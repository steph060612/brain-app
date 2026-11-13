// Project panel section for code maps: link a code folder, map it, open the diagram, unlink.
import { openCodeMap, closeCodeMap, isCodeMapOpen } from './codemap.js';

let el = null, current = null, info = null, busy = false, linking = false;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const BTN = `padding:4px 10px; background:rgba(60,108,255,0.18); border:1px solid rgba(60,108,255,0.4); color:#9FD8FF;
  border-radius:4px; font-size:12px; cursor:pointer; font-family:inherit; white-space:nowrap;`;
const BTN2 = `padding:4px 10px; background:rgba(255,255,255,0.04); border:1px solid rgba(100,120,200,0.25); color:#9FD8FF;
  border-radius:4px; font-size:12px; cursor:pointer; font-family:inherit; white-space:nowrap;`;
const LINK = 'background:none; border:none; padding:0; color:#9FD8FF; font-size:12px; cursor:pointer; font-family:inherit; text-decoration:underline; text-underline-offset:2px; text-decoration-color:rgba(159,216,255,0.35);';
const MUTED = 'font-size:11px; color:#5a6890;';

export function createCodeSection() {
  el = document.createElement('div');
  el.id = 'code-row';
  el.style.cssText = 'display:none; margin:-4px 0 12px; font-size:12px; color:#8090b0;';
  return el;
}

// project: { slug, name } for a project or archive item, or null to hide the section.
export function showCodeSection(project) {
  current = project;
  linking = false;
  info = null;
  if (!project) { el.style.display = 'none'; el.innerHTML = ''; return; }
  el.style.display = 'block';
  el.innerHTML = `<span style="${MUTED}">Code folder…</span>`;
  refresh();
}

