/* ============================================================
   ENTITIES.JS — all gameplay actors
   ------------------------------------------------------------
   LOAD ORDER: after engine.js + fx.js (extends Enemy, uses U/
   scratch vectors/Projectiles/FX) and before game.js (which
   spawns these classes). Contains: Enemy base + Fighter/Gunship/
   Turret/Mine + Enemies registry, Interdictor, Bomber, Drone,
   flightField, the multi-archetype Boss, allies (Vanguard wingman,
   Aegis frigate, Wingmen, LancerAlly, HornetWing), Ravager +
   Sentinel, Interceptor + Hive + elite modifiers.
============================================================ */

class Enemy {
  constructor(type) {
    this.type = type;
    this.pos = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.alive = true;
    this.hp = this.maxHp = 10;
    this.radius = 2;
    this.size = 3;             // explosion scale
    this.flash = 0;            // hit-flash timer 0..1
    this.flashMats = [];       // [{mat, base}] — emissive gets spiked on hit
    this.waveEnemy = false;    // counts toward wave-clear (turrets/mines don't)
    this.scoreVal = 0;
    this.dropChance = 0;
    this.mesh = null;
    this.elite = false;
  }

  /* seek `dest` — see section header */
  steerToward(dest, dt, speed, accel, arriveR) {
    _v2.copy(dest).sub(this.pos);
    const d = _v2.length();
    if (d > 1e-4) _v2.multiplyScalar(1 / d);
    const arrive = Math.min(1, d / (arriveR || 55));
    _v2.multiplyScalar(speed * arrive);
    _v2.sub(this.vel);
    if (_v2.length() > accel) _v2.setLength(accel);
    this.vel.addScaledVector(_v2, dt);
  }

  /* orient -Z toward `target` at limited turn rate (rad/s) */
  faceTowards(target, turnRate, dt) {
    rotateTowards(this.pos, this.quat, target, turnRate * dt);
    if (this.mesh) this.mesh.quaternion.copy(this.quat);
  }

  /* push away from the nearest asteroid surface (universal reflex) */
  avoidGround(dt, power) {
    const hit = G.world.asteroids.querySphere(this.pos, 42);
    if (hit) {
      const str = (hit.depth / 42) * power;
      this.vel.x += hit.nx * str * dt; this.vel.y += hit.ny * str * dt; this.vel.z += hit.nz * str * dt;
      return true;
    }
    return false;
  }

  updateFlash(dt) {
    if (this.flash > 0) {
      this.flash = Math.max(0, this.flash - 5 * dt);
      for (const fm of this.flashMats) fm.mat.emissiveIntensity = fm.base + this.flash * 3.2;
    }
  }

  damage(dmg, hitPos, vel) {
    if (!this.alive || dmg <= 0) return false;
    this.hp -= dmg;
    this.flash = 1;
    if (hitPos) { for (const fm of this.flashMats) fm.mat.emissiveIntensity = fm.base + 3.2; }
    if (this.hp <= 0) { this._die(); return true; }
    // sub-lethal hits have a chance to spook the pilot (see Fighter)
    if (this.onHurt) this.onHurt(dmg);
    return false;
  }

  _die() {
    this.alive = false;
    G.game.onEnemyKilled(this);
  }

  dispose() {
    if (this.mesh) {
      G.scene.remove(this.mesh);
      const ownGeo = !!this.mesh.userData.ownGeo;   // Boss owns its one-off geometry
      this.mesh.traverse((o) => {
        // UPGRADE(perf): ship geometry comes from the shared ShipGeo cache —
        // disposing it here would NaN every other ship in the wave. Only the
        // per-instance flash material clone (never flagged `shared`) dies.
        if (o.material && o.material.dispose && !o.material.userData.shared) o.material.dispose();
        if (ownGeo && o.geometry && o.geometry.dispose) o.geometry.dispose();
      });
    }
    this.mesh = null;
  }

  enginePuff(color) {
    // FIX(visuals): local +Z is AFT (noses point down -Z), so the puff
    // must spawn BEHIND the hull — the old `-(radius+1.2)` offset spawned
    // it in front of the nose while the velocity still pushed aft, so the
    // exhaust streamed backwards THROUGH the ship. Now it trails from the
    // nozzles like the player's does.
    _v1.set(0, 0, 1).applyQuaternion(this.quat);
    _v2.copy(this.pos).addScaledVector(_v1, this.radius + 1.2);
    FX.particles.spawn(_v2.x, _v2.y, _v2.z, _v1.x * 12, _v1.y * 12, _v1.z * 12,
      color[0], color[1], color[2], 0.55 + this.radius * 0.12, 0.22, 2, 0.3);
  }
}

/* ------------------------------------------------------------
   FIGHTER — fast, strafing, close-range. The swarm.
   FSM:
     ENTRY  → fly into the arena around the player
     PURSUE → chase a LEAD point (player pos + vel·t̂), full thrust
     ATTACK → orbit the target on a ring while jinking sinusoidally;
              fire 3-round bursts when the nose is within ~8°
     EVADE  → pick a break-off direction, boost away 1.5-2.5s
              (triggered by timers, damage, or the player getting
              behind them — the "uh oh" state)
   Transitions back to PURSUE keep the loop going forever.
------------------------------------------------------------ */
class Fighter extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill, elite) {
    super('fighter');
    const E = CFG.enemies.fighter;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * hpMult;
    this.radius = E.radius * (elite ? 1.3 : 1);
    this.size = elite ? 5 : 3.2;
    this.scoreVal = elite ? CFG.enemies.elite.score : E.score;
    this.dropChance = elite ? 1 : E.dropChance;
    this.elite = !!elite;
    this.waveEnemy = true;
    this.spdMult = spdMult;
    this.leadSkill = leadSkill;
    this.state = 'entry';
    this.stateT = 0;
    this.orbitDir = Math.random() < 0.5 ? 1 : -1;
    this.orbitA = U.rand(0, U.TAU);
    this.jinkSeed = U.rand(0, 100);
    this.evadeDir = new THREE.Vector3();
    this.dest = new THREE.Vector3();
    this.strafeVec = new THREE.Vector3();
    this.fireT = U.rand(0.5, 1.5);
    this.burstN = 0; this.burstT = 0;
    // FIX: per-frame U.rand() calls in the FSM made state exits nondeterministic
    // and the entry approach jitter on the Y axis every single frame. Pick
    // stable per-fighter values once, here.
    this.entryA = U.rand(0, U.TAU); this.entryY = U.rand(-60, 60);
    this.attackDur = U.rand(2.6, 3.4); this.evadeDur = U.rand(1.6, 2.4);
    // UPGRADE(ai): squad behavior — a rotating role counter spreads the wave
    // across four approach lanes (direct / high / low / wide) so attacks come
    // from a SPHERE around you instead of a single funnel. Roles also bias
    // the attack style: 'direct' roles favor committed strafing runs.
    Fighter._roleSeq = (Fighter._roleSeq + 1) % 4;
    this.role = Fighter._roleSeq;
    this.state = 'entry';
    this._buildMesh(elite);
  }

  /* ---------- procedural ship: SAI-3 DART (rebuilt, visual quality pass) ----------
     Sculpted interceptor built from ONE merged hull geometry (cached in
     ShipGeo — shared by every fighter & elite, so spawning a wave costs
     zero geometry allocations) + a merged dark-trim mesh + 2 animated
     engine glow discs. 4 draw calls per ship (was 8), 10x the silhouette.
     Cosmetic `model` child group handles bank-into-turn + barrel rolls. */
  _buildMesh(elite) {
    const g = new THREE.Group();
    const model = new THREE.Group();               // cosmetic bank/roll child
    g.add(model);
    // per-instance hull material = the hit-flash target (elite = gold HVT)
    const hull = new THREE.MeshStandardMaterial({
      color: elite ? 0x4a3a1a : 0x3a2430, metalness: 0.8, roughness: 0.4, envMapIntensity: 1.15,
      emissive: elite ? 0xffc857 : 0xff3040, emissiveIntensity: elite ? 0.5 : 0.35 });
    this.flashMats.push({ mat: hull, base: hull.emissiveIntensity });
    // shared, never-mutated materials (safe across all instances)
    const trim = HULL.recess(0x191f28);
    const glowMat = shared(new THREE.MeshBasicMaterial({
      color: elite ? new THREE.Color(2.6, 1.7, 0.5) : new THREE.Color(2.4, 0.55, 0.7) }));

    // swept wing planform (extruded slab with beveled edges)
    const wingPts = [[0, 0.85], [1.45, -0.15], [1.68, -0.55], [1.42, -0.8], [0, -1.05]];
    const wingGeo = ShipGeo.get('ftr.wing', () => {
      const s = new THREE.Shape();
      s.moveTo(wingPts[0][0], wingPts[0][1]);
      for (let i = 1; i < wingPts.length; i++) s.lineTo(wingPts[i][0], wingPts[i][1]);
      s.closePath();
      return new THREE.ExtrudeGeometry(s,
        { depth: 0.09, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1 });
    });
    /* Properly mirrored wing (shape mirrored + winding reversed) so the
       hull can be single-sided: a negative-scale mirror only "worked"
       because the material was DoubleSide, which also made thin panels
       light up from behind as pale sheets. */
    const wingGeoR = ShipGeo.get('ftr.wingR', () => {
      const s = new THREE.Shape();
      const rev = wingPts.slice().reverse();
      s.moveTo(-rev[0][0], rev[0][1]);
      for (let i = 1; i < rev.length; i++) s.lineTo(-rev[i][0], rev[i][1]);
      s.closePath();
      return new THREE.ExtrudeGeometry(s,
        { depth: 0.09, bevelEnabled: true, bevelThickness: 0.03, bevelSize: 0.03, bevelSegments: 1 });
    });
    // everything shaded with the flashable hull → one merged mesh
    const hullGeo = ShipGeo.get('ftr.hull2', () => mergeGeos([
      { geo: new THREE.CylinderGeometry(0.24, 0.52, 3.0, 8), rot: [-Math.PI / 2, 0, 0], pos: [0, 0, 0.15] },
      { geo: new THREE.ConeGeometry(0.24, 1.2, 8), rot: [-Math.PI / 2, 0, 0], pos: [0, 0, -1.95] },
      { geo: new THREE.BoxGeometry(0.3, 0.18, 1.8), pos: [0, 0.3, 0.5] },
      { geo: wingGeo, rot: [-Math.PI / 2, 0, 0], pos: [0.52, -0.05, 0.55] },
      { geo: wingGeoR, rot: [-Math.PI / 2, 0, 0], pos: [-0.52, -0.05, 0.55] },
      { geo: new THREE.CylinderGeometry(0.09, 0.12, 1.35, 6), rot: [-Math.PI / 2, 0, 0], pos: [2.06, -0.05, 0.1] },
      { geo: new THREE.CylinderGeometry(0.09, 0.12, 1.35, 6), rot: [-Math.PI / 2, 0, 0], pos: [-2.06, -0.05, 0.1] },
      { geo: new THREE.BoxGeometry(0.07, 0.7, 0.85), pos: [0.42, 0.45, 1.3], rot: [0, 0, -0.5] },
      { geo: new THREE.BoxGeometry(0.07, 0.7, 0.85), pos: [-0.42, 0.45, 1.3], rot: [0, 0, 0.5] },
      { geo: new THREE.BoxGeometry(0.06, 0.5, 0.75), pos: [0, -0.4, 1.2] },
      { geo: new THREE.CylinderGeometry(0.055, 0.055, 1.5, 6), rot: [-Math.PI / 2, 0, 0], pos: [0, -0.2, -1.3] },
      /* swarm identity: hex chitin plates riveted along the wings + a
         spiked collar behind the canopy (the doctrine's insect read) */
      { geo: new THREE.CylinderGeometry(0.16, 0.15, 0.035, 6), pos: [1.15, 0.055, -0.1] },
      { geo: new THREE.CylinderGeometry(0.16, 0.15, 0.035, 6), pos: [1.7, 0.055, 0.45] },
      { geo: new THREE.CylinderGeometry(0.16, 0.15, 0.035, 6), pos: [-1.15, 0.055, -0.1] },
      { geo: new THREE.CylinderGeometry(0.16, 0.15, 0.035, 6), pos: [-1.7, 0.055, 0.45] },
      { geo: new THREE.ConeGeometry(0.07, 0.5, 5), rot: [Math.PI / 2, 0, 0], pos: [0.2, 0.34, 0.95] },
      { geo: new THREE.ConeGeometry(0.07, 0.5, 5), rot: [Math.PI / 2, 0, 0], pos: [-0.2, 0.34, 0.95] },
      /* nose chines — a pointed forebody instead of a bare cone */
      { geo: new THREE.BoxGeometry(0.09, 0.16, 1.9), pos: [0.29, -0.02, -1.3], rot: [0, 0.06, 0] },
      { geo: new THREE.BoxGeometry(0.09, 0.16, 1.9), pos: [-0.29, -0.02, -1.3], rot: [0, -0.06, 0] },
      /* tail plates over the engine housings */
      { geo: new THREE.BoxGeometry(0.34, 0.06, 0.7), pos: [0.34, 0.16, 1.5] },
      { geo: new THREE.BoxGeometry(0.34, 0.06, 0.7), pos: [-0.34, 0.16, 1.5] },
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    // dark trim: canopy glass, intakes, nozzles, canopy rail
    const trimGeo = ShipGeo.get('ftr.trim2', () => mergeGeos([
      { geo: new THREE.SphereGeometry(0.3, 10, 8), scale: [0.72, 0.5, 1.6], pos: [0, 0.26, -0.7] },
      { geo: new THREE.BoxGeometry(0.5, 0.06, 1.25), pos: [0, 0.43, -0.7] },
      { geo: new THREE.BoxGeometry(0.14, 0.2, 1.0), pos: [0.52, 0.02, 0.3] },
      { geo: new THREE.BoxGeometry(0.14, 0.2, 1.0), pos: [-0.52, 0.02, 0.3] },
      { geo: new THREE.CylinderGeometry(0.17, 0.24, 0.4, 8), rot: [-Math.PI / 2, 0, 0], pos: [0.34, 0, 1.72] },
      { geo: new THREE.CylinderGeometry(0.17, 0.24, 0.4, 8), rot: [-Math.PI / 2, 0, 0], pos: [-0.34, 0, 1.72] },
      /* panel breaks + belly keel: value structure so the hull reads as
         mass, not a silhouette with a colour fill */
      { geo: new THREE.BoxGeometry(0.34, 0.04, 1.6), pos: [0, -0.3, 0.9] },
      { geo: new THREE.BoxGeometry(0.5, 0.03, 1.9), pos: [0, 0.33, -0.5] },
      { geo: new THREE.BoxGeometry(0.09, 0.24, 0.9), pos: [1.85, -0.02, 0.6] },
      { geo: new THREE.BoxGeometry(0.09, 0.24, 0.9), pos: [-1.85, -0.02, 0.6] },
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    // twin engine discs — individual meshes so each can flicker/pulse
    const engGeo = ShipGeo.get('ftr.eng', () => new THREE.CircleGeometry(0.15, 10));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 0.34, 0, 1.95);
      model.add(e); this.engMeshes.push(e);
    }
    g.scale.setScalar(this.elite ? 1.25 : 1);
    g.position.copy(this.pos);
    this.mesh = g;
    this.model = model;
    this.spin = 0; this.rollDir = Math.random() < 0.5 ? 1 : -1;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  onHurt() {
    // getting shot has a chance to spook them into a break
    if (this.state !== 'evade' && Math.random() < 0.25) this._startEvade();
  }

  /* UPGRADE(ai): committed strafing run — snapshot a pass line through the
     target with a random lateral offset, then fly it flat-out, guns hot.
     Reads as a deliberate attack run instead of the orbit dance. */
  _startStrafe(tgt) {
    this.state = 'strafe'; this.stateT = 0;
    this.strafeVec.copy(this.pos).sub(tgt.pos);
    const d = this.strafeVec.length();
    this.strafeVec.multiplyScalar(1 / (d || 1));
    // perpendicular jitter so passes don't all fly down the same line
    _v2.set(U.rand(-1, 1), U.rand(-1, 1), U.rand(-1, 1));
    this.strafeVec.addScaledVector(_v2, 0.35).normalize();
    this.rollDir = Math.random() < 0.5 ? 1 : -1;
  }

  _startEvade() {
    this.state = 'evade';
    this.stateT = 0;
    // break away from the attacker: away + big random lateral component
    U.randomDir(this.evadeDir);
    _v1.copy(G.player.pos).sub(this.pos).normalize();
    this.evadeDir.addScaledVector(_v1, -0.8).normalize();
  }

  _shoot(target) {
    const E = CFG.enemies.fighter;
    // first-order lead: aim where the target WILL be (imperfectly —
    // leadSkill ramps with waves, jitter shrinks as skill grows)
    _v1.copy(target.pos).sub(this.pos);
    const dist = _v1.length();
    const tGo = dist / E.boltSpeed;
    _v2.copy(target.pos).addScaledVector(target.vel, tGo * this.leadSkill);
    // FIX: jitter was a fixed world-space offset — huge point-blank (shots
    // curved around you) yet pinpoint at 400u (hits without aiming). Scale
    // it with distance instead: accurate in the furball, spray at range.
    const err = ((1.2 - this.leadSkill) * 5 + 2.2) * (0.35 + dist / 520);
    _v2.x += U.rand(-err, err); _v2.y += U.rand(-err, err); _v2.z += U.rand(-err, err);
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v2.sub(this.pos).normalize();
    _v4.copy(this.pos).addScaledVector(_v3, 2.6); // muzzle in front of nose
    Projectiles.fire('ebolt', 'enemy', _v4, _v2, { src: this, speed: E.boltSpeed, dmg: E.boltDmg, life: 3.5 });
    FX.muzzle(_v4, true);
    G.audio.shotBlaster(0.62);
  }

  update(dt) {
    const E = CFG.enemies.fighter;
    this.stateT += dt;
    this.updateFlash(dt);

    // target selection: normally the player; during escort missions some
    // fighters peel off to hammer the disabled ally (see Waves)
    if (G.waves.escortActive() && this._allyFocus === undefined) {
      this._allyFocus = Math.random() < CFG.enemies.escortTargetChance;
    }
    /* §7 DISTRESS: raiders detailed to the beacon pod keep hitting it while
       the call stands. Once it is saved (or lost) they revert to the player,
       so a resolved call can never leave hostiles stuck on a dead target. */
    if (this._podHunter && G.waves.distressActive()) this.target = G.waves.pod;
    else this.target = (this._allyFocus && G.waves.ally && G.waves.ally.alive) ? G.waves.ally : G.player;
    const tgt = this.target;
    _v1.copy(tgt.pos).sub(this.pos);
    const dist = _v1.length();

    const speed = E.speed * this.spdMult;
    switch (this.state) {
      case 'entry': {
        // slide toward a fixed offset around the player, then engage
        // (FIX: Y offset is now stable — was U.rand(-60,60) every frame,
        //  which made fighters vibrate vertically during approach)
        this.dest.set(Math.sin(this.entryA) * 300, this.entryY, Math.cos(this.entryA) * 300).add(G.player.pos);
        // UPGRADE(ai): role-based approach lanes (see constructor)
        if (this.role === 1) this.dest.y += 150;
        else if (this.role === 2) this.dest.y -= 150;
        else if (this.role === 3) { this.dest.x += Math.cos(this.entryA) * 190; this.dest.z -= Math.sin(this.entryA) * 190; }
        this.steerToward(this.dest, dt, speed, E.accel, 80);
        this.faceTowards(tgt.pos, E.turn, dt);
        if (dist < 520) { this.state = 'pursue'; this.stateT = 0; }
        break;
      }
      case 'pursue': {
        // chase the LEAD point so they cut corners instead of trailing
        const tGo = dist / E.boltSpeed;
        this.dest.copy(tgt.pos).addScaledVector(tgt.vel, tGo * this.leadSkill * 1.4);
        this.steerToward(this.dest, dt, speed, E.accel, 45);
        this.faceTowards(tgt.pos, E.turn, dt);
        if (dist < E.attackRange) {
          // UPGRADE(ai): direct-role fighters (and any lucky roll) commit to
          // a strafing run instead of always settling into the orbit waltz
          if (this.role === 0 ? Math.random() < 0.65 : Math.random() < 0.3) this._startStrafe(tgt);
          else { this.state = 'attack'; this.stateT = 0; }
        }
        else if (this.stateT > 9) { this.state = 'entry'; this.stateT = 0; } // lost the plot, re-enter
        break;
      }
      case 'strafe': {
        /* UPGRADE(ai): full-thrust pass THROUGH the snapshot point, guns
           live the whole way. Barrel-rolls cosmetically. Exits once clear
           of the target (or on timeout) and rejoins pursue. */
        this.dest.copy(tgt.pos).addScaledVector(this.strafeVec, 340);
        this.steerToward(this.dest, dt, speed * 1.4, E.accel * 1.6, 12);
        this.faceTowards(tgt.pos, E.turn * 1.3, dt);
        this.spin += dt * 11 * this.rollDir;         // aileron roll flourish
        if (this.stateT > 3.2 || (this.stateT > 0.6 && dist > 360)) { this.state = 'pursue'; this.stateT = 0; }
        break;
      }
      case 'attack': {
        /* Orbit ring: desired point rotates around the target at ~0.9 rad/s.
           Jink = sinusoidal radial/vertical offset (phase from jinkSeed) so
           each fighter weaves on its own rhythm — hard to lead, pretty to
           watch. Facing stays ON the target for firing while velocity
           orbits: THIS is the "strafing" feel. */
        this.orbitA += this.orbitDir * 0.9 * dt;
        const jink = Math.sin(this.stateT * 2.1 + this.jinkSeed);
        const R = E.orbitDist + jink * 24;
        this.dest.set(
          tgt.pos.x + Math.cos(this.orbitA) * R,
          tgt.pos.y + Math.sin(this.stateT * 1.3 + this.jinkSeed) * 18,
          tgt.pos.z + Math.sin(this.orbitA) * R);
        this.steerToward(this.dest, dt, speed * 0.85, E.accel, 30);
        this.faceTowards(tgt.pos, E.turn * 1.2, dt);
        // after a few seconds of orbiting, break off (keeps motion varied)
        if (this.stateT > this.attackDur) this._startEvade();
        if (dist > E.attackRange * 1.8) { this.state = 'pursue'; this.stateT = 0; }
        break;
      }
      case 'evade': {
        // full-thrust escape along evadeDir; face velocity (running away)
        this.dest.copy(this.pos).addScaledVector(this.evadeDir, 300);
        this.steerToward(this.dest, dt, speed * 1.25, E.accel * 1.3, 200);
        _v2.copy(this.pos).add(this.vel);
        this.faceTowards(_v2, E.turn, dt);
        this.spin += dt * 10 * this.rollDir;   // UPGRADE: panicked barrel roll
        if (this.stateT > this.evadeDur) { this.state = 'pursue'; this.stateT = 0; }
        break;
      }
    }

    /* ---- universal reflexes: rock avoidance + flock separation ---- */
    this.avoidGround(dt, 120);
    for (const o of G.enemies.list) {
      if (o === this || !o.alive || o.type !== 'fighter') continue;
      _v2.copy(this.pos).sub(o.pos);
      const d2 = _v2.lengthSq();
      if (d2 < 20 * 20 && d2 > 1e-4) {
        _v2.multiplyScalar(1 / Math.sqrt(d2));
        this.vel.addScaledVector(_v2, 30 * dt);
      }
    }

    // integrate with a hard speed cap
    const maxS = speed * 1.35;
    if (this.vel.length() > maxS) this.vel.setLength(maxS);
    this.pos.addScaledVector(this.vel, dt);
    if (this.mesh) { this.mesh.position.copy(this.pos); this.mesh.quaternion.copy(this.quat); }

    /* ---- UPGRADE(animation): bank into turns + barrel-roll + engine pulse ---- */
    if (this.model) {
      if (this.state === 'strafe' || this.state === 'evade') {
        this.model.rotation.z = this.spin;                    // continuous roll
      } else {
        this.spin = 0;
        // bank toward the lateral velocity component (weighty, readable)
        _v3.set(0, 0, -1).applyQuaternion(this.quat);
        _v4.copy(this.vel).addScaledVector(_v3, -this.vel.dot(_v3));   // lateral vel
        _v5.set(1, 0, 0).applyQuaternion(this.quat);
        const bank = U.clamp(-_v4.dot(_v5) * 0.022, -0.85, 0.85);
        this.model.rotation.z = U.damp(this.model.rotation.z, bank, 5, dt);
      }
      // engine discs pulse with speed; flare white-hot on evades/strafes
      this._glowT += dt;
      const hot = this.state === 'strafe' || this.state === 'evade' ? 1.6 : 1;
      const gs = (0.8 + Math.sin(this._glowT * 21 + this.jinkSeed) * 0.15) * hot;
      this.engMeshes[0].scale.setScalar(gs);
      this.engMeshes[1].scale.setScalar(gs * 0.94);
    }

    /* ---- fire control: 3-round bursts when nose is on target ---- */
    this.fireT -= dt;
    if (this.burstN > 0) {
      this.burstT -= dt;
      if (this.burstT <= 0) { this._shoot(tgt); this.burstN--; this.burstT = 0.09; }
    } else if (this.fireT <= 0 && dist < E.fireRange && this.state !== 'evade') {
      _v2.copy(tgt.pos).sub(this.pos).normalize();
      _v3.set(0, 0, -1).applyQuaternion(this.quat);
      if (_v3.dot(_v2) > 0.99) {   // within ~8° of boresight
        this.burstN = 3; this.burstT = 0;
        this.fireT = U.rand(1.3, 2.3);
      }
    }

    // engine exhaust (one cheap puff — 14 fighters shouldn't cost 14 systems)
    if (Math.random() < 0.6) this.enginePuff(this.elite ? [1, 0.8, 0.3] : [1, 0.35, 0.4]);
  }
}

/* ------------------------------------------------------------
   GUNSHIP — slow, tanky, standoff firepower.
   FSM:
     APPROACH → close to the hold band (220-380u) from the player
     HOLD     → keep-sttation in the band: thrust away if the player
                closes inside holdMin, drift laterally (orbit crawl),
                and fire 5-bolt FAN volleys on a ~2.4s cadence
     EVADE    → rare: heavy damage makes it wallow away briefly
   Turn rate is deliberately terrible (0.7 rad/s) — outmaneuvering
   a gunship should always be the winning move.
------------------------------------------------------------ */
class Gunship extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill, elite) {
    super('gunship');
    const E = CFG.enemies.gunship;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * hpMult;
    this.radius = E.radius;
    this.size = 6.5;
    this.scoreVal = elite ? CFG.enemies.elite.score : E.score;
    this.dropChance = elite ? 1 : E.dropChance;
    this.elite = !!elite;
    this.waveEnemy = true;
    this.spdMult = spdMult; this.leadSkill = leadSkill;
    this.state = 'approach';
    this.stateT = 0;
    this.latDir = Math.random() < 0.5 ? 1 : -1;
    this.fireT = U.rand(1.2, 2.2);
    this.hvt = elite;      // marked secondary objective target
    this._buildMesh(elite);
  }

  /* ---------- procedural ship: VULCAN CORVETTE (rebuilt) ----------
     Merged-hull gunship: flat hexagonal armored hull, ram prow, jaw
     prongs, sponsons, canted tail fins — all one cached geometry (4
     draw calls was 11). The top turret is a REAL sub-assembly that
     physically tracks the player, and every third volley adds a
     pair of homing missiles (see _missileSalvo). */
  _buildMesh(elite) {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: elite ? 0x4a3a1a : 0x2c3440, metalness: 0.8, roughness: 0.42,
      emissive: elite ? 0xffc857 : 0xff7030, emissiveIntensity: elite ? 0.5 : 0.3,
      envMapIntensity: 1.15 });
    this.flashMats.push({ mat: hull, base: hull.emissiveIntensity });
    const trim = HULL.recess(0x171c24);
    const glowMat = shared(new THREE.MeshBasicMaterial({
      color: elite ? new THREE.Color(2.6, 1.8, 0.6) : new THREE.Color(2.4, 1.1, 0.4) }));

    const hullGeo = ShipGeo.get('gun.hull', () => mergeGeos([
      { geo: new THREE.CylinderGeometry(1.15, 1.45, 6.8, 6), rot: [-Math.PI / 2, 0, 0], scale: [1.35, 0.72, 1] },
      { geo: new THREE.ConeGeometry(1.15, 2.8, 6), rot: [-Math.PI / 2, 0, 0], scale: [1.35, 0.72, 1], pos: [0, 0, -4.75] },
      { geo: new THREE.BoxGeometry(1.7, 0.9, 2.0), pos: [0, 1.05, 0.8] },
      { geo: new THREE.BoxGeometry(0.85, 0.65, 3.4), pos: [1.65, -0.1, 0.4] },
      { geo: new THREE.BoxGeometry(0.85, 0.65, 3.4), pos: [-1.65, -0.1, 0.4] },
      { geo: new THREE.BoxGeometry(1.05, 0.85, 1.7), pos: [0.95, 0, 3.5] },
      { geo: new THREE.BoxGeometry(1.05, 0.85, 1.7), pos: [-0.95, 0, 3.5] },
      { geo: new THREE.BoxGeometry(0.1, 1.05, 1.5), pos: [0.95, 0.85, 2.6], rot: [0, 0, 0.45] },
      { geo: new THREE.BoxGeometry(0.1, 1.05, 1.5), pos: [-0.95, 0.85, 2.6], rot: [0, 0, -0.45] },
      { geo: new THREE.BoxGeometry(1.05, 1.0, 4.2), pos: [2.25, -0.15, -4.3] },
      { geo: new THREE.BoxGeometry(1.05, 1.0, 4.2), pos: [-2.25, -0.15, -4.3] },
      /* MILITIA doctrine: welded patch plates + exposed frame rails. The
         hull is a fat industrial brick — it should look bolted together,
         not moulded. */
      { geo: new THREE.BoxGeometry(1.5, 0.14, 2.4), pos: [0, 1.55, -1.9] },      // bow deck patch
      { geo: new THREE.BoxGeometry(1.9, 0.5, 0.5), pos: [0, 0.2, -5.6] },        // ram plate
      { geo: new THREE.BoxGeometry(0.5, 0.5, 2.6), pos: [1.9, 0.9, -2.4], rot: [0, 0, 0.2] },
      { geo: new THREE.BoxGeometry(0.5, 0.5, 2.6), pos: [-1.9, 0.9, -2.4], rot: [0, 0, -0.2] },
      { geo: new THREE.BoxGeometry(0.34, 0.34, 1.3), pos: [2.9, 0.7, 3.0] },     // pod braces
      { geo: new THREE.BoxGeometry(0.34, 0.34, 1.3), pos: [-2.9, 0.7, 3.0] },
      { geo: new THREE.BoxGeometry(1.2, 0.3, 0.8), pos: [0, 1.6, 1.7] },         // sensor block
      { geo: new THREE.BoxGeometry(1.1, 0.22, 3.0), pos: [0, -1.05, 1.2] },      // belly keel
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('gun.trim', () => mergeGeos([
      { geo: new THREE.BoxGeometry(2.2, 0.12, 3.2), pos: [0, 0.62, 0.6] },
      { geo: new THREE.CylinderGeometry(0.55, 0.68, 0.35, 8), pos: [0, 1.62, 0.4] },
      { geo: new THREE.BoxGeometry(0.9, 0.2, 1.2), pos: [1.65, 0.25, 1.6] },
      { geo: new THREE.BoxGeometry(0.9, 0.2, 1.2), pos: [-1.65, 0.25, 1.6] },
      { geo: new THREE.BoxGeometry(0.9, 0.5, 2.2), pos: [0, -0.75, -1.0] },
      { geo: new THREE.CylinderGeometry(0.5, 0.34, 0.5, 8), rot: [-Math.PI / 2, 0, 0], pos: [0.95, 0, 4.45] },
      { geo: new THREE.CylinderGeometry(0.5, 0.34, 0.5, 8), rot: [-Math.PI / 2, 0, 0], pos: [-0.95, 0, 4.45] },
      { geo: new THREE.CylinderGeometry(0.34, 0.2, 0.9, 6), rot: [-Math.PI / 2, 0, 0], pos: [2.25, -0.15, -6.8] },
      { geo: new THREE.CylinderGeometry(0.34, 0.2, 0.9, 6), rot: [-Math.PI / 2, 0, 0], pos: [-2.25, -0.15, -6.8] },
      /* panel breaks + hatches: value structure across the big slab sides */
      { geo: new THREE.BoxGeometry(2.0, 0.05, 0.24), pos: [0, 0.92, -1.5] },
      { geo: new THREE.BoxGeometry(2.0, 0.05, 0.24), pos: [0, 0.92, 2.4] },
      { geo: new THREE.BoxGeometry(0.24, 0.05, 5.4), pos: [1.0, 1.5, 0.2] },
      { geo: new THREE.BoxGeometry(0.24, 0.05, 5.4), pos: [-1.0, 1.5, 0.2] },
      { geo: new THREE.BoxGeometry(0.28, 0.7, 1.1), pos: [3.0, -0.15, 1.2] },
      { geo: new THREE.BoxGeometry(0.28, 0.7, 1.1), pos: [-3.0, -0.15, 1.2] },
      { geo: new THREE.BoxGeometry(0.7, 0.5, 0.16), pos: [0, 0.1, 6.6] },        // stern vent
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));

    // UPGRADE: tracking turret — dome + twin barrels as one merged head
    const headGeo = ShipGeo.get('gun.turret', () => mergeGeos([
      { geo: new THREE.CylinderGeometry(0.42, 0.5, 0.55, 8), pos: [0, 0.22, 0] },
      { geo: new THREE.SphereGeometry(0.34, 10, 8), pos: [0, 0.42, 0] },
      { geo: new THREE.CylinderGeometry(0.09, 0.09, 1.7, 6), rot: [Math.PI / 2, 0, 0], pos: [0.24, 0.42, -0.85] },
      { geo: new THREE.CylinderGeometry(0.09, 0.09, 1.7, 6), rot: [Math.PI / 2, 0, 0], pos: [-0.24, 0.42, -0.85] },
    ]));
    this.turretHead = new THREE.Mesh(headGeo, trim);
    this.turretHead.rotation.order = 'YXZ';
    this.turretHead.position.set(0, 1.82, 0.4);
    model.add(this.turretHead);
    const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.09, 6, 6),
      shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.4, 0.5) })));
    sensor.position.set(0, 0.72, -0.15);
    this.turretHead.add(sensor);

    const engGeo = ShipGeo.get('gun.eng', () => new THREE.CircleGeometry(0.42, 12));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 0.95, 0, 4.72);
      model.add(e); this.engMeshes.push(e);
    }
    g.scale.setScalar(elite ? 1.3 : 1);
    g.position.copy(this.pos);
    this.mesh = g;
    this.model = model;
    this._glowT = U.rand(0, 10);
    this.volleyN = 0;
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  /* UPGRADE(ai): paired homing missiles off the wing stations. Slow fly-out,
     then the seeker does the work — forces the player to actually deal
     with them (shoot them down / outmaneuver) instead of strafing past. */
  _missileSalvo(tgt) {
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v5.set(1, 0, 0).applyQuaternion(this.quat);
    for (const s of [-1, 1]) {
      _v4.copy(this.pos).addScaledVector(_v3, 3.5).addScaledVector(_v5, s * 2.3);
      _v2.copy(_v3).addScaledVector(_v5, s * 0.55).normalize();
      Projectiles.fire('emissile', 'enemy', _v4, _v2, { src: this,
        speed: 110, maxSpeed: 255, dmg: 12, life: 8,
        target: tgt, turn: 2.1, aoe: 12, aoeDmg: 9, hp: 1 });
    }
    FX.muzzle(_v4, true);
    G.audio.shotMissile();
  }

  onHurt() {
    if (this.state !== 'evade' && Math.random() < 0.1) { this.state = 'evade'; this.stateT = 0; }
  }

  _volley(target) {
    const E = CFG.enemies.gunship;
    _v1.copy(target.pos).sub(this.pos);
    const dist = _v1.length();
    const tGo = dist / E.boltSpeed;
    _v2.copy(target.pos).addScaledVector(target.vel, tGo * this.leadSkill);
    _v2.y += U.rand(-4, 4);
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, 5.5);
    // 5-bolt fan: spread over the local X axis
    for (let i = -2; i <= 2; i++) {
      _v5.copy(_v2).sub(_v4).normalize();
      _v6.set(1, 0, 0).applyQuaternion(this.quat);
      _v5.addScaledVector(_v6, i * 0.045).normalize();
      Projectiles.fire('ebolt', 'enemy', _v4, _v5, { src: this, speed: E.boltSpeed, dmg: E.boltDmg, life: 4 });
    }
    FX.muzzle(_v4, true);
    G.audio.shotBlaster(0.4);
  }

  update(dt) {
    const E = CFG.enemies.gunship;
    this.stateT += dt;
    this.updateFlash(dt);

    const tgt = G.player;
    _v1.copy(tgt.pos).sub(this.pos);
    const dist = _v1.length();
    const speed = E.speed * this.spdMult;

    /* UPGRADE(animation+ai): the top turret physically tracks the player
       (rate-limited via damp); when you're behind it, it slews back to
       forward park instead of snapping. */
    if (this.turretHead) {
      _q1.copy(this.quat).invert();
      _v2.copy(tgt.pos).sub(this.pos).applyQuaternion(_q1);
      const yaw = Math.atan2(-_v2.x, -_v2.z);
      const pitch = Math.atan2(_v2.y, Math.hypot(_v2.x, _v2.z));
      if (Math.abs(yaw) < 2.5) {
        this.turretHead.rotation.y = U.damp(this.turretHead.rotation.y, yaw, 4, dt);
        this.turretHead.rotation.x = U.damp(this.turretHead.rotation.x, U.clamp(pitch, -0.6, 0.9), 4, dt);
      } else {
        this.turretHead.rotation.y = U.damp(this.turretHead.rotation.y, 0, 1.5, dt);
        this.turretHead.rotation.x = U.damp(this.turretHead.rotation.x, 0, 1.5, dt);
      }
    }

    switch (this.state) {
      case 'approach': {
        this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        this.faceTowards(tgt.pos, E.turn, dt);
        if (dist < E.holdMax) { this.state = 'hold'; this.stateT = 0; }
        break;
      }
      case 'hold': {
        /* Band-keeping: the gunship wants to live in [holdMin, holdMax].
           Inside holdMin → thrust backward; beyond holdMax → close in;
           in the sweet spot → lateral orbit crawl. Result: it "walls"
           the arena center and waits for you to fly through the fan. */
        if (dist < E.holdMin) {
          _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(120).add(this.pos);
          this.steerToward(_v2, dt, speed, E.accel, 30);
        } else if (dist > E.holdMax) {
          this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        } else {
          // slow lateral drift around the player
          _v2.copy(this.pos).sub(tgt.pos);
          _v2.y = 0;
          if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
          _v3.set(-_v2.z, 0, _v2.x).normalize().multiplyScalar(this.latDir * 60);
          _v3.add(this.pos);
          this.steerToward(_v3, dt, speed * 0.6, E.accel * 0.6, 25);
        }
        this.faceTowards(tgt.pos, E.turn, dt);
        break;
      }
      case 'evade': {
        _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(200).add(this.pos);
        this.steerToward(_v2, dt, speed * 1.2, E.accel, 60);
        this.faceTowards(tgt.pos, E.turn * 0.6, dt);
        if (this.stateT > 2.2) { this.state = 'hold'; this.stateT = 0; }
        break;
      }
    }

    this.avoidGround(dt, 60);
    if (this.vel.length() > speed * 1.3) this.vel.setLength(speed * 1.3);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    /* UPGRADE(animation): engine flicker + faint mass sway + banking into
       lateral drift — the corvette should feel like 150 tons of metal. */
    this._glowT += dt;
    const gs = 0.9 + Math.sin(this._glowT * 13) * 0.14;
    this.engMeshes[0].scale.setScalar(gs);
    this.engMeshes[1].scale.setScalar(gs * 0.95);
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.vel).addScaledVector(_v3, -this.vel.dot(_v3));
    _v5.set(1, 0, 0).applyQuaternion(this.quat);
    this.model.rotation.z = U.damp(this.model.rotation.z, U.clamp(-_v4.dot(_v5) * 0.006, -0.28, 0.28), 3, dt);

    // volley cadence — needs the nose roughly on target
    this.fireT -= dt;
    if (this.fireT <= 0 && dist < E.fireRange && this.state !== 'evade') {
      _v2.copy(tgt.pos).sub(this.pos).normalize();
      _v3.set(0, 0, -1).applyQuaternion(this.quat);
      if (_v3.dot(_v2) > 0.95) {
        this._volley(tgt);
        // UPGRADE(ai): every third volley adds a homing missile pair
        if (++this.volleyN % 3 === 0) this._missileSalvo(tgt);
        this.fireT = U.rand(2.2, 2.7);
      }
    }

    if (Math.random() < 0.5) this.enginePuff([1, 0.55, 0.2]);
  }
}

