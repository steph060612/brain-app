// Project panel section for code maps: link one or more code folders (each with a short name and its own
// "Map is current" status), map them into one map, open the diagram, remove a folder.
import { openCodeMap, closeCodeMap, isCodeMapOpen } from './codemap.js';

let el = null, current = null, info = null, busy = false, linking = false, status = null;
const autoRemapped = new Set();
let agents = null, agentsConfirm = null; // assistants block preview; 'enable' | 'remove' while asking
let strict = null, strictConfirm = null;  // strict-mode hook preview; 'enable' | 'remove' while asking
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
  info = null; status = null; agents = null; agentsConfirm = null; strict = null; strictConfirm = null;
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
    if (d.folders.length && d.map) loadStatus();
    if (d.folders.length && d.folderExists) loadAgents();
  } catch (e) {
    if (current?.slug === slug) el.innerHTML = `<span style="color:#c0503a">${esc(e.message)}</span>`;
  }
}

const fmtWhen = iso => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const STATE_TEXT = {
  current: ['Map is current', '#6FE3D0'],
  'not-mapped': ['Not in the map yet; re-map', '#e0a040'],
  missing: ['Folder not found', '#e08040'],
};
function folderStatus(name) {
  const f = status?.folders?.find(x => x.name === name);
  if (!f) return null;
  if (STATE_TEXT[f.state]) return STATE_TEXT[f.state];
  if (f.state === 'other-folder') return [`Map was made from ${f.mappedFolder}; re-map`, '#e0a040'];
  return [f.diffUnavailable && !f.changedFiles ? 'Code changed since last map' : `Code changed since last map (${f.changedFiles} file${f.changedFiles === 1 ? '' : 's'})`, '#e0a040'];
}

function render(message = '', color = '#8090b0') {
  if (!current || !info) return;
  if (!info.folders.length) return renderUnlinked(message, color);

  const several = info.folders.length > 1;
  const rows = info.folders.map(f => {
    const st = info.map ? folderStatus(f.name) : null;
    const s = !f.exists ? ['Folder not found', '#e08040'] : st;
    const row = status?.folders?.find(x => x.name === f.name);
    const title = row?.method === 'git' ? `Mapped at ${row.mapCommit?.slice(0, 7) ?? 'no commit'}, now ${row.currentCommit?.slice(0, 7)}; ${row.uncommittedSourceFiles} uncommitted source files` : row?.method === 'mtime' ? 'Compared by modification time (not a git repository)' : '';
    return `<div style="display:flex; gap:8px; align-items:baseline; flex-wrap:wrap; margin-top:3px">
        <span style="color:#c8d0e8; min-width:44px">${esc(f.name)}</span>
        <span title="${esc(f.path)}" style="color:#5a6890">${esc(f.display)}</span>
        ${s ? `<span class="cm-fstatus" title="${esc(title)}" style="font-size:11px; color:${s[1]}">${esc(s[0])}</span>` : ''}
        <button class="cm-unlink" data-name="${esc(f.name)}" style="${LINK} font-size:11px; color:#8090b0; margin-left:auto">Remove</button>
      </div>`;
  }).join('');
  const removed = status?.removed?.length ? `<div style="font-size:11px; color:#e0a040; margin-top:3px">The map still includes ${esc(status.removed.join(', '))}, no longer linked; re-map to drop ${status.removed.length === 1 ? 'it' : 'them'}.</div>` : '';
  el.innerHTML = `
    <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
      ${info.map
        ? `<button class="cm-open" style="${BTN}">View map</button><button class="cm-run" style="${BTN2}">Re-map</button>`
        : `<button class="cm-run" style="${BTN}">Map project</button>`}
    </div>
    ${info.map ? `<div style="${MUTED} margin-top:6px">Last mapped ${esc(fmtWhen(info.map.generatedAt))}${several ? `, ${info.folders.length} folders into one map` : ''}</div>` : ''}
    ${info.mapError ? `<div style="font-size:11px; color:#e08040; margin-top:6px">${esc(info.mapError)}</div>` : ''}
    <div style="${MUTED} margin-top:6px">Code folder${several ? 's' : ''}</div>
    <div style="font-size:11.5px">${rows}</div>
    ${removed}
    <div class="cm-add" style="margin-top:5px"></div>
    <div class="cm-agents" style="margin-top:6px"></div>
    <div class="cm-msg" style="font-size:11.5px; margin-top:5px; color:${color}">${esc(message)}</div>`;
  renderAdd();
  renderAgents();
  el.querySelector('.cm-run').addEventListener('click', runMap);
  el.querySelector('.cm-open')?.addEventListener('click', () => showMap());
  for (const b of el.querySelectorAll('.cm-unlink')) b.addEventListener('click', () => unlink(b.dataset.name));
  if (busy) setBusy(true);
}

