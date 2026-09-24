/* ============================================================
   GAME.JS — orchestration
   ------------------------------------------------------------
   LOAD ORDER: last. Contains: wave director, top-level Game
   object, HUD, Campaign (phases/maps flow), Cheats console, the
   G registry, environment builder, boot() + main loop.
   Split from the old files — logic untouched.
============================================================ */

const Waves = {
  wave: 0,
  state: 'idle',           // idle | lull | active
  lullT: 0,
  queue: [],
  waveT: 0,
  objective: null,
  ally: null,
  boss: null,
  mapMode: null,           // CAMPAIGN: active Adventure map config (see Campaign._startMap)

  reset() {
    this.wave = 0;
    this.state = 'lull';
    this.lullT = 2.5;
    this.queue.length = 0;
    this.objective = null;
    if (this.ally) { this.ally.dispose(); this.ally = null; }
    if (this.lancerAlly) { this.lancerAlly.dispose(); this.lancerAlly = null; }
    if (this.hornets) { this.hornets.dispose(); this.hornets = null; }
    if (this.aegis) { this.aegis.dispose(); this.aegis = null; }
    Wingmen.clear();
    this.boss = null;
    this.mapMode = null;
    G.hud.setObjective(null);
  },

  aegis: null,      // support frigate (slows nearby enemies)

  escortActive() { return !!(this.objective && this.objective.kind === 'escort'
    && this.objective.state === 'active' && this.ally && this.ally.alive); },

  startWave(n) {
    this.wave = n;
    this.state = 'active';
    this.waveT = 0;
    this._completedWave = n - 1;   // completion-guard anchor (see _waveComplete)
    this.queue.length = 0;
    const W = CFG.waves;
    const MM = this.mapMode;   // CAMPAIGN: null = classic endless behavior

    /* CAMPAIGN: in an Adventure map, the map's wave sequence ends in a
       boss wave (map.waves normal waves, then the dreadnought — killing
       it gates progression to the next map). */
    const isBoss = MM ? (n > MM.waves) : (n % W.bossEvery === 0);
    if (isBoss) {
      G.hud.banner(MM ? 'FINAL WAVE' : 'WAVE ' + n, 'CAPITAL SIGNATURE DETECTED', 'bad');
      G.audio.alarm();
      // boss + a light escort screen (spawned close — at its speed cap the
      // dreadnought would otherwise take a minute to reach firing range)
      Enemies._ringPos(_v1, 750, 950, 0.8);
      // UPGRADE(content): map bosses pick their named variant (map order);
      // endless keeps the classic violet Kharybdis.
      const vIdx = MM ? (MM.mapIdx + 1) : 0;
      this.boss = new Boss(_v1, n, MM ? MM.bossMult : 1, vIdx);
      G.enemies.list.push(this.boss);
      for (let i = 0; i < 2; i++) {
        const f = G.enemies.spawnFighter({ hpMult: 1.1, spdMult: 1.15, leadSkill: 0.85 });
        f._bossEscort = true;
      }
      const bossName = this.boss.variant ? this.boss.variant.name : 'DREADNOUGHT KHARYBDIS';
      G.hud.setBossName(bossName);
      G.hud.alert(bossName + ' INBOUND', 4);
      if (MM) G.hud.setObjective('DESTROY THE ' +
        (this.boss.archetype === 'carrier' ? 'CARRIER'
          : this.boss.archetype === 'fortress' ? 'FORTRESS'
          : this.boss.archetype === 'singularity' ? 'SIEGE PLATFORM'
          : 'DREADNOUGHT'));
    } else {
      G.hud.banner(MM ? ('MAP WAVE ' + n + '/' + MM.waves) : 'WAVE ' + n, 'HOSTILES INBOUND', '');
      G.audio.waveHorn();
      if (MM) G.hud.setObjective('CLEAR THE SECTOR — WAVE ' + n + ' OF ' + MM.waves);
    }

    // ---- composition (see CFG.waves for the tuning knobs) ----
    if (!isBoss) {
      if (MM) {
        /* CAMPAIGN: composition rolls from the map's weighted spawn table
           (biased toward its signature enemy types) with the map's tuned
           hp / speed multipliers and elite chance. Same spawner, same
           queue-drain loop below — purely data-driven, no forked logic. */
        const count = 5 + (n - 1) * 2 + MM.mapIdx * 2;
        const hpMult = MM.hpMult * (1 + (n - 1) * W.hpGrowth);
        const spdMult = MM.spdMult;
        const leadSkill = Math.min(0.6 + (n + MM.mapIdx) * 0.05, 1);
        let t = 1.2;
        for (let i = 0; i < count; i++) {
          const type = U.pickWeighted(MM.weights);
          const elite = (type === 'fighter' || type === 'gunship') && Math.random() < MM.eliteChance;
          this.queue.push({ type, t, opts: { hpMult, spdMult, leadSkill, elite } });
          t += U.rand(0.5, 1.1);
        }
      } else {
      const fighters = Math.min(W.baseFighters + (n - 1) * W.fighterGrowth, W.fighterCap);
      const gunships = n < W.gunshipStart ? 0 : Math.min(1 + Math.floor((n - W.gunshipStart) / 2), W.gunshipCap);
      const mines = n < W.mineStart ? 0 : Math.min(2 + Math.floor(n / 3), 8);
      // UPGRADE(content): bombers from wave 4 (ramping), drone packs from wave 3,
      // ravagers from wave 5, one sentinel support platform from wave 6,
      // an interdictor from wave 7 (the "you're not going anywhere" check)
      const bombers = n < 4 ? 0 : Math.min(1 + Math.floor((n - 4) / 3), 4);
      const drones = n < 3 ? 0 : Math.min(3 + n, 14);
      const ravagers = n < 5 ? 0 : Math.min(1 + Math.floor((n - 5) / 3), 3);
      const sentinels = n < 6 ? 0 : 1;
      const interdictors = n < 7 ? 0 : (n % 3 === 0 ? 2 : 1);
      // stat ramp per wave
      const hpMult = 1 + (n - 1) * W.hpGrowth;
      const spdMult = Math.min(1 + (n - 1) * W.speedGrowth, W.speedCap);
      const leadSkill = Math.min(0.55 + (n - 1) * W.leadGrowth, 1.0);

      let t = 1.2;
      for (let i = 0; i < fighters; i++) {
        this.queue.push({ type: 'fighter', t, opts: { hpMult, spdMult, leadSkill } });
        t += U.rand(0.5, 1.1);
      }
      t += 2;
      for (let i = 0; i < gunships; i++) {
        this.queue.push({ type: 'gunship', t, opts: { hpMult, spdMult, leadSkill } });
        t += U.rand(1.5, 3);
      }
      for (let i = 0; i < bombers; i++) {
        this.queue.push({ type: 'bomber', t: U.rand(3, 10), opts: { hpMult, spdMult, leadSkill } });
      }
      for (let i = 0; i < ravagers; i++) {
        this.queue.push({ type: 'ravager', t: U.rand(4, 12), opts: { hpMult, spdMult, leadSkill } });
      }
      for (let i = 0; i < sentinels; i++) {
        this.queue.push({ type: 'sentinel', t: U.rand(6, 14), opts: { hpMult, spdMult, leadSkill } });
      }
      for (let i = 0; i < interdictors; i++) {
        this.queue.push({ type: 'interdictor', t: U.rand(8, 16), opts: { hpMult, spdMult, leadSkill } });
      }
      // drones arrive as a rapid pack
      if (drones > 0) {
        let dt2 = U.rand(6, 14);
        for (let i = 0; i < drones; i++) {
          this.queue.push({ type: 'drone', t: dt2, opts: {} });
          dt2 += U.rand(0.25, 0.6);
        }
      }
      for (let i = 0; i < mines; i++) {
        this.queue.push({ type: 'mine', t: U.rand(4, 14), opts: {} });
      }
      }
    }

    // turrets wake up from wave 2 (wave 1 is the tutorial)
    if (n >= 2) G.enemies.activateTurrets();

    // ---- secondary objective roll (endless only — map waves keep a clean
    //       objective line for the sector progress) ----
    if (!MM && !isBoss && n >= 3 && Math.random() < W.escortChance) {
      const kind = U.pick(['hvt', 'escort', 'onslaught', 'vanguard', 'aegis']);
      if (kind === 'hvt') {
        const hvt = G.enemies.spawnGunship({ hpMult: CFG.enemies.elite.hpMult, spdMult: 1.15, leadSkill: 0.9, elite: true });
        this.objective = { kind, state: 'active', hvt };
        G.hud.setObjective('SECONDARY — ELIMINATE THE PRIZE SHIP  [+BONUS]');
      } else if (kind === 'vanguard') {
        Wingmen.spawn(2 + ((Math.random() * 2) | 0));
        this.objective = { kind, state: 'active' };
        G.hud.setObjective('RED WING JOINED — FIGHT TOGETHER');
      } else if (kind === 'aegis') {
        Enemies._ringPos(_v1, 240, 400, 0.5);
        this.aegis = new Aegis(_v1);
        this.objective = { kind, state: 'active' };
        G.hud.setObjective('AEGIS FRIGATE ON STATION — ENEMY ENGINES DAMPENED');
      } else if (kind === 'escort') {
        Enemies._ringPos(_v1, 260, 420, 0.5);
        this.ally = new Ally(_v1);
        /* UPGRADE(allies): the BULWARK gun-platform hangs back and lays
           down suppressive fire while the TESSA drifts — escort missions
           now feel defended instead of merely timed. */
        if (!this.lancerAlly) {
          Enemies._ringPos(_v2, 200, 340, 0.5);
          this.lancerAlly = new LancerAlly(_v2);
        }
        this.objective = { kind, state: 'active' };
        G.hud.setObjective('SECONDARY — PROTECT THE CORVETTE TESSA');
      } else {
        this.objective = { kind, state: 'active', timer: 45 };
        G.hud.setObjective('SECONDARY — SURVIVE THE ONSLAUGHT');
      }
    } else {
      this.objective = null;
      G.hud.setObjective(null);
    }
    G.hud.refreshWave();
  },

  /* called from the kill pipeline for objective bookkeeping */
  notifyKill(e) {
    const o = this.objective;
    if (!o || o.state !== 'active') return;
    if (o.kind === 'hvt' && e === o.hvt) {
      o.state = 'done';
      G.game.addScore(1500, e.pos, 'TARGET ELIMINATED');
      G.hud.setObjective('SECONDARY COMPLETE — PRIZE SHIP DOWN  [+1500]');
      G.pickups.spawnRandom(e.pos); G.pickups.spawnRandom(e.pos);
    }
  },

  allyDestroyed() {
    const o = this.objective;
    if (o && o.kind === 'escort' && o.state === 'active') {
      o.state = 'failed';
      G.hud.setObjective('SECONDARY FAILED — TESSA LOST');
      G.hud.banner('CORVETTE LOST', 'THE TESSA HAS BEEN DESTROYED', 'bad');
    }
  },

  /* named allies live outside the wave lifecycle — one update path for
     lull and active (ally/aegis exist only mid-wave, so the null checks
     hold during the lull) */
  _updateAllies(dt) {
    if (this.ally && this.ally.alive) this.ally.update(dt);
    if (this.lancerAlly) this.lancerAlly.update(dt);
    if (this.hornets) this.hornets.update(dt);
    if (this.aegis) this.aegis.update(dt);
    Wingmen.update(dt);
  },

  update(dt) {
    if (this.state === 'lull') {
      this._updateAllies(dt);
      this.lullT -= dt;
      if (this.lullT <= 0) this.startWave(this.wave + 1);
      return;
    }
    if (this.state !== 'active') return;
    this.waveT += dt;

    /* ---- drain the spawn queue, trickling under the caps ---- */
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const q = this.queue[i];
      if (q.t > this.waveT) continue;
      const alive = G.enemies.countWaveAlive();
      if (alive >= CFG.waves.concurrentCap && q.type !== 'mine') continue; // hold reinforcement
      if (q.type === 'fighter') G.enemies.spawnFighter(q.opts);
      else if (q.type === 'gunship') G.enemies.spawnGunship(q.opts);
      else if (q.type === 'bomber') G.enemies.spawnBomber(q.opts);
      else if (q.type === 'drone') G.enemies.spawnDrone(q.opts);
      else if (q.type === 'ravager') G.enemies.spawnRavager(q.opts);
      else if (q.type === 'sentinel') G.enemies.spawnSentinel(q.opts);
      else if (q.type === 'interdictor') G.enemies.spawnInterdictor(q.opts);
      else if (q.type === 'interceptor') G.enemies.spawnInterceptor(q.opts);
      else if (q.type === 'hive') G.enemies.spawnHive(q.opts);
      else if (q.type === 'mine') G.enemies.spawnMine();
      this.queue.splice(i, 1);
    }

    /* ---- onslaught trickle ---- */
    const o = this.objective;
    if (o && o.kind === 'onslaught' && o.state === 'active') {
      o.timer -= dt;
      G.hud.updateObjectiveTimer(o.timer);
      if (Math.random() < dt * 0.35 && G.enemies.countAlive('fighter') < 10) {
        G.enemies.spawnFighter({ hpMult: 1 + this.wave * 0.03, spdMult: 1.1, leadSkill: 0.9 });
      }
      if (o.timer <= 0) {
        o.state = 'done';
        G.game.addScore(1200, G.player.pos, 'ONSLAUGHT SURVIVED  [+1200]');
        G.hud.setObjective('SECONDARY COMPLETE — ONSLAUGHT SURVIVED  [+1200]');
      }
    }

    this._updateAllies(dt);

    /* ---- clear check: queue empty, no live wave enemies, boss fully down.
       A dying dreadnought blocks the clear until its final detonation; an
       active onslaught blocks so its trickle can't be cut off. ---- */
    const bossBlocking = !!(this.boss && (this.boss.alive || !this.boss._finalBoom));
    const onslaughtActive = !!(o && o.kind === 'onslaught' && o.state === 'active');
    if (this.queue.length === 0 && G.enemies.countWaveAlive() === 0 &&
        !bossBlocking && !onslaughtActive) {
      // escort resolves HERE (alive at clear = success)
      if (o && o.kind === 'escort' && o.state === 'active' && this.ally && this.ally.alive) {
        o.state = 'done';
        G.game.addScore(1500, this.ally.pos, 'TESSA PROTECTED  [+1500]');
        G.hud.setObjective('SECONDARY COMPLETE — TESSA PROTECTED  [+1500]');
      }
      this._waveComplete();
    }
  },

  _waveComplete() {
    const W = CFG.waves;
    const wasBossWave = !!this.boss;
    const MM = this.mapMode;
    // one completion per wave — a straggler dying in the same tick as a
    // mid-wave skip re-enters the clear check
    if (this._completedWave === this.wave) return;
    this._completedWave = this.wave;
    const bonus = W.waveBonus + (this.wave - 1) * W.waveBonusGrowth;
    G.game.addScore(bonus, G.player.pos, '');
    // small between-wave mercy: patch the hull, top up seekers
    G.player.hull = Math.min(G.player.maxHull || CFG.combat.hull, G.player.hull + W.waveHullRepair);
    G.player.missileAmmo = Math.min(CFG.weapons.seeker.ammoMax,
      G.player.missileAmmo + CFG.weapons.seeker.restock);
    G.hud.banner('WAVE ' + this.wave + ' CLEARED', 'BONUS +' + U.fmt(bonus) +
      (this.boss ? ' — SECTOR HELD' : ''), 'gold');
    G.audio.waveHorn();
    // clear the ally from the world between waves
    if (this.ally) { this.ally.dispose(); this.ally = null; }
    if (this.aegis) { this.aegis.dispose(); this.aegis = null; }
    Wingmen.patchBetweenWaves();
    this.boss = null;
    if (MM && wasBossWave) {
      /* CAMPAIGN: the map's dreadnought is down and its death sequence has
         finished — the sector is cleared; the phase manager advances to
         the next map (or victory). */
      this.state = 'idle';
      this.mapMode = null;   // FIX: forget the map BEFORE onMapCleared mutates state
      G.campaign.onMapCleared();
      return;
    }
    this.state = 'lull';
    this.lullT = W.lull;
    G.hud.refreshWave();
  },
};

