/* ============================================================
   ENGINE.JS — reusable low-level systems
   ------------------------------------------------------------
   LOAD ORDER: after data.js (reads CFG) and before fx.js /
   entities.js / game.js. Contains: math utils + zero-GC scratch
   objects, collision helpers (segSphere, swept queries), Input,
   procedural AudioSys, projectile pools, World (sky/planets/
   asteroids/dust), Pickups, Player + CameraRig, ShipGeo cache +
   geometry merge helpers, screen projection (worldToScreen).
   Split from the old monolithic core — logic untouched.
============================================================ */

/* HUD-facing screen projection + shared screen-scratch vector.
   (Hoisted above its old section: entities.js uses it too.) */
const _proj = new THREE.Vector3();
function worldToScreen(v3, out) {
  _proj.copy(v3).applyMatrix4(G.camera.matrixWorldInverse);
  if (_proj.z > -0.1) return false;          // behind (or inside) the camera
  _proj.applyMatrix4(G.camera.projectionMatrix);
  out.x = (_proj.x * 0.5 + 0.5) * window.innerWidth;
  out.y = (-_proj.y * 0.5 + 0.5) * window.innerHeight;
  return true;
}



/* ============================================================
   [SECTION 2] UTILITIES & MATH SCRATCHPAD
   ------------------------------------------------------------
   Zero-GC policy: hot loops only touch pre-allocated scratch
   objects. damp() is the frame-rate independent exponential
   smoothing used everywhere (rotation, camera, smoothing):
       damp(cur, tgt, rate, dt) = tgt + (cur-tgt)*e^(-rate*dt)
   — converges like a spring with rate "lambda", never depends
   on the frame rate, and never overshoots.
============================================================ */
const U = {
  TAU: Math.PI * 2,
  rand: (a, b) => a + Math.random() * (b - a),
  randi: (a, b) => Math.floor(a + Math.random() * (b - a + 1)),
  pick: (arr) => arr[(Math.random() * arr.length) | 0],
  clamp: (v, a, b) => v < a ? a : (v > b ? b : v),
  lerp: (a, b, t) => a + (b - a) * t,
  damp: (cur, tgt, rate, dt) => tgt + (cur - tgt) * Math.exp(-rate * dt),
  // weighted pick from {key: weight}
  pickWeighted(obj) {
    let total = 0; for (const k in obj) total += obj[k];
    let r = Math.random() * total;
    for (const k in obj) { r -= obj[k]; if (r <= 0) return k; }
    return Object.keys(obj)[0];
  },
  // random unit vector (THREE.Vector3.randomDirection doesn't exist in r128)
  randomDir(out) {
    // uniform on sphere via z = u in [-1,1], golden angle
    const z = U.rand(-1, 1), a = U.rand(0, U.TAU), r = Math.sqrt(1 - z * z);
    return out.set(r * Math.cos(a), r * Math.sin(a), z);
  },
  fmt: (n) => Math.floor(n).toLocaleString('en-US'),
};

// ---- scratch objects (single-frame validity only!) ----
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(),
      _v3 = new THREE.Vector3(), _v4 = new THREE.Vector3(),
      _v5 = new THREE.Vector3(), _v6 = new THREE.Vector3(),
      _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(),
      _e1 = new THREE.Euler(), _m1 = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const FWD = new THREE.Vector3(0, 0, -1);
const _ORIGIN = new THREE.Vector3(0, 0, 0);   // never mutated; lookAt eye point

/* ------------------------------------------------------------
   Segment-vs-sphere sweep test — the collision backbone.
   Projectiles store their previous-frame position, so instead
   of naive "distance now" checks (which tunnel through targets
   at 700 u/s), we test the WHOLE swept segment p0 -> p1 against
   each sphere. Returns hit param t in [0,1] (or -1), and writes
   the closest point on the segment into `out`.
------------------------------------------------------------ */
function segSphere(px, py, pz, qx, qy, qz, cx, cy, cz, r, out) {
  const dx = qx - px, dy = qy - py, dz = qz - pz;
  const l2 = dx * dx + dy * dy + dz * dz;
  let t = 0;
  if (l2 > 1e-9) {
    t = ((cx - px) * dx + (cy - py) * dy + (cz - pz) * dz) / l2;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
  }
  const hx = px + dx * t, hy = py + dy * t, hz = pz + dz * t;
  const ex = hx - cx, ey = hy - cy, ez = hz - cz;
  const d2 = ex * ex + ey * ey + ez * ez, rr = r * r;
  if (d2 > rr) return -1;
  if (out) out.set(hx, hy, hz);
  return t;
}

/* Face `pos` toward `target` along the shortest arc, limited to
   maxStep radians. Uses Matrix4.lookAt directly (NOT Object3D.lookAt —
   that points meshes down +Z; our hull convention is -Z, matching
   cameras). Guarded against the degenerate parallel-to-up case. */
function rotateTowards(pos, quat, target, maxStep) {
  _v6.copy(target).sub(pos);
  const len = _v6.length();
  if (len < 1e-6) return quat;
  _v6.multiplyScalar(1 / len);
  const upRef = Math.abs(_v6.dot(UP)) > 0.999 ? _v5.set(0, 0, 1) : UP;
  // eye is the dedicated _ORIGIN — upRef may BE _v5, so the eye can't be a
  // scratch vector (aliasing here once produced NaN quaternions)
  _m1.lookAt(_ORIGIN, _v6, upRef); // eye at origin, -Z toward dir
  _q2.setFromRotationMatrix(_m1);
  quat.rotateTowards(_q2, maxStep);
  return quat;
}

