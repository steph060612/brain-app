// "Connect Claude Code": one action, previewed first, that makes every Claude Code session know the brain.
//  1. A marked block in ~/.claude/CLAUDE.md (Claude Code loads it in every session): where the brain is, what to read
//     first, never edit it, and how to answer "close session". The file is created if missing; nothing outside the
//     markers is ever changed. Before the first edit of an existing file, a dated copy is saved next to it.
//  2. The brainmap tool server registered with Claude Code at user scope (`claude mcp add --scope user brainmap`),
//     the step install.sh also does.
// Remove takes out exactly the block (the file returns to its earlier bytes when the block is still where it was
// put) and the registration. Same rules as "Enable for assistants" (src/brainmap-agents.js): the exact text and
// paths are shown first, and an apply is refused when the file changed since that preview.
import { readFile, writeFile, mkdir, unlink, copyFile, access } from 'fs/promises';
import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { BRAIN_LABEL } from './brain-dir.js';
import { assistantEnv, CLAUDE_SPOTS } from './assistant-env.js';

const HOME = homedir();
export const CLAUDE_MD = join(HOME, '.claude', 'CLAUDE.md');
const MCP_JS = join(dirname(fileURLToPath(import.meta.url)), 'brainmap-mcp.js');
const tilde = p => (p === HOME || p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p);
const fail = (status, message) => Object.assign(new Error(message), { status });

// ─── the block ───────────────────────────────────────────────────────────────
// The start marker records what Remove must undo: whether the app created the file, and whether it added a line
// break to a file that did not end with one.
const start = (created, nl) => `<!-- brain:start created-file=${created ? 'yes' : 'no'} newline-added=${nl ? 'yes' : 'no'} (added by the Brain app, "Connect Claude Code"; remove it there or delete this block) -->`;
const END = '<!-- brain:end -->';
const BLOCK_RE = /<!-- brain:start[^\n]*-->[\s\S]*?<!-- brain:end -->/;
const flag = (text, name) => new RegExp(`<!-- brain:start[^\\n]*\\b${name}=yes\\b`).test(text);

export function blockBody(brain = BRAIN_LABEL) {
  return `## My brain
- My personal knowledge base (the brain) is at ${brain}. It is the source of truth for my projects.
- Read ${brain}/README.md first, then profile.md and preferences.md, then only the files the task needs.
- Never edit files in the brain. When I say "close session", propose changes in the UPDATE PROTOCOL format from ${brain}/README.md instead.`;
}
const block = (created, nl, brain) => `${start(created, nl)}\n${blockBody(brain)}\n${END}`;
const hash = text => (text === null ? 'none' : createHash('sha1').update(text).digest('hex'));

async function readText(p) {
  try { return await readFile(p, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw fail(500, `Could not read ${tilde(p)}: ${e.message}`); }
}

// What Connect would do to ~/.claude/CLAUDE.md: create, add, update, or nothing ('current').
function planFile(text, brain) {
  if (text === null) return { action: 'create', after: `${block(true, false, brain)}\n` };
  const m = BLOCK_RE.exec(text);
  if (m) {
    const now = block(flag(m[0], 'created-file'), flag(m[0], 'newline-added'), brain);
    const after = text.replace(BLOCK_RE, () => now);
    return { action: after === text ? 'current' : 'update', after };
  }
  if (text === '') return { action: 'add', after: `${block(false, false, brain)}\n` };
  const nl = !text.endsWith('\n');
  return { action: 'add', after: `${text}${nl ? '\n' : ''}\n${block(false, nl, brain)}\n` };
}

// The file without the block. When the block is still at the end, exactly where Connect put it, the result is the
// file's bytes from before Connect. Otherwise the block and the blank line that set it apart are taken out.
export function withoutBlock(text) {
  const m = BLOCK_RE.exec(text);
  if (!m) return text;
  const nl = flag(m[0], 'newline-added');
  const before = text.slice(0, m.index), after = text.slice(m.index + m[0].length);
  if (after === '\n' || after === '') {
    if (before === '') return '';
    let b = before.endsWith('\n\n') ? before.slice(0, -1) : before; // the blank line Connect added
    if (nl && b.endsWith('\n')) b = b.slice(0, -1);                  // the line break Connect added
    return b;
  }
  // Moved or followed by later text: drop the block, its line break, and one blank line around it.
  const rest = after.startsWith('\n') ? after.slice(1) : after;
  return (before.endsWith('\n\n') && rest.startsWith('\n')) || (before === '' && rest.startsWith('\n')) ? before + rest.slice(1) : before + rest;
}

// ─── the tool server registration ────────────────────────────────────────────
function run(cmd, args) {
  return new Promise(res => execFile(cmd, args, { timeout: 30_000, env: { ...process.env, HOME } },
    (err, stdout, stderr) => res({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || ''), err: String(stderr || ''), spawnError: err && typeof err.code === 'string' ? err.code : null })));
}
const wanted = () => ({ command: process.execPath, args: MCP_JS });
const addArgs = () => ['mcp', 'add', '--scope', 'user', 'brainmap', '--', process.execPath, MCP_JS];

