// "Start interview": offered while the brain is new (profile.md has at most a name, preferences.md empty).
// Copies one Terminal command that starts Claude Code in the brain folder with the interview prompt.
// Polls the inbox after the command is copied so the badge updates as proposals arrive.
// Whether it is offered is reported to the top bar as a 'brain-setup' event ({ interview: true|false }); the top bar
// decides where the button shows (src/topbar.js).
import { refreshInboxCount } from './inbox.js';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let pollTimer = null;

async function fetchStatus() {
  const r = await fetch('/api/interview-status');
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function prepareInterview() {
  const r = await fetch('/api/interview/prepare', { method: 'POST' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data; // { command }
}

export function initInterview() {
  checkEligibility();
  window.addEventListener('brain-items-changed', checkEligibility);
}

export async function checkEligibility() {
  try {
    const { eligible } = await fetchStatus();
    window.dispatchEvent(new CustomEvent('brain-setup', { detail: { interview: !!eligible } }));
  } catch { /* non-fatal: the offer stays as it was */ }
}

// A Start interview button; style is the caller's.
export function interviewButton(style) {
  const btn = document.createElement('button');
  btn.style.cssText = style;
  btn.textContent = 'Start interview';
  btn.title = 'Starts a guided interview in Terminal — Claude Code asks 5 questions and writes proposals to your Inbox.';
  btn.addEventListener('click', () => onClickInterview(btn));
  return btn;
}

async function onClickInterview(btn) {
  btn.disabled = true;
  btn.textContent = 'Preparing…';
  try {
    const { command } = await prepareInterview();
    try { await navigator.clipboard.writeText(command); } catch { /* clipboard may be denied; command shown in hint */ }
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.textContent = 'Start interview'; btn.disabled = false; }, 2500);
    showCopiedHint(command);
    startPolling();
  } catch (e) {
    btn.textContent = 'Failed';
    btn.title = e.message;
    setTimeout(() => { btn.textContent = 'Start interview'; btn.disabled = false; }, 2500);
  }
}

function showCopiedHint(command) {
  document.getElementById('interview-hint')?.remove();
  const hint = document.createElement('div');
  hint.id = 'interview-hint';
  hint.style.cssText = `
    position:fixed; bottom:24px; left:50%; transform:translateX(-50%);
    background:#12162a; border:1px solid rgba(60,108,255,0.4); border-radius:8px;
    padding:14px 18px 14px 18px; font-size:13px; color:#c8d0e8; width:min(480px,90vw);
    z-index:100; line-height:1.5; box-shadow:0 4px 24px rgba(0,0,0,0.5);
  `;
  hint.innerHTML = `
    <button id="interview-hint-close" style="position:absolute; top:8px; right:10px; background:none;
      border:none; color:#5a6890; font-size:16px; cursor:pointer; padding:2px 6px;">✕</button>
    <div style="font-weight:600; color:#9FD8FF; margin-bottom:6px;">Command copied — paste it in Terminal</div>
    <div style="font-family:monospace; font-size:11px; color:#8090b0; word-break:break-all;
      background:#0b0e1c; border:1px solid rgba(100,120,200,0.15); border-radius:4px;
      padding:6px 8px; margin-bottom:8px; user-select:all">${esc(command)}</div>
    <div>Claude Code will ask you 5 questions and write proposals to your Inbox. The Inbox badge updates as they arrive.</div>
  `;
  document.body.appendChild(hint);
  hint.querySelector('#interview-hint-close').addEventListener('click', () => hint.remove());
  setTimeout(() => hint.remove(), 45_000);
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  let elapsed = 0;
  pollTimer = setInterval(() => {
    elapsed += 30;
    if (elapsed > 15 * 60) { clearInterval(pollTimer); pollTimer = null; return; }
    refreshInboxCount();
  }, 30_000);
}