// Project a world point to HUD screen px. Returns false if behind the camera.
// (Robust "behind" test: transform into view space and check the z sign,
//  because NDC-projected points behind the eye have mirrored x/y.)
/* ============================================================
   [SECTION 3] INPUT
   ------------------------------------------------------------
   Freelancer-style "virtual cursor" steering:
   - With pointer lock: mouse deltas push a virtual cursor around
     the screen center; its offset from center (after deadzone +
     response curve) commands pitch/yaw RATES. The visible reticle
     shows where you're steering & aiming.
   - Fallback "hover mode" (if pointer lock is denied, e.g. inside
     a sandboxed iframe): cursor = mouse position offset from the
     window center. Same math, no lock needed.
   Wheel gives roll impulses (in addition to Q/E).
============================================================ */
class Input {
  constructor(el) {
    this.el = el;
    this.keys = Object.create(null);   // e.code -> bool
    this.just = new Set();             // e.code pressed THIS frame
    this.cursor = { x: 0, y: 0 };      // virtual cursor px offset
    this.locked = false;
    this.hoverMode = false;
    this.wheelDelta = 0;
    this.btn = [false, false, false];  // mouse buttons held
    this.btnJust = [false, false, false];
    this._lockTimer = 0;

    // Some contexts (virtual keyboards, IMEs, synthetic events) deliver an
    // empty e.code — fall back to deriving it from e.key so the controls
    // keep working there too.
    const codeOf = (e) => {
      if (e.code) return e.code;
      const k = e.key;
      if (!k) return '';
      if (k === ' ') return 'Space';
      if (k.length === 1 && /[a-z]/i.test(k)) return 'Key' + k.toUpperCase();
      if (k.length === 1 && /[0-9]/.test(k)) return 'Digit' + k;
      return k;
    };
    window.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      const code = codeOf(e);
      this.keys[code] = true;
      this.just.add(code);
      // CHEATS menu: remember that THIS frame's keypresses carried Shift
      // (some synthetic/IME keyboards don't emit a separate Shift code)
      if (e.shiftKey) this.justShift = true;
      // stop the page eating backquote/space/etc
      if (['Space', 'Backquote', 'Tab'].includes(code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => { this.keys[codeOf(e)] = false; });
    // NOTE: a blur can swallow the pending touchend — the touch bookkeeping
    // must be dropped here too, or the stale ids would reject every later touch.
    window.addEventListener('blur', () => {
      this.keys = Object.create(null); this.btn = [false, false, false];
      this._steerId = null; this._fireId = null;
    });

    el.addEventListener('mousedown', (e) => {
      if (e.button <= 2) { this.btn[e.button] = true; this.btnJust[e.button] = true; }
    });
    window.addEventListener('mouseup', (e) => { if (e.button <= 2) this.btn[e.button] = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    window.addEventListener('mousemove', (e) => {
      // PHOTO MODE: free-look drag even without pointer lock
      if (typeof G !== 'undefined' && G.photo && G.photo.active) {
        this.cursor.x = U.clamp(this.cursor.x + (e.movementX || 0) * 0.8, -2000, 2000);
        this.cursor.y = U.clamp(this.cursor.y + (e.movementY || 0) * 0.8, -2000, 2000);
        return;
      }
      // A genuine mouse move hands control back to the mouse: a stray touch on a
      // touchscreen laptop must not strand pointer-lock flight. Synthetic tap-mouse
      // events carry no movement, and touch-only devices report no fine pointer.
      if (this.touch) {
        if (this._anyFine && this._steerId === null && this._fireId === null && (e.movementX || e.movementY)) {
          this.touch = false;
          this._touchUI(false);
          this.requestLock();
        }
        return;
      }
      if (this.locked) {
        // Chrome occasionally delivers a bogus huge movementX right after
        // re-locking — clamp so the ship doesn't lurch.
        const mx = U.clamp(e.movementX || 0, -80, 80);
        const my = U.clamp(e.movementY || 0, -80, 80);
        this.cursor.x = U.clamp(this.cursor.x + mx * CFG.flight.mouseSens, -CFG.flight.cursorRadius, CFG.flight.cursorRadius);
        this.cursor.y = U.clamp(this.cursor.y + my * CFG.flight.mouseSens, -CFG.flight.cursorRadius, CFG.flight.cursorRadius);
      } else if (this.hoverMode && G.game && G.game.state === 'playing') {
        this.cursor.x = U.clamp(e.clientX - window.innerWidth * 0.5, -CFG.flight.cursorRadius, CFG.flight.cursorRadius);
        this.cursor.y = U.clamp(e.clientY - window.innerHeight * 0.5, -CFG.flight.cursorRadius, CFG.flight.cursorRadius);
      }
    });

    // wheel = roll impulses (clamped so trackpads don't spin us silly)
    window.addEventListener('wheel', (e) => {
      this.wheelDelta += U.clamp(e.deltaY, -160, 160);
      e.preventDefault();
    }, { passive: false });

    // touch flight: engages when the primary pointer is coarse (phone/tablet),
    // or the moment a real touch lands on the canvas — a mouse on a touchscreen
    // laptop keeps normal pointer-lock steering.
    const coarse = (typeof matchMedia === 'function') && matchMedia('(hover:none) and (pointer:coarse)').matches;
    this._anyFine = (typeof matchMedia === 'function') && matchMedia('(any-pointer:fine)').matches;
    this.touch = !!coarse;
    this._steerId = null; this._fireId = null; this._steerX = 0; this._steerY = 0;
    if (this.touch) this._touchUI(true);
    el.addEventListener('touchstart', (e) => {
      if (!this.touch) { this.touch = true; this.releaseLock(); this._touchUI(true); }
      const playing = G.game && G.game.state === 'playing';
      if (playing && e.target === this.el) e.preventDefault();   // no scroll / double-tap zoom mid-flight
      if (!playing) return;
      for (const t of e.changedTouches) {
        if (this._steerId === null) {
          this._steerId = t.identifier;
          this._steerX = t.clientX; this._steerY = t.clientY;
        } else if (this._fireId === null) {
          this._fireId = t.identifier;
          this.btn[0] = true; this.btnJust[0] = true;
        }
      }
    }, { passive: false });
    el.addEventListener('touchmove', (e) => {
      if (this._steerId === null) return;
      e.preventDefault();
      for (const t of e.changedTouches) {
        if (t.identifier !== this._steerId) continue;
        const dx = t.clientX - this._steerX, dy = t.clientY - this._steerY;
        this._steerX = t.clientX; this._steerY = t.clientY;
        this.cursor.x = U.clamp(this.cursor.x + dx * 2.2, -CFG.flight.cursorRadius, CFG.flight.cursorRadius);
        this.cursor.y = U.clamp(this.cursor.y + dy * 2.2, -CFG.flight.cursorRadius, CFG.flight.cursorRadius);
      }
    }, { passive: false });
    const touchEnd = (e) => {
      const list = e && e.changedTouches;
      const ids = list && list.length ? Array.prototype.map.call(list, (t) => t.identifier) : null;
      if (this._steerId !== null && (!ids || ids.includes(this._steerId))) this._steerId = null;
      if (this._fireId !== null && (!ids || ids.includes(this._fireId))) { this._fireId = null; this.btn[0] = false; }
    };
    window.addEventListener('touchend', touchEnd);
    window.addEventListener('touchcancel', () => touchEnd(null));

    document.addEventListener('pointerlockchange', () => {
      this.locked = (document.pointerLockElement === this.el);
      if (this.locked) { this._retried = false; return; }
      // an intentional unlock for the map-upgrade CHOICE screen must not
      // read as "user hit Esc" — the choice screen owns the cursor until
      // a refit is picked.
      if (G.hud && G.hud._upgCb) return;
      if (G.game && G.game.state === 'playing' && !this.hoverMode) {
        // Lock dropped. If it dropped almost immediately after a request,
        // this ENVIRONMENT can't hold pointer lock (headless, sandboxed
        // iframe) — fall back to hover steering instead of bouncing the
        // player into standby forever. A later drop = user hit Esc => pause.
        if (performance.now() - (this._lastLockReq || 0) < 700) this._enterHoverMode();
        else G.game.pause();
      }
    });
    document.addEventListener('pointerlockerror', () => {
      // Chrome enforces a ~1.25s re-lock cooldown after Esc — retry once
      // before concluding pointer lock is unavailable in this context.
      if (!this._retried) {
        this._retried = true;
        setTimeout(() => { if (G.game && G.game.state === 'playing') this.requestLock(); }, 1400);
        return;
      }
      this._enterHoverMode();
    });
  }

  _touchUI(on) {
    if (G.hud && G.hud.el && G.hud.el.hud) G.hud.el.hud.classList.toggle('touch-ui', on);
  }

  _enterHoverMode() {
    if (this.touch) return;   // a lock-retry timer must not claim "mouse mode" once touch took over
    this.hoverMode = true;
    if (G.app) G.app.classList.add('hovermode');
    if (G.hud) G.hud.alert('MOUSE MODE: HOVER (pointer lock unavailable)', 3);
  }

  requestLock() {
    if (this.touch || this.hoverMode) return;
    this._lastLockReq = performance.now();
    try { const p = this.el.requestPointerLock(); if (p && p.catch) p.catch(() => this._enterHoverMode()); }
    catch (e) { this._enterHoverMode(); }
    // If the lock never engages (some iframes), silently fall back.
    clearTimeout(this._lockTimer);
    this._lockTimer = setTimeout(() => {
      if (!this.locked && G.game && G.game.state === 'playing' && !this.hoverMode) this._enterHoverMode();
    }, 1500);   // Chrome enforces a ~1.25s re-lock cooldown after Esc — wait it out
  }
  releaseLock() { if (this.locked) document.exitPointerLock(); }

  key(code) { return !!this.keys[code]; }
  justKey(code) { return this.just.has(code); }
  recenterCursor() { this.cursor.x = 0; this.cursor.y = 0; }

  // call once at the END of every frame
  endFrame() {
    this.just.clear();
    this.justShift = false;
    this.btnJust = [false, false, false];
    this.wheelDelta = 0;
  }

  // ---- gamepad (Section 14-ish / higher value than touch) ----
  // Poll navigator.getGamepads once per frame; expose a virtual cursor
  // nudge + button edges so existing key-based action paths keep working.
  pollGamepad() {
    this.gpActive = false;
    if (!navigator.getGamepads) return;
    const pads = navigator.getGamepads();
    let gp = null;
    for (let i = 0; i < pads.length; i++) { if (pads[i] && pads[i].connected) { gp = pads[i]; break; } }
    if (!gp) return;
    const ax = gp.axes || [], bt = gp.buttons || [];
    const dead = (v) => (Math.abs(v) < 0.18 ? 0 : v);
    const lx = dead(ax[0] || 0), ly = dead(ax[1] || 0);
    const rx = dead(ax[2] || 0), ry = dead(ax[3] || 0);
    if (lx || ly || rx || ry) {
      this.gpActive = true;
      this.cursor.x = U.clamp(this.cursor.x + rx * CFG.flight.cursorRadius * 0.04, -CFG.flight.cursorRadius, CFG.flight.cursorRadius);
      this.cursor.y = U.clamp(this.cursor.y + ry * CFG.flight.cursorRadius * 0.04, -CFG.flight.cursorRadius, CFG.flight.cursorRadius);
      // left stick also strafes/rolls via synthetic cursor if mouse idle
      if (!this.locked && !this.hoverMode) {
        this.cursor.x = U.clamp(this.cursor.x + lx * CFG.flight.cursorRadius * 0.04, -CFG.flight.cursorRadius, CFG.flight.cursorRadius);
        this.cursor.y = U.clamp(this.cursor.y + ly * CFG.flight.cursorRadius * 0.04, -CFG.flight.cursorRadius, CFG.flight.cursorRadius);
      }
    }
    const held = (i) => !!(bt[i] && bt[i].pressed);
    const edge = (i, code) => {
      const h = held(i);
      if (h && !this._gpPrev[i]) this.just.add(code);
      this._gpPrev[i] = h;
    };
    if (!this._gpPrev) this._gpPrev = {};
    edge(0, 'Space');           // A
    edge(2, 'KeyE');            // X = flares
    edge(3, 'KeyQ');            // Y = nova
    edge(5, 'ShiftLeft');       // RB = boost
    edge(4, 'KeyW');            // LB = fire (approx)
    if (held(5)) this.keys['ShiftLeft'] = true;
    if (held(4)) this.keys['KeyF'] = true;
    if (held(7)) this.wheelDelta += 1; // RT stub
    // dpad = weapon cycle
    if (held(12) && !this._gpPrev[12]) this.just.add('Digit1');
    if (held(13) && !this._gpPrev[13]) this.just.add('Digit2');
    if (held(14) && !this._gpPrev[14]) this.just.add('Digit3');
    if (held(15) && !this._gpPrev[15]) this.just.add('Digit4');
    this._gpPrev[12] = held(12); this._gpPrev[13] = held(13);
    this._gpPrev[14] = held(14); this._gpPrev[15] = held(15);
    this._gpPrev[7] = held(7);
  }

  // per-frame touch recenter: once the fingers lift, snap the virtual cursor
  // back to center so aim direction is always predictable.
  pollTouch() {
    if (this.touch && this._steerId === null && this._fireId === null
        && (this.cursor.x || this.cursor.y)) this.recenterCursor();
  }
}

/* ============================================================
   [SECTION 4] AUDIO — fully procedural WebAudio
   ------------------------------------------------------------
   No files: lasers are pitch-swept oscillators, explosions are
   filtered noise bursts with exponential decay, the engine is a
   looping noise source through a lowpass whose cutoff/gain track
   thrust. Everything is throttled and wrapped in try/catch so a
   blocked AudioContext can never crash the game.
============================================================ */
class AudioSys {
  constructor() { this.ctx = null; this.master = null; this.muted = false; this.ready = false;
    this._last = Object.create(null); this.engine = null; }

  // must be called from a user gesture (click) or it silently no-ops
  init() {
    if (this.ready) return true;
    try {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = (CFG.settings && CFG.settings.volMaster != null)
        ? 0.55 * CFG.settings.volMaster : 0.55;
      this.master.connect(this.ctx.destination);
      // shared noise buffer (2s of white noise, reused by everything)
      const len = this.ctx.sampleRate * 2;
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this._startEngine();
      this._startAmbient();
      this.ready = true;
    } catch (e) { this.ready = false; }
    return this.ready;
  }

  setMuted(m) { this.muted = m; this.applyGain(); }

  applyGain() {
    if (!this.master) return;
    const vm = (CFG.settings && CFG.settings.volMaster != null) ? CFG.settings.volMaster : 1;
    this.master.gain.value = this.muted ? 0 : 0.55 * vm;
  }

  setMusicVol(v) {
    if (G.music && G.music.bus) G.music.bus.gain.value = CFG.music.master * v;
  }

  _throttled(key, ms) {
    const t = performance.now();
    if (this._last[key] && t - this._last[key] < ms) return true;
    this._last[key] = t; return false;
  }

  /* ---- primitive: oscillator blip with pitch slide ---- */
  _osc(type, f0, f1, dur, gain, delay = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, f0), t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }

  /* ---- primitive: filtered noise burst ---- */
  _noise(dur, gain, filtHz0, filtHz1, q = 0.8, delay = 0) {
    if (!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    src.playbackRate.value = U.rand(0.85, 1.15);
    const f = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
    f.type = 'lowpass'; f.Q.value = q;
    f.frequency.setValueAtTime(Math.max(30, filtHz0), t);
    f.frequency.exponentialRampToValueAtTime(Math.max(30, filtHz1), t + dur);
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    src.start(t, Math.random()); src.stop(t + dur + 0.02);
  }

  /* ================= SFX library ================= */
  shotBlaster(pitch = 1) {
    if (this._throttled('bl', 30)) return;
    this._osc('square', 920 * pitch, 240 * pitch, 0.07, 0.06);
    this._osc('sawtooth', 1400 * pitch, 300 * pitch, 0.05, 0.03);
  }
  shotLance(charge) { // deep thump + rising shimmer scaled by charge 0..1
    this._osc('sine', 70 + charge * 40, 34, 0.28 + charge * 0.2, 0.34);
    this._osc('sawtooth', 220 + charge * 500, 90, 0.18, 0.10);
    if (charge > 0.6) this._noise(0.3, 0.12, 2600, 300);
  }
  chargeTick() { if (this._throttled('ct', 90)) return; this._osc('sine', 300, 900, 0.09, 0.03); }
  shotMissile() { this._noise(0.45, 0.16, 900, 3400, 1.2); this._osc('sawtooth', 160, 60, 0.3, 0.08); }
  hit() { if (this._throttled('ht', 45)) return; this._osc('square', 520, 180, 0.045, 0.045); }
  shieldHit() { if (this._throttled('sh', 60)) return;
    this._osc('sine', 640, 500, 0.16, 0.09); this._osc('sine', 962, 860, 0.12, 0.05); }
  hullHit() { this._noise(0.16, 0.2, 700, 140); this._osc('square', 140, 60, 0.12, 0.12); }
  explosion(size) { // size ~ enemy radius scale; bigger = longer/deeper
    if (this._throttled('ex', 40)) return;
    const s = U.clamp(size, 1, 30);
    this._noise(0.4 + s * 0.05, 0.16 + s * 0.012, 2000, 60, 0.6);
    this._osc('sine', 90 + 60 / s, 30, 0.35 + s * 0.05, 0.22 + s * 0.02);
  }
  bigBoom() { this._noise(1.6, 0.34, 2400, 40, 0.5); this._osc('sine', 60, 24, 1.4, 0.4);
    this._noise(1.2, 0.2, 400, 60, 0.4, 0.25); }
  pickup() { this._osc('sine', 620, 620, 0.08, 0.07); this._osc('sine', 930, 930, 0.1, 0.07, 0.07); }
  lockBeep(locked) {
    if (locked) { this._osc('sine', 1180, 1180, 0.14, 0.07); }
    else if (this._throttled('lb', 220)) { this._osc('sine', 760, 760, 0.05, 0.03); }
  }
  alarm() { for (let i = 0; i < 3; i++) { this._osc('square', 440, 440, 0.14, 0.06, i * 0.28);
    this._osc('square', 330, 330, 0.14, 0.06, i * 0.28 + 0.14); } }
  waveHorn() { this._osc('sawtooth', 98, 98, 0.5, 0.08); this._osc('sawtooth', 147, 147, 0.5, 0.06, 0.02); }
  ui() { this._osc('sine', 800, 1200, 0.07, 0.05); }
  thud(power) { this._noise(0.2, 0.14 * power, 500, 90); this._osc('sine', 80, 40, 0.18, 0.2 * power); }
  combo() { this._osc('sine', 700, 1400, 0.09, 0.045); }
  zap() { this._osc('sawtooth', 1900, 320, 0.12, 0.045); this._osc('sine', 2500, 420, 0.09, 0.028); }
  /* deep triple-thump for heavy bolt salvos */
  shotHeavy() {
    if (this._throttled('hv', 60)) return;
    this._osc('sine', 120, 48, 0.22, 0.16);
    this._osc('sawtooth', 340, 90, 0.16, 0.07);
    this._noise(0.14, 0.1, 900, 200);
  }

  /* ---- continuous engine loop: thrust 0..1 (visual+audio always agree) ---- */
  _startEngine() {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf; src.loop = true;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 120; lp.Q.value = 0.7;
    const g = ctx.createGain(); g.gain.value = 0;
    src.connect(lp); lp.connect(g); g.connect(this.master);
    src.start();
    // sub-bass rumble
    const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = 38;
    const og = ctx.createGain(); og.gain.value = 0;
    const olp = ctx.createBiquadFilter(); olp.type = 'lowpass'; olp.frequency.value = 90;
    o.connect(olp); olp.connect(og); og.connect(this.master); o.start();
    this.engine = { g, og, lp, o };
  }
  engineSet(thrust01, boosting) {
    if (!this.engine) return;
    const t = this.ctx.currentTime;
    const tgt = 0.028 + thrust01 * 0.09 + (boosting ? 0.06 : 0);
    this.engine.g.gain.setTargetAtTime(tgt, t, 0.08);
    this.engine.lp.frequency.setTargetAtTime(120 + thrust01 * 900 + (boosting ? 900 : 0), t, 0.1);
    this.engine.og.gain.setTargetAtTime(thrust01 * 0.05 + (boosting ? 0.05 : 0), t, 0.1);
    this.engine.o.frequency.setTargetAtTime(36 + thrust01 * 26, t, 0.15);
  }

  /* ---- quiet evolving ambient pad (detuned saws + slow filter LFO) ----
     This pad is LAYER 0 of the music stack — the Music object below owns
     three ADDITIVE layers (ambient pad, combat pulse, boss riff) whose
     GAINS crossfade with combat intensity. No tracks are ever hard-cut;
     the mix IS the state machine. */
  _startAmbient() {
    const ctx = this.ctx;
    const g = ctx.createGain(); g.gain.value = 0.035;
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 190; lp.Q.value = 0.9;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 0.045;
    const lfoG = ctx.createGain(); lfoG.gain.value = 110;
    lfo.connect(lfoG); lfoG.connect(lp.frequency); lfo.start();
    [55, 55.4, 82.5].forEach((f) => {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
      o.connect(lp); o.start();
    });
    lp.connect(g); g.connect(this.master);
  }
}

/* ============================================================
   MUSIC — layered procedural score (Web Audio)
   ------------------------------------------------------------
   Three additive layers, all built from oscillators + the shared
   noise buffer, all routed through their own gain into one music
   bus (so the M mute kills them with everything else):
     L1 AMBIENT — slow minor pad + airy noise wash (map intro, lulls)
     L2 COMBAT  — pulsing bass + arpeggiated sequencer line, gated by
                  a 16th-note clock; gain tracks enemy pressure
     L3 BOSS    — driving low riff + dissonant drone; engages when a
                  capital signature is active
   setIntensity(0..1, bossActive) eases the layer gains toward their
   targets every frame — transitions are always crossfades.
============================================================ */
class Music {
  constructor(audio) {
    this.a = audio; this.ready = false;
    this.intensity = 0;            // smoothed 0..1 combat pressure
    this.bossOn = false;
    this._step = 0; this._nextNote = 0;
  }

  init() {
    const A = this.a;
    if (!A.ready || this.ready) return;
    try {
      const ctx = A.ctx;
      this.bus = ctx.createGain();
      this.bus.gain.value = CFG.music.master *
        ((CFG.settings && CFG.settings.volMusic != null) ? CFG.settings.volMusic : 1);
      this.bus.connect(A.master);
      const mkGain = () => { const g = ctx.createGain(); g.gain.value = 0; g.connect(this.bus); return g; };
      // ---- L1 ambient pad: detuned fifths + slow LFO breathing ----
      this.gAmb = mkGain();
      const padLP = ctx.createBiquadFilter(); padLP.type = 'lowpass'; padLP.frequency.value = 420;
      padLP.connect(this.gAmb);
      [110, 164.8, 220.5, 329.6].forEach((f, i) => {
        const o = ctx.createOscillator(); o.type = i < 2 ? 'sine' : 'triangle';
        o.frequency.value = f; o.detune.value = (i - 1.5) * 6;
        const og = ctx.createGain(); og.gain.value = i < 2 ? 0.5 : 0.22;
        o.connect(og); og.connect(padLP); o.start();
      });
      // ---- L2 combat: bass pulse + 16-step arp through a pluck env ----
      this.gComb = mkGain();
      this.bassOsc = ctx.createOscillator(); this.bassOsc.type = 'sawtooth';
      this.bassOsc.frequency.value = 55;
      this.bassFilt = ctx.createBiquadFilter(); this.bassFilt.type = 'lowpass'; this.bassFilt.frequency.value = 240; this.bassFilt.Q.value = 4;
      this.bassEnv = ctx.createGain(); this.bassEnv.gain.value = 0;
      this.bassOsc.connect(this.bassFilt); this.bassFilt.connect(this.bassEnv); this.bassEnv.connect(this.gComb);
      this.bassOsc.start();
      this.arpOsc = ctx.createOscillator(); this.arpOsc.type = 'square';
      this.arpEnv = ctx.createGain(); this.arpEnv.gain.value = 0;
      const arpFilt = ctx.createBiquadFilter(); arpFilt.type = 'bandpass'; arpFilt.frequency.value = 880; arpFilt.Q.value = 2.4;
      this.arpOsc.connect(arpFilt); arpFilt.connect(this.arpEnv); this.arpEnv.connect(this.gComb);
      this.arpOsc.start();
      // ---- L3 boss: low fifth drone + offbeat percussion tick ----
      this.gBoss = mkGain();
      [36.7, 55.1].forEach((f) => {
        const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f;
        const og = ctx.createGain(); og.gain.value = 0.4;
        const olp = ctx.createBiquadFilter(); olp.type = 'lowpass'; olp.frequency.value = 160;
        o.connect(olp); olp.connect(og); og.connect(this.gBoss); o.start();
      });
      this.ready = true;
    } catch (e) { this.ready = false; }
  }

  /* Called once per frame from the main loop. target: 0..1 pressure;
     boss: capital ship active. Gains ease exponentially — pure crossfade. */
  update(dt, target, boss) {
    if (!this.ready) return;
    const M = CFG.music;
    this.intensity += (target - this.intensity) * Math.min(1, dt * M.combatRamp);
    this.bossOn = boss;
    const t = this.a.ctx.currentTime;
    const ambT = M.ambient * (1 - this.intensity * 0.55);
    const comT = M.combat * this.intensity;
    const bosT = M.boss * (boss ? Math.min(1, this.intensity * 1.4) : 0);
    this.gAmb.gain.setTargetAtTime(ambT, t, 0.7);
    this.gComb.gain.setTargetAtTime(comT, t, 0.5);
    this.gBoss.gain.setTargetAtTime(bosT, t, 0.9);
    this._seq(dt);
  }

  /* 16th-note sequencer driving the combat bass + arp (dt-accumulated) */
  _seq(dt) {
    if (this.intensity < 0.08) return;
    const stepDur = 60 / (CFG.music.bpm * 4);
    this._nextNote -= dt;
    if (this._nextNote > 0) return;
    this._nextNote = Math.max(this._nextNote + stepDur, stepDur * 0.5);
    const s = (this._step = (this._step + 1) % 16);
    const t = this.a.ctx.currentTime;
    const root = [55, 55, 73.4, 55, 55, 65.4, 55, 49][ (s >> 1) % 8 ];
    this.bassOsc.frequency.setTargetAtTime(root, t, 0.03);
    this.bassEnv.gain.cancelScheduledValues(t);
    this.bassEnv.gain.setValueAtTime(0.5 * this.intensity, t);
    this.bassEnv.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 1.8);
    if (s % 2 === 0 && this.intensity > 0.3) {
      const scale = [0, 3, 5, 7, 10, 12, 15, 19];
      // whole sum inside the modulo, or the index walks out of bounds
      this._stepSeq = ((this._stepSeq || 0) + 1) % 8;
      const n = 220 * Math.pow(2, scale[(s * 5 + this._stepSeq) % 8] / 12);
      this.arpOsc.frequency.setTargetAtTime(n, t, 0.02);
      this.arpEnv.gain.cancelScheduledValues(t);
      this.arpEnv.gain.setValueAtTime(0.12 * this.intensity, t);
      this.arpEnv.gain.exponentialRampToValueAtTime(0.001, t + stepDur * 1.2);
    }
  }
}

/* ============================================================
   [SECTION 6] PROJECTILES — instanced pools + swept collision
   ------------------------------------------------------------
   One InstancedMesh per visual style (bolt / lance / missile /
   enemy bolt / heavy / enemy missile). Each pool entry is a
   plain struct with { pos, prev, vel, ... }; every frame we:
     1. integrate pos (storing prev for the sweep)
     2. homing missiles steer their velocity
     3. write the instance matrix (position + lookAt along vel)
     4. run SEGMENT-vs-sphere collision (see segSphere above)
   which means even 700 u/s bolts cannot tunnel through targets.
============================================================ */

const PROJ_STYLES = {
  // radius = collision sphere, deliberately tight: a shot must genuinely
  // pass through the target. trail = tracer streak config.
  // ---- player ----
  bolt:    { count: 256, radius: 0.55, geo: () => new THREE.BoxGeometry(0.24, 0.24, 3.4),
             mat: () => new THREE.MeshBasicMaterial({ color: 0x8ff8ff }),
             trail: { w: 0.42, max: 26, col: 0x8ff8ff } },
  lance:   { count: 24,  radius: 1.35, geo: () => new THREE.BoxGeometry(0.55, 0.55, 7),
             mat: () => new THREE.MeshBasicMaterial({ color: 0xb0ffd8 }),
             trail: { w: 0.9, max: 44, col: 0xb0ffd8 } },
  rail:    { count: 16,  radius: 1.1, geo: () => new THREE.BoxGeometry(0.3, 0.3, 12),
             mat: () => new THREE.MeshBasicMaterial({ color: 0xd8f4ff }),
             trail: { w: 0.7, max: 90, col: 0xbfe8ff } },
  missile: { count: 48,  radius: 1.0, geo: () => { const g = new THREE.ConeGeometry(0.38, 1.9, 6);
             g.rotateX(Math.PI / 2); return g; },           // cone tip -> +Z
             mat: () => new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
             trail: { w: 0.8, max: 32, col: 0xffb46a } },
  // ---- enemy ----
  ebolt:   { count: 384, radius: 0.5, geo: () => new THREE.BoxGeometry(0.3, 0.3, 2.6),
             mat: () => new THREE.MeshBasicMaterial({ color: 0xff5a40 }),
             trail: { w: 0.44, max: 22, col: 0xff5a40 } },
  eheavy:  { count: 96,  radius: 1.1, geo: () => new THREE.BoxGeometry(0.7, 0.7, 5),
             mat: () => new THREE.MeshBasicMaterial({ color: 0xff8030 }),
             trail: { w: 1.0, max: 34, col: 0xff8030 } },
  emissile:{ count: 64,  radius: 1.0, geo: () => { const g = new THREE.ConeGeometry(0.42, 2.1, 6);
             g.rotateX(Math.PI / 2); return g; },
             mat: () => new THREE.MeshBasicMaterial({ color: 0xff5060 }),
             trail: { w: 0.9, max: 30, col: 0xff5060 } },
  // SHARD CANNON — heavy jagged slugs, dense pattern
  shard:   { count: 128, radius: 0.5, geo: () => new THREE.BoxGeometry(0.34, 0.5, 2.2),
             mat: () => new THREE.MeshBasicMaterial({ color: 0xffe08a }),
             trail: { w: 0.5, max: 18, col: 0xffd76a } },
  // VOID MINES — dormant dark sphere, ignites on trigger
  vmine:   { count: 16,  radius: 1.6, geo: () => { const g = new THREE.SphereGeometry(0.9, 10, 8);
             g.scale(1, 1, 0.55); return g; },
             mat: () => new THREE.MeshBasicMaterial({ color: 0x9a4aff }) },
};

/* NEW: shared gradient geometry for tracer streaks. Vertex colors run
   bright at the +Z head to black at the -Z tail, so one additive-blended
   material fades each streak with zero textures and zero per-instance
   buffers — the whole feature costs one extra instanced draw per style. */
let _trailGeo = null;
function trailGeo() {
  if (_trailGeo) return _trailGeo;
  _trailGeo = new THREE.BoxGeometry(1, 1, 1);
  const pos = _trailGeo.attributes.position;
  const cols = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const t = U.clamp(pos.getZ(i) + 0.5, 0, 1);      // 0 tail -> 1 head
    const b = Math.pow(t, 1.7);                      // eased fade-out
    cols[i * 3] = b; cols[i * 3 + 1] = b; cols[i * 3 + 2] = b;
  }
  _trailGeo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return _trailGeo;
}

class ProjPool {
  constructor(scene, key) {
    const s = PROJ_STYLES[key];
    this.key = key; this.count = s.count; this.radius = s.radius;
    this.trail = s.trail || null;
    this.mesh = new THREE.InstancedMesh(s.geo(), s.mat(), s.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    // NEW: tracer streak pass — one extra instanced draw per style,
    // matrices written in the same loop as the bullets (no allocations)
    if (this.trail) {
      this.trailMesh = new THREE.InstancedMesh(trailGeo(),
        new THREE.MeshBasicMaterial({ vertexColors: true, color: this.trail.col,
          transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending,
          depthWrite: false }), s.count);
      this.trailMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      this.trailMesh.frustumCulled = false;
      this.trailMesh.renderOrder = 4;  // blend over the bullets
      scene.add(this.trailMesh);
    }
    this.dummy = new THREE.Object3D();
    this.items = [];
    this.rover = 0;
    for (let i = 0; i < this.count; i++) {
      this.items.push({ active: false, i, pos: new THREE.Vector3(), prev: new THREE.Vector3(),
        vel: new THREE.Vector3(), life: 0, dmg: 0, hp: 0, fuse: 0, aoe: 0, aoeDmg: 0,
        target: null, turn: 0, maxSpeed: 0, trailT: 0, charge: 0 });
      this._hide(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  _hide(i) { this.dummy.position.set(0, 0, 0); this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix(); this.mesh.setMatrixAt(i, this.dummy.matrix);
    if (this.trailMesh) this.trailMesh.setMatrixAt(i, this.dummy.matrix); }
  _hideTrail(i) { if (!this.trailMesh) return;
    this.dummy.position.set(0, 0, 0); this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix(); this.trailMesh.setMatrixAt(i, this.dummy.matrix); }
  // find a free slot (round-robin scan; returns null if saturated — fine,
  // it just means we're past the designed max concurrency)
  alloc() {
    for (let n = 0; n < this.count; n++) {
      const i = (this.rover + n) % this.count;
      if (!this.items[i].active) { this.rover = (i + 1) % this.count; return this.items[i]; }
    }
    return null;
  }
}

const Projectiles = {
  pools: {},

  init(scene) {
    for (const k in PROJ_STYLES) this.pools[k] = new ProjPool(scene, k);
    this._frame = 0;
  },

  /* Fire one projectile.
     style   : PROJ_STYLES key
     owner   : 'player' | 'enemy'
     origin  : THREE.Vector3
     dir     : normalized THREE.Vector3
     opts    : { speed, dmg, life, target?, turn?, maxSpeed?, fuse?, hp?,
                 aoe?, aoeDmg?, charge?, scale? } */
  fire(style, owner, origin, dir, opts) {
    const pool = this.pools[style];
    const it = pool.alloc();
    if (!it) return null;
    it.active = true;
    it.owner = owner;
    it.pos.copy(origin);
    it.prev.copy(origin);
    it.vel.copy(dir).multiplyScalar(opts.speed);
    it.life = opts.life || 3;
    it.dmg = opts.dmg || 1;
    // chassis: central weapon-damage mult for all player fire
    if (owner === 'player' && !it.noStats) {
      const cm = (G.player && G.player.ship && G.player.ship.dmg) || 1;
      it.dmg *= cm;
    }
    it.src = opts.src || null;   // nemesis: which enemy fired this
    it.hp = opts.hp || 0;
    it.fuse = opts.fuse || 0;
    it.aoe = opts.aoe || 0;
    it.aoeDmg = opts.aoeDmg || 0;
    it.target = opts.target || null;
    it.turn = opts.turn || 0;
    it.maxSpeed = opts.maxSpeed || opts.speed;
    it.charge = opts.charge || 0;
    it.scale = opts.scale || 1;
    it.style = style;               // pierce self-retire
    it.pierce = opts.pierce || 0;   // railgun punch-through budget
    it.wave = opts.wave || 0;       // blast-wave speed → dome size
    /* armT (void mines) and knock (shard cannon) are per-style fields —
       reset EVERY mutable field so a recycled slot can't inherit stale state. */
    it.armT = 0;                    // void mine arming timer
    it.knock = opts.knock || 0;     // shard knockback rides the item
    if (it.hitSet) it.hitSet.clear();   // pooled slots reuse — a stale
    it.hitSet = null;                   // hitSet makes reused slugs ghost through targets
    it.noStats = !!opts.noStats;   // CAMPAIGN: pad auto-turret bolts — damage
                                  // enemies like player fire but stay out of
                                  // the player's shotsFired/shotsHit accuracy
    it.trailT = 0;
    /* every segSphere sweep adds this radius — leave it undefined and the
       NaN comparison makes everything a hit */
    it.radius = pool.radius;
    return it;
  },

  reset() {
    for (const k in this.pools) {
      const p = this.pools[k];
      for (const it of p.items) { it.active = false; it.target = null; }
      for (let i = 0; i < p.count; i++) p._hide(i);
      p.mesh.instanceMatrix.needsUpdate = true;
      if (p.trailMesh) p.trailMesh.instanceMatrix.needsUpdate = true;
    }
  },

  activeCount() {
    let n = 0;
    for (const k in this.pools) for (const it of this.pools[k].items) if (it.active) n++;
    return n;
  },

  // adaptive quality: hide tracer trails entirely on weak GPUs without
  // touching in-flight projectile logic
  setTrailsVisible(v) {
    for (const k in this.pools) {
      const p = this.pools[k];
      if (p.trailMesh) p.trailMesh.visible = v;
    }
  },

  /* ------------------------------------------------------------
     Homing steering: rotate the CURRENT velocity direction toward
     the target by up to `turn` radians this frame, and push the
     speed toward maxSpeed. Gives that satisfying corkscrew pursuit.
  ------------------------------------------------------------ */
  _home(it, dt) {
    const t = it.target;
    if (!t || !t.alive || (t.hp !== undefined && t.hp <= 0)) { it.target = null; return; }
    _v1.copy(t.pos).sub(it.pos);   // dir to target
    const dist = _v1.length();
    if (dist < 1e-4) return;
    _v1.multiplyScalar(1 / dist);                     // dir to target
    const sp = it.vel.length();
    if (sp < 1e-4) return;
    _v2.copy(it.vel).multiplyScalar(1 / sp);          // current dir
    const cosA = U.clamp(_v2.dot(_v1), -1, 1);
    const ang = Math.acos(cosA);
    if (ang > 1e-4) {
      const step = Math.min(ang, it.turn * dt);
      _v3.crossVectors(_v2, _v1);
      /* at the anti-parallel pole the cross product vanishes — pick ANY
         perpendicular axis (all of them reduce the angle). The ang > 0.5
         gate keeps the already-on-target case a no-op. */
      if (_v3.lengthSq() < 1e-6 && ang > 0.5)
        _v3.crossVectors(_v2, Math.abs(_v2.y) < 0.9 ? UP : FWD);
      if (_v3.lengthSq() > 1e-9) {
        _v3.normalize();
        _q1.setFromAxisAngle(_v3, step);
        _v2.applyQuaternion(_q1);
        it.vel.copy(_v2).multiplyScalar(sp);
      }
    }
    // accelerate toward cruise speed — but bleed speed in the terminal
    // phase: a limited-turn seeker at full 400 u/s can only fly a ~118u
    // circle, so it orbited agile prey at ~50-120u standoff without ever
    // touching the 3u hit sphere. Slowing inside ~100u shrinks the turn
    // spiral until the proximity fuse below can catch the flyby.
    const ns = Math.min(it.maxSpeed, sp + 160 * dt, Math.max(110, 100 + dist * 1.5));
    it.vel.multiplyScalar(ns / sp);
  },

  _updatePool(pool, dt, isPlayer, inert) {
    const d = this._dummy;
    for (const it of pool.items) {
      if (!it.active) continue;
      it.life -= dt;
      if (it.life <= 0) { it.active = false; pool._hide(it.i); continue; }

      it.prev.copy(it.pos);
      if (it.turn > 0 && it.target) this._home(it, dt);
      it.pos.addScaledVector(it.vel, dt);

      // smoke/fire trails for both missile flavors
      if (pool.key === 'missile' || pool.key === 'emissile') {
        it.trailT -= dt;
        while (it.trailT <= 0) { FX.missileTrail(it.pos); it.trailT += 0.02; }
      }

      // write instance transform: position + oriented along velocity.
      // (Object3D.lookAt points non-camera objects down +Z — exactly what
      //  our elongated geometries want.) Void mines tumble in place
      //  instead of orienting along their near-zero drift velocity.
      d.position.copy(it.pos);
      const sp2 = it.vel.lengthSq();
      if (pool.key === 'vmine') {
        d.rotation.set(it.age = (it.age || 0) + dt * 0.9, it.age * 0.6, 0);
      } else if (sp2 > 1e-6) { _v4.copy(it.pos).add(it.vel); d.lookAt(_v4); }
      d.scale.setScalar(it.scale);
      d.updateMatrix();
      pool.mesh.setMatrixAt(it.i, d.matrix);

      // NEW: tracer streak — reuses the orientation set above, stretched
      // from just behind the bullet back along its velocity. Gradient
      // vertex colors fade the tail; additive blending keeps it cheap.
      if (pool.trailMesh) {
        const sp = Math.sqrt(sp2);
        const len = Math.min(pool.trail.max, sp * CFG.render.trailTime);
        if (len > 0.6) {
          _v6.copy(it.vel).multiplyScalar(1 / (sp || 1));
          d.position.addScaledVector(_v6, -(len * 0.5 + 1));
          d.scale.set(pool.trail.w, pool.trail.w, len);
          d.updateMatrix();
          pool.trailMesh.setMatrixAt(it.i, d.matrix);
        } else pool._hideTrail(it.i);
      }

      /* ---- collision ---- */
      let dead = false;
      if (inert) {
        // VOID MINES: no impact collision — arming/proximity/detonation is
        // owned by Player._updateVoidMines (per-mine lists + chaining).
      } else if (isPlayer) dead = this._collidePlayerShot(it, pool);
      else dead = this._collideEnemyShot(it, dt);
      if (dead) { it.active = false; pool._hide(it.i); continue; }

      /* NEW: seeker proximity fuse. Even with terminal slowdown, a
         limited-turn missile occasionally blitzes PAST its prey just
         outside the direct-hit sphere. Popping the warhead inside the
         arming radius converts that flyby into splash damage instead of
         a wasted missile circling until fuel runs out. Covers both
         flavors (player seeker aoe 27 / boss emissile aoe 14). */
      if ((pool.key === 'missile' || pool.key === 'emissile') && it.target && it.aoe > 0 &&
          it.pos.distanceToSquared(it.target.pos) < it.aoe * it.aoe * 0.16) {
        it.active = false;
        pool._hide(it.i);
        this._explode(it.pos, it.aoe, it.aoeDmg, !isPlayer, isPlayer);
        continue;
      }
    }
    pool.mesh.instanceMatrix.needsUpdate = true;
    if (pool.trailMesh) pool.trailMesh.instanceMatrix.needsUpdate = true;
  },

  /* player projectiles vs: enemies (incl. boss weak points), enemy
     missiles (they can be shot down!), asteroids, static colliders */
  _collidePlayerShot(it, pool) {
    const enemies = G.enemies.list;
    /* UPGRADE: `pierce` — railgun slugs punch through up to N enemies
       along their swept path instead of stopping at the first hit. Each
       hit marks the enemy in it.hitSet so a multi-frame overlap can't
       hit the same hull twice. */
    if (it.pierce > 0 && !it.hitSet) it.hitSet = new Set();
    // CHEATS: one-shot kills — every player round becomes a lethal hit
    const dmg = (G.cheats && G.cheats.oneShot && !it.noStats) ? 1e9 : it.dmg;
    let stopped = false;
    for (let e = enemies.length - 1; e >= 0; e--) {
      const en = enemies[e];
      if (!en.alive) continue;
      if (it.hitSet && it.hitSet.has(en)) continue;
      const spheres = en.hitSpheres || null;
      if (spheres) {
        // boss-style multi-sphere target
        for (const hs of spheres) {
          if (!hs.alive) continue;
          if (segSphere(it.prev.x, it.prev.y, it.prev.z, it.pos.x, it.pos.y, it.pos.z,
              hs.world.x, hs.world.y, hs.world.z, hs.r + it.radius, _v5) >= 0) {
            en.damagePart(hs, dmg, _v5, it.vel);
            FX.hit(_v5, 5);
            if (!it.noStats) { G.audio.hit(); G.player.shotsHit++; G.hud.hitmark(false); }
            else G.audio.hit();
            // wave speed scales the FX pressure dome
            this._explode(it.pos, it.aoe, it.aoeDmg, false, true, it.wave);
            if (it.pierce > 0) { this._markPierce(it, en); return false; }
            return true;
          }
        }
      } else {
        if (segSphere(it.prev.x, it.prev.y, it.prev.z, it.pos.x, it.pos.y, it.pos.z,
            en.pos.x, en.pos.y, en.pos.z, en.radius + it.radius, _v5) >= 0) {
          const died = en.damage(dmg, _v5, it.vel, true); // byPlayer: mines "safe" when popped by the shooter
          // per-shot knockback; bosses are mass-locked
          if (it.knock > 0 && en.vel && en.type !== 'boss') {
            _v6.copy(it.vel).normalize();
            en.vel.addScaledVector(_v6, it.knock);
          }
          // shard momentum burst: 4+ pellets on any target stack a
          // damage multiplier on the next spray (see Player)
          if (pool && pool.key === 'shard' && G.player && G.player.registerShardHit) G.player.registerShardHit(en);
          FX.hit(_v5, died ? 10 : 5);
          if (!it.noStats) { G.audio.hit(); G.player.shotsHit++; G.hud.hitmark(died); }
          else G.audio.hit();
          this._explode(it.pos, it.aoe, it.aoeDmg, false, true, it.wave);
          // pierce continues through the kill
          if (it.pierce > 0) { this._markPierce(it, en); return false; }
          return true;
        }
      }
    }
    if (stopped) return true;
    // vs enemy homing missiles (interception — very satisfying)
    const em = this.pools.emissile;
    for (const m of em.items) {
      if (!m.active) continue;
      if (segSphere(it.prev.x, it.prev.y, it.prev.z, it.pos.x, it.pos.y, it.pos.z,
          m.pos.x, m.pos.y, m.pos.z, 1.6 + it.radius, _v5) >= 0) {
        m.active = false; em._hide(m.i);
        this._explode(m.pos, 8, 0, false, true);
        G.game.addScore(25, m.pos, '');
        FX.hit(_v5, 8);
        G.audio.hit();
        return true;
      }
    }
    // vs world (staggered for perf: half the bolts each frame)
    if ((it.i + this._frame) % CFG.world.projAsteroidChecks === 0 &&
        G.world.asteroids.sweptHit(it.prev, it.pos, it.radius, _v5)) {
      FX.hit(_v5, 4);
      if (it.aoe > 0) this._explode(it.pos, it.aoe, it.aoeDmg, false, true, it.wave);
      return true;
    }
    if (G.world.staticSwept(it.prev, it.pos, it.radius, _v5)) { FX.hit(_v5, 4); return true; }
    return false;
  },

  /* UPGRADE: pierce bookkeeping for the railgun — remember the hull we
     just punched through; retire the slug once its pierce budget is spent. */
  _markPierce(it, en) {
    it.hitSet.add(en);
    it.pierce--;
    if (it.pierce <= 0) {
      const pool = this.pools[it.style];
      it.active = false;
      if (pool) pool._hide(it.i);
    }
  },

  /* enemy projectiles vs: player, escort ally, world */
  _collideEnemyShot(it, dt) {
    const p = G.player;
    if (p.alive && G.game.state === 'playing') {
      if (segSphere(it.prev.x, it.prev.y, it.prev.z, it.pos.x, it.pos.y, it.pos.z,
          p.pos.x, p.pos.y, p.pos.z, CFG.combat.playerRadius + it.radius, _v5) >= 0) {
        // AoE payload: direct hits detonate for the splash too (a flak
        // direct hit is pure AoE — pure-damage would do nothing)
        // hurt through the blast itself; direct-damage shells don't
        // double-dip the player (hurtPlayer=false), they splash allies/etc.
        if (it.dmg > 0) p.damage(it.dmg, _v5, false, it.src || null);
        const rad = it.aoe > 0 ? it.aoe : (it.aoeDmg > 0 ? 12 : 0);
        if (rad > 0) this._explode(it.pos, rad, it.aoeDmg, it.dmg <= 0);
        return true;
      }
    }
    /* CAMPAIGN (phase 1): bolts that miss the ship but strike the pad
       structure chew on the launch pod instead — the pod is the phase's
       real health bar (the ship itself is armored while parked). */
    if (G.campaign && G.campaign.phase === 1 && G.campaign.padSphere) {
      const ps = G.campaign.padSphere;
      if (segSphere(it.prev.x, it.prev.y, it.prev.z, it.pos.x, it.pos.y, it.pos.z,
          ps.x, ps.y, ps.z, ps.r + it.radius, _v5) >= 0) {
        G.campaign.damagePod(it.dmg * 0.7, _v5);
        FX.hit(_v5, 4);
        return true;
      }
    }
    const ally = G.waves && G.waves.ally;
    if (ally && ally.alive) {
      if (segSphere(it.prev.x, it.prev.y, it.prev.z, it.pos.x, it.pos.y, it.pos.z,
          ally.pos.x, ally.pos.y, ally.pos.z, ally.radius + it.radius, _v5) >= 0) {
        ally.damage(it.dmg, _v5);
        FX.hit(_v5, 6);
        return true;
      }
    }
    // proximity fuse: flak shells detonate when they get NEAR the player
    if (it.fuse > 0) {
      it.fuse -= dt;
      if (it.fuse <= 0 || p.alive && it.pos.distanceToSquared(p.pos) < 900) {
        this._explode(it.pos, 16, it.aoeDmg, true);
        return true;
      }
    }
    // vs world (staggered for perf: half the bolts each frame — same
    // treatment the player bolts already got)
    if ((it.i + this._frame) % CFG.world.projAsteroidChecks === 0 &&
        G.world.asteroids.sweptHit(it.prev, it.pos, it.radius, _v5)) { FX.hit(_v5, 3); return true; }
    if (G.world.staticSwept(it.prev, it.pos, it.radius, _v5)) { FX.hit(_v5, 3); return true; }
    return false;
  },

  /* AoE: hurts enemies (falloff), player, ally, and cracks asteroids.
     NEW friendly=true marks player-made blasts: they spare the escort
     ally, and they "safe" any mine they chain into (see Mine.damage). */
  _explode(pos, radius, dmg, hurtPlayer, friendly, wave) {
    FX.explosion(pos, Math.min(18, radius * 0.55));
    // AoE pops spawn a proportional 3D pressure dome (mid-size+ bursts)
    if (radius >= 8) {
      FX.shockwaves.spawn(pos, Math.min(radius * 1.4, 100), wave === 620 ? 0xbfe8ff : 0xffb060,
        0.4 + Math.min(radius, 40) * 0.014);
    }
    G.audio.explosion(radius * 0.3);
    const enemies = G.enemies.list;
    for (let e = enemies.length - 1; e >= 0; e--) {
      const en = enemies[e];
      if (!en.alive) continue;
      const d = en.pos.distanceTo(pos);
      if (d < radius + en.radius) {
        const f = 1 - U.clamp(d / (radius + en.radius), 0, 1);
        en.damage(dmg * f, en.pos, null, friendly);
      }
    }
    G.world.asteroids.explosionDamage(pos, radius, dmg * 0.6);
    // friendly blasts shove enemies radially
    if (friendly && CFG.features.hazardWeapons && CFG.hazards.enemyKnockShove) {
      for (const en of enemies) {
        if (!en.alive || en.type === 'boss') continue;
        const d = en.pos.distanceTo(pos);
        if (d < radius + en.radius && d > 0.01) {
          _v6.copy(en.pos).sub(pos).multiplyScalar(1 / d);
          en.vel.addScaledVector(_v6, 18 * CFG.hazards.enemyKnockShove * (1 - d / (radius + en.radius)));
        }
      }
    }
    if (hurtPlayer) {
      /* CAMPAIGN (phase 1): enemy blasts splash onto the pod, not the
         parked (invulnerable-by-routing) ship. */
      if (G.campaign && G.campaign.phase === 1 && G.campaign.padSphere) {
        const ps = G.campaign.padSphere;
        const pd = Math.sqrt((pos.x - ps.x) ** 2 + (pos.y - ps.y) ** 2 + (pos.z - ps.z) ** 2);
        if (pd < ps.r) G.campaign.damagePod(dmg * (1 - pd / ps.r), pos);
      } else if (G.player.alive) {
        const d = G.player.pos.distanceTo(pos);
        if (d < radius) G.player.damage(dmg * (1 - d / radius), pos);
      }
    }
    // blast impulse: explosions shove the player radially — friendly
    // blasts are a rideable boost, hostile ones knock you off your line
    if (G.player.alive && G.campaign && G.campaign.phase !== 1) {
      const d = G.player.pos.distanceTo(pos);
      const rr = Math.max(radius, 14);
      if (d < rr) {
        const f = Math.pow(1 - d / rr, 0.8);                 // proximity falloff
        _v6.copy(G.player.pos).sub(pos);
        if (_v6.lengthSq() > 1e-4) _v6.multiplyScalar(1 / _v6.length());
        const k = friendly ? 200 : 70;
        G.player.vel.addScaledVector(_v6, k * f * (0.5 + radius * 0.03));
      }
    }
    const ally = G.waves && G.waves.ally;
    if (ally && ally.alive && dmg > 0 && !friendly) { // your own AoE spares the escort
      const d = ally.pos.distanceTo(pos);
      if (d < radius) ally.damage(dmg * (1 - d / radius), pos);
    }
  },

  update(dt) {
    this._frame++;
    this._dummy = this._dummy || new THREE.Object3D();
    this._updatePool(this.pools.bolt, dt, true);
    this._updatePool(this.pools.lance, dt, true);
    this._updatePool(this.pools.missile, dt, true);
    this._updatePool(this.pools.rail, dt, true);
    this._updatePool(this.pools.shard, dt, true);
    this._updatePool(this.pools.ebolt, dt, false);
    this._updatePool(this.pools.eheavy, dt, false);
    this._updatePool(this.pools.emissile, dt, false);
    this._updatePool(this.pools.vmine, dt, true, true);   // inert: drifts only, armed by Player._updateVoidMines
  },
};

/* ============================================================
   [SECTION 7] WORLD — sky, planets, asteroid field, stations
   ------------------------------------------------------------
   Every texture is painted onto a <canvas> at boot and uploaded
   as a THREE.CanvasTexture. No image files anywhere.
============================================================ */

/* ---------- tiny value-noise / fBm for texture painting ---------- */
function _hash2(x, y) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}
function noise2(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  return U.lerp(
    U.lerp(_hash2(xi, yi), _hash2(xi + 1, yi), u),
    U.lerp(_hash2(xi, yi + 1), _hash2(xi + 1, yi + 1), u), v);
}
function fbm(x, y, oct) {
  let a = 0.5, f = 1, sum = 0;
  for (let i = 0; i < oct; i++) { sum += a * noise2(x * f, y * f); f *= 2; a *= 0.5; }
  return sum;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function canvasTex(c) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = (typeof G !== 'undefined' && G.renderer)
    ? Math.min(8, G.renderer.capabilities.getMaxAnisotropy()) : 4;
  return t;
}

/* ---------- planet texture painters ---------- */
function paintGasGiant(palette) {
  const c = makeCanvas(1024, 512), ctx = c.getContext('2d');
  for (let y = 0; y < 512; y++) {
    // band value: stacked sines + fbm turbulence = swirling latitudinal bands
    const n = fbm(0.3, y * 0.045, 4);
    const band = 0.5 + 0.28 * Math.sin(y * 0.055 + n * 7.5)
                      + 0.14 * Math.sin(y * 0.021 + 1.7)
                      + 0.08 * Math.sin(y * 0.11 + 4.0);
    const k = U.clamp(band, 0, 1);
    const i0 = U.clamp(Math.floor(k * (palette.length - 1)), 0, palette.length - 2);
    const t = k * (palette.length - 1) - i0;
    const A = palette[i0], B = palette[i0 + 1];
    ctx.fillStyle = `rgb(${(U.lerp(A[0], B[0], t)) | 0},${(U.lerp(A[1], B[1], t)) | 0},${(U.lerp(A[2], B[2], t)) | 0})`;
    ctx.fillRect(0, y, 1024, 1);
  }
  // streaky turbulence overlay (drawn as soft horizontal smears)
  ctx.globalAlpha = 0.06;
  for (let i = 0; i < 340; i++) {
    const y = U.randi(0, 511), len = U.randi(60, 500), x = U.randi(0, 1023);
    ctx.fillStyle = Math.random() > 0.5 ? '#ffffff' : '#000000';
    ctx.fillRect(x, y, len, U.randi(1, 3));
  }
  ctx.globalAlpha = 1;
  // darker poles
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, 'rgba(0,0,0,.5)'); g.addColorStop(0.18, 'rgba(0,0,0,0)');
  g.addColorStop(0.82, 'rgba(0,0,0,0)'); g.addColorStop(1, 'rgba(0,0,0,.5)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 1024, 512);
  return canvasTex(c);
}

function paintRocky(base, mid, high) {
  const c = makeCanvas(512, 256), ctx = c.getContext('2d');
  const img = ctx.createImageData(512, 256), d = img.data;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
    const n = fbm(x * 0.02, y * 0.02, 5);
    const n2 = fbm(x * 0.09 + 40, y * 0.09, 3);
    let k = U.clamp(n * 1.25 - 0.15 + n2 * 0.15, 0, 1);
    const i = (y * 512 + x) * 4;
    d[i] = U.lerp(base[0], high[0], k) * (0.75 + 0.25 * n2);
    d[i + 1] = U.lerp(base[1], high[1], k);
    d[i + 2] = U.lerp(base[2], high[2], k);
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasTex(c);
}

function paintIce() {
  const c = makeCanvas(512, 256), ctx = c.getContext('2d');
  const img = ctx.createImageData(512, 256), d = img.data;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
    const n = fbm(x * 0.025, y * 0.05, 4);
    const i = (y * 512 + x) * 4;
    d[i] = 150 + n * 95; d[i + 1] = 195 + n * 55; d[i + 2] = 235; d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  // surface cracks: random-walk dark polylines
  ctx.strokeStyle = 'rgba(40,80,120,.55)'; ctx.lineWidth = 1;
  for (let i = 0; i < 26; i++) {
    let x = U.rand(0, 512), y = U.rand(0, 256);
    ctx.beginPath(); ctx.moveTo(x, y);
    for (let s = 0; s < 14; s++) { x += U.rand(-22, 22); y += U.rand(-9, 9); ctx.lineTo(x, y); }
    ctx.stroke();
  }
  return canvasTex(c);
}

function paintTerran() {
  const c = makeCanvas(512, 256), ctx = c.getContext('2d');
  const img = ctx.createImageData(512, 256), d = img.data;
  for (let y = 0; y < 256; y++) for (let x = 0; x < 512; x++) {
    // continents where fbm crosses a threshold; latitude tweaks climate
    const n = fbm(x * 0.014, y * 0.014, 5) + 0.18 * Math.sin(y * 0.05);
    const i = (y * 512 + x) * 4;
    if (n > 0.52) { // land
      const k = U.clamp((n - 0.52) * 5, 0, 1);
      d[i] = 40 + k * 60; d[i + 1] = 75 + k * 70; d[i + 2] = 45 + k * 40;
    } else {        // ocean
      const k = U.clamp(n * 2.4, 0, 1);
      d[i] = 10 + k * 20; d[i + 1] = 45 + k * 55; d[i + 2] = 90 + k * 80;
    }
    if (y < 26 || y > 232) { d[i] = 225; d[i + 1] = 235; d[i + 2] = 245; } // ice caps
    d[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return canvasTex(c);
}

/* city lights: dark canvas + warm speckle clusters (matches continents
   loosely by seeding clusters from the same fbm — good enough at distance) */
function paintCityLights() {
  const c = makeCanvas(512, 256), ctx = c.getContext('2d');
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 512, 256);
  for (let i = 0; i < 130; i++) {
    const x = U.rand(0, 512), y = U.rand(30, 225);
    const n = fbm(x * 0.014, y * 0.014, 5) + 0.18 * Math.sin(y * 0.05);
    if (n <= 0.52) continue;              // only on "land"
    const cluster = U.randi(6, 26);
    for (let j = 0; j < cluster; j++) {
      ctx.fillStyle = `rgba(255,${(200 + U.randi(0, 50)) | 0},${(110 + U.randi(0, 70)) | 0},${U.rand(0.35, 1)})`;
      ctx.fillRect(x + U.rand(-9, 9), y + U.rand(-5, 5), 1.4, 1.4);
    }
  }
  return canvasTex(c);
}

/* ring texture: 1D radial gradient strip with noisy band gaps */
function paintRing(a, b) {
  const c = makeCanvas(256, 8), ctx = c.getContext('2d');
  const img = ctx.createImageData(256, 8), d = img.data;
  for (let x = 0; x < 256; x++) {
    const n = fbm(x * 0.09, 0.5, 4);
    let alpha = U.clamp(0.75 * Math.sin(Math.PI * x / 256) * (0.55 + n), 0, 1);
    if (fbm(x * 0.35, 3.5, 3) > 0.62) alpha *= 0.15;   // gaps (Cassini-ish)
    for (let y = 0; y < 8; y++) {
      const i = (y * 256 + x) * 4;
      d[i] = a[0]; d[i + 1] = a[1]; d[i + 2] = a[2]; d[i + 3] = (alpha * 255) | 0;
    }
  }
  ctx.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/* soft radial blob for nebulae / sun glow */
function paintGlow(hexInner, hexOuter) {
  const c = makeCanvas(256, 256), ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 8, 128, 128, 126);
  g.addColorStop(0, hexInner);
  g.addColorStop(0.35, hexOuter);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(c);
}

/* ---------- planet factory ---------- */
function addPlanet(opts) {
  const group = new THREE.Group();
  group.position.copy(opts.pos);
  const geo = new THREE.SphereGeometry(opts.radius, 48, 32);
  const mat = new THREE.MeshStandardMaterial({
    map: opts.map, roughness: 0.94, metalness: 0.02,
    bumpMap: opts.bump ? opts.map : null, bumpScale: opts.bump || 0,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.z = opts.tilt || 0;
  group.add(mesh);

  // city-light shell: additive shader whose brightness is gated by the
  // dot(worldNormal, sunDir) — lights only show on the NIGHT hemisphere
  if (opts.cityMap) {
    const cityMat = new THREE.ShaderMaterial({
      uniforms: { uSunDir: { value: G.world.sunDir }, uMap: { value: opts.cityMap } },
      vertexShader: `
        varying vec3 vWN; varying vec2 vUv;
        void main(){
          vWN = normalize(mat3(modelMatrix) * normal);
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 uSunDir; uniform sampler2D uMap;
        varying vec3 vWN; varying vec2 vUv;
        void main(){
          float night = smoothstep(0.08, -0.22, dot(normalize(vWN), uSunDir));
          vec3 c = texture2D(uMap, vUv).rgb;
          gl_FragColor = vec4(c * night * 1.7, 1.0); // additive: alpha=1, rgb premultiplied by night
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    const shell = new THREE.Mesh(new THREE.SphereGeometry(opts.radius * 1.001, 48, 32), cityMat);
    shell.rotation.z = mesh.rotation.z;
    group.add(shell);
    // keep shell rotation synced with the planet spin below
    G.world.syncPairs.push({ a: mesh, b: shell });
  }

  // thin atmosphere rim (fresnel shell — glows at the limb, black at center)
  if (opts.atmo) {
    const atmoMat = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(opts.atmo) } },
      vertexShader: `
        varying vec3 vN; varying vec3 vV;
        void main(){
          vN = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vV = normalize(-mv.xyz);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        uniform vec3 uColor; varying vec3 vN; varying vec3 vV;
        void main(){
          float rim = pow(1.0 - abs(dot(vN, vV)), 3.2);
          gl_FragColor = vec4(uColor * rim * 1.25, rim);
        }`,
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.FrontSide,
    });
    group.add(new THREE.Mesh(new THREE.SphereGeometry(opts.radius * 1.045, 48, 32), atmoMat));
  }

  // ring system — RingGeometry UVs are planar; remap them to (r, 0.5) so
  // the strip texture reads out radially
  if (opts.ring) {
    const inner = opts.radius * 1.5, outer = opts.radius * 2.35;
    const rgeo = new THREE.RingGeometry(inner, outer, 96, 1);
    const uv = rgeo.attributes.uv, pos = rgeo.attributes.position;
    for (let i = 0; i < uv.count; i++) {
      const r = Math.sqrt(pos.getX(i) * pos.getX(i) + pos.getY(i) * pos.getY(i));
      uv.setXY(i, (r - inner) / (outer - inner), 0.5);
    }
    const rmat = new THREE.MeshBasicMaterial({ map: opts.ring, transparent: true,
      side: THREE.DoubleSide, depthWrite: false, opacity: 0.9 });
    const rmesh = new THREE.Mesh(rgeo, rmat);
    rmesh.rotation.x = Math.PI / 2 + (opts.ringTilt || 0.25);
    group.add(rmesh);
    group.userData.ringMesh = rmesh;
  }

  G.scene.add(group);
  const planet = { group, mesh, opts, spin: opts.spin || 0.004 };
  G.world.planets.push(planet);
  // collision proxy (generous — nobody should be flying into these anyway)
  G.world.colliders.push({ x: opts.pos.x, y: opts.pos.y, z: opts.pos.z, r: opts.radius * 1.05, planet: true });
  return planet;
}

/* ---------- sky: gradient dome + nebula sprites + star layers ---------- */
function buildSky() {
  // gradient dome (deepest background tone)
  const domeMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false,
    uniforms: {},
    vertexShader: `varying vec3 vP; void main(){ vP = position;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vP;
      void main(){
        float h = normalize(vP).y * 0.5 + 0.5;
        vec3 lo = vec3(0.008, 0.010, 0.020);
        vec3 hi = vec3(0.020, 0.028, 0.050);
        vec3 c = mix(lo, hi, h);
        c += vec3(0.012, 0.004, 0.014) * (1.0 - abs(normalize(vP).y)); // faint horizon warmth
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const dome = new THREE.Mesh(new THREE.SphereGeometry(16000, 24, 12), domeMat);
  dome.frustumCulled = false;
  dome.renderOrder = -100;
  G.scene.add(dome);

  // nebula sprites — big additive blobs at extreme distance for depth
  const nebColors = ['#0f3a46', '#3a1040', '#141a4a', '#4a2410', '#123042', '#2a1448'];
  for (let i = 0; i < 9; i++) {
    const col = nebColors[i % nebColors.length];
    // inner stop = color, outer stop = same color with 00 alpha (8-digit hex)
    const mat = new THREE.SpriteMaterial({
      map: paintGlow(col, col + '00'),
      blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
      opacity: U.rand(0.14, 0.3), rotation: U.rand(0, 6.28),
    });
    const spr = new THREE.Sprite(mat);
    U.randomDir(_v1).multiplyScalar(U.rand(8500, 11500));
    spr.position.copy(_v1);
    spr.scale.setScalar(U.rand(3200, 6800));
    G.scene.add(spr);
    G.world.nebulae.push(spr);
  }

  // three parallax star layers (different shells => subtle depth cues)
  const starLayer = (count, rMin, rMax, size, tint) => {
    const pos = new Float32Array(count * 3), col = new Float32Array(count * 3),
          siz = new Float32Array(count), tw = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      U.randomDir(_v1).multiplyScalar(U.rand(rMin, rMax));
      pos[i * 3] = _v1.x; pos[i * 3 + 1] = _v1.y; pos[i * 3 + 2] = _v1.z;
      // temperature tint: mostly white, some blue, some warm
      const t = Math.random();
      let r = 1, g = 1, b = 1;
      if (t < 0.28) { r = 0.72; g = 0.82; b = 1; }
      else if (t < 0.5) { r = 1; g = 0.87; b = 0.72; }
      col[i * 3] = r * tint; col[i * 3 + 1] = g * tint; col[i * 3 + 2] = b * tint;
      siz[i] = size * U.rand(0.6, 1.5);
      tw[i] = Math.random();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('aColor', new THREE.BufferAttribute(col, 3));
    geo.setAttribute('aSize', new THREE.BufferAttribute(siz, 1));
    geo.setAttribute('aTw', new THREE.BufferAttribute(tw, 1));
    const mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 }, uTime: { value: 0 }, uOpacity: { value: 0.9 } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aTw;
        uniform float uScale; uniform float uTime;
        varying vec3 vColor; varying float vA;
        void main(){
          vColor = aColor;
          vA = 0.75 + 0.35 * sin(uTime * (0.4 + aTw * 2.2) + aTw * 41.0);  // twinkle
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = min(aSize * (uScale / max(1.0, -mv.z)), 5.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vA; uniform float uOpacity;
        void main(){
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(uv, uv);
          if (r2 > 1.0) discard;
          gl_FragColor = vec4(vColor, vA * uOpacity * (1.0 - r2));
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    const pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    G.scene.add(pts);
    G.world.starLayers.push(pts);
  };
  starLayer(900, 5200, 6400, 55, 1.0);
  starLayer(1600, 7200, 8800, 40, 0.85);
  starLayer(2600, 9500, 12000, 30, 0.65);

  // the sun itself: layered additive sprites + the directional light
  const sunDir = new THREE.Vector3(0.55, 0.35, -0.75).normalize();
  G.world.sunDir = sunDir;
  const core = new THREE.Sprite(new THREE.SpriteMaterial({ map: paintGlow('#ffffff', '#ffe9b0'),
    blending: THREE.AdditiveBlending, depthWrite: false }));
  core.position.copy(sunDir).multiplyScalar(13500);
  core.scale.setScalar(1300);
  G.scene.add(core);
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: paintGlow('rgba(255,220,160,0.8)', 'rgba(255,180,90,0)'),
    blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.5 }));
  halo.position.copy(core.position);
  halo.scale.setScalar(3400);
  G.scene.add(halo);

  const dir = new THREE.DirectionalLight(0xfff2df, 1.35);
  dir.position.copy(sunDir);
  G.scene.add(dir);
  G.scene.add(new THREE.HemisphereLight(0x2a3550, 0x0a0c12, 0.55));
}

/* ============================================================
   [SECTION 7b] ASTEROID FIELD / STATIONS / DUST / WORLD FACADE
   ------------------------------------------------------------
   ~420 tumbling rocks across THREE InstancedMeshes (3 geometry
   variants x 2 tints). Simulation state lives in typed arrays;
   per-frame we recompose each rock's 4x4 and re-upload — that's
   ~420 matrix writes, far cheaper than 420 draw calls.
============================================================ */
class AsteroidField {
  constructor(scene, count) {
    this.count = count;
    // ---- state (SoA) ----
    this.ax = new Float32Array(count); this.ay = new Float32Array(count); this.az = new Float32Array(count);
    this.ar = new Float32Array(count);      // radius
    this.hp = new Float32Array(count);
    this.dead = new Uint8Array(count);
    this.quats = []; this.spinAxis = []; this.spinSpd = new Float32Array(count);
    // which InstancedMesh + instance index each rock belongs to
    this.mIdx = new Uint8Array(count); this.iIdx = new Uint16Array(count);

    // ---- three instanced meshes (visual variety without draw-call cost) ----
    const variants = [];
    for (let v = 0; v < 3; v++) {
      const geo = new THREE.IcosahedronGeometry(1, 1);
      displaceVertices(geo, 0.42 + v * 0.12, v * 7 + 3);
      variants.push(geo);
    }
    const mats = [
      new THREE.MeshStandardMaterial({ color: 0x6a6258, roughness: 0.95, metalness: 0.1, flatShading: true }),
      new THREE.MeshStandardMaterial({ color: 0x59504a, roughness: 0.98, metalness: 0.05, flatShading: true }),
    ];
    this.meshes = [];
    for (let v = 0; v < 3; v++) {
      const per = Math.ceil(count / 3) + 8;
      const m = new THREE.InstancedMesh(variants[v], mats[v % 2], per);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false;
      scene.add(m);
      this.meshes.push({ mesh: m, used: 0, dummy: new THREE.Object3D() });
    }

    // ---- distribution extracted (see scatterBelt / scatterCorridor) so the
    // campaign phases can re-scatter the SAME instanced meshes: belt for
    // arena play, a denser local field along the ascent corridor otherwise.
    // No parallel system — same typed arrays, same draw calls. ----
    this._q = new THREE.Quaternion();
    this._capacity = count;
    this.scatterBelt();
  }

  /* CAMPAIGN: shared scatter bookkeeping — hides whatever instances the
     previous layout was using beyond the new live count. */
  _finishScatter(placed) {
    for (let i = placed; i < this._capacity; i++) {
      this.mIdx[i] = i % 3;
      this.iIdx[i] = this.meshes[i % 3].used++;
      this.dead[i] = 1;            // outside count => never queried/rendered
      this._writeMatrix(i);        // scale 0
    }
    this.count = placed;
    for (const s of this.meshes) s.mesh.instanceMatrix.needsUpdate = true;
  }

  /* arena belt: clumpy ring around the origin (the original layout) */
  scatterBelt() {
    const clumps = [];
    for (let c = 0; c < 15; c++) {
      const a = U.rand(0, U.TAU), rad = U.rand(420, 1500);
      clumps.push(new THREE.Vector3(Math.cos(a) * rad, U.rand(-160, 160), Math.sin(a) * rad));
    }
    for (const s of this.meshes) s.used = 0;
    this.dead.fill(0);
    let placed = 0, guard = 0;
    while (placed < this._capacity && guard++ < this._capacity * 30) {
      let p;
      if (Math.random() < 0.62) {
        const c = U.pick(clumps);
        p = new THREE.Vector3(c.x + U.rand(-130, 130), c.y + U.rand(-70, 70), c.z + U.rand(-130, 130));
      } else {
        const a = U.rand(0, U.TAU), rad = U.rand(330, 1600);
        p = new THREE.Vector3(Math.cos(a) * rad, U.rand(-260, 260), Math.sin(a) * rad);
      }
      if (p.length() < 240) continue;                    // keep the spawn bubble clear
      if (Math.abs(p.x - 900) < 120 && Math.abs(p.z + 700) < 120) continue;  // station clearance
      const r = U.rand(2.5, 26) * (Math.random() < 0.12 ? 1.9 : 1);
      const i = placed++;
      this.ax[i] = p.x; this.ay[i] = p.y; this.az[i] = p.z; this.ar[i] = r;
      this.hp[i] = r * 3.2;
      this.quats[i] = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(U.rand(0, 6.3), U.rand(0, 6.3), U.rand(0, 6.3)));
      this.spinAxis[i] = U.randomDir(new THREE.Vector3());
      this.spinSpd[i] = U.rand(0.05, 0.55) / Math.max(1, r * 0.12); // big rocks tumble slower
      const slot = this.meshes[placed % 3];
      this.mIdx[i] = placed % 3; this.iIdx[i] = slot.used++;
      this._writeMatrix(i);
    }
    this._finishScatter(placed);
  }

  /* CAMPAIGN ascent corridor: redistribute the same rocks along a spline
     path — ~45% sit inside the flight tube as dodge hazards, the rest ring
     the corridor walls. Smaller radii, denser feel. */
  scatterCorridor(pts, tubeR, targetCount) {
    for (const s of this.meshes) s.used = 0;
    this.dead.fill(0);
    const total = Math.min(this._capacity, targetCount || 300);
    const perp = new THREE.Vector3(), side = new THREE.Vector3(), dir = new THREE.Vector3();
    let placed = 0, guard = 0;
    while (placed < total && guard++ < total * 40) {
      const idx = Math.floor(U.rand(0.08, 0.97) * (pts.length - 1));
      const c = pts[idx];
      dir.copy(pts[Math.min(idx + 1, pts.length - 1)]).sub(c);
      if (dir.lengthSq() < 1e-6) dir.set(0, 0, -1);
      dir.normalize();
      // two perpendicular axes around the path tangent
      perp.set(U.rand(-1, 1), U.rand(-1, 1), U.rand(-1, 1)).cross(dir);
      if (perp.lengthSq() < 1e-6) perp.set(0, 1, 0);
      perp.normalize();
      side.crossVectors(dir, perp);
      const inside = Math.random() < 0.45;
      const lat = inside ? U.rand(12, tubeR * 0.95) : U.rand(tubeR * 1.3, tubeR * 2.6);
      const ang = U.rand(0, U.TAU);
      _v1.copy(c)
        .addScaledVector(perp, Math.cos(ang) * lat)
        .addScaledVector(side, Math.sin(ang) * lat);
      if (_v1.lengthSq() < 130 * 130) continue;          // keep lift-off clear
      const r = U.rand(2.2, 11) * (Math.random() < 0.1 ? 1.6 : 1);
      const i = placed++;
      this.ax[i] = _v1.x; this.ay[i] = _v1.y; this.az[i] = _v1.z; this.ar[i] = r;
      this.hp[i] = r * 3.2;
      this.quats[i] = new THREE.Quaternion().setFromEuler(
        new THREE.Euler(U.rand(0, 6.3), U.rand(0, 6.3), U.rand(0, 6.3)));
      this.spinAxis[i] = U.randomDir(new THREE.Vector3());
      this.spinSpd[i] = U.rand(0.05, 0.55) / Math.max(1, r * 0.12);
      const slot = this.meshes[placed % 3];
      this.mIdx[i] = placed % 3; this.iIdx[i] = slot.used++;
      this._writeMatrix(i);
    }
    this._finishScatter(placed);
  }

  _writeMatrix(i) {
    const slot = this.meshes[this.mIdx[i]], d = slot.dummy;
    d.position.set(this.ax[i], this.ay[i], this.az[i]);
    d.quaternion.copy(this.quats[i]);
    d.scale.setScalar(this.dead[i] ? 0 : this.ar[i]);
    d.updateMatrix();
    slot.mesh.setMatrixAt(this.iIdx[i], d.matrix);
  }

  update(dt) {
    const dq = this._q;
    for (let i = 0; i < this.count; i++) {
      if (this.dead[i]) continue;
      // world-axis spin: q' = Δq ⊗ q (pre-multiply), tumbling reads more
      // "drifting wreckage" than body-axis spin
      _q1.setFromAxisAngle(this.spinAxis[i], this.spinSpd[i] * dt);
      dq.copy(_q1);
      this.quats[i].premultiply(dq).normalize();
      this._writeMatrix(i);
    }
    for (const s of this.meshes) s.mesh.instanceMatrix.needsUpdate = true;
  }

  /* segment sweep vs all rocks (projectiles). Typed-array loop with an
     early componentwise reject keeps this fast even at 400 bolts. */
  sweptHit(p0, p1, radius, out) {
    const mx = (p0.x + p1.x) * 0.5, my = (p0.y + p1.y) * 0.5, mz = (p0.z + p1.z) * 0.5;
    const hx = Math.abs(p1.x - p0.x) * 0.5, hy = Math.abs(p1.y - p0.y) * 0.5, hz = Math.abs(p1.z - p0.z) * 0.5;
    for (let i = 0; i < this.count; i++) {
      if (this.dead[i]) continue;
      const r = this.ar[i] + radius;
      if (Math.abs(this.ax[i] - mx) > r + hx || Math.abs(this.ay[i] - my) > r + hy ||
          Math.abs(this.az[i] - mz) > r + hz) continue;
      if (segSphere(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, this.ax[i], this.ay[i], this.az[i], this.ar[i], out) >= 0) {
        this.damage(i, 6, out);   // rocks chip when shot
        return true;
      }
    }
    return false;
  }

  /* nearest sphere overlap (ship collisions). Returns null or
     { i, nx,ny,nz (push-out normal), depth } */
  querySphere(pos, radius) {
    let best = -1, bestD = -1;   // deepest penetration so far
    for (let i = 0; i < this.count; i++) {
      if (this.dead[i]) continue;
      const dx = pos.x - this.ax[i], dy = pos.y - this.ay[i], dz = pos.z - this.az[i];
      const rr = this.ar[i] + radius;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < rr * rr) {
        const depth = rr - Math.sqrt(d2);
        if (depth > bestD) { bestD = depth; best = i; }
      }
    }
    if (best < 0) return null;
    const i = best;
    _v6.set(pos.x - this.ax[i], pos.y - this.ay[i], pos.z - this.az[i]);
    if (_v6.lengthSq() < 1e-9) _v6.set(0, 1, 0);
    _v6.normalize();
    return { i, nx: _v6.x, ny: _v6.y, nz: _v6.z, depth: bestD };
  }

  damage(i, dmg, hitPos) {
    if (this.dead[i]) return;
    this.hp[i] -= dmg;
    if (this.hp[i] <= 0) {
      this.dead[i] = 1;
      _v5.set(this.ax[i], this.ay[i], this.az[i]);
      FX.explosion(_v5, this.ar[i] * 0.8);
      FX.addTrauma(0.12);
      G.audio.explosion(this.ar[i] * 0.4);
      G.game.addScore(10, _v5, '');
      if (Math.random() < 0.06) G.pickups.spawnRandom(_v5);
      this._writeMatrix(i);
      G.enemies.notifyAsteroidDestroyed(i);
    }
  }

  explosionDamage(pos, radius, dmg) {
    if (dmg <= 0) return;
    for (let i = 0; i < this.count; i++) {
      if (this.dead[i]) continue;
      const dx = this.ax[i] - pos.x, dy = this.ay[i] - pos.y, dz = this.az[i] - pos.z;
      const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (d < radius + this.ar[i]) this.damage(i, dmg * (1 - d / (radius + this.ar[i])), null);
    }
  }

  // turret hosting: biggest rocks in the mid belt
  getTurretHosts(n) {
    const cands = [];
    for (let i = 0; i < this.count; i++) {
      if (!this.dead[i] && this.ar[i] > 7) cands.push(i);
    }
    cands.sort((a, b) => this.ar[b] - this.ar[a]);
    return cands.slice(0, n * 2).sort(() => Math.random() - 0.5).slice(0, n);
  }

  reset() {
    this.dead.fill(0);
    for (let i = 0; i < this.count; i++) { this.hp[i] = this.ar[i] * 3.2; this._writeMatrix(i); }
    for (const s of this.meshes) s.mesh.instanceMatrix.needsUpdate = true;
  }
}

/* ---------------- derelict station (set dressing + cover + turret mounts) ---------------- */
function buildDerelict(pos) {
  const g = new THREE.Group();
  g.position.copy(pos);
  const hullMat = new THREE.MeshStandardMaterial({ color: 0x2b313c, roughness: 0.75, metalness: 0.6 });
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1c2129, roughness: 0.85, metalness: 0.5 });

  // hub
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(16, 19, 14, 10), hullMat);
  g.add(hub);
  // broken ring (partial torus = wrecked), plus a surviving arc
  const ring = new THREE.Mesh(new THREE.TorusGeometry(46, 3.6, 8, 44, Math.PI * 1.25), hullMat);
  ring.rotation.x = Math.PI / 2;
  g.add(ring);
  const ring2 = new THREE.Mesh(new THREE.TorusGeometry(46, 3.2, 8, 30, Math.PI * 0.6), darkMat);
  ring2.rotation.x = Math.PI / 2; ring2.rotation.z = 2.4;
  g.add(ring2);
  // spokes
  for (let i = 0; i < 3; i++) {
    const spoke = new THREE.Mesh(new THREE.BoxGeometry(2.6, 2.2, 42), darkMat);
    const a = i * 2.1 + 0.4;
    spoke.position.set(Math.cos(a) * 23, 0, Math.sin(a) * 23);
    spoke.rotation.y = -a;
    g.add(spoke);
  }
  // antenna masts + cargo boxes
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.4, 34, 6), darkMat);
  mast.position.set(6, 22, 3); g.add(mast);
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(U.rand(4, 9), U.rand(3, 6), U.rand(4, 9)), hullMat);
    b.position.set(U.rand(-26, 26), U.rand(-8, 12), U.rand(-26, 26));
    b.rotation.y = U.rand(0, 3);
    g.add(b);
  }
  // flickering window strips (emissive -> bloom catches them)
  const winMat = new THREE.MeshStandardMaterial({ color: 0x11151d, emissive: 0x2a89b8, emissiveIntensity: 0.8 });
  G.world.windows.push(winMat);
  for (let i = 0; i < 8; i++) {
    const w = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.1, U.rand(4, 10)), winMat);
    w.position.set(16.6, U.rand(-5, 5), U.rand(-8, 8));
    w.rotation.y = Math.PI / 2;
    if (i > 3) { w.position.x = -16.6; }
    g.add(w);
  }
  G.scene.add(g);
  // collision proxies (static — ring rotates only visually... actually we
  // spin the whole ring slowly; colliders approximate the hub + 3 arcs)
  const colliders = [];
  const addC = (x, y, z, r) => { colliders.push({ x: pos.x + x, y: pos.y + y, z: pos.z + z, r }); };
  addC(0, 0, 0, 21);
  for (let i = 0; i < 3; i++) { const a = i * 2.1 + 0.7; addC(Math.cos(a) * 46, 0, Math.sin(a) * 46, 7); }
  return { group: g, ringMesh: ring, colliders, turretMounts: [
    { host: null, world: new THREE.Vector3(pos.x + 18, 9, pos.z + 6) },
    { host: null, world: new THREE.Vector3(pos.x - 14, -9, pos.z - 12) },
  ] };
}

/* ---------------- wrecked ship hulks (cover) ---------------- */
function buildHulk(pos) {
  const g = new THREE.Group();
  g.position.copy(pos);
  g.rotation.set(U.rand(0, 3), U.rand(0, 6), U.rand(0, 3));
  const mat = new THREE.MeshStandardMaterial({ color: 0x33363d, roughness: 0.8, metalness: 0.55 });
  const deadMat = new THREE.MeshStandardMaterial({ color: 0x1a1d23, roughness: 0.9, metalness: 0.4,
    emissive: 0x301008, emissiveIntensity: 0.5 });
  const spine = new THREE.Mesh(new THREE.BoxGeometry(6, 5, 34), mat);
  g.add(spine);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(3.4, 9, 6), mat);
  nose.rotation.x = -Math.PI / 2; nose.position.z = -21; g.add(nose);
  // torn plates jutting at wrong angles
  for (let i = 0; i < 6; i++) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(U.rand(2, 5), 0.5, U.rand(3, 8)), mat);
    p.position.set(U.rand(-5, 5), U.rand(-3, 4), U.rand(-16, 14));
    p.rotation.set(U.rand(-1, 1), U.rand(0, 3), U.rand(-1, 1));
    g.add(p);
  }
  // dead engine block, faintly glowing (residual heat)
  for (const sx of [-2.2, 2.2]) {
    const e = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.8, 5, 8), deadMat);
    e.rotation.x = Math.PI / 2; e.position.set(sx, 0, 18.5);
    g.add(e);
  }
  G.scene.add(g);
  const colliders = [];
  for (const z of [-14, 0, 13]) {
    colliders.push({ x: pos.x + z * Math.sin(g.rotation.y), y: pos.y, z: pos.z + z * Math.cos(g.rotation.y), r: 6.5 });
  }
  return { group: g, colliders, tumbleAxis: U.randomDir(new THREE.Vector3()), tumbleSpd: U.rand(0.02, 0.06) };
}

