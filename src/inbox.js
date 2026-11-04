// Inbox review panel: list, approve, edit, discard inbox .md files.
import { saveFile } from './api.js';
import { CONFIRM_ABOVE_CALLS, callEstimate, callsForFiles, cancelRun, progressText } from './run-progress.js';

// ─── STATE ───────────────────────────────────────────────────────────────────
let panelEl    = null;
let listEl     = null;
let statusEl   = null;
let countBadge = null;
let inboxItems = [];
const groupEls    = new Map(); // batch id → { el, titleEl, batch }
const batchErrors = new Map(); // batch id → why Approve all stopped

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

async function pasteProposals(text) {
  const r = await fetch('/api/inbox/paste', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ text }),
  });
  return { status: r.status, data: await r.json() };
}

async function approveBatch(items) {
  const r = await fetch('/api/inbox/approve-batch', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ items: items.map(({ filename, inboxHash, targetHash }) => ({ filename, inboxHash, targetHash })) }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
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
  const pasteBtn = mkBtn('Paste proposals', '#9FD8FF', 'rgba(60,108,255,0.12)', 'rgba(60,108,255,0.35)');
  pasteBtn.addEventListener('click', renderPasteView);
  header.appendChild(titleEl);
  header.appendChild(pasteBtn);
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
  groupEls.clear();

  const batches = new Map();
  for (const item of inboxItems) {
    if (item.batch && !batches.has(item.batch.id)) batches.set(item.batch.id, item.batch);
  }
  const newestFirst = (a, b) => (b.at || '').localeCompare(a.at || '');
  for (const batch of [...batches.values()].sort(newestFirst)) listEl.appendChild(renderGroup(batch));
  inboxItems.filter(i => !i.batch).forEach(item => listEl.appendChild(renderCard(item, false)));
}

const batchItems = id => inboxItems.filter(i => i.batch?.id === id).sort((a, b) => a.batch.order - b.batch.order);

function batchTitle(batch, count) {
  const d = batch.at ? new Date(batch.at) : null;
  const day = d && d.toDateString() !== new Date().toDateString()
    ? d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' : '';
  const time = d ? d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }) : '';
  return `${batch.source}${d ? ` ${day}${time}` : ''}, ${count} suggestion${count !== 1 ? 's' : ''}`;
}

function renderGroup(batch) {
  const group = document.createElement('div');
  group.style.cssText = 'margin-bottom:18px;';

  const header = document.createElement('div');
  header.style.cssText = 'display:flex; align-items:center; gap:8px; margin-bottom:8px;';
  const titleEl = textDiv('flex:1; font-size:12px; font-weight:600; color:#c8d0e8;', '');
  const approveAll = mkBtn('Approve all', '#6FE3D0', 'rgba(111,227,208,0.12)', 'rgba(111,227,208,0.35)');
  const discardAll = mkBtn('Discard all', '#c08090', 'rgba(192,80,58,0.08)', 'rgba(192,80,58,0.3)');
  header.appendChild(titleEl);
  header.appendChild(approveAll);
  header.appendChild(discardAll);
  group.appendChild(header);

  const why = batchErrors.get(batch.id);
  if (why) group.appendChild(textDiv('font-size:12px; color:#e08040; margin-bottom:8px; line-height:1.5;', why));

  groupEls.set(batch.id, { el: group, titleEl, batch });
  syncGroupTitle(batch.id);
  for (const item of batchItems(batch.id)) group.appendChild(renderCard(item, false));

  approveAll.addEventListener('click', () => approveAllInBatch(batch, approveAll));
  discardAll.addEventListener('click', () => discardAllInBatch(batch, discardAll));
  return group;
}

function syncGroupTitle(id) {
  const g = groupEls.get(id);
  if (g) g.titleEl.textContent = batchTitle(g.batch, batchItems(id).length);
}

// After a card leaves the list: update its group's count, or the list if nothing is left.
function afterCardRemoved() {
  updateCount(inboxItems.length);
  if (inboxItems.length === 0) { renderList(); return; }
  for (const [id, g] of groupEls) {
    if (batchItems(id).length === 0) { g.el.remove(); groupEls.delete(id); batchErrors.delete(id); }
    else syncGroupTitle(id);
  }
}

