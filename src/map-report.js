// Path between two things, and a project report, computed from a map (schemaVersion 6). Pure functions with no
// Node or browser dependencies: used by the brainmap command (and its tools) and by the diagram. Deterministic.

const IMPORT_KINDS = new Set(['import', 'require', 're-export', 'dynamic']);
const KIND_LABEL = { import: 'imports', require: 'requires', 're-export': 're-exports', dynamic: 'imports (dynamic)',
  calls: 'calls', navigate: 'navigates to', 'calls-function': 'calls cloud function', reads: 'reads', writes: 'writes' };
const PATH_KINDS = new Set([...IMPORT_KINDS, 'calls', 'navigate', 'calls-function', 'reads', 'writes']);

export const folderOf = f => (f.rootGroup !== 'app' ? f.rootGroup : f.topFolder === '(root)' ? '(root)' : f.topFolder);
const firstLine = e => e.line ?? e.lines?.[0] ?? null;
const nodeLabel = n => (n.kind === 'file' ? n.path : n.kind === 'subcollection' ? n.pattern : n.name);

// ─── endpoints ───────────────────────────────────────────────────────────────
// Every node a query can mean: a file (path, suffix or name), an exported function (name or file:name),
// a screen, a collection, or a subcollection (name or path pattern). Functions and screens resolve to the file
// that defines them, with a note.
export function resolveEndpoint(map, q) {
  const files = map.nodes.filter(n => n.kind === 'file');
  const low = String(q || '').trim().replace(/^\.\//, '').toLowerCase();
  const hits = new Map(); // node id -> { node, how }
  // One entry per node; a file that is also a screen counts as the screen (so two screens can be matched by navigation).
  const add = (node, how) => { if (!node) return; const h = hits.get(node.id); if (!h || (h.how === 'file' && how.startsWith('screen'))) hits.set(node.id, { node, how }); };
  if (!low) return [];
  const byPath = new Map(files.map(f => [f.path.toLowerCase(), f]));
  // file:name → that file's exported function
  const colon = low.lastIndexOf(':');
  if (colon > 0) {
    const fq = low.slice(0, colon), fn = q.trim().slice(colon + 1);
    const f = byPath.get(fq) || files.find(x => x.path.toLowerCase().endsWith(`/${fq}`) || x.path.split('/').pop().toLowerCase() === fq);
    if (f && (f.exports || []).includes(fn)) add(f, `function ${fn}`);
    return [...hits.values()];
  }
  if (byPath.has(low)) return [{ node: byPath.get(low), how: 'file' }];
  for (const f of files) {
    const name = f.path.split('/').pop().toLowerCase();
    if (f.path.toLowerCase().endsWith(`/${low}`) || name === low || name.replace(/\.[^.]+$/, '') === low) add(f, 'file');
  }
  for (const s of map.navigation?.screens || []) {
    if (s.file && (s.name.toLowerCase() === low || s.component?.toLowerCase() === low)) add(files.find(f => f.path === s.file), `screen ${s.name}`);
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
function adjacency(map, reverse = false, kinds = PATH_KINDS) {
  const adj = new Map();
  for (const e of map.edges) {
    if (!kinds.has(e.kind)) continue;
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
function chooseEdges(hops) {
  // Functions in a file that act in the hop leaving it: callers of its calls, functions doing its reads/writes.
  const actors = es => new Set(es.flatMap(e => (e.kind === 'calls' ? [e.caller] : e.kind === 'reads' || e.kind === 'writes' ? (e.sites || []).map(x => x.function) : [])).filter(Boolean));
  const byRank = (a, b) => RANK(a.kind) - RANK(b.kind) || (firstLine(a) ?? 0) - (firstLine(b) ?? 0);
  // Backward: a call into the next file goes first when it calls one of the functions acting there.
  for (let i = hops.length - 1; i >= 0; i--) {
    const want = hops[i + 1] ? actors(hops[i + 1].edges) : null;
    const fits = e => !!want && e.kind === 'calls' && (want.has(e.function) || want.has(e.local));
    hops[i].edges = [...hops[i].edges].sort((a, b) => (fits(b) - fits(a)) || byRank(a, b));
  }
  // Forward: the next hop then shows the edge made by the function that was called.
  for (let i = 1; i < hops.length; i++) {
    const prev = hops[i - 1].edges[0];
    if (prev.kind !== 'calls') continue;
    const fn = prev.function;
    const by = e => (e.kind === 'calls' ? e.caller === fn : (e.sites || []).some(x => x.function === fn));
    hops[i].edges = [...hops[i].edges].sort((a, b) => (by(b) - by(a)) || byRank(a, b));
  }
  return hops;
}

// One edge as text; `fn` is the function the previous hop called, so a read/write shows the line in it.
function edgeText(e, fn) {
  let line = firstLine(e), what = '';
  if (e.kind === 'calls') what = `${e.function}()${e.via === 'value' ? ` via value from ${e.passedFrom}:${e.passedLine}` : ''}`;
  else if (e.kind === 'navigate') what = `screen ${e.screen}`;
  else if (e.kind === 'calls-function') what = e.function;
  else if (e.kind === 'reads' || e.kind === 'writes') {
    const site = fn && (e.sites || []).find(x => x.function === fn);
    if (site) line = site.line;
    what = site ? `in ${fn}` : e.sites?.[0]?.function ? `in ${e.sites[0].function}` : '';
  }
  return { kind: KIND_LABEL[e.kind] || e.kind, what, at: line ? `${e.from}:${line}` : e.from };
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
  // Two screens: a path by navigation alone answers "how do you get there"; otherwise any kind of link.
  const screens = a.how.startsWith('screen') && b.how.startsWith('screen');
  const tries = [...(screens ? [[new Set(['navigate']), 'navigation']] : []), [PATH_KINDS, null]];
  for (const [kinds, only] of tries) {
    for (const [dir, from, to] of [['forward', a, b], ['reverse', b, a]]) {
      const adj = adjacency(map, false, kinds);
      const paths = shortest(adj, [from.node.id], new Set([to.node.id]), limit);
      if (!paths.length) continue;
      return {
        status: 'found', direction: dir, only, ...base, length: paths[0].length - 1,
        paths: paths.map(p => {
          const hops = chooseEdges(p.slice(1).map((id, i) => ({ from: nodeLabel(byId.get(p[i])), to: nodeLabel(byId.get(id)), edges: adj.get(p[i]).get(id) })));
          return hops.map((h, i) => {
            const prev = hops[i - 1]?.edges[0];
            const fn = prev?.kind === 'calls' ? prev.function : null;
            return { from: h.from, to: h.to, edges: h.edges.map((e, j) => edgeText(e, j === 0 ? fn : null)) };
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
  for (const e of map.edges) if (e.kind === 'calls') { const k = `${e.to}:${e.function}`; (fnCallers.get(k) || fnCallers.set(k, { file: e.to, fn: e.function, from: new Set(), calls: 0 }).get(k)); fnCallers.get(k).from.add(e.from); fnCallers.get(k).calls++; }
  const functions = [...fnCallers.values()].map(x => ({ file: x.file, fn: x.fn, files: x.from.size, calls: x.calls }))
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

  return { dependedOn: rankBy(inc), dependent: rankBy(out), functions, data, bridges: bridgeList, surprising, questions: questions.slice(0, 5) };
}