/* ---------------- space dust (the #1 speed cue) ----------------
   A cloud of tiny points that wraps around the ship in a box. When
   you boost, nearby dust streaks past and your brain does the rest. */
class SpaceDust {
  constructor(scene, count, range) {
    this.count = count; this.range = range;
    this.pos = new Float32Array(count * 3);
    this.drift = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      this.pos[i * 3] = U.rand(-range, range); this.pos[i * 3 + 1] = U.rand(-range, range);
      this.pos[i * 3 + 2] = U.rand(-range, range);
      this.drift[i * 3] = U.rand(-2, 2); this.drift[i * 3 + 1] = U.rand(-2, 2); this.drift[i * 3 + 2] = U.rand(-2, 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    const mat = new THREE.PointsMaterial({ color: 0x8fa8c0, size: 0.5, sizeAttenuation: true,
      transparent: true, opacity: 0.42, depthWrite: false, blending: THREE.AdditiveBlending });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }
  update(dt, ref) {
    const R = this.range, r2 = R * 2;
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      this.pos[j] += this.drift[j] * dt; this.pos[j + 1] += this.drift[j + 1] * dt; this.pos[j + 2] += this.drift[j + 2] * dt;
      // wrap each axis relative to the ship (torus topology => endless dust)
      if (this.pos[j] - ref.x > R) this.pos[j] -= r2; else if (this.pos[j] - ref.x < -R) this.pos[j] += r2;
      if (this.pos[j + 1] - ref.y > R) this.pos[j + 1] -= r2; else if (this.pos[j + 1] - ref.y < -R) this.pos[j + 1] += r2;
      if (this.pos[j + 2] - ref.z > R) this.pos[j + 2] -= r2; else if (this.pos[j + 2] - ref.z < -R) this.pos[j + 2] += r2;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
  recenter(ref) {
    for (let i = 0; i < this.count; i++) {
      const j = i * 3;
      this.pos[j] = ref.x + U.rand(-this.range, this.range);
      this.pos[j + 1] = ref.y + U.rand(-this.range, this.range);
      this.pos[j + 2] = ref.z + U.rand(-this.range, this.range);
    }
    this.points.geometry.attributes.position.needsUpdate = true;
  }
}

/* ---------------- the World facade ---------------- */
const World = {
  planets: [], nebulae: [], starLayers: [], windows: [], syncPairs: [],
  colliders: [], stations: [], hulks: [], moons: [], boundaryPulse: 0,
  heroPlanet: null,        // CAMPAIGN: per-map backdrop planet (see setHeroPlanet)
  // exotic-map hazards (black hole / nebula)
  blackhole: null, nebula: null, _hazardGroup: null,
  radarFactor: 1,          // multiplies the HUD radar range (nebula: 0.45)
  visibility: Infinity,

  init() {
    // (facade fields must exist BEFORE addPlanet/buildSky reference them)
    this.asteroids = new AsteroidField(G.scene, CFG.world.asteroidCount);
    buildSky();

    // ---- planets (distances tuned as backdrop + collision hazards) ----
    addPlanet({ pos: new THREE.Vector3(-4200, -500, -3600), radius: 850,
      map: paintGasGiant([[142, 96, 66], [196, 148, 106], [226, 186, 148], [168, 120, 92], [210, 170, 140]]),
      ring: paintRing([196, 168, 140], null), ringTilt: 0.32, tilt: 0.35, spin: 0.0035 });
    addPlanet({ pos: new THREE.Vector3(3600, 900, -5200), radius: 420,
      map: paintRocky([46, 32, 26], [96, 58, 38], [176, 122, 84]), bump: 5, tilt: -0.2, spin: 0.006 });
    addPlanet({ pos: new THREE.Vector3(-2800, 2200, 2600), radius: 300,
      map: paintIce(), bump: 3, atmo: 0x7ab8e8, tilt: 0.15, spin: 0.005 });
    const terran = addPlanet({ pos: new THREE.Vector3(2400, -1500, 4200), radius: 520,
      map: paintTerran(), cityMap: paintCityLights(), atmo: 0x5f9fe8, bump: 3, tilt: 0.4, spin: 0.0045 });
    // its moon (visual orbit)
    const moon = new THREE.Mesh(new THREE.SphereGeometry(70, 24, 16),
      new THREE.MeshStandardMaterial({ map: paintRocky([40, 40, 44], [90, 90, 96], [150, 150, 156]), roughness: 1 }));
    G.scene.add(moon);
    this.moons.push({ mesh: moon, center: terran.group.position, dist: 1400, angle: U.rand(0, 6.28), speed: 0.02, y: -200 });

    // ---- derelict stations + wreck hulks ----
    this.stations.push(buildDerelict(new THREE.Vector3(900, 120, -700)));
    this.stations.push(buildDerelict(new THREE.Vector3(-1300, -220, 500)));
    for (const st of this.stations) this.colliders.push(...st.colliders);
    this.hulks.push(buildHulk(new THREE.Vector3(420, -60, 380)));
    this.hulks.push(buildHulk(new THREE.Vector3(-700, 140, -950)));
    this.hulks.push(buildHulk(new THREE.Vector3(1500, 60, 900)));
    for (const h of this.hulks) this.colliders.push(...h.colliders);

    // ---- space dust + soft combat-zone boundary ----
    this.dust = new SpaceDust(G.scene, CFG.world.dustCount, CFG.world.dustRange);
    const bmat = new THREE.MeshBasicMaterial({ color: 0x1a3a52, wireframe: true, transparent: true,
      opacity: 0.05, depthWrite: false });
    this.boundaryMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(CFG.world.boundary, 2), bmat);
    G.scene.add(this.boundaryMesh);
  },

  /* ============ CAMPAIGN: per-map backdrop ============ */
  /* Each Adventure map defines a hero planet (reusing the existing texture
     painters with new palette params — no new painters) plus a sky tint for
     the nebula sprites. Called with null restores the stock endless sky. */
  setHeroPlanet(def) {
    if (this.heroPlanet) {
      const hp = this.heroPlanet;
      G.scene.remove(hp.group);
      hp.group.traverse((o) => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
      // strip its collision proxy (matched by position + radius)
      const p = hp.group.position, r = hp.opts.radius * 1.05;
      for (let i = this.colliders.length - 1; i >= 0; i--) {
        const c = this.colliders[i];
        if (c.planet && Math.abs(c.x - p.x) < 1 && Math.abs(c.y - p.y) < 1 &&
            Math.abs(c.z - p.z) < 1 && Math.abs(c.r - r) < 1) this.colliders.splice(i, 1);
      }
      this.planets.splice(this.planets.indexOf(hp), 1);
      this.heroPlanet = null;
    }
    if (!def) return;
    const map = def.painter === 'gas' ? paintGasGiant(def.palette)
      : def.painter === 'rocky' ? paintRocky(def.palette[0], def.palette[1], def.palette[2])
      : def.painter === 'ice' ? paintIce()
      : paintTerran();
    this.heroPlanet = addPlanet({
      pos: new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2]),
      radius: def.radius, map,
      cityMap: def.city ? paintCityLights() : null,
      ring: def.ring ? paintRing(def.ring, null) : null,
      ringTilt: def.ringTilt, atmo: def.atmo, tilt: def.tilt,
      bump: def.bump, spin: def.spin || 0.004,
    });
  },

