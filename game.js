// ═══════════════════════════════════════════════════════════
// Milk Abduction
//
// Game states:
//   MENU      → lobby screen, camera orbits a farm with cows + UFOs
//   COUNTDOWN → 2+ players queued, 20-second countdown to start
//   PLAYING   → the actual game (UFO flight, etc.)
//
// Multiplayer is P2P via Trystero — no server. Queue/countdown sync
// uses a "host" = the peer with the lowest ID. The host alone owns
// the countdown clock and broadcasts it; everyone else just mirrors
// it. When the host's countdown hits 0, it sends a one-shot 'start'
// action so everyone transitions to PLAYING at the same instant.
// ═══════════════════════════════════════════════════════════

import * as THREE from 'three';
import { FBXLoader }  from 'three/addons/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js';

// ------------------------------------------------------------------
// 0. Model loading — async, runs during early startup
// ------------------------------------------------------------------
// We pre-load all OBJ/MTL (animals + structures) and the FBX UFO
// before creating any entities. The menu shows the ground + sky while
// this runs (~1-2s on a decent connection). Everything is stored in
// `models` so buildUFO/buildCow can clone from it.

const models = { ufo: null, animals: {}, structures: {} };

// Creature type ↔ skin variant mapping. Skins within the same creature
// share gameplay abilities and stats, but look different. The selection
// UI shows all skins grouped by their creature type.
const CREATURES = {
  Cow:    { skins: ['Cow', 'Bull'],                    icon: '🐄', ability: 'Sturdy — no special' },
  Horse:  { skins: ['Horse', 'Horse_White', 'Donkey'], icon: '🐴', ability: 'Speed burst' },
  Deer:   { skins: ['Deer', 'Stag'],                   icon: '🦌', ability: 'Leap' },
  Dog:    { skins: ['ShibaInu', 'Husky', 'Wolf'],      icon: '🐕', ability: 'Quick dodge' },
  Alpaca: { skins: ['Alpaca'],                         icon: '🦙', ability: 'Spit projectile' },
  Fox:    { skins: ['Fox'],                            icon: '🦊', ability: 'Camouflage' },
};

// Flat list of all 12 skin names — used for loading + UI iteration.
const ALL_SKINS = Object.values(CREATURES).flatMap(c => c.skins);

// Given a skin name, which creature type does it belong to?
function creatureTypeOfSkin(skin) {
  for (const [type, info] of Object.entries(CREATURES)) {
    if (info.skins.includes(skin)) return type;
  }
  return null;
}

// Per-creature gameplay stats. Skins within a creature type share stats —
// picking Bull vs Cow is purely cosmetic, for example.
//
//   walkSpeed     — units/sec when walking (not sprinting)
//   sprintMul     — sprint speed multiplier (Horse fastest, Dog next, etc.)
//   staminaMax    — stamina pool (Horse has much more)
//   staminaDrain  — stamina/sec lost while sprinting
//   staminaRegen  — stamina/sec gained while not sprinting
//   jumpForce     — initial up-velocity on jump (Deer = super jump)
//   jumpCooldown  — seconds before another jump is allowed (Deer = 10s)
//   attackClip    — animation clip name to play when attacking
//   isProjectile  — true for Alpaca (spit projectile instead of melee)
//
//   attackDir: 'forward' (bite/headbutt) or 'backward' (hind-leg kick).
//   specialJumpForce / specialJumpCooldown: Q-key super jump (Deer only).
//
const CREATURE_STATS = {
  Cow:    { walkSpeed: 14, sprintMul: 1.7, staminaMax: 100, staminaDrain: 28, staminaRegen: 14, jumpForce: 13, jumpCooldown: 0.8, attackClip: 'Attack_Kick',     attackDir: 'backward' },
  Horse:  { walkSpeed: 14, sprintMul: 2.3, staminaMax: 180, staminaDrain: 20, staminaRegen: 18, jumpForce: 13, jumpCooldown: 0.8, attackClip: 'Attack_Kick',     attackDir: 'backward' },
  Deer:   { walkSpeed: 14, sprintMul: 1.7, staminaMax: 100, staminaDrain: 28, staminaRegen: 14, jumpForce: 13, jumpCooldown: 0.8, attackClip: 'Attack_Kick',     attackDir: 'backward', specialJumpForce: 28, specialJumpCooldown: 10 },
  Dog:    { walkSpeed: 14, sprintMul: 2.0, staminaMax: 140, staminaDrain: 22, staminaRegen: 16, jumpForce: 16, jumpCooldown: 0.8, attackClip: 'Attack',          attackDir: 'forward'  },
  Alpaca: { walkSpeed: 14, sprintMul: 1.7, staminaMax: 100, staminaDrain: 28, staminaRegen: 14, jumpForce: 13, jumpCooldown: 0.8, attackClip: 'Attack_Headbutt', attackDir: 'forward', isProjectile: true },
  Fox:    { walkSpeed: 14, sprintMul: 1.7, staminaMax: 100, staminaDrain: 28, staminaRegen: 14, jumpForce: 13, jumpCooldown: 0.8, attackClip: 'Attack',          attackDir: 'forward'  },
};

function statsForSkin(skin) {
  const type = creatureTypeOfSkin(skin);
  return CREATURE_STATS[type] || CREATURE_STATS.Cow;
}

async function loadAllModels() {
  const fbxLoader  = new FBXLoader();
  const gltfLoader = new GLTFLoader();
  const texLoader  = new THREE.TextureLoader();

  // ── UFO (FBX + PBR textures) ──────────────────────────
  try {
    const ufo = await fbxLoader.loadAsync('models/ufo/UFO.fbx');
    const baseColor = await texLoader.loadAsync('models/ufo/Textures/BaseColor1.png');
    const emissiveTex = await texLoader.loadAsync('models/ufo/Textures/Emissive.png');
    ufo.traverse((child) => {
      if (child.isMesh) {
        child.material = new THREE.MeshLambertMaterial({
          map: baseColor,
          emissiveMap: emissiveTex,
          emissive: new THREE.Color(0xffffff),
          emissiveIntensity: 0.5,
        });
        child.castShadow = true;
      }
    });
    // FBX from Blender is often exported at 100× scale. Tweak this
    // scalar to match gameplay — the primitive UFO was ~4 units wide.
    ufo.scale.setScalar(0.6);
    models.ufo = ufo;
    console.log('[milk] loaded UFO model');
  } catch (err) {
    console.warn('[milk] UFO model failed, using primitives:', err.message);
  }

  // ── Animals (FBX with skeletal animations) ─────────────
  // FBX files from Blender embed bones + animation clips. We store
  // the whole loaded group as a template and clone with SkeletonUtils
  // so each cow instance has an independent skeleton for animation.
  //
  // Per-animal scale: proportional to real-life sizes relative to cow.
  // FBX scale ≈ 0.01 base (Blender 100× export), then multiplied by
  // the real-life ratio.
  // ── Animals: load each GLTF once as a template ───────────
  // GLTF (glTF 2.0) files from Blender export MUCH more cleanly than
  // FBX — the skeleton hierarchy survives SkeletonUtils.clone without
  // stretching or half-animating artifacts. No pool hack needed.
  for (const skin of ALL_SKINS) {
    try {
      const gltf = await gltfLoader.loadAsync(`models/animals/${skin}.gltf`);
      const root = gltf.scene;

      // GLTF is in meters natively (no cm→m conversion needed).
      root.traverse((c) => {
        if (c.isSkinnedMesh) {
          c.frustumCulled = false;  // animated bones can push bbox out
        }
        if (c.isMesh) {
          c.castShadow = true;
          // GLTF materials usually work as-is, but let's simplify to
          // MeshLambertMaterial to match the rest of the scene style
          // (and avoid any PBR shading surprises).
          const fixMat = (m) => new THREE.MeshLambertMaterial({
            color: m?.color ? m.color.clone() : new THREE.Color(0xcccccc),
            map: m?.map ?? null,
          });
          c.material = Array.isArray(c.material)
            ? c.material.map(fixMat)
            : fixMat(c.material);
        }
      });

      // Attach the clips to the scene root so SkeletonUtils.clone + the
      // mixer pipeline can find them on cloned instances.
      root.animations = gltf.animations ?? [];

      models.animals[skin] = root;
      const clipNames = root.animations.map(c => c.name);
      console.log(`[milk] ${skin}: loaded, clips: ${clipNames.join(', ')}`);
    } catch (err) {
      console.warn(`[milk] ${skin} GLTF failed:`, err.message);
    }
  }

  // ── Structures (FBX) ──────────────────────────────────
  const structNames = [
    'Barn', 'BigBarn', 'ChickenCoop', 'Fence', 'Fence2', 'OpenBarn',
    'Silo', 'Silo_House', 'SmallBarn', 'TowerWindmill',
    'WaterTower', 'Well', 'Windmill',
  ];
  for (const name of structNames) {
    try {
      const fbx = await fbxLoader.loadAsync(`models/structures/${name}.fbx`);
      fbx.scale.setScalar(0.01);  // cm → game units (same as animals)
      // Same material fix as animals — handle multi-material arrays.
      fbx.traverse((c) => {
        if (c.isMesh) {
          c.castShadow = true;
          c.receiveShadow = true;
          const fixMat = (m) => {
            const color = m?.color ? m.color.clone() : new THREE.Color(0xcccccc);
            return new THREE.MeshLambertMaterial({ color });
          };
          c.material = Array.isArray(c.material)
            ? c.material.map(fixMat)
            : fixMat(c.material);
        }
      });
      const sbox = new THREE.Box3().setFromObject(fbx);
      const ssize = sbox.getSize(new THREE.Vector3());
      console.log(`[milk] ${name} struct size: ${ssize.x.toFixed(1)} × ${ssize.y.toFixed(1)} × ${ssize.z.toFixed(1)}`);

      models.structures[name] = fbx;
      console.log(`[milk] loaded ${name} structure (FBX)`);
    } catch (err) {
      console.warn(`[milk] ${name} structure FBX failed:`, err.message);
    }
  }

  console.log('[milk] all models loaded');
}

// ------------------------------------------------------------------
// 1. Game state machine
// ------------------------------------------------------------------

const State = { MENU: 'menu', COUNTDOWN: 'countdown', PLAYING: 'playing' };
let gameState = State.MENU;

// ------------------------------------------------------------------
// 2. Portal protocol — read incoming params, pick next destination
// ------------------------------------------------------------------

const incoming = Portal.readPortalParams();
document.getElementById('username').textContent = incoming.username;
const nextTarget = await Portal.pickPortalTarget();

// ------------------------------------------------------------------
// 3. DOM references
// ------------------------------------------------------------------

