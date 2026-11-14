// Project panel section for code maps: link a code folder, map it, open the diagram, unlink.
import { openCodeMap, closeCodeMap, isCodeMapOpen } from './codemap.js';

let el = null, current = null, info = null, busy = false, linking = false;
const autoRemapped = new Set();
let agents = null, agentsConfirm = null; // assistants block preview; 'enable' | 'remove' while asking
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
  info = null; agents = null; agentsConfirm = null;
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
    // A map in an older format is re-made once, automatically, when the linked folder is there.
    if (d.mapOutdated && d.folderExists && !busy && !autoRemapped.has(slug)) { autoRemapped.add(slug); runMap('The map was in an older format; re-mapping…'); return; }
    if (d.folder && d.map) loadStatus();
    if (d.folder && d.folderExists) loadAgents();
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
    <div class="cm-agents" style="margin-top:6px"></div>
    <div class="cm-msg" style="font-size:11.5px; margin-top:5px; color:${color}">${esc(message)}</div>`;
  renderAgents();
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

async function runMap(note) {
  const slug = current.slug;
  setBusy(true);
  setMsg(typeof note === 'string' ? note : 'Mapping the code folder (up to 60 seconds)…');
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

// ─── "Enable for assistants": a marked block in the project's AGENTS.md or CLAUDE.md ───────────────────
async function loadAgents() {
  const slug = current.slug;
  try {
    const a = await api('GET', '/assistants');
    if (current?.slug !== slug) return;
    agents = a;
  } catch (e) {
    if (current?.slug !== slug) return;
    agents = { error: e.message };
  }
  renderAgents();
}

const ACTION_TEXT = {
  create: 'does not exist; it is created with the text below (marked as created by the app, so Remove deletes it again if nothing else is added).',
  add: 'exists; the text below is added at the end. Nothing else in the file changes, and Remove will never delete this file.',
  update: 'already has a brainmap block in older wording; it is replaced in place by the text below.',
  current: 'already has the current block; nothing changes.',
  skip: 'does not exist and is not created, because the other file exists.',
};

function renderAgents() {
  const box = el?.querySelector('.cm-agents');
  if (!box) return;
  if (!agents) { box.innerHTML = ''; return; }
  if (agents.error) { box.innerHTML = `<div style="${MUTED}">Assistants: ${esc(agents.error)}</div>`; return; }
  const files = agents.files || [];
  const pre = text => `<pre style="margin:4px 0 0; padding:7px 8px; background:#0b0e1c; border:1px solid rgba(100,120,200,0.15); border-radius:4px; font-size:10.5px;
    line-height:1.45; color:#a8b4d4; white-space:pre-wrap; word-break:break-word; max-height:200px; overflow:auto">${esc(text)}</pre>`;
  if (agentsConfirm) {
    const enable = agentsConfirm === 'enable';
    const rows = files.map(f => {
      if (f.action === 'shared') return `<div style="margin-top:6px"><b>${esc(f.name)}</b> is a link to ${esc(f.sharedWith)}, so it gets the block once, through that file.</div>`;
      if (enable) return `<div style="margin-top:6px"><b>${esc(f.path)}</b> ${esc(ACTION_TEXT[f.action] || '')}${f.text ? pre(f.text) : ''}</div>`;
      if (!f.enabled) return '';
      return `<div style="margin-top:6px"><b>${esc(f.path)}</b>: the marked brainmap block is removed. ${f.removeDeletes
        ? 'The app created this file and nothing else is in it, so the file is deleted.'
        : f.removeLeavesEmpty ? 'The file existed before the block was added, so it is kept, even though it will be empty.'
        : 'The rest of the file stays as it is.'}</div>`;
    }).join('');
    const changing = files.filter(f => ['create', 'add', 'update'].includes(f.action)).map(f => f.name);
    const okLabel = enable ? `Write to ${changing.join(' and ')}` : `Remove from ${files.filter(f => f.enabled && f.action !== 'shared').map(f => f.name).join(' and ')}`;
    box.innerHTML = `<div style="border:1px solid rgba(100,120,200,0.22); border-radius:6px; padding:8px 10px; font-size:11.5px; color:#c8d0e8;">
        <div>${enable ? 'Claude Code reads CLAUDE.md by itself and other assistants read AGENTS.md, so the block goes into each.' : 'Only the marked block is taken out.'} Nothing is committed.</div>
        ${rows}
        <div style="display:flex; gap:6px; align-items:center; margin-top:8px">
          <button class="cm-agents-ok" style="${BTN}">${esc(okLabel)}</button>
          <button class="cm-agents-cancel" style="${BTN2}">Cancel</button>
        </div></div>`;
    box.querySelector('.cm-agents-ok').addEventListener('click', () => (enable ? enableAgents() : removeAgents()));
    box.querySelector('.cm-agents-cancel').addEventListener('click', () => { agentsConfirm = null; renderAgents(); });
    return;
  }
  const inFiles = files.filter(f => f.enabled && f.action !== 'shared').map(f => f.name);
  box.innerHTML = agents.enabled
    ? `<div style="${MUTED} display:flex; gap:8px; align-items:baseline; flex-wrap:wrap">
        <span style="color:${agents.upToDate ? '#6FE3D0' : '#e0a040'}">${agents.upToDate ? 'Enabled for assistants' : 'Assistants block needs an update'}</span>
        <span>in ${esc(inFiles.join(' and '))}</span>
        ${agents.upToDate ? '' : `<button class="cm-agents-enable" style="${LINK} font-size:11px">Update</button>`}
        <button class="cm-agents-remove" style="${LINK} font-size:11px; color:#8090b0">Remove</button></div>`
    : `<button class="cm-agents-enable" style="${BTN2}" title="Adds a short block to the project's CLAUDE.md and AGENTS.md that tells coding assistants to use the brainmap command">Enable for assistants</button>`;
  box.querySelector('.cm-agents-enable')?.addEventListener('click', () => askAgents('enable'));
  box.querySelector('.cm-agents-remove')?.addEventListener('click', () => askAgents('remove'));
}

// Always show what is on disk right now before asking.
async function askAgents(kind) {
  await loadAgents();
  if (agents?.error) return;
  agentsConfirm = kind;
  renderAgents();
}

const VERB = { create: 'created', add: 'added to', update: 'updated in' };
async function enableAgents() {
  try {
    const r = await api('POST', '/assistants', { expect: agents.expect });
    agentsConfirm = null;
    await loadAgents();
    setMsg(r.files.length ? `Block ${r.files.map(f => `${VERB[f.action]} ${f.file}`).join(', ')}.` : 'Already up to date.', '#6FE3D0');
  } catch (e) { agentsConfirm = null; await loadAgents(); setMsg(e.message, '#c0503a'); }
}

async function removeAgents() {
  try {
    const r = await api('DELETE', '/assistants', { expect: agents.expect });
    agentsConfirm = null;
    await loadAgents();
    setMsg(r.files.length ? r.files.map(f => (f.deleted ? `${f.file} deleted (the app had created it)`
      : f.leftEmpty ? `block removed from ${f.file} (kept, now empty)` : `block removed from ${f.file}`)).join('; ') + '.' : 'The block was already gone.', '#6FE3D0');
  } catch (e) { agentsConfirm = null; await loadAgents(); setMsg(e.message, '#c0503a'); }
}