  setSkyTint(hex) {
    const c = hex ? new THREE.Color(hex) : new THREE.Color(0xffffff);
    for (const s of this.nebulae) s.material.color.copy(c);
  },

  /* ============ EXOTIC MAP HAZARDS ============
     Two environmental mechanics the MAPS table declares and the campaign
     activates per arena (see Campaign._enterArena):
       BLACKHOLE — visual: photon ring + accretion disk + infalling
         particle stream. Physical: soft 1/d² pull on the player, enemies
         and pickups; a WARN band, a DANGER band, and a hard EVENT
         HORIZON that fails the run (positioning tension, not instant
         death — you have to choose to linger).
       NEBULA — layered volumetric-LOOKING cloud shells; radar range
         collapses to radarMult and telegraphed ion arcs strike near the
         player. Visibility itself is the cloud opacity.
     clearHazard() restores the stock arena. */
  setHazard(map) {
    this.clearHazard();
    if (map && map.blackhole) this._buildBlackhole(map.blackhole);
    if (map && map.nebula) this._buildNebula(map.nebula);
  },

  clearHazard() {
    if (this._hazardGroup) {
      G.scene.remove(this._hazardGroup);
      this._hazardGroup.traverse((o) => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
      this._hazardGroup = null;
    }
    this.blackhole = null; this.nebula = null;
    this.radarFactor = 1; this.visibility = Infinity;
  },

  _buildBlackhole(def) {
    const H = CFG.hazards.blackhole;
    const g = new THREE.Group();
    const pos = new THREE.Vector3(def.pos[0], def.pos[1], def.pos[2]);
    g.position.copy(pos);
    // the hole itself: pure black sphere + searing photon ring
    const hole = new THREE.Mesh(new THREE.SphereGeometry(H.eventHorizon * 0.5, 32, 24),
      new THREE.MeshBasicMaterial({ color: 0x000000 }));
    g.add(hole);
    const ring = new THREE.Mesh(new THREE.TorusGeometry(H.eventHorizon * 0.62, H.eventHorizon * 0.055, 10, 64),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.9, 1.1) }));
    ring.rotation.x = Math.PI / 2.4;
    g.add(ring);
    // accretion disk: hot inner ring + cool outer ring, additive
    const diskMat = (c, o) => new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: o,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    const diskIn = new THREE.Mesh(new THREE.RingGeometry(H.eventHorizon * 0.7, H.eventHorizon * 2.1, 64, 1),
      diskMat(new THREE.Color(2.4, 1.5, 0.55), 0.55));
    diskIn.rotation.x = Math.PI / 2.35; g.add(diskIn);
    const diskOut = new THREE.Mesh(new THREE.RingGeometry(H.eventHorizon * 2.1, H.eventHorizon * 5.2, 64, 1),
      diskMat(0x8a4a20, 0.2));
    diskOut.rotation.x = Math.PI / 2.35; g.add(diskOut);
    // infalling debris stream: orbiting points that decay inward
    const N = 420;
    const parr = new Float32Array(N * 3);
    this._bhParts = [];
    for (let i = 0; i < N; i++) {
      const a = U.rand(0, U.TAU), r = U.rand(H.eventHorizon * 0.9, H.danger * 2.6);
      const y = U.rand(-30, 30);
      parr[i * 3] = Math.cos(a) * r; parr[i * 3 + 1] = y; parr[i * 3 + 2] = Math.sin(a) * r;
      this._bhParts.push({ a, r, y, spd: U.rand(0.15, 0.5) * (60 / Math.max(20, r)) });
    }
    const pgeo = new THREE.BufferGeometry();
    pgeo.setAttribute('position', new THREE.BufferAttribute(parr, 3).setUsage(THREE.DynamicDrawUsage));
    const pmat = new THREE.PointsMaterial({ color: 0xffc890, size: 1.6, sizeAttenuation: true,
      transparent: true, opacity: 0.75, depthWrite: false, blending: THREE.AdditiveBlending });
    const pts = new THREE.Points(pgeo, pmat);
    pts.frustumCulled = false;
    g.add(pts);
    this._bhPts = pts;
    // faint danger halo at the warn radius
    const warn = new THREE.Mesh(new THREE.RingGeometry(H.warn * 0.98, H.warn * 1.0, 64),
      diskMat(0xff5a3c, 0.12));
    warn.rotation.x = Math.PI / 2; g.add(warn);
    G.scene.add(g);
    this._hazardGroup = g;
    this.blackhole = { pos, ring, diskIn, diskOut, ...H };
    this.radarFactor = 1;
  },

  _buildNebula(def) {
    const H = CFG.hazards.nebula;
    const g = new THREE.Group();
    const hue = def.hue !== undefined ? def.hue : 0.62;
    const dens = def.density || 1;
    // three shells of huge soft sprites — layered parallax reads volumetric
    const tex = paintGlow(`hsla(${hue * 360},70%,60%,0.5)`, `hsla(${hue * 360},80%,40%,0)`);
    const shells = [[38, 500, 1300, 0.16], [26, 900, 2100, 0.11], [16, 1400, 3200, 0.08]];
    for (const [n, rMin, rMax, op] of shells) {
      for (let i = 0; i < Math.round(n * dens); i++) {
        const spr = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex,
          blending: THREE.AdditiveBlending, depthWrite: false, transparent: true,
          opacity: op * U.rand(0.7, 1.3), rotation: U.rand(0, U.TAU) }));
        U.randomDir(_v1).multiplyScalar(U.rand(rMin, rMax));
        spr.position.copy(_v1);
        spr.scale.setScalar(U.rand(500, 1400));
        g.add(spr);
      }
    }
    // drifting motes near the player give a sense of currents
    G.scene.add(g);
    this._hazardGroup = g;
    this.nebula = { ...H, _arcT: H.arcEvery * 0.6, _warn: null };
    this.radarFactor = H.radarMult;
  },

  /* per-frame hazard physics — called from World.update with the player ref */
  _updateHazards(dt, refPos) {
    // ---- BLACKHOLE: gravity on player, enemies, pickups ----
    const bh = this.blackhole;
    if (bh) {
      // particle stream decay inward
      if (this._bhPts) {
        const arr = this._bhPts.geometry.attributes.position.array;
        for (let i = 0; i < this._bhParts.length; i++) {
          const b = this._bhParts[i];
          b.a += b.spd * dt;
          b.r -= b.spd * 3.2 * dt;
          if (b.r < bh.eventHorizon * 0.55) b.r = U.rand(bh.danger, bh.warn * 2.4); // recycled infall
          arr[i * 3] = Math.cos(b.a) * b.r;
          arr[i * 3 + 1] = b.y * (b.r / (bh.warn * 2));
          arr[i * 3 + 2] = Math.sin(b.a) * b.r;
        }
        this._bhPts.geometry.attributes.position.needsUpdate = true;
        bh.diskIn.rotation.z += 0.22 * dt; bh.diskOut.rotation.z += 0.1 * dt;
        bh.ring.rotation.z -= 0.3 * dt;
      }
      // pull: force ∝ 1 / max(d², minDist2), clamped
      const pull = (p, dt2, mult) => {
        _v1.copy(bh.pos).sub(p);
        const d2 = Math.max(_v1.lengthSq(), bh.minDist2);
        const d = Math.sqrt(d2);
        const f = Math.min(bh.clamp, bh.mass / d2) * (mult || 1);
        _v1.multiplyScalar(1 / d);
        return { f, dir: _v1, d };
      };
      // player
      if (G.player.alive && G.game.state === 'playing') {
        const r = pull(G.player.pos, dt);
        G.player.vel.addScaledVector(r.dir, r.f * dt);
        // telemetry: warn / danger bands + the point of no return
        if (r.d < bh.eventHorizon) {
          G.hud.alert('EVENT HORIZON — HULL SPAGHETTIFICATION IMMINENT', 0.3);
          G.hud.flashRed(0.5);
          if (G.campaign && G.campaign.blackholeFail) G.campaign.blackholeFail();
        } else if (r.d < bh.danger) {
          G.hud.alert('CRITICAL GRAVITY — PULL OUT NOW', 0.3);
          FX.addTrauma(0.06);
        } else if (r.d < bh.warn) {
          G.hud.alert('GRAVITY WELL — MIND THE TIDE', 0.3);
        }
      }
      // enemies drift too (dogfights lean into the hole — free slingshots)
      for (const e of G.enemies.list) {
        if (!e.alive || e.type === 'boss') continue;
        const r = pull(e.pos, dt);
        e.vel.addScaledVector(r.dir, r.f * dt * 0.6);
        // hazard weapons: enemy black hole damages/kills
        if (CFG.features.hazardWeapons && G.game && G.game.state === 'playing') {
          if (r.d < bh.eventHorizon) {
            e.hazardKill = true;
            e.damage(1e9, e.pos, null, false);
          } else if (r.d < bh.danger && CFG.hazards.enemyPullDamage) {
            e.damage(CFG.hazards.enemyPullDamage * dt, e.pos, null, false);
          } else if (r.d < bh.warn && CFG.hazards.enemyPullDamage) {
            e.damage(CFG.hazards.enemyPullDamage * 0.35 * dt, e.pos, null, false);
          }
        }
      }
      for (const pk of G.pickups.list) {
        const r = pull(pk.pos, dt);
        pk.vel.addScaledVector(r.dir, r.f * dt * 0.8);
      }
    }
    // ---- NEBULA: radar collapse + telegraphed ion arcs ----
    const nb = this.nebula;
    if (nb && G.player.alive && G.game.state === 'playing') {
      nb._arcT -= dt;
      if (nb._warn) {
        nb._warn.t -= dt;
        if (nb._warn.t <= 0) {
          // strike! the storm cell detonates at the telegraphed position
          Projectiles._explode(nb._warn.pos, nb.arcRadius * 0.62, nb.arcDamage, true);
          FX.rings.spawn(nb._warn.pos, nb.arcRadius * 0.8, 0x9fd8ff, 0.5);
          FX.lights.spawn(nb._warn.pos, 0x9fd8ff, 4, 0.3);
          G.audio.zap();
          this._hazardGroup.remove(nb._warn.mesh);
          nb._warn.mesh.geometry.dispose(); nb._warn.mesh.material.dispose();
          nb._warn = null;
        }
      }
      if (nb._arcT <= 0) {
        nb._arcT = nb.arcEvery * U.rand(0.75, 1.3);
        // telegraph a ring at the player's general position
        _v2.copy(G.player.pos).add(U.randomDir(_v3).multiplyScalar(U.rand(0, nb.arcRadius)));
        const ring = new THREE.Mesh(new THREE.RingGeometry(nb.arcRadius * 0.5, nb.arcRadius * 0.56, 32),
          new THREE.MeshBasicMaterial({ color: 0x9fd8ff, transparent: true, opacity: 0.7,
            blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
        ring.position.copy(_v2);
        ring.quaternion.copy(G.camera.quaternion);
        this._hazardGroup.add(ring);
        nb._warn = { pos: _v2.clone(), t: nb.arcWarn, mesh: ring };
        G.hud.alert('ION DISCHARGE — CLEAR THE RING', 1.1, '#9fd8ff');
      }
      if (nb._warn) nb._warn.mesh.material.opacity = 0.35 + 0.4 * Math.sin(performance.now() * 0.02);
    }
  },

  /* segment sweep vs static colliders (stations, hulks, planets) */
  staticSwept(p0, p1, radius, out) {
    for (const c of this.colliders) {
      if (segSphere(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, c.x, c.y, c.z, c.r + radius, out) >= 0) return true;
    }
    return false;
  },
  /* nearest static overlap for ship physics (same shape as field.querySphere) */
  queryStatic(pos, radius) {
    let best = null, bestD = -1;   // deepest penetration so far
    for (const c of this.colliders) {
      const dx = pos.x - c.x, dy = pos.y - c.y, dz = pos.z - c.z;
      const rr = c.r + radius;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < rr * rr) {
        const d = Math.sqrt(d2), depth = rr - d;
        if (depth > bestD) { bestD = depth; best = c; }
      }
    }
    if (!best) return null;
    const d = Math.sqrt((pos.x - best.x) ** 2 + (pos.y - best.y) ** 2 + (pos.z - best.z) ** 2) || 1;
    return { nx: (pos.x - best.x) / d, ny: (pos.y - best.y) / d, nz: (pos.z - best.z) / d, depth: bestD };
  },

  update(dt, refPos) {
    // planets spin; city-shell & ring meshes stay glued to them
    for (const p of this.planets) {
      p.mesh.rotation.y += p.spin * dt;
      if (p.group.userData.ringMesh) p.group.userData.ringMesh.rotation.z += 0.008 * dt;
    }
    for (const pair of this.syncPairs) pair.b.rotation.y = pair.a.rotation.y;
    for (const m of this.moons) {
      m.angle += m.speed * dt;
      m.mesh.position.set(m.center.x + Math.cos(m.angle) * m.dist, m.center.y + m.y, m.center.z + Math.sin(m.angle) * m.dist);
    }
    for (const s of this.nebulae) s.material.rotation += 0.004 * dt;
    for (const s of this.starLayers) s.material.uniforms.uTime.value += dt;
    // station ring drift + hulk tumble
    for (const st of this.stations) st.ringMesh.rotation.z += 0.02 * dt;
    for (const h of this.hulks) {
      _q1.setFromAxisAngle(h.tumbleAxis, h.tumbleSpd * dt);
      h.group.quaternion.premultiply(_q1);
    }
    // flickering windows (derelict power glitches)
    const t = performance.now() * 0.001;
    for (let i = 0; i < this.windows.length; i++) {
      const f = noise2(t * 2.2 + i * 13.7, i * 3.1);
      this.windows[i].emissiveIntensity = f > 0.42 ? U.lerp(0.15, 1.25, (f - 0.42) * 2) : 0.08;
    }
    this.asteroids.update(dt);
    this.dust.update(dt, refPos || _v1.set(0, 0, 0));
    // exotic-map hazard physics (gravity / storm arcs)
    this._updateHazards(dt, refPos);
    // boundary feedback: pulse harder the further out you stray
    const d = refPos ? refPos.length() : 0;
    const over = U.clamp((d - CFG.world.boundary * 0.92) / (CFG.world.boundary * 0.2), 0, 1);
    this.boundaryPulse = Math.max(this.boundaryPulse * (1 - dt), over);
    this.boundaryMesh.material.opacity = 0.04 + this.boundaryPulse *
      (0.12 + 0.1 * Math.sin(performance.now() * 0.006));
  },
};

/* ============================================================
   [SECTION 8] PICKUPS — drops, magnet field, scatter
   ------------------------------------------------------------
   Shapes are tiny primitive assemblages with hot emissive cores
   (bloom does the rest). Types: health / shield / weapon upgrade /
   missile ammo / overdrive. Killed enemies drop them by chance;
   the field is seeded with a few at boot as bait to lure you
   through the asteroid belt.
============================================================ */
const PICKUP_DEFS = {
  health:    { col: [0.35, 1, 0.55], label: 'HULL +35' },
  shield:    { col: [0.3, 0.75, 1],  label: 'SHIELD +50' },
  weapon:    { col: [0.8, 0.4, 1],   label: 'WEAPON UPGRADED' },
  ammo:      { col: [1, 0.65, 0.25], label: 'MISSILES +8' },
  overdrive: { col: [1, 0.85, 0.3],  label: 'OVERDRIVE' },
};

const Pickups = {
  list: [], _glowTex: {},

  _glow(colArr) {
    const key = colArr.join(',');
    if (!this._glowTex[key]) {
      const c = makeCanvas(64, 64), ctx = c.getContext('2d');
      const g = ctx.createRadialGradient(32, 32, 2, 32, 32, 30);
      const cc = `rgba(${(colArr[0] * 255) | 0},${(colArr[1] * 255) | 0},${(colArr[2] * 255) | 0},`;
      g.addColorStop(0, cc + '0.9)'); g.addColorStop(1, cc + '0)');
      ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
      this._glowTex[key] = new THREE.CanvasTexture(c);
    }
    return this._glowTex[key];
  },

  _buildMesh(type) {
    const def = PICKUP_DEFS[type];
    const g = new THREE.Group();
    const coreMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(def.col[0] * 1.6, def.col[1] * 1.6, def.col[2] * 1.6) }); // >1 => blooms
    const shellMat = new THREE.MeshBasicMaterial({ color: 0x3a4a5a, wireframe: true, transparent: true, opacity: 0.6 });
    switch (type) {
      case 'health': { // green cross
        const a = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 0.55), coreMat);
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.8, 0.55), coreMat);
        g.add(a, b); break;
      }
      case 'shield': {
        g.add(new THREE.Mesh(new THREE.SphereGeometry(0.7, 12, 8), coreMat));
        const t = new THREE.Mesh(new THREE.TorusGeometry(1.15, 0.09, 6, 24), shellMat);
        g.add(t); break;
      }
      case 'weapon': {
        const c = new THREE.Mesh(new THREE.ConeGeometry(0.6, 1.6, 5), coreMat);
        g.add(c); break;
      }
      case 'ammo': {
        for (let i = -1; i <= 1; i++) {
          const b = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 1.1), coreMat);
          b.position.x = i * 0.6; g.add(b);
        }
        break;
      }
      case 'overdrive': {
        g.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.85, 0), coreMat));
        break;
      }
    }
    const shell = new THREE.Mesh(new THREE.OctahedronGeometry(1.5, 0), shellMat);
    g.add(shell);
    const spr = new THREE.Sprite(new THREE.SpriteMaterial({
      map: this._glow(def.col), blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.75 }));
    spr.scale.setScalar(5.5);
    g.add(spr);
    return g;
  },

  spawn(type, pos, vel) {
    const mesh = this._buildMesh(type);
    mesh.position.copy(pos);
    G.scene.add(mesh);
    this.list.push({
      type, mesh, pos: mesh.position,
      vel: vel ? vel.clone() : U.randomDir(new THREE.Vector3()).multiplyScalar(U.rand(1, 4)),
      life: CFG.pickups.life, spin: U.rand(0.6, 1.8), base: PICKUP_DEFS[type].col,
      t: U.rand(0, 6.28),
    });
  },

  spawnRandom(pos) { this.spawn(U.pickWeighted(CFG.pickups.weights), pos); },

  scatterInitial() {
    // near the start (easy bait)...
    const near = ['health', 'shield', 'weapon'];
    for (const t of near) {
      U.randomDir(_v1).multiplyScalar(U.rand(160, 320));
      _v1.y *= 0.4;
      this.spawn(t, _v1);
    }
    // ...and out in the belt (risk/reward)
    const belt = ['health', 'shield', 'weapon', 'ammo', 'overdrive', 'ammo', 'shield', 'health'];
    for (const t of belt) {
      const a = U.rand(0, U.TAU), r = U.rand(360, 1000);
      _v1.set(Math.cos(a) * r, U.rand(-140, 140), Math.sin(a) * r);
      this.spawn(t, _v1);
    }
  },

  /* CAMPAIGN: bait pickups sprinkled along the ascent corridor so the
     rock-dodging run has reason to deviate off the centerline. */
  scatterAlongPath(pts) {
    const types = ['health', 'shield', 'ammo'];
    for (let i = 0; i < types.length; i++) {
      const p = pts[Math.floor(pts.length * (0.3 + i * 0.22))];
      _v1.copy(p).add(U.randomDir(_v2).multiplyScalar(26));
      this.spawn(types[i], _v1);
    }
  },

  update(dt) {
    const p = G.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const pk = this.list[i];
      pk.life -= dt; pk.t += dt;
      if (pk.life <= 0) { this._remove(i); continue; }
      // spin + bob
      pk.mesh.rotation.y += pk.spin * dt;
      pk.mesh.position.y += Math.sin(pk.t * 2.2) * 0.5 * dt;
      // blink when about to despawn
      pk.mesh.visible = pk.life > 5 || (Math.sin(pk.life * 18) > -0.2);
      if (p.alive) {
        _v1.copy(p.pos).sub(pk.pos);
        const d = _v1.length();
        if (d < CFG.pickups.magnet && d > 0.01) {
          // magnet: accelerate toward the player, capped
          _v1.multiplyScalar(1 / d);
          pk.vel.addScaledVector(_v1, CFG.pickups.magnetAccel * dt);
          if (pk.vel.length() > 95) pk.vel.setLength(95);
        } else {
          pk.vel.multiplyScalar(Math.max(0, 1 - 0.4 * dt));
        }
        if (d < CFG.pickups.collect) {
          p.applyPickup(pk.type, pk.pos);
          this._remove(i);
          continue;
        }
      }
      pk.pos.addScaledVector(pk.vel, dt);
    }
  },

  _remove(i) {
    const pk = this.list[i];
    G.scene.remove(pk.mesh);
    // dispose per-pickup geometries — every drop builds fresh BufferGeometries;
    // the shared glow texture survives material.dispose()
    pk.mesh.traverse((o) => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
    this.list.splice(i, 1);
  },

  reset() {
    for (let i = this.list.length - 1; i >= 0; i--) this._remove(i);
    this.scatterInitial();
  },
};

