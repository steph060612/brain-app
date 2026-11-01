// Local API server — reads and writes ~/Brain .md files.
// Listens only on localhost:3001. Never touches anything outside ~/Brain.
import express from 'express';
import { readdir, readFile, writeFile, stat, access, unlink, mkdir, rm } from 'fs/promises';
import { resolve, join, sep, extname, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { parseConversations, parseMemories, getConvDir, getMemDir, CHARS_PER_CALL } from './src/claude-parser.js';
import { parseConversations as parseChatgptConversations, getConvDir as getChatgptConvDir } from './src/chatgpt-parser.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const execAsync = promisify(exec);
const app   = express();
const PORT  = 5180;
const BRAIN = resolve(homedir(), 'Brain');

app.use(express.json({ limit: '2mb' }));

// ─── SECURITY ────────────────────────────────────────────────────────────────
// Resolve and validate that the requested path is inside ~/Brain and is .md
function safe(rel) {
  if (!rel || typeof rel !== 'string') throw err400('Missing path');
  if (extname(rel) !== '.md') throw err400('Only .md files are allowed');
  const abs = resolve(BRAIN, rel);
  if (abs !== BRAIN && !abs.startsWith(BRAIN + sep)) throw err403('Path outside Brain');
  return abs;
}
function err400(m) { const e = new Error(m); e.status = 400; return e; }
function err403(m) { const e = new Error(m); e.status = 403; return e; }

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const md5 = s => createHash('md5').update(s).digest('hex');

// Extract the permalink line from frontmatter (we must never alter it)
function pickPermalink(content) {
  const m = content.match(/^permalink:[ \t]*.+$/m);
  return m ? m[0] : null;
}

// After the user saves, ensure the permalink line is identical to the original
function guardPermalink(original, edited) {
  const orig = pickPermalink(original);
  if (!orig) return edited;                          // original has none — nothing to protect
  const got = pickPermalink(edited);
  if (got === orig) return edited;                   // unchanged — fine
  if (got) return edited.replace(/^permalink:[ \t]*.+$/m, orig); // changed — restore
  // deleted — inject it back into the frontmatter opening
  if (/^---[ \t]*\r?\n/.test(edited)) return edited.replace(/^---[ \t]*\r?\n/, `---\n${orig}\n`);
  return `---\n${orig}\n---\n\n${edited}`;           // no frontmatter at all — wrap it
}

function prettify(s) {
  return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function parseFM(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const obj = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return obj;
}

function safeInbox(filename) {
  if (!filename || typeof filename !== 'string') throw err400('Missing filename');
  if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) throw err400('Invalid filename');
  if (extname(filename) !== '.md') throw err400('Only .md files are allowed');
  return join(BRAIN, 'inbox', filename);
}

// ─── DISTILL CONSTANTS & HELPERS ─────────────────────────────────────────────

const STAGING_BASE = resolve(homedir(), '.brain', 'staging');
const DISTILL_LOG  = resolve(homedir(), '.brain', 'distill.log');
const runStore     = new Map(); // runId → state

let importParseState = null; // null = never run, or { status, startedAt, finishedAt, result, error }

const AGENT_PATH = '/Users/stefanopozzato/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin';

function makeRunId() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2,6)}`;
}

// Walk ~/Brain and return "rel/path.md | title" lines
async function buildBrainIndex() {
  const rows = [];
  async function walk(dir, pfx) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = pfx ? `${pfx}/${e.name}` : e.name;
      if (e.isDirectory()) { await walk(join(dir, e.name), rel); }
      else if (e.name.endsWith('.md')) {
        try {
          const fm = parseFM(await readFile(join(dir, e.name), 'utf8'));
          rows.push(`${rel} | ${fm.title || prettify(basename(e.name, '.md'))}`);
        } catch { /* skip unreadable */ }
      }
    }
  }
  await walk(BRAIN, '');
  return rows.join('\n');
}

// Read every projects/*/state.md and return a formatted block for the distill prompt
async function buildProjectStates() {
  const rows = [];
  const projDir = join(BRAIN, 'projects');
  let entries;
  try { entries = await readdir(projDir, { withFileTypes: true }); }
  catch { return ''; }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const statePath = join(projDir, e.name, 'state.md');
    try {
      const content = await readFile(statePath, 'utf8');
      rows.push(`--- projects/${e.name}/state.md ---\n${content.trim()}`);
    } catch { /* no state.md — skip */ }
  }
  return rows.join('\n\n');
}

// md5 checksums of every file in dir, skipping one named top-level subdirectory
async function fileChecksums(dir, skipSub) {
  const map = {};
  async function walk(d, base) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = base ? `${base}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (skipSub && e.name === skipSub && base === '') continue;
        await walk(join(d, e.name), rel);
      } else {
        map[rel] = md5((await readFile(join(d, e.name))).toString());
      }
    }
  }
  await walk(dir, '');
  return map;
}

