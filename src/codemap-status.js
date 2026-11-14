// Shared by the server's code map routes and the brainmap command: links, saved maps, the
// "code changed since the last map" check and the mapper run. Git is only read, with
// --no-optional-locks so that `git status` never refreshes a linked folder's index.
import { readFile, stat, realpath, readdir } from 'fs/promises';
import { spawn, execFile } from 'child_process';
import { homedir } from 'os';
import { join, sep, dirname, extname } from 'path';
import { fileURLToPath } from 'url';
import { JS_EXT, SKIP_DIRS, NO_JS_EXIT, NO_JS_MESSAGE } from './mapper.js';

export const HOME  = homedir();
export const DOT   = join(HOME, '.brain');
export const LINKS = join(DOT, 'code-folders.json');
export const MAPS  = join(DOT, 'maps');
export const BRAIN = join(HOME, 'Brain');
export const SCHEMA_VERSION = 6;
export const MAP_TIMEOUT_MS = 60_000;
const MAPPER = join(dirname(fileURLToPath(import.meta.url)), 'mapper.js');

export const fail = (status, message) => Object.assign(new Error(message), { status });
export const tilde = p => (p === HOME || p.startsWith(HOME + sep) ? '~' + p.slice(HOME.length) : p);
export const isSource = rel => JS_EXT.includes(extname(rel).toLowerCase()) && !rel.split('/').some(s => SKIP_DIRS.has(s));
export const mapFile = slug => join(MAPS, slug, 'map.json');
export const realOrSelf = async p => { try { return await realpath(p); } catch { return p; } };
export const inside = (p, dir) => p === dir || p.startsWith(dir + sep);

export async function loadLinks() {
  try {
    const d = JSON.parse(await readFile(LINKS, 'utf8'));
    return d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  } catch { return {}; }
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

// The full status the panel shows: changeStatus plus "the map was made from another folder".
export async function mapStatus(folder, map, useGit) {
  const st = await changeStatus(folder, map, useGit);
  const mappedFolder = map.project?.path;
  if (mappedFolder && (await realOrSelf(mappedFolder)) !== folder) { st.state = 'other-folder'; st.mappedFolder = tilde(mappedFolder); }
  return st;
}

export function runMapper(folder, slug, useGit) {
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
