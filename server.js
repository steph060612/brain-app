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

// Validate all files in out/ against checker rules
async function checkOutFiles(outDir) {
  const errors = [];
  let names;
  try { names = (await readdir(outDir)).filter(f => !f.startsWith('.')); }
  catch { return { ok: false, errors: ['out/ directory missing'] }; }
  if (names.length === 0) return { ok: false, errors: ['No files written to out/'] };

  const mdFiles = [];
  for (const f of names) {
    if (!f.endsWith('.md')) { errors.push(`Non-.md file in out/: ${f}`); continue; }
    let content;
    try { content = await readFile(join(outDir, f), 'utf8'); }
    catch { errors.push(`Cannot read out/${f}`); continue; }

    if (Buffer.byteLength(content, 'utf8') > 20 * 1024) { errors.push(`out/${f} exceeds 20 KB`); continue; }
    if (/^permalink:/m.test(content)) { errors.push(`out/${f} has a permalink line`); continue; }

    const fm = parseFM(content);
    if (!fm.title)   errors.push(`out/${f}: missing title`);
    if (!fm.updated) errors.push(`out/${f}: missing updated`);
    if (!fm.target)  { errors.push(`out/${f}: missing target`); continue; }

    const t = fm.target;
    if (t.includes('..') || t.startsWith('/')) { errors.push(`out/${f}: invalid target path`); continue; }
    if (!['projects/', 'archive/', 'people/', 'topics/'].some(p => t.startsWith(p))) {
      errors.push(`out/${f}: target "${t}" outside allowed folders`); continue;
    }
    mdFiles.push(f);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, mdFiles };
}

async function appendDistillLog(line) {
  try {
    await mkdir(resolve(homedir(), '.brain'), { recursive: true });
    const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
    await writeFile(DISTILL_LOG, `${ts} | ${line}\n`, { flag: 'a' });
  } catch { /* non-fatal */ }
}

// Run claude -p with prompt on stdin, cwd = stagingDir
async function runClaudeAgent(stagingDir, prompt) {
  return new Promise((resolve, reject) => {
    const child = spawn('claude', [
      '-p',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read,Write,Edit,LS,Glob',
      '--disallowedTools', 'Bash,WebFetch,WebSearch',
      '--output-format', 'text',
      '--no-session-persistence',
    ], {
      cwd: stagingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: AGENT_PATH },
    });

    child.stdin.write(prompt, 'utf8');
    child.stdin.end();

    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', d => { stderr += d; });

    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Claude timed out after 5 minutes')); }, 5 * 60 * 1000);
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0 || code === null) resolve();
      else reject(new Error(`claude exited ${code}: ${stderr.slice(0, 400)}`));
    });
    child.on('error', e => { clearTimeout(timer); reject(e); });
  });
}

// Gemini/agy runner — currently disabled; see verifyGeminiHeadless for reason.
async function runGeminiAgent(_stagingDir, _prompt) {
  throw new Error('Gemini is disabled: ' + (geminiDisabledReason || 'project-level settings unverifiable'));
}