/* ------------------------------------------------------------
   TURRET — stationary, mounted on asteroids or station hulls.
   Rides its host rock's rotation (offset is transformed by the
   host's CURRENT quaternion every frame — shoot the rock, the
   turret goes with it). No FSM, just: track → burst → cooldown.
------------------------------------------------------------ */
class Turret extends Enemy {
  // hostIdx: asteroid index, or -1 with fixedWorld for station mounts
  constructor(hostIdx, localOffset, fixedWorld) {
    super('turret');
    const E = CFG.enemies.turret;
    this.hostIdx = hostIdx;
    this.offset = localOffset ? localOffset.clone() : new THREE.Vector3();
    this.fixedWorld = fixedWorld ? fixedWorld.clone() : null;
    this.hp = this.maxHp = E.hp;
    this.radius = E.radius;
    this.size = 2.5;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = false;
    this.fireT = U.rand(1, 2);
    this.burstN = 0; this.burstT = 0;
    this.active = false;       // dormant until wave 2 (intro mercy)
    this._buildMesh();
    this.update(0.0001);       // place correctly immediately
  }

  /* UPGRADE(model): merged, cached turret — base/collar/head/barrels in one
     draw call (was 4) + an emissive threat-ring so dormant turrets read
     instantly against the rock they're bolted to. */
  _buildMesh() {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0x272e3a, metalness: 0.75, roughness: 0.45,
      emissive: 0x30b8ff, emissiveIntensity: 0.25, envMapIntensity: 1.1 });
    this.flashMats.push({ mat: hull, base: hull.emissiveIntensity });
    const geo = ShipGeo.get('tur.body', () => mergeGeos([
      { geo: new THREE.CylinderGeometry(1.7, 2.1, 1.2, 8) },
      { geo: new THREE.CylinderGeometry(1.0, 1.2, 0.5, 8), pos: [0, 0.8, 0] },
      { geo: new THREE.SphereGeometry(1.15, 12, 10), pos: [0, 1.35, 0] },
      { geo: new THREE.CylinderGeometry(0.17, 0.17, 3.2, 6), rot: [Math.PI / 2, 0, 0], pos: [0.5, 1.35, -1.7] },
      { geo: new THREE.CylinderGeometry(0.17, 0.17, 3.2, 6), rot: [Math.PI / 2, 0, 0], pos: [-0.5, 1.35, -1.7] },
      { geo: new THREE.BoxGeometry(0.5, 0.4, 1.0), pos: [0.5, 1.35, -0.6] },
      { geo: new THREE.BoxGeometry(0.5, 0.4, 1.0), pos: [-0.5, 1.35, -0.6] },
      { geo: new THREE.CylinderGeometry(0.04, 0.04, 0.9, 4), pos: [0.4, 2.4, 0.3] },
    ]));
    g.add(new THREE.Mesh(geo, hull));
    const ring = new THREE.Mesh(ShipGeo.get('tur.ring', () =>
        new THREE.TorusGeometry(1.32, 0.06, 6, 20)),
      shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 1.6, 2.4) })));
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.55;
    g.add(ring);
    this.mesh = g;
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  _worldPos(out) {
    if (this.fixedWorld) return out.copy(this.fixedWorld);
    const F = G.world.asteroids;
    out.copy(this.offset).applyQuaternion(F.quats[this.hostIdx]);
    out.x += F.ax[this.hostIdx]; out.y += F.ay[this.hostIdx]; out.z += F.az[this.hostIdx];
    return out;
  }

  _shoot() {
    const E = CFG.enemies.turret, tgt = G.player;
    _v1.copy(tgt.pos).sub(this.pos);
    const dist = _v1.length();
    const tGo = dist / E.boltSpeed;
    _v2.copy(tgt.pos).addScaledVector(tgt.vel, tGo * 0.9);
    // FIX: same distance-scaled spread as fighters — turrets used to be
    // pinpoint snipers at max range (±3u at 430u ≈ 0.4° of cone)
    const err = 2.0 * (0.35 + dist / 520);
    _v2.x += U.rand(-err, err); _v2.y += U.rand(-err, err); _v2.z += U.rand(-err, err);
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, 2.5);
    _v2.sub(this.pos).normalize();
    Projectiles.fire('ebolt', 'enemy', _v4, _v2, { src: this, speed: E.boltSpeed, dmg: E.boltDmg, life: 3 });
    FX.muzzle(_v4, true);
    G.audio.shotBlaster(0.5);
  }

  update(dt) {
    const E = CFG.enemies.turret;
    dt = Math.max(dt, 0);
    this.updateFlash(dt);
    // ride the host rock
    this._worldPos(this.pos);
    this.mesh.position.copy(this.pos);

    if (!this.active) {
      // dormant: slow scanning sweep. FIX: rotate the QUATERNION itself —
      // the old mesh.rotation.y increment was immediately overwritten by
      // the mesh.quaternion.copy(this.quat) used by aiming, so the idle
      // scan never actually moved.
      _q1.setFromAxisAngle(UP, 0.3 * dt);
      this.quat.premultiply(_q1);
      this.mesh.quaternion.copy(this.quat);
      return;
    }
    const tgt = G.player;
    _v1.copy(tgt.pos).sub(this.pos);
    const dist = _v1.length();
    if (tgt.alive && dist < E.range) {
      this.faceTowards(tgt.pos, E.turn, dt);
      this.fireT -= dt;
      if (this.burstN > 0) {
        this.burstT -= dt;
        if (this.burstT <= 0) { this._shoot(); this.burstN--; this.burstT = 0.14; }
      } else if (this.fireT <= 0) {
        _v2.copy(tgt.pos).sub(this.pos).normalize();
        _v3.set(0, 0, -1).applyQuaternion(this.quat);
        if (_v3.dot(_v2) > 0.98) { this.burstN = 4; this.burstT = 0; this.fireT = U.rand(1.6, 2.4); }
      }
    } else {
      // out of range: keep a lazy scan (same quaternion-based fix)
      _q1.setFromAxisAngle(UP, 0.25 * dt);
      this.quat.premultiply(_q1);
      this.mesh.quaternion.copy(this.quat);
    }
    // tracking glow: hot when it's actually dangerous
    for (const fm of this.flashMats) fm.mat.emissiveIntensity = fm.base + this.flash * 3.2;
  }
}

/* ------------------------------------------------------------
   MINE — drifting proximity trap.
   IDLE (slow drift + soft pulse) → ARMED (player inside trigger
   radius: fast blink, 0.8s to get out) → DETONATE (AoE hurts
   EVERYTHING — player, enemies, rocks — chain reactions are the
   point). Shooting one pops it from a safe distance.
------------------------------------------------------------ */
class Mine extends Enemy {
  constructor(pos) {
    super('mine');
    const E = CFG.enemies.mine;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp;
    this.radius = E.radius;
    this.size = 2.2;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = false;
    this.vel = U.randomDir(new THREE.Vector3()).multiplyScalar(U.rand(1.5, 4));
    this.state = 'idle'; this.armT = 0;
    this._buildMesh();
  }

  /* UPGRADE(model): merged spike shell (cached — one fixed spike pattern
     shared by all mines) around a separate pulsing red core. 2 draw calls,
     reads as a proper naval mine instead of a spiky ball. */
  _buildMesh() {
    const g = new THREE.Group();
    const shellMat = shared(new THREE.MeshStandardMaterial({ color: 0x232028, metalness: 0.7,
      roughness: 0.55, envMapIntensity: 1.0 }));
    const shell = ShipGeo.get('mine.shell', () => {
      const parts = [{ geo: new THREE.IcosahedronGeometry(1.3, 1) }];
      for (let i = 0; i < 8; i++) {
        // fixed pseudo-random spike pattern (deterministic, baked once)
        const a = i * 2.399, y = 1 - (i / 7) * 2, r = Math.sqrt(1 - y * y);
        _v1.set(Math.cos(a) * r, y, Math.sin(a) * r);
        parts.push({ geo: new THREE.ConeGeometry(0.16, 0.95, 5),
          pos: [_v1.x * 1.25, _v1.y * 1.25, _v1.z * 1.25],
          rot: [0, 0, 0] });
        // orient cone +Y along the spike dir: build quaternion via euler hack
        const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), _v1.clone());
        const e = new THREE.Euler().setFromQuaternion(q);
        parts[parts.length - 1].rot = [e.x, e.y, e.z];
      }
      return mergeGeos(parts);
    });
    g.add(new THREE.Mesh(shell, shellMat));
    const coreMat = new THREE.MeshStandardMaterial({ color: 0x2a0a10, metalness: 0.4, roughness: 0.6,
      emissive: 0xff2040, emissiveIntensity: 0.4 });
    this.flashMats.push({ mat: coreMat, base: 0.4 });
    const core = new THREE.Mesh(ShipGeo.get('mine.core', () =>
      new THREE.IcosahedronGeometry(0.72, 1)), coreMat);
    g.add(core);
    g.position.copy(this.pos);
    this.mesh = g;
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  update(dt) {
    const E = CFG.enemies.mine;
    this.updateFlash(dt);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y += 0.8 * dt; this.mesh.rotation.x += 0.3 * dt;

    const p = G.player;
    const d = p.alive ? this.pos.distanceTo(p.pos) : 1e9;
    if (this.state === 'idle') {
      // soft heartbeat pulse
      const s = 0.4 + 0.35 * (0.5 + 0.5 * Math.sin(performance.now() * 0.004));
      for (const fm of this.flashMats) if (this.flash <= 0) fm.mat.emissiveIntensity = s;
      if (d < E.trigger) { this.state = 'armed'; this.armT = 0; G.audio.lockBeep(true); }
    } else if (this.state === 'armed') {
      this.armT += dt;
      // frantic strobing — the "MOVE" tell
      const s = Math.sin(this.armT * 40) > 0 ? 3.2 : 0.2;
      for (const fm of this.flashMats) if (this.flash <= 0) fm.mat.emissiveIntensity = s;
      if (d > E.trigger * 1.6) { this.state = 'idle'; }          // you made it
      else if (this.armT > 0.8) { this._srcPlayer = false; this._die(); }   // you didn't
    }
  }

  /* FIX 1: detonate on ANY death — previously only the timed trigger ran
     the AoE (shooting a mine just quietly deleted it).
     FIX 2: remember WHO set it off. A blast the PLAYER triggered (shooting
     it, or their missiles' AoE chaining into it) no longer hurts the
     player — popping a trap from range is the reward. Walking into the
     proximity fuse still very much hurts (see update: timer resets the
     flag before self-detonating). */
  damage(dmg, hitPos, vel, byPlayer) {
    if (!this.alive || dmg <= 0) return false;
    this._srcPlayer = !!byPlayer;
    return super.damage(dmg, hitPos, vel);
  }
  _die() {
    if (!this.alive) return;
    this.alive = false;
    Projectiles._explode(this.pos, CFG.enemies.mine.blast, CFG.enemies.mine.blastDmg, !this._srcPlayer);
    FX.addTrauma(0.4);
    G.game.onEnemyKilled(this);
  }
}

/* ============================================================
   ENEMY MANAGER — owns the list, spawning rings, ram checks
============================================================ */
const Enemies = {
  list: [],

  /* spawn on a ring around the player. frontBias: fraction of spawns
     that arrive in the player's forward hemisphere (pressure where
     you're looking) vs behind (panic checks). */
  _ringPos(out, minD, maxD, frontBias) {
    const p = G.player;
    const behind = Math.random() > frontBias;
    const a = behind ? U.rand(2.2, 4.1) * (Math.random() < 0.5 ? 1 : -1) : U.rand(-1.6, 1.6);
    out.set(Math.sin(a), U.rand(-0.3, 0.3), -Math.cos(a)).normalize().applyQuaternion(p.quat);
    out.multiplyScalar(U.rand(minD, maxD)).add(p.pos);
    // don't spawn inside a rock — nudge out along the push normal
    const hit = G.world.asteroids.querySphere(out, 30);
    if (hit) { out.x += hit.nx * 70; out.y += hit.ny * 70; out.z += hit.nz * 70; }
    if (out.length() > CFG.world.boundary) out.setLength(CFG.world.boundary * 0.9);
    return out;
  },

  spawnFighter(opts) {
    opts = opts || {};
    // FIX(buttons): difficulty/modifiers never reached enemy stats
    opts.hpMult = G.game.spawnHpMult(opts.hpMult);
    opts.leadSkill = (opts.leadSkill || 0.7) * G.game.diffMult().ai.leadSkill;
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 620, 950, 0.7);
    const f = new Fighter(pos, opts.hpMult, opts.spdMult || 1,
      opts.leadSkill, opts.elite || false);
    this.list.push(f);
    return applyEliteMods(f);   // FIX: the wave elites skipped this funnel
  },

  spawnGunship(opts) {
    opts = opts || {};
    opts.hpMult = G.game.spawnHpMult(opts.hpMult);
    opts.leadSkill = (opts.leadSkill || 0.75) * G.game.diffMult().ai.leadSkill;
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 700, 1000, 0.55);
    const gs = new Gunship(pos, opts.hpMult, opts.spdMult || 1,
      opts.leadSkill, opts.elite || false);
    this.list.push(gs);
    return applyEliteMods(gs);   // FIX: HVTs skipped this too
  },

  spawnTurret(hostIdx, localOffset, fixedWorld) {
    const t = new Turret(hostIdx, localOffset, fixedWorld);
    this.list.push(t);
    return t;
  },

  spawnMine(pos) {
    const m = new Mine(pos || this._ringPos(new THREE.Vector3(), 500, 800, 0.5));
    this.list.push(m);
    return m;
  },

  /* NEW ENEMY SPAWNERS — used by the wave director + cheat console */
  spawnBomber(opts) {
    opts = opts || {};
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 700, 1000, 0.6);
    const b = new Bomber(pos, opts.hpMult || 1, opts.spdMult || 1, opts.leadSkill || 0.7);
    this.list.push(b);
    return b;
  },
  spawnDrone(opts) {
    opts = opts || {};
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 420, 700, 0.7);
    const d = new Drone(pos);
    this.list.push(d);
    return d;
  },

  /* UPGRADE(v1.3/v1.4): heavy + support + new-content spawners.
     applyEliteMods() is applied here so every spawn path (waves,
     cheats, boss escorts) gets consistent elite treatment. */
  spawnRavager(opts) {
    opts = opts || {};
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 700, 1000, 0.6);
    const r = new Ravager(pos, opts.hpMult || 1, opts.spdMult || 1, opts.leadSkill || 0.7);
    r.elite = !!opts.elite;
    this.list.push(r);
    return applyEliteMods(r);
  },

  /* UPGRADE(content v1.8): the two new hostiles. Same funnel as the
     ravager — opts defaults, elite flag, applyEliteMods on the way out. */
  spawnReaper(opts) {
    opts = opts || {};
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 1000, 1400, 0.6);
    const r = new Reaper(pos, opts.hpMult || 1, opts.spdMult || 1, opts.leadSkill || 0.7);
    r.elite = !!opts.elite;
    this.list.push(r);
    return applyEliteMods(r);
  },

  spawnProwler(opts) {
    opts = opts || {};
    // low front bias: prowlers are meant to arrive behind/beside the player
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 700, 950, 0.35);
    const p = new Prowler(pos, opts.hpMult || 1, opts.spdMult || 1, opts.leadSkill || 0.7);
    p.elite = !!opts.elite;
    this.list.push(p);
    return applyEliteMods(p);
  },

  /* UPGRADE(content v1.8.1): cloak sniper, pod layer, repair hull —
     the same funnel as the v1.8 pair above (opts defaults, elite flag,
     applyEliteMods on the way out). */
  spawnStalker(opts) {
    opts = opts || {};
    // low front bias: stalkers come in from the flanks, not the muzzle
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 800, 1150, 0.4);
    const s = new Stalker(pos, opts.hpMult || 1, opts.spdMult || 1, opts.leadSkill || 0.7);
    s.elite = !!opts.elite;
    this.list.push(s);
    return applyEliteMods(s);
  },

  spawnSapper(opts) {
    opts = opts || {};
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 700, 1000, 0.5);
    const s = new Sapper(pos, opts.hpMult || 1, opts.spdMult || 1, opts.leadSkill || 0.7);
    s.elite = !!opts.elite;
    this.list.push(s);
    return applyEliteMods(s);
  },

  spawnWarden(opts) {
    opts = opts || {};
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 900, 1250, 0.4);
    const w = new Warden(pos, opts.hpMult || 1, opts.spdMult || 1, opts.leadSkill || 0.7);
    w.elite = !!opts.elite;
    this.list.push(w);
    return applyEliteMods(w);
  },

  spawnSentinel(opts) {
    opts = opts || {};
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 800, 1100, 0.5);
    const s = new Sentinel(pos, opts.hpMult || 1, opts.spdMult || 1);
    s.elite = !!opts.elite;
    this.list.push(s);
    return applyEliteMods(s);
  },

  spawnInterdictor(opts) {
    opts = opts || {};
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 800, 1100, 0.5);
    const it2 = new Interdictor(pos, opts.hpMult || 1, opts.spdMult || 1, opts.leadSkill || 0.7);
    it2.elite = !!opts.elite;
    this.list.push(it2);
    return applyEliteMods(it2);
  },

  spawnInterceptor(opts) {
    opts = opts || {};
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 620, 950, 0.7);
    const i = new Interceptor(pos, opts.hpMult || 1, opts.spdMult || 1, opts.leadSkill || 0.7);
    i.elite = !!opts.elite;
    this.list.push(i);
    return applyEliteMods(i);
  },

  spawnHive(opts) {
    opts = opts || {};
    const pos = opts.pos || this._ringPos(new THREE.Vector3(), 760, 1050, 0.5);
    const h = new Hive(pos, opts.hpMult || 1, opts.spdMult || 1, opts.elite || false);
    h.elite = !!opts.elite;
    this.list.push(h);
    return applyEliteMods(h);
  },


  /* turrets sitting on a rock that just got vaped die with it */
  notifyAsteroidDestroyed(i) {
    for (const e of this.list) {
      if (e.type === 'turret' && e.hostIdx === i && e.alive) {
        e.hp = -1; e.alive = false;
        FX.explosion(e.pos, 3);
        G.game.onEnemyKilled(e);
      }
    }
  },

  countAlive(type) {
    let n = 0;
    for (const e of this.list) if (e.alive && (!type || e.type === type)) n++;
    return n;
  },
  countWaveAlive() {
    let n = 0;
    for (const e of this.list) if (e.alive && e.waveEnemy) n++;
    return n;
  },

  update(dt) {
    const p = G.player;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const e = this.list[i];
      if (!e.alive) {
        // boss lingers through its death sequence before removal
        // FIX(skip): an early core kill (_skip / ARMAGEDDON) could beat the
        // constructor's hitSpheres init (during _buildMesh → scene flush)
        // — e.update() then ran on a half-built boss and hard-crashed. The
        // next frame from rAF fixes everything anyway.
        if (!e.keepAfterDeath) { e.dispose(); this.list.splice(i, 1); }
        else if (e.hitSpheres) e.update(dt);
        continue;
      }
      e.update(dt);
      // ---- ram check: colliding with the player wrecks both ----
      // FIX(cheat bug): a no-clip ghost passed THROUGH enemies and they
      // still took 120 collision damage and died. Noclip now also means
      // untouchable — plus a general invulnerability guard so spawn-protected
      // players can't get rammed before they can move.
      if (p.alive && !p.invulnerable() &&
          !(G.cheats && G.cheats.noclip) && e.type !== 'turret' && e.type !== 'boss') {
        const rr = e.radius + CFG.combat.playerRadius;
        if (e.pos.distanceToSquared(p.pos) < rr * rr) {
          _v1.copy(p.pos).sub(e.pos).normalize();
          p.vel.addScaledVector(_v1, 26);          // knock the player away
          e.damage(120, e.pos);                     // fighters die on impact
          // §4 NEMESIS: attribute the ram to the instance that did it
          p.damage(CFG.enemies.contactDmg, p.pos, false, e);
          FX.addTrauma(0.4);
        }
      }
    }
  },

  activateTurrets() { for (const e of this.list) if (e.type === 'turret') e.active = true; },

  /* CAMPAIGN: wipe everything WITHOUT seeding turret clusters — used by
     the scripted phases (pad defense / ascent), where the arena's rock-
     mounted turrets shouldn't exist yet. */
  clear() {
    for (const e of this.list) e.dispose();
    this.list.length = 0;
  },

  reset() {
    for (const e of this.list) e.dispose();
    this.list.length = 0;
    // seed turret clusters: some on big belt rocks, some on station hulls
    const hosts = G.world.asteroids.getTurretHosts(10);
    for (const h of hosts) {
      const F = G.world.asteroids;
      U.randomDir(_v1);
      _v1.multiplyScalar(F.ar[h] * 1.05);
      this.spawnTurret(h, _v1, null);
    }
    for (const st of G.world.stations) {
      for (const m of st.turretMounts) this.spawnTurret(-1, null, m.world);
    }
  },
};