function renderUnlinked(message, color) {
  el.innerHTML = `<div class="cm-add"></div><div class="cm-msg" style="font-size:11.5px; margin-top:5px; color:${color}">${esc(message)}</div>`;
  renderAdd(true);
}

// "Link code folder" (no folder yet) or "+ Add folder": suggestions, a path and an optional short name.
function renderAdd(first = false) {
  const box = el.querySelector('.cm-add');
  if (!box) return;
  if (!linking) {
    box.innerHTML = `<button class="cm-link" style="${LINK}${first ? '' : ' font-size:11px'}">${first ? 'Link code folder' : '+ Add folder'}</button>`;
    box.querySelector('.cm-link').addEventListener('click', () => { linking = true; renderAdd(first); loadSuggestions(); });
    return;
  }
  const input = 'background:#0d1020; color:#c8d0e8; border:1px solid rgba(100,120,200,0.25); border-radius:4px; padding:4px 8px; font-size:12px; font-family:inherit; outline:none;';
  box.innerHTML = `
    <div style="border:1px solid rgba(100,120,200,0.18); border-radius:6px; padding:9px 10px;">
      <div style="${MUTED} margin-bottom:5px">Suggested folders</div>
      <div class="cm-sugg" style="display:flex; flex-direction:column; gap:3px; margin-bottom:8px"><span style="${MUTED}">Looking…</span></div>
      <div style="${MUTED} margin-bottom:4px">Or type a path</div>
      <div style="display:flex; gap:6px; flex-wrap:wrap">
        <input class="cm-path" type="text" placeholder="~/Projects/my-app" spellcheck="false" style="flex:1 1 180px; min-width:0; ${input}" />
        <input class="cm-name" type="text" placeholder="short name" spellcheck="false" title="Shown before every path from this folder (for example app or web). Default: the folder's name." style="flex:0 1 110px; min-width:0; ${input}" />
        <button class="cm-go" style="${BTN}">Link</button>
      </div>
      <div style="display:flex; align-items:baseline; margin-top:6px">
        <div class="cm-addmsg" style="font-size:11.5px; color:#8090b0; flex:1">${first ? '' : 'The folders are mapped together; they meet in shared Firestore data and cloud functions.'}</div>
        <button class="cm-cancel" style="${LINK} font-size:11px; color:#8090b0">Cancel</button>
      </div>
    </div>`;
  const path = box.querySelector('.cm-path'), name = box.querySelector('.cm-name');
  const go = () => link(path.value, name.value);
  box.querySelector('.cm-go').addEventListener('click', go);
  path.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  name.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
  box.querySelector('.cm-cancel').addEventListener('click', () => { linking = false; renderAdd(first); });
}

async function loadSuggestions() {
  const slug = current.slug;
  try {
    const r = await fetch(`/api/code/${encodeURIComponent(slug)}/suggestions?name=${encodeURIComponent(current.name || '')}`);
    const linked = new Set((info?.folders || []).map(f => f.path));
    const suggestions = ((await r.json()).suggestions || []).filter(s => !linked.has(s.path));
    const box = el.querySelector('.cm-sugg');
    if (!box || current?.slug !== slug) return;
    box.innerHTML = suggestions.length
      ? suggestions.map((s, i) => `<button data-i="${i}" title="${esc(s.path)}" style="${LINK} text-align:left; text-decoration:none">
          ${esc(s.display)}<span style="color:#5a6890">${s.hasGit ? ' · git' : ''}${s.hasPackageJson ? ' · package.json' : ''}</span></button>`).join('')
      : `<span style="${MUTED}">No folder in your home folder has a similar name.</span>`;
    for (const b of box.querySelectorAll('button')) b.addEventListener('click', () => link(suggestions[Number(b.dataset.i)].path, el.querySelector('.cm-name')?.value));
  } catch { /* typing a path still works */ }
}

function setMsg(text, color = '#8090b0') {
  const m = el.querySelector('.cm-msg');
  if (m) { m.textContent = text; m.style.color = color; }
}

function addMsg(text, color = '#8090b0') {
  const m = el.querySelector('.cm-addmsg') || el.querySelector('.cm-msg');
  if (m) { m.textContent = text; m.style.color = color; }
}

