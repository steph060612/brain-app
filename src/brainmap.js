#!/usr/bin/env node
// brainmap: read-only answers about a mapped code project, for coding assistants. Reads
// ~/.brain/maps/<slug>/map.json (schemaVersion 12); refreshes it first when the code changed in any linked
// folder (the same check as the Brain app's "Map is current"). A project can link several code folders mapped
// into one map: paths then start with the folder's short name (ptdash:src/x.js), --folder limits the output to
// one folder, and report, groups, query and unused run per folder. Prints paths, names and numbers only, never
// file contents.
// No network, no model calls.
import { stat } from 'fs/promises';
import { findPath, computeReport, queryMap, callerTree, callIndex, routesFor } from './map-report.js';
import {
  loadProjects, projectFor, readMap, projectStatus, statusReason, runMapper, gitAvailable, tilde,
} from './codemap-status.js';
import { forFolder, crossFolder, isMulti, folderNames, scopeQuery, prefixed } from './map-folders.js';

const LIST = 10;          // default items per section; --all shows everything
const WIDTH = 110;
const IMPORT_KINDS = new Set(['import', 'require', 're-export', 'dynamic']);
const HELP = `brainmap: read-only map of a JavaScript or TypeScript project linked in the Brain app.

Usage: brainmap <command> [argument] [--all] [--depth 2] [--types] [--folder <name>] [--project <name>] [--no-refresh]
  overview              project summary: entry files, folders, most imported files, screens, collections, functions
  files <folder>        files in a folder, with line counts and exported names
  file <path>           exports, imports, importers, navigation, collections and functions of one file
  impact <path>         files that depend on it through imports, up to 3 steps away (--types: type imports too;
                        impact file:function: through calls)
  screen <name>         a navigation screen or web route (screen name, route path like /clients/:id, a concrete
                        path like /clients/123, or the page file): its file, where it navigates and is reached from
  callers <name>        files and lines that call an exported function (or file:name)
  path <A> <B>          shortest path between two files, functions, screens, routes or collections (navigation first
                        between two screens or pages; --all-shortest: up to 5)
  query "<question>"    plain-words question: matching files, functions, screens, routes, collections and their links
  notes <file|function|--all>  NOTE / WHY / HACK / FIXME / TODO / IMPORTANT / WARNING comments (and ADR/RFC citations)
  groups                subsystems: groups of related files with a name, size, central files and links between groups
  group <label|number>  one group: its files by folder, collections, and the groups it depends on
  report                most-connected files, most-called functions, busiest data, bridges, rare links, next questions
  collection <name>     files that read and write a collection or subcollection (name or path, e.g. users/{uid}/workoutLogs)
  function <name>       a cloud function: where it is defined and who calls it
  find <text>           matches in file paths, exported names, screens and collections
  unused                files not imported from the entry file, screens with no incoming navigation found

The project is the one whose linked folder contains the current folder (any of its folders), or --project <name>.
Each list shows its first items with "(+N more, use --all)"; --all shows everything. Paths are relative to the project folder.
Several code folders: a project can link several folders (an app and a website on one database), mapped as one.
  Paths then start with the folder's short name (ptdash:src/lib/x.js); a path without it works when it is unique.
  Readers, writers and callers are grouped by folder; collection says which folders touch it; path can cross
  folders through shared data or a cloud function, and marks that hop. report, groups, query and unused are
  computed per folder (report adds the shared collections). --folder <name> limits any command to one folder.`;

// ─── output ──────────────────────────────────────────────────────────────────
const lines = [];
let ALL = false, DEPTH = 1, ALL_SHORTEST = false, TYPES = false;
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
  const o = { all: false, refresh: true, project: null, folder: null, depth: 1, allShortest: false, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all' || a === '-a') o.all = true;
    else if (a === '--no-refresh') o.refresh = false;
    else if (a === '--project' || a === '-p') o.project = argv[++i] ?? '';
    else if (a.startsWith('--project=')) o.project = a.slice(10);
    else if (a === '--folder' || a === '-f') o.folder = argv[++i] ?? '';
    else if (a.startsWith('--folder=')) o.folder = a.slice(9);
    else if (a === '--all-shortest') o.allShortest = true;
    else if (a === '--types') o.types = true;
    else if (a === '--depth') o.depth = Number(argv[++i]);
    else if (a.startsWith('--depth=')) o.depth = Number(a.slice(8));
    else if (a === '--help' || a === '-h') o.pos.unshift('help');
    else o.pos.push(a);
  }
  return o;
}

// ─── project, map, refresh ───────────────────────────────────────────────────
async function findProject(name) {
  const projects = await loadProjects();
  if (name) {
    const key = Object.keys(projects).find(k => k.toLowerCase() === name.toLowerCase()) ?? name.toLowerCase();
    return { slug: key, folders: projects[key] ?? [] };
  }
  const p = await projectFor(process.cwd());
  return p && { slug: p.slug, folders: p.folders };
}

