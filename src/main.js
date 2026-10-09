import * as THREE from 'three';
import { GUI } from 'three/addons/libs/lil-gui.module.min.js';

// --- CONFIGURATION & CONSTANTS ---
const IMAGE_URL = 'https://images.unsplash.com/photo-1602488257131-7751faf0cca0?q=80&w=1287&auto=format&fit=crop&ixlib=rb-4.1.0&ixid=M3wxMjA3fDB8MHxwaG90by1wYWdlfHx8fGVufDB8fHx8fA%3D%3D';

// Cloth dimensions & grid
const CLOTH_WIDTH = 3.2;
const CLOTH_HEIGHT = 4.4;
const NX = 50; // Horizontal resolution (increased segments)
const NY = 66; // Vertical resolution (increased segments)
const NUM_PARTICLES = NX * NY;

// Physics parameters
const TIMESTEP = 18 / 1000; // 18ms
const CONSTRAINT_ITERATIONS = 8; // Optimized iteration count for 60fps smoothness

// Default Configuration Values
const DEFAULTS = {
  roughness: 0,
  metalness: 0.3,
  clearcoat: 1,
  clearcoatRoughness: 0,
  sheen: 1.0,
  sheenRoughness: 0,
  specularIntensity: 5.2,
  ambientLight: 1.75,
  keyLight: 4.8,
  rimLight: 4.2,
  cursorLight: 4.0,
  gravity: 0.02,
  damping: 0.975,
  waveStrength: 1.0,
  waveSpeed: 1.0,
  pinMode: '2 Corners'
};

// --- LIVE GUI PARAMETERS ---
const params = {
  ...DEFAULTS,
  // Actions
  uploadImage: () => fileInput.click(),
  reset: () => resetCloth()
};

// --- THREE.JS SETUP ---
const container = document.getElementById('canvas-container');
const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x07070a, 0.06);

const camera = new THREE.PerspectiveCamera(
  42,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.position.set(0, 0, 7.2);

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.15;
container.appendChild(renderer.domElement);

// --- PROCEDURAL STUDIO ENVIRONMENT MAP (For ultra-shiny reflections) ---
function createStudioEnvMap() {
  const pmremGenerator = new THREE.PMREMGenerator(renderer);
  pmremGenerator.compileEquirectangularShader();

  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');

  // Gradient background
  const grad = ctx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0, '#1a1c29');
  grad.addColorStop(0.5, '#0d0e15');
  grad.addColorStop(1, '#050508');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, 1024, 512);

  // Soft bright studio softbox panels for realistic reflections
  ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
  ctx.filter = 'blur(16px)';
  ctx.fillRect(180, 80, 240, 140);
  ctx.fillStyle = 'rgba(160, 200, 255, 0.85)';
  ctx.fillRect(620, 120, 200, 160);
  ctx.fillStyle = 'rgba(255, 230, 210, 0.7)';
  ctx.fillRect(400, 20, 220, 80);

  const canvasTexture = new THREE.CanvasTexture(canvas);
  canvasTexture.mapping = THREE.EquirectangularReflectionMapping;
  const renderTarget = pmremGenerator.fromEquirectangular(canvasTexture);
  canvasTexture.dispose();
  pmremGenerator.dispose();
  return renderTarget.texture;
}

const envMap = createStudioEnvMap();
scene.environment = envMap;

// --- LIGHTING SETUP ---
const ambientLight = new THREE.AmbientLight(0xffffff, 1.75);
scene.add(ambientLight);

// Primary Key Light (Top-Left)
const keyLight = new THREE.DirectionalLight(0xffffff, 4.8);
keyLight.position.set(-4, 5, 5);
scene.add(keyLight);

// Rim Light (Bottom-Right Blue/Cyan Rim)
const rimLight = new THREE.DirectionalLight(0x7da2ff, 4.2);
rimLight.position.set(4, -3, 3);
scene.add(rimLight);

// Follow-cursor Specular Spotlight (Makes cloth glimmer as cursor moves)
const cursorSpotLight = new THREE.PointLight(0xfff5ea, 4.0, 10, 1.6);
cursorSpotLight.position.set(0, 0, 4);
scene.add(cursorSpotLight);

