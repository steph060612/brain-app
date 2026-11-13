// Local API server — reads and writes ~/Brain .md files.
// Listens only on localhost. Brain content stays in ~/Brain; app state (staging, packs, code maps) in ~/.brain.
import express from 'express';
import { readdir, readFile, writeFile, stat, access, unlink, mkdir, rm, rename } from 'fs/promises';
import { resolve, join, sep, extname, basename, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { exec, execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { homedir } from 'os';
import { parseConversations, parseMemories, getConvDir, getMemDir, CHARS_PER_CALL } from './src/claude-parser.js';
import { parseConversations as parseChatgptConversations, getConvDir as getChatgptConvDir } from './src/chatgpt-parser.js';
import { parseConversations as parseGeminiConversations, getConvDir as getGeminiConvDir } from './src/gemini-parser.js';
import { parseProposals, toInboxFile, batchLines, readInboxBody, applyProposal, ACTIONS } from './src/proposals.js';
import { registerCodeMapRoutes } from './src/codemap-routes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const execAsync = promisify(exec);
const app   = express();
const PORT  = Number(process.env.BRAIN_PORT) || 5180; // set per install in the LaunchAgent
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

// YYYY-MM-DD in local time (toISOString() is UTC and gives tomorrow's date in the evening).
function localDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const localToday = () => localDate(new Date());

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
const CALL_TIMEOUT_MS = 5 * 60 * 1000; // per agent call; a run has no total limit
const RUN_ID_RE = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;
let activeRun = null; // { runId, abort, cancelled }: one run at a time, so two runs never spend calls at once

let importParseState = null; // null = never run, or { status, startedAt, finishedAt, result, error }
const PARSE_STATE_FILE = resolve(homedir(), '.brain', 'imports', 'last-parse.json');

const AGENT_PATH = `${homedir()}/.local/bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;

function makeRunId() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2,6)}`;
}

// Walk ~/Brain and return "rel/path.md | title" lines
// Every .md file in ~/Brain except inbox/, .git/ and the top-level README.md, as [{rel, content}]
async function brainMdFiles() {
  const files = [];
  async function walk(dir, pfx) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const rel = pfx ? `${pfx}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!pfx && (e.name === 'inbox' || e.name === '.git')) continue;
        await walk(join(dir, e.name), rel);
      } else if (e.name.endsWith('.md') && rel !== 'README.md') {
        try { files.push({ rel, content: await readFile(join(dir, e.name), 'utf8') }); }
        catch { /* skip unreadable */ }
      }
    }
  }
  await walk(BRAIN, '');
  return files.sort((x, y) => x.rel.localeCompare(y.rel));
}

const titleOf = f => parseFM(f.content).title || prettify(basename(f.rel, '.md'));

async function buildBrainIndex() {
  return (await brainMdFiles()).map(f => `${f.rel} | ${titleOf(f)}`).join('\n');
}

const BRAIN_CONTENT_LIMIT = 60_000;

// Current Brain content for the distill prompt. Full content of every file when it fits
// in BRAIN_CONTENT_LIMIT; otherwise every title plus full profile.md, preferences.md and projects/.
async function buildBrainContent() {
  const files = await brainMdFiles();
  const block = f => `--- ${f.rel} ---\n${f.content.trim()}`;
  const total = files.reduce((n, f) => n + f.content.length, 0);
  if (total <= BRAIN_CONTENT_LIMIT) return files.map(block).join('\n\n');

  const isCore = f => f.rel === 'profile.md' || f.rel === 'preferences.md' || f.rel.startsWith('projects/');
  return [
    'Brain is too large to include in full. Titles of every file:',
    files.map(f => `${f.rel} | ${titleOf(f)}`).join('\n'),
    '',
    'Full content of profile.md, preferences.md and projects/:',
    '',
    files.filter(isCore).map(block).join('\n\n'),
  ].join('\n');
}

// Every change the app itself makes to ~/Brain goes through these two, which record the file and its
// resulting checksum (null once deleted). The distill safety check ignores a change that matches the
// record, so an outside edit, even to a file the app wrote earlier, still counts as tampering.
// Recorded before the write, so a check running at the same moment can't miss it.
const appWrites = new Map(); // path relative to ~/Brain → latest checksum the app left there

async function writeBrainFile(abs, content) {
  appWrites.set(relative(BRAIN, abs), md5(content));
  await writeFile(abs, content, 'utf8');
}

async function deleteBrainFile(abs) {
  appWrites.set(relative(BRAIN, abs), null);
  await unlink(abs);
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
const isAllowedTarget = t => ALLOWED_TARGET_FILES.includes(t) || ALLOWED_TARGET_DIRS.some(d => t.startsWith(d));

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
  if (!isAllowedTarget(t)) return `target "${t}" not allowed`;
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
// batch: { id, source, at }, whose cards are numbered from firstOrder (later calls of a run continue the count).
async function moveToInbox(outDir, files, batch = null, firstOrder = 0) {
  await mkdir(join(BRAIN, 'inbox'), { recursive: true });
  const inboxed = [];
  for (const [i, f] of files.entries()) {
    let dest = join(BRAIN, 'inbox', f); let n = 0;
    while (true) {
      try { await stat(dest); n++; dest = join(BRAIN, 'inbox', `${basename(f, '.md')}-${n}.md`); }
      catch { break; }
    }
    const content = await readFile(join(outDir, f), 'utf8');
    await writeBrainFile(dest, batch
      ? content.replace(/^---\s*\n/, `---\n${batchLines(batch, firstOrder + i).join('\n')}\n`)
      : content);
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

// What a failed agent said, for the log and the window. claude can report errors on stdout and leave
// stderr empty, but stdout can also be a partial reply, so only a short text with no suggestions is used.
function errorOutput(stderr, stdout) {
  const err = stderr.trim(), out = stdout.trim();
  if (err) return err.slice(0, 400);
  if (!out) return '';
  return out.length <= 400 && !/===[ \t]*SUGGESTION[ \t]*===/.test(out) ? out : `stdout withheld, ${out.length} characters`;
}

// Run one agent process; resolves with stdout. Any exit other than 0, including being killed, rejects.
function runAgentProcess(label, cmd, args, { stdin, onAbort } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: AGENT_PATH },
    });
    // Kills the agent and any process it started. Rejects at once: a leftover child can hold stdout open.
    const abort = (message, exit) => {
      execFile('pkill', ['-KILL', '-P', String(child.pid)], () => child.kill('SIGKILL'));
      reject(Object.assign(new Error(message), { exit }));
    };
    onAbort?.(abort);
    if (stdin !== undefined) {
      child.stdin.on('error', () => {}); // a killed child closes the pipe mid-write
      child.stdin.end(stdin, 'utf8');
    }

    let stdout = '', stderr = '';
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => abort(`${label} timed out after 5 minutes`, 'timeout'), CALL_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(stdout);
      const exit = signal || code;
      const detail = errorOutput(stderr, stdout);
      reject(Object.assign(new Error(`${cmd} ${signal ? `killed by ${signal}` : `exited ${code}`}${detail ? `: ${detail}` : ''}`), { exit }));
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Run claude -p with no tools; returns captured stdout.
const runClaudeAgent = (prompt, onAbort) => runAgentProcess('Claude', 'claude', [
  '-p', '--tools', '', '--output-format', 'text', '--no-session-persistence',
], { stdin: prompt, onAbort });

// Run agy --sandbox with no file access; returns captured stdout.
const runGeminiAgent = (prompt, onAbort) => runAgentProcess('Gemini', 'agy', [
  '--sandbox', '--print-timeout', '300s', '--print', prompt,
], { onAbort });

// Run codex exec in its read-only sandbox (ChatGPT plans); prompt on stdin, final reply on stdout.
// Experimental: flags verified by verifyCodexHeadless on each machine before Codex is offered.
const CODEX_ARGS = ['exec', '--sandbox', 'read-only', '--skip-git-repo-check', '-'];
const runCodexAgent = (prompt, onAbort) => runAgentProcess('Codex', 'codex', CODEX_ARGS, { stdin: prompt, onAbort });

let codexDisabledReason = undefined; // undefined=unchecked, null=ok, string=reason
async function verifyCodexHeadless() {
  if (codexDisabledReason !== undefined) return codexDisabledReason;
  try {
    const out = await runAgentProcess('Codex', 'codex', CODEX_ARGS, { stdin: 'Reply with the single word: ok' });
    codexDisabledReason = out.trim() ? null : 'codex returned empty output for ping test';
  } catch (e) {
    codexDisabledReason = `codex headless test failed: ${e.message.slice(0, 160)}`;
  }
  return codexDisabledReason;
}

const AGENT_RUNNERS = { claude: runClaudeAgent, gemini: (...a) => runGeminiAgent(...a), codex: runCodexAgent };

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
  const used = new Set(await readdir(outDir)); // later calls of a run must not overwrite earlier ones
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

// Last updated day of a file: the later of its frontmatter date and its modification time.
// Frontmatter alone goes stale, because edits outside the app's approve flow don't touch it.
async function fileUpdated(rel) {
  const abs = join(BRAIN, rel);
  const declared = (parseFM(await readFile(abs, 'utf8')).updated || '').replace(/['"]/g, '');
  const modified = localDate((await stat(abs)).mtime);
  return /^\d{4}-\d{2}-\d{2}$/.test(declared) && declared > modified ? declared : modified;
}

// A folder item's date is that of its newest file; null if it has no files.
async function itemUpdated(files) {
  const dates = await Promise.all(files.map(fileUpdated));
  return dates.sort().at(-1) ?? null;
}

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

    await Promise.all(items.map(async item => { item.updated = await itemUpdated(item.files); }));
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
    await writeBrainFile(abs, safe_content);
    res.json({ ok: true, hash: md5(safe_content) });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Last git commit in ~/Brain
// On a Mac without the developer tools, running git opens Apple's install dialog; check once instead.
let hasGit = null;
async function gitAvailable() {
  if (hasGit === null) {
    try { await execAsync('xcode-select -p', { timeout: 5000 }); hasGit = true; } catch { hasGit = false; }
  }
  return hasGit;
}

app.get('/api/gitlog', async (_req, res) => {
  if (!(await gitAvailable())) return res.json({ lastCommit: null });
  try {
    const { stdout } = await execAsync(`git -C "${BRAIN}" log -1 --format="%ci"`, { timeout: 5000 });
    const raw = stdout.trim();
    res.json({ lastCommit: raw ? new Date(raw).toISOString() : null });
  } catch {
    res.json({ lastCommit: null });
  }
});

// ─── PACK ────────────────────────────────────────────────────────────────────

// Build a project's pack for other assistants by running ~/.brain/brainpack.sh (the single source of the
// pack format). The script saves the pack and copies it to the clipboard; the saved file is returned too.
const BRAINPACK = resolve(homedir(), '.brain', 'brainpack.sh');
const PACKS_DIR = resolve(homedir(), '.brain', 'packs');

app.post('/api/pack', async (req, res) => {
  const { mode = 'full' } = req.body || {};
  const project = String(req.body?.project || '');
  if (!['full', 'project-only', 'general', 'setup'].includes(mode)) return res.status(400).json({ error: 'Invalid pack mode' });
  const noProject = mode === 'general' || mode === 'setup';
  if (!noProject && !/^[a-z0-9][a-z0-9-]*$/.test(project)) return res.status(400).json({ error: 'Invalid project name' });
  const args = mode === 'general' ? ['--general'] : mode === 'setup' ? ['--setup'] : mode === 'project-only' ? ['--project-only', project] : [project];
  // LaunchAgents start without a locale; pbcopy then re-encodes non-ASCII text, so force UTF-8.
  const env = { ...process.env, LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
  execFile(BRAINPACK, args, { timeout: 15000, env }, async (err, stdout, stderr) => {
    if (err) return res.status(500).json({ error: (stdout || stderr || err.message).trim().split('\n')[0] });
    const m = stdout.match(/^Saved to: (.+)$/m);
    const packPath = m && resolve(m[1].trim());
    if (!packPath || !packPath.startsWith(PACKS_DIR + sep)) return res.status(500).json({ error: 'brainpack.sh did not report a pack file' });
    try {
      const content = await readFile(packPath, 'utf8');
      res.json({ ok: true, content, chars: content.length, file: basename(packPath) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
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
        batch: fm.batch ? { id: fm.batch, source: fm.batch_source || 'Pasted', at: fm.batch_at || null, order: Number(fm.batch_order) || 0 } : null,
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

// Approve one inbox item: append bullet lines to its target, update the target's updated date, delete the
// inbox file. Returns { status, body }. seenTargets: targets this batch has already changed, whose hash is
// expected to differ from the one the page loaded.
async function approveItem({ filename, inboxHash, targetHash }, seenTargets) {
  const inboxAbs = safeInbox(filename);

  let inboxContent;
  try { inboxContent = await readFile(inboxAbs, 'utf8'); }
  catch { return { status: 404, body: { error: 'Inbox file not found' } }; }

  if (inboxHash && md5(inboxContent) !== inboxHash) {
    return { status: 409, body: { error: 'conflict', message: 'Inbox file changed since it was opened.' } };
  }

  const fm = parseFM(inboxContent);
  if (!fm.target) return { status: 400, body: { error: 'No target field in inbox file' } };

  const expectedHash = seenTargets?.has(fm.target) ? null : targetHash;
  const targetAbs = safe(fm.target);
  const bodyRaw = inboxContent.replace(/^---[\s\S]*?---\s*\n?/, '').trimStart();
  const body = bodyRaw.trimEnd() + '\n';
  const today = localToday();

  // Pasted close-session proposals carry an action; distiller items have none and append as before.
  const result = fm.action
    ? await approveAction({ fm, inboxAbs, targetAbs, body: bodyRaw.replace(/\s+$/, ''), targetHash: expectedHash, today })
    : await approveAppend({ fm, inboxAbs, targetAbs, body, targetHash: expectedHash, today });
  if (result.status === 200) seenTargets?.add(fm.target);
  return result;
}

async function approveAppend({ fm, inboxAbs, targetAbs, body, targetHash, today }) {
  let targetContent;
  let targetExists = true;
  try { targetContent = await readFile(targetAbs, 'utf8'); }
  catch { targetExists = false; }

  let newTargetContent;
  if (targetExists) {
    if (targetHash && md5(targetContent) !== targetHash) {
      return { status: 409, body: { error: 'conflict', message: 'Target file changed since it was opened.' } };
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

  await writeBrainFile(targetAbs, newTargetContent);
  await deleteBrainFile(inboxAbs);
  return { status: 200, body: { ok: true } };
}

async function approveAction({ fm, inboxAbs, targetAbs, body, targetHash, today }) {
  if (!ACTIONS.includes(fm.action)) return { status: 400, body: { error: `Unknown action "${fm.action}"` } };
  if (!isAllowedTarget(fm.target)) return { status: 400, body: { error: `Target "${fm.target}" not allowed` } };

  const data = readInboxBody(fm.action, body);
  if (data.error) return { status: 400, body: { error: data.error } };
  if (fm.action === 'replace-section') data.section = fm.section || '';

  let current = null;
  try { current = await readFile(targetAbs, 'utf8'); } catch { }
  if (current !== null && targetHash && md5(current) !== targetHash) {
    return { status: 409, body: { error: 'conflict', message: 'Target file changed since it was opened.' } };
  }

  const result = applyProposal(fm.action, data, current, {
    today, titleFor: () => basename(fm.target, '.md').replace(/-/g, ' '),
  });
  if (result.error) return { status: 422, body: { error: result.error } };

  // Permalink lines are never touched: restore the original one if anything moved it.
  const out = current !== null ? guardPermalink(current, result.content) : result.content;
  if (current === null) await mkdir(dirname(targetAbs), { recursive: true });
  await writeBrainFile(targetAbs, out);
  await deleteBrainFile(inboxAbs);
  return { status: 200, body: { ok: true, action: fm.action } };
}

app.post('/api/inbox/approve', async (req, res) => {
  try {
    const { status, body } = await approveItem(req.body);
    res.status(status).json(body);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Approve all: apply the items in the order given and stop at the first failure; the rest stay in the inbox.
// Body: { items: [{ filename, inboxHash, targetHash }] } → { approved: [filename], failed: { filename, error } | null }
app.post('/api/inbox/approve-batch', async (req, res) => {
  const { items } = req.body || {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'items[] required' });

  const approved = [], seenTargets = new Set();
  for (const item of items) {
    let result;
    try { result = await approveItem(item, seenTargets); }
    catch (e) { result = { status: e.status || 500, body: { error: e.message } }; }
    if (result.status !== 200) {
      return res.json({ approved, failed: { filename: item.filename, error: result.body.message || result.body.error } });
    }
    approved.push(item.filename);
  }
  res.json({ approved, failed: null });
});

// Paste close-session output: parse UPDATE PROTOCOL blocks into inbox items. Plain code, no AI.
// Body: { text } → { created: [filename], errors: [{ line, file, reason }], batch, remainder, noBlocks }
// remainder is the text outside any block, which the page offers to convert.
app.post('/api/inbox/paste', async (req, res) => {
  try {
    const { text } = req.body || {};
    if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Nothing pasted' });

    const { proposals, errors, remainder, noBlocks } = parseProposals(text, { isAllowedTarget });
    const today = localToday();
    const created = [];
    const batch = { id: `paste-${makeRunId()}`, source: 'Pasted', at: new Date().toISOString() };
    await mkdir(join(BRAIN, 'inbox'), { recursive: true });

    for (const p of proposals) {
      const fail = reason => errors.push({ line: p.line, file: p.file, reason });
      let exists = true;
      try { await stat(safe(p.file)); } catch (e) { if (e.status) { fail(e.message); continue; } exists = false; }
      if (p.action === 'create' && exists) { fail('create: target already exists (use append or replace-section)'); continue; }
      if (!exists && !['create', 'append'].includes(p.action)) { fail(`${p.action}: target does not exist`); continue; }

      const content = toInboxFile(p, today, batch, created.length);
      const slug = `paste-${p.file.replace(/\.md$/, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${p.action}`.slice(0, 80);
      const reason = checkSuggestion(`${slug}.md`, content);
      if (reason) { fail(reason); continue; }

      let name = `${slug}.md`, n = 0;
      while (true) {
        try { await stat(join(BRAIN, 'inbox', name)); name = `${slug}-${++n}.md`; } catch { break; }
      }
      await writeBrainFile(join(BRAIN, 'inbox', name), content);
      created.push(name);
    }

    errors.sort((a, b) => (a.line || 0) - (b.line || 0));
    res.json({ created, errors, batch: created.length ? batch.id : null, remainder, noBlocks });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Convert free text with an assistant: a normal distill run (no tools, full brain in the prompt, same
// checker) whose suggestions land in the inbox as one batch. Body: { agent, text } → { runId }
const CONVERT_INSTRUCTION = '- The input is a session summary, not a raw conversation. Turn it into brain suggestions.';

app.post('/api/inbox/convert', (req, res) => {
  const { agent, text } = req.body || {};
  if (!AGENT_RUNNERS[agent]) return res.status(400).json({ error: 'agent required' });
  if (typeof text !== 'string' || !text.trim()) return res.status(400).json({ error: 'Nothing to convert' });
  if (activeRun) return res.status(409).json({ error: 'Another distill run is in progress' });

  const runId = makeRunId();
  const files = [{ name: 'pasted-text.txt', content: text.trim() }];
  const state = newRunState(runId, agent, files.map(f => f.name), []);
  activeRun = { runId, abort: null, cancelled: false };
  runStore.set(runId, state);
  res.json({ runId });
  runDistillPipeline(state, agent, files, {
    instruction: CONVERT_INSTRUCTION,
    batch: { id: `convert-${runId}`, source: 'Converted', at: state.startedAt },
  }).catch(() => {});
});

// Discard: delete inbox file
app.delete('/api/inbox/:filename', async (req, res) => {
  try {
    const inboxAbs = safeInbox(req.params.filename);
    try {
      await deleteBrainFile(inboxAbs);
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

  try {
    await execAsync('which codex', { env: { ...process.env, PATH: AGENT_PATH } });
    const reason = await verifyCodexHeadless();
    if (reason) { reasons.codex = reason; }
    else { agents.push('codex'); }
  } catch {
    reasons.codex = 'codex not installed';
  }

  res.json({ agents, reasons });
});

// ── Shared distill pipeline ───────────────────────────────────────────────────

// ── DISTILLED RECORDS ────────────────────────────────────────────────────────
// ~/.brain/imports/distilled.json: { items: { "<source>:<id>": record } }. Lives outside the per-source
// import folders, so re-parsing a new export keeps it; records are matched by conversation ID.
// record: { source, id, date, messageCount | totalChars, suggestions, runItems, runId, agent, runs: [...] }
// One run distills all its items together, so suggestions is the run's total, shared by its runItems.
const DISTILLED_FILE = resolve(homedir(), '.brain', 'imports', 'distilled.json');

async function loadDistilled() {
  try {
    const d = JSON.parse(await readFile(DISTILLED_FILE, 'utf8'));
    return d && typeof d.items === 'object' ? d : { items: {} };
  } catch { return { items: {} }; }
}

async function saveDistilled(d) {
  await mkdir(dirname(DISTILLED_FILE), { recursive: true });
  const tmp = DISTILLED_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(d, null, 2), 'utf8');
  await rename(tmp, DISTILLED_FILE);
}

let distilledLock = Promise.resolve(); // serialize read-modify-write
function updateDistilled(fn) {
  const next = distilledLock.then(async () => { const d = await loadDistilled(); fn(d); await saveDistilled(d); });
  distilledLock = next.catch(() => {});
  return next;
}

// tracked: [{ source, id, messageCount? , totalChars? }]
function recordDistilled(tracked, { runId, agent, suggestions }) {
  const date = localToday();
  return updateDistilled(d => {
    for (const t of tracked) {
      const key = `${t.source}:${t.id}`;
      const run = { date, runId, agent, suggestions, runItems: tracked.length,
        ...(t.messageCount !== undefined ? { messageCount: t.messageCount } : {}),
        ...(t.totalChars   !== undefined ? { totalChars:   t.totalChars }   : {}) };
      const prev = d.items[key];
      d.items[key] = { source: t.source, id: t.id, ...run, runs: [...(prev?.runs || []), run] };
    }
  });
}

// A recheck moves more of a run's suggestions to the inbox; add them to that run's records.
function addRecheckSuggestions(runId, n) {
  if (!n) return Promise.resolve();
  return updateDistilled(d => {
    for (const rec of Object.values(d.items)) {
      const run = (rec.runs || []).find(r => r.runId === runId);
      if (!run) continue;
      run.suggestions += n;
      if (rec.runId === runId) rec.suggestions = run.suggestions;
    }
  });
}

async function readIndex(dir) {
  try { return JSON.parse(await readFile(join(dir, 'index.json'), 'utf8')); } catch { return []; }
}

// ── RUN RECORDS ──────────────────────────────────────────────────────────────
// Each run keeps its progress in staging, so it survives a failure, a cancel or a server restart:
//   input.txt          the combined input, cut into chunks at fixed offsets
//   run.json           { runId, agent, status, reason, tracked, ranges, chunks: [{ status, ... }], suggestions, recorded }
//   replies/chunk-N.txt  raw reply of each finished call (chunk-N.rejected.txt if it broke the output contract)
//   out/               parsed suggestions waiting for the checker
// status: running | stopped (chunks remain, can be resumed) | done (kept only for dropped files).
const CALLS_FILE = resolve(homedir(), '.brain', 'distill-calls.json'); // recent call durations, for time estimates
const DEFAULT_CALL_MS = 90_000;

const runDir = runId => join(STAGING_BASE, runId);

async function saveRun(run) {
  const file = join(runDir(run.runId), 'run.json');
  await writeFile(file + '.tmp', JSON.stringify(run, null, 2), 'utf8');
  await rename(file + '.tmp', file);
}

// null for a missing folder, or for one left by an older version (no chunk list)
async function loadRun(runId) {
  try {
    const run = JSON.parse(await readFile(join(runDir(runId), 'run.json'), 'utf8'));
    return Array.isArray(run?.chunks) ? run : null;
  } catch { return null; }
}

async function listRuns() {
  let ids = [];
  try { ids = (await readdir(STAGING_BASE)).filter(id => RUN_ID_RE.test(id)); } catch { /* none yet */ }
  return (await Promise.all(ids.map(loadRun))).filter(Boolean);
}

const doneChunks = run => run.chunks.filter(c => c.status === 'done').length;

function splitChunks(text) {
  const chunks = [];
  for (let offset = 0; offset < text.length || chunks.length === 0; offset += CHARS_PER_CALL) {
    chunks.push(text.slice(offset, offset + CHARS_PER_CALL));
  }
  return chunks;
}

// Inputs are combined before chunking, so one chunk can hold the end of one item and the start of the next.
function combineInput(files) {
  const ranges = [];
  let pos = 0;
  const parts = files.map(f => {
    const part = `=== ${f.name} ===\n${f.content}`;
    ranges.push({ name: f.name, start: pos, end: pos + part.length });
    pos += part.length + 2;
    return part;
  });
  return { text: parts.join('\n\n'), ranges };
}

// Tracked items whose every chunk is done and that aren't recorded yet.
function newlyCompleteItems(run) {
  const allDone = r => {
    const first = Math.floor(r.start / CHARS_PER_CALL);
    const last  = Math.floor((r.end - 1) / CHARS_PER_CALL);
    for (let i = first; i <= last; i++) if (run.chunks[i]?.status !== 'done') return false;
    return true;
  };
  return (run.tracked || []).filter(t => {
    if (run.recorded.includes(`${t.source}:${t.id}`)) return false;
    const ranges = run.ranges.filter(r => t.names.includes(r.name));
    return ranges.length > 0 && ranges.every(allDone);
  });
}

async function loadCallDurations() {
  try { const d = JSON.parse(await readFile(CALLS_FILE, 'utf8')); return Array.isArray(d) ? d : []; }
  catch { return []; }
}

async function noteCallDuration(ms) {
  const d = [...await loadCallDurations(), ms].slice(-50);
  await writeFile(CALLS_FILE, JSON.stringify(d), 'utf8').catch(() => {});
}

// Shown to every call after the first, so a split input doesn't produce duplicate suggestions.
const earlierSection = earlier => earlier.trim() ? [
  '=== SUGGESTIONS ALREADY MADE IN THIS RUN ===',
  'Earlier parts of this same input already produced the suggestions below.',
  'Do not repeat them or reword them. Suggest only facts that are not already covered here or in the brain.',
  '',
  earlier.trim(),
  '',
].join('\n') + '\n' : '';

// Every chunk carries this header plus up to CHARS_PER_CALL characters of input,
// matching the distill-call estimates shown in the Import window.
async function buildDistillHeader(instruction) {
  const today        = localToday();
  const readme       = await readFile(join(BRAIN, 'README.md'), 'utf8');
  const brainIndex   = await buildBrainIndex();
  const brainContent = await buildBrainContent();

  const brainSection = brainContent
    ? [
        '=== CURRENT BRAIN CONTENT ===',
        'Compare every candidate fact against these files. Skip anything already recorded; suggest only new or changed facts.',
        '',
        brainContent,
        '',
      ].join('\n')
    : '';

  return [
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
    '- The brain (CURRENT BRAIN CONTENT) is the source of truth. When the input conflicts with the brain, the brain wins: do not suggest the older fact.',
    '- If the input contains something genuinely newer than the brain, suggest it with its date and keep the history in one line in the form "- <new fact> (since YYYY-MM-DD; previously <older fact>)".',
    '- Suggest only facts that are absent from the brain. No rewording of facts already present.',
    '- Never suggest sports, training, fitness, body or diet details (decision in projects/brain/decisions.md).',
    '- Never create a project for something the brain says belongs to someone else.',
    ...(instruction ? [instruction] : []),
    '- If nothing is worth adding, output nothing.',
    '',
    '=== README (Brain format rules) ===',
    readme.trim(),
    '',
    '=== BRAIN INDEX ===',
    brainIndex,
    '',
    brainSection,
  ].join('\n') + '\n';
}

// Changes between two checksum maps, leaving out those the app itself made.
function brainDiff(pre, post) {
  const byApp = k => appWrites.has(k) && appWrites.get(k) === (post[k] ?? null);
  const changed = [];
  for (const k of Object.keys(post)) {
    if (byApp(k)) continue;
    if (!pre[k])                 changed.push(`appeared: ${k}`);
    else if (pre[k] !== post[k]) changed.push(`modified: ${k}`);
  }
  for (const k of Object.keys(pre)) if (!post[k] && !byApp(k)) changed.push(`deleted: ${k}`);
  return changed;
}

// A second look before stopping a run: the first one may have read a file while the app was writing it.
async function outsideChanges(pre) {
  if (brainDiff(pre, await fileChecksums(BRAIN, '.git')).length === 0) return [];
  await new Promise(r => setTimeout(r, 250));
  return brainDiff(pre, await fileChecksums(BRAIN, '.git'));
}

// Checker on everything parsed so far: valid suggestions go to the inbox, and leave out/ so
// they can't be inboxed twice. Conversations whose chunks are all done are recorded as distilled.
async function collectFinished(run) {
  const outDir = join(runDir(run.runId), 'out');
  const { accepted, dropped } = await checkOutFiles(outDir);
  const inboxed = await moveToInbox(outDir, accepted, run.batch, run.suggestions);
  for (const f of accepted) await rm(join(outDir, f), { force: true });
  run.suggestions += inboxed.length;

  const complete = newlyCompleteItems(run);
  if (complete.length) {
    await recordDistilled(complete, { runId: run.runId, agent: run.agent, suggestions: run.suggestions })
      .then(() => run.recorded.push(...complete.map(t => `${t.source}:${t.id}`)))
      .catch(e => appendDistillLog(`${run.agent} | ${run.runId} | WARN: could not record distilled items: ${e.message}`));
  }
  return { inboxed, dropped };
}

const countOf = (n, word) => `${n} ${word}${n !== 1 ? 's' : ''}`;

// A call failed, the run was cancelled, or the server restarted: keep what finished and record what remains.
async function stopRun(state, run, reason) {
  const { inboxed, dropped } = await collectFinished(run);
  run.status = 'stopped';
  run.reason = reason;
  await saveRun(run);

  const done = doneChunks(run), total = run.chunks.length;
  state.status = 'stopped';
  state.result = { inboxed, dropped, done, total, remaining: total - done };
  state.message = `${reason} ${done} of ${total} calls finished, ${countOf(inboxed.length, 'suggestion')} moved to inbox` +
    (dropped.length ? `, ${dropped.length} dropped by checker` : '') + `, ${countOf(total - done, 'chunk')} remaining.`;
  await appendDistillLog(`${run.agent} | ${run.runId} | STOPPED: ${reason} | ${done}/${total} calls done, ` +
    `${total - done} remaining | ${inboxed.length} → inbox (${inboxed.join(', ')})` +
    (dropped.length ? ` | DROPPED: ${fmtDropped(dropped)}` : ''));
}

async function finishRun(state, run) {
  state.message = 'Checking output…';
  const { inboxed, dropped } = await collectFinished(run);

  // Delete staging only when nothing was dropped; keep it for inspection otherwise.
  if (dropped.length === 0) await rm(runDir(run.runId), { recursive: true, force: true });
  else { run.status = 'done'; await saveRun(run); }

  state.status = 'done';
  state.result = { inboxed, dropped };
  state.message = `${countOf(inboxed.length, 'suggestion')} moved to inbox` +
    (dropped.length ? `, ${dropped.length} dropped by checker` : '');
  await appendDistillLog(`${run.agent} | ${run.runId} | OK: ${inboxed.length} → inbox (${inboxed.join(', ')})` +
    (dropped.length ? ` | DROPPED: ${fmtDropped(dropped)}` : ''));
}

// Send every chunk that isn't done yet, one at a time. Each finished reply is saved before the next call.
async function executeRun(state, run) {
  const stagDir  = runDir(run.runId);
  const agentRun = activeRun;
  try {
    const runAgent = AGENT_RUNNERS[run.agent];
    if (!runAgent) throw new Error(`Unknown agent: ${run.agent}`);

    run.status = 'running';
    run.reason = null;
    await saveRun(run);
    appWrites.clear();

    const chunks = splitChunks(await readFile(join(stagDir, 'input.txt'), 'utf8'));
    const header = await buildDistillHeader(run.instruction);
    await mkdir(join(stagDir, 'replies'), { recursive: true });
    const replyFile = i => join(stagDir, 'replies', `chunk-${i + 1}.txt`);

    let earlier = ''; // suggestion blocks from finished chunks, including those of a run being resumed
    for (let i = 0; i < chunks.length; i++) {
      if (run.chunks[i].status === 'done') earlier += (await readFile(replyFile(i), 'utf8')).trim() + '\n\n';
    }

    state.totalCalls = chunks.length;
    for (let i = 0; i < chunks.length; i++) {
      if (run.chunks[i].status === 'done') continue;
      if (agentRun.cancelled) return await stopRun(state, run, 'Cancelled.');

      state.status = 'running';
      state.callNumber = i + 1;
      state.message = `Call ${i + 1} of ${chunks.length}`;
      const callLabel = `${run.agent} | ${run.runId} | chunk ${i + 1}/${chunks.length}`;
      const seconds = ms => `${Math.round(ms / 1000)}s`;

      const preBrain = await fileChecksums(BRAIN, '.git');
      const started  = Date.now();
      let reply;
      try {
        reply = await runAgent(header + earlierSection(earlier) + '=== INPUT ===\n' + chunks[i], abort => { agentRun.abort = abort; });
      } catch (e) {
        await appendDistillLog(`${callLabel} | ${seconds(Date.now() - started)} | exit ${e.exit ?? 'none'} | FAIL: ${e.message}`);
        return await stopRun(state, run, agentRun.cancelled ? 'Cancelled.' : `Call ${i + 1} failed: ${e.message}.`);
      } finally {
        agentRun.abort = null;
      }
      const durationMs = Date.now() - started;

      // The agent has no tools, so a change the app didn't make means something is wrong: don't trust this reply.
      const changed = await outsideChanges(preBrain);
      if (changed.length > 0) {
        const reason = `~/Brain changed during call ${i + 1}: ${changed.join('; ')}.`;
        await appendDistillLog(`${callLabel} | ${seconds(durationMs)} | exit 0 | FAIL: ${reason}`);
        return await stopRun(state, run, reason);
      }

      const contractError = checkReplyContract(reply);
      if (contractError) {
        await writeFile(join(stagDir, 'replies', `chunk-${i + 1}.rejected.txt`), reply, 'utf8');
        await appendDistillLog(`${callLabel} | ${seconds(durationMs)} | exit 0 | FAIL: ${contractError}`);
        return await stopRun(state, run, `Call ${i + 1} failed: ${contractError}.`);
      }

      // Reply first, chunk marked done last: a crash between them only repeats this call.
      await writeFile(replyFile(i), reply, 'utf8');
      const suggestions = await parseAgentReply(reply, join(stagDir, 'out'));
      run.chunks[i] = { status: 'done', durationMs, suggestions, finishedAt: new Date().toISOString() };
      await saveRun(run);
      if (reply.trim()) earlier += reply.trim() + '\n\n';
      await noteCallDuration(durationMs);
      await appendDistillLog(`${callLabel} | ${seconds(durationMs)} | exit 0 | ${countOf(suggestions, 'suggestion')}`);
    }

    await finishRun(state, run);
  } catch (e) {
    await appendDistillLog(`${run.agent} | ${run.runId} | ERROR: ${e.message}`);
    try { await stopRun(state, run, `Error: ${e.message}.`); }
    catch (e2) { state.status = 'failed'; state.message = `Error: ${e2.message}`; }
  } finally {
    if (activeRun === agentRun) activeRun = null;
  }
}

function newRunState(runId, agent, inputNames, tracked) {
  return { runId, status: 'pending', message: 'Preparing…', result: null, agent, inputNames, tracked,
    callNumber: null, totalCalls: null, startedAt: new Date().toISOString() };
}

// Start a new run: write its staging folder, then execute it.
// options: { instruction, batch } for a conversion; both are kept in run.json so a Resume uses them too.
async function runDistillPipeline(state, agent, files, { instruction = null, batch = null } = {}) {
  const stagDir = runDir(state.runId);
  try {
    await mkdir(join(stagDir, 'input'), { recursive: true });
    await mkdir(join(stagDir, 'out'),   { recursive: true });
    for (const f of files) {
      await writeFile(join(stagDir, 'input', basename(f.name)), f.content, 'utf8');
    }
    const { text, ranges } = combineInput(files);
    await writeFile(join(stagDir, 'input.txt'), text, 'utf8');
    const run = {
      runId: state.runId, agent, status: 'running', reason: null, createdAt: state.startedAt,
      inputNames: state.inputNames, tracked: state.tracked || [], ranges,
      chunks: splitChunks(text).map(() => ({ status: 'pending' })),
      suggestions: 0, recorded: [], instruction, batch,
    };
    await saveRun(run);
    await executeRun(state, run);
  } catch (e) {
    activeRun = null;
    state.status  = 'failed';
    state.message = `Error: ${e.message}`;
    await appendDistillLog(`${agent} | ${state.runId} | ERROR: ${e.message}`);
  }
}

// A run still marked running at startup was cut off by a restart or crash.
async function recoverInterruptedRuns() {
  for (const run of await listRuns()) {
    if (run.status !== 'running') continue;
    const state = newRunState(run.runId, run.agent, run.inputNames, run.tracked);
    await stopRun(state, run, 'The server restarted during the run.').catch(e =>
      appendDistillLog(`${run.agent} | ${run.runId} | ERROR: recovery failed: ${e.message}`));
    runStore.set(run.runId, state);
  }
}

// ── DISTILL ROUTES ────────────────────────────────────────────────────────────

// Start a distill run from uploaded files. Body: { agent, files: [{name, content}] }
app.post('/api/distill/run', async (req, res) => {
  const { agent, files } = req.body;
  if (!agent || !Array.isArray(files) || files.length === 0)
    return res.status(400).json({ error: 'agent and files[] required' });

  if (activeRun) return res.status(409).json({ error: 'Another distill run is in progress' });

  const runId = makeRunId();
  const state = newRunState(runId, agent, files.map(f => f.name), []);
  activeRun = { runId, abort: null, cancelled: false };
  runStore.set(runId, state);
  res.json({ runId });
  runDistillPipeline(state, agent, files, { batch: { id: `distill-${runId}`, source: 'Distilled', at: state.startedAt } }).catch(() => {});
});

// Start a distill run from parsed import items.
// Body: { agent, conversationUuids?: string[], chatgptIds?: string[], geminiIds?: string[], includeMemories?: bool }
app.post('/api/distill/import', async (req, res) => {
  const { agent, conversationUuids = [], chatgptIds = [], geminiIds = [], includeMemories = false } = req.body;
  if (!agent) return res.status(400).json({ error: 'agent required' });

  const files = [];
  const tracked = []; // recorded in distilled.json once all their chunks are done
  const convDir = getConvDir();
  const memDir  = getMemDir();

  // messageCount at distill time, so a later export with more messages can be flagged
  const counts = async dir => new Map((await readIndex(dir)).map(c => [c.uuid, c.messageCount]));
  const [claudeCounts, chatgptCounts, geminiCounts] = await Promise.all(
    [convDir, getChatgptConvDir(), getGeminiConvDir()].map(counts));
  const track = (source, id, map, name) => tracked.push({ source, id, names: [name], messageCount: map.get(id) ?? null });

  for (const uuid of conversationUuids) {
    if (!/^[0-9a-f-]{8,}$/i.test(uuid)) continue;
    try {
      const content = await readFile(join(convDir, `${uuid}.txt`), 'utf8');
      files.push({ name: `conv-${uuid.slice(0, 8)}.txt`, content });
      track('claude', uuid, claudeCounts, `conv-${uuid.slice(0, 8)}.txt`);
    } catch { /* skip missing */ }
  }

  const chatgptDir = getChatgptConvDir();
  for (const id of chatgptIds) {
    if (!/^[0-9a-f-]{8,}$/i.test(id)) continue;
    try {
      const content = await readFile(join(chatgptDir, `${id}.txt`), 'utf8');
      files.push({ name: `chatgpt-${id.slice(0, 8)}.txt`, content });
      track('chatgpt', id, chatgptCounts, `chatgpt-${id.slice(0, 8)}.txt`);
    } catch { /* skip missing */ }
  }

  const geminiDir = getGeminiConvDir();
  for (const id of geminiIds) {
    if (!/^gemini-[0-9a-f]{8,}$/i.test(id)) continue;
    try {
      const content = await readFile(join(geminiDir, `${id}.txt`), 'utf8');
      files.push({ name: `${id.slice(0, 15)}.txt`, content });
      track('gemini', id, geminiCounts, `${id.slice(0, 15)}.txt`);
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
    // Claude memories are one item; totalChars flags a later export with changed memories.
    const memNames = files.map(f => f.name).filter(n => n.startsWith('memory-') || n.startsWith('memfile-'));
    if (memNames.length) {
      tracked.push({ source: 'memories', id: 'claude-memories', names: memNames, totalChars: (await memStatsFromDisk()).totalChars });
    }
  }

  if (files.length === 0) return res.status(400).json({ error: 'No import content found — parse first' });

  if (activeRun) return res.status(409).json({ error: 'Another distill run is in progress' });

  const runId = makeRunId();
  const state = newRunState(runId, agent, files.map(f => f.name), tracked);
  activeRun = { runId, abort: null, cancelled: false };
  runStore.set(runId, state);
  res.json({ runId });
  runDistillPipeline(state, agent, files, { batch: { id: `import-${runId}`, source: 'Imported', at: state.startedAt } }).catch(() => {});
});

// Distilled records, keyed "<source>:<id>" (source: claude | chatgpt | gemini | memories)
app.get('/api/import/distilled', async (_req, res) => {
  res.json((await loadDistilled()).items);
});

// Re-run the checker on a kept staging folder (no agent call) and move valid files to the inbox.
app.post('/api/distill/recheck/:runId', async (req, res) => {
  const { runId } = req.params;
  if (!RUN_ID_RE.test(runId)) return res.status(400).json({ error: 'Invalid runId' });
  const stagDir = join(STAGING_BASE, runId);
  const outDir  = join(stagDir, 'out');
  try { await stat(outDir); } catch { return res.status(404).json({ error: 'Staging folder not found' }); }
  try {
    if (activeRun?.runId === runId) return res.status(409).json({ error: 'Run is in progress' });
    const { accepted, dropped } = await checkOutFiles(outDir);
    const run = await loadRun(runId);
    const inboxed = await moveToInbox(outDir, accepted, run?.batch, run?.suggestions);
    const stopped = run?.status === 'stopped'; // a stopped run still needs its folder for Resume
    if (dropped.length === 0 && !stopped) await rm(stagDir, { recursive: true, force: true });
    else for (const f of accepted) await rm(join(outDir, f), { force: true }); // don't re-inbox on a second recheck
    await appendDistillLog(`recheck | ${runId} | OK: ${inboxed.length} → inbox (${inboxed.join(', ')})` +
      (dropped.length ? ` | DROPPED: ${fmtDropped(dropped)}` : ''));
    await addRecheckSuggestions(runId, inboxed.length).catch(() => {});
    res.json({ inboxed, dropped });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// The run in progress, the stopped runs that can be resumed, and the average call time for estimates.
app.get('/api/distill/runs', async (_req, res) => {
  const stopped = (await listRuns())
    .filter(r => r.status === 'stopped' && r.runId !== activeRun?.runId)
    .sort((a, b) => b.runId.localeCompare(a.runId))
    .map(r => ({ runId: r.runId, agent: r.agent, reason: r.reason, createdAt: r.createdAt,
      inputNames: r.inputNames, tracked: r.tracked, suggestions: r.suggestions,
      total: r.chunks.length, done: doneChunks(r) }));
  const durations = await loadCallDurations();
  res.json({
    active: activeRun ? { runId: activeRun.runId } : null,
    stopped,
    callSamples: durations.length,
    avgCallMs: durations.length ? Math.round(durations.reduce((n, d) => n + d, 0) / durations.length) : DEFAULT_CALL_MS,
  });
});

// Cancel the run in progress: kills the current call; finished calls are kept.
app.post('/api/distill/cancel/:runId', (req, res) => {
  if (activeRun?.runId !== req.params.runId) return res.status(409).json({ error: 'Run is not in progress' });
  activeRun.cancelled = true;
  activeRun.abort?.('Cancelled', 'cancelled');
  const state = runStore.get(req.params.runId);
  if (state) state.message = 'Cancelling…';
  res.json({ ok: true });
});

// Resume a stopped run: sends only the chunks that aren't done.
app.post('/api/distill/resume/:runId', async (req, res) => {
  const { runId } = req.params;
  if (!RUN_ID_RE.test(runId)) return res.status(400).json({ error: 'Invalid runId' });
  const run = await loadRun(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  if (run.status !== 'stopped') return res.status(409).json({ error: 'Run is not stopped' });
  if (activeRun) return res.status(409).json({ error: 'Another distill run is in progress' });

  const state = newRunState(runId, run.agent, run.inputNames, run.tracked);
  activeRun = { runId, abort: null, cancelled: false };
  runStore.set(runId, state);
  res.json({ runId });
  executeRun(state, run).catch(() => {});
});

// Poll run status
app.get('/api/distill/status/:runId', (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

// ── IMPORT STATE RESTORE ──────────────────────────────────────────────────────

// Stats for one source rebuilt from its index.json; skipped count is unknown without a parse.
async function statsFromIndex(convDir) {
  const p = join(convDir, 'index.json');
  const [index, st] = await Promise.all([readFile(p, 'utf8').then(JSON.parse), stat(p)]);
  const totalChars = index.reduce((n, c) => n + (c.charCount || 0), 0);
  return {
    mtime: st.mtime,
    stats: {
      total: null, parsed: index.length, skipped: null, totalChars,
      avgChars: index.length ? Math.round(totalChars / index.length) : 0,
      totalDistillCalls: index.reduce((n, c) => n + (c.distillCalls || 0), 0),
    },
  };
}

// Memory stats rebuilt from the files parseMemories() already wrote.
async function memStatsFromDisk() {
  const memDir = getMemDir();
  let totalChars = 0, convMemoryChars = 0, projectMemCount = 0, fileCount = 0;
  try { convMemoryChars = (await readFile(join(memDir, 'conversations_memory.txt'), 'utf8')).length; } catch { }
  totalChars += convMemoryChars;
  try {
    for (const f of await readdir(join(memDir, 'project_memories'))) {
      totalChars += (await readFile(join(memDir, 'project_memories', f), 'utf8')).length;
      projectMemCount++;
    }
  } catch { }
  async function walk(d) {
    let entries;
    try { entries = await readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isDirectory()) await walk(join(d, e.name));
      else { totalChars += (await readFile(join(d, e.name), 'utf8')).length; fileCount++; }
    }
  }
  await walk(join(memDir, 'memory_files'));
  return { convMemoryChars, projectMemCount, fileCount, totalChars, totalDistillCalls: Math.ceil(totalChars / CHARS_PER_CALL) };
}

// On startup: reuse the saved parse state, or rebuild one from existing index.json files.
async function restoreParseState() {
  try {
    const saved = JSON.parse(await readFile(PARSE_STATE_FILE, 'utf8'));
    if (saved?.status === 'done') {
      // A state saved before a source existed lacks its key; fill it from that source's index.json.
      if (saved.result && !saved.result.gemini) {
        const gemini = await statsFromIndex(getGeminiConvDir()).catch(() => null);
        if (gemini) saved.result.gemini = gemini.stats;
      }
      importParseState = saved;
      return;
    }
  } catch { }

  const empty = { total: 0, parsed: 0, skipped: null, totalChars: 0, avgChars: 0, totalDistillCalls: 0 };
  const [claude, chatgpt, gemini] = await Promise.all([
    statsFromIndex(getConvDir()).catch(() => null),
    statsFromIndex(getChatgptConvDir()).catch(() => null),
    statsFromIndex(getGeminiConvDir()).catch(() => null),
  ]);
  if (!claude && !chatgpt && !gemini) return;

  const latest = new Date(Math.max(...[claude, chatgpt, gemini].filter(Boolean).map(x => x.mtime.getTime())));
  importParseState = {
    status: 'done', startedAt: null, finishedAt: latest.toISOString(), error: null,
    result: {
      conversations: claude?.stats  || empty,
      memories:      await memStatsFromDisk(),
      chatgpt:       chatgpt?.stats || empty,
      gemini:        gemini?.stats  || empty,
    },
  };
}
await restoreParseState();

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
      const result = await Promise.all([parseConversations(), parseMemories(), parseChatgptConversations(), parseGeminiConversations()]);
      importParseState = {
        status: 'done',
        startedAt: importParseState.startedAt,
        finishedAt: new Date().toISOString(),
        result: { conversations: result[0], memories: result[1], chatgpt: result[2], gemini: result[3] },
        error: null,
      };
      await writeFile(PARSE_STATE_FILE, JSON.stringify(importParseState, null, 2), 'utf8').catch(() => {});
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

// Return the parsed Gemini conversation index
app.get('/api/import/gemini-index', async (_req, res) => {
  try {
    const p = join(getGeminiConvDir(), 'index.json');
    const data = JSON.parse(await readFile(p, 'utf8'));
    res.json(data);
  } catch {
    res.status(404).json({ error: 'Not parsed yet — POST /api/import/parse first' });
  }
});

// ── CODE MAPS ─────────────────────────────────────────────────────────────────
// Link a project to a code folder and map it; see src/codemap-routes.js.
registerCodeMapRoutes(app, { gitAvailable });

// ── STATIC ────────────────────────────────────────────────────────────────────

// Serve the Vite production build; fall through to index.html for SPA
app.use(express.static(join(__dirname, 'dist')));
app.use((_req, res) =>
  res.sendFile(join(__dirname, 'dist', 'index.html'))
);

recoverInterruptedRuns();

app.listen(PORT, '127.0.0.1', () =>
  console.log(`Brain app → http://localhost:${PORT}`)
);