// Verify agy project-level settings work in headless mode without --dangerously-skip-permissions.
// Result: null = OK, string = disabled reason. Cached after first call.
// Findings from empirical testing (agy 1.4.9):
//   - settings.json in CWD is read, but in headless --print mode agy auto-denies write_file
//     permission unless --dangerously-skip-permissions is also passed.
//   - --dangerously-skip-permissions bypasses ALL path restrictions in settings.json, so
//     project-level write isolation cannot be enforced headlessly.
//   - The same applies to ~/.gemini/config/projects/[name]/settings.json + --project.
// Therefore Gemini remains disabled until agy adds per-path headless permission grants.
let geminiDisabledReason = undefined; // undefined=unchecked, null=ok, string=reason
async function verifyGeminiHeadless() {
  if (geminiDisabledReason !== undefined) return geminiDisabledReason;

  // Step 1: confirm agy binary is reachable.
  try {
    await execAsync('agy --version', { timeout: 8000, env: { ...process.env, PATH: AGENT_PATH } });
  } catch (e) {
    geminiDisabledReason = `agy not found or failed to start: ${e.message.slice(0, 120)}`;
    return geminiDisabledReason;
  }

  // Step 2: verify that a write outside out/ is denied under project settings,
  // WITHOUT --dangerously-skip-permissions. Create a minimal staging dir and
  // try to write to two paths — inside out/ and outside it.
  const testDir = join(STAGING_BASE, `gemini-verify-${Date.now()}`);
  const outDir  = join(testDir, 'out');
  const projectName = 'brain-distill-verify';
  const projectSettingsDir = join(homedir(), '.gemini', 'config', 'projects', projectName);
  const settingsPath = join(projectSettingsDir, 'settings.json');
  const globalSettingsPath = join(homedir(), '.gemini', 'antigravity-cli', 'settings.json');

  try {
    await mkdir(outDir, { recursive: true });
    await mkdir(projectSettingsDir, { recursive: true });

    // Record global settings checksum before test
    let globalBefore = null;
    try { globalBefore = md5(await readFile(globalSettingsPath, 'utf8')); } catch { /* absent is fine */ }

    await writeFile(settingsPath, JSON.stringify({
      permissions: {
        allow: [
          `read_file(${testDir})`,
          `write_file(${outDir})`,
        ],
      },
    }, null, 2));

    // Run agy without --dangerously-skip-permissions
    const testPrompt = `Write 'inside' to ${join(outDir, 'inside.txt')} and 'outside' to ${join(testDir, 'escape.txt')}`;
    let agyStopped = false;
    try {
      await new Promise((res, rej) => {
        const child = spawn('agy', [
          '--print',
          '--sandbox',
          '--project', projectName,
          '--add-dir', testDir,
          '--print-timeout', '20s',
          testPrompt,
        ], {
          cwd: testDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, PATH: AGENT_PATH },
        });
        const t = setTimeout(() => { child.kill('SIGKILL'); agyStopped = true; res(); }, 25000);
        child.on('close', () => { clearTimeout(t); res(); });
        child.on('error', e => { clearTimeout(t); rej(e); });
      });
    } catch { /* expected — headless denial */ }

    // Check global settings unchanged
    let globalAfter = null;
    try { globalAfter = md5(await readFile(globalSettingsPath, 'utf8')); } catch { /* absent */ }
    if (globalBefore !== globalAfter) {
      geminiDisabledReason = 'agy modified ~/.gemini/antigravity-cli/settings.json during headless test';
      return geminiDisabledReason;
    }

    // Check escape was denied and inside was also denied (headless auto-denial without --dangerously-skip-permissions)
    const escapeExists = await stat(join(testDir, 'escape.txt')).then(() => true).catch(() => false);
    const insideExists = await stat(join(outDir, 'inside.txt')).then(() => true).catch(() => false);

    if (escapeExists) {
      geminiDisabledReason = 'agy wrote outside out/ despite project settings — sandbox ineffective';
      return geminiDisabledReason;
    }

    if (!insideExists && !agyStopped) {
      // Both denied: write_file is auto-denied in headless mode without --dangerously-skip-permissions.
      // Using --dangerously-skip-permissions would bypass the write_file path restrictions.
      // Neither option gives safe isolated writes.
      geminiDisabledReason =
        'agy --print auto-denies write_file in headless mode without --dangerously-skip-permissions; ' +
        '--dangerously-skip-permissions bypasses project-level path restrictions entirely. ' +
        'Safe headless write isolation is not achievable in agy 1.4.9.';
      return geminiDisabledReason;
    }

    // If we somehow got here with inside written and escape not written, it works — enable
    geminiDisabledReason = null;
  } catch (e) {
    geminiDisabledReason = `agy verification error: ${e.message.slice(0, 160)}`;
  } finally {
    try { await rm(testDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
    try { await rm(projectSettingsDir, { recursive: true, force: true }); } catch { /* non-fatal */ }
  }

  return geminiDisabledReason;
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

// Start a distill run. Body: { agent, files: [{name, content}] }
app.post('/api/distill/run', async (req, res) => {
  const { agent, files } = req.body;
  if (!agent || !Array.isArray(files) || files.length === 0)
    return res.status(400).json({ error: 'agent and files[] required' });

  const runId   = makeRunId();
  const stagDir = join(STAGING_BASE, runId);
  const state   = {
    status: 'pending', message: 'Preparing staging folder…',
    result: null, agent, inputNames: files.map(f => f.name),
    startedAt: new Date().toISOString(),
  };
  runStore.set(runId, state);
  res.json({ runId });

  const inputLabel = files.map(f => f.name).join(', ');

  (async () => {
    try {
      // ── Setup staging ──────────────────────────────────────────────
      await mkdir(STAGING_BASE, { recursive: true });
      await mkdir(join(stagDir, 'input'), { recursive: true });
      await mkdir(join(stagDir, 'out'));

      await writeFile(join(stagDir, 'README.md'),
        await readFile(join(BRAIN, 'README.md'), 'utf8'));
      await writeFile(join(stagDir, 'brain-index.txt'), await buildBrainIndex());

      for (const f of files) {
        await writeFile(join(stagDir, 'input', basename(f.name)), f.content, 'utf8');
      }

      const today = new Date().toISOString().split('T')[0];
      const prompt = [
        'Read README.md for Brain file format rules, brain-index.txt for every existing Brain path,',
        'and all files in input/ for the content to distill.',
        '',
        'Write your output to the out/ directory ONLY — never write anywhere else.',
        '',
        'Each output file must have YAML frontmatter with:',
        `  title: <short descriptive title>`,
        `  updated: ${today}`,
        `  target: <relative path from brain-index.txt, OR a new path under projects/ for a brand-new project>`,
        '',
        'Body: bullet-point facts only — exactly as stated in the input, distilled and organised.',
        'No raw transcript. No opinions. No permalink line. One file per target. Lowercase-hyphenated filenames.',
      ].join('\n');

      await writeFile(join(stagDir, 'run.json'), JSON.stringify(
        { runId, agent, inputNames: files.map(f => f.name), today }, null, 2));

      // ── Pre-run snapshots ──────────────────────────────────────────
      const preSnap = await fileChecksums(stagDir, 'out');

      // Record git status of ~/Brain before run (catches agent writes outside staging)
      let preGitStatus = '';
      try {
        const { stdout } = await execAsync(`git -C "${BRAIN}" status --short`, { timeout: 10000 });
        preGitStatus = stdout.trim();
      } catch { /* git absent or not a repo — skip */ }

      state.status  = 'running';
      state.message = `${agent === 'claude' ? 'Claude' : 'Gemini'} is distilling…`;

      if (agent === 'claude')       await runClaudeAgent(stagDir, prompt);
      else if (agent === 'gemini')  await runGeminiAgent(stagDir, prompt);
      else throw new Error(`Unknown agent: ${agent}`);

      state.message = 'Checking output…';

      // ── Post-run Brain git status check ───────────────────────────
      let postGitStatus = '';
      try {
        const { stdout } = await execAsync(`git -C "${BRAIN}" status --short`, { timeout: 10000 });
        postGitStatus = stdout.trim();
      } catch { /* skip */ }

      if (preGitStatus !== postGitStatus) {
        const reason = `~/Brain changed during run (git status diff): before="${preGitStatus}" after="${postGitStatus}"`;
        state.status = 'failed'; state.message = reason;
        await appendDistillLog(`${agent} | ${inputLabel} | FAIL: ${reason}`);
        return;
      }

      // ── Post-run staging: nothing outside out/ should have changed ─
      const postSnap = await fileChecksums(stagDir, 'out');
      const tampered = [];
      for (const k of Object.keys(postSnap)) {
        if (!preSnap[k]) tampered.push(`new file: ${k}`);
        else if (preSnap[k] !== postSnap[k]) tampered.push(`modified: ${k}`);
      }
      for (const k of Object.keys(preSnap)) {
        if (!postSnap[k]) tampered.push(`deleted: ${k}`);
      }
      if (tampered.length > 0) {
        const reason = `Files changed outside out/: ${tampered.join('; ')}`;
        state.status = 'failed'; state.message = reason;
        await appendDistillLog(`${agent} | ${inputLabel} | FAIL: ${reason}`);
        return;
      }

      // ── Validate out/ contents ─────────────────────────────────────
      const { ok, errors, mdFiles } = await checkOutFiles(join(stagDir, 'out'));
      if (!ok) {
        const reason = errors.join('; ');
        state.status = 'failed'; state.message = `Checker: ${reason}`;
        await appendDistillLog(`${agent} | ${inputLabel} | FAIL: ${reason}`);
        return;
      }

      // ── Move approved files to ~/Brain/inbox/ ──────────────────────
      await mkdir(join(BRAIN, 'inbox'), { recursive: true });
      const inboxed = [];
      for (const f of mdFiles) {
        let dest = join(BRAIN, 'inbox', f); let n = 0;
        while (true) {
          try { await stat(dest); n++; dest = join(BRAIN, 'inbox', `${basename(f, '.md')}-${n}.md`); }
          catch { break; }
        }
        await writeFile(dest, await readFile(join(stagDir, 'out', f), 'utf8'));
        inboxed.push(basename(dest));
      }

      // ── Delete staging on success ──────────────────────────────────
      await rm(stagDir, { recursive: true, force: true });

      state.status = 'done';
      state.result = { inboxed };
      state.message = `${inboxed.length} suggestion${inboxed.length !== 1 ? 's' : ''} moved to inbox: ${inboxed.join(', ')}`;
      await appendDistillLog(`${agent} | ${inputLabel} | OK: ${inboxed.length} → inbox (${inboxed.join(', ')})`);

    } catch (e) {
      state.status  = 'failed';
      state.message = `Error: ${e.message}`;
      await appendDistillLog(`${agent} | ${inputLabel} | ERROR: ${e.message}`);
    }
  })();
});

// Poll run status
app.get('/api/distill/status/:runId', (req, res) => {
  const run = runStore.get(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(run);
});

// Serve the Vite production build; fall through to index.html for SPA
app.use(express.static(join(__dirname, 'dist')));
app.use((_req, res) =>
  res.sendFile(join(__dirname, 'dist', 'index.html'))
);

app.listen(PORT, '127.0.0.1', () =>
  console.log(`Brain app → http://localhost:${PORT}`)
);
