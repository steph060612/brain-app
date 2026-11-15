// Code map diagram: a force-directed view of ~/.brain/maps/<slug>/map.json (schemaVersion 11; subcollection nodes and function call edges are not drawn).
// Replaces the brain visual on the left while open. Canvas 2D with pre-rendered glow sprites, so it
// stays smooth at around 1,000 nodes; d3-force is bundled by Vite, so nothing is fetched from outside.
//
// Two views share one graph: "Folders" (default) shows one bubble per top-level folder, with links
// between bubbles weighted by the file links they stand for; a bubble can be expanded in place into its
// files. "Files" shows every file. Internally the Files view is the Folders view with every folder expanded.
import { forceSimulation, forceManyBody, forceLink, forceX, forceY, forceCollide } from 'd3-force';
import { setBrainPaused } from './brain.js';
import { computeReport, callerTree, callIndex } from './map-report.js';

const SCHEMA_VERSION = 11;
const BG = '#05070F';
let TOP = 96;             // below the toolbar; follows its height when it wraps
const SIDE_W = 300;       // findings column and selection card
const DEFAULT_LABELS = 8;
const MAX_NEIGHBOR_LABELS = 25;
const NARROW = 900;       // legend starts collapsed below this diagram width

// Edge kinds → toggleable layers.
const LAYERS = [
  { id: 'import',         label: 'Imports',        kinds: ['import', 'require', 're-export', 'dynamic'], color: '#5B7CFF', on: true },
  { id: 'navigate',       label: 'Navigation',     kinds: ['navigate'],       color: '#FF5FD2', on: true },
  { id: 'calls-function', label: 'Cloud functions', kinds: ['calls-function'], color: '#FFB84D', on: false },
  { id: 'reads',          label: 'Reads',          kinds: ['reads'],          color: '#4DFFC3', on: false },
  { id: 'writes',         label: 'Writes',         kinds: ['writes'],         color: '#FF7A59', on: false },
  { id: 'calls',          label: 'Calls',          kinds: ['calls'],          color: '#C3A6FF', on: false },
  { id: 'types',          label: 'Type imports',   kinds: ['type-import'],    color: '#8FA3C8', on: false },
];
const LAYER_OF = Object.fromEntries(LAYERS.flatMap(l => l.kinds.map(k => [k, l.id])));
const LAYER_BY_ID = Object.fromEntries(LAYERS.map(l => [l.id, l]));

// Ten hues spread around the wheel, ordered so neighbors in size rank are far apart; all readable on BG.
const FOLDER_PALETTE = ['#4F8DFF', '#FF9F43', '#3DDC84', '#D36BFF', '#3FD5E8', '#FF5C5C', '#E8E04A', '#8C7CFF', '#A5E86B', '#FF6FB5'];
const OTHER_COLOR = '#7D8597';
// Group colors (Files view, Color by: Group): the folder hues plus two more; isolated files grey.
const GROUP_PALETTE = [...FOLDER_PALETTE, '#F6C177', '#9AD1FF'];
const COLLECTION_COLOR = '#4DFFC3';
const SUBCOLLECTION_COLOR = '#A8FFE6';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = p => p.split('/').pop();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ─── state ───────────────────────────────────────────────────────────────────
let root = null, canvas = null, ctx = null, tooltip = null, findingsEl = null, cardEl = null, legendEl = null, toolbarEl = null, msgEl = null;
let map = null, project = null, onClose = null;
let nodes = [], byId = new Map(), edges = [], drawEdges = [], degree = new Map();
let folders = new Map();             // folder key → { key, label, color, colored, files: [node], lines, bubble }
let rankedFolders = [];
let mode = 'folders', expanded = new Set(), colorBy = 'folder';
let sim = null, view = { x: 0, y: 0, k: 1 }, dpr = 1, width = 0, height = 0;
let layerOn = {};
let hovered = null, selected = null, neighbors = new Set(), searchHits = new Set(), searchMatches = [], searchQuery = '';
let lastLabels = [], tethers = [], CIDX = null;
let dirty = true, raf = 0, panelOpen = true, legendOpen = null;
const sprites = new Map();

// ─── public ──────────────────────────────────────────────────────────────────
export function isCodeMapOpen() { return !!root && root.style.display !== 'none'; }