/* ============================================================
   [SECTION 14] GAME — state machine, score/combo, kill pipeline
   ------------------------------------------------------------
   COMBO RULES: every kill without taking damage adds +0.25x (cap
   8x). Taking ANY damage slams it back to 1x. Idling 12s also
   decays it — aggression is the only sustainable strategy.
============================================================ */
const Game = {
  state: 'boot',             // boot | menu | playing | paused | over
  mode: 'endless',           // CAMPAIGN: 'endless' | 'adventure' (survives restart)
  shipSel: CFG.chassisDefault,   // v1.6 chassis key (CFG.chassis); __VL.ship() swaps mid-run
  score: 0, displayScore: 0, best: 0, bestMap: 0,
  combo: 1, comboT: 0, maxCombo: 1,
  kills: 0, elapsed: 0,
  timeScale: 1, slowT: 0,
  menuT: 0,
  _victory: false,           // CAMPAIGN: adventure completed flag

  loadBest() {
    try { this.best = parseInt(localStorage.getItem('voidlancer_best') || '0', 10) || 0; }
    catch (e) { this.best = 0; }
    try { this.bestMap = parseInt(localStorage.getItem('voidlancer_bestmap') || '0', 10) || 0; }
    catch (e) { this.bestMap = 0; }
  },
  saveBest() {
    if (this.score > this.best) {
      this.best = Math.floor(this.score);
      try { localStorage.setItem('voidlancer_best', String(this.best)); } catch (e) {}
    }
  },
  /* CAMPAIGN: "best map reached" readout for adventure runs — same
     localStorage pattern as the best score, nothing else persisted. */
  saveBestMap(m) {
    if (m > this.bestMap) {
      this.bestMap = m;
      try { localStorage.setItem('voidlancer_bestmap', String(m)); } catch (e) {}
    }
  },

  /* ---------- lifecycle ---------- */
  startRun(mode) {
    if (mode) this.mode = mode;   // no arg = relaunch same mode ([R])
    this.shipSel = CFG.chassisDefault;   // every run launches on the default chassis
    G.player.reset();
    G.camRig.reset();
    G.world.asteroids.reset();   // FIX: revive rocks BEFORE turrets pick hosts
    G.enemies.clear();           // CAMPAIGN: no arena turrets until phase 3 —
                                 // the scripted phases spawn their own attackers
    G.projectiles.reset();
    G.pickups.reset();
    G.FX.clear();
    G.world.dust.recenter(G.player.pos);
    this.score = 0; this.displayScore = 0;
    this.combo = 1; this.comboT = 0; this.maxCombo = 1;
    this.kills = 0; this.elapsed = 0;
    this.timeScale = 1; this.slowT = 0;
    this._victory = false;
    this._podLost = false;      // CAMPAIGN: pod-destroyed game-over framing
    G.waves.reset();
    G.waves.state = 'idle';      // CAMPAIGN: phases own spawning until the arena
    G.input.recenterCursor();
    G.hud.reset();
    this.state = 'playing';
    G.hud.showScreen(null);
    G.campaign.beginRun(this.mode);   // banner + phase 1 setup
  },

  pause() {
    if (this.state !== 'playing') return;
    this.state = 'paused';
    G.hud.showScreen('pause');
    G.audio.engineSet(0, false);
  },
  resume() {
    if (this.state !== 'paused') return;
    // FIX: pausing during the post-death window then resuming left the game
    // running with a dead player and no game-over screen forever (the
    // setTimeout in onPlayerDeath skips non-playing states).
    if (G.player && !G.player.alive) { this.gameOver(); return; }
    this.state = 'playing';
    G.hud.showScreen(null);
    G.input.requestLock();
  },

  onPlayerDeath() {
    this.slowMo(0.25, 2.0);
    setTimeout(() => { if (G.game.state === 'playing' || G.game.state === 'over') this.gameOver(); }, 2300);
  },

  gameOver() {
    if (this.state === 'over') return;
    // FIX: decide "new best" BEFORE saveBest() bumps this.best — the old
    // HUD check compared score against the ALREADY-updated best, so every
    // run with score > 0 displayed "NEW BEST".
    this._newBest = this.score > this.best;
    this.state = 'over';
    this.saveBest();
    G.input.releaseLock();
    G.hud.showGameOver();
  },

  /* CAMPAIGN: back to the mode-select screen (button + [B] on game over). */
  toMenu() {
    this.state = 'menu';
    G.campaign.teardown();
    G.hud.showScreen('start');
    G.hud.refreshBest();
    G.hud.setCockpit(false);
    G.input.releaseLock();
    G.audio.engineSet(0, false);
  },

  /* ---------- slow motion (boss kills, player death) ---------- */
  slowMo(scale, dur) { this.timeScale = scale; this.slowT = dur; },

  /* ---------- score & combo ---------- */
  addScore(base, pos, label) {
    const gained = Math.round(base * this.combo);
    this.score += gained;
    if (pos && label) G.hud.pop(pos, label, 'gold');
    else if (pos && gained >= 25) G.hud.pop(pos, '+' + U.fmt(gained), '');
  },

  registerKill() {
    this.combo = Math.min(CFG.score.comboMax, this.combo + CFG.score.comboStep);
    this.comboT = CFG.score.comboTimeout;
    this.maxCombo = Math.max(this.maxCombo, this.combo);
    G.hud.comboPop();
    G.audio.combo();
  },

  notifyPlayerDamaged() {
    if (this.combo > 1.01) {
      this.combo = 1;
      G.hud.comboLost();
    }
    this.comboT = 0;
  },

  /* ---------- THE kill pipeline (single funnel for everything) ----------
     v1.5: explosion TIERING + a death STAGGER beat. Small fry pop as
     'small'; gunship-class and up read as 'medium'/'large'. Before the
     main blast, the wreck flings 3 tumbling hull chunks (the "death
     stagger") and the main explosion is queued ~0.16s later — kills
     read as a two-beat event instead of an instant pop. */
  onEnemyKilled(e) {
    if (e._killProcessed) return;
    e._killProcessed = true;
    if (e.type !== 'boss') {
      const tier = e.size >= 7 ? 'large' : e.size >= 4.5 ? 'medium' : 'small';
      // stagger beat: tumbling wreck chunks flung out at death
      const chunks = Math.min(4, 2 + ((e.size * 0.3) | 0));
      for (let i = 0; i < chunks; i++) {
        U.randomDir(_v2).multiplyScalar(U.rand(8, 22));
        FX.debris.spawn(e.pos, _v2, e.radius * U.rand(0.3, 0.6), U.rand(0.9, 1.5));
      }
      FX.hit(e.pos, 8);
      // main blast arrives a beat later (see FX._queue cook-off system)
      FX._queue.push({ t: 0.16, x: e.pos.x, y: e.pos.y, z: e.pos.z, size: 0 });
      const dist = G.camera.position.distanceTo(e.pos);
      const prox = U.clamp(1 - dist / 500, 0.15, 1);
      FX.addTrauma(0.1 * prox);
      G.audio.explosion(e.size);
    }
    this.kills++;
    this.registerKill();
    this.addScore(e.scoreVal, e.pos, '');
    if (e.dropChance > 0 && Math.random() < e.dropChance) G.pickups.spawnRandom(e.pos);
    G.waves.notifyKill(e);
  },

  /* ---------- per-frame ---------- */
  update(dtRaw) {
    // slow-mo: hold, then ease back to 1x
    if (this.slowT > 0) this.slowT -= dtRaw;
    else this.timeScale = U.damp(this.timeScale, 1, 3, dtRaw);
    const dt = dtRaw * this.timeScale;

    if (this.state === 'menu') {
      this.menuT += dtRaw;
      // slow advertising orbit around the spawn point
      const a = this.menuT * 0.06;
      G.camera.position.set(Math.cos(a) * 150, 45 + Math.sin(a * 0.7) * 20, Math.sin(a) * 150);
      G.camera.lookAt(0, 6, 0);   // FIX: was lookAt(0,0,-200) — the player ship sat off-center in the menu
      G.camera.fov = 62; G.camera.updateProjectionMatrix();
      G.world.update(dt, G.camera.position);
      G.FX.update(dt);
      return;
    }

    if (this.state === 'playing' || this.state === 'over') {
      this.elapsed += dt;
      // combo decay when nothing dies for a while
      if (this.comboT > 0) {
        this.comboT -= dt;
        if (this.comboT <= 0 && this.combo > 1) { this.combo = 1; }
      }
      G.player.update(dt);
      G.enemies.update(dt);
      if (this.state === 'playing') {
        G.waves.update(dt);
        G.campaign.update(dt);   // CAMPAIGN: phase scheduling + corridor
      }
      G.projectiles.update(dt);
      G.pickups.update(dt);
      G.world.update(dt, G.player.pos);
      G.camRig.update(dt, dtRaw);
      G.FX.update(dt);
      G.hud.update(dt);
      G.audio.engineSet(G.player.thrust01, G.player.boosting);
    }
  },
};



