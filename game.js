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
const lobbyStatusEl    = document.getElementById('lobby-status');
const playerListEl     = document.getElementById('player-list');
const queueBtnEl       = document.getElementById('queue-btn');
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

const barn = new THREE.Mesh(
  new THREE.BoxGeometry(16, 12, 20),
  new THREE.MeshLambertMaterial({ color: 0x8b2500 })
);
barn.position.set(40, 6, -30);
barn.castShadow = true;
scene.add(barn);

const roof = new THREE.Mesh(
  new THREE.ConeGeometry(14, 6, 4),
  new THREE.MeshLambertMaterial({ color: 0x5c3317 })
);
roof.position.set(40, 15, -30);
roof.rotation.y = Math.PI / 4;
scene.add(roof);

for (let i = -5; i <= 5; i++) {
  const post = new THREE.Mesh(
    new THREE.BoxGeometry(0.4, 3, 0.4),
    new THREE.MeshLambertMaterial({ color: 0xffffff })
  );
  post.position.set(i * 6, 1.5, 20);
  scene.add(post);
  if (i < 5) {
    const rail = new THREE.Mesh(
      new THREE.BoxGeometry(6, 0.3, 0.2),
      new THREE.MeshLambertMaterial({ color: 0xffffff })
    );
    rail.position.set(i * 6 + 3, 2.2, 20);
    scene.add(rail);
  }
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

function buildUFO({ saucerColor = 0xaaaaaa, domeColor = 0x66ffaa } = {}) {
  const g = new THREE.Group();

  const sau = new THREE.Mesh(
    new THREE.SphereGeometry(2, 16, 8),
    new THREE.MeshLambertMaterial({ color: saucerColor })
  );
  sau.scale.set(1, 0.3, 1);
  sau.castShadow = true;
  g.add(sau);

  const dom = new THREE.Mesh(
    new THREE.SphereGeometry(1, 12, 8),
    new THREE.MeshLambertMaterial({ color: domeColor, transparent: true, opacity: 0.7 })
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

  // ── Tractor beam cone ─────────────────────────────────
  // An inverted (tip at UFO, wide at ground) translucent cone.
  // Uses ConeGeometry which has its tip at +Y by default, so positioning
  // it at (0, -height/2) puts the tip at the UFO and the wide base below.
  // `open ended` (no cap) so you can see through the base.
  const BEAM_HEIGHT = 40;
  const BEAM_RADIUS = 8;
  const beam = new THREE.Mesh(
    new THREE.ConeGeometry(BEAM_RADIUS, BEAM_HEIGHT, 24, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0x99ff66,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,    // visible from inside too
      depthWrite: false,         // avoid z-fighting with what's inside
    })
  );
  beam.position.y = -BEAM_HEIGHT / 2;  // tip flush with UFO center
  beam.visible = false;                 // off until the alien hits Space
  g.add(beam);

  // Save refs to animatable parts.
  g.userData.saucer = sau;
  g.userData.dome   = dom;
  g.userData.beam   = beam;
  return g;
}

// Beam geometry constants — shared so detection math matches the mesh.
const BEAM_HEIGHT = 40;
const BEAM_RADIUS = 8;

// ------------------------------------------------------------------
// 9. Helper: build a simple cow (boxy placeholder)
// ------------------------------------------------------------------

function buildCow() {
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
function animateCowLegs(cow, time, moving) {
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
const playerCow = buildCow();
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
  const cow = buildCow();
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
for (let i = 0; i < 2; i++) {
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
      // Face direction of movement. The cow's head is at local +X,
      // and atan2(dx, dz) gives the world yaw the cow is heading — so
      // we add π/2 (same as the gameplay cow) to align.
      c.mesh.rotation.y = Math.atan2(dx, dz) + Math.PI / 2;
      moving = true;
    }
    // Walk animation while moving.
    animateCowLegs(c.mesh, time, moving);
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
    // Spin the saucer
    u.mesh.userData.saucer.rotation.y += dt * 2;
    u.mesh.userData.dome.rotation.y   += dt * 2;
  }
}

// ------------------------------------------------------------------
// 12. Input handling (keyboard + mouse)
// ------------------------------------------------------------------

const keys = {};
window.addEventListener('keydown', (e) => {
  keys[e.code] = true;
  if (e.code === 'Space') e.preventDefault();

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

renderer.domElement.addEventListener('click', () => {
  if (gameState === State.PLAYING) {
    renderer.domElement.requestPointerLock();
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
  saucer.rotation.y += dt * 1.5;
  dome.rotation.y   += dt * 1.5;

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
const COW_CAM_OFFSET = new THREE.Vector3(0, 4, 8);  // camera: behind + above cow
let cowYaw = 0;

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
      // been "consumed" by the UFO.
      if (playerCow.position.distanceTo(alienPos) < 2.5) {
        playerCow.visible = false;
      }
    } else {
      // Fallback: no alien in sight (they disconnected?) — just rise.
      playerCow.position.y += 8 * dt;
    }
    mouseDeltaX = 0;  mouseDeltaY = 0;  // eat input
    // Slight spin while rising, for flavor.
    playerCow.rotation.y += dt * 2;
    animateCowLegs(playerCow, time, false);
    return;
  }

  cowYaw -= mouseDeltaX * MOUSE_SENSITIVITY;
  mouseDeltaX = 0;
  mouseDeltaY = 0;

  const forward = new THREE.Vector3(-Math.sin(cowYaw), 0, -Math.cos(cowYaw));
  const right   = new THREE.Vector3(
    -Math.sin(cowYaw - Math.PI / 2), 0, -Math.cos(cowYaw - Math.PI / 2)
  );

  // ── Beam detection + abduction timer ──
  const beamer = findBeamingAlien();
  const inBeam = !!beamer;

  if (inBeam) {
    timeInBeam += dt;
    // Keep the struggle prompts ticking while in beam.
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

  // Track any movement key pressed — used for leg animation + for the
  // broadcast's "moving" hint (future use). Applied to motion below.
  const moving =
    keys['KeyW'] || keys['ArrowUp']    ||
    keys['KeyS'] || keys['ArrowDown']  ||
    keys['KeyA'] || keys['ArrowLeft']  ||
    keys['KeyD'] || keys['ArrowRight'];

  // While in-beam, movement is reduced (you're being pulled up).
  const speedMul = inBeam ? 0.35 : 1.0;
  if (keys['KeyW'] || keys['ArrowUp'])    playerCow.position.addScaledVector(forward,  COW_SPEED * speedMul * dt);
  if (keys['KeyS'] || keys['ArrowDown'])   playerCow.position.addScaledVector(forward, -COW_SPEED * speedMul * dt);
  if (keys['KeyA'] || keys['ArrowLeft'])   playerCow.position.addScaledVector(right,   -COW_SPEED * speedMul * dt);
  if (keys['KeyD'] || keys['ArrowRight'])  playerCow.position.addScaledVector(right,    COW_SPEED * speedMul * dt);

  // Lift visual — smoothly track timeInBeam fraction for feedback.
  const targetLift = (timeInBeam / ABDUCT_SECONDS) * 4.0;
  cowLift += (targetLift - cowLift) * 0.15;

  // Clamp to play area.
  playerCow.position.x = Math.max(-190, Math.min(190, playerCow.position.x));
  playerCow.position.z = Math.max(-190, Math.min(190, playerCow.position.z));
  playerCow.position.y = cowLift;

  playerCow.rotation.y = cowYaw + Math.PI / 2;

  animateCowLegs(playerCow, time, moving);
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

function updateCowCamera() {
  const offset = COW_CAM_OFFSET.clone().applyAxisAngle(
    new THREE.Vector3(0, 1, 0), cowYaw
  );
  camera.position.copy(playerCow.position).add(offset);
  const lookTarget = playerCow.position.clone();
  lookTarget.y += 2;  // look slightly above the cow
  camera.lookAt(lookTarget);
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
// 17. Queue button
// ------------------------------------------------------------------

queueBtnEl.addEventListener('click', () => {
  selfQueued = !selfQueued;
  updateQueueButton();
  broadcastSelf();
});

function updateQueueButton() {
  if (selfQueued) {
    queueBtnEl.textContent = 'Waiting for players...';
    queueBtnEl.classList.add('queued');
  } else {
    queueBtnEl.textContent = 'Queue Up';
    queueBtnEl.classList.remove('queued');
  }
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

  if (localRole === 'alien') {
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
    // Spawn the player as a cow at a random-ish ground position.
    ufo.visible = false;
    playerCow.visible = true;
    playerCow.position.set(
      (Math.random() - 0.5) * 50,
      0,
      (Math.random() - 0.5) * 50
    );
    cowYaw = 0;
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
    beaming:  localRole === 'alien' ? beamActive : false,
    abducted: localRole === 'cow'   ? cowAbducted : false,
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
      // Payload carries the picked alien's peer ID.
      startGameWithRole(payload?.alienId);
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
          const mesh = desiredType === 'ufo' ? buildUFO() : buildCow();
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
      // Heartbeat — updated on every broadcast received. Used by
      // cullStalePeers() to detect ghost peers.
      peer.lastSeen     = Date.now();
      peers.set(peerId, peer);

      refreshPlayerList();
    });

    queueBtnEl.disabled = false;
    updateQueueButton();
    refreshPeerCount();
    refreshPlayerList();
    broadcastSelf();
    console.log('[milk] multiplayer ready');
  } catch (err) {
    console.error('[milk] multiplayer setup failed:', err);
    lobbyStatusEl.textContent = 'Multiplayer offline — solo mode';
    queueBtnEl.disabled = false;
    updateQueueButton();
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
    } else {
      updateCow(dt, time);
      updateCowCamera();
    }
    updateAbductionHUD();
    checkPortalCollision();

    // Interpolate peer positions + rotate them to face their yaw.
    for (const peer of peers.values()) {
      if (!peer?.mesh) continue;
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
          // Cow head points +X locally, so we add π/2 to face -Z world.
          peer.mesh.rotation.y = peer.targetYaw + Math.PI / 2;
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
        animateCowLegs(peer.mesh, time, movingAmount > 0.1);
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