// project: { slug, name }. Resolves after the map is shown; throws with a readable message otherwise.
export async function openCodeMap(proj, { onBack } = {}) {
  const r = await fetch(`/api/code/${encodeURIComponent(proj.slug)}/map`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Could not load the map (HTTP ${r.status}).`);
  if (data.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(`This map uses schema version ${data.schemaVersion ?? 'unknown'}; this app reads only version ${SCHEMA_VERSION}. Re-map the project to replace it.`);
  }
  build();
  project = proj; onClose = onBack || null; map = data; CIDX = null;
  prepare();
  root.style.display = 'block';
  setBrainPaused(true);
  resize();
  if (legendOpen === null) legendOpen = width >= NARROW;
  renderToolbar();
  renderLegend();
  layout({ warm: true, refit: true });
  renderFindings();
  renderCard();
  dirty = true;
  loop();
  // Dev server only (stripped from the build): lets a test script find nodes on screen.
  if (import.meta.env?.DEV) window.__codemapDebug = { nodes: () => nodes, view: () => view, visible: nodeVisible, drawEdges: () => drawEdges, labels: () => lastLabels, mode: () => mode, expanded: () => expanded, selectById };
}

export function closeCodeMap() {
  if (!root) return;
  root.style.display = 'none';
  cancelAnimationFrame(raf); raf = 0;
  sim?.stop(); sim = null;
  map = null; nodes = []; edges = []; drawEdges = []; folders = new Map(); rankedFolders = [];
  hideTooltip();
  setBrainPaused(false);
  onClose?.();
}

// ─── DOM ─────────────────────────────────────────────────────────────────────
function build() {
  if (root) return;
  root = document.createElement('div');
  root.id = 'code-map';
  root.style.cssText = `position:fixed; top:44px; left:0; right:var(--panel-w, 380px); bottom:0; z-index:26; display:none;
    background:${BG}; font-family:system-ui,-apple-system,sans-serif; color:#c8d0e8; overflow:hidden;`;
  root.innerHTML = `
    <style>
      #code-map button { font-family:inherit; }
      #code-map .cm-btn { padding:4px 10px; background:rgba(255,255,255,0.04); border:1px solid rgba(100,120,200,0.25);
        color:#9FD8FF; border-radius:4px; font-size:12px; cursor:pointer; white-space:nowrap; }
      #code-map .cm-btn:hover { border-color:rgba(100,120,200,0.55); }
      #code-map .cm-chip { display:inline-flex; align-items:center; gap:6px; padding:3px 9px; border-radius:12px; font-size:11.5px;
        border:1px solid rgba(100,120,200,0.22); background:rgba(255,255,255,0.03); color:#8090b0; cursor:pointer; white-space:nowrap; }
      #code-map .cm-chip[aria-pressed="true"] { color:#e8eaf0; background:rgba(60,108,255,0.14); border-color:rgba(100,120,200,0.45); }
      #code-map .cm-seg { display:inline-flex; border:1px solid rgba(100,120,200,0.3); border-radius:6px; overflow:hidden; }
      #code-map .cm-seg button { background:transparent; border:none; color:#8090b0; font-size:12px; padding:4px 11px; cursor:pointer; }
      #code-map .cm-seg button + button { border-left:1px solid rgba(100,120,200,0.3); }
      #code-map .cm-seg button[aria-pressed="true"] { background:rgba(60,108,255,0.22); color:#fff; }
      #code-map .cm-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
      #code-map .cm-swatch { width:12px; height:12px; border-radius:3px; flex-shrink:0; }
      #code-map .cm-panel { background:rgba(8,11,24,0.88); backdrop-filter:blur(6px); border:1px solid rgba(100,120,200,0.16); border-radius:8px; }
      #code-map .cm-sec > summary { cursor:pointer; list-style:none; padding:7px 10px; font-size:12px; color:#c8d0e8; display:flex; gap:6px; align-items:baseline; }
      #code-map .cm-sec > summary::-webkit-details-marker { display:none; }
      #code-map .cm-sec > summary::before { content:'▸'; color:#5a6890; font-size:10px; width:10px; }
      #code-map .cm-sec[open] > summary::before { content:'▾'; }
      #code-map .cm-sec[open] > summary { color:#fff; }
      #code-map .cm-sec-body { max-height:42vh; overflow-y:auto; padding-bottom:4px; }
      #code-map .cm-count { color:#8090b0; font-size:11px; margin-left:auto; font-variant-numeric:tabular-nums; }
      #code-map .cm-sub { font-size:10.5px; color:#5a6890; letter-spacing:0.04em; text-transform:uppercase; padding:6px 12px 2px 26px; }
      #code-map .cm-item { display:block; width:100%; text-align:left; background:none; border:none; color:#a8b4d4; font-size:11.5px;
        padding:3px 12px 3px 26px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #code-map .cm-card .cm-item { padding-left:4px; }
      #code-map .cm-card .cm-item.cm-wrap { white-space:normal; overflow:visible; text-overflow:clip; padding-left:18px; text-indent:-14px; line-height:1.4; }
      #code-map .cm-more { background:none; border:none; padding:2px 4px; color:#7FA8FF; font-size:11px; cursor:pointer; font-family:inherit; }
      #code-map .cm-more:hover { color:#BFD4FF; text-decoration:underline; }
      #code-map .cm-item:hover, #code-map .cm-item.cm-active { background:rgba(60,108,255,0.14); color:#fff; }
      #code-map .cm-note { font-size:11px; color:#5a6890; padding:2px 12px 6px 26px; }
      #code-map .cm-h { font-size:10.5px; color:#5a6890; letter-spacing:0.05em; text-transform:uppercase; margin:9px 0 3px; }
      #code-map table.cm-t { width:100%; border-collapse:collapse; font-size:11.5px; font-variant-numeric:tabular-nums; }
      #code-map table.cm-t th { font-weight:normal; color:#5a6890; text-align:right; padding:1px 4px; font-size:10.5px; }
      #code-map table.cm-t th:first-child, #code-map table.cm-t td:first-child { text-align:left; padding-left:0; }
      #code-map table.cm-t td { text-align:right; padding:1px 4px; color:#a8b4d4; }
      #code-map input.cm-search { background:rgba(255,255,255,0.06); border:1px solid rgba(100,120,200,0.22); border-radius:6px;
        color:#c8d0e8; font-size:12px; padding:4px 9px; width:170px; outline:none; font-family:inherit; }
      #code-map input.cm-search:focus { border-color:rgba(100,120,200,0.5); }
      #code-map .cm-scroll { scrollbar-width:thin; scrollbar-color:#2a3050 transparent; }
    </style>
    <canvas style="position:absolute; inset:0; width:100%; height:100%; cursor:grab; touch-action:none;"></canvas>
    <div class="cm-toolbar" style="position:absolute; top:0; left:0; right:0; padding:10px 14px; display:flex; flex-wrap:wrap; gap:8px 10px; align-items:center;
      background:linear-gradient(${BG}f0, ${BG}00);"></div>
    <div class="cm-findings cm-panel cm-scroll" style="position:absolute; left:14px; top:${TOP}px; width:${SIDE_W}px; max-height:calc(100% - ${TOP + 14}px); overflow-y:auto;"></div>
    <div class="cm-card cm-panel cm-scroll" style="position:absolute; right:14px; top:${TOP}px; width:${SIDE_W}px; overflow-y:auto; display:none;
      padding:9px 11px; font-size:11.5px; line-height:1.5;"></div>
    <div class="cm-legend cm-panel" style="position:absolute; right:14px; bottom:14px; font-size:11px; width:220px;"></div>
    <div class="cm-msg" style="position:absolute; left:50%; top:45%; transform:translate(-50%,-50%); color:#8090b0; font-size:13px; display:none;"></div>
    <div class="cm-tip cm-panel" style="position:absolute; pointer-events:none; display:none; padding:8px 10px; font-size:11.5px; max-width:340px; line-height:1.5; z-index:2;"></div>
  `;
  document.body.appendChild(root);
  canvas = root.querySelector('canvas');
  ctx = canvas.getContext('2d');
  toolbarEl = root.querySelector('.cm-toolbar');
  findingsEl = root.querySelector('.cm-findings');
  cardEl = root.querySelector('.cm-card');
  legendEl = root.querySelector('.cm-legend');
  tooltip = root.querySelector('.cm-tip');
  msgEl = root.querySelector('.cm-msg');

  window.addEventListener('resize', () => { if (isCodeMapOpen()) { resize(); placeBelowToolbar(); } });
  window.addEventListener('brain-panel', e => {
    panelOpen = !!e.detail?.open;
    root.style.right = panelOpen ? 'var(--panel-w, 380px)' : '0';
    if (isCodeMapOpen()) { resize(); placeBelowToolbar(); }
  });
  window.addEventListener('keydown', e => {
    if (!isCodeMapOpen() || e.key !== 'Escape' || e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
    if (selected) { select(null); restoreView(); }
  });
  findingsEl.addEventListener('click', e => {
    const b = e.target.closest('.cm-item');
    if (b?.dataset.id) selectById(b.dataset.id);
  });
  // Findings headings expand one at a time (the shared `name` does this natively; this covers older engines).
  findingsEl.addEventListener('toggle', e => {
    if (!e.target.matches?.('details.cm-sec') || !e.target.open) return;
    for (const d of findingsEl.querySelectorAll('details.cm-sec[open]')) if (d !== e.target) d.open = false;
  }, true);
  cardEl.addEventListener('click', e => {
    const b = e.target.closest('[data-act], .cm-item');
    if (!b) return;
    if (b.dataset.act === 'more') {
      // "+N more" ⇄ "Show fewer": the hidden rest of the list is already in the card.
      const extra = b.previousElementSibling, open = extra.hidden;
      extra.hidden = !open;
      b.textContent = open ? 'Show fewer' : b.dataset.label;
      sizeCard();
      return;
    }
    if (b.dataset.act === 'clear') { select(null); restoreView(); }
    else if (b.dataset.act === 'expand') expandFolder(b.dataset.key);
    else if (b.dataset.act === 'collapse') collapseFolder(b.dataset.key);
    else if (b.dataset.id) selectById(b.dataset.id);
  });
  legendEl.addEventListener('click', e => {
    if (!e.target.closest('.cm-legend-toggle')) return;
    legendOpen = !legendOpen;
    renderLegend();
    sizeCard();
  });
  bindPointer();
}

function resize() {
  const rect = root.getBoundingClientRect();
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = rect.width; height = rect.height;
  canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
  dirty = true;
}

// ─── data ────────────────────────────────────────────────────────────────────
const folderKeyOf = f => (f.rootGroup !== 'app' ? `group:${f.rootGroup}` : `folder:${f.topFolder}`);
const folderLabel = k => (k === 'folder:(root)' ? 'root files' : `${k.slice(k.indexOf(':') + 1)}/`);

function prepare() {
  layerOn = Object.fromEntries(LAYERS.map(l => [l.id, l.on]));
  hovered = selected = null; neighbors = new Set(); searchHits = new Set(); searchMatches = []; searchQuery = '';
  mode = 'folders'; expanded = new Set(); colorBy = 'folder';

  // Folders: scripts/ and functions/ (their own root groups) count as folders. The 10 largest get a hue.
  folders = new Map();
  for (const f of map.nodes) {
    if (f.kind !== 'file') continue;
    const key = folderKeyOf(f);
    if (!folders.has(key)) folders.set(key, { key, label: folderLabel(key), files: [], lines: 0 });
    folders.get(key).lines += f.lines || 0;
  }
  rankedFolders = [...folders.values()];
  const fileCount = new Map();
  for (const f of map.nodes) if (f.kind === 'file') fileCount.set(folderKeyOf(f), (fileCount.get(folderKeyOf(f)) || 0) + 1);
  rankedFolders.sort((a, b) => fileCount.get(b.key) - fileCount.get(a.key) || a.label.localeCompare(b.label));
  rankedFolders.forEach((F, i) => { F.colored = i < FOLDER_PALETTE.length; F.color = F.colored ? FOLDER_PALETTE[i] : OTHER_COLOR; });

  const fileNodes = [], colNodes = [], subNodes = [];
  for (const n of map.nodes) {
    if (n.kind === 'subcollection') {
      subNodes.push({ id: n.id, kind: 'subcollection', raw: n, key: 'collection', color: SUBCOLLECTION_COLOR,
        r: Math.min(7.5, 3.2 + Math.sqrt((n.readers || 0) + (n.writers || 0)) * 0.9), label: n.name, x: 0, y: 0 });
      continue;
    }
    if (n.kind === 'collection') {
      colNodes.push({ id: n.id, kind: 'collection', raw: n, key: 'collection', color: COLLECTION_COLOR,
        r: Math.min(11, 5 + Math.sqrt((n.readers || 0) + (n.writers || 0)) * 1.2), label: n.name, x: 0, y: 0 });
      continue;
    }
    if (n.kind !== 'file') continue;
    const F = folders.get(folderKeyOf(n));
    const node = { id: n.id, kind: 'file', raw: n, folder: F.key, key: F.colored ? F.key : 'folder:(other)', color: F.color, fkey: F.colored ? F.key : 'folder:(other)', fcolor: F.color,
      r: Math.max(2.2, Math.min(9, 1.6 + Math.sqrt(n.lines || 1) / 5.5)), label: base(n.path), x: 0, y: 0 };
    F.files.push(node);
    fileNodes.push(node);
  }
  const bubbles = rankedFolders.map(F => {
    F.bubble = { id: `@${F.key}`, kind: 'folder', folder: F.key, key: F.key, color: F.color, F,
      r: 7 + Math.sqrt(F.files.length) * 3.4, label: F.label, x: 0, y: 0 };
    return F.bubble;
  });
  nodes = [...bubbles, ...fileNodes, ...colNodes, ...subNodes];
  byId = new Map(nodes.map(n => [n.id, n]));
  // A subcollection hangs off its nearest mapped ancestor: users/{}/myWorkouts/{}/sessions off
  // users/{}/myWorkouts when that is mapped, otherwise off the top-level collection (users).
  for (const sub of subNodes) {
    const parts = sub.raw.key.split('/');
    let parent = null;
    for (let n = parts.length - 2; n >= 1 && !parent; n -= 2) parent = byId.get(`subcollection:${parts.slice(0, n).join('/')}`) ?? null;
    sub.parent = parent ?? byId.get(`collection:${sub.raw.parent}`) ?? null;
  }
  const subsWithParent = subNodes.filter(n => n.parent);
  for (const sub of subsWithParent) sub.parent.subCount = (sub.parent.subCount || 0) + 1; // longer tethers when crowded

  edges = map.edges.filter(e => byId.has(e.from) && byId.has(e.to)).map(e => ({ ...e, layer: LAYER_OF[e.kind] })).filter(e => e.layer);

  // Files view anchors: one per color group on a golden-angle spiral, largest group in the middle.
  spiralAnchors(fileNodes.concat(colNodes), 70 + Math.sqrt(fileNodes.length + colNodes.length) * 4, (n, a) => { n.fax = a.x; n.fay = a.y; });
  // Folders view anchors: one per bubble (already in size order), collections share one.
  spiralAnchors(bubbles.concat(colNodes), 120, (n, a) => { n.bax = a.x; n.bay = a.y; });
  // Subcollections share their top-level collection's anchor; the tether link keeps them next to the parent.
  const topOf = n => (n.kind === 'subcollection' && n.parent ? topOf(n.parent) : n);
  for (const sub of subsWithParent) { const t = topOf(sub); sub.fax = t.fax; sub.fay = t.fay; sub.bax = t.bax; sub.bay = t.bay; }
  for (const n of nodes) {
    const [ax, ay] = n.kind === 'file' ? [n.fax, n.fay] : [n.bax, n.bay];
    n.x = ax + (Math.random() - 0.5) * 60; n.y = ay + (Math.random() - 0.5) * 60;
  }
  applyAnchors();
}

function spiralAnchors(list, spacing, set) {
  const groups = new Map();
  for (const n of list) groups.set(n.key, (groups.get(n.key) || 0) + (n.kind === 'folder' ? n.F.files.length : 1));
  const order = [...groups].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const anchors = new Map(order.map((k, i) => {
    const a = i * 2.39996, rr = spacing * Math.sqrt(i + (i ? 0.6 : 0));
    return [k, { x: Math.cos(a) * rr, y: Math.sin(a) * rr }];
  }));
  for (const n of list) set(n, anchors.get(n.key));
}

// Expanded files keep the anchor set when their folder was opened (the bubble's position).
function applyAnchors() {
  for (const n of nodes) {
    if (mode === 'files') { n.ax = n.fax ?? 0; n.ay = n.fay ?? 0; }
    else if (n.kind !== 'file') { n.ax = n.bax; n.ay = n.bay; }
  }
}

function nodeVisible(n) {
  if (n.kind === 'collection') return !!(layerOn.reads || layerOn.writes);
  // In the folder overview a subcollection is folded into its parent collection (whose counts include it).
  if (n.kind === 'subcollection') return !!(layerOn.reads || layerOn.writes) && !!n.parent && mode === 'files';
  if (n.kind === 'folder') return mode === 'folders' && !expanded.has(n.folder);
  return mode === 'files' || expanded.has(n.folder);
}

// The node an edge end is drawn at: the file itself, or its folder's bubble when collapsed.
function repOf(n) {
  if (n.kind === 'file' && mode === 'folders' && !expanded.has(n.folder)) return folders.get(n.folder).bubble;
  return n;
}

// Visible edges, merged per layer and drawn pair, for drawing and for the layout.
function rebuildEdges() {
  const merged = new Map();
  for (const e of edges) {
    if (!layerOn[e.layer]) continue;
    const s = repOf(byId.get(e.from)), t = repOf(byId.get(e.to));
    if (s === t) continue;
    const key = `${e.layer}|${s.id}|${t.id}`;
    const m = merged.get(key) ?? merged.set(key, { layer: e.layer, source: s, target: t, count: 0, value: 0, inferred: 0 }).get(key);
    m.count++;
    if (e.via === 'value') m.value++;
    if (e.tag === 'inferred') m.inferred++;
  }
  drawEdges = [...merged.values()].filter(e => nodeVisible(e.source) && nodeVisible(e.target));
  for (const e of drawEdges) {
    e.dashed = e.value > 0 && e.value === e.count; // only calls through a value passed on
    e.light = e.inferred > 0 && e.inferred === e.count; // every link in the pair was inferred by the mapper: drawn lighter
  }
  tethers = nodes.filter(n => n.kind === 'subcollection' && nodeVisible(n) && nodeVisible(n.parent)).map(n => ({ source: n, target: n.parent, tether: true }));
  degree = new Map();
  for (const e of drawEdges) {
    degree.set(e.source, (degree.get(e.source) || 0) + e.count);
    degree.set(e.target, (degree.get(e.target) || 0) + e.count);
  }
}

// Bubbles with no visible links are held close to their anchor so they do not drift off the frame.
const anchorStrength = n => (n.kind === 'folder' ? (degree.get(n) ? 0.08 : 0.25) : n.kind === 'file' && mode === 'folders' ? 0.14 : 0.05);

const isBubbleEdge = e => e.source.kind === 'folder' || e.target.kind === 'folder';

// Rebuilds edges and forces for what is visible now. warm: settle off-screen first; refit: frame it all.
function layout({ warm = false, refit = false } = {}) {
  rebuildEdges();
  const visible = nodes.filter(nodeVisible);
  const pairs = new Map();
  for (const e of drawEdges) {
    const k = e.source.id < e.target.id ? `${e.source.id}|${e.target.id}` : `${e.target.id}|${e.source.id}`;
    const p = pairs.get(k);
    if (p) p.count += e.count; else pairs.set(k, { source: e.source, target: e.target, count: e.count });
  }
  const links = [...pairs.values(), ...tethers];
  if (!sim) sim = forceSimulation().stop().alphaDecay(0.03);
  sim.nodes(visible)
    .force('charge', forceManyBody()
      .strength(n => (n.kind === 'folder' ? -(120 + n.r * 5) : n.kind === 'collection' ? -140 : n.kind === 'subcollection' ? -45 : -38))
      .distanceMax(mode === 'folders' ? 500 : 420).theta(0.9))
    .force('link', forceLink(links)
      .distance(l => (l.tether ? l.source.r + l.target.r + 12 + 1.8 * (l.target.subCount || 0) : isBubbleEdge(l) ? l.source.r + l.target.r + 45 : 34))
      .strength(l => (l.tether ? 0.9 : isBubbleEdge(l) ? Math.min(0.12, 0.03 + 0.012 * Math.log2(1 + l.count)) : 0.35)))
    .force('x', forceX(n => n.ax).strength(anchorStrength))
    .force('y', forceY(n => n.ay).strength(anchorStrength))
    .force('collide', forceCollide(n => (n.kind === 'folder' ? n.r + 10 : n.r + 1.5)).iterations(mode === 'folders' ? 2 : 1));
  if (warm) {
    sim.alpha(1);
    const ticks = Math.min(140, Math.max(40, Math.round(60000 / Math.max(visible.length, 1))));
    for (let i = 0; i < ticks; i++) sim.tick();
  } else sim.alpha(Math.max(sim.alpha(), 0.35));
  if (refit) fit();
  if (selected) neighbors = neighborsOf(selected);
  msgEl.style.display = visible.length ? 'none' : 'block';
  msgEl.textContent = 'Nothing to show.';
  dirty = true;
}

// Files view: color (and place) files by folder or by group (subsystems found by the mapper).
const groupById = () => new Map((map.groups?.list || []).map(g => [g.id, g]));
function setColorBy(c) {
  if (c === colorBy && c !== 'refresh') return;
  colorBy = c === 'refresh' ? colorBy : c;
  const files = nodes.filter(n => n.kind === 'file');
  for (const n of files) {
    const gid = n.raw.group;
    if (colorBy === 'group') { n.key = gid ? `group:${gid}` : 'group:0'; n.color = gid ? GROUP_PALETTE[(gid - 1) % GROUP_PALETTE.length] : OTHER_COLOR; }
    else { n.key = n.fkey; n.color = n.fcolor; }
  }
  const data = nodes.filter(n => n.kind === 'collection' || n.kind === 'subcollection');
  spiralAnchors(files.concat(data.filter(n => n.kind === 'collection')), 70 + Math.sqrt(files.length + data.length) * 4, (n, a) => { n.fax = a.x; n.fay = a.y; });
  const topOf = n => (n.kind === 'subcollection' && n.parent ? topOf(n.parent) : n);
  for (const sub of data.filter(n => n.kind === 'subcollection' && n.parent)) { const t = topOf(sub); sub.fax = t.fax; sub.fay = t.fay; }
  for (const n of files) { n.x = n.fax + (Math.random() - 0.5) * 60; n.y = n.fay + (Math.random() - 0.5) * 60; }
  applyAnchors();
  layout({ warm: true, refit: true });
  renderToolbar(); renderLegend();
}

function setMode(m) {
  if (m === mode) return;
  if (m === 'folders' && colorBy === 'group') { colorBy = 'folder'; for (const n of nodes) if (n.kind === 'file') { n.key = n.fkey; n.color = n.fcolor; } }
  mode = m;
  expanded = new Set();
  select(null);
  hideTooltip(); hovered = null;
  for (const n of nodes) if (n.kind === 'collection') {
    const [ax, ay] = m === 'files' ? [n.fax, n.fay] : [n.bax, n.bay];
    n.x = ax + (Math.random() - 0.5) * 40; n.y = ay + (Math.random() - 0.5) * 40;
  }
  applyAnchors();
  layout({ warm: true, refit: true });
  if (searchQuery) runSearch(searchQuery);
  renderToolbar();
  renderLegend();
}

function expandFolder(key) {
  const F = folders.get(key);
  if (!F || mode !== 'folders' || expanded.has(key)) return;
  const b = F.bubble;
  expanded.add(key);
  for (const f of F.files) {
    const a = Math.random() * Math.PI * 2, d = Math.sqrt(Math.random()) * b.r;
    f.x = b.x + Math.cos(a) * d; f.y = b.y + Math.sin(a) * d; f.vx = f.vy = 0;
    f.ax = b.x; f.ay = b.y;
  }
  if (selected === b) selected = null;
  layout({ warm: true, refit: true });
  if (searchQuery) runSearch(searchQuery);
  renderToolbar();
  renderCard();
}

function collapseFolder(key) {
  const F = folders.get(key);
  if (!F || !expanded.has(key)) return;
  let x = 0, y = 0;
  for (const f of F.files) { x += f.x; y += f.y; }
  F.bubble.x = x / F.files.length; F.bubble.y = y / F.files.length; F.bubble.vx = F.bubble.vy = 0;
  expanded.delete(key);
  const keepSel = selected && nodeVisible(selected);
  layout({ warm: true, refit: true });
  if (searchQuery) runSearch(searchQuery);
  renderToolbar();
  select(keepSel ? selected : F.bubble);
}

// Smoothly moves the view to `to` (instant when `instant`); wheel and drag stop a transition in progress.
let viewAnim = null, viewBeforeSelection = null;
function animateView(to, instant = false) {
  if (instant || !to) { if (to) view = to; viewAnim = null; dirty = true; return; }
  viewAnim = { from: { ...view }, to, t0: performance.now(), dur: 450 };
  dirty = true;
}
function stepView() {
  if (!viewAnim) return;
  const t = Math.min(1, (performance.now() - viewAnim.t0) / viewAnim.dur), e = 1 - Math.pow(1 - t, 3);
  const { from: a, to: b } = viewAnim;
  // Interpolate the zoom geometrically and the world point at the centre, so it does not swing sideways.
  const k = a.k * Math.pow(b.k / a.k, e);
  const cxa = (width / 2 - a.x) / a.k, cya = (height / 2 - a.y) / a.k, cxb = (width / 2 - b.x) / b.k, cyb = (height / 2 - b.y) / b.k;
  const cx = cxa + (cxb - cxa) * e, cy = cya + (cyb - cya) * e;
  view = { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
  if (t >= 1) { view = { ...b }; viewAnim = null; }
  dirty = true;
}

// The free area beside the selection card (top right), clear of the findings column when there is room.
function freeArea() {
  const right = SIDE_W + 30;
  let left = SIDE_W + 30;
  if (width - left - right < 220) left = 14;
  return { left, top: TOP + 4, right: width - right, bottom: height - 30 };
}

// Zoom and pan so the selected node and its direct neighbors on the visible layers fill the free area.
function focusSelection(instant = false) {
  if (!selected || !width) return;
  const group = [selected, ...neighbors].filter(nodeVisible);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of group) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
  const A = freeArea(), w = Math.max(80, A.right - A.left), h = Math.max(80, A.bottom - A.top);
  const pad = 70; // room for labels at the edges
  const k = Math.min(5, Math.max(0.1, Math.min((w - pad) / (x1 - x0 + 1), (h - pad) / (y1 - y0 + 1)) * 0.92));
  animateView({ k, x: A.left + w / 2 - k * (x0 + x1) / 2, y: A.top + h / 2 - k * (y0 + y1) / 2 }, instant);
}

function restoreView() {
  if (viewBeforeSelection) animateView(viewBeforeSelection);
  viewBeforeSelection = null;
}

function fit(animate = false) {
  const vis = nodes.filter(nodeVisible);
  if (!vis.length || !width) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of vis) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
  // Keep clear of the findings column, the toolbar and (when open and the window is wide enough) the legend.
  const padL = SIDE_W + 30, padT = TOP + 4, padR = legendOpen && width > 3 * SIDE_W ? 250 : 40, padB = 40;
  const w = Math.max(1, width - padL - padR), h = Math.max(1, height - padT - padB);
  const k = Math.min(2.2, Math.max(0.12, Math.min(w / (x1 - x0 + 60), h / (y1 - y0 + 60))));
  animateView({ k, x: padL + w / 2 - k * (x0 + x1) / 2, y: padT + h / 2 - k * (y0 + y1) / 2 }, !animate);
}

// ─── drawing ─────────────────────────────────────────────────────────────────
function sprite(color) {
  if (sprites.has(color)) return sprites.get(color);
  const s = 64, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.14, color);
  grad.addColorStop(0.32, hexA(color, 0.38));
  grad.addColorStop(0.6, hexA(color, 0.09));
  grad.addColorStop(1, hexA(color, 0));
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  sprites.set(color, c);
  return c;
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const focusActive = () => !!selected || searchHits.size > 0;
const isFocused = n => (selected ? n === selected || neighbors.has(n) : searchHits.has(n));
const edgeWidth = count => Math.min(10, 0.9 + 1.5 * Math.log2(count)); // screen pixels

// A weighted line, nudged sideways per layer so parallel layers (and the two directions) stay apart.
function strokeOffset(e, lw, layerIdx) {
  const { source: s, target: t } = e, k = view.k;
  const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy) || 1;
  const off = (1.5 + layerIdx * 3.5 + lw / 2) / k, ox = (-dy / len) * off, oy = (dx / len) * off;
  ctx.lineWidth = lw / k;
  ctx.beginPath(); ctx.moveTo(s.x + ox, s.y + oy); ctx.lineTo(t.x + ox, t.y + oy); ctx.stroke();
}

