// "Find my projects": finds code projects in the home folder and drafts brain proposals for the ones the person
// ticks. No AI: only file names, git facts and, after ticking, a few lines of each project's README and manifest.
//
// Scan (before anything is ticked): directory listings (names only) and git metadata. No file is opened.
//   - The home folder to depth 4. A project is a folder with .git or a marker file (MARKERS); a project's own
//     subfolders are not searched further.
//   - Skipped: hidden folders, Library, node_modules and other dependency or build folders, the brain, and the
//     folders macOS keeps from background jobs (Desktop, Documents, Downloads; iCloud Drive and cloud storage are
//     inside Library). The app runs as a LaunchAgent, so these are never opened; the result says which were skipped.
//   - Yours or not: commits whose author email or name is one of the person's git identities (git config user.name
//     and user.email, global and per repository). A repository with commits but none of them yours is a clone.
// Drafts (after ticking): state.md and context.md per project, from the README's first lines, the manifest's name,
// description and dependencies, and the last ten commit subjects. Each says it was drafted from those files.
import { readdir, readFile, stat, realpath } from 'fs/promises';
import { execFile } from 'child_process';
import { homedir } from 'os';
import { join, basename, extname } from 'path';
import { localDate } from './local-date.js';

const HOME = homedir();
export const MARKERS = ['package.json', 'pyproject.toml', 'requirements.txt', 'Package.swift', 'Cargo.toml', 'go.mod', 'index.html'];
const MAX_DEPTH = 4;
// macOS keeps background jobs out of these (they would fail with "Operation not permitted"): never opened.
export const PROTECTED = ['Desktop', 'Documents', 'Downloads'];
const SKIP_HOME = new Set(['Library', 'Applications', 'Music', 'Movies', 'Pictures', 'Public', ...PROTECTED]);
const SKIP_ANY = new Set(['node_modules', 'bower_components', 'vendor', 'Pods', 'Carthage', 'venv', 'env', 'site-packages',
  '__pycache__', 'build', 'dist', 'target', 'DerivedData', 'Library']);
const RECENT_DAYS = 90;
export const RECENT_UNKNOWN = 5; // ticked by default when the git identity is not set
const BLOCKED = 'macOS does not let the Brain app read this folder (it runs in the background). Move the project out of Desktop, Documents, Downloads or iCloud Drive, for example to ~/Projects, then add that folder.';
const LANG = {
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript',
  py: 'Python', ipynb: 'Jupyter', swift: 'Swift', rs: 'Rust', go: 'Go', html: 'HTML', htm: 'HTML', css: 'CSS',
  scss: 'CSS', java: 'Java', kt: 'Kotlin', rb: 'Ruby', php: 'PHP', c: 'C', h: 'C', cpp: 'C++', cc: 'C++',
  hpp: 'C++', cs: 'C#', dart: 'Dart', vue: 'Vue', svelte: 'Svelte', sh: 'Shell', m: 'Objective-C', lua: 'Lua',
};
const tilde = p => (p === HOME || p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
const expand = p => String(p || '').trim().replace(/^~(?=$|\/)/, HOME);
export const slugFor = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';

function git(dir, args, maxBuffer = 16 * 1024 * 1024) {
  return new Promise(res => execFile('git', ['--no-optional-locks', '-C', dir, ...args],
    { timeout: 15_000, maxBuffer, encoding: 'utf8' }, (err, out) => res(err ? null : out)));
}
let hasGit = null;
const gitAvailable = () => (hasGit !== null ? Promise.resolve(hasGit)
  : new Promise(res => execFile('xcode-select', ['-p'], { timeout: 5000 }, err => res((hasGit = !err)))));

// The person's git identities: global user.name and user.email (a repository's own are added per repository).
async function identities() {
  const out = await git(HOME, ['config', '--global', '--get-all', 'user.email']);
  const names = await git(HOME, ['config', '--global', '--get-all', 'user.name']);
  const list = s => (s || '').split('\n').map(x => x.trim().toLowerCase()).filter(Boolean);
  return { emails: list(out), names: list(names) };
}

// Folders that hold a .git or a marker, by names only. Returns { projects: [path], skipped: [{ path, reason }] }.
async function walk(root, { brain, depth0 = 0, maxDepth = MAX_DEPTH }) {
  const projects = [], skipped = [];
  async function visit(dir, depth) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (e) { const denied = e.code === 'EPERM' || e.code === 'EACCES'; skipped.push({ path: tilde(dir), denied, reason: denied ? 'macOS did not let the Brain app read it' : e.message }); return; }
    const names = new Set(entries.map(e => e.name));
    if (depth > 0) { // the starting folder itself is never a candidate here
      if (names.has('.git') || MARKERS.some(m => names.has(m))) { projects.push(dir); return; }
    }
    if (depth >= maxDepth) return;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink() || e.name.startsWith('.')) continue;
      const child = join(dir, e.name);
      if (dir === HOME && SKIP_HOME.has(e.name)) continue;
      if (SKIP_ANY.has(e.name)) continue;
      if (brain && child.toLowerCase() === brain.toLowerCase()) continue;
      await visit(child, depth + 1);
    }
  }
  await visit(root, depth0);
  return { projects, skipped };
}