async function link(folder, name) {
  if (!folder?.trim()) return addMsg('Type a folder path.', '#e08040');
  addMsg('Linking…');
  try {
    const r = await api('POST', '/link', { folder, ...(name?.trim() ? { name: name.trim() } : {}) });
    linking = false;
    await refresh();
    if (info?.map) render(`Linked ${r.display} as ${r.name}. Re-map to add it to the map.`, '#6FE3D0');
  } catch (e) { addMsg(e.message, '#c0503a'); }
}

async function unlink(name) {
  try {
    await api('DELETE', '/link', { name });
    const left = (info?.folders || []).filter(f => f.name !== name).length;
    if (!left && isCodeMapOpen()) closeCodeMap();
    linking = false;
    await refresh();
    render(left ? `Removed ${name}. Re-map to take it out of the map.` : 'Unlinked. The saved map stays until this project is mapped again.');
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
  setMsg(typeof note === 'string' ? note : `Mapping ${(info?.folders?.length || 0) > 1 ? `${info.folders.length} code folders` : 'the code folder'} (up to 60 seconds)…`);
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
    if (current?.slug !== slug) return;
    status = s;
    // Only the per-folder status lines and the "no longer linked" note change; the rest of the section stays.
    if (!agentsConfirm && !strictConfirm && !linking) { const msg = el.querySelector('.cm-msg'); render(msg?.textContent || '', msg?.style.color || '#8090b0'); }
  } catch (e) {
    const box = el.querySelector('.cm-fstatus');
    if (box) { box.textContent = e.message; box.style.color = '#e08040'; }
  }
}

// ─── "Enable for assistants": a marked block in the project's AGENTS.md or CLAUDE.md ───────────────────
async function loadAgents() {
  const slug = current.slug;
  const [a, st] = await Promise.all([
    api('GET', '/assistants').catch(e => ({ error: e.message })),
    api('GET', '/strict').catch(e => ({ error: e.message })),
  ]);
  if (current?.slug !== slug) return;
  agents = a; strict = st;
  renderAgents();
}

const ACTION_TEXT = {
  create: 'does not exist; it is created with the text below (marked as created by the app, so Remove deletes it again if nothing else is added).',
  add: 'exists; the text below is added at the end. Nothing else in the file changes, and Remove will never delete this file.',
  update: 'already has a brainmap block in older wording; it is replaced in place by the text below.',
  current: 'already has the current block; nothing changes.',
  skip: 'does not exist and is not created, because the other file exists.',
};

