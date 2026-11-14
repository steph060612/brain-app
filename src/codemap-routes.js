// Code maps: link a Brain project to a code folder and map it with src/mapper.js.
// Links live in ~/.brain/code-folders.json (slug → absolute path), maps in ~/.brain/maps/<slug>/map.json.
// Nothing here writes to ~/Brain. The only writes to a linked folder are the marked brainmap block in its
// CLAUDE.md / AGENTS.md and the strict-mode hook in .claude/settings.local.json, each after the person confirms
// it (brainmap-agents.js, brainmap-strict.js). Git is only read, with
// --no-optional-locks so that `git status` never refreshes the folder's index; nothing is committed.
import { writeFile, rename, mkdir, stat, realpath, readdir } from 'fs/promises';
import { join, resolve, sep, isAbsolute } from 'path';
import {
  HOME, DOT, LINKS, BRAIN, fail, tilde, realOrSelf, inside, loadLinks, readMap, mapStatus, runMapper,
} from './codemap-status.js';
import { assistantsPreview, enableAssistants, removeAssistants } from './brainmap-agents.js';
import { strictPreview, enableStrict, removeStrict } from './brainmap-strict.js';

const SLUG_RE  = /^[a-z0-9][a-z0-9-]*$/;
const send = (res, e) => res.status(e.status || 500).json({ error: e.message });

function slugOf(req) {
  const slug = String(req.params.slug || '');
  if (!SLUG_RE.test(slug)) throw fail(400, 'Invalid project name');
  return slug;
}

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
const mapSummary = map => ({
  schemaVersion: map.schemaVersion,
  generatedAt: map.generatedAt,
  durationMs: map.durationMs,
  gitCommit: map.project?.gitCommit ?? null,
  folder: map.project?.path ?? null,
  counts: { nodes: map.counts?.nodes, edges: map.counts?.edges, nodesByKind: map.counts?.nodesByKind, edgesByKind: map.counts?.edgesByKind },
});

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
      let map = null, mapError = null, mapOutdated = false;
      try { const m = await readMap(slug); map = m && mapSummary(m.map); } catch (e) { mapError = e.message; mapOutdated = !!e.outdated; }
      res.json({ slug, folder, display: folder && tilde(folder), folderExists, map, mapError, mapOutdated, running: running.has(slug) });
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
      res.json(await mapStatus(folder, m.map, await gitAvailable()));
    } catch (e) { send(res, e); }
  });

  // "Enable for assistants": preview the marked block and where it would go, then add or remove it.
  const agentsFolder = async req => {
    const linked = await linkedFolder(slugOf(req));
    if (!linked) throw fail(400, 'No code folder linked.');
    return validateFolder(linked);
  };
  app.get('/api/code/:slug/assistants', async (req, res) => {
    try { res.json(await assistantsPreview(await agentsFolder(req))); } catch (e) { send(res, e); }
  });
  app.post('/api/code/:slug/assistants', async (req, res) => {
    try { res.json(await enableAssistants(await agentsFolder(req), req.body?.expect)); } catch (e) { send(res, e); }
  });
  app.delete('/api/code/:slug/assistants', async (req, res) => {
    try { res.json(await removeAssistants(await agentsFolder(req), req.body?.expect)); } catch (e) { send(res, e); }
  });

  // Strict mode: the brainmap PreToolUse hook in the project's .claude/settings.local.json (see brainmap-strict.js).
  app.get('/api/code/:slug/strict', async (req, res) => {
    try { res.json(await strictPreview(await agentsFolder(req))); } catch (e) { send(res, e); }
  });
  app.post('/api/code/:slug/strict', async (req, res) => {
    try { res.json(await enableStrict(await agentsFolder(req), req.body?.expect)); } catch (e) { send(res, e); }
  });
  app.delete('/api/code/:slug/strict', async (req, res) => {
    try { res.json(await removeStrict(await agentsFolder(req), req.body?.expect)); } catch (e) { send(res, e); }
  });
}
