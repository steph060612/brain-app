// Gemini (Google Takeout "My Activity") parser — reads ~/brain-exports/gemini/, writes ~/.brain/imports/gemini/
// Safe: never touches ~/Brain or the project directory, never opens attachment files. Runnable as a script.
//
// The export is a flat, newest-first list of activity cards (MyActivity.html). Each "Prompted" card is one
// turn: prompt, timestamp, rendered response HTML. The caption's gemini.google.com/app/<id> link is the
// conversation ID, so turns are grouped by it and sorted oldest-first.
import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join, extname } from 'path';
import { homedir } from 'os';
import { CHARS_PER_CALL } from './claude-parser.js';

const EXPORTS_DIR = join(homedir(), 'brain-exports', 'gemini');
const IMPORT_BASE = join(homedir(), '.brain', 'imports', 'gemini');
const CONV_DIR    = join(IMPORT_BASE, 'conversations');

const CONV_LINK = /gemini\.google\.com\/app\/([0-9a-f]{8,})/i;
const TITLE_LEN = 60;

// ── Locate the activity file ──────────────────────────────────────────────────

// Folder names are translated with the account language, so search by file name + content.
async function findActivityFile(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isFile() && e.name === 'MyActivity.html') {
      const html = await readFile(p, 'utf8');
      if (CONV_LINK.test(html)) return { path: p, html };
    }
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      const found = await findActivityFile(join(dir, e.name));
      if (found) return found;
    }
  }
  return null;
}

// ── Minimal HTML tree ─────────────────────────────────────────────────────────