/* ============================================================
   NEW ENEMY — VULTURE BOMBER: heavy plasma attack craft.
   Slow, tough, holds a wide standoff band and lobs slow AoE
   plasma shells at the player's PROJECTED position (leading hard).
   Shells are big, bright and slow — dodgeable, but splashes punish
   stationary play. FSM mirrors Gunship: approach → hold → evade.
============================================================ */
class Bomber extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill) {
    super('bomber');
    const E = CFG.enemies.bomber;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = 8;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.leadSkill = leadSkill || 0.7;
    this.state = 'approach';
    this.stateT = 0;
    this.latDir = Math.random() < 0.5 ? 1 : -1;
    this.fireT = U.rand(2, 3.5);
    this._buildMesh();
  }

  /* fat teardrop hull, dorsal spine bomb rack, twin huge nacelles */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x2a2620, metalness: 0.78, roughness: 0.44,
      emissive: 0xff9a20, emissiveIntensity: 0.3, envMapIntensity: 1.1 });
    this.flashMats.push({ mat: hull, base: 0.3 });
    const trim = HULL.recess(0x15130f);
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.5, 1.2, 0.3) }));

    const hullGeo = ShipGeo.get('bmb.hull', () => mergeGeos([
      { geo: new THREE.SphereGeometry(2.2, 10, 8), scale: [1, 0.75, 2.1] },
      { geo: new THREE.CylinderGeometry(1.3, 2.0, 4.5, 8), rot: [-Math.PI / 2, 0, 0], pos: [0, 0, 5.2] },
      { geo: new THREE.ConeGeometry(1.3, 2.6, 8), rot: [-Math.PI / 2, 0, 0], pos: [0, 0, -4.6] },
      { geo: new THREE.BoxGeometry(0.7, 0.7, 5.5), pos: [0, 1.9, 1.0] },      // dorsal rack
      { geo: new THREE.BoxGeometry(3.4, 0.5, 2.6), pos: [2.6, -0.2, 2.0] },   // wing stubs
      { geo: new THREE.BoxGeometry(3.4, 0.5, 2.6), pos: [-2.6, -0.2, 2.0] },
      { geo: new THREE.BoxGeometry(0.16, 1.5, 1.6), pos: [2.6, 0.6, 3.0], rot: [0, 0, -0.4] },
      { geo: new THREE.BoxGeometry(0.16, 1.5, 1.6), pos: [-2.6, 0.6, 3.0], rot: [0, 0, 0.4] },
      /* MILITIA read on a fat hull: armour patches welded over the nose
         and flanks, rack ribbing, and a blunt tail shield */
      { geo: new THREE.BoxGeometry(1.6, 0.5, 1.5), pos: [0, 1.5, -2.2] },
      { geo: new THREE.BoxGeometry(2.4, 0.4, 1.2), pos: [0, 1.35, 3.4] },
      { geo: new THREE.BoxGeometry(0.4, 0.4, 3.0), pos: [2.4, 0.6, 1.2] },
      { geo: new THREE.BoxGeometry(0.4, 0.4, 3.0), pos: [-2.4, 0.6, 1.2] },
      { geo: new THREE.BoxGeometry(1.7, 1.2, 0.5), pos: [0, 0, 7.2] },        // tail shield
      { geo: new THREE.BoxGeometry(0.5, 0.4, 4.2), pos: [1.6, -1.4, 2.6] },
      { geo: new THREE.BoxGeometry(0.5, 0.4, 4.2), pos: [-1.6, -1.4, 2.6] },
      { geo: new THREE.BoxGeometry(0.8, 0.5, 1.0), pos: [0, -1.9, -1.2] },    // bay doors
      { geo: new THREE.BoxGeometry(0.8, 0.5, 1.0), pos: [0, -1.9, 0.4] },
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('bmb.trim', () => mergeGeos([
      { geo: new THREE.SphereGeometry(0.55, 8, 6), scale: [0.8, 0.6, 1.5], pos: [0, 0.9, -1.6] },  // cockpit
      { geo: new THREE.CylinderGeometry(0.95, 1.2, 0.5, 8), rot: [-Math.PI / 2, 0, 0], pos: [0, 0, 7.6] },
      { geo: new THREE.SphereGeometry(0.5, 8, 6), pos: [0, 2.15, -1.0] },     // bomb
      /* rack ribs + hull panel breaks: the surfaces get scale and rhythm */
      { geo: new THREE.BoxGeometry(0.86, 0.18, 0.22), pos: [0, 1.9, -1.4] },
      { geo: new THREE.BoxGeometry(0.86, 0.18, 0.22), pos: [0, 1.9, 0.2] },
      { geo: new THREE.BoxGeometry(0.86, 0.18, 0.22), pos: [0, 1.9, 1.8] },
      { geo: new THREE.BoxGeometry(0.86, 0.18, 0.22), pos: [0, 1.9, 3.2] },
      { geo: new THREE.BoxGeometry(3.6, 0.09, 0.3), pos: [0, 0.85, 2.6] },
      { geo: new THREE.BoxGeometry(3.6, 0.09, 0.3), pos: [0, 0.5, 4.4] },
      { geo: new THREE.BoxGeometry(0.3, 0.09, 3.0), pos: [1.9, 0.9, 3.0] },
      { geo: new THREE.BoxGeometry(0.3, 0.09, 3.0), pos: [-1.9, 0.9, 3.0] },
      { geo: new THREE.BoxGeometry(0.7, 0.6, 0.14), pos: [2.6, -0.2, 3.35] },  // stub trailing vents
      { geo: new THREE.BoxGeometry(0.7, 0.6, 0.14), pos: [-2.6, -0.2, 3.35] },
      { geo: new THREE.SphereGeometry(0.5, 8, 6), pos: [0, 2.15, 1.4] },
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('bmb.eng', () => new THREE.CircleGeometry(0.62, 12));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 2.6, -0.2, 6.4);
      model.add(e); this.engMeshes.push(e);
    }
    g.position.copy(this.pos);
    this.mesh = g;
    this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  onHurt() {
    if (this.state !== 'evade' && Math.random() < 0.08) { this.state = 'evade'; this.stateT = 0; }
  }

  _fireShell(tgt) {
    const E = CFG.enemies.bomber;
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 2);
    // hard lead on the target's FUTURE position — dodge by accelerating
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const tGo = dist / E.shellSpeed;
    _v2.copy(tgt.pos).addScaledVector(tgt.vel, tGo * this.leadSkill * 1.35);
    _v2.x += U.rand(-14, 14); _v2.y += U.rand(-10, 10);
    _v2.sub(_v4).normalize();
    Projectiles.fire('eheavy', 'enemy', _v4, _v2, { src: this,
      speed: E.shellSpeed, dmg: 0, life: 5, aoe: 18, aoeDmg: E.shellDmg, fuse: 0,
    });
    FX.muzzle(_v4, true);
    G.audio.shotBlaster(0.3);
  }

  update(dt) {
    const E = CFG.enemies.bomber;
    this.stateT += dt;
    this.updateFlash(dt);
    const tgt = G.player;
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const speed = E.speed * this.spdMult;

    switch (this.state) {
      case 'approach':
        this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        this.faceTowards(tgt.pos, E.turn, dt);
        if (dist < E.holdMax) { this.state = 'hold'; this.stateT = 0; }
        break;
      case 'hold': {
        if (dist < E.holdMin) {
          _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(160).add(this.pos);
          this.steerToward(_v2, dt, speed, E.accel, 40);
        } else if (dist > E.holdMax) {
          this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        } else {
          _v2.copy(this.pos).sub(tgt.pos); _v2.y = 0;
          if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
          _v3.set(-_v2.z, 0, _v2.x).normalize().multiplyScalar(this.latDir * 45);
          _v3.add(this.pos);
          this.steerToward(_v3, dt, speed * 0.6, E.accel * 0.6, 30);
        }
        this.faceTowards(tgt.pos, E.turn, dt);
        break;
      }
      case 'evade':
        _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(260).add(this.pos);
        this.steerToward(_v2, dt, speed * 1.3, E.accel, 60);
        this.faceTowards(tgt.pos, E.turn * 0.6, dt);
        if (this.stateT > 2.5) { this.state = 'hold'; this.stateT = 0; }
        break;
    }

    this.avoidGround(dt, 60);
    if (this.vel.length() > speed * 1.3) this.vel.setLength(speed * 1.3);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    this._glowT += dt;
    const gs = 0.85 + Math.sin(this._glowT * 11) * 0.14;
    this.engMeshes[0].scale.setScalar(gs);
    this.engMeshes[1].scale.setScalar(gs * 0.95);

    this.fireT -= dt;
    if (this.fireT <= 0 && dist < E.fireRange && this.state !== 'evade') {
      this._fireShell(tgt);
      this.fireT = U.rand(2.6, 3.6);
    }
    if (Math.random() < 0.5) this.enginePuff([1, 0.6, 0.2]);
  }
}

/* ============================================================
   NEW ENEMY — RAZOR DRONE: tiny kamikaze swarm unit. Accelerates
   at the player, shrieks, and detonates on proximity. One bolt kills
   it (hp 6), but it's FAST and comes in packs. Kill pipeline scores
   it; its own blast damages only the player.
============================================================ */
class Drone extends Enemy {
  constructor(pos) {
    super('drone');
    const E = CFG.enemies.drone;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp;
    this.radius = E.radius;
    this.size = 2.2;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.state = 'dive';
    this._buildMesh();
  }

  /* spiky tetrahedral pod with a hot core */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x301a20, metalness: 0.7, roughness: 0.5,
      emissive: 0xff2050, emissiveIntensity: 0.8 });
    this.flashMats.push({ mat: hull, base: 0.8 });
    const hullGeo = ShipGeo.get('drn.hull', () => mergeGeos([
      { geo: new THREE.TetrahedronGeometry(1.1, 0), rot: [0, 0.6, 0.3] },
      { geo: new THREE.TetrahedronGeometry(0.7, 0), rot: [2.4, 1.1, 0], scale: [1, 1, -1] },
      { geo: new THREE.ConeGeometry(0.34, 1.4, 5), rot: [-Math.PI / 2, 0, 0], pos: [0, 0, -1.1] },
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const core = new THREE.Mesh(ShipGeo.get('drn.core', () => new THREE.SphereGeometry(0.42, 8, 6)),
      shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.8, 0.5, 0.8) })));
    model.add(core);
    g.scale.setScalar(0.9);
    g.position.copy(this.pos);
    this.mesh = g;
    this.model = model;
    this._pulse = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  update(dt) {
    const E = CFG.enemies.drone;
    this.updateFlash(dt);
    const p = G.player;
    const dist = _v1.copy(p.pos).sub(this.pos).length();

    // relentless accelerate-at-target; slight corkscrew so it's pretty
    this.steerToward(p.pos, dt, E.speed, E.accel, 8);
    this.faceTowards(p.pos, E.turn, dt);
    this._pulse += dt;
    this.model.rotation.z += dt * 7;

    this.avoidGround(dt, 150);
    if (this.vel.length() > E.speed * 1.2) this.vel.setLength(E.speed * 1.2);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    // proximity detonation
    if (dist < E.blast * 0.5 && p.alive) {
      this._detonate();
      return;
    }
    if (Math.random() < 0.3) this.enginePuff([1, 0.3, 0.5]);
  }

  _detonate() {
    const E = CFG.enemies.drone;
    this.alive = false;
    FX.explosion(this.pos, 7);
    FX.rings.spawn(this.pos, E.blast * 0.8, 0xff5070, 0.5);
    G.audio.explosion(6);
    FX.addTrauma(0.3);
    const d = G.player.pos.distanceTo(this.pos);
    if (d < E.blast && G.player.alive) {
      G.player.damage(E.blastDmg * (1 - d / E.blast), this.pos);
    }
    G.game.onEnemyKilled(this);
  }

  /* damage() override: standard death but with a smaller pop (no aoe chain) */
  damage(dmg, hitPos, vel, byPlayer) {
    if (!this.alive || dmg <= 0) return false;
    this.hp -= dmg;
    this.flash = 1;
    if (this.hp <= 0) {
      this.alive = false;
      FX.explosion(this.pos, 4);
      G.game.onEnemyKilled(this);
      return true;
    }
    return false;
  }
}

/* ============================================================
   [SECTION 12] BOSS — DREADNOUGHT "KHARYBDIS"
   ------------------------------------------------------------
   A multi-part target instead of one fat HP bar:
     · 4 WEAK POINTS (two heavy-gun mounts, a missile pod, a
       front SHIELD DOME) each with their own HP.
     · The CORE only takes 60% damage while the shield dome lives.
   Phase ladder on core HP:
     P1 (>66%) : heavy bolt duels + fighter escort
     P2 (>33%) : + homing missile volleys + anti-buzz flak rings
     P3 (<33%) : + the NOSE BEAM — telegraphed, sweeping arc that
                 punishes hovering in front of the hull
   Death = 3-second chain-explosion sequence, then slow-mo, then
   three guaranteed pickups. Remaining escorts die with it.
   The hull also PLOWS asteroids: anything in front of the nose
   gets vaporized (it is a dreadnought; it does not detour).
============================================================ */
class Boss extends Enemy {
  /* CAMPAIGN: `statMult` is the per-map boss multiplier (later maps get
     tankier, harder dreadnoughts) — 1 for the classic endless arena boss.
     UPGRADE(content): `variantIdx` picks a named dreadnought from BOSS_VARIANTS
     (tint + name); -1 = the classic Kharybdis. */
  constructor(pos, wave, statMult, variantIdx) {
    super('boss');
    const B = CFG.boss;
    this.pos.copy(pos);
    this.statMult = statMult || 1;
    this.variant = (variantIdx !== undefined && variantIdx >= 0) ? BOSS_VARIANTS[variantIdx % BOSS_VARIANTS.length] : null;
    this.coreHp = this.coreMax = (B.coreHp + wave * 60) * this.statMult;
    this.hp = this.maxHp = this.coreHp; // radar/UI convenience
    this.radius = B.radius;
    this.size = 26;
    this.scoreVal = B.score;
    this.dropChance = 1;
    this.waveEnemy = true;
    this.phase = 1;
    this.state = 'entry';      // entry | combat | dying
    this.stateT = 0;
    this.fireTL = 1.5; this.fireTR = 2.2;
    this.missileT = 6; this.flakT = 4; this.escortT = 5;
    this.crushT = 0;
    this.beam = { state: 'idle', t: 0, a: 0, dir: 1 };
    // SYSTEM (v1.4): archetype drive table (CFG.bossTypes) — cadences,
    // escort caps, beam mounts, and the singularity's gravity parameters
    this.archetype = (this.variant && this.variant.arch) || 'dreadnought';
    this.arch = CFG.bossTypes[this.archetype] || CFG.bossTypes.dreadnought;
    const grav = this.arch.gravity;
    this.pulseT = grav ? grav.pulseEvery : 0;
    this._pulseWarned = false;
    this._g = new THREE.Vector3(); this._g2 = new THREE.Vector3();   // dedicated: gravity math (no scratch aliasing)
    this.deathT = 0;
    this.keepAfterDeath = true; // linger through the death sequence
    /* SYSTEM(v1.5): per-archetype weak-point LAYOUTS — not a palette
       swap. Each archetype swaps one module + keeps the duel core, and
       the HUD boss bar pips render THIS list with matching labels. */
    this.pipParts = this.archetype === 'carrier'
      ? ['gunL', 'gunR', 'hangarBay', 'shieldDome']
      : this.archetype === 'fortress'
      ? ['beamL', 'beamR', 'missilePod', 'shieldDome']
      : this.archetype === 'singularity'
      ? ['gunL', 'gunR', 'gravityProjector', 'shieldDome']
      : ['gunL', 'gunR', 'missilePod', 'shieldDome'];
    this._buildMesh();
    this._buildHitSpheres();
  }

