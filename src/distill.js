// Distill runner: pick files, pick agent, run, show result.
import { CONFIRM_ABOVE_CALLS, callEstimate, callsForFiles, cancelRun, fetchRuns, progressText } from './run-progress.js';

// ─── STATE ───────────────────────────────────────────────────────────────────
let backdropEl  = null;
let cardEl      = null;
let agentList   = [];
let disabledReasons = {};
let pollTimer   = null;

// ─── INIT ────────────────────────────────────────────────────────────────────
export async function initDistill() {
  createBackdrop();

  const btn = document.createElement('button');
  btn.id = 'distill-btn';
  btn.textContent = 'Distill';
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
    const r = await fetch('/api/distill/agents');
    const d = await r.json();
    agentList = d.agents || [];
    disabledReasons = d.reasons || {};
    if (agentList.length === 0) {
      btn.style.opacity = '0.45';
      btn.title = Object.values(disabledReasons).join('; ');
    }
  } catch { btn.style.opacity = '0.45'; }
}

function createBackdrop() {
  backdropEl = document.createElement('div');
  backdropEl.id = 'distill-backdrop';
  backdropEl.style.cssText = `
    position:fixed; inset:0; background:rgba(0,0,0,0.65); z-index:50;
    display:none; align-items:center; justify-content:center;
  `;
  backdropEl.addEventListener('click', e => { if (e.target === backdropEl) closeModal(); });

  cardEl = document.createElement('div');
  cardEl.style.cssText = `
    background:#0c0f1e; border:1px solid rgba(100,120,200,0.28); border-radius:10px;
    width:480px; max-width:92vw; padding:24px 26px;
    font-family:system-ui,-apple-system,sans-serif; color:#e8eaf0;
    box-shadow:0 8px 40px rgba(0,0,0,0.6);
  `;

  backdropEl.appendChild(cardEl);
  document.body.appendChild(backdropEl);
}

// ─── OPEN / CLOSE ────────────────────────────────────────────────────────────
async function openModal() {
  stopPoll();
  backdropEl.style.display = 'flex';
  // Closing the window doesn't stop a run, so come back to it and to its Cancel button.
  const active = (await fetchRuns().catch(() => null))?.active;
  if (active) watchRun(active.runId);
  else renderIdle(null, []);
}

function closeModal() {
  stopPoll();
  backdropEl.style.display = 'none';
}

function stopPoll() {
  if (pollTimer)  { clearInterval(pollTimer);  pollTimer  = null; }
}

// ─── RENDERS ─────────────────────────────────────────────────────────────────
function renderIdle(selectedAgent, selectedFiles) {
  const agent  = selectedAgent || agentList[0] || '';
  const noFile = selectedFiles.length === 0;

  cardEl.innerHTML = '';

  // Header
  const hdr = row('space-between', 'align-items:center; margin-bottom:18px;');
  const title = el('div', 'font-size:16px; font-weight:700; color:#fff;', 'Distill to Inbox');
  const close = el('button', 'background:none; border:none; color:#8090b0; font-size:18px; cursor:pointer; padding:0 4px;', '✕');
  close.addEventListener('click', closeModal);
  hdr.appendChild(title); hdr.appendChild(close);
  cardEl.appendChild(hdr);

  // File input
  label('Input files');
  const fileRow = row('flex-start', 'align-items:center; gap:10px; margin-bottom:14px;');
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.style.display = 'none';
  const pickBtn = mkBtn('Choose files…', '#c8d0e8', 'rgba(255,255,255,0.08)', 'rgba(100,120,200,0.3)');
  pickBtn.addEventListener('click', () => fileInput.click());

  const fileLabel = el('div', 'font-size:12px; color:#8090b0; flex:1;',
    noFile ? 'No files selected' : selectedFiles.map(f => f.name).join(', '));

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files);
    renderIdle(agent, files);
  });

  fileRow.appendChild(pickBtn);
  fileRow.appendChild(fileInput);
  fileRow.appendChild(fileLabel);
  cardEl.appendChild(fileRow);

  // Agent picker
  if (agentList.length > 0) {
    label('Agent');
    const agentRow = row('flex-start', 'gap:10px; margin-bottom:20px; flex-wrap:wrap;');
    for (const a of agentList) {
      const rb = el('label', 'display:flex; align-items:center; gap:6px; cursor:pointer; font-size:13px;');
      const inp = document.createElement('input');
      inp.type = 'radio'; inp.name = 'distill-agent'; inp.value = a;
      inp.checked = (a === agent);
      inp.addEventListener('change', () => { if (inp.checked) renderIdle(a, selectedFiles); });
      rb.appendChild(inp);
      rb.appendChild(document.createTextNode(a.charAt(0).toUpperCase() + a.slice(1)));
      agentRow.appendChild(rb);
    }
    cardEl.appendChild(agentRow);

    // Run button
    const runBtn = mkBtn('Run', '#9FD8FF', 'rgba(60,108,255,0.2)', 'rgba(60,108,255,0.5)');
    runBtn.style.width = '100%';
    runBtn.style.padding = '8px 0';
    runBtn.style.fontSize = '14px';
    if (noFile) { runBtn.disabled = true; runBtn.style.opacity = '0.4'; }

    runBtn.addEventListener('click', () => {
      const checked = cardEl.querySelector('input[name="distill-agent"]:checked');
      const pickedAgent = checked ? checked.value : agent;
      startRun(pickedAgent, selectedFiles);
    });
    cardEl.appendChild(runBtn);
  } else {
    // No agents
    const msg = el('div', 'font-size:13px; color:#c08050; margin-top:6px;');
    const reasonLines = Object.entries(disabledReasons).map(([k, v]) => `${k}: ${v}`);
    msg.textContent = 'No agents available. ' + reasonLines.join(' | ');
    cardEl.appendChild(msg);
  }
}