/* ============================================================
   [SECTION 9] PLAYER — the 6DOF flight model
   ------------------------------------------------------------
   ORIENTATION is a single quaternion `quat` — no Euler anywhere in
   the physics, so there is no gimbal lock and no order-of-rotation
   ambiguity. Mouse offsets command ANGULAR VELOCITIES (body rates),
   which are smoothed (rotational inertia) and then integrated:

       Δq = Euler(pitchRate·dt, yawRate·dt, rollRate·dt)
       quat ← quat ⊗ Δq            (right-multiply = LOCAL frame)

   VELOCITY `vel` is completely decoupled from facing: thrust
   accumulates acceleration along local axes rotated into world
   space; drag bleeds it off exponentially; a soft clamp eases
   overspeed back toward maxSpeed. Net effect: the ship drifts,
   coasted momentum carries through turns, and stops take time.

   Translational damping uses the exact exponential form
       v ← v · e^(−drag·dt)
   which is stable at any framerate (unlike v·(1−drag·dt)).
============================================================ */


/* craggy rock geometry helper — displaces vertices along their normals with a
   POSITION-HASHED random so shared-corner soup doesn't crack */
function displaceVertices(geo, amp, freq) {
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719 + freq * 13.7) * 43758.5453;
    const k = 1 + (h - Math.floor(h) - 0.5) * 2 * amp;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  geo.computeVertexNormals();
}



class Player {
  constructor() {
    // ---- kinematic state ----
    this.pos = new THREE.Vector3(0, 0, 0);
    this.quat = new THREE.Quaternion();          // identity faces -Z
    this.vel = new THREE.Vector3();
    this.angVel = new THREE.Vector3();           // body rates: x=pitch y=yaw z=roll
    this.extraRoll = 0;                          // wheel-impulse roll momentum
    this.radius = CFG.combat.playerRadius;   // hull collision sphere
    // ---- combat state (ship stats applied in reset(); safe default) ----
    this.ship = CFG.chassis[CFG.chassisDefault];
    this.maxHull = CFG.combat.hull;
    this.maxShield = CFG.combat.shield;
    this.hull = this.maxHull;
    this.shield = this.maxShield;
    this.boostE = CFG.combat.boostEnergy;
    this.lastDamageT = 99;
    this.weapon = 0;
    this.blasterTier = 0;                        // 0..2 (MK I..III)
    this.missileAmmo = CFG.weapons.seeker.ammoStart;
    this.overdriveT = 0;
    this.spawnGuard = 0;
    this.contactCd = 0;
    this.alive = true;
    // ---- weapon state ----
    this.fireT = 0; this.muzzleSide = 0;
    this.charging = false; this.chargeT = 0; this._chargeTick = 0;
    this.volleyN = 0; this.volleyT = 0;
    this.lockTarget = null; this.lockT = 0; this.locked = false; this._wasLocked = false;
    // multi-lock: tagged targets awaiting the release volley. Entries are
    // { e, t } — t drives HUD reticle growth. Cap = CFG lockMax + bonus.
    this.lockTags = [];
    this._tagT = 0;
    this.shotsFired = 0; this.shotsHit = 0;      // accuracy stats
    // ---- feel state ----
    this.thrust01 = 0; this.boosting = false;
    this.wellT = 0;   // gravity-well exposure timer (0..0.25s)
    this.recoil = 0;
    this.vulnT = 0;            // >0: shields offline + thrust choked (overcharge dump)
    // shard Momentum Burst stacks
    this._shardStacks = 0; this._shardWindow = 0;
    // skills (blink / overdrive unlock via utility upgrades)
    this.skillUnlocked = { flare: true, nova: true, blink: false, overdrive: false };
    this.blinkCd = 0; this.odCd = 0;
    this._buildMesh();
  }

