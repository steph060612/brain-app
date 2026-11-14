#!/usr/bin/env node
// brainmap: read-only answers about a mapped code project, for coding assistants. Reads
// ~/.brain/maps/<slug>/map.json (schemaVersion 2); refreshes it first when the code changed (the same check
// as the Brain app's "Map is current"). Prints paths, names and numbers only, never file contents.
// No network, no model calls.
import { stat } from 'fs/promises';
import {
  loadLinks, readMap, mapStatus, runMapper, gitAvailable, realOrSelf, inside, tilde,
} from './codemap-status.js';

const MAX_LINES = 60;
const WIDTH = 110;
const IMPORT_KINDS = new Set(['import', 'require', 're-export', 'dynamic']);
const HELP = `brainmap: read-only map of a JavaScript project linked in the Brain app.

Usage: brainmap <command> [argument] [--all] [--project <name>] [--no-refresh]
  overview              project summary: entry files, folders, most imported files, screens, collections, functions
  files <folder>        files in a folder, with line counts and exported names
  file <path>           exports, imports, importers, navigation, collections and functions of one file
  impact <path>         files that depend on it through imports, up to 3 steps away, grouped by depth
  screen <name>         a navigation screen: its file, where it navigates to and where it is reached from
  collection <name>     files that read and write a Firestore collection
  function <name>       a cloud function: where it is defined and who calls it
  find <text>           matches in file paths, exported names, screens and collections
  unused                files not imported from the entry file, screens with no incoming navigation found

The project is the linked folder that contains the current folder, or --project <name>.
Output stops at ${MAX_LINES} lines unless --all is given. Paths are relative to the project folder.`;