function draw() {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const vg = ctx.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, Math.max(canvas.width, canvas.height) * 0.7);
  vg.addColorStop(0, 'rgba(30,45,120,0.16)'); vg.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, canvas.width, canvas.height);

  const { k } = view;
  ctx.setTransform(dpr * k, 0, 0, dpr * k, dpr * view.x, dpr * view.y);
  ctx.globalCompositeOperation = 'lighter';
  const focus = focusActive();
  const onLayers = LAYERS.filter(L => layerOn[L.id]).map(L => L.id);
  const touchesSel = e => selected && (e.source === selected || e.target === selected);

  // File-to-file edges, one thin path per layer; weighted bubble edges one by one.
  ctx.lineCap = 'round';
  for (const L of LAYERS) {
    if (!layerOn[L.id]) continue;
    ctx.beginPath();
    let any = false;
    for (const e of drawEdges) {
      if (e.layer !== L.id || touchesSel(e) || isBubbleEdge(e) || e.dashed || e.light) continue;
      ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y); any = true;
    }
    ctx.strokeStyle = hexA(L.color, focus ? 0.05 : 0.2);
    ctx.lineWidth = 0.9 / k;
    if (any) ctx.stroke();
    // Inferred links (not written out in the code): lighter.
    ctx.beginPath(); any = false;
    for (const e of drawEdges) {
      if (e.layer !== L.id || touchesSel(e) || isBubbleEdge(e) || e.dashed || !e.light) continue;
      ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y); any = true;
    }
    if (any) { ctx.strokeStyle = hexA(L.color, focus ? 0.025 : 0.08); ctx.stroke(); }
    // Calls made through a function handed over as a value: dashed.
    ctx.beginPath(); any = false;
    for (const e of drawEdges) {
      if (e.layer !== L.id || touchesSel(e) || isBubbleEdge(e) || !e.dashed) continue;
      ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y); any = true;
    }
    if (any) { ctx.strokeStyle = hexA(L.color, focus ? 0.05 : 0.22); ctx.setLineDash([4 / k, 3 / k]); ctx.stroke(); ctx.setLineDash([]); } // via value: inferred too, so light
  }
  // Subcollections: a short tether to the collection they belong to.
  if (tethers.length) {
    ctx.beginPath();
    for (const t of tethers) { ctx.moveTo(t.source.x, t.source.y); ctx.lineTo(t.target.x, t.target.y); }
    ctx.strokeStyle = hexA(SUBCOLLECTION_COLOR, focus ? 0.15 : 0.45); ctx.lineWidth = 1 / k; ctx.setLineDash([2 / k, 2 / k]); ctx.stroke(); ctx.setLineDash([]);
  }
  for (const e of drawEdges) {
    if (!isBubbleEdge(e) || touchesSel(e)) continue;
    ctx.strokeStyle = hexA(LAYER_BY_ID[e.layer].color, focus ? 0.06 : 0.3);
    if (e.dashed) ctx.setLineDash([5 / k, 4 / k]);
    strokeOffset(e, edgeWidth(e.count), onLayers.indexOf(e.layer));
    ctx.setLineDash([]);
  }
  if (selected) {
    for (const e of drawEdges) {
      if (!touchesSel(e)) continue;
      const L = LAYER_BY_ID[e.layer];
      ctx.strokeStyle = hexA(L.color, e.light ? 0.45 : 0.9);
      if (e.dashed) ctx.setLineDash([5 / k, 4 / k]);
      if (isBubbleEdge(e)) strokeOffset(e, edgeWidth(e.count) + 0.6, onLayers.indexOf(e.layer));
      else {
        ctx.lineWidth = (1.3 + Math.min(2, Math.log2(e.count))) / k;
        ctx.beginPath(); ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y); ctx.stroke();
      }
      ctx.setLineDash([]);
      arrow(e, L.color);
    }
  }

  // Nodes
  for (const n of nodes) {
    if (!nodeVisible(n)) continue;
    const dim = focus && !isFocused(n);
    ctx.globalAlpha = dim ? 0.13 : 1;
    if (n.kind === 'folder') {
      const hot = n === hovered || n === selected;
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
      ctx.fillStyle = hexA(n.color, hot ? 0.34 : 0.22); ctx.fill();
      ctx.strokeStyle = hexA(n.color, 0.9); ctx.lineWidth = (hot ? 2.2 : 1.5) / k; ctx.stroke();
      const R = n.r * 0.55;
      ctx.drawImage(sprite(n.color), n.x - R, n.y - R, R * 2, R * 2);
    } else {
      const R = n.r * (n === hovered || n === selected ? 4.6 : 3.6);
      ctx.drawImage(sprite(n.color), n.x - R, n.y - R, R * 2, R * 2);
    }
    if (n.kind === 'subcollection') {
      const s = n.r * 1.2;
      ctx.beginPath();
      ctx.moveTo(n.x, n.y - s); ctx.lineTo(n.x + s, n.y); ctx.lineTo(n.x, n.y + s); ctx.lineTo(n.x - s, n.y); ctx.closePath();
      ctx.fillStyle = hexA(n.color, 0.12); ctx.fill();
      ctx.strokeStyle = n.color; ctx.lineWidth = 1.1 / k; ctx.stroke();
    }
    if (n.kind === 'collection') {
      const s = n.r * 1.25;
      ctx.beginPath();
      ctx.moveTo(n.x, n.y - s); ctx.lineTo(n.x + s, n.y); ctx.lineTo(n.x, n.y + s); ctx.lineTo(n.x - s, n.y); ctx.closePath();
      ctx.fillStyle = hexA(n.color, 0.35); ctx.fill();
      ctx.strokeStyle = n.color; ctx.lineWidth = 1.4 / k; ctx.stroke();
    }
    if (searchHits.has(n) || n === selected) {
      ctx.beginPath(); ctx.arc(n.x, n.y, n.r + 4 / k, 0, Math.PI * 2);
      ctx.strokeStyle = n === selected ? 'rgba(255,255,255,0.9)' : 'rgba(255,230,140,0.85)';
      ctx.lineWidth = 1.2 / k; ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  drawLabels();
}

function arrow(e, color) {
  const { source: s, target: t } = e;
  const dx = t.x - s.x, dy = t.y - s.y, len = Math.hypot(dx, dy);
  if (len < 1) return;
  const ux = dx / len, uy = dy / len, tip = t.r + 2 / view.k, size = 6 / view.k;
  const px = t.x - ux * tip, py = t.y - uy * tip;
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.lineTo(px - ux * size - uy * size * 0.5, py - uy * size + ux * size * 0.5);
  ctx.lineTo(px - ux * size + uy * size * 0.5, py - uy * size - ux * size * 0.5);
  ctx.closePath();
  ctx.fillStyle = color; ctx.fill();
}

const byDegree = (a, b) => (degree.get(b) || 0) - (degree.get(a) || 0) || a.label.localeCompare(b.label);

// Which nodes get a label, most important first. Collisions are resolved in this order.
// Top-level collections are few, so they are always labeled while Reads or Writes is on, before any file.
const collectionLabels = () => (layerOn.reads || layerOn.writes ? nodes.filter(n => n.kind === 'collection' && nodeVisible(n)) : []);

function labelCandidates() {
  const list = [];
  if (selected) list.push(selected);
  list.push(...collectionLabels());
  if (selected) {
    const ns = [...neighbors];
    const isData = n => n.kind === 'collection' || n.kind === 'subcollection';
    // A selected collection labels the subcollections tethered to it (and a subcollection its parent and children).
    if (isData(selected)) {
      for (let p = selected.parent; p; p = p.parent) if (nodeVisible(p)) list.push(p);   // the chain up to the collection
      const kids = t => tethers.filter(x => x.target === t).map(x => x.source);
      const children = kids(selected);
      list.push(...children, ...children.flatMap(kids));                                 // subcollections, then theirs
    }
    list.push(...ns.filter(isData).sort(byDegree));
    list.push(...ns.filter(n => !isData(n)).sort(byDegree).slice(0, MAX_NEIGHBOR_LABELS));
  } else if (searchHits.size) {
    list.push(...[...searchHits].sort(byDegree).slice(0, 40));
  } else {
    const plain = nodes.filter(n => n.kind !== 'collection' && n.kind !== 'subcollection' && nodeVisible(n));
    const linked = plain.filter(n => degree.get(n));
    // With every layer off nothing is linked: the same number of labels goes to the largest nodes instead.
    const size = n => (n.kind === 'folder' ? n.F.files.length * 1000 : n.raw?.lines || 0);
    list.push(...(linked.length ? linked.sort(byDegree) : plain.sort((a, b) => size(b) - size(a) || a.label.localeCompare(b.label))).slice(0, DEFAULT_LABELS));
  }
  return list;
}

function drawLabels() {
  const { k } = view;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  const placed = [];
  const overlaps = b => placed.some(p => b.x0 < p.x1 && b.x1 > p.x0 && b.y0 < p.y1 && b.y1 > p.y0);
  const queue = [];
  const place = (n, force) => {
    if (!n || !nodeVisible(n)) return;
    const big = n.kind === 'folder' || n === selected || n === hovered;
    const font = `${n.kind === 'folder' ? '600 ' : ''}${big ? 12 : 11}px system-ui,-apple-system,sans-serif`;
    ctx.font = font;
    const text = n.kind === 'folder' ? `${n.label} ${n.F.files.length}` : n.label;
    const sx = n.x * k + view.x, sy = n.y * k + view.y;
    const w = ctx.measureText(text).width, gap = n.r * k + 5;
    // Right of the node first; collections may also go left, above or below to avoid a collision.
    const spots = [[sx + gap, sy]];
    if (n.kind === 'collection') {
      for (const f of [1, 2.2]) {
        const g = gap * f, v = (gap + 6) * f;
        spots.push([sx - g - w, sy], [sx - w / 2, sy - v], [sx - w / 2, sy + v],
          [sx + g * 0.7, sy - v * 0.8], [sx + g * 0.7, sy + v * 0.8], [sx - g * 0.7 - w, sy - v * 0.8], [sx - g * 0.7 - w, sy + v * 0.8]);
        if (f === 1) spots.push([sx + g * 2.2, sy]);
      }
    }
    for (const [x, y] of spots) {
      const box = { x0: x - 3, y0: y - 8, x1: x + w + 3, y1: y + 8 };
      if (box.x1 < 0 || box.x0 > width || box.y1 < 0 || box.y0 > height) continue;
      if (!force && overlaps(box)) continue;
      placed.push(box);
      queue.push({ n, text, font, x, y, big });
      return;
    }
  };
  // Group mode: each group's name at the middle of its files, before any node label.
  if (mode === 'files' && colorBy === 'group') {
    const G = groupById(), sums = new Map();
    for (const n of nodes) if (n.kind === 'file' && n.raw.group && nodeVisible(n)) { const o = sums.get(n.raw.group) || sums.set(n.raw.group, { x: 0, y: 0, c: 0 }).get(n.raw.group); o.x += n.x; o.y += n.y; o.c++; }
    for (const [gid, o] of [...sums].sort((a, b) => b[1].c - a[1].c)) {
      const g = G.get(gid); if (!g || o.c < 2) continue;
      const text = `${g.label}`, font = '600 13px system-ui,-apple-system,sans-serif';
      ctx.font = font;
      const w = ctx.measureText(text).width, cx = (o.x / o.c) * k + view.x, cy = (o.y / o.c) * k + view.y;
      const box = { x0: cx - w / 2 - 4, y0: cy - 10, x1: cx + w / 2 + 4, y1: cy + 10 };
      if (box.x1 < 0 || box.x0 > width || box.y1 < 0 || box.y0 > height || overlaps(box)) continue;
      placed.push(box);
      queue.push({ n: { kind: 'group', color: GROUP_PALETTE[(gid - 1) % GROUP_PALETTE.length] }, text, font, x: cx - w / 2, y: cy, big: true, group: true });
    }
  }
  // Hovered always shows, so it reserves its space first.
  if (hovered) place(hovered, true);
  const seen = new Set([hovered]);
  for (const n of labelCandidates()) if (!seen.has(n)) { seen.add(n); place(n, false); }
  lastLabels = queue.map((q, i) => ({ text: q.text, box: placed[i] }));
  for (const q of queue) {
    ctx.font = q.font;
    ctx.lineWidth = 3.5;
    ctx.strokeStyle = 'rgba(3,5,12,0.92)';
    ctx.strokeText(q.text, q.x, q.y);
    ctx.fillStyle = q.group ? q.n.color : q.big ? '#ffffff' : q.n.kind === 'collection' || q.n.kind === 'subcollection' ? '#bfffe9' : 'rgba(215,222,242,0.92)';
    ctx.fillText(q.text, q.x, q.y);
  }
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (sim && sim.alpha() > sim.alphaMin()) { sim.tick(); dirty = true; }
  stepView();
  if (dirty) { dirty = false; draw(); }
}

// ─── interaction ─────────────────────────────────────────────────────────────
const toWorld = (sx, sy) => [(sx - view.x) / view.k, (sy - view.y) / view.k];

function hit(sx, sy) {
  const [wx, wy] = toWorld(sx, sy);
  let best = null, bestD = Infinity;
  for (const n of nodes) {
    if (!nodeVisible(n)) continue;
    const d = Math.hypot(n.x - wx, n.y - wy);
    if (d < n.r + 5 / view.k && d - n.r < bestD) { best = n; bestD = d - n.r; }
  }
  return best;
}

// The drawn edge under the pointer (within a few pixels), for its tooltip.
function hitEdge(sx, sy) {
  const [wx, wy] = toWorld(sx, sy), tol = 4 / view.k;
  let best = null, bestD = tol;
  for (const e of drawEdges) {
    const { source: a, target: b } = e;
    const dx = b.x - a.x, dy = b.y - a.y, len2 = dx * dx + dy * dy;
    if (!len2) continue;
    const t = Math.max(0, Math.min(1, ((wx - a.x) * dx + (wy - a.y) * dy) / len2));
    const d = Math.hypot(wx - (a.x + t * dx), wy - (a.y + t * dy));
    if (d < bestD) { best = e; bestD = d; }
  }
  return best;
}

const nodeName = n => (n.kind === 'file' ? n.raw.path : n.kind === 'subcollection' ? n.raw.pattern : n.kind === 'collection' ? `◆ ${n.raw.name}` : n.label);

// Every visible layer between the two nodes of the edge under the pointer (lines of different layers overlap).
function showEdgeTooltip(e, x, y) {
  const same = drawEdges.filter(d => (d.source === e.source && d.target === e.target) || (d.source === e.target && d.target === e.source));
  same.sort((a, b) => LAYERS.findIndex(l => l.id === a.layer) - LAYERS.findIndex(l => l.id === b.layer));
  tooltip.innerHTML = same.map(d => {
    const L = LAYER_BY_ID[d.layer];
    const what = d.layer === 'calls'
      ? `${plural(d.count, 'call')}${d.value ? ` (${d.value} through a function passed as a value)` : ''}`
      : `${plural(d.count, 'link')}${d.inferred ? ` (${d.inferred} inferred)` : ''}`;
    return `<div><span style="color:${L.color}">●</span> ${esc(L.label)}: ${esc(what)} <span style="color:#8090b0;word-break:break-all">${esc(nodeName(d.source))} → ${esc(nodeName(d.target))}</span></div>`;
  }).join('');
  tooltip.style.display = 'block';
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  tooltip.style.left = `${Math.max(8, Math.min(x + 16, width - tw - 8))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(y + 16, height - th - 8))}px`;
}

function bindPointer() {
  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    viewAnim = null;
    const n = hit(e.offsetX, e.offsetY);
    drag = { n, sx: e.offsetX, sy: e.offsetY, vx: view.x, vy: view.y, moved: false };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
    if (n) { n.fx = n.x; n.fy = n.y; }
  });
  canvas.addEventListener('pointermove', e => {
    if (drag) {
      const dx = e.offsetX - drag.sx, dy = e.offsetY - drag.sy;
      if (Math.hypot(dx, dy) > 3) drag.moved = true;
      if (drag.n) {
        const [wx, wy] = toWorld(e.offsetX, e.offsetY);
        drag.n.fx = wx; drag.n.fy = wy;
        if (drag.moved && sim) { sim.alphaTarget(0.15); if (sim.alpha() < 0.15) sim.alpha(0.15); }
      } else { view.x = drag.vx + dx; view.y = drag.vy + dy; }
      hideTooltip();
      dirty = true;
      return;
    }
    const n = hit(e.offsetX, e.offsetY);
    if (n !== hovered) { hovered = n; dirty = true; }
    canvas.style.cursor = n ? 'pointer' : 'grab';
    if (n) showTooltip(n, e.offsetX, e.offsetY);
    else { const ed = hitEdge(e.offsetX, e.offsetY); if (ed) showEdgeTooltip(ed, e.offsetX, e.offsetY); else hideTooltip(); }
  });
  const end = () => {
    if (!drag) return;
    if (drag.n) { drag.n.fx = null; drag.n.fy = null; sim?.alphaTarget(0); }
    if (!drag.moved) { if (drag.n) select(drag.n); else if (selected) { select(null); viewBeforeSelection = null; } }
    drag = null;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!drag && hovered) { hovered = null; hideTooltip(); dirty = true; } });
  canvas.addEventListener('dblclick', e => {
    const n = hit(e.offsetX, e.offsetY);
    if (n?.kind === 'folder') expandFolder(n.folder);
  });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
    viewAnim = null;
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0018));
    const k = Math.min(8, Math.max(0.08, view.k * f));
    const [wx, wy] = toWorld(e.offsetX, e.offsetY);
    view = { k, x: e.offsetX - wx * k, y: e.offsetY - wy * k };
    hideTooltip();
    dirty = true;
  }, { passive: false });
}