// The block goes into every linked folder; each folder's files are listed (and removed) on their own.
function renderAgents() {
  const box = el?.querySelector('.cm-agents');
  if (!box) return;
  if (!agents) { box.innerHTML = ''; return; }
  if (agents.error) { box.innerHTML = `<div style="${MUTED}">Assistants: ${esc(agents.error)}</div>`; return; }
  const folders = agents.folders || [];
  const several = folders.length > 1;
  const pre = text => `<pre style="margin:4px 0 0; padding:7px 8px; background:#0b0e1c; border:1px solid rgba(100,120,200,0.15); border-radius:4px; font-size:10.5px;
    line-height:1.45; color:#a8b4d4; white-space:pre-wrap; word-break:break-word; max-height:200px; overflow:auto">${esc(text)}</pre>`;
  const fileNames = list => list.join(' and ');
  if (agentsConfirm) {
    const enable = agentsConfirm === 'enable';
    const rowsOf = files => files.map(f => {
      if (f.action === 'shared') return `<div style="margin-top:6px"><b>${esc(f.name)}</b> is a link to ${esc(f.sharedWith)}, so it gets the block once, through that file.</div>`;
      if (enable) return `<div style="margin-top:6px"><b>${esc(f.path)}</b> ${esc(ACTION_TEXT[f.action] || '')}${f.text ? pre(f.text) : ''}</div>`;
      if (!f.enabled) return '';
      return `<div style="margin-top:6px"><b>${esc(f.path)}</b>: the marked brainmap block is removed. ${f.removeDeletes
        ? 'The app created this file and nothing else is in it, so the file is deleted.'
        : f.removeLeavesEmpty ? 'The file existed before the block was added, so it is kept, even though it will be empty.'
        : 'The rest of the file stays as it is.'}</div>`;
    }).join('');
    const rows = folders.map(F => (several ? `<div style="margin-top:8px; color:#9FD8FF">${esc(F.name)} (${esc(F.display)})</div>` : '') + rowsOf(F.files)).join('');
    const per = pickFiles => folders.map(F => ({ F, names: pickFiles(F.files) })).filter(x => x.names.length);
    const changing = per(fs => fs.filter(f => ['create', 'add', 'update'].includes(f.action)).map(f => f.name));
    const removing = per(fs => fs.filter(f => f.enabled && f.action !== 'shared').map(f => f.name));
    const label = list => (several ? list.map(x => `${x.F.name} (${fileNames(x.names)})`).join(', ') : fileNames(list[0]?.names || []));
    const okLabel = enable ? `Write to ${label(changing)}` : `Remove from ${label(removing)}`;
    box.innerHTML = `<div style="border:1px solid rgba(100,120,200,0.22); border-radius:6px; padding:8px 10px; font-size:11.5px; color:#c8d0e8;">
        <div>${enable ? `Claude Code reads CLAUDE.md by itself and other assistants read AGENTS.md, so the block goes into each${several ? ', in every linked folder' : ''}.` : `Only the marked block is taken out${several ? ', in each folder according to what that folder\'s files record' : ''}.`} Nothing is committed.</div>
        ${rows}
        <div style="display:flex; gap:6px; align-items:center; margin-top:8px">
          <button class="cm-agents-ok" style="${BTN}">${esc(okLabel)}</button>
          <button class="cm-agents-cancel" style="${BTN2}">Cancel</button>
        </div></div>`;
    box.querySelector('.cm-agents-ok').addEventListener('click', () => (enable ? enableAgents() : removeAgents()));
    box.querySelector('.cm-agents-cancel').addEventListener('click', () => { agentsConfirm = null; renderAgents(); });
    return;
  }
  const where = folders.map(F => ({ F, names: F.files.filter(f => f.enabled && f.action !== 'shared').map(f => f.name) })).filter(x => x.names.length);
  const missing = several ? folders.filter(F => !F.enabled).map(F => F.name) : [];
  box.innerHTML = agents.enabled
    ? `<div style="${MUTED} display:flex; gap:8px; align-items:baseline; flex-wrap:wrap">
        <span style="color:${agents.upToDate ? '#6FE3D0' : '#e0a040'}">${agents.upToDate ? 'Enabled for assistants' : missing.length ? `Assistants block missing in ${esc(missing.join(', '))}` : 'Assistants block needs an update'}</span>
        <span>in ${esc(several ? where.map(x => `${x.F.name}: ${fileNames(x.names)}`).join('; ') : fileNames(where[0]?.names || []))}</span>
        ${agents.upToDate ? '' : `<button class="cm-agents-enable" style="${LINK} font-size:11px">Update</button>`}
        <button class="cm-agents-remove" style="${LINK} font-size:11px; color:#8090b0">Remove</button></div>`
    : `<button class="cm-agents-enable" style="${BTN2}" title="Adds a short block to the CLAUDE.md and AGENTS.md of ${several ? 'every linked folder' : 'the project'} that tells coding assistants to use the brainmap command">Enable for assistants</button>`;
  box.querySelector('.cm-agents-enable')?.addEventListener('click', () => askAgents('enable'));
  box.querySelector('.cm-agents-remove')?.addEventListener('click', () => askAgents('remove'));
  renderStrict(box);
}

