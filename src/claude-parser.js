// Claude export parser — reads ~/brain-exports/claude/, writes ~/.brain/imports/claude/
// Safe: never touches ~/Brain or the project directory. Runnable as a script.
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join, dirname, basename, resolve } from 'path';
import { homedir } from 'os';

const EXPORTS_DIR  = join(homedir(), 'brain-exports', 'claude');
const IMPORT_BASE  = join(homedir(), '.brain', 'imports', 'claude');
const CONV_DIR     = join(IMPORT_BASE, 'conversations');
const MEM_DIR      = join(IMPORT_BASE, 'memories');

export const CHARS_PER_CALL = 40_000; // conservative estimate of distiller chunk capacity

// ── Branch reconstruction ─────────────────────────────────────────────────────

function getActiveBranch(messages) {
  if (!messages || messages.length === 0) return [];
  const byUuid     = new Map(messages.map(m => [m.uuid, m]));
  const parentSet  = new Set(messages.map(m => m.parent_message_uuid).filter(Boolean));
  const leaves     = messages.filter(m => !parentSet.has(m.uuid));
  if (leaves.length === 0) return messages.slice(); // degenerate fallback

  const latestLeaf = leaves.reduce((a, b) =>
    new Date(a.created_at) > new Date(b.created_at) ? a : b
  );

  const branch = [];
  let cur = latestLeaf;
  const seen = new Set();
  while (cur && !seen.has(cur.uuid)) {
    branch.unshift(cur);
    seen.add(cur.uuid);
    cur = cur.parent_message_uuid ? byUuid.get(cur.parent_message_uuid) : null;
  }
  return branch;
}

// ── Content cleaning ──────────────────────────────────────────────────────────

const SKIP_TYPES = new Set([
  'thinking', 'tool_use', 'tool_result', 'injected_prompt_block', 'token_budget',
]);

function cleanMessage(msg) {
  const blocks = Array.isArray(msg.content) ? msg.content : [];
  const parts  = [];

  for (const blk of blocks) {
    if (!blk || typeof blk !== 'object') continue;
    const { type } = blk;
    if (SKIP_TYPES.has(type)) continue;
    if (type === 'text')     { if (blk.text && blk.text.trim()) parts.push(blk.text.trim()); }
    else if (type === 'image')    { parts.push('[image]'); }
    else if (type === 'document') { parts.push('[document]'); }
  }

  // Fallback to top-level text field if content blocks produced nothing
  if (parts.length === 0 && msg.text && msg.text.trim()) return msg.text.trim();

  // files[] = uploaded file metadata with no inline content — add placeholders
  if (parts.length === 0 && Array.isArray(msg.files)) {
    for (const f of msg.files) {
      if (f && f.file_name) parts.push(`[file: ${f.file_name}]`);
      else parts.push('[file]');
    }
  }

  return parts.join('\n\n');
}

// ── Conversations ─────────────────────────────────────────────────────────────

export async function parseConversations() {
  const src = join(EXPORTS_DIR, 'conversations', 'conversations.json');
  const raw = JSON.parse(await readFile(src, 'utf8'));
  await mkdir(CONV_DIR, { recursive: true });

  const index = [];
  let totalChars = 0;
  let skipped    = 0;

  for (const conv of raw) {
    const msgs = conv.chat_messages || [];
    if (msgs.length === 0) { skipped++; continue; }

    const branch = getActiveBranch(msgs);
    const lines  = [];

    for (const msg of branch) {
      const role = msg.sender === 'human' ? 'human' : 'assistant';
      const text = cleanMessage(msg);
      if (text.trim()) lines.push(`=== ${role} ===\n${text}`);
    }

    if (lines.length === 0) { skipped++; continue; }

    const transcript = lines.join('\n\n');
    await writeFile(join(CONV_DIR, `${conv.uuid}.txt`), transcript, 'utf8');

    const charCount = transcript.length;
    totalChars += charCount;
    index.push({
      uuid:         conv.uuid,
      title:        conv.name || '(untitled)',
      created:      conv.created_at  || null,
      updated:      conv.updated_at  || null,
      messageCount: branch.length,
      charCount,
      distillCalls: Math.ceil(charCount / CHARS_PER_CALL),
    });
  }

  await writeFile(join(CONV_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  return {
    total:             raw.length,
    parsed:            index.length,
    skipped,
    totalChars,
    avgChars:          index.length ? Math.round(totalChars / index.length) : 0,
    totalDistillCalls: index.reduce((s, x) => s + x.distillCalls, 0),
  };
}

// ── Memories ──────────────────────────────────────────────────────────────────

async function walkFiles(dir, result = []) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return result; }
  for (const e of entries) {
    if (e.isDirectory()) await walkFiles(join(dir, e.name), result);
    else result.push(join(dir, e.name));
  }
  return result;
}

