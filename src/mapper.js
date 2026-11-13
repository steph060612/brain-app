#!/usr/bin/env node
// Standalone code mapper: builds a file-level import map of a JavaScript project.
// Usage: node src/mapper.js <project folder> <output name>
// Read-only on the project. Writes only ~/.brain/maps/<output name>/map.json.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from '@babel/parser';

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

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch { return null; }
}

function skipped(rel) {
  return rel.split('/').some((seg) => SKIP_DIRS.has(seg));
}

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
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    const re = line.split('**').map((part) => part.split('*').map((s) => s.replace(/[.+^${}()|[\]\\?]/g, '\\$&')).join('[^/]*')).join('.*');
    rules.push({ neg, dirOnly, re: new RegExp(anchored ? `^${re}(/|$)` : `(^|/)${re}(/|$)`) });
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

function walkAst(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const key in node) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key.endsWith('Comments')) continue;
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

// --- navigation pass ----------------------------------------------------------

const NAV_METHODS = new Set(['navigate', 'push', 'replace', 'reset']);
// push/replace/reset are also String/Array/form methods, so they count only on a navigation-like receiver.
const NAV_RECEIVER = /^(nav\w*|\w*Navigation\w*|\w*navigationRef\w*|StackActions|CommonActions|TabActions|DrawerActions)$/i;

function receiverName(obj) {
  // navigation, props.navigation, this.props.navigation, navigationRef.current -> the most telling identifier
  let n = obj;
  while (n && (n.type === 'MemberExpression' || n.type === 'OptionalMemberExpression')) {
    if (!n.computed && n.property.type === 'Identifier' && n.property.name !== 'current') return n.property.name;
    n = n.object;
  }
  return n?.type === 'Identifier' ? n.name : n?.type === 'ThisExpression' ? 'this' : null;
}

function objProp(obj, key) {
  if (obj?.type !== 'ObjectExpression') return undefined;
  const p = obj.properties.find((q) => q.type === 'ObjectProperty' && !q.computed
    && (q.key.name === key || q.key.value === key));
  return p ? p.value : undefined;
}

// Follow { screen: 'X', params: { screen: 'Y' } } down to the deepest literal screen.
function nestedScreen(params) {
  let chain = [], cur = params;
  while (cur?.type === 'ObjectExpression') {
    const s = objProp(cur, 'screen');
    if (s === undefined) break;
    const v = literalValue(s);
    if (v === null) return { chain, computed: true };
    chain.push(v);
    cur = objProp(cur, 'params');
  }
  return { chain, computed: false };
}

// A route object { name, params } or { name, state: { routes: [...] } } -> list of targets.
function routeTargets(route, line) {
  const name = objProp(route, 'name');
  const v = literalValue(name);
  if (v === null) return [{ computed: true, line }];
  const { chain, computed } = nestedScreen(objProp(route, 'params'));
  const out = [{ name: v, via: [], line }];
  if (chain.length) out[0] = { name: chain[chain.length - 1], via: [v, ...chain.slice(0, -1)], line };
  if (computed) out.push({ computed: true, line });
  const state = objProp(route, 'state');
  const routes = objProp(state, 'routes');
  if (routes?.type === 'ArrayExpression') for (const r of routes.elements) out.push(...routeTargets(r, line));
  return out;
}

