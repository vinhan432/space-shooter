/* ============================================================
   VERIFY_BEHAVIOUR.JS — headless assertion driver (QA)
   Boots the REAL game scripts in Node with minimal DOM stubs and
   asserts the behaviour each pass claims. It has been kept and grown
   with the game: the v1.6 depth systems, the campaign/shop/NG+ layer,
   and the v1.9 systems pass (§4 nemesis, §6 derelict salvage,
   §7 distress calls, §23 run snapshots).  Run: node verify_behaviour.js
============================================================ */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

/* ---------------- minimal DOM ---------------- */
function makeEl(tag, initialClasses) {
  const el = {
    tagName: (tag || 'div').toUpperCase(), children: [], style: {}, dataset: {}, title: '',
    classList: {
      _s: new Set(initialClasses || []),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      toggle(c, f) { if (f === undefined) f = !this._s.has(c); f ? this._s.add(c) : this._s.delete(c); return f; },
      contains(c) { return this._s.has(c); },
    },
    _listeners: {},
    addEventListener(t, f) { (this._listeners[t] = this._listeners[t] || []).push(f); },
    removeEventListener() {},
    dispatchEvent(ev) { ev = ev || {}; ev.target = ev.target || el; ev.preventDefault = ev.preventDefault || (() => {}); (this._listeners[ev.type] || []).forEach((f) => f(ev)); return true; },
    appendChild(c) { el.children.push(c); return c; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); return c; },
    get firstChild() { return el.children[0] || null; },
    querySelector(sel) {
      const m = /data-c="([^"]+)"/.exec(sel || '');
      if (m && el._innerHTML && el._innerHTML.indexOf('data-c="' + m[1] + '"') >= 0) {
        if (!el._btns) el._btns = {};
        if (!el._btns[m[1]]) { const b = makeEl('button'); b.dataset.c = m[1]; el._btns[m[1]] = b; }
        return el._btns[m[1]];
      }
      if (/slot|skill|pip|tagbox|close|thumb|label/.test(sel || '')) return makeEl('div');
      return makeEl('div');
    },
    querySelectorAll() { return []; },
    closest() { return null; },
    getBoundingClientRect() { return { left: 0, top: 100, width: 58, height: 220, right: 58, bottom: 320 }; },
    get offsetWidth() { return 100; },
    set innerHTML(v) { el._innerHTML = v; el._btns = null; if (!v) el.children.length = 0; },
    get innerHTML() { return el._innerHTML || ''; },
    set textContent(v) { el._textContent = v; },
    get textContent() { return el._textContent || ''; },
    click() { el.dispatchEvent({ type: 'click' }); },
    remove() {},
    focus() {},
    toDataURL() { return 'data:image/png;base64,'; },
    width: tag === 'canvas' ? 440 : 300,
    height: tag === 'canvas' ? 440 : 150,
    getContext() {
      const grad = { addColorStop() {} };
      const base = {
        createLinearGradient: () => grad, createRadialGradient: () => grad, createPattern: () => ({}),
        measureText: () => ({ width: 10 }),
        getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w || 1) * (h || 1) * 4)) }),
        createImageData: (w, h) => ({ data: new Uint8ClampedArray(Math.max(4, (w || 1) * (h || 1) * 4)) }),
        putImageData() {},
      };
      return new Proxy(base, { get: (t, k) => (k in t ? t[k] : () => {}), set: (t, k, v) => (t[k] = v, true) });
    },
    requestPointerLock() {},
  };
  return el;
}
const INITIAL_CLASSES = {
  'cheat-panel': ['hidden'], 'screen-start': [], 'screen-pause': ['hidden'], 'screen-over': ['hidden'],
  'screen-error': ['hidden'], 'screen-upgrade': ['hidden'], 'screen-shop': ['hidden'],
  'screen-stats': ['hidden'], 'screen-settings': ['hidden'], 'screen-ending': ['hidden'],
  'hud': ['hidden'], 'fade': [], 'boss-bar': ['hidden'], 'obj-wrap': ['hidden'],
  'touch-thrust': [], 'rotate-gate': [],
};
const elements = new Map();
const cssVars = {};
const documentStub = {
  createElement(tag) { return makeEl(tag); },
  createElementNS(ns, tag) { return makeEl(tag); },
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeEl(id.endsWith('radar') ? 'canvas' : 'div', INITIAL_CLASSES[id] || []));
    return elements.get(id);
  },
  querySelectorAll() { return []; },
  addEventListener() {}, removeEventListener() {},
  documentElement: { style: { setProperty(k, v) { cssVars[k] = v; }, removeProperty() {} } },
  body: makeEl('body'),
  hidden: false, pointerLockElement: null,
  exitPointerLock() { this.pointerLockElement = null; },
};

/* ---------------- stub renderer ---------------- */
function StubRenderer() {
  this.domElement = makeEl('canvas');
  this.domElement.width = 1280; this.domElement.height = 720;
  this.info = { autoReset: true, reset() {}, render: { calls: 0, triangles: 0 }, memory: {} };
  this.capabilities = { getMaxAnisotropy: () => 8, isWebGL2: false };
  this.shadowMap = {};
  this._pixelRatio = 1;
}
StubRenderer.prototype.setPixelRatio = function (v) { this._pixelRatio = v; };
StubRenderer.prototype.getPixelRatio = function () { return this._pixelRatio; };
StubRenderer.prototype.setSize = function () {};
StubRenderer.prototype.getSize = function (v) { return v.set(1280, 720); };
StubRenderer.prototype.render = function () {};
StubRenderer.prototype.setRenderTarget = function () {};
StubRenderer.prototype.getRenderTarget = function () { return null; };
// FIX(harness): real WebGLRenderer.compile() exists in r128; PMREMGenerator
// calls it during buildEnvironment(). Without it the env-map bake throws.
StubRenderer.prototype.compile = function () {};
StubRenderer.prototype.compileEquirectangularShader = function () {};
StubRenderer.prototype.getClearColor = function (t) { return t && t.setRGB ? t.setRGB(0, 0, 0) : t; };
StubRenderer.prototype.getClearAlpha = function () { return 1; };
StubRenderer.prototype.setClearColor = function () {};
StubRenderer.prototype.setClearAlpha = function () {};
StubRenderer.prototype.clear = function () {};
StubRenderer.prototype.dispose = function () {};

/* ---------------- sandbox ---------------- */
const sandbox = {
  console, performance,
  setTimeout, clearTimeout, setInterval, clearInterval,
  requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
  document: documentStub, devicePixelRatio: 1,
  innerWidth: 1280, innerHeight: 720,
  addEventListener() {}, removeEventListener() {},
  location: { href: 'file:///verify' },
};
sandbox.window = sandbox; sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(__dirname, f), 'utf8'), sandbox, { filename: f });

load('vendor/three.min.js');
sandbox.THREE.WebGLRenderer = StubRenderer;
for (const f of ['EffectComposer', 'CopyShader', 'LuminosityHighPassShader', 'RenderPass', 'ShaderPass', 'UnrealBloomPass']) load('vendor/' + f + '.js');
for (const f of ['data.js', 'engine.js', 'fx.js', 'entities.js', 'game.js']) load(f);

