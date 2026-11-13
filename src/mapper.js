#!/usr/bin/env node
// Standalone code mapper: builds a file-level map of a JavaScript project.
// Usage: node src/mapper.js <project folder> <output name>
// Read-only on the project. Writes only ~/.brain/maps/<output name>/map.json.
//
// Layers: imports (files), React Navigation (navigate edges), Firebase callable
// functions (calls-function edges) and Firestore collections (reads / writes edges).

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from '@babel/parser';

const SCHEMA_VERSION = 2;
const IMPORT_KINDS = ['import', 're-export', 'require', 'dynamic'];
const KINDS = {
  nodes: ['file', 'collection'],
  edges: [...IMPORT_KINDS, 'navigate', 'calls-function', 'reads', 'writes'],
  unresolved: ['load', 'navigate', 'function', 'data'],
};

const JS_EXT = ['.js', '.jsx', '.mjs', '.cjs'];
const ASSET_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg', '.mp4', '.ttf', '.otf', '.csv', '.json']);
const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'build', 'dist', '.git', '.claude',
  'cache', '.cache', '.expo', '.next', '.turbo', 'coverage', 'web-build']);
// Resolution order for an extensionless relative path. Platform variants are what Metro tries.
const RESOLVE_SUFFIXES = ['', '.js', '.jsx', '.mjs', '.cjs', '.ios.js', '.android.js', '.native.js',
  '/index.js', '/index.jsx', '/index.ios.js', '/index.native.js'];
const SEPARATE_ROOTS = ['functions', 'scripts'];

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node src/mapper.js <project folder> <output name>');
  process.exit(2);
}

const toPosix = (p) => p.split(path.sep).join('/');
const isJs = (p) => JS_EXT.includes(path.extname(p).toLowerCase());
const isCall = (n) => n?.type === 'CallExpression' || n?.type === 'OptionalCallExpression';
const isMember = (n) => n?.type === 'MemberExpression' || n?.type === 'OptionalMemberExpression';
const propName = (m) => (isMember(m) && !m.computed && m.property.type === 'Identifier' ? m.property.name : null);

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
}

const skipped = (rel) => rel.split('/').some((seg) => SKIP_DIRS.has(seg));

// --- file listing -------------------------------------------------------------

// Minimal .gitignore matcher for non-git folders (root .gitignore only).
function gitignoreMatcher(root) {
  let lines = [];
  try { lines = fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/); } catch { return () => false; }
  const rules = [];
  for (let line of lines) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    const neg = line.startsWith('!');
    if (neg) line = line.slice(1);
    if (line.endsWith('/')) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const re = line.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*');
    rules.push({ neg, re: new RegExp(anchored ? `^${re}(/|$)` : `(^|/)${re}(/|$)`) });
  }
  return (rel) => {
    let ignored = false;
    for (const r of rules) if (r.re.test(rel)) ignored = !r.neg;
    return ignored;
  };
}

function listFiles(root) {
  const fromGit = git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  if (fromGit !== null) {
    return { source: 'git', files: fromGit.split('\0').filter(Boolean).filter((f) => !skipped(f) && fs.existsSync(path.join(root, f))) };
  }
  const ignored = gitignoreMatcher(root);
  const files = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = toPosix(path.relative(root, abs));
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name) && !ignored(rel + '/') && !ignored(rel)) walk(abs); }
      else if (e.isFile() && !ignored(rel)) files.push(rel);
    }
  })(root);
  return { source: 'walk', files };
}

// --- AST helpers --------------------------------------------------------------

function literalValue(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

const SKIP_KEYS = new Set(['loc', 'start', 'end', 'extra', 'range', 'leadingComments', 'trailingComments', 'innerComments']);

function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key in node) {
    if (SKIP_KEYS.has(key)) continue;
    const v = node[key];
    if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') walkAst(c, visit); }
    else if (v && typeof v.type === 'string') walkAst(v, visit);
  }
}

function isModuleExports(n) {
  return n?.type === 'MemberExpression' && n.object.type === 'Identifier' && n.object.name === 'module'
    && !n.computed && n.property.name === 'exports';
}

function exportNames(program) {
  const names = new Set();
  const addPattern = (p) => {
    if (!p) return;
    if (p.type === 'Identifier') names.add(p.name);
    else if (p.type === 'ObjectPattern') p.properties.forEach((q) => addPattern(q.type === 'RestElement' ? q.argument : q.value));
    else if (p.type === 'ArrayPattern') p.elements.forEach(addPattern);
    else if (p.type === 'AssignmentPattern') addPattern(p.left);
    else if (p.type === 'RestElement') addPattern(p.argument);
  };
  for (const st of program.body) {
    if (st.type === 'ExportNamedDeclaration') {
      const d = st.declaration;
      if (d?.type === 'VariableDeclaration') d.declarations.forEach((x) => addPattern(x.id));
      else if (d?.id) names.add(d.id.name);
      for (const s of st.specifiers || []) names.add(s.exported.name ?? s.exported.value);
    } else if (st.type === 'ExportDefaultDeclaration') {
      names.add('default');
    } else if (st.type === 'ExportAllDeclaration') {
      names.add(st.exported ? (st.exported.name ?? st.exported.value) : `* from ${st.source.value}`);
    } else if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression') {
      const left = st.expression.left;
      if (isModuleExports(left)) {
        const right = st.expression.right;
        if (right.type === 'ObjectExpression') {
          for (const p of right.properties) {
            if (p.type === 'ObjectProperty' || p.type === 'ObjectMethod') {
              const k = p.key.type === 'Identifier' ? p.key.name : literalValue(p.key);
              if (k) names.add(k);
            }
          }
        } else names.add('default');
      } else if (left.type === 'MemberExpression' && !left.computed
        && ((left.object.type === 'Identifier' && left.object.name === 'exports') || isModuleExports(left.object))) {
        names.add(left.property.name);
      }
    }
  }
  return [...names];
}

function parseFile(code) {
  return parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowAwaitOutsideFunction: true,
    plugins: ['jsx'],
  });
}

// Collect every module load in the file: { kind, spec | null, line }.
function collectLoads(ast) {
  const loads = [];
  walkAst(ast.program, (n) => {
    switch (n.type) {
      case 'ImportDeclaration':
        loads.push({ kind: 'import', spec: n.source.value, line: n.loc.start.line });
        break;
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (n.source) loads.push({ kind: 're-export', spec: n.source.value, line: n.loc.start.line });
        break;
      case 'ImportExpression': // Babel 8 dynamic import()
        loads.push({ kind: 'dynamic', spec: literalValue(n.source), line: n.loc.start.line });
        break;
      case 'CallExpression': {
        if (n.callee.type === 'Import') {
          loads.push({ kind: 'dynamic', spec: literalValue(n.arguments[0]), line: n.loc.start.line });
        } else if (n.callee.type === 'Identifier' && n.callee.name === 'require' && n.arguments.length >= 1) {
          loads.push({ kind: 'require', spec: literalValue(n.arguments[0]), line: n.loc.start.line });
        }
        break;
      }
    }
  });
  return loads;
}

