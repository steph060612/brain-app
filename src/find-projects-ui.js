// "Find my projects" (server side: src/find-projects.js). A checklist of the code projects found in the home folder,
// from names and git facts only; ticked ones become Inbox proposals (state.md and context.md drafts), one batch per
// project. Opened from the top bar while the brain has no projects, and from the List view at any time.
import { openInboxPanel } from './inbox.js';

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const BTN = `padding:5px 12px; background:rgba(60,108,255,0.22); border:1px solid rgba(60,108,255,0.5); color:#cfe6ff;
  border-radius:5px; font-size:12.5px; cursor:pointer; font-family:inherit; white-space:nowrap;`;
const BTN2 = `padding:4px 10px; background:rgba(255,255,255,0.04); border:1px solid rgba(100,120,200,0.25); color:#9FD8FF;
  border-radius:4px; font-size:12px; cursor:pointer; font-family:inherit; white-space:nowrap;`;
const MUTED = 'font-size:11.5px; color:#6a78a0;';
const INPUT = 'background:#0d1020; color:#c8d0e8; border:1px solid rgba(100,120,200,0.25); border-radius:4px; padding:4px 8px; font-size:12px; font-family:inherit; outline:none;';

let overlay = null, scan = null, extra = [], ticked = new Set(), showClones = false;

export function findProjectsButton({ prominent = false } = {}) {
  const b = document.createElement('button');
  b.textContent = 'Find my projects';
  b.title = 'Looks for code projects in your home folder (names and git history only) and drafts brain entries for the ones you tick';
  b.style.cssText = prominent ? BTN : BTN2;
  b.addEventListener('click', openFindProjects);
  return b;
}

const day = iso => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const KIND = {
  'yours-active': 'Yours, active in the last 90 days', 'yours-old': 'Yours, older', 'no-git': 'Not a git repository (cannot tell whose)',
  'no-commits': 'Git repository, but git found no commits (new, or a broken worktree)', 'unknown-author': 'Git repository (your git name and email are not set, so it cannot tell whose)',
  'git-unavailable': 'Git repository (git is not installed, so no history)', clone: 'No commits by you: probably cloned', 'in-brain': 'Already in your brain',
};

export async function openFindProjects() {
  overlay?.remove();
  overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed; inset:0; z-index:200; background:rgba(5,7,15,0.6); display:flex; align-items:flex-start; justify-content:center; padding:60px 16px 16px; overflow:auto;';
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  const box = document.createElement('div');
  box.style.cssText = 'width:min(760px,100%); background:#12162a; border:1px solid rgba(100,120,200,0.3); border-radius:8px; padding:16px 18px; font-size:12.5px; color:#c8d0e8; line-height:1.5;';
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  await runScan(box);
}
function close() { overlay?.remove(); overlay = null; }

