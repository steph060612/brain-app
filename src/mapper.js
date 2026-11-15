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
import { detectGroups, nameGroups, SEED as GROUP_SEED, WEIGHTS as GROUP_WEIGHTS } from './map-groups.js';

import { SCHEMA_VERSION } from './map-schema.js';
const IMPORT_KINDS = ['import', 're-export', 'require', 'dynamic'];
const KINDS = {
  nodes: ['file', 'collection', 'subcollection'],
  edges: [...IMPORT_KINDS, 'type-import', 'navigate', 'calls-function', 'reads', 'writes', 'calls'],
  unresolved: ['load', 'navigate', 'function', 'data', 'call'],
};

export const JS_EXT = ['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts'];
export const isTypeDeclaration = (p) => /\.d\.[mc]?ts$/i.test(p);
// Vendored code is never mapped: folders named vendor / vendors / third_party (lib/vendor, public/vendor included),
// minified or bundled files; files over MAX_LINES are skipped when read. The reason is kept in the map.
const VENDOR_DIRS = new Set(['vendor', 'vendors', 'third_party']);
const MAX_LINES = 20000;
export function vendoredReason(rel) {
  const segs = rel.split('/');
  if (segs.slice(0, -1).some((x) => VENDOR_DIRS.has(x.toLowerCase()))) return 'vendored folder';
  const name = segs[segs.length - 1].toLowerCase();
  if (name.endsWith('.min.js') || name.endsWith('.bundle.js') || name.includes('.global.js')) return 'minified or bundled file';
  return null;
}
const ASSET_EXT = new Set(['.png', '.webp', '.jpg', '.jpeg', '.gif', '.svg', '.mp4', '.mp3', '.wav', '.ttf', '.otf', '.woff', '.woff2', '.csv', '.json', '.css', '.scss', '.sass', '.less']);
export const SKIP_DIRS = new Set(['node_modules', 'ios', 'android', 'build', 'dist', '.git', '.claude',
  'cache', '.cache', '.expo', '.next', '.turbo', 'coverage', 'web-build']);
// Resolution order for an extensionless relative path. Platform variants are what Metro tries.
const RESOLVE_SUFFIXES = ['', '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.ios.js', '.android.js', '.native.js',
  '.ios.ts', '.ios.tsx', '.native.ts', '.native.tsx', '.d.ts',
  '/index.js', '/index.jsx', '/index.ts', '/index.tsx', '/index.ios.js', '/index.native.js', '/index.d.ts'];
const SEPARATE_ROOTS = ['functions', 'scripts'];

function usage(msg) {
  if (msg) console.error(msg);
  console.error('Usage: node src/mapper.js <project folder> <output name>\n       node src/mapper.js --folder <name>=<folder> [--folder <name>=<folder> ...] <output name>');
  process.exit(2);
}

const toPosix = (p) => p.split(path.sep).join('/');
const isJs = (p) => JS_EXT.includes(path.extname(p).toLowerCase());
const isCall = (n) => n?.type === 'CallExpression' || n?.type === 'OptionalCallExpression';
const isMember = (n) => n?.type === 'MemberExpression' || n?.type === 'OptionalMemberExpression';
const propName = (m) => (isMember(m) && !m.computed && m.property.type === 'Identifier' ? m.property.name : null);

export const NO_JS_EXIT = 3;
export const NO_JS_MESSAGE = 'No JavaScript or TypeScript files found. Other languages are not supported yet.';

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

// TypeScript wrappers around an expression ('Home' as never, x!, y satisfies T, <T>z) and parentheses.
const TS_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression', 'ParenthesizedExpression']);
export function unwrapTS(node) { while (node && TS_WRAPPERS.has(node.type)) node = node.expression; return node; }