function neighborsOf(n) {
  const s = new Set();
  for (const e of drawEdges) { if (e.source === n) s.add(e.target); else if (e.target === n) s.add(e.source); }
  // A collection and its subcollections belong together: tethered nodes count as connected.
  for (const t of tethers) { if (t.source === n) s.add(t.target); else if (t.target === n) s.add(t.source); }
  return s;
}

// Selecting a node (click, search + Enter, a card or findings item) focuses the view on it and its neighbors.
// The view from before the first selection is kept, so Clear can return to it.
function select(n, { focus = true } = {}) {
  if (n && !selected && !viewBeforeSelection) viewBeforeSelection = viewAnim ? { ...viewAnim.to } : { ...view };
  selected = n || null;
  neighbors = selected ? neighborsOf(selected) : new Set();
  if (selected && focus) focusSelection();
  for (const el of findingsEl.querySelectorAll('.cm-item')) el.classList.toggle('cm-active', !!selected && el.dataset.id === selected.id);
  renderCard();
  dirty = true;
}

function selectById(id) {
  const n = byId.get(id);
  if (!n) return;
  if ((n.kind === 'collection' || n.kind === 'subcollection') && !(layerOn.reads || layerOn.writes)) { layerOn.reads = true; layout(); renderToolbar(); renderLegend(); }
  if (n.kind === 'subcollection' && mode === 'folders') setMode('files');
  if (n.kind === 'file' && !nodeVisible(n)) expandFolder(n.folder);
  if (!nodeVisible(n)) return;
  select(n);
}

