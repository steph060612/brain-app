// "Enable for assistants": a short marked block that tells coding assistants to use the brainmap command.
// It goes into every one of CLAUDE.md and AGENTS.md that exists in the linked folder (Claude Code loads
// CLAUDE.md by itself, other assistants read AGENTS.md); when neither exists, both are created. The exact
// text per file is shown before anything is written, only the marked block is ever added, updated or
// removed, and nothing is committed inside the project.
import { readFile, writeFile, lstat, realpath, unlink } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { fail, inside, tilde } from './codemap-status.js';

export const FILES = ['CLAUDE.md', 'AGENTS.md'];

// The start marker records, per file, whether the app created that file, so Remove deletes a file only
// when the app made it and nothing else was added since. A file that existed before is never deleted.
export const start = created => `<!-- brainmap:start created-file=${created ? 'yes' : 'no'} (added by the Brain app, "Enable for assistants"; remove it there or delete this block) -->`;
export const END = '<!-- brainmap:end -->';
// env (src/assistant-env.js) says whether Claude Code is installed and how `brainmap` is run. With Claude Code the
// block names its tools first (it has them as mcp__brainmap__*); without it (Codex and others) it names only the
// command, as a full path when `brainmap` does not run by name. No env means Claude Code is present.
const CLAUDE_ENV = { claude: true, brainmapCommand: 'brainmap' };
export const block = (created, env = CLAUDE_ENV) => (env.claude ? `${start(created)}
## Code map: use brainmap first
- For questions about how this code fits together (who calls, uses or depends on what, where something happens), use the brainmap tools (mcp__brainmap__*) or the \`brainmap\` command before searching the repository.
- Start with \`report\` or \`overview\`; for a question in words, use \`query\`.
- The tool list or \`brainmap help\` shows the rest. The map covers JavaScript and TypeScript, is read-only and refreshes itself.
${END}` : `${start(created)}
## Code map: use brainmap first
- For questions about how this code fits together (who calls, uses or depends on what, where something happens), run \`${env.brainmapCommand} overview\` in a shell before searching the repository.
- Then the matching command: \`${env.brainmapCommand} query "<question in words>"\`, \`${env.brainmapCommand} impact <file>\`, \`${env.brainmapCommand} callers <function>\`, \`${env.brainmapCommand} collection <name>\`, \`${env.brainmapCommand} report\`.
- \`${env.brainmapCommand} help\` lists every command. The map covers JavaScript and TypeScript, is read-only and refreshes itself.
${END}`);

const BLOCK_RE = /\n*<!-- brainmap:start[^\n]*-->[\s\S]*?<!-- brainmap:end -->[ \t]*\n?/g;
const ONE_BLOCK_RE = /<!-- brainmap:start[^\n]*-->[\s\S]*?<!-- brainmap:end -->/;
const hasBlock = text => text !== null && ONE_BLOCK_RE.test(text);
// Only an explicit created-file=yes counts; a block without the flag is treated as added to an existing file.
const createdByApp = text => /<!-- brainmap:start created-file=yes\b/.test(text);
const hash = text => (text === null ? 'none' : createHash('sha1').update(text).digest('hex'));

async function read(folder, name) {
  const p = join(folder, name);
  try {
    let real = p;
    if ((await lstat(p)).isSymbolicLink()) {
      real = await realpath(p);
      if (!inside(real, folder)) throw fail(400, `${name} links to a file outside the project folder; it is left alone.`);
    }
    return { name, path: p, real, text: await readFile(p, 'utf8') };
  } catch (e) {
    if (e.status) throw e;
    if (e.code === 'ENOENT') return { name, path: p, real: p, text: null };
    throw fail(500, `Could not read ${name}: ${e.message}`);
  }
}

// Undo what enable added: every block and the blank line before it.
function removed(text) {
  let atStart = false;
  let t = text.replace(BLOCK_RE, (m, offset) => {
    const before = text.slice(0, offset), after = text.slice(offset + m.length);
    if (!before.trim()) { atStart = true; return ''; }
    if (!after.trim()) return '\n';
    return after.startsWith('\n') ? '\n' : '\n\n'; // keep one blank line between the neighbors
  });
  if (atStart) t = t.replace(/^\s*\n/, ''); // the block was first: no blank line left at the top
  return t.trim() ? t : '';
}

