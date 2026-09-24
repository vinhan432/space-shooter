/* ============================================================================
   VOID LANCER — headless cheat/dev-console test harness
   Boots the REAL game scripts (data/engine/fx/entities/game) in Node with
   the real vendored three.js (only WebGLRenderer + DOM are stubbed), then
   drives frames and exercises Cheats._act() in every campaign phase.
   Timers are virtualized on the sim clock, so fade-cuts complete inside
   synchronous frame marathons exactly like they do in a browser.
   Run: node test_cheats.js
============================================================================ */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ---------------- tiny DOM ---------------- */
function makeCtx2D() {
  const grad = { addColorStop() {} };
  const base = {
    canvas: null,
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createPattern: () => ({}),
    measureText: () => ({ width: 10 }),
    getImageData: () => ({ data: new Uint8ClampedArray(4) }),
    createImageData: () => ({ data: new Uint8ClampedArray(4) }),
  };
  return new Proxy(base, {
    get(t, k) {
      if (k in t) return t[k];
      return () => {};          // every other ctx method = no-op
    },
    set(t, k, v) { t[k] = v; return true; },
  });
}
/* elements with their INITIAL HTML classes so state checks are honest */
const INITIAL_CLASSES = {
  'cheat-panel': ['hidden'],
  'screen-start': [], 'screen-pause': ['hidden'], 'screen-over': ['hidden'],
  'screen-error': ['hidden'], 'screen-upgrade': ['hidden'],
  'hud': ['hidden'], 'fade': [], 'boss-bar': ['hidden'], 'obj-wrap': ['hidden'],
};
function makeEl(tag, initialClasses) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), children: [], style: {}, dataset: {},
    classList: {
      _s: new Set(initialClasses || []),
      add(c) { this._s.add(c); },
      remove(c) { this._s.delete(c); },
      toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); return f; },
      contains(c) { return this._s.has(c); },
    },
    _listeners: {},
    addEventListener(t2, f) { (this._listeners[t2] = this._listeners[t2] || []).push(f); },
    removeEventListener() {},
    dispatchEvent(ev) { ev = ev || {}; ev.target = ev.target || el; ev.preventDefault = ev.preventDefault || (() => {}); (this._listeners[ev.type] || []).forEach((f) => f(ev)); return true; },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    removeChild() {}, remove() {},
    querySelector(sel) { return el._q(sel); },
    querySelectorAll() { return []; },
    _q(sel) {
      // minimal selector answers so Cheats._sync() etc. reach real buttons
      const m = /data-c="([^"]+)"/.exec(sel || '');
      if (m && el._innerHTML && el._innerHTML.indexOf('data-c="' + m[1] + '"') >= 0) {
        if (!el._btns) el._btns = {};
        if (!el._btns[m[1]]) {
          const b = makeEl('button'); b.dataset.c = m[1];
          el._btns[m[1]] = b;
        }
        return el._btns[m[1]];
      }
      return makeEl('div');
    },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 }; },
    get offsetWidth() { return 100; },
    set innerHTML(v) { el._innerHTML = v; el._btns = null; },
    get innerHTML() { return el._innerHTML || ''; },
    set textContent(v) { el._textContent = v; },
    get textContent() { return el._textContent || ''; },
    click() { el.dispatchEvent({ type: 'click' }); },
    focus() {},
    width: tag === 'canvas' ? 440 : 300,
    height: tag === 'canvas' ? 440 : 150,
    getContext() { return makeCtx2D(); },
    requestPointerLock() { return undefined; },
  };
  return el;
}
const elements = new Map();
const documentStub = {
  createElement(tag) { return makeEl(tag); },
  createElementNS(ns, tag) { return makeEl(tag); },
  getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, makeEl(id.endsWith('radar') ? 'canvas' : 'div', INITIAL_CLASSES[id] || []));
    }
    return elements.get(id);
  },
  addEventListener() {}, removeEventListener() {},
  body: makeEl('body'),
  hidden: false,
  pointerLockElement: null,
  exitPointerLock() { this.pointerLockElement = null; },
};