// ─── details ─────────────────────────────────────────────────────────────────
// Per layer: links out/in and the distinct files or collections at the other end. One file can link to
// another more than once (for example two import statements for the same module), so both are kept and
// shown together as "48 links from 47 files" rather than as two separate numbers.
function linkSummary(n) {
  const per = {};
  for (const e of edges) {
    if (e.from !== n.id && e.to !== n.id) continue;
    if (byId.get(e.to)?.kind === 'subcollection' || e.sameFile) continue; // counted in the collection / listed separately
    const p = per[e.layer] ||= { outLinks: 0, out: new Set(), inLinks: 0, in: new Set() };
    if (e.from === n.id) { p.outLinks++; p.out.add(e.to); }
    if (e.to === n.id) { p.inLinks++; p.in.add(e.from); }
  }
  return per;
}

function linkPhrase(links, ends, dir) {
  const cols = [...ends].every(id => byId.get(id)?.kind === 'collection');
  const noun = c => plural(c, cols ? 'collection' : 'file');
  return links === ends.size ? noun(links) : `${links} links ${dir === 'in' ? 'from' : 'to'} ${noun(ends.size)}`;
}

function fileDetailsHtml(n) {
  const r = n.raw, per = linkSummary(n);
  const rows = LAYERS.map(L => {
    const p = per[L.id];
    if (!p) return '';
    const parts = [];
    if (p.outLinks) parts.push(`out ${linkPhrase(p.outLinks, p.out, 'out')}`);
    if (p.inLinks) parts.push(`in ${linkPhrase(p.inLinks, p.in, 'in')}`);
    return `<div><span style="color:${L.color}">●</span> ${L.label}: ${parts.join(' · ')}</div>`;
  }).join('');
  const here = (map.navigation?.screens || []).filter(s => s.file === r.path);
  const screen = here.map(s => s.name), isRoute = here.length && here.every(s => s.route);
  const F = folders.get(n.folder);
  return `<div style="color:#fff;font-weight:600;word-break:break-all">${esc(r.path)}</div>
    <div style="color:#5a6890"><span style="color:${F.color}">■</span> ${esc(F.label)} · ${r.lines} lines</div>
    ${screen.length ? `<div style="color:#FF9FE6">${isRoute ? 'Route' : 'Screen'}: ${screen.slice(0, 4).map(esc).join(', ')}${screen.length > 4 ? '…' : ''}</div>` : ''}
    ${r.importedBy ? '' : '<div style="color:#8090b0">Imported by no file</div>'}
    ${r.importedBy && !r.reachableFromAppEntry ? '<div style="color:#8090b0">Not imported from the entry file</div>' : ''}
    ${rows}
    ${r.exports?.length ? `<div style="color:#8090b0">Exports: ${r.exports.slice(0, 8).map(esc).join(', ')}${r.exports.length > 8 ? '…' : ''}</div>` : ''}
    ${r.packages?.length ? `<div style="color:#8090b0">Packages: ${r.packages.slice(0, 8).map(esc).join(', ')}${r.packages.length > 8 ? '…' : ''}</div>` : ''}
    ${r.parseError ? '<div style="color:#e08040">Could not be parsed</div>' : ''}`;
}