  /* ---------------- procedural dreadnought hull ----------------
     UPGRADE(content): hull tint + glow color come from the variant
     table (5 named dreadnoughts), so each map's boss reads as its own
     ship. The classic endless Kharybdis keeps the violet look. */
  _buildMesh() {
    const V = this.variant;
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: V ? V.hull : 0x232833, metalness: 0.8, roughness: 0.5,
      emissive: V ? V.glow : 0x8a2fae, emissiveIntensity: 0.12 });
    this.flashMats.push({ mat: hull, base: 0.12 });
    const armor = new THREE.MeshStandardMaterial({ color: V ? V.armor : 0x1a1f29, metalness: 0.75, roughness: 0.6 });
    const glow = new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.2, 0.4) });

    const spine = new THREE.Mesh(new THREE.BoxGeometry(20, 9, 92), hull);
    g.add(spine);
    const keel = new THREE.Mesh(new THREE.BoxGeometry(11, 6, 62), armor);
    keel.position.y = -7.5; g.add(keel);
    const superstructure = new THREE.Mesh(new THREE.BoxGeometry(9, 7, 30), hull);
    superstructure.position.set(0, 7, 8); g.add(superstructure);
    const bridge = new THREE.Mesh(new THREE.BoxGeometry(7, 9, 9), armor);
    bridge.position.set(0, 14, 20); g.add(bridge);
    // prow wedge
    const prow = new THREE.Mesh(new THREE.ConeGeometry(9, 22, 4), hull);
    prow.rotation.x = -Math.PI / 2; prow.rotation.y = Math.PI / 4;
    prow.position.z = -55; prow.scale.y = 1.4; g.add(prow);
    // armor rib rows along the flanks
    for (let i = 0; i < 6; i++) {
      for (const s of [-1, 1]) {
        const rib = new THREE.Mesh(new THREE.BoxGeometry(1.5, 4, 12), armor);
        rib.position.set(s * 10.5, -1, -30 + i * 12);
        g.add(rib);
      }
    }
    // engine block: three fat bells + hot discs
    for (const [x, y] of [[-6, -2], [6, -2], [0, 3]]) {
      const bell = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 5.5, 12, 10), armor);
      bell.rotation.x = Math.PI / 2; bell.position.set(x, y, 48);
      g.add(bell);
      const disc = new THREE.Mesh(new THREE.CircleGeometry(4.2, 16), glow);
      disc.position.set(x, y, 54.3);
      g.add(disc);
    }
    // blinking running lights
    this.runLights = [];
    for (let i = 0; i < 8; i++) {
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.8, 6, 6),
        new THREE.MeshBasicMaterial({ color: 0xff4050 }));
      l.position.set(i % 2 ? 10.4 : -10.4, 5, -40 + i * 11);
      g.add(l);
      this.runLights.push(l);
    }
    /* UPGRADE(v1.5) PHASE-TRANSITION ANIMATION: a ring of hull armor
       plates that visibly lift + rotate outward during a phase change
       (exposing the reactor), then reseal. Animated in update() by
       _transT; the transition also grants a short armored tell window. */
    this.plates = [];
    for (let i = 0; i < 6; i++) {
      const plate = new THREE.Mesh(new THREE.BoxGeometry(4.6, 1.1, 10), armor);
      plate.position.set(0, 5.4, -26 + i * 10);
      g.add(plate);
      this.plates.push(plate);
    }
    this._transT = 0;          // >0 while a phase transition animates
    this.mesh = g;
    g.userData.ownGeo = true;   // Boss geometry is one-off — safe (and right) to free it
    g.position.copy(this.pos);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  /* weak points + core, each an Object3D anchor so it rides the hull.
     SYSTEM(v1.5): the layout is per-archetype — the carrier launches
     from a HANGAR BAY (kill it = no more escorts), the fortress's beams
     feed from two emitters (kill them = beam silenced), the singularity
     pulls through a dedicated GRAVITY PROJECTOR (kill it = no more
     pull/pulse). Core weak-point counts stay 4 → HUD pips stay honest. */
  _buildHitSpheres() {
    const B = CFG.boss;
    this.hitSpheres = [];
    const add = (part, label, x, y, z, r, hp) => {
      const obj = new THREE.Object3D();
      obj.position.set(x, y, z);
      this.mesh.add(obj);
      const hs = { part, label, obj, r, hp, maxHp: hp, alive: true,
        world: new THREE.Vector3(), kind: part };
      this.hitSpheres.push(hs);
      return hs;
    };
    // visual + anchor for each weak point (hp scales with the per-map
    // statMult so map bosses are uniformly tankier, not just core-heavy)
    const gunMat = new THREE.MeshStandardMaterial({ color: 0x333944, metalness: 0.7, roughness: 0.5,
      emissive: 0xff7030, emissiveIntensity: 0.5 });
    const wpHp = CFG.boss.wpHp * this.statMult;
    const arch = this.archetype;
    // ---- side mounts: guns (dreadnought/singularity) or beam emitters (fortress) ----
    const sideIsBeam = arch === 'fortress';
    for (const s of [-1, 1]) {
      const hs = add(sideIsBeam ? (s < 0 ? 'beamL' : 'beamR') : (s < 0 ? 'gunL' : 'gunR'),
        sideIsBeam ? 'BEAM EMITTER' : 'HEAVY GUN', s * 16, 2, -28, 13, wpHp);
      const mount = new THREE.Mesh(new THREE.BoxGeometry(8, 7, 10), gunMat);
      hs.obj.add(mount);
      if (sideIsBeam) {
        // focusing crystal + housing — clearly not a gun barrel
        const crystal = new THREE.Mesh(new THREE.OctahedronGeometry(2.6, 0),
          new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.6, 0.4) }));
        crystal.position.z = -9;
        hs.obj.add(crystal);
        hs._crystal = crystal;
      } else {
        for (const b of [-1, 1]) {
          const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 0.9, 14, 8), gunMat);
          barrel.rotation.x = Math.PI / 2; barrel.position.set(b * 2.2, 0, -11);
          hs.obj.add(barrel);
        }
      }
    }
    // ---- center module: missile pod / hangar bay / gravity projector ----
    if (arch === 'carrier') {
      const bay = add('hangarBay', 'HANGAR BAY', 0, 11, 14, 12, wpHp);
      const bayMat = new THREE.MeshStandardMaterial({ color: 0x1c2734, metalness: 0.7, roughness: 0.5,
        emissive: 0x3fa8ff, emissiveIntensity: 0.55 });
      const bayMouth = new THREE.Mesh(new THREE.BoxGeometry(10, 4, 2.2), bayMat);
      bayMouth.position.z = -3;
      bay.obj.add(bayMouth);
      for (let i = 0; i < 4; i++) {
        const rack = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 6), gunMat);
        rack.position.set((i % 2 - 0.5) * 6, (i >> 1) * -2.6 + 1, 1);
        bay.obj.add(rack);
      }
      this._bayMat = bayMat;
    } else if (arch === 'singularity') {
      const proj = add('gravityProjector', 'GRAVITY PROJECTOR', 0, 11, 8, 12, wpHp);
      const projMat = new THREE.MeshStandardMaterial({ color: 0x241a33, metalness: 0.75, roughness: 0.45,
        emissive: 0x9a5fe8, emissiveIntensity: 0.7 });
      const lens = new THREE.Mesh(new THREE.TorusGeometry(4.2, 0.9, 8, 24), projMat);
      lens.position.z = -4;
      proj.obj.add(lens);
      const heart = new THREE.Mesh(new THREE.SphereGeometry(2.4, 12, 10),
        new THREE.MeshBasicMaterial({ color: new THREE.Color(1.8, 0.8, 3.0) }));
      proj.obj.add(heart);
      this._projMat = projMat; this._projLens = lens;
    } else {
      const pod = add('missilePod', 'MISSILE POD', 0, 11, 10, 11, wpHp);
      const podMat = new THREE.MeshStandardMaterial({ color: 0x2c3442, metalness: 0.7, roughness: 0.5,
        emissive: 0xc060ff, emissiveIntensity: 0.4 });
      for (let i = 0; i < 9; i++) {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 6, 8), podMat);
        tube.position.set((i % 3 - 1) * 2.6, 0, (((i / 3) | 0) - 1) * 2.6);
        tube.rotation.x = Math.PI / 2;
        pod.obj.add(tube);
      }
    }
    const dome = add('shieldDome', 'SHIELD DOME', 0, 5, -50, 12, wpHp);
    const domeMesh = new THREE.Mesh(new THREE.SphereGeometry(10, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x3fa8ff, transparent: true, opacity: 0.22,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    dome.obj.add(domeMesh);
    const domeCore = new THREE.Mesh(new THREE.SphereGeometry(3.5, 10, 8),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.8, 2.2, 3.2) }));
    dome.obj.add(domeCore);
    this._domeCore = domeCore;
    // the core itself
    const core = add('core', 'REACTOR CORE', 0, 0, 18, 24, Infinity);
    core.isCore = true;
    const coreMesh = new THREE.Mesh(new THREE.SphereGeometry(6, 12, 10),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.7, 3.0) }));
    core.obj.add(coreMesh);
    // nose beam emitter + beam meshes (P3 weapon)
    this.beamPivot = new THREE.Object3D();
    this.beamPivot.position.set(0, 0, -58);
    this.mesh.add(this.beamPivot);
    const beamGeo = new THREE.CylinderGeometry(2.6, 4.2, 700, 12, 1, true);
    beamGeo.rotateX(Math.PI / 2);
    const beamMat = new THREE.MeshBasicMaterial({ color: 0xff5533, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.beamMesh = new THREE.Mesh(beamGeo, beamMat);
    this.beamMesh.position.z = -350;
    this.beamPivot.add(this.beamMesh);
    const core2 = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.8, 700, 8, 1, true), beamMat.clone());
    core2.geometry.rotateX(Math.PI / 2);
    this.beamCoreMesh = core2;
    this.beamCoreMesh.position.z = -350;
    this.beamCoreMesh.material.color.set(0xffffff);
    this.beamPivot.add(this.beamCoreMesh);
    this.beamMesh.visible = this.beamCoreMesh.visible = false;
  }

  /* route damage into the right weak point (called by Projectiles) */
  damagePart(hs, dmg, hitPos, vel) {
    if (!this.alive || !hs.alive) return;
    const B = CFG.boss;
    let d = dmg;
    // shield dome absorbs partial damage for everything else while alive
    if (!hs.isCore && hs.part !== 'shieldDome' && this._wp('shieldDome').alive) d *= B.shieldReduce;
    // UPGRADE(v1.5): the phase-transition tell window is ARMORED — damage
    // halves while the plates are open (never silent stat swaps: §19)
    if (this._transT > 0) d *= 0.5;
    if (hs.isCore) {
      this.coreHp -= d;
      this.hp = Math.max(0, this.coreHp);
      this.flash = 1;
      if (this.coreHp <= 0) this._startDeath();
      else this._checkPhase();
    } else {
      hs.hp -= d;
      this.flash = 1;
      if (hs.hp <= 0) this._wpDestroyed(hs);
    }
  }

  /* AoE damage lands on the core (reduced by the dome like everything) */
  damage(dmg, hitPos, vel) { this.damagePart(this._wp('core'), dmg, hitPos, vel); }

  _wp(part) { return this.hitSpheres.find((h) => h.part === part); }

  _wpDestroyed(hs) {
    hs.alive = false;
    hs.obj.visible = false;
    hs.obj.getWorldPosition(_v1);
    /* UPGRADE(v1.5): weak-point pops use the BOSS_WEAKPOINT tier —
       categorically bigger than a fighter kill (shader fireball, kick,
       post pulse), not just a re-used medium blast. */
    FX.tiered(_v1, 'bossWeakpoint');
    G.audio.explosion(12);
    G.game.addScore(500, _v1, hs.label + ' DESTROYED');
    G.pickups.spawnRandom(_v1);
    G.hud.bossBanner(hs.label + ' DESTROYED');
    // ---- per-part SYSTEM effects (weak points change behavior) ----
    if (hs.part === 'hangarBay') {
      this._hangarDead = true;      // no more escort launches
      G.hud.alert('HANGAR DESTROYED — NO MORE ESCORTS', 2.5, '#9ff3ff');
    } else if (hs.part === 'beamL' || hs.part === 'beamR') {
      G.hud.alert('BEAM EMITTER DESTROYED', 2.5, '#ff9a5a');
      if (!this._wp('beamL').alive && !this._wp('beamR').alive) {
        this._beamsDead = true;     // nose beam silenced for good
        G.hud.alert('NOSE BEAM OFFLINE', 2.5, '#9ff3ff');
      }
    } else if (hs.part === 'gravityProjector') {
      this._projDead = true;        // gravity pull + pulse disabled
      FX.shockwaves.spawn(this.pos, 160, 0x9a5fe8, 0.8);
      G.hud.alert('GRAVITY PROJECTOR DESTROYED — WELL COLLAPSED', 2.8, '#d9a8ff');
    }
  }

  _checkPhase() {
    const f = this.coreHp / this.coreMax;
    const newPhase = f > 0.66 ? 1 : (f > 0.33 ? 2 : 3);
    if (newPhase !== this.phase) {
      this.phase = newPhase;
      G.audio.alarm();
      G.hud.bossBanner('DREADNOUGHT PHASE ' + newPhase);
      FX.addTrauma(0.25);
      /* UPGRADE(v1.5) PHASE TRANSITION: armor plates LIFT + SPIN outward
         (animated in update via _transT), a pressure dome bursts from the
         spine, and the tell window halves incoming damage while open. */
      this._transT = 1.5;
      _v1.copy(this.pos).add(_v2.set(0, 8, 0));
      FX.shockwaves.spawn(_v1, 90, 0xc060ff, 0.7);
      FX.rings.spawn(_v1, 70, 0xd9a8ff, 0.8);
      FX.postPulse(0.35);
      G.audio.explosion(14);
    }
  }

  _startDeath() {
    if (this.state === 'dying') return;
    this.state = 'dying';
    this.alive = false;               // stops ordinary damage / AI
    this.deathT = 0;
    G.game.onEnemyKilled(this);       // score + combo + banner now
    G.audio.alarm();
  }

  /* ---------------- attacks ---------------- */
  _fireHeavy(side) {
    const B = CFG.boss, hs = this._wp(side);
    if (!hs || !hs.alive) return;
    const p = G.player;
    hs.obj.getWorldPosition(_v4);
    _v1.copy(p.pos).sub(_v4);
    const tGo = _v1.length() / B.heavySpeed;
    _v2.copy(p.pos).addScaledVector(p.vel, tGo * 0.85);
    _v2.x += U.rand(-6, 6); _v2.y += U.rand(-6, 6);
    _v2.sub(_v4).normalize();
    // twin parallel bolts
    _v3.set(1, 0, 0).applyQuaternion(this.quat);
    for (const o of [-4, 4]) {
      _v5.copy(_v2).addScaledVector(_v3, o * 0.01).normalize();
      Projectiles.fire('eheavy', 'enemy', _v4, _v5, { src: this, speed: B.heavySpeed, dmg: B.heavyDmg, life: 5 });
    }
    FX.muzzle(_v4, true);
    G.audio.shotBlaster(0.3);
  }

  _fireMissileVolley() {
    const B = CFG.boss, pod = this._wp('missilePod');
    if (!pod || !pod.alive) return;
    this._missileQueue = this._missileQueue || [];
    for (let i = 0; i < 4; i++) this._missileQueue.push(0.25 * i);
  }

  _fireFlakRing() {
    const B = CFG.boss;
    _v1.copy(this.pos);
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * U.TAU + U.rand(-0.1, 0.1);
      _v2.set(Math.cos(a), U.rand(-0.4, 0.4), Math.sin(a)).normalize();
      Projectiles.fire('ebolt', 'enemy', _v1, _v2, { src: this,
        speed: 150, dmg: 0, life: 1.3, fuse: 1.2, aoeDmg: B.flakDmg });
    }
    G.audio.shotMissile();
  }

  _updateBeam(dt) {
    const bm = this.beam, p = G.player;
    switch (bm.state) {
      case 'idle':
        bm.t -= dt;
        if (bm.t <= 0 && this.phase >= 3) {
          bm.state = 'telegraph'; bm.t = 1.2;
          // sweep will start on the player's current bearing, offset -50°
          _v1.copy(p.pos).sub(this.pos);
          bm.a = Math.atan2(_v1.x, _v1.z) - 0.9 * (Math.random() < 0.5 ? 1 : -1);
          bm.dir = Math.random() < 0.5 ? 1 : -1;
          this.beamPivot.rotation.set(0, bm.a, 0);
          this.beamMesh.visible = this.beamCoreMesh.visible = true;
          G.audio.alarm();
          G.hud.alert('BEAM CHARGING', 1.2);
        }
        break;
      case 'telegraph':
        bm.t -= dt;
        const k = 1 - bm.t / 1.2;
        this.beamMesh.material.opacity = 0.1 + k * 0.15;
        this.beamCoreMesh.material.opacity = k * 0.3;
        if (bm.t <= 0) { bm.state = 'sweep'; bm.t = 3.2; G.audio.shotLance(1); }
        break;
      case 'sweep':
        bm.t -= dt;
        bm.a += bm.dir * 0.55 * dt;                     // sweep rate rad/s
        this.beamPivot.rotation.set(0, bm.a, 0);
        this.beamMesh.material.opacity = 0.75;
        this.beamCoreMesh.material.opacity = 0.9;
        // damage: distance from player to the beam SEGMENT
        this.beamPivot.getWorldPosition(_v1);
        _v2.set(0, 0, -1).applyQuaternion(this.beamPivot.getWorldQuaternion(_q1));
        _v3.copy(_v1).addScaledVector(_v2, 700);
        const t = segTowardPoint(_v1, _v3, p.pos);
        _v4.copy(_v1).lerp(_v3, t);
        const d = _v4.distanceTo(p.pos);
        if (d < 9 && p.alive) {
          // FIX: accumulate DPS into ~0.22s damage ticks. Calling
          // p.damage() every frame spawned 800+ particles/sec and hammered
          // the audio throttlers while the beam touched you.
          bm.acc = (bm.acc || 0) + CFG.boss.beamDps * dt;
          bm.tick = (bm.tick || 0) + dt;
          if (bm.tick >= 0.22) {
            p.damage(bm.acc, p.pos);
            FX.addTrauma(0.08);
            bm.acc = 0; bm.tick = 0;
          }
        }
        // crackle particles along the beam
        if (Math.random() < 0.5) {
          _v5.copy(_v1).addScaledVector(_v2, U.rand(30, 650));
          FX.hit(_v5, 2, true);
        }
        if (bm.t <= 0) { bm.state = 'idle'; bm.t = 7 + U.rand(0, 3);
          this.beamMesh.visible = this.beamCoreMesh.visible = false; }
        break;
    }
  }

  /* ---------------- main update ---------------- */
  update(dt) {
    // death sequence: chained booms along the hull, then the big one
    if (!this.alive) {
      this.deathT += dt;
      this._deathBoomT = (this._deathBoomT || 0) - dt;
      if (this._deathBoomT <= 0 && this.deathT < 3.2) {
        this._deathBoomT = 0.18;
        _v1.copy(this.pos).addScaledVector(_v2.set(U.rand(-1, 1), U.rand(-0.4, 0.6), U.rand(-1, 1)).normalize(), U.rand(10, 45));
        FX.explosion(_v1, U.rand(5, 9));
        FX.addTrauma(0.12);
        G.audio.explosion(U.rand(6, 12));
      }
      if (this.deathT >= 3.2 && !this._finalBoom) {
        this._finalBoom = true;
        /* UPGRADE(v1.5): the capital death uses the BOSS_DEATH tier —
           shader fireball + quad rings + heavy kick + full post pulse. */
        FX.tiered(this.pos, 'bossDeath');
        FX.rings.spawn(this.pos, 140, 0xffc37a, 1.1);
        FX.rings.spawn(this.pos, 90, 0xc060ff, 0.9);
        G.audio.bigBoom();
        G.game.slowMo(0.3, 1.4);
        G.pickups.spawnRandom(this.pos);
        G.pickups.spawnRandom(_v1.copy(this.pos).addScaledVector(_v2.set(10, 0, 0), 30));
        G.pickups.spawnRandom(_v1.copy(this.pos).addScaledVector(_v2.set(-10, 5, 0), 30));
      }
      // escorts die with their command ship
      if (this._finalBoom && !this._escortDied) {
        this._escortDied = true;
        for (const e of G.enemies.list) {
          if (e.type === 'fighter' && e.alive && e._bossEscort) { e.hp = -1; e.alive = false; G.game.onEnemyKilled(e); }
        }
      }
      if (this.deathT > 4.5) this.keepAfterDeath = false;  // manager disposes
      // sink slowly & roll over while dying
      this.vel.multiplyScalar(0.98);
      this.pos.addScaledVector(this.vel, dt);
      _q1.setFromAxisAngle(_v2.set(0, 0, 1), 0.15 * dt);
      this.quat.premultiply(_q1);
      this.mesh.position.copy(this.pos);
      this.mesh.quaternion.copy(this.quat);
      this._syncSpheres();
      return;
    }

    const B = CFG.boss, p = G.player;
    this.stateT += dt;
    this.updateFlash(dt);

    /* movement: crawl to a hold ring ~420u from the player, then track */
    if (this.state === 'entry') {
      _v1.copy(p.pos).sub(this.pos).normalize().multiplyScalar(this.arch.holdDist).add(p.pos);
      this.steerToward(_v1, dt, B.speed * this.arch.speedMult * 3.2, 8, 80);   // FIX: was 2.4 — arrival took a minute+
      this.faceTowards(p.pos, 0.3, dt);
      if (this.pos.distanceTo(p.pos) < this.arch.holdDist + 140) this.state = 'combat';
    } else {
      _v1.copy(this.pos).sub(p.pos);
      _v1.y = 0;
      if (_v1.lengthSq() < 1e-4) _v1.set(1, 0, 0);
      _v1.normalize();
      _v2.copy(p.pos).addScaledVector(_v1, this.arch.holdDist);   // hold station
      this.steerToward(_v2, dt, B.speed * this.arch.speedMult, 5, 60);
      this.faceTowards(p.pos, 0.12, dt);
    }
    // FIX: speed cap is state-dependent — the old single 2.6x cap meant the
    // raised entry steer speed above never actually applied (the cap won).
    const BS = B.speed * this.arch.speedMult;
    const cap = (this.state === 'entry' ? BS * 3.8 : BS * 2.6);
    if (this.vel.length() > cap) this.vel.setLength(cap);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);
    this._syncSpheres();

    /* asteroid plow: vaporize rocks near the nose */
    this.crushT -= dt;
    if (this.crushT <= 0) {
      this.crushT = 0.45;
      _v1.set(0, 0, -1).applyQuaternion(this.quat).multiplyScalar(60).add(this.pos);
      G.world.asteroids.explosionDamage(_v1, 45, 60);
    }

    /* running lights blink + PHASE-TRANSITION plate animation */
    const tt = performance.now() * 0.001;
    for (let i = 0; i < this.runLights.length; i++) {
      this.runLights[i].visible = Math.sin(tt * 3 + i * 1.7) > 0;
    }
    if (this._domeCore) this._domeCore.scale.setScalar(1 + 0.15 * Math.sin(tt * 5));
    // UPGRADE(v1.5): armor plates lift/spin during the transition tell,
    // then reseal — a readable state-change beat for every archetype.
    if (this._transT > 0) {
      this._transT -= dt;
      const k = Math.sin(U.clamp(this._transT / 1.5, 0, 1) * Math.PI);  // 0→1→0
      for (let i = 0; i < this.plates.length; i++) {
        const p = this.plates[i];
        p.position.y = 5.4 + k * 7;
        p.rotation.z = k * (i % 2 ? 0.6 : -0.6);
        p.rotation.x = k * 0.5;
      }
    } else if (this.plates.length && this.plates[0].position.y !== 5.4) {
      for (const p of this.plates) { p.position.y = 5.4; p.rotation.set(0, 0, 0); }
    }
    // hangar-bay / projector / emitter emissive pulses (alive tells)
    if (this._bayMat) this._bayMat.emissiveIntensity = 0.4 + 0.25 * Math.sin(tt * 4);
    if (this._projLens) this._projLens.rotation.z += dt * 1.4;

    /* SINGULARITY ENGINE (v1.4): environmental manipulation — a steady
       pull inside gravity.radius, plus a telegraphed radial PULSE on a
       timer. Changes the player's movement strategy (§18): throttle down
       to fight the pull or save boost to escape the pulse.
       v1.5: killing the GRAVITY PROJECTOR weak point ends it all. */
    const grav2 = this.arch.gravity;
    if (grav2 && this.state !== 'dying' && !this._projDead) {
      this._g.copy(p.pos).sub(this.pos);
      const dl = this._g.length();
      if (dl < grav2.radius && dl > 1) {
        // steady pull — grows as you close (force clamped near the hull)
        const f = grav2.force * (0.25 + Math.min(1, (grav2.radius - dl) / grav2.radius));
        p.vel.addScaledVector(this._g.multiplyScalar(-1 / dl), f * dt);
      }
      this.pulseT -= dt;
      if (this.pulseT <= grav2.pulseWindup && !this._pulseWarned) {
        this._pulseWarned = true;                    // telegraph (§19: never silent)
        G.hud.bossBanner('GRAVITY PULSE IMMINENT');
        G.audio.alarm();
      }
      if (this.pulseT <= 0) {
        this.pulseT = grav2.pulseEvery;
        this._pulseWarned = false;
        if (dl < grav2.pulseRadius && dl > 1) {
          const kick = grav2.pulseForce * (1 - dl / grav2.pulseRadius);
          p.vel.addScaledVector(this._g.normalize(), kick);   // radial shove AWAY
          FX.shockwaves.spawn(this.pos, 140, 0x9a5fe8, 0.9);
          FX.addTrauma(0.5);
        }
        for (const e of G.enemies.list) {            // debris + small ships get flung too
          if (e.alive && e !== this && e.pos.distanceTo(this.pos) < grav2.pulseRadius) {
            this._g2.copy(e.pos).sub(this.pos).normalize();
            e.vel.addScaledVector(this._g2, 40);
          }
        }
        G.audio.explosion(1.2);
      }
    }

    /* ---- attacks by phase ---- */
    // heavy guns (both phases, faster later; cadence per archetype)
    this.fireTL -= dt; this.fireTR -= dt;
    const gunPeriod = (this.phase >= 3 ? 1.0 : 1.5) * this.arch.weapons.heavy;
    if (this.fireTL <= 0) { this._fireHeavy('gunL'); this.fireTL = gunPeriod * U.rand(0.9, 1.2); }
    if (this.fireTR <= 0) { this._fireHeavy('gunR'); this.fireTR = gunPeriod * U.rand(0.9, 1.2); }

    // missile volleys (P2+)
    if (this.phase >= 2) {
      this.missileT -= dt;
      if (this.missileT <= 0) { this._fireMissileVolley(); this.missileT = this.arch.weapons.missiles; }
      if (this._missileQueue) {
        for (let i = this._missileQueue.length - 1; i >= 0; i--) {
          this._missileQueue[i] -= dt;
          if (this._missileQueue[i] <= 0) {
            const pod = this._wp('missilePod');
            if (pod && pod.alive) {
              pod.obj.getWorldPosition(_v4);
              U.randomDir(_v2);
              _v2.multiplyScalar(0.4); _v2.z -= 1; _v2.normalize();
              Projectiles.fire('emissile', 'enemy', _v4, _v2, { src: this,
                speed: 120, maxSpeed: 260, dmg: CFG.boss.missileDmg, life: 9,
                target: G.player, turn: 2.2, aoe: 14, aoeDmg: 10, hp: 1 });
              G.audio.shotMissile();
            }
            this._missileQueue.splice(i, 1);
          }
        }
      }
      // flak ring when the player buzzes the hull (P2+)
      this.flakT -= dt;
      if (this.flakT <= 0 && this.pos.distanceTo(p.pos) < 320) {
        this._fireFlakRing(); this.flakT = this.arch.weapons.flak;
      }
    }

    // the beam (P3) — carriers & the singularity platform mount none.
    // v1.5: fortress loses it permanently when both emitters die.
    if (this.arch.beams > 0 && !this._beamsDead) this._updateBeam(dt);

    // escort fighters — launched from the HANGAR BAY on carriers;
    // v1.5: the bay is a weak point, destroying it stops the launches.
    this.escortT -= dt;
    if (this.escortT <= 0) {
      this.escortT = this.arch.escortEvery || CFG.boss.escortEvery;
      const bayDead = this.archetype === 'carrier' && this._hangarDead;
      const fighters = this._escortCount();
      if (!bayDead && fighters < (this.arch.escortCap || CFG.boss.escortCap)) {
        _v1.copy(this.pos).addScaledVector(_v2.set(U.rand(-1, 1), U.rand(-0.3, 0.3), U.rand(-1, 1)), 80);
        const f = G.enemies.spawnFighter({ pos: _v1, hpMult: 1.1, spdMult: 1.15, leadSkill: 0.9 });
        f._bossEscort = true;
      }
    }

    /* ram: touching the hull hurls + hurts the player */
    const core = this._wp('core');
    if (core && p.alive) {
      const rr = core.r + CFG.combat.playerRadius + 4;
      const d = core.world.distanceTo(p.pos);
      if (d < rr) {
        _v1.copy(p.pos).sub(core.world).normalize();
        p.vel.addScaledVector(_v1, 60);
        p.pos.copy(core.world).addScaledVector(_v1, rr + 1);
        p.damage(30, p.pos);
        FX.addTrauma(0.5);
      }
    }
  }

  _escortCount() {
    let n = 0;
    for (const e of G.enemies.list) if (e.alive && e.type === 'fighter' && e._bossEscort) n++;
    return n;
  }

  _syncSpheres() {
    for (const hs of this.hitSpheres) {
      if (hs.alive) hs.obj.getWorldPosition(hs.world);
    }
  }
}

/* UPGRADE(content): named dreadnought variants — one per Adventure map.
   hull/armor/glow tint the procedural dreadnought so each sector's boss
   reads as a different capital ship; `title` feeds the boss bar + banners. */
/* SYSTEM (v1.4): `arch` keys each boss variant into CFG.bossTypes —
   one hull builder, four behaviors (dreadnought gun duel, carrier
   fighter waves, fortress beam siege, singularity gravity control). */
const BOSS_VARIANTS = [
  { name: 'DREADNOUGHT KHARYBDIS', hull: 0x232833, armor: 0x1a1f29, glow: 0x8a2fae, arch: 'dreadnought' },
  { name: 'BATTLECRUISER IGNIS REX', hull: 0x33241c, armor: 0x241812, glow: 0xd86420, arch: 'dreadnought' },
  { name: 'CARRIER BOREAL WARDEN', hull: 0x1e2c38, armor: 0x14202c, glow: 0x3fa8ff, arch: 'carrier' },
  { name: 'FORTRESS FERRUM AETERNUM', hull: 0x2e2e26, armor: 0x1f1f18, glow: 0xffc857, arch: 'fortress' },
  { name: 'HIVE TITAN VIRIDIAN CHOIR', hull: 0x1e3326, armor: 0x14241a, glow: 0x40ffb0, arch: 'carrier' },
  { name: 'FLAGSHIP KHARYBDIS PRIME', hull: 0x2c1e38, armor: 0x1f1429, glow: 0xc060ff, arch: 'singularity' },
];

/* helper: param t of the closest point on segment a→b to point p */
function segTowardPoint(a, b, p) {
  _v6.copy(b).sub(a);
  const l2 = _v6.lengthSq();
  if (l2 < 1e-9) return 0;
  let t = _v5.copy(p).sub(a).dot(_v6) / l2;
  return t < 0 ? 0 : (t > 1 ? 1 : t);
}

/* ============================================================
   [SECTION 13a] ALLY — disabled corvette "TESSA" (escort objective)
   ------------------------------------------------------------
   Drifts helplessly, flickering. While it survives it projects a
   slow shield-charge aura (80u) — a reason to fight NEAR it.
   Enemies split some fire onto it (see Fighter targeting).
============================================================ */
class Ally {
  constructor(pos) {
    this.pos = pos.clone();
    this.vel = U.randomDir(new THREE.Vector3()).multiplyScalar(1.5);
    this.hp = this.maxHp = 160;
    this.radius = 7;
    this.alive = true;
    this.flash = 0;
    this._buildMesh();
  }

  _buildMesh() {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0x2d3a4a, metalness: 0.7, roughness: 0.5,
      emissive: 0x40ffb0, emissiveIntensity: 0.15 });
    this.hullMat = hull;
    const body = new THREE.Mesh(new THREE.BoxGeometry(4, 3, 18), hull);
    g.add(body);
    const noseC = new THREE.Mesh(new THREE.ConeGeometry(2, 5, 8), hull);
    noseC.rotation.x = -Math.PI / 2; noseC.position.z = -11;
    g.add(noseC);
    for (const s of [-1, 1]) {
      const nac = new THREE.Mesh(new THREE.CylinderGeometry(1, 1.2, 7, 8), hull);
      nac.rotation.x = Math.PI / 2; nac.position.set(s * 2.8, 0, 4);
      g.add(nac);
    }
    // flickering distress light
    this.distress = new THREE.Mesh(new THREE.SphereGeometry(0.6, 8, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2, 1.2, 0.4) }));
    this.distress.position.set(0, 2.2, 0);
    g.add(this.distress);
    // the shield aura ring
    this.aura = new THREE.Mesh(new THREE.TorusGeometry(80, 0.8, 8, 64),
      new THREE.MeshBasicMaterial({ color: 0x40ffb0, transparent: true, opacity: 0.25,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    this.aura.rotation.x = Math.PI / 2;
    g.add(this.aura);
    g.position.copy(this.pos);
    g.quaternion.setFromEuler(new THREE.Euler(U.rand(-0.3, 0.3), U.rand(0, 6.28), U.rand(-0.2, 0.2)));
    this.mesh = g;
    this.quat = g.quaternion;
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  damage(dmg, pos) {
    if (!this.alive || dmg <= 0) return;
    this.hp -= dmg;
    this.flash = 1;
    if (this.hp <= 0) {
      this.hp = 0; this.alive = false;
      FX.explosion(this.pos, 10);
      FX.rings.spawn(this.pos, 40, 0x40ffb0, 0.8);
      G.audio.bigBoom();
      FX.addTrauma(0.5);
      G.waves.allyDestroyed();
    }
  }

  update(dt) {
    if (!this.alive) { this.mesh.visible = false; return; }
    this.flash = Math.max(0, this.flash - 4 * dt);
    this.hullMat.emissiveIntensity = 0.15 + this.flash * 2.5;
    // slow helpless drift
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    // distress strobe
    this.distress.visible = Math.sin(performance.now() * 0.012) > 0.2;
    this.aura.material.opacity = 0.18 + 0.1 * Math.sin(performance.now() * 0.003);
    // aura: trickle-charge the player's shields when nearby
    const p = G.player;
    if (p.alive && p.pos.distanceTo(this.pos) < 80) {
      p.shield = Math.min(CFG.combat.shield, p.shield + 7 * dt);
    }
  }

  dispose() {
    G.scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
  }
}

/* ============================================================
   [SECTION 13a-2] DISTRESS POD — the §7 distress-call objective.
   ------------------------------------------------------------
   CFG.distress shipped as data + a CFG.radio.distress pool with nothing
   behind either. This is the actor: a lifeboat that ejects into the arena
   with a 45-second life-support clock, a strobe you can see from across
   the sector, a RESCUE RING drawn at exactly the distance that counts as
   "reached it", and enough hull to survive a little fire but not a
   sustained one. Enemies detail a hunter element to kill it (see
   CFG.distress.hunters); reaching it inside the ring extracts the
   survivor and pays out.
   Interface mirrors Ally (pos/vel/alive/hp/radius/update/damage/dispose)
   so the wave director can hold it with the same plumbing.
============================================================ */
class Survivor {
  constructor(pos) {
    this.pos = pos.clone();
    this.vel = U.randomDir(new THREE.Vector3()).multiplyScalar(1.1);
    this.hp = this.maxHp = CFG.distress.podHp;
    this.radius = CFG.distress.podRadius;
    this.alive = true;
    this.flash = 0;
    this.tumble = U.randomDir(new THREE.Vector3()).normalize();
    this._buildMesh();
  }

  _buildMesh() {
    const g = new THREE.Group();
    // pod skin: pale rescue-white so it reads as CIVILIAN against the fleet
    const hull = new THREE.MeshStandardMaterial({ color: 0xa8b2bd, metalness: 0.5, roughness: 0.6,
      emissive: 0xff7a3c, emissiveIntensity: 0.12 });
    this.hullMat = hull;
    const body = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 4.6, 10), hull);
    body.rotation.x = Math.PI / 2;
    g.add(body);
    const nose = new THREE.Mesh(new THREE.SphereGeometry(1.7, 10, 8, 0, Math.PI * 2, 0, Math.PI / 2), hull);
    nose.rotation.x = -Math.PI / 2; nose.position.z = -2.3;
    g.add(nose);
    // hatch collar + two RCS bottles
    const collar = new THREE.Mesh(new THREE.TorusGeometry(1.75, 0.16, 4, 12), hull);
    collar.position.z = 0.6;
    g.add(collar);
    for (const s of [-1, 1]) {
      const bot = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.42, 2.2, 6), hull);
      bot.position.set(s * 1.9, -0.2, 0.8);
      g.add(bot);
    }
    /* heavy distress strobe — >1 color range so bloom carries it (this is
       the "you can see the beacon" read the radio lines promise) */
    this.strobe = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.7, 0.3) }));
    this.strobe.position.set(0, 2.0, -0.4);
    g.add(this.strobe);
    /* RESCUE RING: drawn at CFG.distress.rescueRadius, so the mechanic is
       legible in the world instead of only in the HUD text */
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(CFG.distress.rescueRadius, 0.5, 6, 48),
      new THREE.MeshBasicMaterial({ color: 0x58ffb0, transparent: true, opacity: 0.16,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    this.ring.rotation.x = Math.PI / 2;
    g.add(this.ring);
    g.position.copy(this.pos);
    this.mesh = g;
    this.quat = g.quaternion;
    G.scene.add(g);
  }

  damage(dmg, pos) {
    if (!this.alive || dmg <= 0) return;
    this.hp -= dmg;
    this.flash = 1;
    if (this.hp <= 0) {
      this.hp = 0; this.alive = false;
      FX.explosion(this.pos, 9);
      FX.rings.spawn(this.pos, 34, 0xff7a3c, 0.7);
      G.audio.bigBoom();
      FX.addTrauma(0.4);
      G.waves.distressLost();
    }
  }

  update(dt) {
    if (!this.alive) { this.mesh.visible = false; return; }
    this.flash = Math.max(0, this.flash - 4 * dt);
    this.hullMat.emissiveIntensity = 0.12 + this.flash * 2.2;
    // slow helpless tumble + drift (it has no drive left)
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    _q1.setFromAxisAngle(this.tumble, 0.35 * dt);
    this.quat.premultiply(_q1);
    // strobe: fast pulse while the clock runs (see Waves._updateDistress)
    this.strobe.visible = Math.sin(performance.now() * 0.009) > -0.2;
    this.ring.material.opacity = 0.11 + 0.07 * Math.sin(performance.now() * 0.005);
  }

  dispose() {
    G.scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.geometry && o.geometry.dispose) o.geometry.dispose();
      if (o.material && o.material.dispose) o.material.dispose();
    });
  }
}

