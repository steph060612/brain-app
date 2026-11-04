// Import panel: parse Claude, ChatGPT and Gemini exports, select conversations/memories, send to distiller.

// ─── STATE ────────────────────────────────────────────────────────────────────
let backdropEl = null;
let cardEl     = null;
let agentList  = [];
let disabledReasons = {};
let parseStatus = { status: 'idle' };
let pollTimer   = null;
let parsePoll   = null;
let runsInfo    = { active: null, stopped: [], avgCallMs: 90000, callSamples: 0 };

const CONFIRM_ABOVE_CALLS = 10;

// Conversation sources. index: [{uuid, title, created, updated, messageCount, charCount, distillCalls}]
const SOURCES = {
  claude: {
    label: 'Claude Conversations', resultKey: 'conversations', indexUrl: '/api/import/index',
    index: [], search: '', sort: 'newest', checked: new Set(),
  },
  chatgpt: {
    label: 'ChatGPT Conversations', resultKey: 'chatgpt', indexUrl: '/api/import/chatgpt-index',
    index: [], search: '', sort: 'newest', checked: new Set(),
  },
  gemini: {
    label: 'Gemini Conversations', resultKey: 'gemini', indexUrl: '/api/import/gemini-index',
    index: [], search: '', sort: 'newest', checked: new Set(),
  },
};

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
  await refreshRuns();
  if (runsInfo.active) { watchRun(runsInfo.active.runId); return; } // closing the window doesn't stop a run
  await refreshParseStatus();
  if (parseStatus.status === 'done') await loadIndexes();
  renderMain();
}

async function loadIndexes() {
  await Promise.all([
    ...Object.values(SOURCES).map(async src => {
      try {
        const r = await fetch(src.indexUrl);
        src.index = r.ok ? await r.json() : [];
      } catch { /* keep stale */ }
    }),
    (async () => {
      try {
        const r = await fetch('/api/import/distilled');
        if (r.ok) distilled = await r.json();
      } catch { /* keep stale */ }
    })(),
  ]);
}

// ─── DISTILLED ────────────────────────────────────────────────────────────────
// Records keyed "<source>:<id>"; source is the SOURCES key, or 'memories'.
let distilled = {};

const fmtDay = d => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month:'short', day:'numeric', year:'numeric' });

// null, or { label, changed } for a conversation that was distilled before.
function distilledInfo(key, conv) {
  const rec = distilled[`${key}:${conv.uuid}`];
  if (!rec) return null;
  const changed = rec.messageCount != null && conv.messageCount > rec.messageCount;
  return { changed, label: `Distilled ${fmtDay(rec.date)}${changed ? ', has new messages' : ''}` };
}

function memoriesDistilledInfo(stats) {
  const rec = distilled['memories:claude-memories'];
  if (!rec) return null;
  const changed = rec.totalChars != null && stats?.totalChars != null && stats.totalChars !== rec.totalChars;
  return { changed, label: `Distilled ${fmtDay(rec.date)}${changed ? ', has new content' : ''}` };
}

function distilledTag(info) {
  return el('div', `font-size:11px; flex-shrink:0; white-space:nowrap; padding:1px 7px; border-radius:9px;
    ${info.changed ? 'color:#e0a050; background:rgba(224,160,80,0.1);' : 'color:#6FE3D0; background:rgba(111,227,208,0.08);'}`,
    info.label);
}

function closeModal() {
  stopPolls();
  backdropEl.style.display = 'none';
}

function stopPolls() {
  if (pollTimer)  { clearInterval(pollTimer);  pollTimer  = null; }
  if (parsePoll)  { clearInterval(parsePoll);  parsePoll  = null; }
}