// Main languages by file count, from file names only (git ls-files, or a walk of names for a folder without git).
async function languages(dir, isRepo) {
  let files = [];
  if (isRepo) files = ((await git(dir, ['ls-files', '-z'], 64 * 1024 * 1024)) || '').split('\0').filter(Boolean);
  if (!files.length) {
    const walkNames = async (d, rel, depth) => {
      if (depth > 6 || files.length > 20000) return;
      let es; try { es = await readdir(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        if (e.name.startsWith('.') || SKIP_ANY.has(e.name)) continue;
        if (e.isDirectory() && !e.isSymbolicLink()) await walkNames(join(d, e.name), `${rel}${e.name}/`, depth + 1);
        else if (e.isFile()) files.push(rel + e.name);
      }
    };
    await walkNames(dir, '', 0);
  }
  const count = {};
  for (const f of files) {
    if (/(^|\/)(node_modules|vendor|dist|build)\//.test(f)) continue;
    const l = LANG[extname(f).slice(1).toLowerCase()];
    if (l) count[l] = (count[l] || 0) + 1;
  }
  return Object.entries(count).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, files]) => ({ name, files }));
}

// Git facts of one folder: commits, yours, last dates. Metadata only (git log), never file contents.
async function gitFacts(dir, ids) {
  const local = await git(dir, ['config', '--local', '--get-all', 'user.email']);
  const emails = new Set([...ids.emails, ...(local || '').split('\n').map(x => x.trim().toLowerCase()).filter(Boolean)]);
  const names = new Set(ids.names);
  const log = await git(dir, ['log', '--no-merges', '--format=%ae%x1f%an%x1f%ct', '-n', '20000'], 64 * 1024 * 1024);
  if (log === null) return { commits: 0, own: 0, lastCommit: null, lastOwnCommit: null };
  let commits = 0, own = 0, last = 0, lastOwn = 0;
  for (const line of log.split('\n')) {
    if (!line) continue;
    const [email, name, ct] = line.split('\x1f');
    const t = Number(ct) * 1000;
    commits++;
    if (t > last) last = t;
    if (emails.has(email.toLowerCase()) || names.has(name.toLowerCase())) { own++; if (t > lastOwn) lastOwn = t; }
  }
  return { commits, own, lastCommit: last ? new Date(last).toISOString() : null, lastOwnCommit: lastOwn ? new Date(lastOwn).toISOString() : null };
}

async function brainProjects(brain) {
  const out = new Set();
  for (const side of ['projects', 'archive']) {
    try { for (const e of await readdir(join(brain, side), { withFileTypes: true })) if (e.isDirectory()) out.add(e.name.toLowerCase()); } catch { }
  }
  return out;
}

// Paths already linked to a brain project in ~/.brain/code-folders.json (read as data, not a project file).
async function linkedPaths() {
  try {
    const d = JSON.parse(await readFile(join(HOME, '.brain', 'code-folders.json'), 'utf8'));
    return new Set(Object.values(d).flatMap(v => (Array.isArray(v) ? v.map(f => f.path) : [v])).filter(Boolean));
  } catch { return new Set(); }
}