function collectNavCalls(ast) {
  const calls = []; // { method, line, targets: [{ name, via } | { computed }] }
  let skippedNonNav = 0;
  walkAst(ast.program, (n) => {
    if (n.type !== 'CallExpression' && n.type !== 'OptionalCallExpression') return;
    const c = n.callee;
    let method = null, recv = null;
    if ((c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression') && !c.computed && c.property.type === 'Identifier') {
      method = c.property.name; recv = receiverName(c.object);
    } else if (c.type === 'Identifier') { method = c.name; recv = null; }
    if (!NAV_METHODS.has(method)) return;
    if (method !== 'navigate' && !(recv && NAV_RECEIVER.test(recv))) { skippedNonNav++; return; }
    const line = n.loc.start.line;
    const [a0, a1] = n.arguments;
    let targets = [];
    if (method === 'reset') {
      const routes = objProp(a0, 'routes');
      if (routes?.type === 'ArrayExpression') for (const r of routes.elements) targets.push(...routeTargets(r, line));
      else if (literalValue(a0) !== null) targets.push({ name: literalValue(a0), via: [], line });
      else targets.push({ computed: true, line });
    } else if (literalValue(a0) !== null) {
      const { chain, computed } = nestedScreen(a1);
      const first = literalValue(a0);
      targets.push(chain.length ? { name: chain[chain.length - 1], via: [first, ...chain.slice(0, -1)], line } : { name: first, via: [], line });
      if (computed) targets.push({ computed: true, line });
    } else if (a0?.type === 'ObjectExpression') {
      targets.push(...routeTargets(a0, line)); // navigate({ name, params })
    } else {
      targets.push({ computed: true, line });
    }
    calls.push({ method, line, targets });
  });
  return { calls, skippedNonNav };
}

// Local name -> { spec } (import / require) or { local: true } (defined in this file).
function bindings(program) {
  const b = new Map();
  const reqSpec = (init) => {
    let e = init;
    // __DEV__ ? require('x').default : null  /  flag && require('x')
    if (e?.type === 'ConditionalExpression') return reqSpec(e.consequent) ?? reqSpec(e.alternate);
    if (e?.type === 'LogicalExpression') return reqSpec(e.right) ?? reqSpec(e.left);
    if (e?.type === 'MemberExpression') e = e.object; // require('x').default
    if (e?.type === 'CallExpression' && e.callee.name === 'require') return literalValue(e.arguments[0]);
    // React.lazy(() => import('x')) / lazy(() => require('x'))
    if (e?.type === 'CallExpression' && /^(React\.)?lazy$/.test(e.callee.name ?? `${e.callee.object?.name}.${e.callee.property?.name}`)) {
      let body = e.arguments[0]?.body;
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

const jsxTag = (n) => n.type === 'JSXMemberExpression' ? `${jsxTag(n.object)}.${n.property.name}` : n.name;

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
      if (key === 'loc' || key.endsWith('Comments')) continue;
      const v = node[key];
      if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, host));
      else if (v && typeof v.type === 'string') walk(v, host);
    }
  })(ast.program, null);
  return screens;
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

  const resolve = makeResolver(root);
  const nodeSet = new Set(jsFiles);
  const nodes = [], edges = [], unresolved = [], missing = [], parseFailures = [];
  const rawScreens = [], navCallsByFile = new Map();
  let navSkippedNonNav = 0;
  const assetTotals = { total: 0, byExtension: {} };

  for (const rel of jsFiles) {
    const code = fs.readFileSync(path.join(root, rel), 'utf8');
    const lines = code.length === 0 ? 0 : code.split('\n').length - (code.endsWith('\n') ? 1 : 0);
    const segs = rel.split('/');
    const node = {
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
        pkgs.add(packageName(ld.spec.replace(/^node:/, 'node:')));
      }
    }
    node.packages = [...pkgs].sort();

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
      const { calls, skippedNonNav } = collectNavCalls(ast);
      navSkippedNonNav += skippedNonNav;
      if (calls.length) navCallsByFile.set(rel, calls);
    }
  }

  // Navigation: registered screens, nesting, and navigate edges.
  const screens = rawScreens.map((s) => ({
    name: s.name, component: s.component, file: s.file, navigator: s.navigator,
    navigatorFile: s.navigatorFile, line: s.line, host: s.host, localComponent: s.localComponent,
  }));
  // Nesting: a navigator hosted by component H in file F is nested under the screen that
  // renders H (defined locally in F), or under a screen whose component is imported from F.
  const hostsIn = (f) => new Set(screens.filter((x) => x.navigatorFile === f).map((x) => x.host));
  for (const s of screens) {
    const parent = screens.find((p) => p.host !== s.host || p.navigatorFile !== s.navigatorFile
      ? p.file === s.navigatorFile && (p.localComponent ? p.component === s.host : hostsIn(s.navigatorFile).size === 1)
        && !(p.navigatorFile === s.navigatorFile && p.host === s.host)
      : false);
    s.parent = parent ? parent.name : null;
  }
  for (const s of screens) { delete s.host; delete s.localComponent; }
  const screensByName = new Map();
  for (const s of screens) if (s.name) (screensByName.get(s.name) ?? screensByName.set(s.name, []).get(s.name)).push(s);

  const navStats = { calls: 0, targets: 0, matched: 0, computed: 0, unmatched: [], byMethod: {}, skippedNonNavigationReceivers: navSkippedNonNav };
  const navIncoming = new Map(), viaIncoming = new Map();
  for (const [from, calls] of navCallsByFile) {
    for (const call of calls) {
      navStats.calls++;
      navStats.byMethod[call.method] = (navStats.byMethod[call.method] || 0) + 1;
      for (const t of call.targets) {
        navStats.targets++;
        if (t.computed) { navStats.computed++; unresolved.push({ file: from, line: t.line, kind: 'navigate' }); continue; }
        const hits = screensByName.get(t.name);
        if (!hits) { navStats.unmatched.push({ name: t.name, file: from, line: t.line }); continue; }
        navStats.matched++;
        navIncoming.set(t.name, (navIncoming.get(t.name) || 0) + 1);
        for (const via of t.via) viaIncoming.set(via, (viaIncoming.get(via) || 0) + 1);
        for (const h of hits) {
          if (h.file) edges.push({ from, to: h.file, kind: 'navigate', line: t.line, screen: t.name, method: call.method, ...(t.via.length ? { via: t.via } : {}) });
        }
      }
    }
  }
  for (const s of screens) {
    s.incomingNavigation = navIncoming.get(s.name) || 0;
    s.incomingAsNestedParent = viaIncoming.get(s.name) || 0;
  }
  const importEdges = edges.filter((e) => e.kind !== 'navigate');
  const navEdges = edges.length - importEdges.length;

  // Reachability from each root group's entry, and from the project index.js.
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
    const members = nodes.filter((n) => n.rootGroup === g.name).map((n) => n.path);
    const fromOwn = reach(g.entry);
    g.fileCount = members.length;
    g.notImportedFromAppEntry = members.filter((f) => !fromAppEntry.has(f)).length;
    g.notImportedFromOwnEntry = g.entry ? members.filter((f) => !fromOwn.has(f)).length : null;
    g.importedByNoFile = members.filter((f) => importers.get(f).size === 0).length;
  }
  for (const n of nodes) {
    n.importedBy = importers.get(n.path).size;
    n.reachableFromAppEntry = fromAppEntry.has(n.path);
  }

  const commit = git(root, ['rev-parse', 'HEAD'])?.trim() || null;
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const map = {
    version: 1,
    generatedAt: new Date().toISOString(),
    durationMs: Math.round(elapsedMs),
    project: { path: root, gitCommit: commit, fileListSource: listSource },
    rootGroups,
    counts: {
      nodes: nodes.length, edges: edges.length, importEdges: importEdges.length, navigateEdges: navEdges,
      unresolved: unresolved.length, unresolvedLoads: unresolved.filter((u) => u.kind === 'load').length,
      unresolvedNavigation: unresolved.filter((u) => u.kind === 'navigate').length,
      screens: screens.length, navigationCalls: navStats.calls,
      missingRelative: missing.length, assets: assetTotals.total, parseFailures: parseFailures.length,
    },
    nodes, edges, unresolved, missingRelative: missing, assetTotals, parseFailures,
    navigation: { screens, ...navStats },
  };

  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'map.json');
  fs.writeFileSync(outFile, JSON.stringify(map, null, 2) + '\n');

  const top = [...nodes].sort((a, b) => b.importedBy - a.importedBy || a.path.localeCompare(b.path)).slice(0, 10);
  console.log(`Map written: ${outFile}`);
  console.log(`Run time: ${Math.round(elapsedMs)} ms  (file list from ${listSource})`);
  console.log(`Commit: ${commit ?? 'none'}`);
  console.log(`Nodes: ${nodes.length}  Edges: ${edges.length} (import ${importEdges.length}, navigate ${navEdges})  Unresolved: ${unresolved.length} (load ${map.counts.unresolvedLoads}, navigate ${map.counts.unresolvedNavigation})  Missing relative: ${missing.length}  Assets: ${assetTotals.total} ${JSON.stringify(assetTotals.byExtension)}`);
  console.log(`App entry: ${appEntry ?? 'none'}`);
  for (const g of rootGroups) {
    console.log(`Root group ${g.name}: ${g.fileCount} files, entry ${g.entry ?? 'none'}, not imported from ${appEntry ?? 'app entry'}: ${g.notImportedFromAppEntry}`
      + (g.entry && g.name !== 'app' ? `, not imported from own entry: ${g.notImportedFromOwnEntry}` : '')
      + `, imported by no file: ${g.importedByNoFile}`);
  }
  console.log('Most imported:');
  for (const n of top) console.log(`  ${n.importedBy}  ${n.path}`);
  if (screens.length || navStats.calls) {
    const nested = screens.filter((s) => s.parent).length;
    console.log(`Screens registered: ${screens.length} (${nested} nested), in ${new Set(screens.map((s) => s.navigatorFile)).size} navigator file(s); without a resolved file: ${screens.filter((s) => !s.file).length}`);
    console.log(`Navigation calls: ${navStats.calls} ${JSON.stringify(navStats.byMethod)}, targets ${navStats.targets}: matched ${navStats.matched}, unmatched ${navStats.unmatched.length}, computed ${navStats.computed}; push/replace/reset on non-navigation receivers ignored: ${navStats.skippedNonNavigationReceivers}`);
    const um = {};
    for (const u of navStats.unmatched) um[u.name] = (um[u.name] || 0) + 1;
    console.log(`Unmatched names: ${Object.entries(um).map(([k, v]) => `${k} (${v})`).join(', ') || 'none'}`);
    console.log('Most navigated-to screens:');
    for (const s of [...screens].sort((a, b) => b.incomingNavigation - a.incomingNavigation || a.name.localeCompare(b.name)).slice(0, 10)) {
      console.log(`  ${s.incomingNavigation}  ${s.name}  ${s.file ?? '(no file)'}`);
    }
    const none = screens.filter((s) => !s.incomingNavigation && !s.incomingAsNestedParent);
    console.log(`No incoming navigation found: ${none.length}`);
    for (const s of none) console.log(`  ${s.name}${s.parent ? ` (in ${s.parent})` : ''}  ${s.file ?? '(no file)'}`);
  }
  console.log(`Parse failures: ${parseFailures.length}`);
  for (const f of parseFailures) console.log(`  ${f.file}:${f.line ?? '?'} ${f.reason}`);
}

main();