// { state: 'missing' | 'current' | 'other', scope, command, args } from `claude mcp get brainmap`.
async function registration(claudePath) {
  const r = await run(claudePath, ['mcp', 'get', 'brainmap']);
  if (r.spawnError) throw fail(500, notFoundMessage(`it could not be started (${r.spawnError})`));
  if (r.code !== 0) return { state: 'missing' };
  const line = name => (r.out.match(new RegExp(`^\\s*${name}:[ \\t]*(.*)$`, 'm')) || [])[1]?.trim() ?? '';
  const scope = line('Scope'), command = line('Command'), args = line('Args');
  const w = wanted();
  return { state: /^User\b/.test(scope) && command === w.command && args === w.args ? 'current' : 'other', scope, command, args };
}

function notFoundMessage(why, env) {
  return `The claude command was not found, so the brainmap tool server cannot be registered with Claude Code (${why}). `
    + `The Brain app looked in your login shell's PATH${env?.shell ? ` (${env.shell})` : ''}${CLAUDE_SPOTS.length ? ` and in ${CLAUDE_SPOTS.map(tilde).join(', ')}` : ''}. `
    + 'Install Claude Code, open a new Terminal window and check that `claude --version` works there, then reload this page. '
    + 'The CLAUDE.md block does not need the command and is written either way.';
}

// ─── preview, connect, remove ────────────────────────────────────────────────
export async function connectStatus({ fresh = false } = {}) {
  const env = await assistantEnv({ fresh });
  const text = await readText(CLAUDE_MD);
  const plan = planFile(text, BRAIN_LABEL);
  const hasBlock = text !== null && BLOCK_RE.test(text);
  let reg = null, regError = null;
  if (env.claudePath) { try { reg = await registration(env.claudePath); } catch (e) { regError = e.message; } }
  else regError = notFoundMessage(env.claude ? 'your shell knows it only by name, as an alias or function, and it is in none of the usual places' : 'not installed, or not on your PATH', env);
  const removeText = hasBlock ? withoutBlock(text) : null;
  return {
    claude: env.claude || !!env.claudePath,
    claudePath: env.claudePath || null,
    // Installed in a usual place, but a new Terminal window would not find `claude` by name.
    notOnPath: !env.claude && !!env.claudePath,
    file: {
      path: tilde(CLAUDE_MD), exists: text !== null, hasBlock, action: plan.action,
      text: blockBody(BRAIN_LABEL),
      backup: plan.action === 'add' && text !== null && text !== '' ? tilde(await backupName()) : null,
      removeDeletes: hasBlock && flag(text, 'created-file') && removeText.trim() === '',
    },
    mcp: {
      registered: reg ? reg.state !== 'missing' : null, state: reg?.state ?? null, scope: reg?.scope ?? null,
      current: reg?.command ? `${reg.command} ${reg.args}` : null,
      add: env.claudePath ? `${env.claudePath} ${addArgs().join(' ')}` : null,
      remove: env.claudePath ? `${env.claudePath} mcp remove --scope user brainmap` : null,
      error: regError,
    },
    connected: hasBlock, // the installer registers the tool server too, so only the block means "connected"
    upToDate: plan.action === 'current' && reg?.state === 'current',
    expect: hash(text),
  };
}

