// Path between two things, and a project report, computed from a map (schemaVersion 12). Pure functions with no
// Node or browser dependencies: used by the brainmap command (and its tools) and by the diagram. Deterministic.
import { isMulti, prefixed, scopeQuery } from './map-folders.js';

const IMPORT_KINDS = new Set(['import', 'require', 're-export', 'dynamic']);
const KIND_LABEL = { import: 'imports', require: 'requires', 're-export': 're-exports', dynamic: 'imports (dynamic)',
  calls: 'calls', navigate: 'navigates to', 'calls-function': 'calls cloud function', reads: 'reads', writes: 'writes', 'read-by': 'is read by' };
const PATH_KINDS = new Set([...IMPORT_KINDS, 'calls', 'navigate', 'calls-function', 'reads', 'writes']);

// The folder a file is listed under; with several code folders, the code folder's name in front (ptdash:src).
export const folderOf = f => (prefixed(f) ? `${f.codeFolder}:` : '') + (f.rootGroup !== 'app' ? f.rootGroup : f.topFolder === '(root)' ? '(root)' : f.topFolder);
const firstLine = e => e.line ?? e.lines?.[0] ?? null;
const nodeLabel = n => (n.kind === 'file' ? n.path : n.kind === 'subcollection' ? n.pattern : n.name);

// ─── callers (across files and inside a file) ────────────────────────────────
// target file + function → every call edge reaching it (other files, values passed on, and the same file).
export function callIndex(map) {
  const idx = new Map();
  const add = (k, e) => (idx.get(k) || idx.set(k, []).get(k)).push(e);
  for (const e of map.edges) {
    if (e.kind !== 'calls') continue;
    for (const name of new Set([e.function, e.local, e.export].filter(Boolean))) add(`${e.to}\0${name}`, e);
  }
  return idx;
}

// Callers of a function as a tree. A call from another file uses up one level of depth; a call inside the same
// file does not (it is plumbing between helpers), up to 6 such hops in a row. Cycles are cut.
export function callerTree(map, file, fn, depth = 1, idx = callIndex(map)) {
  const visit = (f, name, d, sameHops, seen) => (idx.get(`${f}\0${name}`) || []).map(e => {
    const node = { e, children: [] };
    const key = `${e.from}\0${e.caller}`;
    if (e.caller && !seen.has(key)) {
      const next = new Set([...seen, key]);
      if (e.sameFile && sameHops < 6) node.children = visit(e.from, e.caller, d, sameHops + 1, next);
      else if (!e.sameFile && d < depth) node.children = visit(e.from, e.caller, d + 1, 0, next);
    }
    return node;
  });
  return visit(file, fn, 1, 0, new Set([`${file}\0${fn}`]));
}

// Same-file call graph of one file: caller → Set(callee).
function localCalls(map) {
  const g = new Map();
  for (const e of map.edges) if (e.sameFile && e.caller) {
    const m = g.get(e.from) || g.set(e.from, new Map()).get(e.from);
    (m.get(e.caller) || m.set(e.caller, new Set()).get(e.caller)).add(e.function);
  }
  return g;
}
// Shortest chain of same-file calls from function a to function b in a file: [a, …, b], or null.
function localChain(g, file, a, b) {
  const m = g.get(file);
  if (!m || a === b) return a === b ? [a] : null;
  const prev = new Map([[a, null]]), q = [a];
  for (let i = 0; i < q.length; i++) for (const n of m.get(q[i]) || []) {
    if (prev.has(n)) continue;
    prev.set(n, q[i]);
    if (n === b) { const chain = [b]; for (let x = q[i]; x !== null; x = prev.get(x)) chain.unshift(x); return chain; }
    q.push(n);
  }
  return null;
}

const screenWord = name => `${String(name).startsWith('/') ? 'route' : 'screen'} ${name}`; // routes are named by their path
const isScreenHow = how => how.startsWith('screen ') || how.startsWith('route ');