  /* ---------- procedural ship: VL-9 KESTREL (mark 2) ----------
     REBUILT (visual quality pass): tapered octagonal fuselage, framed
     canopy, dorsal spine with running accent, sculpted swept wings
     (extruded shapes with beveled edges — no more slabs), wingtip
     fins + nav strobes, underwing missile racks, and layered twin
     engines (nacelle → nozzle → hot core → bloom disc). Same anchor
     contract as before: muzzles[] at the wingtip pods, enginePts[] /
     engGlow[] at the nozzles, cockpit struts for the fp frame — so
     nothing outside _buildMesh had to change. */
  _buildMesh() {
    const g = new THREE.Group();               // physics root (position/quaternion)
    const model = new THREE.Group();           // cosmetic bank/recoil child
    g.add(model);
    // two-tone livery: gunmetal frame, light panels, hot orange accents
    const gunmetal = new THREE.MeshStandardMaterial({ color: 0x39424e, metalness: 0.85, roughness: 0.4 });
    const panels = new THREE.MeshStandardMaterial({ color: 0x76818d, metalness: 0.45, roughness: 0.55, side: THREE.DoubleSide });
    const darker = new THREE.MeshStandardMaterial({ color: 0x1d232b, metalness: 0.7, roughness: 0.6 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x35271a, emissive: 0xff9a3c, emissiveIntensity: 1.2, roughness: 0.5 });

    // ---- fuselage: tapered octagon, nose to stern ----
    const fus = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.56, 4.3, 8), gunmetal);
    fus.rotation.x = -Math.PI / 2;             // +Y (top radius) → -Z nose
    model.add(fus);
    const nose = new THREE.Mesh(new THREE.ConeGeometry(0.3, 1.7, 8), panels);
    nose.rotation.x = -Math.PI / 2; nose.position.z = -3.0;
    model.add(nose);
    const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 1.1, 6), darker);
    needle.rotation.x = -Math.PI / 2; needle.position.z = -4.0;
    model.add(needle);

    // ---- canopy: framed glass over the spine hump ----
    const canopy = new THREE.Mesh(new THREE.SphereGeometry(0.46, 16, 12), new THREE.MeshStandardMaterial({
      color: 0x0d141c, metalness: 0.9, roughness: 0.1, emissive: 0x11384a, emissiveIntensity: 0.6 }));
    canopy.scale.set(0.78, 0.6, 2.0); canopy.position.set(0, 0.4, -1.2);
    model.add(canopy);
    for (const s of [-1, 1]) {                 // canopy side rails
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 2.0), darker);
      rail.position.set(s * 0.34, 0.52, -1.2);
      model.add(rail);
    }

    // ---- dorsal spine + running accent ----
    const spine = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.32, 3.4), darker);
    spine.position.set(0, 0.52, 0.6); model.add(spine);
    const runLight = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.06, 2.6), accent);
    runLight.position.set(0, 0.7, 0.6); model.add(runLight);
    // hull greebles — sensor dome, dorsal plates, underwing pylons:
    // reads as a working warbird instead of a smooth toy
    const dome = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), darker);
    dome.scale.set(1, 0.7, 1.3); dome.position.set(0, 0.63, -2.2); model.add(dome);
    for (const s of [-1, 1]) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.06, 1.5), panels);
      plate.position.set(s * 0.62, -0.02, -0.5);
      model.add(plate);
      const pylon = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.2, 1.1), gunmetal);
      pylon.position.set(s * 1.5, -0.12, 0.9);
      model.add(pylon);
    }

    // ---- sculpted swept wings (extruded trapezoids, beveled edges) ----
    const wingShape = new THREE.Shape();
    wingShape.moveTo(0, 1.1);                  // root leading edge
    wingShape.lineTo(2.5, -0.3);               // tip leading edge (swept back)
    wingShape.lineTo(2.78, -0.72);             // tip point
    wingShape.lineTo(2.5, -0.95);              // tip trailing edge
    wingShape.lineTo(0, -1.35);                // root trailing edge
    wingShape.closePath();
    const wingGeo = new THREE.ExtrudeGeometry(wingShape, {
      depth: 0.1, bevelEnabled: true, bevelThickness: 0.035, bevelSize: 0.035, bevelSegments: 1 });
    this.navL = null; this.navR = null;
    for (const s of [-1, 1]) {
      const wing = new THREE.Mesh(wingGeo, panels);
      wing.rotation.x = -Math.PI / 2;          // shape +Y → world -Z (forward)
      wing.scale.x = s;                        // mirror; DoubleSide material
      wing.position.set(0, -0.04, 0.45);
      model.add(wing);
      // wingtip fin + nav strobe
      const fin = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.6, 0.95), gunmetal);
      fin.position.set(s * 2.62, 0.26, 0.75); fin.rotation.z = s * -0.12;
      model.add(fin);
      const nav = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6),
        new THREE.MeshBasicMaterial({ color: s < 0 ? 0xff3040 : 0x30ff70 }));
      nav.position.set(s * 2.72, 0.52, 0.72);
      model.add(nav);
      if (s < 0) this.navL = nav; else this.navR = nav;
      // wingtip gun pod + emissive muzzle ring
      const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 1.6, 8), darker);
      pod.rotation.x = -Math.PI / 2;
      pod.position.set(s * 2.62, -0.06, -0.2);
      model.add(pod);
      const podTip = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.14, 8), accent);
      podTip.rotation.x = -Math.PI / 2;
      podTip.position.set(s * 2.62, -0.06, -0.95);
      model.add(podTip);
      // underwing missile rack (where the seekers live)
      const rack = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.22, 1.3), darker);
      rack.position.set(s * 1.7, -0.16, 0.75);
      model.add(rack);
    }

    // ---- ventral fin + fuselage side intakes ----
    const vfin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 1.15), gunmetal);
    vfin.position.set(0, -0.45, 1.6); model.add(vfin);
    for (const s of [-1, 1]) {
      const intake = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.3, 1.1), darker);
      intake.position.set(s * 0.62, 0.08, 0.7);
      model.add(intake);
    }

    // ---- twin engines: nacelle → nozzle → hot core → bloom disc ----
    // (core color > 1 so bloom ignites it; cosmetics mutate the shared
    //  material for boost/overdrive tints exactly like the old discs)
    this.engGlow = [];
    this.enginePts = [];
    const coreMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 1.6, 2.4) });
    for (const s of [-1, 1]) {
      const nac = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.48, 2.0, 12), gunmetal);
      nac.rotation.x = -Math.PI / 2; nac.position.set(s * 0.62, -0.02, 2.1);
      model.add(nac);
      const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.44, 0.3, 0.4, 12), darker);
      nozzle.rotation.x = -Math.PI / 2; nozzle.position.set(s * 0.62, -0.02, 3.15);
      model.add(nozzle);
      const core = new THREE.Mesh(new THREE.CylinderGeometry(0.24, 0.17, 0.3, 10), coreMat);
      core.rotation.x = -Math.PI / 2; core.position.set(s * 0.62, -0.02, 3.42);
      model.add(core);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.33, 16), coreMat);
      disc.position.set(s * 0.62, -0.02, 3.55);
      model.add(disc);
      this.engGlow.push(disc);
      const noz = new THREE.Object3D();
      noz.position.set(s * 0.62, -0.02, 3.6);
      model.add(noz);
      this.enginePts.push(noz);
    }

    // gun muzzle anchors at wingtip pods (bolts converge on the aim ray)
    this.muzzles = [];
    for (const s of [-1, 1]) {
      const m = new THREE.Object3D();
      m.position.set(s * 2.62, -0.06, -1.05);
      model.add(m);
      this.muzzles.push(m);
    }

    /* LANCE CAPACITOR: a visible accumulator coil on the dorsal spine
       whose emissive intensity rides the charge level — flickers unstable
       while OVERCHARGING past 100%. Cockpit bloom and screen glow read the
       same value (see _updateCosmetics). */
    this.lanceCap = new THREE.Mesh(
      new THREE.CylinderGeometry(0.16, 0.2, 0.9, 8),
      new THREE.MeshStandardMaterial({ color: 0x1a2530, emissive: 0x37ffd8, emissiveIntensity: 0.12, metalness: 0.6, roughness: 0.4 }));
    this.lanceCap.rotation.x = Math.PI / 2;
    this.lanceCap.position.set(0, 0.68, -0.2);
    model.add(this.lanceCap);
    /* MISSILE-POD DOORS: two hinged covers on the underwing racks that
       swing open while a seeker/swarm weapon is live (and slam shut again
       after) — mechanical tell before every volley. */
    this.podDoors = [];
    for (const s of [-1, 1]) {
      const hinge = new THREE.Group();
      hinge.position.set(s * 1.7, -0.05, 0.75);   // outer edge of the rack
      const door = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.24, 1.3), darker);
      door.position.y = -0.12;
      hinge.add(door);
      hinge.rotation.z = 0;                        // 0 = closed
      model.add(hinge);
      this.podDoors.push(hinge);
    }

    // engine light (local pool of one — cheap and lovely on nearby rocks)
    this.engLight = new THREE.PointLight(0x66d8ff, 0.8, 70, 2);
    this.engLight.position.set(0, 0, 3.6);
    model.add(this.engLight);

    // COCKPIT v2 — detailed interior, visible only in first-person
    this._buildCockpit(g);

    // VISIBLE SHIP UPGRADES — container that per-map refits bolt onto
    this.upgradeVis = new THREE.Group();
    model.add(this.upgradeVis);

    this.group = g; this.model = model;
    G.scene.add(g);
  }

  /* ================= COCKPIT v2 =================
     A real interior instead of three struts: framed canopy with A-pillars
     + a spine arch, a curved dashboard carrying a LIVE multi-function
     display (canvas texture: hull/shield/boost bars, radar blips, speed
     & weapon readouts, redrawn ~10 Hz), a center console, a physical
     control stick + throttle that MOVE with input, rudder pedals, and
     overhead switches. All owned by the player group, so it flies with
     the hull and leans with the cosmetic bank — free realism. */
  _buildCockpit(g) {
    const c = new THREE.Group();
    const strutMat = new THREE.MeshStandardMaterial({ color: 0x14181e, metalness: 0.6, roughness: 0.5 });
    const padMat = new THREE.MeshStandardMaterial({ color: 0x1d242e, metalness: 0.3, roughness: 0.9 });
    const glowStrip = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 1.1, 1.4) });

    // ---- canopy frame: A-pillars + side rails + overhead arch ----
    for (const s of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.09, 1.35, 0.14), strutMat);
      pillar.position.set(s * 0.92, 0.28, -1.78);
      pillar.rotation.z = s * 0.34;
      c.add(pillar);
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.09, 2.3), strutMat);
      rail.position.set(s * 0.78, 0.56, -1.15);
      c.add(rail);
    }
    const arch = new THREE.Mesh(new THREE.TorusGeometry(0.94, 0.055, 6, 20, Math.PI), strutMat);
    arch.position.set(0, 0.55, -1.95);
    arch.rotation.z = Math.PI;
    c.add(arch);
    // an interior rear-view mirror stub (cosmetic)
    const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.12, 0.05), strutMat);
    mirror.position.set(0, 0.86, -1.5);
    c.add(mirror);

    // ---- dashboard: angled slab + hooded MFD well ----
    const dash = new THREE.Group();
    dash.position.set(0, -0.2, -1.92);
    dash.rotation.x = 0.38;
    c.add(dash);
    const dashTop = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.09, 0.62), padMat);
    dashTop.position.y = 0.1;
    dash.add(dashTop);
    const dashFace = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.5, 0.07), strutMat);
    dashFace.position.set(0, -0.14, -0.28);
    dash.add(dashFace);
    // side consoles flanking the pilot
    for (const s of [-1, 1]) {
      const cons = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.5, 1.1), padMat);
      cons.position.set(s * 0.98, -0.32, -1.45);
      c.add(cons);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.02, 0.9), glowStrip);
      strip.position.set(s * 0.98, -0.09, -1.45);
      c.add(strip);
    }

    // ---- the LIVE multi-function display (canvas texture) ----
    this._mfdCanvas = makeCanvas(256, 128);
    this._mfdTex = new THREE.CanvasTexture(this._mfdCanvas);
    const mfd = new THREE.Mesh(new THREE.PlaneGeometry(0.84, 0.42),
      new THREE.MeshBasicMaterial({ map: this._mfdTex }));
    mfd.position.set(-0.42, -0.12, -0.22);
    mfd.rotation.x = -0.1;
    dash.add(mfd);
    // static auxiliary screens (threat strip + nav strip)
    const aux1 = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.4),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 0.5, 0.55) }));
    aux1.position.set(0.28, -0.12, -0.24);
    aux1.rotation.x = -0.1;
    dash.add(aux1);
    const aux2 = new THREE.Mesh(new THREE.PlaneGeometry(0.42, 0.3),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.42, 0.3, 0.1) }));
    aux2.position.set(0.62, -0.05, -0.2);
    aux2.rotation.x = -0.1;
    dash.add(aux2);
    // warning lamp row (lights up with the HUD states)
    this._cwLamps = [];
    for (let i = 0; i < 3; i++) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 4),
        new THREE.MeshBasicMaterial({ color: 0x28323c }));
      lamp.position.set(-0.78 + i * 0.08, 0.17, -0.18);
      dash.add(lamp);
      this._cwLamps.push(lamp);
    }

    // ---- controls: stick, throttle, pedals (animated every frame) ----
    this._stickBase = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.13, 0.06, 10), strutMat);
    this._stickBase.position.set(0, -0.42, -1.52);
    c.add(this._stickBase);
    this._stick = new THREE.Group();
    this._stick.position.set(0, -0.4, -1.52);
    const stickShaft = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.036, 0.3, 8), strutMat);
    stickShaft.position.y = 0.15;
    this._stick.add(stickShaft);
    const grip = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), padMat);
    grip.position.y = 0.32;
    grip.scale.y = 1.5;
    this._stick.add(grip);
    this._stick.rotation.x = 0.12;
    c.add(this._stick);
    this._throttle = new THREE.Group();
    this._throttle.position.set(0.86, -0.22, -1.42);
    const thrBox = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.05, 0.34), strutMat);
    this._throttle.add(thrBox);
    const thrKnob = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.09), padMat);
    thrKnob.position.y = 0.07;
    this._throttle.add(thrKnob);
    c.add(this._throttle);
    // rudder pedals (cosmetic, far below the dash)
    for (const s of [-1, 1]) {
      const ped = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.2, 0.05), strutMat);
      ped.position.set(s * 0.3, -0.72, -1.72);
      ped.rotation.x = -0.5;
      c.add(ped);
    }
    // pilot seat headrest framing the view
    const seat = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, 0.14), padMat);
    seat.position.set(0, -0.25, 0.4);
    seat.rotation.x = 0.16;
    c.add(seat);

    // overhead switch panel
    const oh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.06, 0.24), strutMat);
    oh.position.set(0, 0.95, -1.35);
    c.add(oh);
    for (let i = 0; i < 4; i++) {
      const sw = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 0.1),
        new THREE.MeshBasicMaterial({ color: i % 2 ? 0x9fd8ff : 0xffc857 }));
      sw.position.set(-0.24 + i * 0.16, 0.9, -1.35);
      c.add(sw);
    }

    c.visible = false;
    this.cockpit = c;
    this._mfdT = 0;
    g.add(c);
  }

  /* MFD redraw (~10 Hz): hull/shield/boost bars, blip strip, speed+weapon */
  _updateMFD(dt) {
    this._mfdT -= dt;
    if (this._mfdT > 0 || !this._mfdCanvas) return;
    this._mfdT = 0.1;
    const x = this._mfdCanvas.getContext('2d');
    const W = 256, H = 128;
    x.fillStyle = '#04121a'; x.fillRect(0, 0, W, H);
    x.strokeStyle = 'rgba(95,232,255,0.5)'; x.strokeRect(2, 2, W - 4, H - 4);
    const bar = (yy, frac, col, label) => {
      x.fillStyle = 'rgba(95,232,255,0.25)'; x.fillRect(10, yy, 110, 8);
      x.fillStyle = col; x.fillRect(10, yy, 110 * U.clamp(frac, 0, 1), 8);
      x.fillStyle = 'rgba(190,230,255,0.9)'; x.font = '8px monospace';
      x.fillText(label, 124, yy + 8);
    };
    bar(12, this.shield / this.maxShield, '#37c8ff', 'SHD ' + Math.ceil(this.shield));
    bar(26, this.hull / this.maxHull, '#58ff9b', 'HUL ' + Math.ceil(this.hull));
    bar(40, this.boostE / CFG.combat.boostEnergy, '#ffc857', 'BST');
    // radar strip: blips ahead/behind along local Z
    x.fillStyle = 'rgba(95,232,255,0.18)'; x.fillRect(10, 56, 200, 18);
    _q1.copy(this.quat).invert();
    for (const e of G.enemies.list) {
      if (!e.alive) continue;
      _v5.copy(e.pos).sub(this.pos).applyQuaternion(_q1);
      const px = 110 + U.clamp(_v5.x / 400, -1, 1) * 95;
      const py = 65 - U.clamp(_v5.z / 900, -1, 1) * 8;
      x.fillStyle = e.type === 'boss' ? '#c060ff' : '#ff5a4a';
      x.fillRect(px - 1.5, py - 1.5, 3, 3);
    }
    // speed + weapon readout
    x.fillStyle = '#9ff3ff'; x.font = 'bold 13px monospace';
    x.fillText(Math.round(this.vel.length() * 3.6) + ' km/s', 10, 94);
    x.font = '9px monospace';
    const wname = CFG.weapons[['blaster', 'lance', 'pulse', 'seeker', 'swarm', 'railgun', 'arc', 'shard', 'voidmine'][this.weapon] || 'blaster'].name;
    x.fillText(wname, 10, 110);
    x.fillStyle = this.charging ? '#ffe9b0' : '#3a5a6a';
    if (this.charging) x.fillText('CHARGE ' + Math.round(this.chargeT * 100) + '%' +
      (this.chargeT > 1 ? ' UNSTABLE' : ''), 130, 110);
    /* SKILL STRIP — the cockpit instrument mirrors the HUD chips: which
       skills are online, which are cooling, which are not installed yet. */
    x.font = '8px monospace';
    x.fillStyle = 'rgba(95,232,255,0.4)';
    x.fillRect(10, 116, 236, 1);
    const sk = [
      ['V FLR', this.flareCd, CFG.skills.flareCd, true],
      ['B NOV', this.novaCd, CFG.skills.novaCd, true],
      ['N BLK', this.blinkCd, CFG.skills.blinkCd, this.skillUnlocked.blink],
      ['G OVR', this.odCd, CFG.skills.overdriveCd, this.skillUnlocked.overdrive],
    ];
    x.font = '9px monospace';
    sk.forEach((s, i) => {
      const on = !s[3] ? '#3a4a5a' : (s[1] > 0 ? '#c88840' : '#58ff9b');
      x.fillStyle = on;
      x.fillText(s[3] ? (s[1] > 0 ? s[0] + ' ' + Math.ceil(s[1]) : s[0] + ' RDY') : s[0] + ' —', 10 + i * 60, 126);
    });
    this._mfdTex.needsUpdate = true;
  }

  /* ================ UPDATE ================ */
  update(dt) {
    if (!this.alive) return;
    this.spawnGuard = Math.max(0, this.spawnGuard - dt);
    this.contactCd -= dt;
    this.lastDamageT += dt;
    // overcharge vulnerability window + skill cooldowns
    this.vulnT = Math.max(0, this.vulnT - dt);
    this.blinkCd = Math.max(0, this.blinkCd - dt);
    this.odCd = Math.max(0, this.odCd - dt);
    // shard momentum window decay
    if (this._shardWindow > 0) {
      this._shardWindow -= dt;
      if (this._shardWindow <= 0) this._shardStacks = 0;
    }
    /* CAMPAIGN: phase 1 parks the ship on the pad — no flight, no rock /
       boundary checks (the turret view handles aiming). Weapons, survival
       and cosmetics keep running so the HUD + blaster stay alive. */
    const camp = G.campaign;
    if (!camp || camp.playerFlying()) {
      this._updateRotation(dt);
      this._updateVelocity(dt);
      // CHEATS: noclip disables rock/station collision + zone boundary
      // (the Phase 2 corridor detaches itself, see Campaign._updatePhase2)
      if (!(G.cheats && G.cheats.noclip)) {
        this._resolveCollisions(dt);
        this._checkBoundary(dt);
      }
    }
    this._updateWeapons(dt);
    this._updateSkills(dt);
    /* _updateVoidMines: arm / proximity / lifetime / chain reactions */
    this._updateVoidMines(dt);
    // CHEATS ghost mode: constant hull/shield regeneration
    if (G.cheats && G.cheats.ghost) {
      this.hull = Math.min(this.maxHull, this.hull + this.maxHull * 0.25 * dt);
      this.shield = Math.min(this.maxShield, this.shield + this.maxShield * 0.35 * dt);
    }
    this._updateSurvival(dt);
    this._updateCosmetics(dt);
  }

  /* ---- skill cooldowns + flare decoy motion + NEW skills (blink/OD) ---- */
  _updateSkills(dt) {
    if (this.flareCd > 0) this.flareCd = Math.max(0, this.flareCd - dt);
    if (this.novaCd > 0) this.novaCd = Math.max(0, this.novaCd - dt);
    const flares = this.decoyFlares;
    for (let i = flares.length - 1; i >= 0; i--) {
      const f = flares[i];
      f.life -= dt;
      f.pos.addScaledVector(f.vel, dt);
      f.vel.multiplyScalar(Math.max(0, 1 - 0.9 * dt));
      // hot sparkling trail
      if (Math.random() < 0.85) {
        FX.particles.spawn(f.pos.x, f.pos.y, f.pos.z,
          U.rand(-3, 3), U.rand(-3, 3), U.rand(-3, 3),
          1, 0.75, 0.3, U.rand(0.8, 1.6), 0.5, 1.2, 1.5);
      }
      if (f.life <= 0) flares.splice(i, 1);
    }
    // hotkey triggers (edge-triggered keys; pad phase = no skills).
    // blink + overdrive are gated by the utility-branch unlocks.
    const inp = G.input;
    const padPhase = G.campaign && G.campaign.phase === 1;
    if (!padPhase) {
      if (inp.justKey('KeyV')) this.useFlares();
      if (inp.justKey('KeyB')) this.useNovaSurge();
      if (inp.justKey('KeyN') && this.skillUnlocked.blink) this.useBlink();
      if (inp.justKey('KeyG') && this.skillUnlocked.overdrive) this.useOverdrive();
    }
  }

  /* SKILL: EMERGENCY BLINK [N] — instant displacement along
     the current flight vector (velocity if moving, nose otherwise) with a
     short invulnerability window. Pure defensive repositioning: distinct
     from the sustained afterburner, on its own cooldown. */
  useBlink() {
    if (this.blinkCd > 0 || !this.alive) return;
    this.blinkCd = CFG.skills.blinkCd;
    const dir = _v1.copy(this.vel);
    if (dir.lengthSq() < 64) dir.set(0, 0, -1).applyQuaternion(this.quat);
    dir.normalize();
    // FX at both ends reads the displacement (rings + particle tunnel)
    FX.rings.spawn(this.pos, 26, 0x9ff3ff, 0.4);
    for (let i = 0; i < 14; i++) {
      U.randomDir(_v2).multiplyScalar(U.rand(6, 20));
      FX.particles.spawn(this.pos.x, this.pos.y, this.pos.z, _v2.x, _v2.y, _v2.z,
        0.6, 0.95, 1, U.rand(0.5, 1.2), U.rand(0.2, 0.45), 2, 0);
    }
    this.pos.addScaledVector(dir, CFG.skills.blinkDist);
    // stay inside the combat zone (never blink into the fail-state)
    if (this.pos.length() > CFG.world.boundary * 0.95) this.pos.setLength(CFG.world.boundary * 0.95);
    this.spawnGuard = Math.max(this.spawnGuard, CFG.skills.blinkInvuln);
    this.group.position.copy(this.pos);
    FX.rings.spawn(this.pos, 20, 0xdff6ff, 0.35);
    FX.addTrauma(0.18);
    G.audio.zap();
    G.hud.alert('BLINK', 0.9, '#9ff3ff');
  }

  /* SKILL: OVERDRIVE BURST [G] — the pickup effect as a
     real cooldown ability: timed fire-rate + thrust spike, available even
     with no pickup drop. Unlock via the utility upgrade branch. */
  useOverdrive() {
    if (this.odCd > 0 || !this.alive) return;
    this.odCd = CFG.skills.overdriveCd;
    this.overdriveT = Math.max(this.overdriveT, CFG.skills.overdriveSkillDur);
    FX.shockwaves.spawn(this.pos, 26, 0xff9aff, 0.5);
    FX.rings.spawn(this.pos, 18, 0xff9aff, 0.45);
    G.audio.pickup();
    G.hud.alert('OVERDRIVE ENGAGED', 1.2, '#ffb0ff');
  }

  /* ---------------- ROTATION (see section header for the math) ---------------- */
  _updateRotation(dt) {
    const F = CFG.flight, cur = G.input.cursor;

    // Response curve: deadzone in px, then (normalized)^1.5 — gentle near
    // center for aiming, full authority at the rim for evasive turns.
    const curve = (v) => {
      const a = Math.abs(v);
      if (a <= F.deadzone) return 0;
      const n = (a - F.deadzone) / (F.cursorRadius - F.deadzone);
      return Math.sign(v) * n * Math.sqrt(n);
    };
    // CAMPAIGN: phase 2 "systems coming online" — all angular authority
    // scales with the power ramp (see Campaign.powerMult).
    // gyro servos (+turn) apply here as a flat multiplier.
    const pw = (G.campaign && G.campaign.powerMult()) || 1;
    const tm = this.turnMult || 1;
    // chassis: per-class turn-rate multipliers
    const chP = this.ship.pitchRate || 1, chY = this.ship.yawRate || 1, chR = this.ship.rollRate || 1;
    const tPitch = (F.invertY ? 1 : -1) * curve(cur.y) * F.pitchRate * pw * tm * chP;
    const tYaw = -curve(cur.x) * F.yawRate * pw * tm * chY;

    // roll: Q/E keys + mouse-wheel impulses (wheel adds momentum that
    // decays — flicks of roll without holding a key)
    const rollIn = (G.input.key('KeyQ') ? 1 : 0) - (G.input.key('KeyE') ? 1 : 0);
    this.extraRoll += G.input.wheelDelta * 0.0028;
    this.extraRoll = U.damp(this.extraRoll, 0, 2.2, dt);
    this.extraRoll = U.clamp(this.extraRoll, -F.rollRate, F.rollRate);
    const tRoll = (rollIn * F.rollRate + this.extraRoll) * pw * tm * chR;

    // smooth toward commanded rates = rotational INERTIA (the "weight")
    const k = 1 - Math.exp(-F.angResponse * dt);
    this.angVel.x += (tPitch - this.angVel.x) * k;
    this.angVel.y += (tYaw - this.angVel.y) * k;
    this.angVel.z += (tRoll - this.angVel.z) * k;

    // integrate body rates into the quaternion (small-angle exact for Euler)
    _e1.set(this.angVel.x * dt, this.angVel.y * dt, this.angVel.z * dt, 'XYZ');
    _q1.setFromEuler(_e1);
    this.quat.multiply(_q1).normalize();

    this.group.quaternion.copy(this.quat);
  }

  /* ---------------- TRANSLATION (thrust/drag/soft-clamp) ---------------- */
  _updateVelocity(dt) {
    const F = CFG.flight, C = CFG.combat, inp = G.input;
    const over = this.overdriveT > 0;

    // local basis vectors rotated into world space
    const fwd = _v1.set(0, 0, -1).applyQuaternion(this.quat);
    const right = _v2.set(1, 0, 0).applyQuaternion(this.quat);
    const up = _v3.set(0, 1, 0).applyQuaternion(this.quat);

    const th = (inp.key('KeyW') ? 1 : 0) - (inp.key('KeyS') ? 1 : 0);
    const st = (inp.key('KeyD') ? 1 : 0) - (inp.key('KeyA') ? 1 : 0);
    const vt = (inp.key('Space') ? 1 : 0) - (inp.key('KeyC') ? 1 : 0);

    // ---- boost: gated by an energy meter (drain / regen / engage floor) ----
    const wantBoost = inp.key('ShiftLeft') || inp.key('ShiftRight');
    const canBoost = wantBoost && this.boostE > C.boostMin && th > 0;
    const bDrain = C.boostDrain * (this.ship.boostDrain || 1);
    const bRegen = C.boostRegen * (this.ship.boostRegen || 1);
    if (canBoost) this.boostE = Math.max(0, this.boostE - bDrain * dt);
    else this.boostE = Math.min(C.boostEnergy, this.boostE + bRegen * dt);

    // CAMPAIGN: phase 2 power ramp — thrust authority + terminal speed
    // both scale up from 40% to 100% as systems come online.
    const pw = (G.campaign && G.campaign.powerMult()) || 1;
    // chassis flight stats
    const chA = this.ship.accel || 1;

    // Interdictor gravity wells — engine displacement.
    // Inside a well: thrust halved, top speed cut 55%, afterburner dead.
    // The exposure timer eases the effect over ~0.25s (no snap).
    const inWell = flightField(this.pos, this.wellT);
    this.wellT = inWell ? Math.min(0.25, (this.wellT || 0) + dt) : Math.max(0, (this.wellT || 0) - dt * 2);
    const wellK = this.wellT / 0.25;                  // 0..1 blend
    const wellF = 1 - 0.5 * wellK;                    // thrust factor
    const wellS = 1 - 0.55 * wellK;                   // terminal-speed factor
    const canBoostEff = canBoost && wellK < 0.5;      // wells kill the burner
    this.boosting = canBoostEff;

    const mult = (canBoostEff ? F.boostMult : 1) * (over ? CFG.weapons.overdrive.accelMult : 1);
    /* overcharged lance dump chokes the drive — thrust is nearly dead
       while the capacitors vent (the risk half of overcharge). */
    const vuln = this.vulnT > 0 ? 0.18 : 1;
    /* afterburn nozzles (+accel) apply here */
    const am = this.accelMult || 1;
    _v4.set(0, 0, 0)
      .addScaledVector(fwd, th * F.accel * mult * pw * wellF * vuln * am * chA)
      .addScaledVector(right, st * F.strafe * pw * wellF * vuln * am * chA)
      .addScaledVector(up, vt * F.vert * pw * wellF * vuln * am * chA);
    if (this.charging) _v4.multiplyScalar(0.75);      // heavy lance = mass penalty
    this.vel.addScaledVector(_v4, dt);

    // exponential drag — frame-rate independent coasting decay
    this.vel.multiplyScalar(Math.exp(-F.drag * dt));

    // soft speed clamp: excess speed bleeds off rather than hard-stopping
    // afterburn nozzles (+max speed) apply here
    // chassis: maxSpeed / boostMaxSpeed multipliers
    const chMS = canBoostEff ? (this.ship.boostMaxSpeed || 1) : (this.ship.maxSpeed || 1);
    const maxS = (canBoostEff ? F.boostMaxSpeed : F.maxSpeed) * (over ? 1.15 : 1) * pw * wellS * (this.maxSpeedMult || 1) * chMS;
    const s = this.vel.length();
    if (s > maxS) {
      const eased = Math.max(maxS, s - (s - maxS) * (1 - Math.exp(-F.softClampRate * dt)));
      this.vel.multiplyScalar(eased / s);
    }

    this.pos.addScaledVector(this.vel, dt);
    this.group.position.copy(this.pos);

    // thrust magnitude for audio/FX (boost reads hotter than cruise)
    this.thrust01 = U.clamp(Math.abs(th) * 0.75 + Math.abs(st) * 0.3 + Math.abs(vt) * 0.3, 0, 1)
      * (canBoost ? 1.25 : 1);
  }

  /* ---------------- collisions with rocks / stations / planets ---------------- */
  _resolveCollisions(dt) {
    const hit = G.world.asteroids.querySphere(this.pos, CFG.combat.playerRadius)
             || G.world.queryStatic(this.pos, CFG.combat.playerRadius);
    if (!hit) return;
    // positional correction
    this.pos.x += hit.nx * (hit.depth + 0.05);
    this.pos.y += hit.ny * (hit.depth + 0.05);
    this.pos.z += hit.nz * (hit.depth + 0.05);
    // reflect the normal component with restitution 0.35 (a scrape, not a stop)
    const vn = this.vel.x * hit.nx + this.vel.y * hit.ny + this.vel.z * hit.nz;
    if (vn < 0) {
      this.vel.x -= hit.nx * vn * 1.35;
      this.vel.y -= hit.ny * vn * 1.35;
      this.vel.z -= hit.nz * vn * 1.35;
      const impact = -vn;
      if (impact > 18 && this.contactCd <= 0) {
        this.contactCd = CFG.combat.contactCooldown;
        this.damage(Math.min(45, (impact - 18) * 0.55), this.pos);
        FX.addTrauma(0.5);
        G.audio.thud(U.clamp(impact / 60, 0.2, 1));
        FX.hit(this.pos, 12);
      }
    }
    this.group.position.copy(this.pos);
  }

  /* ---------------- combat zone boundary ---------------- */
  _checkBoundary(dt) {
    // CAMPAIGN: the ascent corridor replaces the combat-zone boundary —
    // its own tube constraint (Campaign._updatePhase2) handles drift, and
    // the exit sits near the stock boundary radius anyway.
    if (G.campaign && G.campaign.phase === 2) return;
    const d = this.pos.length();
    if (d > CFG.world.boundary) {
      this._outT = (this._outT || 0) + dt;
      G.hud.alert('LEAVING COMBAT ZONE — TURN BACK', 0.2);
      if (this._outT > CFG.world.boundaryGrace) {
        this.damage(CFG.world.boundaryDamage * dt, this.pos, true);
      }
    } else this._outT = 0;
  }

  /* ---------------- weapons (9-slot battery) ----------------
     [1] blaster  [2] heavy lance  [3] pulse lance  [4] seekers (multi-lock)
     [5] swarm    [6] railgun      [7] arc turret  [8] shard  [9] void mines
     No wheel-cycling: the wheel is roll authority. */
  _updateWeapons(dt) {
    const inp = G.input, W = CFG.weapons;
    // switching (cancels a lance charge — committed shots only).
    // CAMPAIGN: phase 1 is blaster-only (turret defense) — the pad's spare
    // capacitors can't feed the lance or the missile rack yet.
    const lockW = G.campaign && G.campaign.weaponLocked();
    if (!lockW) {
      if (inp.justKey('Digit1')) this.setWeapon(0);
      if (inp.justKey('Digit2')) this.setWeapon(1);
      if (inp.justKey('Digit3')) this.setWeapon(2);
      if (inp.justKey('Digit4')) this.setWeapon(3);
      if (inp.justKey('Digit5')) this.setWeapon(4);
      if (inp.justKey('Digit6')) this.setWeapon(5);
      if (inp.justKey('Digit7')) this.setWeapon(6);
      if (inp.justKey('Digit8')) this.setWeapon(7);
      if (inp.justKey('Digit9')) this.setWeapon(8);
      if (inp.justKey('KeyX')) this.setWeapon((this.weapon + 1) % 9);
    } else if (this.weapon !== 0) this.setWeapon(0);

    this.overdriveT = Math.max(0, this.overdriveT - dt);
    this.fireT -= dt;
    this.volleyT -= dt;

    this._updateLock(dt);

    const held = inp.btn[0];
    const odMult = this.overdriveT > 0 ? W.overdrive.fireMult : 1;
    if (this.weapon === 0) {
      /* ---- PULSE BLASTER: twin (tiered) auto-fire bolts ---- */
      if (held && this.fireT <= 0) {
        this.fireT = (1 / (W.blaster.rate * this.ship.blasterRate)) * (this.rateMult || 1) * odMult * (this.ship.rate || 1);
        this._fireBlaster();
      }
    } else if (this.weapon === 1) {
      /* ---- HEAVY LANCE: hold to charge past 100% into OVERCHARGE,
              release to fire. Overcharge = bigger boom + vent window. ---- */
      if (held) {
        if (!this.charging) { this.charging = true; this.chargeT = 0; }
        const before = this.chargeT;
        this.chargeT = Math.min(W.lance.overMax || 1, this.chargeT + dt / W.lance.chargeTime);
        // rising tick as it charges (feedback for the hold)
        if (Math.floor(before * 5) !== Math.floor(this.chargeT * 5)) G.audio.chargeTick();
      } else if (this.charging) {
        this._fireLance();
        this.charging = false; this.chargeT = 0;
      }
    } else if (this.weapon === 2) {
      /* ---- PULSE LANCE (NEW): instant-fire energy cannon ---- */
      if (held && this.fireT <= 0) {
        this.fireT = (1 / W.pulse.rate) * (this.rateMult || 1) * odMult * (this.ship.rate || 1);
        this._firePulse();
      }
    } else if (this.weapon === 3) {
      /* ---- SEEKER MISSILES: HOLD to multi-lock tag, RELEASE for the
              volley. A quick tap (< tagTime) still fires the classic
              4-missile ripple at the current lock. ---- */
      const infAmmo = G.cheats && G.cheats.infAmmo;   // CHEATS: infinite ammo
      const ammoOk = infAmmo || this.missileAmmo > 0;
      if (held) {
        if (!this._heldSeeker) { this._heldSeeker = true; this._holdT = 0; this._tapFire = true; }
        this._holdT += dt;
        // tag a new target every tagTime while holding (max lockMax+bonus)
        this._tagT -= dt;
        if (this._tagT <= 0 && this.locked && this.lockTarget && ammoOk &&
            this.lockTags.length < this.lockCap()) {
          if (!this.lockTags.some((t) => t.e === this.lockTarget)) {
            this.lockTags.push({ e: this.lockTarget, t: 0 });
            this._tagT = W.seeker.tagTime;
            this._tapFire = false;                 // became a hold-volley
            G.audio.lockBeep(true);
          }
        }
      } else if (this._heldSeeker) {
        // RELEASE: one missile per tagged target, or the classic tap volley
        this._heldSeeker = false;
        if (this.lockTags.length > 0) {
          this._volleyTargets = this.lockTags.map((t) => t.e);
          this.lockTags.length = 0;
        } else if (this._tapFire && ammoOk) {
          this._volleyTargets = [this.locked ? this.lockTarget : null,
                                 null, null, null].slice(0, W.seeker.volley);
        } else this._volleyTargets = null;
        this._tapFire = false;
        if (this._volleyTargets) { this.volleyN = this._volleyTargets.length; this.volleyT = 0; }
      }
      while (this.volleyN > 0 && this.volleyT <= 0 && ammoOk && this._volleyTargets) {
        this._fireMissile(this._volleyTargets.shift());
        this.volleyN--;
        this.volleyT = W.seeker.volleyGap;
        if (this._volleyTargets.length === 0) this._volleyTargets = null;
      }
      // stale tags (target died / switched away) fall out silently
      for (let i = this.lockTags.length - 1; i >= 0; i--) {
        if (!this.lockTags[i].e.alive || this.lockTags[i].e.hp <= 0) this.lockTags.splice(i, 1);
        else this.lockTags[i].t += dt;
      }
    } else if (this.weapon === 4) {
      /* ---- SWARM PODS: dumbfire micro-rocket salvo ---- */
      if (inp.btnJust[0] && this.fireT <= 0) {
        this.fireT = (1 / W.swarm.rate) * (this.rateMult || 1) * odMult * (this.ship.rate || 1);
        this._fireSwarm();
      }
    } else if (this.weapon === 5) {
      /* ---- RAILGUN: spin-up then hyper-velocity piercing slug ---- */
      if (held) {
        this.railSpin = Math.min(1, (this.railSpin || 0) + dt / W.railgun.spinUp);
      } else if (this.railSpin > 0) {
        if (this.railSpin >= 1 && this.fireT <= 0) {
          this.fireT = 1 / W.railgun.rate * (this.ship.rate || 1);
          this._fireRailgun();
        }
        this.railSpin = 0;
      }
    } else if (this.weapon === 6) {
      /* ---- ARC TURRET: helical triple-bolt auto-cannon ---- */
      if (held && this.fireT <= 0) {
        this.fireT = (1 / W.arc.rate) * (this.rateMult || 1) * odMult * (this.ship.rate || 1);
        this._fireArc();
      }
    } else if (this.weapon === 7) {
      /* ---- SHARD CANNON: close-range shotgun spray ---- */
      if (held && this.fireT <= 0) {
        this.fireT = (1 / W.shard.rate) * (this.rateMult || 1) * odMult * (this.ship.rate || 1);
        this._fireShard();
      }
    } else if (this.weapon === 8) {
      /* ---- VOID MINES: drop behind you, arm, detonate ---- */
      if (inp.btnJust[0] && this.fireT <= 0) {
        this.fireT = 1 / W.voidmine.rate * (this.ship.rate || 1);
        this._fireVoidMine();
      }
    }
  }

  /* multi-lock capacity: base tag slots + target-link upgrade bonus */
  lockCap() {
    return (CFG.weapons.seeker.lockMax || 4) + (this.lockBonus || 0);
  }

  /* shard Momentum Burst bookkeeping — called from the
     projectile collision path for every shard pellet that lands. Hits
     inside the rolling window stack the multiplier the NEXT spray uses. */
  registerShardHit(en) {
    const M = CFG.weapons.shard.momentum;
    if (!M) return;
    if (en) { (this._shardHits = this._shardHits || new Map());
      this._shardHits.set(en, (this._shardHits.get(en) || 0) + 1);
      if (this._shardHits.get(en) >= M.pellets) {
        this._shardStacks = Math.min(3, this._shardStacks + 1);
        this._shardHits.clear();
        G.hud.alert('MOMENTUM BURST x' + (this._shardStacks + 1), 0.8, '#ffd76a');
      }
    }
    this._shardWindow = M.window;
  }

  /* SHARD CANNON — 7-pellet close-range spray.
     Momentum Burst: pellets registered by the projectile pipeline bump
     _shardChain; landing 4+ inside the window stacks +35% damage per
     hit up to 3 stacks — sustained close pressure rewards commitment. */
  _fireShard() {
    const W = CFG.weapons.shard;
    const aim = this.getAimDir(_v1);
    this.muzzles[0].getWorldPosition(_v2);
    this._assist(aim, _v2, CFG.weapons.assistConeBlaster, CFG.weapons.aimAssistBlaster * 0.8, true);
    const n = W.pellets;
    for (let i = 0; i < n; i++) {
      _v3.copy(aim);
      // hex-ring pattern: 1 dead-center + 6 ring pellets (tighter than pure
      // random — the gun feels deliberate while still spraying)
      if (i > 0) {
        const a = (i / (n - 1)) * Math.PI * 2 + this._shardPhase;
        _v4.set(Math.cos(a), Math.sin(a), 0).applyQuaternion(this.quat);
        _v3.addScaledVector(_v4, W.spread).normalize();
      }
      _v4.copy(G.camera.position).addScaledVector(_v3, CFG.weapons.convergeDist * 0.4).sub(_v2).normalize();
      Projectiles.fire('shard', 'player', _v2, _v4, {
        speed: W.speed, dmg: W.dmg * (1 + 0.35 * (this._shardStacks || 0)),
        life: W.life, knock: W.knock });
    }
    this._shardPhase = (this._shardPhase || 0) + 0.5;
    this.shotsFired += n;
    FX.muzzle(_v2, false);
    FX.addTrauma(W.shake * 0.5);
    G.audio.shotBlaster(0.55);
    // physical barrel recoil
    this.vel.addScaledVector(_v3.set(0, 0, 1).applyQuaternion(this.quat), -6);
  }

  /* VOID MINES — area-denial deployable. Drops a dormant mine at the
     stern; it arms, then detonates on proximity or lifetime with chained
     sympathetic blasts (see _updateVoidMines). */
  _fireVoidMine() {
    const W = CFG.weapons.voidmine;
    this.voidMines = this.voidMines || [];
    if (this.voidMines.length >= W.maxLive) {
      const old = this.voidMines.shift();      // FIFO: oldest detonates first
      this._detonateMine(old);
    }
    _v3.set(0, 0, 1).applyQuaternion(this.quat);
    const it = Projectiles.fire('vmine', 'player', _v2.copy(this.pos).addScaledVector(_v3, this.radius + 3),
      _v3, { speed: 26, dmg: W.dmg, life: 14 });
    if (!it) return;
    it.armT = W.armTime;
    it.vel.multiplyScalar(0.2);                // gentle back-drift
    this.voidMines.push(it);
    G.audio.shotBlaster(0.4);
  }

  _updateVoidMines(dt) {
    const W = CFG.weapons.voidmine;
    const list = this.voidMines;
    if (!list || !list.length) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const it = list[i];
      if (!it.active) { list.splice(i, 1); continue; }
      if (it.armT > 0) it.armT -= dt;
      it.life -= dt;
      const d = it.pos.distanceTo(G.player.pos);
      // warn blink accelerates near detonation
      const blink = it.armT > 0 ? 0 : (d < 30 ? 14 : 6);
      if (blink && G.FX) G.FX.particles.spawn(it.pos.x, it.pos.y, it.pos.z,
        0, 0, 0, 0.65, 0.3, 1, 0.4, 0.08, blink > 10 ? 1.4 : 0.9, 0.1);
      // proximity trigger + lifetime fuse
      if (it.armT <= 0 && (d < W.trigger || it.life <= 0)) {
        list.splice(i, 1);
        this._detonateMine(it);
      }
    }
  }

  _detonateMine(it) {
    const W = CFG.weapons.voidmine;
    if (!it || !it.active) return;
    const pos = _v5.copy(it.pos);
    Projectiles._explode(pos, W.radius, W.dmg, false);
    it.active = false;
    // chain reaction: nearby live mines sympathetic-detonate (capped)
    let chained = 0;
    for (const other of (this.voidMines || [])) {
      if (chained >= W.chainMax) break;
      if (other !== it && other.active && other.pos.distanceTo(pos) < W.chainRadius) {
        chained++;
        setTimeout(() => this._detonateMine(other), 120);
      }
    }
  }

  /* ARC TURRET — three bolts corkscrewing around the aim line inside a
     tight helix. The spiral phase advances each shot so sustained fire
     draws a visible drill of plasma toward the target. */
  _fireArc() {
    const W = CFG.weapons.arc;
    const aim = this.getAimDir(_v1);
    this.muzzles[0].getWorldPosition(_v2);
    this._assist(aim, _v2, CFG.weapons.assistConePulse, CFG.weapons.aimAssistPulse, true);
    _v4.copy(G.camera.position).addScaledVector(aim, CFG.weapons.convergeDist).sub(_v2).normalize();
    // helix basis from the ship's orientation
    _v5.set(1, 0, 0).applyQuaternion(this.quat);
    _v6.set(0, 1, 0).applyQuaternion(this.quat);
    this._arcPhase = ((this._arcPhase || 0) + Math.PI / 3) % U.TAU;
    for (let i = 0; i < 3; i++) {
      const a = this._arcPhase + (i / 3) * U.TAU;
      _v3.copy(_v4)
        .addScaledVector(_v5, Math.cos(a) * W.helix)
        .addScaledVector(_v6, Math.sin(a) * W.helix)
        .normalize();
      Projectiles.fire('bolt', 'player', _v2, _v3, { speed: W.speed, dmg: W.dmg, life: W.life });
      this.shotsFired++;
    }
    FX.muzzle(_v2, false);
    G.audio.shotBlaster(0.8);
    G.audio.zap();
    this.recoil = Math.min(this.recoil + 0.1, 0.4);
  }

  setWeapon(i) {
    if (i === this.weapon) return;
    this.weapon = i;
    if (this.charging) { this.charging = false; this.chargeT = 0; }
    this.lockTags.length = 0;          // switching drops pending multi-lock tags
    this._volleyTargets = null;
    G.audio.ui();
    G.hud.refreshSlots();
  }

  /* World-space aim direction: ray through the virtual cursor.
     This decouples "where I point the nose" from "where I shoot",
     which is what makes mouse-aim dogfighting feel precise. */
  getAimDir(out) {
    const c = G.input.cursor;
    out.set(
      U.clamp(c.x, -CFG.flight.cursorRadius, CFG.flight.cursorRadius) / (window.innerWidth * 0.5),
      U.clamp(c.y, -CFG.flight.cursorRadius, CFG.flight.cursorRadius) / (window.innerHeight * 0.5),
      0.5).unproject(G.camera).sub(G.camera.position).normalize();
    return out;
  }

  /* Mild aim assist: if an enemy sits inside a small cone around the
     aim ray, bend the shot toward it. Turns "almost hit" into "hit"
     at closing speeds without feeling sticky.
     CAMPAIGN combat-feel pass: cone + strength are now per-weapon args.
     The blaster passes a slightly wider cone with `falloff` so the assist
     scales DOWN toward the cone edge — only genuinely-close misses get
     help, grazing-at-the-edge shots get next to nothing ("easier", not
     "auto-aim"). Lance keeps the original fixed-cone behavior. */
  _assist(dir, fromPos, cone, strength, falloff) {
    const coneMax = (cone !== undefined) ? cone : CFG.weapons.assistCone;
    const base = (strength !== undefined) ? strength : CFG.weapons.aimAssist;
    let best = null, bestAng = coneMax;
    const enemies = G.enemies.list;
    for (const e of enemies) {
      if (!e.alive || e.type === 'mine') continue;
      _v4.copy(e.pos).sub(fromPos);
      const d = _v4.length();
      if (d < 8 || d > CFG.weapons.assistRange) continue;
      _v4.multiplyScalar(1 / d);
      const ang = Math.acos(U.clamp(dir.dot(_v4), -1, 1));
      if (ang < bestAng) { bestAng = ang; best = e; }
    }
    if (best) {
      _v4.copy(best.pos).sub(fromPos).normalize();
      const k = falloff ? base * (1 - bestAng / coneMax) : base;
      dir.lerp(_v4, k).normalize();
    }
    return dir;
  }

  _fireBlaster() {
    const W = CFG.weapons.blaster;
    const n = W.tierBolts[this.blasterTier];
    const dmg = W.tierDmg[this.blasterTier] * (this.dmgBlasterMult || 1) * (this.ship.dmg || 1);
    const aim = this.getAimDir(_v1);
    this.muzzles[this.muzzleSide].getWorldPosition(_v2);
    // AIM-TO-CURSOR (verified): the primary blaster fires along the
    // camera/cursor ray exactly like the lance & seekers — getAimDir()
    // feeds both the assist and the convergence point below, so bolts go
    // where the reticle points, never merely "down the nose".
    this._assist(aim, _v2, CFG.weapons.assistConeBlaster, CFG.weapons.aimAssistBlaster, true);
    // converge every barrel on a point down the aim ray — WYSIWYG aiming
    // (parallel wing muzzles would visibly miss the crosshair up close)
    _v4.copy(G.camera.position).addScaledVector(aim, CFG.weapons.convergeDist).sub(_v2).normalize();
    for (let i = 0; i < n; i++) {
      // side-by-side spread (parallel battery, not a shotgun)
      _v3.copy(_v4);
      _v3.x += (i - (n - 1) / 2) * 0.012 + U.rand(-1, 1) * W.spread;
      _v3.y += U.rand(-1, 1) * W.spread;
      _v3.normalize();
      Projectiles.fire('bolt', 'player', _v2, _v3, { speed: W.speed, dmg, life: W.life });
      this.shotsFired++;
    }
    this.muzzleSide = 1 - this.muzzleSide;
    FX.muzzle(_v2, false);
    G.audio.shotBlaster(this.overdriveT > 0 ? 1.25 : 1);
    this.recoil = Math.min(this.recoil + 0.06, 0.35);
  }

  _fireLance() {
    const W = CFG.weapons.lance;
    /* OVERCHARGE: chargeT rides past 1.0 (see _updateWeapons). Past the
       100% mark the shot is a different animal: higher damage/speed/AoE,
       heavier recoil — and the capacitor dump opens a vulnerability
       window (thrust choked + shields offline, see _updateVelocity /
       damage). Sharp risk/reward, not just numbers. */
    const over = this.chargeT > 1.02;
    let ch = U.clamp(this.chargeT, 0, 1);
    if (ch < W.minRelease) ch = W.minRelease;
    const aim = this.getAimDir(_v1);
    this.muzzles[0].getWorldPosition(_v2);
    this._assist(aim, _v2);
    _v4.copy(G.camera.position).addScaledVector(aim, CFG.weapons.convergeDist).sub(_v2).normalize(); // converge (see _fireBlaster)
    const full = ch > 0.85;
    const it = Projectiles.fire('lance', 'player', _v2, _v4, over ? {
      // ---- overcharged slug ----
      speed: W.overSpd,
      dmg: (W.overDmg) * (this.dmgLanceMult || 1),
      life: 3.6, scale: 3.4, charge: 1.35,
      aoe: W.overAoe, aoeDmg: W.overAoeDmg, wave: W.waveSpeed * 1.3,
      knock: (W.knock != null ? W.knock : 1) * 1.4,
    } : {
      speed: U.lerp(W.spdMin, W.spdMax, ch),
      dmg: U.lerp(W.dmgMin, W.dmgMax, ch) * (this.dmgLanceMult || 1),
      life: 3.2, scale: U.lerp(0.75, 2.7, ch), charge: ch,
      aoe: full ? W.aoe : 0, aoeDmg: W.aoeDmg * ch, wave: W.waveSpeed,
    });
    if (it) this.shotsFired++;
    FX.muzzle(_v2, false);
    G.audio.shotLance(over ? 1.3 : ch);
    // heavier backward shove; overcharge adds a violent snap
    this.vel.addScaledVector(_v3.set(0, 0, 1).applyQuaternion(this.quat),
      -(6 + ch * (W.recoilShove || 55)) * (over ? 1.45 : 1));
    this.recoil = Math.min(1.6, (1.05 * ch + 0.2) * (over ? 1.5 : 1));
    FX.addTrauma(0.18 + ch * (W.kick || 0.5) * 1.5);   // shake scales with charge; overcharge adds FX.kick
    if (over) {
      FX.kick(0.85);
      FX.postPulse(0.75);                        // screen-space impact pulse
      FX.shockwaves.spawn(_v2, 44, 0xbafff0, 0.55);
      FX.shockwaves.spawn(_v2, 20, 0xd8c0ff, 0.4);
      FX.explosion(_v2, 6);                       // violent muzzle bloom
      FX.rings.spawn(_v2, 34, 0xd8c0ff, 0.5);
      // the dump: shields + thrust offline while the capacitors vent
      const vent = this.ventMult || 1;
      this.vulnT = W.vulnTime * vent;
      G.hud.alert('CAPACITORS VENTING — SHIELDS OFFLINE', 1.6, '#ff9a5a');
      G.audio.alarm();
    } else {
      if (ch > 0.4) FX.rings.spawn(_v2, 10 + ch * 18, 0xffd9a0, 0.4);
      if (full) {
        FX.shockwaves.spawn(_v2, 30, 0x9ff3ff, 0.42);   // muzzle pressure dome
        FX.shockwaves.spawn(_v2, 14, 0xfff0d0, 0.3);    // inner flash front
        FX.explosion(_v2, 3.8);                          // hot muzzle bloom
      } else if (ch > 0.55) FX.rings.spawn(_v2, 8 + ch * 10, 0xffe9c0, 0.3);
    }
  }

  /* PULSE LANCE — instant-fire mid-slot energy cannon.
     Solid single-target damage + a small splash; light recoil keeps it
     spam-friendly. The "reliable" heavy weapon between blaster & lance. */
  _firePulse() {
    const W = CFG.weapons.pulse;
    const aim = this.getAimDir(_v1);
    this.muzzles[0].getWorldPosition(_v2);
    this._assist(aim, _v2, CFG.weapons.assistConePulse, CFG.weapons.aimAssistPulse, true);
    _v4.copy(G.camera.position).addScaledVector(aim, CFG.weapons.convergeDist).sub(_v2).normalize();
    Projectiles.fire('lance', 'player', _v2, _v4, {
      speed: W.speed, dmg: W.dmg, life: W.life, scale: 1.1,
      aoe: W.aoe, aoeDmg: W.aoeDmg,
    });
    this.shotsFired++;
    FX.muzzle(_v2, false);
    G.audio.shotLance(0.45);
    this.vel.addScaledVector(_v3.set(0, 0, 1).applyQuaternion(this.quat), -(2 + W.recoil * 10));
    this.recoil = Math.min(1, this.recoil + W.recoil);
    FX.addTrauma(W.kick * W.shake);
  }

  /* SWARM PODS — eight dumbfire micro-rockets fan out on
     loose crosshair vectors with a hint of steering. No lock needed:
     point at the furball, click, and the sky fills with warheads. */
  _fireSwarm() {
    const W = CFG.weapons.swarm;
    const aim = this.getAimDir(_v1);
    this.muzzles[0].getWorldPosition(_v2);
    _v4.copy(G.camera.position).addScaledVector(aim, CFG.weapons.convergeDist).sub(_v2).normalize();
    // fan the salvo around the aim ray inside a ~6° cone
    _v5.set(1, 0, 0).applyQuaternion(this.quat);
    _v6.set(0, 1, 0).applyQuaternion(this.quat);
    for (let i = 0; i < W.count; i++) {
      const a = (i / W.count) * U.TAU + U.rand(0, 0.8);
      const r = W.spread * (0.35 + Math.random() * 0.65);
      _v3.copy(_v4)
        .addScaledVector(_v5, Math.cos(a) * r)
        .addScaledVector(_v6, Math.sin(a) * r)
        .normalize();
      Projectiles.fire('missile', 'player', _v2, _v3, {
        speed: W.speed, maxSpeed: W.maxSpeed, dmg: W.dmg, life: W.life,
        turn: W.turn, aoe: W.aoe, aoeDmg: W.aoeDmg, scale: 0.7,
      });
      this.shotsFired++;
    }
    FX.muzzle(_v2, false);
    G.audio.shotMissile();
    this.vel.addScaledVector(_v3.set(0, 0, 1).applyQuaternion(this.quat), -(3 + W.kick * 14));
    FX.addTrauma(W.kick * W.shake);
  }

  /* RAILGUN — hyper-velocity piercing slug. One pooled bolt at
     2600 u/s with pierce: it does NOT stop on its first kill — it punches
     through up to `pierce` enemies along its swept path. Zero spread, so
     pointing at the target = hitting the target. The kick is the cost. */
  _fireRailgun() {
    const W = CFG.weapons.railgun;
    const aim = this.getAimDir(_v1);
    this.muzzles[0].getWorldPosition(_v2);
    // zero spread — the slug goes exactly where the assisted reticle points
    this._assist(aim, _v2, CFG.weapons.assistConeRail, CFG.weapons.aimAssistRail, true);
    _v4.copy(G.camera.position).addScaledVector(aim, CFG.weapons.convergeDist).sub(_v2).normalize();
    Projectiles.fire('rail', 'player', _v2, _v4, {
      speed: W.speed, dmg: W.dmg, life: W.life, pierce: W.pierce,
      radius: W.radius, scale: 2.2, wave: W.waveSpeed,
    });
    this.shotsFired++;
    FX.muzzle(_v2, false);
    G.audio.shotLance(1);
    // massive kick: backward shove + heavy screen shake + recoil muzzle
    this.vel.addScaledVector(_v3.set(0, 0, 1).applyQuaternion(this.quat), -18);
    this.recoil = Math.min(1, this.recoil + W.kick);
    FX.addTrauma(W.shake);
    FX.rings.spawn(_v2, 16, 0xbfe8ff, 0.3);
    FX.shockwaves.spawn(_v2, 14, 0xbfe8ff, 0.32);
  }

  _fireMissile(target) {
    const W = CFG.weapons.seeker;
    const aim = this.getAimDir(_v1);
    this.muzzles[this.muzzleSide].getWorldPosition(_v2);
    /* target is passed per-volley — a multi-lock release hands each missile
       its own tagged victim; the classic tap path still passes the single
       lockTarget (or null = dumbfire that acquires late). */
    const tgt = target !== undefined ? target : (this.locked ? this.lockTarget : null);
    _v4.copy(G.camera.position).addScaledVector(aim, CFG.weapons.convergeDist).sub(_v2).normalize(); // converge (see _fireBlaster)
    _v3.copy(_v4);
    _v3.x += U.rand(-0.06, 0.06); _v3.y += U.rand(-0.06, 0.06);
    _v3.normalize();
    Projectiles.fire('missile', 'player', _v2, _v3, {
      speed: W.speed, maxSpeed: W.maxSpeed, dmg: W.dmg, life: 6,
      target: tgt && tgt.alive ? tgt : null, turn: tgt && tgt.alive ? W.turn : 0,
      aoe: W.aoe, aoeDmg: W.dmg,
    });
    this.shotsFired++;
    if (!(G.cheats && G.cheats.infAmmo)) this.missileAmmo--;   // CHEATS: infinite ammo
    this.muzzleSide = 1 - this.muzzleSide;
    FX.muzzle(_v2, false);
    G.audio.shotMissile();
  }

  /* ---------------- lock-on (for seekers) ---------------- */
  _updateLock(dt) {
    const W = CFG.weapons.seeker;
    const aim = this.getAimDir(_v1);
    let best = null, bestAng = 0.16;
    for (const e of G.enemies.list) {
      // mines are not valid locks: the seeker would chase the trap, pop
      // it, and the blast wreck the player who fired it
      if (!e.alive || e.type === 'mine') continue;
      _v2.copy(e.pos).sub(this.pos);
      const d = _v2.length();
      if (d > W.lockRange || d < 10) continue;
      _v2.multiplyScalar(1 / d);
      const ang = Math.acos(U.clamp(aim.dot(_v2), -1, 1));
      if (ang < bestAng) { bestAng = ang; best = e; }
    }
    if (best && best === this.lockTarget) this.lockT += dt;
    else { this.lockTarget = best; this.lockT = 0; }
    this.locked = !!this.lockTarget && this.lockT >= W.lockTime;
    if (this.locked && !this._wasLocked) G.audio.lockBeep(true);
    else if (this.lockTarget && !this.locked) G.audio.lockBeep(false);
    this._wasLocked = this.locked;
  }

  /* ---------------- shield regen / low-hull state ---------------- */
  _updateSurvival(dt) {
    // MODIFIER: NO SHIELD REGEN
    const noRegen = G.modOn && G.modOn('noShieldRegen');
    if (!noRegen && this.lastDamageT > CFG.combat.shieldDelay && this.shield < this.maxShield) {
      this.shield = Math.min(this.maxShield, this.shield + CFG.combat.shieldRegen * (this.shieldRegenMult || 1) * dt);
    }
    if (this.vulnT > 0 && this.alive) G.hud.alert('VENTING — SHIELDS OFFLINE', 0.2);
    if (this.hull < 30 && this.alive) G.hud.alert('HULL CRITICAL', 0.4);
  }

  /* ---------------- cosmetics: bank, recoil, engine FX ---------------- */
  _updateCosmetics(dt) {
    // bank into turns (visual only — physics quaternion stays clean)
    const bank = -this.angVel.y * 0.45 + this.angVel.z * 0.06;
    this.model.rotation.z = U.damp(this.model.rotation.z, U.clamp(bank, -0.7, 0.7), 6, dt);
    this.model.rotation.x = U.damp(this.model.rotation.x, U.clamp(this.angVel.x * 0.1, -0.2, 0.2), 6, dt);
    // recoil kick along local Z
    this.recoil = Math.max(0, this.recoil - 3.5 * dt);
    this.model.position.z = this.recoil;
    // engine glow scale/color + point light + exhaust particles
    const t = this.thrust01, over = this.overdriveT > 0;
    const pulse = 1 + Math.sin(performance.now() * 0.02) * 0.08;
    for (const d of this.engGlow) {
      d.scale.setScalar((0.55 + t * 0.85) * pulse);
      if (over) d.material.color.setRGB(1.2, 0.5, 2.2);
      else if (this.boosting) d.material.color.setRGB(0.6, 1.9, 2.8);
      else d.material.color.setRGB(0.45, 1.5, 2.2);
    }
    this.engLight.intensity = 0.5 + t * 2.4;
    this.engLight.color.set(over ? 0xb070ff : 0x66d8ff);
    /* LANCE CAPACITOR + OVERCHARGE TELL: the dorsal coil's glow rides the
       charge level; past 100% it flickers UNSTABLE (the readable risk cue)
       and the whole cockpit catches the tint. */
    if (this.lanceCap) {
      const cm = this.lanceCap.material;
      if (this.charging && this.chargeT > 0.05) {
        const unstable = this.chargeT > 1.0;
        const flicker = unstable ? (0.55 + 0.45 * Math.sin(performance.now() * 0.09)) *
          (Math.random() < 0.12 ? 0.25 : 1) : 1;
        cm.emissiveIntensity = (0.15 + this.chargeT * 2.6) * flicker;
        cm.emissive.setHex(unstable ? 0xff8a5a : 0x37ffd8);
      } else cm.emissiveIntensity = U.damp(cm.emissiveIntensity, 0.12, 6, dt);
    }
    /* MISSILE-POD DOORS: hinge open while a pod weapon is live
       (seekers / swarm), close again otherwise. Mechanical tell. */
    if (this.podDoors) {
      const want = (this.weapon === 3 || this.weapon === 4 || this.volleyN > 0) ? 1.5 : 0;
      for (const h of this.podDoors) {
        h.rotation.z = U.damp(h.rotation.z, h.position.x < 0 ? -want : want, 8, dt);
      }
    }
    // exhaust particles from both nozzles
    const back = _v1.set(0, 0, 1).applyQuaternion(this.quat);
    const rate = Math.ceil(t * 3);   // 0..3 particles per nozzle per frame
    for (const noz of this.enginePts) {
      noz.getWorldPosition(_v2);
      for (let i = 0; i < rate; i++) FX.engine(_v2, back, t, over);
    }
    // struts only make sense from the inside; the model stays visible in
    // every view except first-person (including the phase-1 turret view)
    this.cockpit.visible = (G.camRig.mode === 'fp');
    this.model.visible = (G.camRig.mode !== 'fp');
    /* COCKPIT v2: inside view — animate controls + instruments.
       Stick mirrors the commanded rates (roll dominates visually),
       throttle tracks thrust, MFD redraws at ~10 Hz, warning lamps
       mirror the hull/shield/lock states. */
    if (this.cockpit.visible) {
      const inp = G.input;
      this._stick.rotation.z = U.damp(this._stick.rotation.z,
        U.clamp(-this.angVel.z * 0.12 - inp.cursor.x * 0.0012, -0.5, 0.5), 10, dt);
      this._stick.rotation.x = U.damp(this._stick.rotation.x,
        U.clamp(0.12 + this.angVel.x * 0.1 + inp.cursor.y * 0.001, -0.3, 0.5), 10, dt);
      this._throttle.position.y = -0.22 - this.thrust01 * 0.09;
      this._updateMFD(dt);
      const lampOn = [this.hull / this.maxHull < 0.35, this.shield <= 0, !!this.locked];
      for (let i = 0; i < 3; i++) {
        const on = lampOn[i] && Math.sin(performance.now() * 0.012 + i) > -0.3;
        this._cwLamps[i].material.color.setHex(on ? (i === 2 ? 0x58ff9b : 0xff3040) : 0x28323c);
      }
    }
    // wingtip nav strobes (double-blink aviation pattern)
    if (this.navL && this.navR) {
      const c = (performance.now() * 0.001) % 1.4;
      const on = c < 0.09 || (c > 0.22 && c < 0.31);
      this.navL.visible = on; this.navR.visible = on;
    }
  }

  /* ---------------- damage & death ---------------- */
  /* true while the ship can take a hit right now (spawn guard, death).
     Phase 1 is NOT covered here — on the pad the "ship" is armored down
     and splash that would hit it chews the LAUNCH POD instead. */
  invulnerable() {
    return !this.alive || this.spawnGuard > 0;
  }

  damage(dmg, hitPos, silent) {
    if (!this.alive || this.spawnGuard > 0 || dmg <= 0) return;
    if (G.cheats && G.cheats.god) return;          // CHEATS: god mode      if (G.cheats && G.cheats.ghost) return;        // CHEATS ghost: damage immunity
    const camp = G.campaign;
    if (camp && camp.phase === 1) {
      /* CAMPAIGN: phase 1 — the ship is armored down on the pad; anything
         that would hurt it chews on the LAUNCH POD instead (that's the
         phase's real health bar, and hitting 0 fails the run). */
      camp.damagePod(dmg, hitPos);
      return;
    }
    // CAMPAIGN: cockpit view gets a small damped camera jolt on hits
    if (G.camRig && G.camRig.mode !== 'tp') G.camRig.addSwayImpulse(U.clamp(dmg / 28, 0.15, 1));
    this.lastDamageT = 0;
    // impact feedback scales with ACTUAL damage: sharp kick on top of the
    // long-tail trauma wobble
    FX.kick(U.clamp(dmg / 40, 0.08, 0.7));
    let rest = dmg;
    /* an overcharge dump leaves the shield grid DISCHARGED — damage skips
       the buffer entirely and bites the hull */
    if (this.shield > 0 && this.vulnT <= 0) {
      const absorbed = Math.min(this.shield, rest);
      this.shield -= absorbed; rest -= absorbed;
      if (!silent) { FX.shieldHit(hitPos || this.pos); G.audio.shieldHit(); G.hud.flashBlue(); }
    }
    if (rest > 0) {
      this.hull -= rest;
      if (!silent) {
        FX.hit(hitPos || this.pos, 10 + Math.min(8, rest * 0.3));
        G.audio.hullHit();
        G.hud.flashRed(0.5);
        FX.addTrauma(U.clamp(0.2 + rest * 0.012, 0.2, 0.55));
      }
      G.game.notifyPlayerDamaged();
      if (this.hull <= 0) { this.hull = 0; this.die(); }
    } else if (dmg > 0.5) {
      FX.addTrauma(0.1);
    }
  }

  die() {
    if (!this.alive) return;
    this.alive = false;
    this.charging = false;
    this.thrust01 = 0; this.boosting = false;   // kill engine audio/FX
    FX.explosion(this.pos, 16);
    FX.rings.spawn(this.pos, 60, 0xffc37a, 0.9);
    FX.addTrauma(1.0);
    G.audio.bigBoom();
    this.group.visible = false;
    G.game.onPlayerDeath();
  }

  applyPickup(type, pos) {
    const def = PICKUP_DEFS[type];
    switch (type) {
      case 'health': this.hull = Math.min(this.maxHull, this.hull + 35); break;
      case 'shield': this.shield = Math.min(this.maxShield, this.shield + 50); break;
      case 'weapon':
        if (this.blasterTier < 2) this.blasterTier++;
        else { G.game.addScore(500, pos, 'MAX TIER'); }
        break;
      case 'ammo': this.missileAmmo = Math.min(CFG.weapons.seeker.ammoMax, this.missileAmmo + 8); break;
      case 'overdrive': this.overdriveT = CFG.weapons.overdrive.duration; break;
    }
    G.hud.pop(pos, def.label, type === 'overdrive' ? 'gold' : '');
    FX.pickupPop(pos, def.col);
    G.audio.pickup();
    G.hud.refreshSlots();
  }

  reset() {
    // 3-chassis selection (CFG.chassis); CFG.ships kept for cheats.
    const ck = (G.game && G.game.shipSel) || CFG.chassisDefault;
    this.chassisKey = CFG.chassis[ck] ? ck : CFG.chassisDefault;
    this.ship = CFG.chassis[this.chassisKey];
    // per-map VISIBLE refits (adventure mode): each cleared map grants a
    // CHOSEN upgrade whose effects stack — and bolts physical hardware onto
    // the hull so your ship visibly grows guns and armor.
    this.upgrades = [];
    this.upgradeCounts = {};
    // stat aggregates consumed by the weapon/flight code
    this.rateMult = 1; this.dmgBlasterMult = 1; this.dmgLanceMult = 1;
    this.ventMult = 1; this.lockBonus = 0; this.radarMult = 1;
    this.turnMult = 1; this.accelMult = 1; this.maxSpeedMult = 1;
    this.skillUnlocked = { flare: true, nova: true, blink: false, overdrive: false };
    this._applyUpgradeStats();
    this._clearUpgradeVisuals();
    this.pos.set(0, 0, 0);
    this.quat.identity();
    this.vel.set(0, 0, 0);
    this.angVel.set(0, 0, 0);
    this.extraRoll = 0;
    this.hull = this.maxHull; this.shield = this.maxShield;
    this.boostE = CFG.combat.boostEnergy;
    this.weapon = 0; this.blasterTier = 0;
    // HT-8 BASTION spawns with the Mk III blaster tier from the pad
    if (this.chassisKey === 'heavy') this.blasterTier = 2;
    this.flareCdMult = 1;
    // apply meta-shop starting perks (modest, next-run only)
    if (G.meta && G.meta.activePerks) {
      const P = G.meta.activePerks;
      if (P.hullBonus) this.hullBonus = (this.hullBonus || 0) + P.hullBonus;
      if (P.shieldBonus) this.shieldBonus = (this.shieldBonus || 0) + P.shieldBonus;
      if (P.rateMult) this.rateMult *= P.rateMult;
      if (P.flareCdMult) this.flareCdMult = P.flareCdMult;
      if (P.unlock && this.skillUnlocked[P.unlock] === false) this.skillUnlocked[P.unlock] = true;
      this.maxHull = CFG.combat.hull * this.ship.hull + (this.hullBonus || 0);
      this.maxShield = CFG.combat.shield * this.ship.shield + (this.shieldBonus || 0);
    }
    this.overdriveT = 0;    this.charging = false; this.chargeT = 0;
    this.railSpin = 0;   // NEW: railgun spin-up state
    this.missileAmmo = CFG.weapons.seeker.ammoStart;
    this.lockTarget = null; this.lockT = 0; this.locked = false;
    this.lockTags.length = 0; this._volleyTargets = null; this._heldSeeker = false;
    this.vulnT = 0; this.blinkCd = 0; this.odCd = 0;
    this.voidMines = [];
    this._shardStacks = 0; this._shardWindow = 0;
    this.shotsFired = 0; this.shotsHit = 0;
    this.spawnGuard = CFG.combat.spawnGuard;
    this.lastDamageT = 99; this._outT = 0;
    // skill cooldowns
    this.flareCd = 0; this.novaCd = 0;
    this.decoyFlares = [];   // live flare decoys (see _updateSkills)
    this.alive = true;
    this.group.visible = true;
    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this.quat);
    this.model.rotation.set(0, 0, 0);
  }

  /* ============ VISIBLE SHIP UPGRADES (adventure refits) ============
     ONE upgrade system — CFG.upgrades.pool. applyUpgrade
     applies the stat block (multiplicative stats stack, flats add, each
     id capped at maxStacks), unlocks utility skills, and bolts matching
     hardware onto the hull (see _addPoolUpgradeVisual). Granted between
     maps via the Campaign upgrade-CHOICE screen. */

  /* recompute the aggregate stat block from the applied upgrade ids */
  _applyUpgradeStats() {
    const s = this.ship;
    this.hullBonus = 0; this.shieldBonus = 0;   // reset flats — recompute from scratch
    this.shieldRegenMult = 1;
    for (const id of this.upgrades) {
      const u = CFG.upgrades.pool.find((x) => x.id === id);
      if (!u) continue;
      if (u.hull) this.hullBonus = (this.hullBonus || 0) + u.hull;
      if (u.shield) this.shieldBonus = (this.shieldBonus || 0) + u.shield;
      if (u.shieldRegen) this.shieldRegenMult *= u.shieldRegen;
      if (u.rate) this.rateMult *= u.rate;
      if (u.dmgBlaster) this.dmgBlasterMult *= u.dmgBlaster;
      if (u.dmgLance) this.dmgLanceMult *= u.dmgLance;
      if (u.maxSpeed) this.maxSpeedMult *= u.maxSpeed;
      if (u.accel) this.accelMult *= u.accel;
      if (u.turn) this.turnMult *= u.turn;
      if (u.lockBonus) this.lockBonus += u.lockBonus;
      if (u.radar) this.radarMult *= u.radar;
      if (u.vent) this.ventMult *= u.vent;
    }
    this.maxHull = CFG.combat.hull * s.hull + (this.hullBonus || 0);
    this.maxShield = CFG.combat.shield * s.shield + (this.shieldBonus || 0);
  }

  /* grant one pool upgrade by id (with stack bookkeeping + visuals) */
  applyUpgrade(id) {
    const def = CFG.upgrades.pool.find((x) => x.id === id);
    if (!def) return null;
    const n = (this.upgradeCounts[id] = (this.upgradeCounts[id] || 0) + 1);
    if (n === 1) this.upgrades.push(id);
    this._applyUpgradeStats();
    // skill unlock (utility branch — the payoff for picking utility)
    if (def.unlocks && !this.skillUnlocked[def.unlocks]) {
      this.skillUnlocked[def.unlocks] = true;
      G.hud.alert('SKILL ONLINE — ' + def.unlocks.toUpperCase(), 2.6, '#9ff3ff');
    }
    // top the new pools up so the upgrade is felt immediately
    this.hull = this.maxHull;
    this.shield = Math.max(this.shield, this.maxShield * 0.5);
    this._addPoolUpgradeVisual(def.visual);
    G.hud.banner('REFIT INSTALLED', def.name + ' — ' + def.desc, 'gold');
    G.hud.alert('REFIT FITTED — ' + def.name, 2.6, '#b0ffd8');
    G.audio.pickup();
    G.hud.refreshSlots();
    return def;
  }

  /* hardware for each refit — visible from chase AND cockpit pillars.
     Keyed by the pool's `visual` tag: gun / cap / armor /
     shield / engine / fin / pod. Every upgrade choice in the selection
     screen SHOWS this piece before it's chosen (preview text), and it
     physically appears on the hull the moment it's applied. */
  _addPoolUpgradeVisual(tag) {
    const gunmetal = new THREE.MeshStandardMaterial({ color: 0x2e3742, metalness: 0.85, roughness: 0.4 });
    const accent = new THREE.MeshStandardMaterial({ color: 0x35271a, emissive: 0xff9a3c, emissiveIntensity: 1.3 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x565f6a, metalness: 0.7, roughness: 0.5 });
    const addPair = (mk, z, y) => {
      for (const s of [-1, 1]) {
        const m = mk(s);
        m.position.set(s * 2.05, y === undefined ? -0.02 : y, z);
        this.upgradeVis.add(m);
      }
    };
    switch (tag) {
      case 'gun':   // twin cannon pods under the wings (firepower)
        addPair((s) => {
          const gp = new THREE.Group();
          const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 1.5, 8), gunmetal);
          tube.rotation.x = -Math.PI / 2; gp.add(tube);
          const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.12, 8), accent);
          tip.rotation.x = -Math.PI / 2; tip.position.z = -0.8; gp.add(tip);
          return gp;
        }, 0.1, -0.24);
        break;
      case 'cap':   // capacitor coils flanking the dorsal spine (firepower/utility)
        for (const s of [-1, 1]) {
          const coil = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 0.85, 6),
            new THREE.MeshStandardMaterial({ color: 0x1c3a4a, emissive: 0x37ffd8, emissiveIntensity: 1.15 }));
          coil.rotation.x = Math.PI / 2;
          coil.position.set(s * 0.3, 0.6, 1.1);
          this.upgradeVis.add(coil);
        }
        break;
      case 'armor':  // shoulder plates + chest plate on the fuselage (armor)
        addPair((s) => new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.14, 1.7), steel), 0.9, 0.3);
        { const chest = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.12, 1.2), steel);
          chest.position.set(0, 0.62, 0.9); this.upgradeVis.add(chest); }
        break;
      case 'shield': // emitter vanes on the spine (armor)
        for (let i = 0; i < 3; i++) {
          const vane = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.34, 0.4),
            new THREE.MeshStandardMaterial({ color: 0x1c3a4a, emissive: 0x37c8ff, emissiveIntensity: 1.1 }));
          vane.position.set(0, 0.68 + (i === 1 ? 0.1 : 0), 1.4 - i * 0.9);
          this.upgradeVis.add(vane);
        }
        break;
      case 'engine': // glowing afterburner rings around the nozzles (mobility)
        for (const s of [-1, 1]) {
          const ring = new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.07, 8, 20), accent);
          ring.position.set(s * 0.62, -0.02, 3.2);
          this.upgradeVis.add(ring);
        }
        break;
      case 'fin':    // gyro fins at the tail (mobility/utility)
        addPair((s) => {
          const fin = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.62, 0.5), steel);
          fin.rotation.z = s * 0.5;
          return fin;
        }, 2.4, 0.3);
        break;
      case 'pod':    // ventral sensor/augment pod (utility)
        /* COMPAT: r128 has no CapsuleGeometry — feature-test the CONSTRUCTOR
           itself (a bare `new THREE.CapsuleGeometry ?` throws on undefined). */
        { const podGeo = (typeof THREE.CapsuleGeometry === 'function')
            ? new THREE.CapsuleGeometry(0.18, 0.7, 4, 8)
            : new THREE.SphereGeometry(0.24, 10, 8);
          const pod = new THREE.Mesh(podGeo,
            new THREE.MeshStandardMaterial({ color: 0x22303c, emissive: 0x2fd8ff, emissiveIntensity: 0.9, metalness: 0.7, roughness: 0.4 }));
          pod.rotation.x = Math.PI / 2;
          pod.position.set(0, -0.55, 0.2);
          this.upgradeVis.add(pod);
          const eye = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 6), accent);
          eye.position.set(0, -0.55, -0.35);
          this.upgradeVis.add(eye); }
        break;
    }
  }

  _clearUpgradeVisuals() {
    if (!this.upgradeVis) return;
    while (this.upgradeVis.children.length) {
      const m = this.upgradeVis.children[0];
      this.upgradeVis.remove(m);
      m.traverse((o) => {
        if (o.geometry && o.geometry.dispose) o.geometry.dispose();
        if (o.material && o.material.dispose) o.material.dispose();
      });
    }
  }

  /* PLAYER SKILLS — FLARES (V): burst of decoy flares; every live enemy
     homing missile in the air loses its lock and chases a flare.
     NOVA SURGE (B): engine overburn — instant forward ram-accel with a
     shockwave that shoves and damages nearby enemies. Shared cooldowns. */
  useFlares() {
    if (this.flareCd > 0 || !this.alive) return;
    this.flareCd = CFG.skills.flareCd * (this.flareCdMult || 1);
    const fwd = _v1.set(0, 0, 1).applyQuaternion(this.quat);
    const right = _v2.set(1, 0, 0).applyQuaternion(this.quat);
    const up = _v3.set(0, 1, 0).applyQuaternion(this.quat);
    for (let i = 0; i < 6; i++) {
      _v4.copy(this.pos).addScaledVector(fwd, 2)
        .addScaledVector(right, (i % 2 ? 1 : -1) * 1.2)
        .addScaledVector(up, ((i >> 1) % 2 ? 1 : -1) * 0.8);
      U.randomDir(_v5).multiplyScalar(0.6).addScaledVector(fwd, 0.8);
      FX.flare(_v4, _v5, this.vel);
    }
    G.audio.shotMissile();
    G.hud.alert('FLARES DEPLOYED', 1.2, '#ffc857');
    // break every lock: live hostile seekers chase nothing now
    for (const st of Projectiles.pools.emissile.items) {
      if (st.active && st.target && st.target === this) { st.target = null; st._decoyT = 6; }
    }
  }

  useNovaSurge() {
    if (this.novaCd > 0 || !this.alive) return;
    this.novaCd = CFG.skills.novaCd;
    // ram-accel burst
    _v1.set(0, 0, -1).applyQuaternion(this.quat);
    this.vel.addScaledVector(_v1, CFG.skills.novaImpulse);
    FX.shockwaves.spawn(this.pos, 60, 0x9ff3ff, 0.55);
    FX.rings.spawn(this.pos, 44, 0x9ff3ff, 0.6);
    FX.addTrauma(0.45);
    G.audio.bigBoom();
    G.hud.alert('NOVA SURGE', 1.4, '#9ff3ff');
    // radial shove + damage to everything nearby
    for (const e of G.enemies.list) {
      if (!e.alive || e.type === 'boss') continue;
      const d = e.pos.distanceTo(this.pos);
      if (d < CFG.skills.novaRadius) {
        _v2.copy(e.pos).sub(this.pos).normalize();
        e.vel.addScaledVector(_v2, 90 * (1 - d / CFG.skills.novaRadius));
        e.damage(CFG.skills.novaDmg * (1 - d / CFG.skills.novaRadius), e.pos, null, true);
      }
    }
  }
}

