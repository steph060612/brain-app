// Subsystems: groups of related files found by community detection on the file graph (Louvain with a Leiden-style
// refinement that splits every group into its connected parts), with names made from the group's own words.
// Deterministic: a seeded order, no randomness beyond it, no model. Pure: used by the mapper.

export const SEED = 20261114;
// Edge weights per file pair, and why:
//   import 1      a static dependency is the basic sign two files belong together
//   calls  +1     calling into a file (on top of importing it) is a stronger tie; a little more for many
//                 call sites (0.25 × log2(1 + sites)); functions passed as values count as calls
//   navigation 1.5  screens that lead to each other form the app's areas most clearly
//   data   2/(k−1) files reading or writing the same collection (k files) are linked through it; dividing by
//                 k keeps a collection everyone uses (users) from gluing the whole app together
//   same file 0.1 × log2(1 + calls)  a little self-weight for files with many internal calls
//   hubs   × min(1, 8 / importers)   links into files used almost everywhere (theme, auth) say little about
//                 which area a file belongs to, so they count less
export const WEIGHTS = { import: 1, calls: 1, callSites: 0.25, navigate: 1.5, data: 2, sameFile: 0.1, hubImporters: 8 };

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function shuffled(list, rand) { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }

const IMPORT_KINDS = new Set(['import', 'require', 're-export', 'dynamic']);

// Weighted undirected file graph: Map(a -> Map(b -> w)), plus self weights.
export function fileGraph(files, edges) {
  const ids = files.map(f => f.id).sort();
  const importers = new Map(files.map(f => [f.id, f.importedBy || 0]));
  const hub = id => Math.min(1, WEIGHTS.hubImporters / Math.max(1, importers.get(id) || 0));
  const pair = new Map(); // "a\0b" (sorted) -> { imp, calls, nav, data }
  const P = (a, b) => { const k = a < b ? `${a}\0${b}` : `${b}\0${a}`; return pair.get(k) || pair.set(k, { a: a < b ? a : b, b: a < b ? b : a, imp: 0, calls: 0, nav: 0, data: 0, hub: 1 }).get(k); };
  const self = new Map();
  const isFile = new Set(ids);
  const dataTouch = new Map(); // target -> Set(files)
  const subByFile = new Set(); // file\0collection when the file has a subcollection edge under that collection
  for (const e of edges) if (e.to?.startsWith?.('subcollection:') && (e.kind === 'reads' || e.kind === 'writes')) subByFile.add(`${e.from}\0${e.to.slice(14).split('/')[0]}`);
  for (const e of edges) {
    if (!isFile.has(e.from)) continue;
    if (e.kind === 'calls' && e.sameFile) { self.set(e.from, (self.get(e.from) || 0) + 1); continue; }
    if ((e.kind === 'reads' || e.kind === 'writes')) {
      // The most specific target: a subcollection, or the collection when the file uses no subcollection of it.
      if (e.to.startsWith('collection:') && subByFile.has(`${e.from}\0${e.to.slice(11)}`)) continue;
      (dataTouch.get(e.to) || dataTouch.set(e.to, new Set()).get(e.to)).add(e.from);
      continue;
    }
    if (!isFile.has(e.to) || e.from === e.to) continue;
    const p = P(e.from, e.to);
    if (IMPORT_KINDS.has(e.kind)) { p.imp = 1; p.hub = Math.min(p.hub, hub(e.to)); }
    else if (e.kind === 'calls') { p.calls++; p.hub = Math.min(p.hub, hub(e.to)); }
    else if (e.kind === 'navigate') p.nav = 1;
    else if (e.kind === 'calls-function') p.calls++;
  }
  for (const set of dataTouch.values()) {
    const fs = [...set].sort();
    if (fs.length < 2) continue;
    const w = WEIGHTS.data / (fs.length - 1);
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) P(fs[i], fs[j]).data += w;
  }
  const adj = new Map(ids.map(id => [id, new Map()]));
  for (const p of pair.values()) {
    const w = (p.imp * WEIGHTS.import + (p.calls ? WEIGHTS.calls + WEIGHTS.callSites * Math.log2(1 + p.calls) : 0)) * p.hub + p.nav * WEIGHTS.navigate + p.data;
    if (w <= 0) continue;
    adj.get(p.a).set(p.b, (adj.get(p.a).get(p.b) || 0) + w);
    adj.get(p.b).set(p.a, (adj.get(p.b).get(p.a) || 0) + w);
  }
  const selfW = new Map([...self].map(([f, n]) => [f, WEIGHTS.sameFile * Math.log2(1 + n)]));
  return { ids, adj, selfW };
}