async function loadProject(opts) {
  const p = await findProject(opts.project);
  if (!p) {
    die(`This folder (${tilde(process.cwd())}) is not linked to a Brain project.
To create a map: in the Brain app, open the project, click "Link code folder", choose this folder, then click "Map project".
Or name a project: brainmap overview --project <name>`);
  }
  const ok = [], gone = [];
  for (const f of p.folders) { let d = false; try { d = (await stat(f.path)).isDirectory(); } catch { } (d ? ok : gone).push(f); }
  const allThere = p.folders.length > 0 && !gone.length;
  let m;
  try { m = await readMap(p.slug); } catch (e) {
    // A map in an older format is replaced right away when the folders are available.
    if (!e.outdated || !allThere) die(`${e.message}\nIn the Brain app, open the project and click "Re-map".`);
    const t0 = Date.now();
    try { await runMapper(p.folders, p.slug, await gitAvailable()); m = await readMap(p.slug); }
    catch (e2) { die(`The map is in an older format and could not be re-made (${e2.message}).\nIn the Brain app, open the project and click "Re-map".`); }
    say(`Map refreshed: it was in an older format (${((Date.now() - t0) / 1000).toFixed(1)} s).`);
    opts = { ...opts, refresh: false }; // just made from the current code
  }
  if (!m) {
    die(p.folders.length
      ? `Project "${p.slug}" is linked to ${p.folders.map(f => tilde(f.path)).join(' and ')} but has not been mapped yet.\nTo create the map: in the Brain app, open the project and click "Map project".`
      : `No project "${p.slug}" is linked or mapped.\nTo create one: in the Brain app, open the project, click "Link code folder", then "Map project".`);
  }
  if (!p.folders.length) say(`Note: "${p.slug}" is not linked to a code folder any more; this map may be out of date.`);
  else if (gone.length) say(`Note: the linked folder${gone.length > 1 ? 's' : ''} ${gone.map(f => tilde(f.path)).join(', ')} ${gone.length > 1 ? 'were' : 'was'} not found; this map may be out of date.`);
  else if (opts.refresh) {
    // Every linked folder is checked; the whole project is re-mapped when any of them changed.
    const useGit = await gitAvailable();
    let st = null;
    try { st = await projectStatus(p.folders, m.map, useGit); } catch (e) { say(`Note: could not check for changes (${e.message}).`); }
    if (st && st.state !== 'current') {
      const why = statusReason(st);
      const t0 = Date.now();
      try {
        await runMapper(p.folders, p.slug, useGit);
        m = await readMap(p.slug);
        say(`Map refreshed: ${why} (${((Date.now() - t0) / 1000).toFixed(1)} s).`);
      } catch (e) {
        say(`Note: ${why}, but the map could not be refreshed (${e.message}). Answers use the map from ${when(m.map.generatedAt)}.`);
      }
    }
  }
  const P = { slug: p.slug, folder: p.folders[0]?.path ?? null, folders: p.folders, map: m.map, full: m.map };
  if (opts.folder !== null) {
    const names = folderNames(m.map);
    const name = names.find(n => n === String(opts.folder).toLowerCase());
    if (!name) die(`No code folder "${opts.folder}" in this map. Folders: ${names.join(', ') || 'none'}.`);
    if (isMulti(m.map)) { P.map = forFolder(m.map, name); P.only = name; }
  }
  return P;
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
  return { map, files, byPath, out, inn, screens, collections, subs, unresolvedCalls };
}

// With several code folders, the folder's short name goes in front: ptdash:src.
const cfPrefix = f => (prefixed(f) ? `${f.codeFolder}:` : '');
const folderOf = f => cfPrefix(f) + (f.rootGroup !== 'app' ? f.rootGroup : f.topFolder === '(root)' ? '(root)' : f.topFolder);