function cardHeader() {
  const hdr = row('space-between', 'align-items:center; margin-bottom:20px;');
  hdr.appendChild(el('div', 'font-size:16px; font-weight:700; color:#fff;', 'Distill to Inbox'));
  const close = el('button', 'background:none; border:none; color:#8090b0; font-size:18px; cursor:pointer; padding:0 4px;', '✕');
  close.addEventListener('click', closeModal);
  hdr.appendChild(close);
  return hdr;
}

let runningLine = null;

function renderRunning(message, runId) {
  cardEl.innerHTML = '';
  cardEl.appendChild(cardHeader());

  runningLine = el('div', 'font-size:13px; color:#9FD8FF; margin-bottom:8px;', '⏳ ' + message);
  cardEl.appendChild(runningLine);
  cardEl.appendChild(el('div', 'font-size:11px; color:#5a6890;',
    'Each call has a 5-minute limit. You can close this window; the run continues.'));

  if (runId) {
    const cancel = mkBtn('Cancel', '#e0a050', 'rgba(224,160,80,0.1)', 'rgba(224,160,80,0.4)');
    cancel.style.cssText += 'margin-top:16px; width:100%; padding:7px 0; font-size:13px;';
    cancel.addEventListener('click', async () => {
      cancel.disabled = true;
      cancel.style.opacity = '0.5';
      cancel.textContent = 'Cancelling…';
      await cancelRun(runId);
    });
    cardEl.appendChild(cancel);
  }
}

async function confirmCalls(calls, onConfirm, onBack) {
  if (calls <= CONFIRM_ABOVE_CALLS) { onConfirm(); return; }
  const { estimate, basis } = await callEstimate(calls);

  cardEl.innerHTML = '';
  cardEl.appendChild(cardHeader());
  cardEl.appendChild(el('div', 'font-size:14px; color:#fff; margin-bottom:8px;', `This needs ${calls} calls.`));
  cardEl.appendChild(el('div', 'font-size:13px; color:#c8d0e8; margin-bottom:4px;', `Estimated time: about ${estimate}.`));
  cardEl.appendChild(el('div', 'font-size:11px; color:#5a6890; margin-bottom:16px;',
    `Estimate ${basis}. You can cancel at any time, keep what finished, and resume later.`));

  const btns = row('flex-start', 'gap:10px;');
  const go = mkBtn('Start', '#9FD8FF', 'rgba(60,108,255,0.2)', 'rgba(60,108,255,0.5)');
  go.style.cssText += 'flex:1; padding:8px 0;';
  go.addEventListener('click', onConfirm);
  const back = mkBtn('Back', '#8090b0', 'none', 'rgba(100,120,200,0.22)');
  back.style.cssText += 'flex:1; padding:8px 0;';
  back.addEventListener('click', onBack);
  btns.appendChild(go);
  btns.appendChild(back);
  cardEl.appendChild(btns);
}

