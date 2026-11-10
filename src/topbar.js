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

  // Fetch git log once and display
  fetchGitLog().then(({ lastCommit }) => {
    const el = document.getElementById('git-time');
    if (!el) return;
    if (lastCommit) {
      const d = new Date(lastCommit);
      const fmt = d.toLocaleString(undefined, {
        month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit',
      });
      el.textContent = `Last commit ${fmt}`;
    } else {
      el.textContent = '';
    }
  }).catch(() => {});
}

// The setup interview is offered only while the brain has no projects yet.
export function showSetupIfEmpty(items) {
  const btn = document.getElementById('setup-btn');
  if (btn) btn.style.display = items.some(i => i.category === 'projects') ? 'none' : '';
}