/* ============================================================================
   [SECTION 15] HUD — bars, radar, lock-on, banners, screens
   ------------------------------------------------------------
   All DOM. Position-critical elements (reticle, lock box, popups)
   move via CSS transform only — no layout thrash. The radar is a
   small 2D canvas redrawn every frame (~60 blips = trivial).
   Radar math: enemy offset is rotated into the SHIP'S local frame
   so "up" on the scope is always where the nose points:
       local = worldOffset ⊗ quat⁻¹
       scope.x =  local.x,  scope.up = -local.z,  altitude = local.y
============================================================ */
const HUD = {
  alertT: 0, redFlash: 0, blueFlash: 0, whiteFlash: 0,
  sweep: 0, _popupIdx: 0,

  init() {
    const el = (id) => document.getElementById(id);
    this.el = {
      hud: el('hud'),
      vigRed: el('vig-red'), vigBlue: el('vig-blue'), flashWhite: el('flash-white'),
      shieldFill: el('bar-shield-fill'), shieldNum: el('shield-num'),
      hullFill: el('bar-hull-fill'), hullNum: el('hull-num'),
      boostFill: el('bar-boost-fill'),
      objWrap: el('obj-wrap'), objText: el('obj-text'), objBar: el('obj-bar'),
      objFill: el('obj-fill'), objTimer: el('obj-timer'),
      scoreVal: el('score-val'), comboVal: el('combo-val'), comboFill: el('combo-fill'),
      waveVal: el('wave-val'), bestVal: el('best-val'),
      alertLine: el('alert-line'),
      bossBar: el('boss-bar'), bossName: el('boss-name'), bossFill: el('boss-fill'),
      wpPips: el('wp-pips'),
      banner: el('banner'), bannerMain: el('banner-main'), bannerSub: el('banner-sub'),
      reticle: el('reticle'), chargeRing: el('charge-ring'),
      lockbox: el('lockbox'), lockName: el('lock-name'), lockFill: el('lock-fill'),
      // 9-slot battery (blaster/lance/pulse/seekers/swarm/rail/arc/shard/vmines)
      slots: [el('slot-0'), el('slot-1'), el('slot-2'), el('slot-3'), el('slot-4'), el('slot-5'),
              el('slot-6'), el('slot-7'), el('slot-8')],
      overdriveChip: el('overdrive-chip'),
      // ability cooldown chips (V flares / B nova / N blink / G overdrive)
      skillFlare: el('skill-flare'), skillFlareFill: el('skill-flare-fill'),
      skillNova: el('skill-nova'), skillNovaFill: el('skill-nova-fill'),
      skillBlink: el('skill-blink'), skillBlinkFill: el('skill-blink-fill'),
      skillOD: el('skill-od'), skillODFill: el('skill-od-fill'),
      upgScreen: el('screen-upgrade'), upgRow: el('upg-row'),
      // v1.5: multi-lock tag markers (DOM pool, mirrors Player.lockTags)
      tagWrap: el('lock-tags'),
      radar: el('radar'), popups: el('popups'), indicators: el('indicators'),
      hitmarker: el('hitmarker'),
      statsPanel: el('stats-panel'), fade: el('fade'),
      screens: { start: el('screen-start'), pause: el('screen-pause'), over: el('screen-over'), error: el('screen-error'), upgrade: el('screen-upgrade') },
      overStats: el('over-stats'), startBest: el('start-best'), errorMsg: el('error-msg'),
      overTitle: el('over-title'),
    };
    this.radarCtx = this.el.radar.getContext('2d');

    // popup pool (round-robin — old ones get recycled mid-flight, which
    // reads as "too much happening" and is exactly the vibe we want)
    this.popPool = [];
    for (let i = 0; i < 14; i++) {
      const d = document.createElement('div');
      d.className = 'popup';
      this.el.popups.appendChild(d);
      this.popPool.push(d);
    }
    // offscreen indicator pool: [boss, hvt, ally] + one spare
    this.indPool = [];
    for (let i = 0; i < 4; i++) {
      const d = document.createElement('div');
      d.className = 'ind';
      d.innerHTML = '<div class="arrow"></div><div class="tag"></div>';
      d.style.display = 'none';
      this.el.indicators.appendChild(d);
      this.indPool.push(d);
    }
    // boss weak-point pips (re-built per boss: pipParts varies by archetype)
    this.pips = [];
    for (let i = 0; i < 4; i++) {
      const p = document.createElement('div');
      p.className = 'pip';
      this.el.wpPips.appendChild(p);
      this.pips.push(p);
    }
    // multi-lock tag markers: 6 small DOM boxes repositioned per frame
    this.tagPool = [];
    for (let i = 0; i < 6; i++) {
      const t = document.createElement('div');
      t.className = 'tagbox';
      t.innerHTML = '<span></span>';
      t.style.display = 'none';
      this.el.tagWrap.appendChild(t);
      this.tagPool.push(t);
    }
    this._hitT = 0;
    this.el.bestVal.textContent = U.fmt(G.game.best);
    this.el.startBest.textContent = 'BEST SCORE  ' + U.fmt(G.game.best);
  },

  /* ---------- one-shot UI events ---------- */
  banner(main, sub, cls) {
    const b = this.el.banner;
    this.el.bannerMain.textContent = main;
    this.el.bannerSub.textContent = sub || '';
    b.className = cls || '';
    void b.offsetWidth;              // restart the CSS animation
    b.classList.add('show');
  },

  /* CAMPAIGN: cockpit instrument-panel layout toggle (fp / turret views) */
  setCockpit(on) { this.el.hud.classList.toggle('fp', !!on); },

  /* CAMPAIGN: phase-correct fade cut (banner + black dip in one) */
  fadeCut() {
    this.el.fade.classList.add('on');
  },
  fadeBack() {
    this.el.fade.classList.remove('on');
  },

  bossBanner(text) { this.alert(text, 2.5, '#e6c6ff'); },

  /* named boss variants swap the boss bar label */
  setBossName(name) { this.el.bossName.textContent = name; },

  /* the map-refit CHOICE screen (between maps). Presents 3 pool options with
     category + desc + what bolts onto the hull. */
  showUpgradeChoice(offers, onPick) {
    this._upgCb = onPick;
    this.el.upgRow.innerHTML = '';
    const catColor = { firepower: '#ff9a5a', armor: '#58ff9b', mobility: '#5fe8ff', utility: '#d9a8ff' };
    for (const u of offers) {
      const b = document.createElement('button');
      b.className = 'upg-btn';
      b.innerHTML =
        '<div class="upg-cat" style="color:' + (catColor[u.cat] || '#5fe8ff') + '">' + u.cat.toUpperCase() + '</div>' +
        '<div class="upg-name">' + u.name + '</div>' +
        '<div class="upg-desc">' + u.desc + '</div>' +
        '<div class="upg-vis">HULL REFIT: ' + u.visual.toUpperCase() + ' MOUNTED</div>';
      b.addEventListener('click', () => { G.audio.ui(); onPick(u.id); });
      this.el.upgRow.appendChild(b);
    }
    this.el.upgScreen.classList.remove('hidden');
  },
  hideUpgradeChoice() {
    this.el.upgScreen.classList.add('hidden');
    this._upgCb = null;
  },

  alert(text, dur, color) {
    this.el.alertLine.textContent = text;
    this.el.alertLine.style.color = color || '';
    this.alertT = Math.max(this.alertT, dur || 1);
  },

  setObjective(text) {
    if (!text) { this.el.objWrap.classList.add('hidden'); return; }
    this.el.objWrap.classList.remove('hidden');
    this.el.objText.textContent = text;
  },

  updateObjectiveTimer(t) {
    this.el.objTimer.classList.remove('hidden');
    this.el.objTimer.textContent = 'SURVIVE  ' + Math.max(0, Math.ceil(t)) + 's';
    if (t <= 0) this.el.objTimer.classList.add('hidden');
  },

  announceUpgrade(label) {
    this.alert('REFIT FITTED — ' + label, 2.6, '#b0ffd8');
  },

  /* CAMPAIGN: generic objective progress bar (pod integrity / ascent
     progress) — reuses the existing secondary-objective bar element. */
  setObjectiveBar(frac, color) {
    this.el.objBar.classList.remove('hidden');
    this.el.objFill.style.width = (U.clamp(frac, 0, 1) * 100) + '%';
    this.el.objFill.style.background = color || '';
  },

  pop(worldPos, text, cls) {
    const d = this.popPool[this._popupIdx++ % this.popPool.length];
    const s = { x: 0, y: 0 };
    if (!worldToScreen(worldPos, s)) return;
    d.textContent = text;
    d.className = 'popup ' + (cls || '');
    d.style.left = s.x + 'px';
    d.style.top = s.y + 'px';
    void d.offsetWidth;
    d.classList.add('go');
  },

  comboPop() {
    const c = this.el.comboVal;
    c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop');
    c.classList.remove('lost');
  },
  comboLost() {
    this.el.comboVal.classList.add('lost');
    this.alert('COMBO LOST', 1.2, '#ff4d6a');
  },

  flashRed(i) { this.redFlash = Math.min(1, this.redFlash + i); },
  flashBlue() { this.blueFlash = 0.75; },
  flashWhite(op) { this.whiteFlash = op; },

  /* UPGRADE(feedback): hitmarker — flashes when a player round connects;
     gold + bigger on the killing blow. Fired from the projectile collision
     path via G.hud.hitmark(died). */
  hitmark(kill) {
    const h = this.el.hitmarker;
    h.classList.remove('show', 'kill');
    void h.offsetWidth;
    if (kill) h.classList.add('kill');
    h.classList.add('show');
  },

  refreshWave() {
    /* CAMPAIGN: phase-aware wave readout (pad / ascent / map · wave) */
    const c = G.campaign;
    if (c && c.phase === 1) { this.el.waveVal.textContent = 'PAD'; return; }
    if (c && c.phase === 2) { this.el.waveVal.textContent = 'ASCENT'; return; }
    if (c && c.mode === 'adventure' && c.phase >= 3) {
      this.el.waveVal.textContent = 'MAP ' + (c.mapIdx + 1) + ' · W' + (G.waves.wave || 1);
    } else this.el.waveVal.textContent = G.waves.wave || 1;
  },

  /* CAMPAIGN: start-screen best line (score + best map reached) */
  refreshBest() {
    const g = G.game;
    this.el.startBest.textContent = 'BEST SCORE  ' + U.fmt(g.best) +
      (g.bestMap > 0 ? '   ·   ADVENTURE BEST  MAP ' + g.bestMap + '/' + MAPS.length : '');
  },

  refreshSlots() {
    const p = G.player;
    const roman = ['I', 'II', 'III'];
    this.el.slots.forEach((s, i) => { if (s) s.classList.toggle('active', i === p.weapon); });
    this.el.slots[0].querySelector('.slot-sub').textContent = 'MK ' + roman[p.blasterTier];
    // v1.5 battery: seekers ammo · lance charge hint · shard stacks · mine count
    this.el.slots[3].querySelector('.slot-sub').textContent =
      p.missileAmmo + ' AMMO · ' + p.lockCap() + '-LOCK';
    if (this.el.slots[7]) this.el.slots[7].querySelector('.slot-sub').textContent =
      p._shardStacks > 0 ? 'MOMENTUM x' + (p._shardStacks + 1) : 'CLOSE RANGE';
    if (this.el.slots[8]) this.el.slots[8].querySelector('.slot-sub').textContent =
      (p.voidMines ? p.voidMines.length : 0) + ' DEPLOYED';
    // skill chips: locked skills read LOCKED instead of a key
    if (this.el.skillBlink) this.el.skillBlink.classList.toggle('locked', !p.skillUnlocked.blink);
    if (this.el.skillOD) this.el.skillOD.classList.toggle('locked', !p.skillUnlocked.overdrive);
  },

  showScreen(name) {
    for (const k in this.el.screens) {
      // while the upgrade CHOICE is pending its screen stays
      // up — a pause/resume cycle mid-choice must not swallow it
      if (k === 'upgrade' && this._upgCb) continue;
      this.el.screens[k].classList.toggle('hidden', k !== name);
    }
    this.el.hud.classList.toggle('hidden', name === 'start');
  },

  showGameOver() {
    const g = G.game, p = G.player;
    const acc = p.shotsFired > 0 ? Math.round(100 * p.shotsHit / p.shotsFired) : 0;
    const mm = Math.floor(g.elapsed / 60), ss = Math.floor(g.elapsed % 60);
    const isBest = !!g._newBest;   // FIX: see gameOver() — was always true
    // CAMPAIGN: victory vs death framing + run progress line
    this.el.overTitle.textContent = g._victory ? 'SECTOR LIBERATED'
      : (g._podLost ? 'LAUNCH POD DESTROYED' : 'SHIP DESTROYED');
    this.el.overTitle.style.color = g._victory ? '#ffe9c0' : '#ffd9d2';
    this.el.overTitle.style.textShadow = g._victory
      ? '0 0 30px rgba(255,200,87,.9),0 0 90px rgba(255,200,87,.3)'
      : '0 0 30px rgba(255,80,60,.9),0 0 90px rgba(255,80,60,.3)';
    const prog = G.campaign ? G.campaign.progressLabel() : '';
    this.el.overStats.innerHTML =
      'FINAL SCORE&nbsp; <b>' + U.fmt(g.score) + '</b>' + (isBest ? ' <span style="color:#ffc857">— NEW BEST</span>' : '') + '<br>' +
      'MODE&nbsp; <b>' + (g.mode === 'adventure' ? 'ADVENTURE' : 'ENDLESS') + '</b>' +
      (prog ? ' &nbsp;·&nbsp; ' + prog : '') + '<br>' +
      'BEST&nbsp; <b>' + U.fmt(g.best) + '</b>' +
      (g.bestMap > 0 ? ' &nbsp;·&nbsp; ADVENTURE BEST&nbsp; <b>MAP ' + g.bestMap + '/' + MAPS.length + '</b>' : '') + '<br>' +
      'KILLS&nbsp; <b>' + g.kills + '</b> &nbsp;·&nbsp; ACCURACY&nbsp; <b>' + acc + '%</b><br>' +
      'MAX COMBO&nbsp; <b>x' + g.maxCombo.toFixed(2) + '</b> &nbsp;·&nbsp; TIME&nbsp; <b>' + mm + ':' +
      String(ss).padStart(2, '0') + '</b>' +
      (g.bestMap > 0 ? '<br>DEEPEST SECTOR&nbsp; <b>MAP ' + g.bestMap + '/' + MAPS.length + '</b>' : ''),
    this.showScreen('over');
    this.el.hud.classList.remove('hidden');
  },

  showError(msg) {
    this.el.errorMsg.textContent = msg;
    this.showScreen('error');
  },

  reset() {
    this.el.scoreVal.textContent = '0';
    this.el.waveVal.textContent = '1';
    this.el.comboVal.textContent = 'x1';
    this.el.comboVal.classList.remove('lost');
    this.el.bossBar.classList.add('hidden');
    this.el.objWrap.classList.add('hidden');
    this.el.objTimer.classList.add('hidden');
    this.el.alertLine.textContent = '';
    this.el.banner.className = '';
    this.el.overdriveChip.style.display = 'none';
    // FIX: a restart arriving during a phase-cut left the black #fade
    // overlay up — every new run started on a dark screen.
    this.el.fade.classList.remove('on');
    this.refreshSlots();
  },

  /* ================= per-frame ================= */
  update(dt) {
    const p = G.player, g = G.game;
    G.camera.updateMatrixWorld();

    /* ---- bars ---- */
    const sh = Math.max(0, p.shield) / (p.maxShield || CFG.combat.shield) * 100;
    const hu = Math.max(0, p.hull) / (p.maxHull || CFG.combat.hull) * 100;
    const bo = p.boostE / CFG.combat.boostEnergy * 100;
    this.el.shieldFill.style.width = sh + '%';
    this.el.hullFill.style.width = hu + '%';
    this.el.boostFill.style.width = bo + '%';
    this.el.shieldNum.textContent = Math.ceil(Math.max(0, p.shield));
    this.el.hullNum.textContent = Math.ceil(Math.max(0, p.hull));
    // hull color slides green -> amber -> red
    const hue = U.lerp(0, 120, hu / 100);
    this.el.hullFill.style.background = `linear-gradient(90deg,hsl(${hue},70%,30%),hsl(${hue},90%,55%))`;

    /* ---- score / combo ---- */
    g.displayScore += (g.score - g.displayScore) * Math.min(1, dt * 9);
    if (g.score - g.displayScore < 1) g.displayScore = g.score;
    this.el.scoreVal.textContent = U.fmt(g.displayScore);
    this.el.comboVal.textContent = 'x' + g.combo.toFixed(2).replace(/\.?0+$/, '');   // FIX: x1.50 showed as "x1.5", x2.00 as "x2.0"
    this.el.comboFill.style.width = (g.comboT / CFG.score.comboTimeout * 100) + '%';

    /* ---- reticle (the virtual steering cursor) ---- */
    const cx = window.innerWidth * 0.5, cy = window.innerHeight * 0.5;
    const rx = cx + G.input.cursor.x, ry = cy + G.input.cursor.y;
    this.el.reticle.style.transform = `translate(${rx - 17}px,${ry - 17}px)`;
    this.el.reticle.classList.toggle('hot', !!p.lockTarget && !p.locked);
    this.el.reticle.classList.toggle('locked', p.locked);

    /* ---- lance charge ring (conic sweep around the reticle) ----
       v1.5: past 100% the ring flips to an unstable amber/red flicker —
       the overcharge zone is a choice, and it reads as danger. */
    if (p.charging && p.chargeT > 0.03) {
      const c = this.el.chargeRing;
      c.style.display = 'block';
      c.style.transform = `translate(${rx - 36}px,${ry - 36}px)`;
      const pct = (Math.min(p.chargeT, 1.4) / 1.4 * 100).toFixed(1);
      const over = p.chargeT > 1.0;
      const flick = over ? (0.55 + 0.45 * Math.sin(performance.now() * 0.035)) : 1;
      const col = over ? `rgba(255,${(120 + 80 * flick) | 0},60,${flick})`
        : (p.chargeT > 0.85 ? '#b0ffd8' : '#5fe8ff');
      c.style.background = `conic-gradient(${col} ${pct}%, rgba(255,255,255,0.07) 0)`;
    } else this.el.chargeRing.style.display = 'none';

    /* ---- lock-on box (tracks the candidate target in screen space) ---- */
    const lt = p.lockTarget;
    if (lt && lt.alive) {
      const s = { x: 0, y: 0 };
      if (worldToScreen(lt.pos, s)) {
        const dist = G.camera.position.distanceTo(lt.pos);
        const size = U.clamp(2600 / dist, 26, 110);
        const lb = this.el.lockbox;
        lb.style.display = 'block';
        lb.classList.toggle('locked', p.locked);
        lb.style.transform = `translate(${s.x - size / 2}px,${s.y - size / 2}px) scale(${size / 64})`;
        lb.style.transformOrigin = '0 0';
        this.el.lockName.textContent = p.locked ? 'LOCK — ' + enemyLabel(lt) : enemyLabel(lt);
        const hpFrac = lt.hp !== undefined ? U.clamp(lt.hp / lt.maxHp, 0, 1) : 1;
        this.el.lockFill.style.width = (hpFrac * 100) + '%';
      } else this.el.lockbox.style.display = 'none';
    } else this.el.lockbox.style.display = 'none';

    /* ---- v1.5 MULTI-LOCK TAG MARKERS: one small bracket per tagged
       target, growing with tag age — the reticle-level read of the
       hold-to-tag seeker volley. ---- */
    if (p.lockTags.length) {
      const s2 = { x: 0, y: 0 };
      for (let i = 0; i < this.tagPool.length; i++) {
        const t = this.tagPool[i], tag = p.lockTags[i];
        if (!tag || !tag.e || !tag.e.alive) { t.style.display = 'none'; continue; }
        if (!worldToScreen(tag.e.pos, s2)) { t.style.display = 'none'; continue; }
        const grow = U.clamp(tag.t / 0.4, 0.4, 1);
        const sz = 34 * grow;
        t.style.display = 'block';
        t.style.transform = `translate(${s2.x - sz / 2}px,${s2.y - sz / 2}px) scale(${grow})`;
      }
    } else for (const t of this.tagPool) t.style.display = 'none';

    /* ---- weapon slots (v1.5: charge ring text + seeker lock readout) ---- */
    this.el.slots[1].querySelector('.slot-sub').textContent =
      p.charging ? (p.chargeT > 1.0 ? 'OVERCHARGE ' + Math.round(p.chargeT * 100) + '%'
        : 'CHARGE ' + Math.round(p.chargeT * 100) + '%') : 'HOLD — PAST 100% = OVERCHARGE';
    if (p.missileAmmo !== this._lastAmmo || this._lastLockN !== p.lockCap()) {
      this._lastAmmo = p.missileAmmo; this._lastLockN = p.lockCap();
      this.el.slots[3].querySelector('.slot-sub').textContent = p.missileAmmo + ' AMMO · ' + p.lockCap() + '-LOCK';
    }
    if (p.overdriveT > 0) {
      this.el.overdriveChip.style.display = 'block';
      this.el.overdriveChip.textContent = 'OVERDRIVE ' + Math.ceil(p.overdriveT) + 's';
    } else this.el.overdriveChip.style.display = 'none';

    /* ---- UPGRADE(skills): ability chips — radial-ish vertical fill, ready-glow ---- */
    const skillChip = (chip, fill, cd, max, ready) => {
      if (!chip) return;
      if (cd > 0) {
        chip.classList.add('cd');
        chip.classList.remove('ready');
        fill.style.height = (100 * (1 - cd / max)).toFixed(1) + '%';
        fill.textContent = Math.ceil(cd);
      } else {
        chip.classList.remove('cd');
        chip.classList.add('ready');
        fill.style.height = '100%';
        fill.textContent = ready;
      }
    };
    skillChip(this.el.skillFlare, this.el.skillFlareFill, p.flareCd, CFG.skills.flareCd, 'V');
    skillChip(this.el.skillNova, this.el.skillNovaFill, p.novaCd, CFG.skills.novaCd, 'B');
    skillChip(this.el.skillBlink, this.el.skillBlinkFill, p.blinkCd, CFG.skills.blinkCd, 'N');
    skillChip(this.el.skillOD, this.el.skillODFill, p.odCd, CFG.skills.overdriveCd, 'G');

    /* ---- vignettes / flashes ---- */
    this.redFlash = Math.max(0, this.redFlash - dt * 1.8);
    this.blueFlash = Math.max(0, this.blueFlash - dt * 2.5);
    this.whiteFlash = Math.max(0, this.whiteFlash - dt * 3);
    const lowHull = p.hull < 35 && p.alive ? (0.22 + 0.12 * Math.sin(performance.now() * 0.006)) : 0;
    this.el.vigRed.style.opacity = Math.min(0.9, lowHull + this.redFlash);
    this.el.vigBlue.style.opacity = this.blueFlash * 0.8;
    this.el.flashWhite.style.opacity = this.whiteFlash;

    /* ---- alert line ---- */
    if (this.alertT > 0) { this.alertT -= dt; if (this.alertT <= 0) this.el.alertLine.textContent = ''; }

    /* ---- boss bar (v1.5: pips from the boss's archetype layout) ---- */
    const boss = G.waves.boss;
    if (boss && (boss.alive || boss.keepAfterDeath)) {
      this.el.bossBar.classList.remove('hidden');
      this.el.bossFill.style.width = U.clamp(boss.coreHp / boss.coreMax, 0, 1) * 100 + '%';
      const parts = boss.pipParts || ['gunL', 'gunR', 'missilePod', 'shieldDome'];
      for (let i = 0; i < 4; i++) {
        const hs = boss.hitSpheres.find((h) => h.part === parts[i]);
        const pip = this.pips[i];
        pip.classList.toggle('dead', !(hs && hs.alive));
        pip.title = hs ? hs.label : '';
      }
    } else this.el.bossBar.classList.add('hidden');

    /* ---- escort ally bar (arena phases only — the campaign phases use
       the same bar element for pod integrity / ascent progress) ---- */
    const inArena = !G.campaign || G.campaign.phase >= 3;
    const ally = G.waves.ally;
    if (inArena) {
      if (ally && ally.alive) {
        this.el.objBar.classList.remove('hidden');
        this.el.objFill.style.width = U.clamp(ally.hp / ally.maxHp, 0, 1) * 100 + '%';
      } else {
        this.el.objBar.classList.add('hidden');   // FIX: stale escort bar used to linger at 0%
      }
    }

    this._drawRadar();
    this._drawIndicators();
  },

  /* ---------------- radar scope ---------------- */
  _drawRadar() {
    const ctx = this.radarCtx, S = 440, C = S / 2, R = S * 0.46;
    /* nebula maps collapse the radar — World.radarFactor
       (0.45 in cloud) shrinks the effective scope; the target-link
       upgrade widens it again. Same scope, honest range. */
    const range = CFG.radar.range * (G.world.radarFactor || 1) * (G.player.radarMult || 1);
    ctx.clearRect(0, 0, S, S);
    // scope background
    ctx.fillStyle = 'rgba(6,12,18,0.55)';
    ctx.beginPath(); ctx.arc(C, C, R + 6, 0, U.TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(95,232,255,0.22)';
    for (const f of [1 / 3, 2 / 3, 1]) {
      ctx.beginPath(); ctx.arc(C, C, R * f, 0, U.TAU); ctx.stroke();
    }
    ctx.beginPath();
    ctx.moveTo(C - R, C); ctx.lineTo(C + R, C);
    ctx.moveTo(C, C - R); ctx.lineTo(C, C + R);
    ctx.stroke();
    // rotating sweep with fading trail
    this.sweep += 0.035;
    for (let i = 0; i < 24; i++) {
      const a = this.sweep - i * 0.045;
      ctx.strokeStyle = `rgba(95,232,255,${0.28 * (1 - i / 24)})`;
      ctx.beginPath();
      ctx.moveTo(C, C);
      ctx.lineTo(C + Math.cos(a) * R, C + Math.sin(a) * R);
      ctx.stroke();
    }
    // player wedge at center
    ctx.fillStyle = '#dff6ff';
    ctx.beginPath();
    ctx.moveTo(C, C - 9); ctx.lineTo(C - 6, C + 7); ctx.lineTo(C + 6, C + 7);
    ctx.closePath(); ctx.fill();

    // rotate world offsets into ship-local space (scope up = nose)
    _q1.copy(G.player.quat).invert();
    const blip = (pos, color, size, shape, boss) => {
      _v1.copy(pos).sub(G.player.pos).applyQuaternion(_q1);
      const d = _v1.length();
      const k = d > range ? range / d : 1; // clamp bearing to the rim
      const x = C + (_v1.x / range) * R * k;
      const y = C + (_v1.z / range) * R * k;
      ctx.globalAlpha = d > range ? 0.45 : 1;
      if (shape === 'diamond') {
        ctx.strokeStyle = color; ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, y - size); ctx.lineTo(x + size, y); ctx.lineTo(x, y + size); ctx.lineTo(x - size, y);
        ctx.closePath(); ctx.stroke();
      } else {
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(x, y, size, 0, U.TAU); ctx.fill();
        if (boss) {
          ctx.strokeStyle = color; ctx.lineWidth = 1.5;
          ctx.beginPath(); ctx.arc(x, y, size + 4 + Math.sin(performance.now() * 0.005) * 2, 0, U.TAU); ctx.stroke();
        }
      }
      // altitude tick: above = up-tick, below = down-tick
      const alt = U.clamp(_v1.y / range, -1, 1) * 8;
      if (Math.abs(alt) > 2) {
        ctx.strokeStyle = color; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x, y - alt); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    for (const e of G.enemies.list) {
      if (!e.alive) continue;
      if (e.type === 'fighter') blip(e.pos, e.elite ? '#ffc857' : '#ff4d4d', 3.5, 'dot');
      else if (e.type === 'gunship') blip(e.pos, e.elite ? '#ffc857' : '#ffa040', 5, 'dot');
      else if (e.type === 'bomber') blip(e.pos, '#ff7030', 6.5, 'diamond');     // heavy = outlined diamond
      else if (e.type === 'drone') blip(e.pos, '#ff4070', 2.5, 'dot');          // swarm = small hot dots
      else if (e.type === 'turret') blip(e.pos, '#40c9ff', 3.5, 'diamond');
      else if (e.type === 'mine') blip(e.pos, '#ff80c0', 3, 'dot');
      // v1.3/v1.4 roster — each class keeps a distinct color + size
      else if (e.type === 'ravager') blip(e.pos, '#ff5515', 7, 'diamond');
      else if (e.type === 'sentinel') blip(e.pos, '#40ffd0', 6, 'diamond');
      else if (e.type === 'interdictor') blip(e.pos, '#18c8ff', 7.5, 'diamond');
      else if (e.type === 'interceptor') blip(e.pos, '#ff4ad8', 3, 'dot');
      else if (e.type === 'hive') blip(e.pos, '#9dff2e', 6, 'diamond');
      else if (e.type === 'boss') blip(e.pos, '#c060ff', 9, 'dot', true);
    }
    for (const pk of G.pickups.list) blip(pk.pos, '#7fe070', 2.5, 'dot');
    if (G.waves.ally && G.waves.ally.alive) blip(G.waves.ally.pos, '#40ffb0', 5, 'dot');
    for (const v of Wingmen.wing) if (v.alive) blip(v.pos, '#58ff9b', 3.5, 'dot');
  },

  /* ---------------- offscreen indicators (boss / HVT / ally) ---------------- */
  _drawIndicators() {
    const targets = [];
    const boss = G.waves.boss;
    if (boss && boss.alive) targets.push({ pos: boss.pos, tag: 'KHARYBDIS', cls: 'boss' });
    const o = G.waves.objective;
    if (o && o.kind === 'hvt' && o.state === 'active' && o.hvt && o.hvt.alive) {
      targets.push({ pos: o.hvt.pos, tag: 'PRIZE SHIP', cls: '' });
    }
    if (G.waves.ally && G.waves.ally.alive) targets.push({ pos: G.waves.ally.pos, tag: 'TESSA', cls: 'ally' });
    const W = window.innerWidth, H = window.innerHeight;
    const s = { x: 0, y: 0 };
    for (let i = 0; i < this.indPool.length; i++) {
      const el = this.indPool[i], t = targets[i];
      if (!t) { el.style.display = 'none'; continue; }
      let on = worldToScreen(t.pos, s);
      let dx, dy;
      if (on && s.x > 60 && s.x < W - 60 && s.y > 60 && s.y < H - 60) {
        el.style.display = 'none'; continue;      // visible on screen already
      }
      if (!on) { s.x = W - s.x; s.y = H - s.y; }  // behind camera: mirror
      dx = s.x - W / 2; dy = s.y - H / 2;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      const ex = W / 2 + dx * Math.min(W, H) * 0.38;
      const ey = H / 2 + dy * Math.min(W, H) * 0.38;
      el.style.display = 'block';
      el.className = 'ind ' + t.cls;
      el.style.left = ex + 'px';
      el.style.top = ey + 'px';
      const ang = Math.atan2(dy, dx) + Math.PI / 2;   // arrow points outward
      el.querySelector('.arrow').style.transform = `rotate(${ang}rad)`;
      el.querySelector('.tag').textContent = t.tag;
    }
  },
};

function enemyLabel(e) {
  switch (e.type) {
    case 'fighter': return e.elite ? 'ACE INTERCEPTOR' : 'INTERCEPTOR';
    case 'gunship': return e.elite ? 'PRIZE GUNSHIP' : 'GUNSHIP';
    case 'turret': return 'DEFENSE TURRET';
    case 'mine': return 'CONTACT MINE';
    case 'bomber': return 'VULTURE BOMBER';
    case 'drone': return 'RAZOR DRONE';
    case 'ravager': return 'RAVAGER';
    case 'sentinel': return 'SENTINEL';
    case 'interdictor': return 'INTERDICTOR';
    case 'interceptor': return e.eliteMod ? e.eliteMod + ' INTERCEPTOR' : 'INTERCEPTOR';
    case 'hive': return e.eliteMod ? e.eliteMod + ' HIVE' : 'HIVE';
    case 'boss': return 'DREADNOUGHT';
  }
  return 'UNKNOWN';
}

/* ============================================================
   [SECTION 17] CAMPAIGN — mode select data, MAPS, phase manager
   ------------------------------------------------------------
   Wraps the existing arena systems in a run structure:

     PHASE 1  LAUNCHPAD DEFENSE — fixed gunner view at the pad,
              pod HP bar, two scripted attacker waves (intro).
     PHASE 2  ASCENT            — bounded corridor flight with a
              power-on ramp (40% → 100% thrust/turn/speed) and a
              denser local asteroid field along the path.
     PHASE 3  ARENA             — Endless: today's infinite-wave
              loop / Adventure: 5 boss-gated maps with per-map
              backdrops, spawn tables and stat multipliers.

   PERSISTENCE RULES
   - Endless: nothing carries anywhere; every run is fresh.
   - Adventure: blaster tier + missile ammo carry map→map within
     one run; hull/shield/boost are refit at each map start. ANY
     death (phase 1 pod, phase 2 crash, any map) ends the run —
     restart goes all the way back to phase 1, fully fresh.
   - Only cross-session persistence: best score + "best map
     reached" readout (same localStorage pattern as before).

   Everything reuses the existing pools/classes — this section
   only ORCHESTRATES them (data + scheduling, no parallel systems).
============================================================ */

/* ---------- Adventure map table (plain config objects) ----------
   painter : which existing texture painter to reuse ('gas' | 'rocky'
             | 'ice' | 'terran') + palette params — no new painters.
   weights : weighted spawn table, biased toward the map's 1-2
             signature enemy types (consumed by Waves.startWave).
   waves   : normal waves before the map's boss wave gates the exit. */

const Campaign = {
  mode: 'endless',
  phase: 0,          // 0 idle/menu | 1 pad | 2 ascent | 3 arena/maps
  mapIdx: 0,
  podHp: 0, podHpMax: 0,
  phaseT: 0,
  power: 1,
  transitioning: false,
  padCam: { pos: new THREE.Vector3(), baseQuat: new THREE.Quaternion(), yaw: 0, pitch: 0 },
  padSphere: null,             // { x, y, z, r } — enemy bolt vs pad check
  _padTurrets: [],             // auto-PD turrets (support fire, phase 1 only)
  pathPts: [],
  _pathI: 0,
  _p1: null,                   // phase-1 scheduler state
  _lastPowerTick: -1,

  init() {
    this._buildPad();
    this.pathPts = this._buildPath();
    this._buildCorridorVisual();
  },

  /* ---- helpers other sections query ---- */
  playerFlying() { return this.phase !== 1; },
  weaponLocked() { return this.phase === 1; },      // pad defense: blaster only
  powerMult() { return this.phase === 2 ? this.power : 1; },

  progressLabel() {
    if (this.phase === 1) return 'PHASE 1 — LAUNCHPAD DEFENSE';
    if (this.phase === 2) return 'PHASE 2 — ASCENT';
    if (this.mode === 'endless') return 'WAVE ' + (G.waves.wave || 1);
    return 'MAP ' + (this.mapIdx + 1) + '/' + MAPS.length + ' — WAVE ' + (G.waves.wave || 1);
  },

  /* ================= run lifecycle ================= */
  beginRun(mode) {
    this.mode = mode;
    this.phase = 1;
    this.mapIdx = 0;
    this.transitioning = false;
    this._p1 = null;
    // restore the stock sky (a previous run's hero planet / sky tint must
    // not leak into the new launchpad), and the standard belt layout
    G.world.setHeroPlanet(null);
    G.world.setSkyTint(null);
    G.world.clearHazard();      // v1.5: exotic hazards never leak across runs
    G.world.asteroids.scatterBelt();
    this._startPhase1();
  },

  teardown() {
    this.phase = 0;
    this.transitioning = false;
    this._fadeToken = (this._fadeToken || 0) + 1;   // FIX: orphaned fade timeouts must no-op after teardown
    if (this.pad) this.pad.visible = false;
    if (this._corridorVis) this._corridorVis.visible = false;
    G.world.asteroids.scatterBelt();
    G.world.setHeroPlanet(null);
    G.world.setSkyTint(null);
    G.world.clearHazard();
    G.enemies.clear();
    G.projectiles.reset();
    G.pickups.reset();
    G.waves.reset();
    G.waves.state = 'idle';
    G.hud.setObjective(null);
  },

  update(dt) {
    if (G.game.state !== 'playing' || this.transitioning || !G.player.alive) return;
    if (this.phase === 1) this._updatePhase1(dt);
    else if (this.phase === 2) this._updatePhase2(dt);
  },

  /* phase-cut: dip to black, swap the world behind it, fade back.
     FIX: the old version fired the world-swap unconditionally — pausing,
     dying, or bailing to the menu during the 460ms fade still teleported
     the player into the next phase, or worse, left `transitioning=true`
     forever (permanent soft-lock). Now: a token invalidates superseded
     cuts, the swap aborts unless the run is still live, and the flag
     always clears (spec §59 fallback). */
  _fadeTransition(fn) {
    this._fadeToken = (this._fadeToken || 0) + 1;
    const token = this._fadeToken;
    G.hud.fadeCut();
    setTimeout(() => {
      if (token !== this._fadeToken || G.game.state !== 'playing' || !this.phase) {
        this.transitioning = false;   // run changed under us — recover cleanly
        // FIX(dark screen): an aborted cut used to leave the #fade overlay
        // fully opaque — e.g. SKIP WAVE/PHASE pressed in the dev console
        // pauses the run (state 'paused'), the world-swap bailed here and
        // nothing ever removed the black overlay. Lift the fade regardless;
        // hiding the overlay is always safe even if fn() never ran.
        G.hud.fadeBack();
        return;
      }
      try { fn(); }
      catch (e) { console.error('[campaign] transition fault', e); this.transitioning = false; }
      if (this.transitioning) {       // fn must clear its own flag; force it if not
        console.warn('[VOID LANCER] transition did not clear its flag; recovering');
        this.transitioning = false;
      }
      setTimeout(() => {
        if (token === this._fadeToken && G.game.state === 'playing') G.hud.fadeBack();
      }, 240);
    }, 460);
  },

  /* ================= PHASE 1 — LAUNCHPAD DEFENSE ================= */
  _startPhase1() {
    const P1 = CFG.campaign.phase1;
    this.phase = 1;
    this.phaseT = 0;
    this.podHpMax = this.podHp = P1.podHp;
    // park the ship on the pad, nose toward the approach vector
    G.player.pos.set(0, 2.4, 2);
    G.player.quat.identity();
    G.player.vel.set(0, 0, 0);
    G.player.group.position.copy(G.player.pos);
    G.player.group.quaternion.copy(G.player.quat);
    G.player.spawnGuard = 0.5;
    // FIXED gunner camera anchor — pulled back & up off the pad so the
    // framed view shows the parked ship, the pod, the PD turrets and the
    // approach vector (was 1.2u above the ship: an empty, cramped view).
    this.padCam.pos.set(0, 6.8, 20);
    this.padCam.baseQuat.identity();
    this.padCam.yaw = 0;
    this.padCam.pitch = 0;
    this.padSphere = { x: 4, y: 2, z: 2, r: 30 };
    if (this.pad) this.pad.visible = true;
    if (this._corridorVis) this._corridorVis.visible = false;
    for (const t of this._padTurrets) { t.yaw = 0; t.pitch = 0; t.cd = U.rand(0.5, 1.5); t.hot = 0; }
    this._p1 = {
      waveIdx: 0, waveT: 0, spawnedThisWave: 0, nextSpawnT: 0,
      waveActive: false, done: false, def: null,
    };
    G.camRig.forceMode('turret');   // auto gunner view for the pad phase
    G.world.dust.recenter(G.player.pos);
    G.hud.refreshWave();
    G.hud.banner('PHASE 1 — LAUNCHPAD DEFENSE', 'PAD TURRETS ONLINE — REPEL THE BOARDING WAVE', '');
    G.hud.alert('GUNNER VIEW — FREE LOOK: MOUSE · FIRE: LMB', 4);
    G.audio.waveHorn();
  },

  _updatePhase1(dt) {
    const P1 = CFG.campaign.phase1, s = this._p1;
    this.phaseT += dt;
    s.waveT += dt;
    if (this._podBeacon) this._podBeacon.visible = Math.sin(performance.now() * 0.008) > -0.2;

    /* the parked ship pivots on its launch ring to follow the gunner's
       view — keeps the wingtip muzzles pointed usefully and sells the
       "armed on the pad" fantasy. Pure cosmetics + aiming convenience:
       the phase still disables flight (see Player.update). */
    _q1.setFromAxisAngle(_v1.set(0, 1, 0), this.padCam.yaw);
    G.player.quat.slerp(_q1, 1 - Math.exp(-P1.shipTrackRate * dt));
    G.player.group.quaternion.copy(G.player.quat);

    this._updatePadTurrets(dt);

    // ---- scripted wave sequencing (a scheduler, not the Waves director) ----
    if (!s.waveActive && !s.done && s.waveT >= (s.waveIdx === 0 ? 3 : P1.waveGap)) {
      s.waveActive = true;
      s.spawnedThisWave = 0;
      s.nextSpawnT = 0;
      s.def = P1.waves[s.waveIdx];
      G.hud.alert('HOSTILE WAVE ' + (s.waveIdx + 1) + ' INBOUND', 2.5);
      G.audio.alarm();
    }
    if (s.waveActive) {
      const def = s.def;
      const total = def.fighters + (def.gunships || 0) + (def.turrets || 0);
      if (s.spawnedThisWave < total) {
        s.nextSpawnT -= dt;
        if (s.nextSpawnT <= 0) {
          s.nextSpawnT = U.rand(0.8, 1.6);
          this._spawnPadAttacker(s);
          // FIX(infinite phase): the wave only advanced once the field
          // EMPTIED — an attacker that died without running onEnemyKilled
          // (ram edge cases, cheat despawns) left the spawn counter short
          // and the pad defense ran FOREVER. The launch counter is
          // authoritative: the wave is fully spawned right here.
          s.spawnedThisWave = total;
        }
      } else if (G.enemies.countAlive() === 0) {
        s.waveActive = false;
        s.waveIdx++;
        s.waveT = 0;
        G.hud.alert('WAVE REPELLED', 2);
        if (s.waveIdx >= P1.waves.length) s.done = true;
      }
    }

    // ---- pod integrity readout (reuses the objective bar) ----
    G.hud.setObjective('DEFEND THE LAUNCH POD');
    const frac = this.podHp / this.podHpMax;
    G.hud.setObjectiveBar(frac, frac < 0.35 ? 'var(--bad)' : '');
    if (frac < 0.35) G.hud.alert('POD INTEGRITY CRITICAL', 0.3);

    // ---- completion: waves cleared, or the safety timer expires ----
    if (s.done || this.phaseT > P1.duration) this._completePhase1();
  },

  _spawnPadAttacker(s) {
    const P1 = CFG.campaign.phase1, def = s.def, which = s.spawnedThisWave;
    let type = 'fighter';
    if (which >= def.fighters && def.gunships && which < def.fighters + def.gunships) type = 'gunship';
    else if (def.turrets && which >= def.fighters + (def.gunships || 0)) type = 'turret';
    // spawn inside the gunner's forward arc (free-look can track them
    // anywhere now, but the front hemisphere keeps the phase readable)
    const a = U.rand(-1.0, 1.0);
    _v1.set(Math.sin(a), U.rand(-0.15, 0.35), -Math.cos(a)).normalize()
       .multiplyScalar(U.rand(P1.spawnDist[0], P1.spawnDist[1]));
    if (type === 'fighter') {
      G.enemies.spawnFighter({ pos: _v1, hpMult: 0.8, spdMult: 0.9, leadSkill: 0.55 });
    } else if (type === 'gunship') {
      G.enemies.spawnGunship({ pos: _v1, hpMult: 0.8, spdMult: 0.9, leadSkill: 0.6 });
    } else {
      // distant embedded plinker — reuses the Turret class on a fixed mount
      _v1.setLength(U.rand(340, 400));
      _v1.y = U.rand(-20, 60);
      G.enemies.spawnTurret(-1, null, _v1.clone());
    }
  },

  /* ---------- automated PD turrets (support fire, phase 1 only) ----------
     Each turret picks the nearest live attacker in range, slews its
     yoke/pitch toward it, and fires player-faction bolts. Player-faction
     rounds can never hit the player or the pod (see the faction routing
     in Projectiles._updatePool), and `noStats` keeps them out of the
     player's accuracy readout — they're support, not score. */
  _updatePadTurrets(dt) {
    const P1 = CFG.campaign.phase1;
    for (const t of this._padTurrets) {
      t.cd -= dt;
      t.hot = Math.max(0, t.hot - dt * 3);
      // target: nearest live attacker in range
      let best = null, bestD = P1.turretRange * P1.turretRange;
      for (const e of G.enemies.list) {
        // FIX(infinite phase): dead-but-undisposed attackers linger one
        // frame in the manager list and got targeted; zero-damage fire
        // kept muzzle sfx looping with nothing ever dying. Live targets only.
        if (!e.alive || e.hp <= 0) continue;
        const d = t.world.distanceToSquared(e.pos);
        if (d < bestD) { bestD = d; best = e; }
      }
      let desYaw, desPitch;
      if (best) {
        _v1.copy(best.pos).sub(t.world);
        const flat = Math.sqrt(_v1.x * _v1.x + _v1.z * _v1.z);
        desYaw = Math.atan2(-_v1.x, -_v1.z);
        desPitch = Math.atan2(_v1.y, flat);
      } else {
        // idle: slow patrol sweep so the pad reads as "manned"
        desYaw = Math.sin(this.phaseT * 0.35 + t.phase) * 0.7;
        desPitch = 0.08;
      }
      const dy = Math.atan2(Math.sin(desYaw - t.yaw), Math.cos(desYaw - t.yaw));
      t.yaw += U.clamp(dy, -P1.turretSlew * dt, P1.turretSlew * dt);
      t.pitch = U.clamp(
        t.pitch + U.clamp(desPitch - t.pitch, -P1.turretSlew * dt, P1.turretSlew * dt),
        -0.3, 1.1);
      t.yoke.rotation.y = t.yaw;
      t.pitchNode.rotation.x = t.pitch;
      if (best && t.cd <= 0 && Math.abs(dy) < 0.12 && Math.abs(desPitch - t.pitch) < 0.12) {
        t.cd = U.rand(P1.turretRate[0], P1.turretRate[1]);
        t.hot = 1;
        t.muzzle.getWorldPosition(_v2);
        // lead the target by its velocity — support fire that doesn't
        // feel dumb, but spread keeps it from stealing the phase
        const dist = Math.sqrt(bestD);
        _v3.copy(best.pos);
        if (best.vel) _v3.addScaledVector(best.vel, Math.min(1.2, dist / 640) * 0.85);
        _v3.sub(_v2).normalize();
        _v3.x += U.rand(-1, 1) * P1.turretSpread;
        _v3.y += U.rand(-1, 1) * P1.turretSpread;
        _v3.z += U.rand(-1, 1) * P1.turretSpread;
        _v3.normalize();
        Projectiles.fire('bolt', 'player', _v2, _v3, {
          speed: 640, dmg: P1.turretDmg, life: 2.2, noStats: true,
        });
        FX.muzzle(_v2, false);
        G.audio.shotBlaster(0.38);
      }
      // sensor/heat glow pulses with fire
      t.glowMat.emissiveIntensity = 0.5 + t.hot * 1.8;
    }
  },

  damagePod(dmg, hitPos) {
    if (this.phase !== 1 || this.transitioning || this.podHp <= 0) return;
    if (G.cheats && G.cheats.god) return;
    this.podHp = Math.max(0, this.podHp - dmg);
    if (hitPos) FX.shieldHit(hitPos);
    G.audio.shieldHit();
    G.hud.flashRed(0.3);
    FX.addTrauma(0.12);
    if (this.podHp <= 0) {
      // pod destroyed = run failed (same rule as dying anywhere: restart
      // the whole run from phase 1)
      G.game._podLost = true;
      _v1.set(13.5, 3, 8);
      FX.explosion(_v1, 14);
      FX.addTrauma(0.8);
      G.hud.banner('LAUNCH POD DESTROYED', 'RUN FAILED — RESTART FROM LAUNCH', 'bad');
      G.player.die();
    }
  },

  _completePhase1() {
    if (this.transitioning) return;
    this.transitioning = true;
    G.hud.banner('PAD SECURED', 'PREPARE FOR ASCENT', 'gold');
    G.audio.waveHorn();
    G.hud.setObjective(null);
    this._fadeTransition(() => this._startPhase2());
  },

  /* ================= PHASE 2 — ASCENT (guided corridor) ================= */
  _startPhase2() {
    const P2 = CFG.campaign.phase2;
    this.phase = 2;
    this.phaseT = 0;
    this.power = P2.powerStart;
    this._pathI = 0;
    this._lastPowerTick = -1;
    G.enemies.clear();
    G.projectiles.reset();
    if (this.pad) this.pad.visible = false;
    // swap the belt for a denser local field along the corridor (same
    // instanced meshes — see AsteroidField.scatterCorridor)
    G.world.asteroids.scatterCorridor(this.pathPts, P2.tubeRadius, P2.asteroidCount);
    G.pickups.reset();
    G.pickups.scatterAlongPath(this.pathPts);
    if (this._corridorVis) this._corridorVis.visible = true;
    // lift-off: ship at the path start, nose down the corridor
    G.player.pos.copy(this.pathPts[0]);
    G.player.quat.identity();
    G.player.vel.set(0, 0, 0);
    G.player.group.position.copy(G.player.pos);
    G.player.group.quaternion.copy(G.player.quat);
    G.world.dust.recenter(G.player.pos);
    // FIX(feel): phase 2 used to FORCE the cockpit — the freshly rebuilt
    // ship was invisible unless you remembered F. The "systems coming
    // online" readout works in any view, so honor the player's saved
    // preference (F still toggles freely during the climb).
    G.camRig.restorePref();
    this.transitioning = false;
    G.hud.refreshWave();
    G.hud.banner('PHASE 2 — ASCENT', 'SYSTEMS COMING ONLINE', '');
    G.audio.waveHorn();
  },

  _updatePhase2(dt) {
    const P2 = CFG.campaign.phase2, p = G.player;
    this.phaseT += dt;

    /* progress along the corridor — windowed nearest-sample search (the
       player only ever advances past samples, so a ±window is enough) */
    const pts = this.pathPts;
    let bestI = this._pathI, bestD = Infinity;
    for (let i = Math.max(0, this._pathI - 4); i < Math.min(pts.length, this._pathI + 14); i++) {
      const d = p.pos.distanceToSquared(pts[i]);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    this._pathI = bestI;
    const center = pts[bestI];
    const prog = bestI / (pts.length - 1);

    /* soft tube constraint — same spirit as Player._checkBoundary's
       soft push-back: free steering INSIDE the tube, corrective accel
       (and a hard clamp) past it. NOCLIP detaches it entirely. */
    if (!(G.cheats && G.cheats.noclip)) {
      _v1.copy(p.pos).sub(center);
      const lat = _v1.length();
      if (lat > P2.tubeRadius) {
        _v1.multiplyScalar(1 / lat).negate();          // toward the centerline
        const over = U.clamp((lat - P2.tubeRadius) / P2.tubeRadius, 0, 3);
        p.vel.addScaledVector(_v1, P2.pushAccel * over * dt);
        G.hud.alert('ASCENT CORRIDOR — RETURN TO FLIGHT PATH', 0.25);
        if (lat > P2.hardRadius) {
          _v1.negate();                                // back to outward dir
          p.pos.copy(center).addScaledVector(_v1, P2.hardRadius);
          p.group.position.copy(p.pos);
        }
      }
    }

    /* power-on ramp: 40% → 100%, driven by BOTH elapsed time and distance
       flown, so a fast pilot still enters the arena fully powered */
    const t = Math.min(this.phaseT / P2.powerDur, 1);
    this.power = P2.powerStart + (1 - P2.powerStart) * Math.max(t, prog);

    /* HUD: corridor progress + periodic systems readout */
    G.hud.setObjective('ASCENT — REACH THE ORBITAL GATE');
    G.hud.setObjectiveBar(prog, 'var(--c1)');
    const tick = Math.floor(this.phaseT / 4);
    if (tick !== this._lastPowerTick) {
      this._lastPowerTick = tick;
      G.hud.alert('SYSTEMS ' + Math.round(this.power * 100) + '% ONLINE', 1.2);
    }
    if (this._gate) {
      this._gate.rotation.z += 0.35 * dt;
      this._gate.material.opacity = 0.22 + 0.14 * Math.sin(performance.now() * 0.002);
    }

    if (prog >= 0.985 || p.pos.distanceTo(pts[pts.length - 1]) < 150) this._completePhase2();
  },

  _completePhase2() {
    if (this.transitioning) return;
    this.transitioning = true;
    G.hud.banner('GATE REACHED', 'POWER PLANT AT 100%', 'gold');
    G.hud.setObjective(null);
    this._fadeTransition(() => {
      if (this.mode === 'adventure') this._startMap(0);
      else this._startPhase3();
    });
  },

  /* ================= PHASE 3 — ARENA (Endless) ================= */
  _startPhase3() {
    this._enterArena(null);
    this.phase = 3;
    this.transitioning = false;
    G.hud.refreshWave();
    G.hud.banner('SECTOR 7 — COMBAT ZONE', 'HOLD THE SECTOR', '');
    G.audio.waveHorn();
  },

  /* shared arena entry (endless phase 3 / every adventure map) */
  _enterArena(map) {
    G.projectiles.reset();
    G.pickups.reset();
    G.world.asteroids.scatterBelt();     // fresh belt per arena/map
    G.world.setSkyTint(map ? map.skyTint : null);
    G.world.setHeroPlanet(map ? map.planet : null);
    /* exotic environmental mechanics — the black hole's
       gravity + event horizon, the nebula's radar collapse + ion arcs.
       Built here, cleared on teardown / map change (no leaks). */
    G.world.setHazard(map || null);
    this.currentMap = map || null;
    if (this._corridorVis) this._corridorVis.visible = false;
    // FIX(hardening): the pad is phase-1 dressing — jump paths (cheats,
    // debug API) can enter an arena without passing phase 2, so hide it
    // here rather than relying on the normal phase order.
    if (this.pad) this.pad.visible = false;
    // refit (hull/shield/boost) — upgrades/tier/ammo persist by NOT
    // resetting the player here
    G.player.hull = G.player.maxHull || CFG.combat.hull;
    G.player.shield = G.player.maxShield || CFG.combat.shield;
    G.player.boostE = CFG.combat.boostEnergy;
    G.player.pos.set(0, 0, 0);
    G.player.quat.identity();
    G.player.vel.set(0, 0, 0);
    G.player.group.position.copy(G.player.pos);
    G.player.group.quaternion.copy(G.player.quat);
    G.player.spawnGuard = CFG.combat.spawnGuard;
    G.world.dust.recenter(G.player.pos);
    G.camRig.reset();
    G.camRig.restorePref();              // back to the player's own view choice
    G.input.recenterCursor();
    G.enemies.reset();                   // clear + seed turret clusters (fresh belt)
    G.waves.reset();                     // nulls mapMode; set again below
    if (map) {
      G.waves.mapMode = {
        mapIdx: this.mapIdx, waves: map.waves, weights: map.weights,
        hpMult: map.hpMult, spdMult: map.spdMult, eliteChance: map.eliteChance,
        bossMult: map.bossMult,
      };
    }
  },

  /* ================= ADVENTURE MAPS ================= */
  _startMap(idx) {
    this.mapIdx = idx;
    const map = MAPS[idx];
    G.game.saveBestMap(idx + 1);         // "best map reached" readout
    // within-run persistence: tier + missile ammo carry (nothing resets
    // the player in _enterArena); guarantee at least starting ammo
    G.player.missileAmmo = Math.max(G.player.missileAmmo, CFG.weapons.seeker.ammoStart);
    this._enterArena(map);
    this.phase = 3;
    this.transitioning = false;
    /* FIX(labels): the run is 10 sectors now — the hardcoded /5 banners
       lied about progress. */
    G.hud.banner('MAP ' + (idx + 1) + '/' + MAPS.length + ' — ' + map.name, map.intro,
      idx === MAPS.length - 1 ? 'bad' : '');
    G.hud.refreshWave();
    G.audio.waveHorn();
  },

  /* called by Waves._waveComplete when a map's boss wave is cleared.
     the auto-grant is GONE — the player now CHOOSES one of
     three refits on the upgrade screen (Section 5), then the run advances. */
  onMapCleared() {
    if (this.transitioning) return;
    if (this.mapIdx >= MAPS.length - 1) { this._victory(); return; }
    this.transitioning = true;             // waves stay idle during the choice
    G.player.spawnGuard = Math.max(G.player.spawnGuard, 2.0);
    G.hud.banner('SECTOR CLEARED', 'SELECT A REFIT', 'gold');
    G.audio.waveHorn();
    G.hud.setObjective(null);
    /* the choice screen has DOM buttons — hand the cursor back for it,
       then re-lock when the choice is made (see _chooseUpgrade). */
    G.input.releaseLock();
    this._showUpgradeChoice();
    /* FIX(dark screen): the CHEATS "SKIP MAP" path calls onMapCleared while
       the dev console has the run paused — the screen stayed black (paused
       runs don't render a lit frame) AND showScreen() skips 'upgrade' only
       while _upgCb is pending, so the choice screen could stay hidden.
       Lift the phase fade NOW so the offer is visible in both situations. */
    G.hud.fadeBack();
    if (G.hud._upgCb) G.hud.el.screens.upgrade.classList.remove('hidden');
  },

  /* ---- the upgrade CHOICE screen: 3 options from the pool (stack-aware) ---- */
  _showUpgradeChoice() {
    const p = G.player;
    const pool = CFG.upgrades.pool.filter((u) =>
      (p.upgradeCounts[u.id] || 0) < CFG.upgrades.maxStacks);
    // shuffle + take offerCount
    const offers = [];
    const bag = pool.slice();
    while (offers.length < Math.min(CFG.upgrades.offerCount, bag.length)) {
      offers.push(bag.splice((Math.random() * bag.length) | 0, 1)[0]);
    }
    G.hud.showUpgradeChoice(offers, (id) => this._chooseUpgrade(id));
  },

  _chooseUpgrade(id) {
    G.hud.hideUpgradeChoice();
    G.player.applyUpgrade(id);
    G.input.requestLock();
    const goNext = () => this._fadeTransition(() => this._startMap(this.mapIdx + 1));
    setTimeout(goNext, 700);   // beat so the refit banner reads before the cut
  },

  /* black hole event horizon — the point of no return.
     Not instant death: the ship is dragged in and destroyed messily. */
  blackholeFail() {
    if (!G.player.alive) return;
    G.hud.alert('CROSSED THE EVENT HORIZON', 2, '#ff5a3c');
    FX.kick(1);
    FX.postPulse(1);
    G.player.damage(1e6, G.player.pos, false);
  },

  _victory() {
    this.transitioning = false;   // FIX: no further transitions exist — a stuck flag would block every future phase
    G.game.addScore(10000, G.player.pos, 'CAMPAIGN COMPLETE');
    G.hud.banner('CAMPAIGN COMPLETE', 'THE THRESHOLD IS BROKEN', 'gold');
    G.audio.bigBoom();
    G.game.slowMo(0.3, 2);
    G.game._victory = true;
    setTimeout(() => { if (G.game.state === 'playing') G.game.gameOver(); }, 2800);
  },

  /* CHEATS: jump straight past the current scripted phase.
     FIX(skip): this used to be silent when the phase scheduler state was
     not ready yet (e.g. SKIP pressed during the first 3s wave gap) — now
     it force-completes by flipping the scheduler to done first, and
     surfaces a HUD message when there is genuinely nothing to skip. */
  skipPhase() {
    if (this.transitioning) return;
    if (this.phase === 1) {
      if (this._p1 && !this._p1.done) { this._p1.done = true; this._p1.waveActive = false; }
      this._completePhase1();
    } else if (this.phase === 2) {
      this._completePhase2();
    } else {
      G.hud.alert('NOTHING TO SKIP — ARENA PHASE', 2);
    }  
  },

  /* ================= set dressing: the launch pad ================= */
  _buildPad() {
    const g = new THREE.Group();
    const hull = new THREE.MeshStandardMaterial({ color: 0x2b313c, roughness: 0.75, metalness: 0.6 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x1c2129, roughness: 0.85, metalness: 0.5 });
    const platform = new THREE.Mesh(new THREE.CylinderGeometry(26, 31, 5, 24), hull);
    platform.position.y = -2.5;
    g.add(platform);
    // emissive landing ring (bloom catches it)
    const ringMat = new THREE.MeshStandardMaterial({ color: 0x0c2833, emissive: 0x2a89b8, emissiveIntensity: 1.4 });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(9, 0.35, 8, 40), ringMat);
    ring.rotation.x = Math.PI / 2; ring.position.y = 0.15;
    g.add(ring);
    // gantry towers
    for (const s of [-1, 1]) {
      const tower = new THREE.Mesh(new THREE.BoxGeometry(3, 22, 3), dark);
      tower.position.set(s * 21, 9, 12);
      g.add(tower);
      const arm = new THREE.Mesh(new THREE.BoxGeometry(9, 1.2, 1.2), dark);
      arm.position.set(s * 16.5, 15, 12);
      g.add(arm);
    }
    // ---- automated PD turrets (support fire, phase 1 — see
    //     Campaign._updatePadTurrets; tuned in CFG.campaign.phase1) ----
    const tHull = new THREE.MeshStandardMaterial({ color: 0x333a44, metalness: 0.7, roughness: 0.5 });
    const tDark = new THREE.MeshStandardMaterial({ color: 0x1e242c, metalness: 0.6, roughness: 0.6 });
    for (const pos of CFG.campaign.phase1.turrets) {
      const grp = new THREE.Group();
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.9, 1.1, 10), tHull);
      base.position.y = 0.55; grp.add(base);
      const yoke = new THREE.Group();
      yoke.position.y = 1.25; grp.add(yoke);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.9, 2.0), tDark);
      housing.position.z = -0.1; yoke.add(housing);
      const sensor = new THREE.Mesh(new THREE.SphereGeometry(0.3, 10, 8),
        new THREE.MeshStandardMaterial({ color: 0x0c2833, emissive: 0x2a89b8, emissiveIntensity: 0.5 }));
      sensor.position.set(0, 0.62, 0.1); yoke.add(sensor);
      const pitchNode = new THREE.Group();
      pitchNode.position.set(0, 0.1, -0.55); yoke.add(pitchNode);
      for (const s of [-1, 1]) {
        const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.14, 2.4, 8), tHull);
        barrel.rotation.x = -Math.PI / 2;
        barrel.position.set(s * 0.3, 0, -1.2);
        pitchNode.add(barrel);
      }
      const muzzle = new THREE.Object3D();
      muzzle.position.set(0, 0, -2.5);
      pitchNode.add(muzzle);
      grp.position.set(pos.x, 0, pos.z);
      g.add(grp);
      this._padTurrets.push({
        yoke, pitchNode, muzzle, glowMat: sensor.material,
        world: new THREE.Vector3(pos.x, 1.25, pos.z),
        yaw: 0, pitch: 0, cd: 1, hot: 0, phase: U.rand(0, Math.PI * 2),
      });
    }
    // the POD — the thing you're defending
    const pod = new THREE.Group();
    pod.add(new THREE.Mesh(new THREE.BoxGeometry(7, 5.5, 8), hull));
    const winMat = new THREE.MeshStandardMaterial({ color: 0x10151d, emissive: 0x2a89b8, emissiveIntensity: 1.1 });
    for (let i = 0; i < 4; i++) {
      const w = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.2, 2.2), winMat);
      w.position.set(3.6, 0.6, -2.5 + i * 1.8);
      pod.add(w);
    }
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.15, 9, 6), dark);
    mast.position.set(0, 6.5, 0);
    pod.add(mast);
    this._podBeacon = new THREE.Mesh(new THREE.SphereGeometry(0.55, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff4050 }));
    this._podBeacon.position.set(0, 11, 0);
    pod.add(this._podBeacon);
    // pod sits toward the right edge of the pad — defended, visible when
    // you look right, but out of the gunner's main sightline
    pod.position.set(13.5, 2.8, 8);
    g.add(pod);
    this.podGroup = pod;
    // pad floodlight
    const l = new THREE.PointLight(0x5fd8ff, 0.9, 160, 2);
    l.position.set(0, 18, 6);
    g.add(l);
    g.visible = false;
    this.pad = g;
    G.scene.add(g);
  },

  /* ================= the ascent corridor spline ================= */
  _buildPath() {
    // waypoints leaving "Earth" (the pad): a climbing, gently weaving climb
    const cp = [
      new THREE.Vector3(0, 24, 0),
      new THREE.Vector3(0, 70, -320),
      new THREE.Vector3(-110, 190, -720),
      new THREE.Vector3(70, 400, -1180),
      new THREE.Vector3(-130, 640, -1650),
      new THREE.Vector3(20, 900, -2100),
      new THREE.Vector3(0, 1140, -2560),
    ];
    const curve = new THREE.CatmullRomCurve3(cp, false, 'catmullrom', 0.5);
    return curve.getSpacedPoints(72);
  },

  /* subtle guide: centerline + ring markers + the exit gate (Ph2 only) */
  _buildCorridorVisual() {
    const P2 = CFG.campaign.phase2;
    const g = new THREE.Group();
    g.add(new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(this.pathPts),
      new THREE.LineBasicMaterial({ color: 0x5fe8ff, transparent: true, opacity: 0.18 })));
    const ringGeo = new THREE.TorusGeometry(P2.tubeRadius, 1.2, 6, 36);
    const ringMat = new THREE.MeshBasicMaterial({ color: 0x5fe8ff, transparent: true,
      opacity: 0.07, blending: THREE.AdditiveBlending, depthWrite: false });
    const zAxis = new THREE.Vector3(0, 0, 1);
    for (let i = 6; i < this.pathPts.length - 2; i += 8) {
      const c = this.pathPts[i];
      const n = this.pathPts[i + 1];
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(c);
      _v1.copy(n).sub(c).normalize();
      ring.quaternion.setFromUnitVectors(zAxis, _v1);
      g.add(ring);
    }
    const last = this.pathPts[this.pathPts.length - 1];
    const prev = this.pathPts[this.pathPts.length - 2];
    this._gate = new THREE.Mesh(new THREE.TorusGeometry(110, 4, 8, 40),
      new THREE.MeshBasicMaterial({ color: 0x5fe8ff, transparent: true, opacity: 0.3,
        blending: THREE.AdditiveBlending, depthWrite: false }));
    this._gate.position.copy(last);
    _v1.copy(last).sub(prev).normalize();
    this._gate.quaternion.setFromUnitVectors(zAxis, _v1);
    g.add(this._gate);
    g.visible = false;
    this._corridorVis = g;
    G.scene.add(g);
  },
};

