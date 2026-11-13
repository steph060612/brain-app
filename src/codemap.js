// Code map diagram: a force-directed view of ~/.brain/maps/<slug>/map.json (schemaVersion 2).
// Replaces the brain visual on the left while open. Canvas 2D with pre-rendered glow sprites, so it
// stays smooth at around 1,000 nodes; d3-force is bundled by Vite, so nothing is fetched from outside.
import { forceSimulation, forceManyBody, forceLink, forceX, forceY, forceCollide } from 'd3-force';
import { setBrainPaused } from './brain.js';

const SCHEMA_VERSION = 2;
const BG = '#05070F';
const PANEL_W = 380;

// Edge kinds → toggleable layers.
const LAYERS = [
  { id: 'import',         label: 'Imports',        kinds: ['import', 'require', 're-export', 'dynamic'], color: '#5B7CFF', on: true },
  { id: 'navigate',       label: 'Navigation',     kinds: ['navigate'],       color: '#FF5FD2', on: true },
  { id: 'calls-function', label: 'Cloud functions', kinds: ['calls-function'], color: '#FFB84D', on: false },
  { id: 'reads',          label: 'Reads',          kinds: ['reads'],          color: '#4DFFC3', on: false },
  { id: 'writes',         label: 'Writes',         kinds: ['writes'],         color: '#FF7A59', on: false },
];
const LAYER_OF = Object.fromEntries(LAYERS.flatMap(l => l.kinds.map(k => [k, l.id])));

const FOLDER_COLORS = ['#3B6CFF', '#9FD8FF', '#7C5CFF', '#FF5FD2', '#4DE1FF', '#B388FF', '#5CFFB0',
  '#FFD166', '#FF8A5C', '#6FE3D0', '#A0B4FF', '#FF6B9A', '#C6F36B', '#E59CFF'];
const GROUP_COLORS = { functions: '#FFB84D', scripts: '#8E80B8' };
const ROOT_FILES_COLOR = '#C8D0E8';
const OTHER_COLOR = '#6A7598';
const COLLECTION_COLOR = '#4DFFC3';

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const base = p => p.split('/').pop();

// ─── state ───────────────────────────────────────────────────────────────────
let root = null, canvas = null, ctx = null, tooltip = null, findingsEl = null, legendEl = null, toolbarEl = null, msgEl = null;
let map = null, project = null, onClose = null;
let nodes = [], byId = new Map(), edges = [], drawEdges = [];
let sim = null, view = { x: 0, y: 0, k: 1 }, dpr = 1, width = 0, height = 0;
let layerOn = {};
let hovered = null, selected = null, neighbors = new Set(), searchHits = new Set(), searchQuery = '';
let dirty = true, raf = 0, panelOpen = true;
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
  project = proj; onClose = onBack || null; map = data;
  prepare();
  root.style.display = 'block';
  setBrainPaused(true);
  resize();
  startSim();
  renderToolbar();
  renderLegend();
  renderFindings();
  dirty = true;
  loop();
}

export function closeCodeMap() {
  if (!root) return;
  root.style.display = 'none';
  cancelAnimationFrame(raf); raf = 0;
  sim?.stop(); sim = null;
  map = null; nodes = []; edges = []; drawEdges = [];
  hideTooltip();
  setBrainPaused(false);
  onClose?.();
}

