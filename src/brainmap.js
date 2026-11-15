#!/usr/bin/env node
// brainmap: read-only answers about a mapped code project, for coding assistants. Reads
// ~/.brain/maps/<slug>/map.json (schemaVersion 6); refreshes it first when the code changed (the same check
// as the Brain app's "Map is current"). Prints paths, names and numbers only, never file contents.
// No network, no model calls.
import { stat } from 'fs/promises';
import { findPath, computeReport } from './map-report.js';
import {
  loadLinks, readMap, mapStatus, runMapper, gitAvailable, realOrSelf, inside, tilde,
} from './codemap-status.js';

const LIST = 10;          // default items per section; --all shows everything
const WIDTH = 110;
const IMPORT_KINDS = new Set(['import', 'require', 're-export', 'dynamic']);
const HELP = `brainmap: read-only map of a JavaScript project linked in the Brain app.

Usage: brainmap <command> [argument] [--all] [--depth 2] [--project <name>] [--no-refresh]
  overview              project summary: entry files, folders, most imported files, screens, collections, functions
  files <folder>        files in a folder, with line counts and exported names
  file <path>           exports, imports, importers, navigation, collections and functions of one file
  impact <path>         files that depend on it through imports, up to 3 steps away, grouped by depth
  screen <name>         a navigation screen: its file, where it navigates to and where it is reached from
  callers <name>        files and lines that call an exported function (or file:name)
  path <A> <B>          shortest path between two files, functions, screens or collections (--all-shortest: up to 5)
  report                most-connected files, most-called functions, busiest data, bridges, rare links, next questions
  collection <name>     files that read and write a collection or subcollection (name or path, e.g. users/{uid}/workoutLogs)
  function <name>       a cloud function: where it is defined and who calls it
  find <text>           matches in file paths, exported names, screens and collections
  unused                files not imported from the entry file, screens with no incoming navigation found

The project is the linked folder that contains the current folder, or --project <name>.
Each list shows its first items with "(+N more, use --all)"; --all shows everything. Paths are relative to the project folder.`;

// ─── output ──────────────────────────────────────────────────────────────────
const lines = [];
let ALL = false, DEPTH = 1, ALL_SHORTEST = false;
const say = (s = '') => { for (const l of String(s).split('\n')) lines.push(l); };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A comma-separated list wrapped to WIDTH, continuation lines indented.
function wrapList(head, items, limit = 30, indent = '  ') {
  if (!items.length) return say(`${head}none`);
  if (!ALL && items.length > limit) items = [...items.slice(0, limit), `(+${items.length - limit} more, use --all)`];
  let cur = head;
  const out = [];
  items.forEach((it, i) => {
    const piece = it + (i < items.length - 1 ? ', ' : '');
    if (cur.length + piece.length > WIDTH && cur.trim()) { out.push(cur.trimEnd()); cur = indent; }
    cur += piece;
  });
  out.push(cur.trimEnd());
  say(out.join('\n'));
}
// One section's items, one per line, cut at `limit` with a "(+N more, use --all)" line.
function items(list, limit = LIST) {
  const shown = ALL ? list : list.slice(0, limit);
  for (const x of shown) say(`  ${x}`);
  if (shown.length < list.length) say(`  (+${list.length - shown.length} more, use --all)`);
}
function flush() { process.stdout.write(lines.join('\n') + '\n'); }
// Ends with a message, keeping any note already printed (such as "Map refreshed").
function die(msg, code = 1) { process.stdout.write([...lines, msg].join('\n') + '\n'); process.exit(code); }

// ─── arguments ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { all: false, refresh: true, project: null, depth: 1, allShortest: false, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all' || a === '-a') o.all = true;
    else if (a === '--no-refresh') o.refresh = false;
    else if (a === '--project' || a === '-p') o.project = argv[++i] ?? '';
    else if (a.startsWith('--project=')) o.project = a.slice(10);
    else if (a === '--all-shortest') o.allShortest = true;
    else if (a === '--depth') o.depth = Number(argv[++i]);
    else if (a.startsWith('--depth=')) o.depth = Number(a.slice(8));
    else if (a === '--help' || a === '-h') o.pos.unshift('help');
    else o.pos.push(a);
  }
  return o;
}

// ─── project, map, refresh ───────────────────────────────────────────────────
async function findProject(name) {
  const links = await loadLinks();
  if (name) {
    const key = Object.keys(links).find(k => k.toLowerCase() === name.toLowerCase()) ?? name.toLowerCase();
    return { slug: key, folder: links[key] ?? null };
  }
  const cwd = await realOrSelf(process.cwd());
  let best = null;
  for (const [slug, folder] of Object.entries(links)) {
    const real = await realOrSelf(folder);
    if (inside(cwd, real) && (!best || real.length > best.folder.length)) best = { slug, folder: real };
  }
  return best;
}

