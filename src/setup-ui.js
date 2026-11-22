// "Set up your brain": a chooser with two paths, Start from scratch and Import what I already have. It only offers
// existing buttons, each doing exactly what it does elsewhere. Opening it writes nothing and nothing about the choice
// is saved: it can be reopened from the top bar (while the brain is not set up) or from More (always), and the other
// path used later. The top bar (src/topbar.js) places the buttons and passes the current setup state.
import { openFindProjects, openNewProject } from './find-projects-ui.js';
import { interviewButton } from './interview-ui.js';
import { packButton } from './pack.js';
import { openModal as openImport } from './import.js';

const BTN = `padding:5px 12px; background:rgba(60,108,255,0.22); border:1px solid rgba(60,108,255,0.5); color:#cfe6ff;
  border-radius:5px; font-size:12.5px; cursor:pointer; font-family:inherit; white-space:nowrap;`;
const BTN2 = `padding:4px 10px; background:rgba(255,255,255,0.04); border:1px solid rgba(100,120,200,0.25); color:#9FD8FF;
  border-radius:4px; font-size:12px; cursor:pointer; font-family:inherit; white-space:nowrap;`;
const MUTED = 'font-size:11.5px; color:#6a78a0;';

let overlay = null;

// A "Set up your brain" button; style is the caller's. getState() returns { claude, profileEmpty }.
export function setupBrainButton(style, getState) {
  const b = document.createElement('button');
  b.textContent = 'Set up your brain';
  b.title = 'Start from scratch, or import what you already have. Nothing is saved until you approve it in the Inbox.';
  b.style.cssText = style;
  b.addEventListener('click', () => openSetup(getState()));
  return b;
}

function close() { overlay?.remove(); overlay = null; }

function button(label, onClick, style = BTN) {
  const b = document.createElement('button');
  b.textContent = label;
  b.style.cssText = style;
  b.addEventListener('click', onClick);
  return b;
}

function section(title, line, buttons, note) {
  const s = document.createElement('div');
  s.style.cssText = 'margin-top:12px; padding:12px 14px; border:1px solid rgba(100,120,200,0.22); border-radius:6px; background:rgba(255,255,255,0.02);';
  const h = document.createElement('div');
  h.style.cssText = 'font-size:13.5px; font-weight:700; color:#fff;';
  h.textContent = title;
  const p = document.createElement('div');
  p.style.cssText = 'margin-top:3px;';
  p.textContent = line;
  const row = document.createElement('div');
  row.style.cssText = 'display:flex; gap:8px; margin-top:10px; flex-wrap:wrap; align-items:center;';
  row.append(...buttons);
  s.append(h, p, row);
  if (note) { const n = document.createElement('div'); n.style.cssText = `margin-top:6px; ${MUTED}`; n.textContent = note; s.appendChild(n); }
  return s;
}

export function openSetup({ claude = false, profileEmpty = false } = {}) {
  close();
  overlay = document.createElement('div');
  overlay.id = 'setup-chooser';
  overlay.style.cssText = 'position:fixed; inset:0; z-index:200; background:rgba(5,7,15,0.6); display:flex; align-items:flex-start; justify-content:center; padding:70px 16px 16px; overflow:auto;';
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const box = document.createElement('div');
  box.style.cssText = 'width:min(600px,100%); font-family:system-ui,-apple-system,sans-serif; background:#12162a; border:1px solid rgba(100,120,200,0.3); border-radius:8px; padding:16px 18px; font-size:12.5px; color:#c8d0e8; line-height:1.5;';
  overlay.appendChild(box);

  const head = document.createElement('div');
  head.style.cssText = 'font-size:15px; font-weight:700; color:#fff;';
  head.textContent = 'Set up your brain';
  const sub = document.createElement('div');
  sub.style.cssText = `margin-top:2px; ${MUTED}`;
  sub.textContent = 'Pick either way; you can come back here from More and use the other one later. Everything goes to the Inbox first.';

  // Start from scratch: New project, plus the interview. Start interview launches Claude Code, so without Claude Code
  // it is Copy setup interview (the same pack as in More).
  const scratch = [button('New project', () => { close(); openNewProject(); })];
  let note = '';
  if (claude) {
    const iv = interviewButton(BTN);
    iv.addEventListener('click', () => setTimeout(close, 300)); // the copied-command hint shows at the bottom of the page
    if (!profileEmpty) { iv.disabled = true; iv.style.opacity = '0.45'; iv.style.cursor = 'not-allowed'; note = 'Start interview is for a new brain: your profile or preferences already have content.'; }
    scratch.push(iv);
  } else {
    scratch.push(packButton({ label: 'Copy setup interview', hint: 'paste into a new chat with your assistant', body: () => ({ mode: 'setup' }) }));
  }

  const imports = [
    button('Find my projects', () => { close(); openFindProjects(); }),
    button('Import chat exports', () => { close(); openImport(); }),
  ];

  const foot = document.createElement('div');
  foot.style.cssText = 'display:flex; justify-content:flex-end; margin-top:14px;';
  foot.appendChild(button('Close', close, BTN2));

  box.append(head, sub,
    section('Start from scratch', 'For people with little or nothing yet: add a project by name, or answer a few questions about yourself.', scratch, note),
    section('Import what I already have', 'Choose this if you have used Claude Code or other assistants for a while: draft entries from your code projects, or from Claude, ChatGPT or Gemini chat exports.', imports),
    foot);
  document.body.appendChild(overlay);
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });
}
