// Import panel: parse Claude export, select conversations/memories, send to distiller.

// ─── STATE ────────────────────────────────────────────────────────────────────
let backdropEl = null;
let cardEl     = null;
let agentList  = [];
let disabledReasons = {};
let convIndex  = [];   // [{uuid, title, created, updated, messageCount, charCount, distillCalls}]
let parseStatus = { status: 'idle' };
let pollTimer   = null;
let parsePoll   = null;
let runTimeout  = null;

const MAX_RUN_MS = 10 * 60 * 1000;

// ─── INIT ─────────────────────────────────────────────────────────────────────
export async function initImport() {
  createBackdrop();

  const btn = document.createElement('button');
  btn.id = 'import-btn';
  btn.textContent = 'Import';
  btn.style.cssText = `
    background:rgba(255,255,255,0.06); border:1px solid rgba(100,120,200,0.22);
    border-radius:6px; color:#c8d0e8; font-size:13px; padding:5px 12px;
    cursor:pointer; font-family:inherit; transition:border-color 0.15s;
  `;
  btn.addEventListener('mouseover', () => btn.style.borderColor = 'rgba(100,120,200,0.5)');
  btn.addEventListener('mouseout',  () => btn.style.borderColor = 'rgba(100,120,200,0.22)');
  btn.addEventListener('click', openModal);

  const gitTime = document.getElementById('git-time');
  if (gitTime) gitTime.parentNode.insertBefore(btn, gitTime);

  try {
    const [agentRes, statusRes] = await Promise.all([
      fetch('/api/distill/agents'),
      fetch('/api/import/status'),
    ]);
    const agentData  = await agentRes.json();
    agentList        = agentData.agents || [];
    disabledReasons  = agentData.reasons || {};
    parseStatus      = await statusRes.json();
  } catch { /* non-fatal */ }
}