// ─── DOM ─────────────────────────────────────────────────────────────────────
function build() {
  if (root) return;
  root = document.createElement('div');
  root.id = 'code-map';
  root.style.cssText = `position:fixed; top:44px; left:0; right:${PANEL_W}px; bottom:0; z-index:26; display:none;
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
      #code-map .cm-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
      #code-map .cm-panel { background:rgba(8,11,24,0.86); backdrop-filter:blur(6px); border:1px solid rgba(100,120,200,0.16); border-radius:8px; }
      #code-map .cm-sec > summary { cursor:pointer; list-style:none; padding:7px 10px; font-size:12px; color:#c8d0e8; display:flex; gap:6px; align-items:baseline; }
      #code-map .cm-sec > summary::-webkit-details-marker { display:none; }
      #code-map .cm-sec > summary::before { content:'▸'; color:#5a6890; font-size:10px; width:10px; }
      #code-map .cm-sec[open] > summary::before { content:'▾'; }
      #code-map .cm-count { color:#5a6890; font-size:11px; margin-left:auto; }
      #code-map .cm-sub { font-size:10.5px; color:#5a6890; letter-spacing:0.04em; text-transform:uppercase; padding:6px 12px 2px 26px; }
      #code-map .cm-item { display:block; width:100%; text-align:left; background:none; border:none; color:#a8b4d4; font-size:11.5px;
        padding:3px 12px 3px 26px; cursor:pointer; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
      #code-map .cm-item:hover, #code-map .cm-item.cm-active { background:rgba(60,108,255,0.14); color:#fff; }
      #code-map .cm-note { font-size:11px; color:#5a6890; padding:2px 12px 6px 26px; }
      #code-map input.cm-search { background:rgba(255,255,255,0.06); border:1px solid rgba(100,120,200,0.22); border-radius:6px;
        color:#c8d0e8; font-size:12px; padding:4px 9px; width:170px; outline:none; font-family:inherit; }
      #code-map input.cm-search:focus { border-color:rgba(100,120,200,0.5); }
      #code-map .cm-scroll { scrollbar-width:thin; scrollbar-color:#2a3050 transparent; }
    </style>
    <canvas style="position:absolute; inset:0; width:100%; height:100%; cursor:grab; touch-action:none;"></canvas>
    <div class="cm-toolbar" style="position:absolute; top:0; left:0; right:0; padding:10px 14px; display:flex; flex-wrap:wrap; gap:8px 10px; align-items:center;
      background:linear-gradient(${BG}f0, ${BG}00);"></div>
    <div class="cm-findings cm-panel cm-scroll" style="position:absolute; left:14px; top:96px; bottom:14px; width:300px; overflow-y:auto;"></div>
    <div class="cm-legend cm-panel" style="position:absolute; right:14px; bottom:14px; padding:9px 11px; font-size:11px; max-width:240px;"></div>
    <div class="cm-msg" style="position:absolute; left:50%; top:45%; transform:translate(-50%,-50%); color:#8090b0; font-size:13px; display:none;"></div>
    <div class="cm-tip cm-panel" style="position:absolute; pointer-events:none; display:none; padding:8px 10px; font-size:11.5px; max-width:340px; line-height:1.5; z-index:2;"></div>
  `;
  document.body.appendChild(root);
  canvas = root.querySelector('canvas');
  ctx = canvas.getContext('2d');
  toolbarEl = root.querySelector('.cm-toolbar');
  findingsEl = root.querySelector('.cm-findings');
  legendEl = root.querySelector('.cm-legend');
  tooltip = root.querySelector('.cm-tip');
  msgEl = root.querySelector('.cm-msg');

  window.addEventListener('resize', () => { if (isCodeMapOpen()) resize(); });
  window.addEventListener('brain-panel', e => {
    panelOpen = !!e.detail?.open;
    root.style.right = panelOpen ? `${PANEL_W}px` : '0';
    if (isCodeMapOpen()) resize();
  });
  window.addEventListener('keydown', e => {
    if (!isCodeMapOpen() || e.key !== 'Escape' || e.target?.tagName === 'INPUT' || e.target?.tagName === 'TEXTAREA') return;
    select(null);
  });
  findingsEl.addEventListener('click', e => {
    const b = e.target.closest('.cm-item');
    if (b?.dataset.id) selectById(b.dataset.id);
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
function prepare() {
  layerOn = Object.fromEntries(LAYERS.map(l => [l.id, l.on]));
  hovered = selected = null; neighbors = new Set(); searchHits = new Set(); searchQuery = '';

  const files = map.nodes.filter(n => n.kind === 'file');
  // Folder colors: app folders by size, then fixed colors for separate root groups.
  const folderCount = new Map();
  for (const f of files) if (f.rootGroup === 'app' && f.topFolder !== '(root)') folderCount.set(f.topFolder, (folderCount.get(f.topFolder) || 0) + 1);
  const folders = [...folderCount].sort((a, b) => b[1] - a[1]).map(([f]) => f);
  const folderColor = new Map(folders.map((f, i) => [f, FOLDER_COLORS[i] ?? OTHER_COLOR]));

  const colorKey = n => {
    if (n.kind === 'collection') return { key: 'collection', color: COLLECTION_COLOR };
    if (n.rootGroup !== 'app') return { key: `group:${n.rootGroup}`, color: GROUP_COLORS[n.rootGroup] ?? OTHER_COLOR };
    if (n.topFolder === '(root)') return { key: 'folder:(root)', color: ROOT_FILES_COLOR };
    const c = folderColor.get(n.topFolder);
    return c === OTHER_COLOR ? { key: 'folder:(other)', color: OTHER_COLOR } : { key: `folder:${n.topFolder}`, color: c };
  };

  nodes = map.nodes.map(n => {
    const { key, color } = colorKey(n);
    const isCol = n.kind === 'collection';
    const r = isCol ? Math.min(11, 5 + Math.sqrt((n.readers || 0) + (n.writers || 0)) * 1.2)
      : Math.max(2.2, Math.min(9, 1.6 + Math.sqrt(n.lines || 1) / 5.5));
    return { id: n.id, kind: n.kind, raw: n, key, color, r, label: isCol ? n.name : base(n.path), x: 0, y: 0 };
  });
  byId = new Map(nodes.map(n => [n.id, n]));

  edges = map.edges.filter(e => byId.has(e.from) && byId.has(e.to)).map(e => ({ ...e, layer: LAYER_OF[e.kind] })).filter(e => e.layer);

  // Anchors: one per color group on a golden-angle spiral, largest group in the middle.
  const groups = new Map();
  for (const n of nodes) groups.set(n.key, (groups.get(n.key) || 0) + 1);
  const order = [...groups].sort((a, b) => b[1] - a[1]).map(([k]) => k);
  const spacing = 70 + Math.sqrt(nodes.length) * 4;
  const anchors = new Map(order.map((k, i) => {
    const a = i * 2.39996, rr = spacing * Math.sqrt(i + (i ? 0.6 : 0));
    return [k, { x: Math.cos(a) * rr, y: Math.sin(a) * rr }];
  }));
  for (const n of nodes) {
    const a = anchors.get(n.key);
    n.ax = a.x; n.ay = a.y;
    n.x = a.x + (Math.random() - 0.5) * 60; n.y = a.y + (Math.random() - 0.5) * 60;
  }
}

const nodeVisible = n => n.kind !== 'collection' || layerOn.reads || layerOn.writes;

// Visible edges, merged per layer and pair, for drawing and for the layout.
function rebuildEdges() {
  const merged = new Map();
  for (const e of edges) {
    if (!layerOn[e.layer] || e.from === e.to) continue;
    const key = `${e.layer}|${e.from}|${e.to}`;
    const m = merged.get(key);
    if (m) m.count++;
    else merged.set(key, { layer: e.layer, source: byId.get(e.from), target: byId.get(e.to), count: 1 });
  }
  drawEdges = [...merged.values()].filter(e => nodeVisible(e.source) && nodeVisible(e.target));
}

function startSim() {
  rebuildEdges();
  const visible = nodes.filter(nodeVisible);
  const pairs = new Map();
  for (const e of drawEdges) { const k = e.source.id < e.target.id ? `${e.source.id}|${e.target.id}` : `${e.target.id}|${e.source.id}`; if (!pairs.has(k)) pairs.set(k, e); }
  const links = [...pairs.values()].map(e => ({ source: e.source, target: e.target }));
  sim = forceSimulation(visible).stop()
    .force('charge', forceManyBody().strength(n => (n.kind === 'collection' ? -140 : -38)).distanceMax(420).theta(0.9))
    .force('link', forceLink(links).distance(34).strength(0.35))
    .force('x', forceX(n => n.ax).strength(0.05))
    .force('y', forceY(n => n.ay).strength(0.05))
    .force('collide', forceCollide(n => n.r + 1.5).iterations(1))
    .alphaDecay(0.03);
  const warm = Math.min(140, Math.max(40, Math.round(60000 / Math.max(visible.length, 1))));
  for (let i = 0; i < warm; i++) sim.tick();
  fit();
  msgEl.style.display = visible.length ? 'none' : 'block';
  msgEl.textContent = 'Nothing to show.';
}

function relayout() {
  if (!sim) return;
  rebuildEdges();
  const visible = nodes.filter(nodeVisible);
  const pairs = new Map();
  for (const e of drawEdges) { const k = e.source.id < e.target.id ? `${e.source.id}|${e.target.id}` : `${e.target.id}|${e.source.id}`; if (!pairs.has(k)) pairs.set(k, e); }
  sim.nodes(visible);
  sim.force('link').links([...pairs.values()].map(e => ({ source: e.source, target: e.target })));
  sim.alpha(Math.max(sim.alpha(), 0.35));
  if (selected) neighbors = neighborsOf(selected);
  dirty = true;
}

function fit() {
  const vis = nodes.filter(nodeVisible);
  if (!vis.length || !width) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of vis) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  const padL = 330, padT = 100, padR = 40, padB = 40; // keep clear of the findings column and toolbar
  const w = Math.max(1, width - padL - padR), h = Math.max(1, height - padT - padB);
  const k = Math.min(2.2, Math.max(0.12, Math.min(w / (x1 - x0 + 40), h / (y1 - y0 + 40))));
  view = { k, x: padL + w / 2 - k * (x0 + x1) / 2, y: padT + h / 2 - k * (y0 + y1) / 2 };
  dirty = true;
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

  // Edges, one path per layer; edges touching the selection are drawn again on top.
  ctx.lineCap = 'round';
  for (const L of LAYERS) {
    if (!layerOn[L.id]) continue;
    ctx.beginPath();
    let any = false;
    for (const e of drawEdges) {
      if (e.layer !== L.id) continue;
      if (selected && (e.source === selected || e.target === selected)) continue;
      ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y); any = true;
    }
    if (!any) continue;
    ctx.strokeStyle = hexA(L.color, focus ? 0.05 : 0.2);
    ctx.lineWidth = 0.9 / k;
    ctx.stroke();
  }
  if (selected) {
    for (const e of drawEdges) {
      if (e.source !== selected && e.target !== selected) continue;
      const L = LAYERS.find(l => l.id === e.layer);
      ctx.strokeStyle = hexA(L.color, 0.9);
      ctx.lineWidth = (1.3 + Math.min(2, Math.log2(e.count))) / k;
      ctx.beginPath(); ctx.moveTo(e.source.x, e.source.y); ctx.lineTo(e.target.x, e.target.y); ctx.stroke();
      arrow(e, L.color);
    }
  }

  // Nodes
  for (const n of nodes) {
    if (!nodeVisible(n)) continue;
    const dim = focus && !isFocused(n);
    ctx.globalAlpha = dim ? 0.13 : 1;
    const R = n.r * (n === hovered || n === selected ? 4.6 : 3.6);
    ctx.drawImage(sprite(n.color), n.x - R, n.y - R, R * 2, R * 2);
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
  drawLabels(focus);
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

function drawLabels(focus) {
  const { k } = view;
  const toScreen = n => [n.x * k + view.x, n.y * k + view.y];
  const list = new Set();
  if (hovered) list.add(hovered);
  if (selected) { list.add(selected); for (const n of neighbors) list.add(n); }
  if (!selected) for (const n of searchHits) { if (list.size > 60) break; list.add(n); }
  if (!focus) {
    const vis = nodes.filter(nodeVisible);
    if (k >= 2.4) for (const n of vis) list.add(n);
    else if (k >= 1.1) for (const n of vis) if (n.kind === 'collection' || (n.raw.importedBy || 0) >= 8) list.add(n);
    else for (const n of vis) if (n.kind === 'collection') list.add(n);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.font = '11px system-ui,-apple-system,sans-serif';
  ctx.textBaseline = 'middle';
  let drawn = 0;
  for (const n of list) {
    if (!nodeVisible(n)) continue;
    const [x, y] = toScreen(n);
    if (x < -50 || y < -20 || x > width + 50 || y > height + 20) continue;
    if (++drawn > 400) break;
    const strong = n === hovered || n === selected;
    ctx.fillStyle = strong ? '#ffffff' : n.kind === 'collection' ? '#bfffe9' : 'rgba(200,210,235,0.78)';
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 4;
    ctx.fillText(n.label, x + n.r * k + 6, y);
  }
  ctx.shadowBlur = 0;
}

function loop() {
  raf = requestAnimationFrame(loop);
  if (sim && sim.alpha() > sim.alphaMin()) { sim.tick(); dirty = true; }
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
    if (d < n.r + 5 / view.k && d < bestD) { best = n; bestD = d; }
  }
  return best;
}

function bindPointer() {
  let drag = null;
  canvas.addEventListener('pointerdown', e => {
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
    if (n) showTooltip(n, e.offsetX, e.offsetY); else hideTooltip();
  });
  const end = () => {
    if (!drag) return;
    if (drag.n) { drag.n.fx = null; drag.n.fy = null; sim?.alphaTarget(0); }
    if (!drag.moved) select(drag.n);
    drag = null;
    canvas.style.cursor = 'grab';
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
  canvas.addEventListener('pointerleave', () => { if (!drag && hovered) { hovered = null; hideTooltip(); dirty = true; } });
  canvas.addEventListener('wheel', e => {
    e.preventDefault();
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
  return s;
}

function select(n, { center = false } = {}) {
  selected = n || null;
  neighbors = selected ? neighborsOf(selected) : new Set();
  if (selected && center) {
    const k = Math.max(view.k, 1.3);
    const cx = 330 + (width - 330) / 2, cy = 100 + (height - 100) / 2;
    view = { k, x: cx - selected.x * k, y: cy - selected.y * k };
  }
  for (const el of findingsEl.querySelectorAll('.cm-item')) el.classList.toggle('cm-active', !!selected && el.dataset.id === selected.id);
  renderSelection();
  dirty = true;
}

function selectById(id) {
  const n = byId.get(id);
  if (!n) return;
  if (!nodeVisible(n)) { layerOn.reads = true; renderToolbar(); relayout(); }
  select(n, { center: true });
}

// ─── tooltip ─────────────────────────────────────────────────────────────────
function connectionCounts(n) {
  const c = {};
  for (const e of edges) {
    if (e.from === n.id) c[`out:${e.layer}`] = (c[`out:${e.layer}`] || 0) + 1;
    if (e.to === n.id) c[`in:${e.layer}`] = (c[`in:${e.layer}`] || 0) + 1;
  }
  return c;
}

function detailsHtml(n) {
  const r = n.raw;
  if (n.kind === 'collection') {
    return `<div style="color:#fff;font-weight:600">◆ ${esc(r.name)}</div>
      <div style="color:#5a6890">Firestore collection</div>
      <div>Read by ${r.readers} file${r.readers === 1 ? '' : 's'}, written by ${r.writers}${r.usedWithUnknownOperation ? `, ${r.usedWithUnknownOperation} unknown` : ''}</div>
      ${r.paths?.length ? `<div style="color:#8090b0;margin-top:3px">${r.paths.slice(0, 6).map(esc).join('<br>')}${r.paths.length > 6 ? '<br>…' : ''}</div>` : ''}`;
  }
  const c = connectionCounts(n);
  const line = (label, layer) => {
    const i = c[`in:${layer}`] || 0, o = c[`out:${layer}`] || 0;
    return i || o ? `<div>${label}: ${o} out · ${i} in</div>` : '';
  };
  const screen = (map.navigation?.screens || []).filter(s => s.file === r.path).map(s => s.name);
  return `<div style="color:#fff;font-weight:600;word-break:break-all">${esc(r.path)}</div>
    <div style="color:#5a6890">${esc(r.rootGroup)} · ${esc(r.topFolder)} · ${r.lines} lines</div>
    ${screen.length ? `<div style="color:#FF9FE6">Screen: ${screen.slice(0, 4).map(esc).join(', ')}${screen.length > 4 ? '…' : ''}</div>` : ''}
    <div>Imported by ${r.importedBy} file${r.importedBy === 1 ? '' : 's'}${r.reachableFromAppEntry ? '' : ' · not imported from the entry file'}</div>
    ${line('Imports', 'import')}${line('Navigation', 'navigate')}${line('Cloud functions', 'calls-function')}${line('Reads', 'reads')}${line('Writes', 'writes')}
    ${r.exports?.length ? `<div style="color:#8090b0">Exports: ${r.exports.slice(0, 8).map(esc).join(', ')}${r.exports.length > 8 ? '…' : ''}</div>` : ''}
    ${r.packages?.length ? `<div style="color:#8090b0">Packages: ${r.packages.slice(0, 8).map(esc).join(', ')}${r.packages.length > 8 ? '…' : ''}</div>` : ''}
    ${r.parseError ? '<div style="color:#e08040">Could not be parsed</div>' : ''}`;
}

function showTooltip(n, x, y) {
  tooltip.innerHTML = detailsHtml(n);
  tooltip.style.display = 'block';
  const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
  tooltip.style.left = `${Math.min(x + 16, width - tw - 8)}px`;
  tooltip.style.top = `${Math.min(y + 16, height - th - 8)}px`;
}
function hideTooltip() { if (tooltip) tooltip.style.display = 'none'; }

// ─── toolbar, legend ─────────────────────────────────────────────────────────
function renderToolbar() {
  const fileCount = map.counts?.nodesByKind?.file ?? nodes.filter(n => n.kind === 'file').length;
  const colCount = map.counts?.nodesByKind?.collection ?? 0;
  const when = map.generatedAt ? new Date(map.generatedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '';
  const layerCount = id => edges.filter(e => e.layer === id).length;
  toolbarEl.innerHTML = `
    <button class="cm-btn cm-back">← Back to brain</button>
    <div style="font-size:13px;color:#fff;font-weight:600">${esc(project.name)}</div>
    <div style="font-size:11px;color:#5a6890">${fileCount} files${colCount ? ` · ${colCount} collections` : ''} · mapped ${esc(when)}</div>
    <input class="cm-search" type="text" placeholder="Search files…" value="${esc(searchQuery)}" />
    <span class="cm-hits" style="font-size:11px;color:#5a6890"></span>
    <div style="flex-basis:100%;height:0"></div>
    ${LAYERS.map(L => `<button class="cm-chip" data-layer="${L.id}" aria-pressed="${!!layerOn[L.id]}">
      <span class="cm-dot" style="background:${L.color};box-shadow:0 0 6px ${L.color}"></span>${L.label}
      <span style="color:#5a6890">${layerCount(L.id)}</span></button>`).join('')}
    <button class="cm-btn cm-fit" style="margin-left:4px">Fit</button>`;
  toolbarEl.querySelector('.cm-back').addEventListener('click', closeCodeMap);
  toolbarEl.querySelector('.cm-fit').addEventListener('click', fit);
  for (const b of toolbarEl.querySelectorAll('.cm-chip')) {
    b.addEventListener('click', () => {
      layerOn[b.dataset.layer] = !layerOn[b.dataset.layer];
      b.setAttribute('aria-pressed', String(layerOn[b.dataset.layer]));
      if (selected && !nodeVisible(selected)) select(null);
      relayout();
      renderLegend();
    });
  }
  const input = toolbarEl.querySelector('.cm-search');
  input.addEventListener('input', () => runSearch(input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { const first = [...searchHits][0]; if (first) select(first, { center: true }); }
    if (e.key === 'Escape') { input.value = ''; runSearch(''); input.blur(); }
  });
  updateHits();
}

function runSearch(q) {
  searchQuery = q;
  const s = q.trim().toLowerCase();
  searchHits = new Set(s ? nodes.filter(n => nodeVisible(n) && (n.kind === 'collection' ? n.raw.name : n.raw.path).toLowerCase().includes(s)) : []);
  updateHits();
  dirty = true;
}
function updateHits() {
  const el = toolbarEl.querySelector('.cm-hits');
  if (el) el.textContent = searchQuery.trim() ? `${searchHits.size} match${searchHits.size === 1 ? '' : 'es'}${searchHits.size ? ' · Enter to select' : ''}` : '';
}

function renderLegend() {
  const seen = new Map();
  for (const n of nodes) if (nodeVisible(n) && n.kind === 'file') seen.set(n.key, { color: n.color, count: (seen.get(n.key)?.count || 0) + 1 });
  const label = k => k.startsWith('group:') ? `${k.slice(6)}/ (own root)` : k === 'folder:(root)' ? 'project root files' : k === 'folder:(other)' ? 'other folders' : `${k.slice(7)}/`;
  const rows = [...seen].sort((a, b) => b[1].count - a[1].count).map(([k, v]) =>
    `<div style="display:flex;align-items:center;gap:7px;margin:2px 0"><span class="cm-dot" style="background:${v.color};box-shadow:0 0 6px ${v.color}"></span>
      <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(label(k))}</span><span style="color:#5a6890">${v.count}</span></div>`).join('');
  const showCols = layerOn.reads || layerOn.writes;
  legendEl.innerHTML = `<div style="color:#5a6890;font-size:10.5px;letter-spacing:0.05em;text-transform:uppercase;margin-bottom:4px">Files by folder</div>
    <div class="cm-scroll" style="max-height:220px;overflow-y:auto">${rows}</div>
    <div style="display:flex;align-items:center;gap:7px;margin-top:6px;${showCols ? '' : 'opacity:0.45'}">
      <span style="width:9px;height:9px;transform:rotate(45deg);border:1.4px solid ${COLLECTION_COLOR};background:${hexA(COLLECTION_COLOR, 0.35)};margin:0 1px"></span>
      <span>Firestore collection${showCols ? '' : ' (turn on Reads or Writes)'}</span></div>
    <div style="color:#5a6890;margin-top:6px">Size: lines of code. Click a node to highlight its connections.</div>`;
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
    return { group: g, entry: null, files: members.filter(f => !f.importedBy) };
  });
}

function renderFindings() {
  const sec = (title, count, body, open = false) =>
    `<details class="cm-sec" ${open ? 'open' : ''}><summary>${title}<span class="cm-count">${count}</span></summary>${body}</details>`;
  const item = (id, text, title = text) => `<button class="cm-item" data-id="${esc(id)}" title="${esc(title)}">${esc(text)}</button>`;

  const groups = notImported();
  const notImportedBody = groups.map(g => {
    const head = g.entry ? `${esc(g.group.name)}: not imported from ${esc(g.entry)}` : `${esc(g.group.name)}: imported by no file (no entry file)`;
    const list = g.files.length ? g.files.map(f => item(f.path, f.path)).join('') : '<div class="cm-note">None</div>';
    return `<div class="cm-sub">${head} · ${g.files.length}</div>${list}`;
  }).join('');
  const notImportedCount = groups.reduce((n, g) => n + g.files.length, 0);

  const screens = map.navigation?.screens || [];
  const noNav = screens.filter(s => !s.incomingNavigation && !s.incomingAsNestedParent);
  const noNavBody = noNav.length
    ? noNav.map(s => item(s.file || '', `${s.name}${s.parent ? ` (in ${s.parent})` : ''} · ${s.file ? base(s.file) : 'no file'}`, `${s.name} → ${s.file || 'no file'}`)).join('')
    : `<div class="cm-note">${screens.length ? 'None' : 'No React Navigation screens found.'}</div>`;

  const KIND_LABEL = { load: 'Module loads with a computed path', navigate: 'Navigation with a computed screen name', function: 'Cloud function calls with a computed name', data: 'Firestore paths that could not be resolved' };
  const unresolved = map.unresolved || [];
  const kinds = map.kinds?.unresolved || [...new Set(unresolved.map(u => u.kind))];
  const unresolvedBody = kinds.map(kind => {
    const list = unresolved.filter(u => u.kind === kind);
    return `<div class="cm-sub">${esc(KIND_LABEL[kind] || kind)} · ${list.length}</div>` +
      (list.length ? list.map(u => item(u.file, `${u.file}:${u.line}`)).join('') : '<div class="cm-note">None</div>');
  }).join('');
  const unknownOps = map.data?.usesWithUnknownOperation || [];
  const unknownBody = unknownOps.length
    ? `<div class="cm-sub">Firestore use with unknown read or write · ${unknownOps.length}</div>` + unknownOps.map(u => item(u.file, `${u.file}:${u.line} · ${u.collection}`)).join('')
    : '';

  findingsEl.innerHTML = `
    <div style="display:flex;align-items:center;padding:9px 10px 4px">
      <div style="font-size:11px;color:#5a6890;letter-spacing:0.06em;text-transform:uppercase">Findings</div>
      <button class="cm-btn cm-collapse" style="margin-left:auto;padding:2px 8px;font-size:11px">Hide</button>
    </div>
    <div class="cm-selection"></div>
    <div class="cm-body">
      ${sec('Not imported', notImportedCount, notImportedBody, true)}
      ${sec('No incoming navigation found', noNav.length, noNavBody)}
      ${sec('Unresolved', unresolved.length, unresolvedBody + unknownBody)}
      <div class="cm-note" style="padding:8px 12px 10px">"Not imported" and "no incoming navigation found" mean the map found no link. A file can still be used in ways the map does not see.</div>
    </div>`;
  findingsEl.style.bottom = '14px';
  const collapse = findingsEl.querySelector('.cm-collapse');
  collapse.addEventListener('click', () => {
    const body = findingsEl.querySelector('.cm-body'), hidden = body.style.display === 'none';
    body.style.display = hidden ? '' : 'none';
    findingsEl.querySelector('.cm-selection').style.display = hidden ? '' : 'none';
    findingsEl.style.bottom = hidden ? '14px' : 'auto';
    collapse.textContent = hidden ? 'Hide' : 'Show';
  });
  renderSelection();
}

function renderSelection() {
  const el = findingsEl?.querySelector('.cm-selection');
  if (!el) return;
  if (!selected) { el.innerHTML = ''; return; }
  const ns = [...neighbors].sort((a, b) => a.label.localeCompare(b.label));
  el.innerHTML = `<div style="margin:2px 8px 8px;padding:8px 10px;border:1px solid rgba(100,120,200,0.2);border-radius:6px;font-size:11.5px;line-height:1.5">
      ${detailsHtml(selected)}
      <div style="display:flex;align-items:center;margin-top:6px"><span style="color:#5a6890">${ns.length} connection${ns.length === 1 ? '' : 's'} on visible layers</span>
        <button class="cm-btn cm-clear" style="margin-left:auto;padding:1px 7px;font-size:11px">Clear</button></div>
    </div>
    ${ns.length ? `<div class="cm-scroll" style="max-height:160px;overflow-y:auto;margin-bottom:6px">${ns.map(n =>
      `<button class="cm-item" data-id="${esc(n.id)}" title="${esc(n.kind === 'collection' ? n.raw.name : n.raw.path)}">${esc(n.kind === 'collection' ? `◆ ${n.raw.name}` : n.raw.path)}</button>`).join('')}</div>` : ''}`;
  el.querySelector('.cm-clear').addEventListener('click', () => select(null));
}