async function refreshRuns() {
  try {
    const r = await fetch('/api/distill/runs');
    if (r.ok) runsInfo = await r.json();
  } catch { /* keep stale */ }
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

  renderStoppedRuns(body);

  // ── Parse section ──
  renderParseSection(body);

  // ── Separator ──
  if (parseStatus.status === 'done') {
    body.appendChild(div('height:1px; background:rgba(100,120,200,0.12); margin:16px 0;'));
    renderConversationsSection(body, 'claude');
    body.appendChild(div('height:1px; background:rgba(100,120,200,0.12); margin:16px 0;'));
    renderConversationsSection(body, 'chatgpt');
    body.appendChild(div('height:1px; background:rgba(100,120,200,0.12); margin:16px 0;'));
    renderConversationsSection(body, 'gemini');
    body.appendChild(div('height:1px; background:rgba(100,120,200,0.12); margin:16px 0;'));
    renderMemoriesSection(body);
  }
}

// ── Stopped runs ─────────────────────────────────────────────────────────────

function runItemTitle(t) {
  if (t.source === 'memories') return 'Claude memories';
  return SOURCES[t.source]?.index.find(c => c.uuid === t.id)?.title || t.names[0];
}

function renderStoppedRuns(parent) {
  if (runsInfo.stopped.length === 0) return;
  const wrap = div('margin-bottom:14px;');
  wrap.appendChild(el('div', 'font-size:12px; color:#5a6890; letter-spacing:0.05em; text-transform:uppercase; margin-bottom:8px;', 'Stopped runs'));

  for (const run of runsInfo.stopped) {
    const remaining = run.total - run.done;
    const row = div('display:flex; align-items:center; gap:12px; padding:8px 10px; margin-bottom:6px; border:1px solid rgba(224,160,80,0.25); border-radius:6px;');
    const info = div('flex:1; min-width:0;');
    const names = run.tracked?.length ? run.tracked.map(runItemTitle).join(', ') : run.inputNames.join(', ');
    info.appendChild(el('div', 'font-size:12px; color:#c8d0e8; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;', names));
    info.appendChild(el('div', 'font-size:11px; color:#8090b0; margin-top:2px;',
      `${run.done} of ${run.total} calls finished, ${remaining} remaining, ${run.suggestions} in Inbox`));
    if (run.reason) info.appendChild(el('div', 'font-size:11px; color:#5a6890; margin-top:2px; word-break:break-word;', run.reason));
    row.appendChild(info);

    const resume = mkBtn('Resume', '#9FD8FF', 'rgba(60,108,255,0.15)', 'rgba(60,108,255,0.4)');
    resume.style.cssText += 'flex-shrink:0; font-size:12px;';
    resume.addEventListener('click', () => confirmCalls(remaining, () => resumeRun(run.runId, run.agent), renderMain));
    row.appendChild(resume);
    wrap.appendChild(row);
  }
  parent.appendChild(wrap);
  parent.appendChild(div('height:1px; background:rgba(100,120,200,0.12); margin:16px 0;'));
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
    const parsed = (r.conversations?.parsed ?? 0) + (r.chatgpt?.parsed ?? 0) + (r.gemini?.parsed ?? 0);
    statusBadge.textContent = `${parsed} conversations parsed`;
    statusBadge.style.cssText += 'background:rgba(111,227,208,0.12); color:#6FE3D0;';
  } else if (parseStatus.status === 'failed') {
    statusBadge.textContent = 'Parse failed';
    statusBadge.style.cssText += 'background:rgba(192,80,58,0.15); color:#c0503a;';
  }
  titleRow.appendChild(statusBadge);
  wrap.appendChild(titleRow);

  const desc = el('div', 'font-size:12px; color:#5a6890; margin-bottom:6px;',
    '~/brain-exports/claude/ — Claude conversation and memory export');
  wrap.appendChild(desc);
  wrap.appendChild(el('div', 'font-size:12px; color:#5a6890; margin-bottom:6px;',
    '~/brain-exports/ChatGPT_Data-Export/ — ChatGPT conversation export'));
  wrap.appendChild(el('div', 'font-size:12px; color:#5a6890; margin-bottom:6px;',
    '~/brain-exports/gemini/ — Google Takeout Gemini Apps activity'));
  wrap.appendChild(div('margin-bottom:4px;'));

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

  const btnRow = div('display:flex; align-items:center; gap:10px;');
  btnRow.appendChild(parseBtn);
  if (parseStatus.status === 'done' && parseStatus.finishedAt) {
    const ts = new Date(parseStatus.finishedAt).toLocaleString(undefined, { month:'short', day:'numeric', year:'numeric', hour:'2-digit', minute:'2-digit' });
    btnRow.appendChild(el('div', 'font-size:11px; color:#5a6890;', `Last parsed ${ts}`));
  }
  wrap.appendChild(btnRow);

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
      if (parseStatus.status === 'done') await loadIndexes();
      renderMain();
    }
  }, 1500);
}

