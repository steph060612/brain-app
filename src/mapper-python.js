// The Python side of the code mapper: the same map layers as the JavaScript side (imports, calls, entry files, web
// routes, notes) plus classes, read from .py files with the tree-sitter Python grammar compiled to WebAssembly.
// The grammar (src/grammars/tree-sitter-python.wasm, tree-sitter-python 0.25.0, MIT) is bundled with the app and
// runs inside Node through web-tree-sitter: no Python installation, no compiler, and the same map on every Mac
// whatever Python version (if any) is installed. Read-only on the project.
//
// What is linked, and only when it is certain:
//   imports    import a.b, from a import b, relative imports (from . import x, from ..pkg import y), aliases and
//              packages (a/__init__.py), resolved from the project root (and src/ in a src layout), else from the
//              importing file's own folder (as Python does for a script run directly; marked inferred). Anything
//              else is a package. Importing a.b.c also runs a/__init__.py and a/b/__init__.py: those links are added
//              and marked inferred ("package __init__.py runs first").
//   calls      f() for a function imported from another project file or defined in the same file, mod.f() through
//              an imported module, Cls() (an instantiation, function Cls), and method calls (function Class.method)
//              where the class is certain: self.m() / cls.m() in a method (not when a project subclass overrides m),
//              super().m(), Cls.m(), Cls().m(), and x.m() where x is assigned once in its scope, from Cls(...).
//              A receiver known only from a type annotation, a variable assigned more than once, a method that may
//              come from a package base class, or an overridden method goes to unresolved (kind call), never guessed.
//   classes    every class with its bases (project classes, package classes, builtins) and methods; an inherits
//              edge from a class's file to each project base class's file.
//   entries    if __name__ == "__main__", __main__.py, console_scripts in pyproject.toml / setup.py / setup.cfg, and a
//              Flask or FastAPI app file.
//   routes     Flask and FastAPI decorators (@app.route, @app.get, @bp.post, @router.put, …) and add_url_rule, on an
//              app, Blueprint or APIRouter whose constructor is imported from flask or fastapi; prefixes from
//              Blueprint(url_prefix=), APIRouter(prefix=), register_blueprint and include_router.
//   notes      the same tagged comments as the JavaScript side, written with #.
// There is no data layer for Python yet.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOTE_RE, CITE_RE } from './map-notes.js';

export const PY_EXT = ['.py'];
export const isPython = (p) => path.extname(p).toLowerCase() === '.py';
export const PY_PARSER = 'tree-sitter-python 0.25.0 (WebAssembly, bundled with the app)';
const GRAMMAR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grammars', 'tree-sitter-python.wasm');

// Loaded once, only when a folder has Python files. Throws when the WebAssembly runtime or the grammar cannot be
// loaded; the mapper then lists the Python files as skipped with that reason and maps the rest.
let parserPromise = null;
export function loadPythonParser() {
  parserPromise ??= (async () => {
    const { Parser, Language } = await import('web-tree-sitter');
    await Parser.init();
    const lang = await Language.load(new Uint8Array(fs.readFileSync(GRAMMAR)));
    const parser = new Parser();
    parser.setLanguage(lang);
    return parser;
  })();
  return parserPromise;
}

// --- syntax tree ----------------------------------------------------------------------------------------------
// The tree-sitter tree is copied once into plain objects { type, named, field, row, start, end, parent, children }
// (start and end are string offsets, row is 1-based); comments are collected on the side.

function firstError(n) {
  if (n.type === 'ERROR' || n.isMissing) return { line: n.startPosition.row + 1, reason: n.isMissing ? `SyntaxError (missing ${n.type})` : 'SyntaxError' };
  for (const c of n.children) if (c.hasError || c.isMissing) { const r = firstError(c); if (r) return r; }
  return null;
}

function parsePlain(parser, src) {
  const tree = parser.parse(src);
  try {
    if (tree.rootNode.hasError) return { error: firstError(tree.rootNode) ?? { line: null, reason: 'SyntaxError' } };
    const comments = [];
    const c = tree.walk();
    const build = (parent) => {
      const n = { type: c.nodeType, named: c.nodeIsNamed, field: c.currentFieldName, row: c.startPosition.row + 1, start: c.startIndex, end: c.endIndex, parent, children: [] };
      if (c.gotoFirstChild()) {
        do { const ch = build(n); if (ch.type === 'comment') comments.push(ch); else n.children.push(ch); } while (c.gotoNextSibling());
        c.gotoParent();
      }
      return n;
    };
    const root = build(null);
    c.delete();
    return { root, comments };
  } finally { tree.delete(); }
}

const F = (n, f) => n?.children.find((c) => c.field === f) ?? null;
const FA = (n, f) => (n ? n.children.filter((c) => c.field === f) : []);
const named = (n) => (n ? n.children.filter((c) => c.named) : []);
function walk(n, visit) { visit(n); for (const c of n.children) walk(c, visit); }

// --- constants --------------------------------------------------------------------------------------------------
// Methods every class gets from object; a call to one that no project class defines is a call into Python itself.
const OBJECT_METHODS = new Set(['__init__', '__new__', '__init_subclass__', '__repr__', '__str__', '__format__', '__hash__',
  '__eq__', '__ne__', '__lt__', '__le__', '__gt__', '__ge__', '__getattribute__', '__setattr__', '__delattr__', '__dir__',
  '__sizeof__', '__reduce__', '__reduce_ex__', '__subclasshook__', '__getstate__']);
const FRAMEWORKS = {
  flask: { Flask: { framework: 'Flask', kind: 'app' }, Blueprint: { framework: 'Flask', kind: 'blueprint', prefixArg: 'url_prefix' } },
  fastapi: { FastAPI: { framework: 'FastAPI', kind: 'app' }, APIRouter: { framework: 'FastAPI', kind: 'router', prefixArg: 'prefix' } },
};
const ROUTE_METHODS = {
  Flask: { route: null, get: ['GET'], post: ['POST'], put: ['PUT'], delete: ['DELETE'], patch: ['PATCH'] },
  FastAPI: { get: ['GET'], post: ['POST'], put: ['PUT'], delete: ['DELETE'], patch: ['PATCH'], options: ['OPTIONS'], head: ['HEAD'], trace: ['TRACE'], api_route: null, websocket: ['WEBSOCKET'] },
};
const MAIN_GUARD = 'if __name__ == "__main__"';

// --- one file: scopes, bindings, classes ----------------------------------------------------------------------------
// Python scoping: a name bound anywhere in a function is local to it (unless declared global / nonlocal); class
// bodies do not enclose the functions inside them; comprehensions have their own scope. Each binding records what
// bound it: def, class, import, from-import, parameter or a plain value (assignment, for, with, except, :=).

