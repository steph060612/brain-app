// Inbox review panel: list, approve, edit, discard inbox .md files.
import { saveFile } from './api.js';

// ─── STATE ───────────────────────────────────────────────────────────────────
let panelEl    = null;
let listEl     = null;
let statusEl   = null;
let countBadge = null;
let inboxItems = [];

// ─── API ─────────────────────────────────────────────────────────────────────
async function loadInbox() {
  const r = await fetch('/api/inbox');
  if (!r.ok) throw new Error(`inbox fetch failed: ${r.status}`);
  return r.json();
}

async function approveInbox(filename, inboxHash, targetHash) {
  const r = await fetch('/api/inbox/approve', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ filename, inboxHash, targetHash }),
  });
  return { status: r.status, data: await r.json() };
}

async function discardInbox(filename) {
  const r = await fetch(`/api/inbox/${encodeURIComponent(filename)}`, { method: 'DELETE' });
  return { status: r.status, data: await r.json() };
}

// ─── MARKDOWN (shared subset from panel.js) ──────────────────────────────────
function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMarkdown(md) {
  const body = md.replace(/^---[\s\S]*?---\s*\n?/, '');
  const lines = body.split('\n');
  let html = '';
  const stack = [];

  function closeTo(max) {
    while (stack.length && stack[stack.length - 1].indent >= max) {
      html += stack[stack.length - 1].type === 'ul' ? '</ul>' : '</ol>';
      stack.pop();
    }
  }

  for (const raw of lines) {
    const t = raw.trim();
    if (!t) { closeTo(0); continue; }
    const indent = raw.search(/\S/);
    const isUL = /^[-*] /.test(t);
    const isOL = /^\d+\. /.test(t);

    if      (/^### /.test(t)) { closeTo(0); html += `<h3>${esc(t.slice(4))}</h3>`; }
    else if (/^## /.test(t))  { closeTo(0); html += `<h2>${esc(t.slice(3))}</h2>`; }
    else if (/^# /.test(t))   { closeTo(0); html += `<h1>${esc(t.slice(2))}</h1>`; }
    else if (isUL || isOL) {
      const type = isUL ? 'ul' : 'ol';
      const text = isUL ? t.replace(/^[-*] /, '') : t.replace(/^\d+\. /, '');
      closeTo(indent + 1);
      const top = stack[stack.length - 1];
      if (!top || top.indent < indent)    { html += `<${type}>`; stack.push({ type, indent }); }
      else if (top.type !== type) { html += `</${top.type}>`; stack.pop(); html += `<${type}>`; stack.push({ type, indent }); }
      html += `<li>${esc(text)}</li>`;
    } else {
      closeTo(0);
      html += `<p>${esc(t)}</p>`;
    }
  }
  closeTo(0);
  return html;
}

// ─── BUILD ───────────────────────────────────────────────────────────────────
export function initInbox() {
  // Panel
  panelEl = document.createElement('div');
  panelEl.id = 'inbox-panel';
  panelEl.style.cssText = `
    position:fixed; top:44px; left:0; height:calc(100% - 44px); width:460px;
    background:rgba(5,7,15,0.96); color:#e8eaf0;
    font-family:system-ui,-apple-system,sans-serif; font-size:14px;
    border-right:1px solid rgba(100,120,200,0.18);
    transform:translateX(-100%); transition:transform 0.22s ease;
    display:flex; flex-direction:column; z-index:30; overflow:hidden;
  `;

  const header = document.createElement('div');
  header.style.cssText = `
    padding:14px 16px 12px; flex-shrink:0; display:flex; align-items:center;
    gap:10px; border-bottom:1px solid rgba(100,120,200,0.15);
  `;
  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-size:15px; font-weight:700; color:#ffffff; flex:1;';
  titleEl.textContent = 'Inbox';
  const closeBtn = document.createElement('button');
  closeBtn.textContent = '✕';
  closeBtn.style.cssText = 'background:none; border:none; color:#8090b0; font-size:16px; cursor:pointer; padding:2px 6px;';
  closeBtn.addEventListener('click', closeInboxPanel);
  header.appendChild(titleEl);
  header.appendChild(closeBtn);
  panelEl.appendChild(header);

  listEl = document.createElement('div');
  listEl.style.cssText = `
    flex:1; overflow-y:auto; padding:12px 16px;
    scrollbar-width:thin; scrollbar-color:#2a3050 transparent;
  `;
  panelEl.appendChild(listEl);

  statusEl = document.createElement('div');
  statusEl.style.cssText = `
    padding:8px 16px; font-size:12px; min-height:32px; flex-shrink:0;
    border-top:1px solid rgba(100,120,200,0.12);
  `;
  panelEl.appendChild(statusEl);
  document.body.appendChild(panelEl);

  // Inbox button in topbar
  const btn = document.createElement('button');
  btn.id = 'inbox-btn';
  btn.style.cssText = `
    background:rgba(255,255,255,0.06); border:1px solid rgba(100,120,200,0.22);
    border-radius:6px; color:#c8d0e8; font-size:13px; padding:5px 12px;
    cursor:pointer; font-family:inherit; display:flex; align-items:center; gap:6px;
    transition:border-color 0.15s;
  `;
  btn.addEventListener('mouseover',  () => { btn.style.borderColor = 'rgba(100,120,200,0.5)'; });
  btn.addEventListener('mouseout',   () => { btn.style.borderColor = 'rgba(100,120,200,0.22)'; });
  const label = document.createElement('span');
  label.textContent = 'Inbox';
  countBadge = document.createElement('span');
  countBadge.style.cssText = `
    background:rgba(159,216,255,0.2); color:#9FD8FF;
    border-radius:10px; font-size:11px; padding:1px 6px; display:none;
  `;
  btn.appendChild(label);
  btn.appendChild(countBadge);
  btn.addEventListener('click', openInboxPanel);

  const gitTime = document.getElementById('git-time');
  if (gitTime) {
    gitTime.parentNode.insertBefore(btn, gitTime);
  }

  // Load initial count without opening panel
  loadInbox().then(items => {
    inboxItems = items;
    updateCount(items.length);
  }).catch(() => {});
}

function updateCount(n) {
  if (!countBadge) return;
  countBadge.textContent = n;
  countBadge.style.display = n > 0 ? '' : 'none';
}

// ─── OPEN / CLOSE ────────────────────────────────────────────────────────────
export async function openInboxPanel() {
  panelEl.style.transform = 'translateX(0)';
  listEl.innerHTML = '<div style="color:#5a6890;padding:20px 0">Loading…</div>';
  setStatus('');

  try {
    inboxItems = await loadInbox();
    updateCount(inboxItems.length);
    renderList();
  } catch (e) {
    listEl.innerHTML = `<div style="color:#c0503a">Error: ${esc(e.message)}</div>`;
  }
}

export function closeInboxPanel() {
  panelEl.style.transform = 'translateX(-100%)';
}

// ─── LIST ────────────────────────────────────────────────────────────────────
function renderList() {
  if (inboxItems.length === 0) {
    listEl.innerHTML = '<div style="color:#5a6890; padding:30px 0; text-align:center;">Inbox is empty.</div>';
    return;
  }
  listEl.innerHTML = '';
  inboxItems.forEach(item => listEl.appendChild(renderCard(item, false)));
}

function renderCard(item, editMode) {
  const card = document.createElement('div');
  card.style.cssText = `
    background:rgba(255,255,255,0.03); border:1px solid rgba(100,120,200,0.15);
    border-radius:8px; padding:14px; margin-bottom:12px;
  `;

  const titleEl = document.createElement('div');
  titleEl.style.cssText = 'font-size:14px; font-weight:600; color:#ffffff; margin-bottom:4px;';
  titleEl.textContent = item.title;
  card.appendChild(titleEl);

  const targetEl = document.createElement('div');
  targetEl.style.cssText = 'font-size:11px; color:#5a6890; margin-bottom:10px; font-family:monospace;';
  targetEl.textContent = item.target ? `→ ${item.target}` : '(no target)';
  card.appendChild(targetEl);

  if (item.target === 'preferences.md') {
    const warnEl = document.createElement('div');
    warnEl.style.cssText = `
      font-size:11px; color:#e0a050; background:rgba(224,160,80,0.1);
      border:1px solid rgba(224,160,80,0.35); border-radius:5px;
      padding:4px 8px; margin:-4px 0 10px; display:inline-block;
    `;
    warnEl.textContent = 'Changes how assistants behave: review carefully.';
    card.appendChild(warnEl);
  }

  if (editMode) {
    buildEditArea(card, item);
  } else {
    buildReadArea(card, item);
  }

  return card;
}

function buildReadArea(card, item) {
  // Ensure md-style injected (panel.js may also inject it — idempotent via id)
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
    `;
    document.head.appendChild(s);
  }

  const contentEl = document.createElement('div');
  contentEl.className = 'md-body';
  contentEl.style.cssText = 'color:#c8d0e8; line-height:1.65; margin-bottom:12px; font-size:13px;';
  contentEl.innerHTML = renderMarkdown(item.content);
  card.appendChild(contentEl);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:8px;';

  const approveBtn = mkBtn('Approve', '#6FE3D0', 'rgba(111,227,208,0.12)', 'rgba(111,227,208,0.35)');
  const editBtn    = mkBtn('Edit',    '#9FD8FF', 'rgba(60,108,255,0.12)',  'rgba(60,108,255,0.35)');
  const discardBtn = mkBtn('Discard', '#c08090', 'rgba(192,80,58,0.08)',   'rgba(192,80,58,0.3)');

  if (!item.target) {
    approveBtn.disabled = true;
    approveBtn.style.opacity = '0.35';
    approveBtn.style.cursor = 'not-allowed';
  }

  approveBtn.addEventListener('click', async () => {
    approveBtn.disabled = true;
    approveBtn.textContent = '…';
    setStatus('Approving…', '#8090b0');
    try {
      const { status, data } = await approveInbox(item.filename, item.inboxHash, item.targetHash);
      if (status === 200) {
        inboxItems = inboxItems.filter(x => x.filename !== item.filename);
        updateCount(inboxItems.length);
        card.remove();
        if (inboxItems.length === 0) renderList();
        setStatus('Approved — appended to target.', '#6FE3D0');
      } else if (status === 409) {
        setStatus(data.message || 'Conflict — refreshing.', '#e08040');
        await openInboxPanel();
      } else {
        setStatus(`Error: ${data.error || 'unknown'}`, '#c0503a');
        approveBtn.disabled = false;
        approveBtn.textContent = 'Approve';
      }
    } catch (e) {
      setStatus(`Network error: ${e.message}`, '#c0503a');
      approveBtn.disabled = false;
      approveBtn.textContent = 'Approve';
    }
  });

  editBtn.addEventListener('click', () => {
    const newCard = renderCard(item, true);
    card.replaceWith(newCard);
  });

  discardBtn.addEventListener('click', async () => {
    if (!confirm(`Discard "${item.title}"? This cannot be undone.`)) return;
    discardBtn.disabled = true;
    discardBtn.textContent = '…';
    try {
      const { status } = await discardInbox(item.filename);
      if (status === 200) {
        inboxItems = inboxItems.filter(x => x.filename !== item.filename);
        updateCount(inboxItems.length);
        card.remove();
        if (inboxItems.length === 0) renderList();
        setStatus('Discarded.', '#8090b0');
      } else {
        setStatus('Discard failed.', '#c0503a');
        discardBtn.disabled = false;
        discardBtn.textContent = 'Discard';
      }
    } catch (e) {
      setStatus(`Network error: ${e.message}`, '#c0503a');
      discardBtn.disabled = false;
      discardBtn.textContent = 'Discard';
    }
  });

  btnRow.appendChild(approveBtn);
  btnRow.appendChild(editBtn);
  btnRow.appendChild(discardBtn);
  card.appendChild(btnRow);
}

function buildEditArea(card, item) {
  const textarea = document.createElement('textarea');
  textarea.value = item.content;
  textarea.style.cssText = `
    width:100%; height:180px; resize:vertical; background:#0d1020;
    color:#c8d0e8; border:1px solid rgba(100,120,200,0.25); border-radius:4px;
    padding:10px; font-family:monospace; font-size:12px; line-height:1.5;
    outline:none; box-sizing:border-box; margin-bottom:8px;
  `;
  card.appendChild(textarea);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:8px;';

  const saveBtn   = mkBtn('Save',   '#9FD8FF', 'rgba(60,108,255,0.25)',  'rgba(60,108,255,0.5)');
  const cancelBtn = mkBtn('Cancel', '#8090b0', 'none',                   'rgba(100,120,200,0.25)');

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    try {
      const { status, data } = await saveFile(`inbox/${item.filename}`, textarea.value, item.inboxHash);
      if (status === 200) {
        const idx = inboxItems.findIndex(x => x.filename === item.filename);
        if (idx >= 0) {
          inboxItems[idx] = { ...inboxItems[idx], content: textarea.value, inboxHash: data.hash };
          const newCard = renderCard(inboxItems[idx], false);
          card.replaceWith(newCard);
        }
        setStatus('Saved.', '#6FE3D0');
      } else if (status === 409) {
        const idx = inboxItems.findIndex(x => x.filename === item.filename);
        if (idx >= 0) {
          inboxItems[idx] = { ...inboxItems[idx], content: data.content, inboxHash: data.hash };
          const newCard = renderCard(inboxItems[idx], true);
          card.replaceWith(newCard);
        }
        setStatus('File changed on disk — editor refreshed.', '#e08040');
      } else {
        setStatus(`Error ${status}: ${data.error || 'unknown'}`, '#c0503a');
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
    } catch (e) {
      setStatus(`Network error: ${e.message}`, '#c0503a');
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    }
  });

  cancelBtn.addEventListener('click', () => {
    const newCard = renderCard(item, false);
    card.replaceWith(newCard);
    setStatus('');
  });

  btnRow.appendChild(saveBtn);
  btnRow.appendChild(cancelBtn);
  card.appendChild(btnRow);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function mkBtn(text, color, bg, border) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.style.cssText = `
    padding:5px 12px; background:${bg}; border:1px solid ${border};
    color:${color}; border-radius:4px; font-size:12px; cursor:pointer;
    font-family:inherit; transition:opacity 0.15s;
  `;
  return btn;
}

function setStatus(msg, color = '#8090b0') {
  if (statusEl) { statusEl.textContent = msg; statusEl.style.color = color; }
}