/* ============================================================
   [SECTION 18] CHEATS — dev console menu
   ------------------------------------------------------------
   OFF by default, never referenced by normal UI, and a separate
   namespace from the stats overlay (Backquote) and the
   autoQuality system — no interference either way.

   TOGGLE: SHIFT + . (period) opens / closes the menu directly.
   The classic Ctrl+Shift+I-D-D-Q-D sequence still works too. Opening
   while flying would fight pointer lock (you can't click what you
   can't see), so the panel pauses the run and releases the lock;
   closing it resumes exactly where you were. Panel is DOM-only; its
   mousedown never reaches the canvas (so no stray shots fired).
============================================================ */
const Cheats = {
  god: false,
  infAmmo: false,
  noclip: false,
  _seq: '',
  _panel: null,
  _uiPause: false,          // run was paused BY this panel (resumes on close)

  init() {
    this._buildPanel();
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey && e.shiftKey)) return;
      const k = (e.key || '').toUpperCase();
      if (!/^[A-Z]$/.test(k)) return;
      // exact-subsequence automaton toward "IDDQD"
      const target = 'IDDQD';
      const next = this._seq + k;
      if (target.startsWith(next)) this._seq = next;
      else this._seq = (k === 'I') ? 'I' : '';
      if (this._seq === target) {
        this._seq = '';
        this.togglePanel();
        e.preventDefault();
      }
    });
  },

  _buildPanel() {
    const d = document.getElementById('cheat-panel');
    this._panel = d;
    d.innerHTML =
      '<div class="cp-head"><span>VL DEV CONSOLE</span><span class="cp-close" id="cp-close">×</span></div>' +
      '<div class="cp-btns">' +
        '<button data-c="god">GOD</button>' +
        '<button data-c="ammo">INF AMMO</button>' +
        '<button data-c="tier">MAX TIER</button>' +
        '<button data-c="noclip">NOCLIP</button>' +
        '<button data-c="ghost">GHOST</button>' +
        '<button data-c="skip">SKIP WAVE / PHASE</button>' +
        '<button data-c="tp">TELEPORT</button>' +
        '<button data-c="oneshot">ONE-SHOT KILLS</button>' +
        '<button data-c="heal">FULL REFIT</button>' +
        '<button data-c="killall">KILL ALL</button>' +
        '<button data-c="slowmo">SLOW MOTION</button>' +
        '<button data-c="turbo">TURBO SHIP</button>' +
        '<button data-c="map">SKIP MAP</button>' +
        /* UPGRADE(cheats v1.3): the power row — full arsenal, asteroid
           purge, total erasure, ally strike wing, 5-boss gauntlet */
        '<button data-c="arsenal">ARSENAL</button>' +
        '<button data-c="nuke">NUKE FIELD</button>' +
        '<button data-c="armageddon">ARMAGEDDON</button>' +
        '<button data-c="wing">STRIKE WING</button>' +
        '<button data-c="gauntlet">BOSS GAUNTLET</button>' +
        /* UPGRADE(cheats v1.5): quality tiers, refits, boss roster —
           live tools for tuning and balance checks */
        '<button data-c="q-2">Q: FULL</button>' +
        '<button data-c="q-1">Q: HALF</button>' +
        '<button data-c="q-0">Q: MIN</button>' +
        '<button data-c="upgmenu">GRANT REFIT…</button>' +
        '<div class="cp-spawn"><span>FORCE BOSS</span>' +
          '<button data-c="b-dread">DREAD</button>' +
          '<button data-c="b-carrier">CARRIER</button>' +
          '<button data-c="b-fortress">FORTRESS</button>' +
          '<button data-c="b-sing">SINGULARITY</button>' +
        '</div>' +
      '</div>' +
      '<div class="cp-spawn"><span>SPAWN FRIENDLY</span>' +
        '<button data-c="s-vanguard">WINGMAN</button>' +
        '<button data-c="s-ally">TESSA</button>' +
        '<button data-c="s-lancer">BULWARK</button>' +
        '<button data-c="s-hornets">HORNETS</button>' +
      '</div>' +
      '<div class="cp-spawn"><span>SPAWN HOSTILE</span>' +
        '<button data-c="s-fighter">FTR</button>' +
        '<button data-c="s-gunship">GUN</button>' +
        '<button data-c="s-bomber">BMB</button>' +
        '<button data-c="s-drone5">DRN×5</button>' +
        '<button data-c="s-mine">MINE</button>' +
        '<button data-c="s-turret">TUR</button>' +
        '<button data-c="s-ravager">RAV</button>' +
        '<button data-c="s-sentinel">SEN</button>' +
        '<button data-c="s-interdictor">INT</button>' +
        '<button data-c="s-interceptor">ICEP</button>' +
        '<button data-c="s-hive">HIVE</button>' +
        '<button data-c="s-elite">ELITE</button>' +
        '<button data-c="s-boss">BOSS</button>' +
        '<button data-c="s-bossalt">BOSS+</button>' +
      '</div>' +
      '<div class="cp-foot">SHIFT+. OPEN/CLOSE — RUN PAUSED</div>';
    d.querySelector('#cp-close').addEventListener('click', () => this.togglePanel());
    d.addEventListener('mousedown', (e) => e.stopPropagation());
    d.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      this._act(b.dataset.c);
      this._sync();
    });
  },

  isOpen() { return !!this._panel && !this._panel.classList.contains('hidden'); },

  /* SHIFT+. / IDDQD / the × button all funnel through here. */
  togglePanel() {
    if (!this._panel) return;
    if (this.isOpen()) {
      this._panel.classList.add('hidden');
      if (this._uiPause && G.game.state === 'paused') G.game.resume();
      this._uiPause = false;
    } else {
      this._panel.classList.remove('hidden');
      this._uiPause = false;
      if (G.game.state === 'playing') {
        this._uiPause = true;
        G.game.pause();
        G.hud.showScreen(null);   // the panel replaces the STANDBY overlay
      }
      G.input.releaseLock();
    }
    this._sync();
  },

  _act(c) {
    // allowed while playing OR while paused BY this panel (its whole
    // purpose); other states (menu / over) have no run to act on
    // FIX: also allow whenever the console is OPEN — a stale _uiPause
    // flag used to brick every button in the panel
    if (G.game.state !== 'playing' && !this._uiPause && !this.isOpen()) return;
    switch (c) {
      case 'god': this.god = !this.god; break;
      case 'ammo': this.infAmmo = !this.infAmmo; break;
      case 'noclip': this.noclip = !this.noclip; break;
      case 'tier': G.player.blasterTier = 2; G.hud.refreshSlots(); break;
      case 'skip': this._skip(); break;
      case 'tp': this._tp(); break;
      /* ---- UPGRADE(cheats): expanded dev toolkit ---- */
      case 'oneshot':
        this.oneShot = !this.oneShot;
        G.hud.alert(this.oneShot ? 'ONE-SHOT KILLS ON' : 'ONE-SHOT KILLS OFF', 2);
        break;
      case 'heal': {
        const p = G.player;
        p.hull = p.maxHull || CFG.combat.hull; p.shield = p.maxShield || CFG.combat.shield;
        p.boostE = CFG.combat.boostEnergy;
        p.missileAmmo = CFG.weapons.seeker.ammoMax;
        p.blasterTier = 2;
        G.hud.refreshSlots();
        G.hud.pop(p.pos, 'FULL REFIT', 'gold');
        break;
      }
      case 'killall': {
        let n = 0;
        for (const e of G.enemies.list) {
          if (!e.alive || e.type === 'boss') continue;
          e.alive = false; n++;
          G.game.onEnemyKilled(e);
        }
        G.hud.alert('TERMINATED ' + n + ' HOSTILES', 2);
        break;
      }
      case 'slowmo':
        G.game.slowMo(this._slow ? 1 : 0.3, 9999);
        this._slow = !this._slow;
        G.hud.alert(this._slow ? 'TIME DILATION 30%' : 'TIME NORMAL', 2);
        break;
      case 'turbo':
        this.turbo = !this.turbo;
        CFG.flight.maxSpeed = this.turbo ? 320 : 130;
        CFG.flight.boostMaxSpeed = this.turbo ? 520 : 235;
        CFG.flight.accel = this.turbo ? 130 : 46;
        G.hud.alert(this.turbo ? 'TURBO ENGINES ONLINE' : 'STOCK ENGINES', 2);
        break;
      /* ---- UPGRADE(cheats v1.3): the power tools ---- */
      case 'ghost':
        // spectral mode: noclip + no ram + hostiles ignore you + hull regen
        this.ghost = !this.ghost;
        if (this.ghost) this.noclip = true;
        G.hud.alert(this.ghost ? 'GHOST MODE — YOU ARE A SPECTER' : 'GHOST MODE OFF', 2.5);
        break;
      case 'arsenal':
        // max blaster tier + every ammo pool topped (kept topped by _sync)
        this.infAmmo = true;
        G.player.blasterTier = 2;
        G.player.missileAmmo = CFG.weapons.seeker.ammoMax;
        G.hud.refreshSlots();
        G.hud.alert('FULL ARSENAL ONLINE — ALL 7 SLOTS', 2.5);
        break;
      case 'nuke': {
        // vaporize the entire belt — every rock detonates, turrets die with
        // their hosts, projectiles reset. (reset() respawns — scatterBelt is
        // the purge; explodeScatter below is just the fireworks.)
        const rocks = G.world.asteroids;
        let nuked = 0;
        for (let i = 0; i < rocks._capacity; i++) {
          if (rocks.dead[i]) continue;
          rocks.damage(i, 1e9, null);
          nuked++;
        }
        G.projectiles.reset();
        G.hud.alert('ASTEROID FIELD PURGED — ' + nuked + ' ROCKS VAPORIZED', 2.5);
        break;
      }
      case 'armageddon': {
        // every hostile on the field simply ceases — boss included
        G.game.slowMo(0.35, 1.1);
        FX.addTrauma(1);
        let killed = 0;
        for (const e of G.enemies.list) {
          if (!e.alive) continue;
          if (e.type === 'boss' && e.hitSpheres) {
            // FIX: same undefined-core crash as _skip — harden identically
            const core = e.hitSpheres.find((h) => h.isCore && h.alive);
            if (core) e.damagePart(core, 1e9, e.pos, null);
            else if (e._startDeath) e._startDeath();
          } else {
            e.alive = false;
            FX.explosion(e.pos, e.type === 'interdictor' ? 12 : 7);
            G.game.onEnemyKilled(e);
          }
          killed++;
        }
        G.hud.alert('ARMAGEDDON — ' + killed + ' SIGNATURES ERASED', 3);
        break;
      }
      case 'wing': {
        // combined-arms strike wing: gunship + drone wing, instantly
        Enemies._ringPos(_v1, 180, 320, 0.5);
        if (G.waves.lancerAlly) G.waves.lancerAlly.dispose();
        G.waves.lancerAlly = new LancerAlly(_v1);
        if (G.waves.hornets) G.waves.hornets.dispose();
        G.waves.hornets = new HornetWing(_v1, 3);
        G.hud.alert('STRIKE WING ON STATION — BULWARK + 3 HORNETS', 3);
        break;
      }
      case 'gauntlet': {
        // five named dreadnoughts at once. Good luck.
        for (let i = 0; i < 5; i++) {
          Enemies._ringPos(_v1, 700 + i * 90, 950 + i * 110, 0.8);
          const gb = new Boss(_v1, (G.waves.wave || 5) + i * 2, 1 + i * 0.15, i + 1);
          G.enemies.list.push(gb);
        }
        G.waves.boss = G.enemies.list[G.enemies.list.length - 1];
        G.hud.alert('BOSS GAUNTLET — 5 CAPITAL SIGNATURES', 3.5);
        G.audio.alarm();
        break;
      }
      case 'map':
        if (G.campaign.mode === 'adventure' && G.campaign.phase === 3) {
          G.campaign.onMapCleared();
          // FIX(dark screen): the refit CHOICE's confirm → _fadeTransition
          // needs a live run; resume out of the console pause like SKIP does
          this._consoleResume();
        } else G.hud.alert('MAP SKIP: ADVENTURE ARENA ONLY', 2);
        break;
      /* ---- friendly spawns ---- */
      case 's-vanguard':
        Wingmen.spawn(1);
        G.hud.alert('WINGMAN DEPLOYED', 2);
        break;
      case 's-ally':
        Enemies._ringPos(_v1, 260, 420, 0.5);
        if (G.waves.ally) G.waves.ally.dispose();
        G.waves.ally = new Ally(_v1);
        G.hud.alert('TESSA ON STATION — SHIELD AURA ACTIVE', 2);
        break;
      /* ---- UPGRADE(cheats v1.3): new allied spawns ---- */
      case 's-lancer':
        Enemies._ringPos(_v1, 180, 320, 0.5);
        if (G.waves.lancerAlly) G.waves.lancerAlly.dispose();
        G.waves.lancerAlly = new LancerAlly(_v1);
        G.hud.alert('BULWARK ON STATION — SUPPORT GUNSHIP', 2);
        break;
      case 's-hornets':
        Enemies._ringPos(_v1, 80, 160, 0.5);
        if (G.waves.hornets) G.waves.hornets.dispose();
        G.waves.hornets = new HornetWing(_v1, 3);
        G.hud.alert('HORNET WING DEPLOYED — 3 DRONES', 2);
        break;
      /* ---- hostile spawns ---- */
      case 's-fighter': G.enemies.spawnFighter({}); break;
      case 's-gunship': G.enemies.spawnGunship({}); break;
      case 's-bomber': G.enemies.spawnBomber({}); break;
      case 's-drone5':
        for (let i = 0; i < 5; i++) G.enemies.spawnDrone({});
        break;
      case 's-mine': G.enemies.spawnMine(); break;
      case 's-turret':
        Enemies._ringPos(_v1, 140, 260, 0.6);
        G.enemies.spawnTurret(-1, null, _v1.clone());
        break;
      case 's-boss': {
        Enemies._ringPos(_v1, 750, 950, 0.8);
        const b = new Boss(_v1, G.waves.wave || 5, 1, 0);
        G.enemies.list.push(b);
        G.waves.boss = b;
        break;
      }
      case 's-ravager': G.enemies.spawnRavager({}); break;
      case 's-sentinel': G.enemies.spawnSentinel({}); break;
      case 's-interceptor': G.enemies.spawnInterceptor({}); break;
      case 's-hive':
        G.enemies.spawnHive({});
        G.hud.alert('HIVE INBOUND — DRONE BURSTS IMMINENT', 3);
        break;
      case 's-elite': {  // v1.4: force a full elite (modifier + stripe)
        const ee = G.enemies.spawnFighter({ elite: true });
        G.hud.alert('ELITE ' + (ee.eliteMod || 'HVT') + ' DEPLOYED', 2.5);
        break;
      }
      case 's-interdictor':
        G.enemies.spawnInterdictor({});
        G.hud.alert('INTERDICTOR INBOUND — GRAVITY WELL ACTIVE', 3);
        break;
      case 's-bossalt': {
        // cycle through the named variants
        this._bossAlt = ((this._bossAlt || 0) + 1) % BOSS_VARIANTS.length;
        Enemies._ringPos(_v1, 750, 950, 0.8);
        const b2 = new Boss(_v1, (G.waves.wave || 5) + 3, 1.5, this._bossAlt);
        G.enemies.list.push(b2);
        G.waves.boss = b2;
        G.hud.alert(BOSS_VARIANTS[this._bossAlt].name + ' INBOUND', 3);
        break;
      }
      /* ---- UPGRADE(cheats v1.5): live quality tiers + refits + boss roster ---- */
      case 'q-2': case 'q-1': case 'q-0': {
        const lv = parseInt(c.slice(2), 10);
        CFG.fx.quality = lv;                 // particle budget tier
        G.hud.alert('FX QUALITY: ' + (lv === 2 ? 'FULL' : lv === 1 ? 'HALF' : 'MINIMAL'), 2);
        break;
      }
      case 'upgmenu': {
        // grant any pool refit on demand — cycles through the pool
        const poolIds = CFG.upgrades.pool.map((u) => u.id);
        const nid = poolIds[this._upgIdx = ((this._upgIdx || 0) + 1) % poolIds.length];
        G.player.applyUpgrade(nid);
        G.hud.alert('REFIT GRANTED: ' + nid.toUpperCase(), 2.2);
        break;
      }
      case 'b-dread': case 'b-carrier': case 'b-fortress': case 'b-sing': {
        const archMap = { 'b-dread': 0, 'b-carrier': 2, 'b-fortress': 3, 'b-sing': 5 };
        Enemies._ringPos(_v1, 750, 950, 0.8);
        const bb = new Boss(_v1, (G.waves.wave || 5) + 3, 1.5, archMap[c]);
        G.enemies.list.push(bb);
        G.waves.boss = bb;
        G.hud.alert(BOSS_VARIANTS[archMap[c]].name + ' INBOUND', 3);
        G.audio.alarm();
        break;
      }
    }
    G.audio.ui();
  },

  /* FIX(skip): actions that advance the campaign fire real phase cuts
     (_fadeTransition swaps the world only while state === 'playing').
     The console PAUSES the run while it's open, so a skip from the panel
     aborted silently and the screen just stayed dark. Closing the panel
     here resumes the run — exactly what a manual close does — so the cut
     actually lands. */
  _consoleResume() {
    if (this._uiPause && G.game.state === 'paused') {
      this._panel.classList.add('hidden');
      this._uiPause = false;
      G.game.resume();
    }
  },

  /* skip: scripted phases jump to their completion; in the arena it
     force-clears the live wave (kills route through the normal pipeline
     so score/drops still happen; the boss plays its death sequence). */
  _skip() {
    const camp = G.campaign;
    if (camp.phase === 1 || camp.phase === 2) {
      camp.skipPhase();
      this._consoleResume();   // FIX: let the phase-cut actually execute
      return;
    }
    const w = G.waves;
    if (w.state === 'lull') { w.lullT = 0.01; return; }
    // FIX(skip): this body used to run only under state 'active' — with
    // the console's pause active the wave state could be anything, and
    // SKIP did literally nothing. Queue/field wipe is safe in any state.
    w.queue.length = 0;
    let killed = 0;
    for (const e of G.enemies.list) {
      if (!e.alive) continue;
      if (e.type === 'boss') {
        // FIX: find() can return undefined (core part already destroyed)
        // — that threw inside damagePart and silently killed the whole
        // skip. Fall back to starting the death sequence directly.
        const core = e.hitSpheres && e.hitSpheres.find((h) => h.isCore && h.alive);
        if (core) e.damagePart(core, 1e9, e.pos, null);
        else if (e._startDeath) e._startDeath();
      } else if (e.waveEnemy || e.type === 'mine') {
        e.alive = false;
        G.game.onEnemyKilled(e);
        killed++;
      }
    }
    G.hud.alert('WAVE SKIPPED — ' + killed + ' HOSTILES REMOVED', 2);
  },

  _tp() {
    // phase 1: the ship is clamped to the pad — teleporting it off the
    // launch ring would break the phase, so the cheat is a no-op there
    if (G.campaign.phase === 1) return;
    const p = G.player;
    const aim = p.getAimDir(_v1);
    _v2.copy(p.pos).addScaledVector(aim, 650);
    if (_v2.length() > CFG.world.boundary * 0.95) _v2.setLength(CFG.world.boundary * 0.95);
    p.pos.copy(_v2);
    p.vel.set(0, 0, 0);
    p.group.position.copy(p.pos);
    FX.rings.spawn(p.pos, 30, 0x5fe8ff, 0.6);
  },

  _sync() {
    if (!this._panel || this._panel.classList.contains('hidden')) return;
    const set = (c, on) => {
      const b = this._panel.querySelector('[data-c="' + c + '"]');
      if (b) b.classList.toggle('on', !!on);
    };
    set('god', this.god);
    set('ammo', this.infAmmo);
    set('noclip', this.noclip);
    set('oneshot', this.oneShot);
    set('slowmo', !!this._slow);
    set('turbo', !!this.turbo);
    set('ghost', !!this.ghost);
    set('arsenal', !!this.infAmmo);   // arsenal = infAmmo + max tier
    set('arsenal', !!this.infAmmo);   // arsenal is infAmmo + max tier
  },
};