function analyzeFile(rel, src, parser) {
  const parsed = parsePlain(parser, src);
  const A = { rel, src, error: parsed.error ?? null, classes: [], defs: [], calls: [], attrs: [], imports: [], decorated: [], comments: parsed.comments ?? [], names: [] };
  if (parsed.error) return A;
  const T = A.T = (n) => src.slice(n.start, n.end);
  const root = A.root = parsed.root;
  const mk = (kind, node, parent, name) => ({ kind, node, parent, name, bindings: new Map(), globals: new Set(), nonlocals: new Set() });
  const M = A.M = mk('module', root, null, null);
  const bindIn = (s, name, b) => (s.bindings.get(name) ?? s.bindings.set(name, []).get(name)).push(b);
  const bind = (s, id, b) => {
    const name = T(id);
    id.bound = true;
    let t = s;
    if (b.walrus) while (t.kind === 'comprehension') t = t.parent;
    if (t.globals.has(name)) t = M;
    else if (t.nonlocals.has(name)) { for (let u = t.parent; u; u = u.parent) if (u.kind === 'function' && u.bindings.has(name)) { t = u; break; } }
    bindIn(t, name, { ...b, name, line: id.row, scope: t });
  };
  // The names an assignment target binds (attributes and subscripts bind no name).
  const targets = (n, out = []) => {
    if (!n) return out;
    if (n.type === 'identifier') out.push(n);
    else if (['pattern_list', 'tuple_pattern', 'list_pattern', 'tuple', 'list', 'parenthesized_expression', 'list_splat_pattern', 'list_splat', 'as_pattern_target'].includes(n.type)) for (const c of named(n)) targets(c, out);
    return out;
  };
  const decoratorNames = (def) => (def.parent?.type === 'decorated_definition' ? def.parent.children.filter((c) => c.type === 'decorator').map((d) => T(named(d)[0] ?? d)) : []);

  function visit(n, s) {
    n.scope = s;
    switch (n.type) {
      case 'function_definition': {
        const nameNode = F(n, 'name'), name = T(nameNode);
        const inClass = s.kind === 'class';
        const qname = inClass ? `${s.name}.${name}` : name;
        n.qname = qname;
        nameNode.defName = true; nameNode.scope = s;
        const decorators = decoratorNames(n);
        bind(s, nameNode, { kind: 'function', node: n, qname });
        A.defs.push({ node: n, name, qname, start: n.start, end: n.end, line: n.row, inClass: inClass ? s.cls : null, decorators });
        const params = F(n, 'parameters'), ret = F(n, 'return_type');
        const inner = mk('function', n, s, qname);
        n.inner = inner;
        if (ret) visit(ret, s);
        const isStatic = decorators.includes('staticmethod'), isClassMethod = decorators.includes('classmethod');
        let first = true;
        for (const p of params ? params.children : []) {
          p.scope = s;
          if (!p.named) continue;
          let id = null, type = null;
          if (p.type === 'identifier') id = p;
          else if (p.type === 'typed_parameter') { id = p.children.find((c) => c.type === 'identifier' && !c.field) ?? named(p)[0]; type = F(p, 'type'); }
          else if (p.type === 'default_parameter' || p.type === 'typed_default_parameter') { id = F(p, 'name'); type = F(p, 'type'); const v = F(p, 'value'); if (v) visit(v, s); }
          else if (p.type === 'list_splat_pattern' || p.type === 'dictionary_splat_pattern') { id = named(p)[0]; first = false; }
          if (type) visit(type, s);
          if (id?.type === 'identifier') {
            const self = first && inClass && !isStatic && p.type !== 'list_splat_pattern' && p.type !== 'dictionary_splat_pattern';
            bind(inner, id, { kind: 'param', node: p, type, ...(self ? { self: isClassMethod ? 'cls' : 'self', cls: s.cls } : {}) });
            id.param = true;
            first = false;
          }
        }
        for (const c of n.children) if (c.field === 'body') visit(c, inner);
        return;
      }
      case 'lambda': {
        const inner = mk('function', n, s, null);
        for (const p of named(F(n, 'parameters'))) {
          const id = p.type === 'identifier' ? p : F(p, 'name') ?? named(p)[0];
          const v = F(p, 'value'); if (v) visit(v, s);
          if (id?.type === 'identifier') { bind(inner, id, { kind: 'param', node: p }); id.param = true; }
        }
        const body = F(n, 'body'); if (body) visit(body, inner);
        return;
      }
      case 'class_definition': {
        const nameNode = F(n, 'name'), name = T(nameNode);
        nameNode.defName = true; nameNode.scope = s;
        const cls = { name, file: rel, line: n.row, node: n, scope: s, bases: [], methods: new Map(), attrs: new Set(), selfAttrs: new Set(), subclasses: [], decorators: decoratorNames(n) };
        A.classes.push(cls);
        bind(s, nameNode, { kind: 'class', node: n, cls });
        const sup = F(n, 'superclasses'); if (sup) visit(sup, s);
        const inner = mk('class', n, s, name);
        inner.cls = cls;
        cls.body = inner;
        for (const c of n.children) if (c.field === 'body') visit(c, inner);
        for (const [k, bs] of inner.bindings) {
          const fn = bs.find((b) => b.kind === 'function');
          if (fn && bs.length === 1) {
            const decs = decoratorNames(fn.node);
            cls.methods.set(k, { name: k, qname: fn.qname, line: fn.line, node: fn.node, property: decs.some((d) => d === 'property' || d.endsWith('.setter') || d.endsWith('.getter') || d === 'cached_property' || d.endsWith('.cached_property')) });
          } else cls.attrs.add(k);
        }
        return;
      }
      case 'list_comprehension': case 'set_comprehension': case 'dictionary_comprehension': case 'generator_expression': {
        const inner = mk('comprehension', n, s, null);
        let firstFor = true;
        for (const c of n.children) {
          if (c.type === 'for_in_clause') {
            const right = FA(c, 'right');
            for (const r of right) visit(r, firstFor ? s : inner);
            for (const id of targets(F(c, 'left'))) bind(inner, id, { kind: 'value', loop: true });
            for (const x of c.children) if (x.field !== 'right' && x.field !== 'left') visit(x, inner);
            const l = F(c, 'left'); if (l) visit(l, inner);
            c.scope = inner;
            firstFor = false;
          } else visit(c, inner);
        }
        return;
      }
      case 'assignment': {
        let right = F(n, 'right');
        while (right?.type === 'assignment') right = F(right, 'right'); // a = b = value
        const left = F(n, 'left'), type = F(n, 'type');
        const ids = targets(left);
        const single = left?.type === 'identifier';
        for (const id of ids) bind(s, id, { kind: 'value', value: single ? right : null, type: single ? type : null, unpacked: !single });
        // self.x = ... inside a method: an instance attribute of the method's class.
        if (left?.type === 'attribute') {
          const obj = F(left, 'object');
          if (obj?.type === 'identifier') A.names.push({ selfAttr: true, obj, attr: T(F(left, 'attribute')), scope: s });
        }
        break;
      }
      case 'augmented_assignment':
        for (const id of targets(F(n, 'left'))) bind(s, id, { kind: 'value', value: null, augmented: true });
        break;
      case 'for_statement':
        for (const id of targets(F(n, 'left'))) bind(s, id, { kind: 'value', loop: true });
        break;
      case 'as_pattern': {
        const alias = F(n, 'alias');
        for (const id of targets(alias)) bind(s, id, { kind: 'value', value: null, as: true });
        break;
      }
      case 'named_expression':
        bind(s, F(n, 'name'), { kind: 'value', value: F(n, 'value'), walrus: true });
        break;
      case 'global_statement': for (const id of named(n)) { s.globals.add(T(id)); id.declared = true; } break;
      case 'nonlocal_statement': for (const id of named(n)) { s.nonlocals.add(T(id)); id.declared = true; } break;
      case 'type_alias_statement': { const l = F(n, 'left'); const id = l && (l.type === 'identifier' ? l : named(l)[0]); if (id?.type === 'identifier') bind(s, id, { kind: 'value', value: null }); break; }
      case 'case_pattern': {
        // A capture pattern (case x:) binds x; a dotted value pattern (case Color.RED:) does not.
        for (const c of named(n)) if (c.type === 'dotted_name' && named(c).length === 1) bind(s, named(c)[0], { kind: 'value', value: null });
        break;
      }
      case 'import_statement': {
        for (const item of FA(n, 'name')) {
          const dotted = item.type === 'aliased_import' ? F(item, 'name') : item;
          const alias = item.type === 'aliased_import' ? F(item, 'alias') : null;
          const module = T(dotted);
          const rec = { stmt: n, line: n.row, kind: 'import', module, alias: alias ? T(alias) : null, scope: s };
          A.imports.push(rec);
          if (alias) bind(s, alias, { kind: 'import', module, full: true, rec });
          else bind(s, named(dotted)[0], { kind: 'import', module: module.split('.')[0], full: false, rec });
        }
        walk(n, (x) => { x.importPart = true; x.scope = s; });
        return;
      }
      case 'import_from_statement': {
        const modNode = F(n, 'module_name');
        let level = 0, module = '';
        if (modNode.type === 'relative_import') {
          level = T(modNode.children.find((c) => c.type === 'import_prefix')).length;
          const d = modNode.children.find((c) => c.type === 'dotted_name');
          module = d ? T(d) : '';
        } else module = T(modNode);
        const star = n.children.some((c) => c.type === 'wildcard_import');
        const names = FA(n, 'name').map((item) => ({ name: T(item.type === 'aliased_import' ? F(item, 'name') : item), alias: item.type === 'aliased_import' ? F(item, 'alias') : null, node: item }));
        const rec = { stmt: n, line: n.row, kind: 'from', module, level, star, names: names.map((x) => x.name), scope: s };
        A.imports.push(rec);
        for (const x of names) bind(s, x.alias ?? (x.node.type === 'dotted_name' ? named(x.node)[0] : x.node), { kind: 'from', module, level, imported: x.name, rec });
        if (star) (s.stars ??= []).push(rec);
        walk(n, (x) => { x.importPart = true; x.scope = s; });
        return;
      }
      case 'future_import_statement':
        walk(n, (x) => { x.importPart = true; x.scope = s; });
        return;
      case 'call':
        A.calls.push(n);
        break;
      case 'attribute':
        A.attrs.push(n);
        break;
      case 'decorated_definition':
        A.decorated.push(n);
        break;
      case 'identifier':
        A.names.push({ id: n });
        break;
    }
    for (const c of n.children) visit(c, s);
  }
  visit(root, M);
  // self.x = ... in a method: recorded on the method's class (any method, any depth inside it).
  for (const x of A.names) {
    if (!x.selfAttr) continue;
    const r = lookup(x.scope, T(x.obj));
    const b = r?.bs.length === 1 ? r.bs[0] : null;
    if (b?.kind === 'param' && b.self === 'self') b.cls.selfAttrs.add(x.attr);
  }
  A.names = A.names.filter((x) => !x.selfAttr).map((x) => x.id);
  return A;
}