const { G, CFG, U } = sandbox.window.__VL;
const GAME = G.game;

let pass = 0, fail = 0;
const check = (name, fn) => {
  try { const msg = fn(); pass++; console.log('  ok  ' + name + (msg ? ' — ' + msg : '')); }
  catch (e) { fail++; console.log('  FAIL ' + name + ' — ' + e.message); }
};
const assert = (c, m) => { if (!c) throw new Error(m); };
const near = (a, b, eps, m) => assert(Math.abs(a - b) <= eps, m + ' (got ' + a + ', want ~' + b + ')');

console.log('boot:', GAME.state);
const Vec3 = G.camera.position.constructor;

/* ---- modifiers: the toggle must change actual gameplay ---- */
console.log('\n— modifiers —');
check('G.modOn reflects the toggle list', () => {
  assert(G.modOn('noShieldRegen') === false, 'defaults off');
  CFG.settings.modifiers.push('noShieldRegen');
  assert(G.modOn('noShieldRegen') === true, 'on after push');
  return 'off → on';
});
check('NO SHIELD REGEN actually stops regeneration', () => {
  const p = G.player;
  CFG.settings.difficulty = 'normal';
  GAME.startRun('endless');
  G.campaign._startPhase3();
  p.lastDamageT = 99; p.shield = 10;
  p.update(1.0);
  const withMod = p.shield;
  assert(withMod <= 10.01, 'shield grew while modifier active');
  CFG.settings.modifiers = CFG.settings.modifiers.filter((k) => k !== 'noShieldRegen');
  p.update(1.0);
  assert(p.shield > withMod + 5, 'shield did not regen after removing the modifier');
  return 'held at ' + withMod.toFixed(1) + ' → ' + p.shield.toFixed(1);
});
check('DEAD RADAR path runs without throwing', () => {
  CFG.settings.modifiers.push('noRadar');
  G.hud._drawRadar();
  CFG.settings.modifiers = [];
  return 'scope drawn';
});

/* ---- difficulty: must reach real spawns and the score ---- */
console.log('\n— difficulty —');
check('HARD spawns tougher enemies and scores harder', () => {
  G.enemies.clear();
  CFG.settings.difficulty = 'normal';
  const n = G.enemies.spawnFighter({});
  const s0 = GAME.score; GAME.combo = 1; GAME.addScore(100, null, ''); const gainN = GAME.score - s0;
  G.enemies.clear();
  CFG.settings.difficulty = 'hard';
  const h = G.enemies.spawnFighter({});
  const s1 = GAME.score; GAME.addScore(100, null, ''); const gainH = GAME.score - s1;
  assert(h.maxHp > n.maxHp, 'hard fighter HP ' + h.maxHp + ' not > normal ' + n.maxHp);
  near(h.maxHp / n.maxHp, 1.25, 0.02, 'hard HP ratio');
  assert(h.leadSkill > n.leadSkill, 'hard leadSkill not raised');
  near(gainH / gainN, 1.5, 0.01, 'hard score mult');
  G.enemies.clear(); CFG.settings.difficulty = 'normal';
  return 'HP x' + (h.maxHp / n.maxHp).toFixed(2) + ', lead ' + n.leadSkill.toFixed(2) + '→' + h.leadSkill.toFixed(2) + ', score x' + (gainH / gainN).toFixed(2);
});

/* ---- chassis pick survives startRun ---- */
console.log('\n— chassis —');
check('picked chassis survives startRun and changes stats', () => {
  GAME.shipSel = 'interceptor';
  GAME.startRun('endless');
  assert(G.player.chassisKey === 'interceptor', 'chassis was reset to ' + G.player.chassisKey);
  const interceptorHull = G.player.maxHull;
  GAME.shipSel = 'heavy';
  GAME.startRun('endless');
  assert(G.player.chassisKey === 'heavy', 'second pick lost');
  assert(G.player.maxHull > interceptorHull, 'heavy hull not > interceptor');
  return 'interceptor ' + interceptorHull.toFixed(0) + ' → heavy ' + G.player.maxHull.toFixed(0);
});

/* ---- phase 1: drain path with an attacker that never ran onEnemyKilled ---- */
console.log('\n— phase 1 scheduler —');
check('wave drains even when attackers never run onEnemyKilled', () => {
  GAME.startRun('adventure');
  const s = G.campaign._p1;
  for (let i = 0; i < 400 && s.spawnedThisWave === 0; i++) GAME.update(1 / 60);
  const total = s.def.fighters + (s.def.gunships || 0) + (s.def.turrets || 0);
  assert(s.spawnedThisWave >= total, 'launch latch not armed (' + s.spawnedThisWave + '/' + total + ')');
  // empty the field WITHOUT the kill pipeline (the hang scenario)
  for (const e of G.enemies.list) e.alive = false;
  const waveBefore = s.waveIdx;
  for (let i = 0; i < 400 && s.waveIdx === waveBefore; i++) GAME.update(1 / 60);
  assert(s.waveIdx > waveBefore, 'wave never advanced after the field emptied');
  return 'wave ' + waveBefore + ' → ' + s.waveIdx;
});

/* ---- pool reuse ---- */
console.log('\n— pooled projectiles —');
check('a reused pool slot is fully re-initialised', () => {
  const pool = G.projectiles.pools.vmine;
  G.projectiles.reset();
  const first = G.projectiles.fire('vmine', 'player', new Vec3(0, 0, -50), new Vec3(0, 0, -1), { speed: 10, dmg: 1, life: 5 });
  first.age = 9; first.target = first; first.turn = 3; first.knock = 99;
  first.active = false;                       // hand the slot back
  const again = G.projectiles.fire('vmine', 'player', new Vec3(0, 0, -60), new Vec3(0, 0, -1), { speed: 10, dmg: 1, life: 5 });
  assert(pool.items.includes(again), 'allocator returned a foreign item');
  assert(again.age === 0, 'stale tumble age ' + again.age);
  assert(again.target === null && again.turn === 0 && again.knock === 0, 'stale target/turn/knock');
  assert(again.life === 5, 'stale life ' + again.life);
  again.active = false;
  return 'age/target/turn/knock cleared';
});
check('deploying a mine counts as a shot', () => {
  const p = G.player, before = p.shotsFired;
  p.weapon = 8; p.fireT = 0;
  p._fireVoidMine();
  assert(p.shotsFired === before + 1, 'shotsFired unchanged');
  return before + ' → ' + p.shotsFired;
});

/* ---- ghost mode ---- */
console.log('\n— cheat: ghost immunity —');
check('ghost mode blocks damage; turning it off restores it', () => {
  const p = G.player;
  G.campaign._startPhase3();   // phase 1 routes damage to the pod, not the ship
  G.cheats.ghost = true;
  p.spawnGuard = 0; p.shield = 0; p.hull = 100;
  p.damage(50, p.pos);
  assert(p.hull === 100, 'ghost took damage (' + p.hull + ')');
  G.cheats.ghost = false;
  p.damage(50, p.pos);
  assert(p.hull === 50, 'damage did not land after ghost off (' + p.hull + ')');
  return '100 → 100 → 50';
});

