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
import { pathToFileURL } from 'node:url';
import { parse } from '@babel/parser';

const SCHEMA_VERSION = 5;
const IMPORT_KINDS = ['import', 're-export', 'require', 'dynamic'];
const KINDS = {
  nodes: ['file', 'collection', 'subcollection'],
  edges: [...IMPORT_KINDS, 'navigate', 'calls-function', 'reads', 'writes', 'calls'],
  unresolved: ['load', 'navigate', 'function', 'data', 'call'],
};

export const JS_EXT = ['.js', '.jsx', '.mjs', '.cjs'];
const ASSET_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg', '.mp4', '.ttf', '.otf', '.csv', '.json']);
export const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'build', 'dist', '.git', '.claude',
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

export const NO_JS_EXIT = 3;
export const NO_JS_MESSAGE = 'No JavaScript files found. Other languages are not supported yet.';

function git(root, args) {
  if (process.env.MAPPER_NO_GIT === '1') return null; // the caller knows git is unavailable
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
        for (const s of node.specifiers) {
          const imported = s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : (s.imported.name ?? s.imported.value);
          declare(program, s.local, { kind: 'import', spec: node.source.value, imported });
        }
        break;
      case 'VariableDeclaration':
        for (const d of node.declarations) {
          // `for (const x of list)`: remember the list, so x's possible values can be read from it.
          const forOf = par?.type === 'ForOfStatement' && key === 'left' ? par.right : null;
          for (const id of patternIds(d.id)) declare(scope, id, d.id.type === 'Identifier' ? { kind: node.kind, init: d.init, ...(forOf ? { forOf } : {}) } : { kind: 'pattern' });
        }
        break;
      case 'FunctionDeclaration': case 'ClassDeclaration':
        if (node.id) declare(scope, node.id, { kind: 'function', fn: node });
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
      if (b.forOf) {
        const arr = objectOf(b.forOf, A, depth + 1);
        return arr?.type === 'ArrayExpression' && arr.elements.length ? union(...arr.elements.map((e) => stringValues(e, A, depth + 1))) : null;
      }
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

// --- function call layer ---------------------------------------------------------
// Which named function a node sits in, the functions each file exports, and calls from one project file to a
// function exported by another. Nothing is guessed: what cannot be traced is counted as unresolved (kind call).

const keyName = (k) => (k?.type === 'Identifier' ? k.name : literalValue(k) ?? (k?.type === 'NumericLiteral' ? String(k.value) : null));

// The name a function gets from where it is written: function f, const f = () =>, exports.f = ..., { f: () => },
// class methods (Class.method). Null for an anonymous function.
function functionName(f, A) {
  if (f.type === 'FunctionDeclaration') return f.id?.name ?? null;
  if (f.type === 'ClassMethod' || f.type === 'ClassPrivateMethod') {
    const cls = A.parent(A.parent(f));
    const k = f.key.type === 'PrivateName' ? `#${f.key.id.name}` : keyName(f.key);
    return k ? (cls?.id ? `${cls.id.name}.${k}` : k) : null;
  }
  if (f.type === 'ObjectMethod') return keyName(f.key);
  if (f.id?.name) return f.id.name; // named function expression
  return assignedName(f, A);
}

// The name a value is given: const x = v, x = v, exports.x = v, { x: v }, class field x = v. Also looks through
// wrapper calls, so const load = useCallback(async () => ..., []) and exports.onLog = onCall(async () => ...) are named.
function assignedName(node, A) {
  let cur = node, p = A.parent(cur), wrapped = null;
  // Look through a wrapper call only when it returns the function itself: React's useCallback / memo /
  // forwardRef, or a cloud function definition that is exported (exports.x = onCall(fn), export const x =
  // onRequest(fn)). Not docs.map(fn) or const unsubscribe = onAuthStateChanged(auth, fn), whose results are values.
  for (let i = 0; p && i < 6 && isCall(p) && A.key(cur) === 'arguments'; i++) { wrapped ??= p; cur = p; p = A.parent(cur); }
  if (!p) return null;
  const hook = wrapped && /^(useCallback|memo|forwardRef)$/.test(wrapped.callee.name ?? propName(wrapped.callee) ?? '');
  const exported = () => (p.type === 'VariableDeclarator' && A.parent(A.parent(p))?.type === 'ExportNamedDeclaration')
    || (p.type === 'AssignmentExpression' && isMember(p.left) && ((p.left.object.type === 'Identifier' && p.left.object.name === 'exports') || isModuleExports(p.left.object)));
  if (wrapped && !hook && !exported()) return null;
  if (p.type === 'VariableDeclarator' && A.key(cur) === 'init' && p.id.type === 'Identifier') return p.id.name;
  if (p.type === 'AssignmentExpression' && A.key(cur) === 'right') {
    if (p.left.type === 'Identifier') return p.left.name;
    if (isMember(p.left) && !p.left.computed) return p.left.property.name;
  }
  if ((p.type === 'ObjectProperty' || p.type === 'ClassProperty') && A.key(cur) === 'value' && !p.computed) return keyName(p.key);
  if (p.type === 'ExportDefaultDeclaration') return 'default';
  return null;
}

// The nearest enclosing function that has a name; anonymous callbacks count as part of the function around them.
function enclosingFunction(node, A) {
  for (let n = A.parent(node); n; n = A.parent(n)) {
    if (!FUNC_TYPES.has(n.type)) continue;
    const name = functionName(n, A);
    if (name) return name;
  }
  return null;
}

const isFnNode = (n) => n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration');

// What a file exports: name -> { local, fn } for its own values, or { file, name } for a re-export; plus `export *`.
function exportTable(program, rel, resolve) {
  const localFns = new Set(), locals = new Set();
  for (const st of program.body) {
    const d = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
    if (d?.type === 'FunctionDeclaration' && d.id) { localFns.add(d.id.name); locals.add(d.id.name); }
    if (d?.type === 'ClassDeclaration' && d.id) locals.add(d.id.name);
    if (d?.type === 'VariableDeclaration') for (const x of d.declarations) if (x.id.type === 'Identifier') { locals.add(x.id.name); if (isFnNode(x.init)) localFns.add(x.id.name); }
  }
  const names = new Map(), stars = [];
  const own = (exp, local, fnNode) => names.set(exp, { local, fn: fnNode ? isFnNode(fnNode) : localFns.has(local) });
  const target = (spec) => (spec && (spec.startsWith('.') || spec.startsWith('/')) ? resolve(rel, spec) : null);
  let cjs = false;
  for (const st of program.body) {
    if (st.type === 'ExportNamedDeclaration') {
      const d = st.declaration;
      if (d?.type === 'FunctionDeclaration') own(d.id.name, d.id.name, d);
      else if (d?.type === 'ClassDeclaration') own(d.id.name, d.id.name, null);
      else if (d?.type === 'VariableDeclaration') for (const x of d.declarations) for (const id of patternIds(x.id)) own(id.name, id.name, x.id.type === 'Identifier' ? x.init : null);
      for (const sp of st.specifiers || []) {
        const exp = sp.exported.name ?? sp.exported.value;
        if (st.source) { const f = target(st.source.value); if (f) names.set(exp, { file: f, name: sp.type === 'ExportNamespaceSpecifier' ? '*' : (sp.local?.name ?? sp.local?.value ?? 'default') }); }
        else own(exp, sp.local.name, null);
      }
    } else if (st.type === 'ExportDefaultDeclaration') {
      const d = st.declaration;
      if (d.type === 'Identifier') own('default', d.name, null);
      else if (d.type === 'FunctionDeclaration' || isFnNode(d)) own('default', d.id?.name ?? 'default', d);
      else names.set('default', { local: 'default', fn: false });
    } else if (st.type === 'ExportAllDeclaration' && !st.exported) {
      const f = target(st.source.value);
      if (f) stars.push(f);
    } else if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression') {
      const { left, right } = st.expression;
      const valueOwn = (exp, v) => {
        if (v.type === 'Identifier') own(exp, v.name, null);
        else if (isFnNode(v)) own(exp, v.id?.name ?? exp, v);
        else if (isCall(v) && v.callee.name === 'require' && target(literalValue(v.arguments[0]))) names.set(exp, { file: target(literalValue(v.arguments[0])), name: '*' });
        else names.set(exp, { local: exp, fn: isCall(v) }); // e.g. exports.x = onCall(...): callable
      };
      if (isModuleExports(left)) {
        cjs = true;
        if (right.type === 'ObjectExpression') {
          for (const pr of right.properties) {
            if (pr.type === 'ObjectMethod') own(keyName(pr.key), keyName(pr.key), pr);
            else if (pr.type === 'ObjectProperty' && !pr.computed) valueOwn(keyName(pr.key), pr.value);
          }
        } else valueOwn('default', right);
      } else if (isMember(left) && !left.computed && ((left.object.type === 'Identifier' && left.object.name === 'exports') || isModuleExports(left.object))) {
        cjs = true;
        valueOwn(left.property.name, right);
      }
    }
  }
  return { names, stars, cjs };
}