// ─── Strict: send the first code search to the map (hook in .claude/settings.local.json) ─────────────
function renderStrict(box) {
  if (!strict) return;
  const row = document.createElement('div');
  row.style.cssText = 'margin-top:6px;';
  if (strict.error) row.innerHTML = `<div style="${MUTED}">Strict mode: ${esc(strict.error)}</div>`;
  else if (strictConfirm) {
    const enable = strictConfirm === 'enable';
    row.innerHTML = `<div style="border:1px solid rgba(100,120,200,0.22); border-radius:6px; padding:8px 10px; font-size:11.5px; color:#c8d0e8;">
      ${enable
        ? `<div>This adds a Claude Code hook to <b>${esc(strict.path)}</b>${strict.exists ? '' : ' (new file)'} (git: ${esc(strict.git)}). In each session it blocks the first Grep, Glob or Read of source code once, with a message to use the brainmap tools first, then allows everything. CLAUDE.md, AGENTS.md and configuration files are never blocked. The settings already in the file stay as they are (the file is saved as standard JSON), Remove puts the file back exactly as it was, and nothing is committed.</div>
           <pre style="margin:6px 0 0; padding:7px 8px; background:#0b0e1c; border:1px solid rgba(100,120,200,0.15); border-radius:4px; font-size:10.5px; line-height:1.45; color:#a8b4d4; white-space:pre-wrap; word-break:break-word; max-height:200px; overflow:auto">${esc(strict.added)}</pre>`
        : `<div>This takes the brainmap hook out of <b>${esc(strict.path)}</b>. If the file was not edited since, it is restored exactly as it was before (or removed, if the app created it). Nothing is committed.</div>`}
      <div style="display:flex; gap:6px; margin-top:8px">
        <button class="cm-strict-ok" style="${BTN}">${enable ? 'Add the hook' : 'Remove the hook'}</button>
        <button class="cm-strict-cancel" style="${BTN2}">Cancel</button></div></div>`;
    row.querySelector('.cm-strict-ok').addEventListener('click', () => (enable ? enableStrictMode() : removeStrictMode()));
    row.querySelector('.cm-strict-cancel').addEventListener('click', () => { strictConfirm = null; renderAgents(); });
  } else if (strict.enabled) {
    row.innerHTML = `<div style="${MUTED} display:flex; gap:8px; align-items:baseline; flex-wrap:wrap">
      <span style="color:#6FE3D0">Strict: first code search goes to the map</span><span>in ${esc((info?.folders?.length || 0) > 1 ? `${info.folders[0].name}/` : '')}${esc(strict.file)}</span>
      <button class="cm-strict-remove" style="${LINK} font-size:11px; color:#8090b0">Remove</button></div>`;
    row.querySelector('.cm-strict-remove').addEventListener('click', () => askStrict('remove'));
  } else if (strict.refused) {
    row.innerHTML = `<div style="${MUTED}">Strict mode not available: ${esc(strict.refused)}</div>`;
  } else {
    row.innerHTML = `<button class="cm-strict-enable" style="${BTN2}" title="Claude Code only: blocks the first code search of each session once, pointing to the map tools${(info?.folders?.length || 0) > 1 ? ` (in the first linked folder, ${esc(info.folders[0].name)})` : ''}">Strict: send the first code search to the map</button>`;
    row.querySelector('.cm-strict-enable').addEventListener('click', () => askStrict('enable'));
  }
  box.appendChild(row);
}

async function askStrict(kind) {
  await loadAgents();
  if (strict?.error || (kind === 'enable' && strict?.refused)) return renderAgents();
  strictConfirm = kind;
  renderAgents();
}

async function enableStrictMode() {
  try {
    const r = await api('POST', '/strict', { expect: strict.expect });
    strictConfirm = null; await loadAgents();
    setMsg(r.already ? 'Strict mode was already on.' : `Strict mode on (${r.created ? 'created' : 'updated'} ${strict.file}).`, '#6FE3D0');
  } catch (e) { strictConfirm = null; await loadAgents(); setMsg(e.message, '#c0503a'); }
}

async function removeStrictMode() {
  try {
    const r = await api('DELETE', '/strict', { expect: strict.expect });
    strictConfirm = null; await loadAgents();
    setMsg(r.already ? 'Strict mode was already off.' : r.restored ? (r.deleted ? 'Strict mode off; the file the app created was removed.' : 'Strict mode off; the file is back exactly as it was.') : 'Strict mode off; only the hook was taken out (the file had been edited since).', '#6FE3D0');
  } catch (e) { strictConfirm = null; await loadAgents(); setMsg(e.message, '#c0503a'); }
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
    const where = f => ((agents?.folders?.length || 0) > 1 ? `${f.folder}/` : '');
    setMsg(r.files.length ? `Block ${r.files.map(f => `${VERB[f.action]} ${where(f)}${f.file}`).join(', ')}.` : 'Already up to date.', '#6FE3D0');
  } catch (e) { agentsConfirm = null; await loadAgents(); setMsg(e.message, '#c0503a'); }
}

async function removeAgents() {
  try {
    const r = await api('DELETE', '/assistants', { expect: agents.expect });
    agentsConfirm = null;
    await loadAgents();
    const at = f => ((agents?.folders?.length || 0) > 1 ? `${f.folder}/${f.file}` : f.file);
    setMsg(r.files.length ? r.files.map(f => (f.deleted ? `${at(f)} deleted (the app had created it)`
      : f.leftEmpty ? `block removed from ${at(f)} (kept, now empty)` : `block removed from ${at(f)}`)).join('; ') + '.' : 'The block was already gone.', '#6FE3D0');
  } catch (e) { agentsConfirm = null; await loadAgents(); setMsg(e.message, '#c0503a'); }
}