const menuEl           = document.getElementById('menu');
const menuMainEl       = document.getElementById('menu-main');
const animalSelectEl   = document.getElementById('animal-select');
const animalGridEl     = document.getElementById('animal-grid');
const readyBtnEl       = document.getElementById('ready-btn');
const backBtnEl        = document.getElementById('back-btn');
const joinBtnEl        = document.getElementById('join-btn');
const lobbyStatusEl    = document.getElementById('lobby-status');
const playerListEl     = document.getElementById('player-list');
const settingsBtnEl    = document.getElementById('settings-btn');
const settingsModalEl  = document.getElementById('settings-modal');
const settingsCloseEl  = document.getElementById('settings-close');
const volumeSliderEl   = document.getElementById('volume-slider');
const volumeValueEl    = document.getElementById('volume-value');
const nudityToggleEl   = document.getElementById('nudity-toggle');
const countdownEl      = document.getElementById('countdown-display');
const hudEl            = document.getElementById('hud');
const peerCountEl      = document.getElementById('peers');
const abductionWarnEl  = document.getElementById('abduction-warning');
const abductionBarEl   = document.getElementById('abduction-bar');
const abductedScreenEl = document.getElementById('abducted-screen');
const strugglePromptEl = document.getElementById('struggle-prompt');
const struggleKeyEl    = document.getElementById('struggle-key');
const spectateInfoEl   = document.getElementById('spectate-info');
const spectateHintEl   = document.getElementById('spectate-hint');
const cowHudEl         = document.getElementById('cow-hud');
const staminaBarEl     = document.getElementById('stamina-bar');
const jumpBarEl        = document.getElementById('jump-bar');

// ------------------------------------------------------------------
// 4. Three.js scene setup
// ------------------------------------------------------------------

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x87ceeb);
scene.fog = new THREE.Fog(0x87ceeb, 100, 300);

const camera = new THREE.PerspectiveCamera(
  60, window.innerWidth / window.innerHeight, 0.1, 500
);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
document.body.appendChild(renderer.domElement);

window.addEventListener('resize', () => {
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth, window.innerHeight);
});

// ------------------------------------------------------------------
// 5. Lighting
// ------------------------------------------------------------------

scene.add(new THREE.AmbientLight(0xffffff, 0.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.0);
sun.position.set(50, 80, 30);
sun.castShadow = true;
scene.add(sun);

// ------------------------------------------------------------------
// 6. Ground + decorations
// ------------------------------------------------------------------

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(400, 400),
  new THREE.MeshLambertMaterial({ color: 0x4a8c3f })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

// ── Load all 3D models (async — blocks here until done) ──
// The renderer already shows the ground + sky while this runs.
await loadAllModels();

// ── Place farm structures on the map ─────────────────────
// Each entry: { model, x, z, rotY (degrees), scale }.
// Structures sit at y=0 (on the ground). If a model didn't load,
// it's silently skipped — the game still runs, just emptier.
const MAP_LAYOUT = [
  // Central barn area
  { model: 'Barn',          x:  40, z: -30,  rotY:   0, scale: 3.0 },
  { model: 'SmallBarn',     x: -35, z: -50,  rotY:  45, scale: 3.0 },
  { model: 'OpenBarn',      x:  70, z:  40,  rotY: -30, scale: 3.0 },

  // Fences — create a loose corral
  { model: 'Fence',  x:  15, z:  25, rotY:   0, scale: 3.0 },
  { model: 'Fence',  x:  25, z:  25, rotY:   0, scale: 3.0 },
  { model: 'Fence',  x:  35, z:  25, rotY:   0, scale: 3.0 },
  { model: 'Fence2', x:  45, z:  25, rotY:   0, scale: 3.0 },
  { model: 'Fence',  x: -10, z:  25, rotY:   0, scale: 3.0 },
  { model: 'Fence2', x: -20, z:  25, rotY:   0, scale: 3.0 },
  { model: 'Fence',  x:  10, z: -40, rotY:  90, scale: 3.0 },
  { model: 'Fence',  x:  10, z: -50, rotY:  90, scale: 3.0 },

  // Landmarks — visible from far away
  { model: 'Silo',          x: -60, z: -20,  rotY:   0, scale: 3.0 },
  { model: 'TowerWindmill', x:  90, z: -60,  rotY:  15, scale: 3.0 },
  { model: 'WaterTower',    x: -80, z:  50,  rotY:   0, scale: 3.0 },
  { model: 'Windmill',      x:  60, z:  80,  rotY: -20, scale: 3.0 },

  // Scattered smaller buildings
  { model: 'ChickenCoop',   x: -25, z:  35,  rotY:  60, scale: 3.0 },
  { model: 'Well',          x:   0, z:  10,  rotY:   0, scale: 3.0 },
  { model: 'Silo_House',    x: -55, z: -60,  rotY:   0, scale: 3.0 },
  { model: 'BigBarn',       x:  80, z: -20,  rotY: 180, scale: 3.0 },
];

for (const s of MAP_LAYOUT) {
  const template = models.structures[s.model];
  if (!template) continue;
  const mesh = template.clone();
  mesh.position.set(s.x, 0, s.z);
  mesh.rotation.y = (s.rotY * Math.PI) / 180;
  // Multiply (not override) so the FBXLoader's unit conversion is preserved.
  mesh.scale.multiplyScalar(s.scale);
  scene.add(mesh);
}

// ------------------------------------------------------------------
// 7. Portals
// ------------------------------------------------------------------

const exitPortalMesh = new THREE.Mesh(
  new THREE.TorusGeometry(3, 0.4, 8, 32),
  new THREE.MeshBasicMaterial({ color: 0xc64bff })
);
exitPortalMesh.position.set(60, 4, 0);
scene.add(exitPortalMesh);

let returnPortalMesh = null;
if (incoming.ref) {
  returnPortalMesh = new THREE.Mesh(
    new THREE.TorusGeometry(3, 0.4, 8, 32),
    new THREE.MeshBasicMaterial({ color: 0x4ff0ff })
  );
  returnPortalMesh.position.set(-60, 4, 0);
  scene.add(returnPortalMesh);
}

// ------------------------------------------------------------------
// 8. Helper: build a UFO mesh (used for player + menu scene)
// ------------------------------------------------------------------

function buildUFO() {
  const g = new THREE.Group();

  // Clone the loaded FBX model if available; otherwise primitive fallback.
  if (models.ufo) {
    const clone = models.ufo.clone();
    g.add(clone);
  } else {
    // Primitive fallback — flattened sphere + dome + rim lights.
    const sau = new THREE.Mesh(
      new THREE.SphereGeometry(2, 16, 8),
      new THREE.MeshLambertMaterial({ color: 0xaaaaaa })
    );
    sau.scale.set(1, 0.3, 1);
    sau.castShadow = true;
    g.add(sau);

    const dom = new THREE.Mesh(
      new THREE.SphereGeometry(1, 12, 8),
      new THREE.MeshLambertMaterial({ color: 0x66ffaa, transparent: true, opacity: 0.7 })
    );
    dom.position.y = 0.4;
    dom.scale.set(1, 0.6, 1);
    g.add(dom);

    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI * 2;
      const bulb = new THREE.Mesh(
        new THREE.SphereGeometry(0.15, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xffff00 })
      );
      bulb.position.set(Math.cos(angle) * 1.9, 0, Math.sin(angle) * 1.9);
      g.add(bulb);
    }
  }

  // ── Tractor beam cone (always added, regardless of model source) ──
  const BH = 40, BR = 8;
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(BR, BH, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x99ff66, transparent: true, opacity: 0.28,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  beam.position.y = -BH / 2;
  beam.visible = false;
  g.add(beam);

  // userData.saucer/dome are only used for the idle spin animation
  // on the primitive fallback. Null for loaded models — spin is skipped.
  g.userData.saucer = null;
  g.userData.dome   = null;
  g.userData.beam   = beam;
  return g;
}

// Beam geometry constants — shared so detection math matches the mesh.
const BEAM_HEIGHT = 40;
const BEAM_RADIUS = 8;

// ------------------------------------------------------------------
// 9. Helper: build an animal (loaded model or boxy placeholder)
// ------------------------------------------------------------------
// Accepts an optional animal name ('Cow', 'Horse', 'Pig', etc.) to
// clone from the model cache. Falls back to the primitive box-cow if
// the model isn't loaded. For the class system later, each animal is
// a separate OBJ with its own MTL colors.

// Legacy list name; alias for code that still references ANIMAL_NAMES.
const ANIMAL_NAMES = ALL_SKINS;

// Uniform scale multiplier per skin. GLTF exports are already in metres
// so 1.0 = life-size; these tweaks normalise the pack's inconsistencies
// and let us fine-tune Fox-vs-Horse sizing.
const SKIN_SIZE = {
  Cow: 1.0,   Bull: 1.1,
  Horse: 1.2, Horse_White: 1.2, Donkey: 0.9,
  Deer: 1.0,  Stag: 1.1,
  ShibaInu: 0.45, Husky: 0.55, Wolf: 0.6,
  Alpaca: 0.85,
  Fox: 0.5,
};

function buildCow(skinName = 'Cow') {
  const template = models.animals[skinName];
  if (!template) return buildPrimitiveCow();

  // OUTER group — where we put gameplay-facing transforms (position,
  // yaw, size). Safe for any transform because it sits above both
  // the SkinnedMesh and the skeleton bones.
  const g = new THREE.Group();

  // SkeletonUtils.clone duplicates the skeleton for independent animation.
  // GLTF files behave cleanly here (unlike the old FBX pack).
  // CRITICAL: do NOT rotate `inner` — rotating the SkinnedMesh ancestor
  // causes bind-pose mismatch (the "stretched limbs" bug).
  const inner = SkeletonUtils.clone(template);
  g.add(inner);

  // Per-skin uniform size (safe, doesn't distort skinning).
  g.scale.setScalar(SKIN_SIZE[skinName] ?? 1.0);

  // AnimationMixer attached to the cloned root. We preload EVERY clip
  // we might need as an Action, all .play()-ed continuously but with
  // weights controlling which is visible. Switching animations then
  // just means lerping weights — no action.stop()/start() churn that
  // causes stutter.
  let mixer = null;
  const actions = {};
  if (template.animations?.length) {
    mixer = new THREE.AnimationMixer(inner);
    for (const clip of template.animations) {
      const a = mixer.clipAction(clip);
      a.play();
      a.weight = 0;   // start all at zero; updater will pick one to ramp up
      actions[clip.name] = a;
    }
    // Default to Idle at full weight — cow is standing still initially.
    if (actions['Idle']) actions['Idle'].weight = 1;
  }

  g.userData.legs       = null;
  g.userData.hasRig     = false;
  g.userData.mixer      = mixer;
  g.userData.actions    = actions;
  // What animation is currently the "target" (for weight lerping).
  // Starts as Idle; updateAnimalAnim() picks a new target each frame.
  g.userData.currentClip = 'Idle';
  g.userData.tailPivot  = null;
  g.userData.animalName = skinName;
  return g;
}