// ── Conversations section ─────────────────────────────────────────────────────

let memChecked  = false;

function renderConversationsSection(parent, key) {
  const src  = SOURCES[key];
  const wrap = div('');
  wrap.appendChild(el('div', 'font-size:12px; color:#5a6890; letter-spacing:0.05em; text-transform:uppercase; margin-bottom:10px;', src.label));

  const result = parseStatus.result?.[src.resultKey];
  if (result?.missing) {
    wrap.appendChild(el('div', 'font-size:12px; color:#5a6890;', 'Export not found.'));
    parent.appendChild(wrap);
    return;
  }
  const nDistilled = src.index.filter(c => distilledInfo(key, c)).length;
  if (nDistilled > 0) {
    wrap.appendChild(el('div', 'font-size:12px; color:#5a6890; margin-bottom:10px;',
      `${nDistilled} already distilled: left unticked, and "All" skips them. Tick one to distill it again.`));
  }
  const skipped = result?.skipped ?? 0;
  if (skipped > 0 && key === 'gemini') {
    // Gemini skips individual activity entries, not conversations.
    const reasons = Object.entries(result.skippedReasons || {}).map(([r, n]) => `${r} (${n})`).join(', ');
    wrap.appendChild(el('div', 'font-size:12px; color:#5a6890; margin-bottom:10px;',
      `${skipped} activit${skipped !== 1 ? 'y entries were' : 'y entry was'} skipped${reasons ? `: ${reasons}` : ''}.`));
  } else if (skipped > 0) {
    wrap.appendChild(el('div', 'font-size:12px; color:#5a6890; margin-bottom:10px;',
      `${skipped} conversation${skipped !== 1 ? 's' : ''} were empty in the export and were skipped.`));
  }

  // Controls row
  const controls = div('display:flex; align-items:center; gap:8px; margin-bottom:10px;');

  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search…';
  searchInput.value = src.search;
  searchInput.style.cssText = `
    background:rgba(255,255,255,0.06); border:1px solid rgba(100,120,200,0.22);
    border-radius:5px; color:#c8d0e8; font-size:12px; padding:4px 9px;
    outline:none; font-family:inherit; width:180px;
  `;
  searchInput.addEventListener('input', () => {
    src.search = searchInput.value;
    refreshConvList(key);
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
    o.value = v; o.textContent = l; if (v === src.sort) o.selected = true;
    sortSel.appendChild(o);
  });
  sortSel.addEventListener('change', () => { src.sort = sortSel.value; refreshConvList(key); });
  controls.appendChild(sortSel);

  // Select all / none
  const selAll = mkBtn('All', '#8090b0', 'none', 'rgba(100,120,200,0.22)');
  selAll.style.cssText += 'font-size:11px; padding:3px 8px;';
  selAll.addEventListener('click', () => {
    filteredSorted(key).filter(c => !distilledInfo(key, c)).forEach(c => src.checked.add(c.uuid)); // distilled stay unticked
    refreshConvList(key); updateFooter();
  });
  const selNone = mkBtn('None', '#8090b0', 'none', 'rgba(100,120,200,0.22)');
  selNone.style.cssText += 'font-size:11px; padding:3px 8px;';
  selNone.addEventListener('click', () => {
    filteredSorted(key).forEach(c => src.checked.delete(c.uuid));
    refreshConvList(key); updateFooter();
  });
  controls.appendChild(selAll);
  controls.appendChild(selNone);

  wrap.appendChild(controls);

  // List
  const listWrap = div('max-height:260px; overflow-y:auto; border:1px solid rgba(100,120,200,0.12); border-radius:6px; scrollbar-width:thin; scrollbar-color:#2a3050 transparent;');
  listWrap.id = `conv-list-wrap-${key}`;
  wrap.appendChild(listWrap);

  renderConvList(listWrap, key);
  parent.appendChild(wrap);

  // Footer / distill row — rendered after memories section
}

