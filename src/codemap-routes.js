// Code maps: link a Brain project to a code folder and map it with src/mapper.js.
// Links live in ~/.brain/code-folders.json (slug → absolute path), maps in ~/.brain/maps/<slug>/map.json.
// Nothing here writes to ~/Brain or to a linked folder: git is only read, with --no-optional-locks so
// that `git status` never refreshes the folder's index.
import { readFile, writeFile, rename, mkdir, stat, realpath, readdir } from 'fs/promises';
import { spawn, execFile } from 'child_process';
import { homedir } from 'os';
import { join, resolve, sep, dirname, extname, isAbsolute } from 'path';
import { fileURLToPath } from 'url';
import { JS_EXT, SKIP_DIRS, NO_JS_EXIT, NO_JS_MESSAGE } from './mapper.js';

const HOME     = homedir();
const DOT      = join(HOME, '.brain');
const LINKS    = join(DOT, 'code-folders.json');
const MAPS     = join(DOT, 'maps');
const BRAIN    = join(HOME, 'Brain');
const MAPPER   = join(dirname(fileURLToPath(import.meta.url)), 'mapper.js');
const SCHEMA_VERSION = 2;
const MAP_TIMEOUT_MS = 60_000;
const SLUG_RE  = /^[a-z0-9][a-z0-9-]*$/;

const fail = (status, message) => Object.assign(new Error(message), { status });
const send = (res, e) => res.status(e.status || 500).json({ error: e.message });
const tilde = p => (p === HOME || p.startsWith(HOME + sep) ? '~' + p.slice(HOME.length) : p);
const isSource = rel => JS_EXT.includes(extname(rel).toLowerCase()) && !rel.split('/').some(s => SKIP_DIRS.has(s));
const mapFile = slug => join(MAPS, slug, 'map.json');

function slugOf(req) {
  const slug = String(req.params.slug || '');
  if (!SLUG_RE.test(slug)) throw fail(400, 'Invalid project name');
  return slug;
}

const realOrSelf = async p => { try { return await realpath(p); } catch { return p; } };
const inside = (p, dir) => p === dir || p.startsWith(dir + sep);

// Accept only an existing directory under the home folder, never ~/Brain or ~/.brain (or anything in them).
async function validateFolder(input) {
  if (typeof input !== 'string' || !input.trim()) throw fail(400, 'Type a folder path.');
  let p = input.trim();
  if (p === '~' || p.startsWith('~/')) p = HOME + p.slice(1);
  if (!isAbsolute(p)) throw fail(400, 'Use a full path, for example ~/Projects/my-app.');
  let real;
  try { real = await realpath(resolve(p)); } catch { throw fail(400, 'That folder does not exist.'); }
  if (!(await stat(real)).isDirectory()) throw fail(400, 'That path is a file, not a folder.');
  const home = await realOrSelf(HOME);
  if (!real.startsWith(home + sep)) throw fail(400, 'Only folders inside your home folder can be linked.');
  if (inside(real, await realOrSelf(BRAIN))) throw fail(400, 'Folders inside ~/Brain cannot be linked.');
  if (inside(real, await realOrSelf(DOT))) throw fail(400, 'Folders inside ~/.brain cannot be linked.');
  return real;
}

