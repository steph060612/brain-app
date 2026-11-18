// Thin fetch wrappers for the Brain API.
export async function fetchItems() {
  const r = await fetch('/api/items');
  if (!r.ok) throw new Error(`items fetch failed: ${r.status}`);
  return r.json();
}

// Archive ('archive') or unarchive ('unarchive') a project folder by name. Resolves to { from, to, location };
// rejects with the server's message (a name already used on the other side moves nothing). On success the page's
// labels and list are refreshed through the brain-items-changed event.
export async function moveProject(action, name) {
  const r = await fetch(`/api/projects/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  window.dispatchEvent(new CustomEvent('brain-items-changed'));
  return data;
}

export async function fetchFile(path) {
  const r = await fetch(`/api/file?path=${encodeURIComponent(path)}`);
  if (!r.ok) throw new Error(`file fetch failed: ${r.status}`);
  return r.json(); // { content, hash, mtime, path }
}

export async function saveFile(path, content, hash) {
  const r = await fetch('/api/file', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ path, content, hash }),
  });
  return { status: r.status, data: await r.json() };
}

export async function fetchGitLog() {
  try {
    const r = await fetch('/api/gitlog');
    return r.ok ? r.json() : { lastCommit: null };
  } catch { return { lastCommit: null }; }
}