/* ---- shard convergence math ---- */
console.log('\n— weapon aim —');
check('shard pellets converge on the crosshair ray', () => {
  G.enemies.clear();
  const p = G.player;
  G.campaign._startPhase3();
  p.unlockWeapon(7);          // progression ladder: force the slot online
  p.setWeapon(7); p.fireT = 0;
  G.input.cursor.x = 140; G.input.cursor.y = -90;
  G.input.btn[0] = true; G.input.btnJust[0] = true;
  p.update(0.016);
  G.input.btn[0] = false;
  const pellets = G.projectiles.pools.shard.items.filter((x) => x.active);
  assert(pellets.length > 0, 'no pellets fired');
  const aim = new Vec3(); p.getAimDir(aim);
  const target = aim.multiplyScalar(CFG.weapons.convergeDist).add(G.camera.position);
  // pellets are a deliberate spread around the ray, so they must land inside
  // the weapon's own spread cone (cos 0.09 ≈ 0.996) — the centre pellet exact
  let worst = 1, center = 1;
  pellets.sort((a, b) => a.i - b.i);
  pellets.forEach((it, idx) => {
    const toTarget = target.clone().sub(it.pos).normalize();
    const dot = toTarget.dot(it.vel.clone().normalize());
    worst = Math.min(worst, dot);
    if (idx === 0) center = dot;
  });
  assert(center > 0.9999, 'centre pellet off the ray (' + center.toFixed(5) + ')');
  assert(worst > Math.cos(CFG.weapons.shard.spread), 'pellet outside the spread cone (' + worst.toFixed(4) + ')');
  return 'centre ' + center.toFixed(5) + ', spread cone worst ' + worst.toFixed(4);
});

/* ---- touch throttle drives the flight model ---- */
console.log('\n— touch thrust —');
check('throttle produces thrust; keyboard overrides it', () => {
  const p = G.player;
  const run = (throttle, keys) => {
    G.campaign._startPhase3();
    p.vel.set(0, 0, 0); p.quat.identity();
    for (const k in p.keysHeld) delete p.keysHeld;
    G.input.touch = true;
    G.input.touchThrottle = throttle;
    for (const k of keys) G.input.keys[k] = true;
    p.update(0.5);
    const fwdZ = p.vel.clone().normalize().z;
    const boosted = p.boosting;
    for (const k of keys) G.input.keys[k] = false;
    G.input.touch = false; G.input.touchThrottle = 0;
    return { fwdZ, boosted };
  };
  const fwd = run(1.0, []);
  assert(fwd.fwdZ < -0.5, 'full throttle did not push the nose forward (z ' + fwd.fwdZ.toFixed(2) + ')');
  assert(fwd.boosted, 'full throttle did not engage the afterburner');
  const back = run(-1.0, []);
  assert(back.fwdZ > 0.5, 'brake did not reverse (z ' + back.fwdZ.toFixed(2) + ')');
  const override = run(-1.0, ['KeyW']);
  assert(override.fwdZ < -0.5, 'keyboard did not override the slider (z ' + override.fwdZ.toFixed(2) + ')');
  return 'fwd ' + fwd.fwdZ.toFixed(2) + ' / brake ' + back.fwdZ.toFixed(2) + ' / W-override ' + override.fwdZ.toFixed(2);
});

/* ---- fluid HUD scale ---- */
console.log('\n— HUD scale —');
check('--hs is written and shrinks on narrow viewports', () => {
  G.input.touch = false;
  sandbox.window.innerWidth = 1280;
  G.hud.applyHudScale();
  const wide = parseFloat(cssVars['--hs']);
  sandbox.window.innerWidth = 500;
  G.hud.applyHudScale();
  const narrow = parseFloat(cssVars['--hs']);
  assert(wide === 1, 'desktop scale should be 1, got ' + wide);
  assert(narrow < wide, 'scale did not shrink (' + narrow + ')');
  assert(narrow >= CFG.hud.minScale, 'scale below the configured floor');
  sandbox.window.innerWidth = 1280;
  G.hud.applyHudScale();
  G.input.touch = false;
  return '1280px → ' + wide + ', 500px → ' + narrow;
});

/* ---- victory routing ---- */
console.log('\n— ending screen —');
check('victory shows the ending screen with stats', () => {
  GAME._victory = true;
  GAME.state = 'playing';
  GAME.score = 4321; GAME.kills = 7; GAME.maxCombo = 3.5; GAME.elapsed = 125;
  G.hud.showGameOver();
  assert(!G.hud.el.screens.ending.classList.contains('hidden'), 'ending screen stayed hidden');
  assert(G.hud.el.screens.over.classList.contains('hidden'), 'game-over screen also shown');
  assert(/4,321/.test(G.hud.el.endingStats.innerHTML), 'stats not filled: ' + G.hud.el.endingStats.innerHTML.slice(0, 40));
  GAME._victory = false;
  return 'ending shown, score rendered';
});

/* ---- boost burnout (v1.6 review: meter never emptied / burner flapped) ---- */
console.log('\n— boost burnout —');
check('a full burnout empties the meter and locks the burner until rearm', () => {
  const p = G.player, C = CFG.combat;
  G.enemies.clear();
  G.campaign._startPhase3();
  for (const k in G.input.keys) G.input.keys[k] = false;
  G.input.touch = false;
  p.vel.set(0, 0, 0); p.quat.identity();
  p.boostE = 20; p.boostLock = false;
  G.input.keys['KeyW'] = true; G.input.keys['ShiftLeft'] = true;
  p.update(1 / 60);
  assert(p.boosting, 'burner did not engage at 20 energy');
  let minE = 99, cutSeen = false;
  for (let i = 0; i < 240; i++) {
    p.update(1 / 60);
    minE = Math.min(minE, p.boostE);
    if (!p.boosting) cutSeen = true;
  }
  assert(minE <= 0.001, 'meter never reached empty (min ' + minE.toFixed(2) + ')');
  assert(cutSeen, 'burner never cut out');
  assert(p.boostLock, 'burner was not locked after a full burnout');
  let rearm = -1;
  for (let i = 0; i < 600 && rearm < 0; i++) {
    p.update(1 / 60);
    assert(p.boostE < C.boostRearm + 1.5 || p.boosting, 'locked burner re-engaged below rearm');
    if (p.boosting) rearm = p.boostE;
  }
  G.input.keys['KeyW'] = false; G.input.keys['ShiftLeft'] = false;
  assert(rearm >= C.boostRearm - 1.5, 're-engaged at ' + rearm.toFixed(1) + ' (below rearm ' + C.boostRearm + ')');
  return 'drained to empty, locked, re-armed at ' + rearm.toFixed(1);
});

