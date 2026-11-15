// Code maps: link a Brain project to one or more code folders and map them with src/mapper.js into one map.
// Links live in ~/.brain/code-folders.json (slug → [{ name, path }]; the older slug → path is read and upgraded
// on the next write), maps in ~/.brain/maps/<slug>/map.json.
// Nothing here writes to ~/Brain. The only writes to a linked folder are the marked brainmap block in its
// CLAUDE.md / AGENTS.md and the strict-mode hook in .claude/settings.local.json, each after the person confirms
// it (brainmap-agents.js, brainmap-strict.js). Git is only read, with
// --no-optional-locks so that `git status` never refreshes the folder's index; nothing is committed.
import { writeFile, rename, mkdir, stat, realpath, readdir } from 'fs/promises';
import { join, resolve, sep, isAbsolute } from 'path';
import {
  HOME, DOT, LINKS, BRAIN, fail, tilde, realOrSelf, inside, loadLinks, foldersOf, readMap, projectStatus, runMapper,
  defaultFolderName, FOLDER_NAME_RE, RESERVED_FOLDER_NAMES,
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
    for (const k of Object.keys(d)) d[k] = foldersOf(d[k]); // the older slug → path format, upgraded in place
    fn(d);
    for (const k of Object.keys(d)) if (!d[k]?.length) delete d[k];
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
  folders: (map.folders || []).map(f => ({ name: f.name, folder: tilde(f.path), gitCommit: f.gitCommit, files: f.counts?.nodesByKind?.file ?? null })),
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
  const linkedFolders = async slug => foldersOf((await loadLinks())[slug]);
  // Every linked folder, each checked again (it may have moved since it was linked).
  const validFolders = async slug => {
    const links = await linkedFolders(slug);
    if (!links.length) throw fail(400, 'Link a code folder first.');
    const out = [];
    for (const l of links) {
      try { out.push({ name: l.name, path: await validateFolder(l.path) }); }
      catch (e) { throw fail(e.status || 400, `${l.name} (${tilde(l.path)}): ${e.message}`); }
    }
    return out;
  };

  // Link state (every linked folder) and the saved map's summary.
  app.get('/api/code/:slug', async (req, res) => {
    try {
      const slug = slugOf(req);
      const folders = [];
      for (const l of await linkedFolders(slug)) {
        let exists = false;
        try { exists = (await stat(l.path)).isDirectory(); } catch { }
        folders.push({ name: l.name, path: l.path, display: tilde(l.path), exists });
      }
      let map = null, mapError = null, mapOutdated = false;
      try { const m = await readMap(slug); map = m && mapSummary(m.map); } catch (e) { mapError = e.message; mapOutdated = !!e.outdated; }
      res.json({ slug, folders, folder: folders[0]?.path ?? null, display: folders[0]?.display ?? null,
        folderExists: folders.length > 0 && folders.every(f => f.exists), map, mapError, mapOutdated, running: running.has(slug) });
    } catch (e) { send(res, e); }
  });

  app.get('/api/code/:slug/suggestions', async (req, res) => {
    try {
      const slug = slugOf(req);
      const name = typeof req.query.name === 'string' ? req.query.name.slice(0, 100) : '';
      res.json({ suggestions: await suggestFolders([slug, name]) });
    } catch (e) { send(res, e); }
  });

  // Add a code folder to the project, with a short name (default: the folder's own name).
  app.post('/api/code/:slug/link', async (req, res) => {
    try {
      const slug = slugOf(req);
      const folder = await validateFolder(req.body?.folder);
      const asked = typeof req.body?.name === 'string' ? req.body.name.trim().toLowerCase() : '';
      if (asked && (!FOLDER_NAME_RE.test(asked) || RESERVED_FOLDER_NAMES.has(asked)))
        throw fail(400, 'Short name: up to 24 lower-case letters, digits, dash or underscore (not "collection" or "subcollection").');
      let added = null;
      await updateLinks(d => {
        const list = d[slug] || [];
        const real = list.find(f => f.path === folder);
        if (real) throw fail(400, `That folder is already linked as ${real.name}.`);
        let name = asked || defaultFolderName(folder);
        if (list.some(f => f.name === name)) {
          if (asked) throw fail(400, `This project already has a folder named ${name}.`);
          let i = 2; while (list.some(f => f.name === `${name}-${i}`)) i++; name = `${name}-${i}`;
        }
        added = { name, path: folder };
        d[slug] = [...list, added];
      });
      res.json({ ok: true, folder, name: added.name, display: tilde(folder) });
    } catch (e) { send(res, e); }
  });

  // Remove one folder ({ name }) or, with no name, every folder. The saved map is kept; it is replaced on the
  // next map of this project.
  app.delete('/api/code/:slug/link', async (req, res) => {
    try {
      const slug = slugOf(req);
      const name = typeof req.body?.name === 'string' ? req.body.name : null;
      await updateLinks(d => {
        if (!name) { delete d[slug]; return; }
        if (!(d[slug] || []).some(f => f.name === name)) throw fail(404, `No linked folder named ${name}.`);
        d[slug] = d[slug].filter(f => f.name !== name);
      });
      res.json({ ok: true });
    } catch (e) { send(res, e); }
  });

  app.post('/api/code/:slug/map', async (req, res) => {
    let slug;
    try {
      slug = slugOf(req);
      const folders = await validFolders(slug);
      if (running.has(slug)) throw fail(409, 'This project is already being mapped.');
      running.add(slug);
      const started = Date.now();
      try { await runMapper(folders, slug, await gitAvailable()); }
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

  // Is the saved map still current, for every linked folder?
  app.get('/api/code/:slug/status', async (req, res) => {
    try {
      const slug = slugOf(req);
      const links = await linkedFolders(slug);
      if (!links.length) throw fail(400, 'No code folder linked.');
      const m = await readMap(slug);
      if (!m) throw fail(404, 'This project has not been mapped yet.');
      res.json(await projectStatus(links, m.map, await gitAvailable()));
    } catch (e) { send(res, e); }
  });

  // "Enable for assistants": the marked block goes into every linked folder; each folder's files are previewed,
  // written and removed on their own (body.folder limits an action to one folder; body.expect is per folder).
  const pick = (folders, name) => {
    if (!name) return folders;
    const f = folders.filter(x => x.name === name);
    if (!f.length) throw fail(404, `No linked folder named ${name}.`);
    return f;
  };
  const previewAll = async folders => {
    const out = [];
    for (const f of folders) out.push({ name: f.name, display: tilde(f.path), ...(await assistantsPreview(f.path)) });
    return { folders: out, enabled: out.some(f => f.enabled), upToDate: out.every(f => f.upToDate), expect: Object.fromEntries(out.map(f => [f.name, f.expect])) };
  };
  app.get('/api/code/:slug/assistants', async (req, res) => {
    try { res.json(await previewAll(await validFolders(slugOf(req)))); } catch (e) { send(res, e); }
  });
  for (const [method, act] of [['post', enableAssistants], ['delete', removeAssistants]]) {
    app[method]('/api/code/:slug/assistants', async (req, res) => {
      try {
        const folders = pick(await validFolders(slugOf(req)), req.body?.folder);
        // Every folder is checked against its preview before anything is written in any of them.
        const now = await previewAll(folders);
        const changed = now.folders.filter(f => JSON.stringify(f.expect) !== JSON.stringify(req.body?.expect?.[f.name])).map(f => f.name);
        if (changed.length) throw fail(409, `${changed.join(' and ')}: the files changed since the preview. Review the text again.`);
        const done = [];
        for (const f of folders) done.push({ name: f.name, ...(await act(f.path, req.body.expect[f.name])) });
        res.json({ ok: true, folders: done, files: done.flatMap(d => d.files.map(x => ({ ...x, folder: d.name }))) });
      } catch (e) { send(res, e); }
    });
  }

  // Strict mode works on the first linked folder (see brainmap-strict.js).
  const agentsFolder = async req => (await validFolders(slugOf(req)))[0].path;
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