function createBackdrop() {
  backdropEl = document.createElement('div');
  backdropEl.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:50;
    display:none; align-items:flex-start; justify-content:center; padding-top:40px;
  `;
  backdropEl.addEventListener('click', e => { if (e.target === backdropEl) closeModal(); });

  cardEl = document.createElement('div');
  cardEl.style.cssText = `
    background:#0c0f1e; border:1px solid rgba(100,120,200,0.28); border-radius:10px;
    width:640px; max-width:96vw; max-height:82vh; display:flex; flex-direction:column;
    font-family:system-ui,-apple-system,sans-serif; color:#e8eaf0;
    box-shadow:0 8px 40px rgba(0,0,0,0.6);
  `;

  backdropEl.appendChild(cardEl);
  document.body.appendChild(backdropEl);
}

// ─── OPEN / CLOSE ─────────────────────────────────────────────────────────────
async function openModal() {
  stopPolls();
  backdropEl.style.display = 'flex';
  await refreshParseStatus();
  renderMain();
}

function closeModal() {
  stopPolls();
  backdropEl.style.display = 'none';
}

function stopPolls() {
  if (pollTimer)  { clearInterval(pollTimer);  pollTimer  = null; }
  if (parsePoll)  { clearInterval(parsePoll);  parsePoll  = null; }
  if (runTimeout) { clearTimeout(runTimeout);  runTimeout = null; }
}

async function refreshParseStatus() {
  try {
    const r = await fetch('/api/import/status');
    parseStatus = await r.json();
  } catch { /* keep stale */ }
}

// ─── MAIN RENDER ──────────────────────────────────────────────────────────────
function renderMain() {
  cardEl.innerHTML = '';

  // ── Header ──
  const hdr = div('display:flex; justify-content:space-between; align-items:center; padding:18px 20px 14px; border-bottom:1px solid rgba(100,120,200,0.15); flex-shrink:0;');
  hdr.appendChild(el('div', 'font-size:16px; font-weight:700; color:#fff;', 'Import'));
  const closeBtn = el('button', 'background:none; border:none; color:#8090b0; font-size:18px; cursor:pointer; padding:0 4px;', '✕');
  closeBtn.addEventListener('click', closeModal);
  hdr.appendChild(closeBtn);
  cardEl.appendChild(hdr);

  // ── Scrollable body ──
  const body = div('flex:1; overflow-y:auto; padding:16px 20px; scrollbar-width:thin; scrollbar-color:#2a3050 transparent;');
  cardEl.appendChild(body);

  // ── Parse section ──
  renderParseSection(body);

  // ── Separator ──
  if (parseStatus.status === 'done') {
    body.appendChild(div('height:1px; background:rgba(100,120,200,0.12); margin:16px 0;'));
    renderConversationsSection(body);
    body.appendChild(div('height:1px; background:rgba(100,120,200,0.12); margin:16px 0;'));
    renderMemoriesSection(body);
  }
}

// ── Parse section ────────────────────────────────────────────────────────────

function renderParseSection(parent) {
  const wrap = div('margin-bottom:14px;');

  const titleRow = div('display:flex; align-items:center; gap:10px; margin-bottom:8px;');
  titleRow.appendChild(el('div', 'font-size:12px; color:#5a6890; letter-spacing:0.05em; text-transform:uppercase;', 'Source'));

  const statusBadge = el('div', 'font-size:11px; padding:2px 8px; border-radius:10px;');
  if (parseStatus.status === 'idle') {
    statusBadge.textContent = 'Not parsed';
    statusBadge.style.cssText += 'background:rgba(90,104,144,0.2); color:#8090b0;';
  } else if (parseStatus.status === 'running') {
    statusBadge.textContent = 'Parsing…';
    statusBadge.style.cssText += 'background:rgba(159,216,255,0.15); color:#9FD8FF;';
  } else if (parseStatus.status === 'done') {
    const r = parseStatus.result;
    const ts = parseStatus.finishedAt ? new Date(parseStatus.finishedAt).toLocaleString(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit' }) : '';
    statusBadge.textContent = `${r.conversations.parsed} conversations parsed${ts ? ' · ' + ts : ''}`;
    statusBadge.style.cssText += 'background:rgba(111,227,208,0.12); color:#6FE3D0;';
  } else if (parseStatus.status === 'failed') {
    statusBadge.textContent = 'Parse failed';
    statusBadge.style.cssText += 'background:rgba(192,80,58,0.15); color:#c0503a;';
  }
  titleRow.appendChild(statusBadge);
  wrap.appendChild(titleRow);

  const desc = el('div', 'font-size:12px; color:#5a6890; margin-bottom:10px;',
    '~/brain-exports/claude/ — Claude conversation and memory export');
  wrap.appendChild(desc);

  if (parseStatus.status === 'failed' && parseStatus.error) {
    wrap.appendChild(el('div', 'font-size:12px; color:#c0503a; margin-bottom:8px;', parseStatus.error));
  }

  const parseBtn = mkBtn(
    parseStatus.status === 'done' ? 'Re-parse' : parseStatus.status === 'running' ? 'Parsing…' : 'Parse',
    '#9FD8FF', 'rgba(60,108,255,0.15)', 'rgba(60,108,255,0.4)'
  );
  if (parseStatus.status === 'running') {
    parseBtn.disabled = true;
    parseBtn.style.opacity = '0.5';
  }
  parseBtn.addEventListener('click', () => triggerParse());
  wrap.appendChild(parseBtn);

  parent.appendChild(wrap);
}

async function triggerParse() {
  parseStatus = { status: 'running' };
  renderMain();

  try {
    await fetch('/api/import/parse', { method: 'POST' });
  } catch { /* non-fatal */ }

  parsePoll = setInterval(async () => {
    await refreshParseStatus();
    if (parseStatus.status !== 'running') {
      clearInterval(parsePoll);
      parsePoll = null;
      if (parseStatus.status === 'done') {
        try {
          const r = await fetch('/api/import/index');
          if (r.ok) convIndex = await r.json();
        } catch { }
      }
      renderMain();
    }
  }, 1500);
}

// ── Conversations section ─────────────────────────────────────────────────────

let convSearch  = '';
let convSort    = 'newest'; // 'newest' | 'oldest' | 'az'
let convChecked = new Set();
let memChecked  = false;

function renderConversationsSection(parent) {
  const wrap = div('');
  wrap.appendChild(el('div', 'font-size:12px; color:#5a6890; letter-spacing:0.05em; text-transform:uppercase; margin-bottom:10px;', 'Claude Conversations'));

  // Controls row
  const controls = div('display:flex; align-items:center; gap:8px; margin-bottom:10px;');

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search…';
  searchInput.value = convSearch;
  searchInput.style.cssText = `
    background:rgba(255,255,255,0.06); border:1px solid rgba(100,120,200,0.22);
    border-radius:5px; color:#c8d0e8; font-size:12px; padding:4px 9px;
    outline:none; font-family:inherit; width:180px;
  `;
  searchInput.addEventListener('input', () => {
    convSearch = searchInput.value;
    refreshConvList();
  });
  controls.appendChild(searchInput);

  const sortSel = document.createElement('select');
  sortSel.style.cssText = `
    background:#0c0f1e; border:1px solid rgba(100,120,200,0.22);
    border-radius:5px; color:#8090b0; font-size:12px; padding:4px 8px;
    outline:none; cursor:pointer; font-family:inherit;
  `;
  [['newest', 'Newest first'], ['oldest', 'Oldest first'], ['az', 'A → Z']].forEach(([v, l]) => {
    const o = document.createElement('option');
    o.value = v; o.textContent = l; if (v === convSort) o.selected = true;
    sortSel.appendChild(o);
  });
  sortSel.addEventListener('change', () => { convSort = sortSel.value; refreshConvList(); });
  controls.appendChild(sortSel);

  // Select all / none
  const selAll = mkBtn('All', '#8090b0', 'none', 'rgba(100,120,200,0.22)');
  selAll.style.cssText += 'font-size:11px; padding:3px 8px;';
  selAll.addEventListener('click', () => {
    visibleUuids().forEach(u => convChecked.add(u));
    refreshConvList(); updateFooter();
  });
  const selNone = mkBtn('None', '#8090b0', 'none', 'rgba(100,120,200,0.22)');
  selNone.style.cssText += 'font-size:11px; padding:3px 8px;';
  selNone.addEventListener('click', () => {
    visibleUuids().forEach(u => convChecked.delete(u));
    refreshConvList(); updateFooter();
  });
  controls.appendChild(selAll);
  controls.appendChild(selNone);

  wrap.appendChild(controls);

  // List
  const listWrap = div('max-height:260px; overflow-y:auto; border:1px solid rgba(100,120,200,0.12); border-radius:6px; scrollbar-width:thin; scrollbar-color:#2a3050 transparent;');
  listWrap.id = 'conv-list-wrap';
  wrap.appendChild(listWrap);

  renderConvList(listWrap);
  parent.appendChild(wrap);

  // Footer / distill row — rendered after memories section
}

function visibleUuids() {
  return filteredSorted().map(c => c.uuid);
}

function filteredSorted() {
  const q = convSearch.toLowerCase();
  let items = q
    ? convIndex.filter(c => (c.title || '').toLowerCase().includes(q))
    : convIndex.slice();

  if (convSort === 'newest') items.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  else if (convSort === 'oldest') items.sort((a, b) => (a.created || '').localeCompare(b.created || ''));
  else items.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return items;
}

function renderConvList(container) {
  const items = filteredSorted();
  container.innerHTML = '';
  if (items.length === 0) {
    container.appendChild(el('div', 'padding:20px; text-align:center; color:#5a6890; font-size:12px;',
      convSearch ? 'No matches.' : 'No conversations.'));
    return;
  }

  for (const conv of items) {
    const row = div('display:flex; align-items:center; gap:10px; padding:7px 12px; border-bottom:1px solid rgba(100,120,200,0.08); cursor:pointer;');
    row.addEventListener('mouseover', () => row.style.background = 'rgba(255,255,255,0.03)');
    row.addEventListener('mouseout',  () => row.style.background = '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = convChecked.has(conv.uuid);
    cb.style.cssText = 'accent-color:#9FD8FF; flex-shrink:0;';
    cb.addEventListener('change', () => {
      if (cb.checked) convChecked.add(conv.uuid); else convChecked.delete(conv.uuid);
      updateFooter();
    });
    row.addEventListener('click', e => { if (e.target !== cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change')); } });

    const title = el('div', 'flex:1; font-size:12px; color:#c8d0e8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;', conv.title || '(untitled)');
    const date  = el('div', 'font-size:11px; color:#5a6890; flex-shrink:0; white-space:nowrap;',
      conv.created ? new Date(conv.created).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' }) : '');
    const calls = el('div', 'font-size:11px; color:#4a5470; flex-shrink:0; white-space:nowrap; width:50px; text-align:right;',
      `~${conv.distillCalls} call${conv.distillCalls !== 1 ? 's' : ''}`);

    row.appendChild(cb);
    row.appendChild(title);
    row.appendChild(date);
    row.appendChild(calls);
    container.appendChild(row);
  }
}

function refreshConvList() {
  const wrap = document.getElementById('conv-list-wrap');
  if (wrap) renderConvList(wrap);
}

// ── Memories section ──────────────────────────────────────────────────────────

function renderMemoriesSection(parent) {
  const r = parseStatus.result?.memories;
  if (!r) return;

  const wrap = div('margin-bottom:14px;');
  wrap.appendChild(el('div', 'font-size:12px; color:#5a6890; letter-spacing:0.05em; text-transform:uppercase; margin-bottom:8px;', 'Claude Memories'));

  const row = div('display:flex; align-items:center; gap:10px;');

  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = memChecked;
  cb.style.cssText = 'accent-color:#9FD8FF;';
  cb.addEventListener('change', () => { memChecked = cb.checked; updateFooter(); });

  const desc = el('div', 'font-size:12px; color:#c8d0e8;',
    `${r.fileCount} memory files · ${r.projectMemCount} project memories · conversations memory`);
  const calls = el('div', 'font-size:11px; color:#4a5470;', `~${r.totalDistillCalls} distill call${r.totalDistillCalls !== 1 ? 's' : ''}`);

  row.appendChild(cb);
  row.appendChild(desc);
  row.appendChild(calls);
  wrap.appendChild(row);
  parent.appendChild(wrap);

  // Footer is rendered here so it appears below memories
  renderFooter(parent);
}

// ── Footer (agent + run) ──────────────────────────────────────────────────────

let footerEl = null;

function renderFooter(parent) {
  footerEl = div('margin-top:14px;');
  parent.appendChild(footerEl);
  updateFooter();
}

function updateFooter() {
  if (!footerEl) return;
  footerEl.innerHTML = '';

  const selectedConvs  = [...convChecked].filter(u => convIndex.some(c => c.uuid === u));
  const convCalls      = selectedConvs.reduce((s, u) => {
    const c = convIndex.find(x => x.uuid === u);
    return s + (c ? c.distillCalls : 0);
  }, 0);
  const memCalls       = memChecked ? (parseStatus.result?.memories?.totalDistillCalls || 0) : 0;
  const totalCalls     = convCalls + memCalls;
  const hasSelection   = selectedConvs.length > 0 || memChecked;

  // Summary line
  const parts = [];
  if (selectedConvs.length > 0) parts.push(`${selectedConvs.length} conversation${selectedConvs.length !== 1 ? 's' : ''}`);
  if (memChecked) parts.push('memories');
  if (parts.length > 0) parts.push(`→ ~${totalCalls} distill call${totalCalls !== 1 ? 's' : ''}`);

  if (parts.length > 0) {
    footerEl.appendChild(el('div', 'font-size:12px; color:#8090b0; margin-bottom:10px;', parts.join(' + ')));
  }

  if (agentList.length === 0) {
    footerEl.appendChild(el('div', 'font-size:12px; color:#c08050;', 'No agents available.'));
    return;
  }

  // Agent picker
  const agentRow = div('display:flex; gap:12px; margin-bottom:12px; flex-wrap:wrap;');
  let selectedAgent = agentList[0];
  for (const a of agentList) {
    const lbl = el('label', 'display:flex; align-items:center; gap:5px; cursor:pointer; font-size:12px; color:#c8d0e8;');
    const inp = document.createElement('input');
    inp.type = 'radio'; inp.name = 'import-agent'; inp.value = a; inp.checked = (a === agentList[0]);
    inp.addEventListener('change', () => { if (inp.checked) selectedAgent = a; });
    lbl.appendChild(inp);
    lbl.appendChild(document.createTextNode(a.charAt(0).toUpperCase() + a.slice(1)));
    agentRow.appendChild(lbl);
  }
  footerEl.appendChild(agentRow);

  // Run button
  const runBtn = mkBtn('Distill selected', '#9FD8FF', 'rgba(60,108,255,0.2)', 'rgba(60,108,255,0.5)');
  runBtn.style.cssText += 'width:100%; padding:8px 0; font-size:13px;';
  if (!hasSelection) { runBtn.disabled = true; runBtn.style.opacity = '0.4'; }
  runBtn.addEventListener('click', () => {
    const agent = cardEl.querySelector('input[name="import-agent"]:checked')?.value || selectedAgent;
    startRun(agent, selectedConvs, memChecked);
  });
  footerEl.appendChild(runBtn);
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
async function startRun(agent, uuids, includeMemories) {
  renderRunning(`Starting ${agent === 'claude' ? 'Claude' : 'Gemini'}…`);

  let runId;
  try {
    const r = await fetch('/api/distill/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent, conversationUuids: uuids, includeMemories }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    runId = d.runId;
  } catch (e) {
    renderResult({ status: 'failed', message: `Failed to start: ${e.message}` });
    return;
  }

  const deadline = Date.now() + MAX_RUN_MS;
  pollTimer = setInterval(async () => {
    if (Date.now() > deadline) {
      stopPolls();
      renderResult({ status: 'failed', message: 'Timed out after 10 minutes.' });
      return;
    }
    try {
      const r = await fetch(`/api/distill/status/${runId}`);
      if (!r.ok) return;
      const state = await r.json();
      if (state.status === 'running' || state.status === 'pending') {
        renderRunning(state.message || 'Working…');
      } else {
        stopPolls();
        renderResult(state);
      }
    } catch { /* transient */ }
  }, 3000);
}

// ─── RUNNING / RESULT RENDERS ─────────────────────────────────────────────────
function renderRunning(message) {
  cardEl.innerHTML = '';

  const hdr = div('display:flex; justify-content:space-between; align-items:center; padding:18px 20px 14px; border-bottom:1px solid rgba(100,120,200,0.15);');
  hdr.appendChild(el('div', 'font-size:16px; font-weight:700; color:#fff;', 'Import'));
  const c = el('button', 'background:none; border:none; color:#8090b0; font-size:18px; cursor:pointer; padding:0 4px;', '✕');
  c.addEventListener('click', closeModal);
  hdr.appendChild(c);
  cardEl.appendChild(hdr);

  const body = div('padding:20px;');
  body.appendChild(el('div', 'font-size:13px; color:#9FD8FF; margin-bottom:6px;', '⏳ ' + message));
  body.appendChild(el('div', 'font-size:11px; color:#5a6890;', 'Timeout after 10 minutes.'));
  cardEl.appendChild(body);
}

function renderResult(state) {
  cardEl.innerHTML = '';

  const hdr = div('display:flex; justify-content:space-between; align-items:center; padding:18px 20px 14px; border-bottom:1px solid rgba(100,120,200,0.15);');
  hdr.appendChild(el('div', 'font-size:16px; font-weight:700; color:#fff;', 'Import'));
  const c = el('button', 'background:none; border:none; color:#8090b0; font-size:18px; cursor:pointer; padding:0 4px;', '✕');
  c.addEventListener('click', closeModal);
  hdr.appendChild(c);
  cardEl.appendChild(hdr);

  const body = div('padding:20px;');

  if (state.status === 'done') {
    body.appendChild(el('div', 'font-size:14px; color:#6FE3D0; margin-bottom:12px;', '✓ ' + state.message));
    if (state.result?.inboxed?.length) {
      const list = el('div', 'font-size:12px; color:#8090b0; font-family:monospace;');
      list.textContent = state.result.inboxed.join('\n');
      body.appendChild(list);
    }
  } else {
    body.appendChild(el('div', 'font-size:13px; color:#c0503a; margin-bottom:12px;', '✗ ' + state.message));
    body.appendChild(el('div', 'font-size:11px; color:#5a6890;', 'Staging folder kept for inspection.'));
  }

  const again = mkBtn('Back to Import', '#9FD8FF', 'rgba(60,108,255,0.15)', 'rgba(60,108,255,0.4)');
  again.style.cssText += 'margin-top:16px; width:100%; padding:7px 0; font-size:13px;';
  again.addEventListener('click', openModal);
  body.appendChild(again);

  cardEl.appendChild(body);
}

// ─── DOM HELPERS ──────────────────────────────────────────────────────────────
function el(tag, css, text) {
  const e = document.createElement(tag);
  if (css)  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

function div(css) { return el('div', css); }

function mkBtn(text, color, bg, border) {
  const btn = document.createElement('button');
  btn.textContent = text;
  btn.style.cssText = `
    padding:5px 14px; background:${bg}; border:1px solid ${border};
    color:${color}; border-radius:5px; font-size:13px; cursor:pointer;
    font-family:inherit; transition:opacity 0.15s;
  `;
  return btn;
}