/* ---- steering assist ---- */
console.log('\n— steering assist —');
check('idle mouse bleeds fine aim to center; hard turns keep authority', () => {
  const inp = G.input;
  CFG.settings.steerAssist = true; inp.touch = false; inp.gpActive = false;
  inp.aimT = -1e6;                       // long idle
  inp.cursor.x = 60; inp.cursor.y = 0;
  inp.aimAssist(1 / 60);
  const settled = Math.abs(inp.cursor.x);
  assert(settled < 60, 'cursor did not bleed while idle (still ' + settled.toFixed(1) + ')');
  inp.cursor.x = 200;                    // outside the fine-aim band
  inp.aimAssist(1 / 60);
  assert(Math.abs(inp.cursor.x - 200) < 1e-6, 'assist grabbed a deliberate hard turn');
  inp.cursor.x = 60;
  inp.aimT = performance.now();          // mouse live again
  inp.aimAssist(1 / 60);
  assert(Math.abs(inp.cursor.x - 60) < 1e-6, 'assist ran while the mouse was moving');
  CFG.settings.steerAssist = false; inp.aimT = -1e6;
  inp.aimAssist(1 / 60);
  assert(Math.abs(inp.cursor.x - 60) < 1e-6, 'assist ran while switched off');
  CFG.settings.steerAssist = true;
  inp.cursor.x = 0; inp.cursor.y = 0;
  return '60px → ' + settled.toFixed(1) + 'px in one frame';
});

/* ---- flight model ---- */
console.log('\n— flight model —');
check('INERTIAL keeps momentum that ARCADE bleeds off', () => {
  const p = G.player;
  G.enemies.clear();
  G.campaign._startPhase3();
  for (const k in G.input.keys) G.input.keys[k] = false;
  const coast = (model) => {
    CFG.settings.flightModel = model;
    p.vel.set(0, 0, -100); p.quat.identity(); p.angVel.set(0, 0, 0);
    p.boostE = CFG.combat.boostEnergy; p.boostLock = false;
    for (let i = 0; i < 60; i++) p.update(1 / 60);
    return Math.abs(p.vel.z);
  };
  const arc = coast('arcade'), inert = coast('inertial');
  CFG.settings.flightModel = 'arcade';
  assert(arc < 62, 'arcade coast still fast: ' + arc.toFixed(1));
  assert(inert > 88, 'inertial coast bled too much: ' + inert.toFixed(1));
  return 'after 1s: arcade ' + arc.toFixed(1) + ' u/s vs inertial ' + inert.toFixed(1) + ' u/s';
});

/* ---- shields ---- */
console.log('\n— shields —');
check('regen waits out the configured delay', () => {
  const p = G.player, C = CFG.combat;
  G.enemies.clear();
  G.campaign._startPhase3();
  CFG.settings.modifiers = [];           // no NO-SHIELD-REGEN
  p.shield = 0; p.lastDamageT = 0;
  p.update(C.shieldDelay - 0.5);
  assert(p.shield === 0, 'regen started before the delay (' + p.shield.toFixed(1) + ')');
  p.update(1.0);
  assert(p.shield > 0, 'shield never regenerated after the delay');
  return 'held through ' + C.shieldDelay + 's, +' + p.shield.toFixed(1) + ' after';
});

/* ---- collision damage ---- */
console.log('\n— collision damage —');
check('rock impacts scale with speed and clamp at the cap', () => {
  const p = G.player, C = CFG.combat;
  G.campaign._startPhase3();
  const fake = { nx: 0, ny: 0, nz: 1, depth: 0.2 };
  const real = G.world.asteroids.querySphere;
  G.world.asteroids.querySphere = () => fake;
  const hit = (speed) => {
    p.hull = 100; p.shield = 0; p.spawnGuard = 0; p.alive = true; p.contactCd = 0;
    p.vel.set(0, 0, -speed);             // vn = -speed → impact
    p._resolveCollisions(0.016);
    return 100 - p.hull;
  };
  const soft = hit(10), mid = hit(40), hard = hit(300);
  G.world.asteroids.querySphere = real;
  p.hull = p.maxHull; p.shield = p.maxShield;
  assert(soft === 0, 'a 10 u/s scrape cost ' + soft.toFixed(1) + ' hull');
  near(mid, (40 - C.contactImpactMin) * C.contactDmgFactor, 0.01, 'mid impact damage');
  near(hard, C.contactDmgMax, 0.01, 'hard impact should clamp to the cap');
  return 'scrape 0 · 40u/s ' + mid.toFixed(1) + ' · 300u/s ' + hard.toFixed(0);
});

/* ---- weapon progression ---- */
console.log('\n— weapon progression —');
check('adventure starts with the core pair and unlocks one per sector', () => {
  const p = G.player;
  GAME.startRun('endless');
  assert(p.weaponUnlocked(0) && p.weaponUnlocked(8), 'endless should fly the full battery');
  GAME.startRun('adventure');
  assert(p.weaponUnlocked(0) && p.weaponUnlocked(2), 'adventure start pair wrong: ' + p.unlockedWeapons.join(','));
  assert(!p.weaponUnlocked(1) && !p.weaponUnlocked(7), 'adventure leaked late weapons');
  const w0 = p.weapon;
  p.setWeapon(7);
  assert(p.weapon === w0, 'a locked weapon became selectable');
  G.campaign._startMap(0);
  assert(p.weaponUnlocked(1), 'sector 1 did not unlock its ladder step');
  assert(!p.weaponUnlocked(3), 'the ladder skipped ahead');
  p.setWeapon(1);
  assert(p.weapon === 1, 'newly unlocked weapon not selectable');
  return 'core [1,3] → +[2] at sector 1, locked slots refused';
});

/* ---- mission briefing ---- */
console.log('\n— mission briefing —');
check('phase 1 shows the launchpad briefing and can be dismissed', () => {
  GAME.startRun('adventure');
  assert(G.hud.briefingVisible(), 'briefing not visible at run start');
  assert(/LAUNCHPAD/.test(G.hud.el.briefingHead.textContent), 'wrong title: ' + G.hud.el.briefingHead.textContent);
  assert(/lift off/.test(G.hud.el.briefingBody.innerHTML), 'briefing body missing the why');
  G.hud.hideBriefing();
  assert(!G.hud.briefingVisible() && G.hud.el.briefing.classList.contains('hidden'), 'briefing did not hide');
  return 'shown with mission text, hidden on dismissal';
});

/* ---- target-lead pip ---- */
console.log('\n— target-lead pip —');
check('lead pip shows for a crossing target and hides up close', () => {
  G.enemies.clear();
  G.campaign._startPhase3();
  const e = G.enemies.spawnFighter({});
  e.pos.set(0, 0, -400); e.vel.set(60, 0, 0);
  G.camera.position.set(0, 0, 0);
  G.camera.lookAt(0, 0, -400);
  G.camera.updateMatrixWorld(true);
  G.player.weapon = 0;
  G.hud._updateLeadMarker(e);
  const shown = G.hud.el.leadMarker.style.display === 'block';
  e.pos.set(0, 0, -80);
  G.hud._updateLeadMarker(e);
  const hidden = G.hud.el.leadMarker.style.display === 'none';
  G.enemies.clear();
  assert(shown, 'pip hidden for a moving far target');
  assert(hidden, 'pip still shown at point-blank');
  return 'far crossing target → pip, 80u → hidden';
});