function filteredSorted(key) {
  const src = SOURCES[key];
  const q = src.search.toLowerCase();
  let items = q
    ? src.index.filter(c => (c.title || '').toLowerCase().includes(q))
    : src.index.slice();

  if (src.sort === 'newest') items.sort((a, b) => (b.created || '').localeCompare(a.created || ''));
  else if (src.sort === 'oldest') items.sort((a, b) => (a.created || '').localeCompare(b.created || ''));
  else items.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  return items;
}

function renderConvList(container, key) {
  const src   = SOURCES[key];
  const items = filteredSorted(key);
  container.innerHTML = '';
  if (items.length === 0) {
    container.appendChild(el('div', 'padding:20px; text-align:center; color:#5a6890; font-size:12px;',
      src.search ? 'No matches.' : 'No conversations.'));
    return;
  }

  for (const conv of items) {
    const row = div('display:flex; align-items:center; gap:10px; padding:7px 12px; border-bottom:1px solid rgba(100,120,200,0.08); cursor:pointer;');
    row.addEventListener('mouseover', () => row.style.background = 'rgba(255,255,255,0.03)');
    row.addEventListener('mouseout',  () => row.style.background = '');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = src.checked.has(conv.uuid);
    cb.style.cssText = 'accent-color:#9FD8FF; flex-shrink:0;';
    cb.addEventListener('change', () => {
      if (cb.checked) src.checked.add(conv.uuid); else src.checked.delete(conv.uuid);
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
    const info = distilledInfo(key, conv);
    if (info) row.appendChild(distilledTag(info));
    row.appendChild(date);
    row.appendChild(calls);
    container.appendChild(row);
  }
}

function refreshConvList(key) {
  const wrap = document.getElementById(`conv-list-wrap-${key}`);
  if (wrap) renderConvList(wrap, key);
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
  const memInfo = memoriesDistilledInfo(r);
  if (memInfo) row.appendChild(distilledTag(memInfo));
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

  const selected = {};
  let convCalls = 0;
  for (const [key, src] of Object.entries(SOURCES)) {
    selected[key] = src.index.filter(c => src.checked.has(c.uuid));
    convCalls += selected[key].reduce((s, c) => s + c.distillCalls, 0);
  }
  const selectedCount  = selected.claude.length + selected.chatgpt.length + selected.gemini.length;
  const memCalls       = memChecked ? (parseStatus.result?.memories?.totalDistillCalls || 0) : 0;
  const totalCalls     = convCalls + memCalls;
  const hasSelection   = selectedCount > 0 || memChecked;

  // Summary line
  const parts = [];
  if (selected.claude.length > 0)  parts.push(`${selected.claude.length} Claude conversation${selected.claude.length !== 1 ? 's' : ''}`);
  if (selected.chatgpt.length > 0) parts.push(`${selected.chatgpt.length} ChatGPT conversation${selected.chatgpt.length !== 1 ? 's' : ''}`);
  if (selected.gemini.length > 0)  parts.push(`${selected.gemini.length} Gemini conversation${selected.gemini.length !== 1 ? 's' : ''}`);
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
    confirmCalls(totalCalls, () =>
      startRun(agent, selected.claude.map(c => c.uuid), selected.chatgpt.map(c => c.uuid), selected.gemini.map(c => c.uuid), memChecked),
      renderMain);
  });
  footerEl.appendChild(runBtn);
}

