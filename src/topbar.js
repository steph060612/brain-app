// Top bar: search input + last git commit time.
import { fetchGitLog } from './api.js';
import { setSearchQuery } from './labels.js';

export function initTopbar() {
  const bar = document.getElementById('topbar');
  if (!bar) return;

  const input = document.getElementById('search-input');
  if (input) {
    input.addEventListener('input', () => setSearchQuery(input.value));
  }

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