function collectionDetailsHtml(n) {
  const r = n.raw;
  const subs = n.kind === 'collection' ? nodes.filter(x => x.kind === 'subcollection' && x.raw.parent === r.name) : [];
  if (n.kind === 'subcollection') {
    return `<div style="color:#fff;font-weight:600;word-break:break-all">◇ ${esc(r.pattern)}</div>
      <div style="color:#5a6890">Firestore subcollection of ${esc(r.parent)}</div>
      <div>Read by ${plural(r.readers, 'file')}, written by ${r.writers}${r.usedWithUnknownOperation ? `, ${r.usedWithUnknownOperation} unknown` : ''}</div>`;
  }
  return `<div style="color:#fff;font-weight:600">◆ ${esc(r.name)}</div>
    <div style="color:#5a6890">Firestore collection${subs.length ? `; counts include its ${plural(subs.length, 'subcollection')}` : ''}</div>
    <div>Read by ${plural(r.readers, 'file')}, written by ${r.writers}${r.usedWithUnknownOperation ? `, ${r.usedWithUnknownOperation} unknown` : ''}</div>
    ${r.paths?.length ? `<div style="color:#8090b0;margin-top:3px">${r.paths.slice(0, 6).map(esc).join('<br>')}${r.paths.length > 6 ? '<br>…' : ''}</div>` : ''}`;
}

// Links between this folder and every other folder or collection, on visible layers.
function folderLinks(key) {
  const groupOf = id => { const n = byId.get(id); return n.kind === 'file' ? n.folder : n.id; };
  const rows = new Map();
  let inside = 0, totalIn = 0, totalOut = 0;
  const row = g => rows.get(g) || (rows.set(g, { g, in: 0, out: 0 }), rows.get(g));
  for (const e of edges) {
    if (!layerOn[e.layer] || byId.get(e.to)?.kind === 'subcollection' || e.sameFile) continue; // subcollections count in their parent
    const a = groupOf(e.from), b = groupOf(e.to);
    if (a === key && b === key) inside++;
    else if (a === key) { row(b).out++; totalOut++; }
    else if (b === key) { row(a).in++; totalIn++; }
  }
  return { inside, totalIn, totalOut, rows: [...rows.values()].sort((x, y) => y.in + y.out - x.in - x.out || String(x.g).localeCompare(String(y.g))) };
}

function folderSummaryHtml(n) {
  const F = n.F;
  return `<div style="color:#fff;font-weight:600"><span style="color:${F.color}">●</span> ${esc(F.label)}</div>
    <div style="color:#8090b0">${plural(F.files.length, 'file')} · ${F.lines.toLocaleString()} lines</div>`;
}

function folderCardHtml(n) {
  const F = n.F, L = folderLinks(F.key);
  const name = g => {
    const f = folders.get(g);
    if (f) return `<span style="color:${f.color}">●</span> ${esc(f.label)}`;
    return `<span style="color:${COLLECTION_COLOR}">◆</span> ${esc(byId.get(g)?.label ?? g)}`;
  };
  const table = L.rows.length
    ? `<table class="cm-t"><tr><th>Folder</th><th title="Links from that folder into this one">in</th><th title="Links from this folder to that one">out</th></tr>
      ${L.rows.map(r => `<tr><td>${name(r.g)}</td><td>${r.in || '·'}</td><td>${r.out || '·'}</td></tr>`).join('')}
      <tr><td style="color:#5a6890">Total</td><td style="color:#c8d0e8">${L.totalIn}</td><td style="color:#c8d0e8">${L.totalOut}</td></tr></table>`
    : '<div style="color:#5a6890">No links to other folders on the visible layers.</div>';
  const top = [...F.files].sort((a, b) => (b.raw.importedBy || 0) - (a.raw.importedBy || 0) || a.raw.path.localeCompare(b.raw.path)).slice(0, 5);
  return `${folderSummaryHtml(n)}
    <div style="display:flex;gap:6px;margin-top:7px">
      <button class="cm-btn" data-act="expand" data-key="${esc(F.key)}">Show files</button>
      <button class="cm-btn" data-act="clear" style="margin-left:auto">Clear</button></div>
    <div class="cm-h">Links in and out, per folder</div>
    ${table}
    ${L.inside ? `<div style="color:#5a6890;margin-top:3px">${plural(L.inside, 'link')} between files inside ${esc(F.label)}</div>` : ''}
    <div class="cm-h">Most imported files inside</div>
    ${top.map(f => `<button class="cm-item" data-id="${esc(f.id)}" title="${esc(f.raw.path)}">${esc(f.raw.path)} <span style="color:#5a6890">· imported by ${f.raw.importedBy || 0}</span></button>`).join('')}`;
}

function showTooltip(n, x, y) {
  tooltip.innerHTML = n.kind === 'folder'
    ? `${folderSummaryHtml(n)}<div style="color:#5a6890">Click for its links · double-click to show its files</div>`
    : n.kind === 'collection' || n.kind === 'subcollection' ? collectionDetailsHtml(n) : fileDetailsHtml(n);
  tooltip.style.display = 'block';
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  tooltip.style.left = `${Math.max(8, Math.min(x + 16, width - tw - 8))}px`;
  tooltip.style.top = `${Math.max(8, Math.min(y + 16, height - th - 8))}px`;
}
function hideTooltip() { if (tooltip) tooltip.style.display = 'none'; }

// ─── selection card (top right, separate from the findings) ──────────────────
function renderCard() {
  if (!cardEl) return;
  if (!selected) { cardEl.style.display = 'none'; cardEl.innerHTML = ''; return; }
  if (selected.kind === 'folder') cardEl.innerHTML = folderCardHtml(selected);
  else {
    const ns = [...neighbors].sort((a, b) => a.label.localeCompare(b.label));
    const inExpanded = selected.kind === 'file' && mode === 'folders' && expanded.has(selected.folder);
    const nName = n => (n.kind === 'collection' ? `◆ ${n.raw.name}` : n.kind === 'subcollection' ? `◇ ${n.raw.pattern}` : n.kind === 'folder' ? `● ${n.label} (${plural(n.F.files.length, 'file')})` : n.raw.path);
    const isData = selected.kind === 'collection' || selected.kind === 'subcollection';
    cardEl.innerHTML = `${isData ? collectionDetailsHtml(selected) : fileDetailsHtml(selected)}
      ${isData ? throughFunctionsHtml(selected) : functionsHtml(selected)}
      <div style="display:flex;gap:6px;align-items:center;margin-top:7px">
        <span style="color:#5a6890">Connected on visible layers: ${ns.length}</span>
        ${inExpanded ? `<button class="cm-btn" data-act="collapse" data-key="${esc(selected.folder)}" style="margin-left:auto;padding:1px 7px;font-size:11px">Collapse ${esc(folders.get(selected.folder).label)}</button>` : ''}
        <button class="cm-btn" data-act="clear" style="${inExpanded ? '' : 'margin-left:auto;'}padding:1px 7px;font-size:11px">Clear</button></div>
      ${ns.length ? `<div style="margin-top:4px">${ns.map(n => `<button class="cm-item" data-id="${esc(n.id)}" title="${esc(nName(n))}">${esc(nName(n))}</button>`).join('')}</div>` : ''}`;
  }
  cardEl.style.display = 'block';
  sizeCard();
}

// ─── function calls in the card ──────────────────────────────────────────────
const fileItem = (id, text) => `<button class="cm-item" data-id="${esc(id)}" title="${esc(id)}">${text}</button>`;
const wrapItem = (id, text) => `<button class="cm-item cm-wrap" data-id="${esc(id)}" title="${esc(id)}">${text}</button>`;
// The first `limit` rows, then the rest hidden behind a "+N more" toggle.
function moreList(rows, limit, noun = 'more') {
  if (ALL_ROWS || rows.length <= limit) return rows.join('');
  const label = `+${rows.length - limit} ${noun}`;
  return `${rows.slice(0, limit).join('')}<div hidden>${rows.slice(limit).join('')}</div><button class="cm-more" data-act="more" data-label="${esc(label)}">${esc(label)}</button>`;
}
const ALL_ROWS = false;
const callsInto = (file, fn) => edges.filter(e => e.kind === 'calls' && e.to === file && (e.function === fn || e.local === fn || e.export === fn));
// Caller rows as brainmap shows them: file (lines) in function, via value from file:line.
function callerRows(list, limit) {
  const by = new Map();
  for (const e of list) { const k = e.via === 'value' ? `${e.from}\0${e.passedFrom}:${e.passedLine}` : e.sameFile ? `${e.from}\0same\0${e.caller}` : e.from; (by.get(k) || by.set(k, []).get(k)).push(e); }
  const rows = [...by.values()].sort((a, b) => a[0].from.localeCompare(b[0].from)).map(es => {
    const e0 = es[0], ls = [...new Set(es.map(e => e.line))].sort((a, b) => a - b);
    const callers = [...new Set(es.map(e => e.caller).filter(Boolean))];
    return wrapItem(e0.from, `${esc(e0.from)} <span style="color:#5a6890">(line${ls.length > 1 ? 's' : ''} ${ls.join(', ')})${callers.length ? ` in ${esc(callers.join(', '))}` : ''}${e0.sameFile ? ' · same file' : ''}${e0.via === 'value' ? ` · via value from ${esc(e0.passedFrom)}:${e0.passedLine}` : ''}</span>`);
  });
  return moreList(rows, limit);
}