// ─── RUN ──────────────────────────────────────────────────────────────────────
const agentName = agent => agent === 'claude' ? 'Claude' : 'Gemini';

function fmtDuration(ms) {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600), m = Math.floor(totalSec / 60) % 60, s = totalSec % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
}

// Runs above CONFIRM_ABOVE_CALLS spend real usage and take a while, so ask first.
async function confirmCalls(calls, onConfirm, onBack) {
  if (calls <= CONFIRM_ABOVE_CALLS) { onConfirm(); return; }
  await refreshRuns();
  const estimate = fmtDuration(calls * runsInfo.avgCallMs);
  const basis = runsInfo.callSamples
    ? `from the average of your last ${runsInfo.callSamples} call${runsInfo.callSamples !== 1 ? 's' : ''}`
    : 'a rough guess of 90 seconds per call, until there are real timings';

  cardEl.innerHTML = '';
  cardEl.appendChild(modalHeader());
  const body = div('padding:20px;');
  body.appendChild(el('div', 'font-size:14px; color:#fff; margin-bottom:8px;', `This needs ${calls} calls.`));
  body.appendChild(el('div', 'font-size:13px; color:#c8d0e8; margin-bottom:4px;', `Estimated time: about ${estimate}.`));
  body.appendChild(el('div', 'font-size:11px; color:#5a6890; margin-bottom:16px;',
    `Estimate ${basis}. You can cancel at any time, keep what finished, and resume later.`));

  const btns = div('display:flex; gap:10px;');
  const go = mkBtn('Start', '#9FD8FF', 'rgba(60,108,255,0.2)', 'rgba(60,108,255,0.5)');
  go.style.cssText += 'flex:1; padding:8px 0;';
  go.addEventListener('click', onConfirm);
  const back = mkBtn('Back', '#8090b0', 'none', 'rgba(100,120,200,0.22)');
  back.style.cssText += 'flex:1; padding:8px 0;';
  back.addEventListener('click', onBack);
  btns.appendChild(go);
  btns.appendChild(back);
  body.appendChild(btns);
  cardEl.appendChild(body);
}

async function postRun(url, body, startingLabel) {
  renderRunning({ message: startingLabel });
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    watchRun(d.runId);
  } catch (e) {
    renderResult({ status: 'failed', message: `Failed to start: ${e.message}` });
  }
}

function startRun(agent, uuids, chatgptIds, geminiIds, includeMemories) {
  return postRun('/api/distill/import', { agent, conversationUuids: uuids, chatgptIds, geminiIds, includeMemories },
    `Starting ${agentName(agent)}…`);
}

function resumeRun(runId, agent) {
  return postRun(`/api/distill/resume/${runId}`, {}, `Resuming with ${agentName(agent)}…`);
}

function watchRun(runId) {
  stopPolls();
  renderRunning({ message: 'Working…', runId });
  const poll = async () => {
    try {
      const r = await fetch(`/api/distill/status/${runId}`);
      if (r.status === 404) { stopPolls(); openModal(); return; } // the server restarted; the run is under Stopped runs
      if (!r.ok) return;
      const state = await r.json();
      if (state.status === 'running' || state.status === 'pending') {
        updateRunning(state);
      } else {
        stopPolls();
        renderResult(state);
      }
    } catch { /* transient */ }
  };
  poll();
  pollTimer = setInterval(poll, 1000);
}

// ─── RUNNING / RESULT RENDERS ─────────────────────────────────────────────────
function modalHeader() {
  const hdr = div('display:flex; justify-content:space-between; align-items:center; padding:18px 20px 14px; border-bottom:1px solid rgba(100,120,200,0.15);');
  hdr.appendChild(el('div', 'font-size:16px; font-weight:700; color:#fff;', 'Import'));
  const c = el('button', 'background:none; border:none; color:#8090b0; font-size:18px; cursor:pointer; padding:0 4px;', '✕');
  c.addEventListener('click', closeModal);
  hdr.appendChild(c);
  return hdr;
}