// Bindings that refer to another project file: import { a as b }, import x, import * as ns, and the CommonJS
// forms const x = require('./y'), const { a, b: c } = require('./y'), const a = require('./y').a.
function importBindings(ast, A, rel, resolve) {
  const out = new Map(); // binding -> { file, imported }
  const fileOf = (spec) => (spec && (spec.startsWith('.') || spec.startsWith('/')) ? resolve(rel, spec) : null);
  const declared = (id) => A.lookup(id.name, id);
  walkAst(ast.program, (n) => {
    if (n.type === 'ImportDeclaration') {
      const file = fileOf(n.source.value);
      if (!file) return;
      for (const sp of n.specifiers) { const b = declared(sp.local); if (b) out.set(b, { file, imported: b.imported }); }
    } else if (n.type === 'VariableDeclarator' && n.init) {
      let init = n.init, member = null;
      if (isMember(init) && !init.computed) { member = init.property.name; init = init.object; }
      if (!isCall(init) || init.callee.name !== 'require') return;
      const file = fileOf(literalValue(init.arguments[0]));
      if (!file) return;
      if (n.id.type === 'Identifier') { const b = declared(n.id); if (b) out.set(b, { file, imported: member ?? '*' }); }
      else if (n.id.type === 'ObjectPattern' && !member) {
        for (const pr of n.id.properties) {
          if (pr.type !== 'ObjectProperty' || pr.computed) continue;
          const id = pr.value.type === 'AssignmentPattern' ? pr.value.left : pr.value;
          if (id.type === 'Identifier') { const b = declared(id); if (b) out.set(b, { file, imported: keyName(pr.key) }); }
        }
      }
    }
  });
  return out;
}