/* ============================================================
   [SECTION 10] CAMERA RIG — spring-lag chase / cockpit
   ------------------------------------------------------------
   Third person: the camera is NEVER rigidly welded to the ship.
   Position follows a stiff exponential spring toward the "ideal"
   chase point, and orientation SLERPs toward the ship's quaternion.
   The gap between ideal and actual while you maneuver is the
   "drag" that sells mass. Boost widens the FOV (speed = tunnel
   vision in reverse), impacts add trauma-based shake.
============================================================ */
class CameraRig {
  constructor(camera) {
    this.cam = camera;
    this.mode = 'tp';
    this.prefMode = 'tp';   // CAMPAIGN: the player's own chase/cockpit choice.
                            // Scripted phases force a view WITHOUT touching
                            // this; phase 3 / map combat restores it.
    this.curPos = new THREE.Vector3(0, 3, 12);
    this.curQuat = new THREE.Quaternion();
    this.fov = CFG.render.fov;
    this._shakeT = 0;
    this.sway = { x: 0, y: 0, vx: 0, vy: 0 };  // CAMPAIGN: cockpit sway (below)
  }

  /* Player-initiated toggle (F key) — records the preference. */
  toggleMode() {
    this.setMode(this.mode === 'turret' ? 'tp' : (this.mode === 'tp' ? 'fp' : 'tp'));
    G.audio.ui();
  }