// One folder → a checklist row.
async function describe(dir, ctx) {
  let isRepo = false;
  try { await stat(join(dir, '.git')); isRepo = true; } catch { }
  const facts = isRepo && ctx.git ? await gitFacts(dir, ctx.ids) : { commits: 0, own: 0, lastCommit: null, lastOwnCommit: null };
  const name = basename(dir), slug = slugFor(name);
  const recent = facts.lastOwnCommit && (Date.now() - Date.parse(facts.lastOwnCommit)) < RECENT_DAYS * 864e5;
  let kind;
  if (ctx.brainSlugs.has(slug) || ctx.linked.has(dir)) kind = 'in-brain';
  else if (!isRepo) kind = 'no-git';
  else if (!ctx.git) kind = 'git-unavailable';
  else if (!facts.commits) kind = 'no-commits';
  else if (!ctx.ids.emails.length && !ctx.ids.names.length) kind = 'unknown-author';
  else if (!facts.own) kind = 'clone';
  else kind = recent ? 'yours-active' : 'yours-old';
  return { name, slug, path: dir, display: tilde(dir), kind, ticked: kind === 'yours-active', isRepo, ...facts, languages: await languages(dir, isRepo) };
}

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; out[k] = await fn(items[k]); } }));
  return out;
}

// The whole scan. extra: folders the person typed ("Add a folder"), searched the same way to depth 4 below them.
export async function scanProjects({ brain, extra = [] } = {}) {
  const t0 = Date.now();
  const brainReal = brain ? await realpath(brain).catch(() => brain) : null;
  const ctx = { git: await gitAvailable(), ids: { emails: [], names: [] }, brainSlugs: brain ? await brainProjects(brain) : new Set(), linked: await linkedPaths() };
  if (ctx.git) ctx.ids = await identities();
  const found = await walk(HOME, { brain: brainReal });
  const added = [];
  for (const p of extra) {
    const abs = expand(p);
    if (!abs.startsWith('/')) { added.push({ path: p, error: 'Give a full path, for example ~/Code/my-app.' }); continue; }
    try { if (!(await stat(abs)).isDirectory()) throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' }); }
    catch (e) { added.push({ path: tilde(abs), error: e.code === 'ENOENT' ? 'There is no folder there.' : e.code === 'EPERM' || e.code === 'EACCES' ? BLOCKED : e.message }); continue; }
    const r = await walk(abs, { brain: brainReal, depth0: 0, maxDepth: MAX_DEPTH });
    // The typed folder itself may be the project.
    const self = (await readdir(abs).catch(() => [])).some(n => n === '.git' || MARKERS.includes(n));
    const list = self ? [abs] : r.projects;
    const denied = r.skipped.find(x => x.path === tilde(abs) && x.denied);
    added.push({ path: tilde(abs), found: list.length, error: !list.length && denied ? BLOCKED : !list.length && r.skipped[0] ? r.skipped[0].reason : null });
    found.projects.push(...list);
    found.skipped.push(...r.skipped);
  }
  const unique = [...new Set(found.projects)];
  const rows = await pool(unique, 8, d => describe(d, ctx));
  const order = { 'yours-active': 0, 'yours-old': 1, 'no-git': 2, 'no-commits': 3, 'unknown-author': 4, 'git-unavailable': 5, clone: 6, 'in-brain': 7 };
  rows.sort((a, b) => order[a.kind] - order[b.kind] || String(b.lastOwnCommit || b.lastCommit || '').localeCompare(String(a.lastOwnCommit || a.lastCommit || '')) || a.name.localeCompare(b.name));
  // Without a git name and email nothing is "yours", so the five most recently committed projects are ticked instead.
  const noIdentity = ctx.git && !ctx.ids.emails.length && !ctx.ids.names.length;
  if (noIdentity) rows.filter(x => x.kind === 'unknown-author' && x.lastCommit)
    .sort((a, b) => b.lastCommit.localeCompare(a.lastCommit)).slice(0, RECENT_UNKNOWN).forEach(x => { x.ticked = true; });
  let home = [];
  try { home = await readdir(HOME); } catch { }
  return {
    ms: Date.now() - t0,
    identity: ctx.ids, git: ctx.git, noIdentity,
    protectedSkipped: [...PROTECTED.filter(n => home.includes(n)).map(n => `~/${n}`), '~/Library (iCloud Drive and cloud storage folders are inside it)'],
    otherSkipped: found.skipped,
    added,
    rows,
  };
}

// ─── drafts, only for ticked folders ─────────────────────────────────────────
const firstLines = (text, n) => text.replace(/\r\n?/g, '\n').split('\n')
  .filter(l => l.trim() && !/^\s*(<|!\[|\[!\[|```)/.test(l)) // skip HTML, images, badges, fences
  .slice(0, n).map(l => l.trimEnd().slice(0, 200));

async function readSmall(p, max = 64 * 1024) {
  try { const s = await stat(p); if (!s.isFile() || s.size > 1024 * 1024) return null; return (await readFile(p, 'utf8')).slice(0, max); } catch { return null; }
}

// { file, name, description, dependencies: [] } from the first manifest found.
async function manifest(dir) {
  const pkg = await readSmall(join(dir, 'package.json'));
  if (pkg) { try { const j = JSON.parse(pkg); return { file: 'package.json', name: j.name, description: j.description, dependencies: [...Object.keys(j.dependencies || {}), ...Object.keys(j.devDependencies || {})] }; } catch { } }
  const py = await readSmall(join(dir, 'pyproject.toml'));
  if (py) {
    const sect = (py.match(/^\[(?:project|tool\.poetry)\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m) || [])[1] || '';
    const val = k => (sect.match(new RegExp(`^${k}\\s*=\\s*["']([^"']*)["']`, 'm')) || [])[1];
    const deps = ((sect.match(/^dependencies\s*=\s*\[([\s\S]*?)\]/m) || [])[1] || '').match(/["']([A-Za-z0-9_.-]+)/g)?.map(s => s.slice(1)) || [];
    return { file: 'pyproject.toml', name: val('name'), description: val('description'), dependencies: deps };
  }
  const req = await readSmall(join(dir, 'requirements.txt'));
  if (req !== null) return { file: 'requirements.txt', dependencies: req.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#') && !l.startsWith('-')).map(l => l.split(/[<>=!~;\[ ]/)[0]) };
  const cargo = await readSmall(join(dir, 'Cargo.toml'));
  if (cargo) {
    const pkgSect = (cargo.match(/^\[package\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m) || [])[1] || '';
    const deps = ((cargo.match(/^\[dependencies\]([\s\S]*?)(?=^\[|$(?![\s\S]))/m) || [])[1] || '').split('\n').map(l => (l.match(/^([A-Za-z0-9_-]+)\s*=/) || [])[1]).filter(Boolean);
    return { file: 'Cargo.toml', name: (pkgSect.match(/^name\s*=\s*"([^"]*)"/m) || [])[1], description: (pkgSect.match(/^description\s*=\s*"([^"]*)"/m) || [])[1], dependencies: deps };
  }
  const gomod = await readSmall(join(dir, 'go.mod'));
  if (gomod) return { file: 'go.mod', name: (gomod.match(/^module\s+(\S+)/m) || [])[1], dependencies: [...gomod.matchAll(/^\s*([a-z0-9.\-/]+\.[a-z]+\/\S+)\s+v/gm)].map(m => m[1]) };
  const swift = await readSmall(join(dir, 'Package.swift'));
  if (swift) return { file: 'Package.swift', name: (swift.match(/name:\s*"([^"]+)"/) || [])[1], dependencies: [...swift.matchAll(/\.package\(\s*url:\s*"([^"]+)"/g)].map(m => m[1].replace(/\.git$/, '').split('/').pop()) };
  return null;
}

async function readme(dir) {
  let names = [];
  try { names = await readdir(dir); } catch { }
  const f = names.find(n => /^readme(\.(md|markdown|txt|rst))?$/i.test(n));
  if (!f) return null;
  const text = await readSmall(join(dir, f), 16 * 1024);
  return text === null ? null : { file: f, lines: firstLines(text, 12) };
}

const day = iso => (iso ? localDate(iso) : null); // the local day, not the UTC one
const quote = lines => lines.map(l => `> ${l.replace(/^#+\s*/, '')}`).join('\n');
const oneLine = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 300);

// The two proposals for one ticked folder, in the UPDATE PROTOCOL format the Inbox already reads.
export async function draftProject(dir, today) {
  const row = await describe(dir, { git: await gitAvailable(), ids: await identities(), brainSlugs: new Set(), linked: new Set() });
  const rd = await readme(dir), mf = await manifest(dir);
  const subjects = row.isRepo ? ((await git(dir, ['log', '-n', '10', '--format=%s'])) || '').split('\n').map(oneLine).filter(Boolean) : [];
  const list = [rd && rd.file, mf && mf.file, subjects.length && 'the last ten commit subjects'].filter(Boolean);
  const sources = list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list.join('');
  const label = `Drafted by the Brain app ("Find my projects") from ${sources || 'the folder listing only'} in ${row.display}, on ${today}. Nothing here was written by you yet: check it, then add the status and next step in your own words.`;
  const langs = row.languages.map(l => `${l.name} (${l.files} file${l.files === 1 ? '' : 's'})`).join(', ');
  const deps = mf?.dependencies?.length ? `${mf.dependencies.slice(0, 25).join(', ')}${mf.dependencies.length > 25 ? ` and ${mf.dependencies.length - 25} more` : ''}` : null;
  const s = row.slug;
  const state = [
    `---`, `title: ${row.name} state`, `updated: ${today}`, `---`, ``, `# ${row.name}`, ``, `> ${label}`, ``,
    `## Status`,
    row.isRepo && row.lastCommit ? `- Last commit: ${day(row.lastCommit)}. ${row.kind === 'unknown-author'
      ? `${row.commits} commit${row.commits === 1 ? '' : 's'}; your git name and email are not set, so which of them are yours cannot be told.`
      : `${row.own} of ${row.commits} commits are yours${row.lastOwnCommit ? `; your last on ${day(row.lastOwnCommit)}` : ''}.`}` : `- Not a git repository; no commit history.`,
    `- Next step: not known yet. Facts you approve later appear under Added headings below.`,
    ...(subjects.length ? [``, `## Recent commits (last ten subjects, newest first)`, ...subjects.map(x => `- ${x}`)] : []),
  ].join('\n');
  const context = [
    `---`, `title: ${row.name} context`, `updated: ${today}`, `---`, ``, `# ${row.name}: background`, ``, `> ${label}`, ``,
    `- Code folder: ${row.display}`,
    langs ? `- Main languages by file count: ${langs}` : null,
    mf?.name ? `- Name in ${mf.file}: ${oneLine(mf.name)}` : null,
    mf?.description ? `- Description in ${mf.file}: ${oneLine(mf.description)}` : null,
    deps ? `- Dependencies in ${mf.file}: ${deps}` : null,
    ...(rd?.lines.length ? [``, `## From ${rd.file} (first lines)`, quote(rd.lines)] : []),
  ].filter(l => l !== null).join('\n');
  // The content is inside FILE blocks; a line in it that looks like a FILE or ACTION label would split the block.
  const safe = t => t.replace(/^(\s*#{0,6}\s*\**)(FILE|ACTION)(\**\s*:)/gim, '$1$2 $3');
  return {
    row, slug: s,
    text: `### FILE: projects/${s}/state.md\n### ACTION: create\n${safe(state)}\n\n### FILE: projects/${s}/context.md\n### ACTION: create\n${safe(context)}\n`,
  };
}

// "New project" (shown when the scan found nothing): the two drafts for a project the person names, from the name
// and the one line they typed. No folder is read.
export function draftNewProject(name, line, today) {
  const n = oneLine(name).slice(0, 80), l = oneLine(line);
  const s = slugFor(n);
  const label = `Written by the Brain app from what you typed in "New project" on ${today}. Check it before approving.`;
  const state = [`---`, `title: ${n} state`, `updated: ${today}`, `---`, ``, `# ${n}`, ``, `> ${label}`, ``, `## Status`,
    `- Next step: not known yet. Facts you approve later appear under Added headings below.`].join('\n');
  const context = [`---`, `title: ${n} context`, `updated: ${today}`, `---`, ``, `# ${n}: background`, ``, `> ${label}`, ``, `- ${l}`].join('\n');
  const safe = t => t.replace(/^(\s*#{0,6}\s*\**)(FILE|ACTION)(\**\s*:)/gim, '$1$2 $3');
  return { name: n, slug: s,
    text: `### FILE: projects/${s}/state.md\n### ACTION: create\n${safe(state)}\n\n### FILE: projects/${s}/context.md\n### ACTION: create\n${safe(context)}\n` };
}
