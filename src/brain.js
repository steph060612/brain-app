// Three.js brain scene. Exports camera, controls, surfPool, surfNormVecs,
// renderer, composer, and helpers for registering per-frame callbacks.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// ─── CONFIG ──────────────────────────────────────────────────────────────────
export const CONFIG = {
  pointCount:        30000,
  surfaceFraction:   0.99,
  surfaceThickness:  0.075,
  pointSize:         1.1,
  pointBrightness:   0.22,
  colorDeep:        '#1A2A8F',
  colorElectric:    '#3B6CFF',
  colorCyan:        '#9FD8FF',
  hotspotCount:      6,
  hotspotRadius:     0.20,
  hotspotStrength:   0.65,
  connSubset:        2500,
  connRadius:        0.19,
  connMaxSegs:       60000,
  connOpacity:       0.44,
  spikeCount:        150,
  spikeMinLen:       0.40,
  spikeMaxLen:       1.10,
  spikeOpacity:      0.72,
  bloomStrength:     0.25,
  bloomRadius:       0.08,
  bloomThreshold:    0.32,
  rotationSpeed:     0.8,
  flickerAmplitude:  0.12,
  flickerSpeed:      1.2,
  exposure:          0.65,
  bg:               '#05070F',
};

// ─── MATH ────────────────────────────────────────────────────────────────────
const lerp = (a, b, t) => a + (b - a) * t;
function hash(n) { const x = Math.sin(n*127.1+311.7)*43758.5453123; return x-Math.floor(x); }
function noise3(x, y, z) {
  const ix=Math.floor(x),iy=Math.floor(y),iz=Math.floor(z);
  const fx=x-ix,fy=y-iy,fz=z-iz;
  const ux=fx*fx*(3-2*fx),uy=fy*fy*(3-2*fy),uz=fz*fz*(3-2*fz);
  const h=(a,b,c)=>hash(a+b*57+c*131);
  return lerp(
    lerp(lerp(h(ix,iy,iz),h(ix+1,iy,iz),ux),lerp(h(ix,iy+1,iz),h(ix+1,iy+1,iz),ux),uy),
    lerp(lerp(h(ix,iy,iz+1),h(ix+1,iy,iz+1),ux),lerp(h(ix,iy+1,iz+1),h(ix+1,iy+1,iz+1),ux),uy),
    uz);
}
function fbm(x,y,z) { return noise3(x*2.1,y*2.1,z*2.1)*0.5+noise3(x*4.3,y*4.3,z*4.3)*0.25; }

// ─── BRAIN SDF ───────────────────────────────────────────────────────────────
function eSDF(x,y,z,cx,cy,cz,rx,ry,rz) {
  const dx=(x-cx)/rx,dy=(y-cy)/ry,dz=(z-cz)/rz;
  return Math.sqrt(dx*dx+dy*dy+dz*dz)-1;
}
function brainSDF(x, y, z) {
  const n = (fbm(x*3+5.1, y*3+1.7, z*3+2.9)-0.5)*0.07;
  const fr=eSDF(x,y,z, 0.42, 0.05,0, 0.50,0.36,0.32);
  const pa=eSDF(x,y,z, 0.00, 0.27,0, 0.58,0.33,0.32);
  const oc=eSDF(x,y,z,-0.48, 0.03,0, 0.36,0.30,0.28);
  const te=eSDF(x,y,z, 0.05,-0.22,0.02, 0.58,0.20,0.33);
  const cb=eSDF(x,y,z,-0.45,-0.54,0, 0.22,0.18,0.20);
  const bs=eSDF(x,y,z,-0.10,-0.67,0, 0.10,0.28,0.09);
  return Math.min(fr,pa,oc,te,cb,bs)+n;
}
function sdfNormal(x, y, z) {
  const e=0.012;
  const dx=brainSDF(x+e,y,z)-brainSDF(x-e,y,z);
  const dy=brainSDF(x,y+e,z)-brainSDF(x,y-e,z);
  const dz=brainSDF(x,y,z+e)-brainSDF(x,y,z-e);
  const l=Math.sqrt(dx*dx+dy*dy+dz*dz)||1;
  return [dx/l,dy/l,dz/l];
}
// Export for external use (label region classification)
export { brainSDF, sdfNormal };