// --- PARTICLES & CONSTRAINTS DATA STRUCTURE ---
const pos = {
  x: new Float32Array(NUM_PARTICLES),
  y: new Float32Array(NUM_PARTICLES),
  z: new Float32Array(NUM_PARTICLES)
};

const oldPos = {
  x: new Float32Array(NUM_PARTICLES),
  y: new Float32Array(NUM_PARTICLES),
  z: new Float32Array(NUM_PARTICLES)
};

const origPos = {
  x: new Float32Array(NUM_PARTICLES),
  y: new Float32Array(NUM_PARTICLES),
  z: new Float32Array(NUM_PARTICLES)
};

const pinned = new Uint8Array(NUM_PARTICLES);

// Initialize particles in standard hanging grid
const dx = CLOTH_WIDTH / (NX - 1);
const dy = CLOTH_HEIGHT / (NY - 1);
const offsetX = -CLOTH_WIDTH * 0.5;
const offsetY = CLOTH_HEIGHT * 0.5;

for (let y = 0; y < NY; y++) {
  for (let x = 0; x < NX; x++) {
    const idx = y * NX + x;
    const px = offsetX + x * dx;
    const py = offsetY - y * dy;

    // Natural undulating wavy silk curves that drape vertically
    const u = x / (NX - 1);
    const v = y / (NY - 1);
    const wave = Math.sin(u * Math.PI * 4) * 0.14 * Math.sin(v * Math.PI * 0.95);
    const pz = wave;

    pos.x[idx] = px;
    pos.y[idx] = py;
    pos.z[idx] = pz;

    oldPos.x[idx] = px;
    oldPos.y[idx] = py;
    oldPos.z[idx] = pz;

    origPos.x[idx] = px;
    origPos.y[idx] = py;
    origPos.z[idx] = pz;
  }
}

// Constraints builder
const constraintPairs = [];
function addConstraint(p1, p2, stiffness = 1.0) {
  const p1x = pos.x[p1], p1y = pos.y[p1], p1z = pos.z[p1];
  const p2x = pos.x[p2], p2y = pos.y[p2], p2z = pos.z[p2];
  const dist = Math.hypot(p1x - p2x, p1y - p2y, p1z - p2z);
  constraintPairs.push({ p1, p2, restLen: dist, stiffness });
}

// 1. Structural constraints (adjacent edges)
for (let y = 0; y < NY; y++) {
  for (let x = 0; x < NX; x++) {
    const idx = y * NX + x;
    if (x < NX - 1) addConstraint(idx, idx + 1, 1.0);
    if (y < NY - 1) addConstraint(idx, idx + NX, 1.0);
  }
}

// 2. Shear constraints (diagonals for fabric shear resistance)
for (let y = 0; y < NY - 1; y++) {
  for (let x = 0; x < NX - 1; x++) {
    const idx = y * NX + x;
    addConstraint(idx, idx + NX + 1, 0.9);
    addConstraint(idx + 1, idx + NX, 0.9);
  }
}

// 3. Bending constraints (2-hop distance for smooth satin drape)
for (let y = 0; y < NY; y++) {
  for (let x = 0; x < NX; x++) {
    const idx = y * NX + x;
    if (x < NX - 2) addConstraint(idx, idx + 2, 0.9);
    if (y < NY - 2) addConstraint(idx, idx + 2 * NX, 0.9);
  }
}

// Convert constraints to flat TypedArrays for peak performance
const NUM_CONSTRAINTS = constraintPairs.length;
const cP1 = new Int32Array(NUM_CONSTRAINTS);
const cP2 = new Int32Array(NUM_CONSTRAINTS);
const cDist = new Float32Array(NUM_CONSTRAINTS);
const cStiff = new Float32Array(NUM_CONSTRAINTS);

for (let i = 0; i < NUM_CONSTRAINTS; i++) {
  cP1[i] = constraintPairs[i].p1;
  cP2[i] = constraintPairs[i].p2;
  cDist[i] = constraintPairs[i].restLen;
  cStiff[i] = constraintPairs[i].stiffness;
}

// Pinning helper - 2 top corners pinned
function updatePins() {
  pinned.fill(0);
  pinned[0] = 1;          // Top-Left corner
  pinned[NX - 1] = 1;     // Top-Right corner
}
updatePins();