/* ============================================================
   NEW ALLY — VANGUARD WINGMAN: a friendly AI fighter that escorts
   the PLAYER (not a static objective). It follows an offset perch,
   engages the nearest enemy with bursts, and respawns next wave if
   lost. Gives the player visible support + adds life to the arena.
============================================================ */
class Vanguard {
  constructor(pos) {
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.hp = this.maxHp = 90;
    this.radius = 2.4;
    this.alive = true;
    this.flash = 0;
    this.fireT = U.rand(0.6, 1.4);
    this.burstN = 0; this.burstT = 0;
    this.dest = new THREE.Vector3();
    this.orbitA = U.rand(0, U.TAU);
    this._buildMesh();
  }

  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x24384a, metalness: 0.75, roughness: 0.42,
      emissive: 0x40ffb0, emissiveIntensity: 0.3, side: THREE.DoubleSide });
    this.hullMat = hull;
    const trim = shared(new THREE.MeshStandardMaterial({
      color: 0x16222e, metalness: 0.85, roughness: 0.4 }));
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.6, 2.4, 1.4) }));
    // slim dagger silhouette — visually distinct from enemy darts
    const hullGeo = ShipGeo.get('van.hull', () => mergeGeos([
      { geo: new THREE.CylinderGeometry(0.2, 0.46, 3.2, 8), rot: [-Math.PI / 2, 0, 0] },
      { geo: new THREE.ConeGeometry(0.2, 1.4, 8), rot: [-Math.PI / 2, 0, 0], pos: [0, 0, -2.2] },
      { geo: new THREE.BoxGeometry(2.6, 0.09, 1.15), pos: [1.15, 0, 0.55], rot: [0, 0.25, 0] },
      { geo: new THREE.BoxGeometry(2.6, 0.09, 1.15), pos: [-1.15, 0, 0.55], rot: [0, -0.25, 0] },
      { geo: new THREE.BoxGeometry(0.08, 0.55, 0.9), pos: [0, 0.4, 1.2] },
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const engGeo = ShipGeo.get('van.eng', () => new THREE.CircleGeometry(0.17, 10));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 0.3, 0, 1.85);
      model.add(e); this.engMeshes.push(e);
    }
    g.position.copy(this.pos);
    this.mesh = g;
    this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  damage(dmg, pos) {
    if (!this.alive || dmg <= 0) return;
    this.hp -= dmg;
    this.flash = 1;
    if (this.hp <= 0) {
      this.hp = 0; this.alive = false;
      FX.explosion(this.pos, 6);
      G.audio.explosion(6);
      G.hud.alert('VANGUARD DOWN', 2, '#ff4d6a');
    }
  }

  update(dt) {
    if (!this.alive) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    this.flash = Math.max(0, this.flash - 4 * dt);
    this.hullMat.emissiveIntensity = 0.3 + this.flash * 2.5;
    const p = G.player;

    /* station-keep on a rotating perch behind the player */
    this.orbitA += 0.5 * dt;
    this.dest.copy(p.pos);
    _v1.set(Math.sin(this.orbitA) * 60, 14, Math.cos(this.orbitA) * 60)
      .applyQuaternion(p.quat).add(this.dest);
    _v2.copy(_v1).sub(this.pos);
    const d = _v2.length();
    if (d > 1e-4) _v2.multiplyScalar(1 / d);
    _v2.multiplyScalar(Math.min(110, d * 1.6));
    _v2.sub(this.vel);
    if (_v2.length() > 70) _v2.setLength(70);
    this.vel.addScaledVector(_v2, dt);
    this.pos.addScaledVector(this.vel, dt);

    /* engage: nearest enemy in range gets burst fire with good lead */
    let best = null, bestD = 620 * 620;
    for (const e of G.enemies.list) {
      if (!e.alive || e.type === 'mine' || e.type === 'drone') continue;
      const dd = e.pos.distanceToSquared(this.pos);
      if (dd < bestD) { bestD = dd; best = e; }
    }
    let facePt;
    if (best && bestD < 520 * 520) facePt = best.pos;
    else facePt = _v3.copy(this.pos).addScaledVector(this.vel, 1);
    rotateTowards(this.pos, this.quat, facePt, 2.4 * dt);

    this.fireT -= dt;
    if (this.burstN > 0) {
      this.burstT -= dt;
      if (this.burstT <= 0) {
        this.burstT = 0.1;
        this.burstN--;
        if (best) {
          _v2.copy(best.pos).sub(this.pos);
          const dist = _v2.length();
          const tGo = dist / 700;
          _v2.multiplyScalar(1 / (dist || 1));
          _v4.copy(best.pos).addScaledVector(best.vel, tGo * 0.8).sub(this.pos).normalize();
          _v5.copy(this.pos).addScaledVector(_v4, 3);
          Projectiles.fire('bolt', 'player', _v5, _v4, { speed: 700, dmg: 5, life: 1.4, noStats: true });
          FX.muzzle(_v5, false);
        }
      }
    } else if (this.fireT <= 0 && best && bestD < 520 * 520) {
      this.burstN = 3; this.burstT = 0;
      this.fireT = U.rand(1.4, 2.2);
    }

    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);
    this._glowT += dt;
    const gs = 0.9 + Math.sin(this._glowT * 19) * 0.15;
    for (const e of this.engMeshes) e.scale.setScalar(gs);
    if (Math.random() < 0.5) this.enginePuffVan();
  }

  enginePuffVan() {
    // +Z = aft (same fix as Enemy.enginePuff — puffs trail the nozzles)
    _v1.set(0, 0, 1).applyQuaternion(this.quat);
    _v2.copy(this.pos).addScaledVector(_v1, 2.2);
    FX.particles.spawn(_v2.x, _v2.y, _v2.z, _v1.x * 10, _v1.y * 10, _v1.z * 10,
      0.4, 1, 0.7, 0.5, 0.2, 2, 0.3);
  }

  dispose() {
    G.scene.remove(this.mesh);
    this.mesh.traverse((o) => {
      if (o.material && o.material.dispose && !o.material.userData.shared) o.material.dispose();
    });
  }
}

/* ============================================================
   [SECTION 13b] WAVE DIRECTOR — escalation + secondary objectives
   ------------------------------------------------------------
   States:  LULL (breather + banner) → ACTIVE (drain spawn queue)
   → clear check → WAVE CLEARED → LULL → ...

   The spawn QUEUE staggers arrivals (0.5-1.1s apart) and trickles
   whenever concurrency drops under the cap, so waves feel like a
   stream of reinforcements rather than one dumb blob.

   Secondary objectives (rolled on non-boss waves >= 3):
     hvt      — kill the marked golden gunship (3x HP, fat rewards)
     escort   — keep the disabled ally alive until wave clear
     onslaught— survive a 45s sustained trickle (bonus at the end)
============================================================ */

/* ============================================================
   NEW ENEMY (v1.3, restored) — INTERDICTOR: engine-displacement
   cruiser. A slow, heavily-armored wedge that drops a GRAVITY
   WELL: while the player is inside its radius, top speed is cut
   55%, boost is disabled and thrust is halved. Armed with a
   triple heavy-bolt salvo on a long cooldown. Kill priority #1.
============================================================ */
function flightField(p, outT) {
  for (const e of Enemies.list) {
    if (e.type === 'interdictor' && e.alive && e.inWell(p)) return true;
  }
  return false;
}

class Interdictor extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill) {
    super('interdictor');
    const E = CFG.enemies.interdictor;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = 9;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.leadSkill = leadSkill || 0.7;
    this.state = 'approach';
    this.stateT = 0;
    this.holdDist = U.rand(E.holdMin, E.holdMax);
    this.fireT = U.rand(2.5, 4);
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this._fwd = new THREE.Vector3();
    this._buildMesh();
  }

  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x22303a, metalness: 0.85, roughness: 0.38,
      emissive: 0x18c8ff, emissiveIntensity: 0.22, side: THREE.DoubleSide,
      envMapIntensity: 1.2 });
    this.flashMats.push({ mat: hull, base: 0.22 });
    const trim = shared(new THREE.MeshStandardMaterial({ color: 0x131c24, metalness: 0.88, roughness: 0.42 }));
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 2.2, 3.2) }));
    // broad forward wedge + skirt + keel — unmistakable from every hull
    const hullGeo = ShipGeo.get('int.hull', () => mergeGeos([
      { geo: new THREE.CylinderGeometry(1.7, 3.2, 9, 6), rot: [-Math.PI / 2, 0, 0], scale: [1.55, 0.72, 1] },
      { geo: new THREE.ConeGeometry(1.7, 4.4, 6), rot: [-Math.PI / 2, 0, 0], scale: [1.55, 0.72, 1], pos: [0, 0, -6.6] },
      { geo: new THREE.BoxGeometry(7.4, 1.4, 3.4), pos: [0, -1.5, 2.2] },
      { geo: new THREE.BoxGeometry(5.2, 1.1, 2.6), pos: [0, 1.7, 1.4] },
      { geo: new THREE.BoxGeometry(0.3, 2.6, 3.2), pos: [4.4, 0.4, 1.6], rot: [0, 0, -0.3] },
      { geo: new THREE.BoxGeometry(0.3, 2.6, 3.2), pos: [-4.4, 0.4, 1.6], rot: [0, 0, 0.3] },
      { geo: new THREE.CylinderGeometry(1.15, 1.5, 0.7, 8), rot: [-Math.PI / 2, 0, 0], pos: [1.5, 0, 5.2] },
      { geo: new THREE.CylinderGeometry(1.15, 1.5, 0.7, 8), rot: [-Math.PI / 2, 0, 0], pos: [-1.5, 0, 5.2] },
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('int.trim', () => mergeGeos([
      { geo: new THREE.SphereGeometry(0.7, 10, 8), scale: [0.85, 0.55, 1.4], pos: [0, 1.05, -2.4] },
      { geo: new THREE.BoxGeometry(4.4, 0.26, 5.4), pos: [0, 1.85, 0.8] },
      { geo: new THREE.BoxGeometry(3.4, 0.7, 1.6), pos: [0, -1.1, -3.4] },
      // the signature: three gravity-well projector barrels on the chin
      { geo: new THREE.CylinderGeometry(0.3, 0.42, 2.0, 8), rot: [-Math.PI / 2, 0, 0], pos: [0, -0.8, -4.4] },
      { geo: new THREE.CylinderGeometry(0.24, 0.34, 1.7, 8), rot: [-Math.PI / 2, 0, 0], pos: [1.15, -0.55, -4.1] },
      { geo: new THREE.CylinderGeometry(0.24, 0.34, 1.7, 8), rot: [-Math.PI / 2, 0, 0], pos: [-1.15, -0.55, -4.1] },
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    // pulsing well-ring halo around the nose projector
    this.wellRing = new THREE.Mesh(
      new THREE.TorusGeometry(2.5, 0.09, 6, 32),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 2.0, 3.0), transparent: true, opacity: 0.6 }));
    this.wellRing.rotation.x = Math.PI / 2;
    this.wellRing.position.set(0, -0.8, -5.2);
    model.add(this.wellRing);
    const engGeo = ShipGeo.get('int.eng', () => new THREE.CircleGeometry(1.15, 12));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 1.5, 0, 5.6);
      model.add(e); this.engMeshes.push(e);
    }
    g.position.copy(this.pos);
    this.mesh = g;
    this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  onHurt() {
    if (this.state === 'approach' && Math.random() < 0.1) this.state = 'hold';
  }

  inWell(p) {
    if (!this.alive) return false;
    const E = CFG.enemies.interdictor;
    // dedicated vectors: called from Player._updateVelocity, where the
    // shared _v3/_v6 scratch slots are already live (aliasing hazard)
    if (!this._wa) { this._wa = new THREE.Vector3(); this._wb = new THREE.Vector3(); }
    this._wb.copy(p).sub(this.pos);
    this._fwd.set(0, 0, -1).applyQuaternion(this.quat);
    const fwd = -this._wb.dot(this._fwd);
    const lat2 = Math.max(0, this._wb.lengthSq() - fwd * fwd);
    if (fwd > 0 && fwd < 560 && Math.sqrt(lat2) < E.wellRadius)
      return true;                          // inside the discard well
    return p.distanceTo(this.pos) < E.wellRadius; // inside the ship well
  }

  update(dt) {
    if (!this.alive) return;
    this.stateT += dt;
    this.fireT -= dt;
    const p = G.player, E = CFG.enemies.interdictor;
    const spd = E.speed * this.spdMult;
    // hull faces the player: direction DELTA into a dedicated vector
    // (the lookAt eye is the origin — never pass world positions here)
    if (!this._aim) this._aim = new THREE.Vector3();
    this._aim.copy(p.pos).sub(this.pos);
    if (this._aim.lengthSq() > 1e-6) {
      _m1.lookAt(_ORIGIN, this._aim, UP);
      this.quat.setFromRotationMatrix(_m1);
    }
    // nav strobes + well ring pulse
    this._glowT += dt;
    if (this.wellRing) {
      const pulse = 0.35 + 0.3 * Math.sin(this._glowT * 5);
      this.wellRing.material.opacity = pulse;
      this.wellRing.scale.setScalar(1 + 0.12 * Math.sin(this._glowT * 3.1));
    }
    const gs = 0.9 + Math.sin(this._glowT * 12) * 0.1;
    for (const e of this.engMeshes) e.scale.setScalar(gs);

    const dist = _v1.copy(p.pos).sub(this.pos).length();
    switch (this.state) {
      case 'approach':
        this.steerToward(p.pos, dt, spd, E.accel, 60);
        if (dist < this.holdDist) { this.state = 'hold'; this.stateT = 0; }
        break;
      case 'hold': {
        if (dist < this.holdDist - 60) {
          _v2.copy(this.pos).sub(p.pos).normalize().multiplyScalar(200).add(this.pos);
          this.steerToward(_v2, dt, spd, E.accel, 40);
        } else if (dist > this.holdDist + 60) {
          this.steerToward(p.pos, dt, spd, E.accel, 60);
        }
        // long slow orbit so the well sweeps across the arena
        _v2.copy(this.pos).sub(p.pos); _v2.y = 0;
        if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
        _v3.set(-_v2.z, 0, _v2.x).normalize().multiplyScalar(this.latDir || 1);
        _v3.add(this.pos);
        this.steerToward(_v3, dt, spd * 0.5, E.accel * 0.5, 50);
        if (this.stateT > 20) { this.state = 'approach'; this.stateT = 0; }
        break;
      }
    }
    this.avoidGround(dt, 70);
    if (this.vel.length() > spd * 1.25) this.vel.setLength(spd * 1.25);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    // triple heavy-bolt salvo, tight spread
    if (this.fireT <= 0 && dist < E.fireRange) {
      this.fireT = E.salvoGap * U.rand(0.9, 1.2);
      _v3.set(0, 0, -1).applyQuaternion(this.quat);
      _v4.copy(this.pos).addScaledVector(_v3, this.radius + 2);
      const tGo = dist / E.boltSpeed;
      for (let i = -1; i <= 1; i++) {
        _v2.copy(p.pos).addScaledVector(p.vel, tGo * this.leadSkill)
           .addScaledVector(_v6.set(p.vel.z, 0, -p.vel.x).normalize(), i * 9)
           .sub(_v4).normalize();
        Projectiles.fire('eheavy', 'enemy', _v4, _v2, { src: this, speed: E.boltSpeed, dmg: E.boltDmg, life: 3 });
      }
      FX.muzzle(_v4, true);
      G.audio.shotHeavy();
    }
  }
}


/* ============================================================
   UPGRADE (v1.3, restored) — LANCER SUPPORT GUNSHIP "BULWARK"
   A heavy friendly gunship that holds station off the player's
   flank and fires mostly-independent twin cannons at anything
   hostile. Tough; dies loudly. Color language: deep blue hull.
============================================================ */
class LancerAlly {
  constructor(pos) {
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this.hp = this.maxHp = 320;
    this.radius = 7;
    this.alive = true;
    this.flash = 0;
    this.fireT = U.rand(1.5, 3);
    this.burstN = 0; this.burstT = 0;
    this.flakT = U.rand(6, 9);
    this.orbitA = U.rand(0, U.TAU);
    this._buildMesh();
  }

  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x1e3244, metalness: 0.78, roughness: 0.42,
      emissive: 0x2fa8ff, emissiveIntensity: 0.28, side: THREE.DoubleSide });
    this.hullMat = hull;
    const trim = shared(new THREE.MeshStandardMaterial({ color: 0x141e28, metalness: 0.85, roughness: 0.42 }));
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 1.6, 2.6) }));
    // stubby twin-hull gunboat — unmistakably friendly (blue) and heavy
    const hullGeo = ShipGeo.get('lnc.hull', () => mergeGeos([
      { geo: new THREE.BoxGeometry(3.4, 2.2, 10), pos: [1.4, 0, 0] },
      { geo: new THREE.BoxGeometry(3.4, 2.2, 10), pos: [-1.4, 0, 0] },
      { geo: new THREE.ConeGeometry(1.6, 4.4, 8), rot: [-Math.PI / 2, 0, 0], pos: [1.4, 0, -7], scale: [1, 1, 0.6] },
      { geo: new THREE.ConeGeometry(1.6, 4.4, 8), rot: [-Math.PI / 2, 0, 0], pos: [-1.4, 0, -7], scale: [1, 1, 0.6] },
      { geo: new THREE.BoxGeometry(8.6, 0.7, 3.2), pos: [0, 0.9, 1.2] },        // wing
      { geo: new THREE.BoxGeometry(0.5, 2.4, 2.6), pos: [4.1, 0.4, 1.6], rot: [0, 0, -0.3] },
      { geo: new THREE.BoxGeometry(0.5, 2.4, 2.6), pos: [-4.1, 0.4, 1.6], rot: [0, 0, 0.3] },
      { geo: new THREE.CylinderGeometry(0.34, 0.42, 2.6, 8), rot: [-Math.PI / 2, 0, 0], pos: [1.4, -0.8, -6.2] },  // twin cannons
      { geo: new THREE.CylinderGeometry(0.34, 0.42, 2.6, 8), rot: [-Math.PI / 2, 0, 0], pos: [-1.4, -0.8, -6.2] },
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('lnc.trim', () => mergeGeos([
      { geo: new THREE.SphereGeometry(0.55, 8, 6), scale: [0.9, 0.6, 1.5], pos: [0, 1.25, -2.2] },
      { geo: new THREE.BoxGeometry(2.2, 0.4, 3.4), pos: [0, 1.6, 1.6] },
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('lnc.eng', () => new THREE.CircleGeometry(0.62, 12));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 1.4, 0, 5.4);
      model.add(e); this.engMeshes.push(e);
    }
    g.position.copy(this.pos);
    this.mesh = g;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  update(dt) {
    if (!this.alive) return;
    const p = G.player;
    // loose flank station: orbit the player at ~90u, drift with them
    this.orbitA += 0.22 * dt;
    _v1.set(Math.cos(this.orbitA) * 90, 12 + Math.sin(this.orbitA * 0.7) * 8, Math.sin(this.orbitA) * 90)
       .applyQuaternion(p.quat).add(p.pos);
    _v2.copy(_v1).sub(this.pos);
    const d = _v2.length();
    if (d > 1) {
      _v2.multiplyScalar(Math.min(d, 60) / d * 2.4);
      _v2.sub(this.vel);
      if (_v2.length() > 34) _v2.setLength(34);
      this.vel.addScaledVector(_v2, dt);
    }
    this.vel.multiplyScalar(Math.exp(-1.2 * dt));
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    // face the nearest hostile — direction DELTA into a dedicated vector
    let best = null, bestD = 1e9;
    for (const e of G.enemies.list) {
      if (!e.alive) continue;
      const dd = e.pos.distanceToSquared(this.pos);
      if (dd < bestD) { bestD = dd; best = e; }
    }
    if (!this._aim) this._aim = new THREE.Vector3();
    if (best) this._aim.copy(best.pos).sub(this.pos);
    else this._aim.copy(p.vel).multiplyScalar(-1);
    if (this._aim.lengthSq() > 1e-6) {
      _m1.lookAt(_ORIGIN, this._aim, UP);
      this.quat.setFromRotationMatrix(_m1);
    }
    this.mesh.quaternion.copy(this.quat);
    // engine flicker
    this._glowT += dt;
    const gs = 0.9 + Math.sin(this._glowT * 15) * 0.12;
    for (const e of this.engMeshes) e.scale.setScalar(gs);

    // twin cannon bursts at the nearest hostile
    this.fireT -= dt;
    if (this.fireT <= 0 && best && bestD < 620 * 620) {
      this.burstN = 3; this.fireT = U.rand(1.6, 2.4);
    }
    if (this.burstN > 0) {
      this.burstT -= dt;
      if (this.burstT <= 0 && best) {
        this.burstT = 0.13;
        this.burstN--;
        const E = CFG.enemies.fighter;
        _v3.set(0, -0.8, -1).applyQuaternion(this.quat);
        _v4.copy(this.pos).addScaledVector(_v3, this.radius + 2);
        _v2.copy(best.pos).sub(_v4).normalize();
        Projectiles.fire('bolt', 'player', _v4, _v2, { speed: 640, dmg: 7, life: 1.6, noStats: true });
        G.audio.shotBlaster(0.3);
      }
    }
    // periodic flak burst at close hostiles
    this.flakT -= dt;
    if (this.flakT <= 0) {
      this.flakT = U.rand(6, 9);
      if (best && bestD < 300 * 300) {
        FX.explosion(best.pos, 4);
        for (const e of G.enemies.list) {
          if (e.alive && e.pos.distanceToSquared(best.pos) < 30 * 30) e.damage(10, e.pos);
        }
        G.audio.explosion(0.4);
      }
    }
  }

  damage(dmg, hitPos) {
    if (!this.alive) return;
    this.hp -= dmg;
    this.flash = 0.4;
    if (this.hp <= 0) {
      this.alive = false;
      FX.explosion(this.pos, 9);
      G.audio.explosion(0.8);
      G.hud.alert('BULWARK LOST', 2.5);
      this.dispose();
    }
  }

  dispose() {
    if (this.mesh) { G.scene.remove(this.mesh); this.mesh = null; }
  }
}

/* ============================================================
   UPGRADE (v1.3, restored) — HORNET WING: 3 micro-drones that
   orbit the player tightly and peck anything that gets close.
   Fragile, replaced on refit. Blue accent = friendly.
============================================================ */
class HornetWing {
  constructor(pos, count) {
    this.count = count || 3;
    this.drones = [];
    for (let i = 0; i < this.count; i++) this.drones.push(this._make(pos, i));
    this.alive = true;
  }

  _make(pos, i) {
    const a = (i / this.count) * U.TAU;
    const d = {
      pos: pos.clone().add(new THREE.Vector3(Math.cos(a) * 14, 3, Math.sin(a) * 14)),
      vel: new THREE.Vector3(),
      hp: 18,
      alive: true,
      orbitA: a,
      fireT: U.rand(0.5, 1.5),
      mesh: null,
    };
    const g = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.TetrahedronGeometry(0.9),
      new THREE.MeshStandardMaterial({ color: 0x20364a, metalness: 0.8, roughness: 0.35, emissive: 0x2fa8ff, emissiveIntensity: 0.5 }));
    body.rotation.z = 0.6;
    g.add(body);
    d.mesh = g;
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
    return d;
  }

  update(dt) {
    if (!this.alive) return;
    const p = G.player;
    let anyAlive = false;
    for (const d of this.drones) {
      if (!d.alive) continue;
      anyAlive = true;
      d.orbitA += 1.4 * dt;
      _v1.set(Math.cos(d.orbitA) * 13, 4 + Math.sin(d.orbitA * 1.3) * 2, Math.sin(d.orbitA) * 13)
         .applyQuaternion(p.quat).add(p.pos);
      _v2.copy(_v1).sub(d.pos);
      _v2.multiplyScalar(3.2);
      _v2.sub(d.vel);
      if (_v2.length() > 60) _v2.setLength(60);
      d.vel.addScaledVector(_v2, dt);
      d.pos.addScaledVector(d.vel, dt);
      d.mesh.position.copy(d.pos);
      d.mesh.quaternion.copy(p.quat);
      d.mesh.rotation.y += 6 * dt;
      // peck: nearest hostile inside 260u
      d.fireT -= dt;
      if (d.fireT <= 0) {
        let best = null, bestD = 260 * 260;
        for (const e of G.enemies.list) {
          if (!e.alive) continue;
          const dd = e.pos.distanceToSquared(d.pos);
          if (dd < bestD) { bestD = dd; best = e; }
        }
        if (best) {
          d.fireT = U.rand(0.7, 1.2);
          _v2.copy(best.pos).sub(d.pos).normalize();
          Projectiles.fire('bolt', 'player', d.pos, _v2, { speed: 600, dmg: 4, life: 1.2, noStats: true });
          G.audio.shotBlaster(0.2);
        }
      }
    }
    this.alive = anyAlive;
  }

  dispose() {
    for (const d of this.drones) if (d.mesh) G.scene.remove(d.mesh);
    this.drones.length = 0;
    this.alive = false;
  }
}

/* ============================================================
   WINGMEN REGISTRY: Vanguard fighters that spawn together, fight
   independently, and get dead pilots replaced between waves.
============================================================ */
const Wingmen = {
  wing: [],
  spawn(n) {
    this.clear();
    for (let i = 0; i < n; i++) {
      _v1.copy(G.player.pos);
      this.wing.push(new Vanguard(_v1));
    }
    G.hud.alert('RED WING ONLINE — ' + n + ' SHIPS', 2.5);
  },
  clear() {
    for (const v of this.wing) v.dispose();
    this.wing.length = 0;
  },
  update(dt) {
    for (const v of this.wing) if (v.alive) v.update(dt);
  },
  /* called between waves: dead pilots replaced at the player, live
     ones patched up — the wing persists across the lull */
  patchBetweenWaves() {
    for (let i = 0; i < this.wing.length; i++) {
      if (this.wing[i].alive) this.wing[i].hp = Math.min(this.wing[i].maxHp, this.wing[i].hp + 20);
      else { this.wing[i].dispose(); _v1.copy(G.player.pos); this.wing[i] = new Vanguard(_v1); }
    }
  },
};

/* ============================================================
   UPGRADE (restored) — RAVAGER: heavy assault craft. Pressure-
   flak bursts that fill space near the player, minesweeper blades
   that vaporize ordnance on contact, and a punishing contact ram.
============================================================ */
class Ravager extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill) {
    super('ravager');
    const E = CFG.enemies.ravager;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = 8;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.leadSkill = leadSkill || 0.7;
    this.state = 'approach';
    this.stateT = 0;
    this.latDir = Math.random() < 0.5 ? 1 : -1;
    this.fireT = U.rand(2, 4);
    this.flakN = 0; this.flakT = 0;
    this._buildMesh();
  }

  /* brutalist plow: blunt wedge, minebreaker blades, quad stacks */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x32261c, metalness: 0.8, roughness: 0.44, envMapIntensity: 1.1,
      emissive: 0xff6a1a, emissiveIntensity: 0.26 });
    this.flashMats.push({ mat: hull, base: 0.26 });
    const trim = HULL.recess(0x1a140e);
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.9, 0.25) }));
    const hullGeo = ShipGeo.get('rav.hull2', () => mergeGeos([
      { geo: new THREE.BoxGeometry(5.6, 2.6, 9), pos: [0, 0, 0.6] },
      { geo: new THREE.ConeGeometry(2.8, 4.6, 4), rot: [-Math.PI / 2, 0, 0], pos: [0, 0, -6.4], scale: [1, 1, 0.7] },
      { geo: new THREE.BoxGeometry(9.6, 0.6, 3.4), pos: [0, -0.6, 1.4] },        // minesweeper wing
      { geo: new THREE.BoxGeometry(0.4, 3.4, 2.4), pos: [4.8, 0.2, -2.4], rot: [0, 0, -0.5] },  // blades
      { geo: new THREE.BoxGeometry(0.4, 3.4, 2.4), pos: [-4.8, 0.2, -2.4], rot: [0, 0, 0.5] },
      /* FIX(silhouette): the exhaust stacks ran the WRONG way and ended
         amidships, so the engine discs floated buried inside the hull —
         nothing glowed from the stern. The stacks now run aft along the
         deck and the discs sit proud of the tail. */
      { geo: new THREE.CylinderGeometry(0.62, 0.82, 7.0, 6), rot: [-Math.PI / 2, 0, 0], pos: [1.8, 1.55, 1.6] },
      { geo: new THREE.CylinderGeometry(0.62, 0.82, 7.0, 6), rot: [-Math.PI / 2, 0, 0], pos: [-1.8, 1.55, 1.6] },
      { geo: new THREE.BoxGeometry(4.4, 0.3, 0.9), pos: [0, 1.9, 3.2] },          // stack brace
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('rav.trim', () => mergeGeos([
      { geo: new THREE.SphereGeometry(0.6, 8, 6), scale: [0.9, 0.6, 1.4], pos: [0, 1.6, -1.4] },
      { geo: new THREE.BoxGeometry(3.2, 0.5, 2.2), pos: [0, -1.7, -0.8] },
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('rav.eng', () => new THREE.CircleGeometry(0.68, 10));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 1.8, 1.55, 5.25);
      model.add(e); this.engMeshes.push(e);
    }
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  onHurt() {
    if (this.state === 'approach' && Math.random() < 0.14) { this.state = 'hold'; this.stateT = 0; }
  }

  /* pressure flak: a fan of fast shells sweeping the player's position */
  _fireFlak(tgt) {
    const E = CFG.enemies.ravager;
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 2);
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const tGo = dist / E.flakSpeed;
    _v2.copy(tgt.pos).addScaledVector(tgt.vel, tGo * this.leadSkill)
       .add(_v5.copy(U.randomDir(_v6)).multiplyScalar(9))
       .sub(_v4).normalize();
    Projectiles.fire('ebolt', 'enemy', _v4, _v2, { src: this, speed: E.flakSpeed, dmg: E.flakDmg, life: 1.6 });
    FX.muzzle(_v4, true);
  }

  update(dt) {
    const E = CFG.enemies.ravager;
    this.stateT += dt;
    this.updateFlash(dt);
    const tgt = G.player;
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const speed = E.speed * this.spdMult;

    switch (this.state) {
      case 'approach':
        this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        this.faceTowards(tgt.pos, E.turn, dt);
        if (dist < E.holdMax) { this.state = 'hold'; this.stateT = 0; }
        break;
      case 'hold': {
        if (dist < E.holdMin) {
          _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(170).add(this.pos);
          this.steerToward(_v2, dt, speed, E.accel, 40);
        } else if (dist > E.holdMax) {
          this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        } else {
          _v2.copy(this.pos).sub(tgt.pos); _v2.y = 0;
          if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
          _v3.set(-_v2.z, 0, _v2.x).normalize().multiplyScalar(this.latDir * 50);
          _v3.add(this.pos);
          this.steerToward(_v3, dt, speed * 0.6, E.accel * 0.6, 30);
        }
        this.faceTowards(tgt.pos, E.turn, dt);
        if (this.stateT > 16) { this.state = 'approach'; this.stateT = 0; }   // FSM failsafe
        break;
      }
    }

    this.avoidGround(dt, 80);
    if (this.vel.length() > speed * 1.25) this.vel.setLength(speed * 1.25);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    this._glowT += dt;
    const gs = 0.9 + Math.sin(this._glowT * 13) * 0.14;
    for (const e of this.engMeshes) e.scale.setScalar(gs);

    // flak bursts: one every few seconds, then a rapid 6-shell fan
    this.fireT -= dt;
    if (this.fireT <= 0 && dist < E.fireRange && this.flakN === 0) {
      this.flakN = E.flakShots; this.flakT = 0;
      this.fireT = U.rand(3.2, 4.6);
    }
    if (this.flakN > 0) {
      this.flakT -= dt;
      if (this.flakT <= 0 && this.state !== 'approach') {
        this.flakT = E.flakGap;
        this.flakN--;
        this._fireFlak(tgt);
        if (this.flakN === 0) G.audio.shotHeavy();
      }
    }
    if (Math.random() < 0.5) this.enginePuff([1, 0.5, 0.15]);
  }
}

/* ============================================================
   UPGRADE (restored) — SENTINEL: hovering shield/repair platform.
   Regenerates nearby hostile hulls,its aura hardens them against
   damage, and two guard shards orbit it sniping at the player.
   Kill it first or the wave drags.
============================================================ */
class Sentinel extends Enemy {
  constructor(pos, hpMult, spdMult) {
    super('sentinel');
    const E = CFG.enemies.sentinel;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = 7.5;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.state = 'approach';
    this.stateT = 0;
    this.fireT = U.rand(1.5, 3);
    this.guards = [];
    this._buildMesh();
  }

  /* monky hab: ring monastery around a glowing reactor heart */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x2c3038, metalness: 0.76, roughness: 0.46,
      emissive: 0x40ffd0, emissiveIntensity: 0.3, side: THREE.DoubleSide });
    this.flashMats.push({ mat: hull, base: 0.3 });
    const trim = shared(new THREE.MeshStandardMaterial({ color: 0x181b20, metalness: 0.84, roughness: 0.44 }));
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.35, 2.4, 1.9) }));
    const hullGeo = ShipGeo.get('sen.hull', () => mergeGeos([
      { geo: new THREE.TorusGeometry(3.4, 1.0, 8, 18) },
      { geo: new THREE.CylinderGeometry(1.3, 1.7, 1.4, 8), rot: [-Math.PI / 2, 0, 0], pos: [0, 0, 0] },
      { geo: new THREE.BoxGeometry(1.1, 1.1, 2.6), pos: [0, 0, -2.2] },
      { geo: new THREE.BoxGeometry(0.5, 2.2, 0.5), pos: [3.4, 1.4, 0] },
      { geo: new THREE.BoxGeometry(0.5, 2.2, 0.5), pos: [-3.4, 1.4, 0] },
      { geo: new THREE.BoxGeometry(0.5, 2.2, 0.5), pos: [0, 1.6, 3.4] },
      { geo: new THREE.BoxGeometry(0.5, 2.2, 0.5), pos: [0, 1.6, -3.4] },
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const heart = new THREE.Mesh(new THREE.SphereGeometry(0.95, 10, 8), glowMat);
    model.add(heart);
    this.heart = heart;
    // the shield aura bubble (scaled by regen pulses)
    this.aura = new THREE.Mesh(
      new THREE.SphereGeometry(CFG.enemies.sentinel.auraRange * 0.16, 16, 12),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.3, 1.6, 1.3), transparent: true, opacity: 0.05 }));
    g.add(this.aura);
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  _spawnGuard(i) {
    const E = CFG.enemies.sentinel;
    const gd = {
      a: (i / E.guard) * U.TAU,
      hp: 14, alive: true, fireT: U.rand(1, 2),
      pos: this.pos.clone(), mesh: null,
    };
    const m = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.85),
      new THREE.MeshStandardMaterial({ color: 0x39424e, metalness: 0.8, roughness: 0.35, emissive: 0x40ffd0, emissiveIntensity: 0.6 }));
    gd.mesh = m;
    G.scene.add(m);
    this.guards.push(gd);
  }

  update(dt) {
    const E = CFG.enemies.sentinel;
    this.stateT += dt;
    this.updateFlash(dt);
    const tgt = G.player;
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const speed = E.speed * this.spdMult;

    switch (this.state) {
      case 'approach':
        this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        this.faceTowards(tgt.pos, E.turn, dt);
        if (dist < E.holdMax) { this.state = 'hold'; this.stateT = 0; }
        break;
      case 'hold': {
        if (dist < E.holdMin) {
          _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(200).add(this.pos);
          this.steerToward(_v2, dt, speed, E.accel, 40);
        } else if (dist > E.holdMax) {
          this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        }
        this.faceTowards(tgt.pos, E.turn * 0.7, dt);
        if (this.stateT > 18) { this.state = 'approach'; this.stateT = 0; }   // FSM failsafe
        break;
      }
    }

    this.avoidGround(dt, 55);
    if (this.vel.length() > speed * 1.2) this.vel.setLength(speed * 1.2);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    // reactor heart pulse + aura shimmer
    this._glowT += dt;
    if (this.heart) this.heart.scale.setScalar(0.9 + Math.sin(this._glowT * 6) * 0.12);
    if (this.aura) this.aura.material.opacity = 0.04 + 0.02 * Math.sin(this._glowT * 2.4);

    // AURA: regenerate nearby hostiles (bosses and self excluded)
    for (const e of G.enemies.list) {
      if (!e.alive || e === this || e.type === 'boss' || e.type === 'mine') continue;
      if (e.pos.distanceToSquared(this.pos) < E.auraRange * E.auraRange) {
        e.hp = Math.min(e.maxHp, e.hp + E.regen * dt);
      }
    }

    // guard shards: orbit, snipe
    while (this.guards.length < E.guard) this._spawnGuard(this.guards.length);
    for (const gd of this.guards) {
      if (!gd.alive) continue;
      gd.a += 1.1 * dt;
      _v2.set(Math.cos(gd.a) * 16, 5, Math.sin(gd.a) * 16).add(this.pos);
      gd.pos.lerp(_v2, Math.min(1, 3 * dt));
      gd.mesh.position.copy(gd.pos);
      gd.fireT -= dt;
      if (gd.fireT <= 0 && dist < E.fireRange) {
        gd.fireT = U.rand(1.6, 2.6);
        _v3.copy(tgt.pos).sub(gd.pos).normalize();
        Projectiles.fire('ebolt', 'enemy', gd.pos, _v3, { src: this, speed: E.guardSpeed, dmg: E.guardDmg, life: 1.6 });
        G.audio.shotBlaster(0.5);
      }
    }
  }

  damage(dmg, hitPos, vel) {
    // guards soak their own hits; body takes the rest
    return super.damage(dmg, hitPos, vel);
  }

  _die() {
    this.alive = false;
    for (const gd of this.guards) {
      gd.alive = false;
      if (gd.mesh) { G.scene.remove(gd.mesh); gd.mesh = null; }
    }
    G.game.onEnemyKilled(this);
  }

  dispose() {
    super.dispose();
    for (const gd of this.guards) if (gd.mesh) { G.scene.remove(gd.mesh); gd.mesh = null; }
    this.guards.length = 0;
  }
}