async function loadProject(opts) {
  const p = await findProject(opts.project);
  if (!p) {
    die(`This folder (${tilde(process.cwd())}) is not linked to a Brain project.
To create a map: in the Brain app, open the project, click "Link code folder", choose this folder, then click "Map project".
Or name a project: brainmap overview --project <name>`);
  }
  let folderOk = false;
  if (p.folder) { try { folderOk = (await stat(p.folder)).isDirectory(); } catch { } }
  let m;
  try { m = await readMap(p.slug); } catch (e) {
    // A map in an older format is replaced right away when the folder is available.
    if (!e.outdated || !folderOk) die(`${e.message}\nIn the Brain app, open the project and click "Re-map".`);
    const t0 = Date.now();
    try { await runMapper(p.folder, p.slug, await gitAvailable()); m = await readMap(p.slug); }
    catch (e2) { die(`The map is in an older format and could not be re-made (${e2.message}).\nIn the Brain app, open the project and click "Re-map".`); }
    say(`Map refreshed: it was in an older format (${((Date.now() - t0) / 1000).toFixed(1)} s).`);
    opts = { ...opts, refresh: false }; // just made from the current code
  }
  if (!m) {
    die(p.folder
      ? `Project "${p.slug}" is linked to ${tilde(p.folder)} but has not been mapped yet.\nTo create the map: in the Brain app, open the project and click "Map project".`
      : `No project "${p.slug}" is linked or mapped.\nTo create one: in the Brain app, open the project, click "Link code folder", then "Map project".`);
  }
  if (!p.folder) say(`Note: "${p.slug}" is not linked to a code folder any more; this map may be out of date.`);
  else if (!folderOk) say(`Note: the linked folder ${tilde(p.folder)} was not found; this map may be out of date.`);
  else if (opts.refresh) {
    const useGit = await gitAvailable();
    let st = null;
    try { st = await mapStatus(p.folder, m.map, useGit); } catch (e) { say(`Note: could not check for changes (${e.message}).`); }
    if (st && st.state !== 'current') {
      const why = st.state === 'other-folder' ? `the map was made from ${st.mappedFolder}`
        : st.changedFiles ? `${plural(st.changedFiles, 'source file')} changed since the last map` : 'the code changed since the last map';
      const t0 = Date.now();
      try {
        await runMapper(p.folder, p.slug, useGit);
        m = await readMap(p.slug);
        say(`Map refreshed: ${why} (${((Date.now() - t0) / 1000).toFixed(1)} s).`);
      } catch (e) {
        say(`Note: ${why}, but the map could not be refreshed (${e.message}). Answers use the map from ${when(m.map.generatedAt)}.`);
      }
    }
  }
  return { slug: p.slug, folder: p.folder, map: m.map };
}

const when = iso => {
  const d = new Date(iso);
  if (Number.isNaN(+d)) return 'an unknown time';
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

// ─── indexes over the map ────────────────────────────────────────────────────
function index(map) {
  const files = map.nodes.filter(n => n.kind === 'file');
  const byPath = new Map(files.map(f => [f.path, f]));
  const out = new Map(), inn = new Map();
  for (const e of map.edges) {
    (out.get(e.from) || out.set(e.from, []).get(e.from)).push(e);
    (inn.get(e.to) || inn.set(e.to, []).get(e.to)).push(e);
  }
  const screens = map.navigation?.screens || [];
  const collections = map.nodes.filter(n => n.kind === 'collection');
  const subs = map.nodes.filter(n => n.kind === 'subcollection');
  const unresolvedCalls = (map.unresolved || []).filter(u => u.kind === 'call');
  return { files, byPath, out, inn, screens, collections, subs, unresolvedCalls };
}

const folderOf = f => (f.rootGroup !== 'app' ? f.rootGroup : f.topFolder === '(root)' ? '(root)' : f.topFolder);

// A path from the user: exact, then path suffix, then file name, then name without extension.
function resolveFile(ix, q) {
  q = String(q || '').replace(/^\.\//, '');
  if (!q) die('Give a file path, for example: brainmap file src/App.js');
  if (ix.byPath.has(q)) return ix.byPath.get(q);
  const low = q.toLowerCase();
  const tries = [
    f => f.path.toLowerCase().endsWith('/' + low),
    f => f.path.split('/').pop().toLowerCase() === low,
    f => f.path.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase() === low,
  ];
  for (const t of tries) {
    const hits = ix.files.filter(t);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) die(`"${q}" matches ${hits.length} files; use the full path:\n${hits.slice(0, 20).map(f => `  ${f.path}`).join('\n')}`);
  }
  const near = ix.files.filter(f => f.path.toLowerCase().includes(low)).slice(0, 10);
  die(`No mapped file "${q}".${near.length ? `\nSimilar:\n${near.map(f => `  ${f.path}`).join('\n')}` : ''}\nOnly JavaScript files are mapped.`);
}

const linesOf = list => {
  const ls = [...new Set(list.flatMap(e => e.lines || (e.line ? [e.line] : [])))].sort((a, b) => a - b);
  return ls.length ? ` (line${ls.length === 1 ? '' : 's'} ${ls.slice(0, 6).join(', ')}${ls.length > 6 ? ', …' : ''})` : '';
};
const groupBy = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); (m.get(k) || m.set(k, []).get(k)).push(x); } return m; };