// --- CREATE THREE.JS CLOTH MESH ---
const clothGeometry = new THREE.PlaneGeometry(
  CLOTH_WIDTH,
  CLOTH_HEIGHT,
  NX - 1,
  NY - 1
);

// Texture Loader
const textureLoader = new THREE.TextureLoader();
const clothTexture = textureLoader.load(
  IMAGE_URL,
  () => {
    clothTexture.colorSpace = THREE.SRGBColorSpace;
    clothTexture.generateMipmaps = true;
    clothTexture.minFilter = THREE.LinearMipmapLinearFilter;
    clothMaterial.needsUpdate = true;
  },
  undefined,
  (err) => {
    console.warn('Failed loading image, using high-end fallback gradient', err);
    // Procedural fallback canvas if network/cors issues arise
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 768;
    const ctx = canvas.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 512, 768);
    g.addColorStop(0, '#f43f5e');
    g.addColorStop(0.5, '#a855f7');
    g.addColorStop(1, '#3b82f6');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 768);
    clothTexture.image = canvas;
    clothTexture.needsUpdate = true;
  }
);
clothTexture.colorSpace = THREE.SRGBColorSpace;
const clothMaterial = new THREE.MeshPhysicalMaterial({
  map: clothTexture,
  side: THREE.DoubleSide,
  roughness: params.roughness,
  metalness: params.metalness,
  clearcoat: params.clearcoat,
  clearcoatRoughness: params.clearcoatRoughness,
  sheen: params.sheen,
  sheenRoughness: params.sheenRoughness,
  sheenColor: new THREE.Color(0xffffff),
  specularIntensity: params.specularIntensity,
  envMapIntensity: 1.4,
  shadowSide: THREE.DoubleSide
});

const clothMesh = new THREE.Mesh(clothGeometry, clothMaterial);
scene.add(clothMesh);

// --- IMAGE UPLOAD HELPER ---
const fileInput = document.createElement('input');
fileInput.type = 'file';
fileInput.accept = 'image/*';
fileInput.style.display = 'none';
document.body.appendChild(fileInput);

function applyNewImage(imageSrc) {
  textureLoader.load(imageSrc, (newTexture) => {
    newTexture.colorSpace = THREE.SRGBColorSpace;
    newTexture.generateMipmaps = true;
    newTexture.minFilter = THREE.LinearMipmapLinearFilter;
    clothMaterial.map = newTexture;
    clothMaterial.needsUpdate = true;
  });
}

fileInput.addEventListener('change', (e) => {
  const file = e.target.files && e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    applyNewImage(event.target.result);
  };
  reader.readAsDataURL(file);
  fileInput.value = '';
});

// Drag & drop image files directly onto window
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (event) => {
      applyNewImage(event.target.result);
    };
    reader.readAsDataURL(file);
  }
});

// Two luxury gold pins at the two pinned corners
const pinGeo = new THREE.SphereGeometry(0.065, 20, 20);
const pinMat = new THREE.MeshStandardMaterial({
  color: 0xd4af37,
  metalness: 0.95,
  roughness: 0.15
});
const leftPin = new THREE.Mesh(pinGeo, pinMat);
leftPin.position.set(-CLOTH_WIDTH * 0.5, offsetY, 0.04);
const rightPin = new THREE.Mesh(pinGeo, pinMat);
rightPin.position.set(CLOTH_WIDTH * 0.5, offsetY, 0.04);
scene.add(leftPin, rightPin);

// --- DRAG & INTERACTION SYSTEM ---
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2(-999, -999);
const dragPlane = new THREE.Plane();
const dragPlaneIntersect = new THREE.Vector3();
const dragNormal = new THREE.Vector3(0, 0, 1);

let isDragging = false;
let draggedParticleIdx = -1;
let grabbedCluster = []; // Neighborhood of vertices to pull smoothly
const BRUSH_RADIUS = 0.75; // Radius of stretch influence

// Track mouse movement for breeze and specular light
let lastMouseX = 0;
let lastMouseY = 0;
let mouseVelocity = 0;
let pointerWorldPos = new THREE.Vector3(0, 0, 0);

