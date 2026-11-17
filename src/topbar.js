// Top bar: search input + last git commit time.
import { fetchGitLog } from './api.js';
import { setSearchQuery } from './labels.js';
import { setListQuery } from './list.js';
import { packButton, textCopyButton } from './pack.js';

const CLOSE_SESSION_PROMPT = 'Close session: output proposed changes for my brain in the UPDATE PROTOCOL format from README.md (### FILE, ### ACTION, content; OLD and NEW lines for replace-line), all inside one code block. Include only facts I stated or confirmed in this chat. Nothing is saved until I approve.';

export function initTopbar() {
  const bar = document.getElementById('topbar');
  if (!bar) return;

  const input = document.getElementById('search-input');
  if (input) {
    input.addEventListener('input', () => { setSearchQuery(input.value); setListQuery(input.value); });
  }

  const gitTime = document.getElementById('git-time');
  gitTime?.parentNode.insertBefore(packButton({
    label: 'Copy general pack',
    hint: 'new chat, no project yet',
    body: () => ({ mode: 'general' }),
  }), gitTime);
  const setupBtn = packButton({
    label: 'Copy setup interview',
    hint: 'first session, fills an empty brain',
    body: () => ({ mode: 'setup' }),
  });
  setupBtn.id = 'setup-btn';
  setupBtn.style.display = 'none';
  gitTime?.parentNode.insertBefore(setupBtn, gitTime);
  gitTime?.parentNode.insertBefore(textCopyButton({
    label: 'Copy close-session prompt',
    text: CLOSE_SESSION_PROMPT,
  }), gitTime);

  // Last commit time, and a failing automatic save as a banner under the bar. Refreshed when the window comes back
  // into view and every 5 minutes, so a backup that starts failing while the app is open still shows up.
  refreshGitStatus();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshGitStatus(); });
  setInterval(refreshGitStatus, 5 * 60_000);
}

const fmtTime = iso => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function refreshGitStatus() {
  fetchGitLog().then(({ lastCommit, backupProblem }) => {
    const el = document.getElementById('git-time');
    if (el) el.textContent = lastCommit ? `Last commit ${fmtTime(lastCommit)}` : '';
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

// The setup interview is offered only while the brain has no projects yet.
export function showSetupIfEmpty(items) {
  const btn = document.getElementById('setup-btn');
  if (btn) btn.style.display = items.some(i => i.category === 'projects') ? 'none' : '';
}