function buildPrimitiveCow() {
  const g = new THREE.Group();

  const whiteMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const blackMat = new THREE.MeshLambertMaterial({ color: 0x222222 });
  const pinkMat  = new THREE.MeshLambertMaterial({ color: 0xffaabb });
  const hornMat  = new THREE.MeshLambertMaterial({ color: 0x554433 });

  // ── Body — longer rectangular box ──────────────────────
  const body = new THREE.Mesh(new THREE.BoxGeometry(2.8, 1.4, 1.4), whiteMat);
  body.position.y = 1.3;
  body.castShadow = true;
  g.add(body);

  // Black splotches on the body's sides (not floating on top).
  // We deterministically seed-ish them with Math.random so each cow
  // looks slightly unique. 4 spots, each on left OR right side.
  for (let i = 0; i < 4; i++) {
    const spot = new THREE.Mesh(
      new THREE.BoxGeometry(
        0.5 + Math.random() * 0.6,
        0.4 + Math.random() * 0.4,
        0.02          // very thin — sits flush on the body surface
      ),
      blackMat
    );
    const side = Math.random() < 0.5 ? 1 : -1;
    spot.position.set(
      (Math.random() - 0.5) * 2.0,   // along body length
      1.1 + Math.random() * 0.6,     // vertical on the side
      side * 0.71                    // flush against the body side
    );
    g.add(spot);
  }

  // ── Head (+X is "forward" in local space) ──────────────
  const head = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.0, 1.1), whiteMat);
  head.position.set(1.7, 1.45, 0);
  g.add(head);

  // Pink muzzle sticking out of the head
  const snout = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.55, 0.8), pinkMat);
  snout.position.set(2.15, 1.3, 0);
  g.add(snout);

  // Nostrils (two tiny black squares on the snout)
  for (const s of [-0.18, 0.18]) {
    const n = new THREE.Mesh(
      new THREE.BoxGeometry(0.08, 0.08, 0.05),
      blackMat
    );
    n.position.set(2.42, 1.32, s);
    g.add(n);
  }

  // Eyes
  for (const s of [-0.35, 0.35]) {
    const eye = new THREE.Mesh(
      new THREE.BoxGeometry(0.14, 0.14, 0.08),
      new THREE.MeshBasicMaterial({ color: 0x000000 })
    );
    eye.position.set(1.95, 1.65, s);
    g.add(eye);
  }

  // Floppy ears — angled outward
  for (const s of [-1, 1]) {
    const ear = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.5), whiteMat);
    ear.position.set(1.5, 1.95, s * 0.6);
    ear.rotation.z = s * 0.35;   // flop outward
    g.add(ear);
  }

  // Small horns — cones
  for (const s of [-1, 1]) {
    const horn = new THREE.Mesh(
      new THREE.ConeGeometry(0.1, 0.3, 6),
      hornMat
    );
    horn.position.set(1.55, 2.15, s * 0.3);
    g.add(horn);
  }

  // ── Udder (pink box underneath, toward the back) ───────
  const udder = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), pinkMat);
  udder.position.set(-0.5, 0.65, 0);
  g.add(udder);
  // Four little teats
  for (const tx of [-0.2, 0.2]) {
    for (const tz of [-0.2, 0.2]) {
      const teat = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.2, 0.08),
        pinkMat
      );
      teat.position.set(-0.5 + tx, 0.35, tz);
      g.add(teat);
    }
  }

  // ── Tail (pivoted so we can sway it later if we want) ──
  const tailPivot = new THREE.Group();
  tailPivot.position.set(-1.4, 1.55, 0);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.8, 0.15), whiteMat);
  tail.position.y = -0.4;
  tailPivot.add(tail);
  const tuft = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.25), blackMat);
  tuft.position.y = -0.85;
  tailPivot.add(tuft);
  g.add(tailPivot);

  // ── Legs — each on a pivot group so rotation = swing from hip ──
  // The mesh hangs below the pivot so rotating around X "swings" it.
  const legs = [];
  const legSpec = [
    { x:  1.0, z:  0.55, key: 'FR' },  // front-right
    { x:  1.0, z: -0.55, key: 'FL' },  // front-left
    { x: -1.0, z:  0.55, key: 'BR' },  // back-right
    { x: -1.0, z: -0.55, key: 'BL' },  // back-left
  ];
  for (const s of legSpec) {
    const pivot = new THREE.Group();
    pivot.position.set(s.x, 1.0, s.z);   // pivot sits at the "hip"
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.1, 0.3), blackMat);
    leg.position.y = -0.55;              // hangs under the pivot
    pivot.add(leg);
    g.add(pivot);
    legs.push({ pivot, key: s.key });
  }

  // Expose animatable parts for the walk cycle / future use.
  g.userData.legs      = legs;
  g.userData.tailPivot = tailPivot;
  return g;
}

// ── Leg walk cycle ────────────────────────────────────────
// `stride`: how much to swing (radians). `cadence`: steps per sec.
// `moving`: 1 if walking, 0 if idle (legs lerp back to rest).
// Flash every mesh in an animal group RED during stun. We lerp the
// material's base color toward pure red (AND emissive) so the effect
// is unmistakable in bright daylight. Caches the originals to restore.
const _flashColor = new THREE.Color(0xff0000);
function setStunFlash(animal, amount) {
  animal.traverse((c) => {
    if (!c.isMesh) return;
    const mats = Array.isArray(c.material) ? c.material : [c.material];
    for (const m of mats) {
      if (!m || !m.color) continue;
      // Cache baselines once per material so repeated calls restore cleanly.
      if (!m.userData.baseColor) {
        m.userData.baseColor = m.color.clone();
        if (m.emissive) m.userData.baseEmissive = m.emissive.clone();
      }
      m.color.copy(m.userData.baseColor).lerp(_flashColor, amount);
      if (m.emissive && m.userData.baseEmissive) {
        m.emissive.copy(m.userData.baseEmissive).lerp(_flashColor, amount * 0.5);
      }
    }
  });
}

// Animation state machine — set the given clip as the target, lerp all
// action weights toward it (1 for the target, 0 for everything else).
// Multiple actions play simultaneously but only the target has meaningful
// weight, so no fighting / no stutter.
function updateAnimalAnim(animal, dt, desiredClip) {
  const { mixer, actions } = animal.userData;
  if (!mixer || !actions) return;

  // Resolve desiredClip against available action names (case-forgiving).
  let target = desiredClip;
  if (!actions[target]) {
    for (const k of Object.keys(actions)) {
      if (k.toLowerCase() === target.toLowerCase()) { target = k; break; }
    }
  }
  if (!actions[target]) target = 'Idle';             // fallback
  if (!actions[target]) target = Object.keys(actions)[0] ?? null;

  // Log once when the clip actually changes (debugging aid).
  if (animal.userData.currentClip !== target) {
    if (animal === playerCow) {
      console.log(`[milk] self anim → ${target}`);
    } else {
      // Peer animation change — useful for verifying broadcasts arrive.
      const name = animal.userData.animalName || '?';
      console.log(`[milk] peer (${name}) anim → ${target}`);
    }
  }
  animal.userData.currentClip = target;
  const k = Math.min(1, dt * 10);   // ~100ms crossfade
  for (const [name, action] of Object.entries(actions)) {
    const targetWeight = (name === target) ? 1 : 0;
    action.weight += (targetWeight - action.weight) * k;
  }
  mixer.update(dt);
}

// Legacy entry point — a lot of call sites (menu cows, peer cows) still
// call this with (cow, dt, time, moving). Routes to the state-machine
// with a Walk/Idle choice since those callers don't track sprint/jump.
function animateCowLegs(cow, dt, time, moving) {
  if (cow.userData.mixer) {
    updateAnimalAnim(cow, dt, moving ? 'Walk' : 'Idle');
    return;
  }

  // Primitive fallback with pivot-based legs.
  const legs = cow.userData.legs;
  if (!legs) return;

  const stride  = moving ? 0.55 : 0.0;
  const cadence = 6.0;
  const phase   = time * cadence;

  for (const l of legs) {
    // Diagonal legs move in phase (FR+BL together, FL+BR together).
    const sign   = (l.key === 'FR' || l.key === 'BL') ? 1 : -1;
    const target = Math.sin(phase) * stride * sign;
    // Rotate around Z so the leg swings forward/back in the cow's
    // local X-Y plane (head direction + up). Rotating around X would
    // swing the leg side-to-side — which is what the wrong version did.
    l.pivot.rotation.z += (target - l.pivot.rotation.z) * 0.25;
  }
}

// ------------------------------------------------------------------
// 10. Player UFO (shown only during PLAYING)
// ------------------------------------------------------------------

const ufo = buildUFO();
ufo.position.set(0, 15, 0);
ufo.visible = false;
scene.add(ufo);
const saucer = ufo.userData.saucer;
const dome   = ufo.userData.dome;

// Player cow mesh — used when `localRole === 'cow'`. Hidden until then.
let playerCow = buildCow();
playerCow.visible = false;
scene.add(playerCow);

// Role is set on game start based on the host's random pick.
// Values: 'alien' | 'cow' | null (still in menu).
let localRole = null;

// ------------------------------------------------------------------
// 11. Menu background entities — wandering cows + UFOs chasing them
// ------------------------------------------------------------------

// Group so we can hide all menu entities at once when game starts.
const menuEntities = new THREE.Group();
scene.add(menuEntities);

// Menu cows — each has a random target it walks toward; picks a new one
// when it arrives. They panic-scatter when a UFO gets close.
const menuCows = [];
for (let i = 0; i < 6; i++) {
  // Pick a random skin for each menu cow so the title screen shows variety.
  const randomSkin = ALL_SKINS[Math.floor(Math.random() * ALL_SKINS.length)];
  const cow = buildCow(randomSkin);
  cow.position.set(
    (Math.random() - 0.5) * 80,
    0,
    (Math.random() - 0.5) * 80
  );
  menuEntities.add(cow);
  menuCows.push({
    mesh: cow,
    targetX: (Math.random() - 0.5) * 80,
    targetZ: (Math.random() - 0.5) * 80,
    speed: 3 + Math.random() * 2,
  });
}

// Menu UFOs — slowly chase the nearest cow, never actually catching them.
const menuUFOs = [];
for (let i = 0; i < 1; i++) {
  const u = buildUFO();
  u.position.set(
    (Math.random() - 0.5) * 60,
    8 + Math.random() * 4,
    (Math.random() - 0.5) * 60
  );
  u.scale.setScalar(0.9);
  menuEntities.add(u);
  menuUFOs.push({ mesh: u });
}