// A path from the user: exact, then path suffix, then file name, then name without extension. With several code
// folders, "ptdash:src/x.js" looks only in that folder and "src/x.js" in all of them (it must be unique).
function resolveFile(ix, q) {
  q = String(q || '').replace(/^\.\//, '');
  if (!q) die('Give a file path, for example: brainmap file src/App.js');
  if (ix.byPath.has(q)) return ix.byPath.get(q);
  const scope = scopeQuery(ix.map, q);
  const files = scope.folder ? ix.files.filter(f => f.codeFolder === scope.folder) : ix.files;
  const rel = f => f.relPath ?? f.path;
  const low = scope.rest.replace(/^\.\//, '').toLowerCase();
  const tries = [
    f => rel(f).toLowerCase() === low,
    f => rel(f).toLowerCase().endsWith('/' + low),
    f => f.path.split('/').pop().toLowerCase() === low,
    f => f.path.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase() === low,
  ];
  for (const t of tries) {
    const hits = files.filter(t);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) die(`"${q}" matches ${hits.length} files; use the full path:\n${hits.slice(0, 20).map(f => `  ${f.path}`).join('\n')}`);
  }
  const near = files.filter(f => f.path.toLowerCase().includes(low)).slice(0, 10);
  die(`No mapped file "${q}".${near.length ? `\nSimilar:\n${near.map(f => `  ${f.path}`).join('\n')}` : ''}\nOnly JavaScript files are mapped.`);
}

const linesOf = list => {
  const ls = [...new Set(list.flatMap(e => e.lines || (e.line ? [e.line] : [])))].sort((a, b) => a - b);
  return ls.length ? ` (line${ls.length === 1 ? '' : 's'} ${ls.slice(0, 6).join(', ')}${ls.length > 6 ? ', …' : ''})` : '';
};
const groupBy = (list, key) => { const m = new Map(); for (const x of list) { const k = key(x); (m.get(k) || m.set(k, []).get(k)).push(x); } return m; };

const routeCount = ix => ix.screens.filter(s => s.route).length;
// "screen", "route", or "screen or route" for a list of navigate edges (routes are named by their path).
const destWord = es => { const nav = es.filter(e => e.kind === 'navigate'); const r = nav.filter(e => e.screen?.startsWith('/')).length; return !r ? 'screen' : r === nav.length ? 'route' : 'screen or route'; };

// ─── commands ────────────────────────────────────────────────────────────────
function overview(P, ix) {
  const { map } = P;
  const c = map.counts || {};
  if (isMulti(map)) {
    say(`${P.slug}  ${map.folders.length} code folders, mapped together ${when(map.generatedAt)}`);
    for (const f of map.folders) say(`  ${f.name}  ${tilde(f.path)}  ${plural(ix.files.filter(x => x.codeFolder === f.name).length, 'file')}${f.gitCommit ? ` (commit ${f.gitCommit.slice(0, 7)})` : ''}`);
    const cf = crossFolder(map);
    say(`Shared between folders: ${plural(cf.data.filter(d => d.kind === 'collection').length, 'collection')}, ${plural(cf.data.filter(d => d.kind === 'subcollection').length, 'subcollection')}${cf.calls.length ? `, ${plural(cf.calls.length, 'cloud function call')} into another folder` : ''} (brainmap report)`);
  } else say(`${P.slug}${P.only ? ` (folder ${P.only})` : ''}  ${tilde(map.project?.path || P.folder || '')}  mapped ${when(map.generatedAt)}${map.project?.gitCommit ? ` (commit ${map.project.gitCommit.slice(0, 7)})` : ''}`);
  const fnNames = map.functions?.exported || [];
  say(`${plural(ix.files.length, 'file')}, ${plural(c.edges ?? map.edges.length, 'link')}, ${plural(ix.screens.filter(s => !s.route).length, 'screen')}, ${routeCount(ix) ? `${plural(routeCount(ix), 'web route')}, ` : ''}${plural(ix.collections.length, 'collection')}, ${plural(fnNames.length, 'cloud function')}`);
  const langs = map.counts?.filesByLanguage || {};
  if (Object.keys(langs).length) say(`Languages: ${Object.entries(langs).map(([l, n]) => `${n} ${l === 'typescript' ? 'TypeScript' : 'JavaScript'}`).join(', ')}${map.skippedFiles?.length ? `; skipped ${plural(map.skippedFiles.length, 'file')} (${[...new Set(map.skippedFiles.map(x => x.reason.split(' (')[0]))].join(', ')})` : ''}`);
  const groups = map.rootGroups || [];
  const gname = g => (isMulti(map) ? `${g.codeFolder}:` : '') + (g.dir || g.name);
  wrapList('Entry files: ', groups.map(g => (g.entry ? `${g.entry} (${g.name})` : `${gname(g)}/ has no entry file (${plural(g.fileCount, 'file')})`)));
  const fc = new Map();
  for (const f of ix.files) fc.set(folderOf(f), (fc.get(folderOf(f)) || 0) + 1);
  wrapList('Folders: ', [...fc].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([k, n]) => `${k.endsWith('(root)') ? k.replace('(root)', '(root files)') : `${k}/`} ${n}`), Infinity);
  say('Most imported:');
  for (const f of [...ix.files].sort((a, b) => (b.importedBy || 0) - (a.importedBy || 0) || a.path.localeCompare(b.path)).slice(0, 10)) {
    say(`  ${String(f.importedBy || 0).padStart(3)}  ${f.path}`);
  }
  const rn = ix.screens.filter(s => !s.route), web = ix.screens.filter(s => s.route);
  if (rn.length || !web.length) wrapList(`Screens (${rn.length}): `, [...new Set(rn.map(s => s.name))], Infinity);
  if (web.length) wrapList(`Web routes (${web.length}): `, web.map(s => `${s.name} ${s.file.split('/').pop()}`), Infinity);
  wrapList(`Collections (${ix.collections.length}, all folders): `, [...ix.collections].sort((a, b) => (b.readers + b.writers) - (a.readers + a.writers))
    .map(n => `${n.name} (${n.readers}r/${n.writers}w)`), Infinity);
  if (ix.subs.length) wrapList(`Subcollections (${ix.subs.length}): `, ix.subs.map(n => n.pattern), 12);
  const called = map.functions?.names || {};
  wrapList(`Cloud functions (${fnNames.length}${Object.keys(called).length ? `, ${Object.keys(called).length} called from code` : ''}): `,
    fnNames.map(n => (called[n]?.callers?.length ? `${n} ←${called[n].callers.length}` : n)), Infinity);
  const apps = groups.filter(g => g.entry && g.name === 'app');
  const standalone = groups.filter(g => !g.entry).reduce((s, g) => s + (g.fileCount || 0), 0);
  const noNav = ix.screens.filter(s => !s.incomingNavigation && !s.incomingAsNestedParent).length;
  say(`Not imported from ${apps.map(a => a.entry).join(' / ') || 'the entry file'}: ${apps.length ? apps.reduce((s, a) => s + (a.notImportedFromOwnEntry || 0), 0) : '?'} app files${standalone ? ` (+${standalone} standalone scripts)` : ''} · screens with no incoming navigation: ${noNav} · unresolved: ${(map.unresolved || []).length}`);
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
  const nn = notesOf(P, f.path).length, grp = P.map.groups?.list.find(g => g.id === f.group);
  say(`${f.path}  ${f.lines} lines  folder ${folderOf(f)}${f.rootGroup !== 'app' ? ` (own root: ${f.rootGroup})` : ''}${grp ? `  group ${grp.id}. ${grp.label}` : ''}${nn ? `  ${plural(nn, 'note')} (brainmap notes ${f.path})` : ''}${f.parseError ? '  (could not be parsed)' : ''}`);
  wrapList(`Exports (${(f.exports || []).length}): `, f.exports || [], 20);
  const imp = out.filter(e => IMPORT_KINDS.has(e.kind)), impBy = inn.filter(e => IMPORT_KINDS.has(e.kind));
  const impTo = groupBy(imp, e => e.to), impFrom = groupBy(impBy, e => e.from);
  say(`Imports ${plural(impTo.size, 'file')}${imp.length !== impTo.size ? ` (${imp.length} statements)` : ''}${impTo.size ? ':' : ''}`);
  items([...impTo].map(([p, es]) => `${p}${es.some(e => e.kind !== 'import') ? ` [${[...new Set(es.map(e => e.kind))].join(', ')}]` : ''}`));
  const tOut = [...new Set(out.filter(e => e.kind === 'type-import').map(e => e.to))], tIn = [...new Set(inn.filter(e => e.kind === 'type-import').map(e => e.from))];
  if (tOut.length || tIn.length) say(`Type imports: uses types from ${plural(tOut.length, 'file')}${tOut.length ? ` (${tOut.slice(0, 4).join(', ')}${tOut.length > 4 ? ', …' : ''})` : ''}; its types are used by ${plural(tIn.length, 'file')}`);
  if (f.packages?.length) wrapList('Packages: ', f.packages);
  say(`Imported by ${plural(impFrom.size, 'file')}${impBy.length !== impFrom.size ? ` (${impBy.length} statements)` : ''}${f.reachableFromAppEntry === false && f.rootGroup === 'app' ? ' · not reached from the entry file' : ''}${impFrom.size ? ':' : ''}`);
  items([...impFrom.keys()].sort((a, b) => a.localeCompare(b)));
  const defines = ix.screens.filter(s => s.file === f.path);
  if (defines.length) wrapList(defines.every(s => s.route) ? 'Page of routes: ' : 'Defines screens: ', defines.map(s => (s.route ? s.name : `${s.name} (${s.navigator}${s.parent ? ` in ${s.parent}` : ''})`)));
  const navTo = groupBy(out.filter(e => e.kind === 'navigate'), e => `${e.screen} → ${e.to}`);
  if (navTo.size) { say(`Navigates to ${plural(navTo.size, destWord(out))}:`); items([...navTo].map(([k, es]) => `${k}${linesOf(es)}`)); }
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
  if (calls.size) wrapList('Calls cloud functions: ', [...calls].map(([n, es]) => `${n} (${es[0].to}${es[0].crossFolder ? `, in folder ${es[0].toFolder}` : ''})${linesOf(es)}`));
  const served = groupBy(inn.filter(e => e.kind === 'calls-function'), e => e.function);
  if (served.size) wrapList('Defines called cloud functions: ', [...served].map(([n, es]) => `${n} ←${es.length}${es.some(e => e.crossFolder) ? ` (${es.filter(e => e.crossFolder).length} from ${[...new Set(es.filter(e => e.crossFolder).map(e => e.codeFolder))].join(', ')})` : ''}`));
}