// ─── commands ────────────────────────────────────────────────────────────────
function overview(P, ix) {
  const { map } = P;
  const c = map.counts || {};
  say(`${P.slug}  ${tilde(map.project?.path || P.folder || '')}  mapped ${when(map.generatedAt)}${map.project?.gitCommit ? ` (commit ${map.project.gitCommit.slice(0, 7)})` : ''}`);
  const fnNames = map.functions?.exported || [];
  say(`${plural(ix.files.length, 'file')}, ${plural(c.edges ?? map.edges.length, 'link')}, ${plural(ix.screens.length, 'screen')}, ${plural(ix.collections.length, 'collection')}, ${plural(fnNames.length, 'cloud function')}`);
  const groups = map.rootGroups || [];
  wrapList('Entry files: ', groups.map(g => (g.entry ? `${g.entry} (${g.name})` : `${g.dir || g.name}/ has no entry file (${plural(g.fileCount, 'file')})`)));
  const fc = new Map();
  for (const f of ix.files) fc.set(folderOf(f), (fc.get(folderOf(f)) || 0) + 1);
  wrapList('Folders: ', [...fc].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k === '(root)' ? '(root files)' : `${k}/`} ${n}`), Infinity);
  say('Most imported:');
  for (const f of [...ix.files].sort((a, b) => (b.importedBy || 0) - (a.importedBy || 0) || a.path.localeCompare(b.path)).slice(0, 10)) {
    say(`  ${String(f.importedBy || 0).padStart(3)}  ${f.path}`);
  }
  wrapList(`Screens (${ix.screens.length}): `, [...new Set(ix.screens.map(s => s.name))], Infinity);
  wrapList(`Collections (${ix.collections.length}, all folders): `, [...ix.collections].sort((a, b) => (b.readers + b.writers) - (a.readers + a.writers))
    .map(n => `${n.name} (${n.readers}r/${n.writers}w)`), Infinity);
  if (ix.subs.length) wrapList(`Subcollections (${ix.subs.length}): `, ix.subs.map(n => n.pattern), 12);
  const called = map.functions?.names || {};
  wrapList(`Cloud functions (${fnNames.length}${Object.keys(called).length ? `, ${Object.keys(called).length} called from code` : ''}): `,
    fnNames.map(n => (called[n]?.callers?.length ? `${n} ←${called[n].callers.length}` : n)), Infinity);
  const app = groups.find(g => g.entry && g.name === 'app');
  const standalone = groups.filter(g => !g.entry).reduce((s, g) => s + (g.fileCount || 0), 0);
  const noNav = ix.screens.filter(s => !s.incomingNavigation && !s.incomingAsNestedParent).length;
  say(`Not imported from ${app?.entry ?? 'the entry file'}: ${app?.notImportedFromOwnEntry ?? '?'} app files${standalone ? ` (+${standalone} standalone scripts)` : ''} · screens with no incoming navigation: ${noNav} · unresolved: ${(map.unresolved || []).length}`);
  say('More: brainmap file <path> | impact <path> | screen <name> | collection <name> | function <name> | files <folder> | find <text> | unused');
}

function filesCmd(P, ix, q) {
  if (!q) die('Give a folder, for example: brainmap files screens');
  const low = q.replace(/\/+$/, '').toLowerCase();
  const list = ix.files.filter(f => folderOf(f).toLowerCase() === low || f.path.toLowerCase().startsWith(low + '/'))
    .sort((a, b) => a.path.localeCompare(b.path));
  if (!list.length) {
    const folders = [...new Set(ix.files.map(folderOf))].sort();
    die(`No mapped files in "${q}". Folders: ${folders.map(f => (f === '(root)' ? '(root)' : `${f}/`)).join(', ')}`);
  }
  say(`${q.replace(/\/+$/, '')}/: ${plural(list.length, 'file')}, ${list.reduce((s, f) => s + (f.lines || 0), 0)} lines`);
  items(list.map(f => {
    const ex = f.exports || [];
    return `${f.path}  ${f.lines}${ex.length ? `  exports: ${ex.slice(0, 6).join(', ')}${ex.length > 6 ? ` +${ex.length - 6}` : ''}` : ''}`;
  }), 50);
}

function fileCmd(P, ix, q) {
  const f = resolveFile(ix, q);
  const out = ix.out.get(f.path) || [], inn = ix.inn.get(f.path) || [];
  say(`${f.path}  ${f.lines} lines  folder ${folderOf(f)}${f.rootGroup !== 'app' ? ` (own root: ${f.rootGroup})` : ''}${f.parseError ? '  (could not be parsed)' : ''}`);
  wrapList(`Exports (${(f.exports || []).length}): `, f.exports || [], 20);
  const imp = out.filter(e => IMPORT_KINDS.has(e.kind)), impBy = inn.filter(e => IMPORT_KINDS.has(e.kind));
  const impTo = groupBy(imp, e => e.to), impFrom = groupBy(impBy, e => e.from);
  say(`Imports ${plural(impTo.size, 'file')}${imp.length !== impTo.size ? ` (${imp.length} statements)` : ''}${impTo.size ? ':' : ''}`);
  items([...impTo].map(([p, es]) => `${p}${es.some(e => e.kind !== 'import') ? ` [${[...new Set(es.map(e => e.kind))].join(', ')}]` : ''}`));
  if (f.packages?.length) wrapList('Packages: ', f.packages);
  say(`Imported by ${plural(impFrom.size, 'file')}${impBy.length !== impFrom.size ? ` (${impBy.length} statements)` : ''}${f.reachableFromAppEntry === false && f.rootGroup === 'app' ? ' · not reached from the entry file' : ''}${impFrom.size ? ':' : ''}`);
  items([...impFrom.keys()].sort((a, b) => a.localeCompare(b)));
  const defines = ix.screens.filter(s => s.file === f.path);
  if (defines.length) wrapList('Defines screens: ', defines.map(s => `${s.name} (${s.navigator}${s.parent ? ` in ${s.parent}` : ''})`));
  const navTo = groupBy(out.filter(e => e.kind === 'navigate'), e => `${e.screen} → ${e.to}`);
  if (navTo.size) { say(`Navigates to ${plural(navTo.size, 'screen')}:`); items([...navTo].map(([k, es]) => `${k}${linesOf(es)}`)); }
  const navFrom = groupBy(inn.filter(e => e.kind === 'navigate'), e => e.from);
  if (navFrom.size) { say(`Navigated to from ${plural(navFrom.size, 'file')}:`); items([...navFrom].sort().map(([k, es]) => `${k} (${[...new Set(es.map(e => e.screen))].join(', ')})${linesOf(es)}`)); }
  const subPattern = id => P.map.nodes.find(n => n.id === id)?.pattern ?? id.replace(/^subcollection:/, '');
  for (const kind of ['reads', 'writes']) {
    const es = out.filter(e => e.kind === kind);
    const top = es.filter(e => e.to.startsWith('collection:')), sub = es.filter(e => e.to.startsWith('subcollection:'));
    if (top.length) wrapList(`${kind === 'reads' ? 'Reads' : 'Writes'}: `, top.map(e => `${e.to.slice(11)} (${plural(e.count || 1, 'use')})`), 15);
    if (sub.length) wrapList(`  of which subcollections: `, sub.map(e => `${subPattern(e.to)} (${plural(e.count || 1, 'use')})`), 10);
  }
  const unknown = (P.map.data?.usesWithUnknownOperation || []).filter(u => u.file === f.path);
  if (unknown.length) wrapList('Firestore use, read or write unknown: ', unknown.map(u => `${u.collection} line ${u.line}`));
  const calls = groupBy(out.filter(e => e.kind === 'calls-function'), e => e.function);
  if (calls.size) wrapList('Calls cloud functions: ', [...calls].map(([n, es]) => `${n} (${es[0].to})${linesOf(es)}`));
  const served = Object.entries(P.map.functions?.names || {}).filter(([, v]) => v.definedIn === f.path);
  if (served.length) wrapList('Defines called cloud functions: ', served.map(([n, v]) => `${n} ←${v.callers.length}`));
}

function impactCmd(P, ix, q) {
  const f = resolveFile(ix, q);
  const seen = new Map([[f.path, { depth: 0 }]]);
  let frontier = [f.path];
  for (let d = 1; d <= 3 && frontier.length; d++) {
    const next = [];
    for (const p of frontier) {
      for (const e of ix.inn.get(p) || []) {
        if (!IMPORT_KINDS.has(e.kind) || seen.has(e.from)) continue;
        seen.set(e.from, { depth: d, via: p });
        next.push(e.from);
      }
    }
    frontier = next;
  }
  const byDepth = groupBy([...seen].filter(([, v]) => v.depth > 0), ([, v]) => v.depth);
  let beyond = 0;
  for (const p of frontier) for (const e of ix.inn.get(p) || []) if (IMPORT_KINDS.has(e.kind) && !seen.has(e.from)) beyond++;
  const total = seen.size - 1;
  say(`${f.path}: ${plural(total, 'file')} depend on it through imports (${[1, 2, 3].map(d => `depth ${d}: ${byDepth.get(d)?.length || 0}`).join(', ')})${beyond ? `; more beyond depth 3` : ''}`);
  for (const d of [1, 2, 3]) {
    const list = byDepth.get(d);
    if (!list) continue;
    say(d === 1 ? 'Depth 1 (import it directly):' : `Depth ${d} (via the file shown):`);
    items(list.sort((a, b) => a[0].localeCompare(b[0])).map(([p, v]) => (d === 1 ? p : `${p}  ← ${v.via}`)));
  }
  const nav = new Set((ix.inn.get(f.path) || []).filter(e => e.kind === 'navigate').map(e => e.from));
  if (nav.size) say(`Also navigated to from ${plural(nav.size, 'file')} (not counted above): brainmap file ${f.path}`);
}

function findScreens(ix, q) {
  const low = String(q || '').toLowerCase().replace(/screen$/, '');
  if (!q) die('Give a screen name, for example: brainmap screen Home');
  let hits = ix.screens.filter(s => s.name.toLowerCase() === q.toLowerCase());
  if (!hits.length) hits = ix.screens.filter(s => s.name.toLowerCase() === low || s.component?.toLowerCase() === q.toLowerCase() || s.file?.toLowerCase().endsWith(`/${q.toLowerCase()}`));
  if (!hits.length) {
    const near = [...new Set(ix.screens.filter(s => s.name.toLowerCase().includes(low)).map(s => s.name))];
    die(`No screen "${q}".${near.length ? ` Similar: ${near.slice(0, 15).join(', ')}` : ` Screens: ${[...new Set(ix.screens.map(s => s.name))].slice(0, 30).join(', ')}…`}`);
  }
  return hits;
}

function screenCmd(P, ix, q) {
  const hits = findScreens(ix, q);
  const names = new Set(hits.map(s => s.name));
  for (const s of hits) {
    say(`Screen ${s.name}: ${s.file || 'no file found'}  (${s.navigator || 'navigator'}${s.parent ? ` in ${s.parent}` : ''}, declared in ${s.navigatorFile}:${s.line})`);
  }
  const files = new Set(hits.map(s => s.file).filter(Boolean));
  const from = P.map.edges.filter(e => e.kind === 'navigate' && (names.has(e.screen) || (files.has(e.to) && !e.screen)));
  const fromBy = groupBy(from, e => e.from);
  const nested = hits.reduce((s, h) => s + (h.incomingAsNestedParent || 0), 0);
  say(`Reached from ${plural(fromBy.size, 'file')} (${plural(from.length, 'call')})${nested ? `, plus ${nested} navigation calls into screens nested inside it` : ''}:`);
  items([...fromBy].sort().map(([p, es]) => {
    const methods = [...new Set(es.map(e => e.method).filter(Boolean))];
    const owner = ix.screens.filter(x => x.file === p).map(x => x.name);
    return `${p}${owner.length ? ` [${owner.slice(0, 3).join(', ')}]` : ''}${methods.length ? ` ${methods.join('/')}` : ''}${linesOf(es)}`;
  }), 15);
  if (!from.length) say('  none found (it may be the first screen, reached through a navigator, or by a computed name)');
  const to = groupBy([...files].flatMap(fp => (ix.out.get(fp) || []).filter(e => e.kind === 'navigate')), e => `${e.screen} → ${e.to}`);
  say(`Navigates to ${plural(to.size, 'screen')}:`);
  items([...to].map(([k, es]) => `${k}${linesOf(es)}`));
  if (!to.size) say('  none found');
}

// ─── path and report ─────────────────────────────────────────────────────────
function pathCmd(P, ix, args) {
  const [a, b] = Array.isArray(args) ? args : [];
  if (!a || !b) die('Give two things, for example: brainmap path screens/TrackerScreen.js workoutLogs  (quote names with spaces)');
  const r = findPath(P.map, a, b, { allShortest: ALL_SHORTEST });
  if (r.status === 'notfound') die(`Nothing in the map matches "${r.query}" (a file, exported function, screen, collection or subcollection).`);
  if (r.status === 'ambiguous') die(`"${r.query}" matches ${r.matches.length} things; use a fuller name or file:function:\n${r.matches.map(m => `  ${m}`).join('\n')}`);
  if (r.status === 'same') return say(`${r.a} and ${r.b} are the same node.`);
  if (r.status === 'none') return say(`No path between ${r.a} and ${r.b}, in either direction (imports, calls, navigation, cloud functions, reads, writes).`);
  const by = r.only ? ` by ${r.only} only` : '';
  say(r.direction === 'forward'
    ? `${r.a} → ${r.b}: ${plural(r.length, 'hop')}${by} (${r.a} uses ${r.b})`
    : `No path from ${r.a} to ${r.b}; the other direction exists: ${r.b} → ${r.a}, ${plural(r.length, 'hop')}${by} (${r.b} uses ${r.a})`);
  if (r.paths.length > 1) say(`${r.paths.length} shortest paths${r.paths.length === 5 ? ' (first 5)' : ''}:`);
  r.paths.forEach((path, i) => {
    if (r.paths.length > 1) say(`Path ${i + 1}:`);
    path.forEach((h, j) => {
      const e = h.edges[0];
      say(`  ${j + 1}. ${h.from} —${e.kind}${e.what ? ` ${e.what}` : ''}→ ${h.to}  (${e.at})`);
      if (h.edges.length > 1) say(`     also: ${h.edges.slice(1, ALL ? undefined : 3).map(x => `${x.kind}${x.what ? ` ${x.what}` : ''} (${x.at})`).join('; ')}${!ALL && h.edges.length > 3 ? `; +${h.edges.length - 3} more` : ''}`);
    });
  });
}

function reportCmd(P) {
  const r = computeReport(P.map);
  const kinds = o => Object.entries(o.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
  say(`Report for ${P.slug} (map from ${when(P.map.generatedAt)}); links = imports, calls, navigation, cloud functions, reads, writes.`);
  say('Most depended-on files (incoming links):');
  items(r.dependedOn.map(x => `${String(x.total).padStart(4)}  ${x.file}  (${kinds(x)})`));
  say('Most dependent files (outgoing links):');
  items(r.dependent.map(x => `${String(x.total).padStart(4)}  ${x.file}  (${kinds(x)})`));
  say('Most-called functions (calling files):');
  items(r.functions.map(x => `${String(x.files).padStart(4)}  ${x.fn}  ${x.file}  (${plural(x.calls, 'call')})`));
  say('Busiest data (reader + writer files):');
  items(r.data.map(x => `${String(x.total).padStart(4)}  ${x.name}  (${x.readers} read, ${x.writers} write${x.kind === 'subcollection' ? ', subcollection' : ''})`));
  say('Bridges (removing the file splits the import graph):');
  items(r.bridges.length ? r.bridges.map(x => `${x.file}  cuts off ${plural(x.cutOff, 'file')} (parts: ${x.parts.slice(0, 5).join(', ')}${x.parts.length > 5 ? ', …' : ''})`) : ['none']);
  say('Rare links (between folders joined by fewer than 3 links):');
  items(r.surprising.length ? r.surprising.map(x => `${x.from} —${x.kind}${x.what ? ` ${x.what}` : ''}→ ${x.to}  (${x.from}:${x.line ?? '?'}; ${x.folders.join(' ↔ ')}: ${plural(x.pairLinks, 'link')})`) : ['none']);
  say('Suggested next questions:');
  items(r.questions.map(q => `${q.cmd}   # ${q.why}`));
}