// Update menu entities each frame.
function updateMenuEntities(dt, time) {
  // Move cows toward their targets; repick when close.
  for (const c of menuCows) {
    const dx = c.targetX - c.mesh.position.x;
    const dz = c.targetZ - c.mesh.position.z;
    const dist = Math.hypot(dx, dz);
    let moving = false;
    if (dist < 2) {
      c.targetX = (Math.random() - 0.5) * 80;
      c.targetZ = (Math.random() - 0.5) * 80;
    } else {
      c.mesh.position.x += (dx / dist) * c.speed * dt;
      c.mesh.position.z += (dz / dist) * c.speed * dt;
      // Face direction of movement. The inner model already rotates +π/2
      // (nose +Z → +X). The gameplay/peer code adds another +π/2 on the
      // group — but atan2(dx,dz) already gives the raw world angle, so
      // we DON'T add π/2 here or the two offsets stack to π (backwards).
      c.mesh.rotation.y = Math.atan2(dx, dz);
      moving = true;
    }
    // Walk animation while moving.
    animateCowLegs(c.mesh, dt, time, moving);
  }

  // Each UFO picks the nearest cow and drifts toward it.
  for (const u of menuUFOs) {
    let nearest = null, nearestDist = Infinity;
    for (const c of menuCows) {
      const d = u.mesh.position.distanceTo(c.mesh.position);
      if (d < nearestDist) { nearestDist = d; nearest = c; }
    }
    if (nearest) {
      const dir = new THREE.Vector3().subVectors(nearest.mesh.position, u.mesh.position);
      dir.y = 0;  // stay level
      dir.normalize();
      u.mesh.position.addScaledVector(dir, 4 * dt);
      // Hover bob
      u.mesh.position.y = 8 + Math.sin(performance.now() * 0.001 + u.mesh.id) * 1.5;
      // Face direction
      u.mesh.rotation.y = Math.atan2(dir.x, dir.z);
    }
    // Spin the saucer (only exists on the primitive fallback, null on loaded models).
    if (u.mesh.userData.saucer) u.mesh.userData.saucer.rotation.y += dt * 2;
    if (u.mesh.userData.dome)   u.mesh.userData.dome.rotation.y   += dt * 2;
  }
}

// ------------------------------------------------------------------
// 12. Input handling (keyboard + mouse)
// ------------------------------------------------------------------

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();

  // Spectate cycling — arrow keys while abducted + cow hidden.
  if (cowAbducted && !playerCow.visible) {
    if (e.code === 'ArrowRight') cycleSpectate(1);
    if (e.code === 'ArrowLeft')  cycleSpectate(-1);
  }

  // Struggle mini-game input — if an active prompt exists and the
  // pressed letter matches, knock time off timeInBeam and flash green.
  // A wrong key while a prompt is active flashes fail briefly.
  if (strugglePromptKey && gameState === State.PLAYING && localRole === 'cow' && !cowAbducted) {
    // e.code for letter keys is "KeyE", "KeyR", etc. We compare the last char.
    const pressedLetter = e.code.startsWith('Key') ? e.code.slice(3) : '';
    const now = performance.now();
    if (pressedLetter === strugglePromptKey && now <= struggleEndsAt) {
      timeInBeam = Math.max(0, timeInBeam - STRUGGLE_REWARD);
      strugglePromptKey  = null;
      struggleNextAt     = now + 400;              // brief gap before next
      struggleFlashUntil = now + 250;
      // Tag the key element for green flash via CSS class.
      if (struggleKeyEl) {
        struggleKeyEl.classList.remove('flash-fail');
        struggleKeyEl.classList.add('flash-success');
      }
    } else if (pressedLetter && STRUGGLE_POOL.includes(pressedLetter)) {
      // Wrong key (but still a struggle-pool key) — brief fail flash.
      struggleFlashUntil = now + 200;
      if (struggleKeyEl) {
        struggleKeyEl.classList.remove('flash-success');
        struggleKeyEl.classList.add('flash-fail');
      }
    }
  }
});
window.addEventListener('keyup', (e) => {
  keys[e.code] = false;
});

const MOUSE_SENSITIVITY = 0.003;
let mouseDeltaX = 0;
let mouseDeltaY = 0;

// mousedown: first click requests pointer lock; subsequent clicks while
// locked are role-specific actions (cow attack on left click, etc.).
renderer.domElement.addEventListener('mousedown', (e) => {
  if (gameState !== State.PLAYING) return;

  if (!document.pointerLockElement) {
    renderer.domElement.requestPointerLock();
    return;
  }

  // Pointer is locked — route clicks to actions.
  if (e.button === 0 && localRole === 'cow') {
    tryAttack();
  }
});

window.addEventListener('mousemove', (e) => {
  if (document.pointerLockElement === renderer.domElement) {
    mouseDeltaX += e.movementX;
    mouseDeltaY += e.movementY;
  }
});

// ------------------------------------------------------------------
// 13. UFO flight (PLAYING state)
// ------------------------------------------------------------------

const MOVE_SPEED   = 30;
const STRAFE_SPEED = 25;
const MIN_HEIGHT   = 3;
const MAX_HEIGHT   = 80;
const MAX_PITCH    = Math.PI / 3;
const CAM_OFFSET   = new THREE.Vector3(0, 6, 14);

let yaw   = 0;
let pitch = 0;
const ufoQuat = new THREE.Quaternion();

// Beam state — true while alien is holding Space.
let beamActive = false;

function updateUFO(dt) {
  yaw   -= mouseDeltaX * MOUSE_SENSITIVITY;
  pitch -= mouseDeltaY * MOUSE_SENSITIVITY;
  mouseDeltaX = 0;
  mouseDeltaY = 0;
  pitch = Math.max(-MAX_PITCH, Math.min(MAX_PITCH, pitch));

  const yawQ   = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,1,0), yaw);
  const pitchQ = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1,0,0), pitch);
  ufoQuat.copy(yawQ).multiply(pitchQ);

  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(ufoQuat);
  const right   = new THREE.Vector3(-Math.sin(yaw - Math.PI / 2), 0, -Math.cos(yaw - Math.PI / 2));

  if (keys['KeyW'] || keys['ArrowUp'])    ufo.position.addScaledVector(forward,  MOVE_SPEED * dt);
  if (keys['KeyS'] || keys['ArrowDown'])   ufo.position.addScaledVector(forward, -MOVE_SPEED * dt);
  if (keys['KeyA'] || keys['ArrowLeft'])   ufo.position.addScaledVector(right,   -STRAFE_SPEED * dt);
  if (keys['KeyD'] || keys['ArrowRight'])  ufo.position.addScaledVector(right,    STRAFE_SPEED * dt);

  ufo.position.y = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, ufo.position.y));
  ufo.position.x = Math.max(-190, Math.min(190, ufo.position.x));
  ufo.position.z = Math.max(-190, Math.min(190, ufo.position.z));

  ufo.quaternion.copy(ufoQuat);
  // Idle spin — only exists on the primitive fallback, null on loaded models.
  if (saucer) saucer.rotation.y += dt * 1.5;
  if (dome)   dome.rotation.y   += dt * 1.5;

  // ── Beam ────────────────────────────────────────────────
  // Hold Space to emit a tractor beam. The cone is parented to the UFO
  // so it inherits the UFO's yaw + pitch — meaning you AIM the beam
  // by tilting the saucer. Diving toward a cow points the beam forward.
  beamActive = !!keys['Space'];
  ufo.userData.beam.visible = beamActive;
}

function updatePlayCamera() {
  const offset = CAM_OFFSET.clone().applyQuaternion(ufoQuat);
  camera.position.copy(ufo.position).add(offset);
  const lookTarget = ufo.position.clone();
  lookTarget.add(new THREE.Vector3(0, 0, -5).applyQuaternion(ufoQuat));
  camera.lookAt(lookTarget);
}

// ── Cow controls (ground movement, 3rd-person camera) ──────
// Cows don't fly, so no pitch — mouse Y is ignored for now (might
// be used later for camera tilt). Mouse X yaws the cow, WASD moves
// relative to that yaw.

const COW_SPEED      = 14;                          // ground speed (slower than UFO)
const COW_CAM_OFFSET = new THREE.Vector3(0, 6, 14); // camera: further behind + higher above cow
let cowYaw = 0;

// ── Ability state for the player's cow ───────────────────
// These get reset on game start (see startGameWithRole).
let cowStamina         = 100;    // current stamina (0..staminaMax)
let cowSprinting       = false;  // true while Shift is held AND stamina > 0 AND moving
let cowJumpVel         = 0;      // vertical velocity (units/sec) — non-zero while airborne
let cowGrounded        = true;   // true when on the ground
let cowJumpCooldownEnd = 0;      // perf-ms timestamp when next jump is allowed
let cowSpecialJumpEnd  = 0;      // perf-ms timestamp when next SPECIAL jump is allowed (Q key, Deer only)
let cowAttackEndTime   = 0;      // perf-ms timestamp — attack anim runs until this
let cowAttackCooldownEnd = 0;    // perf-ms timestamp when next attack is allowed
let cowStunnedUntil    = 0;      // perf-ms timestamp — we're stunned until this

const GRAVITY          = 40;     // units/sec² downward acceleration
const ATTACK_DURATION  = 0.8;    // seconds an attack anim plays
const ATTACK_COOLDOWN  = 1.5;    // seconds between attacks
const ATTACK_RANGE     = 5.0;    // game units — how close to hit a target
const STUN_DURATION    = 2.0;    // seconds a stun lasts

// Abduction state — while in the alien's beam, timeInBeam ticks up;
// at ABDUCT_SECONDS it latches cowAbducted=true and the cow is taken.
const ABDUCT_SECONDS    = 3.0;
const BEAM_DECAY_FACTOR = 2.0;   // out-of-beam decays twice as fast
let   timeInBeam        = 0;     // seconds of continuous beam contact (current run)
let   cowAbducted       = false; // latched when timeInBeam >= ABDUCT_SECONDS
let   cowLift           = 0;     // how far the cow visually lifts off the ground

// ── Struggle mini-game (active while being beamed, not yet abducted) ──
// Every STRUGGLE_INTERVAL seconds a random key prompt appears. The cow
// has STRUGGLE_WINDOW seconds to hit it — success knocks STRUGGLE_REWARD
// seconds off timeInBeam. Adds a real-time skill check so the cow has
// agency during abduction instead of just watching the bar fill.
const STRUGGLE_POOL     = ['E', 'R', 'F', 'T', 'G', 'Q'];
const STRUGGLE_INTERVAL = 1.2;   // seconds between prompts
const STRUGGLE_WINDOW   = 0.9;   // seconds to react before it expires
const STRUGGLE_REWARD   = 0.8;   // seconds subtracted from timeInBeam on success
let   strugglePromptKey = null;  // current key to press, or null if no prompt
let   struggleEndsAt    = 0;     // perf-timestamp when the current prompt expires
let   struggleNextAt    = 0;     // perf-timestamp when the next prompt may appear
let   struggleFlashUntil = 0;    // perf-timestamp — show success/fail flash until then

// Check if the player cow is inside any alien's active beam cone.
// The beam now tilts with the UFO (see updateUFO comment), so we can't
// just check "cow below alien". Instead we transform the cow's position
// into the alien's local frame; the beam points along local -Y there,
// so depth = -localY and radial distance = hypot(localX, localZ).
const _invQuat = new THREE.Quaternion();
const _local   = new THREE.Vector3();

function findBeamingAlien() {
  for (const peer of peers.values()) {
    if (peer?.role !== 'alien' || !peer.beaming || !peer.mesh) continue;

    // Inverse of the alien's quaternion transforms world → local.
    _invQuat.copy(peer.mesh.quaternion).invert();
    _local.copy(playerCow.position).sub(peer.mesh.position).applyQuaternion(_invQuat);

    const depth = -_local.y;   // beam extends in local -Y
    if (depth <= 0 || depth > BEAM_HEIGHT) continue;

    const radialDist    = Math.hypot(_local.x, _local.z);
    const radiusAtDepth = (depth / BEAM_HEIGHT) * BEAM_RADIUS;
    if (radialDist < radiusAtDepth) return peer;
  }
  return null;
}