// --- scope analysis -----------------------------------------------------------
// Parent links, lexical scopes, bindings, references and assignments for one file.
// Approximate (no var hoisting), which is enough for "is this a literal in the same file".

const SCOPE_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod',
  'ClassMethod', 'ClassPrivateMethod', 'BlockStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement',
  'CatchClause', 'SwitchStatement', 'StaticBlock']);
const FUNC_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod',
  'ClassMethod', 'ClassPrivateMethod']);

function patternIds(p, out = []) {
  if (!p) return out;
  if (p.type === 'Identifier') out.push(p);
  else if (p.type === 'ObjectPattern') for (const q of p.properties) patternIds(q.type === 'RestElement' ? q.argument : q.value, out);
  else if (p.type === 'ArrayPattern') for (const e of p.elements) patternIds(e, out);
  else if (p.type === 'AssignmentPattern') patternIds(p.left, out);
  else if (p.type === 'RestElement') patternIds(p.argument, out);
  return out;
}

function isReference(par, key) {
  if (!par) return true;
  if (isMember(par) && key === 'property' && !par.computed) return false;
  if ((par.type === 'ObjectProperty' || par.type === 'ObjectMethod' || par.type === 'ClassMethod'
    || par.type === 'ClassProperty' || par.type === 'ClassPrivateProperty') && key === 'key' && !par.computed) return false;
  if (['LabeledStatement', 'BreakStatement', 'ContinueStatement'].includes(par.type)) return false;
  if (['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'ExportSpecifier', 'MetaProperty'].includes(par.type)) return false;
  return true;
}

function analyze(ast) {
  const parent = new Map(), parentKey = new Map(), scopeOf = new Map();
  const refs = new Map(), assigns = new Map(), declIds = new Set();
  const push = (m, k, v) => (m.get(k) ?? m.set(k, []).get(k)).push(v);
  const program = { up: null, decls: new Map() };
  const declare = (scope, id, info) => { declIds.add(id); scope.decls.set(id.name, { name: id.name, ...info }); };

  function visit(node, scope, par, key) {
    parent.set(node, par); parentKey.set(node, key); scopeOf.set(node, scope);
    const inner = SCOPE_TYPES.has(node.type) ? { up: scope, decls: new Map() } : scope;
    switch (node.type) {
      case 'ImportDeclaration':
        for (const s of node.specifiers) declare(program, s.local, { kind: 'import', spec: node.source.value });
        break;
      case 'VariableDeclaration':
        for (const d of node.declarations) {
          for (const id of patternIds(d.id)) declare(scope, id, d.id.type === 'Identifier' ? { kind: node.kind, init: d.init } : { kind: 'pattern' });
        }
        break;
      case 'FunctionDeclaration': case 'ClassDeclaration':
        if (node.id) declare(scope, node.id, { kind: 'function' });
        break;
      case 'CatchClause':
        for (const id of patternIds(node.param)) declare(inner, id, { kind: 'param' });
        break;
      case 'AssignmentExpression':
        if (node.left.type === 'Identifier') push(assigns, node.left.name, node);
        break;
      case 'UpdateExpression':
        if (node.argument.type === 'Identifier') push(assigns, node.argument.name, node);
        break;
      case 'Identifier':
        if (!declIds.has(node) && isReference(par, key)) push(refs, node.name, node);
        break;
    }
    if (FUNC_TYPES.has(node.type)) {
      for (const p of node.params) for (const id of patternIds(p)) declare(inner, id, { kind: 'param' });
      if (node.type === 'FunctionExpression' && node.id) declare(inner, node.id, { kind: 'function' });
    }
    for (const k in node) {
      if (SKIP_KEYS.has(k)) continue;
      const v = node[k];
      if (Array.isArray(v)) { for (const c of v) if (c && typeof c.type === 'string') visit(c, inner, node, k); }
      else if (v && typeof v.type === 'string') visit(v, inner, node, k);
    }
  }
  visit(ast.program, program, null, null);

  const lookup = (name, node) => {
    for (let s = scopeOf.get(node); s; s = s.up) { const b = s.decls.get(name); if (b) return b; }
    return null;
  };
  return {
    parent: (n) => parent.get(n),
    key: (n) => parentKey.get(n),
    lookup,
    usesOf: (b) => (refs.get(b.name) || []).filter((r) => lookup(b.name, r) === b),
    assignmentsOf: (b) => (assigns.get(b.name) || []).filter((a) => lookup(b.name, a) === b),
    nodes: () => parent.keys(),
  };
}

const union = (...arrs) => (arrs.some((a) => a === null) ? null : [...new Set(arrs.flat())]);

// The object or array literal an expression refers to (inline, via const, or via a static member).
function objectOf(node, A, depth = 0) {
  if (!node || depth > 8) return null;
  if (node.type === 'ObjectExpression' || node.type === 'ArrayExpression') return node;
  if (node.type === 'Identifier') {
    const b = A.lookup(node.name, node);
    return b?.kind === 'const' && b.init ? objectOf(b.init, A, depth + 1) : null;
  }
  if (isMember(node)) {
    const obj = objectOf(node.object, A, depth + 1);
    const k = node.computed ? literalValue(node.property) ?? (node.property.type === 'NumericLiteral' ? String(node.property.value) : null) : node.property.name;
    if (!obj || k === null) return null;
    const v = memberValues(obj, [k]);
    return v?.length === 1 ? objectOf(v[0], A, depth + 1) : null;
  }
  return null;
}

// Values of the given keys (or of all members when keys is null); null if any is missing.
function memberValues(obj, keys) {
  if (obj.type === 'ObjectExpression') {
    if (obj.properties.some((p) => p.type !== 'ObjectProperty' || p.computed)) {
      if (keys === null) return null;
    }
    const props = obj.properties.filter((p) => p.type === 'ObjectProperty' && !p.computed);
    const keyOf = (p) => (p.key.type === 'Identifier' ? p.key.name : literalValue(p.key) ?? (p.key.type === 'NumericLiteral' ? String(p.key.value) : null));
    if (keys === null) return props.map((p) => p.value);
    const out = [];
    for (const k of keys) { const p = props.find((q) => keyOf(q) === k); if (!p) return null; out.push(p.value); }
    return out;
  }
  if (obj.type === 'ArrayExpression') {
    if (obj.elements.some((e) => !e || e.type === 'SpreadElement')) return null;
    if (keys === null) return obj.elements;
    const out = [];
    for (const k of keys) { const e = obj.elements[Number(k)]; if (!e) return null; out.push(e); }
    return out;
  }
  return null;
}

// Every string an expression can evaluate to, if all of them are literals in this file; else null.
function stringValues(node, A, depth = 0) {
  if (!node || depth > 8) return null;
  const lit = literalValue(node);
  if (lit !== null) return [lit];
  switch (node.type) {
    case 'ConditionalExpression':
      return union(stringValues(node.consequent, A, depth + 1), stringValues(node.alternate, A, depth + 1));
    case 'LogicalExpression':
      return node.operator === '&&' ? null : union(stringValues(node.left, A, depth + 1), stringValues(node.right, A, depth + 1));
    case 'Identifier': {
      const b = A.lookup(node.name, node);
      if (!b || !['const', 'let', 'var'].includes(b.kind)) return null;
      const parts = [];
      if (b.init) parts.push(stringValues(b.init, A, depth + 1));
      else if (b.kind === 'const') return null;
      if (b.kind !== 'const') {
        for (const a of A.assignmentsOf(b)) {
          if (a.type !== 'AssignmentExpression' || a.operator !== '=') return null;
          parts.push(stringValues(a.right, A, depth + 1));
        }
      }
      return parts.length ? union(...parts) : null;
    }
    case 'MemberExpression': case 'OptionalMemberExpression': {
      const obj = objectOf(node.object, A, depth + 1);
      if (!obj) return null;
      let keys;
      if (!node.computed) keys = [node.property.name];
      else if (node.property.type === 'NumericLiteral') keys = [String(node.property.value)];
      else keys = stringValues(node.property, A, depth + 1); // null -> any member
      const vals = memberValues(obj, keys);
      return vals ? union(...vals.map((v) => stringValues(v, A, depth + 1))) : null;
    }
  }
  return null;
}

// A name argument: direct literal, or inferred from same-file literals.
function nameValues(node, A) {
  const lit = literalValue(node);
  if (lit !== null) return { values: [lit], inferred: false };
  return { values: stringValues(node, A), inferred: true };
}

// --- navigation pass ----------------------------------------------------------

const NAV_METHODS = new Set(['navigate', 'push', 'replace', 'reset']);
// push/replace/reset are also String/Array/form methods, so they count only on a navigation-like receiver.
const NAV_RECEIVER = /^(nav\w*|\w*Navigation\w*|\w*navigationRef\w*|StackActions|CommonActions|TabActions|DrawerActions)$/i;

function receiverName(obj) {
  let n = obj;
  while (isMember(n)) {
    if (!n.computed && n.property.type === 'Identifier' && n.property.name !== 'current') return n.property.name;
    n = n.object;
  }
  return n?.type === 'Identifier' ? n.name : n?.type === 'ThisExpression' ? 'this' : null;
}

function objProp(obj, key) {
  if (obj?.type !== 'ObjectExpression') return undefined;
  const p = obj.properties.find((q) => q.type === 'ObjectProperty' && !q.computed && (q.key.name === key || q.key.value === key));
  return p ? p.value : undefined;
}

// Follow { screen: 'X', params: { screen: 'Y' } } down; each level may have several inferred values.
function nestedScreens(params, A) {
  const levels = [];
  let cur = objectOf(params, A);
  while (cur?.type === 'ObjectExpression') {
    const s = objProp(cur, 'screen');
    if (s === undefined) break;
    const n = nameValues(s, A);
    if (!n.values) return { levels, computed: true };
    levels.push(n);
    cur = objectOf(objProp(cur, 'params'), A);
  }
  return { levels, computed: false };
}

function makeTargets(nameNode, paramsNode, A, line) {
  const first = nameValues(nameNode, A);
  if (!first.values) return [{ computed: true, line }];
  const { levels, computed } = nestedScreens(paramsNode, A);
  const out = [];
  if (levels.length) {
    const last = levels[levels.length - 1];
    const via = [first.values.join('|'), ...levels.slice(0, -1).map((l) => l.values.join('|'))];
    const inferred = first.inferred || levels.some((l) => l.inferred);
    for (const v of last.values) out.push({ name: v, via, inferred, line });
  } else {
    for (const v of first.values) out.push({ name: v, via: [], inferred: first.inferred, line });
  }
  if (computed) out.push({ computed: true, line });
  return out;
}

// A route object { name, params } or { name, state: { routes: [...] } } -> targets.
function routeTargets(route, A, line) {
  const obj = objectOf(route, A);
  if (obj?.type !== 'ObjectExpression') return [{ computed: true, line }];
  const name = objProp(obj, 'name');
  const out = name === undefined ? [{ computed: true, line }] : makeTargets(name, objProp(obj, 'params'), A, line);
  const routes = objectOf(objProp(objectOf(objProp(obj, 'state'), A), 'routes'), A);
  if (routes?.type === 'ArrayExpression') for (const r of routes.elements) out.push(...routeTargets(r, A, line));
  return out;
}

function collectNavCalls(A) {
  const calls = [];
  let skippedNonNav = 0;
  for (const n of A.nodes()) {
    if (!isCall(n)) continue;
    const c = n.callee;
    let method = null, recv = null;
    if (isMember(c)) { method = propName(c); recv = receiverName(c.object); }
    else if (c.type === 'Identifier') method = c.name;
    if (!NAV_METHODS.has(method)) continue;
    if (method !== 'navigate' && !(recv && NAV_RECEIVER.test(recv))) { skippedNonNav++; continue; }
    const line = n.loc.start.line;
    const [a0, a1] = n.arguments;
    let targets;
    if (method === 'reset') {
      const routes = objectOf(objProp(objectOf(a0, A), 'routes'), A);
      if (routes?.type === 'ArrayExpression') targets = routes.elements.flatMap((r) => routeTargets(r, A, line));
      else targets = makeTargets(a0, undefined, A, line);
    } else if (a0?.type === 'ObjectExpression') {
      targets = routeTargets(a0, A, line); // navigate({ name, params })
    } else {
      targets = makeTargets(a0, a1, A, line);
    }
    calls.push({ method, line, targets });
  }
  return { calls, skippedNonNav };
}

// Local name -> { spec } (import / require) or { local: true } (defined in this file).
function bindings(program) {
  const b = new Map();
  const reqSpec = (init) => {
    let e = init;
    if (e?.type === 'ConditionalExpression') return reqSpec(e.consequent) ?? reqSpec(e.alternate);
    if (e?.type === 'LogicalExpression') return reqSpec(e.right) ?? reqSpec(e.left);
    if (e?.type === 'MemberExpression') e = e.object; // require('x').default
    if (e?.type === 'CallExpression' && e.callee.name === 'require') return literalValue(e.arguments[0]);
    if (e?.type === 'CallExpression' && /^(React\.)?lazy$/.test(e.callee.name ?? `${e.callee.object?.name}.${e.callee.property?.name}`)) {
      const body = e.arguments[0]?.body;
      if (body?.type === 'ImportExpression') return literalValue(body.source);
      if (body?.type === 'CallExpression') return literalValue(body.arguments[0]);
    }
    return undefined;
  };
  for (const st of program.body) {
    if (st.type === 'ImportDeclaration') for (const s of st.specifiers) b.set(s.local.name, { spec: st.source.value });
    const decl = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
    if (!decl) continue;
    if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id) b.set(decl.id.name, { local: true });
    if (decl.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        const spec = reqSpec(d.init);
        const names = d.id.type === 'Identifier' ? [d.id.name]
          : d.id.type === 'ObjectPattern' ? d.id.properties.map((p) => p.value?.name).filter(Boolean) : [];
        for (const nm of names) b.set(nm, spec ? { spec } : { local: true });
      }
    }
  }
  return b;
}

