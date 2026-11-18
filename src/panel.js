// Right-side panel: shows item content, tabs per file, edit/save.
import { fetchFile, saveFile, fetchItems, moveProject } from './api.js';
import { setPanelOpen } from './labels.js';
import { packButton } from './pack.js';
import { createCodeSection, showCodeSection } from './codemap-panel.js';

// ─── STATE ───────────────────────────────────────────────────────────────────
let currentItem  = null;
let currentTab   = 0;   // index into currentItem.files
let fileCache    = {};  // path → { content, hash }
let editMode     = false;
let panelEl      = null;
let bodyEl       = null;
let tabsEl       = null;
let statusEl     = null;

// ─── MARKDOWN RENDERER ───────────────────────────────────────────────────────
function stripFrontmatter(md) {
  return md.replace(/^---[\s\S]*?---\s*\n?/, '');
}

function renderMarkdown(md) {
  const body = stripFrontmatter(md);
  const lines = body.split('\n');
  let html = '';
  // Stack of open list contexts: { type:'ul'|'ol', indent:number }
  const stack = [];

  function closeListsTo(maxIndent) {
    while (stack.length && stack[stack.length - 1].indent >= maxIndent) {
      html += stack[stack.length - 1].type === 'ul' ? '</ul>' : '</ol>';
      stack.pop();
    }
  }

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      closeListsTo(0);
      continue;
    }
    const indent = raw.search(/\S/);
    const isUL = /^[-*] /.test(trimmed);
    const isOL = /^\d+\. /.test(trimmed);

    if (/^### /.test(trimmed)) {
      closeListsTo(0);
      html += `<h3>${esc(trimmed.slice(4))}</h3>`;
    } else if (/^## /.test(trimmed)) {
      closeListsTo(0);
      html += `<h2>${esc(trimmed.slice(3))}</h2>`;
    } else if (/^# /.test(trimmed)) {
      closeListsTo(0);
      html += `<h1>${esc(trimmed.slice(2))}</h1>`;
    } else if (isUL || isOL) {
      const type = isUL ? 'ul' : 'ol';
      const text = isUL ? trimmed.replace(/^[-*] /, '') : trimmed.replace(/^\d+\. /, '');

      // Close any lists deeper than this indent level
      closeListsTo(indent + 1);

      const top = stack[stack.length - 1];
      if (!top || top.indent < indent) {
        // Open a new (possibly nested) list
        html += type === 'ul' ? '<ul>' : '<ol>';
        stack.push({ type, indent });
      } else if (top.type !== type) {
        // Same indent, different list type — switch
        html += top.type === 'ul' ? '</ul>' : '</ol>';
        stack.pop();
        html += type === 'ul' ? '<ul>' : '<ol>';
        stack.push({ type, indent });
      }
      html += `<li>${esc(text)}</li>`;
    } else {
      closeListsTo(0);
      html += `<p>${esc(trimmed)}</p>`;
    }
  }
  closeListsTo(0);
  return html;
}

function parseFrontmatter(md) {
  const m = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const obj = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) obj[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return obj;
}