function updateCow(dt, time) {
  // ── Abducted: frozen, sucked up into the nearest UFO ──
  // Fixes the "UFO disappears" bug: previously we raised y indefinitely
  // and the cow overshot above the UFO, leaving the camera staring at
  // empty sky. Now we lerp the whole (x,y,z) toward the nearest alien.
  if (cowAbducted) {
    // Find any alien to be pulled toward (just take the first one).
    let alienPos = null;
    for (const peer of peers.values()) {
      if (peer?.role === 'alien' && peer.mesh) {
        alienPos = peer.mesh.position;
        break;
      }
    }
    if (alienPos) {
      const k = Math.min(1, 1.8 * dt);   // ~1.8/s pull rate
      playerCow.position.x += (alienPos.x - playerCow.position.x) * k;
      playerCow.position.y += (alienPos.y - playerCow.position.y) * k;
      playerCow.position.z += (alienPos.z - playerCow.position.z) * k;
      // When we're close enough to the UFO, hide the cow mesh — we've
      // been "consumed" by the UFO. Release pointer lock so the cursor
      // is free during spectate mode.
      if (playerCow.position.distanceTo(alienPos) < 2.5) {
        playerCow.visible = false;
        if (document.pointerLockElement) document.exitPointerLock();
      }
    } else {
      // Fallback: no alien in sight (they disconnected?) — just rise.
      playerCow.position.y += 8 * dt;
    }
    mouseDeltaX = 0;  mouseDeltaY = 0;  // eat input
    // Slight spin while rising, for flavor.
    playerCow.rotation.y += dt * 2;
    animateCowLegs(playerCow, dt, time, false);
    return;
  }

  cowYaw -= mouseDeltaX * MOUSE_SENSITIVITY;
  mouseDeltaX = 0;
  mouseDeltaY = 0;

  const now = performance.now();
  const stunned = now < cowStunnedUntil;
  const attacking = now < cowAttackEndTime;
  const stats = statsForSkin(selectedAnimal);

  const forward = new THREE.Vector3(-Math.sin(cowYaw), 0, -Math.cos(cowYaw));
  const right   = new THREE.Vector3(
    -Math.sin(cowYaw - Math.PI / 2), 0, -Math.cos(cowYaw - Math.PI / 2)
  );

  // ── Beam detection + abduction timer ──
  const beamer = findBeamingAlien();
  const inBeam = !!beamer;
  if (inBeam) {
    timeInBeam += dt;
    updateStruggle();
    if (timeInBeam >= ABDUCT_SECONDS) {
      cowAbducted = true;
      clearStruggle();
      console.log('[milk] abducted!');
    }
  } else {
    timeInBeam = Math.max(0, timeInBeam - dt * BEAM_DECAY_FACTOR);
    if (timeInBeam === 0) clearStruggle();
  }

  // ── Input gathering ─────────────────────────────────────
  // Movement input is gated out when stunned (can't move).
  const movingInput = !stunned && (
    keys['KeyW'] || keys['ArrowUp']    ||
    keys['KeyS'] || keys['ArrowDown']  ||
    keys['KeyA'] || keys['ArrowLeft']  ||
    keys['KeyD'] || keys['ArrowRight']
  );

  // Sprint: Shift held + stamina left + actually moving.
  const wantsSprint = !stunned && (keys['ShiftLeft'] || keys['ShiftRight']) && movingInput && cowStamina > 0;
  cowSprinting = wantsSprint;

  // ── Stamina tick ────────────────────────────────────────
  if (cowSprinting) {
    cowStamina = Math.max(0, cowStamina - stats.staminaDrain * dt);
  } else {
    cowStamina = Math.min(stats.staminaMax, cowStamina + stats.staminaRegen * dt);
  }

  // ── Jump (Space = normal, Q = super for creatures that have it) ─
  // Normal jump (Space) is always on a short cooldown — every creature
  // can hop regularly. Super jump (Q) is a separate ability with its
  // own long cooldown (Deer only for now, via specialJumpForce).
  if (!stunned && cowGrounded) {
    if (keys['KeyQ'] && stats.specialJumpForce && now >= cowSpecialJumpEnd) {
      // Super jump — launches much higher.
      cowJumpVel = stats.specialJumpForce;
      cowGrounded = false;
      cowSpecialJumpEnd = now + stats.specialJumpCooldown * 1000;
    } else if (keys['Space'] && now >= cowJumpCooldownEnd) {
      // Normal jump.
      cowJumpVel = stats.jumpForce;
      cowGrounded = false;
      cowJumpCooldownEnd = now + stats.jumpCooldown * 1000;
    }
  }

  // ── Movement (horizontal) ───────────────────────────────
  // Reduced while in beam (being pulled up), sprint multiplier when sprinting.
  const beamSlow = inBeam ? 0.35 : 1.0;
  const sprintMul = cowSprinting ? stats.sprintMul : 1.0;
  const moveSpeed = stats.walkSpeed * sprintMul * beamSlow;

  if (movingInput) {
    if (keys['KeyW'] || keys['ArrowUp'])    playerCow.position.addScaledVector(forward,  moveSpeed * dt);
    if (keys['KeyS'] || keys['ArrowDown'])   playerCow.position.addScaledVector(forward, -moveSpeed * dt);
    if (keys['KeyA'] || keys['ArrowLeft'])   playerCow.position.addScaledVector(right,   -moveSpeed * dt);
    if (keys['KeyD'] || keys['ArrowRight'])  playerCow.position.addScaledVector(right,    moveSpeed * dt);
  }

  // ── Vertical physics (jumping + gravity) ────────────────
  cowJumpVel -= GRAVITY * dt;
  let targetY = playerCow.position.y + cowJumpVel * dt;
  // Beam lift adds on top — but only while grounded (can't lift mid-jump).
  const beamLift = cowGrounded
    ? (timeInBeam / ABDUCT_SECONDS) * 4.0
    : 0;
  cowLift += (beamLift - cowLift) * 0.15;
  // Ground check: cowLift is the beam-pull offset; base ground is y=0.
  const groundY = cowLift;
  if (targetY <= groundY) {
    targetY = groundY;
    cowJumpVel = 0;
    cowGrounded = true;
  } else {
    cowGrounded = false;
  }

  // Clamp to play area.
  playerCow.position.x = Math.max(-190, Math.min(190, playerCow.position.x));
  playerCow.position.z = Math.max(-190, Math.min(190, playerCow.position.z));
  playerCow.position.y = targetY;

  playerCow.rotation.y = cowYaw + Math.PI;

  // ── Pick animation clip ─────────────────────────────────
  // Priority: stunned → attack → jump → gallop → walk → idle.
  let desiredClip = 'Idle';
  if (stunned) {
    // Per design: Death animation plays during stun (animal "downed").
    // Abduction uses its own spin-rise, not Death, so Death here means
    // "knocked out by another animal's attack".
    desiredClip = 'Death';
  } else if (attacking && actionNameFor(stats.attackClip, playerCow)) {
    desiredClip = actionNameFor(stats.attackClip, playerCow);
  } else if (!cowGrounded) {
    desiredClip = actionNameFor('Gallop_Jump', playerCow) ?? 'Gallop';
  } else if (movingInput && cowSprinting) {
    desiredClip = 'Gallop';
  } else if (movingInput) {
    desiredClip = 'Walk';
  }
  updateAnimalAnim(playerCow, dt, desiredClip);

  // Red flash while stunned — strong tint so the hit is unmistakable.
  const flashAmount = stunned ? 0.9 : 0;
  setStunFlash(playerCow, flashAmount);
}

// Try to attack: find any peer cow inside an attack CONE (direction
// depends on creature — kickers hit behind, biters/headbutters hit in
// front). Stun the first hit via Trystero.
const ATTACK_CONE_HALF_ANGLE = Math.PI / 3;  // 60° half-angle = 120° total cone

function tryAttack() {
  const now = performance.now();
  if (now < cowAttackCooldownEnd) {
    console.log('[milk] attack on cooldown');
    return;
  }
  if (cowStunnedUntil > now || cowAbducted) {
    console.log('[milk] can\'t attack — stunned or abducted');
    return;
  }
  if (localRole !== 'cow') return;

  cowAttackEndTime = now + ATTACK_DURATION * 1000;
  cowAttackCooldownEnd = now + ATTACK_COOLDOWN * 1000;

  const stats = statsForSkin(selectedAnimal);

  // Reset the attack animation's time so each attack plays from start.
  const attackName = actionNameFor(stats.attackClip, playerCow);
  const attackAction = attackName && playerCow.userData.actions?.[attackName];
  if (attackAction) attackAction.time = 0;

  // Cone direction: "forward" (bite/headbutt) or "backward" (kick).
  // cowYaw=0 means facing world -Z. forward vector at that heading:
  const forward = new THREE.Vector3(-Math.sin(cowYaw), 0, -Math.cos(cowYaw));
  const coneAxis = stats.attackDir === 'backward'
    ? forward.clone().multiplyScalar(-1)   // hind-leg kick points behind
    : forward;                              // bite/headbutt points ahead

  const cosLimit = Math.cos(ATTACK_CONE_HALF_ANGLE);

  // Find a peer cow inside the cone (range + angle).
  let victimId = null;
  let victimDist = Infinity;
  let candidatesChecked = 0;
  for (const [peerId, peer] of peers) {
    if (peer?.role !== 'cow' || peer.abducted || !peer.mesh) continue;
    candidatesChecked++;

    const toTarget = new THREE.Vector3()
      .subVectors(peer.mesh.position, playerCow.position);
    const dist = toTarget.length();
    if (dist > ATTACK_RANGE || dist < 0.01) continue;

    toTarget.divideScalar(dist);    // normalize
    const dot = toTarget.dot(coneAxis);
    if (dot < cosLimit) continue;    // outside cone angle

    if (dist < victimDist) {
      victimDist = dist;
      victimId = peerId;
    }
  }

  console.log(`[milk] attack fired (${stats.attackDir}), cone checked ${candidatesChecked} peer(s), hit:`, victimId);

  if (victimId && sendAttackActionFn) {
    try { sendAttackActionFn({ victimId }); } catch (err) {
      console.error('[milk] sendAttackAction failed:', err);
    }
  }
}

// Returns the actual action key on the mesh that matches a desired
// clip name. Some clip names differ slightly between animal packs
// (e.g. "Jump_toIdle" vs "Jump_ToIdle"). Returns null if not present.
function actionNameFor(wantedName, animal) {
  if (!animal?.userData?.actions) return null;
  const exact = animal.userData.actions[wantedName];
  if (exact) return wantedName;
  // Case-insensitive fallback.
  for (const k of Object.keys(animal.userData.actions)) {
    if (k.toLowerCase() === wantedName.toLowerCase()) return k;
  }
  return null;
}