async function runScan(box) {
  box.innerHTML = `<div style="font-size:15px; font-weight:700; color:#fff">Find my projects</div><div style="${MUTED} margin-top:6px">Looking through your home folder (folder names and git history only)…</div>`;
  try {
    const r = await fetch('/api/find-projects/scan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extra }) });
    scan = await r.json();
    if (!r.ok) throw new Error(scan.error || `HTTP ${r.status}`);
    ticked = new Set(scan.rows.filter(x => x.ticked).map(x => x.path));
    render(box);
  } catch (e) {
    box.innerHTML += `<div style="color:#e08040; margin-top:8px">${esc(e.message)}</div>`;
  }
}

function row(x) {
  const disabled = x.kind === 'in-brain';
  const langs = x.languages.map(l => `${l.name} ${l.files}`).join(', ');
  const commits = !x.isRepo ? 'no git' : !x.commits ? 'no commits'
    : x.kind === 'unknown-author' ? `${x.commits} commit${x.commits === 1 ? '' : 's'}, whose cannot be told` : `${x.own} of ${x.commits} commits yours`;
  return `<label style="display:grid; grid-template-columns:20px 1fr; gap:6px; padding:6px 4px; border-top:1px solid rgba(100,120,200,0.1); ${disabled ? 'opacity:0.5' : 'cursor:pointer'}">
    <input type="checkbox" data-path="${esc(x.path)}" ${ticked.has(x.path) ? 'checked' : ''} ${disabled ? 'disabled' : ''} style="margin-top:3px">
    <span><b style="color:#fff">${esc(x.name)}</b> <span style="${MUTED}">${esc(x.display)}</span><br>
      <span style="${MUTED}">Last commit ${esc(day(x.lastCommit))} · ${esc(commits)}${langs ? ` · ${esc(langs)}` : ''}</span></span></label>`;
}

function render(box) {
  const groups = {};
  for (const x of scan.rows) (groups[x.kind] ||= []).push(x);
  const section = (kinds, open = true) => kinds.filter(k => groups[k]).map(k => `
    <div style="margin-top:12px; font-size:11px; color:#8090b0; text-transform:uppercase; letter-spacing:0.04em">${esc(KIND[k])} (${groups[k].length})</div>
    ${open ? groups[k].map(row).join('') : ''}`).join('');
  const clones = groups.clone?.length || 0;
  const id = scan.identity || {};
  box.innerHTML = `
    <div style="font-size:15px; font-weight:700; color:#fff">Find my projects</div>
    <div style="${MUTED} margin-top:4px">Found ${scan.rows.length} folder${scan.rows.length === 1 ? '' : 's'} with git or a project file, in ${(scan.ms / 1000).toFixed(1)} s. Only folder names and git history were read; no project file was opened.
      ${scan.noIdentity ? 'Your git name and email are not set, so it cannot tell which commits are yours or your projects from cloned ones. The five most recently committed projects are ticked.'
        : `${id.emails?.length || id.names?.length ? `"Yours" means commits by ${esc([...(id.names || []), ...(id.emails || [])].join(' / '))}.` : ''} The ones with a commit by you in the last 90 days are ticked.`}</div>
    <div style="margin-top:10px; padding:8px 10px; border:1px solid rgba(224,160,64,0.3); border-radius:6px; font-size:12px">
      Not searched: ${esc(scan.protectedSkipped.join(', '))}. The Brain app runs in the background, and macOS does not let background apps open Desktop, Documents, Downloads, iCloud Drive or cloud storage folders. A project kept there cannot be mapped or read by the app; move it to a folder such as ~/Projects. To search another folder, type its path:
      <div style="display:flex; gap:6px; margin-top:6px; flex-wrap:wrap"><input class="fp-path" type="text" placeholder="~/Code" spellcheck="false" style="flex:1 1 220px; min-width:0; ${INPUT}"><button class="fp-add" style="${BTN2}">Add a folder</button></div>
      ${(scan.added || []).map(a => `<div style="margin-top:4px; ${a.error ? 'color:#e08040' : MUTED}">${esc(a.path)}: ${esc(a.error || `${a.found} project${a.found === 1 ? '' : 's'} found`)}</div>`).join('')}
    </div>
    ${scan.otherSkipped?.length ? `<div style="${MUTED} margin-top:6px">Could not read: ${esc(scan.otherSkipped.map(s => `${s.path} (${s.reason})`).join('; '))}</div>` : ''}
    ${section(['yours-active', 'yours-old', 'no-git', 'no-commits', 'unknown-author', 'git-unavailable'])}
    ${clones ? `<button class="fp-clones" style="background:none; border:none; padding:0; margin-top:12px; font-size:11px; color:#8090b0; text-transform:uppercase; letter-spacing:0.04em; cursor:pointer; font-family:inherit">${showClones ? '▾' : '▸'} ${esc(KIND.clone)} (${clones})</button>${showClones ? groups.clone.map(row).join('') : ''}` : ''}
    ${section(['in-brain'])}
    ${scan.rows.length ? '' : `<div style="margin-top:12px; ${MUTED}">No projects found outside the folders above.</div>`}
    <div style="margin-top:14px; ${MUTED}">Continue drafts a state.md and context.md for each ticked project, from its README's first lines, its manifest (name, description, dependencies) and its last ten commit subjects, and puts them in the Inbox. Nothing is added to your brain until you approve it there.</div>
    <div style="display:flex; gap:8px; margin-top:10px; align-items:center"><button class="fp-go" style="${BTN}">Continue with ${ticked.size} project${ticked.size === 1 ? '' : 's'}</button><button class="fp-cancel" style="${BTN2}">Cancel</button><span class="fp-msg" style="${MUTED}"></span></div>`;
  for (const c of box.querySelectorAll('input[type=checkbox]')) c.addEventListener('change', () => { c.checked ? ticked.add(c.dataset.path) : ticked.delete(c.dataset.path); box.querySelector('.fp-go').textContent = `Continue with ${ticked.size} project${ticked.size === 1 ? '' : 's'}`; });
  box.querySelector('.fp-clones')?.addEventListener('click', () => { showClones = !showClones; render(box); });
  box.querySelector('.fp-cancel').addEventListener('click', close);
  const add = () => { const v = box.querySelector('.fp-path').value.trim(); if (v) { extra = [...new Set([...extra, v])]; runScan(box); } };
  box.querySelector('.fp-add').addEventListener('click', add);
  box.querySelector('.fp-path').addEventListener('keydown', e => { if (e.key === 'Enter') add(); });
  box.querySelector('.fp-go').addEventListener('click', () => propose(box));
}

async function propose(box) {
  if (!ticked.size) { box.querySelector('.fp-msg').textContent = 'Tick at least one project.'; return; }
  const go = box.querySelector('.fp-go');
  go.disabled = true; go.textContent = 'Drafting…';
  try {
    const r = await fetch('/api/find-projects/propose', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ paths: [...ticked] }) });
    const d = await r.json();
    if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
    const ok = d.projects.filter(p => p.created.length), bad = d.projects.filter(p => p.errors.length);
    box.innerHTML = `<div style="font-size:15px; font-weight:700; color:#fff">Drafts are in the Inbox</div>
      <div style="margin-top:6px">${ok.length} project${ok.length === 1 ? '' : 's'}: ${esc(ok.map(p => p.name).join(', ') || 'none')}. Each has a state.md and a context.md draft to read, edit and approve or discard. Nothing was added to your brain yet.</div>
      ${bad.length ? `<div style="margin-top:6px; color:#e08040">${bad.map(p => `${esc(p.name)}: ${esc(p.errors.map(e => e.reason).join('; '))}`).join('<br>')}</div>` : ''}
      <div style="margin-top:6px; ${MUTED}">After you approve a project, its page offers "Link code folder" with its folder already filled in.</div>
      <div style="display:flex; gap:8px; margin-top:12px"><button class="fp-inbox" style="${BTN}">Open Inbox</button><button class="fp-cancel" style="${BTN2}">Close</button></div>`;
    box.querySelector('.fp-inbox').addEventListener('click', () => { close(); openInboxPanel(); });
    box.querySelector('.fp-cancel').addEventListener('click', close);
  } catch (e) {
    go.disabled = false; go.textContent = `Continue with ${ticked.size} project${ticked.size === 1 ? '' : 's'}`;
    box.querySelector('.fp-msg').textContent = e.message;
  }
}