// One level of Louvain moves on a weighted graph (nodes 0..n-1), seeded order. Returns community per node.
function moveNodes(n, nb, selfW, rand) {
  const k = new Float64Array(n); let m2 = 0;
  for (let i = 0; i < n; i++) { let s = 2 * (selfW[i] || 0); for (const [, w] of nb[i]) s += w; k[i] = s; m2 += s; }
  const comm = Int32Array.from({ length: n }, (_, i) => i);
  const tot = Float64Array.from(k);
  if (m2 === 0) return comm;
  let moved = true, rounds = 0;
  while (moved && rounds++ < 50) {
    moved = false;
    for (const i of shuffled([...Array(n).keys()], rand)) {
      const ci = comm[i];
      const toComm = new Map();
      for (const [j, w] of nb[i]) if (j !== i) toComm.set(comm[j], (toComm.get(comm[j]) || 0) + w);
      tot[ci] -= k[i];
      let best = ci, bestGain = (toComm.get(ci) || 0) - tot[ci] * k[i] / m2;
      for (const [c, w] of [...toComm].sort((a, b) => a[0] - b[0])) {
        const gain = w - tot[c] * k[i] / m2;
        if (gain > bestGain + 1e-12) { best = c; bestGain = gain; }
      }
      tot[best] += k[i];
      if (best !== ci) { comm[i] = best; moved = true; }
    }
  }
  return comm;
}

// Leiden-style refinement: a community whose nodes are not connected inside it is split into its connected parts.
function refine(n, nb, comm) {
  const out = new Int32Array(n).fill(-1); let next = 0;
  for (let s = 0; s < n; s++) {
    if (out[s] !== -1) continue;
    out[s] = next; const st = [s];
    while (st.length) { const u = st.pop(); for (const [v] of nb[u]) if (out[v] === -1 && comm[v] === comm[s]) { out[v] = next; st.push(v); } }
    next++;
  }
  return out;
}

export function detectGroups(files, edges) {
  const { ids, adj, selfW } = fileGraph(files, edges);
  const index = new Map(ids.map((id, i) => [id, i]));
  const isolated = ids.filter(id => adj.get(id).size === 0);
  const active = ids.filter(id => adj.get(id).size > 0);
  const rand = rng(SEED);
  // Level graph: members of each node, neighbours, self weights.
  let members = active.map(id => [id]);
  let nb = active.map(id => new Map([...adj.get(id)].map(([j, w]) => [active.indexOf(j), w])));
  let sw = active.map(id => selfW.get(id) || 0);
  for (let level = 0; level < 20; level++) {
    const n = members.length;
    if (!n) break; // a root whose files link to nothing: every file is isolated
    const comm = refine(n, nb, moveNodes(n, nb, sw, rand));
    const count = Math.max(...comm) + 1;
    if (count === n) break;
    const nm = Array.from({ length: count }, () => []), nnb = Array.from({ length: count }, () => new Map()), nsw = new Array(count).fill(0);
    for (let i = 0; i < n; i++) {
      const c = comm[i]; nm[c].push(...members[i]); nsw[c] += sw[i];
      for (const [j, w] of nb[i]) { const d = comm[j]; if (d === c) nsw[c] += w / 2; else nnb[c].set(d, (nnb[c].get(d) || 0) + w); }
    }
    members = nm; nb = nnb; sw = nsw;
  }
  void index;
  return { groups: members.map(m => m.sort()), isolated, adj };
}