// Reset struggle state — called when we leave the beam / get abducted /
// game state changes, so no stale prompt hangs around.
function clearStruggle() {
  strugglePromptKey = null;
  struggleEndsAt    = 0;
  struggleNextAt    = 0;
}

// Per-frame struggle mini-game tick. Only runs while cow is being beamed.
function updateStruggle() {
  const now = performance.now();

  // Expire an active prompt if the window elapsed without a press.
  if (strugglePromptKey && now > struggleEndsAt) {
    strugglePromptKey = null;
    // Schedule next prompt after a short gap (so prompts don't chain).
    struggleNextAt = now + 300;
  }

  // Spawn a new prompt when it's time.
  if (!strugglePromptKey && now >= struggleNextAt) {
    const pick = STRUGGLE_POOL[Math.floor(Math.random() * STRUGGLE_POOL.length)];
    strugglePromptKey = pick;
    struggleEndsAt    = now + STRUGGLE_WINDOW * 1000;
    struggleNextAt    = now + STRUGGLE_INTERVAL * 1000;  // next cycle
  }
}

// Update the bottom-center progress bar + the full-screen "ABDUCTED"
// overlay based on current cow state. Called each frame during PLAYING.
function updateAbductionHUD() {
  // Only cows ever see these.
  if (localRole !== 'cow') {
    abductionWarnEl.classList.add('hidden');
    abductedScreenEl.classList.add('hidden');
    return;
  }

  // Latched abducted state — show the big full-screen overlay.
  if (cowAbducted) {
    abductionWarnEl.classList.add('hidden');
    abductedScreenEl.classList.remove('hidden');
    return;
  }

  // Mid-abduction — show the progress bar if we're actively being beamed.
  if (timeInBeam > 0) {
    abductionWarnEl.classList.remove('hidden');
    abductedScreenEl.classList.add('hidden');
    const pct = Math.min(100, (timeInBeam / ABDUCT_SECONDS) * 100);
    abductionBarEl.style.width = pct + '%';

    // Struggle mini-game prompt — show active key or hide if none.
    const now = performance.now();
    if (strugglePromptKey) {
      strugglePromptEl.classList.remove('hidden');
      struggleKeyEl.textContent = strugglePromptKey;
    } else if (now > struggleFlashUntil) {
      // No prompt and flash is done — hide the widget between prompts
      // so the flash doesn't linger.
      strugglePromptEl.classList.add('hidden');
      struggleKeyEl.classList.remove('flash-success', 'flash-fail');
    }
  } else {
    abductionWarnEl.classList.add('hidden');
    abductedScreenEl.classList.add('hidden');
    strugglePromptEl.classList.add('hidden');
    struggleKeyEl.classList.remove('flash-success', 'flash-fail');
  }
}

// Update the cow ability HUD bars (stamina + jump/special cooldown).
// For creatures with a super jump (Deer), the jump bar shows the
// special-jump cooldown (since normal jump is basically always ready).
function updateCowHUD() {
  if (localRole !== 'cow') return;
  const stats = statsForSkin(selectedAnimal);
  const now = performance.now();

  if (staminaBarEl) {
    staminaBarEl.style.width = ((cowStamina / stats.staminaMax) * 100).toFixed(0) + '%';
  }
  if (jumpBarEl) {
    let remaining, total;
    if (stats.specialJumpForce) {
      remaining = Math.max(0, cowSpecialJumpEnd - now);
      total = stats.specialJumpCooldown * 1000;
      const label = jumpBarEl.parentElement?.previousElementSibling;
      if (label && label.textContent !== 'SUPER') label.textContent = 'SUPER';
    } else {
      remaining = Math.max(0, cowJumpCooldownEnd - now);
      total = stats.jumpCooldown * 1000;
    }
    const pct = 100 - (remaining / total) * 100;
    jumpBarEl.style.width = Math.min(100, pct).toFixed(0) + '%';
  }
}

function updateCowCamera() {
  const offset = COW_CAM_OFFSET.clone().applyAxisAngle(
    new THREE.Vector3(0, 1, 0), cowYaw
  );
  camera.position.copy(playerCow.position).add(offset);
  const lookTarget = playerCow.position.clone();
  lookTarget.y += 2;  // look slightly above the cow
  camera.lookAt(lookTarget);
}

// ── Spectator mode (for abducted cows) ─────────────────────
// After the cow is fully captured (mesh hidden), camera switches to
// follow remaining alive peer cows. Left/Right arrow keys cycle the
// target. If no cows are left, orbit the map like the menu camera.

let spectateIndex = 0;   // which alive cow we're watching

// Returns an array of peer objects that are alive cows (not abducted).
function getAliveCowPeers() {
  const alive = [];
  for (const peer of peers.values()) {
    if (peer?.role === 'cow' && !peer.abducted && peer.mesh) {
      alive.push(peer);
    }
  }
  return alive;
}

// Cycle spectate target forward (+1) or backward (-1).
function cycleSpectate(dir) {
  const alive = getAliveCowPeers();
  if (alive.length === 0) return;
  spectateIndex = ((spectateIndex + dir) % alive.length + alive.length) % alive.length;
}

function updateSpectateCamera(time) {
  const alive = getAliveCowPeers();

  if (alive.length === 0) {
    // No cows left — do a menu-style orbit.
    updateMenuCamera(time);
    if (spectateInfoEl) spectateInfoEl.textContent = 'No cows remaining';
    if (spectateHintEl) spectateHintEl.textContent = '';
    return;
  }

  // Clamp index in case a cow got abducted since last frame.
  spectateIndex = spectateIndex % alive.length;
  const target = alive[spectateIndex];

  // Camera follows the spectated cow's interpolated position.
  const pos = target.mesh.position;
  const yaw = target.targetYaw ?? 0;
  const offset = COW_CAM_OFFSET.clone().applyAxisAngle(
    new THREE.Vector3(0, 1, 0), yaw
  );
  camera.position.lerp(pos.clone().add(offset), 0.08);  // smooth transition
  const lookTarget = pos.clone();
  lookTarget.y += 2;
  camera.lookAt(lookTarget);

  // Update HUD.
  if (spectateInfoEl) {
    spectateInfoEl.textContent = `Spectating: ${target.username || 'cow'}`;
  }
  if (spectateHintEl) {
    spectateHintEl.textContent = alive.length > 1
      ? `← → to switch (${spectateIndex + 1}/${alive.length})`
      : '';
  }
}

// ------------------------------------------------------------------
// 14. Menu camera — slow lazy orbit around the farm
// ------------------------------------------------------------------

const MENU_CAM_RADIUS = 60;
const MENU_CAM_HEIGHT = 30;
const MENU_CAM_SPEED  = 0.15;

function updateMenuCamera(time) {
  const angle = time * MENU_CAM_SPEED;
  camera.position.set(
    Math.cos(angle) * MENU_CAM_RADIUS,
    MENU_CAM_HEIGHT,
    Math.sin(angle) * MENU_CAM_RADIUS
  );
  camera.lookAt(0, 5, 0);
}

// ------------------------------------------------------------------
// 15. Portal collision (PLAYING state)
// ------------------------------------------------------------------

let redirecting = false;

function checkPortalCollision() {
  if (redirecting) return;

  // Which mesh represents us — UFO (alien) or cow.
  const playerPos = localRole === 'cow' ? playerCow.position : ufo.position;

  const distExit = playerPos.distanceTo(exitPortalMesh.position);
  if (distExit < 5 && nextTarget?.url) {
    redirecting = true;
    Portal.sendPlayerThroughPortal(nextTarget.url, {
      username: incoming.username, color: incoming.color, speed: incoming.speed,
    });
    return;
  }

  if (returnPortalMesh && incoming.ref) {
    const distReturn = playerPos.distanceTo(returnPortalMesh.position);
    if (distReturn < 5) {
      redirecting = true;
      Portal.sendPlayerThroughPortal(incoming.ref, {
        username: incoming.username, color: incoming.color, speed: incoming.speed,
      });
    }
  }
}

function animatePortals(time) {
  exitPortalMesh.rotation.y = time * 1.5;
  exitPortalMesh.position.y = 4 + Math.sin(time * 2) * 0.5;
  if (returnPortalMesh) {
    returnPortalMesh.rotation.y = time * 1.5;
    returnPortalMesh.position.y = 4 + Math.sin(time * 2 + 1) * 0.5;
  }
}

// ------------------------------------------------------------------
// 16. Queue / countdown — host-authoritative
// ------------------------------------------------------------------
// The "host" is the peer with the lowest ID (including us). Only the
// host tracks `countdownEndTime` and broadcasts `countdownMs`. Non-host
// peers just mirror whatever the host sends. When the host's countdown
// hits 0, it sends a one-shot `start` action and everyone transitions.

const COUNTDOWN_SECONDS  = 20;
const MIN_PLAYERS        = 2;

let selfQueued       = false;
let countdownEndTime = null;        // only used by the host
let displayCountdown = null;        // what to show on screen (ms)
let selfId           = null;        // our Trystero peer id (set once connected)
let sendStartAction  = null;        // trystero action: host → everyone says "start now"
let sendAttackActionFn = null;      // trystero action: attacker notifies victim of a hit

if (incoming.fromPortal) {
  selfQueued = true;
}

// Is *this* client the current host? Host = lowest peer ID including self.
function isHost() {
  if (!selfId) return false;
  for (const peerId of peers.keys()) {
    if (peerId < selfId) return false;
  }
  return true;
}

function getQueuedCount() {
  let count = selfQueued ? 1 : 0;
  for (const peer of peers.values()) {
    if (peer?.queued) count++;
  }
  return count;
}

function updateQueue() {
  const queuedCount = getQueuedCount();

  if (isHost()) {
    // ── Host logic: own the countdown clock ───────────────
    if (queuedCount >= MIN_PLAYERS) {
      if (countdownEndTime === null) {
        countdownEndTime = Date.now() + COUNTDOWN_SECONDS * 1000;
        console.log('[milk] (host) countdown started, queuedCount=', queuedCount);
      }
      const remaining = Math.max(0, countdownEndTime - Date.now());
      displayCountdown = remaining;

      if (remaining <= 0) {
        // ── Role assignment: host picks one queued player as alien ──
        // Only count peers we've heard a broadcast from within the
        // heartbeat window. This is critical: if we pick a ghost peer
        // as alien, nobody's selfId matches and everyone becomes a cow.
        const now = Date.now();
        const FRESH_MS = PEER_TIMEOUT_MS;

        const queuedIds = selfQueued ? [selfId] : [];
        for (const [peerId, peer] of peers) {
          const fresh = peer?.lastSeen && (now - peer.lastSeen < FRESH_MS);
          if (peer?.queued && fresh) queuedIds.push(peerId);
        }
        console.log('[milk] (host) countdown elapsed, queuedIds:', queuedIds);

        if (queuedIds.length < MIN_PLAYERS) {
          // Not enough *live* queued players — restart the countdown.
          // Safer than picking a ghost that'll leave everyone as a cow.
          console.warn('[milk] (host) fewer than', MIN_PLAYERS,
            'live queued players at elapse — restarting countdown');
          countdownEndTime = null;
          return;
        }

        const alienId = queuedIds[Math.floor(Math.random() * queuedIds.length)];
        console.log('[milk] (host) alien assigned:', alienId);

        try {
          if (sendStartAction) sendStartAction({ alienId });
        } catch (err) {
          console.error('[milk] sendStartAction failed:', err);
        }

        startGameWithRole(alienId);
        countdownEndTime = null;
      }
    } else {
      if (countdownEndTime !== null) {
        countdownEndTime = null;
        console.log('[milk] (host) countdown cancelled — queuedCount now', queuedCount);
      }
      displayCountdown = null;
    }
  } else {
    // ── Non-host: mirror the host's broadcast ─────────────
    // Find the host peer (lowest ID we know of).
    let hostPeerId = null;
    for (const peerId of peers.keys()) {
      if (hostPeerId === null || peerId < hostPeerId) hostPeerId = peerId;
    }
    const hostPeer = hostPeerId ? peers.get(hostPeerId) : null;
    displayCountdown = hostPeer?.countdownMs ?? null;
  }

  // Render the countdown text (same logic for host + non-host).
  if (displayCountdown !== null && displayCountdown > 0) {
    const secs = Math.ceil(displayCountdown / 1000);
    countdownEl.textContent = `Starting in ${secs}...`;
  } else {
    countdownEl.textContent = '';
  }
}