function getIntersection(event) {
  const rect = renderer.domElement.getBoundingClientRect();
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const clientY = event.touches ? event.touches[0].clientY : event.clientY;

  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  raycaster.setFromCamera(mouse, camera);
  const intersects = raycaster.intersectObject(clothMesh);
  return intersects.length > 0 ? intersects[0] : null;
}

function onPointerDown(event) {
  const hit = getIntersection(event);
  if (!hit) return;

  const hitPoint = hit.point;
  let closestDistSq = Infinity;
  let closestIdx = -1;
  const hx = hitPoint.x, hy = hitPoint.y, hz = hitPoint.z;

  // Fast squared distance search
  for (let i = 0; i < NUM_PARTICLES; i++) {
    const dx = pos.x[i] - hx;
    const dy = pos.y[i] - hy;
    const dz = pos.z[i] - hz;
    const dSq = dx * dx + dy * dy + dz * dz;
    if (dSq < closestDistSq) {
      closestDistSq = dSq;
      closestIdx = i;
    }
  }

  if (closestIdx !== -1) {
    isDragging = true;
    draggedParticleIdx = closestIdx;
    container.classList.add('grabbing');

    // Create drag plane parallel to camera at the hit depth
    const camDir = new THREE.Vector3();
    camera.getWorldDirection(camDir).negate();
    dragPlane.setFromNormalAndCoplanarPoint(camDir, hitPoint);

    // Compute cluster of influenced particles with smooth falloff
    grabbedCluster = [];
    const centerPx = pos.x[closestIdx];
    const centerPy = pos.y[closestIdx];
    const centerPz = pos.z[closestIdx];
    const rSq = BRUSH_RADIUS * BRUSH_RADIUS;

    for (let i = 0; i < NUM_PARTICLES; i++) {
      if (pinned[i]) continue;
      const dx = pos.x[i] - centerPx;
      const dy = pos.y[i] - centerPy;
      const dz = pos.z[i] - centerPz;
      const dSq = dx * dx + dy * dy + dz * dz;
      if (dSq < rSq) {
        const dist = Math.sqrt(dSq);
        const factor = Math.cos((dist / BRUSH_RADIUS) * Math.PI * 0.5);
        grabbedCluster.push({
          idx: i,
          weight: factor * factor,
          offsetOrigX: dx,
          offsetOrigY: dy,
          offsetOrigZ: dz
        });
      }
    }
  }
}

let pointerNeedsUpdate = false;

function onPointerMove(event) {
  const clientX = event.touches ? event.touches[0].clientX : event.clientX;
  const clientY = event.touches ? event.touches[0].clientY : event.clientY;

  const rect = renderer.domElement.getBoundingClientRect();
  mouse.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  mouse.y = -((clientY - rect.top) / rect.height) * 2 + 1;

  lastMouseX = clientX;
  lastMouseY = clientY;
  pointerNeedsUpdate = true;
}

function updatePointerInteraction() {
  if (!pointerNeedsUpdate && !isDragging) return;
  pointerNeedsUpdate = false;

  raycaster.setFromCamera(mouse, camera);

  if (raycaster.ray.intersectPlane(dragPlane, dragPlaneIntersect)) {
    pointerWorldPos.copy(dragPlaneIntersect);
    cursorSpotLight.position.lerp(
      new THREE.Vector3(pointerWorldPos.x, pointerWorldPos.y, pointerWorldPos.z + 1.2),
      0.15
    );

    // Handle active drag stretching
    if (isDragging && draggedParticleIdx !== -1) {
      const targetX = dragPlaneIntersect.x;
      const targetY = dragPlaneIntersect.y;
      const targetZ = dragPlaneIntersect.z;

      if (!pinned[draggedParticleIdx]) {
        pos.x[draggedParticleIdx] = targetX;
        pos.y[draggedParticleIdx] = targetY;
        pos.z[draggedParticleIdx] = targetZ;
        oldPos.x[draggedParticleIdx] = targetX;
        oldPos.y[draggedParticleIdx] = targetY;
        oldPos.z[draggedParticleIdx] = targetZ;
      }

      for (let k = 0; k < grabbedCluster.length; k++) {
        const item = grabbedCluster[k];
        const idx = item.idx;
        if (idx === draggedParticleIdx) continue;

        const desiredX = targetX + item.offsetOrigX;
        const desiredY = targetY + item.offsetOrigY;
        const desiredZ = targetZ + item.offsetOrigZ;

        const w = item.weight * 0.72;
        pos.x[idx] += (desiredX - pos.x[idx]) * w;
        pos.y[idx] += (desiredY - pos.y[idx]) * w;
        pos.z[idx] += (desiredZ - pos.z[idx]) * w;

        oldPos.x[idx] = pos.x[idx];
        oldPos.y[idx] = pos.y[idx];
        oldPos.z[idx] = pos.z[idx];
      }
    }
  }
}