  setMode(mode) { this.prefMode = mode; this._applyMode(mode); }

  /* Scripted phases force a view without clobbering the stored preference. */
  forceMode(mode) { this._applyMode(mode); }
  restorePref() { this._applyMode(this.prefMode); }

  _applyMode(mode) {
    this.mode = mode;
    this.fov = mode === 'tp' ? CFG.render.fov : CFG.render.fovCockpit;
    this.cam.fov = this.fov;
    this.cam.updateProjectionMatrix();
    // CAMPAIGN: cockpit instrument-panel HUD layout (fp + turret views)
    if (G.hud) G.hud.setCockpit(mode !== 'tp');
  }

  /* CAMPAIGN: impulse into the cockpit sway spring (called from
     Player.damage — hit-linked, distinct from trauma shake). */
  addSwayImpulse(s) {
    this.sway.vx += U.rand(-1, 1) * s * 7;
    this.sway.vy += U.rand(-0.5, 1) * s * 7;
  }

  reset() {
    // snap directly behind the ship (used on restart / respawn)
    const p = G.player;
    _v1.set(CFG.flight ? 0 : 0, 2.3, 9.5).applyQuaternion(p.quat);
    this.curPos.copy(p.pos).add(_v1);
    this.curQuat.copy(p.quat);
    this.cam.position.copy(this.curPos);
    this.cam.quaternion.copy(this.curQuat);
  }

  update(dt, realDt) {
    const p = G.player;
    if (this.mode === 'turret') {
      /* CAMPAIGN PHASE 1 — fixed gunner view at the launchpad: the virtual
       cursor drives yaw/pitch RATES through the same deadzone + response
       curve as flight steering, so aiming unprojects through the exact
       same path as normal flight and attackers can't slip out of view. */
      const a = G.campaign.padCam, P1 = CFG.campaign.phase1;
      this.curPos.lerp(a.pos, 1 - Math.exp(-40 * dt));
      const F = CFG.flight, cur = G.input.cursor;
      const curve = (v) => {
        const mag = Math.abs(v);
        if (mag <= F.deadzone) return 0;
        const n = (mag - F.deadzone) / (F.cursorRadius - F.deadzone);
        return Math.sign(v) * n * Math.sqrt(n);
      };
      a.yaw += -curve(cur.x) * P1.lookYawRate * dt;
      a.pitch = U.clamp(a.pitch - curve(cur.y) * P1.lookPitchRate * dt,
        -P1.lookPitchClamp, P1.lookPitchClamp);
      _e1.set(a.pitch, a.yaw, 0, 'YXZ');
      _q1.copy(a.baseQuat).multiply(_q2.setFromEuler(_e1));
      this.curQuat.slerp(_q1, 1 - Math.exp(-30 * dt));
    } else if (this.mode === 'tp') {
      /* ideal chase point: behind (+Z local, since forward is -Z) & above */
      _v1.set(0, 2.3, 9.5).applyQuaternion(p.quat).add(p.pos);
      // position spring — rate 14: keeps up in boost, lags in turns
      const k = 1 - Math.exp(-14 * dt);
      this.curPos.lerp(_v1, k);
      // orientation: slerp toward ship quat (rate 9 → visible rotational lag)
      _q1.copy(p.quat);
      _q1.multiply(_q2.setFromAxisAngle(_v3.set(1, 0, 0), 0.06)); // hint of nose-down framing
      this.curQuat.slerp(_q1, 1 - Math.exp(-9 * dt));
    } else {
      /* cockpit: near-rigid, very high rates (you ARE the ship) */
      _v1.set(0, 0.42, -0.9).applyQuaternion(p.quat).add(p.pos);
      this.curPos.lerp(_v1, 1 - Math.exp(-40 * dt));
      this.curQuat.slerp(p.quat, 1 - Math.exp(-30 * dt));
    }
    this.cam.position.copy(this.curPos);
    this.cam.quaternion.copy(this.curQuat);

    /* CAMPAIGN: cockpit sway — a small damped positional offset driven by
       ship velocity (in the ship's local frame) plus hit impulses. Low
       frequency, capped amplitude, deliberately distinct from BOTH the
       chase-cam spring lag and the high-frequency trauma shake. */
    if (this.mode !== 'tp') this._updateSway(dt);

    /* ---- FOV kick: speed & boost stretch the view ---- */
    let fovT = this.mode === 'tp' ? CFG.render.fov : CFG.render.fovCockpit;
    const speedFrac = U.clamp(p.vel.length() / CFG.flight.boostMaxSpeed, 0, 1);
    fovT += speedFrac * 8;
    if (p.boosting) fovT += 7;
    if (p.overdriveT > 0) fovT += 3;
    if (p.charging) fovT -= 5 * p.chargeT;   // lance charge zooms slightly in
    this.fov = U.damp(this.fov, fovT, 5, realDt);
    if (Math.abs(this.cam.fov - this.fov) > 0.05) {
      this.cam.fov = this.fov;
      this.cam.updateProjectionMatrix();
    }

    /* ---- trauma shake (squared: small hits subtle, big hits slam) ---- */
    const tr = FX.trauma;
    if (tr > 0.001) {
      const s = tr * tr;
      const t = (this._shakeT += realDt);
      // layered sines at incommensurate frequencies = pseudo-noise
      const ox = Math.sin(t * 57.3) * s * 0.65;
      const oy = Math.sin(t * 47.1 + 1.3) * s * 0.45;
      const roll = Math.sin(t * 63.7) * s * 0.05;
      _v2.set(1, 0, 0).applyQuaternion(this.curQuat);
      _v3.set(0, 1, 0).applyQuaternion(this.curQuat);
      this.cam.position.addScaledVector(_v2, ox).addScaledVector(_v3, oy);
      _q1.setFromAxisAngle(_v4.set(0, 0, 1).applyQuaternion(this.curQuat).normalize(), roll);
      this.cam.quaternion.multiply(_q1);
    }

    /* ---- SHARP KICK: an instant directional punch that decays at 6/s
       (see FX.update) — layered ON TOP of the trauma wobble so big hits
       land with an attack transient, not just more sine. Fast to rise,
       gone in ~0.25s. ---- */
    if (FX.kickAmt > 0.001) {
      const k = FX.kickAmt;
      this._kickT = (this._kickT || 0) + realDt;
      _v2.set(1, 0, 0).applyQuaternion(this.curQuat);
      _v3.set(0, 1, 0).applyQuaternion(this.curQuat);
      // one violent pull-back + jitter roll (kick "recoil" feel)
      _v4.set(0, 0, 1).applyQuaternion(this.curQuat);
      this.cam.position.addScaledVector(_v4, k * 0.9)
        .addScaledVector(_v2, Math.sin(this._kickT * 80) * k * 0.35)
        .addScaledVector(_v3, -k * 0.3);
      _q1.setFromAxisAngle(_v4.normalize(), Math.sin(this._kickT * 65) * k * 0.02);
      this.cam.quaternion.multiply(_q1);
    }
  }

  /* ---------------- CAMPAIGN: cockpit sway ----------------
     Damped spring toward a velocity-linked target (local-frame lateral
     & vertical drift), plus impulses from Player.damage. Amplitude is
     hard-capped so it can never grow into a wobble. */
  _updateSway(dt) {
    const p = G.player, s = this.sway;
    _q2.copy(p.quat).invert();
    _v5.copy(p.vel).applyQuaternion(_q2);          // velocity, ship-local
    const cap = 0.34;
    const tx = U.clamp(-_v5.x * 0.011, -cap, cap);
    const ty = U.clamp(_v5.y * 0.008, -cap, cap);
    const K = 26, C = 8;                           // stiff spring, heavy damping
    s.vx += ((tx - s.x) * K - s.vx * C) * dt;
    s.vy += ((ty - s.y) * K - s.vy * C) * dt;
    s.x = U.clamp(s.x + s.vx * dt, -cap * 1.25, cap * 1.25);
    s.y = U.clamp(s.y + s.vy * dt, -cap * 1.25, cap * 1.25);
    // apply: small positional drift + a whisper of roll
    _v2.set(1, 0, 0).applyQuaternion(this.cam.quaternion);
    _v3.set(0, 1, 0).applyQuaternion(this.cam.quaternion);
    this.cam.position.addScaledVector(_v2, s.x * 0.4).addScaledVector(_v3, s.y * 0.4);
    _q1.setFromAxisAngle(_v4.set(0, 0, 1).applyQuaternion(this.cam.quaternion).normalize(), -s.x * 0.05);
    this.cam.quaternion.multiply(_q1);
  }
}

/* ============================================================
   [SECTION 11] ENEMIES — base class + four FSM archetypes
   ------------------------------------------------------------
   ARCHITECTURE
   - Enemy (base): kinematics (pos/quat/vel), hp, hit-flash book-
     keeping, steering helpers shared by every archetype:
       steerToward()  — seek with arrive slowdown + accel clamp
       faceTowards()  — rate-limited quaternion turn toward a point
     Subclasses implement update(dt) as a state machine.
   - Damage flows through damage(dmg, hitPos) so kill bookkeeping
     (score, drops, combo, wave logic) happens in ONE place.
   - Boss overrides the multi-sphere path via hitSpheres +
     damagePart() (see SECTION 12).

   STEERING MODEL (all flying enemies):
     desiredVel = normalize(dest-pos) * speed * arrive(d)
     steering   = clamp(desiredVel - vel, accel)
     vel       += steering * dt        (then hazard/separation pushes)
   The mismatch between desired and current velocity is what
   produces weighty, arcing pursuit instead of rails.
============================================================ */
/* ------------------------------------------------------------
   SHARED SHIP GEOMETRY CACHE + MERGER
   ------------------------------------------------------------
   Every Fighter/Gunship/Turret/Mine used to construct its own
   BufferGeometries on spawn — a fresh wave of 8 fighters meant
   ~80 geometry allocations in one frame (visible hitch), and
   ~8 draw calls per ship forever after.

   - ShipGeo.get(key, build): build-once shared geometry cache.
     Instances NEVER dispose shared geometry (see Enemy.dispose).
   - mergeGeos(): bakes a list of transformed primitives into ONE
     non-indexed BufferGeometry, so a whole ship collapses into
     1 mesh per material. The new ship models below render in
     4 draw calls (was 8-14) and cost ~0 to spawn.
   - Mark shared materials with mat.userData.shared = true;
     dispose() skips those (cloned flash materials still die).
------------------------------------------------------------ */
const ShipGeo = {
  _c: {},
  get(key, build) { return this._c[key] || (this._c[key] = build()); },
};
const _mergeM = new THREE.Matrix4(), _mergeQ = new THREE.Quaternion(),
      _mergeE = new THREE.Euler(), _mergeP = new THREE.Vector3(), _mergeS = new THREE.Vector3();
function mergeGeos(list) {
  let total = 0;
  const parts = list.map((it) => {
    const src = it.geo;
    const g = src.index ? src.toNonIndexed() : src.clone();
    _mergeE.set(it.rot ? it.rot[0] : 0, it.rot ? it.rot[1] : 0, it.rot ? it.rot[2] : 0);
    _mergeQ.setFromEuler(_mergeE);
    const s = it.scale || [1, 1, 1];
    _mergeP.set(it.pos ? it.pos[0] : 0, it.pos ? it.pos[1] : 0, it.pos ? it.pos[2] : 0);
    _mergeS.set(s[0], s[1], s[2]);
    _mergeM.compose(_mergeP, _mergeQ, _mergeS);
    g.applyMatrix4(_mergeM);
    total += g.attributes.position.count;
    return g;
  });
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3),
        uv = new Float32Array(total * 2);
  let oP = 0;
  for (const g of parts) {
    pos.set(g.attributes.position.array, oP * 3);
    nor.set(g.attributes.normal.array, oP * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, oP * 2);
    oP += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}
const shared = (mat) => { mat.userData.shared = true; return mat; };


