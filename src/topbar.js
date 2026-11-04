// Top bar: search input + last git commit time.
import { fetchGitLog } from './api.js';
import { setSearchQuery } from './labels.js';
import { setListQuery } from './list.js';
import { packButton } from './pack.js';

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
