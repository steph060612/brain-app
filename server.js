// Local API server — reads and writes ~/Brain .md files.
// Listens only on localhost:3001. Never touches anything outside ~/Brain.
import express from 'express';
import { readdir, readFile, writeFile, stat, access, unlink, mkdir } from 'fs/promises';
import { resolve, join, sep, extname, basename, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { exec } from 'child_process';
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

// Serve the Vite production build; fall through to index.html for SPA
app.use(express.static(join(__dirname, 'dist')));
app.use((_req, res) =>
  res.sendFile(join(__dirname, 'dist', 'index.html'))
);

app.listen(PORT, '127.0.0.1', () =>
  console.log(`Brain app → http://localhost:${PORT}`)
);