/* ---------------- virtual timers (fire on the sim clock) ---------------- */
let rafQueue = [];
let nowMs = 0;
let timerSeq = 1;
const timers = new Map();   // id -> { at, fn, cleared }
const realSetTimeout = setTimeout;
function tick(n) {
  for (let i = 0; i < n; i++) {
    nowMs += 16.7;
    for (const [id, t] of [...timers]) {
      if (!timers.has(id)) continue;             // cleared while walking
      if (nowMs >= t.at) { timers.delete(id); t.fn(); }
    }
    const q = rafQueue; rafQueue = [];
    for (const f of q) f(nowMs);
  }
}
function setTimeoutV(fn, ms) {
  const id = timerSeq++;
  timers.set(id, { at: nowMs + Math.max(0, ms || 0), fn });
  return id;
}
function clearTimeoutV(id) { timers.delete(id); }

/* ---------------- stub renderer (real GL is unavailable in Node) -------- */
function StubRenderer(opts) {
  this.domElement = makeEl('canvas');
  this.domElement.width = 1280; this.domElement.height = 720;
  this.info = { autoReset: true, reset() {}, render: { calls: 0, triangles: 0 }, memory: {} };
  this.capabilities = { getMaxAnisotropy: () => 8, isWebGL2: false };
  this.shadowMap = {};
}
StubRenderer.prototype.setPixelRatio = function () {};
StubRenderer.prototype.getPixelRatio = function () { return 1; };
StubRenderer.prototype.setSize = function () {};
StubRenderer.prototype.getSize = function (v) { return v.set(1280, 720); };
StubRenderer.prototype.render = function () {};
StubRenderer.prototype.setRenderTarget = function () {};
StubRenderer.prototype.getRenderTarget = function () { return null; };
StubRenderer.prototype.getClearColor = function (t) { return t && t.setRGB ? t.setRGB(0, 0, 0) : t; };
StubRenderer.prototype.getClearAlpha = function () { return 1; };
StubRenderer.prototype.setClearColor = function () {};
StubRenderer.prototype.setClearAlpha = function () {};
StubRenderer.prototype.clear = function () {};
StubRenderer.prototype.dispose = function () {};
StubRenderer.prototype.initTexture = function () {};
StubRenderer.prototype.copyFramebufferToTexture = function () {};

/* ---------------- sandbox ---------------- */
const sandbox = {
  console, performance,
  setTimeout: setTimeoutV, clearTimeout: clearTimeoutV,
  setInterval: setTimeoutV, clearInterval: clearTimeoutV,
  requestAnimationFrame: (f) => { rafQueue.push(f); return rafQueue.length; },
  cancelAnimationFrame: () => {},
  document: documentStub,
  devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 720,
  addEventListener() {}, removeEventListener() {},
  location: { href: 'file:///test' },
};
sandbox.window = sandbox;   // game assigns window.__VL etc.
sandbox.self = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(file) {
  const code = fs.readFileSync(path.join(__dirname, file), 'utf8');
  vm.runInContext(code, sandbox, { filename: file });
}

console.log('— loading vendored three.js r128 —');
load('vendor/three.min.js');
sandbox.THREE.WebGLRenderer = StubRenderer;   // swap the only GL-dependent class
load('vendor/EffectComposer.js');
load('vendor/CopyShader.js');
load('vendor/LuminosityHighPassShader.js');
load('vendor/RenderPass.js');
load('vendor/ShaderPass.js');
load('vendor/UnrealBloomPass.js');

console.log('— loading game scripts —');
load('data.js');
load('engine.js');
load('fx.js');
load('entities.js');
load('game.js');
console.log('boot OK — state:', sandbox.window.__VL.G.game.state);

/* ---------------- helpers ---------------- */
const G = sandbox.window.__VL.G;
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT: ' + msg); console.log('  ✓ ' + msg); };