const ALLOWED_TARGET_DIRS  = ['projects/', 'archive/', 'people/', 'topics/'];
const ALLOWED_TARGET_FILES = ['profile.md', 'preferences.md'];

// Per-file checker rules. Returns null if the file passes, else the rejection reason.
function checkSuggestion(f, content) {
  if (!f.endsWith('.md')) return 'not a .md file';
  if (Buffer.byteLength(content, 'utf8') > 20 * 1024) return 'exceeds 20 KB';
  if (/^permalink:/m.test(content)) return 'has a permalink line';
  if (!/^---\s*\n[\s\S]*?\n---/.test(content)) return 'missing frontmatter';

  const fm = parseFM(content);
  const missing = ['title', 'updated', 'target'].filter(k => !fm[k]);
  if (missing.length) return `frontmatter missing ${missing.join(', ')}`;

  const t = fm.target;
  if (t.includes('..') || t.startsWith('/') || t.includes('\\') || !t.endsWith('.md'))
    return `invalid target path "${t}"`;
  if (!ALLOWED_TARGET_FILES.includes(t) && !ALLOWED_TARGET_DIRS.some(d => t.startsWith(d)))
    return `target "${t}" not allowed`;
  return null;
}

// Validate every file in out/. Failing files are dropped individually, not the whole run.
async function checkOutFiles(outDir) {
  let names;
  try { names = (await readdir(outDir)).filter(f => !f.startsWith('.')); }
  catch { return { accepted: [], dropped: [] }; }

  const accepted = [], dropped = [];
  for (const f of names) {
    let content = '';
    if (f.endsWith('.md')) {
      try { content = await readFile(join(outDir, f), 'utf8'); }
      catch { dropped.push({ file: f, reason: 'cannot read' }); continue; }
    }
    const reason = checkSuggestion(f, content);
    if (reason) dropped.push({ file: f, reason });
    else accepted.push(f);
  }
  return { accepted, dropped };
}

// Copy accepted out/ files into ~/Brain/inbox/ without overwriting existing items.
async function moveToInbox(outDir, files) {
  await mkdir(join(BRAIN, 'inbox'), { recursive: true });
  const inboxed = [];
  for (const f of files) {
    let dest = join(BRAIN, 'inbox', f); let n = 0;
    while (true) {
      try { await stat(dest); n++; dest = join(BRAIN, 'inbox', `${basename(f, '.md')}-${n}.md`); }
      catch { break; }
    }
    await writeFile(dest, await readFile(join(outDir, f), 'utf8'));
    inboxed.push(basename(dest));
  }
  return inboxed;
}

const fmtDropped = dropped => dropped.map(d => `${d.file} (${d.reason})`).join('; ');