const jsxTag = (n) => (n.type === 'JSXMemberExpression' ? `${jsxTag(n.object)}.${n.property.name}` : n.name);

// Screens registered in this file: <X.Screen name="..." component={C} />, with the
// top-level component that hosts each navigator (for nesting).
function collectScreens(ast) {
  const screens = [];
  (function walk(node, host) {
    if (!node || typeof node.type !== 'string') return;
    if (node.type === 'FunctionDeclaration' && node.id && /^[A-Z]/.test(node.id.name)) host = node.id.name;
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && /^[A-Z]/.test(node.id.name)) host = node.id.name;
    if (node.type === 'JSXOpeningElement') {
      const tag = jsxTag(node.name);
      if (/\.Screen$/.test(tag)) {
        const attr = (k) => node.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === k);
        const nameAttr = attr('name')?.value;
        const name = nameAttr?.type === 'StringLiteral' ? nameAttr.value
          : nameAttr?.type === 'JSXExpressionContainer' ? literalValue(nameAttr.expression) : null;
        const comp = attr('component')?.value?.expression;
        const getComp = attr('getComponent')?.value?.expression;
        let component = null, spec;
        if (comp?.type === 'Identifier') component = comp.name;
        else if (comp?.type === 'MemberExpression') component = `${comp.object.name}.${comp.property.name}`;
        if (getComp?.body) {
          const body = getComp.body.type === 'MemberExpression' ? getComp.body.object : getComp.body;
          if (body?.type === 'CallExpression' && body.callee.name === 'require') spec = literalValue(body.arguments[0]);
        }
        screens.push({ name, component, spec, navigator: tag.replace(/\.Screen$/, ''), host, line: node.loc.start.line });
      }
    }
    for (const key in node) {
      if (SKIP_KEYS.has(key)) continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, host));
      else if (v && typeof v.type === 'string') walk(v, host);
    }
  })(ast.program, null);
  return screens;
}

