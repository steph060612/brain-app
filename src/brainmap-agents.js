// "Enable for assistants": a short marked block in a linked project's AGENTS.md (or CLAUDE.md) that points
// coding assistants to the brainmap command. The block is shown to the person before it is written, it is
// the only thing ever added or removed, and nothing is committed inside the project.
import { readFile, writeFile, lstat, realpath, unlink } from 'fs/promises';
import { createHash } from 'crypto';
import { join } from 'path';
import { fail, inside, tilde } from './codemap-status.js';

export const START = '<!-- brainmap:start (added by the Brain app, "Enable for assistants"; remove it there or delete this block) -->';
export const END = '<!-- brainmap:end -->';
export const BLOCK = `${START}
## Code map (brainmap)
- Run \`brainmap overview\` first to see this project's structure.
- For structure questions, use \`brainmap file <path>\`, \`brainmap impact <path>\`, \`brainmap screen <name>\` and \`brainmap collection <name>\` before searching the whole repository. \`brainmap help\` lists the other commands.
- The map covers JavaScript files only (.js, .jsx, .mjs, .cjs). Check other languages, assets and configuration directly.
- brainmap is read-only and refreshes the map itself when the code has changed.
${END}`;

const BLOCK_RE = /\n*<!-- brainmap:start[^\n]*-->[\s\S]*?<!-- brainmap:end -->[ \t]*\n?/;
const hash = text => (text === null ? 'none' : createHash('sha1').update(text).digest('hex'));

async function read(folder, name) {
  const p = join(folder, name);
  try {
    if ((await lstat(p)).isSymbolicLink()) {
      const real = await realpath(p);
      if (!inside(real, folder)) return { name, path: p, text: null, outside: true };
    }
    return { name, path: p, text: await readFile(p, 'utf8') };
  } catch (e) {
    if (e.code === 'ENOENT') return { name, path: p, text: null };
    throw fail(500, `Could not read ${name}: ${e.message}`);
  }
}

// A CLAUDE.md that only sends readers to AGENTS.md, such as "@AGENTS.md" or "See AGENTS.md".
function pointsToAgents(text) {
  const body = text.replace(/<!--[\s\S]*?-->/g, '').trim();
  const lines = body.split('\n').filter(l => l.trim());
  return /AGENTS\.md/i.test(body) && body.length <= 300 && lines.length <= 4;
}

// Which file the block belongs in, and why.
async function target(folder) {
  const agents = await read(folder, 'AGENTS.md'), claude = await read(folder, 'CLAUDE.md');
  for (const f of [agents, claude]) if (f.outside) throw fail(400, `${f.name} links to a file outside the project folder; it is left alone.`);
  if (agents.text !== null && BLOCK_RE.test(agents.text)) return { ...agents, reason: 'The block is in AGENTS.md.' };
  if (claude.text !== null && BLOCK_RE.test(claude.text)) return { ...claude, reason: 'The block is in CLAUDE.md.' };
  if (agents.text !== null) return { ...agents, reason: 'The project has an AGENTS.md.' };
  if (claude.text !== null) {
    return pointsToAgents(claude.text)
      ? { ...agents, reason: 'CLAUDE.md only points to AGENTS.md, so AGENTS.md is created.' }
      : { ...claude, reason: 'The project has a CLAUDE.md and no AGENTS.md.' };
  }
  return { ...agents, reason: 'The project has neither file, so AGENTS.md is created.' };
}

function removed(text) {
  // Undo what enableAssistants added: the block and the blank line before it.
  const t = text.replace(BLOCK_RE, (m, offset) => {
    const before = text.slice(0, offset), after = text.slice(offset + m.length);
    if (!before.trim()) return '';
    if (!after.trim()) return '\n';
    return after.startsWith('\n') ? '\n' : '\n\n'; // keep one blank line between the neighbors
  });
  return t.trim() ? t : '';
}

export async function assistantsPreview(folder) {
  const t = await target(folder);
  const enabled = t.text !== null && BLOCK_RE.test(t.text);
  const afterRemove = enabled ? removed(t.text) : null;
  return {
    file: t.name, path: tilde(t.path), exists: t.text !== null, enabled, reason: t.reason,
    block: BLOCK, expect: hash(t.text),
    removeDeletesFile: enabled && afterRemove === '',
  };
}

export async function enableAssistants(folder, expect) {
  const t = await target(folder);
  if (expect !== hash(t.text)) throw fail(409, `${t.name} changed since the preview. Review the text again.`);
  if (t.text !== null && BLOCK_RE.test(t.text)) return { ok: true, file: t.name, already: true };
  const text = t.text === null || !t.text.trim()
    ? `${BLOCK}\n`
    : `${t.text}${t.text.endsWith('\n') ? '' : '\n'}\n${BLOCK}\n`;
  await writeFile(t.path, text, 'utf8');
  return { ok: true, file: t.name, created: t.text === null };
}

export async function removeAssistants(folder, expect) {
  const t = await target(folder);
  if (t.text === null || !BLOCK_RE.test(t.text)) return { ok: true, file: t.name, already: true };
  if (expect !== hash(t.text)) throw fail(409, `${t.name} changed since the preview. Review again.`);
  const rest = removed(t.text);
  if (rest === '') await unlink(t.path); // only the block was in it
  else await writeFile(t.path, rest, 'utf8');
  return { ok: true, file: t.name, deleted: rest === '' };
}