// The first block replaced by the current wording, in place; any further copies dropped, so a file never
// holds two blocks.
function withOneBlock(text, current) {
  let first = true;
  return text.replace(BLOCK_RE, (m, offset) => {
    if (first) { first = false; return m.replace(ONE_BLOCK_RE, () => current); }
    const before = text.slice(0, offset), after = text.slice(offset + m.length);
    if (!after.trim()) return before.endsWith('\n') ? '' : '\n'; // last in the file: end with one newline
    return after.startsWith('\n') ? '\n' : '\n\n';
  });
}

// What Enable would do to each file: create it, add the block, update an existing block, or nothing.
// When CLAUDE.md is a link to AGENTS.md (or the reverse), the shared file gets the block once.
// Without Claude Code only AGENTS.md is written: CLAUDE.md is never created, and an existing one is left as it is
// ('no-claude'), though Remove still takes out a block found in it.
async function plan(folder, env = CLAUDE_ENV) {
  const files = [];
  for (const name of FILES) files.push(await read(folder, name));
  const neither = files.every(f => f.text === null);
  const seen = new Set();
  return files.map(f => {
    const shared = f.text !== null && seen.has(f.real);
    seen.add(f.real);
    const exists = f.text !== null;
    const enabled = hasBlock(f.text);
    let action, created, after = null;
    if (shared) { action = 'shared'; created = false; }
    else if (!env.claude && f.name === 'CLAUDE.md') { action = 'no-claude'; created = enabled && createdByApp(f.text); }
    else if (!exists) {
      const make = neither || (!env.claude && f.name === 'AGENTS.md');
      action = make ? 'create' : 'skip';
      created = true;
      if (make) after = `${block(true, env)}\n`;
    } else if (enabled) {
      created = createdByApp(f.text);
      after = withOneBlock(f.text, block(created, env)); // keeps this file's marker
      action = after === f.text ? 'current' : 'update';
    } else {
      created = false;
      after = f.text.trim() ? `${f.text}${f.text.endsWith('\n') ? '' : '\n'}\n${block(false, env)}\n` : `${f.text}${block(false, env)}\n`;
      action = 'add';
    }
    const rest = enabled && !shared ? removed(f.text) : null;
    return {
      ...f, exists, enabled, action, created, after,
      sharedWith: shared ? files.find(o => o !== f && o.real === f.real)?.name : null,
      removeDeletes: enabled && !shared && createdByApp(f.text) && rest === '',
      removeLeavesEmpty: enabled && !shared && !createdByApp(f.text) && rest === '',
    };
  });
}

const expectOf = files => Object.fromEntries(files.map(f => [f.name, hash(f.text)]));
function checkUnchanged(files, expect) {
  const changed = files.filter(f => !expect || expect[f.name] !== hash(f.text)).map(f => f.name);
  if (changed.length) throw fail(409, `${changed.join(' and ')} changed since the preview. Review the text again.`);
}

export async function assistantsPreview(folder, env = CLAUDE_ENV) {
  const files = await plan(folder, env);
  const work = files.filter(f => ['create', 'add', 'update'].includes(f.action));
  return {
    enabled: files.some(f => f.enabled),
    upToDate: files.some(f => f.enabled) && !work.length,
    files: files.map(f => ({
      name: f.name, path: tilde(f.path), exists: f.exists, enabled: f.enabled, action: f.action, sharedWith: f.sharedWith,
      createdByApp: f.enabled ? createdByApp(f.text) : f.action === 'create',
      text: ['create', 'add', 'update'].includes(f.action) ? block(f.created, env) : null,
      removeDeletes: f.removeDeletes, removeLeavesEmpty: f.removeLeavesEmpty,
    })),
    expect: expectOf(files),
  };
}

export async function enableAssistants(folder, expect, env = CLAUDE_ENV) {
  const files = await plan(folder, env);
  checkUnchanged(files, expect);
  const done = [];
  for (const f of files) {
    if (!['create', 'add', 'update'].includes(f.action)) continue;
    await writeFile(f.path, f.after, 'utf8');
    done.push({ file: f.name, action: f.action });
  }
  return { ok: true, files: done };
}

export async function removeAssistants(folder, expect, env = CLAUDE_ENV) {
  const files = await plan(folder, env);
  checkUnchanged(files, expect);
  const done = [];
  for (const f of files) {
    if (!f.enabled || f.action === 'shared') continue;
    const rest = removed(f.text);
    const del = rest === '' && createdByApp(f.text); // the app made this file and nothing else was added
    if (del) await unlink(f.path);
    else await writeFile(f.path, rest, 'utf8');
    done.push({ file: f.name, deleted: del, leftEmpty: rest === '' && !del });
  }
  return { ok: true, files: done };
}