// --- cloud functions pass -----------------------------------------------------

// httpsCallable(functions, 'name') or functions().httpsCallable('name').
function collectCallables(A) {
  const out = [];
  for (const n of A.nodes()) {
    if (!isCall(n)) continue;
    let nameNode;
    if (n.callee.type === 'Identifier' && n.callee.name === 'httpsCallable') nameNode = n.arguments[1];
    else if (propName(n.callee) === 'httpsCallable') nameNode = n.arguments[0];
    else continue;
    out.push({ name: literalValue(nameNode), line: n.loc.start.line });
  }
  return out;
}

// Exported functions of the functions entry: name -> file that defines it.
function functionDefinitions(ast, rel, resolve) {
  const defs = new Map();
  const b = bindings(ast.program);
  const fileFor = (rhs) => {
    let e = rhs;
    if (isMember(e)) e = e.object;
    if (e?.type === 'CallExpression' && e.callee.name === 'require') {
      const spec = literalValue(e.arguments[0]);
      return spec?.startsWith('.') ? resolve(rel, spec) ?? rel : rel;
    }
    if (e?.type === 'Identifier') {
      const spec = b.get(e.name)?.spec;
      return spec?.startsWith('.') ? resolve(rel, spec) ?? rel : rel;
    }
    return rel;
  };
  for (const st of ast.program.body) {
    if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression') {
      const { left, right } = st.expression;
      if (isMember(left) && !left.computed && ((left.object.type === 'Identifier' && left.object.name === 'exports') || isModuleExports(left.object))) {
        defs.set(left.property.name, fileFor(right));
      } else if (isModuleExports(left) && right.type === 'ObjectExpression') {
        for (const p of right.properties) {
          if (p.type === 'ObjectProperty' && !p.computed) defs.set(p.key.name ?? p.key.value, fileFor(p.value));
          if (p.type === 'SpreadElement') {
            const f = fileFor(p.argument);
            if (f !== rel) defs.set(`* from ${f}`, f);
          }
        }
      }
    } else if (st.type === 'ExportNamedDeclaration') {
      if (st.declaration?.type === 'VariableDeclaration') for (const d of st.declaration.declarations) for (const id of patternIds(d.id)) defs.set(id.name, rel);
      else if (st.declaration?.id) defs.set(st.declaration.id.name, rel);
      for (const s of st.specifiers || []) {
        const name = s.exported.name ?? s.exported.value;
        defs.set(name, st.source ? resolve(rel, st.source.value) ?? rel : fileFor({ type: 'Identifier', name: s.local.name }));
      }
    }
  }
  return defs;
}

// --- Firestore pass -----------------------------------------------------------

const FS_REF_FNS = new Set(['collection', 'doc', 'collectionGroup']);
const FS_READ_FNS = new Set(['getDoc', 'getDocs', 'getDocFromServer', 'getDocsFromServer', 'getDocFromCache',
  'getDocsFromCache', 'onSnapshot', 'getCountFromServer', 'getAggregateFromServer']);
const FS_WRITE_FNS = new Set(['setDoc', 'updateDoc', 'addDoc', 'deleteDoc']);
const FS_QUERY_FNS = new Set(['query']);
// Chained (firebase-admin / namespaced) style.
const CHAIN_READ = new Set(['get', 'onSnapshot', 'listDocuments', 'count']);
const CHAIN_WRITE = new Set(['set', 'update', 'delete', 'add', 'create']);
const CHAIN_QUERY = new Set(['where', 'orderBy', 'limit', 'limitToLast', 'startAt', 'startAfter', 'endAt', 'endBefore', 'select', 'offset', 'withConverter']);
// batch.set(ref) / transaction.get(ref)
const ARG_READ = new Set(['get', 'getAll']);
const ARG_WRITE = new Set(['set', 'update', 'delete', 'create']);
const REF_PROPS = new Set(['id', 'path', 'parent', 'type', 'firestore']);
const DB_NAME =/^(db|firestore|fs|database|firestoreDb|adminDb|\w*Db)$/;

// Identifier callee that is Firestore's: imported (or a global), not a local variable or parameter.
function fsFn(n, names, A) {
  if (!isCall(n) || n.callee.type !== 'Identifier' || !names.has(n.callee.name)) return null;
  const b = A.lookup(n.callee.name, n.callee);
  return !b || b.kind === 'import' ? n.callee.name : null;
}