// ------------------------------------------------------------------
// 17. Menu navigation + animal selection + queue
// ------------------------------------------------------------------

// Which skin the player chose. Used for spawning + broadcasting.
let selectedAnimal = 'Cow';

// Pretty display names for skins (replace underscores, etc).
function displaySkin(skin) {
  return skin.replace(/_/g, ' ').replace('White ', 'White ');  // "Horse_White" → "Horse White"
}

// ── Build the animal selection grid (once, at startup) ──
// Groups skins by creature type. Skins within a group share the same
// gameplay class — picking a different skin is purely cosmetic.
for (const [creatureType, info] of Object.entries(CREATURES)) {
  // Creature group header
  const header = document.createElement('div');
  header.className = 'creature-group-header';
  header.innerHTML = `
    <span class="creature-group-icon">${info.icon}</span>
    <span class="creature-group-name">${creatureType}</span>
    <span class="creature-group-ability">${info.ability}</span>
  `;
  animalGridEl.appendChild(header);

  // Skin cards row
  const row = document.createElement('div');
  row.className = 'skin-row';
  for (const skin of info.skins) {
    const card = document.createElement('div');
    card.className = 'animal-card';
    card.dataset.animal = skin;
    card.innerHTML = `
      <div class="animal-card-name">${displaySkin(skin)}</div>
    `;
    card.addEventListener('click', () => {
      animalGridEl.querySelectorAll('.animal-card').forEach(
        (c) => c.classList.remove('selected')
      );
      card.classList.add('selected');
      selectedAnimal = skin;
      readyBtnEl.disabled = false;
      readyBtnEl.textContent = `I'm Ready (${displaySkin(skin)})`;
    });
    row.appendChild(card);
  }
  animalGridEl.appendChild(row);
}

// ── Menu navigation ──────────────────────────────────────

// "Join Game" → show animal selection.
joinBtnEl.addEventListener('click', () => {
  menuMainEl.classList.add('hidden');
  animalSelectEl.classList.remove('hidden');
});

// "Back" → return to main menu, unqueue if we were queued.
backBtnEl.addEventListener('click', () => {
  animalSelectEl.classList.add('hidden');
  menuMainEl.classList.remove('hidden');
  if (selfQueued) {
    selfQueued = false;
    readyBtnEl.textContent = selectedAnimal
      ? `I'm Ready (${selectedAnimal})`
      : 'Pick an animal first';
    readyBtnEl.classList.remove('queued');
    broadcastSelf();
  }
});

// "I'm Ready" — toggles queue on/off (same as old "Queue Up").
readyBtnEl.addEventListener('click', () => {
  selfQueued = !selfQueued;
  updateReadyButton();
  broadcastSelf();
});

function updateReadyButton() {
  if (selfQueued) {
    readyBtnEl.textContent = 'Waiting for players...';
    readyBtnEl.classList.add('queued');
  } else {
    readyBtnEl.textContent = `I'm Ready (${selectedAnimal})`;
    readyBtnEl.classList.remove('queued');
  }
}

// Called when multiplayer connects — enable the Join button.
function enableJoinButton() {
  joinBtnEl.disabled = false;
  joinBtnEl.textContent = 'Join Game';
}

// ------------------------------------------------------------------
// 18. Settings panel
// ------------------------------------------------------------------
// Volume slider: persists to localStorage as a 0–100 integer.
// The actual volume variable is global so future audio code can read it.
// "Nudity" toggle: flips a label, does absolutely nothing else. (joke)

let masterVolume = 70; // 0–100
const VOL_KEY = 'milk.volume';

// Load saved volume from localStorage (if present).
const savedVol = localStorage.getItem(VOL_KEY);
if (savedVol !== null) {
  masterVolume = Math.max(0, Math.min(100, parseInt(savedVol, 10)));
}
volumeSliderEl.value = masterVolume;
volumeValueEl.textContent = `${masterVolume}%`;

volumeSliderEl.addEventListener('input', (e) => {
  masterVolume = parseInt(e.target.value, 10);
  volumeValueEl.textContent = `${masterVolume}%`;
  localStorage.setItem(VOL_KEY, String(masterVolume));
  // When audio is added later, it'll read window.masterVolume / 100.
  window.masterVolume = masterVolume / 100;
});
window.masterVolume = masterVolume / 100;

// Nudity toggle — a joke that literally does nothing game-side.
nudityToggleEl.addEventListener('click', () => {
  const on = nudityToggleEl.dataset.on === 'true';
  nudityToggleEl.dataset.on = String(!on);
  nudityToggleEl.textContent = !on ? 'ON' : 'OFF';
});

// Open / close the settings modal.
settingsBtnEl.addEventListener('click', () => {
  settingsModalEl.classList.remove('hidden');
});
settingsCloseEl.addEventListener('click', () => {
  settingsModalEl.classList.add('hidden');
});
// Click outside the panel to close too.
settingsModalEl.addEventListener('click', (e) => {
  if (e.target === settingsModalEl) {
    settingsModalEl.classList.add('hidden');
  }
});

// ------------------------------------------------------------------
// 19. Player list UI
// ------------------------------------------------------------------