function onPointerUp() {
  if (isDragging) {
    isDragging = false;
    draggedParticleIdx = -1;
    grabbedCluster = [];
    container.classList.remove('grabbing');
  }
}

// Window & Interaction Event Listeners
window.addEventListener('pointerdown', onPointerDown);
window.addEventListener('pointermove', onPointerMove);
window.addEventListener('pointerup', onPointerUp);
window.addEventListener('pointercancel', onPointerUp);

// --- SIMULATION STEP ---
let clock = new THREE.Clock();

// Pre-allocated wave lookup buffers for zero-GC & ultra-fast computation
const colWave = new Float32Array(NX);
const rowWave = new Float32Array(NY);

function simulateCloth(time) {
  const wSpeed = params.waveSpeed;
  const wStrength = params.waveStrength;
  const damp = params.damping;
  const gravForce = -9.8 * params.gravity * TIMESTEP * TIMESTEP;

  // Precompute wave factors once per frame (116 math ops instead of 6,600!)
  for (let x = 0; x < NX; x++) {
    colWave[x] = Math.sin(time * 1.6 * wSpeed + x * 0.28) * 0.0010 + Math.cos(time * 2.2 * wSpeed + x * 0.45) * 0.0005;
  }
  for (let y = 0; y < NY; y++) {
    rowWave[y] = Math.max(0, 1 - (y / NY));
  }

  // 1. Verlet Integration step
  let idx = 0;
  for (let y = 0; y < NY; y++) {
    const rW = rowWave[y] * wStrength;
    for (let x = 0; x < NX; x++, idx++) {
      if (pinned[idx]) {
        pos.x[idx] = origPos.x[idx];
        pos.y[idx] = origPos.y[idx];
        pos.z[idx] = origPos.z[idx];
        continue;
      }

      if (isDragging && idx === draggedParticleIdx) {
        continue;
      }

      const vx = (pos.x[idx] - oldPos.x[idx]) * damp;
      const vy = (pos.y[idx] - oldPos.y[idx]) * damp;
      const vz = (pos.z[idx] - oldPos.z[idx]) * damp;

      oldPos.x[idx] = pos.x[idx];
      oldPos.y[idx] = pos.y[idx];
      oldPos.z[idx] = pos.z[idx];

      const waveZ = colWave[x] * rW;

      pos.x[idx] += vx;
      pos.y[idx] += vy + gravForce;
      pos.z[idx] += vz + waveZ;

      // Gentle restitution towards natural wavy drape
      pos.z[idx] += (origPos.z[idx] - pos.z[idx]) * 0.025;
      pos.x[idx] += (origPos.x[idx] - pos.x[idx]) * 0.004;
      pos.y[idx] += (origPos.y[idx] - pos.y[idx]) * 0.004;
    }
  }

  // 2. Relaxation Constraints Iterations (Fast Math.sqrt)
  for (let it = 0; it < CONSTRAINT_ITERATIONS; it++) {
    for (let c = 0; c < NUM_CONSTRAINTS; c++) {
      const p1 = cP1[c];
      const p2 = cP2[c];

      const p1Pinned = pinned[p1] || (isDragging && p1 === draggedParticleIdx);
      const p2Pinned = pinned[p2] || (isDragging && p2 === draggedParticleIdx);

      if (p1Pinned && p2Pinned) continue;

      const deltaX = pos.x[p2] - pos.x[p1];
      const deltaY = pos.y[p2] - pos.y[p1];
      const deltaZ = pos.z[p2] - pos.z[p1];

      const distSq = deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ;
      const currentDist = Math.sqrt(distSq);
      if (currentDist < 1e-6) continue;

      const restLen = cDist[c];
      const diff = (currentDist - restLen) / currentDist;
      const stiffness = cStiff[c];

      const factorX = deltaX * diff * 0.5 * stiffness;
      const factorY = deltaY * diff * 0.5 * stiffness;
      const factorZ = deltaZ * diff * 0.5 * stiffness;

      if (!p1Pinned && !p2Pinned) {
        pos.x[p1] += factorX;
        pos.y[p1] += factorY;
        pos.z[p1] += factorZ;

        pos.x[p2] -= factorX;
        pos.y[p2] -= factorY;
        pos.z[p2] -= factorZ;
      } else if (!p1Pinned) {
        pos.x[p1] += factorX * 2.0;
        pos.y[p1] += factorY * 2.0;
        pos.z[p1] += factorZ * 2.0;
      } else if (!p2Pinned) {
        pos.x[p2] -= factorX * 2.0;
        pos.y[p2] -= factorY * 2.0;
        pos.z[p2] -= factorZ * 2.0;
      }
    }
  }

  // 3. Update Three.js PlaneGeometry positions buffer
  const positionAttr = clothGeometry.attributes.position;
  const pArray = positionAttr.array;

  for (let i = 0; i < NUM_PARTICLES; i++) {
    const idx3 = i * 3;
    pArray[idx3] = pos.x[i];
    pArray[idx3 + 1] = pos.y[i];
    pArray[idx3 + 2] = pos.z[i];
  }

  positionAttr.needsUpdate = true;
  clothGeometry.computeVertexNormals();
}