function isDbLike(node, A) {
  if (node?.type === 'Identifier') {
    if (DB_NAME.test(node.name)) return true;
    const b = A.lookup(node.name, node);
    return !!(b?.init && isCall(b.init) && /^(getFirestore|initializeFirestore|firestore)$/.test(b.init.callee.name ?? propName(b.init.callee) ?? ''));
  }
  if (isCall(node)) return /^(getFirestore|initializeFirestore|firestore)$/.test(node.callee.name ?? propName(node.callee) ?? '');
  return false;
}

const segOf = (arg) => {
  if (!arg) return { text: '{}', node: null };
  const lit = literalValue(arg);
  if (lit !== null) return { text: lit, node: arg };
  if (arg.type === 'TemplateLiteral') return { text: arg.quasis.map((q) => q.value.cooked).join('{}'), node: arg };
  return { text: '{}', node: arg };
};

// The path segments a Firestore reference expression points at.
// Returns null (not a reference), { unresolved: true }, or { segs: [{ text, node }] }.
function refPath(node, A, depth = 0) {
  if (!node || depth > 10) return null;
  if (node.type === 'Identifier') {
    const b = A.lookup(node.name, node);
    return b && ['const', 'let', 'var'].includes(b.kind) && b.init ? refPath(b.init, A, depth + 1) : null;
  }
  if (node.type === 'AwaitExpression') return null;
  if (!isCall(node)) return null;
  const fn = fsFn(node, FS_REF_FNS, A) ?? fsFn(node, FS_QUERY_FNS, A);
  const args = node.arguments;
  if (fn === 'query') return refPath(args[0], A, depth + 1);
  if (fn === 'collectionGroup') return { segs: [segOf(args[1])], group: true };
  if (fn === 'collection' || fn === 'doc') {
    if (!args.length) return null;
    const base = refPath(args[0], A, depth + 1);
    const rest = args.slice(1).map(segOf);
    if (base?.unresolved) return base;
    if (base) return { segs: [...base.segs, ...(rest.length ? rest : [{ text: '{}', node: null }])] };
    if (isDbLike(args[0], A) && rest.length) return { segs: rest };
    return { unresolved: true };
  }
  const prop = propName(node.callee);
  if (!prop) return null;
  const recv = node.callee.object;
  if (prop === 'collection' || prop === 'collectionGroup') {
    const base = refPath(recv, A, depth + 1);
    if (base?.unresolved) return base;
    if (base) return { segs: [...base.segs, segOf(args[0])] };
    return isDbLike(recv, A) ? { segs: [segOf(args[0])], group: prop === 'collectionGroup' } : null;
  }
  if (prop === 'doc' || CHAIN_QUERY.has(prop)) {
    const base = refPath(recv, A, depth + 1);
    if (!base || base.unresolved) return base;
    return prop === 'doc' ? { segs: [...base.segs, segOf(args[0])] } : base;
  }
  return null;
}

// Is this call a reference constructor (the start of a Firestore path)?
function isRefCtor(n, A) {
  if (fsFn(n, FS_REF_FNS, A)) return true;
  const prop = propName(n.callee);
  if (prop === 'collection' || prop === 'collectionGroup') return isDbLike(n.callee.object, A) || !!refPath(n.callee.object, A);
  if (prop === 'doc') return !!refPath(n.callee.object, A);
  return false;
}

// How a reference expression is used: 'reads', 'writes', 'unknown', or 'base' (feeds a longer path).
function opsFor(node, A, depth = 0, seen = new Set()) {
  const p = A.parent(node), k = A.key(node);
  if (!p || depth > 8) return ['unknown'];
  if (isCall(p) && k === 'arguments') {
    const c = p.callee;
    if (c.type === 'Identifier') {
      if (FS_READ_FNS.has(c.name)) return ['reads'];
      if (FS_WRITE_FNS.has(c.name)) return ['writes'];
      if (FS_QUERY_FNS.has(c.name) && p.arguments[0] === node) return opsFor(p, A, depth + 1, seen);
      if (FS_REF_FNS.has(c.name) && p.arguments[0] === node) return ['base'];
      return ['unknown'];
    }
    const prop = propName(c);
    if (prop && p.arguments[0] === node) {
      if (ARG_READ.has(prop)) return ['reads'];
      if (ARG_WRITE.has(prop)) return ['writes'];
    }
    return ['unknown'];
  }
  if (isMember(p) && k === 'object' && !p.computed) {
    const g = A.parent(p), prop = propName(p);
    if (REF_PROPS.has(prop) && !(isCall(g) && A.key(p) === 'callee')) return ['none']; // ref.id, ref.path
    if (isCall(g) && A.key(p) === 'callee') {
      if (CHAIN_READ.has(prop)) return ['reads'];
      if (CHAIN_WRITE.has(prop)) return ['writes'];
      if (CHAIN_QUERY.has(prop)) return opsFor(g, A, depth + 1, seen);
      if (prop === 'doc' || prop === 'collection' || prop === 'collectionGroup') return ['base'];
    }
    return ['unknown'];
  }
  // Several uses: a real read/write wins over incidental uses (passed along, .id, ...).
  const merge = (ops) => {
    const rw = ops.filter((o) => o === 'reads' || o === 'writes');
    if (rw.length) return rw;
    if (ops.includes('unknown')) return ['unknown'];
    return ops.includes('base') ? ['base'] : ['none'];
  };
  const viaBinding = (b) => {
    if (!b || seen.has(b)) return ['unknown'];
    seen.add(b);
    const uses = A.usesOf(b);
    return uses.length ? merge(uses.flatMap((u) => opsFor(u, A, depth + 1, seen))) : ['unknown'];
  };
  if (p.type === 'VariableDeclarator' && k === 'init' && p.id.type === 'Identifier') return viaBinding(A.lookup(p.id.name, p.id));
  if (p.type === 'AssignmentExpression' && k === 'right' && p.left.type === 'Identifier') return viaBinding(A.lookup(p.left.name, p));
  // Returned from a helper defined in this file: follow the helper's call sites.
  if (p.type === 'ReturnStatement' || (p.type === 'ArrowFunctionExpression' && k === 'body')) {
    let f = p;
    if (p.type === 'ReturnStatement') { f = A.parent(p); while (f && !FUNC_TYPES.has(f.type)) f = A.parent(f); }
    if (!f || seen.has(f)) return ['unknown'];
    seen.add(f);
    let b = null;
    if (f.type === 'FunctionDeclaration' && f.id) b = A.lookup(f.id.name, f.id);
    else { const d = A.parent(f); if (d?.type === 'VariableDeclarator' && d.id.type === 'Identifier') b = A.lookup(d.id.name, d.id); }
    const calls = b ? A.usesOf(b).filter((u) => isCall(A.parent(u)) && A.key(u) === 'callee').map((u) => A.parent(u)) : [];
    return calls.length ? merge(calls.flatMap((c) => opsFor(c, A, depth + 1, seen))) : ['unknown'];
  }
  if (p.type === 'AwaitExpression') return opsFor(p, A, depth + 1, seen);
  if (['ConditionalExpression', 'LogicalExpression', 'ParenthesizedExpression', 'SequenceExpression'].includes(p.type)) return opsFor(p, A, depth + 1, seen);
  return ['unknown'];
}

