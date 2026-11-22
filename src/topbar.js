// Top bar: Search, List, Inbox, the setup step that applies now, and a More menu with everything else.
// Setup buttons, in order: Connect Claude Code, Find my projects (while the brain has no projects), Start interview
// (while profile.md has only a name). Only the first that applies is in the bar, plus "Update Claude Code connection"
// when an existing connection is outdated, so never more than two. The others that apply are in the More menu, with
// Copy setup interview, the Claude Code connection, Copy general pack, Copy close-session prompt, Distill and Import
// (src/distill.js and src/import.js add theirs to #more-items), and the last commit time.
import { fetchGitLog } from './api.js';
import { setSearchQuery } from './labels.js';
import { setListQuery } from './list.js';
import { packButton, textCopyButton } from './pack.js';
import { initClaudeConnect, openConnection } from './claude-connect-ui.js';
import { findProjectsButton } from './find-projects-ui.js';
import { initInterview, interviewButton } from './interview-ui.js';

const CLOSE_SESSION_PROMPT = 'Close session: output proposed changes for my brain in the UPDATE PROTOCOL format from README.md (### FILE, ### ACTION, content; OLD and NEW lines for replace-line), all inside one code block. Include only facts I stated or confirmed in this chat. Nothing is saved until I approve.';
const SETUP_BTN = `padding:5px 14px; background:rgba(60,108,255,0.22); border:1px solid rgba(60,108,255,0.5); color:#9FD8FF;
  border-radius:4px; font-size:12px; cursor:pointer; font-family:inherit; white-space:nowrap; font-weight:600;`;

const setup = { connect: 'none', noProjects: false, interview: false };
let bar = {}, menu = {};

export function initTopbar() {
  const topbar = document.getElementById('topbar');
  if (!topbar) return;

  const input = document.getElementById('search-input');
  if (input) {
    input.addEventListener('input', () => { setSearchQuery(input.value); setListQuery(input.value); });
  }

  // Setup slot in the bar (Inbox is added before it by src/inbox.js, List after the search box by src/list.js).
  const slot = document.getElementById('topbar-setup');
  bar = { connect: initClaudeConnect(), find: findProjectsButton({ prominent: true }), interview: interviewButton(SETUP_BTN) };
  bar.find.id = 'find-btn';
  bar.interview.id = 'interview-btn';
  for (const el of Object.values(bar)) { el.style.display = 'none'; slot.appendChild(el); }

  // More menu: in <body>, because the bar's backdrop blur would clip a dropdown inside it.
  const moreBtn = document.getElementById('more-btn');
  const panel = document.createElement('div');
  panel.id = 'more-menu';
  panel.hidden = true;
  panel.setAttribute('role', 'menu');
  const gitTime = document.createElement('div');
  gitTime.id = 'git-time';
  gitTime.className = 'more-info';
  const setupBox = document.createElement('div');
  setupBox.id = 'more-setup';
  const items = document.createElement('div');
  items.id = 'more-items';
  panel.append(gitTime, setupBox, items);
  document.body.appendChild(panel);

  const setupCopy = packButton({ label: 'Copy setup interview', hint: 'first session, fills an empty brain', body: () => ({ mode: 'setup' }) });
  setupCopy.id = 'setup-btn';
  const connection = document.createElement('button');
  connection.textContent = 'Claude Code connection';
  connection.title = 'See, update or remove the Claude Code connection.';
  connection.addEventListener('click', openConnection);
  menu = { find: findProjectsButton(), interview: interviewButton(''), setupCopy, connection };
  for (const el of Object.values(menu)) { el.style.display = 'none'; setupBox.appendChild(el); }
  setupCopy.dataset.keepOpen = '1';

  const general = packButton({ label: 'Copy general pack', hint: 'new chat, no project yet', body: () => ({ mode: 'general' }) });
  const closeSession = textCopyButton({ label: 'Copy close-session prompt', text: CLOSE_SESSION_PROMPT });
  general.dataset.keepOpen = closeSession.dataset.keepOpen = '1';
  items.append(general, closeSession);

  const show = open => { panel.hidden = !open; moreBtn.setAttribute('aria-expanded', String(open)); if (open) refreshGitStatus(); };
  moreBtn.addEventListener('click', e => { e.stopPropagation(); show(panel.hidden); });
  // A copy button stays open to show "Copied"; anything that opens a window closes the menu.
  panel.addEventListener('click', e => { const b = e.target.closest('button'); if (b && !b.dataset.keepOpen) show(false); });
  document.addEventListener('click', e => { if (!panel.hidden && !panel.contains(e.target)) show(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !panel.hidden) show(false); });

  window.addEventListener('brain-setup', e => { Object.assign(setup, e.detail); renderSetup(); });
  initInterview();
  renderSetup();

  // Last commit time, and a failing automatic save as a banner under the bar. Refreshed when the window comes back
  // into view and every 5 minutes, so a backup that starts failing while the app is open still shows up.
  refreshGitStatus();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshGitStatus(); });
  setInterval(refreshGitStatus, 5 * 60_000);
}

// Which setup buttons are in the bar and which in the More menu.
function renderSetup() {
  if (!bar.connect) return;
  const applies = { connect: setup.connect === 'connect', find: setup.noProjects, interview: setup.interview };
  const first = ['connect', 'find', 'interview'].find(k => applies[k]);
  const inBar = { connect: first === 'connect' || setup.connect === 'update', find: first === 'find', interview: first === 'interview' };
  for (const k of ['connect', 'find', 'interview']) bar[k].style.display = inBar[k] ? '' : 'none';
  menu.find.style.display = applies.find && !inBar.find ? '' : 'none';
  menu.interview.style.display = applies.interview && !inBar.interview ? '' : 'none';
  menu.setupCopy.style.display = setup.noProjects ? '' : 'none';
  menu.connection.style.display = setup.connect === 'current' ? '' : 'none';
}

const fmtTime = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function refreshGitStatus() {
  fetchGitLog().then(({ lastCommit, backupProblem }) => {
    const el = document.getElementById('git-time');
    if (el) el.textContent = lastCommit ? `Last commit ${fmtTime(lastCommit)}` : 'No commit yet';
    showBackupProblem(backupProblem);
  }).catch(() => {});
}

// A red banner under the top bar while the last automatic save failed; gone once a save succeeds again.
function showBackupProblem(problem) {
  let banner = document.getElementById('backup-alert');
  if (!problem) { banner?.remove(); return; }
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'backup-alert';
    banner.setAttribute('role', 'alert');
    document.body.appendChild(banner);
  }
  const since = problem.since ? ` since ${fmtTime(problem.since)}` : '';
  banner.replaceChildren();
  const title = document.createElement('strong');
  title.textContent = `Your brain is not being saved: automatic saves have failed${since}.`;
  const detail = document.createElement('div');
  detail.className = 'backup-alert-detail';
  detail.textContent = problem.message || 'No details were recorded.';
  const where = document.createElement('div');
  where.className = 'backup-alert-where';
  where.textContent = 'Full history: ~/.brain/autocommit.log. This message goes away after the next save that works.';
  banner.append(title, detail, where);
}

// Find my projects and Copy setup interview are offered only while the brain has no projects yet.
export function showSetupIfEmpty(items) {
  window.dispatchEvent(new CustomEvent('brain-setup', { detail: { noProjects: !items.some(i => i.category === 'projects') } }));
}
