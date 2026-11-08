// Close-session proposals: parse README UPDATE PROTOCOL blocks and apply one approved block to its target.
// Plain code, no AI. Used by server.js (paste → inbox items, approve → target edit).
//
//   ### FILE: [relative path]          (also FILE:, **FILE:**, or a heading of any level)
//   ### ACTION: create | append | replace-section [section heading] | replace-line | frontmatter
//   [content]

export const ACTIONS = ['create', 'append', 'replace-section', 'replace-line', 'frontmatter'];

const PERMALINK = /^[ \t]*permalink[ \t]*:/im;

// A label line, tolerant of copied chat output: "### FILE: x", "FILE: x", "**FILE:** x", "**FILE**: x",
// "**FILE: x**", "## **ACTION:** x", "- OLD: x". Groups: heading, open bold, word, close bold, bold after
// the colon, value (one space after the colon is dropped, the rest is kept as is).
const LABEL_RE = /^[ \t]*(#{1,6}[ \t]*)?(?:[-*][ \t]+)?(\*\*|__)?([A-Za-z]+)(?:[ \t]+line)?(\*\*|__)?[ \t]*:(?:[ \t]*(\*\*|__))?[ \t]?(.*)$/;

// Returns { word, value } when line is a label for one of words, else null. A plain label (no heading
// marker, no bold) must be uppercase, so content such as "File: notes" is not taken for a new block.
// caseInsensitive: also accept plain lowercase labels (OLD/NEW inside a replace-line block).
function matchLabel(line, words, caseInsensitive = false) {
  const m = line.match(LABEL_RE);
  if (!m) return null;
  const [, heading, open, word, close, after, raw] = m;
  const upper = word.toUpperCase();
  if (!words.includes(upper)) return null;
  if (!heading && !open && !close && !after && !caseInsensitive && word !== upper) return null;
  let value = raw;
  // "**FILE: x**": the bold opened before the label closes at the end of the line.
  if (open && !close && !after && value.trimEnd().endsWith(open)) value = value.trimEnd().slice(0, -open.length);
  return { word: upper, value };
}

const fileLine   = line => matchLabel(line, ['FILE']);
const actionLine = line => matchLabel(line, ['ACTION']);

// "[x]", "`x`", "**x**" → "x"
const unwrap = s => s.trim().replace(/^(\*\*|__)(.*)\1$/, '$2').trim()
  .replace(/^\[(.*)\]$/, '$1').replace(/^`(.*)`$/, '$1').trim();

// Split pasted text into raw blocks. A block starts at a FILE line and its content ends at the next
// FILE line or at a closing code fence. Text outside blocks is returned as remainder (free prose that can
// be converted separately); code fence lines are dropped from it; stray ACTION lines are errors.
export function splitBlocks(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = [], errors = [];
  const outside = new Set(); // line indexes outside any block
  let cur = null;
  const close = () => { if (cur) { blocks.push(cur); cur = null; } };

  lines.forEach((line, i) => {
    const fm = fileLine(line);
    if (fm) { close(); cur = { line: i + 1, file: unwrap(fm.value), action: null, content: [] }; return; }
    if (!cur) {
      if (actionLine(line)) errors.push({ line: i + 1, file: null, reason: 'ACTION line without a FILE line before it' });
      else outside.add(i);
      return;
    }
    if (cur.action === null) {
      if (!line.trim()) return;
      const am = actionLine(line);
      cur.action = am ? unwrap(am.value) : '';
      if (!am) cur.content.push(line); // keep it so the error names the problem
      cur.missingAction = !am;
      return;
    }
    if (actionLine(line)) cur.extraAction = true; // one action per FILE block
    cur.content.push(line);
    (cur.lineIndexes ??= new Map()).set(cur.content.length - 1, i);
  });
  close();

  // A bare closing fence ends the content; anything after it is outside the block.
  for (const b of blocks) {
    const at = b.content.findIndex(l => /^[ \t]*(```|~~~)[ \t]*$/.test(l));
    if (at >= 0) {
      for (let c = at + 1; c < b.content.length; c++) outside.add(b.lineIndexes.get(c));
      b.content = b.content.slice(0, at);
    }
    while (b.content.length && !b.content[0].trim()) b.content.shift();
    while (b.content.length && !b.content.at(-1).trim()) b.content.pop();
  }
  const remainder = [...outside].sort((a, b) => a - b).map(i => lines[i])
    .filter(l => !/^[ \t]*(```|~~~)/.test(l)).join('\n').trim();
  return { blocks, errors, remainder };
}

// Parse "replace-section ## Heading" etc. → { action, section }
function parseAction(raw) {
  const s = raw.trim();
  const m = s.match(/^([a-z-]+)\b[ \t]*(.*)$/i);
  if (!m) return { action: '' };
  return { action: m[1].toLowerCase(), section: unwrap(m[2] || '') };
}

// OLD/NEW from "OLD: x" + "NEW: y" (inline) or "OLD:" / x / "NEW:" / y (next line). Same label forms as
// FILE/ACTION (headings, bullets, bold), plus "OLD line:"; any case is accepted inside the block.
const oldNewLine = line => matchLabel(line, ['OLD', 'NEW'], true);
// An inline value wrapped whole in single backticks is unwrapped: "OLD: `- x`" → "- x".
const unBacktick = v => (/^`[^`]*`$/.test(v.trim()) ? v.trim().slice(1, -1) : v);

function parseOldNew(lines) {
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const m = oldNewLine(lines[i]);
    if (!m) continue;
    const key = m.word;
    if (key in out) return { error: `more than one ${key} line` };
    if (m.value.trim() !== '') {
      out[key] = unBacktick(m.value);
      // NEW may continue on the following lines (one line replaced by several, e.g. new sub-bullets).
      // Take every following non-blank line that is not another label, so nothing is silently dropped.
      if (key === 'NEW') {
        while (i + 1 < lines.length && lines[i + 1].trim() !== '' && !oldNewLine(lines[i + 1])) out.NEW += '\n' + lines[++i];
      }
      continue;
    }
    const next = lines.slice(i + 1).findIndex(l => l.trim() !== '');
    const val = next < 0 ? undefined : lines[i + 1 + next];
    if (val === undefined || oldNewLine(val)) return { error: `${key} has no line after it` };
    out[key] = val;
    i += 1 + next;
  }
  if (out.OLD === undefined || out.NEW === undefined) return { error: 'replace-line needs an OLD line and a NEW line' };
  return { old: out.OLD, new: out.NEW };
}

// "key: value" lines → [[key, value]]
function parseFields(lines) {
  const fields = [];
  for (const l of lines) {
    if (!l.trim() || /^-{3,}\s*$/.test(l)) continue;
    const m = l.match(/^[ \t]*([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/);
    if (!m) return { error: `not a "field: value" line: line ${fields.length + 1}` };
    fields.push([m[1], m[2].trim()]);
  }
  if (!fields.length) return { error: 'frontmatter block has no fields' };
  return { fields };
}

// Validate one raw block into a normalized proposal, or { error }.
// isAllowedTarget(path) and targetExists(path) are supplied by the server.
export function normalizeBlock(b, { isAllowedTarget }) {
  const file = b.file;
  if (!file) return { error: 'FILE line has no path' };
  if (file.includes('..') || file.startsWith('/') || file.includes('\\') || !file.endsWith('.md')) return { error: `invalid path "${file}" (must be a relative .md path)` };
  if (!isAllowedTarget(file)) return { error: `target "${file}" not allowed` };
  if (b.missingAction) return { error: 'no ### ACTION line after the FILE line' };
  if (b.extraAction) return { error: 'more than one ### ACTION line in this block (use one FILE block per action)' };

  const { action, section } = parseAction(b.action || '');
  if (!ACTIONS.includes(action)) return { error: `unknown action "${b.action}"` };

  const content = b.content.join('\n');
  if (PERMALINK.test(content)) return { error: 'content has a permalink line (permalinks are never edited)' };

  if (action === 'replace-line') {
    const r = parseOldNew(b.content);
    if (r.error) return { error: r.error };
    if (!r.old.trim()) return { error: 'OLD line is empty' };
    if (/[\n\r]/.test(r.old)) return { error: 'OLD must be a single line' };
    return { file, action, old: r.old, new: r.new };
  }
  if (action === 'frontmatter') {
    const r = parseFields(b.content);
    if (r.error) return { error: r.error };
    if (r.fields.some(([k]) => k.toLowerCase() === 'permalink')) return { error: 'frontmatter may not change permalink' };
    return { file, action, fields: r.fields };
  }
  if (!content.trim()) return { error: `${action} block has no content` };
  if (action === 'replace-section') {
    if (!section) return { error: 'replace-section needs a section heading after the action' };
    return { file, action, section, content };
  }
  return { file, action, content };
}

// Parse a whole paste → { proposals: [...], errors: [{ line, file, reason }], remainder, noBlocks }
export function parseProposals(text, opts) {
  const { blocks, errors, remainder } = splitBlocks(text);
  const proposals = [];
  for (const b of blocks) {
    const p = normalizeBlock(b, opts);
    if (p.error) errors.push({ line: b.line, file: b.file || null, reason: p.error });
    else proposals.push({ ...p, line: b.line });
  }
  return { proposals, errors: errors.sort((a, b) => (a.line || 0) - (b.line || 0)), remainder, noBlocks: blocks.length === 0 };
}

// ── Inbox file format ─────────────────────────────────────────────────────────
// Frontmatter carries target and action (+ section). The body carries the content; for replace-line
// the body is "=== OLD ===\n<line>\n=== NEW ===\n<line>", for frontmatter the "field: value" lines.

const oneLine = s => String(s).replace(/[\r\n]+/g, ' ').trim();

// Batch lines group the cards of one paste or conversion in the Inbox, in order.
export function batchLines({ id, source, at }, order) {
  return [`batch: ${id}`, `batch_source: ${source}`, `batch_at: ${at}`, `batch_order: ${order}`];
}

export function toInboxFile(p, today, batch, order) {
  const fm = [`title: ${p.action} ${p.file}`, `updated: ${today}`, `target: ${p.file}`, `action: ${p.action}`];
  if (p.section) fm.push(`section: ${oneLine(p.section)}`);
  fm.push('source: pasted proposal', ...batchLines(batch, order));
  let body;
  if (p.action === 'replace-line')      body = `=== OLD ===\n${p.old}\n=== NEW ===\n${p.new}`;
  else if (p.action === 'frontmatter')  body = p.fields.map(([k, v]) => `${k}: ${v}`).join('\n');
  else                                  body = p.content;
  return `---\n${fm.join('\n')}\n---\n\n${body}\n`;
}

// Read the body of an inbox file back for its action.
export function readInboxBody(action, body) {
  if (action === 'replace-line') {
    const m = body.match(/^=== OLD ===\n([^\n]*)\n=== NEW ===\n([\s\S]*?)\n?$/);
    if (!m) return { error: 'replace-line item is malformed (expected === OLD === and === NEW === lines)' };
    return { old: m[1], new: m[2] };
  }
  if (action === 'frontmatter') return parseFields(body.split('\n'));
  return { content: body };
}

// ── Apply ─────────────────────────────────────────────────────────────────────

const FM_BLOCK = /^---[ \t]*\n([\s\S]*?)\n---[ \t]*(\n|$)/;

export function bumpUpdated(content, today) {
  const m = content.match(FM_BLOCK);
  if (!m) return content;
  if (/^updated:/m.test(m[1])) {
    const fm = m[1].replace(/^(updated:[ \t]*).*$/m, `$1${today}`);
    return content.replace(FM_BLOCK, `---\n${fm}\n---$2`);
  }
  return content.replace(/^---[ \t]*\n/, `---\nupdated: ${today}\n`);
}

const headingText = h => h.replace(/^#+[ \t]*/, '').trim().toLowerCase();

// Apply one action to the target's current content (null if the file does not exist).
// Returns { content } or { error }. Never adds, edits or removes a permalink line.
export function applyProposal(action, data, current, { today, titleFor }) {
  const exists = current !== null;

  if (action === 'create') {
    if (exists) return { error: 'create refused: target already exists' };
    const c = data.content.trim() + '\n';
    if (FM_BLOCK.test(c)) return { content: c };
    return { content: `---\ntitle: ${titleFor()}\nupdated: ${today}\n---\n\n${c}` };
  }

  if (action === 'append') {
    if (!exists) return { content: `---\ntitle: ${titleFor()}\nupdated: ${today}\n---\n\n${data.content.trim()}\n` };
    return { content: bumpUpdated(current, today).trimEnd() + '\n' + data.content.trimEnd() + '\n' };
  }

  if (!exists) return { error: `${action} refused: target does not exist` };

  if (action === 'replace-line') {
    if (PERMALINK.test(data.old) || PERMALINK.test(data.new)) return { error: 'replace-line refused: permalink lines are never edited' };
    const lines = current.split('\n');
    const hits = lines.reduce((a, l, i) => (l === data.old ? [...a, i] : a), []);
    if (hits.length !== 1) {
      return { error: hits.length === 0
        ? 'replace-line refused: the OLD line was not found exactly in the target'
        : `replace-line refused: the OLD line appears ${hits.length} times in the target (must be exactly once)` };
    }
    lines[hits[0]] = data.new;
    return { content: bumpUpdated(lines.join('\n'), today) };
  }

  if (action === 'replace-section') {
    const lines = current.split('\n');
    const want = headingText(data.section);
    const hits = lines.reduce((a, l, i) => (/^#{1,6}[ \t]/.test(l) && headingText(l) === want ? [...a, i] : a), []);
    if (hits.length !== 1) {
      return { error: hits.length === 0
        ? `replace-section refused: heading "${data.section}" not found in the target`
        : `replace-section refused: heading "${data.section}" appears ${hits.length} times` };
    }
    const start = hits[0];
    const level = lines[start].match(/^#+/)[0].length;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
      const h = lines[i].match(/^(#{1,6})[ \t]/);
      if (h && h[1].length <= level) { end = i; break; }
    }
    let newLines = data.content.trimEnd().split('\n');
    if (/^#{1,6}[ \t]/.test(newLines[0]) && headingText(newLines[0]) === want) newLines = newLines.slice(1);
    while (newLines.length && !newLines[0].trim()) newLines.shift();
    const tail = lines.slice(end);
    const out = [...lines.slice(0, start + 1), ...newLines, ...(tail.length ? ['', ...tail] : [''])];
    return { content: bumpUpdated(out.join('\n').replace(/\n{3,}(?=#)/g, '\n\n'), today) };
  }

  if (action === 'frontmatter') {
    const m = current.match(FM_BLOCK);
    if (!m) return { error: 'frontmatter refused: target has no frontmatter' };
    const fmLines = m[1].split('\n');
    for (const [k, v] of data.fields) {
      if (k.toLowerCase() === 'permalink') return { error: 'frontmatter refused: permalink is never edited' };
      const i = fmLines.findIndex(l => l.match(/^([A-Za-z0-9_-]+)[ \t]*:/)?.[1] === k);
      if (i >= 0) fmLines[i] = `${k}: ${v}`;
      else fmLines.push(`${k}: ${v}`);
    }
    return { content: current.replace(FM_BLOCK, `---\n${fmLines.join('\n')}\n---$2`) };
  }

  return { error: `unknown action "${action}"` };
}
