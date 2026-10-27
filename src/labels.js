// HTML label overlay — one label per Brain item, anchored to a surface point.
// Labels on the far side of the brain fade to 0 opacity as the camera orbits.
import * as THREE from 'three';
import { setAutoRotate, controls } from './brain.js';

// ─── STYLES BY CATEGORY ─────────────────────────────────────────────────────
const STYLE = {
  projects:    { color: '#ffffff', fontWeight: '700', fontSize: '15px' },
  archive:     { color: '#A3ADD1', fontWeight: '400', fontSize: '12px' },
  people:      { color: '#B9A6FF', fontWeight: '400', fontSize: '15px' },
  topics:      { color: '#6FE3D0', fontWeight: '400', fontSize: '15px' },
  profile:     { color: '#6FE3D0', fontWeight: '400', fontSize: '15px' },
  preferences: { color: '#6FE3D0', fontWeight: '400', fontSize: '15px' },
};

// ─── REGION FILTER ───────────────────────────────────────────────────────────
// Decides which area of surfPool to use for each item category.
function regionOf(category) {
  if (category === 'projects') return 'front_top';
  if (category === 'archive')  return 'back_lower';
  return 'middle';
}
function matchRegion([x, y], region) {
  if (region === 'front_top')  return x >  0.10 && y >  0.05;
  if (region === 'back_lower') return x < -0.15 && y <  0.10;
  return x > -0.35 && x < 0.45 && y > -0.30 && y < 0.35; // middle
}

// ─── STATE ───────────────────────────────────────────────────────────────────
let panelOpen    = false;
let labelHovered = false;
let dragging     = false;
let searchQuery  = '';
let clickHandler = null;
let labels       = [];
let resumeTimer  = null;

// ─── ROTATION CONTROL ────────────────────────────────────────────────────────
// Rotation pauses ONLY while dragging the brain, hovering a label, or a panel
// is open. Mouse moving over empty screen never pauses rotation.
function syncRotation() {
  setAutoRotate(!panelOpen && !labelHovered && !dragging);
}
function scheduleResume() {
  clearTimeout(resumeTimer);
  resumeTimer = setTimeout(syncRotation, 1500);
}
export function setPanelOpen(open) {
  panelOpen = open;
  clearTimeout(resumeTimer);
  syncRotation();
}

// ─── SEARCH ──────────────────────────────────────────────────────────────────
export function setSearchQuery(q) { searchQuery = q.trim().toLowerCase(); }

// ─── INIT ────────────────────────────────────────────────────────────────────
export function initLabels(items, surfPool, surfNormVecs, camera, onClickItem) {
  clickHandler = onClickItem;

  // Pause while OrbitControls drag is active; resume after 1.5s on release
  controls.addEventListener('start', () => {
    dragging = true;
    clearTimeout(resumeTimer);
    syncRotation();
  });
  controls.addEventListener('end', () => {
    dragging = false;
    scheduleResume();
  });

  // Build region pools from surfPool
  const pools = { front_top: [], back_lower: [], middle: [] };
  for (let i = 0; i < surfPool.length; i++) {
    const [x, y] = surfPool[i];
    for (const [region, pool] of Object.entries(pools)) {
      if (matchRegion([x, y], region)) { pool.push(i); break; }
    }
  }

  // Group items by region, assign anchors evenly
  const byRegion = { front_top: [], back_lower: [], middle: [] };
  for (const item of items) byRegion[regionOf(item.category)].push(item);

  const container = document.createElement('div');
  container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;overflow:hidden;z-index:20;';
  document.body.appendChild(container);

  for (const [region, regionItems] of Object.entries(byRegion)) {
    const pool = pools[region];
    if (!pool.length) continue;
    regionItems.forEach((item, idx) => {
      const step = Math.max(1, Math.floor(pool.length / regionItems.length));
      const poolIdx = pool[(idx * step + Math.floor(step * 0.3)) % pool.length];
      const anchor = surfPool[poolIdx];
      const normal = surfNormVecs[poolIdx];
      const el = buildLabel(item);
      container.appendChild(el);
      const lb = { item, anchor, normal, el, _hovered: false };
      labels.push(lb);

      el.addEventListener('mouseenter', () => {
        lb._hovered  = true;
        labelHovered = true;
        clearTimeout(resumeTimer);
        syncRotation();
      });
      el.addEventListener('mouseleave', () => {
        lb._hovered  = false;
        labelHovered = labels.some(l => l._hovered);
        if (!labelHovered) scheduleResume();
      });
    });
  }

  return labels;
}