// In each top-level function of a file: where a parameter is called, as p(...), p.key(...), or through a
// destructured { key } (in the parameter list or const { key } = p). A reassigned parameter is skipped.
// Returns local function name -> [{ param, prop, line, caller }].
function collectParamCalls(program, A) {
  const fns = new Map();
  for (const st0 of program.body) {
    const st = (st0.type === 'ExportNamedDeclaration' || st0.type === 'ExportDefaultDeclaration') && st0.declaration ? st0.declaration : st0;
    if (st.type === 'FunctionDeclaration' && st.id) fns.set(st.id.name, st);
    if (st.type === 'VariableDeclaration') for (const d of st.declarations) if (d.id.type === 'Identifier' && isFnNode(d.init)) fns.set(d.id.name, d.init);
    if (st.type === 'ExpressionStatement' && st.expression.type === 'AssignmentExpression' && isFnNode(st.expression.right)) {
      const l = st.expression.left;
      if (isMember(l) && !l.computed && ((l.object.type === 'Identifier' && l.object.name === 'exports') || isModuleExports(l.object))) fns.set(st.expression.right.id?.name ?? l.property.name, st.expression.right);
    }
  }
  const out = new Map();
  for (const [name, f] of fns) {
    const calls = [];
    const push = (u, param, prop) => calls.push({ param, prop, line: u.loc.start.line, caller: enclosingFunction(u, A) ?? name });
    const callsOf = (id, param, prop) => {
      const b = A.lookup(id.name, id);
      if (!b || A.assignmentsOf(b).length) return;
      for (const u of A.usesOf(b)) if (isCall(A.parent(u)) && A.key(u) === 'callee') push(u, param, prop);
    };
    const destructure = (pat, param) => {
      for (const pr of pat.properties) {
        if (pr.type !== 'ObjectProperty' || pr.computed) continue;
        const v = pr.value.type === 'AssignmentPattern' ? pr.value.left : pr.value;
        if (v.type === 'Identifier') callsOf(v, param, keyName(pr.key));
      }
    };
    f.params.forEach((prm, i) => {
      const t = prm.type === 'AssignmentPattern' ? prm.left : prm;
      if (t.type === 'ObjectPattern') return destructure(t, i);
      if (t.type !== 'Identifier') return;
      const b = A.lookup(t.name, t);
      if (!b || A.assignmentsOf(b).length) return;
      for (const u of A.usesOf(b)) {
        const p = A.parent(u), k = A.key(u);
        if (isCall(p) && k === 'callee') push(u, i, null);
        else if (isMember(p) && k === 'object' && !p.computed && isCall(A.parent(p)) && A.key(p) === 'callee') push(u, i, p.property.name);
        else if (p.type === 'VariableDeclarator' && k === 'init' && p.id.type === 'ObjectPattern') destructure(p.id, i);
      }
    });
    if (calls.length) out.set(name, calls);
  }
  return out;
}