// ─── function calls ──────────────────────────────────────────────────────────
// Call edges into a function: the exported name or the local name it has in its own file.
const callsTo = (ix, file, fn) => (ix.inn.get(file) || []).filter(e => e.kind === 'calls' && (e.function === fn || e.local === fn || e.export === fn));
// One row per calling file; calls through a function handed over as a value get their own row with where it came from.
const callRows = list => [...groupBy(list, e => (e.via === 'value' ? `${e.from}\0${e.passedFrom}:${e.passedLine}` : e.from))].map(([, es]) => {
  const e0 = es[0];
  const callers = [...new Set(es.map(e => e.caller).filter(Boolean))];
  return { file: e0.from, text: `${e0.from}${linesOf(es)}${callers.length ? ` in ${callers.slice(0, 3).join(', ')}${callers.length > 3 ? ', …' : ''}` : ''}${e0.via === 'value' ? `, via value from ${e0.passedFrom}:${e0.passedLine}` : ''}` };
});

// "Through functions": the named functions that read or write a collection, and the files that call them. With
// --depth 2, also the callers of functions (in other files) that call those functions.
function throughFunctions(ix, dataEdges) {
  const fns = new Map(); // file\0function -> { file, fn, ops }
  for (const e of dataEdges) for (const st of e.sites || []) {
    if (!st.function) continue;
    const k = `${e.from}\0${st.function}`;
    (fns.get(k) || fns.set(k, { file: e.from, fn: st.function, ops: new Set() }).get(k)).ops.add(e.kind === 'reads' ? 'reads' : 'writes');
  }
  const list = [...fns.values()].sort((a, b) => a.file.localeCompare(b.file) || a.fn.localeCompare(b.fn));
  const direct = list.map(f => ({ ...f, calls: callsTo(ix, f.file, f.fn) }));
  const callerFiles = new Set(direct.flatMap(f => f.calls.map(e => e.from)));
  say(`Through functions: ${plural(list.length, 'function')} read or write it, called from ${plural(callerFiles.size, 'other file')}${DEPTH === 1 ? ' (--depth 2 adds their callers)' : ''}`);
  // Many functions: fewer of them, and fewer caller lines each, unless --all.
  const many = direct.length > 6;
  const shownFns = ALL ? direct : direct.slice(0, many ? 8 : 12);
  for (const f of shownFns) {
    say(`  ${f.fn} (${f.file}, ${[...f.ops].join(' and ')}) ← ${f.calls.length ? plural(new Set(f.calls.map(e => e.from)).size, 'file') : 'no calls from other files'}`);
    if (f.calls.length) indent(() => groupedByFolder(ix, callRows(f.calls), many ? 3 : 6));
    const passed = ix.unresolvedCalls.filter(u => u.target === f.file && u.name === f.fn);
    if (passed.length) say(`    also passed on as a value, not followed: ${passed.map(u => `${u.file}:${u.line}`).join(', ')}`);
    if (DEPTH < 2) continue;
    // Functions in other files that call f, and who calls them.
    const wrappers = [...groupBy(f.calls.filter(e => e.caller), e => `${e.from}\0${e.caller}`).values()]
      .map(es => ({ file: es[0].from, fn: es[0].caller, calls: callsTo(ix, es[0].from, es[0].caller) }))
      .filter(w => !fns.has(`${w.file}\0${w.fn}`)); // already listed above as reading or writing it
    for (const w of wrappers) {
      if (!w.calls.length) continue;
      say(`    via ${w.fn} (${w.file}) ← ${plural(new Set(w.calls.map(e => e.from)).size, 'file')}`);
      indent(() => indent(() => groupedByFolder(ix, callRows(w.calls), 4)));
    }
    const silent = wrappers.filter(w => !w.calls.length).length;
    if (silent) say(`    (${plural(silent, 'calling function')} with no calls from other files)`);
  }
  if (shownFns.length < direct.length) say(`  (+${direct.length - shownFns.length} more functions, use --all)`);
}

