// List view: every Brain item by group, newest first. An opaque layer over the brain, which keeps running behind it.
import { fetchItems, moveProject } from './api.js';
import { STYLE } from './labels.js';

const GROUPS = [
  { title: 'Active projects', categories: ['projects'] },
  { title: 'Archived',        categories: ['archive'], collapsible: true },
  { title: 'People',          categories: ['people'] },
  { title: 'Topics',          categories: ['topics'] },
  { title: 'Profile and Preferences', categories: ['profile', 'preferences'] },
];
const VIEW_KEY = 'brain-view';

let items    = [];
let query    = '';
let archivedOpen = false; // the Archived section starts collapsed; a search opens it while it has matches
let rowNote  = new Map(); // item id → message shown under its row (an unarchive that was refused)
let onClick  = null;
let listEl   = null;
let toggleEl = null;

function savedView() {
  try { return localStorage.getItem(VIEW_KEY); } catch { return null; }
}

function saveView(view) {
  try { localStorage.setItem(VIEW_KEY, view); } catch { /* the choice just isn't remembered */ }
}

export function initList(initialItems, onClickItem) {
  items   = initialItems;
  onClick = onClickItem;

  listEl = document.createElement('div');
  listEl.id = 'list-view';
  listEl.style.cssText = `
    position:fixed; top:44px; left:0; right:0; bottom:0; z-index:25; display:none;
    overflow-y:auto; background:#05070F; padding:20px 24px 40px;
    font-family:system-ui,-apple-system,sans-serif;
    scrollbar-width:thin; scrollbar-color:#2a3050 transparent;
  `;
  document.body.appendChild(listEl);

  toggleEl = document.createElement('button');
  toggleEl.id = 'list-btn';
  toggleEl.textContent = 'List';
  toggleEl.addEventListener('click', () => {
    const show = listEl.style.display === 'none';
    saveView(show ? 'list' : 'brain');
    setVisible(show);
  });
  document.getElementById('search-input')?.after(toggleEl);

  setVisible(savedView() === 'list');
}

function setVisible(show) {
  listEl.style.display = show ? 'block' : 'none';
  toggleEl.setAttribute('aria-pressed', String(show));
  toggleEl.style.cssText = `
    background:${show ? 'rgba(60,108,255,0.2)' : 'rgba(255,255,255,0.06)'};
    border:1px solid ${show ? 'rgba(60,108,255,0.5)' : 'rgba(100,120,200,0.22)'};
    border-radius:6px; color:${show ? '#9FD8FF' : '#c8d0e8'}; font-size:13px; padding:5px 12px;
    cursor:pointer; font-family:inherit;
  `;
  if (!show) return;
  render();
  fetchItems().then(fresh => { items = fresh; render(); }).catch(() => { /* keep what's shown */ });
}

// New items from elsewhere (a project archived from its page): shown the next time the list renders.
export function setListItems(fresh) {
  items = fresh;
  if (listEl && listEl.style.display !== 'none') render();
}

export function setListQuery(q) {
  query = q.trim().toLowerCase();
  if (listEl && listEl.style.display !== 'none') render();
}

const fmtDate = d => d
  ? new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  : '—';

function newestFirst(a, b) {
  return (b.updated || '').localeCompare(a.updated || '') || a.name.localeCompare(b.name);
}

function render() {
  const top = listEl.scrollTop;
  listEl.innerHTML = '';
  const wrap = document.createElement('div');
  wrap.style.cssText = 'width:max(280px, min(640px, calc(100vw - var(--panel-w, 380px) - 48px)));'; // rows stay clear of the open panel

  const matches = items.filter(i => !query || i.name.toLowerCase().includes(query));
  for (const { title, categories, collapsible } of GROUPS) {
    const rows = matches.filter(i => categories.includes(i.category)).sort(newestFirst);
    if (rows.length === 0) continue;

    const open = !collapsible || archivedOpen || !!query;
    const heading = document.createElement(collapsible ? 'button' : 'div');
    heading.style.cssText = `font-size:12px; color:#5a6890; letter-spacing:0.05em; text-transform:uppercase; margin:18px 0 6px;
      ${collapsible ? 'background:none; border:none; padding:0; cursor:pointer; font-family:inherit;' : ''}`;
    heading.textContent = `${collapsible ? (open ? '▾ ' : '▸ ') : ''}${title} (${rows.length})`;
    if (collapsible) {
      heading.setAttribute('aria-expanded', String(open));
      heading.addEventListener('click', () => { archivedOpen = !open; render(); });
    }
    wrap.appendChild(heading);
    if (open) for (const item of rows) wrap.appendChild(buildRow(item));
  }

  if (matches.length === 0) {
    const none = document.createElement('div');
    none.style.cssText = 'font-size:13px; color:#5a6890; margin-top:18px;';
    none.textContent = query ? 'No matches.' : 'No items.';
    wrap.appendChild(none);
  }
  listEl.appendChild(wrap);
  listEl.scrollTop = top;
}

function buildRow(item) {
  const row = document.createElement('button');
  row.style.cssText = `
    display:flex; align-items:baseline; gap:12px; width:100%; padding:7px 10px; text-align:left;
    background:none; border:none; border-bottom:1px solid rgba(100,120,200,0.08);
    cursor:pointer; font-family:inherit;
  `;
  row.addEventListener('mouseover', () => row.style.background = 'rgba(255,255,255,0.04)');
  row.addEventListener('mouseout',  () => row.style.background = 'none');
  row.addEventListener('click', () => onClick(item));

  const name = document.createElement('span');
  name.style.cssText = `flex:1; min-width:0; font-size:14px; color:${(STYLE[item.category] || STYLE.topics).color};
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`;
  name.textContent = item.name;

  const date = document.createElement('span');
  date.style.cssText = 'font-size:12px; color:#8090b0; flex-shrink:0; white-space:nowrap;';
  date.textContent = fmtDate(item.updated);

  row.appendChild(name);
  row.appendChild(date);
  if (item.category !== 'archive') return row;

  // An archived project: an Unarchive button on its row, and the reason under it if the move was refused.
  const btn = document.createElement('span');
  btn.setAttribute('role', 'button');
  btn.tabIndex = 0;
  btn.textContent = 'Unarchive';
  btn.style.cssText = `font-size:12px; color:#9FD8FF; flex-shrink:0; padding:1px 8px; border:1px solid rgba(100,120,200,0.25);
    border-radius:4px; background:rgba(255,255,255,0.04);`;
  const run = async e => {
    e.stopPropagation();
    if (btn.dataset.busy) return;
    btn.dataset.busy = '1'; btn.textContent = 'Moving…';
    try { await moveProject('unarchive', item.path.split('/').pop()); rowNote.delete(item.id); }
    catch (err) { rowNote.set(item.id, err.message); }
    items = await fetchItems().catch(() => items);
    render();
  };
  btn.addEventListener('click', run);
  btn.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') run(e); });
  row.appendChild(btn);
  if (!rowNote.has(item.id)) return row;
  const box = document.createElement('div');
  const note = document.createElement('div');
  note.style.cssText = 'font-size:12px; color:#e08a70; padding:2px 10px 8px;';
  note.textContent = rowNote.get(item.id);
  box.appendChild(row); box.appendChild(note);
  return box;
}