let runningLine = null;

function renderRunning({ message, runId }) {
  cardEl.innerHTML = '';
  cardEl.appendChild(modalHeader());

  const body = div('padding:20px;');
  runningLine = el('div', 'font-size:13px; color:#9FD8FF; margin-bottom:6px;', '⏳ ' + message);
  body.appendChild(runningLine);
  body.appendChild(el('div', 'font-size:11px; color:#5a6890;',
    'Each call has a 5-minute limit. You can close this window; the run continues.'));

  if (runId) {
    const cancel = mkBtn('Cancel', '#e0a050', 'rgba(224,160,80,0.1)', 'rgba(224,160,80,0.4)');
    cancel.style.cssText += 'margin-top:16px; width:100%; padding:7px 0; font-size:13px;';
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      cancel.style.opacity = '0.5';
      cancel.textContent = 'Cancelling…';
      await fetch(`/api/distill/cancel/${runId}`, { method: 'POST' }).catch(() => {});
    });
    body.appendChild(cancel);
  }
  cardEl.appendChild(body);
}

// In place, so the Cancel button isn't rebuilt under the pointer on every poll.
function updateRunning(state) {
  if (!runningLine) return;
  const elapsed = fmtDuration(Date.now() - new Date(state.startedAt).getTime());
  runningLine.textContent = state.callNumber && state.message !== 'Cancelling…'
    ? `⏳ Call ${state.callNumber} of ${state.totalCalls}, ${elapsed} elapsed`
    : `⏳ ${state.message || 'Working…'} (${elapsed} elapsed)`;
}

function renderResult(state) {
  cardEl.innerHTML = '';
  cardEl.appendChild(modalHeader());

  const body = div('padding:20px;');

  if (state.status === 'done' || state.status === 'stopped') {
    // Done items are recorded and stopped ones are under Stopped runs; start the next selection from nothing ticked.
    for (const src of Object.values(SOURCES)) src.checked.clear();
    memChecked = false;
    body.appendChild(state.status === 'done'
      ? el('div', 'font-size:14px; color:#6FE3D0; margin-bottom:12px;', '✓ ' + state.message)
      : el('div', 'font-size:13px; color:#e0a050; margin-bottom:12px; word-break:break-word;', state.message));
    if (state.result?.inboxed?.length) {
      const list = el('div', 'font-size:12px; color:#8090b0; font-family:monospace;');
      list.textContent = state.result.inboxed.join('\n');
      body.appendChild(list);
    }
    if (state.result?.dropped?.length) {
      body.appendChild(el('div', 'font-size:12px; color:#c08050; margin:12px 0 4px;', 'Dropped by checker (staging folder kept):'));
      const dl = el('div', 'font-size:12px; color:#8090b0; font-family:monospace; white-space:pre-line;');
      dl.textContent = state.result.dropped.map(d => `${d.file}: ${d.reason}`).join('\n');
      body.appendChild(dl);
    }
  } else {
    body.appendChild(el('div', 'font-size:13px; color:#c0503a; margin-bottom:12px;', '✗ ' + state.message));
    body.appendChild(el('div', 'font-size:11px; color:#5a6890;', 'Staging folder kept for inspection.'));
  }

  if (state.status === 'stopped' && state.result?.remaining > 0) {
    const resume = mkBtn('Resume', '#9FD8FF', 'rgba(60,108,255,0.2)', 'rgba(60,108,255,0.5)');
    resume.style.cssText += 'margin-top:16px; width:100%; padding:7px 0; font-size:13px;';
    resume.addEventListener('click', () => confirmCalls(state.result.remaining,
      () => resumeRun(state.runId, state.agent), () => renderResult(state)));
    body.appendChild(resume);
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