// Runs fn with its output indented by two more spaces.
function indent(fn) {
  const start = lines.length;
  fn();
  for (let i = start; i < lines.length; i++) lines[i] = `  ${lines[i]}`;
}

function callersCmd(P, ix, q) {
  if (!q) die('Give an exported function name, or file:name, for example: brainmap callers logWorkout');
  let file = null, name = q;
  const colon = q.lastIndexOf(':');
  if (colon > 0) { file = resolveFile(ix, q.slice(0, colon)).path; name = q.slice(colon + 1); }
  const all = P.map.edges.filter(e => e.kind === 'calls' && (e.function === name || e.local === name || e.export === name) && (!file || e.to === file));
  const byTarget = groupBy(all, e => e.to);
  const passed = (P.map.unresolved || []).filter(u => u.kind === 'call' && u.name === name && (!file || u.target === file));
  if (!byTarget.size) {
    const defined = ix.files.filter(f => (f.exports || []).includes(name) && (!file || f.path === file)).map(f => f.path);
    say(defined.length
      ? `${name} (exported by ${defined.join(', ')}): no calls from other files found.`
      : `No exported function "${name}"${file ? ` in ${file}` : ''} is called from another file.${file ? '' : ' Try brainmap find.'}`);
  }
  if (byTarget.size > 1) say(`"${name}" matches ${byTarget.size} functions: ${[...byTarget.keys()].map(t => `${t}:${name}`).join(', ')}`);
  for (const [target, es] of byTarget) {
    if (byTarget.size > 1) say('');
    say(`${name} (${target}): ${plural(es.length, 'call')} from ${plural(new Set(es.map(e => e.from)).size, 'file')}, by folder:`);
    groupedByFolder(ix, callRows(es), byTarget.size > 1 ? 10 : 25);
  }
  if (passed.length) {
    say(`Also passed on as a value, so its calls cannot be followed (${passed.length}):`);
    items(passed.map(u => `${u.file}:${u.line}`));
  }
}

