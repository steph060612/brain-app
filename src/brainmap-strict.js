// Strict mode, per project and opt in: adds the brainmap PreToolUse hook to the project's
// .claude/settings.local.json (a file git ignores by default). Same rules as the instruction block: the exact
// change is previewed, the write is refused if the file changed after the preview, and Remove takes out only
// the hook. The original bytes are kept in ~/.brain (never in the project), so Remove restores the file byte
// for byte when it was not edited since. Refused when git would track the file. Nothing is committed.
import { readFile, writeFile, mkdir, unlink, rmdir, readdir } from 'fs/promises';
import { createHash } from 'crypto';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { fail, tilde, git, gitAvailable, DOT } from './codemap-status.js';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'brainmap-hook.js');
const BACKUPS = join(DOT, 'strict-backups');
const REL = '.claude/settings.local.json';
export const MATCHER = 'Grep|Glob|Read';
const hookCommand = () => `"${process.execPath}" "${HOOK}"`;
export const hookEntry = () => ({ matcher: MATCHER, hooks: [{ type: 'command', command: hookCommand(), timeout: 10 }] });
const isOurs = h => (h?.hooks || []).some(x => String(x?.command || '').includes('brainmap-hook.js'));
const sha = t => (t === null ? 'none' : createHash('sha1').update(t).digest('hex'));
const backupFile = folder => join(BACKUPS, `${createHash('sha1').update(folder).digest('hex').slice(0, 16)}.json`);

async function readText(p) { try { return await readFile(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }

// Would git track .claude/settings.local.json in this folder? Ignored and untracked is required.
async function gitCheck(folder) {
  if (!(await gitAvailable())) return { repo: false };
  if ((await git(folder, ['rev-parse', '--is-inside-work-tree']))?.trim() !== 'true') return { repo: false };
  const tracked = (await git(folder, ['ls-files', '--', REL]))?.trim();
  const ignored = (await git(folder, ['check-ignore', '-q', '--', REL])) !== null; // exit 0 = ignored
  return { repo: true, tracked: !!tracked, ignored };
}

async function state(folder) {
  const path = join(folder, REL);
  const text = await readText(path);
  let json = null, parseError = null;
  if (text !== null && text.trim()) { try { json = JSON.parse(text); } catch (e) { parseError = e.message; } }
  const enabled = !!json?.hooks?.PreToolUse?.some?.(isOurs);
  return { path, text, json: text !== null && !text.trim() ? {} : json, parseError, enabled };
}

function withHook(json) {
  const out = structuredClone(json || {});
  out.hooks ||= {};
  out.hooks.PreToolUse = [...(out.hooks.PreToolUse || []).filter(h => !isOurs(h)), hookEntry()];
  return out;
}
function withoutHook(json) {
  const out = structuredClone(json);
  if (out.hooks?.PreToolUse) {
    out.hooks.PreToolUse = out.hooks.PreToolUse.filter(h => !isOurs(h));
    if (!out.hooks.PreToolUse.length) delete out.hooks.PreToolUse;
    if (!Object.keys(out.hooks).length) delete out.hooks;
  }
  return out;
}

function refusal(s, g) {
  if (s.parseError) return `${REL} is not valid JSON (${s.parseError}); it is left alone.`;
  if (g.repo && g.tracked) return `${REL} is tracked by git in this project, so strict mode is not added (it would be committed).`;
  if (g.repo && !g.ignored) return `${REL} is not ignored by git in this project, so it could be committed; add it to .gitignore first.`;
  return null;
}

export async function strictPreview(folder) {
  const s = await state(folder), g = await gitCheck(folder);
  return {
    file: REL, path: tilde(s.path), exists: s.text !== null, enabled: s.enabled,
    git: g.repo ? (g.tracked ? 'tracked' : g.ignored ? 'ignored' : 'not ignored') : 'not a git repository',
    refused: refusal(s, g),
    added: JSON.stringify({ hooks: { PreToolUse: [hookEntry()] } }, null, 2),
    expect: sha(s.text),
  };
}

export async function enableStrict(folder, expect) {
  const s = await state(folder), g = await gitCheck(folder);
  if (expect !== sha(s.text)) throw fail(409, `${REL} changed since the preview. Review it again.`);
  const why = refusal(s, g);
  if (why) throw fail(400, why);
  if (s.enabled) return { ok: true, already: true };
  const next = `${JSON.stringify(withHook(s.json), null, 2)}\n`;
  const dirExisted = (await readdir(join(folder, '.claude')).then(() => true, () => false));
  await mkdir(BACKUPS, { recursive: true });
  await writeFile(backupFile(folder), JSON.stringify({ folder, original: s.text, written: next, dirExisted }), 'utf8');
  await mkdir(join(folder, '.claude'), { recursive: true });
  await writeFile(s.path, next, 'utf8');
  return { ok: true, created: s.text === null };
}

export async function removeStrict(folder, expect) {
  const s = await state(folder);
  if (!s.enabled) return { ok: true, already: true };
  if (expect !== sha(s.text)) throw fail(409, `${REL} changed since the preview. Review it again.`);
  let backup = null;
  try { backup = JSON.parse(await readFile(backupFile(folder), 'utf8')); } catch { }
  if (backup && backup.written === s.text) {
    // Not edited since strict mode was added: put back exactly what was there before.
    if (backup.original === null) {
      await unlink(s.path);
      if (!backup.dirExisted) await rmdir(join(folder, '.claude')).catch(() => {}); // only if now empty
    } else await writeFile(s.path, backup.original, 'utf8');
    await unlink(backupFile(folder)).catch(() => {});
    return { ok: true, restored: true, deleted: backup.original === null };
  }
  // Edited since: take out only the hook entry, keep everything else.
  await writeFile(s.path, `${JSON.stringify(withoutHook(s.json), null, 2)}\n`, 'utf8');
  await unlink(backupFile(folder)).catch(() => {});
  return { ok: true, restored: false };
}