/* ============================================================
   UPGRADE (restored) — AEGIS FRIGATE (friendly): slow support
   ship that dampens hostile engines in a wide bubble and paints
   targets. No guns — pure force multiplier.
============================================================ */
class Aegis {
  constructor(pos) {
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.hp = this.maxHp = 260;
    this.radius = 8;
    this.alive = true;
    this.flash = 0;
    this._buildMesh();
  }

  _buildMesh() {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0x2a4a42, metalness: 0.75, roughness: 0.42,
      emissive: 0x40ffd0, emissiveIntensity: 0.22, side: THREE.DoubleSide });
    this.hullMat = hull;
    const trim = shared(new THREE.MeshStandardMaterial({ color: 0x16241f, metalness: 0.85, roughness: 0.4 }));
    const body = new THREE.Mesh(new THREE.BoxGeometry(6, 3.4, 22), hull);
    g.add(body);
    const tower = new THREE.Mesh(new THREE.BoxGeometry(2.6, 3.6, 5), trim);
    tower.position.set(0, 3, 4); g.add(tower);
    const dish = new THREE.Mesh(new THREE.CylinderGeometry(2.2, 2.2, 0.4, 12), trim);
    dish.rotation.x = Math.PI / 3; dish.position.set(0, 5.6, 4); g.add(dish);
    for (const s of [-1, 1]) {
      const nac = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, 9, 8), trim);
      nac.rotation.x = Math.PI / 2; nac.position.set(s * 4.2, -0.4, 3); g.add(nac);
    }
    this.field = new THREE.Mesh(
      new THREE.SphereGeometry(46, 20, 14),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(0.25, 1.5, 1.2), transparent: true, opacity: 0.045 }));
    g.add(this.field);
    g.position.copy(this.pos);
    this.mesh = g;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  update(dt) {
    if (!this.alive) return;
    const p = G.player;
    this._glowT += dt;
    // hold station far off the player's flank
    _v1.set(1, 0.25, 0.4).applyQuaternion(p.quat).multiplyScalar(150).add(p.pos);
    _v2.copy(_v1).sub(this.pos);
    const d = _v2.length();
    if (d > 1) {
      _v2.multiplyScalar(Math.min(d, 55) / d * 1.6);
      _v2.sub(this.vel);
      if (_v2.length() > 30) _v2.setLength(30);
      this.vel.addScaledVector(_v2, dt);
    }
    this.vel.multiplyScalar(Math.exp(-1.1 * dt));
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(p.quat);
    this.field.material.opacity = 0.035 + 0.02 * Math.sin(this._glowT * 2.1);

    // DAMPEN: hostile engines inside the field get dragged
    for (const e of G.enemies.list) {
      if (!e.alive || e.type === 'mine' || e.type === 'turret' || e.type === 'boss') continue;
      if (e.pos.distanceToSquared(this.pos) < 240 * 240) {
        e.vel.multiplyScalar(Math.exp(-1.7 * dt));
      }
    }
  }

  damage(dmg, hitPos) {
    if (!this.alive) return;
    this.hp -= dmg;
    this.flash = 0.4;
    if (this.hp <= 0) {
      this.alive = false;
      FX.explosion(this.pos, 10);
      G.audio.explosion(0.9);
      G.hud.alert('AEGIS FRIGATE LOST', 2.5);
      this.dispose();
    }
  }

  dispose() {
    if (this.mesh) { G.scene.remove(this.mesh); this.mesh = null; }
  }
}


/* ============================================================
   NEW ENEMY (v1.4) — INTERCEPTOR: hit-and-run duelist.
   ------------------------------------------------------------
   FSM: passIn (scream in from a side angle, hard lead prediction)
   → slash (one committed gun pass) → reposition (blowtorch away to
   a new approach bearing). A passT failsafe guarantees no state
   can hang. Punishes players who sit still — moving sideways
   wrecks its aim solution.
============================================================ */
class Interceptor extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill) {
    super('interceptor');
    const E = CFG.enemies.interceptor;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = 3.5;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.leadSkill = leadSkill || 0.7;
    this.state = 'passIn';
    this.stateT = 0;
    this.passT = 0;          // failsafe timer for the current state
    this.latDir = Math.random() < 0.5 ? 1 : -1;
    this.fireT = 0;
    this.shots = 0;
    this._buildMesh();
  }

  /* needle dart: narrow nose, swept canards, single hot engine */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    /* FrontSide: every piece here is a closed solid, so double-siding only
       bought see-through shading artifacts (and 2x fragment cost) */
    const hull = new THREE.MeshStandardMaterial({
      color: 0x30243c, metalness: 0.82, roughness: 0.36, envMapIntensity: 1.15,
      emissive: 0xff4ad8, emissiveIntensity: 0.26 });
    this.flashMats.push({ mat: hull, base: 0.26 });
    const trim = HULL.recess(0x191222);
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 0.6, 2.2) }));
    const hullGeo = ShipGeo.get('itc.hull', () => mergeGeos([
      { geo: new THREE.ConeGeometry(1.05, 6.4, 6), rot: [-Math.PI / 2, 0, 0], scale: [1, 0.62, 1] },
      { geo: new THREE.CylinderGeometry(1.05, 1.5, 2.6, 6), rot: [-Math.PI / 2, 0, 0], pos: [0, 0, 4.4], scale: [1, 0.62, 1] },
      { geo: new THREE.BoxGeometry(5.4, 0.22, 1.9), pos: [0, -0.1, 1.6] },       // swept wing
      { geo: new THREE.BoxGeometry(0.16, 1.3, 1.3), pos: [2.5, 0.35, 2.2], rot: [0, 0, -0.5] },
      { geo: new THREE.BoxGeometry(0.16, 1.3, 1.3), pos: [-2.5, 0.35, 2.2], rot: [0, 0, 0.5] },
      { geo: new THREE.BoxGeometry(0.3, 0.5, 2.2), pos: [0, 0.8, 0.4] },         // spine
      /* forward-swept canards: the duelist's signature (the fighter's
         planform stays a straight dart, so the two never confuse) */
      { geo: new THREE.BoxGeometry(1.5, 0.08, 0.62), pos: [0.95, 0.06, -1.45], rot: [0, 0.5, 0] },
      { geo: new THREE.BoxGeometry(1.5, 0.08, 0.62), pos: [-0.95, 0.06, -1.45], rot: [0, -0.5, 0] },
      /* nose chines: sharp forebody edges instead of a bare cone */
      { geo: new THREE.BoxGeometry(0.14, 0.2, 3.4), pos: [0.55, 0.02, -1.2], rot: [0, 0.06, 0] },
      { geo: new THREE.BoxGeometry(0.14, 0.2, 3.4), pos: [-0.55, 0.02, -1.2], rot: [0, -0.06, 0] },
      /* ventral strakes */
      { geo: new THREE.BoxGeometry(0.1, 0.5, 2.0), pos: [0.6, -0.55, 1.9], rot: [0, 0, 0.22] },
      { geo: new THREE.BoxGeometry(0.1, 0.5, 2.0), pos: [-0.6, -0.55, 1.9], rot: [0, 0, -0.22] },
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('itc.trim', () => mergeGeos([
      { geo: new THREE.SphereGeometry(0.45, 8, 6), scale: [0.75, 0.55, 1.4], pos: [0, 0.55, -1.2] },  // canopy
      { geo: new THREE.BoxGeometry(0.5, 0.14, 1.7), pos: [0, -0.45, -0.4] },     // chin gun
      { geo: new THREE.BoxGeometry(0.52, 0.5, 0.5), pos: [0, 0.72, 1.75] },      // spine housing
      { geo: new THREE.BoxGeometry(0.1, 0.34, 1.5), pos: [0.72, 0.1, 2.6] },     // wing-root wells
      { geo: new THREE.BoxGeometry(0.1, 0.34, 1.5), pos: [-0.72, 0.1, 2.6] },
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('itc.eng', () => new THREE.CircleGeometry(0.78, 12));
    this.engMeshes = [];
    const e = new THREE.Mesh(engGeo, glowMat);
    e.position.set(0, 0, 5.76);      // aft of the nozzle face — never occluded
    model.add(e); this.engMeshes.push(e);
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  onHurt() {
    if (this.state === 'passIn' && Math.random() < 0.12) { this.state = 'reposition'; this.passT = 0; }
  }

  /* fire solution: lead the target's FUTURE position (side passes make
     the deflection shot honest — sitting still makes you a paper target) */
  _fire(tgt) {
    const E = CFG.enemies.interceptor;
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 1.5);
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const tGo = dist / E.boltSpeed;
    _v2.copy(tgt.pos).addScaledVector(tgt.vel, tGo * this.leadSkill * 1.5);
    _v2.sub(_v4).normalize();
    Projectiles.fire('ebolt', 'enemy', _v4, _v2, { src: this,
      speed: E.boltSpeed, dmg: E.boltDmg, life: 1.8 });
    FX.muzzle(_v4, true);
    G.audio.shotBlaster(0.35);
  }

  update(dt) {
    const E = CFG.enemies.interceptor;
    this.stateT += dt; this.passT += dt;
    this.updateFlash(dt);
    const tgt = G.player;
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const speed = E.speed * this.spdMult;

    // FSM failsafes — no state may hang (spec §15)
    if (this.passT > 6) { this.state = 'passIn'; this.passT = 0; }

    switch (this.state) {
      case 'passIn': {                       // line up a slashing side pass
        _v2.copy(tgt.pos).addScaledVector(tgt.vel, 0.8)
           .addScaledVector(_v3.set(-tgt.vel.z, 0, tgt.vel.x).normalize(), this.latDir * 150);
        this.steerToward(_v2, dt, speed, E.accel || 80, 70);
        this.faceTowards(tgt.pos, E.turn, dt);
        if (dist < E.passRange * 0.55 || this.passT > 2.6) {
          this.state = 'slash'; this.passT = 0; this.shots = 0;
        }
        break;
      }
      case 'slash': {                        // one committed gun pass
        this.steerToward(tgt.pos, dt, speed * 1.15, (E.accel || 80) * 1.2, 30);
        this.faceTowards(tgt.pos, E.turn * 1.2, dt);
        this.fireT -= dt;
        if (this.fireT <= 0 && dist < E.fireRange && this.shots < 3) {
          this._fire(tgt); this.shots++;
          this.fireT = 0.16;
        }
        if (dist < 90 || this.shots >= 3) { this.state = 'reposition'; this.passT = 0; }
        break;
      }
      case 'reposition': {                   // blowtorch away, swap bearing
        _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(380).add(this.pos);
        this.steerToward(_v2, dt, speed, E.accel || 80, 60);
        this.faceTowards(tgt.pos, E.turn * 0.5, dt);
        if (this.passT > 1.7) {
          this.latDir *= -1;
          this.state = 'passIn'; this.passT = 0;
        }
        break;
      }
    }

    this.avoidGround(dt, 70);
    if (this.vel.length() > speed * 1.35) this.vel.setLength(speed * 1.35);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    this._glowT += dt;
    this.engMeshes[0].scale.setScalar(0.9 + Math.sin(this._glowT * 22) * 0.18);
    if (Math.random() < 0.6) this.enginePuff([1, 0.35, 0.85]);
  }
}

/* ============================================================
   NEW ENEMY (v1.4) — HIVE: swarmer carrier. Holds a standoff band
   like a bomber but never fires guns — instead it belches clusters
   of razor drones on a timer. Killing it is a priority: every burst
   is 4 more drones you must dodge. Body count IS the threat.
============================================================ */
class Hive extends Enemy {
  constructor(pos, hpMult, spdMult) {
    super('hive');
    const E = CFG.enemies.hive;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = 7;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.state = 'approach';
    this.stateT = 0;
    this.latDir = Math.random() < 0.5 ? 1 : -1;
    this.spawnT = U.rand(2.5, 4);
    this._buildMesh();
  }

  /* ribbed incubator sac between twin pylons — pulsing with young */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x24301f, metalness: 0.68, roughness: 0.5,
      emissive: 0x9dff2e, emissiveIntensity: 0.3, side: THREE.DoubleSide });
    this.flashMats.push({ mat: hull, base: 0.3 });
    const trim = shared(new THREE.MeshStandardMaterial({ color: 0x131a10, metalness: 0.8, roughness: 0.45 }));
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(1.2, 2.6, 0.35) }));
    const sacGeo = ShipGeo.get('hv.sac', () => mergeGeos([
      { geo: new THREE.SphereGeometry(2.4, 10, 8), scale: [1, 0.9, 1.5] },
      { geo: new THREE.TorusGeometry(2.2, 0.28, 6, 12), pos: [0, 0, -1.2] },
      { geo: new THREE.TorusGeometry(2.4, 0.28, 6, 12), pos: [0, 0, 0.6] },
      { geo: new THREE.TorusGeometry(2.2, 0.28, 6, 12), pos: [0, 0, 2.4] },
    ]));
    model.add(new THREE.Mesh(sacGeo, hull));
    const frameGeo = ShipGeo.get('hv.frame', () => mergeGeos([
      { geo: new THREE.BoxGeometry(0.55, 0.55, 5.6), pos: [2.9, 0, 0] },      // pylons
      { geo: new THREE.BoxGeometry(0.55, 0.55, 5.6), pos: [-2.9, 0, 0] },
      { geo: new THREE.BoxGeometry(6.4, 0.4, 1.6), pos: [0, 0, 2.4] },        // crossbeams
      { geo: new THREE.BoxGeometry(6.4, 0.4, 1.6), pos: [0, 0, -2.2] },
      { geo: new THREE.CylinderGeometry(0.9, 1.2, 0.6, 8), rot: [-Math.PI / 2, 0, 0], pos: [2.9, 0, 2.9] },
      { geo: new THREE.CylinderGeometry(0.9, 1.2, 0.6, 8), rot: [-Math.PI / 2, 0, 0], pos: [-2.9, 0, 2.9] },
      { geo: new THREE.CylinderGeometry(0.55, 0.8, 2.6, 7), rot: [-Math.PI / 2, 0, 0], pos: [0, -1.6, 0.6] },  // birth canal
    ]));
    model.add(new THREE.Mesh(frameGeo, trim));
    const engGeo = ShipGeo.get('hv.eng', () => new THREE.CircleGeometry(0.66, 10));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 2.9, 0, 3.25);
      model.add(e); this.engMeshes.push(e);
    }
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    this.sacMesh = model.children[0];
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  /* belch a drone cluster: launch each at a jittered vector toward the
     player so the pack fans out naturally */
  _spawnBurst(tgt) {
    const E = CFG.enemies.hive;
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 2);
    for (let i = 0; i < E.burst; i++) {
      const d = new Drone(_v4);
      d.pos.x += U.rand(-3, 3); d.pos.y += U.rand(-3, 3); d.pos.z += U.rand(-3, 3);
      // inherit a forward shove so the pack blooms outward
      d.vel.copy(_v3).multiplyScalar(55)
        .addScaledVector(_v2.copy(tgt.pos).sub(this.pos).normalize(), 30);
      d.mesh.position.copy(d.pos);
      G.enemies.list.push(d);
    }
    FX.explosion(_v4, 2.5);
    G.audio.shotBlaster(0.5);
  }

  update(dt) {
    const E = CFG.enemies.hive;
    this.stateT += dt;
    this.updateFlash(dt);
    const tgt = G.player;
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const speed = E.speed * this.spdMult;

    switch (this.state) {
      case 'approach':
        this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        this.faceTowards(tgt.pos, E.turn, dt);
        if (dist < E.holdMax) { this.state = 'hold'; this.stateT = 0; }
        break;
      case 'hold': {
        if (dist < E.holdMin) {
          _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(180).add(this.pos);
          this.steerToward(_v2, dt, speed, E.accel, 40);
        } else if (dist > E.holdMax) {
          this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        } else {
          _v2.copy(this.pos).sub(tgt.pos); _v2.y = 0;
          if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
          _v3.set(-_v2.z, 0, _v2.x).normalize().multiplyScalar(this.latDir * 40);
          _v3.add(this.pos);
          this.steerToward(_v3, dt, speed * 0.6, E.accel * 0.6, 30);
        }
        this.faceTowards(tgt.pos, E.turn, dt);
        // FSM failsafe: cap the hold so it can never orbit forever (§15)
        if (this.stateT > 14) { this.state = 'approach'; this.stateT = 0; }
        break;
      }
    }

    this.avoidGround(dt, 60);
    if (this.vel.length() > speed * 1.3) this.vel.setLength(speed * 1.3);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    // sac pulse — faster as the burst approaches (telegraph)
    this._glowT += dt;
    const pulse = 0.9 + Math.sin(this._glowT * (this.spawnT < 1.2 ? 16 : 7)) * 0.12;
    if (this.sacMesh) this.sacMesh.scale.setScalar(pulse);
    for (const e of this.engMeshes) e.scale.setScalar(pulse);

    this.spawnT -= dt;
    if (this.spawnT <= 0 && dist < E.fireRange && this.state === 'hold') {
      this._spawnBurst(tgt);
      this.spawnT = E.spawnEvery * U.rand(0.9, 1.15);
    }
  }
}

/* SYSTEM (v1.4): ELITE MODIFIERS — applied by Enemies.spawnX after
   construction. Adds a real emissive stripe (no bare recolors: the
   stripe sits on a dedicated ring mesh) plus the stat/behavior knobs
   from CFG.eliteMods. Returns the enemy for chaining. */
function applyEliteMods(e) {
  if (!e.elite || e.type === 'mine' || e.type === 'turret' || e.type === 'boss') return e;
  const keys = Object.keys(CFG.eliteMods);
  const mod = CFG.eliteMods[keys[(Math.random() * keys.length) | 0]];
  e.eliteMod = mod.tag;
  /* the "#target-tag" HUD element shipped with nothing feeding it: every
     elite carries a callsign from CFG.namedElite so the prize ship reads
     as an ace with a name and a modifier instead of a gold blob. */
  if (!e.callsign && CFG.namedElite && CFG.namedElite.names) e.callsign = U.pick(CFG.namedElite.names);
  if (mod.hpMult) { e.hp *= mod.hpMult; e.maxHp *= mod.hpMult; }
  if (mod.speedMult) e.spdMult = (e.spdMult || 1) * mod.speedMult;
  if (mod.turnMult) e.turnMult = (e.turnMult || 1) * mod.turnMult;
  if (mod.blast) { e.blastBonus = mod.blast; e.blastDmgBonus = mod.blastDmg; }
  // visual identifier: emissive stripe torus around the hull (bloom catches it)
  if (e.mesh && !e._eliteStripe) {
    const stripe = new THREE.Mesh(
      new THREE.TorusGeometry(e.radius * 1.15, 0.12, 6, 20),
      new THREE.MeshBasicMaterial({ color: mod.tint }));
    stripe.rotation.x = Math.PI / 2;
    e.mesh.add(stripe);
    e._eliteStripe = stripe;
  }
  return e;
}

/* ============================================================
   UPGRADE(content v1.8) — NEW ACTORS
   ------------------------------------------------------------
   Two hostile archetypes that change the SHAPE of a fight, plus
   two ally craft. The stat tables live here in V18 because
   data.js's CFG ships without these keys; the wave director and
   cheat console reach the hostiles through
   Enemies.spawnReaper / Enemies.spawnProwler.
     REAPER      — long-range sniper tank. Holds a 900-1400
                   standoff band, strafes laterally, and charges
                   a telegraphed rail slug every few seconds.
     PROWLER     — fast mine-layer skirmisher. Drops mines in the
                   player's lap, plinks at range, flees when the
                   player closes. Deliberately a small silhouette.
     WASP WING   — 4 fast interceptor drones, 3-round volleys.
     SALVAGE TUG — repair craft: a green beam patches the hull.
   ============================================================ */
const V18 = {
  reaper:  { hp: 220, speed: 46, accel: 20, turn: 0.7, radius: 6, size: 7, score: 550,
             minRange: 900, maxRange: 1400, chargeTime: 1.4,
             boltSpeed: 1350, boltDmg: 26, boltLife: 4, dropChance: 0.7 },
  prowler: { hp: 95, speed: 130, accel: 70, turn: 2.4, radius: 2.6, size: 3, score: 220,
             nearRange: 500, farRange: 700, fleeRange: 300, fleeTo: 900,
             boltSpeed: 430, boltDmg: 5, boltLife: 2, dropChance: 0.3 },
  /* UPGRADE(content v1.8.1) — the three archetypes built by the
     STALKER/SAPPER/WARDEN block below. Same reason as the v1.8 pair:
     data.js's CFG ships without these keys. */
  stalker: { hp: 130, speed: 115, accel: 55, turn: 1.6, radius: 3, size: 4, score: 300,
             nearRange: 600, farRange: 1000, telegraph: 0.7, cool: 1.6,
             boltSpeed: 1150, boltDmg: 22, boltLife: 3.5, dropChance: 0.35 },
  sapper:  { hp: 180, speed: 95, accel: 45, turn: 1.1, radius: 4, size: 5, score: 320,
             nearRange: 500, farRange: 800, fleeRange: 300, fleeTo: 950,
             boltSpeed: 520, boltDmg: 6, boltLife: 2, dropChance: 0.4 },
  warden:  { hp: 260, speed: 85, accel: 40, turn: 1.0, radius: 5, size: 6, score: 420,
             standoff: 800, healRange: 500, healPerSec: 6,
             boltSpeed: 480, boltDmg: 5, boltLife: 2, dropChance: 0.5 },
};

/* UPGRADE(content v1.8) — REAPER: long-range sniper tank.
   Range-keeping is the whole identity: it refuses to brawl, drifting
   sideways inside its band while a charging muzzle ring telegraphs the
   rail slug. One shot, hard hit, then the cycle restarts. */