/* ---- photo mode ---- */
console.log('\n— photo mode —');
check('photo mode freezes the sim, drives its own camera, and exits cleanly', () => {
  G.enemies.clear();
  GAME.startRun('endless');
  G.campaign._startPhase3();
  GAME.pause();
  G.photo.enter();
  assert(GAME.state === 'photo', 'state not photo (' + GAME.state + ')');
  assert(!G.hud.el.photoUi.classList.contains('hidden'), 'photo chrome hidden');
  assert(G.hud.el.hud.classList.contains('hidden'), 'HUD still up');
  G.photo.dist = 40; G.photo.yaw += 0.8;
  G.photo.update(0.5);
  const camDist = G.camera.position.distanceTo(G.photo.focus);
  assert(camDist > 5, 'camera did not orbit out (' + camDist.toFixed(1) + ')');
  G.photo.shot();
  assert(G.photo._shotReq === true, 'shot not queued');
  G.photo._capture();
  assert(G.photo._shotReq === false, 'capture did not clear the request');
  G.photo.toggleHud();
  assert(!G.hud.el.hud.classList.contains('hidden'), 'HUD toggle did not show the HUD');
  G.photo.exit();
  assert(GAME.state === 'paused', 'exit did not return to paused');
  assert(!G.hud.el.screens.pause.classList.contains('hidden'), 'pause screen not restored');
  return 'enter → orbit ' + camDist.toFixed(0) + 'u → shot → exit';
});

/* ---- v1.6 stub systems: radio / tutorial / pilot record / hangar ---- */
const { Radio, Tutorial, Pilot, Meta } = sandbox.window.__VL;
const D = sandbox.document;   // harness scope has no `document`; the stub does
console.log('\n— radio chatter —');
check('radio prints throttled lines and caps the log', () => {
  Radio.clear();
  const el = D.getElementById('radio-log');
  const a = Radio.say('waveStart', { cd: 5 });
  const b = Radio.say('waveStart', { cd: 5 });          // throttled
  assert(a === true, 'first line refused');
  assert(b === false, 'second line was not throttled');
  for (let i = 0; i < 6; i++) Radio.say('lowHealth', { cd: 0 });
  assert(el.children.length <= Radio.max, 'log grew past its cap (' + el.children.length + ')');
  Radio.line('tutorial', 0);
  const last = el.children[el.children.length - 1];
  assert(/CONTROL:/.test(last.textContent), 'specific line not shown: ' + last.textContent);
  assert(last.className.indexOf('radio-line') >= 0, 'line missing its class');
  Radio.clear();
  assert(el.children.length === 0, 'clear left lines behind');
  return 'throttled, capped at ' + Radio.max + ', scripted lines work';
});