function refreshPlayerList() {
  playerListEl.innerHTML = '';

  const selfLi = document.createElement('li');
  selfLi.innerHTML = `
    <span class="player-dot" style="background:#${incoming.color}"></span>
    ${incoming.username} (you)
    ${selfQueued ? '<span class="queued-badge">queued</span>' : ''}
  `;
  playerListEl.appendChild(selfLi);

  for (const [, peer] of peers) {
    if (!peer) continue;
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="player-dot" style="background:#${peer.color || 'aaa'}"></span>
      ${peer.username || 'guest'}
      ${peer.queued ? '<span class="queued-badge">queued</span>' : ''}
    `;
    playerListEl.appendChild(li);
  }
}

// ------------------------------------------------------------------
// 20. State transitions
// ------------------------------------------------------------------

// Called by both host and non-host when the start signal fires.
// `alienId` is the Trystero peer ID that was picked as the alien.
function startGameWithRole(alienId) {
  if (gameState === State.PLAYING) return;  // idempotent

  localRole = (alienId === selfId) ? 'alien' : 'cow';
  console.log('[milk] my role:', localRole, '(alien is', alienId + ')');

  gameState = State.PLAYING;

  // Hide menu UI, show HUD.
  menuEl.classList.add('hidden');
  hudEl.classList.remove('hidden');

  // Hide menu background entities (the chasing UFOs + wandering cows).
  menuEntities.visible = false;

  if (document.pointerLockElement) {
    document.exitPointerLock();
  }

  const hintEl = document.getElementById('hint');

  if (localRole === 'alien') {
    if (hintEl) hintEl.textContent = 'Mouse aims · WASD moves · Space emits tractor beam';
    // Spawn the player as the UFO.
    ufo.visible = true;
    playerCow.visible = false;
    ufo.position.set(0, 15, 0);
    yaw = 0;
    pitch = 0;

    if (incoming.fromPortal && returnPortalMesh) {
      ufo.position.set(returnPortalMesh.position.x + 8, 15, 0);
    }
  } else {
    // Spawn the player as their chosen animal at a random ground position.
    ufo.visible = false;

    scene.remove(playerCow);
    playerCow = buildCow(selectedAnimal);
    playerCow.position.set(
      (Math.random() - 0.5) * 50,
      0,
      (Math.random() - 0.5) * 50
    );
    playerCow.visible = true;
    scene.add(playerCow);
    cowYaw = 0;

    // Initialise ability state based on the chosen creature's stats.
    const stats = statsForSkin(selectedAnimal);
    cowStamina           = stats.staminaMax;
    cowSprinting         = false;
    cowJumpVel           = 0;
    cowGrounded          = true;
    cowJumpCooldownEnd   = 0;
    cowSpecialJumpEnd    = 0;
    cowAttackEndTime     = 0;
    cowAttackCooldownEnd = 0;
    cowStunnedUntil      = 0;

    // Show the cow ability HUD (stamina + jump bars).
    if (cowHudEl) cowHudEl.classList.remove('hidden');
    if (hintEl) hintEl.textContent = 'WASD move · Shift sprint · Space jump · Click attack';
  }
}

// ------------------------------------------------------------------
// 21. Multiplayer via Trystero
// ------------------------------------------------------------------

const peers = new Map();
let sendState = null;
let room = null;

function setPeerStatus(text, isError = false) {
  if (!peerCountEl) return;
  peerCountEl.textContent = text;
  peerCountEl.style.color = isError ? '#ff6b6b' : '';
}

function refreshPeerCount() {
  const total = peers.size + 1;
  setPeerStatus(`${total} online`);
  lobbyStatusEl.textContent = `${total} player${total === 1 ? '' : 's'} in lobby`;
}

// Broadcast our state. Uses the correct position/yaw based on role.
// Host also includes `countdownMs` so non-hosts can mirror it.
function broadcastSelf() {
  if (!sendState) return;

  // Pick whichever mesh represents us right now.
  const pos    = localRole === 'cow' ? playerCow.position : ufo.position;
  const myYaw  = localRole === 'cow' ? cowYaw : yaw;
  const myPit  = localRole === 'cow' ? 0 : pitch;

  sendState({
    x: pos.x,
    y: pos.y,
    z: pos.z,
    yaw: myYaw,
    pitch: myPit,
    role: localRole,
    color: incoming.color,
    username: incoming.username,
    queued: selfQueued,
    state: gameState,
    countdownMs: isHost() ? displayCountdown : null,
    // Ability state:
    beaming:    localRole === 'alien' ? beamActive : false,
    abducted:   localRole === 'cow'   ? cowAbducted : false,
    animalName: localRole === 'cow'   ? selectedAnimal : null,
    // Cow animation state — so peers can render the correct clip.
    // currentClip lets peers mirror walk/gallop/jump/attack/death directly.
    currentClip: localRole === 'cow' ? (playerCow?.userData?.currentClip || 'Idle') : null,
    grounded:    localRole === 'cow' ? cowGrounded : true,
  });
}

// ── Peer heartbeat / ghost removal ─────────────────────────
// Trystero's onPeerLeave doesn't always fire — a tab closed abruptly,
// a network blip, or a stale Nostr relay replay can leave phantom
// peers in our map. We broadcast state often enough to heartbeat
// ourselves; if a peer hasn't sent anything in PEER_TIMEOUT_MS,
// assume they're gone and cull.
//
// Timeout is generous because backgrounded browser tabs throttle both
// requestAnimationFrame *and* setInterval down to ~1s. A tab that's
// still alive but not focused should never cross this threshold.
const PEER_TIMEOUT_MS = 12000;

function cullStalePeers() {
  const now = Date.now();
  let culled = false;
  for (const [id, peer] of peers) {
    if (!peer) continue;
    // Fall back to joinedAt if we've never received a state broadcast.
    const last = peer.lastSeen ?? peer.joinedAt ?? 0;
    if (now - last > PEER_TIMEOUT_MS) {
      console.log('[milk] culling stale peer:', id,
        peer.lastSeen ? '(no broadcast in 6s)' : '(never broadcast)');
      if (peer.mesh) scene.remove(peer.mesh);
      peers.delete(id);
      culled = true;
    }
  }
  if (culled) {
    refreshPeerCount();
    refreshPlayerList();
  }
}

// Run every second — cheap, and catches ghosts quickly.
setInterval(cullStalePeers, 1000);

async function loadTrystero() {
  const urls = [
    'https://esm.run/trystero@0.23',
    'https://cdn.jsdelivr.net/npm/trystero@0.23/+esm',
    'https://esm.sh/trystero@0.23',
  ];
  let lastErr;
  for (const url of urls) {
    try {
      const mod = await import(url);
      if (mod && typeof mod.joinRoom === 'function') {
        console.log('[milk] loaded trystero from', url);
        return mod;
      }
      lastErr = new Error(`module from ${url} has no joinRoom export`);
    } catch (err) {
      console.warn('[milk] cdn failed:', url, err.message);
      lastErr = err;
    }
  }
  throw lastErr || new Error('could not load trystero');
}

async function setupMultiplayer() {
  try {
    lobbyStatusEl.textContent = 'Connecting...';
    const mod = await loadTrystero();
    const { joinRoom, selfId: trysteroSelfId } = mod;

    selfId = trysteroSelfId;  // store our peer ID for host election
    console.log('[milk] selfId:', selfId);

    room = joinRoom({ appId: 'milk-abduction' }, 'farm-01');

    // Continuous state (position, queue flag, countdown).
    const [send, getState] = room.makeAction('state');
    sendState = send;

    // One-shot action: host fires this when countdown hits 0.
    // Non-host clients use it to transition to PLAYING in sync.
    const [sendStart, getStart] = room.makeAction('start');
    sendStartAction = sendStart;
    getStart((payload) => {
      console.log('[milk] received start signal', payload);
      startGameWithRole(payload?.alienId);
    });

    // One-shot: an attacker hits a target. Target plays Death + is stunned.
    // Payload: { victimId } — we only react if victimId === our selfId.
    const [sendAttackAction, getAttackAction] = room.makeAction('attack');
    sendAttackActionFn = sendAttackAction;
    getAttackAction((payload) => {
      console.log('[milk] received attack action:', payload, 'mySelfId:', selfId);
      if (payload?.victimId === selfId && !cowAbducted && gameState === State.PLAYING) {
        // Got hit! Apply stun.
        cowStunnedUntil = performance.now() + STUN_DURATION * 1000;
        console.log('[milk] I am the victim — stunned for', STUN_DURATION, 's');
      }
    });

    room.onPeerJoin((id) => {
      console.log('[milk] peer joined:', id);
      // Track when they joined — if they never broadcast state within
      // PEER_TIMEOUT_MS, cullStalePeers() will remove them (ghost peer).
      peers.set(id, { joinedAt: Date.now() });
      broadcastSelf();
      refreshPeerCount();
      refreshPlayerList();
    });

    room.onPeerLeave((id) => {
      console.log('[milk] peer left:', id);
      const peer = peers.get(id);
      if (peer?.mesh) scene.remove(peer.mesh);
      peers.delete(id);
      refreshPeerCount();
      refreshPlayerList();
    });

    getState((data, peerId) => {
      let peer = peers.get(peerId);

      if (gameState === State.PLAYING) {
        // Pick the mesh type based on *this peer's* role.
        const desiredType = data.role === 'alien' ? 'ufo' : 'cow';

        // (Re)build the mesh if it doesn't exist or role changed.
        if (!peer || !peer.mesh || peer.meshType !== desiredType) {
          if (peer?.mesh) scene.remove(peer.mesh);
          const mesh = desiredType === 'ufo'
            ? buildUFO()
            : buildCow(data.animalName || 'Cow');
          scene.add(mesh);
          peer = peer || {};
          peer.mesh     = mesh;
          peer.meshType = desiredType;
          peer.renderX  = data.x;
          peer.renderY  = data.y;
          peer.renderZ  = data.z;
        }
        peer.targetX     = data.x;
        peer.targetY     = data.y;
        peer.targetZ     = data.z;
        peer.targetYaw   = data.yaw;
        peer.targetPitch = data.pitch ?? 0;

        // Toggle the beam cone on peer UFOs based on their broadcast.
        if (peer.meshType === 'ufo' && peer.mesh.userData.beam) {
          peer.mesh.userData.beam.visible = !!data.beaming;
        }
      }

      if (!peer) peer = {};
      peer.username     = data.username;
      peer.color        = data.color;
      peer.queued       = data.queued;
      peer.role         = data.role;
      peer.countdownMs  = data.countdownMs;   // only meaningful if this peer is host
      peer.beaming      = !!data.beaming;
      peer.abducted     = !!data.abducted;
      peer.currentClip  = data.currentClip || null;
      // Heartbeat — updated on every broadcast received. Used by
      // cullStalePeers() to detect ghost peers.
      peer.lastSeen     = Date.now();
      peers.set(peerId, peer);

      refreshPlayerList();
    });

    enableJoinButton();
    refreshPeerCount();
    refreshPlayerList();
    broadcastSelf();
    console.log('[milk] multiplayer ready');
  } catch (err) {
    console.error('[milk] multiplayer setup failed:', err);
    lobbyStatusEl.textContent = 'Multiplayer offline — solo mode';
    enableJoinButton();
    refreshPlayerList();
  }
}

setupMultiplayer();

// ── Background-safe heartbeat ────────────────────────────
// The main game loop broadcasts inside requestAnimationFrame, which
// browsers throttle heavily (often down to 1fps, sometimes to zero)
// for backgrounded/hidden tabs. This setInterval keeps a steady
// stream of broadcasts even when the tab isn't focused, so peers
// don't think we've silently disconnected. setInterval gets clamped
// to ~1s in background but never fully paused.
setInterval(() => { broadcastSelf(); }, 500);

window.addEventListener('beforeunload', () => {
  if (room) {
    try { room.leave(); } catch {}
  }
});

// ------------------------------------------------------------------
// 22. Main loop
// ------------------------------------------------------------------

let lastBroadcast = 0;
const clock = new THREE.Clock();

function gameLoop() {
  requestAnimationFrame(gameLoop);

  const dt   = Math.min(clock.getDelta(), 0.05);
  const time = clock.getElapsedTime();

  animatePortals(time);

  if (gameState === State.MENU || gameState === State.COUNTDOWN) {
    updateMenuCamera(time);
    updateMenuEntities(dt, time);
    updateQueue();
  }

  if (gameState === State.PLAYING) {
    // Branch by role — alien flies the UFO, cow walks on the ground.
    if (localRole === 'alien') {
      updateUFO(dt);
      updatePlayCamera();
    } else if (cowAbducted && !playerCow.visible) {
      // Abducted + mesh hidden → spectate remaining cows.
      updateSpectateCamera(time);
    } else {
      updateCow(dt, time);
      updateCowCamera();
    }
    updateAbductionHUD();
    updateCowHUD();
    checkPortalCollision();

    // Interpolate peer positions + rotate them to face their yaw.
    for (const peer of peers.values()) {
      if (!peer?.mesh) continue;

      // Hide abducted peer cows — they've been captured, shouldn't
      // float above the UFO on other players' screens.
      if (peer.meshType === 'cow' && peer.abducted) {
        peer.mesh.visible = false;
        continue;
      }
      peer.mesh.visible = true;

      const k = Math.min(1, dt * 10);

      // Detect movement by how far behind the interp is from the target.
      // If we're still catching up to the target, the peer is moving.
      const dx = (peer.targetX ?? peer.renderX) - peer.renderX;
      const dz = (peer.targetZ ?? peer.renderZ) - peer.renderZ;
      const movingAmount = Math.hypot(dx, dz);

      peer.renderX += dx * k;
      peer.renderY += ((peer.targetY ?? peer.renderY) - peer.renderY) * k;
      peer.renderZ += dz * k;
      peer.mesh.position.set(peer.renderX, peer.renderY, peer.renderZ);

      // Rotate the mesh.
      if (peer.targetYaw !== undefined) {
        if (peer.meshType === 'cow') {
          // FBX nose is +Z local; our forward at yaw=0 is world -Z.
          // Rotation of π maps +Z → -Z, so total = targetYaw + π.
          peer.mesh.rotation.y = peer.targetYaw + Math.PI;
        } else {
          // UFO — apply yaw AND pitch via quaternion so the beam aims
          // in the direction the remote alien is pointing.
          const yawQ   = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(0, 1, 0), peer.targetYaw
          );
          const pitchQ = new THREE.Quaternion().setFromAxisAngle(
            new THREE.Vector3(1, 0, 0), peer.targetPitch ?? 0
          );
          peer.mesh.quaternion.copy(yawQ).multiply(pitchQ);
        }
      }

      // Animate legs for peer cows.
      if (peer.meshType === 'cow') {
        // Use the peer's broadcast clip if present (they know if they're
        // sprinting/jumping/attacking/stunned). Fall back to moving detect.
        if (peer.currentClip && peer.mesh.userData.actions) {
          updateAnimalAnim(peer.mesh, dt, peer.currentClip);
        } else {
          animateCowLegs(peer.mesh, dt, time, movingAmount > 0.1);
        }
        // Red stun flash — peer's currentClip is 'Death' while stunned.
        // (Note: abducted cows are hidden, so Death here always means stunned.)
        const peerStunned = peer.currentClip === 'Death';
        setStunFlash(peer.mesh, peerStunned ? 0.9 : 0);
      }
    }
  }

  const now = performance.now();
  if (now - lastBroadcast > 66) {
    lastBroadcast = now;
    broadcastSelf();
  }

  renderer.render(scene, camera);
}

gameLoop();