// ─── RENDERER + SCENE ────────────────────────────────────────────────────────
export const renderer = new THREE.WebGLRenderer({ antialias: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = CONFIG.exposure;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(CONFIG.bg);

export const camera = new THREE.PerspectiveCamera(60, window.innerWidth/window.innerHeight, 0.01, 100);
camera.position.set(0.3, 0.05, 2.8);

export const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping  = true;
controls.dampingFactor  = 0.06;
controls.minDistance    = 1.2;
controls.maxDistance    = 9;
controls.target.set(0, -0.1, 0);
controls.autoRotate     = true;
controls.autoRotateSpeed = CONFIG.rotationSpeed;
controls.update();

export const brainGroup = new THREE.Group();
scene.add(brainGroup);

// ─── COLORS ──────────────────────────────────────────────────────────────────
const colDeep = new THREE.Color(CONFIG.colorDeep);
const colElec = new THREE.Color(CONFIG.colorElectric);
const colCyan = new THREE.Color(CONFIG.colorCyan);

function baseColor(y) {
  const t = Math.max(0, Math.min(1, (y+1.05)/1.85));
  return new THREE.Color().lerpColors(colDeep, colElec, t*t);
}

// ─── HOTSPOTS ────────────────────────────────────────────────────────────────
const hotspots = [];
for (let h = 0; h < CONFIG.hotspotCount; h++) {
  let hx,hy,hz,tries=0;
  do {
    hx=(Math.random()-0.5)*2; hy=Math.random()*1.9-1.05; hz=(Math.random()-0.5)*1;
    tries++;
  } while (Math.abs(brainSDF(hx,hy,hz))>0.06 && tries<300);
  hotspots.push([hx,hy,hz]);
}
function withHotspot(col, x, y, z) {
  let inf=0;
  for (const [hx,hy,hz] of hotspots) {
    const d=Math.sqrt((x-hx)**2+(y-hy)**2+(z-hz)**2);
    inf=Math.max(inf,Math.max(0,1-d/CONFIG.hotspotRadius));
  }
  if (inf>0) col.lerp(colCyan, inf*inf*CONFIG.hotspotStrength);
  return col;
}
function ptColor(x,y,z) { return withHotspot(baseColor(y),x,y,z); }

// ─── POINT SAMPLING ──────────────────────────────────────────────────────────
function randPt() {
  return [(Math.random()-0.5)*2, Math.random()*1.9-1.05, (Math.random()-0.5)*1];
}
const surfaceTarget  = Math.floor(CONFIG.pointCount * CONFIG.surfaceFraction);
const interiorTarget = CONFIG.pointCount - surfaceTarget;

const allPos=[],allCol=[],allNorm=[],allPhase=[];
// Exported parallel arrays: surfPool[i] = [x,y,z], surfNormVecs[i] = [nx,ny,nz]
export const surfPool     = [];
export const surfNormVecs = [];

while (surfPool.length < surfaceTarget) {
  const [x,y,z] = randPt();
  if (Math.abs(brainSDF(x,y,z)) < CONFIG.surfaceThickness) {
    const [nx,ny,nz] = sdfNormal(x,y,z);
    const c=ptColor(x,y,z), b=CONFIG.pointBrightness;
    allPos.push(x,y,z);
    allCol.push(c.r*b,c.g*b,c.b*b);
    allNorm.push(nx,ny,nz);
    allPhase.push(Math.random()*Math.PI*2);
    surfPool.push([x,y,z]);
    surfNormVecs.push([nx,ny,nz]);
  }
}
let iDone=0, iTries=0;
while (iDone<interiorTarget && iTries<500000) {
  const [x,y,z]=randPt();
  if (brainSDF(x,y,z)<-0.06 && Math.random()<0.01) {
    const c=baseColor(y).multiplyScalar(0.18);
    allPos.push(x,y,z); allCol.push(c.r,c.g,c.b);
    allNorm.push(0,0,0); allPhase.push(Math.random()*Math.PI*2);
    iDone++;
  }
  iTries++;
}

// ─── POINTS MESH ─────────────────────────────────────────────────────────────
const ptGeo = new THREE.BufferGeometry();
ptGeo.setAttribute('position',   new THREE.Float32BufferAttribute(allPos,   3));
ptGeo.setAttribute('baseColor',  new THREE.Float32BufferAttribute(allCol,   3));
ptGeo.setAttribute('surfNormal', new THREE.Float32BufferAttribute(allNorm,  3));
ptGeo.setAttribute('phase',      new THREE.Float32BufferAttribute(allPhase, 1));

export const ptMat = new THREE.ShaderMaterial({
  uniforms: { time: {value:0}, pointSize: {value:CONFIG.pointSize} },
  vertexShader: `
    attribute vec3  baseColor;
    attribute vec3  surfNormal;
    attribute float phase;
    uniform   float time;
    uniform   float pointSize;
    varying   vec3  vColor;
    void main() {
      vec3  wp       = (modelMatrix * vec4(position,1.0)).xyz;
      vec3  viewDir  = normalize(cameraPosition - wp);
      float nLen     = length(surfNormal);
      float facing   = nLen < 0.5 ? 1.0 : max(0.0, dot(normalize(mat3(modelMatrix)*surfNormal), viewDir));
      float fade     = 0.18 + 0.82 * pow(facing, 1.5);
      float flicker  = 1.0 + ${CONFIG.flickerAmplitude.toFixed(4)} * sin(time * ${CONFIG.flickerSpeed.toFixed(4)} + phase);
      vColor = baseColor * flicker * fade;
      vec4 mv = modelViewMatrix * vec4(position,1.0);
      gl_PointSize = max(1.2, pointSize * 4.2 / -mv.z);
      gl_Position  = projectionMatrix * mv;
    }
  `,
  fragmentShader: `
    varying vec3 vColor;
    void main() {
      vec2 c = gl_PointCoord - 0.5;
      float r2 = dot(c,c);
      if (r2 > 0.25) discard;
      gl_FragColor = vec4(vColor, (0.25-r2)*4.0);
    }
  `,
  transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
});
brainGroup.add(new THREE.Points(ptGeo, ptMat));

// ─── CONNECTIONS ─────────────────────────────────────────────────────────────
const connN = Math.min(CONFIG.connSubset, surfPool.length);
const connPts = surfPool.slice(0, connN);
const connColors = connPts.map(([x,y,z]) => ptColor(x,y,z));
const linePos=[], lineCol=[];
const r2Th = CONFIG.connRadius*CONFIG.connRadius;
let nSegs=0;
for (let i=0;i<connN&&nSegs<CONFIG.connMaxSegs;i++) {
  const [ax,ay,az]=connPts[i], ca=connColors[i];
  for (let j=i+1;j<connN&&nSegs<CONFIG.connMaxSegs;j++) {
    const [bx,by,bz]=connPts[j];
    const dx=bx-ax,dy=by-ay,dz=bz-az;
    if (dx*dx+dy*dy+dz*dz<r2Th) {
      const cb=connColors[j], op=CONFIG.connOpacity;
      linePos.push(ax,ay,az,bx,by,bz);
      lineCol.push(ca.r*op,ca.g*op,ca.b*op, cb.r*op,cb.g*op,cb.b*op);
      nSegs++;
    }
  }
}
const connGeo=new THREE.BufferGeometry();
connGeo.setAttribute('position',new THREE.Float32BufferAttribute(linePos,3));
connGeo.setAttribute('color',   new THREE.Float32BufferAttribute(lineCol,3));
brainGroup.add(new THREE.LineSegments(connGeo, new THREE.LineBasicMaterial({
  vertexColors:true, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false,
})));

// ─── SPIKES ───────────────────────────────────────────────────────────────────
const spikePos=[],spikeCol=[];
const step=Math.max(1,Math.floor(surfPool.length/CONFIG.spikeCount));
for (let i=0;i<CONFIG.spikeCount;i++) {
  const idx=(i*step+Math.floor(Math.random()*step))%surfPool.length;
  const [x,y,z]=surfPool[idx], [nx,ny,nz]=sdfNormal(x,y,z);
  const len=CONFIG.spikeMinLen+Math.random()*(CONFIG.spikeMaxLen-CONFIG.spikeMinLen);
  const col=ptColor(x,y,z), op=CONFIG.spikeOpacity;
  spikePos.push(x,y,z, x+nx*len,y+ny*len,z+nz*len);
  spikeCol.push(col.r*op,col.g*op,col.b*op, 0,0,0);
}
const spikeGeo=new THREE.BufferGeometry();
spikeGeo.setAttribute('position',new THREE.Float32BufferAttribute(spikePos,3));
spikeGeo.setAttribute('color',   new THREE.Float32BufferAttribute(spikeCol,3));
brainGroup.add(new THREE.LineSegments(spikeGeo, new THREE.LineBasicMaterial({
  vertexColors:true, transparent:true, blending:THREE.AdditiveBlending, depthWrite:false,
})));

// ─── BLOOM ────────────────────────────────────────────────────────────────────
export const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(
  new THREE.Vector2(window.innerWidth, window.innerHeight),
  CONFIG.bloomStrength, CONFIG.bloomRadius, CONFIG.bloomThreshold,
));
composer.addPass(new OutputPass());

// ─── RESIZE ───────────────────────────────────────────────────────────────────
window.addEventListener('resize', () => {
  const w=window.innerWidth, h=window.innerHeight;
  camera.aspect=w/h; camera.updateProjectionMatrix();
  renderer.setSize(w,h); composer.setSize(w,h);
});

// ─── ANIMATION LOOP ───────────────────────────────────────────────────────────
const _frameCallbacks = new Set();
export function onAnimate(cb) { _frameCallbacks.add(cb); }
export function offAnimate(cb) { _frameCallbacks.delete(cb); }
export function setAutoRotate(v) { controls.autoRotate = v; }
// Skip rendering while another view (the code map) covers the brain. The brain itself is unchanged.
let paused = false;
export function setBrainPaused(v) { paused = v; }

const clock = new THREE.Clock();
(function loop() {
  requestAnimationFrame(loop);
  if (paused) return;
  ptMat.uniforms.time.value = clock.getElapsedTime();
  controls.update();
  composer.render();
  for (const cb of _frameCallbacks) cb();
})();
