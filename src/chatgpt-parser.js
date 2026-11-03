// ChatGPT export parser — reads ~/brain-exports/ChatGPT_Data-Export/, writes ~/.brain/imports/chatgpt/
// Safe: never touches ~/Brain or the project directory. Runnable as a script.
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { CHARS_PER_CALL, fallbackTitle } from './claude-parser.js';

const EXPORT_FILE = join(homedir(), 'brain-exports', 'ChatGPT_Data-Export', 'conversations.json');
const IMPORT_BASE = join(homedir(), '.brain', 'imports', 'chatgpt');
const CONV_DIR    = join(IMPORT_BASE, 'conversations');

// ── Branch reconstruction ─────────────────────────────────────────────────────

// Walk from current_node up through parent links, then reverse to root → leaf.
function getActiveBranch(conv) {
  const mapping = conv.mapping || {};
  const branch  = [];
  const seen    = new Set();
  let cur = conv.current_node;
  while (cur && mapping[cur] && !seen.has(cur)) {
    seen.add(cur);
    if (mapping[cur].message) branch.unshift(mapping[cur].message);
    cur = mapping[cur].parent;
  }
  return branch;
}

// ── Content cleaning ──────────────────────────────────────────────────────────

const KEEP_ROLES = new Set(['user', 'assistant']);
const KEEP_TYPES = new Set(['text', 'multimodal_text']); // thoughts, reasoning_recap etc. are dropped

function cleanMessage(msg) {
  const content = msg.content || {};
  if (!KEEP_TYPES.has(content.content_type)) return '';

  const parts = [];
  for (const p of content.parts || []) {
    if (typeof p === 'string') { if (p.trim()) parts.push(p.trim()); }
    else if (p && typeof p === 'object' && p.content_type === 'image_asset_pointer') parts.push('[image]');
  }

  // Image attachments duplicate the image_asset_pointer parts; only add the others.
  for (const a of msg.metadata?.attachments || []) {
    if (!a || String(a.mime_type || '').startsWith('image/')) continue;
    parts.push(a.name ? `[file: ${a.name}]` : '[file]');
  }

  return parts.join('\n\n');
}

const toIso = t => (typeof t === 'number' ? new Date(t * 1000).toISOString() : null);

// ── Conversations ─────────────────────────────────────────────────────────────

export async function parseConversations() {
  let raw;
  try { raw = JSON.parse(await readFile(EXPORT_FILE, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return { total: 0, parsed: 0, skipped: 0, skippedReasons: {}, totalChars: 0, avgChars: 0, totalDistillCalls: 0, missing: true };
    throw e;
  }
  await mkdir(CONV_DIR, { recursive: true });

  const index = [];
  const skippedReasons = {};
  const skip = reason => { skippedReasons[reason] = (skippedReasons[reason] || 0) + 1; };
  let totalChars = 0;

  for (const conv of raw) {
    const id = conv.id || conv.conversation_id;
    if (!id || !/^[0-9a-f-]{8,}$/i.test(id)) { skip('missing or invalid id'); continue; }
    if (!conv.mapping || Object.keys(conv.mapping).length === 0) { skip('no messages'); continue; }

    const branch = getActiveBranch(conv);
    if (branch.length === 0) { skip('current_node missing or not in mapping'); continue; }

    const lines = [];
    let firstHuman = '';
    for (const msg of branch) {
      const role = msg.author?.role;
      if (!KEEP_ROLES.has(role)) continue;
      const text = cleanMessage(msg);
      if (text.trim()) lines.push(`=== ${role === 'user' ? 'human' : 'assistant'} ===\n${text}`);
      if (role === 'user' && !firstHuman && text.trim()) firstHuman = text;
    }

    if (lines.length === 0) { skip('no user/assistant text on active branch'); continue; }

    const transcript = lines.join('\n\n');
    await writeFile(join(CONV_DIR, `${id}.txt`), transcript, 'utf8');

    const charCount = transcript.length;
    totalChars += charCount;
    index.push({
      uuid:         id,
      title:        fallbackTitle(conv.title, conv.summary, firstHuman),
      created:      toIso(conv.create_time),
      updated:      toIso(conv.update_time),
      messageCount: lines.length,
      charCount,
      distillCalls: Math.ceil(charCount / CHARS_PER_CALL),
    });
  }

  await writeFile(join(CONV_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  const skipped = Object.values(skippedReasons).reduce((s, n) => s + n, 0);
  return {
    total:             raw.length,
    parsed:            index.length,
    skipped,
    skippedReasons,
    totalChars,
    avgChars:          index.length ? Math.round(totalChars / index.length) : 0,
    totalDistillCalls: index.reduce((s, x) => s + x.distillCalls, 0),
  };
}

export function getConvDir() { return CONV_DIR; }

// ── Entry point (node src/chatgpt-parser.js) ──────────────────────────────────

const isMain = process.argv[1] &&
  (process.argv[1].endsWith('chatgpt-parser.js') || process.argv[1].endsWith('chatgpt-parser'));

if (isMain) {
  parseConversations()
    .then(stats => { console.log(JSON.stringify(stats, null, 2)); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
