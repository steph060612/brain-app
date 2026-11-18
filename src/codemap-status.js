// Shared by the server's code map routes and the brainmap command: links (one or more code folders per
// project), saved maps, the
// "code changed since the last map" check and the mapper run. Git is only read, with
// --no-optional-locks so that `git status` never refreshes a linked folder's index.
import { readFile, stat, realpath, readdir } from 'fs/promises';
import { spawn, execFile } from 'child_process';
import { homedir } from 'os';
import { join, sep, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { JS_EXT, PY_EXT, SKIP_DIRS, NO_JS_EXIT, NO_JS_MESSAGE, vendoredReason, defaultFolderName, FOLDER_NAME_RE, RESERVED_FOLDER_NAMES } from './mapper.js';
export { defaultFolderName, FOLDER_NAME_RE, RESERVED_FOLDER_NAMES };

export const HOME  = homedir();
export const DOT   = join(HOME, '.brain');
export const LINKS = join(DOT, 'code-folders.json');
export const MAPS  = join(DOT, 'maps');
export { BRAIN } from './brain-dir.js';
import { SCHEMA_VERSION } from './map-schema.js';
export { SCHEMA_VERSION };
export const MAP_TIMEOUT_MS = 60_000;
const MAPPER = join(dirname(fileURLToPath(import.meta.url)), 'mapper.js');

export const fail = (status, message) => Object.assign(new Error(message), { status });
export const tilde = p => (p === HOME || p.startsWith(HOME + sep) ? '~' + p.slice(HOME.length) : p);
export const isSource = rel => (JS_EXT.includes(extname(rel).toLowerCase()) || PY_EXT.includes(extname(rel).toLowerCase())) && !rel.split('/').some(s => SKIP_DIRS.has(s)) && !vendoredReason(rel);
export const mapFile = slug => join(MAPS, slug, 'map.json');
export const realOrSelf = async p => { try { return await realpath(p); } catch { return p; } };
export const inside = (p, dir) => p === dir || p.startsWith(dir + sep);

// The links file as stored: slug → [{ name, path }] (one entry per linked code folder). The older format,
// slug → "/path", is still read (as one folder named after its directory) and upgraded on the next write.
export async function loadLinks() {
  try {
    const d = JSON.parse(await readFile(LINKS, 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
}
export function foldersOf(entry) {
  if (typeof entry === 'string') return entry ? [{ name: defaultFolderName(entry), path: entry }] : [];
  if (Array.isArray(entry)) return entry.filter(f => f && typeof f.path === 'string' && typeof f.name === 'string');
  return [];
}
// slug → [{ name, path }], whatever the format on disk.
export async function loadProjects() {
  const d = await loadLinks();
  return Object.fromEntries(Object.entries(d).map(([k, v]) => [k, foldersOf(v)]).filter(([, v]) => v.length));
}
// The project whose linked folder contains `cwd` (the deepest one): { slug, folders, folder }, or null.
export async function projectFor(cwd) {
  const here = await realOrSelf(cwd);
  let best = null;
  for (const [slug, folders] of Object.entries(await loadProjects())) {
    for (const f of folders) {
      const real = await realOrSelf(f.path);
      if (inside(here, real) && (!best || real.length > best.folder.path.length)) best = { slug, folders, folder: { ...f, path: real } };
    }
  }
  return best;
}

// { text, map } for a saved map of the supported schema, null when there is none.
export async function readMap(slug) {
  let text;
  try { text = await readFile(mapFile(slug), 'utf8'); } catch { return null; }
  let map;
  try { map = JSON.parse(text); } catch { throw fail(422, 'The saved map could not be read. Re-map the project.'); }
  if (map?.schemaVersion !== SCHEMA_VERSION) {
    // An older map is replaced automatically (brainmap and the panel re-map when they see `outdated`).
    const e = fail(422, `This map uses schema version ${map?.schemaVersion ?? 'unknown'}; this app reads only version ${SCHEMA_VERSION}. Re-map the project to replace it.`);
    e.outdated = typeof map?.schemaVersion === 'number' && map.schemaVersion < SCHEMA_VERSION;
    throw e;
  }
  return { text, map };
}

// On a Mac without the developer tools, running git opens Apple's install dialog; check once instead.
let hasGit = null;
export function gitAvailable() {
  if (hasGit !== null) return Promise.resolve(hasGit);
  return new Promise(res => execFile('xcode-select', ['-p'], { timeout: 5000 }, err => res((hasGit = !err))));
}

export function git(folder, args) {
  return new Promise(res => {
    execFile('git', ['--no-optional-locks', '-C', folder, ...args],
      { timeout: 10_000, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout) => res(err ? null : stdout));
  });
}

// Source files changed since the map was made: files changed between the mapped commit and HEAD, plus
// uncommitted source files modified after the map was written (or deleted since).
export async function changeStatus(folder, map, useGit) {
  const mapTime = Date.parse(map.generatedAt) || 0;
  const mapped = new Set(map.nodes.filter(n => n.kind === 'file').map(n => n.relPath ?? n.path));
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

// One linked folder's part of the map, as changeStatus reads it (paths inside the folder).
function folderPart(map, name) {
  const f = (map.folders || []).find(x => x.name === name);
  if (!f) return null;
  return { folder: f, generatedAt: f.generatedAt, project: { path: f.path, gitCommit: f.gitCommit }, nodes: map.nodes.filter(n => n.kind === 'file' && (n.codeFolder ?? name) === name) };
}

// The status the panel and brainmap show, for every linked folder: 'current', 'changed', 'other-folder' (the map
// has this name from another folder) or 'not-mapped' (linked after the map was made); plus folders the map
// has that are not linked any more. The project's map is current only when every folder is.
export async function projectStatus(links, map, useGit) {
  const folders = [];
  for (const l of links) {
    const part = folderPart(map, l.name);
    const base = { name: l.name, folder: tilde(l.path) };
    if (!part) { folders.push({ ...base, state: 'not-mapped' }); continue; }
    let exists = false;
    try { exists = (await stat(l.path)).isDirectory(); } catch { }
    if (!exists) { folders.push({ ...base, state: 'missing' }); continue; }
    const st = await changeStatus(l.path, part, useGit);
    if ((await realOrSelf(part.folder.path)) !== (await realOrSelf(l.path))) { st.state = 'other-folder'; st.mappedFolder = tilde(part.folder.path); }
    folders.push({ ...base, ...st });
  }
  const removed = (map.folders || []).filter(f => !links.some(l => l.name === f.name)).map(f => f.name);
  const changed = folders.filter(f => f.state !== 'current' && f.state !== 'missing');
  return {
    state: changed.length || removed.length ? 'changed' : 'current',
    folders, removed,
    changedFiles: folders.reduce((s, f) => s + (f.changedFiles || 0), 0),
  };
}

// Why a status is not current, in words: "2 source files changed in web", "web is not in the map yet".
export function statusReason(st) {
  const parts = [];
  for (const f of st.folders) {
    const where = st.folders.length > 1 ? ` in ${f.name}` : '';
    if (f.state === 'changed') parts.push(f.changedFiles ? `${f.changedFiles} source file${f.changedFiles === 1 ? '' : 's'} changed${where}` : `the code changed${where}`);
    else if (f.state === 'not-mapped') parts.push(`${f.name} (${f.folder}) is not in the map yet`);
    else if (f.state === 'other-folder') parts.push(`the map's ${f.name} was made from ${f.mappedFolder}`);
  }
  if (st.removed.length) parts.push(`${st.removed.join(', ')} ${st.removed.length === 1 ? 'is' : 'are'} no longer linked`);
  return parts.join('; ') || 'the code changed since the last map';
}

// Maps every linked folder of a project ([{ name, path }]) into one map.json.
export function runMapper(folders, slug, useGit) {
  return new Promise((res, rej) => {
    const args = folders.flatMap(f => ['--folder', `${f.name}=${f.path}`]);
    const child = spawn(process.execPath, [MAPPER, ...args, slug], {
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
      if (code === NO_JS_EXIT) return rej(fail(422, stderr.trim().split('\n')[0] || NO_JS_MESSAGE));
      if (code !== 0) return rej(fail(500, `Mapper failed: ${(stderr || stdout).trim().split('\n')[0] || `exit ${code}`}`));
      res(stdout);
    });
  });
}