// A file: its exported functions with how many files call each, and the functions it calls in other files.
function functionsHtml(n) {
  if (n.kind !== 'file') return '';
  const inc = edges.filter(e => e.kind === 'calls' && e.to === n.id && !e.sameFile);
  const local = edges.filter(e => e.kind === 'calls' && e.from === n.id && e.sameFile);
  const localBy = new Map();
  for (const e of local) localBy.set(e.function, (localBy.get(e.function) || 0) + 1);
  const byFn = new Map();
  for (const e of inc) (byFn.get(e.function) || byFn.set(e.function, new Set()).get(e.function)).add(e.from);
  const exported = (n.raw.exports || []).filter(x => x !== 'default' && !x.startsWith('* from'));
  const rows = [...new Set([...byFn.keys(), ...exported])].map(fn => ({ fn, files: byFn.get(fn)?.size || 0 }))
    .sort((a, b) => b.files - a.files || a.fn.localeCompare(b.fn));
  const called = rows.filter(r => r.files);
  const onlyLocal = rows.filter(r => !r.files && localBy.get(r.fn));
  const silent = rows.length - called.length - onlyLocal.length;
  const out = new Map();
  for (const e of edges) if (e.kind === 'calls' && e.from === n.id && !e.sameFile) { const k = `${e.to}\0${e.function}`; (out.get(k) || out.set(k, { to: e.to, fn: e.function, n: 0, value: 0 }).get(k)).n++; if (e.via === 'value') out.get(k).value++; }
  const outRows = [...out.values()].sort((a, b) => b.n - a.n || a.fn.localeCompare(b.fn));
  // Calls inside this file: caller → callee, grouped.
  const pairs = new Map();
  for (const e of local) { const k = `${e.caller ?? 'top level'}\0${e.function}`; pairs.set(k, (pairs.get(k) || 0) + 1); }
  const localRows = [...pairs].sort((a, b) => a[0].localeCompare(b[0])).map(([k, c]) => { const [from, to] = k.split('\0'); return `<div style="padding-left:4px;word-break:break-word">${esc(from)} <span style="color:#5a6890">→</span> ${esc(to)}${c > 1 ? ` <span style="color:#5a6890">×${c}</span>` : ''}</div>`; });
  if (!rows.length && !outRows.length && !localRows.length) return '';
  return `${rows.length ? `<div class="cm-h">Exported functions, files calling each</div>
      ${moreList(called.map(r => `<div style="display:flex;gap:6px"><span style="flex:1;word-break:break-word">${esc(r.fn)}</span><span style="color:#c8d0e8">${r.files}</span></div>`), 12, 'more called')}
      ${onlyLocal.length ? `<div style="color:#5a6890">Called only inside this file: ${onlyLocal.map(r => `${esc(r.fn)} (${localBy.get(r.fn)})`).join(', ')}</div>` : ''}
      ${silent ? `<div style="color:#5a6890">${plural(silent, 'other export')} not called anywhere in the map</div>` : ''}` : ''}
    ${outRows.length ? `<div class="cm-h">Calls functions in other files</div>
      ${moreList(outRows.map(r => wrapItem(r.to, `${esc(r.fn)} <span style="color:#5a6890">(${esc(r.to)})${r.n > 1 ? ` ×${r.n}` : ''}${r.value ? ' · via value' : ''}</span>`)), 12)}` : ''}
    ${localRows.length ? `<div class="cm-h">Calls inside this file (${local.length})</div>${moreList(localRows, 12)}` : ''}`;
}

// A collection or subcollection: the functions that read or write it and who calls them (depth 1), as brainmap collection.
function throughFunctionsHtml(n) {
  const fns = new Map();
  for (const e of edges) {
    if (e.to !== n.id || (e.kind !== 'reads' && e.kind !== 'writes')) continue;
    for (const st of e.sites || []) {
      if (!st.function) continue;
      const k = `${e.from}\0${st.function}`;
      (fns.get(k) || fns.set(k, { file: e.from, fn: st.function, ops: new Set() }).get(k)).ops.add(e.kind);
    }
  }
  const list = [...fns.values()].sort((a, b) => a.file.localeCompare(b.file) || a.fn.localeCompare(b.fn));
  if (!list.length) return '';
  return `<div class="cm-h">Through functions (${list.length})</div>
    ${moreList(list.map(f => {
      // Depth 1 as brainmap collection: calls inside the file are followed to the first callers elsewhere.
      const calls = [];
      const top = callerTree(map, f.file, f.fn, 1, CIDX ??= callIndex(map));
      const walk = ns => { for (const x of ns) { calls.push(x.e); walk(x.children); } };
      walk(top);
      // Direct callers decide the wording; files reached through same-file helpers are counted separately.
      const direct = new Set(top.filter(n => !n.e.sameFile).map(n => n.e.from)), same = top.filter(n => n.e.sameFile).length;
      const reached = new Set(calls.filter(e => e.from !== f.file).map(e => e.from));
      const summary = direct.size ? `${plural(direct.size, 'file')}${same ? ` (and ${plural(same, 'place')} in its own file)` : ''}`
        : same ? `called only inside its own file (${plural(same, 'place')})${reached.size ? `, reached from ${plural(reached.size, 'file')}` : ''}` : 'no calls found';
      return `<div style="margin-top:4px"><span style="color:#fff">${esc(f.fn)}</span> <span style="color:#5a6890">(${esc(f.file)}, ${[...f.ops].join(' and ')}) ← ${summary}</span></div>
        ${calls.length ? `<div style="padding-left:10px">${callerRows(calls, 4)}</div>` : ''}`;
    }), 10, 'more functions')}`;
}

function sizeCard() {
  if (!cardEl || cardEl.style.display === 'none') return;
  cardEl.style.maxHeight = `${Math.max(140, height - TOP - legendEl.offsetHeight - 28)}px`;
}

// ─── toolbar, legend ─────────────────────────────────────────────────────────
function renderToolbar() {
  const fileCount = map.counts?.nodesByKind?.file ?? nodes.filter(n => n.kind === 'file').length;
  const colCount = map.counts?.nodesByKind?.collection ?? 0;
  const when = map.generatedAt ? new Date(map.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  // Subcollection edges are inside their top-level collection's, so they are not counted again here.
  // Calls inside a file are not drawn and not counted here (they are listed in the file's card).
  const layerCount = id => edges.filter(e => e.layer === id && byId.get(e.to)?.kind !== 'subcollection' && !e.sameFile).length;
  toolbarEl.innerHTML = `
    <button class="cm-btn cm-back">← Back to brain</button>
    <div style="font-size:13px;color:#fff;font-weight:600">${esc(project.name)}</div>
    <div style="font-size:11px;color:#5a6890">${fileCount} files · ${folders.size} folders${colCount ? ` · ${colCount} collections` : ''} · mapped ${esc(when)}</div>
    <input class="cm-search" type="text" placeholder="Search files…" value="${esc(searchQuery)}" />
    <span class="cm-hits" style="font-size:11px;color:#5a6890"></span>
    <div style="flex-basis:100%;height:0"></div>
    <div class="cm-seg" role="group" aria-label="View">
      <button data-mode="folders" aria-pressed="${mode === 'folders'}">Folders</button><button data-mode="files" aria-pressed="${mode === 'files'}">Files</button>
    </div>
    ${mode === 'files' && map.groups?.list?.length ? `<span style="font-size:11px;color:#5a6890">Color by</span><div class="cm-seg cm-colorby" role="group" aria-label="Color by">
      <button data-color="folder" aria-pressed="${colorBy === 'folder'}">Folder</button><button data-color="group" aria-pressed="${colorBy === 'group'}">Group</button></div>` : ''}
    ${LAYERS.map(L => `<button class="cm-chip" data-layer="${L.id}" aria-pressed="${!!layerOn[L.id]}">
      <span class="cm-dot" style="background:${L.color};box-shadow:0 0 6px ${L.color}"></span>${L.label}
      <span style="color:#5a6890">${layerCount(L.id)}</span></button>`).join('')}
    <button class="cm-btn cm-fit" style="margin-left:4px">Fit</button>
    ${mode === 'folders' && expanded.size ? `<button class="cm-btn cm-collapse-all">Collapse ${expanded.size === 1 ? folders.get([...expanded][0]).label : `${expanded.size} folders`}</button>` : ''}`;
  toolbarEl.querySelector('.cm-back').addEventListener('click', closeCodeMap);
  toolbarEl.querySelector('.cm-fit').addEventListener('click', () => fit(true));
  toolbarEl.querySelector('.cm-collapse-all')?.addEventListener('click', () => {
    const keys = [...expanded];
    if (keys.length === 1) return collapseFolder(keys[0]);
    expanded = new Set(); select(null); layout({ warm: true, refit: true });
    if (searchQuery) runSearch(searchQuery);
    renderToolbar();
  });
  for (const b of toolbarEl.querySelectorAll('.cm-seg button[data-mode]')) b.addEventListener('click', () => setMode(b.dataset.mode));
  for (const b of toolbarEl.querySelectorAll('.cm-colorby button')) b.addEventListener('click', () => setColorBy(b.dataset.color));
  for (const b of toolbarEl.querySelectorAll('.cm-chip')) {
    b.addEventListener('click', () => {
      layerOn[b.dataset.layer] = !layerOn[b.dataset.layer];
      b.setAttribute('aria-pressed', String(layerOn[b.dataset.layer]));
      if (selected && !nodeVisible(selected)) select(null);
      layout();
      if (searchQuery) runSearch(searchQuery);
      renderCard();
      renderLegend();
    });
  }
  const input = toolbarEl.querySelector('.cm-search');
  input.addEventListener('input', () => runSearch(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const first = searchMatches[0]; if (first) selectById(first.id); }
    if (e.key === 'Escape') { input.value = ''; runSearch(''); input.blur(); }
  });
  updateHits();
  placeBelowToolbar();
}

// Findings and the selection card sit just under the toolbar, which wraps onto more rows on narrow windows.
function placeBelowToolbar() {
  TOP = Math.max(60, Math.round(toolbarEl.offsetHeight + 6));
  findingsEl.style.top = cardEl.style.top = `${TOP}px`;
  findingsEl.style.maxHeight = `calc(100% - ${TOP + 14}px)`;
  sizeCard();
}