async function reloadList() {
  inboxItems = await loadInbox();
  updateCount(inboxItems.length);
  renderList();
}

async function approveAllInBatch(batch, btn) {
  const items = batchItems(batch.id);
  btn.disabled = true;
  btn.textContent = '…';
  setStatus(`Approving ${items.length}…`, '#8090b0');
  try {
    const { approved, failed } = await approveBatch(items);
    batchErrors.delete(batch.id);
    if (failed) {
      const item = items.find(i => i.filename === failed.filename);
      const left = items.length - approved.length;
      batchErrors.set(batch.id, `Stopped at "${item?.title || failed.filename}": ${failed.error}. ` +
        `${approved.length} approved, ${left} left in the Inbox.`);
      setStatus(`Approved ${approved.length} of ${items.length}, then stopped.`, '#e08040');
    } else {
      setStatus(`Approved ${approved.length} suggestion${approved.length !== 1 ? 's' : ''}.`, '#6FE3D0');
    }
    await reloadList();
  } catch (e) {
    setStatus(`Approve all failed: ${e.message}`, '#c0503a');
    btn.disabled = false;
    btn.textContent = 'Approve all';
  }
}

async function discardAllInBatch(batch, btn) {
  const items = batchItems(batch.id);
  if (!confirm(`Discard all ${items.length} suggestions in "${batchTitle(batch, items.length)}"? This cannot be undone.`)) return;
  btn.disabled = true;
  btn.textContent = '…';
  let discarded = 0;
  try {
    for (const item of items) {
      const { status } = await discardInbox(item.filename);
      if (status !== 200) throw new Error(`could not discard "${item.title}"`);
      discarded++;
    }
    batchErrors.delete(batch.id);
    setStatus(`Discarded ${discarded} suggestion${discarded !== 1 ? 's' : ''}.`, '#8090b0');
  } catch (e) {
    setStatus(`Discarded ${discarded} of ${items.length}, then stopped: ${e.message}.`, '#c0503a');
  }
  await reloadList().catch(() => {});
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
  const fmBlock = (item.content.match(/^---\s*\n([\s\S]*?)\n---/) || [])[1] || '';
  const action  = (fmBlock.match(/^action:[ \t]*(.+)$/m) || [])[1]?.trim();
  const section = action === 'replace-section' ? (fmBlock.match(/^section:[ \t]*(.+)$/m) || [])[1]?.trim() : '';
  targetEl.textContent = item.target
    ? `→ ${item.target}${action ? ` · ${action}${section ? ` ${section}` : ''}` : ''}`
    : '(no target)';
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
        card.remove();
        afterCardRemoved();
        const done = { 'replace-line': 'line replaced in', 'replace-section': 'section replaced in',
          frontmatter: 'frontmatter updated in', create: 'created' }[data.action] || 'appended to';
        setStatus(`Approved — ${done} ${item.target}.`, '#6FE3D0');
      } else if (status === 409) {
        setStatus(data.message || 'Conflict — refreshing.', '#e08040');
        await openInboxPanel();
      } else if (status === 422) {
        setStatus(data.error, '#e08040'); // refused: e.g. OLD line not found exactly once
        approveBtn.disabled = false;
        approveBtn.textContent = 'Approve';
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
        card.remove();
        afterCardRemoved();
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

// ─── PASTE PROPOSALS ─────────────────────────────────────────────────────────
// Paste close-session output from any assistant; the server parses UPDATE PROTOCOL blocks (no AI).
function renderPasteView() {
  panelEl.style.transform = 'translateX(0)';
  setStatus('');
  listEl.innerHTML = '';

  listEl.appendChild(textDiv('font-size:12px; color:#8090b0; margin-bottom:8px; line-height:1.5;',
    'Paste close-session output. Each FILE / ACTION block becomes an Inbox suggestion (with or without ###, bold labels are fine); nothing is written until you approve it. Free text can be converted by an assistant.'));

  const textarea = document.createElement('textarea');
  textarea.placeholder = '### FILE: projects/…/state.md\n### ACTION: append\n- …';
  textarea.style.cssText = `
    width:100%; height:300px; resize:vertical; background:#0d1020;
    color:#c8d0e8; border:1px solid rgba(100,120,200,0.25); border-radius:4px;
    padding:10px; font-family:monospace; font-size:12px; line-height:1.5;
    outline:none; box-sizing:border-box; margin-bottom:8px;
  `;
  listEl.appendChild(textarea);

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'display:flex; gap:8px; margin-bottom:12px;';
  const addBtn    = mkBtn('Add to Inbox', '#9FD8FF', 'rgba(60,108,255,0.25)', 'rgba(60,108,255,0.5)');
  const cancelBtn = mkBtn('Cancel', '#8090b0', 'none', 'rgba(100,120,200,0.25)');
  btnRow.appendChild(addBtn);
  btnRow.appendChild(cancelBtn);
  listEl.appendChild(btnRow);

  const resultEl = document.createElement('div');
  listEl.appendChild(resultEl);
  cancelBtn.addEventListener('click', openInboxPanel);

  addBtn.addEventListener('click', async () => {
    if (!textarea.value.trim()) { setStatus('Nothing pasted.', '#e08040'); return; }
    addBtn.disabled = true;
    addBtn.textContent = 'Parsing…';
    try {
      const { status, data } = await pasteProposals(textarea.value);
      if (status !== 200) throw new Error(data.error || `HTTP ${status}`);
      renderPasteResult(resultEl, data);
      if (data.created.length) {
        inboxItems = await loadInbox();
        updateCount(inboxItems.length);
      }
      if (data.noBlocks) setStatus('');
      else setStatus(`${data.created.length} suggestion${data.created.length !== 1 ? 's' : ''} added` +
        (data.errors.length ? `, ${data.errors.length} block${data.errors.length !== 1 ? 's' : ''} not parsed.` : '.'),
        data.errors.length ? '#e08040' : '#6FE3D0');
    } catch (e) {
      setStatus(`Paste failed: ${e.message}`, '#c0503a');
    }
    addBtn.disabled = false;
    addBtn.textContent = 'Add to Inbox';
  });

  textarea.focus();
}

function renderPasteResult(el, { created, errors, remainder, noBlocks }) {
  el.innerHTML = '';
  if (errors.length) {
    el.appendChild(textDiv('font-size:12px; color:#e08040; margin-bottom:4px;', 'Not parsed (fix and paste again):'));
    const list = textDiv('font-size:12px; color:#c8d0e8; font-family:monospace; white-space:pre-wrap; margin-bottom:10px;',
      errors.map(e => `${e.line ? `line ${e.line}` : '—'}${e.file ? ` ${e.file}` : ''}: ${e.reason}`).join('\n'));
    el.appendChild(list);
  }
  if (created.length) {
    el.appendChild(textDiv('font-size:12px; color:#6FE3D0; margin-bottom:8px;',
      `Added ${created.length} suggestion${created.length !== 1 ? 's' : ''} to the Inbox.`));
    const view = mkBtn('Review in Inbox', '#6FE3D0', 'rgba(111,227,208,0.12)', 'rgba(111,227,208,0.35)');
    view.addEventListener('click', openInboxPanel);
    el.appendChild(view);
  }
  if (remainder) {
    const convertEl = document.createElement('div');
    convertEl.style.cssText = 'margin-top:14px;';
    el.appendChild(convertEl);
    renderConvertOffer(convertEl, remainder, noBlocks
      ? 'No proposal blocks found. Convert with an assistant?'
      : `${remainder.length.toLocaleString()} characters were outside any block. Convert them with an assistant?`);
  }
}

// ─── CONVERT FREE TEXT ───────────────────────────────────────────────────────
// A distill run on the pasted text; its suggestions arrive in the Inbox as one batch.
async function renderConvertOffer(el, text, question) {
  el.innerHTML = '';
  el.appendChild(textDiv('font-size:12px; color:#c8d0e8; margin-bottom:8px;', question));

  let agents = [], reasons = {};
  try {
    ({ agents = [], reasons = {} } = await (await fetch('/api/distill/agents')).json());
  } catch { /* shown below */ }
  if (agents.length === 0) {
    el.appendChild(textDiv('font-size:12px; color:#c08050;',
      `No assistant available. ${Object.entries(reasons).map(([k, v]) => `${k}: ${v}`).join(' | ')}`));
    return;
  }

  let agent = agents[0];
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; gap:12px; align-items:center;';
  for (const a of agents) {
    const lbl = document.createElement('label');
    lbl.style.cssText = 'display:flex; align-items:center; gap:5px; cursor:pointer; font-size:12px; color:#c8d0e8;';
    const inp = document.createElement('input');
    inp.type = 'radio'; inp.name = 'convert-agent'; inp.value = a; inp.checked = a === agent;
    inp.addEventListener('change', () => { if (inp.checked) agent = a; });
    lbl.appendChild(inp);
    lbl.appendChild(document.createTextNode(a.charAt(0).toUpperCase() + a.slice(1)));
    row.appendChild(lbl);
  }
  const go = mkBtn('Convert', '#9FD8FF', 'rgba(60,108,255,0.25)', 'rgba(60,108,255,0.5)');
  row.appendChild(go);
  el.appendChild(row);

  go.addEventListener('click', async () => {
    const calls = callsForFiles([{ name: 'pasted-text.txt', content: text }]);
    if (calls <= CONFIRM_ABOVE_CALLS) { startConvert(el, agent, text); return; }

    const { estimate, basis } = await callEstimate(calls);
    el.innerHTML = '';
    el.appendChild(textDiv('font-size:13px; color:#ffffff; margin-bottom:6px;', `This needs ${calls} calls. Estimated time: about ${estimate}.`));
    el.appendChild(textDiv('font-size:11px; color:#5a6890; margin-bottom:10px;', `Estimate ${basis}.`));
    const start = mkBtn('Start', '#9FD8FF', 'rgba(60,108,255,0.25)', 'rgba(60,108,255,0.5)');
    const back  = mkBtn('Back', '#8090b0', 'none', 'rgba(100,120,200,0.25)');
    start.style.marginRight = '8px';
    start.addEventListener('click', () => startConvert(el, agent, text));
    back.addEventListener('click', () => renderConvertOffer(el, text, question));
    el.appendChild(start);
    el.appendChild(back);
  });
}

async function startConvert(el, agent, text) {
  el.innerHTML = '';
  const line = textDiv('font-size:13px; color:#9FD8FF; margin-bottom:8px;', '⏳ Starting…');
  el.appendChild(line);

  let runId;
  try {
    const r = await fetch('/api/inbox/convert', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ agent, text }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    runId = d.runId;
  } catch (e) {
    line.textContent = `Convert failed: ${e.message}`;
    line.style.color = '#c0503a';
    return;
  }

  const cancel = mkBtn('Cancel', '#e0a050', 'rgba(224,160,80,0.1)', 'rgba(224,160,80,0.4)');
  cancel.addEventListener('click', async () => {
    cancel.disabled = true;
    cancel.textContent = 'Cancelling…';
    await cancelRun(runId);
  });
  el.appendChild(cancel);

  const finish = async (message, color, note) => {
    clearInterval(poll);
    cancel.remove();
    line.textContent = message;
    line.style.color = color;
    if (note) el.appendChild(textDiv('font-size:11px; color:#5a6890; margin-bottom:8px;', note));
    if (el.isConnected) {
      inboxItems = await loadInbox().catch(() => inboxItems);
      updateCount(inboxItems.length);
      const view = mkBtn('Review in Inbox', '#6FE3D0', 'rgba(111,227,208,0.12)', 'rgba(111,227,208,0.35)');
      view.addEventListener('click', openInboxPanel);
      el.appendChild(view);
    } else {
      await openInboxPanel(); // the list is showing, and it just changed
    }
    setStatus(message, color);
  };

  const poll = setInterval(async () => {
    try {
      const r = await fetch(`/api/distill/status/${runId}`);
      if (r.status === 404) { finish('The server restarted during the conversion.', '#e0a050', 'Open Import to resume it.'); return; }
      if (!r.ok) return;
      const state = await r.json();
      if (state.status === 'running' || state.status === 'pending') line.textContent = '⏳ ' + progressText(state);
      else if (state.status === 'done') finish(`✓ ${state.message}`, '#6FE3D0');
      else if (state.status === 'stopped') finish(state.message, '#e0a050', 'Open Import to resume the remaining chunks.');
      else finish(`✗ ${state.message}`, '#c0503a');
    } catch { /* transient */ }
  }, 1000);
}

function textDiv(css, text) {
  const d = document.createElement('div');
  d.style.cssText = css;
  d.textContent = text;
  return d;
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