function collectData(A) {
  const uses = [], unresolvedLines = [];
  for (const n of A.nodes()) {
    if (!isCall(n) || !isRefCtor(n, A)) continue;
    let ops = [...new Set(opsFor(n, A))];
    if (ops.length === 1 && ops[0] === 'base') continue; // the longer path is recorded instead
    ops = ops.filter((o) => o !== 'base' && o !== 'none');
    if (!ops.length) ops = ['unknown']; // only its id / path is used
    const line = n.loc.start.line;
    const r = refPath(n, A);
    if (!r || r.unresolved || !r.segs.length) { unresolvedLines.push(line); continue; }
    const pathText = r.segs.map((s) => s.text).join('/').split('/').filter(Boolean).join('/');
    let tops, inferred = false;
    const first = r.segs[0];
    const head = first.text.split('/')[0];
    if (head && !head.includes('{')) tops = [head];
    else if (first.node && first.node.type !== 'TemplateLiteral') {
      const v = stringValues(first.node, A);
      if (v) { tops = [...new Set(v.map((x) => x.split('/')[0]).filter((x) => x && !x.includes('{')))]; inferred = true; }
    }
    if (!tops?.length) { unresolvedLines.push(line); continue; }
    for (const collection of tops) {
      for (const op of ops) if (op !== 'base') uses.push({ collection, path: inferred ? pathText.replace(/^[^/]*/, collection) : pathText, op, line, inferred, group: !!r.group });
    }
  }
  return { uses, unresolvedLines };
}

// --- resolution ---------------------------------------------------------------

function makeResolver(root) {
  const cache = new Map();
  const isFile = (abs) => {
    if (!cache.has(abs)) { let ok = false; try { ok = fs.statSync(abs).isFile(); } catch {} cache.set(abs, ok); }
    return cache.get(abs);
  };
  return (fromRel, spec) => {
    const base = spec.startsWith('/') ? spec : path.join(root, path.dirname(fromRel), spec);
    for (const suf of RESOLVE_SUFFIXES) {
      const cand = base + suf;
      if (isFile(cand) && (suf !== '' || isJs(cand))) return toPosix(path.relative(root, cand));
    }
    return null;
  };
}

const packageName = (spec) => {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const countBy = (arr, f) => arr.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o; }, {});

// --- main ---------------------------------------------------------------------