export async function parseMemories() {
  const memDir  = join(EXPORTS_DIR, 'memories', 'memories');
  let files;
  try { files = (await readdir(memDir)).filter(f => f.endsWith('.json')); }
  catch { return { convMemoryChars: 0, projectMemCount: 0, fileCount: 0, totalChars: 0, totalDistillCalls: 0 }; }

  if (files.length === 0) return { convMemoryChars: 0, projectMemCount: 0, fileCount: 0, totalChars: 0, totalDistillCalls: 0 };

  const mem = JSON.parse(await readFile(join(memDir, files[0]), 'utf8'));
  await mkdir(join(MEM_DIR, 'memory_files'), { recursive: true });
  await mkdir(join(MEM_DIR, 'project_memories'), { recursive: true });

  let totalChars = 0;
  let convMemoryChars = 0;

  // conversations_memory (one free-form string)
  if (mem.conversations_memory) {
    await writeFile(join(MEM_DIR, 'conversations_memory.txt'), mem.conversations_memory, 'utf8');
    convMemoryChars = mem.conversations_memory.length;
    totalChars += convMemoryChars;
  }

  // project_memories (dict: project_uuid → string)
  const projMems = mem.project_memories || {};
  for (const [uuid, content] of Object.entries(projMems)) {
    if (!content) continue;
    await writeFile(join(MEM_DIR, 'project_memories', `${uuid}.txt`), content, 'utf8');
    totalChars += content.length;
  }

  // memory_files (array of {path, content, updated_at})
  const memFiles = mem.memory_files || [];
  let mfCount = 0;
  for (const mf of memFiles) {
    if (!mf.content) continue;
    const safePath = (mf.path || `file_${mfCount}`)
      .replace(/\.\./g, '_')
      .replace(/^\/+/, '');
    const absPath = resolve(join(MEM_DIR, 'memory_files'), safePath);
    // Security: must stay inside memory_files dir
    if (!absPath.startsWith(join(MEM_DIR, 'memory_files'))) continue;
    await mkdir(dirname(absPath), { recursive: true });
    await writeFile(absPath, mf.content, 'utf8');
    totalChars += mf.content.length;
    mfCount++;
  }

  return {
    convMemoryChars,
    projectMemCount: Object.keys(projMems).length,
    fileCount:       mfCount,
    totalChars,
    totalDistillCalls: Math.ceil(totalChars / CHARS_PER_CALL),
  };
}

// ── All-in-one ────────────────────────────────────────────────────────────────

export async function runParse() {
  const [convStats, memStats] = await Promise.all([
    parseConversations(),
    parseMemories(),
  ]);
  return { conversations: convStats, memories: memStats };
}

export function getImportBase() { return IMPORT_BASE; }
export function getConvDir()    { return CONV_DIR; }
export function getMemDir()     { return MEM_DIR; }

// ── Entry point (node src/claude-parser.js) ───────────────────────────────────

const isMain = process.argv[1] &&
  (process.argv[1].endsWith('claude-parser.js') || process.argv[1].endsWith('claude-parser'));

if (isMain) {
  runParse()
    .then(stats => { console.log(JSON.stringify(stats, null, 2)); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