// ─── links file ──────────────────────────────────────────────────────────────
async function loadLinks() {
  try {
    const d = JSON.parse(await readFile(LINKS, 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}

let linksLock = Promise.resolve();
function updateLinks(fn) {
  const next = linksLock.then(async () => {
    const d = await loadLinks();
    fn(d);
    await mkdir(DOT, { recursive: true });
    await writeFile(LINKS + '.tmp', JSON.stringify(d, null, 2) + '\n', 'utf8');
    await rename(LINKS + '.tmp', LINKS);
    return d;
  });
  linksLock = next.catch(() => {});
  return next;
}

// ─── map file ────────────────────────────────────────────────────────────────
async function readMap(slug) {
  let text;
  try { text = await readFile(mapFile(slug), 'utf8'); } catch { return null; }
  let map;
  try { map = JSON.parse(text); } catch { throw fail(422, 'The saved map could not be read. Re-map the project.'); }
  if (map?.schemaVersion !== SCHEMA_VERSION) {
    throw fail(422, `This map uses schema version ${map?.schemaVersion ?? 'unknown'}; this app reads only version ${SCHEMA_VERSION}. Re-map the project to replace it.`);
  }
  return { text, map };
}

const mapSummary = map => ({
  schemaVersion: map.schemaVersion,
  generatedAt: map.generatedAt,
  durationMs: map.durationMs,
  gitCommit: map.project?.gitCommit ?? null,
  folder: map.project?.path ?? null,
  counts: { nodes: map.counts?.nodes, edges: map.counts?.edges, nodesByKind: map.counts?.nodesByKind, edgesByKind: map.counts?.edgesByKind },
});

// ─── git (read-only) ─────────────────────────────────────────────────────────
function git(folder, args) {
  return new Promise(res => {
    execFile('git', ['--no-optional-locks', '-C', folder, ...args],
      { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => res(err ? null : stdout));
  });
}

// Source files changed since the map was made: files changed between the mapped commit and HEAD, plus
// uncommitted source files modified after the map was written (or deleted since).
async function changeStatus(folder, map, useGit) {
  const mapTime = Date.parse(map.generatedAt) || 0;
  const mapped = new Set(map.nodes.filter(n => n.kind === 'file').map(n => n.path));
  const changed = new Set();
  const out = { mapCommit: map.project?.gitCommit ?? null, currentCommit: null, commitChanged: false, uncommittedSourceFiles: 0, method: 'git' };

  const mtime = async rel => { try { return (await stat(join(folder, rel))).mtimeMs; } catch { return null; } };
  const head = useGit ? (await git(folder, ['rev-parse', 'HEAD']))?.trim() : null;

  if (head) {
    out.currentCommit = head;
    if (out.mapCommit && head !== out.mapCommit) {
      out.commitChanged = true;
      const diff = await git(folder, ['diff', '--name-only', '-z', out.mapCommit, head]);
      if (diff === null) out.diffUnavailable = true;
      else for (const f of diff.split('\0')) if (f && isSource(f)) changed.add(f);
    } else if (!out.mapCommit) out.commitChanged = true; // mapped without git, now a repository
    const porcelain = await git(folder, ['status', '--porcelain', '-z', '--untracked-files=all']);
    const parts = (porcelain || '').split('\0');
    for (let i = 0; i < parts.length; i++) {
      const entry = parts[i];
      if (entry.length < 4) continue;
      const code = entry.slice(0, 2), rel = entry.slice(3);
      if (code.includes('R') || code.includes('C')) i++; // the next field is the old path
      if (!isSource(rel)) continue;
      out.uncommittedSourceFiles++;
      const t = await mtime(rel);
      if (t === null ? mapped.has(rel) : t > mapTime) changed.add(rel);
    }
  } else {
    // Not a git repository (or git unavailable): compare modification times with the map.
    out.method = 'mtime';
    const seen = new Set();
    async function walk(dir, base) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const rel = base ? `${base}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) await walk(join(dir, e.name), rel); }
        else if (e.isFile() && isSource(rel)) {
          seen.add(rel);
          const t = await mtime(rel);
          if (!mapped.has(rel) || (t !== null && t > mapTime)) changed.add(rel);
        }
      }
    }
    await walk(folder, '');
    for (const f of mapped) if (!seen.has(f) && !f.startsWith('.')) changed.add(f);
  }
  out.changedFiles = changed.size;
  out.state = changed.size || out.diffUnavailable ? 'changed' : 'current';
  return out;
}

// ─── folder suggestions ──────────────────────────────────────────────────────
const norm = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
function bigrams(s) { const b = new Map(); for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); b.set(g, (b.get(g) || 0) + 1); } return b; }
function similarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (Math.min(a.length, b.length) >= 3 && (a.includes(b) || b.includes(a))) return 0.85;
  const A = bigrams(a), B = bigrams(b);
  let common = 0;
  for (const [g, n] of A) common += Math.min(n, B.get(g) || 0);
  return (2 * common) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1));
}
const SUGGEST_ROOTS = ['', 'Projects', 'projects', 'Developer', 'Code', 'code', 'dev', 'src', 'repos', 'git', 'workspace', 'Documents', 'Desktop'];
const NOT_CODE = new Set(['Library', 'Applications', 'Brain', 'Music', 'Movies', 'Pictures', 'Public', 'Downloads']);

async function suggestFolders(names) {
  const queries = [...new Set(names.map(norm).filter(q => q.length >= 2))];
  const roots = new Map();
  for (const r of SUGGEST_ROOTS) {
    const abs = join(HOME, r);
    try { if ((await stat(abs)).isDirectory()) roots.set((await realOrSelf(abs)).toLowerCase(), abs); } catch { }
  }
  const found = new Map();
  for (const root of roots.values()) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.') || (root === HOME && NOT_CODE.has(e.name))) continue;
      const score = Math.max(...queries.map(q => similarity(norm(e.name), q)));
      if (score < 0.5) continue;
      const abs = join(root, e.name);
      const key = abs.toLowerCase();
      if (found.has(key)) continue;
      const has = async f => { try { await stat(join(abs, f)); return true; } catch { return false; } };
      let mtimeMs = 0;
      try { mtimeMs = (await stat(abs)).mtimeMs; } catch { }
      found.set(key, { path: abs, display: tilde(abs), score, hasGit: await has('.git'), hasPackageJson: await has('package.json'), mtimeMs });
    }
  }
  return [...found.values()]
    .sort((a, b) => b.score - a.score || (b.hasPackageJson - a.hasPackageJson) || b.mtimeMs - a.mtimeMs)
    .slice(0, 8)
    .map(({ mtimeMs, ...s }) => s);
}

// ─── mapper run ──────────────────────────────────────────────────────────────
const running = new Set();

function runMapper(folder, slug, useGit) {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [MAPPER, folder, slug], {
      cwd: DOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...(useGit ? {} : { MAPPER_NO_GIT: '1' }) },
    });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, MAP_TIMEOUT_MS);
    child.on('error', e => { clearTimeout(timer); rej(fail(500, `Could not start the mapper: ${e.message}`)); });
    child.on('close', code => {
      clearTimeout(timer);
      if (timedOut) return rej(fail(504, 'Mapping took longer than 60 seconds and was stopped.'));
      if (code === NO_JS_EXIT) return rej(fail(422, NO_JS_MESSAGE));
      if (code !== 0) return rej(fail(500, `Mapper failed: ${(stderr || stdout).trim().split('\n')[0] || `exit ${code}`}`));
      res(stdout);
    });
  });
}

// ─── routes ──────────────────────────────────────────────────────────────────
export function registerCodeMapRoutes(app, { gitAvailable }) {
  const linkedFolder = async slug => (await loadLinks())[slug] ?? null;

  // Link state and the saved map's summary.
  app.get('/api/code/:slug', async (req, res) => {
    try {
      const slug = slugOf(req);
      const folder = await linkedFolder(slug);
      let folderExists = false;
      if (folder) { try { folderExists = (await stat(folder)).isDirectory(); } catch { } }
      let map = null, mapError = null;
      try { const m = await readMap(slug); map = m && mapSummary(m.map); } catch (e) { mapError = e.message; }
      res.json({ slug, folder, display: folder && tilde(folder), folderExists, map, mapError, running: running.has(slug) });
    } catch (e) { send(res, e); }
  });

  app.get('/api/code/:slug/suggestions', async (req, res) => {
    try {
      const slug = slugOf(req);
      const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 100) : '';
      res.json({ suggestions: await suggestFolders([slug, name]) });
    } catch (e) { send(res, e); }
  });

  app.post('/api/code/:slug/link', async (req, res) => {
    try {
      const slug = slugOf(req);
      const folder = await validateFolder(req.body?.folder);
      await updateLinks(d => { d[slug] = folder; });
      res.json({ ok: true, folder, display: tilde(folder) });
    } catch (e) { send(res, e); }
  });

  // Unlink keeps the saved map; it is replaced on the next map of this project.
  app.delete('/api/code/:slug/link', async (req, res) => {
    try {
      const slug = slugOf(req);
      await updateLinks(d => { delete d[slug]; });
      res.json({ ok: true });
    } catch (e) { send(res, e); }
  });

  app.post('/api/code/:slug/map', async (req, res) => {
    let slug;
    try {
      slug = slugOf(req);
      const linked = await linkedFolder(slug);
      if (!linked) throw fail(400, 'Link a code folder first.');
      const folder = await validateFolder(linked); // it may have moved since it was linked
      if (running.has(slug)) throw fail(409, 'This project is already being mapped.');
      running.add(slug);
      const started = Date.now();
      try { await runMapper(folder, slug, await gitAvailable()); }
      finally { running.delete(slug); }
      const m = await readMap(slug);
      if (!m) throw fail(500, 'The mapper finished but wrote no map.');
      res.json({ ok: true, elapsedMs: Date.now() - started, map: mapSummary(m.map) });
    } catch (e) { send(res, e); }
  });

  // The full map, only when its schema is the one this app reads.
  app.get('/api/code/:slug/map', async (req, res) => {
    try {
      const m = await readMap(slugOf(req));
      if (!m) throw fail(404, 'This project has not been mapped yet.');
      res.type('application/json').send(m.text);
    } catch (e) { send(res, e); }
  });

  // Is the saved map still current for the linked folder?
  app.get('/api/code/:slug/status', async (req, res) => {
    try {
      const slug = slugOf(req);
      const linked = await linkedFolder(slug);
      if (!linked) throw fail(400, 'No code folder linked.');
      const folder = await validateFolder(linked);
      const m = await readMap(slug);
      if (!m) throw fail(404, 'This project has not been mapped yet.');
      const mappedFolder = m.map.project?.path;
      const st = await changeStatus(folder, m.map, await gitAvailable());
      if (mappedFolder && (await realOrSelf(mappedFolder)) !== folder) { st.state = 'other-folder'; st.mappedFolder = tilde(mappedFolder); }
      res.json(st);
    } catch (e) { send(res, e); }
  });
}