// GUI reference
let gui;

// Reset Function - Restores all parameters, material settings, studio lighting, pins, and cloth simulation
function resetCloth() {
  // 1. Reset interaction & dragging states
  isDragging = false;
  draggedParticleIdx = -1;
  grabbedCluster = [];
  container.classList.remove('grabbing');

  // 2. Reset all parameters back to initial default values
  Object.assign(params, DEFAULTS);

  // 3. Reset cloth material properties to default shiny satin
  clothMaterial.roughness = params.roughness;
  clothMaterial.metalness = params.metalness;
  clothMaterial.clearcoat = params.clearcoat;
  clothMaterial.clearcoatRoughness = params.clearcoatRoughness;
  clothMaterial.sheen = params.sheen;
  clothMaterial.sheenRoughness = params.sheenRoughness;
  clothMaterial.specularIntensity = params.specularIntensity;
  clothMaterial.needsUpdate = true;

  // 4. Reset studio lights intensities to default
  ambientLight.intensity = params.ambientLight;
  keyLight.intensity = params.keyLight;
  rimLight.intensity = params.rimLight;
  cursorSpotLight.intensity = params.cursorLight;

  // 5. Restore default pin mode ('2 Corners') & pin markers
  pinned.fill(0);
  pinned[0] = 1;
  pinned[NX - 1] = 1;
  leftPin.visible = true;
  rightPin.visible = true;

  // 6. Reset cloth particle coordinates and velocities to rest pose
  for (let i = 0; i < NUM_PARTICLES; i++) {
    pos.x[i] = origPos.x[i];
    pos.y[i] = origPos.y[i];
    pos.z[i] = origPos.z[i];
    oldPos.x[i] = origPos.x[i];
    oldPos.y[i] = origPos.y[i];
    oldPos.z[i] = origPos.z[i];
  }

  // 7. Immediately push default positions to GPU buffer and compute normals
  const pArray = clothGeometry.attributes.position.array;
  for (let i = 0; i < NUM_PARTICLES; i++) {
    const idx3 = i * 3;
    pArray[idx3] = origPos.x[i];
    pArray[idx3 + 1] = origPos.y[i];
    pArray[idx3 + 2] = origPos.z[i];
  }
  clothGeometry.attributes.position.needsUpdate = true;
  clothGeometry.computeVertexNormals();

  // 8. Visually update all GUI sliders, inputs, and dropdowns back to initial default values
  if (gui) {
    gui.controllersRecursive().forEach(controller => {
      if (typeof controller.updateDisplay === 'function') {
        controller.updateDisplay();
      }
    });
  }
}

// Double click / tap anywhere to reset cloth if needed
window.addEventListener('dblclick', resetCloth);

// --- GUI SETUP (TOP-LEFT) ---
gui = new GUI({ title: 'Cloth Controls' });