class Reaper extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill) {
    super('reaper');
    const E = V18.reaper;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = E.size;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.leadSkill = leadSkill || 0.7;
    this.stateT = 0;
    this.jinkSeed = U.rand(0, 100);
    this.fireT = U.rand(2, 3.4);
    this.charging = false;
    this.chargeT = 0;
    this._buildMesh();
  }

  /* siege sniper: chunky slab hull, outrigger stabilizers, a long thin
     barrel down the nose and a sensor dish on the spine. Reads as a
     standoff weapon at a glance, not a brawler. */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x2d3128, metalness: 0.82, roughness: 0.4, envMapIntensity: 1.15,
      emissive: 0xd6ff42, emissiveIntensity: 0.26 });
    this.flashMats.push({ mat: hull, base: 0.26 });
    const trim = HULL.recess(0x171a12);
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 2.6, 0.6) }));
    const hullGeo = ShipGeo.get('rep.hull', () => mergeGeos([
      HULL.box(3.2, 1.8, 6.0, [0, 0, 0.8]),                        // slab core
      HULL.box(2.2, 1.1, 2.2, [0, 0.25, -3.2]),                    // glacis shoulder
      HULL.cone(1.2, 2.6, 6, [0, 0.05, -4.4], [-Math.PI / 2, 0, 0], [1, 0.72, 1]),
      /* the barrel: long, thin, unmistakable */
      HULL.cyl(0.15, 0.2, 8.4, 8, [0, 0.2, -8.9], [-Math.PI / 2, 0, 0]),
      HULL.cyl(0.34, 0.34, 1.6, 8, [0, 0.2, -5.2], [-Math.PI / 2, 0, 0]),   // barrel shroud
      HULL.cyl(0.26, 0.3, 0.5, 8, [0, 0.2, -12.9], [-Math.PI / 2, 0, 0]),   // muzzle brake
      /* outrigger stabilizers planted wide of the hull */
      HULL.box(0.55, 0.5, 3.4, [1.9, -0.35, -1.2]),
      HULL.box(0.55, 0.5, 3.4, [-1.9, -0.35, -1.2]),
      HULL.box(1.6, 0.4, 4.2, [0, 1.15, 1.2]),                     // dorsal deck
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('rep.trim', () => mergeGeos([
      HULL.sph(0.5, 8, [0, 1.0, -2.0], [0.8, 0.5, 1.5]),           // canopy blister
      HULL.cyl(0.09, 0.12, 1.1, 5, [0, 1.8, 0.6]),                 // dish mast
      HULL.cyl(1.25, 1.25, 0.18, 10, [0, 2.35, 0.6], [Math.PI / 3, 0, 0]),  // sensor dish
      HULL.box(0.6, 0.9, 0.5, [0, 1.75, 3.0]),                     // stern housing
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('rep.eng', () => new THREE.CircleGeometry(0.5, 10));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 1.15, 0, 3.95);
      model.add(e); this.engMeshes.push(e);
    }
    /* telegraphed muzzle: a ring that swells + brightens through the charge.
       Cached geometry (never disposed), per-instance material (animated). */
    this.chargeMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(1.4, 1.6, 0.5), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false });
    this.chargeMesh = new THREE.Mesh(
      ShipGeo.get('rep.ring', () => new THREE.TorusGeometry(0.52, 0.14, 6, 14)), this.chargeMat);
    this.chargeMesh.position.set(0, 0.2, -13.1);
    this.chargeMesh.visible = false;
    model.add(this.chargeMesh);
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  /* one fast heavy slug down the bore, leading the player's motion */
  _fireRail(tgt) {
    const E = V18.reaper;
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 7.2);   // muzzle = barrel tip
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const tGo = dist / E.boltSpeed;
    _v2.copy(tgt.pos).addScaledVector(tgt.vel, tGo * this.leadSkill).sub(_v4).normalize();
    Projectiles.fire('eheavy', 'enemy', _v4, _v2, { src: this, speed: E.boltSpeed, dmg: E.boltDmg, life: E.boltLife });
    FX.muzzle(_v4, true);
    G.audio.shotHeavy();
  }

  update(dt) {
    const E = V18.reaper;
    this.stateT += dt;
    this.updateFlash(dt);
    const tgt = G.player;
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const speed = E.speed * this.spdMult;

    // standoff band: back away inside min, close beyond max, else strafe
    if (dist < E.minRange) {
      _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(dist + 260).add(tgt.pos);
      this.steerToward(_v2, dt, speed, E.accel, 60);
    } else if (dist > E.maxRange) {
      this.steerToward(tgt.pos, dt, speed, E.accel, 60);
    } else {
      // lateral sinusoid — the same lead-jink idea as the fighter, softened
      _v2.copy(this.pos).sub(tgt.pos); _v2.y = 0;
      if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
      _v3.set(-_v2.z, 0, _v2.x).normalize()
         .multiplyScalar(Math.sin(this.stateT * 0.6 + this.jinkSeed) * 95).add(this.pos);
      this.steerToward(_v3, dt, speed * 0.6, E.accel * 0.6, 30);
    }
    this.faceTowards(tgt.pos, E.turn, dt);

    this.avoidGround(dt, 70);
    if (this.vel.length() > speed * 1.2) this.vel.setLength(speed * 1.2);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    this._glowT += dt;
    const gs = 0.9 + Math.sin(this._glowT * 11) * 0.12;
    for (const e of this.engMeshes) e.scale.setScalar(gs);

    // rail cycle: charge (glow telegraphs) → fire → cooldown
    this.fireT -= dt;
    if (!this.charging && this.fireT <= 0 && dist < E.maxRange * 1.6) {
      _v3.set(0, 0, -1).applyQuaternion(this.quat);
      _v2.copy(tgt.pos).sub(this.pos).normalize();
      if (_v3.dot(_v2) > 0.93) { this.charging = true; this.chargeT = E.chargeTime; }
    }
    if (this.charging) {
      this.chargeT -= dt;
      const p = U.clamp(1 - this.chargeT / E.chargeTime, 0, 1);
      this.chargeMesh.visible = true;
      this.chargeMesh.scale.setScalar(0.5 + p * 1.9);
      this.chargeMat.opacity = 0.15 + p * 0.85;
      this.chargeMat.color.setRGB(1.2 + p * 2.0, 1.5 + p * 1.6, 0.4 + p * 0.7);
      if (this.chargeT <= 0) {
        this.charging = false;
        this.chargeMesh.visible = false;
        this.fireT = U.rand(3, 4);
        this._fireRail(tgt);
      }
    }
    if (Math.random() < 0.4) this.enginePuff([1, 1, 0.35]);
  }
}

/* UPGRADE(content v1.8) — PROWLER: fast mine-layer skirmisher.
   FSM: in (close to the 500-700 band) → drop (hold the band, swing
   sideways, release a mine from the ventral bay) → flee (the player
   got inside 300: burn off to 900 and re-enter). Mine ammo trickles
   back one every 3s, capped at 2. A failsafe re-enters from any hold. */
class Prowler extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill) {
    super('prowler');
    const E = V18.prowler;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = E.size;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.leadSkill = leadSkill || 0.7;
    this.state = 'in';
    this.stateT = 0;
    this.latDir = Math.random() < 0.5 ? 1 : -1;
    this.fireT = U.rand(1.5, 3);
    this.dropT = U.rand(0.6, 1.4);
    this._minesLeft = 2;
    this._mineRegenT = 3;
    this._buildMesh();
  }

  /* angular dart, no wings: pointed forebody, small tail fins, twin small
     engines, and three mine canisters slung under the belly. */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x26242e, metalness: 0.84, roughness: 0.36, envMapIntensity: 1.15,
      emissive: 0xffa62e, emissiveIntensity: 0.3 });
    this.flashMats.push({ mat: hull, base: 0.3 });
    const trim = HULL.recess(0x14131a);
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.5, 0.4) }));
    const hullGeo = ShipGeo.get('pwl.hull', () => mergeGeos([
      HULL.box(0.95, 0.7, 2.6, [0, 0, 0.4]),
      HULL.cone(0.46, 1.6, 6, [0, 0, -1.6], [-Math.PI / 2, 0, 0], [1, 0.8, 1]),
      HULL.box(1.7, 0.2, 0.9, [0, -0.05, 1.3]),                    // small tail planes
      HULL.box(0.26, 0.7, 0.6, [0, 0.5, 1.4]),                     // dorsal spine
      /* ventral mine bay: three canisters */
      HULL.cyl(0.17, 0.17, 0.8, 6, [0, -0.52, 0.7], [Math.PI / 2, 0, 0]),
      HULL.cyl(0.17, 0.17, 0.8, 6, [0.34, -0.52, 0.7], [Math.PI / 2, 0, 0]),
      HULL.cyl(0.17, 0.17, 0.8, 6, [-0.34, -0.52, 0.7], [Math.PI / 2, 0, 0]),
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('pwl.trim', () => mergeGeos([
      HULL.sph(0.28, 7, [0, 0.32, -0.9], [0.7, 0.5, 1.3]),         // cockpit
      HULL.box(0.5, 0.14, 0.9, [0, -0.34, -0.6]),                  // chin stub
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('pwl.eng', () => new THREE.CircleGeometry(0.22, 8));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 0.34, 0, 1.72);
      model.add(e); this.engMeshes.push(e);
    }
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  /* light bolt — deflection shot, long-range plinking only */
  _fire(tgt) {
    const E = V18.prowler;
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 1.4);
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const tGo = dist / E.boltSpeed;
    _v2.copy(tgt.pos).addScaledVector(tgt.vel, tGo * this.leadSkill).sub(_v4).normalize();
    Projectiles.fire('ebolt', 'enemy', _v4, _v2, { src: this, speed: E.boltSpeed, dmg: E.boltDmg, life: E.boltLife });
    FX.muzzle(_v4, true);
    G.audio.shotBlaster(0.3);
  }

  /* drop one mine out of the ventral bay */
  _dropMine() {
    _v3.set(0, -1, 0).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 0.9);
    G.enemies.spawnMine(_v4);
    FX.rings.spawn(_v4, 5, 0xffa62e, 0.3);
  }

  update(dt) {
    const E = V18.prowler;
    this.stateT += dt;
    this.updateFlash(dt);
    const tgt = G.player;
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const speed = E.speed * this.spdMult;

    // mine ammo trickles back, capped at 2
    this._mineRegenT -= dt;
    if (this._mineRegenT <= 0) { this._mineRegenT = 3; if (this._minesLeft < 2) this._minesLeft++; }

    switch (this.state) {
      case 'in':
        this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        this.faceTowards(tgt.pos, E.turn, dt);
        if (dist < E.fleeRange) { this.state = 'flee'; this.stateT = 0; }
        else if (dist < E.nearRange) { this.state = 'drop'; this.stateT = 0; }
        break;
      case 'drop': {
        if (dist < E.fleeRange) { this.state = 'flee'; this.stateT = 0; break; }
        if (dist > E.farRange) {
          this.steerToward(tgt.pos, dt, speed, E.accel, 60);
        } else {
          _v2.copy(this.pos).sub(tgt.pos); _v2.y = 0;
          if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
          _v3.set(-_v2.z, 0, _v2.x).normalize().multiplyScalar(this.latDir * 55).add(this.pos);
          this.steerToward(_v3, dt, speed * 0.7, E.accel * 0.7, 30);
        }
        this.faceTowards(tgt.pos, E.turn, dt);
        this.dropT -= dt;
        if (this.dropT <= 0 && this._minesLeft > 0) {
          this._minesLeft--;
          this.dropT = U.rand(3.4, 4.6);
          this._dropMine();
        }
        if (this.stateT > 12) { this.state = 'in'; this.stateT = 0; }   // FSM failsafe
        break;
      }
      case 'flee':
        _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(E.fleeTo).add(tgt.pos);
        this.steerToward(_v2, dt, speed * 1.1, E.accel, 50);
        this.faceTowards(tgt.pos, E.turn * 0.6, dt);
        if (this.stateT > 2.2 || dist > E.fleeTo * 0.85) {
          this.latDir *= -1;
          this.state = 'in'; this.stateT = 0;
        }
        break;
    }

    this.avoidGround(dt, 70);
    if (this.vel.length() > speed * 1.35) this.vel.setLength(speed * 1.35);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    this._glowT += dt;
    const gs = 0.9 + Math.sin(this._glowT * 17) * 0.14;
    for (const e of this.engMeshes) e.scale.setScalar(gs);

    // long-range plink
    this.fireT -= dt;
    if (this.fireT <= 0 && dist > E.fleeRange && dist < E.fleeTo * 1.4 && this.state !== 'flee') {
      this.fireT = U.rand(1.4, 2.6);
      this._fire(tgt);
    }
    if (Math.random() < 0.55) this.enginePuff([1, 0.6, 0.15]);
  }
}

/* ============================================================
   UPGRADE(content v1.8.1) — STALKER / SAPPER / WARDEN
   ------------------------------------------------------------
   Three hostiles that change the SHAPE of a fight, in the same
   idiom as the v1.8 pair (stats in V18, spawner in the Enemies
   registry, per-instance materials, shared scratch vectors, the
   base-class damage/_die/dispose pipeline):
     STALKER — cloak sniper. Holds a 600-1000 band invisible,
               breaks cover on a 0.7s red aim-laser, puts one
               lead-aimed heavy slug into the player, then fades
               out again for the 1.6s cooldown.
     SAPPER  — standoff pod-layer. Sits at 500-800 and bolts
               turret pods onto the field; flees outward when the
               player closes inside 300.
     WARDEN  — support hull. Repairs other hostiles through a green
               beam; destroying it stops the fleet's repairs.
   ============================================================ */

/* STALKER — cloaked precision sniper. `this.cloaked` is public state
   (HUD/target logic reads it), so it stays a plain boolean, and the
   hull is damageable the whole cycle: the cloak is concealment, never
   invulnerability. Stealth fades its OWN materials (a shared material
   would dim the rest of the wave). It deliberately skips
   addEngineRims — that hardware rides the shared recess tier and would
   hang lit around an invisible ship. */
class Stalker extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill) {
    super('stalker');
    const E = V18.stalker;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = E.size;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.leadSkill = leadSkill || 0.7;
    this.state = 'cloak';        // cloak → telegraph → cool → cloak
    this.stateT = 0;
    this.jinkSeed = U.rand(0, 100);
    this.fireT = U.rand(2.5, 4);
    this.cloaked = true;
    this._cloak = 1;             // 1 = faded out, 0 = fully lit
    this._buildMesh();
  }

  /* slim angular sniper: pointed forebody, a long thin bore, small
     tail planes. All three lit tiers are per-instance so the whole
     silhouette can fade together. */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x1f2430, metalness: 0.84, roughness: 0.38, envMapIntensity: 1.15,
      emissive: 0xff3a3a, emissiveIntensity: 0.22, transparent: true, opacity: 1 });
    this.flashMats.push({ mat: hull, base: 0.22 });
    const trim = new THREE.MeshStandardMaterial({
      color: 0x13161d, metalness: 0.86, roughness: 0.42, envMapIntensity: 1.2,
      transparent: true, opacity: 1 });
    const glowMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.4, 0.6, 0.55), transparent: true, opacity: 1 });
    this._cloakMats = [{ mat: hull, base: 1 }, { mat: trim, base: 1 }, { mat: glowMat, base: 1 }];
    const hullGeo = ShipGeo.get('stk.hull', () => mergeGeos([
      HULL.box(0.9, 0.6, 2.4, [0, 0, 0.5]),                        // slim spine
      HULL.cone(0.5, 1.5, 6, [0, 0, -1.5], [-Math.PI / 2, 0, 0], [1, 0.85, 1]),
      HULL.cyl(0.16, 0.2, 5.2, 8, [0, 0.1, -3.4], [-Math.PI / 2, 0, 0]),   // long bore
      HULL.box(1.9, 0.14, 1.1, [0, -0.1, 1.1]),                    // tail planes
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('stk.trim', () => mergeGeos([
      HULL.sph(0.3, 7, [0, 0.3, -0.5], [0.7, 0.5, 1.4]),           // canopy
      HULL.box(0.5, 0.16, 1.0, [0, -0.36, -0.4]),                  // chin stub
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('stk.eng', () => new THREE.CircleGeometry(0.22, 8));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 0.28, 0, 1.55);
      model.add(e); this.engMeshes.push(e);
    }
    /* aim laser: a 1-unit box along local Z, scaled to the exact shot
       range while the muzzle is hot (per-instance material, animated) */
    this.laserMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.6, 0.15, 0.2), transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false });
    this.laser = new THREE.Mesh(
      ShipGeo.get('stk.laser', () => new THREE.BoxGeometry(0.05, 0.05, 1)), this.laserMat);
    this.laser.visible = false;
    model.add(this.laser);
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    dressHull(this);
    G.scene.add(g);
  }

  /* one lead-aimed heavy slug down the bore */
  _fire(tgt) {
    const E = V18.stalker;
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 3.4);   // muzzle = bore tip
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const tGo = dist / E.boltSpeed;
    _v2.copy(tgt.pos).addScaledVector(tgt.vel, tGo * this.leadSkill).sub(_v4).normalize();
    Projectiles.fire('eheavy', 'enemy', _v4, _v2, { src: this, speed: E.boltSpeed, dmg: E.boltDmg, life: E.boltLife });
    FX.muzzle(_v4, true);
    G.audio.shotHeavy();
  }

  update(dt) {
    const E = V18.stalker;
    this.stateT += dt;
    this.updateFlash(dt);
    const tgt = G.player;
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const speed = E.speed * this.spdMult;

    // band-keeping: refuse the brawl, drift sideways inside the ring
    if (dist < E.nearRange) {
      _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(dist + 240).add(tgt.pos);
      this.steerToward(_v2, dt, speed, E.accel, 60);
    } else if (dist > E.farRange) {
      this.steerToward(tgt.pos, dt, speed, E.accel, 60);
    } else {
      _v2.copy(this.pos).sub(tgt.pos); _v2.y = 0;
      if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
      _v3.set(-_v2.z, 0, _v2.x).normalize()
         .multiplyScalar(Math.sin(this.stateT * 0.7 + this.jinkSeed) * 80).add(this.pos);
      this.steerToward(_v3, dt, speed * 0.7, E.accel * 0.7, 30);
    }
    this.faceTowards(tgt.pos, E.turn, dt);
    this.avoidGround(dt, 70);
    if (this.vel.length() > speed * 1.3) this.vel.setLength(speed * 1.3);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    // stalk cycle: hold cover → telegraph → shot → 1.6s exposed
    switch (this.state) {
      case 'cloak':
        this.fireT -= dt;
        if (this.fireT <= 0 && dist < E.farRange * 1.4) { this.state = 'telegraph'; this.stateT = 0; }
        break;
      case 'telegraph': {
        const p = U.clamp(this.stateT / E.telegraph, 0, 1);
        this.laser.visible = true;
        this.laserMat.opacity = 0.12 + p * 0.45;
        this.laser.scale.z = dist;                          // the beam reaches the player
        this.laser.position.z = -(dist * 0.5) - this.radius * 0.5;
        if (this.stateT >= E.telegraph) {
          this.laser.visible = false;
          this._fire(tgt);
          this.state = 'cool'; this.stateT = 0;
        }
        break;
      }
      case 'cool':
        if (this.stateT >= E.cool) {
          this.state = 'cloak'; this.stateT = 0;
          this.fireT = U.rand(3, 4.6);
        }
        break;
    }
    this.cloaked = this.state === 'cloak';

    // fade to 12% opacity under cover, snap back fast when it breaks
    this._cloak = U.clamp(this._cloak + (this.cloaked ? 0.85 : -5) * dt, 0, 1);
    const op = 0.12 + 0.88 * (1 - this._cloak);
    for (const cm of this._cloakMats) cm.mat.opacity = cm.base * op;

    this._glowT += dt;
    const gs = 0.9 + Math.sin(this._glowT * 15) * 0.12;
    for (const e of this.engMeshes) e.scale.setScalar(gs);
    if (!this.cloaked && Math.random() < 0.4) this.enginePuff([1, 0.35, 0.3]);
  }
}

/* SAPPER — standoff pod-layer. Its damage comes from the field it
   builds, not from its gun: it bolts a turret pod onto the map every
   6-8s. Two safeguards hold the 2-pod ceiling — a charge budget
   (_podsLeft, one back every 9s, cap 2) and a scan of its own live
   pods — so a pod killed early can be replaced without ever letting
   a third one exist. */