let failures = 0;
function run(name, fn) {
  try { fn(); console.log('PASS  ' + name); }
  catch (e) { failures++; console.log('FAIL  ' + name + ' — ' + e.message); console.log(e.stack.split('\n').slice(1, 4).join('\n')); }
}

const ALL_ACTIONS = ['god', 'ammo', 'noclip', 'ghost', 'tier', 'oneshot', 'heal', 'killall',
  'slowmo', 'turbo', 'arsenal', 'nuke', 'armageddon', 'wing', 'gauntlet', 'map',
  'q-2', 'q-1', 'q-0', 'upgmenu', 'tp', 'skip',
  'b-dread', 'b-carrier', 'b-fortress', 'b-sing',
  's-vanguard', 's-ally', 's-lancer', 's-hornets',
  's-fighter', 's-gunship', 's-bomber', 's-drone5', 's-mine', 's-turret',
  's-ravager', 's-sentinel', 's-interceptor', 's-hive', 's-elite', 's-interdictor',
  's-boss', 's-bossalt'];

function openConsole() {
  if (!G.cheats.isOpen()) G.cheats.togglePanel();
  // togglePanel pauses the run — that is the real-world context for cheats
}
function act(c) {
  G.cheats._act(c);   // exactly what a button click invokes
  G.cheats._sync();
}
function playMode() {   // console closed + state playing
  if (G.cheats.isOpen()) G.cheats.togglePanel();
  if (G.game.state === 'paused') G.game.resume();
}
function restart() { documentStub.getElementById('btn-restart').click(); }

/* ================= TESTS ================= */

run('boot reaches menu', () => {
  assert(G.game.state === 'menu', 'state is menu');
});

run('adventure run starts in phase 1 (pad defense)', () => {
  documentStub.getElementById('btn-adventure').click();
  assert(G.game.state === 'playing', 'state playing');
  assert(G.campaign.phase === 1, 'campaign.phase === 1');
  tick(120);   // ~2s: first wave spawns at 3s; just let frames run
  assert(G.game.state === 'playing', 'still playing after 2s');
});

run('SKIP WAVE/PHASE from console works in phase 1 (was: dead button + dark screen)', () => {
  openConsole();
  assert(G.game.state === 'paused', 'console pauses the run');
  act('skip');
  assert(G.campaign.transitioning === true, 'phase cut began');
  assert(G.game.state === 'playing', 'run resumed after skip');
  assert(!G.cheats.isOpen(), 'console closed itself for the cut');
  tick(60);   // 460ms swap + 240ms fade-back (virtual timers)
  assert(G.campaign.phase === 2, 'campaign.phase === 2 after cut');
  assert(!G.hud.el.fade.classList.contains('on'), 'fade overlay lifted (no dark screen)');
});

run('SKIP in phase 2 reaches the arena', () => {
  openConsole();
  act('skip');
  playMode();
  tick(60);
  assert(G.campaign.phase === 3, 'campaign.phase === 3 after ascent skip');
  assert(!G.hud.el.fade.classList.contains('on'), 'fade lifted');
  tick(240);  // lull 2.5s expires → wave 1 starts
  assert(G.waves.state === 'active' && G.waves.wave === 1, 'wave 1 running');
});

run('SKIP in arena clears the live wave exactly once', () => {
  tick(300);  // let wave 1 populate
  openConsole();
  act('skip');
  playMode();
  tick(30);
  assert(G.waves.state === 'lull', 'wave completed → lull');
  assert(G.waves._completedWave === G.waves.wave, 'guard recorded this wave');
  assert(G.game.state === 'playing', 'still playing');
  tick(600);  // lull → wave 2
  assert(G.waves.wave === 2, 'advanced to wave 2');
});