// Where a name used in scope s is bound: { scope, bs } (bs: every binding of the name in that scope), or null for a
// builtin or an unknown name. Class scopes are skipped when looking outwards, as in Python.
function lookup(s, name) {
  if (s.globals.has(name)) { let m = s; while (m.parent) m = m.parent; return m.bindings.has(name) ? { scope: m, bs: m.bindings.get(name) } : null; }
  let first = true;
  for (let cur = s; cur; cur = cur.parent) {
    if ((first || cur.kind !== 'class') && !cur.nonlocals.has(name) && !cur.globals.has(name) && cur.bindings.has(name)) return { scope: cur, bs: cur.bindings.get(name) };
    first = false;
  }
  return null;
}

// The nearest enclosing named function: 'Class.method' for a method, the function's own name otherwise; lambdas
// count as part of the function around them. Null at the top level of the file.
function enclosingName(n) {
  for (let p = n.parent; p; p = p.parent) if (p.type === 'function_definition') return p.qname;
  return null;
}

function strValue(n, T) {
  if (!n) return null;
  if (n.type === 'concatenated_string') { const parts = named(n).map((x) => strValue(x, T)); return parts.every((p) => p !== null) ? parts.join('') : null; }
  if (n.type !== 'string' || n.children.some((c) => c.type === 'interpolation')) return null;
  return n.children.filter((c) => c.type === 'string_content').map(T).join('');
}
const argsOf = (call) => { const a = F(call, 'arguments'); return a?.type === 'argument_list' ? named(a) : []; };
const positional = (call) => argsOf(call).filter((a) => a.type !== 'keyword_argument' && a.type !== 'list_splat' && a.type !== 'dictionary_splat');
const keyword = (call, T, name) => { const k = argsOf(call).find((a) => a.type === 'keyword_argument' && T(F(a, 'name')) === name); return k ? F(k, 'value') : null; };

// --- the project ---------------------------------------------------------------------------------------------------