// impact <file:function>: everything that reaches the function through calls, up to 3 levels across files
// (calls inside a file are followed without using up a level), grouped by depth.
function impactFunction(P, ix, file, fn) {
  const nodes = tree(P, file, fn, 3);
  const byDepth = new Map(); // depth -> Map(key -> { e, lines })
  const walk = (ns, d) => { for (const n of ns) {
    const depth = n.e.sameFile ? d : d + 1;
    const k = `${n.e.from}\0${n.e.caller}\0${n.e.sameFile ? 1 : 0}`;
    const m = byDepth.get(depth) || byDepth.set(depth, new Map()).get(depth);
    const g = m.get(k) || m.set(k, { e: n.e, lines: new Set() }).get(k); g.lines.add(n.e.line);
    walk(n.children, depth);
  } };
  walk(nodes, 0);
  const files = new Set([...byDepth.values()].flatMap(m => [...m.values()].map(g => g.e.from)));
  files.delete(file);
  say(`${fn} (${file}): reached through calls from ${plural(files.size, 'other file')} (${[...byDepth.keys()].sort().map(d => `depth ${d}: ${byDepth.get(d).size}`).join(', ') || 'none'}); calls inside a file do not add depth`);
  for (const d of [...byDepth.keys()].sort()) {
    say(d === 0 ? 'Inside its own file:' : d === 1 ? 'Depth 1 (call it directly, or through same-file helpers):' : `Depth ${d}:`);
    items([...byDepth.get(d).values()].sort((a, b) => a.e.from.localeCompare(b.e.from)).map(g => rowText(g)));
  }
}