// ~/.claude/CLAUDE.md.before-brain-2026-11-19, or -2, -3 when that name is taken.
async function backupName() {
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; // local date
  for (let i = 1; ; i++) {
    const p = `${CLAUDE_MD}.before-brain-${day}${i > 1 ? `-${i}` : ''}`;
    try { await access(p); } catch { return p; }
  }
}

function checkUnchanged(text, expect) {
  if (hash(text) !== expect) throw fail(409, `${tilde(CLAUDE_MD)} changed since the preview. Review the text again.`);
}

export async function connectClaude(expect) {
  const env = await assistantEnv({ fresh: true });
  const text = await readText(CLAUDE_MD);
  checkUnchanged(text, expect);
  const plan = planFile(text, BRAIN_LABEL);
  const out = { file: { path: tilde(CLAUDE_MD), action: plan.action, backup: null }, mcp: null };
  if (plan.action !== 'current') {
    if (plan.action === 'add' && text) { // first edit of a file that has the person's own content
      const b = await backupName();
      await copyFile(CLAUDE_MD, b);
      out.file.backup = tilde(b);
    }
    await mkdir(dirname(CLAUDE_MD), { recursive: true });
    await writeFile(CLAUDE_MD, plan.after, 'utf8');
  }
  if (!env.claudePath) out.mcp = { ok: false, error: notFoundMessage('not installed, or not on your PATH', env) };
  else {
    let reg;
    try { reg = await registration(env.claudePath); } catch (e) { out.mcp = { ok: false, error: e.message }; }
    if (reg?.state === 'current') out.mcp = { ok: true, action: 'current' };
    else if (reg) {
      if (reg.state === 'other') await run(env.claudePath, ['mcp', 'remove', '--scope', 'user', 'brainmap']);
      const r = await run(env.claudePath, addArgs());
      out.mcp = r.code === 0
        ? { ok: true, action: reg.state === 'other' ? 'update' : 'add', command: `claude ${addArgs().join(' ')}` }
        : { ok: false, error: `claude mcp add failed: ${(r.err || r.out).trim().split('\n')[0] || `exit ${r.code}`}` };
    }
  }
  return { ok: !!out.mcp?.ok, ...out };
}

export async function disconnectClaude(expect) {
  const env = await assistantEnv({ fresh: true });
  const text = await readText(CLAUDE_MD);
  checkUnchanged(text, expect);
  const out = { file: { path: tilde(CLAUDE_MD), action: 'none' }, mcp: { action: 'none' } };
  if (text !== null && BLOCK_RE.test(text)) {
    const rest = withoutBlock(text);
    if (rest.trim() === '' && flag(text, 'created-file')) { await unlink(CLAUDE_MD); out.file.action = 'deleted'; }
    else { await writeFile(CLAUDE_MD, rest, 'utf8'); out.file.action = 'removed'; }
  }
  if (env.claudePath) {
    const reg = await registration(env.claudePath).catch(() => null);
    if (reg && reg.state !== 'missing' && /^User\b/.test(reg.scope || '')) {
      const r = await run(env.claudePath, ['mcp', 'remove', '--scope', 'user', 'brainmap']);
      out.mcp = r.code === 0 ? { action: 'removed' } : { action: 'failed', error: (r.err || r.out).trim().split('\n')[0] };
    }
  } else out.mcp = { action: 'skipped', error: notFoundMessage('not installed, or not on your PATH', env) };
  return { ok: true, ...out };
}