export function mapPython({ root, files, codeOf, allFiles, parser }) {
  const pySet = new Set(files);
  const dirsWithPy = new Set();
  for (const f of files) for (let d = path.posix.dirname(f); d !== '.'; d = path.posix.dirname(d)) dirsWithPy.add(d);
  // Import roots: the project folder, and src/ in a src layout (a src/ folder that is not itself a package).
  const roots = [''];
  if (dirsWithPy.has('src') && !pySet.has('src/__init__.py')) roots.push('src');
  const join = (dir, parts) => [dir, ...parts].filter(Boolean).join('/');

  // A dotted module path from a base folder: { file, dir } (file: the .py or __init__.py, null for a namespace
  // package; dir: the package folder, null for a plain module), or null.
  const lookupModule = (baseDir, parts) => {
    const base = join(baseDir, parts);
    if (parts.length && pySet.has(`${base}.py`)) return { file: `${base}.py`, dir: null, name: parts.join('.') };
    if (pySet.has(`${base ? `${base}/` : ''}__init__.py`) && parts.length) return { file: `${base}/__init__.py`, dir: base, name: parts.join('.') };
    if (parts.length && dirsWithPy.has(base)) return { file: null, dir: base, name: parts.join('.') };
    return null;
  };
  // An absolute or relative import from a file: { file, dir, via } or null. via is 'root' or 'folder' (the
  // importing file's own folder, as for a script run directly).
  const resolveModule = (fromRel, module, level = 0) => {
    const parts = module ? module.split('.') : [];
    if (level > 0) {
      let dir = path.posix.dirname(fromRel); if (dir === '.') dir = '';
      for (let i = 1; i < level; i++) { if (!dir) return null; dir = path.posix.dirname(dir); if (dir === '.') dir = ''; }
      if (!parts.length) {
        const init = `${dir ? `${dir}/` : ''}__init__.py`;
        return { file: pySet.has(init) ? init : null, dir, via: 'root', relative: true };
      }
      const r = lookupModule(dir, parts);
      return r && { ...r, via: 'root', relative: true };
    }
    for (const rt of roots) { const r = lookupModule(rt, parts); if (r) return { ...r, via: 'root' }; }
    let own = path.posix.dirname(fromRel); if (own === '.') own = '';
    if (own) { const r = lookupModule(own, parts); if (r) return { ...r, via: 'folder' }; }
    return null;
  };
  const moduleRef = (r) => (r ? { kind: 'module', file: r.file, dir: r.dir } : null);
  // The package __init__.py files Python runs before a module: those of every package folder above it that does
  // not contain the importing file (whose own packages are already running).
  const packageInits = (fromRel, target) => {
    const out = [];
    const dirOf = target.dir && target.file?.endsWith('__init__.py') ? path.posix.dirname(target.dir) : path.posix.dirname(target.file ?? `${target.dir}/x`);
    for (let d = dirOf; d && d !== '.'; d = path.posix.dirname(d)) {
      if (roots.includes(d)) break;
      const init = `${d}/__init__.py`;
      if (!pySet.has(init) || init === target.file) continue;
      if (fromRel.startsWith(`${d}/`)) continue;
      out.push(init);
    }
    return out;
  };

  // --- parse every file
  const A = new Map(), parseFailures = [];
  for (const rel of files) {
    const a = analyzeFile(rel, codeOf.get(rel), parser);
    A.set(rel, a);
    if (a.error) parseFailures.push({ file: rel, line: a.error.line, reason: a.error.reason });
  }

  // from x import *: binds every public name of x (its __all__ when that is a literal list) at the top level of the
  // importing file, unless the file binds the name itself. Repeated so that a chain of star imports is followed.
  const publicNames = (a) => {
    const all = a.M.bindings.get('__all__');
    const v = all?.length === 1 ? all[0].value : null;
    if (v && (v.type === 'list' || v.type === 'tuple')) { const xs = named(v).map((x) => strValue(x, a.T)); if (xs.every((x) => x !== null)) return xs; }
    return [...a.M.bindings.keys()].filter((k) => !k.startsWith('_'));
  };
  for (let pass = 0; pass < 5; pass++) {
    let added = 0;
    for (const [rel, a] of A) {
      if (a.error) continue;
      for (const st of a.M.stars || []) {
        const r = resolveModule(rel, st.module, st.level), t = r?.file && A.get(r.file);
        if (!t?.M) continue;
        for (const name of publicNames(t)) {
          const own = a.M.bindings.get(name);
          if (own && !own.every((b) => b.star)) continue;
          if (own?.some((b) => b.rec === st)) continue;
          (own ?? a.M.bindings.set(name, []).get(name)).push({ kind: 'from', module: st.module, level: st.level, imported: name, rec: st, star: true, name, line: st.line, scope: a.M });
          added++;
        }
      }
    }
    if (!added) break;
  }

  // --- what a name or expression denotes. Refs: { kind: 'module', file, dir } | { kind: 'function', file, qname }
  // | { kind: 'class', cls } | { kind: 'instance', cls } | { kind: 'self', cls, cls: true when cls } | { kind: 'super', cls }
  // | { kind: 'package', module, name } | { kind: 'pkgcall', module, name, file, node } | { kind: 'annotated', cls }
  // | { kind: 'ambiguous', bs, file } | { kind: 'missing', target, name } | { kind: 'value' } | null.
  const refOfBinding = (file, b, depth = 0) => {
    if (depth > 12) return null;
    switch (b.kind) {
      case 'function': return { kind: 'function', file, qname: b.qname, local: b.scope.kind !== 'module' && b.scope.kind !== 'class' };
      case 'class': return { kind: 'class', cls: b.cls };
      case 'import': {
        const r = resolveModule(file, b.module);
        return r ? moduleRef(r) : { kind: 'package', module: b.module, name: null };
      }
      case 'from': {
        const r = resolveModule(file, b.module, b.level);
        if (!r) return b.level ? { kind: 'missing', target: null, name: b.imported } : { kind: 'package', module: b.module, name: b.imported };
        return resolveMember(moduleRef(r), b.imported, depth + 1) ?? { kind: 'missing', target: r.file ?? r.dir, name: b.imported };
      }
      case 'param': {
        if (b.self) return { kind: 'self', cls: b.cls, viaCls: b.self === 'cls' };
        const c = b.type ? annotationClass(file, b.type, b.scope.parent ?? b.scope) : null;
        return c ? { kind: 'annotated', cls: c } : null;
      }
      case 'value': {
        if (!b.value) return null;
        const v = evalExpr(file, b.value, b.value.scope ?? b.scope, depth + 1);
        if (v && ['instance', 'class', 'module', 'function', 'pkgcall', 'package'].includes(v.kind)) return v;
        if (v?.kind === 'annotatedCall') return { kind: 'annotated', cls: v.cls, fromCall: true };
        const c = b.type ? annotationClass(file, b.type, b.scope) : null;
        return c ? { kind: 'annotated', cls: c } : { kind: 'value' };
      }
    }
    return null;
  };
  // A name inside a module, as `module.name` or `from module import name` sees it.
  const resolveMember = (mod, name, depth = 0) => {
    if (!mod || depth > 12) return null;
    if (mod.file) {
      const a = A.get(mod.file);
      if (a?.M) {
        const bs = a.M.bindings.get(name);
        if (bs?.length > 1) return { kind: 'ambiguous', bs, file: mod.file };
        if (bs?.length === 1) return refOfBinding(mod.file, bs[0], depth + 1);
        for (const st of a.M.stars || []) {
          if (name.startsWith('_')) break;
          const r = resolveModule(mod.file, st.module, st.level);
          const hit = r && resolveMember(moduleRef(r), name, depth + 1);
          if (hit && hit.kind !== 'missing') return hit;
        }
      }
    }
    if (mod.dir != null) { const sub = lookupModule(mod.dir, [name]); if (sub) return moduleRef(sub); }
    return null;
  };
  const evalName = (file, id, scope, depth) => {
    const name = A.get(file).T(id);
    const r = lookup(scope, name);
    if (!r) return { kind: 'builtin', name };
    if (r.bs.length > 1) return { kind: 'ambiguous', bs: r.bs, file };
    return refOfBinding(file, r.bs[0], depth + 1);
  };
  function evalExpr(file, n, scope, depth = 0) {
    if (!n || depth > 12) return null;
    const a = A.get(file), T = a.T;
    scope = n.scope ?? scope;
    switch (n.type) {
      case 'identifier': return evalName(file, n, scope, depth);
      case 'parenthesized_expression': return evalExpr(file, named(n)[0], scope, depth + 1);
      case 'attribute': {
        const base = evalExpr(file, F(n, 'object'), scope, depth + 1), attr = T(F(n, 'attribute'));
        if (!base) return null;
        if (base.kind === 'module') return resolveMember(base, attr, depth + 1);
        if (base.kind === 'package') return { kind: 'package', module: base.module, name: base.name ? `${base.name}.${attr}` : attr };
        return null;
      }
      case 'call': {
        const callee = F(n, 'function');
        if (callee?.type === 'identifier' && T(callee) === 'super' && !positional(n).length) {
          const r = lookup(scope, 'super');
          if (!r) { const m = methodScope(scope); if (m) return { kind: 'super', cls: m.cls }; }
          return null;
        }
        const f = evalExpr(file, callee, scope, depth + 1);
        if (f?.kind === 'class') return { kind: 'instance', cls: f.cls };
        if (f?.kind === 'package') return { kind: 'pkgcall', module: f.module, name: f.name, file, node: n };
        if (f?.kind === 'function') {
          // A project function whose return annotation names a project class: known only from the annotation.
          const def = A.get(f.file)?.defs.find((d) => d.qname === f.qname);
          const ret = def && F(def.node, 'return_type');
          const c = ret && annotationClass(f.file, ret, def.node.scope);
          if (c) return { kind: 'annotatedCall', cls: c };
        }
        return null;
      }
    }
    return null;
  }
  // The method a scope belongs to: { cls, def } for a function written directly in a class body.
  function methodScope(scope) {
    for (let s = scope; s; s = s.parent) {
      if (s.kind === 'function' && s.node.type === 'function_definition') return s.parent?.kind === 'class' ? { cls: s.parent.cls, def: s.node } : methodScope(s.parent);
    }
    return null;
  }
  // The project class an annotation names: Foo, mod.Foo, 'Foo', Foo | None, Optional[Foo].
  function annotationClass(file, typeNode, scope) {
    const a = A.get(file);
    let n = typeNode;
    for (let i = 0; n && i < 6; i++) {
      if (n.type === 'type') { n = named(n)[0]; continue; }
      if (n.type === 'binary_operator') { const parts = [F(n, 'left'), F(n, 'right')].filter((x) => x && x.type !== 'none'); n = parts.length === 1 ? parts[0] : null; continue; }
      if (n.type === 'generic_type' || n.type === 'subscript') {
        if (!/^(typing\.)?Optional$/.test(a.T(n.children[0]))) return null;
        const inner = n.type === 'subscript' ? F(n, 'subscript') : named(n).find((x) => x.type === 'type_parameter');
        n = inner?.type === 'type_parameter' ? named(inner)[0] : inner;
        continue;
      }
      break;
    }
    if (!n) return null;
    if (n.type === 'string') {
      const s = strValue(n, a.T);
      if (!s || !/^[A-Za-z_][\w.]*$/.test(s)) return null;
      const [head, ...rest] = s.split('.');
      let r = lookup(scope, head);
      let ref = r?.bs.length === 1 ? refOfBinding(file, r.bs[0]) : null;
      for (const part of rest) ref = ref?.kind === 'module' ? resolveMember(ref, part) : null;
      return ref?.kind === 'class' ? ref.cls : null;
    }
    if (n.type !== 'identifier' && n.type !== 'attribute') return null;
    const ref = evalExpr(file, n, scope);
    return ref?.kind === 'class' ? ref.cls : null;
  }

  // --- classes: bases, inheritance, method resolution order
  const classes = [...A.values()].flatMap((a) => a.classes);
  const edges = [], unresolved = [], missing = [], notes = [], screens = [];
  const nodesInfo = new Map(); // file -> { exports, packages, packageImports, classes }
  for (const cls of classes) {
    const a = A.get(cls.file);
    const sup = F(cls.node, 'superclasses');
    for (const b of named(sup)) {
      if (b.type === 'keyword_argument') continue; // metaclass=…
      const text = a.T(b);
      const ref = b.type === 'identifier' || b.type === 'attribute' ? evalExpr(cls.file, b, cls.scope) : null;
      if (ref?.kind === 'class') { cls.bases.push({ name: ref.cls.name, cls: ref.cls, line: b.row }); ref.cls.subclasses.push(cls); }
      else if (ref?.kind === 'package') cls.bases.push({ name: text, package: ref.module, external: true });
      else if (ref?.kind === 'builtin') cls.bases.push({ name: text, builtin: true, external: true });
      else {
        cls.bases.push({ name: text, external: true, unknown: true });
        unresolved.push({ file: cls.file, line: b.row, kind: 'class', reason: ref?.kind === 'ambiguous' ? 'base class name bound more than once' : 'base class not resolved', class: cls.name, base: text });
      }
    }
  }
  for (const cls of classes) for (const b of cls.bases) {
    if (!b.cls) continue;
    edges.push({ from: cls.file, to: b.cls.file, kind: 'inherits', line: b.line, class: cls.name, base: b.cls.name, ...(cls.file === b.cls.file ? { sameFile: true } : {}) });
  }
  const OBJECT = { external: true, name: 'object', builtin: true };
  const mroCache = new Map();
  // C3 linearization over project classes; a package or builtin base is a leaf (its own bases are unknown). Every
  // order ends with object.
  const mro = (cls, stack = new Set()) => {
    if (mroCache.has(cls)) return mroCache.get(cls);
    if (stack.has(cls)) return [cls];
    stack.add(cls);
    const seqs = cls.bases.map((b) => (b.cls ? mro(b.cls, stack).filter((x) => x !== OBJECT) : [b]));
    seqs.push(cls.bases.map((b) => b.cls ?? b));
    const out = [cls];
    const lists = seqs.map((s) => [...s]).filter((s) => s.length);
    while (lists.length) {
      let head = null;
      for (const l of lists) { const h = l[0]; if (!lists.some((m) => m.indexOf(h) > 0)) { head = h; break; } }
      if (!head) { for (const l of lists) for (const x of l) if (!out.includes(x)) out.push(x); break; } // inconsistent: keep a plain order
      out.push(head);
      for (const l of lists) if (l[0] === head) l.shift();
      for (let i = lists.length - 1; i >= 0; i--) if (!lists[i].length) lists.splice(i, 1);
    }
    out.push(OBJECT);
    stack.delete(cls);
    mroCache.set(cls, out);
    return out;
  };
  // Where Class.name is found: { found: { owner, method } } | { attr: owner } | { external: base } | { none: true }.
  const findMethod = (cls, name, after = null) => {
    const order = mro(cls);
    let i = after ? order.indexOf(after) + 1 : 0;
    for (; i < order.length; i++) {
      const c = order[i];
      if (c.external) { if (c === OBJECT && !OBJECT_METHODS.has(name)) continue; return { external: c }; }
      if (c.methods.has(name)) return { found: { owner: c, method: c.methods.get(name) } };
      if (c.attrs.has(name)) return { attr: c };
    }
    return { none: true };
  };
  const allSubclasses = (cls, out = new Set()) => { for (const s of cls.subclasses) if (!out.has(s)) { out.add(s); allSubclasses(s, out); } return out; };
  const setOnInstance = (cls, name) => mro(cls).some((c) => !c.external && c.selfAttrs.has(name));

  // --- per file: imports, calls, value uses, notes
  const stats = { callSites: 0, resolved: 0, sameFile: 0, methodCalls: 0, instantiations: 0, unresolved: 0 };
  const callEdge = (from, line, caller, to, fields) => {
    const e = { from, to, kind: 'calls', line, ...fields, ...(caller ? { caller } : {}), ...(from === to ? { sameFile: true } : {}) };
    edges.push(e);
    if (from === to) stats.sameFile++; else stats.resolved++;
    if (fields.method) stats.methodCalls++;
    if (fields.instantiates) stats.instantiations++;
  };
  const unresolvedCall = (file, line, reason, extra = {}) => { unresolved.push({ file, line, kind: 'call', reason, ...extra }); stats.unresolved++; };
  const describe = (b) => (b.package ? `${b.name} (${b.package})` : b.builtin ? `${b.name} (builtin)` : b.name);

  for (const [rel, a] of A) {
    const info = { exports: [], packages: [], packageImports: 0, classes: [] };
    nodesInfo.set(rel, info);
    if (a.error) continue;
    const T = a.T;

    // Imports: one edge per statement and target file.
    const pkgs = new Set();
    for (const im of a.imports) {
      const targets = new Map(); // file -> why
      const add = (f, why) => { if (f && f !== rel && !targets.has(f)) targets.set(f, why); };
      if (im.kind === 'import') {
        const r = resolveModule(rel, im.module);
        if (!r) {
          const top = resolveModule(rel, im.module.split('.')[0]);
          if (top) missing.push({ file: rel, line: im.line, module: im.module });
          else { info.packageImports++; pkgs.add(im.module.split('.')[0]); }
          continue;
        }
        add(r.file, r.via === 'folder' ? 'resolved from the importing file\'s folder' : null);
        for (const init of packageInits(rel, r)) add(init, 'package __init__.py runs first');
      } else {
        const r = resolveModule(rel, im.module, im.level);
        if (!r) {
          if (im.level) missing.push({ file: rel, line: im.line, module: `${'.'.repeat(im.level)}${im.module}` });
          else if (resolveModule(rel, im.module.split('.')[0])) missing.push({ file: rel, line: im.line, module: im.module });
          else { info.packageImports++; pkgs.add(im.module.split('.')[0]); }
          continue;
        }
        const folderWhy = r.via === 'folder' ? 'resolved from the importing file\'s folder' : null;
        // from pkg import name: a name the module defines, else a submodule (pkg/name.py), whose package's
        // __init__.py runs first (unless the importing file is inside that package).
        const defined = (n) => !!r.file && !!A.get(r.file)?.M && !!resolveMember({ kind: 'module', file: r.file, dir: null }, n);
        const ownPackage = r.dir != null && (r.dir === '' || rel.startsWith(`${r.dir}/`));
        if (im.star) add(r.file, folderWhy);
        for (const n of im.names) {
          if (defined(n)) { add(r.file, folderWhy); continue; }
          const sub = r.dir != null ? lookupModule(r.dir, [n]) : null;
          if (sub?.file) { add(sub.file, folderWhy); if (r.file && !ownPackage) add(r.file, 'package __init__.py runs first'); }
          else if (r.file) add(r.file, folderWhy);
          else missing.push({ file: rel, line: im.line, module: `${'.'.repeat(im.level)}${im.module}`, name: n });
        }
        for (const init of packageInits(rel, r)) add(init, 'package __init__.py runs first');
      }
      for (const [to, why] of targets) edges.push({ from: rel, to, kind: 'import', line: im.line, ...(why ? { why } : {}) });
    }
    // importlib.import_module('a.b') and __import__('a'): a dynamic import when the name is written out.
    for (const c of a.calls) {
      const callee = F(c, 'function');
      const ref = callee && evalExpr(rel, callee, c.scope);
      const isImportlib = ref?.kind === 'package' && ((ref.module === 'importlib' && ref.name === 'import_module') || (ref.module === 'importlib.import_module'));
      const isDunder = callee?.type === 'identifier' && T(callee) === '__import__' && !lookup(c.scope, '__import__');
      if (!isImportlib && !isDunder) continue;
      const spec = strValue(positional(c)[0], T);
      if (spec === null) { unresolved.push({ file: rel, line: c.row, kind: 'load', reason: 'computed module name' }); continue; }
      const r = spec.startsWith('.') ? null : resolveModule(rel, spec);
      if (r?.file && r.file !== rel) edges.push({ from: rel, to: r.file, kind: 'dynamic', line: c.row });
      else if (!r) { info.packageImports++; pkgs.add(spec.split('.')[0]); }
    }
    info.packages = [...pkgs].sort();

    // Exports: __all__ when it is a literal list or tuple, else the public names defined at the top level.
    const allB = a.M.bindings.get('__all__');
    const allVal = allB?.length === 1 ? allB[0].value : null;
    if (allVal && (allVal.type === 'list' || allVal.type === 'tuple') && named(allVal).every((x) => strValue(x, T) !== null)) info.exports = named(allVal).map((x) => strValue(x, T));
    else info.exports = [...a.M.bindings].filter(([k, bs]) => !k.startsWith('_') && bs.some((b) => b.kind === 'function' || b.kind === 'class' || b.kind === 'value')).map(([k]) => k);

    // Calls.
    for (const c of a.calls) {
      const callee = F(c, 'function');
      if (!callee) continue;
      const line = c.row, caller = enclosingName(c);
      if (callee.type === 'identifier') {
        const name = T(callee);
        const r = lookup(c.scope, name);
        if (!r) continue; // a builtin (print, len, …)
        if (r.bs.length > 1) {
          const project = r.bs.map((b) => refOfBinding(rel, b)).filter((x) => x && ['function', 'class', 'instance'].includes(x.kind));
          if (project.length) unresolvedCall(rel, line, 'name bound more than once in its scope', { name });
          continue;
        }
        const ref = refOfBinding(rel, r.bs[0]);
        if (ref?.kind === 'function') {
          if (ref.file === rel && caller === ref.qname) continue; // recursion
          callEdge(rel, line, caller, ref.file, { function: ref.qname, ...(r.bs[0].kind === 'from' && r.bs[0].imported !== name ? { local: name } : {}) });
        } else if (ref?.kind === 'class') {
          callEdge(rel, line, caller, ref.cls.file, { function: ref.cls.name, class: ref.cls.name, instantiates: true });
        } else if (ref?.kind === 'missing') {
          unresolvedCall(rel, line, 'export not found', { target: ref.target, name: ref.name });
        } else if (ref?.kind === 'ambiguous') {
          unresolvedCall(rel, line, `name bound more than once in ${ref.file}`, { target: ref.file, name });
        }
        continue;
      }
      if (callee.type !== 'attribute') continue;
      const obj = F(callee, 'object'), m = T(F(callee, 'attribute'));
      const base = evalExpr(rel, obj, c.scope);
      if (!base) continue;
      const methodCall = (cls, via) => {
        const res = findMethod(cls, m, via === 'super' ? cls : null);
        const label = via === 'super' ? `super().${m}()` : `${via === 'self' || via === 'cls' ? T(obj) : cls.name}.${m}()`;
        if (res.found) {
          const { owner, method } = res.found;
          if (method.property) return; // calls what a property returns
          if (via === 'self' || via === 'cls') {
            const over = [...allSubclasses(cls)].filter((s) => s.methods.has(m) || s.attrs.has(m));
            if (over.length) return unresolvedCall(rel, line, `${label} may run ${over.map((s) => `${s.name}.${m}`).join(', ')} (overridden in a subclass)`, { target: owner.file, name: `${owner.name}.${m}` });
          }
          if ((via === 'self' || via === 'instance') && setOnInstance(cls, m)) return unresolvedCall(rel, line, `${label}: ${m} is also set as an instance attribute`, { target: owner.file, name: `${owner.name}.${m}` });
          return callEdge(rel, line, caller, owner.file, { function: `${owner.name}.${m}`, class: owner.name, method: m, receiver: via });
        }
        if (res.external) {
          if (res.external === OBJECT) return; // object.__init__ and the like
          return unresolvedCall(rel, line, `${label}: not defined in the project's classes; may come from the base class ${describe(res.external)}`, { name: `${cls.name}.${m}` });
        }
        if (res.attr) return unresolvedCall(rel, line, `${label}: ${m} is a class attribute of ${res.attr.name}, not a method`, { target: res.attr.file, name: `${res.attr.name}.${m}` });
        if ((via === 'self' || via === 'instance') && setOnInstance(cls, m)) return unresolvedCall(rel, line, `${label}: ${m} is an instance attribute set to a value`, { target: cls.file, name: `${cls.name}.${m}` });
        return unresolvedCall(rel, line, `${label}: no method ${m} in ${cls.name} or its project base classes`, { target: cls.file, name: `${cls.name}.${m}` });
      };
      switch (base.kind) {
        case 'module': {
          const r = resolveMember(base, m);
          if (r?.kind === 'function') callEdge(rel, line, caller, r.file, { function: r.qname });
          else if (r?.kind === 'class') callEdge(rel, line, caller, r.cls.file, { function: r.cls.name, class: r.cls.name, instantiates: true });
          else if (!r || r.kind === 'missing') unresolvedCall(rel, line, 'export not found', { target: base.file ?? base.dir, name: m });
          else if (r.kind === 'ambiguous') unresolvedCall(rel, line, `name bound more than once in ${r.file}`, { target: r.file, name: m });
          break;
        }
        case 'class': methodCall(base.cls, 'class'); break;
        case 'instance': methodCall(base.cls, 'instance'); break;
        case 'self': methodCall(base.cls, base.viaCls ? 'cls' : 'self'); break;
        case 'super': methodCall(base.cls, 'super'); break;
        case 'annotated': case 'annotatedCall': {
          const res = findMethod(base.cls, m);
          unresolvedCall(rel, line, `${T(obj)}.${m}(): ${T(obj)} is ${base.cls.name} only by a type annotation${base.fromCall ? ' (the return type of the function that made it)' : ''}, which Python does not check`, { target: res.found?.owner.file ?? base.cls.file, name: `${res.found?.owner.name ?? base.cls.name}.${m}` });
          break;
        }
        case 'ambiguous': {
          const kinds = base.bs.map((b) => refOfBinding(rel, b)).filter((x) => x && ['instance', 'class', 'module', 'self'].includes(x.kind));
          if (kinds.length) {  unresolvedCall(rel, line, `${T(obj)}.${m}(): ${T(obj)} is assigned more than once in its scope`, { name: m }); }
          break;
        }
      }
    }

    // Decorators that are project functions are calls too: @decorator applies decorator(function).
    for (const d of a.decorated) for (const dec of d.children.filter((x) => x.type === 'decorator')) {
      const e = named(dec)[0];
      if (!e || e.type === 'call') continue; // @deco(args) is a call node, already counted
      const ref = evalExpr(rel, e, dec.scope ?? d.scope);
      if (ref?.kind !== 'function') continue;
      callEdge(rel, dec.row, enclosingName(d), ref.file, { function: ref.qname, decorator: true });
    }

    // Imported functions and project modules used as values: their calls cannot be followed (as on the JavaScript
    // side; classes and functions defined in the same file are not counted).
    const inType = (n) => { for (let p = n; p; p = p.parent) { if (p.type === 'type' || p.field === 'return_type') return true; if (p.type.endsWith('statement') || p.type === 'block') return false; } return false; };
    for (const id of a.names) {
      if (id.bound || id.defName || id.param || id.importPart || id.declared) continue;
      const p = id.parent;
      if (p.type === 'attribute' && id.field === 'attribute') continue;
      if (p.type === 'keyword_argument' && id.field === 'name') continue;
      if (p.type === 'call' && id.field === 'function') continue;
      if (p.type === 'decorator') continue;
      if (inType(id)) continue;
      const r = lookup(id.scope, T(id));
      if (!r || r.bs.length !== 1 || !['import', 'from'].includes(r.bs[0].kind)) continue;
      const ref = refOfBinding(rel, r.bs[0]);
      if (p.type === 'attribute' && id.field === 'object') continue; // see the attribute chains below
      if (ref?.kind === 'module') unresolvedCall(rel, id.row, 'module object used as a value', { target: ref.file ?? ref.dir, name: T(id) });
      else if (ref?.kind === 'function') unresolvedCall(rel, id.row, 'function used as a value', { target: ref.file, name: ref.qname });
    }

    // mod.f, pkg.mod.f used without calling it (the whole chain, from an imported module).
    for (const at of a.attrs) {
      const p = at.parent;
      if ((p.type === 'attribute' && at.field === 'object') || (p.type === 'call' && at.field === 'function') || p.type === 'decorator' || inType(at)) continue;
      if (p.type === 'assignment' && at.field === 'left') continue;
      let head = at; while (head.type === 'attribute') head = F(head, 'object');
      if (head?.type !== 'identifier') continue;
      const r = lookup(head.scope ?? at.scope, T(head));
      if (!r || r.bs.length !== 1 || !['import', 'from'].includes(r.bs[0].kind)) continue;
      const ref = evalExpr(rel, at, at.scope);
      if (ref?.kind === 'function') unresolvedCall(rel, at.row, 'function used as a value', { target: ref.file, name: ref.qname });
    }

    // Notes: # NOTE / WHY / HACK / FIXME / TODO / IMPORTANT / WARNING, and ADR / RFC citations; a note continued
    // on the following # lines is one note.
    const cs = a.comments;
    for (let i = 0; i < cs.length; i++) {
      const value = T(cs[i]).replace(/^#/, '');
      let tag = null;
      if (NOTE_RE.test(value)) tag = NOTE_RE.exec(value)[1].toUpperCase();
      else { const m = CITE_RE.exec(value); if (!m) continue; tag = m[1].toUpperCase(); }
      const at = cs[i];
      let text = value;
      for (let j = i + 1; j < cs.length && cs[j].row === cs[j - 1].row + 1 && !NOTE_RE.test(T(cs[j]).replace(/^#/, '')); j++) { text += ` ${T(cs[j]).replace(/^#/, '')}`; i = j; }
      text = text.replace(/\s+/g, ' ').trim();
      const around = a.defs.filter((f) => f.start <= at.start && at.end <= f.end).sort((x, y) => (x.end - x.start) - (y.end - y.start))[0];
      notes.push({ file: rel, line: at.row, tag, function: around?.qname ?? null, text: text.length > 200 ? `${text.slice(0, 199)}…` : text });
    }

    info.classes = a.classes.map((c) => ({ name: c.name, line: c.line,
      bases: c.bases.map((b) => (b.cls ? { name: b.name, file: b.cls.file } : b.package ? { name: b.name, package: b.package } : b.builtin ? { name: b.name, builtin: true } : { name: b.name, unresolved: true })),
      methods: [...c.methods.keys()], ...(c.decorators.length ? { decorators: c.decorators } : {}) }));
  }

  // --- web routes: Flask and FastAPI
  const routerOf = (file, n, scope) => {
    const ref = evalExpr(file, n, scope);
    if (ref?.kind !== 'pkgcall') return null;
    const top = ref.module.split('.')[0];
    const spec = FRAMEWORKS[top]?.[ref.name];
    if (!spec) return null;
    const a = A.get(ref.file);
    const own = spec.prefixArg ? keyword(ref.node, a.T, spec.prefixArg) : null;
    return { ...spec, key: `${ref.file}:${ref.node.start}`, file: ref.file, line: ref.node.row, prefix: own ? strValue(own, a.T) : '', prefixComputed: !!own && strValue(own, a.T) === null };
  };
  const registrations = new Map(); // router key -> [{ parent, prefix }]
  for (const [rel, a] of A) {
    if (a.error) continue;
    for (const c of a.calls) {
      const callee = F(c, 'function');
      if (callee?.type !== 'attribute') continue;
      const m = a.T(F(callee, 'attribute'));
      if (m !== 'register_blueprint' && m !== 'include_router') continue;
      const parent = routerOf(rel, F(callee, 'object'), c.scope), child = positional(c)[0] && routerOf(rel, positional(c)[0], c.scope);
      if (!parent || !child) continue;
      const kw = keyword(c, a.T, m === 'register_blueprint' ? 'url_prefix' : 'prefix');
      const prefix = kw ? strValue(kw, a.T) : null;
      (registrations.get(child.key) ?? registrations.set(child.key, []).get(child.key)).push({ parent, prefix, computed: !!kw && prefix === null });
    }
  }
  const joinPath = (...ps) => (`/${ps.filter(Boolean).join('/')}`).replace(/\/+/g, '/').replace(/(.)\/$/, '$1');
  // Every full prefix a router is mounted at: Flask's register_blueprint(url_prefix=) replaces the blueprint's own
  // prefix; FastAPI's include_router(prefix=) goes in front of it.
  const prefixesOf = (r, depth = 0) => {
    if (r.kind === 'app' || depth > 6) return [{ prefix: '', unregistered: false }];
    const regs = registrations.get(r.key) || [];
    if (!regs.length) return [{ prefix: r.prefix, unregistered: true }];
    return regs.flatMap((g) => prefixesOf(g.parent, depth + 1).map((pp) => ({
      prefix: joinPath(pp.prefix, r.framework === 'Flask' ? (g.prefix ?? r.prefix) : `${g.prefix ?? ''}/${r.prefix}`), unregistered: pp.unregistered,
    })));
  };
  const addRoute = (rel, line, router, rule, methods, handler, handlerFile) => {
    for (const p of prefixesOf(router)) {
      screens.push({ name: joinPath(p.prefix, rule), component: handler, file: handlerFile, navigator: router.framework, navigatorFile: rel, line, route: true,
        handler, methods, ...(p.unregistered && router.kind !== 'app' ? { unregistered: true } : {}) });
    }
  };
  for (const [rel, a] of A) {
    if (a.error) continue;
    const T = a.T;
    for (const d of a.decorated) {
      const def = F(d, 'definition');
      if (def?.type !== 'function_definition') continue;
      for (const dec of d.children.filter((x) => x.type === 'decorator')) {
        const e = named(dec)[0];
        if (e?.type !== 'call' || F(e, 'function')?.type !== 'attribute') continue;
        const callee = F(e, 'function'), m = T(F(callee, 'attribute'));
        const router = routerOf(rel, F(callee, 'object'), d.scope);
        if (!router || !(m in ROUTE_METHODS[router.framework])) continue;
        const ruleNode = positional(e)[0] ?? keyword(e, T, router.framework === 'Flask' ? 'rule' : 'path');
        const rule = strValue(ruleNode, T);
        if (rule === null) { unresolved.push({ file: rel, line: dec.row, kind: 'route', reason: 'computed route path', handler: def.qname }); continue; }
        let methods = ROUTE_METHODS[router.framework][m];
        if (!methods) {
          const mk = keyword(e, T, 'methods');
          methods = mk && (mk.type === 'list' || mk.type === 'tuple' || mk.type === 'set') ? named(mk).map((x) => strValue(x, T)).filter(Boolean).map((x) => x.toUpperCase()) : ['GET'];
          if (!methods.length) methods = ['GET'];
        }
        addRoute(rel, dec.row, router, rule, methods, def.qname, rel);
      }
    }
    // app.add_url_rule('/path', view_func=handler)
    for (const c of a.calls) {
      const callee = F(c, 'function');
      if (callee?.type !== 'attribute' || T(F(callee, 'attribute')) !== 'add_url_rule') continue;
      const router = routerOf(rel, F(callee, 'object'), c.scope);
      if (router?.framework !== 'Flask') continue;
      const rule = strValue(positional(c)[0] ?? keyword(c, T, 'rule'), T);
      const vf = keyword(c, T, 'view_func') ?? positional(c)[2];
      const ref = vf && evalExpr(rel, vf, c.scope);
      if (rule === null) { unresolved.push({ file: rel, line: c.row, kind: 'route', reason: 'computed route path' }); continue; }
      const mk = keyword(c, T, 'methods');
      const methods = mk ? named(mk).map((x) => strValue(x, T)).filter(Boolean).map((x) => x.toUpperCase()) : ['GET'];
      if (ref?.kind === 'function') addRoute(rel, c.row, router, rule, methods, ref.qname, ref.file);
      else unresolved.push({ file: rel, line: c.row, kind: 'route', reason: 'view function not resolved', path: rule });
    }
  }

  // --- entry files: { file, why } in order of confidence
  const entries = [];
  const addEntry = (file, why) => { if (file && pySet.has(file) && !entries.some((x) => x.file === file)) entries.push({ file, why }); };
  const scriptTarget = (cfgFile, spec) => {
    const mod = String(spec).split(':')[0].trim();
    if (!/^[\w.]+$/.test(mod)) return null;
    let base = path.posix.dirname(cfgFile); if (base === '.') base = '';
    const parts = mod.split('.');
    for (const rt of [base, join(base, ['src'])]) { const r = lookupModule(rt, parts); if (r?.file) return r.file; }
    return null;
  };
  const read = (f) => { try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch { return null; } };
  for (const f of allFiles.filter((x) => path.posix.basename(x) === 'pyproject.toml').sort()) {
    const text = read(f); if (!text) continue;
    let section = null;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.replace(/\s+#.*$/, '').trim();
      const sec = /^\[([^\]]+)\]$/.exec(line);
      if (sec) { section = sec[1].trim(); continue; }
      if (!['project.scripts', 'project.gui-scripts', 'tool.poetry.scripts'].includes(section)) continue;
      const kv = /^["']?([\w.-]+)["']?\s*=\s*(?:["']([^"']+)["']|\{[^}]*reference\s*=\s*["']([^"']+)["'][^}]*\})/.exec(line);
      if (kv) addEntry(scriptTarget(f, kv[2] ?? kv[3]), `pyproject.toml script "${kv[1]}"`);
    }
  }
  for (const f of allFiles.filter((x) => path.posix.basename(x) === 'setup.py').sort()) {
    const text = read(f); if (!text || !/console_scripts|gui_scripts/.test(text)) continue;
    for (const m of text.matchAll(/["']\s*([\w.-]+)\s*=\s*([\w.]+)\s*:\s*[\w.]+[^"']*["']/g)) addEntry(scriptTarget(f, m[2]), `setup.py console_scripts "${m[1]}"`);
  }
  for (const f of allFiles.filter((x) => path.posix.basename(x) === 'setup.cfg').sort()) {
    const text = read(f); if (!text) continue;
    let section = null, key = null;
    for (const raw of text.split(/\r?\n/)) {
      const sec = /^\s*\[([^\]]+)\]\s*$/.exec(raw);
      if (sec) { section = sec[1].trim(); key = null; continue; }
      if (section !== 'options.entry_points') continue;
      let value = raw;
      const head = /^(\S[^=]*?)\s*=\s*(.*)$/.exec(raw);
      if (head) { key = head[1].trim(); value = head[2]; }
      if (key !== 'console_scripts' && key !== 'gui_scripts') continue;
      const m = /^\s*([\w.-]+)\s*=\s*([\w.]+)\s*:/.exec(value);
      if (m) addEntry(scriptTarget(f, m[2]), `setup.cfg ${key} "${m[1]}"`);
    }
  }
  for (const f of files.filter((x) => path.posix.basename(x) === '__main__.py')) addEntry(f, 'python -m (__main__.py)');
  for (const [rel, a] of A) {
    if (a.error) continue;
    const guard = a.root.children.some((st) => {
      if (st.type !== 'if_statement') return false;
      const cond = F(st, 'condition');
      if (cond?.type !== 'comparison_operator') return false;
      const ops = cond.children.filter((x) => !x.named).map(a.T), sides = named(cond);
      return ops.length === 1 && ops[0] === '==' && sides.length === 2
        && sides.some((x) => x.type === 'identifier' && a.T(x) === '__name__') && sides.some((x) => strValue(x, a.T) === '__main__');
    });
    if (guard) addEntry(rel, MAIN_GUARD);
  }
  for (const [rel, a] of A) {
    if (a.error) continue;
    for (const [, bs] of a.M.bindings) {
      if (bs.length !== 1 || bs[0].kind !== 'value' || !bs[0].value) continue;
      const r = routerOf(rel, bs[0].value, a.M);
      if (r?.kind === 'app' && r.file === rel) { addEntry(rel, `${r.framework} app`); break; }
    }
  }

  stats.callSites = stats.resolved + stats.sameFile + stats.unresolved;
  const classCount = classes.length;
  return {
    nodesInfo, edges, unresolved, missing, parseFailures, notes, screens, entries,
    stats: { ...stats, classes: classCount, inheritance: edges.filter((e) => e.kind === 'inherits').length, routes: screens.length, roots: roots.map((r) => r || '.') },
  };
}