function renderResult(state) {
  cardEl.innerHTML = '';
  const hdr = row('space-between', 'align-items:center; margin-bottom:20px;');
  hdr.appendChild(el('div', 'font-size:16px; font-weight:700; color:#fff;', 'Distill to Inbox'));
  const close = el('button', 'background:none; border:none; color:#8090b0; font-size:18px; cursor:pointer; padding:0 4px;', '✕');
  close.addEventListener('click', closeModal);
  hdr.appendChild(close);
  cardEl.appendChild(hdr);

  if (state.status === 'done') {
    const ok = el('div', 'font-size:14px; color:#6FE3D0; margin-bottom:14px;', '✓ ' + state.message);
    cardEl.appendChild(ok);
    if (state.result?.inboxed?.length) {
      const list = el('div', 'font-size:12px; color:#8090b0; font-family:monospace;');
      list.textContent = state.result.inboxed.join('\n');
      cardEl.appendChild(list);
    }
    if (state.result?.dropped?.length) {
      cardEl.appendChild(el('div', 'font-size:12px; color:#c08050; margin:12px 0 4px;', 'Dropped by checker (staging folder kept):'));
      const dl = el('div', 'font-size:12px; color:#8090b0; font-family:monospace; white-space:pre-line;');
      dl.textContent = state.result.dropped.map(d => `${d.file}: ${d.reason}`).join('\n');
      cardEl.appendChild(dl);
    }
  } else {
    const fail = el('div', 'font-size:13px; color:#c0503a; margin-bottom:14px;', '✗ ' + state.message);
    cardEl.appendChild(fail);
    if (state.result?.remaining > 0) {
      const resume = mkBtn('Resume', '#9FD8FF', 'rgba(60,108,255,0.2)', 'rgba(60,108,255,0.5)');
      resume.style.cssText += 'width:100%; padding:7px 0; font-size:13px;';
      resume.addEventListener('click', () => confirmCalls(state.result.remaining,
        () => postRun(`/api/distill/resume/${state.runId}`, {}, 'Resuming…'), () => renderResult(state)));
      cardEl.appendChild(resume);
    } else {
      cardEl.appendChild(el('div', 'font-size:11px; color:#5a6890;',
        state.status === 'stopped' ? 'Open Import to resume the remaining chunks.' : 'Staging folder kept for inspection.'));
    }
  }

  const again = mkBtn('Run again', '#9FD8FF', 'rgba(60,108,255,0.15)', 'rgba(60,108,255,0.4)');
  again.style.cssText += 'margin-top:16px; width:100%; padding:7px 0; font-size:13px;';
  again.addEventListener('click', openModal);
  cardEl.appendChild(again);
}

// ─── RUN ─────────────────────────────────────────────────────────────────────
async function startRun(agent, fileObjects) {
  renderRunning('Reading files…');

  let files;
  try {
    files = await Promise.all(fileObjects.map(f => readFileAsText(f)));
  } catch (e) {
    renderResult({ status: 'failed', message: `Could not read input files: ${e.message}` });
    return;
  }

  await confirmCalls(callsForFiles(files),
    () => postRun('/api/distill/run', { agent, files }, `Starting ${agent === 'claude' ? 'Claude' : 'Gemini'}…`),
    () => renderIdle(agent, fileObjects));
}

async function postRun(url, body, startingLabel) {
  renderRunning(startingLabel);
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

function watchRun(runId) {
  stopPoll();
  renderRunning('Working…', runId);
  const poll = async () => {
    try {
      const r = await fetch(`/api/distill/status/${runId}`);
      if (r.status === 404) {
        stopPoll();
        renderResult({ status: 'stopped', message: 'The server restarted during the run.' });
        return;
      }
      if (!r.ok) return;
      const state = await r.json();
      if (state.status === 'running' || state.status === 'pending') {
        if (runningLine) runningLine.textContent = '⏳ ' + progressText(state);
      } else {
        stopPoll();
        renderResult(state);
      }
    } catch { /* transient — keep polling */ }
  };
  poll();
  pollTimer = setInterval(poll, 1000);
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve({ name: file.name, content: reader.result });
    reader.onerror = () => reject(new Error(`Cannot read ${file.name}`));
    reader.readAsText(file);
  });
}

// ─── DOM HELPERS ─────────────────────────────────────────────────────────────
function el(tag, css, text) {
  const e = document.createElement(tag);
  if (css)  e.style.cssText = css;
  if (text !== undefined) e.textContent = text;
  return e;
}

function row(justify, extra) {
  return el('div', `display:flex; justify-content:${justify}; ${extra || ''}`);
}

function label(text) {
  cardEl.appendChild(el('div', 'font-size:11px; color:#5a6890; letter-spacing:0.05em; text-transform:uppercase; margin-bottom:6px;', text));
}

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