function buildLabel(item) {
  const st = STYLE[item.category] || STYLE.topics;
  const el = document.createElement('div');
  el.textContent = item.name;
  Object.assign(el.style, {
    position:    'absolute',
    color:       st.color,
    fontSize:    st.fontSize,
    fontWeight:  st.fontWeight,
    fontFamily:  'system-ui, -apple-system, sans-serif',
    whiteSpace:  'nowrap',
    transform:   'translate(-50%, -50%)',
    cursor:      'pointer',
    transition:  'opacity 0.15s',
    textShadow:  '0 0 6px #05070F, 0 0 6px #05070F, 0 0 10px #05070F',
    userSelect:  'none',
    pointerEvents: 'auto',
  });
  el.addEventListener('click', () => clickHandler && clickHandler(item));
  return el;
}

// ─── UPDATE (called every frame) ─────────────────────────────────────────────
const _wp = new THREE.Vector3();
const _sp = new THREE.Vector3();

export function updateLabels(camera) {
  const W = window.innerWidth, H = window.innerHeight;

  // Phase 1 — project all labels to screen, compute base opacity
  for (const lb of labels) {
    _wp.set(...lb.anchor);
    const vx = camera.position.x - _wp.x;
    const vy = camera.position.y - _wp.y;
    const vz = camera.position.z - _wp.z;
    const vl = Math.sqrt(vx*vx + vy*vy + vz*vz) || 1;
    lb._facing = (lb.normal[0]*vx + lb.normal[1]*vy + lb.normal[2]*vz) / vl;

    _sp.copy(_wp).project(camera);
    lb._sx = (_sp.x * 0.5 + 0.5) * W;
    lb._sy = (-_sp.y * 0.5 + 0.5) * H;
    lb._px = lb._sx;
    lb._py = lb._sy;

    const visOp = lb._facing < -0.1 ? 0 : Math.min(1, (lb._facing + 0.1) / 0.4);
    const matches = !searchQuery || lb.item.name.toLowerCase().includes(searchQuery);
    lb._op = visOp * (matches ? 1 : 0.06);
  }

  // Phase 2 — push overlapping visible labels apart
  const vis = labels.filter(lb => lb._op > 0.25);
  if (vis.length > 1) {
    for (const lb of vis) {
      lb._hw = (lb.el.offsetWidth  || 80) * 0.5 + 5;  // half-width + margin
      lb._hh = (lb.el.offsetHeight || 16) * 0.5 + 4;  // half-height + margin
    }
    for (let iter = 0; iter < 8; iter++) {
      for (let i = 0; i < vis.length - 1; i++) {
        const a = vis[i];
        for (let j = i + 1; j < vis.length; j++) {
          const b = vis[j];
          const dx = b._px - a._px;
          const dy = b._py - a._py;
          const overlapX = a._hw + b._hw - Math.abs(dx);
          const overlapY = a._hh + b._hh - Math.abs(dy);
          if (overlapX > 0 && overlapY > 0) {
            if (overlapX <= overlapY) {
              const push = overlapX * 0.5 * (dx >= 0 ? 1 : -1);
              a._px -= push; b._px += push;
            } else {
              const push = overlapY * 0.5 * (dy >= 0 ? 1 : -1);
              a._py -= push; b._py += push;
            }
          }
        }
      }
    }
  }

  // Phase 3 — apply final positions and opacity
  for (const lb of labels) {
    const nowInteractive = lb._facing > 0 && lb._op > 0.05;
    lb.el.style.left    = lb._px + 'px';
    lb.el.style.top     = lb._py + 'px';
    lb.el.style.opacity = lb._op.toFixed(3);
    lb.el.style.pointerEvents = nowInteractive ? 'auto' : 'none';

    // If a label fades behind the brain while the cursor is on it, mouseleave
    // never fires (pointer-events just got set to none). Clear hover manually.
    if (!nowInteractive && lb._hovered) {
      lb._hovered  = false;
      labelHovered = labels.some(l => l._hovered);
      if (!labelHovered) scheduleResume();
    }
  }
}