// Calls to functions imported from other project files: { file, name, line, caller, via }, and the uses the
// mapper cannot follow (a computed member, an imported function passed as a value, a module object passed on).
function collectCalls(ast, A, rel, resolve) {
  const imports = importBindings(ast, A, rel, resolve);
  const calls = [], values = [];
  // The imported function a call goes to, when that is certain: f(...) or ns.f(...) / def.f(...).
  const calleeOf = (call) => {
    const c = call.callee;
    if (c.type === 'Identifier') {
      const b = A.lookup(c.name, c), imp = b && imports.get(b);
      return imp && imp.imported !== '*' ? { file: imp.file, name: imp.imported } : null;
    }
    if (isMember(c) && !c.computed && c.object.type === 'Identifier') {
      const b = A.lookup(c.object.name, c.object), imp = b && imports.get(b);
      if (imp && (imp.imported === '*' || imp.imported === 'default')) return { file: imp.file, name: c.property.name, via: imp.imported };
    }
    return null;
  };
  // Where a value is handed to an imported function: directly as argument i, or as property `key` of an object
  // literal that is argument i (inline, or a const used only as that argument). One hop, nothing else.
  const passedTo = (node) => {
    const p = A.parent(node), k = A.key(node), line = node.loc.start.line;
    const site = (call, argIndex, propKey) => { const t = calleeOf(call); return t ? { ...t, argIndex, propKey, passLine: line } : null; };
    if (isCall(p) && k === 'arguments') return [site(p, p.arguments.indexOf(node), null)].filter(Boolean);
    if (p?.type !== 'ObjectProperty' || k !== 'value' || p.computed) return [];
    const key = keyName(p.key), obj = A.parent(p), op = A.parent(obj), ok = A.key(obj);
    if (isCall(op) && ok === 'arguments') return [site(op, op.arguments.indexOf(obj), key)].filter(Boolean);
    if (op?.type === 'VariableDeclarator' && ok === 'init' && op.id.type === 'Identifier') {
      const b = A.lookup(op.id.name, op.id);
      if (!b || b.kind !== 'const') return [];
      return A.usesOf(b).filter((u) => isCall(A.parent(u)) && A.key(u) === 'arguments')
        .map((u) => site(A.parent(u), A.parent(u).arguments.indexOf(u), key)).filter(Boolean);
    }
    return [];
  };
  for (const [b, imp] of imports) {
    for (const ref of A.usesOf(b)) {
      const p = A.parent(ref), k = A.key(ref);
      const line = ref.loc.start.line;
      if (isCall(p) && k === 'callee') { calls.push({ file: imp.file, name: imp.imported, line, caller: enclosingFunction(ref, A) }); continue; }
      if (isMember(p) && k === 'object') {
        const g = A.parent(p), member = p.computed ? literalValue(p.property) : p.property.name;
        const called = isCall(g) && A.key(p) === 'callee';
        if (imp.imported === '*' || imp.imported === 'default') {
          if (member === null) { values.push({ file: imp.file, name: null, line, reason: 'computed member' }); continue; }
          if (called) { calls.push({ file: imp.file, name: member, line, caller: enclosingFunction(ref, A), via: imp.imported }); continue; }
          values.push({ file: imp.file, name: member, local: member, line, reason: 'function used as a value', member: true, passed: passedTo(p) });
        }
        continue; // fn.length, Component.propTypes, ...: not a call
      }
      if (p?.type === 'UnaryExpression' && p.operator === 'typeof') continue;
      if (p?.type === 'ExportSpecifier') continue;
      values.push({ file: imp.file, name: imp.imported, local: ref.name, line, reason: imp.imported === '*' ? 'module object used as a value' : 'function used as a value', passed: passedTo(ref) });
    }
  }
  return { calls, values };
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

// A placeholder named after the expression that fills a path segment: uid, user.uid -> {uid}, else {id}.
function placeholder(node) {
  let n = node;
  while (n && (n.type === 'TSNonNullExpression' || n.type === 'ParenthesizedExpression')) n = n.expression;
  if (n?.type === 'Identifier') return `{${n.name}}`;
  if (isMember(n) && !n.computed && n.property.type === 'Identifier') return `{${n.property.name}}`;
  return '{id}';
}
const MAX_VARIANTS = 8;
const cartesian = (a, b) => { const out = []; for (const x of a) for (const y of b) out.push(x + y); return out.slice(0, MAX_VARIANTS); };

// The possible texts of one path argument: a literal, a template or '+' concatenation (with named
// placeholders for the parts it cannot know), or the few string values a variable or conditional can hold.
function segValues(node, A) {
  if (!node) return { values: ['{id}'], inferred: false };
  const lit = literalValue(node);
  if (lit !== null) return { values: [lit], inferred: false };
  if (node.type === 'TemplateLiteral') {
    let vals = [''], inferred = false;
    node.quasis.forEach((q, i) => {
      vals = vals.map((v) => v + q.value.cooked);
      if (i < node.expressions.length) { const e = segValues(node.expressions[i], A); inferred ||= e.inferred; vals = cartesian(vals, e.values); }
    });
    return { values: vals, inferred };
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const l = segValues(node.left, A), r = segValues(node.right, A);
    return { values: cartesian(l.values, r.values), inferred: l.inferred || r.inferred };
  }
  const v = stringValues(node, A);
  if (v?.length && v.length <= MAX_VARIANTS) return { values: v, inferred: true };
  return { values: [placeholder(node)], inferred: false };
}
const segOf = (arg, A) => {
  if (!arg) return { text: '{id}', values: ['{id}'], node: null };
  const { values, inferred } = segValues(arg, A);
  return { text: values[0], values, inferred, node: arg };
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
  // A helper defined in this file that returns a reference, such as workoutLogsRef(uid).
  if (!fn && node.callee.type === 'Identifier') {
    const ret = returnedExpr(localFunction(node.callee, A));
    if (ret) return refPath(ret, A, depth + 1);
  }
  const args = node.arguments;
  if (fn === 'query') return refPath(args[0], A, depth + 1);
  if (fn === 'collectionGroup') return { segs: [segOf(args[1], A)], group: true };
  if (fn === 'collection' || fn === 'doc') {
    if (!args.length) return null;
    const base = refPath(args[0], A, depth + 1);
    const rest = args.slice(1).map((a) => segOf(a, A));
    if (base?.unresolved) return base;
    if (base) return { segs: [...base.segs, ...(rest.length ? rest : [segOf(null, A)])] };
    if (isDbLike(args[0], A) && rest.length) return { segs: rest };
    return { unresolved: true };
  }
  const prop = propName(node.callee);
  if (!prop) return null;
  const recv = node.callee.object;
  if (prop === 'collection' || prop === 'collectionGroup') {
    const base = refPath(recv, A, depth + 1);
    if (base?.unresolved) return base;
    if (base) return { segs: [...base.segs, segOf(args[0], A)] };
    return isDbLike(recv, A) ? { segs: [segOf(args[0], A)], group: prop === 'collectionGroup' } : null;
  }
  if (prop === 'doc' || CHAIN_QUERY.has(prop)) {
    const base = refPath(recv, A, depth + 1);
    if (!base || base.unresolved) return base;
    return prop === 'doc' ? { segs: [...base.segs, segOf(args[0], A)] } : base;
  }
  return null;
}

// The function a name refers to when it is declared in this file (function declaration or const arrow).
function localFunction(id, A) {
  const b = A.lookup(id.name, id);
  if (b?.fn) return b.fn;
  if (b?.kind === 'const' && b.init && (b.init.type === 'ArrowFunctionExpression' || b.init.type === 'FunctionExpression')) return b.init;
  return null;
}
// What a function returns: an arrow's expression body, or the first top-level `return x;`.
function returnedExpr(f) {
  if (!f) return null;
  if (f.body?.type !== 'BlockStatement') return f.body ?? null;
  return f.body.body.find((st) => st.type === 'ReturnStatement' && st.argument)?.argument ?? null;
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

const isHole = (seg) => seg.includes('{');
// One key per subcollection, whatever the document ids are called: users/{uid}/workoutLogs -> users/{}/workoutLogs.
const subKey = (colParts) => colParts.map((p, i) => (i % 2 ? '{}' : p)).join('/');

// Firestore references in one file. Each use names its top-level collection (as in schema 2) and, when the
// path goes deeper, the subcollection pattern it reaches (a document path counts as its collection's).
// When a reference is what a helper in the same file returns (function workoutLogsRef(uid) { return collection(...) }),
// it is really used where the helper is called: those call nodes, or null.
function helperCallSites(n, A) {
  let cur = n, p = A.parent(cur);
  while (p && (p.type === 'ParenthesizedExpression' || p.type === 'TSAsExpression')) { cur = p; p = A.parent(p); }
  let f = null;
  if (p?.type === 'ReturnStatement') { f = A.parent(p); while (f && !FUNC_TYPES.has(f.type)) f = A.parent(f); }
  else if (p?.type === 'ArrowFunctionExpression' && A.key(cur) === 'body') f = p;
  if (!f) return null;
  let b = null;
  if (f.type === 'FunctionDeclaration' && f.id) b = A.lookup(f.id.name, f.id);
  else { const d = A.parent(f); if (d?.type === 'VariableDeclarator' && d.id.type === 'Identifier') b = A.lookup(d.id.name, d.id); }
  const calls = b ? A.usesOf(b).filter((u) => isCall(A.parent(u)) && A.key(u) === 'callee').map((u) => A.parent(u)) : [];
  return calls.length ? calls : null;
}

const cleanOps = (ops) => {
  ops = [...new Set(ops)];
  if (ops.length === 1 && ops[0] === 'base') return null; // the longer path is recorded instead
  ops = ops.filter((o) => o !== 'base' && o !== 'none');
  return ops.length ? ops : ['unknown']; // only its id / path is used
};

function collectData(A) {
  const uses = [], unresolvedLines = [], partial = [];
  for (const n of A.nodes()) {
    if (!isCall(n) || !isRefCtor(n, A)) continue;
    // Where the reference is used: here, or at each call of the helper that returns it.
    const sites = (helperCallSites(n, A) ?? [n]).map((c) => ({ ops: cleanOps(opsFor(c, A)), line: c.loc.start.line, fn: enclosingFunction(c, A) })).filter((x) => x.ops);
    if (!sites.length) continue;
    const line = n.loc.start.line;
    const r = refPath(n, A);
    if (!r || r.unresolved || !r.segs.length) { unresolvedLines.push(line); continue; }
    // Every combination of the segments' possible values (a conditional subcollection name gives several).
    let variants = [''];
    for (const sg of r.segs) variants = cartesian(variants.map((v) => (v ? `${v}/` : v)), sg.values);
    const inferred = r.segs.some((sg) => sg.inferred);
    let any = false;
    for (const raw of new Set(variants)) {
      const parts = raw.split('/').filter(Boolean);
      if (!parts.length || isHole(parts[0])) continue;
      any = true;
      const pathText = parts.join('/');
      const colParts = r.group ? parts : parts.length % 2 === 0 ? parts.slice(0, -1) : parts;
      let sub = null;
      if (!r.group && colParts.length > 1) {
        if (colParts.some((p, i) => i % 2 === 0 && isHole(p))) partial.push({ line, path: pathText });
        else sub = { key: subKey(colParts), pattern: colParts.join('/') };
      }
      for (const st of sites) for (const op of st.ops) uses.push({ collection: parts[0], path: pathText, op, line: st.line, fn: st.fn, inferred, group: !!r.group, sub });
    }
    if (!any) unresolvedLines.push(line);
  }
  return { uses, unresolvedLines, partial };
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
  if (!jsFiles.length) { console.error(NO_JS_MESSAGE); process.exit(NO_JS_EXIT); }

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
  const exportTables = new Map(), callsByFile = new Map(), paramCallsByFile = new Map();
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

    // Firestore use is read in every root group (app, functions/, scripts/); the rest is app only.
    const A = analyze(ast);
    exportTables.set(rel, exportTable(ast.program, rel, resolve));
    const fc = collectCalls(ast, A, rel, resolve);
    if (fc.calls.length || fc.values.length) callsByFile.set(rel, fc);
    const pc = collectParamCalls(ast.program, A);
    if (pc.size) paramCallsByFile.set(rel, pc);
    const data = collectData(A);
    if (data.uses.length || data.unresolvedLines.length || data.partial.length) dataByFile.set(rel, data);

    if (node.rootGroup === 'app') {
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

  // --- function calls between project files: calls edges (one per call site)
  const resolveExport = (file, name, depth = 0) => {
    const t = exportTables.get(file);
    if (!t || depth > 10) return null;
    const e = t.names.get(name);
    if (e) return e.file ? (e.name === '*' ? null : resolveExport(e.file, e.name, depth + 1)) : { file, name, local: e.local, fn: e.fn };
    if (name !== 'default') for (const f of t.stars) { const r = resolveExport(f, name, depth + 1); if (r) return r; }
    return null;
  };
  const callStats = { calls: 0, resolved: 0, unresolved: 0 };
  for (const [from, fc] of callsByFile) {
    for (const c of fc.calls) {
      callStats.calls++;
      const t = exportTables.get(c.file);
      let name = c.name;
      if (name === '*') name = 'default'; // const f = require('./f'); f()
      if (c.via === 'default' && !t?.cjs && !t?.names.has(name)) name = null; // a member of an ES default export object
      const r = name === null ? null : resolveExport(c.file, name);
      if (!r) {
        callStats.unresolved++;
        unresolved.push({ file: from, line: c.line, kind: 'call', reason: name === null ? 'called through the default export object' : 'export not found', target: c.file, name: c.name });
        continue;
      }
      callStats.resolved++;
      edges.push({ from, to: r.file, kind: 'calls', line: c.line, function: r.name === 'default' ? r.local : r.name,
        ...(r.name !== (r.name === 'default' ? r.local : r.name) ? { export: r.name } : {}),
        ...(r.local && r.local !== r.name ? { local: r.local } : {}), ...(c.caller ? { caller: c.caller } : {}) });
    }
    // Imported functions handed on as values cannot be followed. Components (capitalised names) are rendered,
    // not called, and non-function exports are plain values, so neither is counted.
    for (const v of fc.values) {
      if (v.reason === 'module object used as a value' || v.reason === 'computed member') {
        callStats.unresolved++;
        unresolved.push({ file: from, line: v.line, kind: 'call', reason: v.reason, target: v.file });
        continue;
      }
      if (/^[A-Z]/.test(v.local)) continue;
      const r = resolveExport(v.file, v.name === '*' ? 'default' : v.name);
      if (!r?.fn) continue;
      const fnName = r.name === 'default' ? r.local : r.name;
      // Followed one hop: the receiving function (resolved with certainty) calls that parameter or property.
      let followed = 0;
      for (const ps of v.passed || []) {
        const rt = exportTables.get(ps.file);
        const recvName = ps.via === 'default' && !rt?.cjs && !rt?.names.has(ps.name) ? null : ps.name;
        const recv = recvName && resolveExport(ps.file, recvName);
        if (!recv?.local) continue;
        const hits = (paramCallsByFile.get(recv.file)?.get(recv.local) || []).filter((c) => c.param === ps.argIndex && c.prop === ps.propKey);
        for (const h of hits) {
          followed++;
          edges.push({ from: recv.file, to: r.file, kind: 'calls', line: h.line, function: fnName,
            ...(r.name !== fnName ? { export: r.name } : {}), ...(r.local && r.local !== r.name ? { local: r.local } : {}),
            caller: h.caller, via: 'value', passedFrom: from, passedLine: ps.passLine,
            through: ps.propKey ? `${recv.local}(…${ps.propKey})` : `${recv.local} argument ${ps.argIndex + 1}` });
        }
      }
      if (followed) { callStats.resolved += followed; callStats.viaValue = (callStats.viaValue || 0) + followed; continue; }
      callStats.unresolved++;
      const why = (v.passed || []).length ? 'function used as a value; the function it is passed to does not call it directly' : v.reason;
      unresolved.push({ file: from, line: v.line, kind: 'call', reason: why, target: r.file, name: fnName });
    }
  }

  // --- Firestore: collection and subcollection nodes, reads / writes edges (one per file, target and kind).
  // Top-level collection nodes count every use under them, subcollections included (as in schema 2);
  // subcollection nodes are one per path pattern. Each edge says which root group and folder its file is in.
  const fileByPath = new Map(nodes.map((n) => [n.path, n]));
  const dataEdges = new Map(), collections = new Map(), subs = new Map(), dataOpUnknown = [];
  const newTarget = () => ({ readers: new Set(), writers: new Set(), unknown: new Set(), paths: new Set(), group: false });
  const addEdge = (from, to, u) => {
    const key = `${from}\0${to}\0${u.op}`;
    const f = fileByPath.get(from);
    const e = dataEdges.get(key) ?? dataEdges.set(key, { from, to, kind: u.op, count: 0, lines: [], paths: [], sites: [], group: f.rootGroup, folder: f.topFolder }).get(key);
    e.count++;
    if (!e.lines.includes(u.line)) e.lines.push(u.line);
    // Each line with the named function it is in (none at the top level of the file).
    if (!e.sites.some((x) => x.line === u.line)) e.sites.push({ line: u.line, function: u.fn ?? null });
    if (!e.paths.includes(u.path)) e.paths.push(u.path);
    if (u.inferred) e.inferred = true;
  };
  for (const [from, data] of dataByFile) {
    for (const line of data.unresolvedLines) unresolved.push({ file: from, line, kind: 'data' });
    const seenPartial = new Set();
    for (const p of data.partial) {
      if (seenPartial.has(`${p.line}\0${p.path}`)) continue;
      seenPartial.add(`${p.line}\0${p.path}`);
      unresolved.push({ file: from, line: p.line, kind: 'data', path: p.path, reason: 'subcollection name not resolved' });
    }
    for (const u of data.uses) {
      const col = collections.get(u.collection) ?? collections.set(u.collection, newTarget()).get(u.collection);
      col.paths.add(u.path);
      if (u.group) col.group = true;
      let sub = null;
      if (u.sub) {
        sub = subs.get(u.sub.key) ?? subs.set(u.sub.key, { ...newTarget(), parent: u.collection, patterns: new Map() }).get(u.sub.key);
        sub.paths.add(u.path);
        sub.patterns.set(u.sub.pattern, (sub.patterns.get(u.sub.pattern) || 0) + 1);
      }
      if (u.op === 'unknown') {
        col.unknown.add(from); sub?.unknown.add(from);
        dataOpUnknown.push({ file: from, line: u.line, function: u.fn ?? null, collection: u.collection, path: u.path, ...(u.sub ? { subcollection: u.sub.key } : {}) });
        continue;
      }
      (u.op === 'reads' ? col.readers : col.writers).add(from);
      addEdge(from, `collection:${u.collection}`, u);
      if (sub) { (u.op === 'reads' ? sub.readers : sub.writers).add(from); addEdge(from, `subcollection:${u.sub.key}`, u); }
    }
  }
  edges.push(...dataEdges.values());
  for (const [name, c] of [...collections].sort((a, b) => a[0].localeCompare(b[0]))) {
    nodes.push({ id: `collection:${name}`, kind: 'collection', name, readers: c.readers.size, writers: c.writers.size,
      usedWithUnknownOperation: c.unknown.size, paths: [...c.paths].sort(), ...(c.group ? { collectionGroup: true } : {}) });
  }
  // The pattern shown for a subcollection: at each document position, the placeholder name used most often.
  const displayPattern = (key, patterns) => {
    const parts = key.split('/');
    return parts.map((p, i) => {
      if (p !== '{}') return p;
      const counts = new Map();
      for (const [pat, n] of patterns) { const seg = pat.split('/')[i]; counts.set(seg, (counts.get(seg) || 0) + n); }
      return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    }).join('/');
  };
  for (const [key, c] of [...subs].sort((a, b) => a[0].localeCompare(b[0]))) {
    const parts = key.split('/');
    nodes.push({ id: `subcollection:${key}`, kind: 'subcollection', name: parts[parts.length - 1], key,
      pattern: displayPattern(key, c.patterns), parent: c.parent, depth: (parts.length - 1) / 2,
      readers: c.readers.size, writers: c.writers.size, usedWithUnknownOperation: c.unknown.size, paths: [...c.paths].sort() });
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
      functionCallSites: callStats.calls, functionCallsResolved: callStats.resolved, functionCallsViaValue: callStats.viaValue || 0, functionCallsUnresolved: callStats.unresolved,
      collections: collections.size, subcollections: subs.size, dataUsesWithUnknownOperation: dataOpUnknown.length,
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
    for (const e of edges) if ((e.kind === 'reads' || e.kind === 'writes') && e.to.startsWith('collection:')) (touch.get(e.from) ?? touch.set(e.from, new Set()).get(e.from)).add(e.to);
    console.log('Files touching the most collections:');
    for (const [f, s] of [...touch].sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0])).slice(0, 10)) console.log(`  ${s.size}  ${f}`);
    console.log(`Subcollections: ${subs.size} (readers / writers / used with unknown operation)`);
    for (const n of nodes.filter((x) => x.kind === 'subcollection')) console.log(`  ${n.pattern}: ${n.readers} / ${n.writers} / ${n.usedWithUnknownOperation}`);
    console.log(`Data uses with unknown read/write: ${dataOpUnknown.length}; unresolved data paths: ${map.counts.unresolvedByKind.data ?? 0}`);
  }
  console.log(`Function calls between files: ${callStats.resolved} resolved (${callStats.viaValue || 0} via a value passed on), ${callStats.unresolved} unresolved (kind call)`);
  console.log(`Parse failures: ${parseFailures.length}`);
  for (const f of parseFailures) console.log(`  ${f.file}:${f.line ?? '?'} ${f.reason}`);
}

// Run only when executed directly, so the server can import the constants above.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