// ─── output ──────────────────────────────────────────────────────────────────
const lines = [];
const say = (s = '') => { for (const l of String(s).split('\n')) lines.push(l); };
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// A comma-separated list wrapped to WIDTH, continuation lines indented.
function wrapList(head, items, indent = '  ') {
  if (!items.length) return say(`${head}none`);
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
function flush(all) {
  const out = !all && lines.length > MAX_LINES
    ? [...lines.slice(0, MAX_LINES - 1), `(+${lines.length - (MAX_LINES - 1)} more, use --all)`]
    : lines;
  process.stdout.write(out.join('\n') + '\n');
}
// Ends with a message, keeping any note already printed (such as "Map refreshed").
function die(msg, code = 1) { process.stdout.write([...lines, msg].join('\n') + '\n'); process.exit(code); }

// ─── arguments ───────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { all: false, refresh: true, project: null, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all' || a === '-a') o.all = true;
    else if (a === '--no-refresh') o.refresh = false;
    else if (a === '--project' || a === '-p') o.project = argv[++i] ?? '';
    else if (a.startsWith('--project=')) o.project = a.slice(10);
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
  try { m = await readMap(p.slug); } catch (e) { die(`${e.message}\nIn the Brain app, open the project and click "Re-map".`); }
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
  return { files, byPath, out, inn, screens, collections };
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
  wrapList('Folders: ', [...fc].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k === '(root)' ? '(root files)' : `${k}/`} ${n}`));
  say('Most imported:');
  for (const f of [...ix.files].sort((a, b) => (b.importedBy || 0) - (a.importedBy || 0) || a.path.localeCompare(b.path)).slice(0, 10)) {
    say(`  ${String(f.importedBy || 0).padStart(3)}  ${f.path}`);
  }
  wrapList(`Screens (${ix.screens.length}): `, [...new Set(ix.screens.map(s => s.name))]);
  wrapList(`Collections (${ix.collections.length}, used in app files): `, [...ix.collections].sort((a, b) => (b.readers + b.writers) - (a.readers + a.writers))
    .map(n => `${n.name} (${n.readers}r/${n.writers}w)`));
  const called = map.functions?.names || {};
  wrapList(`Cloud functions (${fnNames.length}${Object.keys(called).length ? `, ${Object.keys(called).length} called from code` : ''}): `,
    fnNames.map(n => (called[n]?.callers?.length ? `${n} ←${called[n].callers.length}` : n)));
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
  for (const f of list) {
    const ex = f.exports || [];
    say(`  ${f.path}  ${f.lines}${ex.length ? `  exports: ${ex.slice(0, 6).join(', ')}${ex.length > 6 ? ` +${ex.length - 6}` : ''}` : ''}`);
  }
}

function fileCmd(P, ix, q) {
  const f = resolveFile(ix, q);
  const out = ix.out.get(f.path) || [], inn = ix.inn.get(f.path) || [];
  say(`${f.path}  ${f.lines} lines  folder ${folderOf(f)}${f.rootGroup !== 'app' ? ` (own root: ${f.rootGroup})` : ''}${f.parseError ? '  (could not be parsed)' : ''}`);
  wrapList(`Exports (${(f.exports || []).length}): `, f.exports || []);
  const imp = out.filter(e => IMPORT_KINDS.has(e.kind)), impBy = inn.filter(e => IMPORT_KINDS.has(e.kind));
  const impTo = groupBy(imp, e => e.to), impFrom = groupBy(impBy, e => e.from);
  say(`Imports ${plural(impTo.size, 'file')}${imp.length !== impTo.size ? ` (${imp.length} statements)` : ''}:`);
  for (const [p, es] of impTo) say(`  ${p}${es.some(e => e.kind !== 'import') ? ` [${[...new Set(es.map(e => e.kind))].join(', ')}]` : ''}`);
  if (f.packages?.length) wrapList('Packages: ', f.packages);
  say(`Imported by ${plural(impFrom.size, 'file')}${impBy.length !== impFrom.size ? ` (${impBy.length} statements)` : ''}${f.reachableFromAppEntry === false && f.rootGroup === 'app' ? ' · not reached from the entry file' : ''}:`);
  for (const p of [...impFrom.keys()].sort((a, b) => a.localeCompare(b))) say(`  ${p}`);
  const defines = ix.screens.filter(s => s.file === f.path);
  if (defines.length) wrapList('Defines screens: ', defines.map(s => `${s.name} (${s.navigator}${s.parent ? ` in ${s.parent}` : ''})`));
  const navTo = groupBy(out.filter(e => e.kind === 'navigate'), e => `${e.screen} → ${e.to}`);
  if (navTo.size) { say(`Navigates to ${plural(navTo.size, 'screen')}:`); for (const [k, es] of navTo) say(`  ${k}${linesOf(es)}`); }
  const navFrom = groupBy(inn.filter(e => e.kind === 'navigate'), e => e.from);
  if (navFrom.size) { say(`Navigated to from ${plural(navFrom.size, 'file')}:`); for (const [k, es] of [...navFrom].sort()) say(`  ${k} (${[...new Set(es.map(e => e.screen))].join(', ')})${linesOf(es)}`); }
  for (const kind of ['reads', 'writes']) {
    const es = out.filter(e => e.kind === kind);
    if (es.length) wrapList(`${kind === 'reads' ? 'Reads' : 'Writes'}: `, es.map(e => `${e.to.replace(/^collection:/, '')} (${plural(e.count || 1, 'use')})`));
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
    for (const [p, v] of list.sort((a, b) => a[0].localeCompare(b[0]))) say(d === 1 ? `  ${p}` : `  ${p}  ← ${v.via}`);
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
  for (const [p, es] of [...fromBy].sort()) {
    const methods = [...new Set(es.map(e => e.method).filter(Boolean))];
    const owner = ix.screens.filter(x => x.file === p).map(x => x.name);
    say(`  ${p}${owner.length ? ` [${owner.slice(0, 3).join(', ')}]` : ''}${methods.length ? ` ${methods.join('/')}` : ''}${linesOf(es)}`);
  }
  if (!from.length) say('  none found (it may be the first screen, reached through a navigator, or by a computed name)');
  const to = groupBy([...files].flatMap(fp => (ix.out.get(fp) || []).filter(e => e.kind === 'navigate')), e => `${e.screen} → ${e.to}`);
  say(`Navigates to ${plural(to.size, 'screen')}:`);
  for (const [k, es] of to) say(`  ${k}${linesOf(es)}`);
  if (!to.size) say('  none found');
}

function collectionCmd(P, ix, q) {
  if (!q) die('Give a collection name, for example: brainmap collection users');
  const col = ix.collections.find(c => c.name === q) || ix.collections.find(c => c.name.toLowerCase() === q.toLowerCase());
  if (!col) die(`No collection "${q}". Collections: ${ix.collections.map(c => c.name).join(', ') || 'none found'}`);
  const es = ix.inn.get(col.id) || [];
  const unknown = (P.map.data?.usesWithUnknownOperation || []).filter(u => u.collection === col.name);
  const unknownFiles = new Set(unknown.map(u => u.file)).size;
  say(`Collection ${col.name}: read by ${plural(col.readers, 'file')}, written by ${plural(col.writers, 'file')}${unknown.length ? `; read or write unknown: ${plural(unknown.length, 'use')} in ${plural(unknownFiles, 'file')}` : ''}`);
  wrapList('Paths: ', col.paths || []);
  for (const kind of ['writes', 'reads']) {
    const list = es.filter(e => e.kind === kind).sort((a, b) => a.from.localeCompare(b.from));
    say(`${kind === 'writes' ? 'Written by' : 'Read by'} (${list.length}):`);
    for (const e of list) say(`  ${e.from}  ${plural(e.count || 1, 'use')}${linesOf([e])}${e.paths?.length ? `  ${e.paths.slice(0, 3).join(' ')}${e.paths.length > 3 ? ' …' : ''}` : ''}`);
  }
  if (unknown.length) { say(`Read or write unknown (${unknown.length}):`); for (const u of unknown) say(`  ${u.file}:${u.line}  ${u.path || ''}`); }
  const others = (P.map.rootGroups || []).filter(g => g.name !== 'app').map(g => `${g.dir || g.name}/`);
  if (others.length) say(`Note: Firestore use is mapped in app files only; ${others.join(' and ')} ${others.length === 1 ? 'is' : 'are'} not scanned for it.`);
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
  for (const [p, es] of by) say(`  ${p}${linesOf(es)}`);
  if (!by.size) say('  none found in the code (it may run on a schedule, an HTTP request or a database trigger)');
}

function findCmd(P, ix, q) {
  if (!q) die('Give some text to find, for example: brainmap find auth');
  const low = q.toLowerCase();
  const paths = ix.files.filter(f => f.path.toLowerCase().includes(low));
  const exp = ix.files.flatMap(f => (f.exports || []).filter(x => x.toLowerCase().includes(low)).map(x => `${x}  ${f.path}`));
  const scr = ix.screens.filter(s => s.name.toLowerCase().includes(low));
  const cols = ix.collections.filter(c => c.name.toLowerCase().includes(low));
  say(`"${q}": ${plural(paths.length, 'path')}, ${plural(exp.length, 'export')}, ${plural(scr.length, 'screen')}, ${plural(cols.length, 'collection')}`);
  if (paths.length) { say('Paths:'); for (const f of paths) say(`  ${f.path}`); }
  if (exp.length) { say('Exports:'); for (const x of exp) say(`  ${x}`); }
  if (scr.length) { say('Screens:'); for (const s of scr) say(`  ${s.name}  ${s.file || ''}`); }
  if (cols.length) wrapList('Collections: ', cols.map(c => c.name));
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
    for (const f of list) say(`  ${f.path}${f.importedBy ? `  (imported by ${f.importedBy} unreached file${f.importedBy === 1 ? '' : 's'})` : ''}`);
  }
  for (const g of groups.filter(g => !g.entry)) say(`${g.dir || g.name}/: ${plural(g.fileCount, 'file')} with no entry file (standalone scripts, run by hand); not listed`);
  const noNav = ix.screens.filter(s => !s.incomingNavigation && !s.incomingAsNestedParent);
  say(`Screens with no incoming navigation found: ${noNav.length}`);
  for (const s of noNav) say(`  ${s.name}${s.parent ? ` (in ${s.parent})` : ''}  ${s.file || 'no file'}`);
  say('"Not found" means the map saw no link; code can still be used in ways the map does not see (computed names, other languages).');
}

// ─── main ────────────────────────────────────────────────────────────────────
const COMMANDS = { overview, files: filesCmd, file: fileCmd, impact: impactCmd, screen: screenCmd, collection: collectionCmd, function: functionCmd, find: findCmd, unused: unusedCmd };

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const [cmd = 'help', ...rest] = opts.pos;
  if (cmd === 'help') die(HELP, 0);
  const run = COMMANDS[cmd];
  if (!run) die(`Unknown command "${cmd}".\n\n${HELP}`);
  const P = await loadProject(opts);
  run(P, index(P.map), rest.join(' '));
  flush(opts.all);
}

main().catch(e => die(`brainmap: ${e.message}`));