function main() {
  const [projectArg, outName] = process.argv.slice(2);
  if (!projectArg || !outName) usage();
  if (!/^[A-Za-z0-9._-]+$/.test(outName) || outName === '.' || outName === '..') usage('Output name may only use letters, digits, dot, dash and underscore.');
  const root = path.resolve(projectArg.replace(/^~(?=$|\/)/, os.homedir()));
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) usage(`Not a folder: ${root}`);

  const outDir = path.join(os.homedir(), '.brain', 'maps', outName);
  const brainDir = path.join(os.homedir(), 'Brain');
  const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
  if (inside(outDir, root)) usage('Refusing to write inside the project folder.');
  if (inside(outDir, brainDir)) usage('Refusing to write inside ~/Brain.');

  const t0 = process.hrtime.bigint();
  const { source: listSource, files: allFiles } = listFiles(root);
  const jsFiles = allFiles.filter(isJs).sort();

  // Root groups: the project itself, plus separate roots such as functions/ and scripts/.
  const rootGroups = [{ name: 'app', dir: '' }];
  for (const d of SEPARATE_ROOTS) {
    if (fs.existsSync(path.join(root, d)) && fs.statSync(path.join(root, d)).isDirectory()) rootGroups.push({ name: d, dir: d });
  }
  const groupOf = (rel) => rootGroups.find((g) => g.dir && (rel === g.dir || rel.startsWith(g.dir + '/')))?.name ?? 'app';
  for (const g of rootGroups) {
    const pkgPath = path.join(root, g.dir, 'package.json');
    g.hasPackageJson = fs.existsSync(pkgPath);
    let main = null;
    if (g.hasPackageJson) { try { main = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).main ?? null; } catch {} }
    g.entry = null;
    for (const cand of [main, 'index.js'].filter(Boolean)) {
      const rel = toPosix(path.join(g.dir, cand)).replace(/^\.\//, '');
      if (jsFiles.includes(rel)) { g.entry = rel; break; }
    }
  }
  const functionsEntry = rootGroups.find((g) => g.name === 'functions')?.entry ?? null;

  const resolve = makeResolver(root);
  const nodeSet = new Set(jsFiles);
  const nodes = [], edges = [], unresolved = [], missing = [], parseFailures = [];
  const rawScreens = [], navCallsByFile = new Map(), callablesByFile = new Map(), dataByFile = new Map();
  let navSkippedNonNav = 0, functionDefs = new Map();
  const assetTotals = { total: 0, byExtension: {} };

  for (const rel of jsFiles) {
    const code = fs.readFileSync(path.join(root, rel), 'utf8');
    const lines = code.length === 0 ? 0 : code.split('\n').length - (code.endsWith('\n') ? 1 : 0);
    const segs = rel.split('/');
    const node = {
      id: rel,
      kind: 'file',
      path: rel,
      topFolder: segs.length > 1 ? segs[0] : '(root)',
      rootGroup: groupOf(rel),
      exports: [],
      lines,
      packageImports: 0,
      packages: [],
    };
    nodes.push(node);

    let ast;
    try { ast = parseFile(code); }
    catch (e) {
      node.parseError = true;
      parseFailures.push({ file: rel, line: e.loc?.line ?? null, reason: e.reasonCode ?? 'SyntaxError' });
      continue;
    }
    node.exports = exportNames(ast.program);

    const pkgs = new Set();
    for (const ld of collectLoads(ast)) {
      if (ld.spec === null) { unresolved.push({ file: rel, line: ld.line, kind: 'load' }); continue; }
      const ext = path.extname(ld.spec.split('?')[0]).toLowerCase();
      if (ASSET_EXT.has(ext)) {
        assetTotals.total++;
        assetTotals.byExtension[ext.slice(1)] = (assetTotals.byExtension[ext.slice(1)] || 0) + 1;
        continue;
      }
      if (ld.spec.startsWith('.') || ld.spec.startsWith('/')) {
        const to = resolve(rel, ld.spec);
        if (to && nodeSet.has(to)) edges.push({ from: rel, to, kind: ld.kind, line: ld.line });
        else missing.push({ file: rel, line: ld.line, ...(to ? { resolvedOutsideScan: true } : {}) });
      } else {
        node.packageImports++;
        pkgs.add(packageName(ld.spec));
      }
    }
    node.packages = [...pkgs].sort();

    if (rel === functionsEntry) functionDefs = functionDefinitions(ast, rel, resolve);

    if (node.rootGroup === 'app') {
      const A = analyze(ast);
      const found = collectScreens(ast);
      if (found.length) {
        const b = bindings(ast.program);
        for (const s of found) {
          const bind = s.component ? b.get(s.component.split('.')[0]) : null;
          const spec = s.spec ?? bind?.spec;
          let file = null;
          if (spec && (spec.startsWith('.') || spec.startsWith('/'))) file = resolve(rel, spec);
          else if (!spec && (bind?.local || !s.component)) file = rel; // defined here, or children render
          rawScreens.push({ ...s, navigatorFile: rel, file, localComponent: !spec && !!bind?.local });
        }
      }
      const { calls, skippedNonNav } = collectNavCalls(A);
      navSkippedNonNav += skippedNonNav;
      if (calls.length) navCallsByFile.set(rel, calls);
      const callables = collectCallables(A);
      if (callables.length) callablesByFile.set(rel, callables);
      const data = collectData(A);
      if (data.uses.length || data.unresolvedLines.length) dataByFile.set(rel, data);
    }
  }

  // --- navigation: screens, nesting, navigate edges
  const screens = rawScreens.map((s) => ({
    name: s.name, component: s.component, file: s.file, navigator: s.navigator,
    navigatorFile: s.navigatorFile, line: s.line, host: s.host, localComponent: s.localComponent,
  }));
  // A navigator hosted by component H in file F is nested under the screen that renders H
  // (defined locally in F), or under a screen whose component is imported from F.
  const hostsIn = (f) => new Set(screens.filter((x) => x.navigatorFile === f).map((x) => x.host));
  for (const s of screens) {
    const parent = screens.find((p) => !(p.navigatorFile === s.navigatorFile && p.host === s.host)
      && p.file === s.navigatorFile && (p.localComponent ? p.component === s.host : hostsIn(s.navigatorFile).size === 1));
    s.parent = parent ? parent.name : null;
  }
  for (const s of screens) { delete s.host; delete s.localComponent; }
  const screensByName = new Map();
  for (const s of screens) if (s.name) (screensByName.get(s.name) ?? screensByName.set(s.name, []).get(s.name)).push(s);

  const navStats = { calls: 0, targets: 0, matched: 0, matchedInferred: 0, computed: 0, inferredCalls: 0, unmatched: [], byMethod: {}, skippedNonNavigationReceivers: navSkippedNonNav };
  const navIncoming = new Map(), viaIncoming = new Map();
  for (const [from, calls] of navCallsByFile) {
    for (const call of calls) {
      navStats.calls++;
      navStats.byMethod[call.method] = (navStats.byMethod[call.method] || 0) + 1;
      if (call.targets.some((t) => t.inferred)) navStats.inferredCalls++;
      for (const t of call.targets) {
        navStats.targets++;
        if (t.computed) { navStats.computed++; unresolved.push({ file: from, line: t.line, kind: 'navigate' }); continue; }
        const hits = screensByName.get(t.name);
        if (!hits) { navStats.unmatched.push({ name: t.name, file: from, line: t.line, ...(t.inferred ? { inferred: true } : {}) }); continue; }
        navStats.matched++;
        if (t.inferred) navStats.matchedInferred++;
        navIncoming.set(t.name, (navIncoming.get(t.name) || 0) + 1);
        for (const via of t.via) for (const v of via.split('|')) viaIncoming.set(v, (viaIncoming.get(v) || 0) + 1);
        for (const h of hits) {
          if (h.file) edges.push({ from, to: h.file, kind: 'navigate', line: t.line, screen: t.name, method: call.method,
            ...(t.via.length ? { via: t.via } : {}), ...(t.inferred ? { inferred: true } : {}) });
        }
      }
    }
  }
  for (const s of screens) {
    s.incomingNavigation = navIncoming.get(s.name) || 0;
    s.incomingAsNestedParent = viaIncoming.get(s.name) || 0;
  }

  // --- cloud functions: calls-function edges
  const fnStats = { calls: 0, matched: 0, computed: 0, unmatched: [], names: {} };
  for (const [from, calls] of callablesByFile) {
    for (const c of calls) {
      fnStats.calls++;
      if (c.name === null) { fnStats.computed++; unresolved.push({ file: from, line: c.line, kind: 'function' }); continue; }
      const def = functionDefs.get(c.name);
      (fnStats.names[c.name] ??= { definedIn: def ?? null, callers: [] }).callers.push(from);
      if (!def) { fnStats.unmatched.push({ name: c.name, file: from, line: c.line }); continue; }
      fnStats.matched++;
      edges.push({ from, to: def, kind: 'calls-function', line: c.line, function: c.name });
    }
  }
  fnStats.exported = [...functionDefs.keys()];

  // --- Firestore: collection nodes and reads / writes edges (one per file, collection and kind)
  const dataEdges = new Map(), collections = new Map(), dataOpUnknown = [];
  for (const [from, data] of dataByFile) {
    for (const line of data.unresolvedLines) unresolved.push({ file: from, line, kind: 'data' });
    for (const u of data.uses) {
      const col = collections.get(u.collection) ?? collections.set(u.collection, { readers: new Set(), writers: new Set(), unknown: new Set(), paths: new Set(), group: false }).get(u.collection);
      col.paths.add(u.path);
      if (u.group) col.group = true;
      if (u.op === 'unknown') { col.unknown.add(from); dataOpUnknown.push({ file: from, line: u.line, collection: u.collection, path: u.path }); continue; }
      (u.op === 'reads' ? col.readers : col.writers).add(from);
      const key = `${from}\0${u.collection}\0${u.op}`;
      const e = dataEdges.get(key) ?? dataEdges.set(key, { from, to: `collection:${u.collection}`, kind: u.op, count: 0, lines: [], paths: [] }).get(key);
      e.count++;
      if (!e.lines.includes(u.line)) e.lines.push(u.line);
      if (!e.paths.includes(u.path)) e.paths.push(u.path);
      if (u.inferred) e.inferred = true;
    }
  }
  edges.push(...dataEdges.values());
  for (const [name, c] of [...collections].sort((a, b) => a[0].localeCompare(b[0]))) {
    nodes.push({ id: `collection:${name}`, kind: 'collection', name, readers: c.readers.size, writers: c.writers.size,
      usedWithUnknownOperation: c.unknown.size, paths: [...c.paths].sort(), ...(c.group ? { collectionGroup: true } : {}) });
  }

  // --- reachability over import edges only
  const fileNodes = nodes.filter((n) => n.kind === 'file');
  const importEdges = edges.filter((e) => IMPORT_KINDS.includes(e.kind));
  const out = new Map(jsFiles.map((f) => [f, []]));
  const importers = new Map(jsFiles.map((f) => [f, new Set()]));
  for (const e of importEdges) { out.get(e.from).push(e.to); importers.get(e.to).add(e.from); }
  const reach = (start) => {
    const seen = new Set();
    if (!start) return seen;
    const stack = [start];
    while (stack.length) { const f = stack.pop(); if (seen.has(f)) continue; seen.add(f); stack.push(...out.get(f)); }
    return seen;
  };
  const appEntry = rootGroups[0].entry;
  const fromAppEntry = reach(appEntry);
  for (const g of rootGroups) {
    const members = fileNodes.filter((n) => n.rootGroup === g.name).map((n) => n.path);
    const fromOwn = reach(g.entry);
    g.fileCount = members.length;
    g.notImportedFromAppEntry = members.filter((f) => !fromAppEntry.has(f)).length;
    g.notImportedFromOwnEntry = g.entry ? members.filter((f) => !fromOwn.has(f)).length : null;
    g.importedByNoFile = members.filter((f) => importers.get(f).size === 0).length;
  }
  for (const n of fileNodes) {
    n.importedBy = importers.get(n.path).size;
    n.reachableFromAppEntry = fromAppEntry.has(n.path);
  }

  const commit = git(root, ['rev-parse', 'HEAD'])?.trim() || null;
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const map = {
    schemaVersion: SCHEMA_VERSION,
    kinds: KINDS,
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(elapsedMs),
    project: { path: root, gitCommit: commit, fileListSource: listSource },
    rootGroups,
    counts: {
      nodes: nodes.length, nodesByKind: countBy(nodes, (n) => n.kind),
      edges: edges.length, edgesByKind: countBy(edges, (e) => e.kind),
      unresolved: unresolved.length, unresolvedByKind: countBy(unresolved, (u) => u.kind),
      missingRelative: missing.length, assets: assetTotals.total, parseFailures: parseFailures.length,
      screens: screens.length, navigationCalls: navStats.calls, functionCalls: fnStats.calls,
      collections: collections.size, dataUsesWithUnknownOperation: dataOpUnknown.length,
    },
    nodes, edges, unresolved, missingRelative: missing, assetTotals, parseFailures,
    navigation: { screens, ...navStats },
    functions: fnStats,
    data: { usesWithUnknownOperation: dataOpUnknown },
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'map.json');
  fs.writeFileSync(outFile, JSON.stringify(map, null, 2) + '\n');

  // --- report
  const kv = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`Map written: ${outFile}  (schema ${SCHEMA_VERSION})`);
  console.log(`Run time: ${Math.round(elapsedMs)} ms  (file list from ${listSource})`);
  console.log(`Commit: ${commit ?? 'none'}`);
  console.log(`Nodes: ${nodes.length} (${kv(map.counts.nodesByKind)})`);
  console.log(`Edges: ${edges.length} (${kv(map.counts.edgesByKind)})`);
  console.log(`Unresolved: ${unresolved.length} (${kv(map.counts.unresolvedByKind)})  Missing relative: ${missing.length}  Assets: ${assetTotals.total} ${JSON.stringify(assetTotals.byExtension)}`);
  for (const g of rootGroups) {
    console.log(`Root group ${g.name}: ${g.fileCount} files, entry ${g.entry ?? 'none'}, not imported from ${appEntry ?? 'app entry'}: ${g.notImportedFromAppEntry}`
      + (g.entry && g.name !== 'app' ? `, not imported from own entry: ${g.notImportedFromOwnEntry}` : '')
      + `, imported by no file: ${g.importedByNoFile}`);
  }
  console.log('Most imported:');
  for (const n of [...fileNodes].sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path)).slice(0, 10)) console.log(`  ${n.importedBy}  ${n.path}`);

  if (screens.length || navStats.calls) {
    console.log(`Screens registered: ${screens.length} (${screens.filter((s) => s.parent).length} nested); without a resolved file: ${screens.filter((s) => !s.file).length}`);
    console.log(`Navigation calls: ${navStats.calls} ${JSON.stringify(navStats.byMethod)}; targets ${navStats.targets}: matched ${navStats.matched} (inferred ${navStats.matchedInferred}), unmatched ${navStats.unmatched.length}, still computed ${navStats.computed}; calls with inferred targets: ${navStats.inferredCalls}`);
    const um = countBy(navStats.unmatched, (u) => u.name);
    console.log(`Unmatched screen names: ${kv(um) || 'none'}`);
    console.log('Most navigated-to screens:');
    for (const s of [...screens].sort((a, b) => b.incomingNavigation - a.incomingNavigation || a.name.localeCompare(b.name)).slice(0, 10)) console.log(`  ${s.incomingNavigation}  ${s.name}`);
    const none = screens.filter((s) => !s.incomingNavigation && !s.incomingAsNestedParent);
    console.log(`No incoming navigation found: ${none.length}: ${none.map((s) => s.name + (s.parent ? ` (in ${s.parent})` : '')).join(', ')}`);
  }
  if (fnStats.calls || functionDefs.size) {
    console.log(`Callable functions: ${fnStats.calls} calls, matched ${fnStats.matched}, computed ${fnStats.computed}; exported by ${functionsEntry}: ${functionDefs.size}`);
    for (const [name, v] of Object.entries(fnStats.names)) console.log(`  ${name} -> ${v.definedIn ?? 'NO MATCH'}  called from ${[...new Set(v.callers)].join(', ')}`);
  }
  if (collections.size) {
    console.log(`Collections: ${collections.size} (readers / writers / used with unknown operation)`);
    for (const n of nodes.filter((x) => x.kind === 'collection').sort((a, b) => (b.readers + b.writers) - (a.readers + a.writers) || a.name.localeCompare(b.name))) {
      console.log(`  ${n.name}: ${n.readers} / ${n.writers} / ${n.usedWithUnknownOperation}${n.collectionGroup ? ' (collection group)' : ''}`);
    }
    const touch = new Map();
    for (const e of edges) if (e.kind === 'reads' || e.kind === 'writes') (touch.get(e.from) ?? touch.set(e.from, new Set()).get(e.from)).add(e.to);
    console.log('Files touching the most collections:');
    for (const [f, s] of [...touch].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, 10)) console.log(`  ${s.size}  ${f}`);
    console.log(`Data uses with unknown read/write: ${dataOpUnknown.length}; unresolved data paths: ${map.counts.unresolvedByKind.data ?? 0}`);
  }
  console.log(`Parse failures: ${parseFailures.length}`);
  for (const f of parseFailures) console.log(`  ${f.file}:${f.line ?? '?'} ${f.reason}`);
}

main();