// ─── web routes ──────────────────────────────────────────────────────────────
// Does a path (/clients/123, or /clients/:id) match a route pattern (/clients/:clientUid)? 'exact', 'param'
// (a parameter took a value) or null. The same rule as the mapper's.
export function routeMatch(target, pattern) {
  const clean = p => String(p).split(/[?#]/)[0].replace(/(.)\/$/, '$1');
  const t = clean(target).split('/'), r = clean(pattern).split('/');
  const rest = r[r.length - 1]?.startsWith(':') && r[r.length - 1].endsWith('*');
  if (rest ? t.length < r.length : t.length !== r.length) return null;
  let param = false;
  for (let i = 0; i < r.length; i++) {
    if (r[i].startsWith(':') || r[i] === '*') { if (!t[i]) return null; if (t[i] !== r[i]) param = true; if (r[i].endsWith('*')) break; continue; }
    if (t[i] !== r[i]) return null;
  }
  return param ? 'param' : 'exact';
}
// The routes a path means: the exact route, else those its parameters fit, fewest parameters first.
export function routesFor(screens, q) {
  const routes = (screens || []).filter(s => s.route && s.file);
  const exact = routes.filter(s => s.name === q || routeMatch(q, s.name) === 'exact');
  if (exact.length) return exact;
  const fit = routes.filter(s => routeMatch(q, s.name));
  const params = s => (s.name.match(/:/g) || []).length;
  const least = Math.min(...fit.map(params));
  return fit.filter(s => params(s) === least);
}

// ─── endpoints ───────────────────────────────────────────────────────────────
// Every node a query can mean: a file (path, suffix or name), an exported function (name or file:name),
// a screen, a collection, or a subcollection (name or path pattern). Functions and screens resolve to the file
// that defines them, with a note.
export function resolveEndpoint(map, q) {
  // ptdash:src/x.js or ptdash:/clients: only that folder's files and screens.
  const scope = scopeQuery(map, String(q || '').trim());
  const inScope = x => !scope.folder || x.codeFolder === scope.folder;
  const files = map.nodes.filter(n => n.kind === 'file' && inScope(n));
  const rel = f => (f.relPath ?? f.path);
  q = scope.rest;
  const low = String(q || '').trim().replace(/^\.\//, '').toLowerCase();
  const hits = new Map(); // node id -> { node, how }
  // One entry per node; a file that is also a screen counts as the screen (so two screens can be matched by navigation).
  const add = (node, how) => { if (!node) return; const h = hits.get(node.id); if (!h || (h.how === 'file' && isScreenHow(how))) hits.set(node.id, { node, how }); };
  if (!low) return [];
  const screens = (map.navigation?.screens || []).filter(inScope);
  // A web path (/clients or /clients/123): the routes it matches, as screens.
  if (low.startsWith('/')) {
    for (const s of routesFor(screens, q.trim())) add(files.find(f => f.path === s.file), screenWord(s.name));
    return [...hits.values()];
  }
  const byPath = new Map(files.map(f => [f.path.toLowerCase(), f]));
  const byRel = new Map(); for (const f of files) (byRel.get(rel(f).toLowerCase()) || byRel.set(rel(f).toLowerCase(), []).get(rel(f).toLowerCase())).push(f);
  // file:name → that file's exported function
  const colon = low.lastIndexOf(':');
  if (colon > 0) {
    const fq = low.slice(0, colon), fn = q.trim().slice(colon + 1);
    const fs = byPath.has(fq) ? [byPath.get(fq)] : byRel.get(fq) || files.filter(x => rel(x).toLowerCase().endsWith(`/${fq}`) || x.path.split('/').pop().toLowerCase() === fq);
    for (const f of fs) if ((f.exports || []).includes(fn)) add(f, `function ${fn}`);
    return [...hits.values()];
  }
  const exact = byPath.has(low) ? [byPath.get(low)] : byRel.get(low) || [];
  if (exact.length) {
    // a page file counts as its screen or route
    return exact.map(f => { const s = screens.find(x => x.file === f.path); return { node: f, how: s ? screenWord(s.name) : 'file' }; });
  }
  for (const f of files) {
    const name = f.path.split('/').pop().toLowerCase();
    if (rel(f).toLowerCase().endsWith(`/${low}`) || name === low || name.replace(/\.[^.]+$/, '') === low) add(f, 'file');
  }
  for (const s of screens) {
    if (s.file && (s.name.toLowerCase() === low || s.component?.toLowerCase() === low)) add(files.find(f => f.path === s.file), screenWord(s.name));
  }
  for (const f of files) for (const x of f.exports || []) if (x.toLowerCase() === low && x !== 'default') add(f, `function ${x}`);
  for (const n of map.nodes) {
    if (n.kind === 'collection' && n.name.toLowerCase() === low) add(n, 'collection');
    if (n.kind === 'subcollection') {
      const key = low.includes('/') ? patternKey(low) : null;
      if (n.name.toLowerCase() === low || (key && n.key.toLowerCase() === key)) add(n, 'subcollection');
    }
  }
  return [...hits.values()];
}

function patternKey(q) {
  const parts = q.split('/').filter(Boolean);
  const col = parts.length % 2 === 0 ? parts.slice(0, -1) : parts;
  return col.map((p, i) => (i % 2 ? '{}' : p)).join('/');
}

// ─── path ────────────────────────────────────────────────────────────────────
// Directed adjacency: from → to, one entry per node pair with every edge between them (for the hop text).
// With dataFlow, a read also leads from the collection to the file that reads it ("is read by"), so a path can go
// writer → collection → reader: how data written in one code folder reaches another.
function adjacency(map, reverse = false, kinds = PATH_KINDS, dataFlow = false) {
  const adj = new Map();
  const list = dataFlow ? [...map.edges, ...map.edges.filter(e => e.kind === 'reads').map(e => ({ ...e, kind: 'read-by', from: e.to, to: e.from, reader: e.from }))] : map.edges;
  for (const e of list) {
    if (!kinds.has(e.kind) && e.kind !== 'read-by') continue;
    const [a, b] = reverse ? [e.to, e.from] : [e.from, e.to];
    if (a === b) continue;
    const m = adj.get(a) || adj.set(a, new Map()).get(a);
    (m.get(b) || m.set(b, []).get(b)).push(e);
  }
  return adj;
}

// Shortest paths from any source id to any target id (BFS keeping every shortest parent), up to `limit` paths.
function shortest(adj, sources, targets, limit) {
  const dist = new Map(), parents = new Map(), queue = [];
  for (const s of sources) { dist.set(s, 0); parents.set(s, []); queue.push(s); }
  let found = null;
  for (let i = 0; i < queue.length; i++) {
    const u = queue[i], d = dist.get(u);
    if (found !== null && d >= found) break;
    for (const v of [...(adj.get(u)?.keys() || [])].sort()) {
      if (!dist.has(v)) { dist.set(v, d + 1); parents.set(v, [u]); queue.push(v); if (targets.has(v) && found === null) found = d + 1; }
      else if (dist.get(v) === d + 1) parents.get(v).push(u);
    }
  }
  if (found === null) return [];
  const ends = [...targets].filter(t => dist.get(t) === found).sort();
  const paths = [];
  const walk = (node, tail) => {
    if (paths.length >= limit) return;
    if (dist.get(node) === 0) { paths.push([node, ...tail]); return; }
    for (const p of parents.get(node)) walk(p, [node, ...tail]);
  };
  for (const t of ends) walk(t, []);
  return paths;
}

const RANK = k => ['calls', 'navigate', 'calls-function', 'writes', 'reads'].indexOf(k) + 1 || 9;

// For each hop, put first the edge that leads into the next hop: a call to the function that makes the next call
// or does the read/write. Then the most telling kinds (calls, navigation, data) before imports.
function chooseEdges(hops, local = null) {
  // Functions in a file that act in the hop leaving it: callers of its calls, functions doing its reads/writes,
  // and (with the same-file call graph) every function there that reaches one of those through local calls.
  // Returns Map(function -> 2 if it acts directly, 1 if it reaches an actor through same-file calls).
  const actors = (es, file) => {
    const score = new Map(es.flatMap(e => (e.kind === 'calls' ? [e.caller] : e.kind === 'reads' || e.kind === 'writes' ? (e.sites || []).map(x => x.function) : [])).filter(Boolean).map(f => [f, 2]));
    const m = local?.get(file);
    if (m) for (let grew = true; grew;) { grew = false; for (const [caller, callees] of m) if (!score.has(caller) && [...callees].some(c => score.has(c))) { score.set(caller, 1); grew = true; } }
    return score;
  };
  const byRank = (a, b) => RANK(a.kind) - RANK(b.kind) || (firstLine(a) ?? 0) - (firstLine(b) ?? 0);
  const fit = new Map(); // edge -> how well it leads into the next hop (kept as a tie-breaker below)
  // Backward: a call into the next file goes first when it calls one of the functions acting there.
  for (let i = hops.length - 1; i >= 0; i--) {
    const want = hops[i + 1] ? actors(hops[i + 1].edges, hops[i + 1].edges[0]?.from) : null;
    for (const e of hops[i].edges) fit.set(e, want && e.kind === 'calls' ? Math.max(want.get(e.function) || 0, want.get(e.local) || 0) : 0);
    hops[i].edges = [...hops[i].edges].sort((a, b) => (fit.get(b) - fit.get(a)) || byRank(a, b));
    // A call whose function does not lead into the next step: the files connect, the functions do not.
    const next = hops[i + 1]?.edges[0];
    if (next && hops[i].edges[0].kind === 'calls' && !fit.get(hops[i].edges[0]) && ['calls', 'reads', 'writes'].includes(next.kind)) hops[i].loose = true;
  }
  // Forward: the next hop then shows the edge made by the function that was called.
  for (let i = 1; i < hops.length; i++) {
    const prev = hops[i - 1].edges[0];
    if (prev.kind !== 'calls') continue;
    const fn = prev.function;
    const reach = local ? (x => x === fn || !!localChain(local, hops[i].edges[0]?.from, fn, x)) : (x => x === fn);
    const by = e => (e.kind === 'calls' ? reach(e.caller) : (e.sites || []).some(x => reach(x.function)));
    hops[i].edges = [...hops[i].edges].sort((a, b) => (by(b) - by(a)) || (fit.get(b) - fit.get(a)) || byRank(a, b));
    // How the called function gets to the one acting next, inside that file: "via a → b, same file".
    const e = hops[i].edges[0], actor = e.kind === 'calls' ? e.caller : (e.sites || []).map(x => x.function).find(reach);
    if (local && actor && actor !== fn) { const chain = localChain(local, e.from, fn, actor); if (chain) hops[i].via = chain.join(' → '); }
  }
  return hops;
}

// One edge as text; `fn` is the function the previous hop called, so a read/write shows the line in it.
function edgeText(e, fn, via = null) {
  let line = firstLine(e), what = '';
  if (e.kind === 'calls') what = `${e.function}()${e.via === 'value' ? ` via value from ${e.passedFrom}:${e.passedLine}` : ''}${e.sameFile ? ` in ${e.caller ?? 'top level'}, same file` : ''}`;
  else if (e.kind === 'navigate') what = screenWord(e.screen);
  else if (e.kind === 'calls-function') what = e.function;
  else if (e.kind === 'reads' || e.kind === 'writes') {
    const site = fn && (e.sites || []).find(x => x.function === fn);
    if (site) line = site.line;
    what = site ? `in ${fn}` : e.sites?.[0]?.function ? `in ${e.sites[0].function}` : '';
  } else if (e.kind === 'read-by') what = e.sites?.[0]?.function ? `in ${e.sites[0].function}` : '';
  if (via) what = `${what}${what ? ' ' : ''}(${via}, same file)`;
  if (e.tag === 'inferred') what = `${what}${what ? ' ' : ''}[inferred: ${e.why}]`;
  const file = e.kind === 'read-by' ? e.reader : e.from; // a read is written in the reading file
  return { kind: KIND_LABEL[e.kind] || e.kind, what, at: line ? `${file}:${line}` : file, inferred: e.tag === 'inferred' };
}

// Where a path goes from one code folder to another: a cloud function defined in the other folder, or data
// written (or read) on one side and read on the other. Text for the hop, or null.
function crossing(hops, i) {
  const e = hops[i].edges[0];
  if (e.crossFolder) return `crosses from ${e.codeFolder} to ${e.toFolder} through the cloud function ${e.function}`;
  if (e.kind !== 'read-by') return null;
  const before = hops[i - 1]?.edges[0];
  if (before && before.codeFolder && before.codeFolder !== e.codeFolder) return `crosses from ${before.codeFolder} to ${e.codeFolder} through shared data`;
  return null;
}

// { status: 'ambiguous' | 'notfound' | 'none' | 'found', ... }
export function findPath(map, aQuery, bQuery, { allShortest = false } = {}) {
  const A = resolveEndpoint(map, aQuery), B = resolveEndpoint(map, bQuery);
  for (const [q, m] of [[aQuery, A], [bQuery, B]]) {
    if (!m.length) return { status: 'notfound', query: q };
    if (m.length > 1) return { status: 'ambiguous', query: q, matches: m.map(x => `${nodeLabel(x.node)} (${x.how})`) };
  }
  const a = A[0], b = B[0], byId = new Map(map.nodes.map(n => [n.id, n]));
  const limit = allShortest ? 5 : 1;
  const base = { a: `${nodeLabel(a.node)}${a.how !== 'file' && a.node.kind === 'file' ? ` (${a.how})` : ''}`, b: `${nodeLabel(b.node)}${b.how !== 'file' && b.node.kind === 'file' ? ` (${b.how})` : ''}` };
  if (a.node.id === b.node.id) return { status: 'same', ...base };
  const local = localCalls(map);
  // Two screens: a path by navigation alone answers "how do you get there"; otherwise any kind of link.
  const screens = isScreenHow(a.how) && isScreenHow(b.how);
  // With several code folders, a last try lets data flow from a collection to its readers, so the path can cross
  // from the folder that writes the data to the folder that reads it.
  const tries = [...(screens ? [[new Set(['navigate']), 'navigation']] : []), [PATH_KINDS, null], ...(isMulti(map) ? [[PATH_KINDS, null, true]] : [])];
  for (const [kinds, only, dataFlow] of tries) {
    for (const [dir, from, to] of [['forward', a, b], ['reverse', b, a]]) {
      const adj = adjacency(map, false, kinds, !!dataFlow);
      const paths = shortest(adj, [from.node.id], new Set([to.node.id]), limit);
      if (!paths.length) continue;
      return {
        status: 'found', direction: dir, only, ...base, length: paths[0].length - 1, ...(dataFlow ? { dataFlow: true } : {}),
        // A path is only as sure as its least sure hop.
        paths: paths.map(p => {
          const hops = chooseEdges(p.slice(1).map((id, i) => ({ from: nodeLabel(byId.get(p[i])), to: nodeLabel(byId.get(id)), edges: adj.get(p[i]).get(id) })), local);
          return hops.map((h, i) => {
            const prev = hops[i - 1]?.edges[0];
            const fn = prev?.kind === 'calls' ? (h.via ? h.via.split(' → ').pop() : prev.function) : null;
            return { from: h.from, to: h.to, loose: !!h.loose, cross: crossing(hops, i), edges: h.edges.map((e, j) => edgeText(e, j === 0 ? fn : null, j === 0 ? h.via : null)) };
          });
        }),
      };
    }
  }
  return { status: 'none', ...base };
}

// ─── report ──────────────────────────────────────────────────────────────────
// Articulation points of the undirected import graph, with the sizes of the parts each one separates.
function bridges(map) {
  const files = map.nodes.filter(n => n.kind === 'file').map(n => n.id).sort();
  const nb = new Map(files.map(f => [f, new Set()]));
  for (const e of map.edges) if (IMPORT_KINDS.has(e.kind) && nb.has(e.from) && nb.has(e.to) && e.from !== e.to) { nb.get(e.from).add(e.to); nb.get(e.to).add(e.from); }
  const disc = new Map(), low = new Map(), size = new Map(), out = [];
  let t = 0;
  for (const root of files) {
    if (disc.has(root) || !nb.get(root).size) continue;
    // iterative DFS
    const compStart = t;
    const stack = [[root, null, [...nb.get(root)].sort(), 0]];
    disc.set(root, t); low.set(root, t); size.set(root, 1); t++;
    const parts = new Map(); // node -> sizes of child subtrees it separates
    let rootChildren = 0;
    while (stack.length) {
      const top = stack[stack.length - 1];
      const [u, parent, list] = top;
      if (top[3] < list.length) {
        const v = list[top[3]++];
        if (v === parent) continue;
        if (!disc.has(v)) {
          disc.set(v, t); low.set(v, t); size.set(v, 1); t++;
          if (u === root) rootChildren++;
          stack.push([v, u, [...nb.get(v)].sort(), 0]);
        } else low.set(u, Math.min(low.get(u), disc.get(v)));
      } else {
        stack.pop();
        if (parent !== null) {
          low.set(parent, Math.min(low.get(parent), low.get(u)));
          size.set(parent, size.get(parent) + size.get(u));
          if (low.get(u) >= disc.get(parent)) (parts.get(parent) || parts.set(parent, []).get(parent)).push(size.get(u));
        }
      }
    }
    const comp = t - compStart;
    for (const [v, ps] of parts) {
      if (v === root && rootChildren < 2) continue;
      const separated = ps.reduce((s, x) => s + x, 0);
      const all = v === root ? ps : [...ps, comp - 1 - separated].filter(x => x > 0);
      if (all.length < 2) continue;
      const sorted = [...all].sort((x, y) => y - x);
      out.push({ file: v, parts: sorted, cutOff: comp - 1 - sorted[0] });
    }
  }
  return out.sort((x, y) => y.cutOff - x.cutOff || x.file.localeCompare(y.file));
}

export function computeReport(map, top = 10) {
  const files = map.nodes.filter(n => n.kind === 'file');
  const fileById = new Map(files.map(f => [f.id, f]));
  const isSub = id => String(id).startsWith('subcollection:'); // counted in the top-level collection already
  const kindKey = k => (IMPORT_KINDS.has(k) ? 'imports' : k);
  const inc = new Map(), out = new Map();
  const bump = (m, id, k) => { const o = m.get(id) || m.set(id, { total: 0, byKind: {} }).get(id); o.total++; o.byKind[k] = (o.byKind[k] || 0) + 1; };
  for (const e of map.edges) {
    if (!PATH_KINDS.has(e.kind) || isSub(e.to) || e.from === e.to) continue;
    const k = kindKey(e.kind);
    if (fileById.has(e.from)) bump(out, e.from, k);
    if (fileById.has(e.to)) bump(inc, e.to, k);
  }
  const rankBy = m => [...m].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0])).slice(0, top).map(([file, v]) => ({ file, ...v }));

  const fnCallers = new Map();
  for (const e of map.edges) if (e.kind === 'calls') {
    const k = `${e.to}:${e.function}`;
    const o = fnCallers.get(k) || fnCallers.set(k, { file: e.to, fn: e.function, from: new Set(), calls: 0, same: 0 }).get(k);
    if (e.sameFile) o.same++; else { o.from.add(e.from); o.calls++; }
  }
  const functions = [...fnCallers.values()].filter(x => x.from.size).map(x => ({ file: x.file, fn: x.fn, files: x.from.size, calls: x.calls, same: x.same }))
    .sort((a, b) => b.files - a.files || b.calls - a.calls || a.fn.localeCompare(b.fn)).slice(0, top);

  const data = map.nodes.filter(n => n.kind === 'collection' || n.kind === 'subcollection')
    .map(n => ({ id: n.id, name: n.kind === 'subcollection' ? n.pattern : n.name, kind: n.kind, readers: n.readers, writers: n.writers, total: n.readers + n.writers }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, top);

  const bridgeList = bridges(map).slice(0, top);

  // Folder pairs joined by fewer than 3 file-to-file links in all.
  const pairEdges = new Map();
  for (const e of map.edges) {
    if (!PATH_KINDS.has(e.kind) || !fileById.has(e.from) || !fileById.has(e.to)) continue;
    const fa = folderOf(fileById.get(e.from)), fb = folderOf(fileById.get(e.to));
    if (fa === fb) continue;
    const key = [fa, fb].sort().join('\0');
    (pairEdges.get(key) || pairEdges.set(key, []).get(key)).push(e);
  }
  const surprising = [...pairEdges].filter(([, es]) => es.length < 3)
    .sort((a, b) => a[1].length - b[1].length || a[0].localeCompare(b[0]))
    .flatMap(([key, es]) => es.map(e => ({ folders: key.split('\0'), pairLinks: es.length, from: e.from, to: e.to, kind: KIND_LABEL[e.kind] || e.kind,
      what: e.function || e.screen || '', line: firstLine(e) })))
    .slice(0, top);

  const questions = [];
  if (bridgeList[0]) questions.push({ cmd: `brainmap impact ${bridgeList[0].file}`, why: 'the biggest bridge: what breaks if it changes' });
  if (functions[0]) questions.push({ cmd: `brainmap callers ${functions[0].fn}`, why: 'the most-called function' });
  if (data[0]) questions.push({ cmd: `brainmap collection ${data[0].name} --depth 2`, why: 'the busiest data and the functions in front of it' });
  const mostDep = rankBy(inc)[0];
  if (mostDep) questions.push({ cmd: `brainmap file ${mostDep.file}`, why: 'the most depended-on file' });
  if (surprising[0]) questions.push({ cmd: `brainmap path ${surprising[0].from} ${surprising[0].to}`, why: 'a rare link between two folders' });
  const mostDependent = rankBy(out)[0];
  if (questions.length < 5 && mostDependent) questions.push({ cmd: `brainmap file ${mostDependent.file}`, why: 'the file that depends on the most others' });

  const byTag = { extracted: 0, inferred: 0 }, byWhy = {};
  for (const e of map.edges) { byTag[e.tag === 'inferred' ? 'inferred' : 'extracted']++; if (e.why) byWhy[e.why] = (byWhy[e.why] || 0) + 1; }
  const noteTags = {}; for (const n of map.notes || []) noteTags[n.tag] = (noteTags[n.tag] || 0) + 1;
  return { dependedOn: rankBy(inc), dependent: rankBy(out), functions, data, bridges: bridgeList, surprising, questions: questions.slice(0, 5), confidence: { byTag, byWhy }, noteTags };
}

// ─── query: plain words → matching nodes and the links around them ──────────────────────────────────────
// Deterministic: no model. Words are split (camelCase, snake_case, paths) and lightly stemmed on both sides.
const STOP = new Set(('a an the of to in on at for from by with and or not no is are was were be been being do does did done '
  + 'how what where which who whom whose when why that this these those it its there here into onto over under after before '
  + 'about app apps code project file files thing things some any all each every can could should would will shall may might '
  + 'me my we our you your they them their i get gets got make makes made happen happens use uses used using way ways work works').split(/\s+/));
// Words that say what kind of thing is wanted rather than which one.
const KIND_WORDS = { screen: 'screen', screens: 'screen', page: 'screen', pages: 'screen', view: 'screen', views: 'screen',
  collection: 'data', collections: 'data', table: 'data', data: 'data', database: 'data', firestore: 'data',
  function: 'function', functions: 'function', method: 'function', helper: 'function' };

export function splitWords(s) {
  return String(s || '')
    .replace(/\.[a-z0-9]+$/i, '')                  // file extension
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')       // camelCase
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')    // APIClient → API Client
    .split(/[^A-Za-z0-9]+/).map(w => w.toLowerCase()).filter(Boolean);
}
export function stem(w) {
  w = w.toLowerCase();
  if (w.length > 4 && w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3).replace(/(.)\1$/, '$1');
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2).replace(/(.)\1$/, '$1').replace(/e$/, '');
  if (w.length > 4 && /(sh|ch|x|ss)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1).replace(/e$/, '');
  return w.replace(/e$/, '');
}