function esc(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ─── BUILD ───────────────────────────────────────────────────────────────────
// Panel width: about half the window, never narrower than 380px (or the window) nor wider than 960px.
// The code map diagram and the list view read the same variable to stay clear of the panel.
const PANEL_WIDTH = 'clamp(min(380px, 100vw), 50vw, 960px)';

export function initPanel() {
  document.documentElement.style.setProperty('--panel-w', PANEL_WIDTH);
  panelEl = document.createElement('div');
  panelEl.id = 'brain-panel';
  // The whole panel scrolls (header, code section, tabs and body together), so no section is cut off.
  panelEl.style.cssText = `
    position:fixed; top:44px; right:0; height:calc(100% - 44px); width:var(--panel-w);
    background:#05070F; color:#e8eaf0; /* opaque: the wider panel covers part of the brain and its labels */
    font-family:system-ui,-apple-system,sans-serif; font-size:14px;
    border-left:1px solid rgba(100,120,200,0.18);
    transform:translateX(100%); transition:transform 0.22s ease;
    display:flex; flex-direction:column; z-index:30; overflow-x:hidden; overflow-y:auto;
    scrollbar-width:thin; scrollbar-color:#2a3050 transparent;
  `;
  panelEl.addEventListener('wheel', chainWheel, { passive: false });

  // Header
  const header = document.createElement('div');
  header.style.cssText = 'padding:16px 16px 0; flex-shrink:0;';

  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = `
    float:right; background:none; border:none; color:#8090b0; font-size:16px;
    cursor:pointer; padding:2px 6px; line-height:1;
  `;
  closeBtn.addEventListener('click', closePanel);
  header.appendChild(closeBtn);

  const pathEl = document.createElement('div');
  pathEl.id = 'panel-path';
  pathEl.style.cssText = 'font-size:11px; color:#5a6890; letter-spacing:0.04em; margin-bottom:6px;';
  header.appendChild(pathEl);

  const titleEl = document.createElement('div');
  titleEl.id = 'panel-title';
  titleEl.style.cssText = 'font-size:18px; font-weight:700; color:#ffffff; line-height:1.3;';
  header.appendChild(titleEl);

  const metaEl = document.createElement('div');
  metaEl.id = 'panel-meta';
  metaEl.style.cssText = 'font-size:11px; color:#5a6890; margin-top:4px; margin-bottom:12px;';
  header.appendChild(metaEl);

  // Copy pack (projects and archive only)
  const packRow = document.createElement('div');
  packRow.id = 'pack-row';
  packRow.style.cssText = 'display:none; flex-direction:column; align-items:flex-start; gap:4px; margin:-4px 0 12px;';
  const projectPack = (label, hint, mode) => packRow.appendChild(packButton({
    label, hint, onResult: packResult,
    body: () => ({ mode, project: (currentItem?.path || '').split('/').pop() }),
  }));
  projectPack('Copy full pack', 'new chat about this project', 'full');
  projectPack('Copy project only', 'chat that already has my rules', 'project-only');
  projectPack('Copy directions', 'assistant that can read my files', 'directions');
  header.appendChild(packRow);

  // Archive / Unarchive (projects and archive only): a move of the folder, so no confirmation; the page says where
  // the folder went.
  const archiveRow = document.createElement('div');
  archiveRow.id = 'archive-row';
  archiveRow.style.cssText = 'display:none; align-items:center; flex-wrap:wrap; gap:8px; margin:-4px 0 12px; font-size:12px; color:#8090b0;';
  header.appendChild(archiveRow);

  // Code folder link and Map project (projects and archive only)
  header.appendChild(createCodeSection());

  panelEl.appendChild(header);

  // Tabs
  tabsEl = document.createElement('div');
  tabsEl.style.cssText = `
    display:flex; padding:0 16px; gap:4px; flex-shrink:0;
    border-bottom:1px solid rgba(100,120,200,0.15);
  `;
  panelEl.appendChild(tabsEl);

  // Body
  bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'flex:1 0 auto; padding:16px 16px 32px;';
  panelEl.appendChild(bodyEl);

  // Status bar
  statusEl = document.createElement('div');
  statusEl.style.cssText = `
    padding:8px 16px; font-size:12px; min-height:32px; flex-shrink:0;
    border-top:1px solid rgba(100,120,200,0.12);
    position:sticky; bottom:0; background:rgba(5,7,15,0.98);
  `;
  panelEl.appendChild(statusEl);

  document.body.appendChild(panelEl);
}

// A box inside the panel with its own scroll (a code preview) hands the wheel on to the panel once it
// reaches its end, instead of swallowing it.
function chainWheel(e) {
  if (e.ctrlKey || !e.deltaY) return;
  const down = e.deltaY > 0;
  for (let n = e.target; n && n !== panelEl; n = n.parentElement) {
    if (n.scrollHeight <= n.clientHeight + 1 || !/(auto|scroll)/.test(getComputedStyle(n).overflowY)) continue;
    const canScroll = down ? n.scrollTop + n.clientHeight < n.scrollHeight - 1 : n.scrollTop > 0;
    if (canScroll) return; // the inner box still has room: let it scroll
    // At its end: move the panel instead.
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? panelEl.clientHeight : 1;
    panelEl.scrollTop += e.deltaY * unit;
    return;
  }
}

// ─── OPEN / CLOSE ────────────────────────────────────────────────────────────
const TAB_ORDER = ['state', 'decisions', 'context'];
function sortedFiles(item) {
  if (!item.files) return [item.path];
  return [...item.files].sort((a, b) => {
    const ai = TAB_ORDER.indexOf(a.split('/').pop().replace('.md', ''));
    const bi = TAB_ORDER.indexOf(b.split('/').pop().replace('.md', ''));
    return (ai < 0 ? TAB_ORDER.length : ai) - (bi < 0 ? TAB_ORDER.length : bi);
  });
}

export async function openPanel(item) {
  currentItem = { ...item, files: sortedFiles(item) };
  currentTab  = 0;
  editMode    = false;
  fileCache   = {};
  setStatus('');

  // Populate header
  document.getElementById('panel-path').textContent = item.folder || item.category;
  document.getElementById('panel-title').textContent = item.name;
  const isProject = item.type === 'folder' && (item.category === 'projects' || item.category === 'archive');
  document.getElementById('pack-row').style.display = isProject ? 'flex' : 'none';
  renderArchiveRow(isProject ? item : null);
  showCodeSection(isProject ? { slug: item.path.split('/').pop(), name: item.name } : null);

  buildTabs();
  panelEl.scrollTop = 0; // a newly opened item starts at its header
  panelEl.style.transform = 'translateX(0)';
  setPanelOpen(true);
  window.dispatchEvent(new CustomEvent('brain-panel', { detail: { open: true } }));

  await loadTab(0);
}

function closePanel() {
  panelEl.style.transform = 'translateX(100%)';
  setPanelOpen(false);
  window.dispatchEvent(new CustomEvent('brain-panel', { detail: { open: false } }));
  currentItem = null;
}

// ─── TABS ────────────────────────────────────────────────────────────────────
function buildTabs() {
  tabsEl.innerHTML = '';
  const files = currentItem.files || [currentItem.path];
  files.forEach((path, i) => {
    const name = path.split('/').pop().replace('.md', '');
    const btn = document.createElement('button');
    btn.textContent = name;
    btn.dataset.idx = i;
    btn.style.cssText = `
      background:none; border:none; border-bottom:2px solid transparent;
      color:#8090b0; font-size:12px; padding:8px 10px; cursor:pointer;
      transition:color 0.15s,border-color 0.15s; font-family:inherit;
    `;
    btn.addEventListener('click', () => {
      currentTab = i;
      editMode = false;
      setStatus('');
      loadTab(i);
      updateTabActive();
    });
    tabsEl.appendChild(btn);
  });
  updateTabActive();
}

function updateTabActive() {
  Array.from(tabsEl.children).forEach((btn, i) => {
    const active = i === currentTab;
    btn.style.color       = active ? '#9FD8FF' : '#8090b0';
    btn.style.borderColor = active ? '#9FD8FF' : 'transparent';
  });
}

// ─── LOAD TAB ────────────────────────────────────────────────────────────────
async function loadTab(idx) {
  const files = currentItem.files || [currentItem.path];
  const path  = files[idx];
  bodyEl.innerHTML = '<div style="color:#5a6890;padding:20px 0">Loading…</div>';

  try {
    if (!fileCache[path]) {
      const data = await fetchFile(path);
      fileCache[path] = { content: data.content, hash: data.hash };
    }
    const { content } = fileCache[path];
    const fm = parseFrontmatter(content);

    document.getElementById('panel-meta').textContent =
      fm.updated ? `Updated ${String(fm.updated).replace(/['"]/g, '')}` : '';

    renderReadView(content, path);
  } catch (e) {
    bodyEl.innerHTML = `<div style="color:#c0503a">Error: ${esc(e.message)}</div>`;
  }
}

// ─── READ VIEW ───────────────────────────────────────────────────────────────
function renderReadView(content, path) {
  const html = renderMarkdown(content);
  bodyEl.innerHTML = `
    <div class="md-body" style="
      line-height:1.65; color:#c8d0e8;
    ">${html}</div>
    <button id="edit-btn" style="
      margin-top:16px; padding:6px 14px; background:rgba(60,108,255,0.18);
      border:1px solid rgba(60,108,255,0.4); color:#9FD8FF; border-radius:4px;
      font-size:13px; cursor:pointer; font-family:inherit;
    ">Edit file</button>
  `;

  // Inject minimal markdown styles
  if (!document.getElementById('md-style')) {
    const s = document.createElement('style');
    s.id = 'md-style';
    s.textContent = `
      .md-body h1 { font-size:16px; font-weight:700; margin:14px 0 6px; color:#ffffff; }
      .md-body h2 { font-size:14px; font-weight:700; margin:12px 0 5px; color:#e0e8ff; }
      .md-body h3 { font-size:13px; font-weight:600; margin:10px 0 4px; color:#c0d0f0; }
      .md-body p  { margin:3px 0; }
      .md-body ul, .md-body ol { margin:4px 0 4px 18px; }
      .md-body li { margin:2px 0; }
      .md-body li > ul, .md-body li > ol,
      .md-body ul > ul, .md-body ul > ol,
      .md-body ol > ul, .md-body ol > ol { margin-top:2px; margin-bottom:2px; }
    `;
    document.head.appendChild(s);
  }

  document.getElementById('edit-btn').addEventListener('click', () => {
    editMode = true;
    renderEditView(content, path);
  });
}

// ─── EDIT VIEW ────────────────────────────────────────────────────────────────
function renderEditView(content, path) {
  bodyEl.innerHTML = `
    <textarea id="edit-area" style="
      width:100%; height:calc(100vh - 260px); resize:none; background:#0d1020;
      color:#c8d0e8; border:1px solid rgba(100,120,200,0.25); border-radius:4px;
      padding:10px; font-family:monospace; font-size:13px; line-height:1.5;
      outline:none; box-sizing:border-box;
    ">${esc(content)}</textarea>
    <div style="margin-top:10px; display:flex; gap:8px;">
      <button id="save-btn" style="
        padding:6px 16px; background:rgba(60,108,255,0.25);
        border:1px solid rgba(60,108,255,0.5); color:#9FD8FF;
        border-radius:4px; font-size:13px; cursor:pointer; font-family:inherit;
      ">Save</button>
      <button id="cancel-btn" style="
        padding:6px 14px; background:none; border:1px solid rgba(100,120,200,0.25);
        color:#8090b0; border-radius:4px; font-size:13px; cursor:pointer; font-family:inherit;
      ">Cancel</button>
    </div>
  `;

  document.getElementById('save-btn').addEventListener('click', () => doSave(path));
  document.getElementById('cancel-btn').addEventListener('click', () => {
    editMode = false;
    setStatus('');
    renderReadView(fileCache[path].content, path);
  });
}

// ─── SAVE ────────────────────────────────────────────────────────────────────
async function doSave(path) {
  const textarea = document.getElementById('edit-area');
  if (!textarea) return;
  const newContent = textarea.value;
  const hash = fileCache[path]?.hash;

  document.getElementById('save-btn').disabled = true;
  setStatus('Saving…', '#8090b0');

  try {
    const { status, data } = await saveFile(path, newContent, hash);

    if (status === 200) {
      fileCache[path] = { content: newContent, hash: data.hash };
      editMode = false;
      setStatus('Saved. Auto-commit within 15 minutes.', '#6FE3D0');
      renderReadView(newContent, path);

    } else if (status === 409) {
      // Conflict: disk changed since open
      fileCache[path] = { content: data.content, hash: data.hash };
      textarea.value = data.content;
      setStatus('File changed on disk since you opened it. Editor refreshed.', '#e08040');
      document.getElementById('save-btn').disabled = false;

    } else {
      setStatus(`Error ${status}: ${data.error || 'unknown'}`, '#c0503a');
      document.getElementById('save-btn').disabled = false;
    }
  } catch (e) {
    setStatus(`Network error: ${e.message}`, '#c0503a');
    const btn = document.getElementById('save-btn');
    if (btn) btn.disabled = false;
  }
}

// ─── ARCHIVE ─────────────────────────────────────────────────────────────────
const ARCHIVE_BTN = `padding:4px 10px; background:rgba(255,255,255,0.04); border:1px solid rgba(100,120,200,0.25); color:#9FD8FF;
  border-radius:4px; font-size:12px; cursor:pointer; font-family:inherit; white-space:nowrap;`;
function renderArchiveRow(item) {
  const row = document.getElementById('archive-row');
  row.innerHTML = '';
  if (!item) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  const name = item.path.split('/').pop();
  const archived = item.category === 'archive';
  if (archived) {
    const where = document.createElement('span');
    where.textContent = `Archived: its folder is archive/${name}/ in the brain.`;
    row.appendChild(where);
  }
  const btn = document.createElement('button');
  btn.textContent = archived ? 'Unarchive project' : 'Archive project';
  btn.title = archived ? `Moves the folder back to projects/${name}/` : `Moves the folder to archive/${name}/; Unarchive brings it back`;
  btn.style.cssText = ARCHIVE_BTN;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Moving…';
    try {
      const r = await moveProject(archived ? 'unarchive' : 'archive', name);
      const moved = (await fetchItems()).find(i => i.id === r.to);
      if (moved && currentItem?.path === item.path) await openPanel(moved);
      const bm = r.basicMemory?.state === 'reindexing' ? ' Basic Memory is re-indexing the brain.'
        : r.basicMemory?.state === 'manual' ? ` Basic Memory has not seen the move yet: run ${r.basicMemory.command}` : '';
      setStatus((archived
        ? `Unarchived: the folder is back at ${r.location}`
        : `Archived: the folder moved to ${r.location} (Unarchive on this page or in the list's Archived section brings it back).`) + bm, '#6FE3D0');
    } catch (e) {
      btn.disabled = false;
      btn.textContent = archived ? 'Unarchive project' : 'Archive project';
      setStatus(e.message, '#c0503a');
    }
  });
  row.appendChild(btn);
}

// ─── COPY PACK ───────────────────────────────────────────────────────────────
function packResult(error, data) {
  if (error) setStatus(`Pack failed: ${error}`, '#c0503a');
  else setStatus(`Pack copied: ${data.chars.toLocaleString()} characters (saved as ${data.file}).`, '#6FE3D0');
}

function setStatus(msg, color = '#8090b0') {
  statusEl.textContent = msg;
  statusEl.style.color = color;
}