// Matches are files and collections; in the Folders view a file inside a collapsed folder lights its bubble.
function runSearch(q) {
  searchQuery = q;
  const s = q.trim().toLowerCase();
  searchMatches = s ? nodes.filter(n => (n.kind === 'file' || ((n.kind === 'collection' || n.kind === 'subcollection') && nodeVisible(n)))
    && (n.kind === 'collection' ? n.raw.name : n.kind === 'subcollection' ? n.raw.pattern : n.raw.path).toLowerCase().includes(s)) : [];
  searchHits = new Set(searchMatches.map(repOf).filter(nodeVisible));
  updateHits();
  dirty = true;
}
function updateHits() {
  const el = toolbarEl.querySelector('.cm-hits');
  if (el) el.textContent = searchQuery.trim() ? `${searchMatches.length} match${searchMatches.length === 1 ? '' : 'es'}${searchMatches.length ? ' · Enter to select' : ''}` : '';
}

function renderLegend() {
  const colored = rankedFolders.filter(F => F.colored), others = rankedFolders.filter(F => !F.colored);
  const row = (color, name, count, title = name) =>
    `<div style="display:flex;align-items:center;gap:7px;margin:3px 0" title="${esc(title)}"><span class="cm-swatch" style="background:${color}"></span>
      <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</span><span style="color:#5a6890">${count}</span></div>`;
  const groups = mode === 'files' && colorBy === 'group';
  const rows = groups
    ? (map.groups.list.map(g => row(GROUP_PALETTE[(g.id - 1) % GROUP_PALETTE.length], `${g.id}. ${g.label}`, g.size)).join('')
      + (map.groups.isolated.length ? row(OTHER_COLOR, 'isolated', map.groups.isolated.length) : ''))
    : colored.map(F => row(F.color, F.label, F.files.length)).join('') +
      (others.length ? row(OTHER_COLOR, 'other folders', others.reduce((s, F) => s + F.files.length, 0), others.map(F => F.label).join(', ')) : '');
  const showCols = layerOn.reads || layerOn.writes;
  legendEl.innerHTML = `
    <button class="cm-legend-toggle" aria-expanded="${!!legendOpen}" style="display:flex;width:100%;align-items:center;gap:6px;background:none;border:none;cursor:pointer;
      padding:8px 11px;color:#8090b0;font-size:10.5px;letter-spacing:0.05em;text-transform:uppercase">
      <span style="font-size:10px;width:10px">${legendOpen ? '▾' : '▸'}</span>Legend<span style="margin-left:auto;text-transform:none;letter-spacing:0">${mode === 'folders' ? 'folders by folder' : colorBy === 'group' ? 'files by group' : 'files by folder'}</span></button>
    ${legendOpen ? `<div style="padding:0 11px 9px">
      <div class="cm-scroll" style="max-height:240px;overflow-y:auto">${rows}</div>
      <div style="display:flex;align-items:center;gap:7px;margin-top:6px;${showCols ? '' : 'opacity:0.45'}">
        <span style="width:9px;height:9px;transform:rotate(45deg);border:1.4px solid ${COLLECTION_COLOR};background:${hexA(COLLECTION_COLOR, 0.35)};margin:0 2px"></span>
        <span>Firestore collection${showCols ? '' : ' (turn on Reads or Writes)'}</span></div>
      <div style="display:flex;align-items:center;gap:7px;margin-top:4px;${showCols && mode === 'files' ? '' : 'opacity:0.45'}">
        <span style="width:7px;height:7px;transform:rotate(45deg);border:1.2px solid ${SUBCOLLECTION_COLOR};margin:0 3px"></span>
        <span>Subcollection, tied to its collection${mode === 'files' ? '' : ' (Files view; counted in its collection here)'}</span></div>
      ${layerOn.calls ? `<div style="display:flex;align-items:center;gap:7px;margin-top:4px">
        <span style="width:14px;border-top:1.5px dashed ${LAYER_BY_ID.calls.color}"></span><span>Call through a function passed as a value</span></div>` : ''}
      <div style="color:#5a6890;margin-top:6px;line-height:1.45">${mode === 'folders'
        ? 'Bubble size: number of files. Line thickness: number of file links, per layer. Double-click a bubble to show its files.'
        : 'Dot size: lines of code.'} Click a node to see its connections.</div></div>` : ''}`;
}

// ─── findings ────────────────────────────────────────────────────────────────
function notImported() {
  const files = map.nodes.filter(n => n.kind === 'file');
  const out = new Map(files.map(f => [f.path, []]));
  for (const e of map.edges) if (LAYER_OF[e.kind] === 'import' && out.has(e.from)) out.get(e.from).push(e.to);
  const reach = start => { const seen = new Set(), st = [start]; while (st.length) { const f = st.pop(); if (!f || seen.has(f) || !out.has(f)) continue; seen.add(f); st.push(...out.get(f)); } return seen; };
  return (map.rootGroups || []).map(g => {
    const members = files.filter(f => f.rootGroup === g.name);
    if (g.entry) {
      const seen = reach(g.entry);
      return { group: g, entry: g.entry, files: members.filter(f => !seen.has(f.path)) };
    }
    return { group: g, entry: null, files: members };
  });
}

// The same report as brainmap report: most-connected files, most-called functions, busiest data, bridges, rare links.
function reportBody() {
  const r = computeReport(map);
  const item = (id, text, title = text) => `<button class="cm-item" data-id="${esc(id)}" title="${esc(title)}">${esc(text)}</button>`;
  const kinds = o => Object.entries(o.byKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${n} ${k}`).join(', ');
  const block = (title, rows) => `<div class="cm-sub">${esc(title)}</div>${rows.length ? rows.join('') : '<div class="cm-note">None</div>'}`;
  return block('Most depended-on files', r.dependedOn.map(x => item(x.file, `${x.total} · ${x.file}`, `${x.file}: ${kinds(x)}`)))
    + block('Most dependent files', r.dependent.map(x => item(x.file, `${x.total} · ${x.file}`, `${x.file}: ${kinds(x)}`)))
    + block('Most-called functions (files)', r.functions.map(x => item(x.file, `${x.files} · ${x.fn}`, `${x.fn} in ${x.file}: ${x.calls} calls`)))
    + block('Busiest data (reader + writer files)', r.data.map(x => item(x.id, `${x.total} · ${x.name}`, `${x.readers} read, ${x.writers} write`)))
    + block('Bridges (import graph)', r.bridges.map(x => item(x.file, `${x.file} · cuts off ${x.cutOff}`, `parts: ${x.parts.join(', ')}`)))
    + block('Rare links between folders', r.surprising.map(x => item(x.from, `${x.from} → ${x.to}`, `${x.kind}${x.what ? ` ${x.what}` : ''}, line ${x.line ?? '?'}; ${x.folders.join(' ↔ ')}: ${x.pairLinks} links`)))
    + block('Suggested questions', r.questions.map(q => `<div class="cm-note" style="padding-top:2px;padding-bottom:2px" title="${esc(q.why)}">${esc(q.cmd)}</div>`));
}

function renderFindings() {
  const sec = (title, count, body) =>
    `<details class="cm-sec" name="cm-findings"><summary>${title}<span class="cm-count">${count}</span></summary><div class="cm-sec-body cm-scroll">${body}</div></details>`;
  const item = (id, text, title = text) => `<button class="cm-item" data-id="${esc(id)}" title="${esc(title)}">${esc(text)}</button>`;
  const list = files => (files.length ? files.map(f => item(f.path, f.path)).join('') : '<div class="cm-note">None</div>');

  // "Not imported": app files only. Root groups without an entry (scripts/) are listed on their own.
  const groups = notImported();
  const app = groups.find(g => g.group.name === 'app' && g.entry);
  const notImportedFiles = app ? app.files : [];
  const notImportedBody = app
    ? `<div class="cm-note">App files that are not reached by imports from ${esc(app.entry)}.</div>${list(app.files)}`
    : '<div class="cm-note">No app entry file found.</div>';
  const standalone = groups.filter(g => !g.entry).flatMap(g => g.files);
  const standaloneBody = `<div class="cm-note">Run by hand (for example with node), so no file imports them. That is expected.</div>${list(standalone)}`;

  const screens = map.navigation?.screens || [];
  const noNav = screens.filter(s => !s.incomingNavigation && !s.incomingAsNestedParent);
  const noNavBody = noNav.length
    ? noNav.map(s => item(s.file || '', `${s.name}${s.parent ? ` (in ${s.parent})` : ''} · ${s.file ? base(s.file) : 'no file'}`, `${s.name} → ${s.file || 'no file'}`)).join('')
    : `<div class="cm-note">${screens.length ? 'None' : 'No navigation screens or web routes found.'}</div>`;

  const KIND_LABEL = { load: 'Module loads with a computed path', navigate: 'Navigation to a computed or unknown screen or route', function: 'Cloud function calls with a computed name', data: 'Firestore paths that could not be resolved' };
  const unresolved = map.unresolved || [];
  const kinds = [...new Set([...(map.kinds?.unresolved || []), ...unresolved.map(u => u.kind)])];
  const unresolvedBody = kinds.map(kind => {
    const l = unresolved.filter(u => u.kind === kind);
    return l.length ? `<div class="cm-sub">${esc(KIND_LABEL[kind] || kind)} · ${l.length}</div>` + l.map(u => item(u.file, `${u.file}:${u.line}${u.reason ? ` · ${u.reason}` : ''}`)).join('') : '';
  }).join('') || '<div class="cm-note">None</div>';
  const unknownOps = map.data?.usesWithUnknownOperation || [];
  const unknownBody = unknownOps.length
    ? `<div class="cm-sub">Also noted: Firestore use with unknown read or write · ${unknownOps.length}</div>` + unknownOps.map(u => item(u.file, `${u.file}:${u.line} · ${u.collection}`)).join('')
    : '';

  findingsEl.innerHTML = `
    <div style="display:flex;align-items:center;padding:9px 10px 4px">
      <div style="font-size:11px;color:#5a6890;letter-spacing:0.06em;text-transform:uppercase">Findings</div>
      <button class="cm-btn cm-collapse" style="margin-left:auto;padding:2px 8px;font-size:11px">Hide</button>
    </div>
    <div class="cm-body">
      ${sec('Not imported', notImportedFiles.length, notImportedBody)}
      ${standalone.length ? sec('Standalone scripts', standalone.length, standaloneBody) : ''}
      ${sec('No incoming navigation found', noNav.length, noNavBody)}
      ${sec('Unresolved', unresolved.length, unresolvedBody + unknownBody)}
      ${sec('Report', 'top 10', reportBody())}
      <div class="cm-note" style="padding:6px 12px 10px">"Not imported" and "no incoming navigation found" mean the map found no link. A file can still be used in ways the map does not see.</div>
    </div>`;
  const collapse = findingsEl.querySelector('.cm-collapse');
  collapse.addEventListener('click', () => {
    const body = findingsEl.querySelector('.cm-body'), hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    collapse.textContent = hidden ? 'Hide' : 'Show';
  });
}
