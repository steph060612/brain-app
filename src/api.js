// Thin fetch wrappers for the Brain API.
export async function fetchItems() {
  const r = await fetch('/api/items');
  if (!r.ok) throw new Error(`items fetch failed: ${r.status}`);
  return r.json();
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