function literalValue(node) {
  node = unwrapTS(node);
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

// JavaScript with JSX; TypeScript (.ts, .mts, .cts) with the typescript plugin, .tsx with typescript and JSX.
function parseFile(code, rel = '') {
  const ext = path.extname(rel).toLowerCase();
  const plugins = ext === '.tsx' ? ['typescript', 'jsx'] : ['.ts', '.mts', '.cts'].includes(ext) ? ['typescript'] : ['jsx'];
  return parse(code, {
    sourceType: 'unambiguous',
    allowReturnOutsideFunction: true,
    allowImportExportEverywhere: true,
    allowAwaitOutsideFunction: true,
    plugins,
  });
}

// Collect every module load in the file: { kind, spec | null, line }.
function collectLoads(ast) {
  const loads = [];
  walkAst(ast.program, (n) => {
    switch (n.type) {
      case 'ImportDeclaration': {
        // import type {A} / import {type A, type B}: types only, no runtime dependency.
        const typeOnly = n.importKind === 'type' || (n.specifiers.length > 0 && n.specifiers.every((x) => x.importKind === 'type'));
        const names = n.specifiers.map((x) => (x.type === 'ImportDefaultSpecifier' ? 'default' : x.type === 'ImportNamespaceSpecifier' ? '*' : (x.imported.name ?? x.imported.value)));
        loads.push({ kind: typeOnly ? 'type-import' : 'import', spec: n.source.value, line: n.loc.start.line, names });
        break;
      }
      case 'ExportNamedDeclaration':
      case 'ExportAllDeclaration':
        if (n.source) {
          const typeOnly = n.exportKind === 'type' || (n.specifiers?.length > 0 && n.specifiers.every((x) => x.exportKind === 'type'));
          loads.push({ kind: typeOnly ? 'type-import' : 're-export', spec: n.source.value, line: n.loc.start.line });
        }
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
  node = unwrapTS(node);
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
const NAV_RECEIVER = /^(nav\w*|\w*Navigation\w*|\w*navigationRef\w*|StackActions|CommonActions|TabActions|DrawerActions|router|history)$/i;

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

// A web path written as a template or concatenation, `/clients/${id}` → '/clients/:*' (a parameter the map
// cannot know), or null when it is not a path.
function pathTemplate(node) {
  node = unwrapTS(node);
  if (node?.type === 'TemplateLiteral' && node.expressions.length && node.quasis[0].value.cooked.startsWith('/'))
    return node.quasis.map((q, i) => q.value.cooked + (i < node.expressions.length ? ':*' : '')).join('');
  if (node?.type === 'BinaryExpression' && node.operator === '+') {
    const parts = []; const flat = (n) => { n = unwrapTS(n); if (n?.type === 'BinaryExpression' && n.operator === '+') { flat(n.left); flat(n.right); } else parts.push(literalValue(n) ?? ':*'); };
    flat(node);
    return parts[0]?.startsWith('/') ? parts.join('') : null;
  }
  return null;
}

// `item.to` inside list.map((item) => …), or `path` inside list.map(({ path }) => …), over a constant array:
// each element's value (MODULES.map(({ path }) => <NavLink to={path} />)).
function mappedMemberValues(node, A) {
  let name, key;
  if (isMember(node) && node.object.type === 'Identifier') { name = node.object.name; key = propName(node); }
  else if (node?.type === 'Identifier') name = node.name;
  if (!name) return null;
  const matches = (fn) => {
    const p0 = fn.params[0];
    if (key && p0?.type === 'Identifier') return p0.name === name;
    if (!key && p0?.type === 'ObjectPattern') {
      const prop = p0.properties.find((q) => q.type === 'ObjectProperty' && unwrapDefault(q.value)?.name === name);
      if (prop) { key = prop.key.name ?? prop.key.value; return true; }
    }
    return false;
  };
  let fn = A.parent(node);
  while (fn && !(FUNC_TYPES.has(fn.type) && matches(fn))) fn = A.parent(fn);
  const call = fn && A.parent(fn);
  if (!key || !isCall(call) || call.arguments[0] !== fn || !/^(map|forEach|flatMap)$/.test(propName(call.callee) ?? '')) return null;
  const arr = objectOf(call.callee.object, A);
  if (arr?.type !== 'ArrayExpression' || !arr.elements.length) return null;
  const vals = arr.elements.map((e) => literalValue(objProp(objectOf(e, A) ?? e, key)));
  return vals.every((v) => v != null) ? [...new Set(vals)] : null;
}
const unwrapDefault = (n) => (n?.type === 'AssignmentPattern' ? n.left : n);

// The web paths a `to` / navigate() / redirect() argument can take. Conditionals give each branch; a constant
// or a list element gives its values (inferred); a template gives a pattern. Absolute URLs (other sites) give
// nothing; a value the map cannot know gives { computed }. A non-path string gives { nonPath } (a screen name).
// A short label for a value the map cannot know: `url`, `location.state.from`, `getPath()`.
function exprLabel(node) {
  node = unwrapTS(node);
  if (node?.type === 'Identifier') return node.name;
  if (isMember(node)) { const o = exprLabel(node.object); const p = propName(node); return o && p ? `${o}.${p}` : null; }
  if (isCall(node)) { const c = exprLabel(node.callee); return c ? `${c}()` : null; }
  return null;
}
const computedTarget = (node, line) => ({ computed: true, line, expr: exprLabel(node) });

function webTargets(node, A, line, depth = 0) {
  node = unwrapTS(node);
  if (!node || depth > 6) return [computedTarget(node, line)];
  if (node.type === 'ConditionalExpression') return [...webTargets(node.consequent, A, line, depth + 1), ...webTargets(node.alternate, A, line, depth + 1)];
  if (node.type === 'LogicalExpression' && node.operator !== '&&') return [...webTargets(node.left, A, line, depth + 1), ...webTargets(node.right, A, line, depth + 1)];
  if (node.type === 'ObjectExpression' && objProp(node, 'pathname')) return webTargets(objProp(node, 'pathname'), A, line, depth + 1);
  const one = (v, inferred) => (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith('//') ? null : v.startsWith('/') ? { name: v, via: [], inferred, line } : { nonPath: true, name: v, line });
  const lit = literalValue(node);
  if (lit != null) return [one(lit, false)].filter(Boolean);
  const tpl = pathTemplate(node);
  if (tpl) return [{ name: tpl, via: [], inferred: true, template: true, line }];
  const vals = mappedMemberValues(node, A) ?? stringValues(node, A);
  if (vals?.length) return vals.map((v) => one(v, true)).filter(Boolean);
  return [computedTarget(node, line)];
}

function makeTargets(nameNode, paramsNode, A, line) {
  const un = unwrapTS(nameNode);
  if (un?.type === 'NumericLiteral' || (un?.type === 'UnaryExpression' && un.argument.type === 'NumericLiteral')) return []; // navigate(-1): back
  const web = webTargets(nameNode, A, line);
  if (web.some((t) => t.name?.startsWith('/')) && !web.some((t) => t.nonPath)) return web;
  const first = nameValues(nameNode, A);
  if (!first.values) return [computedTarget(nameNode, line)];
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

// --- web routes (React Router) ---------------------------------------------------
const jsxName = (n) => (n?.type === 'JSXIdentifier' ? n.name : n?.type === 'JSXMemberExpression' ? n.property.name : null);
const jsxAttr = (el, name) => el.openingElement.attributes.find((a) => a.type === 'JSXAttribute' && a.name.name === name);
const attrExpr = (a) => (!a ? undefined : a.value == null ? { type: 'BooleanLiteral', value: true } : a.value.type === 'JSXExpressionContainer' ? a.value.expression : a.value);
const joinPath = (base, p) => (p.startsWith('/') ? p : `${base.replace(/\/$/, '')}/${p}`).replace(/\/+/g, '/').replace(/(.)\/$/, '$1') || '/';
// The module a component name comes from: an import, a const X = lazy(() => import('./X')), or this file.
function componentSpec(name, node, A) {
  const b = A.lookup(name, node);
  if (!b) return null;
  if (b.kind === 'import') return { spec: b.spec };
  if (b.init) {
    let spec = null;
    walkAst(b.init, (n) => { if (spec) return; if (n.type === 'ImportExpression') spec = literalValue(n.source); else if (isCall(n) && n.callee.type === 'Import') spec = literalValue(n.arguments[0]); });
    if (spec) return { spec, lazy: true };
  }
  return { local: true };
}
// The page an element renders: the deepest element among the children (not props) that is a known component
// (<ProtectedRoute><ClientsPage /></ProtectedRoute> → ClientsPage). A <Navigate to> instead marks a redirect route.
function pageOfElement(expr, A) {
  let best = null, redirect = null;
  const visit = (n, depth) => {
    n = unwrapTS(n);
    if (n?.type === 'JSXFragment') { for (const c of n.children) visit(c, depth + 1); return; }
    if (n?.type === 'JSXExpressionContainer') return visit(n.expression, depth);
    if (n?.type !== 'JSXElement') return;
    const name = jsxName(n.openingElement.name);
    if (name === 'Navigate') { const to = attrExpr(jsxAttr(n, 'to')); redirect = to ?? null; return; }
    if (name && /^[A-Z]/.test(name)) { const src = componentSpec(name, n.openingElement.name, A); if (src && (!best || depth >= best.depth)) best = { name, ...src, depth }; }
    for (const c of n.children) visit(c, depth + 1);
  };
  visit(expr, 0);
  return { page: best, redirect };
}
// <Route path element> trees (nested, index, layout routes without a path) and route objects passed to
// createBrowserRouter / createHashRouter / createMemoryRouter / useRoutes ({ path, element, Component, lazy, children }).
function collectWebRoutes(ast, A) {
  const routes = [], redirects = [];
  const add = (path, page, line, extra = {}) => routes.push({ path, component: page?.name ?? null, spec: page?.spec ?? null, local: !!page?.local, line, ...extra });
  const fromElement = (el, base) => {
    const p = literalValue(attrExpr(jsxAttr(el, 'path')));
    const isIndex = !!attrExpr(jsxAttr(el, 'index'));
    const path = p != null ? joinPath(base, p) : base;
    const line = el.loc.start.line;
    const elem = attrExpr(jsxAttr(el, 'element')), comp = attrExpr(jsxAttr(el, 'Component')), lazyA = attrExpr(jsxAttr(el, 'lazy'));
    if ((p != null || isIndex) && p !== '*') {
      if (elem) { const r = pageOfElement(elem, A); if (r.redirect) redirects.push({ to: r.redirect, line, from: path }); else add(path, r.page, line, isIndex ? { index: true } : {}); }
      else if (comp?.type === 'Identifier') add(path, { name: comp.name, ...componentSpec(comp.name, comp, A) }, line);
      else if (lazyA) { let spec = null; walkAst(lazyA, (n) => { if (!spec && n.type === 'ImportExpression') spec = literalValue(n.source); }); add(path, spec ? { name: null, spec } : null, line); }
    } else if (p === '*' && elem) { const r = pageOfElement(elem, A); if (r.redirect) redirects.push({ to: r.redirect, line, from: '*' }); }
    for (const c of el.children) if (c.type === 'JSXElement' && jsxName(c.openingElement.name) === 'Route') fromElement(c, path);
  };
  const fromObject = (obj, base) => {
    obj = objectOf(obj, A) ?? obj;
    if (obj?.type !== 'ObjectExpression') return;
    const p = literalValue(objProp(obj, 'path')), isIndex = !!objProp(obj, 'index');
    const path = p != null ? joinPath(base, p) : base;
    const line = obj.loc.start.line;
    if ((p != null || isIndex) && p !== '*') {
      const elem = objProp(obj, 'element'), comp = objProp(obj, 'Component'), lazyP = objProp(obj, 'lazy');
      if (elem) { const r = pageOfElement(elem, A); if (r.redirect) redirects.push({ to: r.redirect, line, from: path }); else add(path, r.page, line, isIndex ? { index: true } : {}); }
      else if (comp?.type === 'Identifier') add(path, { name: comp.name, ...componentSpec(comp.name, comp, A) }, line, isIndex ? { index: true } : {});
      else if (lazyP) { let spec = null; walkAst(lazyP, (n) => { if (!spec && (n.type === 'ImportExpression')) spec = literalValue(n.source); else if (!spec && isCall(n) && n.callee.type === 'Import') spec = literalValue(n.arguments[0]); }); add(path, spec ? { name: null, spec } : null, line, isIndex ? { index: true } : {}); }
    }
    const kids = objectOf(objProp(obj, 'children'), A) ?? objProp(obj, 'children');
    if (kids?.type === 'ArrayExpression') for (const k of kids.elements) fromObject(k, path);
  };
  walkAst(ast.program, (n) => {
    if (n.type === 'JSXElement' && jsxName(n.openingElement.name) === 'Route' && jsxName(A.parent(n)?.openingElement?.name) !== 'Route') fromElement(n, '/');
    if (isCall(n) && /^(createBrowserRouter|createHashRouter|createMemoryRouter|useRoutes)$/.test(n.callee.name ?? '')) {
      const arr = objectOf(n.arguments[0], A) ?? n.arguments[0];
      if (arr?.type === 'ArrayExpression') for (const o of arr.elements) fromObject(o, '/');
    }
  });
  // A layout route and its index child share a path: the index page is what that path shows.
  const indexPaths = new Set(routes.filter((r) => r.index).map((r) => r.path));
  return { routes: routes.filter((r) => r.index || !indexPaths.has(r.path)), redirects };
}

// Web navigation: <Link to>, <NavLink to>, <Navigate to> (outside route definitions), redirect('/x'),
// window.location.href = '/x', location.assign('/x') / replace('/x'). Absolute URLs (other sites) are ignored.
function collectWebNav(A) {
  const calls = [];
  const target = (node, line) => webTargets(node, A, line).filter((t) => !t.nonPath); // relative links are left out
  for (const n of A.nodes()) {
    if (n.type === 'JSXElement') {
      const name = jsxName(n.openingElement.name);
      if (!/^(Link|NavLink|Navigate)$/.test(name || '')) continue;
      // A <Navigate> that is a route's element is a redirect route, handled with the routes.
      let up = A.parent(n); while (up && (up.type === 'JSXExpressionContainer' || up.type === 'JSXElement' && !jsxAttr(up, 'path'))) up = A.parent(up);
      if (name === 'Navigate' && (up?.type === 'JSXAttribute' && up.name.name === 'element')) continue;
      const a = jsxAttr(n, 'to') ?? (name === 'Link' ? jsxAttr(n, 'href') : null); // Next.js <Link href>
      if (!a) continue;
      const t = target(attrExpr(a), n.loc.start.line);
      if (t?.length) calls.push({ method: name === 'Navigate' ? 'redirect' : 'link', line: n.loc.start.line, targets: t });
    } else if (isCall(n)) {
      const c = n.callee;
      const isRedirect = c.type === 'Identifier' && c.name === 'redirect';
      const isLoc = isMember(c) && /^(assign|replace)$/.test(propName(c) ?? '') && /^location$/.test(receiverName(c.object) ?? '');
      if (!isRedirect && !isLoc) continue;
      const t = target(n.arguments[0], n.loc.start.line);
      if (t?.length) calls.push({ method: isRedirect ? 'redirect' : 'location', line: n.loc.start.line, targets: t });
    } else if (n.type === 'AssignmentExpression' && isMember(n.left)) {
      const l = n.left, prop = propName(l);
      const isLoc = (prop === 'href' && receiverName(l.object) === 'location') || (prop === 'location' && receiverName(l.object) === 'window');
      if (!isLoc) continue;
      const t = target(n.right, n.loc.start.line);
      if (t?.length) calls.push({ method: 'location', line: n.loc.start.line, targets: t });
    }
  }
  return calls;
}

// Next.js file routes: app/**/page.* and pages/** (not _app, _document, api/) under a folder whose package.json
// depends on next. [id] → :id, [...slug] → :slug*, (group) folders are left out of the path.
function nextRoutes(root, files) {
  const out = [];
  const pkgDirs = files.filter((f) => f.endsWith('package.json')).map((f) => path.dirname(f) === '.' ? '' : path.dirname(f)).filter((d) => {
    try { const pj = JSON.parse(fs.readFileSync(path.join(root, d, 'package.json'), 'utf8')); return !!(pj.dependencies?.next || pj.devDependencies?.next); } catch { return false; }
  });
  const seg = (x) => x.replace(/^\[\.\.\.(.+)\]$/, ':$1*').replace(/^\[\[\.\.\.(.+)\]\]$/, ':$1*').replace(/^\[(.+)\]$/, ':$1');
  for (const d of pkgDirs) {
    const pre = d ? `${d}/` : '';
    for (const base of ['', 'src/']) {
      for (const f of files) {
        if (!f.startsWith(`${pre}${base}`)) continue;
        const rest = f.slice(`${pre}${base}`.length);
        let m = /^app\/(.*?)\/?page\.(m?[jt]sx?)$/.exec(rest) || /^app\/page\.(m?[jt]sx?)$/.exec(rest);
        if (m) { const parts = (m[1] && !m[1].includes('.') ? m[1] : '').split('/').filter((x) => x && !/^\(.*\)$/.test(x) && !x.startsWith('@')).map(seg); out.push({ path: `/${parts.join('/')}`, file: f }); continue; }
        m = /^pages\/(.+)\.(m?[jt]sx?)$/.exec(rest);
        if (m && !/(^|\/)(_app|_document|_error)$/.test(m[1]) && !m[1].startsWith('api/')) {
          const parts = m[1].split('/').map(seg); if (parts[parts.length - 1] === 'index') parts.pop();
          out.push({ path: `/${parts.join('/')}`, file: f });
        }
      }
    }
  }
  return out;
}

// Does a navigation target path match a route pattern? Returns 'exact', 'param' (a parameter took a value), or null.
function matchRoute(target, pattern) {
  const clean = (p) => p.split(/[?#]/)[0].replace(/(.)\/$/, '$1');
  const t = clean(target).split('/'), r = clean(pattern).split('/');
  if (r[r.length - 1]?.endsWith('*') && r[r.length - 1].startsWith(':')) { if (t.length < r.length) return null; }
  else if (t.length !== r.length) return null;
  let param = false;
  for (let i = 0; i < r.length; i++) {
    if (r[i].startsWith(':') || r[i] === '*') { if (!t[i]) return null; if (t[i] !== r[i]) param = true; if (r[i].endsWith('*')) break; continue; }
    if (t[i] === ':*' || t[i] !== r[i]) return null;
  }
  return param ? 'param' : 'exact';
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
      return spec ? resolve(rel, spec) ?? rel : rel;
    }
    if (e?.type === 'Identifier') {
      const spec = b.get(e.name)?.spec;
      return spec ? resolve(rel, spec) ?? rel : rel;
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

const isFnNode = (n0) => { const n = unwrapTS(n0); return !!n && (n.type === 'ArrowFunctionExpression' || n.type === 'FunctionExpression' || n.type === 'FunctionDeclaration'); };

// What a file exports: name -> { local, fn } for its own values, or { file, name } for a re-export; plus `export *`.
function exportTable(program, rel, resolve) {
  const localFns = new Set(), locals = new Set(), localTypes = new Set();
  for (const st of program.body) {
    const d = st.type === 'ExportNamedDeclaration' || st.type === 'ExportDefaultDeclaration' ? st.declaration : st;
    if ((d?.type === 'TSInterfaceDeclaration' || d?.type === 'TSTypeAliasDeclaration') && d.id) localTypes.add(d.id.name);
    if (d?.type === 'FunctionDeclaration' && d.id) { localFns.add(d.id.name); locals.add(d.id.name); }
    if (d?.type === 'ClassDeclaration' && d.id) locals.add(d.id.name);
    if (d?.type === 'VariableDeclaration') for (const x of d.declarations) if (x.id.type === 'Identifier') { locals.add(x.id.name); if (isFnNode(x.init)) localFns.add(x.id.name); }
  }
  const names = new Map(), stars = [];
  const own = (exp, local, fnNode) => names.set(exp, { local, fn: fnNode ? isFnNode(fnNode) : localFns.has(local), ...(localTypes.has(local) ? { type: true } : {}) });
  const target = (spec) => (spec ? resolve(rel, spec) : null);
  let cjs = false;
  for (const st of program.body) {
    if (st.type === 'ExportNamedDeclaration') {
      const d = st.declaration;
      if (d?.type === 'FunctionDeclaration') own(d.id.name, d.id.name, d);
      else if (d?.type === 'ClassDeclaration') own(d.id.name, d.id.name, null);
      else if ((d?.type === 'TSInterfaceDeclaration' || d?.type === 'TSTypeAliasDeclaration') && d.id) names.set(d.id.name, { local: d.id.name, fn: false, type: true });
      else if (d?.type === 'TSDeclareFunction' && d.id && !names.has(d.id.name)) names.set(d.id.name, { local: d.id.name, fn: true }); // overload signature
      else if (d?.type === 'TSEnumDeclaration' && d.id) own(d.id.name, d.id.name, null);
      else if (d?.type === 'VariableDeclaration') for (const x of d.declarations) for (const id of patternIds(x.id)) own(id.name, id.name, x.id.type === 'Identifier' ? x.init : null);
      for (const sp of st.specifiers || []) {
        const exp = sp.exported.name ?? sp.exported.value;
        if (st.source) { const f = target(st.source.value); if (f) names.set(exp, { file: f, name: sp.type === 'ExportNamespaceSpecifier' ? '*' : (sp.local?.name ?? sp.local?.value ?? 'default') }); }
        else if (st.exportKind === 'type' || sp.exportKind === 'type') names.set(exp, { local: sp.local.name, fn: false, type: true });
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
  const fileOf = (spec) => (spec ? resolve(rel, spec) : null);
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

// "Why" comments: a line of a comment that starts with NOTE, WHY, HACK, FIXME, TODO, IMPORTANT or WARNING (any case),
// or any comment citing an ADR or RFC. Attached to the innermost named function around it (null at top level),
// with the line and the first 200 characters (following // lines that continue it are joined).
const NOTE_TAG = /^[\s!]*(NOTE|WHY|HACK|FIXME|TODO|IMPORTANT|WARNING)\b(\s*[:\-–—]|\(|[^.:\n()]{1,40}:)?/i;
// A tag counts when written in capitals (TODO), followed by ":" or a dash, directly by "(" (todo(locale)), or by a
// colon within a few words ("Why this exists:"); plain words such as a JSX label {/* Warning */}, a section label
// "Note (in details tray)" or prose "note that…" are not notes.
const NOTE_RE = { test: (l) => { const m = NOTE_TAG.exec(l); return !!m && (m[1] === m[1].toUpperCase() || !!m[2]); }, exec: (l) => NOTE_TAG.exec(l) };
const CITE_RE = /\b(ADR|RFC)[\s#-]?\d+/i;
function collectNotes(ast, A) {
  const fns = [];
  for (const n of A.nodes()) if (FUNC_TYPES.has(n.type)) { const name = functionName(n, A); if (name) fns.push({ start: n.start, end: n.end, name }); }
  const cs = ast.comments || [], out = [];
  for (let i = 0; i < cs.length; i++) {
    const c = cs[i];
    const lines = c.value.split('\n').map((l) => (c.type === 'CommentBlock' ? l.replace(/^\s*\*+\s?/, '') : l));
    let idx = lines.findIndex((l) => NOTE_RE.test(l)), tag = null;
    if (idx >= 0) tag = NOTE_RE.exec(lines[idx])[1].toUpperCase();
    else { const m = CITE_RE.exec(c.value); if (!m) continue; tag = m[1].toUpperCase(); idx = Math.max(0, lines.findIndex((l) => CITE_RE.test(l))); }
    let text = lines.slice(idx).join(' ');
    // A // NOTE continued on the next // lines (not starting a new tag) is one note.
    for (let j = i + 1; c.type === 'CommentLine' && j < cs.length && cs[j].type === 'CommentLine' && cs[j].loc.start.line === cs[j - 1].loc.start.line + 1 && !NOTE_RE.test(cs[j].value); j++) { text += ` ${cs[j].value}`; i = j; }
    text = text.replace(/\s+/g, ' ').trim();
    const around = fns.filter((f) => f.start <= c.start && c.end <= f.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    out.push({ line: c.loc.start.line + idx, tag, function: around?.name ?? null, text: text.length > 200 ? `${text.slice(0, 199)}…` : text });
  }
  return out;
}

// Calls to functions defined in the same file (function declarations and const = arrow / function expression,
// exported or not, at any depth): { function, line, caller }. Recursion (a function calling itself) is left out.
function collectLocalCalls(program, A) {
  const out = [];
  const local = []; // [name, idNode]
  walkAst(program, (n) => {
    if (n.type === 'FunctionDeclaration' && n.id) local.push([n.id.name, n.id]);
    else if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && isFnNode(n.init)) local.push([n.id.name, n.id]);
  });
  for (const [name, id] of local) {
    const b = A.lookup(name, id);
    if (!b || A.assignmentsOf(b).length) continue; // reassigned: not certain which function runs
    for (const u of A.usesOf(b)) {
      if (!isCall(A.parent(u)) || A.key(u) !== 'callee') continue;
      const caller = enclosingFunction(u, A);
      if (caller === name) continue;
      out.push({ function: name, line: u.loc.start.line, caller });
    }
  }
  return out.sort((a, b) => a.line - b.line);
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
      if (p?.type?.startsWith('TS') && !TS_WRAPPERS.has(p.type)) continue; // a type position (x: Foo, typeof Foo in a type)
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
  node = unwrapTS(node);
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
  node = unwrapTS(node);
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
    if (ret) { const r = refPath(ret, A, depth + 1); return r && !r.unresolved ? { ...r, helper: true } : r; }
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
  if (['ConditionalExpression', 'LogicalExpression', 'SequenceExpression'].includes(p.type) || TS_WRAPPERS.has(p.type)) return opsFor(p, A, depth + 1, seen);
  return ['unknown'];
}

const isHole = (seg) => seg.includes('{');

// A literal document ID that must never be stored or shown: a generated-looking value (16+ letters and digits
// mixed), a UUID, an email address or a long number. Short fixed names the app uses as documents (stats,
// exercisePRs, settings, state) are kept.
export const looksLikeId = (seg) => !seg.includes('{') && (
  (seg.length >= 16 && /[A-Za-z]/.test(seg) && /\d/.test(seg) && /^[A-Za-z0-9_-]+$/.test(seg))
  || /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seg)
  || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(seg)
  || /^\d{6,}$/.test(seg));
// Document positions are the odd segments of a path (after each collection name); collection names stay.
const maskIds = (parts, group) => (group ? parts : parts.map((p, i) => (i % 2 === 1 && looksLikeId(p) ? '{id}' : p)));
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
  const uses = [], unresolvedLines = [], partial = [], masked = new Set();
  for (const n of A.nodes()) {
    if (!isCall(n) || !isRefCtor(n, A)) continue;
    // Where the reference is used: here, or at each call of the helper that returns it.
    const helperSites = helperCallSites(n, A);
    const sites = (helperSites ?? [n]).map((c) => ({ ops: cleanOps(opsFor(c, A)), line: c.loc.start.line, fn: enclosingFunction(c, A) })).filter((x) => x.ops);
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
      const rawParts = raw.split('/').filter(Boolean);
      if (!rawParts.length || isHole(rawParts[0])) continue;
      const parts = maskIds(rawParts, r.group);
      if (parts.some((p, i) => p !== rawParts[i])) masked.add(parts.join('/')); // counted, never the raw form
      any = true;
      const pathText = parts.join('/');
      const colParts = r.group ? parts : parts.length % 2 === 0 ? parts.slice(0, -1) : parts;
      let sub = null;
      if (!r.group && colParts.length > 1) {
        if (colParts.some((p, i) => i % 2 === 0 && isHole(p))) partial.push({ line, path: pathText });
        else sub = { key: subKey(colParts), pattern: colParts.join('/') };
      }
      // How the mapper got there, when it was not written out: a helper-built reference, or a value it resolved.
      const why = helperSites || r.helper ? 'through a helper-built reference' : inferred ? 'path from a resolved value' : null;
      for (const st of sites) for (const op of st.ops) uses.push({ collection: parts[0], path: pathText, op, line: st.line, fn: st.fn, inferred, why, group: !!r.group, sub });
    }
    if (!any) unresolvedLines.push(line);
  }
  return { uses, unresolvedLines, partial, masked };
}

// --- entry files -------------------------------------------------------------------
// The files a root group (app, functions/, scripts/) starts from; a group may have several. Looked for in every
// folder of the group that has a package.json (and in the group's own folder): the package's main and module, files
// its scripts run (node x.js, esbuild src/index.js), the scripts its HTML pages load (index.html's
// <script src="/src/main.jsx"> in a Vite app, a static site's js/main.js, files imported by inline module scripts), the Vite and CRA conventions
// (src/main.* and src/index.*), Expo and React Native (App.*, index.*), and Next.js pages (app/**/page.*, app/layout.*,
// pages/**). scripts/ is a set of tools run by hand: only its package.json can name an entry. Returns
// [{ file, why }] in that order of confidence.
function detectEntries(root, g, jsSet, allFiles, groupOf) {
  const found = new Map();
  const add = (rel, why) => {
    rel = toPosix(path.posix.normalize(rel)).replace(/^\.\//, '');
    if (jsSet.has(rel) && groupOf(rel) === g.name && !found.has(rel)) found.set(rel, why);
  };
  const tryBase = (base, why) => {
    for (const suf of ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '/index.js', '/index.jsx', '/index.ts', '/index.tsx']) {
      if (jsSet.has(toPosix(path.posix.normalize(base + suf)).replace(/^\.\//, ''))) return add(base + suf, why);
    }
  };
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(root, f), 'utf8')); } catch { return null; } };
  const dirs = new Set([g.dir]);
  for (const f of allFiles) if (path.posix.basename(f) === 'package.json') { const d = path.posix.dirname(f) === '.' ? '' : path.posix.dirname(f); if (groupOf(d ? `${d}/x.js` : 'x.js') === g.name) dirs.add(d); }
  const ordered = [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
  const pre = (d) => (d ? `${d}/` : '');
  const conventions = g.name !== 'scripts';
  for (const d of ordered) {
    const pj = readJson(`${pre(d)}package.json`);
    if (pj) {
      for (const k of ['main', 'module']) if (typeof pj[k] === 'string') tryBase(pre(d) + pj[k].replace(/^\.\//, ''), `package.json ${k}`);
      for (const [name, cmd] of Object.entries(pj.scripts || {})) {
        if (typeof cmd !== 'string') continue;
        for (const tok of cmd.split(/[\s=&|;]+/)) if (/^[\w./@-]+\.(m?[jt]sx?|cjs)$/.test(tok) && !tok.startsWith('..')) tryBase(pre(d) + tok.replace(/^\.\//, ''), `package.json script "${name}"`);
      }
    }
    if (!conventions) continue;
    // HTML pages in this folder and the scripts they load (local paths only).
    const pages = allFiles.filter((f) => path.posix.dirname(f) === (d || '.') && /\.html?$/i.test(f))
      .sort((a, b) => (/(^|\/)index\.html?$/i.test(b) - /(^|\/)index\.html?$/i.test(a)) || a.localeCompare(b));
    for (const f of pages) {
      let html = ''; try { html = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
      for (const m of html.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"'?#]+)/gi)) {
        const src = m[1];
        if (/^[a-z]+:|^\/\//i.test(src)) continue;
        add(src.startsWith('/') ? pre(d) + src.slice(1) : pre(d) + src, `script in ${f}`);
      }
      // Inline <script type="module"> blocks that import local files: import { auth } from './assets/js/x.js'.
      for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
        for (const im of m[1].matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"'?#]+\.(?:m?[jt]sx?|cjs))["']/g)) {
          const src = im[1];
          if (/^[a-z]+:|^\/\//i.test(src)) continue;
          add(src.startsWith('/') ? pre(d) + src.slice(1) : path.posix.join(pre(d) || '.', src), `imported by a module script in ${f}`);
        }
      }
    }
    for (const b of ['src/main', 'src/index']) tryBase(pre(d) + b, 'Vite / web app convention');
    for (const b of ['App', 'index']) for (const ext of ['.js', '.jsx', '.ts', '.tsx']) add(pre(d) + b + ext, b === 'App' ? 'Expo / React Native App' : 'index file');
    if (pj && (pj.dependencies?.next || pj.devDependencies?.next)) {
      for (const f of jsSet) {
        const rest = f.startsWith(pre(d)) ? f.slice(pre(d).length).replace(/^src\//, '') : null;
        if (rest && (/^app\/(.*\/)?(page|layout)\.(m?[jt]sx?)$/.test(rest) || (/^pages\/.+\.(m?[jt]sx?)$/.test(rest) && !rest.startsWith('pages/api/')))) add(f, 'Next.js page');
      }
    }
  }
  return [...found].map(([file, why]) => ({ file, why }));
}

// --- resolution ---------------------------------------------------------------

// tsconfig.json / jsconfig.json, with comments and trailing commas allowed (as TypeScript reads them).
function readJsonc(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\/|(^|[^:"'])\/\/.*$/gm, '$1').replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(text);
  } catch { return null; }
}

// Resolves a module specifier from a file: relative paths (with the JS and TS extensions, index files and
// "./x.js" meaning x.ts), then the nearest tsconfig/jsconfig "paths" and "baseUrl". Returns a project path, or
// null for a package (or anything in node_modules). Also returns .d.ts files, which are only used for this.
function makeResolver(root) {
  const cache = new Map(), configs = new Map(), aliasesUsed = new Map();
  const isFile = (abs) => {
    if (!cache.has(abs)) { let ok = false; try { ok = fs.statSync(abs).isFile(); } catch {} cache.set(abs, ok); }
    return cache.get(abs);
  };
  const inProject = (abs) => { const rel = toPosix(path.relative(root, abs)); return rel && !rel.startsWith('..') && !rel.split('/').includes('node_modules') ? rel : null; };
  const tryBase = (base) => {
    for (const suf of RESOLVE_SUFFIXES) {
      const cand = base + suf;
      if (isFile(cand) && (suf !== '' || isJs(cand))) return inProject(cand);
    }
    const js = /\.(m|c)?jsx?$/i.exec(base); // TypeScript ESM style: import './x.js' for x.ts
    if (js) for (const ext of ['.ts', '.tsx', '.mts', '.cts']) if (isFile(base.slice(0, -js[0].length) + ext)) return inProject(base.slice(0, -js[0].length) + ext);
    return null;
  };
  // A config with its "extends" chain: { paths, pathsBase, baseUrl } (paths relative to baseUrl, else to the
  // config that defines them).
  const loadConfig = (file, depth = 0) => {
    if (configs.has(file)) return configs.get(file);
    const json = readJsonc(file), dir = path.dirname(file);
    let out = { file: toPosix(path.relative(root, file)), paths: null, pathsBase: null, baseUrl: null };
    if (json && depth < 8) {
      for (const ext of [].concat(json.extends || [])) {
        let pf = ext.startsWith('.') ? path.resolve(dir, ext) : null;
        if (!pf) for (let d = dir; d.startsWith(root); d = path.dirname(d)) { const c = path.join(d, 'node_modules', ext); if (fs.existsSync(c) || fs.existsSync(`${c}.json`)) { pf = c; break; } if (d === root) break; }
        if (pf && !pf.endsWith('.json') && !fs.existsSync(pf)) pf += '.json';
        if (pf && fs.existsSync(pf) && fs.statSync(pf).isFile()) { const parent = loadConfig(pf, depth + 1); out = { ...out, paths: parent.paths, pathsBase: parent.pathsBase, baseUrl: parent.baseUrl }; }
      }
      const co = json.compilerOptions || {};
      if (co.baseUrl) out.baseUrl = path.resolve(dir, co.baseUrl);
      if (co.paths) { out.paths = co.paths; out.pathsBase = out.baseUrl || dir; }
      else if (co.baseUrl && out.paths) out.pathsBase = out.baseUrl;
    }
    configs.set(file, out);
    return out;
  };
  // The nearest tsconfig.json or jsconfig.json above a file, inside the project.
  const nearest = new Map();
  const configFor = (dirAbs) => {
    if (nearest.has(dirAbs)) return nearest.get(dirAbs);
    let found = null;
    for (const name of ['tsconfig.json', 'jsconfig.json']) if (isFile(path.join(dirAbs, name))) { found = loadConfig(path.join(dirAbs, name)); break; }
    if (!found && dirAbs !== root && dirAbs.startsWith(root)) found = configFor(path.dirname(dirAbs));
    nearest.set(dirAbs, found);
    return found;
  };
  const resolve = (fromRel, spec) => {
    if (!spec) return null;
    if (spec.startsWith('.') || spec.startsWith('/')) return tryBase(spec.startsWith('/') ? spec : path.join(root, path.dirname(fromRel), spec));
    const cfg = configFor(path.join(root, path.dirname(fromRel)));
    if (!cfg) return null;
    for (const [pattern, targets] of Object.entries(cfg.paths || {})) {
      const star = pattern.indexOf('*');
      const match = star < 0 ? (spec === pattern ? '' : null)
        : spec.startsWith(pattern.slice(0, star)) && spec.endsWith(pattern.slice(star + 1)) && spec.length >= pattern.length - 1 ? spec.slice(star, spec.length - (pattern.length - star - 1)) : null;
      if (match === null) continue;
      for (const t of [].concat(targets)) {
        const hit = tryBase(path.join(cfg.pathsBase, star < 0 ? t : t.replace('*', match)));
        if (hit) { const k = `${cfg.file}: ${pattern}`; aliasesUsed.set(k, (aliasesUsed.get(k) || 0) + 1); return hit; }
      }
    }
    if (cfg.baseUrl) { const hit = tryBase(path.join(cfg.baseUrl, spec)); if (hit) { const k = `${cfg.file}: baseUrl`; aliasesUsed.set(k, (aliasesUsed.get(k) || 0) + 1); return hit; } }
    return null;
  };
  resolve.aliases = () => [...configs.values()].filter((c) => c.paths || c.baseUrl).map((c) => ({ config: c.file, paths: Object.keys(c.paths || {}), baseUrl: c.baseUrl ? toPosix(path.relative(root, c.baseUrl)) || '.' : null }));
  resolve.aliasesUsed = () => Object.fromEntries(aliasesUsed);
  resolve.configFor = configFor;
  return resolve;
}

const packageName = (spec) => {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
};

const countBy = (arr, f) => arr.reduce((o, x) => { const k = f(x); o[k] = (o[k] || 0) + 1; return o; }, {});

// --- several folders, one map ------------------------------------------------------
// A Brain project can link several code folders (two repositories sharing one database). Each is mapped on its
// own by buildMap, so imports, calls, navigation and routes stay inside one folder; then the maps are merged.
// With more than one folder every file id and path gets the folder's short name in front (app:src/x.js), so the
// same path in two repositories never collides. The data layer is the join: a collection or subcollection with the
// same path pattern is one node, read and written from every folder (its counts per folder in byFolder). A cloud
// function called in one folder and defined in another is a calls-function edge marked crossFolder. Every node
// and edge records its folder (codeFolder). A single folder is merged with no prefixes, so its map is unchanged.
const DATA_ID = /^(sub)?collection:/;
export function mergeMaps(parts) {
  const multi = parts.length > 1;
  const nodes = [], edges = [], unresolved = [], missing = [], parseFailures = [], notes = [], skippedFiles = [], keptLarge = [];
  const screens = [], unknownOps = [], masked = new Set(), rootGroups = [], folders = [];
  const groupList = [], isolated = [], groupLinks = [];
  const nav = { calls: 0, targets: 0, matched: 0, matchedInferred: 0, computed: 0, inferredCalls: 0, unmatched: [], byMethod: {}, skippedNonNavigationReceivers: 0 };
  const fn = { calls: 0, matched: 0, computed: 0, unmatched: [], names: {}, exported: [], definitions: {} };
  const fnByFolder = {};
  const data = new Map();
  const assetTotals = { total: 0, byExtension: {} };
  const aliasConfigs = [], aliasUsed = {};
  const counts = {};
  let groupOffset = 0, duration = 0;
  for (const { name, map: m } of parts) {
    const P = (f) => (f == null || !multi ? f : `${name}:${f}`);
    const PE = (id) => (DATA_ID.test(id) ? id : P(id));
    for (const n of m.nodes) {
      if (n.kind === 'file') { nodes.push({ ...n, id: P(n.id), path: P(n.path), relPath: n.path, codeFolder: name, ...(n.group ? { group: n.group + groupOffset } : {}) }); continue; }
      const mine = { readers: n.readers, writers: n.writers, unknown: n.usedWithUnknownOperation, paths: n.paths, ...(n.pattern ? { pattern: n.pattern } : {}) };
      const d = data.get(n.id);
      if (!d) { data.set(n.id, { ...n, paths: [...n.paths], folders: [name], byFolder: { [name]: mine } }); continue; }
      // A shared subcollection keeps the pattern of the first folder that has it (the order the folders were
      // linked); links from a folder that names the placeholders differently are marked as merged by position.
      d.readers += n.readers; d.writers += n.writers; d.usedWithUnknownOperation += n.usedWithUnknownOperation;
      d.paths = [...new Set([...d.paths, ...n.paths])].sort();
      if (n.collectionGroup) d.collectionGroup = true;
      d.folders.push(name); d.byFolder[name] = mine;
    }
    for (const e of m.edges) edges.push({ ...e, from: P(e.from), to: PE(e.to), ...(e.passedFrom ? { passedFrom: P(e.passedFrom) } : {}), codeFolder: name });
    for (const u of m.unresolved) unresolved.push({ ...u, file: P(u.file), ...(u.target ? { target: P(u.target) } : {}), codeFolder: name });
    for (const x of m.missingRelative) missing.push({ ...x, file: P(x.file), codeFolder: name });
    for (const x of m.parseFailures) parseFailures.push({ ...x, file: P(x.file), codeFolder: name });
    for (const x of m.notes) notes.push({ ...x, file: P(x.file), codeFolder: name });
    for (const x of m.skippedFiles) skippedFiles.push({ ...x, file: P(x.file), codeFolder: name });
    for (const x of m.keptLargeFiles) keptLarge.push({ ...x, file: P(x.file), importedBy: P(x.importedBy), codeFolder: name });
    for (const x of m.data.usesWithUnknownOperation) unknownOps.push({ ...x, file: P(x.file), codeFolder: name });
    for (const x of m.data.documentIdPathsMasked) masked.add(x);
    for (const g of m.rootGroups) rootGroups.push({ ...g, entry: P(g.entry), entries: g.entries.map(P), entryReasons: Object.fromEntries(Object.entries(g.entryReasons).map(([k, v]) => [P(k), v])), codeFolder: name });
    const { screens: sc, ...ns } = m.navigation;
    for (const x of sc) screens.push({ ...x, file: P(x.file), navigatorFile: P(x.navigatorFile), codeFolder: name });
    for (const [k, v] of Object.entries(ns)) {
      if (typeof v === 'number') nav[k] = (nav[k] || 0) + v;
      else if (k === 'unmatched') nav.unmatched.push(...v.map((u) => ({ ...u, file: P(u.file), codeFolder: name })));
      else if (k === 'byMethod') for (const [mk, mv] of Object.entries(v)) nav.byMethod[mk] = (nav.byMethod[mk] || 0) + mv;
    }
    const f = m.functions;
    const own = { calls: f.calls, matched: f.matched, computed: f.computed, unmatched: f.unmatched.map((u) => ({ ...u, file: P(u.file) })), names: {}, exported: f.exported,
      definitions: Object.fromEntries(Object.entries(f.definitions || {}).map(([k, v]) => [k, P(v)])) };
    for (const [k, v] of Object.entries(f.names)) own.names[k] = { definedIn: P(v.definedIn), callers: v.callers.map(P) };
    fnByFolder[name] = own;
    fn.calls += f.calls; fn.matched += f.matched; fn.computed += f.computed;
    fn.unmatched.push(...own.unmatched.map((u) => ({ ...u, codeFolder: name })));
    for (const [k, v] of Object.entries(own.names)) {
      const t = (fn.names[k] ??= { definedIn: null, callers: [] });
      t.definedIn ??= v.definedIn; t.callers.push(...v.callers);
    }
    for (const x of f.exported) if (!fn.exported.includes(x)) fn.exported.push(x);
    for (const [k, v] of Object.entries(own.definitions)) fn.definitions[k] ??= v;
    for (const g of m.groups.list) groupList.push({ ...g, id: g.id + groupOffset, files: g.files.map(P), central: g.central.map(P), codeFolder: name });
    isolated.push(...m.groups.isolated.map(P));
    groupLinks.push(...m.groups.links.map((l) => ({ ...l, a: l.a + groupOffset, b: l.b + groupOffset })));
    groupOffset += m.groups.list.length;
    assetTotals.total += m.assetTotals.total;
    for (const [k, v] of Object.entries(m.assetTotals.byExtension)) assetTotals.byExtension[k] = (assetTotals.byExtension[k] || 0) + v;
    aliasConfigs.push(...m.pathAliases.configs.map((c) => ({ ...c, config: P(c.config), codeFolder: name })));
    for (const [k, v] of Object.entries(m.pathAliases.used)) aliasUsed[P(k)] = v;
    for (const [k, v] of Object.entries(m.counts)) {
      if (typeof v === 'number') counts[k] = (counts[k] || 0) + v;
      else if (v && typeof v === 'object') { counts[k] ??= {}; for (const [kk, vv] of Object.entries(v)) counts[k][kk] = (counts[k][kk] || 0) + vv; }
    }
    duration += m.durationMs;
    folders.push({ name, path: m.project.path, gitCommit: m.project.gitCommit, fileListSource: m.project.fileListSource, generatedAt: m.generatedAt, durationMs: m.durationMs, counts: m.counts });
  }

  if (multi) {
    // A cloud function called in one folder and defined in another (the app's functions/, the website's calls).
    for (const { name, map: m } of parts) {
      for (const u of m.functions.unmatched) {
        const defs = parts.filter((o) => o.name !== name && o.map.functions.definitions?.[u.name]);
        if (!defs.length) continue;
        for (const o of defs) {
          edges.push({ from: `${name}:${u.file}`, to: `${o.name}:${o.map.functions.definitions[u.name]}`, kind: 'calls-function', line: u.line, function: u.name,
            codeFolder: name, toFolder: o.name, crossFolder: true, why: `cloud function defined in another linked folder (${o.name})`, tag: 'inferred' });
        }
        fn.matched++;
        fn.unmatched = fn.unmatched.filter((x) => !(x.codeFolder === name && x.name === u.name && x.line === u.line && x.file === `${name}:${u.file}`));
        fn.names[u.name].definedIn ??= `${defs[0].name}:${defs[0].map.functions.definitions[u.name]}`;
      }
    }
    // A shared subcollection whose placeholders were named differently in another folder.
    for (const e of edges) {
      const d = e.to.startsWith('subcollection:') ? data.get(e.to) : null;
      if (!d || e.why) continue;
      const n = d.key.split('/').length;
      if ((e.paths || []).some((p) => p.split('/').slice(0, n).join('/') !== d.pattern)) { e.why = 'placeholders merged by position'; e.tag = 'inferred'; }
    }
    for (const d of data.values()) if (d.folders.length > 1) d.shared = true;
  }
  const dataNodes = [...data.values()];
  nodes.push(...dataNodes.filter((n) => n.kind === 'collection').sort((a, b) => a.name.localeCompare(b.name)),
    ...dataNodes.filter((n) => n.kind === 'subcollection').sort((a, b) => a.key.localeCompare(b.key)));

  Object.assign(counts, {
    nodes: nodes.length, nodesByKind: countBy(nodes, (n) => n.kind), edges: edges.length, edgesByKind: countBy(edges, (e) => e.kind),
    unresolved: unresolved.length, unresolvedByKind: countBy(unresolved, (u) => u.kind), edgesByConfidence: countBy(edges, (e) => e.tag),
    collections: dataNodes.filter((n) => n.kind === 'collection').length, subcollections: dataNodes.filter((n) => n.kind === 'subcollection').length,
    documentIdPathsMasked: masked.size,
    ...(multi ? { folders: parts.length, crossFolderEdges: edges.filter((e) => e.crossFolder).length, sharedData: dataNodes.filter((n) => n.shared).length } : {}),
  });
  const first = parts[0].map;
  return {
    schemaVersion: SCHEMA_VERSION,
    kinds: KINDS,
    generatedAt: multi ? new Date().toISOString() : first.generatedAt,
    durationMs: duration,
    project: multi ? { folders: parts.map((p) => p.name) } : first.project,
    folders,
    rootGroups,
    counts,
    nodes, edges, unresolved, missingRelative: missing, assetTotals, parseFailures,
    navigation: { screens, ...nav },
    functions: { ...fn, ...(multi ? { byFolder: fnByFolder } : {}) },
    data: { usesWithUnknownOperation: unknownOps, documentIdPathsMasked: [...masked].sort() },
    groups: { algorithm: first.groups.algorithm, seed: first.groups.seed, weights: first.groups.weights, list: groupList, isolated, links: groupLinks },
    notes,
    skippedFiles, keptLargeFiles: keptLarge,
    pathAliases: { configs: aliasConfigs, used: aliasUsed },
  };
}

// --- main ---------------------------------------------------------------------

// Short names of linked code folders: lower-case letters, digits, dash and underscore. The names of the data
// node prefixes are not allowed, so a node id never reads as a collection.
export const FOLDER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,23}$/;
export const RESERVED_FOLDER_NAMES = new Set(['collection', 'subcollection']);
export const defaultFolderName = (dir) => (path.basename(dir).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 24) || 'code');

// node src/mapper.js <project folder> <output name>
// node src/mapper.js --folder <name>=<folder> [--folder <name>=<folder> ...] <output name>
function parseCli(argv) {
  const folders = [], pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--folder' || a.startsWith('--folder=')) {
      const v = a === '--folder' ? argv[++i] : a.slice(9);
      const eq = v?.indexOf('=') ?? -1;
      if (eq < 1) usage('--folder takes <name>=<folder>.');
      folders.push({ name: v.slice(0, eq), dir: v.slice(eq + 1) });
    } else pos.push(a);
  }
  let outName;
  if (folders.length) { if (pos.length !== 1) usage(); outName = pos[0]; }
  else { if (pos.length !== 2) usage(); folders.push({ name: null, dir: pos[0] }); outName = pos[1]; }
  return { folders, outName };
}

function main() {
  const { folders: specs, outName } = parseCli(process.argv.slice(2));
  if (!outName) usage();
  if (!/^[A-Za-z0-9._-]+$/.test(outName) || outName === '.' || outName === '..') usage('Output name may only use letters, digits, dot, dash and underscore.');
  const outDir = path.join(os.homedir(), '.brain', 'maps', outName);
  const brainDir = path.join(os.homedir(), 'Brain');
  const inside = (p, dir) => p === dir || p.startsWith(dir + path.sep);
  const folders = specs.map((f) => {
    const root = path.resolve(f.dir.replace(/^~(?=$|\/)/, os.homedir()));
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) usage(`Not a folder: ${root}`);
    if (inside(outDir, root)) usage('Refusing to write inside the project folder.');
    if (inside(outDir, brainDir)) usage('Refusing to write inside ~/Brain.');
    const name = f.name ?? defaultFolderName(root);
    if (!FOLDER_NAME_RE.test(name) || RESERVED_FOLDER_NAMES.has(name)) usage(`Folder name "${name}": use up to 24 lower-case letters, digits, dash or underscore (not collection or subcollection).`);
    return { name, root };
  });
  const dup = folders.find((f, i) => folders.findIndex((g) => g.name === f.name) !== i);
  if (dup) usage(`Two folders are named "${dup.name}".`);

  const t0 = process.hrtime.bigint();
  const parts = [];
  for (const f of folders) {
    let built;
    try { built = buildMap(f.root); }
    catch (e) {
      if (e.code === NO_JS_EXIT) { console.error(folders.length > 1 ? `${f.name} (${f.root}): ${NO_JS_MESSAGE}` : NO_JS_MESSAGE); process.exit(NO_JS_EXIT); }
      throw e;
    }
    parts.push({ ...f, ...built });
  }
  const map = mergeMaps(parts.map((p) => ({ name: p.name, map: p.map })));
  map.durationMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'map.json');
  fs.writeFileSync(outFile, JSON.stringify(map, null, 2) + '\n');
  console.log(`Map written: ${outFile}  (schema ${SCHEMA_VERSION})`);
  for (const p of parts) {
    if (parts.length > 1) console.log(`\n=== Folder ${p.name}: ${p.root}`);
    p.report();
  }
  if (parts.length > 1) {
    const shared = map.nodes.filter((n) => (n.kind === 'collection' || n.kind === 'subcollection') && n.shared);
    const cross = map.edges.filter((e) => e.crossFolder);
    console.log(`\n=== Merged: ${map.nodes.length} nodes, ${map.edges.length} edges; ${shared.length} collections and subcollections shared by several folders; ${cross.length} cross-folder cloud function calls`);
    for (const n of shared) console.log(`  ${n.kind === 'subcollection' ? n.pattern : n.name}: ${Object.entries(n.byFolder).map(([k, v]) => `${k} ${v.readers}r/${v.writers}w`).join(', ')}`);
    for (const e of cross) console.log(`  ${e.from}:${e.line} → ${e.function} (${e.to})`);
  }
}

// Maps one folder: { map (schema without folder fields), report() } . Throws { code: NO_JS_EXIT } when the
// folder has no JavaScript or TypeScript.
function buildMap(root) {
  const t0 = process.hrtime.bigint();
  const { source: listSource, files: allFiles } = listFiles(root);
  // Sources: JS and TS, without type declarations (.d.ts, used only to resolve imports) and without vendored
  // code (folders, minified/bundled names, files over MAX_LINES), which is listed with the reason instead.
  // A file over MAX_LINES is skipped unless another project file imports it: real bundles are loaded by a
  // script tag, while a large table the app imports (a translations file) is still part of the app.
  const resolve = makeResolver(root);
  const skippedFiles = [], keptLarge = [], codeOf = new Map(), large = new Map();
  const candidates = allFiles.filter(isJs).filter((f) => !isTypeDeclaration(f)).sort().filter((f) => {
    const why = vendoredReason(f);
    if (why) { skippedFiles.push({ file: f, reason: why }); return false; }
    let code; try { code = fs.readFileSync(path.join(root, f), 'utf8'); } catch { return false; }
    codeOf.set(f, code);
    const n = code.length === 0 ? 0 : code.split('\n').length;
    if (n > MAX_LINES) large.set(f, n);
    return true;
  });
  const importedBy = new Map();
  if (large.size) {
    const SPEC = /(?:\bfrom\s*|\brequire\(\s*|\bimport\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm;
    for (const f of candidates) {
      if (large.has(f)) continue;
      for (const m of codeOf.get(f).matchAll(SPEC)) { const to = resolve(f, m[1]); if (to && large.has(to)) importedBy.set(to, f); }
    }
  }
  const jsFiles = candidates.filter((f) => {
    if (!large.has(f)) return true;
    const n = large.get(f).toLocaleString('en-US');
    if (importedBy.has(f)) { keptLarge.push({ file: f, lines: large.get(f), importedBy: importedBy.get(f) }); return true; }
    skippedFiles.push({ file: f, reason: `over ${MAX_LINES.toLocaleString('en-US')} lines (${n}) and imported by no project file` });
    codeOf.delete(f);
    return false;
  });
  if (!jsFiles.length) throw Object.assign(new Error(NO_JS_MESSAGE), { code: NO_JS_EXIT });

  // Root groups: the project itself, plus separate roots such as functions/ and scripts/.
  const rootGroups = [{ name: 'app', dir: '' }];
  for (const d of SEPARATE_ROOTS) {
    if (fs.existsSync(path.join(root, d)) && fs.statSync(path.join(root, d)).isDirectory()) rootGroups.push({ name: d, dir: d });
  }
  const groupOf = (rel) => rootGroups.find((g) => g.dir && (rel === g.dir || rel.startsWith(g.dir + '/')))?.name ?? 'app';
  const jsSet = new Set(jsFiles);
  for (const g of rootGroups) {
    g.hasPackageJson = fs.existsSync(path.join(root, g.dir, 'package.json'));
    const found = detectEntries(root, g, jsSet, allFiles, groupOf);
    g.entries = found.map((x) => x.file);
    g.entryReasons = Object.fromEntries(found.map((x) => [x.file, x.why]));
    g.entry = g.entries[0] ?? null; // the first one, for readers of a single entry
  }
  const functionsEntry = rootGroups.find((g) => g.name === 'functions')?.entry ?? null;

  const nodeSet = new Set(jsFiles);
  const nodes = [], edges = [], unresolved = [], missing = [], parseFailures = [];
  const webRedirects = new Map(); // redirect route path → where it sends (<Route path="/" element={<Navigate to="/clients" />} />)
  const rawScreens = [], navCallsByFile = new Map(), callablesByFile = new Map(), dataByFile = new Map();
  const exportTables = new Map(), callsByFile = new Map(), paramCallsByFile = new Map(), importNames = new Map();
  let localCallCount = 0;
  const notes = [];
  let navSkippedNonNav = 0, functionDefs = new Map();
  const assetTotals = { total: 0, byExtension: {} };

  for (const rel of jsFiles) {
    const code = codeOf.get(rel);
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
    try { ast = parseFile(code, rel); }
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
      const relative = ld.spec.startsWith('.') || ld.spec.startsWith('/');
      const to = resolve(rel, ld.spec); // relative, or a tsconfig/jsconfig alias
      if (to && nodeSet.has(to)) {
        const edge = { from: rel, to, kind: ld.kind, line: ld.line };
        edges.push(edge);
        if (ld.names) importNames.set(edge, ld.names);
      } else if (to && isTypeDeclaration(to)) {
        // a .d.ts: type declarations only, nothing to link
      } else if (relative || to) {
        missing.push({ file: rel, line: ld.line, ...(to ? { resolvedOutsideScan: true, reason: vendoredReason(to) || undefined } : {}) });
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
    for (const nt of collectNotes(ast, A)) notes.push({ file: rel, ...nt });
    for (const c of collectLocalCalls(ast.program, A)) {
      edges.push({ from: rel, to: rel, kind: 'calls', line: c.line, function: c.function, ...(c.caller ? { caller: c.caller } : {}), sameFile: true });
      localCallCount++;
    }
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
          if (spec) file = resolve(rel, spec);
          else if (!spec && (bind?.local || !s.component)) file = rel; // defined here, or children render
          rawScreens.push({ ...s, navigatorFile: rel, file, localComponent: !spec && !!bind?.local });
        }
      }
      const web = collectWebRoutes(ast, A);
      for (const r of web.routes) {
        const file = r.spec ? resolve(rel, r.spec) : r.local ? rel : null;
        rawScreens.push({ name: r.path, component: r.component, file, navigator: 'Route', navigatorFile: rel, line: r.line, route: true });
      }
      const { calls, skippedNonNav } = collectNavCalls(A);
      navSkippedNonNav += skippedNonNav;
      // A route whose element is <Navigate to> is a redirect from the file that defines the routes.
      for (const r of web.redirects) { const to = literalValue(r.to); if (r.from !== '*' && to) webRedirects.set(r.from, to); }
      for (const r of web.redirects) { const t = webTargets(r.to, A, r.line).filter((x) => !x.nonPath); if (t.length) calls.push({ method: 'redirect', line: r.line, targets: t }); }
      calls.push(...collectWebNav(A));
      if (calls.length) navCallsByFile.set(rel, calls);
      const callables = collectCallables(A);
      if (callables.length) callablesByFile.set(rel, callables);
    }
  }

  // --- navigation: screens, nesting, navigate edges
  for (const r of nextRoutes(root, allFiles)) if (nodeSet.has(r.file)) rawScreens.push({ name: r.path, component: null, file: r.file, navigator: 'Next.js', navigatorFile: r.file, line: 1, route: true });
  const screens = rawScreens.map((s) => ({
    name: s.name, component: s.component, file: s.file, navigator: s.navigator,
    navigatorFile: s.navigatorFile, line: s.line, host: s.host, localComponent: s.localComponent, ...(s.route ? { route: true } : {}),
  }));
  // A navigator hosted by component H in file F is nested under the screen that renders H
  // (defined locally in F), or under a screen whose component is imported from F.
  const hostsIn = (f) => new Set(screens.filter((x) => x.navigatorFile === f).map((x) => x.host));
  for (const s of screens) {
    if (s.route) { s.parent = null; continue; } // web routes: nesting is already in their path
    const parent = screens.find((p) => !p.route && !(p.navigatorFile === s.navigatorFile && p.host === s.host)
      && p.file === s.navigatorFile && (p.localComponent ? p.component === s.host : hostsIn(s.navigatorFile).size === 1));
    s.parent = parent ? parent.name : null;
  }
  for (const s of screens) { delete s.host; delete s.localComponent; }
  const webRoutes = screens.filter((s) => s.route && s.file);
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
        if (t.computed) { navStats.computed++; unresolved.push({ file: from, line: t.line, kind: 'navigate', reason: t.expr ? `computed target: ${t.expr}` : 'computed target' }); continue; }
        let hits = t.template ? null : screensByName.get(t.name);
        let paramMatch = false, redirected = null;
        if (!hits && webRedirects.has(t.name)) { redirected = t.name; t.name = webRedirects.get(t.name); hits = screensByName.get(t.name); }
        if (!hits && t.name.startsWith('/')) {
          // A web path: the route it matches, preferring exact routes over ones whose parameters take values.
          const m = webRoutes.map((r) => ({ r, how: matchRoute(t.name, r.name) })).filter((x) => x.how);
          const exact = m.filter((x) => x.how === 'exact');
          const best = exact.length ? exact : m.sort((a, b) => (a.r.name.match(/:/g) || []).length - (b.r.name.match(/:/g) || []).length).slice(0, 1);
          if (best.length) { hits = best.map((x) => x.r); paramMatch = !exact.length; t.name = hits[0].name; }
        }
        if (!hits) {
          navStats.unmatched.push({ name: t.name, file: from, line: t.line, ...(t.inferred ? { inferred: true } : {}) });
          unresolved.push({ file: from, line: t.line, kind: 'navigate', reason: t.name.startsWith('/') ? `no route matches ${t.name}` : `no screen named ${t.name}` });
          continue;
        }
        navStats.matched++;
        if (t.inferred) navStats.matchedInferred++;
        navIncoming.set(t.name, (navIncoming.get(t.name) || 0) + 1);
        for (const via of t.via) for (const v of via.split('|')) viaIncoming.set(v, (viaIncoming.get(v) || 0) + 1);
        for (const h of hits) {
          if (h.file) edges.push({ from, to: h.file, kind: 'navigate', line: t.line, screen: t.name, method: call.method,
            ...(t.via.length ? { via: t.via } : {}),
            ...(redirected ? { inferred: true, why: `${redirected} redirects to ${t.name}` } : paramMatch || t.template ? { inferred: true, why: 'route parameter matched' } : t.inferred ? { inferred: true, why: t.name.startsWith('/') ? 'path inferred from a value' : 'screen name inferred' } : {}) });
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
  fnStats.definitions = Object.fromEntries(functionDefs); // name -> file, so another linked folder's calls can be matched

  // --- function calls between project files: calls edges (one per call site)
  const resolveExport = (file, name, depth = 0) => {
    const t = exportTables.get(file);
    if (!t || depth > 10) return null;
    const e = t.names.get(name);
    if (e) return e.file ? (e.name === '*' ? null : resolveExport(e.file, e.name, depth + 1)) : { file, name, local: e.local, fn: e.fn, type: !!e.type };
    if (name !== 'default') for (const f of t.stars) { const r = resolveExport(f, name, depth + 1); if (r) return r; }
    return null;
  };
  // An import whose every name is an interface or type alias in the target file is a type import too.
  for (const [edge, names] of importNames) {
    if (edge.kind !== 'import' || !names.length || names.includes('*')) continue;
    if (names.every((n) => resolveExport(edge.to, n)?.type)) edge.kind = 'type-import';
  }
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
            caller: h.caller, via: 'value', passedFrom: from, passedLine: ps.passLine, why: 'function passed as a value',
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
    // Confidence per use: the link counts as inferred only if every use behind it was (see below).
    if (u.why) { e.inferredUses = (e.inferredUses || 0) + 1; e.whyFirst ??= u.why; const st = e.sites.find((x) => x.line === u.line); if (st && !st.why) st.why = u.why; }
  };
  const maskedPaths = new Set();
  for (const [from, data] of dataByFile) {
    for (const m of data.masked) maskedPaths.add(m);
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
  for (const e of dataEdges.values()) {
    if (e.inferredUses === e.count) e.why = e.whyFirst; // an explicit use anywhere makes the link extracted
    delete e.inferredUses; delete e.whyFirst;
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
  // A file used only for its types is still used: type imports count for reachability and importers.
  const importEdges = edges.filter((e) => IMPORT_KINDS.includes(e.kind) || e.kind === 'type-import');
  const out = new Map(jsFiles.map((f) => [f, []]));
  const importers = new Map(jsFiles.map((f) => [f, new Set()]));
  for (const e of importEdges) { out.get(e.from).push(e.to); importers.get(e.to).add(e.from); }
  const reach = (starts) => {
    const seen = new Set();
    const stack = [].concat(starts || []).filter(Boolean);
    while (stack.length) { const f = stack.pop(); if (seen.has(f)) continue; seen.add(f); stack.push(...out.get(f)); }
    return seen;
  };
  const appEntry = rootGroups[0].entries.join(', ') || null;
  const fromAppEntry = reach(rootGroups[0].entries);
  for (const g of rootGroups) {
    const members = fileNodes.filter((n) => n.rootGroup === g.name).map((n) => n.path);
    const fromOwn = reach(g.entries);
    g.fileCount = members.length;
    g.notImportedFromAppEntry = members.filter((f) => !fromAppEntry.has(f)).length;
    g.notImportedFromOwnEntry = g.entries.length ? members.filter((f) => !fromOwn.has(f)).length : null;
    g.importedByNoFile = members.filter((f) => importers.get(f).size === 0).length;
  }
  for (const n of fileNodes) {
    n.importedBy = importers.get(n.path).size;
    n.reachableFromAppEntry = fromAppEntry.has(n.path);
  }

  // --- confidence: every edge is extracted (written out in the code) or inferred (derived by the mapper)
  const subPattern = new Map(nodes.filter((n) => n.kind === 'subcollection').map((n) => [n.id, n]));
  for (const e of edges) {
    if (!e.why && subPattern.has(e.to)) {
      // A subcollection whose placeholders were named differently in this file and merged by position.
      const node = subPattern.get(e.to), parts = node.key.split('/');
      const own = (e.paths || []).map((p) => p.split('/').slice(0, parts.length).join('/'));
      if (own.some((p) => p !== node.pattern)) e.why = 'placeholders merged by position';
    }
    e.tag = e.why ? 'inferred' : 'extracted';
  }

  // --- subsystems: groups of related files (community detection on the file graph; see map-groups.js)
  // Detected separately for each root (app, functions/, scripts/), so admin scripts and cloud functions never
  // join app groups; links across roots still show in a group's "depends on" and "used by".
  const det = { groups: [], isolated: [], adj: new Map(), root: new Map() };
  for (const g of rootGroups) {
    const part = detectGroups(fileNodes.filter((n) => n.rootGroup === g.name), edges);
    for (const grp of part.groups.sort((a, b) => b.length - a.length || a[0].localeCompare(b[0]))) { det.groups.push(grp); det.root.set(grp, g.name); }
    det.isolated.push(...part.isolated);
    for (const [k, v] of part.adj) det.adj.set(k, v);
  }
  const rawGroups = det.groups;
  const names = nameGroups(rawGroups, fileNodes, edges, screens);
  const groupOfFile = new Map();
  rawGroups.forEach((g, i) => g.forEach(f => groupOfFile.set(f, i + 1)));
  for (const f of det.isolated) groupOfFile.set(f, 0);
  const internal = f => { let s = 0; for (const [o, w] of det.adj.get(f)) if (groupOfFile.get(o) === groupOfFile.get(f)) s += w; return s; };
  const groupList = rawGroups.map((g, i) => {
    const cols = new Map();
    for (const e of edges) if ((e.kind === 'reads' || e.kind === 'writes') && e.to.startsWith('collection:') && groupOfFile.get(e.from) === i + 1) cols.set(e.to.slice(11), (cols.get(e.to.slice(11)) || 0) + 1);
    return { id: i + 1, root: det.root.get(g), label: names[i].label, terms: names[i].terms, size: g.length,
      central: [...g].sort((a, b) => internal(b) - internal(a) || a.localeCompare(b)).slice(0, 3),
      collections: [...cols].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([c]) => c), files: g };
  });
  const between = new Map();
  for (const [a, m] of det.adj) for (const [b, w] of m) {
    const ga = groupOfFile.get(a), gb = groupOfFile.get(b);
    if (a < b && ga !== gb && ga && gb) { const k = ga < gb ? `${ga}-${gb}` : `${gb}-${ga}`; between.set(k, (between.get(k) || 0) + w); }
  }
  for (const n of fileNodes) n.group = groupOfFile.get(n.id) ?? 0;
  const groupsOut = {
    algorithm: 'Louvain with Leiden-style refinement (groups split into connected parts), modularity, resolution 1, per root group',
    seed: GROUP_SEED, weights: GROUP_WEIGHTS, list: groupList, isolated: det.isolated,
    links: [...between].map(([k, w]) => { const [a, b] = k.split('-').map(Number); return { a, b, weight: Math.round(w * 100) / 100 }; })
      .sort((x, y) => y.weight - x.weight || x.a - y.a || x.b - y.b).slice(0, 40),
  };

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
      filesByLanguage: countBy(fileNodes, (n) => (/\.(m|c)?tsx?$/i.test(n.path) ? 'typescript' : 'javascript')), skippedFiles: skippedFiles.length,
      notes: notes.length, edgesByConfidence: countBy(edges, (e) => e.tag), functionCallsSameFile: localCallCount, functionCallSites: callStats.calls, functionCallsResolved: callStats.resolved, functionCallsViaValue: callStats.viaValue || 0, functionCallsUnresolved: callStats.unresolved,
      collections: collections.size, subcollections: subs.size, documentIdPathsMasked: maskedPaths.size, dataUsesWithUnknownOperation: dataOpUnknown.length,
    },
    nodes, edges, unresolved, missingRelative: missing, assetTotals, parseFailures,
    navigation: { screens, ...navStats },
    functions: fnStats,
    // Paths in which a literal document ID was replaced by {id} (masked form only; the raw ID is never stored).
    data: { usesWithUnknownOperation: dataOpUnknown, documentIdPathsMasked: [...maskedPaths].sort() },
    groups: groupsOut,
    notes,
    skippedFiles, keptLargeFiles: keptLarge,
    pathAliases: { configs: resolve.aliases(), used: resolve.aliasesUsed() },
  };

  return { map, report };

  // --- report (printed by main after the merged map is written)
  function report() {
  const kv = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(', ');
  console.log(`Run time: ${Math.round(elapsedMs)} ms  (file list from ${listSource})`);
  console.log(`Commit: ${commit ?? 'none'}`);
  console.log(`Nodes: ${nodes.length} (${kv(map.counts.nodesByKind)})`);
  console.log(`Edges: ${edges.length} (${kv(map.counts.edgesByKind)})`);
  console.log(`Unresolved: ${unresolved.length} (${kv(map.counts.unresolvedByKind)})  Missing relative: ${missing.length}  Assets: ${assetTotals.total} ${JSON.stringify(assetTotals.byExtension)}`);
  for (const g of rootGroups) {
    console.log(`Root group ${g.name}: ${g.fileCount} files, ${g.entries.length ? `entry files ${g.entries.map((e) => `${e} (${g.entryReasons[e]})`).join(', ')}` : 'no entry file found'}, not imported from ${appEntry ?? 'app entry'}: ${g.notImportedFromAppEntry}`
      + (g.entries.length && g.name !== 'app' ? `, not imported from own entry: ${g.notImportedFromOwnEntry}` : '')
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
    console.log(`Data uses with unknown read/write: ${dataOpUnknown.length}; unresolved data paths: ${map.counts.unresolvedByKind.data ?? 0}; paths with a literal document ID masked as {id}: ${maskedPaths.size}`);
  }
  console.log(`Function calls between files: ${callStats.resolved} resolved (${callStats.viaValue || 0} via a value passed on), ${callStats.unresolved} unresolved (kind call); inside the same file: ${localCallCount}`);
  console.log(`Groups: ${groupList.length} (+${det.isolated.length} isolated files)`);
  for (const g of groupList) console.log(`  ${g.id}. [${g.root}] ${g.label}  (${g.size})  ${g.central.join(', ')}`);
  console.log(`Edges by confidence: ${kv(countBy(edges, (e) => e.tag))}; inferred by reason: ${kv(countBy(edges.filter((e) => e.why), (e) => e.why))}`);
  console.log(`Notes: ${notes.length} (${kv(countBy(notes, (n) => n.tag))})`);
  if (keptLarge.length) console.log(`Kept despite size (imported by the app): ${keptLarge.map((x) => `${x.file} (${x.lines} lines, imported by ${x.importedBy})`).join('; ')}`);
  console.log(`Languages: ${kv(map.counts.filesByLanguage)}; skipped: ${skippedFiles.length}${skippedFiles.length ? ` (${skippedFiles.slice(0, 5).map((x) => `${x.file}: ${x.reason}`).join('; ')}${skippedFiles.length > 5 ? '; …' : ''})` : ''}`);
  const al = resolve.aliases(); if (al.length) console.log(`Path aliases: ${al.map((a) => `${a.config} ${[...a.paths, ...(a.baseUrl ? [`baseUrl=${a.baseUrl}`] : [])].join(', ')}`).join(' | ')}; used: ${JSON.stringify(resolve.aliasesUsed())}`);
  console.log(`Parse failures: ${parseFailures.length}`);
  for (const f of parseFailures) console.log(`  ${f.file}:${f.line ?? '?'} ${f.reason}`);
  }
}

// Run only when executed directly, so the server can import the constants above.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