/* ============================================================================
   [SECTION 16] GLOBAL CONTEXT + BOOT + MAIN LOOP
   ------------------------------------------------------------
   G is the service locator every subsystem talks through. Boot
   order matters (comments inline). The loop is a single rAF:
     hotkeys → game.update(sim) → render (composer or plain)
     → input.endFrame()
   Adaptive quality watches an FPS EMA and degrades pixel ratio
   first, bloom second — the game stays playable on weak GPUs.
============================================================ */
const G = {};   // { app, renderer, scene, camera, composer, bloom, audio,
                 //   input, FX, world, projectiles, pickups, player,
                 //   camRig, enemies, waves, hud, game }

// ---- hard dependency check: did the CDN actually answer? ----
if (!window.THREE) {
  document.getElementById('screen-start').classList.add('hidden');
  const err = document.getElementById('screen-error');
  err.classList.remove('hidden');
  document.getElementById('error-msg').textContent =
    'Three.js failed to load from the CDN. Check your network connection ' +
    '(or mirror jsdelivr with another r128 CDN) and reload.';
  throw new Error('THREE missing — CDN unreachable');
}

let statsOn = false;

/* ---- IMPACT POST PASS — chromatic aberration + radial
   blur, driven by FX.pulse. Fires on big hits, overcharged lance
   releases, weak-point pops and boss deaths. Quality ladder disables
   the whole pass below Q3 (FX budget tiers 0/1). ---- */
const ImpactShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 0 } },
  vertexShader: `varying vec2 vUv; void main(){ vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse; uniform float uAmount; varying vec2 vUv;
    void main(){
      vec2 dir = vUv - 0.5;
      float dist = length(dir);
      float a = uAmount;
      // chromatic aberration: RGB channels offset radially, edge-weighted
      vec2 off = dir * a * (0.35 + dist * 1.7);
      float r = texture2D(tDiffuse, vUv + off).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv - off).b;
      vec3 col = vec3(r, g, b);
      // radial blur: 4 cheap taps pulled toward the center, edge-weighted
      if (a > 0.003) {
        float blur = a * 0.055 * dist;
        vec3 acc = col;
        for (int i = 1; i <= 4; i++) {
          float t = float(i) / 4.0;
          acc += texture2D(tDiffuse, vUv - dir * blur * t).rgb;
        }
        col = acc / 5.0;
      }
      gl_FragColor = vec4(col, 1.0);
    }`,
};

/* ---- UPGRADE(graphics): procedural equirect environment ------------------
   A 1024x512 canvas: deep-space vertical gradient, soft nebula blobs and a
   starfield. Fed through PMREMGenerator it becomes scene.environment, so
   every MeshStandardMaterial (ships, rocks, stations) picks up believable
   star reflections with ZERO ongoing GPU cost after the one-time bake. */