class Sapper extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill) {
    super('sapper');
    const E = V18.sapper;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = E.size;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.leadSkill = leadSkill || 0.7;
    this.stateT = 0;
    this.jinkSeed = U.rand(0, 100);
    this.fireT = U.rand(1, 2.2);
    this.deployT = U.rand(2.5, 4.5);
    this._podsLeft = 2;
    this._podRegenT = 9;
    this._pods = [];             // Turret refs, for the alive-pod cap
    this._buildMesh();
  }

  /* boxy military layer: fat hull, two stacks of pod canisters and a
     dorsal launch rack. Amber accent = ordnance. */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x2b2a24, metalness: 0.82, roughness: 0.42, envMapIntensity: 1.15,
      emissive: 0xffa62e, emissiveIntensity: 0.24 });
    this.flashMats.push({ mat: hull, base: 0.24 });
    const trim = HULL.recess(0x181712);
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.5, 0.45) }));
    const hullGeo = ShipGeo.get('sap.hull', () => mergeGeos([
      HULL.box(2.4, 1.5, 4.0, [0, 0, 0.4]),                        // fat deployer hull
      HULL.cone(1.0, 1.6, 6, [0, 0, -2.1], [-Math.PI / 2, 0, 0], [1, 0.9, 1]),
      HULL.box(0.8, 0.7, 1.4, [1.7, -0.35, 0.3]),                  // pod stacks
      HULL.box(0.8, 0.7, 1.4, [-1.7, -0.35, 0.3]),
      HULL.cyl(0.26, 0.26, 1.0, 7, [0.9, 0.95, 0.6], [Math.PI / 2, 0, 0]),  // launch rails
      HULL.cyl(0.26, 0.26, 1.0, 7, [-0.9, 0.95, 0.6], [Math.PI / 2, 0, 0]),
      HULL.box(1.0, 0.9, 0.6, [0, -0.2, 2.2]),                     // stern hatch
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('sap.trim', () => mergeGeos([
      HULL.sph(0.4, 8, [0, 0.78, -0.7], [0.9, 0.6, 1.3]),          // bridge blister
      HULL.box(0.5, 0.45, 0.7, [0, 1.35, 0.5]),                    // gantry housing
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('sap.eng', () => new THREE.CircleGeometry(0.42, 10));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 1.0, 0, 2.42);
      model.add(e); this.engMeshes.push(e);
    }
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  /* weak plink — the pods are the threat, this is only pressure */
  _fire(tgt) {
    const E = V18.sapper;
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 1.6);
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const tGo = dist / E.boltSpeed;
    _v2.copy(tgt.pos).addScaledVector(tgt.vel, tGo * this.leadSkill).sub(_v4).normalize();
    Projectiles.fire('ebolt', 'enemy', _v4, _v2, { src: this, speed: E.boltSpeed, dmg: E.boltDmg, life: E.boltLife });
    FX.muzzle(_v4, true);
    G.audio.shotBlaster(0.32);
  }

  /* drop a turret pod on the field under/behind the hull */
  _deploy() {
    let live = 0;
    for (let i = 0; i < this._pods.length; i++) if (this._pods[i].alive) live++;
    if (live >= 2 || this._podsLeft <= 0) return;
    _v3.set(0, -0.7, 1).normalize().applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 3.2);
    const pod = G.enemies.spawnTurret(-1, null, _v4);   // (-1, null, worldPos) = fixed mount
    pod.active = true;                                  // deployed pods are live, not wave-2 dormant
    this._podsLeft--;
    this._pods.push(pod);
    FX.rings.spawn(_v4, 6, 0xffa62e, 0.35);
    G.audio.lockBeep(true);
  }

  update(dt) {
    const E = V18.sapper;
    this.stateT += dt;
    this.updateFlash(dt);
    const tgt = G.player;
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const speed = E.speed * this.spdMult;

    // pod charges trickle back one at a time
    this._podRegenT -= dt;
    if (this._podRegenT <= 0) { this._podRegenT = 9; if (this._podsLeft < 2) this._podsLeft++; }

    // range-keeping: flee outward inside 300, then hold the 500-800 band
    if (dist < E.fleeRange) {
      _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(E.fleeTo).add(tgt.pos);
      this.steerToward(_v2, dt, speed * 1.15, E.accel, 50);
    } else if (dist < E.nearRange) {
      _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(dist + 260).add(tgt.pos);
      this.steerToward(_v2, dt, speed, E.accel, 60);
    } else if (dist > E.farRange) {
      this.steerToward(tgt.pos, dt, speed, E.accel, 60);
    } else {
      _v2.copy(this.pos).sub(tgt.pos); _v2.y = 0;
      if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
      _v3.set(-_v2.z, 0, _v2.x).normalize()
         .multiplyScalar(Math.sin(this.stateT * 0.5 + this.jinkSeed) * 70).add(this.pos);
      this.steerToward(_v3, dt, speed * 0.65, E.accel * 0.65, 30);
    }
    this.faceTowards(tgt.pos, E.turn, dt);
    this.avoidGround(dt, 70);
    if (this.vel.length() > speed * 1.3) this.vel.setLength(speed * 1.3);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    // deployment timer — skipped while it's running from the player
    this.deployT -= dt;
    if (this.deployT <= 0) {
      this.deployT = U.rand(6, 8);
      if (dist > E.fleeRange) this._deploy();
    }

    // weak plink
    this.fireT -= dt;
    if (this.fireT <= 0 && dist > E.fleeRange && dist < E.farRange * 1.5) {
      this.fireT = U.rand(1.1, 2);
      this._fire(tgt);
    }

    this._glowT += dt;
    const gs = 0.9 + Math.sin(this._glowT * 13) * 0.12;
    for (const e of this.engMeshes) e.scale.setScalar(gs);
    if (Math.random() < 0.5) this.enginePuff([1, 0.7, 0.2]);
  }
}

/* WARDEN — support hull. Every 0.5s it retargets the nearest OTHER
   damaged hostile inside 500u and pours 6 hull/s down a green beam;
   the beam is visible only while a repair is actually in flight. It
   hangs back at ~800u and plinks, so the fight is "kill the Warden or
   watch the wave heal" — and its death says so on the HUD. */
class Warden extends Enemy {
  constructor(pos, hpMult, spdMult, leadSkill) {
    super('warden');
    const E = V18.warden;
    this.pos.copy(pos);
    this.hp = this.maxHp = E.hp * (hpMult || 1);
    this.radius = E.radius;
    this.size = E.size;
    this.scoreVal = E.score;
    this.dropChance = E.dropChance;
    this.waveEnemy = true;
    this.spdMult = spdMult || 1;
    this.leadSkill = leadSkill || 0.7;
    this.stateT = 0;
    this.healT = 0;
    this.fireT = U.rand(1, 2.4);
    this._healTarget = null;
    this._buildMesh();
  }

  /* broad tender hull: wide spine, outrigger repair arms and a
     dorsal emitter dish. Green accent = support. */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x22322a, metalness: 0.8, roughness: 0.4, envMapIntensity: 1.15,
      emissive: 0x46ff9a, emissiveIntensity: 0.22 });
    this.flashMats.push({ mat: hull, base: 0.22 });
    const trim = HULL.recess(0x131f18);
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 2.4, 1.2) }));
    const hullGeo = ShipGeo.get('wrd.hull', () => mergeGeos([
      HULL.box(3.4, 1.7, 5.2, [0, 0, 0.6]),                        // wide spine
      HULL.cone(1.3, 2.0, 6, [0, 0, -3.0], [-Math.PI / 2, 0, 0], [1, 0.9, 1]),
      HULL.box(1.2, 1.0, 2.4, [2.4, -0.2, 0.4]),                   // repair outriggers
      HULL.box(1.2, 1.0, 2.4, [-2.4, -0.2, 0.4]),
      HULL.cyl(0.4, 0.4, 1.6, 8, [0, 1.1, 0.8]),                   // emitter pedestal
      HULL.cyl(0.75, 0.75, 0.2, 10, [0, 1.95, 0.8]),               // dish
      HULL.box(1.4, 0.8, 1.0, [0, -0.15, 3.2]),                    // stern block
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('wrd.trim', () => mergeGeos([
      HULL.sph(0.5, 8, [0, 0.85, -1.4], [0.9, 0.6, 1.3]),          // canopy
      HULL.box(0.5, 0.5, 1.2, [2.4, 0.7, 0.4]),                    // arm housings
      HULL.box(0.5, 0.5, 1.2, [-2.4, 0.7, 0.4]),
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('wrd.eng', () => new THREE.CircleGeometry(0.5, 10));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 1.35, 0, 3.05);
      model.add(e); this.engMeshes.push(e);
    }
    /* the repair beam: one cached open tube, rotated so its axis runs
       local Z (scale.z = length). It is parented to the SCENE, not the
       ship — the two ends are independent hulls and every frame the
       mesh is parked at their midpoint and aimed down the join. */
    this.beamMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.35, 2.4, 0.7), transparent: true, opacity: 0.26,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.beam = new THREE.Mesh(
      ShipGeo.get('wrd.beam', () => {
        const b = new THREE.CylinderGeometry(0.16, 0.16, 1, 6, 1, true);
        b.rotateX(Math.PI / 2);
        return b;
      }), this.beamMat);
    this.beam.visible = false;
    G.scene.add(this.beam);
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  /* weak plink */
  _fire(tgt) {
    const E = V18.warden;
    _v3.set(0, 0, -1).applyQuaternion(this.quat);
    _v4.copy(this.pos).addScaledVector(_v3, this.radius + 1.6);
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const tGo = dist / E.boltSpeed;
    _v2.copy(tgt.pos).addScaledVector(tgt.vel, tGo * this.leadSkill).sub(_v4).normalize();
    Projectiles.fire('ebolt', 'enemy', _v4, _v2, { src: this, speed: E.boltSpeed, dmg: E.boltDmg, life: E.boltLife });
    FX.muzzle(_v4, true);
    G.audio.shotBlaster(0.3);
  }

  /* the nearest other hostile that is actually hurt */
  _pickHealTarget() {
    const E = V18.warden;
    let best = null, bestD = E.healRange * E.healRange;
    for (const e of G.enemies.list) {
      if (e === this || !e.alive || e.hp >= e.maxHp) continue;
      const dd = e.pos.distanceToSquared(this.pos);
      if (dd < bestD) { bestD = dd; best = e; }
    }
    this._healTarget = best;
  }

  /* drive the beam from this hull to the patient: position at the
     midpoint, aim down the join, scale to the gap */
  _updateBeam(dt) {
    if (!this.beam) return;
    const E = V18.warden;
    const t = this._healTarget;
    const ok = !!t && t.alive && t.hp < t.maxHp &&
      t.pos.distanceToSquared(this.pos) < E.healRange * E.healRange;
    if (!ok) { this._healTarget = null; this.beam.visible = false; return; }
    t.hp = Math.min(t.maxHp, t.hp + E.healPerSec * dt);
    _v3.copy(t.pos).sub(this.pos);
    const len = _v3.length();
    if (len < 1e-3) { this.beam.visible = false; return; }
    _v3.multiplyScalar(1 / len);
    this.beam.position.copy(this.pos).addScaledVector(_v3, len * 0.5);
    _m1.lookAt(_ORIGIN, _v3, UP);
    this.beam.quaternion.setFromRotationMatrix(_m1);
    this.beam.scale.set(1, 1, len);
    this.beam.visible = true;
    this.beamMat.opacity = 0.2 + 0.16 * Math.sin(this.stateT * 12);
  }

  update(dt) {
    const E = V18.warden;
    this.stateT += dt;
    this.updateFlash(dt);
    const tgt = G.player;
    const dist = _v1.copy(tgt.pos).sub(this.pos).length();
    const speed = E.speed * this.spdMult;

    // hangs back: back off inside the standoff, close beyond it, else strafe
    if (dist < E.standoff * 0.8) {
      _v2.copy(this.pos).sub(tgt.pos).normalize().multiplyScalar(dist + 320).add(tgt.pos);
      this.steerToward(_v2, dt, speed, E.accel, 60);
    } else if (dist > E.standoff * 1.3) {
      this.steerToward(tgt.pos, dt, speed, E.accel, 60);
    } else {
      _v2.copy(this.pos).sub(tgt.pos); _v2.y = 0;
      if (_v2.lengthSq() < 1e-4) _v2.set(1, 0, 0);
      _v3.set(-_v2.z, 0, _v2.x).normalize()
         .multiplyScalar(Math.sin(this.stateT * 0.45 + 1.7) * 80).add(this.pos);
      this.steerToward(_v3, dt, speed * 0.6, E.accel * 0.6, 30);
    }
    this.faceTowards(tgt.pos, E.turn, dt);
    this.avoidGround(dt, 70);
    if (this.vel.length() > speed * 1.25) this.vel.setLength(speed * 1.25);
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);
    this.mesh.quaternion.copy(this.quat);

    // repair cycle: retarget twice a second, run the beam every frame
    this.healT -= dt;
    if (this.healT <= 0) { this.healT = 0.5; this._pickHealTarget(); }
    this._updateBeam(dt);

    this.fireT -= dt;
    if (this.fireT <= 0) {
      this.fireT = U.rand(1.1, 2.2);
      if (dist > 200) this._fire(tgt);
    }

    this._glowT += dt;
    const gs = 0.9 + Math.sin(this._glowT * 12) * 0.12;
    for (const e of this.engMeshes) e.scale.setScalar(gs);
    if (Math.random() < 0.5) this.enginePuff([0.5, 1, 0.7]);
  }

  /* the fleet's only repair source: losing it is a HUD event */
  _die() {
    if (this.beam) this.beam.visible = false;
    G.hud.alert('WARDEN DOWN — ENEMY REPAIRS STOPPED', 2);
    super._die();
  }

  dispose() {
    if (this.beam) { G.scene.remove(this.beam); this.beam = null; }
    if (this.beamMat && this.beamMat.dispose) this.beamMat.dispose();
    super.dispose();
  }
}

/* UPGRADE(content v1.8) — WASP WING: four fast interceptor drones.
   Same group/per-drone shape as HornetWing, but lighter and quicker,
   leaning toward the nearest hostile and punching 3-round volleys
   instead of single pecks. Blue-green accent = friendly. */
class WaspWing {
  constructor(pos, count) {
    this.count = count || 4;
    this.drones = [];
    this.pos = pos.clone();
    this._cen = new THREE.Vector3();
    this.hp = this.maxHp = this.count * 50;
    for (let i = 0; i < this.count; i++) this.drones.push(this._make(pos, i));
    this.alive = true;
  }

  _make(pos, i) {
    const a = (i / this.count) * U.TAU;
    const d = {
      pos: pos.clone().add(new THREE.Vector3(Math.cos(a) * 16, 4, Math.sin(a) * 16)),
      vel: new THREE.Vector3(),
      aim: new THREE.Vector3(),
      hp: 50, maxHp: 50,
      alive: true,
      orbitA: a,
      fireT: U.rand(0.4, 1.2),
      burstN: 0, burstT: 0,
      mesh: null,
    };
    const g = new THREE.Group();
    /* wasp silhouette: twin tapered bodies with a thin stinger nose */
    const hull = new THREE.MeshStandardMaterial({
      color: 0x213a2c, metalness: 0.8, roughness: 0.34,
      emissive: 0x46ff9a, emissiveIntensity: 0.5 });
    const bodyGeo = ShipGeo.get('wsp.body', () => mergeGeos([
      HULL.cone(0.2, 0.85, 6, [0.17, 0, -0.25], [-Math.PI / 2, 0, 0]),
      HULL.cone(0.2, 0.85, 6, [-0.17, 0, -0.25], [-Math.PI / 2, 0, 0]),
      HULL.cyl(0.14, 0.22, 0.95, 6, [0.17, 0, 0.55], [-Math.PI / 2, 0, 0]),
      HULL.cyl(0.14, 0.22, 0.95, 6, [-0.17, 0, 0.55], [-Math.PI / 2, 0, 0]),
      HULL.cyl(0.03, 0.05, 1.5, 5, [0, 0, -1.35], [-Math.PI / 2, 0, 0]),   // stinger
      HULL.box(1.05, 0.05, 0.4, [0, 0.05, 0.35]),                          // wing stubs
    ]));
    g.add(new THREE.Mesh(bodyGeo, hull));
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 2.4, 1.3) }));
    const engGeo = ShipGeo.get('wsp.eng', () => new THREE.CircleGeometry(0.11, 7));
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 0.17, 0, 1.06);
      g.add(e);
    }
    d.mesh = g;
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
    return d;
  }

  update(dt) {
    if (!this.alive) return;
    const p = G.player;
    let anyAlive = false, n = 0, hpSum = 0, hpMax = 0;
    this._cen.set(0, 0, 0);
    for (const d of this.drones) {
      if (!d.alive) continue;
      anyAlive = true; n++;
      hpSum += d.hp; hpMax += d.maxHp;
      // nearest hostile in reach — wasps pick their own fights
      let best = null, bestD = 700 * 700;
      for (const e of G.enemies.list) {
        if (!e.alive) continue;
        const dd = e.pos.distanceToSquared(d.pos);
        if (dd < bestD) { bestD = dd; best = e; }
      }
      // tight fast orbit around the player, wider when engaging
      d.orbitA += 2.2 * dt;
      const r = best ? 22 : 14;
      _v1.set(Math.cos(d.orbitA) * r, 5 + Math.sin(d.orbitA * 1.6) * 3, Math.sin(d.orbitA) * r)
         .applyQuaternion(p.quat).add(p.pos);
      _v2.copy(_v1).sub(d.pos);
      _v2.multiplyScalar(4.2);                       // stiffer spring than hornets
      _v2.sub(d.vel);
      if (_v2.length() > 95) _v2.setLength(95);
      d.vel.addScaledVector(_v2, dt);
      d.pos.addScaledVector(d.vel, dt);
      d.mesh.position.copy(d.pos);
      // face the target (or the flight vector when idle)
      if (best) d.aim.copy(best.pos).sub(d.pos);
      else d.aim.copy(d.vel);
      if (d.aim.lengthSq() > 1e-6) {
        _m1.lookAt(_ORIGIN, d.aim, UP);
        d.mesh.quaternion.setFromRotationMatrix(_m1);
      }
      // 3-round volley
      if (!best) d.burstN = 0;
      d.fireT -= dt;
      if (d.fireT <= 0 && best) { d.fireT = U.rand(1.1, 1.7); d.burstN = 3; }
      if (d.burstN > 0) {
        d.burstT -= dt;
        if (d.burstT <= 0 && best) {
          d.burstT = 0.09;
          d.burstN--;
          _v2.copy(best.pos).sub(d.pos).normalize();
          Projectiles.fire('bolt', 'player', d.pos, _v2, { speed: 780, dmg: 4, life: 1.3, noStats: true });
          G.audio.shotBlaster(0.18);
        }
      }
      this._cen.add(d.pos);
    }
    this.hp = hpSum; this.maxHp = hpMax || 1;
    if (n) this.pos.copy(this._cen.multiplyScalar(1 / n));
    this.alive = anyAlive;
  }

  dispose() {
    for (const d of this.drones) if (d.mesh) G.scene.remove(d.mesh);
    this.drones.length = 0;
    this.alive = false;
  }
}

/* UPGRADE(content v1.8) — SALVAGE TUG: unarmed repair craft.
   Holds a perch behind/above the player on a soft spring, faces them,
   and runs a green beam down its nose that patches +3 hull/s inside
   200u. Its only offence is a weak 1/s plink at whatever is nearest. */
class SalvageTug {
  constructor(pos) {
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this._aim = new THREE.Vector3();
    this.hp = this.maxHp = 140;
    this.radius = 4;
    this.alive = true;
    this.flash = 0;
    this.fireT = U.rand(0.5, 1.5);
    this._buildMesh();
  }

  /* boxy utility tug: work pods on outriggers, a grapple claw, and a
     dorsal emitter housing. Green accent = friendly support. */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x233a30, metalness: 0.76, roughness: 0.44,
      emissive: 0x39ff88, emissiveIntensity: 0.2 });
    this.hullMat = hull;
    const trim = HULL.recess(0x14231b);
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.45, 2.4, 1.2) }));
    const hullGeo = ShipGeo.get('tug.hull', () => mergeGeos([
      HULL.box(1.9, 1.3, 3.6, [0, 0, 0.4]),
      HULL.cone(0.9, 1.6, 6, [0, 0, -2.0], [-Math.PI / 2, 0, 0], [1, 0.9, 1]),
      HULL.box(1.1, 1.0, 1.8, [1.6, 0.1, 0.5]),                    // work pods
      HULL.box(1.1, 1.0, 1.8, [-1.6, 0.1, 0.5]),
      HULL.box(2.4, 0.3, 0.6, [0, 0.4, 0.2]),                      // cross brace
      HULL.cyl(0.14, 0.14, 1.4, 6, [0, -0.9, -1.2]),               // grapple arm
      HULL.cyl(0.32, 0.12, 0.6, 6, [0, -1.7, -1.2]),               // claw
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('tug.trim', () => mergeGeos([
      HULL.sph(0.34, 8, [0, 0.75, -0.6], [0.8, 0.6, 1.4]),         // canopy
      HULL.cyl(0.3, 0.42, 0.7, 8, [0, 0.95, 0.9]),                 // emitter housing
      HULL.cyl(0.55, 0.55, 0.16, 10, [0, 1.35, 0.9]),              // emitter dish
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('tug.eng', () => new THREE.CircleGeometry(0.34, 10));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 1.6, 0.1, 1.5);
      model.add(e); this.engMeshes.push(e);
    }
    /* the repair beam: a thin additive tube down the nose (a cylinder's
       axis runs local Y, so a quarter-turn about X lines it up with Z) */
    this.beamMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(0.4, 2.4, 1.2), transparent: true, opacity: 0.25,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.beam = new THREE.Mesh(
      ShipGeo.get('tug.beam', () => new THREE.CylinderGeometry(0.16, 0.16, 170, 7, 1, true)), this.beamMat);
    this.beam.rotation.x = Math.PI / 2;
    this.beam.position.set(0, 0, -86);
    this.beam.visible = false;
    model.add(this.beam);
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  update(dt) {
    if (!this.alive) { this.mesh.visible = false; return; }
    const p = G.player;
    this._glowT += dt;
    this.flash = Math.max(0, this.flash - 4 * dt);
    if (this.hullMat) this.hullMat.emissiveIntensity = 0.2 + this.flash * 2.5;

    // soft spring onto a perch behind/above the player (100-160 u)
    _v1.set(0.7, 0.55, 1).normalize().multiplyScalar(130).applyQuaternion(p.quat).add(p.pos);
    _v2.copy(_v1).sub(this.pos);
    const d = _v2.length();
    if (d > 1) {
      _v2.multiplyScalar(Math.min(d, 80) / d * 1.9);
      _v2.sub(this.vel);
      if (_v2.length() > 26) _v2.setLength(26);
      this.vel.addScaledVector(_v2, dt);
    }
    this.vel.multiplyScalar(Math.exp(-1.3 * dt));
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);

    // face the player — the beam runs down the nose
    this._aim.copy(p.pos).sub(this.pos);
    if (this._aim.lengthSq() > 1e-6) {
      _m1.lookAt(_ORIGIN, this._aim, UP);
      this.quat.setFromRotationMatrix(_m1);
    }
    this.mesh.quaternion.copy(this.quat);

    // repair beam + hull trickle when the player is in reach
    const inReach = p.alive && p.pos.distanceToSquared(this.pos) < 200 * 200;
    this.beam.visible = inReach;
    if (inReach) {
      this.beamMat.opacity = 0.16 + 0.14 * Math.sin(this._glowT * 9);
      p.hull = Math.min(p.maxHull || CFG.combat.hull, p.hull + 3 * dt);
    }

    // engine flicker
    const gs = 0.9 + Math.sin(this._glowT * 14) * 0.12;
    for (const e of this.engMeshes) e.scale.setScalar(gs);

    // weak plink at the nearest hostile, roughly once a second
    this.fireT -= dt;
    if (this.fireT <= 0) {
      let best = null, bestD = 620 * 620;
      for (const e of G.enemies.list) {
        if (!e.alive) continue;
        const dd = e.pos.distanceToSquared(this.pos);
        if (dd < bestD) { bestD = dd; best = e; }
      }
      if (best) {
        this.fireT = 1.0;
        _v3.set(0, 0, -1).applyQuaternion(this.quat);
        _v4.copy(this.pos).addScaledVector(_v3, this.radius + 1.4);
        _v2.copy(best.pos).sub(_v4).normalize();
        Projectiles.fire('bolt', 'player', _v4, _v2, { speed: 620, dmg: 4, life: 1.4, noStats: true });
        G.audio.shotBlaster(0.22);
      } else {
        this.fireT = 0.3;
      }
    }
  }

  damage(dmg) {
    if (!this.alive || dmg <= 0) return;
    this.hp -= dmg;
    this.flash = 1;
    if (this.hp <= 0) {
      this.alive = false;
      FX.explosion(this.pos, 7);
      G.audio.explosion(0.7);
      G.hud.alert('SALVAGE TUG LOST', 2.5);
      this.dispose();
    }
  }

  dispose() {
    if (this.mesh) { G.scene.remove(this.mesh); this.mesh = null; }
    this.alive = false;
  }
}

/* ============================================================
   UPGRADE(content v1.8.1) — SPOTTER / SWEEPER
   ------------------------------------------------------------
   Two small friendly utility craft with the same contract as
   WaspWing / SalvageTug: the game only ever calls update(dt) and
   dispose(), and damage is whatever the instance chooses to model.
     SPOTTER — orbits at ~140u and paints the nearest hostile for
               the wing (e.designated, an amber marker over the
               hull), plinking in 3-round bursts while it works.
     SWEEPER — hunts mines down, closes to contact range and cracks
               them, claiming the blast so it can't hurt the player
               it just cleared the lane for.
   ============================================================ */

/* SPOTTER — target designator. Grepped the codebase first: there is
   no cross-file marking API (no Enemies.markTarget, no Enemy.designated
   producer), so the whole designation lives inside this class — the
   target carries `e.designated` in seconds, this instance owns the
   marker mesh over its hull and does the decay itself. */
class Spotter {
  constructor(pos) {
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this._aim = new THREE.Vector3();
    this.hp = this.maxHp = 90;
    this.radius = 3;
    this.alive = true;
    this.orbitA = U.rand(0, U.TAU);
    this.markT = U.rand(0.4, 1.2);
    this.fireT = U.rand(0.6, 1.4);
    this.burstN = 0;
    this.burstT = 0;
    this._marked = null;
    this._buildMesh();
  }

  /* spindly sensor craft: narrow hull, wide sensor vanes and a dish
     mast. Amber accent = the designator. */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x2a3326, metalness: 0.78, roughness: 0.4,
      emissive: 0xffc25a, emissiveIntensity: 0.3 });
    const trim = HULL.recess(0x1a1d14);
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(2.4, 1.8, 0.5) }));
    const hullGeo = ShipGeo.get('spt.hull', () => mergeGeos([
      HULL.box(0.7, 0.5, 1.9, [0, 0, 0.2]),
      HULL.cone(0.34, 1.1, 6, [0, 0, -1.15], [-Math.PI / 2, 0, 0], [1, 0.85, 1]),
      HULL.box(1.5, 0.1, 0.7, [0, 0.15, 0.5]),                     // sensor vanes
      HULL.box(0.3, 0.4, 0.5, [0, 0.35, -0.1]),                    // mast base
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('spt.trim', () => mergeGeos([
      HULL.sph(0.24, 7, [0, 0.22, -0.3], [0.8, 0.5, 1.3]),         // canopy
      HULL.cyl(0.08, 0.08, 1.0, 5, [0, 0.75, -0.1]),               // sensor mast
      HULL.cyl(0.3, 0.3, 0.08, 8, [0, 1.3, -0.1], [Math.PI / 3, 0, 0]),   // dish
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('spt.eng', () => new THREE.CircleGeometry(0.16, 8));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 0.22, 0, 1.2);
      model.add(e); this.engMeshes.push(e);
    }
    /* the designation marker: a small additive amber bipyramid parked
       over whatever this spotter painted. World space, own material. */
    this.markMat = new THREE.MeshBasicMaterial({
      color: new THREE.Color(2.6, 1.7, 0.3), transparent: true, opacity: 0.8,
      blending: THREE.AdditiveBlending, depthWrite: false });
    this.mark = new THREE.Mesh(
      ShipGeo.get('spt.mark', () => new THREE.OctahedronGeometry(0.9, 0)), this.markMat);
    this.mark.visible = false;
    G.scene.add(this.mark);
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  _nearestEnemy(maxD) {
    let best = null, bestD = maxD * maxD;
    for (const e of G.enemies.list) {
      if (!e.alive) continue;
      const dd = e.pos.distanceToSquared(this.pos);
      if (dd < bestD) { bestD = dd; best = e; }
    }
    return best;
  }

  update(dt) {
    if (!this.alive) { this.mesh.visible = false; this.mark.visible = false; return; }
    const p = G.player;
    this._glowT += dt;

    // orbit ~140u over the player's shoulder
    this.orbitA += 0.7 * dt;
    _v1.set(Math.cos(this.orbitA) * 140, 35 + Math.sin(this.orbitA * 0.8) * 18, Math.sin(this.orbitA) * 140)
       .applyQuaternion(p.quat).add(p.pos);
    _v2.copy(_v1).sub(this.pos);
    _v2.multiplyScalar(2.4);
    _v2.sub(this.vel);
    if (_v2.length() > 85) _v2.setLength(85);
    this.vel.addScaledVector(_v2, dt);
    this.vel.multiplyScalar(Math.exp(-0.8 * dt));
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);

    // designation: re-pick the nearest hostile in reach every 1.5s
    const near = this._nearestEnemy(900);
    this.markT -= dt;
    if (this.markT <= 0) {
      this.markT = 1.5;
      if (this._marked && this._marked !== near) this._marked.designated = 0;
      this._marked = near;
      if (near) near.designated = 2.0;      // seconds of paint; this class owns the decay
    }
    // own the decay + hang the marker over the painted hull
    const m = this._marked;
    if (m && m.alive && m.designated > 0) {
      m.designated = Math.max(0, m.designated - dt);
      this.mark.visible = true;
      this.mark.position.copy(m.pos);
      this.mark.position.y += m.radius * 1.4 + 5;
      this.mark.rotation.y += 2.4 * dt;
      this.markMat.opacity = 0.5 + 0.3 * Math.sin(this._glowT * 9);
    } else {
      this.mark.visible = false;
    }

    // face the painted target, or the player when the scope is empty
    this._aim.copy(m && m.alive ? m.pos : p.pos).sub(this.pos);
    if (this._aim.lengthSq() > 1e-6) {
      _m1.lookAt(_ORIGIN, this._aim, UP);
      this.quat.setFromRotationMatrix(_m1);
    }
    this.mesh.quaternion.copy(this.quat);

    // weak 3-round burst at whatever it can see
    const tgt = this._nearestEnemy(700);
    if (!tgt) this.burstN = 0;
    this.fireT -= dt;
    if (this.fireT <= 0 && tgt) { this.fireT = U.rand(1.6, 2.4); this.burstN = 3; }
    if (this.burstN > 0) {
      this.burstT -= dt;
      if (this.burstT <= 0 && tgt) {
        this.burstT = 0.12;
        this.burstN--;
        _v3.set(0, 0, -1).applyQuaternion(this.quat);
        _v4.copy(this.pos).addScaledVector(_v3, this.radius + 1.2);
        _v2.copy(tgt.pos).sub(_v4).normalize();
        Projectiles.fire('bolt', 'player', _v4, _v2, { speed: 820, dmg: 3, life: 1.3, noStats: true });
        G.audio.shotBlaster(0.16);
      }
    }

    const gs = 0.9 + Math.sin(this._glowT * 15) * 0.12;
    for (const e of this.engMeshes) e.scale.setScalar(gs);
  }

  dispose() {
    if (this._marked) { this._marked.designated = 0; this._marked = null; }
    if (this.mark) { G.scene.remove(this.mark); this.mark = null; }
    if (this.markMat && this.markMat.dispose) this.markMat.dispose();
    if (this.mesh) { G.scene.remove(this.mesh); this.mesh = null; }
    this.alive = false;
  }
}

/* SWEEPER — mine hunter. Flies the enemy list for live mines first
   (700u sweep), chases the nearest one down and cracks it inside 40u
   by calling its damage() directly — flagged as a PLAYER kill so the
   detonation can't clip the player the lane was cleared for. With no
   mine in reach it plinks the nearest hostile, and with no target at
   all it holds station off the player's shoulder. */
class Sweeper {
  constructor(pos) {
    this.pos = pos.clone();
    this.vel = new THREE.Vector3();
    this.quat = new THREE.Quaternion();
    this._aim = new THREE.Vector3();
    this.hp = this.maxHp = 110;
    this.radius = 3.5;
    this.alive = true;
    this.fireT = U.rand(0.4, 1.2);
    this.homeA = U.rand(0, U.TAU);
    this._buildMesh();
  }

  /* stubby utility drone: fat hull, a mine-cracker jaw on the nose and
     two sweeper booms. Blue-green accent = friendly. */
  _buildMesh() {
    const g = new THREE.Group();
    const model = new THREE.Group();
    g.add(model);
    const hull = new THREE.MeshStandardMaterial({
      color: 0x243530, metalness: 0.78, roughness: 0.44,
      emissive: 0x46d0c0, emissiveIntensity: 0.26 });
    const trim = HULL.recess(0x152120);
    const glowMat = shared(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 2.2, 2.0) }));
    const hullGeo = ShipGeo.get('swp.hull', () => mergeGeos([
      HULL.box(1.5, 1.1, 2.8, [0, 0, 0.3]),
      HULL.box(0.6, 0.6, 0.9, [0, -0.1, -1.7]),                    // cracker jaw
      HULL.box(1.9, 0.16, 0.5, [0, 0.55, -0.2]),                   // sweeper booms
      HULL.box(0.35, 0.5, 0.5, [0.85, 0.35, 0.9]),
      HULL.box(0.35, 0.5, 0.5, [-0.85, 0.35, 0.9]),
    ]));
    model.add(new THREE.Mesh(hullGeo, hull));
    const trimGeo = ShipGeo.get('swp.trim', () => mergeGeos([
      HULL.sph(0.32, 8, [0, 0.6, -0.5], [0.8, 0.6, 1.3]),          // canopy
      HULL.cyl(0.12, 0.12, 0.6, 6, [0, -0.5, -1.7], [Math.PI / 2, 0, 0]),  // jaw pin
    ]));
    model.add(new THREE.Mesh(trimGeo, trim));
    const engGeo = ShipGeo.get('swp.eng', () => new THREE.CircleGeometry(0.3, 9));
    this.engMeshes = [];
    for (const s of [-1, 1]) {
      const e = new THREE.Mesh(engGeo, glowMat);
      e.position.set(s * 0.55, 0, 1.75);
      model.add(e); this.engMeshes.push(e);
    }
    g.position.copy(this.pos);
    this.mesh = g; this.model = model;
    this._glowT = U.rand(0, 10);
    if (this.engMeshes) addEngineRims(this.model || g, this.engMeshes, HULL.recess(), this.type || 'x');
    dressHull(this);
    G.scene.add(g);
  }

  update(dt) {
    if (!this.alive) { this.mesh.visible = false; return; }
    const p = G.player;
    this._glowT += dt;

    // mines first: closest live one inside the sweep radius
    let mine = null, mD = 700 * 700;
    let foe = null, fD = 800 * 800;
    for (const e of G.enemies.list) {
      if (!e.alive) continue;
      const dd = e.pos.distanceToSquared(this.pos);
      if (e.type === 'mine') { if (dd < mD) { mD = dd; mine = e; } }
      else if (dd < fD) { fD = dd; foe = e; }
    }
    const tgt = mine || foe;

    if (tgt) {
      // hold ~18u off a mine's flank, ~90u off a warship
      _v1.copy(this.pos).sub(tgt.pos);
      const d = Math.max(_v1.length(), 1e-3);
      const hold = tgt.type === 'mine' ? 18 : 90;
      _v2.copy(tgt.pos).addScaledVector(_v1, hold / d);
      _v2.sub(this.pos).multiplyScalar(2.2);
      _v2.sub(this.vel);
      if (_v2.length() > 90) _v2.setLength(90);
      this.vel.addScaledVector(_v2, dt);
    } else {
      // nothing to hunt: hold station off the player's shoulder
      this.homeA += 0.6 * dt;
      _v1.set(Math.cos(this.homeA) * 170, 40 + Math.sin(this.homeA * 0.7) * 16, Math.sin(this.homeA) * 170)
         .applyQuaternion(p.quat).add(p.pos);
      _v2.copy(_v1).sub(this.pos).multiplyScalar(2.2);
      _v2.sub(this.vel);
      if (_v2.length() > 80) _v2.setLength(80);
      this.vel.addScaledVector(_v2, dt);
    }
    this.vel.multiplyScalar(Math.exp(-1.0 * dt));
    this.pos.addScaledVector(this.vel, dt);
    this.mesh.position.copy(this.pos);

    this._aim.copy(tgt ? tgt.pos : p.pos).sub(this.pos);
    if (this._aim.lengthSq() > 1e-6) {
      _m1.lookAt(_ORIGIN, this._aim, UP);
      this.quat.setFromRotationMatrix(_m1);
    }
    this.mesh.quaternion.copy(this.quat);

    // contact crack: inside 40u of a mine, pop it (as a player kill, so
    // the blast the sweeper is standing in doesn't clip the player)
    if (mine && mine.pos.distanceToSquared(this.pos) < 40 * 40) {
      FX.rings.spawn(mine.pos, 6, 0xffd25a, 0.3);
      if (mine.damage(mine.hp, null, null, true)) G.hud.alert('SWEEPER: MINE CLEARED', 1.5);
    } else if (tgt) {
      this.fireT -= dt;
      if (this.fireT <= 0) {
        this.fireT = 0.8;
        _v3.set(0, 0, -1).applyQuaternion(this.quat);
        _v4.copy(this.pos).addScaledVector(_v3, this.radius + 1.2);
        _v2.copy(tgt.pos).sub(_v4).normalize();
        Projectiles.fire('bolt', 'player', _v4, _v2, { speed: 760, dmg: 5, life: 1.3, noStats: true });
        G.audio.shotBlaster(0.2);
      }
    }

    const gs = 0.9 + Math.sin(this._glowT * 14) * 0.12;
    for (const e of this.engMeshes) e.scale.setScalar(gs);
  }

  dispose() {
    if (this.mesh) { G.scene.remove(this.mesh); this.mesh = null; }
    this.alive = false;
  }
}