console.log('\n— tutorial beats —');
check('tutorial advances on action, on timeout, and remembers being done', () => {
  // the harness has no localStorage: install a memory stub for persistence
  const store = {};
  sandbox.localStorage = {
    getItem: (k) => (k in store ? store[k] : null),
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  sandbox.window.localStorage = sandbox.localStorage;
  GAME.startRun('endless');
  G.campaign._startPhase3();
  Tutorial.stop();
  Tutorial.begin();
  assert(Tutorial.active, 'tutorial did not start on a first run');
  const el = D.getElementById('tutorial-prompt');
  assert(/TEST FIRE/.test(el.innerHTML) && /SKIP/.test(el.innerHTML), 'prompt text missing: ' + el.innerHTML.slice(0, 60));
  // step 1 completes when you actually shoot
  G.player.shotsFired = 1;
  Tutorial.update(0.1);
  assert(/AFTERBURN/.test(el.innerHTML), 'did not advance on the fired flag: ' + el.innerHTML.slice(0, 40));
  // step 2 times out on its own (no burner used)
  G.player.boosting = false; G.player.boostE = CFG.combat.boostEnergy;
  Tutorial.update(CFG.tutorial.steps[1].time + 0.1);
  assert(/COCKPIT/.test(el.innerHTML), 'timeout did not advance the beat');
  // skip writes the flag and latches
  Tutorial.skip();
  assert(!Tutorial.active && store['voidlancer_tutorial'] === '1', 'skip did not persist');
  Tutorial.begin();
  assert(!Tutorial.active, 'tutorial restarted after being seen');
  Tutorial.stop();
  return 'fired → afterburn → cockpit → skip latched';
});

console.log('\n— pilot record —');
check('finished runs fold into the record and render the grid', () => {
  Pilot.data = null;
  GAME.startRun('endless');
  GAME.kills = 7; GAME.score = 4321; GAME.elapsed = 91;
  GAME._victory = false; GAME._bossKills = 1; GAME.bestMap = 3; GAME.maxCombo = 2.5;
  G.player.shotsFired = 100; G.player.shotsHit = 41;
  const before = Pilot.load().runs;
  GAME.gameOver();
  const d = Pilot.load();
  assert(d.runs === before + 1, 'run not counted');
  assert(d.kills >= 7 && d.bosses >= 1, 'kills/bosses not folded in');
  assert(d.deaths === 1, 'loss not recorded');
  assert(d.bestScore >= 4321, 'best score not tracked');
  assert(d.bestMap >= 3, 'best sector not tracked');
  Pilot.render();
  const grid = D.getElementById('stats-grid');
  assert(/ACCURACY/.test(grid.innerHTML), 'grid not rendered');
  assert(/41%/.test(grid.innerHTML), 'accuracy row wrong: ' + grid.innerHTML.slice(0, 120));
  assert(/CAPITALS DOWNED/.test(grid.innerHTML), 'boss row missing');
  return 'runs +1 · 41% accuracy row rendered';
});

console.log('\n— hangar shop + liveries —');
check('credits bank from endless only; perks apply; liveries repaint the hull', () => {
  Meta.data = null; Pilot.data = null;
  Meta.load();
  GAME.startRun('endless');
  const c0 = Meta.load().credits;
  const fake = () => ({ type: 'fighter', size: 2, radius: 2, pos: G.player.pos, scoreVal: 10, dropChance: 0 });
  for (let i = 0; i < 5; i++) GAME.onEnemyKilled(fake());
  const afterKills = Meta.load().credits;
  assert(afterKills > c0, 'endless kills did not bank credits');
  GAME.mode = 'adventure';
  GAME.onEnemyKilled(fake());
  assert(Meta.load().credits === afterKills, 'adventure banked credits despite endlessOnly');
  GAME.mode = 'endless';
  // perk purchase → applies to the next adventure run
  Meta.data.credits = 1000;
  assert(Meta.buyPerk('perk_hull') === true, 'perk purchase failed');
  assert(Meta.activePerks && Meta.activePerks.hullBonus === 25, 'perk apply block wrong');
  GAME.startRun('adventure');
  const expectHull = CFG.combat.hull * CFG.chassis[GAME.shipSel].hull + 25;
  near(G.player.maxHull, expectHull, 0.5, 'hull perk not applied to the run');
  // livery purchase paints the hull's base tier
  Meta.data.credits = 1000;
  assert(Meta.buyLivery('liv_ember') === true, 'livery purchase failed');
  const lv = Meta.liveryColors();
  assert(lv.id === 'liv_ember', 'livery not equipped after purchase');
  let painted = false;
  G.player.group.traverse((o) => { if (o.material && o.material.color && o.material.color.getHex() === lv.base) painted = true; });
  assert(painted, 'hull was not repainted with the livery base colour');
  Meta.renderShop();
  const shop = D.getElementById('shop-liveries');
  assert(/data-livery="liv_ember"/.test(shop.innerHTML) && /equipped/.test(shop.innerHTML), 'shop did not render the equipped livery');
  return 'credits endless-only · perk +25 hull · hull painted #' + lv.base.toString(16);
});

console.log('\n— new game+ —');
check('NG+ scales enemy hp, boss hp and score once armed', () => {
  CFG.settings.difficulty = 'normal';
  Pilot.load().wins = 1;
  GAME.ngPlus = false;
  const off = GAME.spawnHpMult(1);
  Meta.toggleNgPlus();
  assert(Meta.load().ngplus === true, 'NG+ did not arm');
  GAME.ngPlus = true;
  near(GAME.spawnHpMult(1) / off, CFG.ngplus.hpMult, 0.001, 'NG+ hp multiplier');
  near(GAME.ngMult().bossHpMult, CFG.ngplus.bossHpMult, 0.001, 'NG+ boss multiplier');
  GAME.combo = 1;
  const s0 = GAME.score;
  GAME.addScore(100, null, '');
  const gained = GAME.score - s0;
  near(gained, Math.round(100 * CFG.ngplus.scoreMult) / 1, 2, 'NG+ score multiplier (got ' + gained + ')');
  Meta.toggleNgPlus();
  GAME.ngPlus = false;
  return 'hp x' + CFG.ngplus.hpMult + ' · boss x' + CFG.ngplus.bossHpMult + ' · score x' + CFG.ngplus.scoreMult;
});

console.log('\n— elite identity + sector comms —');
check('elite prize ships carry a callsign and tag their modifier', () => {
  GAME.startRun('endless');
  G.campaign._startPhase3();
  G.enemies.clear();
  const e = G.enemies.spawnGunship({ elite: true, hpMult: 3 });
  assert(!!e.callsign, 'elite has no callsign');
  assert(!!e.eliteMod, 'elite has no modifier tag');
  G.player.lockTarget = e; G.player.lockT = 99; G.player.locked = true;
  G.hud.update(0.016);
  const tag = D.getElementById('target-tag');
  assert(tag.textContent.indexOf(e.callsign) === 0, 'tag did not name the target: ' + tag.textContent);
  assert(tag.style.display === 'block', 'tag stayed hidden on an elite lock');
  assert(tag.className === 'elite', 'tag missing its elite class');
  G.player.lockTarget = null; G.player.locked = false;
  G.hud.update(0.016);
  assert(tag.style.display === 'none', 'tag lingered with no target');
  G.enemies.clear();
  return e.callsign + ' — ' + e.eliteMod;
});

check('entering a sector posts its comms line', () => {
  Radio.clear();
  GAME.startRun('adventure');
  G.campaign._startMap(1);
  const el = D.getElementById('radio-log');
  const last = el.children[el.children.length - 1];
  assert(last && /COMMS \/\/ GLACIUS/.test(last.textContent), 'map story not posted: ' + (last && last.textContent.slice(0, 40)));
  Radio.clear();
  return 'sector story posted to comms';
});

/* ============================================================
   v1.9 — the four §systems that shipped as data + DOM with no code
   behind them (wrecks / distress / nemesis / run snapshot), the
   modifier score multipliers, and the pause-menu RESUME button.
   The localStorage stub installed by the tutorial check above is in
   scope (and shared) from here on.
============================================================ */
const { Nemesis, Wrecks, Snapshot } = sandbox.window.__VL;
const V3 = sandbox.THREE.Vector3;
/* fast path into a live arena (phase 3) with a clean field */
const arena = (mode) => {
  CFG.settings.difficulty = 'normal';
  CFG.settings.modifiers = [];
  GAME.startRun(mode || 'endless');
  G.campaign._startPhase3();
  G.enemies.clear();
  return G.player;
};
const holdFor = (secs) => { for (let t = 0; t < secs; t += 1 / 60) GAME.update(1 / 60); };
/* The game runs inside the vm context, so its Math is the CONTEXT's
   intrinsic — not a property of `sandbox`. Force a value from out here. */
const withRandom = (v, fn) => {
  vm.runInContext('__realRandom = Math.random; Math.random = () => ' + v + ';', sandbox);
  try { return fn(); } finally { vm.runInContext('Math.random = __realRandom;', sandbox); }
};

console.log('\n— §6 derelict salvage —');
check('a derelict arms the salvage prompt and a full hold strips it', () => {
  arena();
  const h = G.world.hulks[0];
  assert(h && h.salvaged === false && h.beacon, 'derelict missing its salvage state/beacon');
  const p = G.player;
  p.pos.copy(h.group.position);
  G.wrecks.update(1 / 60);
  assert(G.wrecks.idx === 0, 'derelict not armed in range');
  assert(Wrecks.el.style.display === 'block', 'prompt not shown');
  const score0 = GAME.score;
  G.input.keys[CFG.wrecks.key] = true;
  holdFor(CFG.wrecks.holdTime * 0.6);
  assert(h.salvaged === false, 'salvage resolved before the hold finished');
  const mid = parseFloat(Wrecks.fill.style.width);
  assert(mid > 20 && mid < 100, 'hold meter not tracking (' + mid + '%)');
  holdFor(CFG.wrecks.holdTime * 0.5);
  G.input.keys[CFG.wrecks.key] = false;
  assert(h.salvaged === true, 'hold never resolved the salvage');
  assert(h.beacon.visible === false, 'beacon stayed lit after salvage');
  assert(GAME.score - score0 >= CFG.wrecks.scoreBonus, 'salvage bounty missing');
  assert(Wrecks.el.style.display === 'none', 'prompt lingered after salvage');
  p.pos.set(9000, 0, 0);
  return 'hold ' + CFG.wrecks.holdTime + 's → +' + (GAME.score - score0);
});
check('releasing or leaving mid-hold cancels it, and a rigged hull springs a trap', () => {
  arena();
  const h = G.world.hulks[1];
  const p = G.player;
  p.pos.copy(h.group.position);
  G.input.keys[CFG.wrecks.key] = true;
  holdFor(CFG.wrecks.holdTime * 0.5);
  assert(G.wrecks.hold > 0.5, 'hold did not accumulate');
  G.input.keys[CFG.wrecks.key] = false;
  holdFor(0.8);
  assert(G.wrecks.hold === 0 && h.salvaged === false, 'released hold still salvaged the wreck');
  p.pos.set(9000, 0, 0);
  G.wrecks.update(1 / 60);
  assert(G.wrecks.el.style.display === 'none', 'prompt survived leaving range');
  // rigged hull: force the hazard band and confirm the trap + the survivor
  arena();
  const rig = G.world.hulks[2];
  G.player.pos.copy(rig.group.position);
  G.input.keys[CFG.wrecks.key] = true;
  withRandom(0.001, () => holdFor(CFG.wrecks.holdTime * 1.2));   // force the hazard band
  G.input.keys[CFG.wrecks.key] = false;
  const mines = G.enemies.list.filter((e) => e.type === 'mine' && e.alive).length;
  assert(mines >= 2, 'trap spawned no ordnance');
  assert(rig.salvaged === false && rig.beacon.visible !== false, 'the trap consumed the wreck');
  G.enemies.clear();
  return 'cancelled mid-hold · trap: ' + mines + ' mines, wreck intact';
});
check('salvage is per-run and the scope draws the derelict blips', () => {
  arena();
  for (const h of G.world.hulks) { h.salvaged = true; h.beacon.visible = false; }
  G.wrecks.reset();
  for (const h of G.world.hulks) assert(h.salvaged === false && h.beacon.visible, 'reset left a derelict consumed');
  G.hud._drawRadar();
  for (const h of G.world.hulks) h.salvaged = true;
  G.hud._drawRadar();
  for (const h of G.world.hulks) h.salvaged = false;
  return 'reset re-opens all ' + G.world.hulks.length + ' · scope drawn both ways';
});

console.log('\n— §7 distress call —');
check('a distress call spawns a pod, hunters and its own clock, and owns the HUD line', () => {
  arena();
  withRandom(0.0, () => G.waves.startWave(3));   // force the roll + deterministic spawns
  assert(G.waves.pod && G.waves.pod.alive, 'no pod on a forced roll');
  near(G.waves.distressT, CFG.distress.timeout, 0.001, 'life-support clock');
  const hunters = G.enemies.list.filter((e) => e._podHunter && e.alive).length;
  assert(hunters === CFG.distress.hunters, 'hunter count ' + hunters);
  const line = D.getElementById('obj-text');
  assert(/DISTRESS/.test(line.textContent), 'call did not take the objective line: ' + line.textContent);
  assert(D.getElementById('obj-timer').textContent.indexOf('RESCUE') === 0, 'clock not labelled RESCUE');
  // a later objective post must not steal the line while the call stands
  G.waves._setObjective('SOMETHING ELSE');
  assert(/DISTRESS/.test(line.textContent), 'a later post stole the line mid-call');
  G.waves._setObjective('RESTORED');
  G.waves.distressExpired();
  assert(line.textContent === 'RESTORED', 'line not handed back: ' + line.textContent);
  assert(G.waves.pod === null, 'pod survived the expiry');
  return 'pod + ' + hunters + ' raiders · ' + CFG.distress.timeout + 's · line owned then restored';
});
check('reaching the pod rescues it for the reward and the promised pickup', () => {
  arena();
  withRandom(0.0, () => G.waves.startWave(3));
  const pod = G.waves.pod, p = G.player;
  const score0 = GAME.score, picks0 = G.pickups.list.length;
  p.pos.copy(pod.pos).addScaledVector(new V3(1, 0, 0), CFG.distress.rescueRadius + 20);
  G.waves._updateDistress(1 / 60);
  assert(G.waves.pod === pod, 'rescued from outside the ring');
  p.pos.copy(pod.pos).addScaledVector(new V3(1, 0, 0), CFG.distress.rescueRadius - 10);
  G.waves._updateDistress(1 / 60);
  assert(G.waves.pod === null, 'rescue did not resolve inside the ring');
  assert(GAME.score - score0 >= CFG.distress.rescueReward, 'rescue reward missing');
  assert(G.pickups.list.length > picks0, 'no pickup on rescue');
  const drop = G.pickups.list[G.pickups.list.length - 1];
  assert(drop.type === 'weapon', 'rescue pickup was "' + drop.type + '", not the upgrade track');
  G.enemies.clear();
  return '+' + (GAME.score - score0) + ' · ' + drop.type + ' pickup';
});
check('enemy fire can shoot the pod down, and its raiders pay the bounty', () => {
  arena();
  withRandom(0.0, () => G.waves.startWave(3));
  const pod = G.waves.pod;
  const hp0 = pod.hp;
  const from = pod.pos.clone().addScaledVector(new V3(0, 0, 1), 60);
  G.projectiles.fire('ebolt', 'enemy', from, new V3(0, 0, -1), { speed: 300, dmg: 25, life: 2 });
  for (let i = 0; i < 30; i++) G.projectiles.update(1 / 60);
  assert(pod.hp < hp0, 'enemy bolts pass through the pod');
  const hunter = G.enemies.list.filter((e) => e._podHunter && e.alive)[0];
  assert(hunter, 'no hunter to test');
  hunter.update(1 / 60);
  assert(hunter.target === pod, 'hunter did not engage the pod');
  GAME.combo = 1;
  const score0 = GAME.score;
  hunter.alive = false;
  GAME.onEnemyKilled(hunter);
  assert(GAME.score - score0 >= CFG.distress.killReward, 'raider bounty missing');
  G.waves.distressLost();
  assert(G.waves.pod === null, 'destroyed pod was not torn down');
  G.enemies.clear();
  return 'pod ' + hp0 + ' → ' + pod.hp.toFixed(0) + ' hp · raider +' + (GAME.score - score0);
});

console.log('\n— §4 nemesis —');
check('one heavy hitter is marked, and a rock can never become the rival', () => {
  arena();
  Nemesis.clear(); Nemesis.resetRun();
  const th = CFG.nemesis.damageThreshold * G.player.maxHull;
  const e = G.enemies.spawnFighter({});
  Nemesis.noteDamage(e, th * 0.5);
  assert(!e.isNemesisCandidate, 'marked before the threshold');
  Nemesis.noteDamage(e, th * 0.6);
  assert(e.isNemesisCandidate && e.callsign, 'not marked at the threshold');
  assert(CFG.nemesis.names.indexOf(e.callsign) >= 0, 'callsign not from CFG.nemesis.names');
  const m = G.enemies.spawnMine(G.player.pos.clone());
  Nemesis.noteDamage(m, 1e6);
  assert(Nemesis._candUnit === e, 'a mine displaced the real candidate');
  // the funnel only attributes when a source instance is passed
  G.player.spawnGuard = 0; G.player.shield = 0;
  Nemesis.clear(); Nemesis.resetRun();
  G.player.damage(th, G.player.pos);
  assert(Nemesis._candUnit === null, 'unattributed damage created a rival');
  const f = G.enemies.spawnFighter({});
  G.player.damage(th + 5, G.player.pos, false, f);
  assert(f.isNemesisCandidate, 'attributed damage did not mark its source');
  G.enemies.clear();
  return e.callsign + ' at ' + th.toFixed(0) + ' damage · mine/rock ignored';
});
check('a marker that outlives the run is persisted and returns scaled', () => {
  arena();
  Nemesis.clear(); Nemesis.resetRun();
  const e = G.enemies.spawnFighter({});
  Nemesis.noteDamage(e, CFG.nemesis.damageThreshold * G.player.maxHull + 1);
  const name = e.callsign;
  GAME.gameOver();
  assert(Nemesis.load().name === name, 'marker not persisted (' + Nemesis.load().name + ')');
  assert(sandbox.localStorage.getItem('voidlancer_nemesis_v1') !== null, 'nothing written to localStorage');
  arena();
  assert(Nemesis.spawnedThisRun === false, 'spawn roll not re-armed for the new run');
  let rev = null;
  withRandom(0.0, () => { rev = Nemesis.maybeSpawn(); });
  assert(rev && rev.isNemesis && rev.callsign === name, 'the rival did not return as itself');
  assert(rev.dmgMult === CFG.nemesis.dmgMult, 'damage multiplier not set');
  const rivalHp = rev.maxHp;
  G.enemies.clear();
  near(rivalHp / G.enemies.spawnFighter({}).maxHp, CFG.nemesis.hpMult, 0.01, 'rival hp scaling');
  const it = G.projectiles.fire('ebolt', 'enemy', G.player.pos, new V3(0, 0, 1),
    { speed: 100, dmg: 20, life: 1, src: rev });
  near(it.dmg, 20 * CFG.nemesis.dmgMult, 1e-6, 'rival fire not scaled');
  G.projectiles.reset();
  // the bounty, the tag, and the cleared slot
  G.player.lockTarget = rev; G.player.lockT = 99; G.player.locked = true;
  G.hud.update(0.016);
  const tag = D.getElementById('target-tag');
  assert(tag.className === 'nemesis' && /NEMESIS/.test(tag.textContent), 'rival tag: ' + tag.className + '/' + tag.textContent);
  GAME.combo = 1;
  const score0 = GAME.score;
  rev.alive = false;
  GAME.onEnemyKilled(rev);
  assert(GAME.score - score0 >= CFG.nemesis.scoreBonus, 'nemesis bounty missing');
  assert(Nemesis.load().name === null, 'slot not cleared after the kill');
  G.player.lockTarget = null; G.player.locked = false;
  return name + ' returned · hp x' + CFG.nemesis.hpMult + ' · +' + (GAME.score - score0);
});
check('a marker you kill never gets promoted', () => {
  arena();
  Nemesis.clear(); Nemesis.resetRun();
  const e = G.enemies.spawnFighter({});
  Nemesis.noteDamage(e, CFG.nemesis.damageThreshold * G.player.maxHull + 1);
  e.alive = false;
  GAME.onEnemyKilled(e);
  assert(Nemesis._candUnit === null, 'dead marker still tracked');
  GAME.gameOver();
  assert(Nemesis.load().name === null, 'a marker you killed was still promoted');
  return 'killed → no grudge';
});

console.log('\n— §23 run snapshot —');
check('a live wave bookmarks the run; the scripted phases and a finished run do not', () => {
  arena();
  G.waves.startWave(4);
  const s = Snapshot.load();
  assert(s && s.wave === 4 && s.v === CFG.save.version, 'no valid bookmark after a wave started');
  Snapshot.clear();
  GAME.startRun('adventure');
  G.waves.startWave(3);
  assert(Snapshot.load() === null, 'a scripted pad-phase state was bookmarked');
  arena();
  G.waves.startWave(5);
  assert(Snapshot.load(), 'setup failed');
  GAME.gameOver();
  assert(Snapshot.load() === null, 'a finished run is still resumable');
  arena();
  G.waves.startWave(2);
  arena();
  assert(Snapshot.load() === null, 'a new run left the old bookmark on disk');
  return 'wave 4 stored · pad refused · finished/new runs clear';
});
check('resuming restores the run: score, wave, sector and carried state', () => {
  const p = arena('adventure');
  G.campaign._startMap(4);                       // sector 5
  const upId = CFG.upgrades.pool[0].id;
  p.applyUpgrade(upId);                          // refits top the pools up — set carried state after
  p.hull = 42; p.shield = 11; p.missileAmmo = 3; p.blasterTier = 2;
  p.unlockedWeapons[7] = true; p.skillUnlocked.blink = true;
  GAME.score = 12345; GAME.kills = 77;
  G.waves.startWave(3);
  const maxHullAtSave = p.maxHull;
  GAME.score = 0; p.hull = 1; p.blasterTier = 0;
  p.unlockedWeapons[7] = false; p.skillUnlocked.blink = false; p.upgrades.length = 0;
  assert(Snapshot.resume() === true, 'resume refused the bookmark');
  const q = G.player;
  assert(GAME.score === 12345 && GAME.kills === 77, 'score/kills not restored');
  assert(G.waves.wave === 3, 'wave not restored (' + G.waves.wave + ')');
  assert(G.campaign.mapIdx === 4 && GAME.mode === 'adventure', 'sector/mode not restored');
  assert(q.hull === 42 && q.shield === 11 && q.missileAmmo === 3, 'carried pools not restored');
  assert(q.blasterTier === 2 && q.unlockedWeapons[7] && q.skillUnlocked.blink, 'progression not restored');
  assert(q.upgrades.indexOf(upId) >= 0, 'refit not re-applied');
  near(q.maxHull, maxHullAtSave, 0.001, 'refit stats not recomputed');
  assert(GAME.state === 'playing', 'resume left the game out of play');
  return 'score ' + GAME.score + ' · sector ' + (G.campaign.mapIdx + 1) + ' · wave ' + G.waves.wave + ' · hull ' + q.hull;
});
check('the start screen offers the bookmark, and DISCARD / RESUME work', () => {
  arena();
  GAME.score = 987654;
  G.waves.startWave(7);
  Snapshot.init();
  const el = D.getElementById('resume-offer');
  assert(el.style.display === 'flex', 'offer not shown');
  const text = D.getElementById('resume-text').textContent;
  assert(/WAVE 7/.test(text) && /987/.test(text), 'offer text is "' + text + '"');
  D.getElementById('btn-discard').click();
  assert(Snapshot.load() === null && el.style.display === 'none', 'discard did not clear/hide the offer');
  GAME.score = 555;
  G.waves.startWave(8);
  Snapshot.init();
  D.getElementById('btn-resume').click();
  assert(GAME.score === 555 && G.waves.wave === 8, 'RESUME button did not resume the run');
  assert(el.style.display === 'none', 'offer stayed up after resuming');
  return text;
});

console.log('\n— shipped-but-dead contracts closed in v1.9 —');
check('modifier score multipliers actually pay (the ×1.20 badges)', () => {
  arena();
  GAME.combo = 1;
  const s0 = GAME.score;
  GAME.addScore(1000, null, '');
  const plain = GAME.score - s0;
  CFG.settings.modifiers = ['noShieldRegen'];
  const s1 = GAME.score;
  GAME.addScore(1000, null, '');
  const modded = GAME.score - s1;
  near(modded / plain, CFG.modifiers.noShieldRegen.scoreMult, 0.01, 'modifier score multiplier');
  CFG.settings.modifiers = [];
  return '×' + (modded / plain).toFixed(2) + ' with noShieldRegen';
});
check('the pause-menu RESUME button is wired', () => {
  arena();
  GAME.pause();
  assert(GAME.state === 'paused', 'pause failed');
  D.getElementById('btn-pause-resume').click();
  assert(GAME.state === 'playing', 'RESUME button did nothing (state ' + GAME.state + ')');
  return 'paused → playing';
});

console.log('\n' + (fail ? fail + ' FAILED, ' : '') + pass + ' passed');
process.exit(fail ? 1 : 0);