async function appendDistillLog(line) {
  try {
    await mkdir(resolve(homedir(), '.brain'), { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await writeFile(DISTILL_LOG, `${ts} | ${line}\n`, { flag: 'a' });
  } catch { /* non-fatal */ }
}

// Run claude -p with no tools; returns captured stdout.
async function runClaudeAgent(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p',
      '--tools', '',
      '--output-format', 'text',
      '--no-session-persistence',
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: AGENT_PATH },
    });

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Claude timed out after 5 minutes')); }, 5 * 60 * 1000);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve(stdout);
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Run agy --sandbox with no file access; returns captured stdout.
async function runGeminiAgent(prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('agy', [
      '--sandbox',
      '--print-timeout', '300s',
      '--print', prompt,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: AGENT_PATH },
    });

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Gemini timed out after 5 minutes')); }, 5 * 60 * 1000);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve(stdout);
      else reject(new Error(`agy exited ${code}: ${stderr.slice(0, 400)}`));
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Confirm agy is reachable and produces text output in headless mode (no file tools needed).
let geminiDisabledReason = undefined; // undefined=unchecked, null=ok, string=reason
async function verifyGeminiHeadless() {
  if (geminiDisabledReason !== undefined) return geminiDisabledReason;
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn('agy', ['--sandbox', '--print', 'ping'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, PATH: AGENT_PATH },
      });
      let stdout = '';
      child.stdout.on('data', d => { stdout += d; });
      const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('agy ping timed out')); }, 15000);
      child.on('close', code => { clearTimeout(t); code === 0 ? resolve(stdout) : reject(new Error(`agy ping exited ${code}`)); });
      child.on('error', e => { clearTimeout(t); reject(e); });
    });
    geminiDisabledReason = out.trim() ? null : 'agy returned empty output for ping test';
  } catch (e) {
    geminiDisabledReason = `agy headless test failed: ${e.message.slice(0, 160)}`;
  }
  return geminiDisabledReason;
}

// Output contract: an empty reply ("nothing worth adding"), or only === SUGGESTION === blocks
// with no text before the first marker. Returns an error string, or null if the reply conforms.
function checkReplyContract(stdout) {
  if (!stdout.trim()) return null;
  const first = stdout.search(/===[ \t]*SUGGESTION[ \t]*===/);
  if (first === -1) return 'No === SUGGESTION === blocks in agent reply';
  if (stdout.slice(0, first).trim()) return 'Agent reply has text before the first === SUGGESTION === block';
  return null;
}

// Split a conforming agent reply on === SUGGESTION === markers; write each block as .md to outDir.
// Blocks are written even without frontmatter so the per-file checker can drop them with a reason.
async function parseAgentReply(stdout, outDir) {
  const blocks = stdout.split(/===[ \t]*SUGGESTION[ \t]*===/).map(b => b.trim()).filter(b => b.length > 0);
  const used = new Set();
  for (const block of blocks) {
    const fm = parseFM(block);
    const base = (fm.title || 'suggestion').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'suggestion';
    let name = `${base}.md`; let n = 1;
    while (used.has(name)) name = `${base}-${n++}.md`;
    used.add(name);
    await writeFile(join(outDir, name), block + '\n', 'utf8');
  }
  return blocks.length;
}

async function mdFilesIn(dir) {
  try {
    return (await readdir(dir)).filter(f => f.endsWith('.md'));
  } catch { return []; }
}