// The folder a file is listed under: its own root (functions/, scripts/) or its top-level app folder.
const folderLabel = f => (!f ? '?' : f.rootGroup !== 'app' ? `${f.rootGroup}/` : f.topFolder === '(root)' ? '(root files)' : `${f.topFolder}/`);

// Lines grouped under folder headings, cut after `limit` lines in all with "(+N more, use --all)".
function groupedByFolder(ix, rows, limit = 15) {
  const by = groupBy(rows, r => folderLabel(ix.byPath.get(r.file)));
  const rank = k => (k === 'functions/' || k === 'scripts/' ? 1 : 0); // app folders first, then the separate roots
  const order = [...by.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  let shown = 0;
  for (const k of order) {
    if (!ALL && shown >= limit) break;
    const list = by.get(k).sort((x, y) => x.file.localeCompare(y.file));
    say(`  ${k} (${list.length})`);
    for (const r of list) { if (!ALL && shown >= limit) break; say(`    ${r.text}`); shown++; }
  }
  if (shown < rows.length) say(`  (+${rows.length - shown} more, use --all)`);
}

// A path the user typed, as the mapper keys it: users/{uid}/workoutLogs/{id} -> users/{}/workoutLogs.
function patternKey(q) {
  const parts = q.split('/').filter(Boolean);
  const col = parts.length % 2 === 0 ? parts.slice(0, -1) : parts;
  return col.map((p, i) => (i % 2 ? '{}' : p)).join('/');
}

function collectionTargets(ix, q) {
  const low = q.toLowerCase();
  if (q.includes('/')) {
    const key = patternKey(q);
    return [...ix.collections.filter(c => c.name === key), ...ix.subs.filter(n => n.key === key || n.key.toLowerCase() === key.toLowerCase())];
  }
  let hits = [...ix.collections.filter(c => c.name === q), ...ix.subs.filter(n => n.name === q)];
  if (!hits.length) hits = [...ix.collections.filter(c => c.name.toLowerCase() === low), ...ix.subs.filter(n => n.name.toLowerCase() === low)];
  return hits;
}

function collectionCmd(P, ix, q) {
  if (!q) die('Give a collection name, subcollection name or path, for example: brainmap collection users');
  const hits = collectionTargets(ix, q);
  if (!hits.length) {
    const names = [...new Set([...ix.collections.map(c => c.name), ...ix.subs.map(n => n.pattern)])];
    const near = names.filter(n => n.toLowerCase().includes(q.toLowerCase()));
    die(`No collection or subcollection "${q}".${near.length ? ` Similar: ${near.slice(0, 15).join(', ')}` : ` Known: ${names.slice(0, 40).join(', ')}`}`);
  }
  const label = n => (n.kind === 'subcollection' ? n.pattern : n.name);
  if (hits.length > 1) say(`"${q}" matches ${hits.length} patterns: ${hits.map(label).join(', ')}`);
  const unknownAll = P.map.data?.usesWithUnknownOperation || [];
  hits.forEach((n, i) => {
    if (i) say('');
    const sub = n.kind === 'subcollection';
    const unknown = unknownAll.filter(u => (sub ? u.subcollection === n.key : u.collection === n.name));
    const uf = new Set(unknown.map(u => u.file)).size;
    say(`${sub ? 'Subcollection' : 'Collection'} ${label(n)}: read by ${plural(n.readers, 'file')}, written by ${plural(n.writers, 'file')}${unknown.length ? `; read or write unknown: ${plural(unknown.length, 'use')} in ${plural(uf, 'file')}` : ''}${n.collectionGroup ? ' (also queried as a collection group)' : ''}`);
    if (!sub) {
      const children = ix.subs.filter(x => x.parent === n.name);
      if (children.length) wrapList(`Counts include its ${plural(children.length, 'subcollection')}: `, children.map(x => `${x.pattern} (${x.readers}r/${x.writers}w)`), 10);
    }
    wrapList(`Paths (${(n.paths || []).length}): `, n.paths || [], 8);
    const es = ix.inn.get(n.id) || [];
    for (const kind of ['writes', 'reads']) {
      const list = es.filter(e => e.kind === kind);
      say(`${kind === 'writes' ? 'Written by' : 'Read by'} ${plural(list.length, 'file')}${list.length ? ', by folder:' : ''}`);
      groupedByFolder(ix, list.map(e => ({ file: e.from, text: `${e.from}  ${plural(e.count || 1, 'use')}${linesOf([e])}` })), hits.length > 1 ? 10 : 15);
    }
    if (unknown.length) {
      say(`Read or write unknown (${unknown.length}), by folder:`);
      groupedByFolder(ix, unknown.map(u => ({ file: u.file, text: `${u.file}:${u.line}${u.function ? ` (in ${u.function})` : ''}  ${u.path || ''}` })), 10);
    }
    throughFunctions(ix, es);
  });
  const partial = (P.map.unresolved || []).filter(u => u.kind === 'data' && u.path).length;
  say(`Firestore use is mapped in every folder (app, functions/, scripts/).${partial ? ` ${plural(partial, 'path')} with a subcollection name the map could not work out ${partial === 1 ? 'is' : 'are'} counted as unresolved.` : ''}`);
}

function functionCmd(P, ix, q) {
  if (!q) die('Give a cloud function name, for example: brainmap function sendEmail');
  const fn = P.map.functions || {};
  const all = [...new Set([...(fn.exported || []), ...Object.keys(fn.names || {})])];
  const name = all.find(n => n === q) || all.find(n => n.toLowerCase() === q.toLowerCase());
  if (!name) die(`No cloud function "${q}". Cloud functions: ${all.join(', ') || 'none found'}`);
  const info = fn.names?.[name];
  const defined = info?.definedIn || (P.map.rootGroups || []).find(g => g.name === 'functions')?.entry;
  say(`Cloud function ${name}: defined in ${defined || 'unknown file'}${(fn.exported || []).includes(name) ? ' (exported)' : ''}`);
  const calls = P.map.edges.filter(e => e.kind === 'calls-function' && e.function === name);
  const by = groupBy(calls, e => e.from);
  say(`Called from ${plural(by.size, 'file')}:`);
  items([...by].map(([p, es]) => `${p}${linesOf(es)}`), 20);
  if (!by.size) say('  none found in the code (it may run on a schedule, an HTTP request or a database trigger)');
}

function findCmd(P, ix, q) {
  if (!q) die('Give some text to find, for example: brainmap find auth');
  const low = q.toLowerCase();
  const paths = ix.files.filter(f => f.path.toLowerCase().includes(low));
  const exp = ix.files.flatMap(f => (f.exports || []).filter(x => x.toLowerCase().includes(low)).map(x => `${x}  ${f.path}`));
  const scr = ix.screens.filter(s => s.name.toLowerCase().includes(low));
  const cols = [...ix.collections.filter(c => c.name.toLowerCase().includes(low)).map(c => c.name),
    ...ix.subs.filter(n => n.pattern.toLowerCase().includes(low)).map(n => n.pattern)];
  say(`"${q}": ${plural(paths.length, 'path')}, ${plural(exp.length, 'export')}, ${plural(scr.length, 'screen')}, ${plural(cols.length, 'collection or subcollection', 'collections or subcollections')}`);
  if (paths.length) { say('Paths:'); items(paths.map(f => f.path)); }
  if (exp.length) { say('Exports:'); items(exp); }
  if (scr.length) { say('Screens:'); items(scr.map(s => `${s.name}  ${s.file || ''}`)); }
  if (cols.length) wrapList('Collections: ', cols);
}

function unusedCmd(P, ix) {
  const groups = P.map.rootGroups || [];
  const imports = new Map();
  for (const e of P.map.edges) if (IMPORT_KINDS.has(e.kind)) (imports.get(e.from) || imports.set(e.from, []).get(e.from)).push(e.to);
  const reach = start => { const seen = new Set(), st = [start]; while (st.length) { const f = st.pop(); if (!f || seen.has(f) || !ix.byPath.has(f)) continue; seen.add(f); st.push(...(imports.get(f) || [])); } return seen; };
  for (const g of groups.filter(g => g.entry)) {
    const seen = reach(g.entry);
    const list = ix.files.filter(f => f.rootGroup === g.name && !seen.has(f.path)).sort((a, b) => a.path.localeCompare(b.path));
    say(`Not imported from ${g.entry} (${g.name}): ${list.length}`);
    items(list.map(f => `${f.path}${f.importedBy ? `  (imported by ${f.importedBy} unreached file${f.importedBy === 1 ? '' : 's'})` : ''}`), 25);
  }
  for (const g of groups.filter(g => !g.entry)) say(`${g.dir || g.name}/: ${plural(g.fileCount, 'file')} with no entry file (standalone scripts, run by hand); not listed`);
  const noNav = ix.screens.filter(s => !s.incomingNavigation && !s.incomingAsNestedParent);
  say(`Screens with no incoming navigation found: ${noNav.length}`);
  items(noNav.map(s => `${s.name}${s.parent ? ` (in ${s.parent})` : ''}  ${s.file || 'no file'}`), 20);
  say('"Not found" means the map saw no link; code can still be used in ways the map does not see (computed names, other languages).');
}

// ─── main ────────────────────────────────────────────────────────────────────
const COMMANDS = { path: pathCmd, report: reportCmd, callers: callersCmd, overview, files: filesCmd, file: fileCmd, impact: impactCmd, screen: screenCmd, collection: collectionCmd, function: functionCmd, find: findCmd, unused: unusedCmd };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [cmd = 'help', ...rest] = opts.pos;
  if (cmd === 'help') die(HELP, 0);
  const run = COMMANDS[cmd];
  if (!run) die(`Unknown command "${cmd}".\n\n${HELP}`);
  ALL = opts.all;
  if (![1, 2].includes(opts.depth)) die('--depth takes 1 or 2.');
  DEPTH = opts.depth;
  ALL_SHORTEST = opts.allShortest;
  const P = await loadProject(opts);
  run(P, index(P.map), cmd === 'path' ? rest : rest.join(' '));
  flush();
}

main().catch(e => die(`brainmap: ${e.message}`));