function impactCmd(P, ix, q) {
  const colon = q.lastIndexOf(':');
  if (colon > 0 && !/^\d+$/.test(q.slice(colon + 1))) {
    const f0 = resolveFile(ix, q.slice(0, colon));
    return impactFunction(P, ix, f0.path, q.slice(colon + 1));
  }
  const f = resolveFile(ix, q);
  const seen = new Map([[f.path, { depth: 0 }]]);
  let frontier = [f.path];
  for (let d = 1; d <= 3 && frontier.length; d++) {
    const next = [];
    for (const p of frontier) {
      for (const e of ix.inn.get(p) || []) {
        if (!(IMPORT_KINDS.has(e.kind) || (TYPES && e.kind === 'type-import')) || seen.has(e.from)) continue;
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
  say(`${f.path}: ${plural(total, 'file')} depend on it through imports${TYPES ? ' and type imports' : ''} (${[1, 2, 3].map(d => `depth ${d}: ${byDepth.get(d)?.length || 0}`).join(', ')})${beyond ? `; more beyond depth 3` : ''}`);
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
  if (!q) die('Give a screen name, a route path or a page file, for example: brainmap screen Home, brainmap screen /clients/:id');
  if (q.startsWith('/')) {
    // A route path, or a concrete path such as /clients/123 (matched to /clients/:clientUid).
    const hits = routesFor(ix.screens, q);
    if (!hits.length) die(`No route matches "${q}". Routes: ${ix.screens.filter(s => s.route).map(s => s.name).slice(0, 30).join(', ') || 'none in this map'}`);
    return hits;
  }
  const page = s => s.file?.split('/').pop().replace(/\.[^.]+$/, '').toLowerCase();
  let hits = ix.screens.filter(s => s.name.toLowerCase() === q.toLowerCase() || s.file?.toLowerCase() === q.toLowerCase().replace(/^\.\//, ''));
  if (!hits.length) hits = ix.screens.filter(s => s.name.toLowerCase() === low || s.component?.toLowerCase() === q.toLowerCase() || s.file?.toLowerCase().endsWith(`/${q.toLowerCase()}`) || (s.route && page(s) === q.toLowerCase()));
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
    say(s.route
      ? `Route ${s.name}: ${s.file || 'no page file found'}  (${s.navigator === 'Next.js' ? 'Next.js file route' : `declared in ${s.navigatorFile}:${s.line}`})`
      : `Screen ${s.name}: ${s.file || 'no file found'}  (${s.navigator || 'navigator'}${s.parent ? ` in ${s.parent}` : ''}, declared in ${s.navigatorFile}:${s.line})`);
  }
  const files = new Set(hits.map(s => s.file).filter(Boolean));
  const folders = new Set(hits.map(s => s.codeFolder)); // navigation never crosses folders
  const from = P.map.edges.filter(e => e.kind === 'navigate' && (names.has(e.screen) || (files.has(e.to) && !e.screen)) && (!e.codeFolder || folders.has(e.codeFolder)));
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
  say(`Navigates to ${plural(to.size, destWord([...to.values()].flat()))}:`);
  items([...to].map(([k, es]) => `${k}${linesOf(es)}`));
  if (!to.size) say('  none found');
}

// ─── notes ───────────────────────────────────────────────────────────────────
const noteRow = n => `${n.file}:${n.line}${n.function ? ` (${n.function})` : ''}  ${n.tag}: ${n.text.replace(new RegExp(`^${n.tag}\\b[\\s:(\\-]*`, 'i'), '')}`;
const notesOf = (P, file, fn) => (P.map.notes || []).filter(n => n.file === file && (fn === undefined || n.function === fn));

function notesCmd(P, ix, q) {
  const all = P.map.notes || [];
  if (!q) {
    if (!ALL) die('Give a file, a function (or file:function), or --all, for example: brainmap notes utils/pendingSessions.js');
    const tags = {}; for (const n of all) tags[n.tag] = (tags[n.tag] || 0) + 1;
    say(`${plural(all.length, 'note')} (${Object.entries(tags).sort((a, b) => b[1] - a[1]).map(([t, c]) => `${c} ${t}`).join(', ')}), by file:`);
    for (const [f, ns] of groupBy(all, n => n.file)) { say(`  ${f} (${ns.length})`); for (const n of ns) say(`    ${noteRow(n).slice(f.length + 1)}`); }
    return;
  }
  let file = null, fn;
  const colon = q.lastIndexOf(':');
  if (colon > 0 && !/^\d+$/.test(q.slice(colon + 1))) { file = resolveFile(ix, q.slice(0, colon)).path; fn = q.slice(colon + 1); }
  else if (all.some(n => n.function === q) && !ix.byPath.has(q)) {
    const hits = all.filter(n => n.function === q);
    const files = [...new Set(hits.map(n => n.file))];
    if (files.length > 1) die(`"${q}" names functions with notes in ${files.length} files; use file:${q}:\n${files.map(f => `  ${f}:${q}`).join('\n')}`);
    file = files[0]; fn = q;
  } else file = resolveFile(ix, q).path;
  const ns = notesOf(P, file, fn);
  say(`${plural(ns.length, 'note')} in ${fn ? `${fn} (${file})` : file}${ns.length ? ':' : ''}`);
  if (!fn) for (const [f, list] of groupBy(ns, n => n.function ?? '(top level)')) { say(`  ${f}`); items(list.map(n => `  line ${n.line}  ${noteRow(n).split('  ').slice(1).join('  ')}`), 12); }
  else items(ns.map(n => `line ${n.line}  ${noteRow(n).split('  ').slice(1).join('  ')}`));
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
    path.conf = path.some(h => h.edges[0].inferred) ? 'inferred (at least one hop was derived by the mapper)' : 'extracted (every hop is written in the code)';
    path.forEach((h, j) => {
      const e = h.edges[0];
      say(`  ${j + 1}. ${h.from} —${e.kind}${e.what ? ` ${e.what}` : ''}→ ${h.to}  (${e.at})${h.loose ? '  [files connect here, but no call reaches the next step]' : ''}${h.cross ? `  [${h.cross}]` : ''}`);
      if (h.edges.length > 1) say(`     also: ${h.edges.slice(1, ALL ? undefined : 3).map(x => `${x.kind}${x.what ? ` ${x.what}` : ''} (${x.at})`).join('; ')}${!ALL && h.edges.length > 3 ? `; +${h.edges.length - 3} more` : ''}`);
    });
    say(`  Confidence: ${path.conf}`);
    const crossings = path.filter(h => h.cross).length;
    if (crossings) say(`  Crosses code folders ${crossings === 1 ? 'once' : `${crossings} times`}: the folders share no code, only ${path.some(h => /shared data/.test(h.cross || '')) ? 'the data' : ''}${path.some(h => /shared data/.test(h.cross || '')) && path.some(h => /cloud function/.test(h.cross || '')) ? ' and ' : ''}${path.some(h => /cloud function/.test(h.cross || '')) ? 'cloud functions' : ''}.`);
  });
}

function queryCmd(P, ix, q) {
  if (!q) die('Ask in words, for example: brainmap query "what saves completed workout sessions"');
  const r = queryMap(P.map, q);
  say(`Terms: ${r.terms.join(', ') || 'none'}${r.dropped.length ? `   (ignored: ${r.dropped.join(', ')})` : ''}`);
  if (!r.matches.length) {
    return say(`Nothing in the map matches those words well enough.${r.best ? ` Try: brainmap find ${r.best}` : ''}`);
  }
  say('Matches:');
  items(r.matches.map((m, i) => `${i + 1}. ${m.label}  [${m.hit.join(', ')}]${m.kind === 'group' ? `  central: ${m.central.join(', ')}` : ''}`), 5);
  const total = r.groups.reduce((n, g) => n + g.edges.length, 0);
  say(`Links around them (${total}):`);
  for (const g of r.groups) {
    say(`  ${g.kind} (${g.edges.length}):`);
    indent(() => items(g.edges.map(e => `${e.between ? '★ ' : ''}${e.from} —${e.kind}${e.what ? ` ${e.what}` : ''}→ ${e.to}  (${e.at})`), 8));
  }
  if (r.paths.length) {
    say('Connecting paths (up to 3 hops):');
    items(r.paths.map(p => [p[0].from, ...p.map(h => `—${h.edge.kind}${h.edge.what ? ` ${h.edge.what}` : ''} (${h.edge.at})→ ${h.to}`)].join(' ')), 4);
  }
  say('Next:');
  items(r.next);
}

const groupName = g => `${g.id}. ${g.label}`;
function groupsCmd(P) {
  const G = P.map.groups;
  if (!G?.list?.length) die('This map has no groups.');
  say(`${plural(G.list.length, 'group')} of related files (${G.algorithm.split(' (')[0]}, seed ${G.seed})${G.isolated.length ? `, plus ${plural(G.isolated.length, 'isolated file')}` : ''}:`);
  items(G.list.map(g => `${groupName(g)}  [${g.root}]  (${plural(g.size, 'file')})  central: ${g.central.join(', ')}`), 30);
  const byId = new Map(G.list.map(g => [g.id, g]));
  say('Strongest links between groups:');
  items(G.links.map(l => `${byId.get(l.a).label}  ↔  ${byId.get(l.b).label}  (weight ${l.weight})`), 8);
  if (G.isolated.length) { say('Isolated (linked to nothing):'); wrapList('  ', G.isolated, 12); }
  say('Next: brainmap group <number or label>');
}

function groupCmd(P, ix, q) {
  const G = P.map.groups;
  if (!G?.list?.length) die('This map has no groups.');
  if (!q) die('Give a group number or label, for example: brainmap group 1  (brainmap groups lists them)');
  const low = q.trim().toLowerCase();
  if (low === 'isolated' || low === '0') { say(`Isolated files (${G.isolated.length}): linked to nothing on any layer`); return items(G.isolated, 30); }
  let hits = /^\d+$/.test(low) ? G.list.filter(g => g.id === Number(low)) : G.list.filter(g => g.label.toLowerCase() === low);
  if (!hits.length) hits = G.list.filter(g => g.label.toLowerCase().includes(low) || g.terms.some(t => t === low || low.split(/\s+/).includes(t)));
  if (!hits.length) die(`No group matches "${q}". Groups: ${G.list.map(groupName).join('; ')}`);
  if (hits.length > 1) die(`"${q}" matches ${hits.length} groups: ${hits.map(groupName).join('; ')}`);
  const g = hits[0], members = new Set(g.files);
  say(`Group ${groupName(g)}: ${plural(g.size, 'file')}; words: ${g.terms.join(', ')}`);
  say(`Central files: ${g.central.join(', ')}`);
  say(`Files by folder:`);
  groupedByFolder(ix, g.files.map(f => ({ file: f, text: f })), 40);
  wrapList(`Collections (${g.collections.length}): `, g.collections, 12);
  // Which groups its files use (imports, calls, navigation), and which use it.
  const fileGroup = new Map(P.map.nodes.filter(n => n.kind === 'file').map(n => [n.id, n.group]));
  const out = new Map(), inn = new Map();
  for (const e of P.map.edges) {
    if (!['import', 'require', 're-export', 'dynamic', 'calls', 'navigate', 'calls-function'].includes(e.kind) || e.sameFile) continue;
    const a = fileGroup.get(e.from), b = fileGroup.get(e.to);
    if (a === undefined || b === undefined || a === b) continue;
    if (members.has(e.from)) out.set(b, (out.get(b) || 0) + 1);
    if (members.has(e.to)) inn.set(a, (inn.get(a) || 0) + 1);
  }
  const byId = new Map(G.list.map(x => [x.id, x]));
  const row = ([id, n]) => `${byId.get(id) ? groupName(byId.get(id)) : 'isolated'}  (${plural(n, 'link')})`;
  say('Depends on (links from this group into others):');
  items([...out].sort((a, b) => b[1] - a[1]).map(row));
  say('Used by (links from other groups into this one):');
  items([...inn].sort((a, b) => b[1] - a[1]).map(row));
}

function reportCmd(P) {
  const r = computeReport(P.map);
  const kinds = o => Object.entries(o.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
  say(`Report for ${P.slug}${P.only ? `, folder ${P.only}` : ''} (map from ${when(P.map.generatedAt)}); links = imports, calls, navigation, cloud functions, reads, writes.`);
  say('Most depended-on files (incoming links):');
  items(r.dependedOn.map(x => `${String(x.total).padStart(4)}  ${x.file}  (${kinds(x)})`));
  say('Most dependent files (outgoing links):');
  items(r.dependent.map(x => `${String(x.total).padStart(4)}  ${x.file}  (${kinds(x)})`));
  say('Most-called functions (calling files):');
  items(r.functions.map(x => `${String(x.files).padStart(4)}  ${x.fn}  ${x.file}  (${plural(x.calls, 'call')}${x.same ? `, +${x.same} in its own file` : ''})`));
  say('Busiest data (reader + writer files):');
  items(r.data.map(x => `${String(x.total).padStart(4)}  ${x.name}  (${x.readers} read, ${x.writers} write${x.kind === 'subcollection' ? ', subcollection' : ''})`));
  say('Bridges (removing the file splits the import graph):');
  items(r.bridges.length ? r.bridges.map(x => `${x.file}  cuts off ${plural(x.cutOff, 'file')} (parts: ${x.parts.slice(0, 5).join(', ')}${x.parts.length > 5 ? ', …' : ''})`) : ['none']);
  say('Rare links (between folders joined by fewer than 3 links):');
  items(r.surprising.length ? r.surprising.map(x => `${x.from} —${x.kind}${x.what ? ` ${x.what}` : ''}→ ${x.to}  (${x.from}:${x.line ?? '?'}; ${x.folders.join(' ↔ ')}: ${plural(x.pairLinks, 'link')})`) : ['none']);
  const c = r.confidence;
  say(`Links by confidence: ${c.byTag.extracted} extracted, ${c.byTag.inferred} inferred${Object.keys(c.byWhy).length ? ` (${Object.entries(c.byWhy).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${n} ${w}`).join(', ')})` : ''}`);
  if (Object.keys(r.noteTags).length) say(`Notes: ${Object.entries(r.noteTags).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${n} ${t}`).join(', ')} (brainmap notes --all)`);
  if (P.map.groups?.list?.length) {
    say(`Groups (related files; brainmap groups):`);
    items(P.map.groups.list.map(g => `${groupName(g)}  (${g.size})  central: ${g.central[0]}`), 12);
  }
  say('Suggested next questions:');
  items(r.questions.map(q => `${q.cmd}   # ${q.why}`));
}

// The part of report that only a project with several code folders has: data both sides touch, from where, and
// cloud function calls from one folder into another.
function crossFolderCmd(P, ix) {
  const r = crossFolder(P.map);
  say(`=== Across folders (${folderNames(P.map).join(', ')}): the folders share no imports or calls; they meet in the data and in cloud functions`);
  say(`Shared collections and subcollections (${r.data.length}), with the files that touch them on each side:`);
  const shown = ALL ? r.data : r.data.slice(0, LIST);
  for (const d of shown) {
    say(`  ${d.name}${d.kind === 'subcollection' ? ' (subcollection)' : ''}`);
    for (const f of d.byFolder) {
      const list = (k, xs) => (xs.length ? `${k} ${xs.length}: ${xs.slice(0, ALL ? undefined : 4).map(x => x.slice(f.folder.length + 1)).join(', ')}${!ALL && xs.length > 4 ? `, +${xs.length - 4}` : ''}` : `${k} 0`);
      say(`    ${f.folder}: ${list('read by', f.readers)}; ${list('written by', f.writers)}${f.unknown ? `; ${f.unknown} unknown` : ''}`);
    }
  }
  if (shown.length < r.data.length) say(`  (+${r.data.length - shown.length} more, use --all)`);
  for (const [k, cols] of Object.entries(r.only)) wrapList(`Collections only ${k} touches (${cols.length}): `, cols, 15);
  say(`Cloud function calls into another folder (${r.calls.length}):`);
  items(r.calls.length ? r.calls.map(c => `${c.from}:${c.line} → ${c.function}  (defined in ${c.to})`) : ['none']);
  say('Next: brainmap collection <name> (readers and writers by folder) | brainmap path <file in one folder> <file in the other>');
}

// ─── function calls ──────────────────────────────────────────────────────────
// Call edges into a function: the exported name or the local name it has in its own file.
const callsTo = (ix, file, fn) => (ix.inn.get(file) || []).filter(e => e.kind === 'calls' && (e.function === fn || e.local === fn || e.export === fn));
let CIDX = null;
const tree = (P, file, fn, depth) => callerTree(P.map, file, fn, depth, (CIDX ??= callIndex(P.map)));

// Sibling callers merged per calling file and function (and per value hand-over), with their lines.
function mergeNodes(nodes) {
  const by = new Map();
  for (const n of nodes) {
    const e = n.e, k = `${e.from}\0${e.caller}\0${e.sameFile ? 1 : 0}\0${e.via === 'value' ? `${e.passedFrom}:${e.passedLine}` : ''}`;
    const g = by.get(k) || by.set(k, { e, lines: new Set(), children: [] }).get(k);
    g.lines.add(e.line);
    if (!g.children.length) g.children = n.children;
  }
  return [...by.values()].sort((x, y) => (x.e.sameFile ? 1 : 0) - (y.e.sameFile ? 1 : 0) || x.e.from.localeCompare(y.e.from) || String(x.e.caller).localeCompare(String(y.e.caller)));
}
const rowText = g => {
  const ls = [...g.lines].sort((x, y) => x - y);
  return `${g.e.from} (line${ls.length > 1 ? 's' : ''} ${ls.slice(0, 6).join(', ')}${ls.length > 6 ? ', …' : ''})${g.e.caller ? ` in ${g.e.caller}` : ' at top level'}`
    + `${g.e.sameFile ? ', same file' : ''}${g.e.via === 'value' ? `, via value from ${g.e.passedFrom}:${g.e.passedLine}` : ''}${g.e.tag === 'inferred' && g.e.via !== 'value' ? ` [inferred: ${g.e.why}]` : g.e.via === 'value' ? ' [inferred]' : ''}`;
};
// Callers of callers, indented with "←".
function sayTree(nodes, pad, limit = 4) {
  const gs = mergeNodes(nodes), shown = ALL ? gs : gs.slice(0, limit);
  for (const g of shown) { say(`${pad}← ${rowText(g)}`); sayTree(g.children, `${pad}  `); }
  if (shown.length < gs.length) say(`${pad}  (+${gs.length - shown.length} more, use --all)`);
}
// Top level of a caller tree: other files by folder, then calls inside the function's own file.
function sayCallers(ix, nodes, limit) {
  const gs = mergeNodes(nodes), other = gs.filter(g => !g.e.sameFile), same = gs.filter(g => g.e.sameFile);
  const byFolder = groupBy(other, g => folderLabel(ix.byPath.get(g.e.from)));
  let shown = 0;
  for (const k of [...byFolder.keys()].sort(headingOrder)) {
    if (!ALL && shown >= limit) break;
    say(`  ${k} (${byFolder.get(k).length})`);
    for (const g of byFolder.get(k)) { if (!ALL && shown >= limit) break; say(`    ${rowText(g)}`); sayTree(g.children, '      '); shown++; }
  }
  if (shown < other.length) say(`  (+${other.length - shown} more, use --all)`);
  if (same.length) {
    say('  inside its own file:');
    for (const g of ALL ? same : same.slice(0, limit)) { say(`    ${rowText(g)}`); sayTree(g.children, '      '); }
    if (!ALL && same.length > limit) say(`    (+${same.length - limit} more, use --all)`);
  }
}
// "← 3 files", "← 2 files, and 4 places in its own file", "← called only inside its own file (4 places)".
function callerSummary(nodes) {
  const other = new Set(nodes.filter(n => !n.e.sameFile).map(n => n.e.from)), same = nodes.filter(n => n.e.sameFile).length;
  if (other.size) return `${plural(other.size, 'file')}${same ? `, and ${plural(same, 'place')} in its own file` : ''}`;
  return same ? `called only inside its own file (${plural(same, 'place')})` : 'no calls found';
}

// "Through functions": the named functions that read or write a collection, and who calls them. Calls inside
// a file are followed for free; --depth 2 adds one more level of callers in other files.
function throughFunctions(P, ix, dataEdges) {
  const fns = new Map(); // file\0function -> { file, fn, ops }
  for (const e of dataEdges) for (const st of e.sites || []) {
    if (!st.function) continue;
    const k = `${e.from}\0${st.function}`;
    (fns.get(k) || fns.set(k, { file: e.from, fn: st.function, ops: new Set() }).get(k)).ops.add(e.kind === 'reads' ? 'reads' : 'writes');
  }
  const list = [...fns.values()].sort((a, b) => a.file.localeCompare(b.file) || a.fn.localeCompare(b.fn)).map(f => ({ ...f, nodes: tree(P, f.file, f.fn, DEPTH) }));
  // Every other file anywhere in the caller trees (calls inside a file are followed to the files beyond).
  const callerFiles = new Set();
  const walk = (ns, own) => { for (const n of ns) { if (n.e.from !== own) callerFiles.add(n.e.from); walk(n.children, own); } };
  for (const f of list) walk(f.nodes, f.file);
  say(`Through functions: ${plural(list.length, 'function')} read or write it, reached from ${plural(callerFiles.size, 'other file')}${DEPTH === 1 ? ' (--depth 2 adds their callers)' : ''}`);
  const many = list.length > 6;
  const shownFns = ALL ? list : list.slice(0, many ? 8 : 12);
  for (const f of shownFns) {
    say(`  ${f.fn} (${f.file}, ${[...f.ops].join(' and ')}) ← ${callerSummary(f.nodes)}`);
    if (f.nodes.length) indent(() => sayCallers(ix, f.nodes, many ? 3 : 6));
    const passed = ix.unresolvedCalls.filter(u => u.target === f.file && u.name === f.fn);
    if (passed.length) say(`    also passed on as a value, not followed: ${passed.map(u => `${u.file}:${u.line}`).join(', ')}`);
  }
  if (shownFns.length < list.length) say(`  (+${list.length - shownFns.length} more functions, use --all)`);
}

// Runs fn with its output indented by two more spaces.
function indent(fn) {
  const start = lines.length;
  fn();
  for (let i = start; i < lines.length; i++) lines[i] = `  ${lines[i]}`;
}

function callersCmd(P, ix, q) {
  if (!q) die('Give a function name, or file:name (any function defined in that file), for example: brainmap callers logWorkout');
  let file = null, name = q;
  const colon = q.lastIndexOf(':');
  if (colon > 0) { file = resolveFile(ix, q.slice(0, colon)).path; name = q.slice(colon + 1); }
  const all = P.map.edges.filter(e => e.kind === 'calls' && (e.function === name || e.local === name || e.export === name) && (!file || e.to === file));
  const byTarget = groupBy(all, e => e.to);
  const passed = (P.map.unresolved || []).filter(u => u.kind === 'call' && u.name === name && (!file || u.target === file));
  if (!byTarget.size) {
    const defined = ix.files.filter(f => (f.exports || []).includes(name) && (!file || f.path === file)).map(f => f.path);
    say(defined.length
      ? `${name} (exported by ${defined.join(', ')}): no calls found, in other files or its own.`
      : `No function "${name}"${file ? ` in ${file}` : ''} is called anywhere in the map.${file ? '' : ' Try brainmap find, or file:name for a function that is not exported.'}`);
  }
  if (byTarget.size > 1) say(`"${name}" matches ${byTarget.size} functions: ${[...byTarget.keys()].map(t => `${t}:${name}`).join(', ')}`);
  for (const [target, es] of byTarget) {
    if (byTarget.size > 1) say('');
    const nodes = tree(P, target, name, DEPTH);
    const other = es.filter(e => !e.sameFile), same = es.length - other.length;
    const nn = notesOf(P, target, name).length;
    if (nn) say(`${name} has ${plural(nn, 'note')}: brainmap notes ${target}:${name}`);
    say(other.length
      ? `${name} (${target}): ${plural(other.length, 'call')} from ${plural(new Set(other.map(e => e.from)).size, 'file')}${same ? `, ${plural(same, 'call')} inside its own file` : ''}${DEPTH > 1 ? `, callers to depth ${DEPTH}` : ''}, by folder:`
      : `${name} (${target}): called only inside its own file (${plural(same, 'place')})${DEPTH > 1 ? `, callers to depth ${DEPTH}` : ''}:`);
    sayCallers(ix, nodes, byTarget.size > 1 ? 10 : 25);
  }
  if (passed.length) {
    say(`Also passed on as a value, so its calls cannot be followed (${passed.length}):`);
    items(passed.map(u => `${u.file}:${u.line}`));
  }
}

// The folder a file is listed under: its own root (functions/, scripts/) or its top-level app folder.
const folderLabel = f => (!f ? '?' : cfPrefix(f) + (f.rootGroup !== 'app' ? `${f.rootGroup}/` : f.topFolder === '(root)' ? '(root files)' : `${f.topFolder}/`));
// Folder headings in order: by code folder (the folder's name comes first), then app folders before the separate
// roots (functions/, scripts/), then by name.
const headingOrder = (a, b) => {
  const cf = k => (/^[a-z0-9_-]+:/.test(k) ? k.slice(0, k.indexOf(':')) : '');
  const rank = k => (/(^|:)(functions|scripts)\/$/.test(k) ? 1 : 0);
  return cf(a).localeCompare(cf(b)) || rank(a) - rank(b) || a.localeCompare(b);
};

// Lines grouped under folder headings, cut after `limit` lines in all with "(+N more, use --all)".
function groupedByFolder(ix, rows, limit = 15) {
  const by = groupBy(rows, r => folderLabel(ix.byPath.get(r.file)));
  const order = [...by.keys()].sort(headingOrder);
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
    if (isMulti(P.map)) {
      const by = Object.entries(n.byFolder || {});
      say(`Touched by ${by.length === 1 ? `only the ${by[0][0]} folder` : `${by.length} folders (shared data)`}: ${by.map(([k, v]) => `${k} (${v.readers} read, ${v.writers} write${v.unknown ? `, ${v.unknown} unknown` : ''})`).join('; ')}`);
    }
    if (!sub) {
      const children = ix.subs.filter(x => x.parent === n.name);
      if (children.length) wrapList(`Counts include its ${plural(children.length, 'subcollection')}: `, children.map(x => `${x.pattern} (${x.readers}r/${x.writers}w)`), 10);
    }
    wrapList(`Paths (${(n.paths || []).length}): `, n.paths || [], 8);
    const es = ix.inn.get(n.id) || [];
    for (const kind of ['writes', 'reads']) {
      const list = es.filter(e => e.kind === kind);
      say(`${kind === 'writes' ? 'Written by' : 'Read by'} ${plural(list.length, 'file')}${list.length ? ', by folder:' : ''}`);
      groupedByFolder(ix, list.map(e => ({ file: e.from, text: `${e.from}  ${plural(e.count || 1, 'use')}${linesOf([e])}${e.tag === 'inferred' ? `  [inferred: ${e.why}]` : ''}` })), hits.length > 1 ? 10 : 15);
    }
    if (unknown.length) {
      say(`Read or write unknown (${unknown.length}), by folder:`);
      groupedByFolder(ix, unknown.map(u => ({ file: u.file, text: `${u.file}:${u.line}${u.function ? ` (in ${u.function})` : ''}  ${u.path || ''}` })), 10);
    }
    throughFunctions(P, ix, es);
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
  say(`Called from ${plural(by.size, 'file')}${isMulti(P.map) ? ', by folder' : ''}:`);
  items([...by].sort((a, b) => headingOrder(a[0], b[0])).map(([p, es]) => `${p}${linesOf(es)}${es[0].crossFolder ? `  [from another folder: ${es[0].codeFolder} → ${es[0].toFolder}]` : ''}`), 20);
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
  for (const g of groups.filter(g => !g.entry)) say(`${g.codeFolder && P.only ? `${g.codeFolder}:` : ''}${g.dir || g.name}/: ${plural(g.fileCount, 'file')} with no entry file (standalone scripts, run by hand); not listed`);
  const noNav = ix.screens.filter(s => !s.incomingNavigation && !s.incomingAsNestedParent);
  say(`Screens with no incoming navigation found: ${noNav.length}`);
  items(noNav.map(s => `${s.name}${s.parent ? ` (in ${s.parent})` : ''}  ${s.file || 'no file'}`), 20);
  say('"Not found" means the map saw no link; code can still be used in ways the map does not see (computed names, other languages).');
}

// ─── main ────────────────────────────────────────────────────────────────────
// Commands answered per code folder when the project links several (unless --folder picks one).
const PER_FOLDER = new Set(['report', 'groups', 'query', 'unused']);
const COMMANDS = { notes: notesCmd, groups: groupsCmd, group: groupCmd, query: queryCmd, path: pathCmd, report: reportCmd, callers: callersCmd, overview, files: filesCmd, file: fileCmd, impact: impactCmd, screen: screenCmd, collection: collectionCmd, function: functionCmd, find: findCmd, unused: unusedCmd };

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
  TYPES = !!opts.types;
  const P = await loadProject(opts);
  const arg = cmd === 'path' ? rest : rest.join(' ');  // query takes the words, quoted or not
  if (PER_FOLDER.has(cmd) && isMulti(P.map)) {
    // Computed for each code folder on its own; groups never span folders.
    for (const name of folderNames(P.map)) {
      const F = { ...P, map: forFolder(P.map, name), only: name };
      say(`=== Folder ${name} (${tilde(F.map.project.path)})`);
      CIDX = null;
      run(F, index(F.map), arg);
      say('');
    }
    CIDX = null;
    if (cmd === 'report') crossFolderCmd(P, index(P.map));
  } else run(P, index(P.map), arg);
  flush();
}

main().catch(e => die(`brainmap: ${e.message}`));