function buildEnvironment(renderer, scene) {
  try {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 512;
    const x = c.getContext('2d');
    // vertical gradient: deep nadir → brighter galactic band at horizon → dark zenith
    const grad = x.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0.0, '#010208');
    grad.addColorStop(0.35, '#0a1626');
    grad.addColorStop(0.5, '#12233b');
    grad.addColorStop(0.65, '#0a1626');
    grad.addColorStop(1.0, '#010208');
    x.fillStyle = grad; x.fillRect(0, 0, 1024, 512);
    // nebula blobs (screen-blended so they tint the metal)
    x.globalCompositeOperation = 'screen';
    const blobs = [
      [180, 190, 260, 'rgba(38,120,150,0.55)'], [420, 140, 200, 'rgba(120,40,140,0.45)'],
      [700, 240, 300, 'rgba(30,70,150,0.5)'], [860, 160, 180, 'rgba(150,80,40,0.35)'],
      [560, 330, 240, 'rgba(40,110,130,0.4)'], [80, 320, 200, 'rgba(90,40,120,0.4)'],
      [300, 60, 160, 'rgba(200,120,60,0.3)'],
    ];
    for (const [bx, by, r, col] of blobs) {
      const g2 = x.createRadialGradient(bx, by, 0, bx, by, r);
      g2.addColorStop(0, col); g2.addColorStop(1, 'rgba(0,0,0,0)');
      x.fillStyle = g2; x.fillRect(bx - r, by - r, r * 2, r * 2);
    }
    // the sun as one hot spot (drives the specular highlight on hulls)
    const sg = x.createRadialGradient(770, 205, 0, 770, 205, 90);
    sg.addColorStop(0, 'rgba(255,245,225,1)');
    sg.addColorStop(0.25, 'rgba(255,215,150,0.9)');
    sg.addColorStop(1, 'rgba(255,180,90,0)');
    x.fillStyle = sg; x.fillRect(680, 115, 180, 180);
    // starfield: 900 tiny white dots with a few colored giants
    x.globalCompositeOperation = 'lighter';
    for (let i = 0; i < 900; i++) {
      const px = Math.random() * 1024, py = Math.random() * 512;
      const s = Math.random() < 0.06 ? 1.6 : 0.7;
      const t = Math.random();
      x.fillStyle = t < 0.75 ? 'rgba(255,255,255,0.9)'
        : t < 0.88 ? 'rgba(160,200,255,0.9)' : 'rgba(255,220,170,0.9)';
      x.fillRect(px, py, s, s);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromEquirectangular(tex);
    scene.environment = rt.texture;
    tex.dispose(); pmrem.dispose();
    return true;
  } catch (e) { console.warn('Env map unavailable, standard reflections only.', e); return false; }
}