async function api(method, path, body) {
  const r = await fetch(`/api/code/${encodeURIComponent(current.slug)}${path}`, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}

async function refresh() {
  const slug = current?.slug;
  try {
    const d = await api('GET', '');
    if (current?.slug !== slug) return;
    info = d;
    render();
    if (d.folder && d.map) loadStatus();
  } catch (e) {
    if (current?.slug === slug) el.innerHTML = `<span style="color:#c0503a">${esc(e.message)}</span>`;
  }
}

const fmtWhen = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

function render(message = '', color = '#8090b0') {
  if (!current || !info) return;
  if (!info.folder) return renderUnlinked(message, color);

  const missing = !info.folderExists;
  el.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
      ${info.map
        ? `<button class="cm-open" style="${BTN}">View map</button><button class="cm-run" style="${BTN2}">Re-map</button>`
        : `<button class="cm-run" style="${BTN}">Map project</button>`}
    </div>
    ${info.map ? `<div style="${MUTED} margin-top:6px">Last mapped ${esc(fmtWhen(info.map.generatedAt))}</div>
      <div class="cm-status" style="${MUTED}"></div>` : ''}
    ${info.mapError ? `<div style="font-size:11px; color:#e08040; margin-top:6px">${esc(info.mapError)}</div>` : ''}
    <div style="${MUTED} margin-top:4px; display:flex; gap:8px; align-items:baseline; flex-wrap:wrap">
      <span title="${esc(info.folder)}" style="color:${missing ? '#e08040' : '#5a6890'}">Code: ${esc(info.display)}${missing ? ' (folder not found)' : ''}</span>
      <button class="cm-unlink" style="${LINK} font-size:11px; color:#8090b0">Unlink</button>
    </div>
    <div class="cm-msg" style="font-size:11.5px; margin-top:5px; color:${color}">${esc(message)}</div>`;
  el.querySelector('.cm-run').addEventListener('click', runMap);
  el.querySelector('.cm-open')?.addEventListener('click', () => showMap());
  el.querySelector('.cm-unlink').addEventListener('click', unlink);
  if (busy) setBusy(true);
}

function renderUnlinked(message, color) {
  if (!linking) {
    el.innerHTML = `<button class="cm-link" style="${LINK}">Link code folder</button>
      <div class="cm-msg" style="font-size:11.5px; margin-top:5px; color:${color}">${esc(message)}</div>`;
    el.querySelector('.cm-link').addEventListener('click', () => { linking = true; renderUnlinked('', '#8090b0'); loadSuggestions(); });
    return;
  }
  el.innerHTML = `
    <div style="border:1px solid rgba(100,120,200,0.18); border-radius:6px; padding:9px 10px;">
      <div style="${MUTED} margin-bottom:5px">Suggested folders</div>
      <div class="cm-sugg" style="display:flex; flex-direction:column; gap:3px; margin-bottom:8px"><span style="${MUTED}">Looking…</span></div>
      <div style="${MUTED} margin-bottom:4px">Or type a path</div>
      <div style="display:flex; gap:6px">
        <input class="cm-path" type="text" placeholder="~/Projects/my-app" spellcheck="false" style="flex:1; min-width:0; background:#0d1020; color:#c8d0e8;
          border:1px solid rgba(100,120,200,0.25); border-radius:4px; padding:4px 8px; font-size:12px; font-family:inherit; outline:none;" />
        <button class="cm-go" style="${BTN}">Link</button>
      </div>
      <div style="display:flex; align-items:baseline; margin-top:6px">
        <div class="cm-msg" style="font-size:11.5px; color:${color}; flex:1">${esc(message)}</div>
        <button class="cm-cancel" style="${LINK} font-size:11px; color:#8090b0">Cancel</button>
      </div>
    </div>`;
  const input = el.querySelector('.cm-path');
  el.querySelector('.cm-go').addEventListener('click', () => link(input.value));
  input.addEventListener('keydown', e => { if (e.key === 'Enter') link(input.value); });
  el.querySelector('.cm-cancel').addEventListener('click', () => { linking = false; renderUnlinked('', '#8090b0'); });
}

async function loadSuggestions() {
  const slug = current.slug;
  try {
    const r = await fetch(`/api/code/${encodeURIComponent(slug)}/suggestions?name=${encodeURIComponent(current.name || '')}`);
    const { suggestions = [] } = await r.json();
    const box = el.querySelector('.cm-sugg');
    if (!box || current?.slug !== slug) return;
    box.innerHTML = suggestions.length
      ? suggestions.map((s, i) => `<button data-i="${i}" title="${esc(s.path)}" style="${LINK} text-align:left; text-decoration:none">
          ${esc(s.display)}<span style="color:#5a6890">${s.hasGit ? ' · git' : ''}${s.hasPackageJson ? ' · package.json' : ''}</span></button>`).join('')
      : `<span style="${MUTED}">No folder in your home folder has a similar name.</span>`;
    for (const b of box.querySelectorAll('button')) b.addEventListener('click', () => link(suggestions[Number(b.dataset.i)].path));
  } catch { /* typing a path still works */ }
}

function setMsg(text, color = '#8090b0') {
  const m = el.querySelector('.cm-msg');
  if (m) { m.textContent = text; m.style.color = color; }
}

async function link(folder) {
  if (!folder?.trim()) return setMsg('Type a folder path.', '#e08040');
  setMsg('Linking…');
  try {
    await api('POST', '/link', { folder });
    linking = false;
    await refresh();
  } catch (e) { setMsg(e.message, '#c0503a'); }
}

async function unlink() {
  try {
    await api('DELETE', '/link');
    if (isCodeMapOpen()) closeCodeMap();
    linking = false;
    await refresh();
    render('Unlinked. The saved map stays until this project is mapped again.');
  } catch (e) { setMsg(e.message, '#c0503a'); }
}

function setBusy(on) {
  busy = on;
  for (const b of el.querySelectorAll('button')) b.disabled = on;
  const run = el.querySelector('.cm-run');
  if (run && on) run.textContent = 'Mapping…';
}

async function runMap() {
  const slug = current.slug;
  setBusy(true);
  setMsg('Mapping the code folder (up to 60 seconds)…');
  try {
    const d = await api('POST', '/map');
    busy = false;
    if (current?.slug !== slug) return;
    await refresh();
    const c = d.map.counts;
    render(`Mapped ${c.nodesByKind?.file ?? c.nodes} files in ${(d.elapsedMs / 1000).toFixed(1)} s.`, '#6FE3D0');
    loadStatus();
    showMap();
  } catch (e) {
    busy = false;
    if (current?.slug !== slug) return;
    render(e.message, '#c0503a');
  }
}

async function showMap() {
  try {
    await openCodeMap({ slug: current.slug, name: current.name });
  } catch (e) { setMsg(e.message, '#c0503a'); }
}

async function loadStatus() {
  const slug = current.slug;
  try {
    const s = await api('GET', '/status');
    const box = el.querySelector('.cm-status');
    if (!box || current?.slug !== slug) return;
    if (s.state === 'current') { box.textContent = 'Map is current'; box.style.color = '#6FE3D0'; }
    else if (s.state === 'other-folder') { box.textContent = `Map was made from ${s.mappedFolder}; re-map for this folder`; box.style.color = '#e0a040'; }
    else {
      box.textContent = s.diffUnavailable && !s.changedFiles ? 'Code changed since last map' : `Code changed since last map (${s.changedFiles} file${s.changedFiles === 1 ? '' : 's'})`;
      box.style.color = '#e0a040';
    }
    box.title = s.method === 'git' ? `Mapped at ${s.mapCommit?.slice(0, 7) ?? 'no commit'}, now ${s.currentCommit?.slice(0, 7)}; ${s.uncommittedSourceFiles} uncommitted source files` : 'Compared by modification time (not a git repository)';
  } catch (e) {
    const box = el.querySelector('.cm-status');
    if (box) { box.textContent = e.message; box.style.color = '#e08040'; }
  }
}