// Material Folder
const matFolder = gui.addFolder('Material');
matFolder.add(params, 'roughness', 0, 1, 0.01).name('Roughness').onChange(v => { clothMaterial.roughness = v; });
matFolder.add(params, 'metalness', 0, 1, 0.01).name('Metalness').onChange(v => { clothMaterial.metalness = v; });
matFolder.add(params, 'clearcoat', 0, 1, 0.01).name('Clearcoat').onChange(v => { clothMaterial.clearcoat = v; });
matFolder.add(params, 'clearcoatRoughness', 0, 1, 0.01).name('Coat Roughness').onChange(v => { clothMaterial.clearcoatRoughness = v; });
matFolder.add(params, 'sheen', 0, 2, 0.05).name('Sheen Glow').onChange(v => { clothMaterial.sheen = v; });
matFolder.add(params, 'sheenRoughness', 0, 1, 0.01).name('Sheen Roughness').onChange(v => { clothMaterial.sheenRoughness = v; });
matFolder.add(params, 'specularIntensity', 0, 10, 0.1).name('Specular Shine').onChange(v => { clothMaterial.specularIntensity = v; });

// Studio Lighting Folder
const lightFolder = gui.addFolder('Studio Lights');
lightFolder.add(params, 'ambientLight', 0, 5, 0.1).name('Ambient Light').onChange(v => { ambientLight.intensity = v; });
lightFolder.add(params, 'keyLight', 0, 10, 0.1).name('Key Light').onChange(v => { keyLight.intensity = v; });
lightFolder.add(params, 'rimLight', 0, 10, 0.1).name('Rim Light').onChange(v => { rimLight.intensity = v; });
lightFolder.add(params, 'cursorLight', 0, 10, 0.1).name('Spot Highlight').onChange(v => { cursorSpotLight.intensity = v; });

// Pins Mode
gui.add(params, 'pinMode', ['2 Corners', 'Top Bar', '4 Corners']).name('Pins').onChange(val => {
  pinned.fill(0);
  if (val === '2 Corners') {
    pinned[0] = 1;
    pinned[NX - 1] = 1;
    leftPin.visible = true;
    rightPin.visible = true;
  } else if (val === 'Top Bar') {
    for (let i = 0; i < NX; i++) pinned[i] = 1;
    leftPin.visible = true;
    rightPin.visible = true;
  } else if (val === '4 Corners') {
    pinned[0] = 1;
    pinned[NX - 1] = 1;
    pinned[(NY - 1) * NX] = 1;
    pinned[(NY - 1) * NX + NX - 1] = 1;
    leftPin.visible = true;
    rightPin.visible = true;
  }
});

// Actions
gui.add(params, 'uploadImage').name('Upload Image');
gui.add(params, 'reset').name('Reset Cloth');

matFolder.open();
lightFolder.open();

// --- WINDOW RESIZE ---
window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  // Adjust camera distance for mobile screens so cloth fits nicely
  if (window.innerWidth < 768) {
    camera.position.z = 9.2;
  } else {
    camera.position.z = 7.2;
  }
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
});

// Initial mobile check
if (window.innerWidth < 768) {
  camera.position.z = 9.2;
}

// Subtle camera parallax sway
let targetCamX = 0;
let targetCamY = 0;
window.addEventListener('pointermove', (e) => {
  const normX = (e.clientX / window.innerWidth - 0.5) * 2;
  const normY = (e.clientY / window.innerHeight - 0.5) * 2;
  targetCamX = normX * 0.4;
  targetCamY = -normY * 0.3;
});

// --- ANIMATION LOOP ---
function animate() {
  requestAnimationFrame(animate);

  const elapsedTime = clock.getElapsedTime();

  // Gentle camera parallax
  camera.position.x += (targetCamX - camera.position.x) * 0.05;
  camera.position.y += (targetCamY - camera.position.y) * 0.05;
  camera.lookAt(0, -0.2, 0);

  // Rotate rim lights subtly for dynamic reflections
  rimLight.position.x = 4 + Math.sin(elapsedTime * 0.8) * 1.5;
  rimLight.position.y = -3 + Math.cos(elapsedTime * 0.7) * 1.0;

  updatePointerInteraction();
  simulateCloth(elapsedTime);
  renderer.render(scene, camera);
}

animate();