function boot() {
  const app = document.getElementById('app');

  /* ---- renderer / scene / camera ---- */
  // FIX(perf): MSAA allocates a multisampled default framebuffer that is
  // NEVER used when the composer owns rendering — only enable it for the
  // plain-render fallback path.
  const postReady = !!(THREE.EffectComposer && THREE.RenderPass && THREE.ShaderPass &&
    THREE.CopyShader && THREE.LuminosityHighPassShader && THREE.UnrealBloomPass);
  const renderer = new THREE.WebGLRenderer({ antialias: !postReady, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, CFG.render.maxPixelRatio));
  renderer.setSize(window.innerWidth, window.innerHeight);
  // UPGRADE(graphics): filmic tone curve + linear-to-sRGB output. Everything
  // emissive gets a nicer highlight roll-off, and color stops looking like
  // a flat 1998 texture dump. Cheap: it's just output-shader math.
  if (CFG.render.toneMapping && THREE.ACESFilmicToneMapping !== undefined) {
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = CFG.render.exposure;
  }
  // NOTE(output encoding): deliberately NOT switching outputEncoding. With
  // EffectComposer the internal targets stay linear in r128, so sRGB would
  // apply ONLY on the no-composer fallback path — making the two paths look
  // different. ACES (applied per-material, both paths) is the safe win.
  renderer.info.autoReset = false;   // we reset manually AFTER composer passes
  app.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x02030a);
  // UPGRADE(graphics): whisper of exp2 fog — gives distant rocks aerial
  // perspective and hides the far-plane pop-in. Background is a dome at
  // 16k so it stays untouched by fog.
  if (CFG.render.fogDensity > 0 && THREE.FogExp2) {
    scene.fog = new THREE.FogExp2(0x040810, CFG.render.fogDensity);
  }
  // UPGRADE(graphics): PMREM starfield environment → real reflections on
  // every metal hull. One-time bake, zero per-frame cost.
  if (CFG.render.envRefl) buildEnvironment(renderer, scene);
  const camera = new THREE.PerspectiveCamera(CFG.render.fov,
    window.innerWidth / window.innerHeight, CFG.render.near, CFG.render.far);
  camera.position.set(0, 4, 16);

  G.app = app; G.renderer = renderer; G.scene = scene; G.camera = camera;

  /* ---- post-processing (bloom) — guarded so the game still runs
     if the example scripts didn't load ---- */
  G.composer = null; G.bloom = null; G.impactPass = null;
  try {
    if (THREE.EffectComposer && THREE.RenderPass && THREE.UnrealBloomPass) {
      const composer = new THREE.EffectComposer(renderer);
      composer.addPass(new THREE.RenderPass(scene, camera));
      const bloom = new THREE.UnrealBloomPass(
        new THREE.Vector2(window.innerWidth, window.innerHeight),
        CFG.render.bloomStrength, CFG.render.bloomRadius, CFG.render.bloomThreshold);
      // FIX(perf): render the bloom pyramid at reduced resolution. The patch
      // lives in setSize so it survives every composer.setSize() (resizes,
      // quality drops). Visually near-identical for glow effects.
      const bs = U.clamp(CFG.render.bloomRes || 0.5, 0.25, 1);
      const bloomSetSize = bloom.setSize.bind(bloom);
      bloom.setSize = (w, h) => bloomSetSize(
        Math.max(64, Math.round(w * bs)), Math.max(64, Math.round(h * bs)));
      composer.addPass(bloom);
      // impact pass (CA + radial blur) — last in the chain.
      // EffectComposer renders to screen only when the final pass renders
      // to screen; ShaderPass default renderToScreen handling in r128
      // composer works via pass order (last pass outputs to screen).
      const impact = new THREE.ShaderPass(ImpactShader);
      composer.addPass(impact);
      impact.renderToScreen = true;
      bloom.renderToScreen = false;
      G.composer = composer; G.bloom = bloom; G.impactPass = impact;
    }
  } catch (e) { console.warn('Bloom unavailable, rendering plain.', e); }

  /* ---- subsystems (ORDER MATTERS) ---- */
  G.audio = new AudioSys();                       // 1. audio (inert until click)
  G.music = new Music(G.audio);                   // layered score
  G.input = new Input(renderer.domElement);        // 2. input listeners
  G.FX = FX; FX.init(scene);                       // 3. particle/debris pools
  G.world = World; World.init();                   // 4. sky, planets, asteroids...
  G.projectiles = Projectiles; Projectiles.init(scene);
  G.pickups = Pickups;
  G.enemies = Enemies;                             // 5. manager (turrets seeded on reset)
  G.player = new Player();                         // 6. the ship
  G.camRig = new CameraRig(camera);                // 7. chase camera
  G.waves = Waves;                                 // 8. wave director
  G.game = Game; Game.loadBest();                  // 9. game core (BEFORE HUD: HUD.init reads best)
  G.hud = HUD; HUD.init();                         // 10. DOM HUD
  G.campaign = Campaign; Campaign.init();          // 11. campaign phases (pad + corridor set dressing)
  G.cheats = Cheats; Cheats.init();               // 12. gated dev console (DOM only)

  /* ---- pick initial scatter (bait in the belt) ---- */
  Pickups.reset();   // reset() clears (empty here) then scatters one full set

  /* ---- wire screens: mode select is the new entry point ---- */
  const launch = (mode) => () => {
    G.audio.init();
    G.music.init();          // the score joins on first gesture
    G.input.requestLock();
    Game.startRun(mode);
  };
  document.getElementById('btn-endless').addEventListener('click', launch('endless'));
  document.getElementById('btn-adventure').addEventListener('click', launch('adventure'));
  document.getElementById('screen-pause').addEventListener('click', () => {
    G.audio.init();
    G.input.requestLock();
    Game.resume();
  });
  // touch devices: on-screen pause button (phones have no Esc/P)
  const pauseBtn = document.getElementById('btn-touch-pause');
  if (pauseBtn) {
    pauseBtn.addEventListener('click', () => { if (G.game.state === 'playing') G.game.pause(); });
  }
  document.getElementById('btn-restart').addEventListener('click', () => {
    G.audio.init();
    G.input.requestLock();
    Game.startRun();          // no mode arg = relaunch the same mode
  });
  document.getElementById('btn-mode').addEventListener('click', () => {
    G.audio.ui();
    Game.toMenu();
  });

  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => { if (document.hidden && G.game) G.game.pause(); });
  window.addEventListener('blur', () => { if (G.game && G.game.state === 'playing') G.game.pause(); });
  window.addEventListener('error', (e) => {
    if (HUD.el && Game.state !== 'over') {
      HUD.showError('Runtime fault: ' + (e.message || 'unknown') + ' — see console (F12).');
    }
  });

  Game.state = 'menu';
  HUD.showScreen('start');
  HUD.refreshBest();
  requestAnimationFrame(frame);
}

function onResize() {
  const w = window.innerWidth, h = window.innerHeight;
  G.camera.aspect = w / h;
  G.camera.updateProjectionMatrix();
  G.renderer.setSize(w, h);
  if (G.composer) G.composer.setSize(w, h);
}

/* ---- edge-triggered hotkeys (polled once per frame) ---- */
function handleHotkeys() {
  const inp = G.input, st = G.game.state;
  /* CHEATS menu: SHIFT + . toggles the dev console in any state.
     (e.code stays 'Period' even when Shift renders it as '>'). Shift can
     arrive as a held key code OR as the event modifier — accept both. */
  if (inp.justKey('Period') &&
      (inp.justShift || inp.key('ShiftLeft') || inp.key('ShiftRight'))) {
    G.cheats.togglePanel();
    return;   // don't let the same keypress double as something else
  }
  // while the cheat panel is up it IS the pause UI — swallow the
  // normal pause/restart/menu hotkeys so they can't fight it
  if (G.cheats.isOpen()) return;
  if (st === 'playing') {
    /* CAMPAIGN: F toggles the view except during the scripted pad phase
       (the turret camera is the phase — the stored preference still
       applies once the arena starts). */
    if (inp.justKey('KeyF') && !(G.campaign.phase === 1)) G.camRig.toggleMode();
    if (inp.justKey('KeyM')) {
      G.audio.setMuted(!G.audio.muted);   // FIX: was setMute() which doesn't exist — M key threw a TypeError
      G.hud.alert(G.audio.muted ? 'AUDIO MUTED' : 'AUDIO ON', 1.2);
    }
    if (inp.justKey('KeyP')) { G.game.pause(); inp.releaseLock(); }
    if (inp.justKey('Backquote')) statsOn = !statsOn;
  } else if (st === 'paused') {
    if (inp.justKey('KeyP')) { G.input.requestLock(); G.game.resume(); }
  } else if (st === 'over') {
    if (inp.justKey('KeyR')) { G.audio.init(); G.input.requestLock(); G.game.startRun(); }
    if (inp.justKey('KeyB')) { G.game.toMenu(); }        // CAMPAIGN: mode select
  } else if (st === 'menu') {
    if (inp.justKey('Enter')) document.getElementById('btn-endless').click();
    if (inp.justKey('KeyA')) document.getElementById('btn-adventure').click();
  }
}

/* ---- stats + adaptive quality ---- */
let _last = performance.now(), _fpsEMA = 60, _lowT = 0, _highT = 0, _qLevel = 0, _statsT = 0;

function frame(t) {
  requestAnimationFrame(frame);
  const dtRaw = U.clamp((t - _last) / 1000, 0, 0.05);
  _last = t;

  if (G.input.touch) G.input.pollTouch();

  handleHotkeys();
  Game.update(dtRaw);
  if (Game.state === 'menu' || Game.state === 'paused' || Game.state === 'over') {
    G.audio.engineSet(0, false);
  }

  /* SYSTEM(v1.5): music intensity — a smoothed blend of live-enemy
     pressure, wave state and the boss flag. Layers crossfade; no cuts. */
  if (G.music && G.music.ready) {
    const playing = Game.state === 'playing';
    const pressure = playing
      ? U.clamp(G.enemies.countAlive() / 9, 0, 1) * (G.waves.state === 'active' ? 1 : 0.4)
      : 0;
    const bossLive = !!(G.waves.boss && G.waves.boss.alive);
    G.music.update(dtRaw, playing ? Math.max(0.12, pressure) : 0, bossLive);
  }
  /* SYSTEM(v1.5): impact post pass reads the pulse envelope; the quality
     ladder retires the whole pass on weak GPUs (Q3+). */
  if (G.impactPass) {
    G.impactPass.enabled = _qLevel < 3 && CFG.postfx.caStrength > 0;
    G.impactPass.uniforms.uAmount.value = FX.pulse * CFG.postfx.caStrength;
  }

  // keep point sizes honest through FOV kicks & resizes
  FX.particles.syncScale(G.camera, G.renderer.domElement.height);

  /* ---- render ---- */
  if (G.composer) G.composer.render();
  else G.renderer.render(G.scene, G.camera);

  /* ---- stats + adaptive quality ---- */
  if (dtRaw > 0.0001) _fpsEMA = _fpsEMA * 0.95 + (1 / dtRaw) * 0.05;
  if (CFG.render.autoQuality) {
    if (_fpsEMA < 42) { _lowT += dtRaw; _highT = Math.max(0, _highT - dtRaw); }
    else if (_fpsEMA > 57) { _highT += dtRaw; _lowT = Math.max(0, _lowT - dtRaw * 0.5); }
    else { _lowT = Math.max(0, _lowT - dtRaw * 0.5); _highT = Math.max(0, _highT - dtRaw); }
    /* UPGRADE(perf): deeper fallback ladder + RECOVERY. The old ladder had
       two steps and never went back up. Now: pixel ratio first, then bloom,
       then FX budget, then trails — and 12s of sustained good FPS walks the
       quality back UP one stage, so beefy machines reclaim eye candy after
       a transient load spike. */
    const setLevel = (lv) => {
      _qLevel = lv;
      const pr = [Math.min(window.devicePixelRatio || 1, CFG.render.maxPixelRatio), 1.25, 1, 0.85, 0.75][lv];
      G.renderer.setPixelRatio(pr);
      if (G.composer) G.composer.setPixelRatio(pr);
      if (G.bloom) G.bloom.strength = CFG.render.bloomStrength * [1, 1, 0.6, 0.45, 0][lv];
      CFG.fx.quality = lv >= 4 ? 0 : (lv >= 3 ? 1 : 2);
      Projectiles.setTrailsVisible(lv <= 2);
    };
    if (_lowT > 4 && _qLevel === 0) setLevel(1);
    else if (_lowT > 8 && _qLevel === 1) setLevel(2);
    else if (_lowT > 12 && _qLevel === 2) setLevel(3);
    else if (_lowT > 16 && _qLevel === 3) setLevel(4);
    else if (_highT > 12 && _qLevel > 0) { setLevel(_qLevel - 1); _highT = 0; }
  }
  if (statsOn) {
    _statsT += dtRaw;
    if (_statsT > 0.25) {
      _statsT = 0;
      const inf = G.renderer.info;
      HUD.el.statsPanel.style.display = 'block';
      HUD.el.statsPanel.textContent =
        `FPS ${_fpsEMA.toFixed(0)}   Q${_qLevel}   calls ${inf.render.calls}   tris ${(inf.render.triangles / 1000).toFixed(0)}k\n` +
        `particles ${FX.particles.alive}   projectiles ${Projectiles.activeCount()}   enemies ${G.enemies.countAlive()}\n` +
        `combo x${G.game.combo.toFixed(2)}   scale ${G.game.timeScale.toFixed(2)}   ${G.composer ? 'bloom' : 'plain'}`;
    }
  } else if (HUD.el.statsPanel.style.display === 'block') {
    HUD.el.statsPanel.style.display = 'none';
  }

  G.renderer.info.reset();
  G.input.endFrame();
}

/* ---- debug API: poke the game from the console / tests ---- */
window.__VL = {
  G, CFG, U,
  start(mode) { if (!G.audio.ready) G.audio.init(); Game.startRun(mode); },
  wave(n) { G.waves.startWave(n || 1); },
  boss(n) { Enemies._ringPos(_v1, 750, 950, 0.8); const b = new Boss(_v1, n || 5); G.enemies.list.push(b); G.waves.boss = b; return b; },
  kill() { G.player.damage(9999, G.player.pos); },
  fire(n) { for (let i = 0; i < (n || 60); i++) { U.randomDir(_v1); _v2.copy(G.player.pos); Projectiles.fire('bolt', 'player', _v2, _v1, { speed: 600, dmg: 6, life: 2 }); } },
  ship(k) { // swap chassis mid-run (CFG.chassis keys); falls back to default
    G.game.shipSel = CFG.chassis[k] ? k : CFG.chassisDefault;
    G.player.reset();
    G.player.spawnGuard = 0.5;
    G.hud.alert(CFG.chassis[G.game.shipSel].name + ' CHASSIS SWAP', 2.5);
    return CFG.chassis[G.game.shipSel].name;
  },
  interdictor() { G.enemies.spawnInterdictor({}); },
  allies() { // deploy the full strike wing anywhere
    Enemies._ringPos(_v1, 180, 320, 0.5);
    if (G.waves.lancerAlly) G.waves.lancerAlly.dispose();
    G.waves.lancerAlly = new LancerAlly(_v1);
    if (G.waves.hornets) G.waves.hornets.dispose();
    G.waves.hornets = new HornetWing(_v1, 3);
    return 'Bulwark + 3 Hornets deployed';
  },
  explode(pos, r) { Projectiles._explode(pos || G.player.pos, r || 30, 40, false); },
  stats() { statsOn = !statsOn; },
  // CAMPAIGN / CHEATS hooks
  campaign: () => G.campaign,
  cheats: () => G.cheats,
  map(i) { G.campaign._startMap(i | 0); },
  phase(n) { // jump straight into a phase (1 pad | 2 ascent | 3 arena)
    if (n === 1) G.campaign._startPhase1();
    else if (n === 2) G.campaign._startPhase2();
    else G.campaign._startPhase3();
  },
  unlockCheats() { G.cheats.togglePanel(); },
};

boot();