export function queryMap(map, question, { maxMatches = 5 } = {}) {
  const words = splitWords(question);
  const kinds = new Set(words.map(w => KIND_WORDS[w]).filter(Boolean));
  const terms = [...new Set(words.filter(w => !STOP.has(w) && !KIND_WORDS[w] && w.length > 1))];
  const dropped = [...new Set(words.filter(w => STOP.has(w) || KIND_WORDS[w]))];
  const tstems = terms.map(t => ({ t, s: stem(t) }));
  const files = map.nodes.filter(n => n.kind === 'file');
  const fileById = new Map(files.map(f => [f.id, f]));

  // Candidates: { key, kind, label, node (graph id), fn?, name tokens, path tokens, full name }
  const cands = [];
  for (const f of files) {
    const segs = f.path.split('/');
    cands.push({ key: `file:${f.id}`, kind: 'file', label: f.path, node: f.id, full: segs[segs.length - 1].replace(/\.[^.]+$/, ''),
      name: splitWords(segs[segs.length - 1]), path: segs.slice(0, -1).flatMap(splitWords), folder: segs[0] });
    for (const x of f.exports || []) if (x !== 'default' && !x.startsWith('* from'))
      cands.push({ key: `fn:${f.id}:${x}`, kind: 'function', label: `${x} (${f.path})`, node: f.id, fn: x, full: x, name: splitWords(x), path: segs.flatMap(splitWords), folder: segs[0] });
  }
  for (const s of map.navigation?.screens || []) if (s.file) {
    // A web route: named by its path and its page (/clients/:clientUid → clients, client, uid + ClientDetailPage).
    const page = s.route ? s.file.split('/').pop() : null;
    cands.push({ key: `screen:${s.name}:${s.file}`, kind: 'screen', label: `${s.route ? 'route' : 'screen'} ${s.name} (${s.file})`, node: s.file, screen: s.name, route: !!s.route,
      full: s.route ? page.replace(/\.[^.]+$/, '') : s.name, name: [...splitWords(s.name), ...(page ? splitWords(page) : [])], path: s.file.split('/').flatMap(splitWords), folder: s.file.split('/')[0] });
  }
  // Paths written in the question (/clients/123) point at their routes directly.
  const asked = (question.match(/(^|\s)\/[^\s,;"'`]*/g) || []).map(x => x.trim());
  // Notes: their words count as path words (1, not 3 like a name), at three quarters.
  for (const n of map.notes || []) cands.push({ key: `note:${n.file}:${n.line}`, kind: 'note', label: `${n.tag} note in ${n.file}${n.function ? ` (${n.function})` : ''}, line ${n.line}: ${n.text.slice(0, 90)}${n.text.length > 90 ? '…' : ''}`, node: n.file, fn: n.function, full: '', name: [], path: splitWords(n.text), half: true });
  for (const g of map.groups?.list || []) cands.push({ key: `group:${g.id}`, kind: 'group', label: `group ${g.id}. ${g.label} (${g.size} files)`, node: `group:${g.id}`, full: g.label, name: g.terms.slice(0, 3), path: g.terms.slice(3), group: g });
  for (const n of map.nodes) {
    if (n.kind === 'collection') cands.push({ key: n.id, kind: 'collection', label: `collection ${n.name}`, node: n.id, full: n.name, name: splitWords(n.name), path: [] });
    if (n.kind === 'subcollection') cands.push({ key: n.id, kind: 'subcollection', label: `subcollection ${n.pattern}`, node: n.id, full: n.name, name: splitWords(n.name), path: n.key.split('/').filter(p => p !== '{}').slice(0, -1).flatMap(splitWords) });
  }

  // Score: an exact (stemmed) word of the name 3, a prefix of one 1.5, a word of the path 1; the whole name
  // equal to a term +3; every matched term +1. Kind words ("screens", "collection") favour that kind.
  for (const c of cands) {
    const ns = c.name.map(stem), ps = c.path.map(stem);
    let score = 0; const hit = [];
    for (const { t, s } of tstems) {
      let best = 0;
      if (ns.includes(s)) best = 3;
      else if (s.length >= 4 && ns.some(n => n.length >= 4 && (n.startsWith(s) || s.startsWith(n)))) best = 1.5;
      else if (ps.includes(s)) best = 1;
      if (best) { score += best + 1; hit.push(t); }
    }
    if (score && tstems.some(({ s }) => stem(c.full) === s || c.full.toLowerCase() === s)) score += 3;
    if (score && kinds.size) {
      const k = c.kind === 'collection' || c.kind === 'subcollection' ? 'data' : c.kind === 'file' && c.folder === 'screens' ? 'screen' : c.kind;
      if (kinds.has(k)) score += 2;
    }
    if (c.route && asked.some(a => routeMatch(a, c.screen))) { score += 8; hit.push(asked.find(a => routeMatch(a, c.screen))); }
    c.score = c.half ? score * 0.75 : score; c.hit = hit; // note words: path weight (1, not 3) and three quarters of that
  }
  const MIN = 4; // at least one exact word of a name (3 + 1), or two weaker matches
  let ranked = cands.filter(c => c.score >= MIN).sort((a, b) => b.score - a.score || b.hit.length - a.hit.length || a.label.localeCompare(b.label));
  // Only clear matches: more than half the best score. A collection is dropped when one of its subcollections
  // matched better (users vs users/{uid}/stats for "user stats").
  if (ranked.length) ranked = ranked.filter(c => c.score > ranked[0].score / 2);
  ranked = ranked.filter(c => !(c.kind === 'collection' && ranked.some(d => d.kind === 'subcollection' && d.node.startsWith(`subcollection:${c.full}/`) && d.score > c.score)));
  // One entry per thing: a file whose screen or function already matched higher is not listed again.
  const matches = [], seenNode = new Map();
  for (const c of ranked) {
    if (matches.length >= maxMatches) break;
    const prev = seenNode.get(c.node);
    if (prev && (c.kind === 'file' || prev.some(p => p.kind === c.kind && p.fn === c.fn && p.screen === c.screen))) continue;
    matches.push(c); seenNode.set(c.node, [...(prev || []), c]);
  }
  if (!matches.length) {
    const best = [...tstems].sort((a, b) => b.t.length - a.t.length)[0]?.t ?? terms[0] ?? null;
    return { terms, dropped, matches: [], best };
  }

  const cidx = callIndex(map);
  // Subgraph: links touching each match (for a function: its calls and the reads/writes it makes; for a screen:
  // its navigation in and out and what its file calls), plus paths of up to 3 hops between two matches.
  const links = new Map();
  const add = (e, why) => { const k = `${e.kind}|${e.from}|${e.to}|${e.line ?? e.lines?.[0]}|${e.function ?? ''}`; if (!links.has(k)) links.set(k, { e, why }); };
  // fn: the matched function whose read/write line a data link should show
  for (const c of matches) {
    if (c.kind === 'note' || c.kind === 'group') continue; // listed as they are; their file's links would be noise
    for (const e of map.edges) {
      if (!PATH_KINDS.has(e.kind) || String(e.to).startsWith('subcollection:') && c.kind === 'collection') continue;
      if (c.kind === 'function') {
        if ((e.kind === 'calls' || e.kind === 'calls-function') && e.to === c.node && (e.function === c.fn || e.local === c.fn)) add(e, c);
        else if (e.from === c.node && e.kind === 'calls' && e.caller === c.fn && !e.sameFile) add(e, c); // not its local helpers
        else if (e.from === c.node && (e.kind === 'reads' || e.kind === 'writes') && (e.sites || []).some(x => x.function === c.fn)) {
          // The subcollection link says more than the same use counted on the top-level collection.
          const sub = map.edges.some(o => o.from === e.from && o.kind === e.kind && String(o.to).startsWith('subcollection:') && (o.sites || []).some(x => x.function === c.fn));
          if (!(sub && String(e.to).startsWith('collection:'))) add(e, c);
        }
      } else if (c.kind === 'screen') {
        if (e.kind === 'navigate' && (e.screen === c.screen || e.from === c.node)) add(e, c);
        else if (e.from === c.node && e.kind !== 'navigate' && !IMPORT_KINDS.has(e.kind) && !e.sameFile) add(e, c);
      } else if ((e.from === c.node || e.to === c.node) && !e.sameFile) add(e, c); // a file's internal calls are not listed
    }
    // Data: also who calls the functions doing the reads and writes (depth 1, as brainmap collection: calls
    // inside the same file are followed to the first caller in another file).
    if (c.kind === 'collection' || c.kind === 'subcollection') {
      const actors = new Set();
      for (const e of map.edges) if (e.to === c.node && (e.kind === 'reads' || e.kind === 'writes')) for (const x of e.sites || []) if (x.function) actors.add(`${e.from}\0${x.function}`);
      const walk = nodes => { for (const n of nodes) { add(n.e, c); walk(n.children); } };
      for (const a of actors) { const [f, fn] = a.split('\0'); walk(callerTree(map, f, fn, 1, cidx)); }
    }
  }
  const adj = adjacency(map), navAdj = adjacency(map, false, new Set(['navigate'])), byId = new Map(map.nodes.map(n => [n.id, n])), local = localCalls(map);
  const paths = [];
  const nodesOf = [...new Set(matches.map(m => m.node))];
  const isScreenNode = id => matches.some(m => m.node === id && m.kind === 'screen');
  for (let i = 0; i < nodesOf.length; i++) for (let j = 0; j < nodesOf.length; j++) {
    if (i === j) continue;
    // Between two screens, navigation alone first (how you get there), then any kind of link.
    const both = isScreenNode(nodesOf[i]) && isScreenNode(nodesOf[j]);
    const navP = both ? shortest(navAdj, [nodesOf[i]], new Set([nodesOf[j]]), 1)[0] : null;
    const useNav = navP && navP.length - 1 <= 3;
    if (both && !useNav) continue; // two screens joined only through the navigator's imports: not an answer
    const adjUsed = useNav ? navAdj : adj;
    const p = useNav ? navP : shortest(adj, [nodesOf[i]], new Set([nodesOf[j]]), 1)[0];
    if (p && p.length - 1 <= 3 && p.length > 2) { // direct links are already listed above
      const hops = chooseEdges(p.slice(1).map((id, k) => ({ from: nodeLabel(byId.get(p[k])), to: nodeLabel(byId.get(id)), edges: adjUsed.get(p[k]).get(id) })), local);
      paths.push(hops.map((h, k) => ({ from: h.from, to: h.to, edge: edgeText(h.edges[0], k && hops[k - 1].edges[0].kind === 'calls' ? (h.via ? h.via.split(' → ').pop() : hops[k - 1].edges[0].function) : null, h.via) })));
    }
  }
  const groups = new Map();
  const groupOf = k => (IMPORT_KINDS.has(k) ? 'imports' : { navigate: 'navigation', 'calls-function': 'cloud functions' }[k] || k);
  // Links between two matched things first: they are usually the answer.
  const matchedNodes = new Set(nodesOf);
  for (const { e, why } of links.values()) (groups.get(groupOf(e.kind)) || groups.set(groupOf(e.kind), []).get(groupOf(e.kind))).push({ ...edgeText(e, why.kind === 'function' && e.from === why.node ? why.fn : null), between: !e.sameFile && matchedNodes.has(e.from) && matchedNodes.has(e.to), from: nodeLabel(byId.get(e.from) || { kind: 'file', path: e.from }), to: nodeLabel(byId.get(e.to) || { kind: 'file', path: e.to }) });
  const order = ['navigation', 'calls', 'cloud functions', 'writes', 'reads', 'imports'];

  const next = [];
  const dup = new Set(matches.filter(c => c.kind === 'function').map(c => c.fn).filter((f, i, a) => a.indexOf(f) !== i));
  const fnRef = c => (dup.has(c.fn) ? `${c.node}:${c.fn}` : c.fn);
  const depth = kinds.has('screen') ? ' --depth 2' : '';
  const cmdFor = c => (c.kind === 'note' ? `brainmap notes ${c.node}` : c.kind === 'group' ? `brainmap group ${c.group.id}` : c.kind === 'screen' ? `brainmap screen ${c.screen}` : c.kind === 'function' ? `brainmap callers ${fnRef(c)}`
    : c.kind === 'collection' || c.kind === 'subcollection' ? `brainmap collection ${c.kind === 'subcollection' ? c.node.slice(14) : c.full}${depth}` : `brainmap file ${c.node}`);
  for (const c of matches) { const cmd = cmdFor(c); if (!next.includes(cmd)) next.push(cmd); if (next.length >= 2) break; }
  // A path between the first two matches that are different files or collections.
  const ref = c => (c.kind === 'note' ? c.node : c.kind === 'group' ? c.group.central[0] : c.kind === 'function' ? `${c.node}:${c.fn}` : c.kind === 'screen' ? c.screen : c.kind === 'file' ? c.node : c.kind === 'subcollection' ? c.node.slice(14) : c.full);
  const other = matches.find(c => c.node !== matches[0].node);
  if (other) next.push(`brainmap path ${ref(matches[0])} ${ref(other)}`);
  else if (fileById.has(matches[0].node)) next.push(`brainmap impact ${matches[0].node}`);

  return {
    terms, dropped,
    matches: matches.map(c => ({ label: c.label, kind: c.kind, score: c.score, hit: c.hit, ...(c.kind === 'group' ? { central: c.group.central } : {}) })),
    groups: order.filter(k => groups.has(k)).map(k => ({ kind: k, edges: groups.get(k).sort((a, b) => (b.between - a.between) || a.at.localeCompare(b.at, undefined, { numeric: true })) })),
    paths, next: next.slice(0, 3),
  };
}