async function subdirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries.filter(e => e.isDirectory()).map(e => e.name);
  } catch { return []; }
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// List all Brain items: projects, archive, people, topics, profile, preferences
app.get('/api/items', async (_req, res) => {
  try {
    const items = [];

    // Folders: projects + archive
    for (const category of ['projects', 'archive']) {
      for (const dir of await subdirs(join(BRAIN, category))) {
        const files = await mdFilesIn(join(BRAIN, category, dir));
        items.push({
          id:       `${category}/${dir}`,
          category,
          name:     prettify(dir),
          path:     `${category}/${dir}`,
          type:     'folder',
          files:    files.map(f => `${category}/${dir}/${f}`),
        });
      }
    }

    // Single files: people + topics
    for (const category of ['people', 'topics']) {
      for (const file of await mdFilesIn(join(BRAIN, category))) {
        const stem = basename(file, '.md');
        items.push({
          id:       `${category}/${stem}`,
          category,
          name:     prettify(stem),
          path:     `${category}/${file}`,
          type:     'file',
          files:    [`${category}/${file}`],
        });
      }
    }

    // Root singletons
    for (const stem of ['profile', 'preferences']) {
      try {
        await access(join(BRAIN, `${stem}.md`));
        items.push({
          id:       stem,
          category: stem,
          name:     prettify(stem),
          path:     `${stem}.md`,
          type:     'file',
          files:    [`${stem}.md`],
        });
      } catch { /* file absent */ }
    }

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Return a file's content + hash (used to detect conflicts on save)
app.get('/api/file', async (req, res) => {
  try {
    const abs     = safe(req.query.path);
    const content = await readFile(abs, 'utf8');
    const info    = await stat(abs);
    res.json({ content, hash: md5(content), mtime: info.mtimeMs, path: req.query.path });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Save a file. Rejects if content changed on disk since it was opened.
app.post('/api/file', async (req, res) => {
  try {
    const { path: rel, content, hash } = req.body;
    if (typeof content !== 'string') throw err400('Missing content');
    const abs = safe(rel);

    let current;
    try { current = await readFile(abs, 'utf8'); }
    catch { return res.status(404).json({ error: 'File not found' }); }

    // Conflict check: compare the hash the client opened with what is on disk now
    if (hash && md5(current) !== hash) {
      return res.status(409).json({
        error:   'conflict',
        message: 'File changed on disk since you opened it. Editor refreshed.',
        content: current,
        hash:    md5(current),
      });
    }

    const safe_content = guardPermalink(current, content);
    await writeFile(abs, safe_content, 'utf8');
    res.json({ ok: true, hash: md5(safe_content) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Last git commit in ~/Brain
app.get('/api/gitlog', async (_req, res) => {
  try {
    const { stdout } = await execAsync(`git -C "${BRAIN}" log -1 --format="%ci"`, { timeout: 5000 });
    const raw = stdout.trim();
    res.json({ lastCommit: raw ? new Date(raw).toISOString() : null });
  } catch {
    res.json({ lastCommit: null });
  }
});

// ─── INBOX ROUTES ────────────────────────────────────────────────────────────

// List inbox items with parsed frontmatter and hashes
app.get('/api/inbox', async (_req, res) => {
  try {
    const inboxDir = join(BRAIN, 'inbox');
    let files;
    try {
      files = (await readdir(inboxDir)).filter(f => f.endsWith('.md') && f !== '.gitkeep');
    } catch {
      return res.json([]);
    }

    const items = await Promise.all(files.map(async (filename) => {
      const content = await readFile(join(inboxDir, filename), 'utf8');
      const fm = parseFM(content);
      let targetHash = null;
      if (fm.target) {
        try {
          const tc = await readFile(safe(fm.target), 'utf8');
          targetHash = md5(tc);
        } catch { /* target absent or invalid — leave null */ }
      }
      return {
        filename,
        path: `inbox/${filename}`,
        title: fm.title || prettify(basename(filename, '.md')),
        target: fm.target || null,
        content,
        inboxHash: md5(content),
        targetHash,
      };
    }));

    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Approve: append bullet lines to target, update target's updated date, delete inbox file
app.post('/api/inbox/approve', async (req, res) => {
  try {
    const { filename, inboxHash, targetHash } = req.body;
    const inboxAbs = safeInbox(filename);

    let inboxContent;
    try { inboxContent = await readFile(inboxAbs, 'utf8'); }
    catch { return res.status(404).json({ error: 'Inbox file not found' }); }

    if (inboxHash && md5(inboxContent) !== inboxHash) {
      return res.status(409).json({ error: 'conflict', message: 'Inbox file changed since it was opened.' });
    }

    const fm = parseFM(inboxContent);
    if (!fm.target) return res.status(400).json({ error: 'No target field in inbox file' });

    const targetAbs = safe(fm.target);
    const bodyRaw = inboxContent.replace(/^---[\s\S]*?---\s*\n?/, '').trimStart();
    const body = bodyRaw.trimEnd() + '\n';
    const today = new Date().toISOString().split('T')[0];

    let targetContent;
    let targetExists = true;
    try { targetContent = await readFile(targetAbs, 'utf8'); }
    catch { targetExists = false; }

    let newTargetContent;
    if (targetExists) {
      if (targetHash && md5(targetContent) !== targetHash) {
        return res.status(409).json({ error: 'conflict', message: 'Target file changed since it was opened.' });
      }
      let updated = targetContent.replace(/^(updated:[ \t]*).*$/m, `$1${today}`);
      if (updated === targetContent) {
        updated = targetContent.replace(/^(---[ \t]*\r?\n)/, `$1updated: ${today}\n`);
      }
      newTargetContent = guardPermalink(targetContent, updated.trimEnd() + '\n' + body);
    } else {
      const titleStem = basename(fm.target, '.md').replace(/-/g, ' ');
      newTargetContent = `---\ntitle: ${titleStem}\nupdated: ${today}\n---\n\n${body}`;
      await mkdir(dirname(targetAbs), { recursive: true });
    }

    await writeFile(targetAbs, newTargetContent, 'utf8');
    await unlink(inboxAbs);
    res.json({ ok: true });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Discard: delete inbox file
app.delete('/api/inbox/:filename', async (req, res) => {
  try {
    const inboxAbs = safeInbox(req.params.filename);
    try {
      await unlink(inboxAbs);
      res.json({ ok: true });
    } catch {
      res.status(404).json({ error: 'File not found' });
    }
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// ─── DISTILL ROUTES ──────────────────────────────────────────────────────────

// Detect installed + working agents
app.get('/api/distill/agents', async (_req, res) => {
  const agents = [], reasons = {};

  try {
    await execAsync('which claude', { env: { ...process.env, PATH: AGENT_PATH } });
    agents.push('claude');
  } catch {
    reasons.claude = 'claude not found in PATH';
  }

  try {
    await execAsync('which agy', { env: { ...process.env, PATH: AGENT_PATH } });
    const reason = await verifyGeminiHeadless();
    if (reason) { reasons.gemini = reason; }
    else { agents.push('gemini'); }
  } catch {
    reasons.gemini = 'agy not installed';
  }

  res.json({ agents, reasons });
});

// ── Shared distill pipeline ───────────────────────────────────────────────────

async function runDistillPipeline(state, agent, files) {
  const stagDir    = join(STAGING_BASE, state.runId);
  const inputLabel = files.map(f => f.name).join(', ');
  const agentLabel = agent === 'claude' ? 'Claude' : 'Gemini';

  try {
    // ── Setup staging ──────────────────────────────────────────────
    await mkdir(join(stagDir, 'input'), { recursive: true });
    await mkdir(join(stagDir, 'out'),   { recursive: true });
    for (const f of files) {
      await writeFile(join(stagDir, 'input', basename(f.name)), f.content, 'utf8');
    }

    // ── Build prompt ───────────────────────────────────────────────
    const today         = new Date().toISOString().split('T')[0];
    const readme        = await readFile(join(BRAIN, 'README.md'), 'utf8');
    const brainIndex    = await buildBrainIndex();
    const projectStates = await buildProjectStates();
    const inputText     = files.map(f => `=== ${f.name} ===\n${f.content}`).join('\n\n');

    const stateSection = projectStates
      ? [
          '=== CURRENT PROJECT STATES ===',
          'Compare every candidate fact against these files. Skip anything already recorded; suggest only new or changed facts.',
          '',
          projectStates,
          '',
        ].join('\n')
      : '';

    const header = [
      'Respond ONLY with === SUGGESTION === blocks — no other text before, between, or after them.',
      'Each block is a complete Markdown file with YAML frontmatter:',
      '',
      '=== SUGGESTION ===',
      '---',
      'title: Short descriptive title',
      `updated: ${today}`,
      'target: projects/foo/state.md',
      '---',
      '',
      '- Bullet point fact distilled from the input',
      '',
      'Rules:',
      '- One block per target file.',
      '- target must be a relative path from the Brain Index, or a new path under projects/ for a brand-new project.',
      '- Body: bullet-point facts only — distilled and organised. No opinions, no raw transcript.',
      '- No permalink line in the output.',
      '- If CURRENT PROJECT STATES is present, only suggest facts that are new or changed relative to it.',
      '- If nothing is worth adding, output nothing.',
      '',
      '=== README (Brain format rules) ===',
      readme.trim(),
      '',
      '=== BRAIN INDEX ===',
      brainIndex,
      '',
      stateSection,
      '=== INPUT ===',
    ].join('\n') + '\n';

    const CHUNK_SIZE = 50_000;
    const available  = Math.max(CHUNK_SIZE - header.length, 5_000);
    const prompts    = [];
    if (inputText.length <= available) {
      prompts.push(header + inputText);
    } else {
      let offset = 0;
      while (offset < inputText.length) {
        prompts.push(header + inputText.slice(offset, offset + available));
        offset += available;
      }
    }

    // ── Pre-run Brain checksum ─────────────────────────────────────
    const preBrainSnap = await fileChecksums(BRAIN, '.git');

    // ── Run agent ──────────────────────────────────────────────────
    if (agent !== 'claude' && agent !== 'gemini') throw new Error(`Unknown agent: ${agent}`);
    const runAgent = agent === 'claude' ? runClaudeAgent : runGeminiAgent;

    let allStdout = '';
    let contractError = null;
    for (let i = 0; i < prompts.length; i++) {
      state.status  = 'running';
      state.message = `${agentLabel} distilling${prompts.length > 1 ? ` (chunk ${i+1}/${prompts.length})` : ''}…`;
      const reply = await runAgent(prompts[i]);
      const err = checkReplyContract(reply);
      if (err && !contractError) contractError = prompts.length > 1 ? `chunk ${i+1}: ${err}` : err;
      allStdout += reply + '\n';
    }

    state.message = 'Checking output…';

    // ── Post-run Brain checksum check ──────────────────────────────
    const postBrainSnap = await fileChecksums(BRAIN, '.git');
    const brainChanged  = [];
    for (const k of Object.keys(postBrainSnap)) {
      if (!preBrainSnap[k])                          brainChanged.push(`appeared: ${k}`);
      else if (preBrainSnap[k] !== postBrainSnap[k]) brainChanged.push(`modified: ${k}`);
    }
    for (const k of Object.keys(preBrainSnap)) {
      if (!postBrainSnap[k]) brainChanged.push(`deleted: ${k}`);
    }
    if (brainChanged.length > 0) {
      const reason = `~/Brain changed during run: ${brainChanged.join('; ')}`;
      state.status = 'failed'; state.message = reason;
      await appendDistillLog(`${agent} | ${inputLabel} | FAIL: ${reason}`);
      return;
    }

    // ── Output contract (run-level) ────────────────────────────────
    if (contractError) {
      await writeFile(join(stagDir, 'out', 'raw-reply.txt'), allStdout, 'utf8');
      state.status = 'failed'; state.message = contractError;
      await appendDistillLog(`${agent} | ${inputLabel} | FAIL: ${contractError}`);
      return;
    }

    // ── Parse reply → out/, then per-file checks ───────────────────
    const outDir = join(stagDir, 'out');
    await parseAgentReply(allStdout, outDir);
    const { accepted, dropped } = await checkOutFiles(outDir);

    // ── Move accepted files to ~/Brain/inbox/ ──────────────────────
    const inboxed = await moveToInbox(outDir, accepted);

    // Delete staging only when nothing was dropped; keep it for inspection otherwise.
    if (dropped.length === 0) await rm(stagDir, { recursive: true, force: true });
    else for (const f of accepted) await rm(join(outDir, f), { force: true }); // don't re-inbox on a recheck

    state.status = 'done';
    state.result = { inboxed, dropped };
    state.message = `${inboxed.length} suggestion${inboxed.length !== 1 ? 's' : ''} moved to inbox` +
      (dropped.length ? `, ${dropped.length} dropped by checker` : '');
    await appendDistillLog(`${agent} | ${inputLabel} | OK: ${inboxed.length} → inbox (${inboxed.join(', ')})` +
      (dropped.length ? ` | DROPPED: ${fmtDropped(dropped)}` : ''));

  } catch (e) {
    state.status  = 'failed';
    state.message = `Error: ${e.message}`;
    await appendDistillLog(`${agent} | ${inputLabel} | ERROR: ${e.message}`);
  }
}

// ── DISTILL ROUTES ────────────────────────────────────────────────────────────

// Start a distill run from uploaded files. Body: { agent, files: [{name, content}] }
app.post('/api/distill/run', async (req, res) => {
  const { agent, files } = req.body;
  if (!agent || !Array.isArray(files) || files.length === 0)
    return res.status(400).json({ error: 'agent and files[] required' });

  const runId = makeRunId();
  const state = {
    runId, status: 'pending', message: 'Preparing…',
    result: null, agent, inputNames: files.map(f => f.name),
    startedAt: new Date().toISOString(),
  };
  runStore.set(runId, state);
  res.json({ runId });
  runDistillPipeline(state, agent, files).catch(() => {});
});

// Start a distill run from parsed import items.
// Body: { agent, conversationUuids?: string[], chatgptIds?: string[], includeMemories?: bool }
app.post('/api/distill/import', async (req, res) => {
  const { agent, conversationUuids = [], chatgptIds = [], includeMemories = false } = req.body;
  if (!agent) return res.status(400).json({ error: 'agent required' });

  const files = [];
  const convDir = getConvDir();
  const memDir  = getMemDir();

  for (const uuid of conversationUuids) {
    if (!/^[0-9a-f-]{8,}$/i.test(uuid)) continue;
    try {
      const content = await readFile(join(convDir, `${uuid}.txt`), 'utf8');
      files.push({ name: `conv-${uuid.slice(0, 8)}.txt`, content });
    } catch { /* skip missing */ }
  }

  const chatgptDir = getChatgptConvDir();
  for (const id of chatgptIds) {
    if (!/^[0-9a-f-]{8,}$/i.test(id)) continue;
    try {
      const content = await readFile(join(chatgptDir, `${id}.txt`), 'utf8');
      files.push({ name: `chatgpt-${id.slice(0, 8)}.txt`, content });
    } catch { /* skip missing */ }
  }

  if (includeMemories) {
    const load = async (p, name) => {
      try { files.push({ name, content: await readFile(p, 'utf8') }); } catch { }
    };
    await load(join(memDir, 'conversations_memory.txt'), 'memory-conversations.txt');

    try {
      const projDir = join(memDir, 'project_memories');
      const pmFiles = (await readdir(projDir)).filter(f => f.endsWith('.txt'));
      for (const f of pmFiles) {
        await load(join(projDir, f), `memory-project-${f}`);
      }
    } catch { }

    async function walkMemFiles(dir) {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (e.isDirectory()) await walkMemFiles(join(dir, e.name));
        else await load(join(dir, e.name), `memfile-${e.name}`);
      }
    }
    await walkMemFiles(join(memDir, 'memory_files'));
  }

  if (files.length === 0) return res.status(400).json({ error: 'No import content found — parse first' });

  const runId = makeRunId();
  const state = {
    runId, status: 'pending', message: 'Preparing…',
    result: null, agent, inputNames: files.map(f => f.name),
    startedAt: new Date().toISOString(),
  };
  runStore.set(runId, state);
  res.json({ runId });
  runDistillPipeline(state, agent, files).catch(() => {});
});

// Re-run the checker on a kept staging folder (no agent call) and move valid files to the inbox.
app.post('/api/distill/recheck/:runId', async (req, res) => {
  const { runId } = req.params;
  if (!/^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/.test(runId)) return res.status(400).json({ error: 'Invalid runId' });
  const stagDir = join(STAGING_BASE, runId);
  const outDir  = join(stagDir, 'out');
  try { await stat(outDir); } catch { return res.status(404).json({ error: 'Staging folder not found' }); }
  try {
    const { accepted, dropped } = await checkOutFiles(outDir);
    const inboxed = await moveToInbox(outDir, accepted);
    if (dropped.length === 0) await rm(stagDir, { recursive: true, force: true });
    else for (const f of accepted) await rm(join(outDir, f), { force: true }); // don't re-inbox on a second recheck
    await appendDistillLog(`recheck | ${runId} | OK: ${inboxed.length} → inbox (${inboxed.join(', ')})` +
      (dropped.length ? ` | DROPPED: ${fmtDropped(dropped)}` : ''));
    res.json({ inboxed, dropped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Poll run status
app.get('/api/distill/status/:runId', (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

// ── IMPORT ROUTES ─────────────────────────────────────────────────────────────

// Parse status + basic stats
app.get('/api/import/status', (_req, res) => {
  res.json(importParseState || { status: 'idle' });
});

// Trigger (re-)parse. Fire-and-forget; poll /api/import/status.
app.post('/api/import/parse', (_req, res) => {
  if (importParseState?.status === 'running') {
    return res.json({ status: 'running', message: 'Parse already in progress' });
  }
  importParseState = { status: 'running', startedAt: new Date().toISOString(), result: null, error: null };
  res.json({ status: 'running' });

  (async () => {
    try {
      const result = await Promise.all([parseConversations(), parseMemories(), parseChatgptConversations()]);
      importParseState = {
        status: 'done',
        startedAt: importParseState.startedAt,
        finishedAt: new Date().toISOString(),
        result: { conversations: result[0], memories: result[1], chatgpt: result[2] },
        error: null,
      };
    } catch (e) {
      importParseState = {
        status: 'failed',
        startedAt: importParseState.startedAt,
        finishedAt: new Date().toISOString(),
        result: null,
        error: e.message,
      };
    }
  })();
});

// Return the parsed conversation index
app.get('/api/import/index', async (_req, res) => {
  try {
    const p = join(getConvDir(), 'index.json');
    const data = JSON.parse(await readFile(p, 'utf8'));
    res.json(data);
  } catch {
    res.status(404).json({ error: 'Not parsed yet — POST /api/import/parse first' });
  }
});

// Return the parsed ChatGPT conversation index
app.get('/api/import/chatgpt-index', async (_req, res) => {
  try {
    const p = join(getChatgptConvDir(), 'index.json');
    const data = JSON.parse(await readFile(p, 'utf8'));
    res.json(data);
  } catch {
    res.status(404).json({ error: 'Not parsed yet — POST /api/import/parse first' });
  }
});

// ── STATIC ────────────────────────────────────────────────────────────────────

// Serve the Vite production build; fall through to index.html for SPA
app.use(express.static(join(__dirname, 'dist')));
app.use((_req, res) =>
  res.sendFile(join(__dirname, 'dist', 'index.html'))
);

app.listen(PORT, '127.0.0.1', () =>
  console.log(`Brain app → http://localhost:${PORT}`)
);