run('SKIP with a live boss kills it via core (no crash, single completion)', () => {
  // deterministic setup: clear leftovers from earlier tests first
  // (the action matrix can leave mapMode set — then a boss kill routes to
  // onMapCleared() instead of the endless lull, which is correct game
  // behavior but not what this test asserts)
  for (const e of G.enemies.list) if (e.alive && e.type !== 'boss') { e.alive = false; e.dispose && e.dispose(); }
  G.enemies.list.length = 0;
  G.waves.queue.length = 0;
  G.waves.boss = null;
  G.waves.mapMode = null;
  G.waves.objective = null;
  G.waves.startWave(5);   // endless: wave 5 = boss wave
  tick(30);
  assert(!!G.waves.boss, 'boss spawned');
  openConsole();
  act('skip');
  playMode();
  assert(G.waves.boss && !G.waves.boss.alive, 'boss dead');
  tick(400);  // play the death sequence out
  if (G.waves.state !== 'lull') {
    const alive = G.enemies.list.filter((e) => e.alive && e.waveEnemy)
      .map((e) => e.type + '#' + (e.id || '?') + ' hp=' + (e.hp | 0)).join(', ');
    console.log('  DBG stuck: waveState=' + G.waves.state + ' queue=' + G.waves.queue.length
      + ' aliveWave=[' + alive + ']'
      + ' bossAlive=' + (G.waves.boss && G.waves.boss.alive)
      + ' bossDeathT=' + (G.waves.boss && G.waves.boss.deathT != null ? G.waves.boss.deathT.toFixed(1) : '-')
      + ' finalBoom=' + (G.waves.boss ? !!G.waves.boss._finalBoom : '-')
      + ' obj=' + (G.waves.objective ? G.waves.objective.kind + ':' + G.waves.objective.state : 'none'));
  }
  assert(G.waves.state === 'lull', 'wave completed after boss death');
  assert(G.waves._completedWave === 5, 'single completion (no re-entry)');
});

run('every console action × every phase: no exceptions', () => {
  for (const phase of [1, 2, 3]) {
    sandbox.window.__VL.phase(phase);   // debug jump (no fades)
    openConsole();
    for (const c of ALL_ACTIONS) {
      try { act(c); } catch (e) {
        throw new Error('phase ' + phase + ' action "' + c + '": ' + e.message);
      }
      tick(5);   // let any timers/enemy updates churn
      if (G.game.state === 'over') restart();   // some actions can end a run
      if (G.game.state === 'menu') restart();   // defensive: keep a run alive
    }
    console.log('  phase ' + phase + ': ' + ALL_ACTIONS.length + ' actions OK');
    playMode();
  }
  assert(true, 'all phases survived the full action matrix');
});

run('phase 1 pod defense completes on its own (no infinite pad defense)', () => {
  restart();   // fresh run → phase 1
  assert(G.campaign.phase === 1, 'phase 1');
  tick(60 * 80 + 200);   // past the 75s safety timer, comfortably
  assert(G.campaign.phase !== 1, 'phase advanced past pad defense (got ' + G.campaign.phase + ')');
  assert(!G.hud.el.fade.classList.contains('on'), 'fade lifted');
});

run('phase 1 completes by clearing its two waves (not just the timer)', () => {
  restart();
  // kill every attacker as they spawn, like a player would
  for (let i = 0; i < 60 * 70; i++) {
    tick(1);
    for (const e of G.enemies.list) if (e.alive && e.waveEnemy) { e.alive = false; G.game.onEnemyKilled(e); }
    if (G.campaign.phase !== 1) break;
  }
  assert(G.campaign.phase !== 1, 'phase advanced by clearing waves (got ' + G.campaign.phase + ')');
});

run('fresh restart after cheats leaves no stuck fade/pause', () => {
  openConsole();
  act('skip');
  playMode();
  tick(60);
  restart();
  assert(G.game.state === 'playing' && G.campaign.phase === 1, 'clean restart');
  assert(!G.hud.el.fade.classList.contains('on'), 'fade cleared on restart');
  tick(600);
  assert(G.game.state === 'playing', 'run keeps running normally');
});

console.log('');
console.log(failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED');
process.exit(failures === 0 ? 0 : 1);