const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const RAW  = new Set(['script', 'style']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function parseAttrs(s) {
  const attrs = {};
  for (const m of s.matchAll(/([^\s=\/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
    attrs[m[1].toLowerCase()] = decode(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

// Tolerant tokenizer → tree of { tag, attrs, children } and text strings.
function parseHtml(html) {
  const root  = { tag: '#root', attrs: {}, children: [] };
  const stack = [root];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>/gi;
  let last = 0, m;
  while ((m = re.exec(html))) {
    if (m.index > last) stack.at(-1).children.push(decode(html.slice(last, m.index)));
    last = re.lastIndex;
    if (!m[2]) continue; // comment / doctype
    const tag = m[2].toLowerCase();
    if (m[1]) {
      const i = stack.findLastIndex(n => n.tag === tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const node = { tag, attrs: parseAttrs(m[3]), children: [] };
    stack.at(-1).children.push(node);
    if (RAW.has(tag)) {
      const end = html.toLowerCase().indexOf(`</${tag}`, last);
      last = re.lastIndex = end < 0 ? html.length : html.indexOf('>', end) + 1;
      continue;
    }
    if (!VOID.has(tag) && !m[4]) stack.push(node);
  }
  if (last < html.length) stack.at(-1).children.push(decode(html.slice(last)));
  return root;
}

const classes = n => (n.attrs?.class || '').split(/\s+/);

function findAll(node, pred, out = []) {
  for (const c of node.children || []) {
    if (typeof c === 'string') continue;
    if (pred(c)) out.push(c); else findAll(c, pred, out);
  }
  return out;
}

// ── HTML → plain text (lists preserved) ───────────────────────────────────────

const BLOCK = new Set(['p', 'div', 'section', 'article', 'blockquote', 'pre', 'table', 'thead', 'tbody',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'ul', 'ol', 'figure']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.heif', '.bmp', '.svg', '.tif', '.tiff']);

function attachmentPlaceholder(href) {
  let name = href.split(/[\\/]/).pop() || '';
  try { name = decodeURIComponent(name); } catch { }
  return IMAGE_EXT.has(extname(name).toLowerCase()) ? '[image]' : (name ? `[file: ${name}]` : '[file]');
}
const isLocal = href => !!href && !/^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith('//') && !href.startsWith('#');

// Render nodes to text. Lists become "- item" / "1. item", nested with two-space indent.
function toText(nodes) {
  let out = '';
  const nl = (n = 1) => { out = out.replace(/[ \t]+$/, ''); const have = out.match(/\n*$/)[0].length; if (out) out += '\n'.repeat(Math.max(0, n - have)); };

  function walk(node, ctx) {
    if (typeof node === 'string') {
      const t = ctx.pre ? node : node.replace(/\s+/g, ' ');
      if (!ctx.pre && /\n$|^$/.test(out)) out += t.replace(/^ /, ''); else out += t;
      return;
    }
    const { tag } = node;
    if (tag === 'br') { out = out.replace(/ +$/, ''); out += '\n' + ctx.indent; return; }
    if (tag === 'img') { out += '[image]'; return; }
    if (tag === 'a' && isLocal(node.attrs.href)) { out += attachmentPlaceholder(node.attrs.href); return; }
    if (tag === 'ul' || tag === 'ol') {
      nl(ctx.depth ? 1 : 2);
      let i = 0;
      for (const c of node.children) {
        if (typeof c === 'string') continue;
        if (c.tag !== 'li') { walk(c, ctx); continue; }
        i++;
        const bullet = tag === 'ol' ? `${(parseInt(node.attrs.start, 10) || 1) + i - 1}. ` : '- ';
        nl(1);
        out += ctx.indent + bullet;
        const sub = { ...ctx, depth: ctx.depth + 1, indent: ctx.indent + '  ' };
        for (const cc of c.children) walk(cc, sub);
        out = out.replace(/\s+$/, '');
      }
      nl(ctx.depth ? 1 : 2);
      return;
    }
    if (tag === 'tr') {
      nl(1);
      const cells = node.children.filter(c => typeof c !== 'string');
      cells.forEach((c, j) => { if (j) out += ' | '; for (const cc of c.children) walk(cc, ctx); });
      nl(1);
      return;
    }
    const block = BLOCK.has(tag);
    if (block) { ctx.depth ? nl(1) : nl(2); if (ctx.depth) out += ctx.indent; }
    if (tag === 'hr') { out += '---'; nl(2); return; }
    const sub = tag === 'pre' ? { ...ctx, pre: true } : ctx;
    for (const c of node.children) walk(c, sub);
    if (block) ctx.depth ? nl(1) : nl(2);
  }

  for (const n of nodes) walk(n, { depth: 0, indent: '', pre: false });
  return out.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── Cards ─────────────────────────────────────────────────────────────────────

const MONTHS = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
// "Oct 28, 2026, 2:14:06 PM EDT" — the zone label is ignored (Takeout stamps one label on every date).
const TS = /^([A-Z][a-z]{2}) (\d{1,2}), (\d{4}), (\d{1,2}):(\d{2}):(\d{2})[\s ]?([AP]M)(?:[\s ]+\S+)?$/;

function parseTimestamp(s) {
  const m = s.trim().match(TS);
  if (!m || !(m[1] in MONTHS)) return null;
  let h = parseInt(m[4], 10) % 12;
  if (m[7] === 'PM') h += 12;
  const d = new Date(+m[3], MONTHS[m[1]], +m[2], h, +m[5], +m[6]); // local time
  return Number.isNaN(d.getTime()) ? null : d;
}

const PROMPT_PREFIX = /^Prompted(?:[\s ]+|$)/; // alone when the prompt starts with an element
const ATTACHED_LINE = /^Attached \d+ files?\.$/;

function parseCard(card) {
  const cells   = findAll(card, n => classes(n).includes('content-cell'));
  const body    = cells.find(n => classes(n).includes('mdl-typography--body-1') && !classes(n).includes('mdl-typography--text-right'));
  const caption = cells.find(n => classes(n).includes('mdl-typography--caption'));
  if (!body) return { skip: 'no body cell' };

  // Split body children at the first timestamp text node: before = prompt, after = response.
  let tsIndex = -1, date = null;
  body.children.forEach((c, i) => {
    if (tsIndex < 0 && typeof c === 'string') {
      const d = parseTimestamp(c);
      if (d) { tsIndex = i; date = d; }
    }
  });
  if (tsIndex < 0) return { skip: 'no timestamp' };

  const before = body.children.slice(0, tsIndex);
  const firstText = before.find(c => typeof c === 'string' && c.trim());
  if (!firstText || !PROMPT_PREFIX.test(firstText.trim())) return { skip: 'activity event, not a prompt' };

  // Prompt: text nodes and inline elements before the timestamp, minus the "Prompted" prefix and
  // the "Attached N files." line; local links become attachment placeholders.
  const promptNodes = [];
  let stripped = false;
  for (const c of before) {
    if (typeof c === 'string') {
      let t = c;
      if (!stripped && t.trim()) { t = t.trim().replace(PROMPT_PREFIX, ''); stripped = true; }
      if (ATTACHED_LINE.test(t.trim())) continue;
      promptNodes.push(t);
    } else promptNodes.push(c);
  }
  const prompt   = toText(promptNodes);
  const response = toText(body.children.slice(tsIndex + 1));

  const link = caption && findAll(caption, n => n.tag === 'a' && CONV_LINK.test(n.attrs.href || ''))[0];
  if (!link) return { skip: 'no conversation link' };
  if (!prompt && !response) return { skip: 'empty prompt and response' };

  return { convId: 'gemini-' + link.attrs.href.match(CONV_LINK)[1].toLowerCase(), date, prompt, response };
}

// ── Conversations ─────────────────────────────────────────────────────────────

export async function parseConversations() {
  const found = await findActivityFile(EXPORTS_DIR);
  if (!found) return { total: 0, parsed: 0, skipped: 0, skippedReasons: {}, totalChars: 0, avgChars: 0, totalDistillCalls: 0, missing: true };
  await mkdir(CONV_DIR, { recursive: true });

  const cards = findAll(parseHtml(found.html), n => n.tag === 'div' && classes(n).includes('outer-cell'));

  const skippedReasons = {};
  const skip = reason => { skippedReasons[reason] = (skippedReasons[reason] || 0) + 1; };
  const groups = new Map();
  for (const card of cards) {
    const turn = parseCard(card);
    if (turn.skip) { skip(turn.skip); continue; }
    if (!groups.has(turn.convId)) groups.set(turn.convId, []);
    groups.get(turn.convId).push(turn);
  }

  const index = [];
  let totalChars = 0;
  for (const [id, turns] of groups) {
    turns.sort((a, b) => a.date - b.date);
    const lines = [];
    for (const t of turns) {
      if (t.prompt)   lines.push(`=== human ===\n${t.prompt}`);
      if (t.response) lines.push(`=== assistant ===\n${t.response}`);
    }
    const transcript = lines.join('\n\n');
    await writeFile(join(CONV_DIR, `${id}.txt`), transcript, 'utf8');

    const firstPrompt = (turns.find(t => t.prompt)?.prompt || '').replace(/\s+/g, ' ').trim();
    const charCount = transcript.length;
    totalChars += charCount;
    index.push({
      uuid:         id,
      title:        firstPrompt ? [...firstPrompt].slice(0, TITLE_LEN).join('') : '(untitled)',
      created:      turns[0].date.toISOString(),
      updated:      turns.at(-1).date.toISOString(),
      messageCount: lines.length,
      charCount,
      distillCalls: Math.ceil(charCount / CHARS_PER_CALL),
    });
  }

  await writeFile(join(CONV_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');

  const skipped = Object.values(skippedReasons).reduce((s, n) => s + n, 0);
  return {
    total:             cards.length, // activity entries, not conversations
    parsed:            index.length,
    skipped,
    skippedReasons,
    totalChars,
    avgChars:          index.length ? Math.round(totalChars / index.length) : 0,
    totalDistillCalls: index.reduce((s, x) => s + x.distillCalls, 0),
  };
}

export function getConvDir() { return CONV_DIR; }

// ── Entry point (node src/gemini-parser.js) ───────────────────────────────────

const isMain = process.argv[1] &&
  (process.argv[1].endsWith('gemini-parser.js') || process.argv[1].endsWith('gemini-parser'));

if (isMain) {
  parseConversations()
    .then(stats => { console.log(JSON.stringify(stats, null, 2)); })
    .catch(e => { console.error(e.message); process.exit(1); });
}