// ─── names ───────────────────────────────────────────────────────────────────
const GENERIC = new Set(('get set use is has on to of in for with from by and or the a an at as do new add remove update delete save load '
  + 'fetch make create build handle render init reset clear list item items all any one two data info meta id ids js jsx ts tsx index '
  + 'screen screens component components util utils helper helpers service services hook hooks lib api config constants const type '
  + 'types default value values state context provider modal card tab view page section content button main app test spec mock '
  + 'with without format to from current latest my me user users count total').split(/\s+/));
const split = s => String(s || '').replace(/\.[a-z0-9]+$/i, '').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  .split(/[^A-Za-z]+/).map(w => w.toLowerCase()).filter(w => w.length > 2 && !GENERIC.has(w));
const norm = w => (w.length > 4 && w.endsWith('ies') ? `${w.slice(0, -3)}y` : w.length > 3 && w.endsWith('s') && !/(ss|is|us)$/.test(w) ? w.slice(0, -1) : w);

// Words of a group: file names, exported functions, screens defined in its files, collections they use.
function groupWords(fileIds, fileById, screensByFile, dataByFile) {
  const tf = new Map();
  const add = (w, n = 1) => tf.set(w, (tf.get(w) || 0) + n);
  for (const id of fileIds) {
    const f = fileById.get(id);
    const seen = new Set();
    // File and screen names say most about what a file is for; exported names and collections count less.
    const words = [...split(id.split('/').pop()).map(w => [w, 2]), ...(screensByFile.get(id) || []).flatMap(s => split(s).map(w => [w, 2])),
      ...(f.exports || []).flatMap(x => split(x).map(w => [w, 0.5])), ...(dataByFile.get(id) || []).flatMap(c => split(c).map(w => [w, 0.5]))];
    for (const [w, n] of words) { const k = norm(w); if (!seen.has(k)) add(k, n); seen.add(k); } // a word counts once per file
  }
  return tf;
}

export function nameGroups(groups, files, edges, screens) {
  const fileById = new Map(files.map(f => [f.id, f]));
  const screensByFile = new Map(); for (const s of screens || []) if (s.file) (screensByFile.get(s.file) || screensByFile.set(s.file, []).get(s.file)).push(s.name);
  const dataByFile = new Map(); for (const e of edges) if ((e.kind === 'reads' || e.kind === 'writes') && e.to.startsWith('collection:')) (dataByFile.get(e.from) || dataByFile.set(e.from, new Set()).get(e.from)).add(e.to.slice(11));
  for (const [k, v] of dataByFile) dataByFile.set(k, [...v]);
  const tfs = groups.map(g => groupWords(g, fileById, screensByFile, dataByFile));
  const df = new Map(); for (const tf of tfs) for (const w of tf.keys()) df.set(w, (df.get(w) || 0) + 1);
  const N = groups.length;
  const used = new Set();
  return tfs.map((tf, i) => {
    // Frequent in this group, rare in the others (tf × idf); ties by word.
    // Words used by at least two files of the group first (a single file's word is not the group's theme).
    const ranked = [...tf].map(([w, n]) => [w, n * Math.log(1 + N / df.get(w)), n >= 4 ? 1 : 0])
      .sort((a, b) => b[2] - a[2] || b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w);
    let terms = ranked.slice(0, 3);
    let label = terms.join(' / ') || `group ${i + 1}`;
    for (let extra = 3; used.has(label) && extra < ranked.length; extra++) { terms = [...ranked.slice(0, 2), ranked[extra]]; label = terms.join(' / '); }
    used.add(label);
    return { label, terms: ranked.slice(0, 6) };
  });
}
