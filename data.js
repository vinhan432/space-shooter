/* ============================================================
   DATA.JS — pure configuration (no logic, no rendering)
   ------------------------------------------------------------
   LOAD ORDER: 1st. Defines: CFG (every tunable in the game),
   MAPS (adventure roster). Everything downstream reads these.
   Split from the old monolithic core — data untouched.
============================================================ */

const CFG = {
  render: {
    maxPixelRatio: 1.75,     // clamp devicePixelRatio (perf)
    bloomStrength: 1.05,     // UnrealBloomPass strength
    bloomRadius: 0.55,
    bloomThreshold: 0.45,    // grey hull stays under this → no bloom
    bloomRes: 0.5,           // FIX(perf): bloom mip chain runs at half res —
                             // glow is low-frequency so it looks the same,
                             // but costs ~4x fewer blur pixels on the GPU
    toneMapping: true,       // UPGRADE: ACES filmic curve — cinematic roll-off,
                             // highlights bloom instead of clipping to white
    exposure: 1.12,          // ACES exposure compensation
    envRefl: true,           // UPGRADE: PMREM environment — metals pick up
                             // real starfield/nebula reflections for free
    fogDensity: 0,           // opt-in exp2 fog — NOTE: left OFF because the
                             // sun/nebula sprites live at 8.5k-13.5k and a
                             // global fog would smear them out (depth cues
                             // already come from the dust + star parallax)
    fov: 68,                 // base third-person FOV (degrees)
    fovCockpit: 76,
    near: 0.1, far: 40000,
    autoQuality: true,       // drop pixel ratio if FPS tanks
    trails: true,            // NEW: additive tracer streaks behind projectiles
    trailTime: 0.05,         // streak length = speed * this, capped per style
  },

  flight: {
    /* --- translation --- */
    accel: 46,               // forward thrust, u/s^2
    strafe: 32,              // lateral thrust
    vert: 26,                // vertical thrust
    boostMult: 2.35,         // thrust multiplier while boosting
    maxSpeed: 130,           // normal terminal speed (u/s)
    boostMaxSpeed: 235,
    drag: 0.55,              // exponential drag coefficient (per second)
    softClampRate: 3.5,      // how fast overspeed bleeds back to max
    /* --- rotation --- */
    pitchRate: 1.9,          // max angular rates, rad/s
    yawRate: 1.45,
    rollRate: 2.6,
    angResponse: 8.5,        // rotational inertia: smoothing rate toward
                             // commanded rate (higher = snappier)
    cursorRadius: 250,       // virtual cursor clamp (px from screen center)
    deadzone: 14,            // px of centered mouse that does nothing
    /* --- steering assist (settings.steerAssist) ---
       The virtual cursor is a persistent RATE command: after a small
       mouse move the ship keeps rotating until the cursor is moved back.
       With the assist on, an IDLE mouse bleeds the cursor back to center
       — but only inside assistRadius, so deliberate hard turns (cursor
       parked at the rim) keep their full authority. */
    assistDelay: 0.28,       // s of mouse idle before the bleed starts
    assistRadius: 120,       // px — beyond this the cursor is a turn command
    assistRate: 7,           // bleed rate at center (per second)
    /* --- inertial flight model (settings.flightModel) --- */
    inertialDragMult: 0.12,  // drag multiplier in INERTIAL mode
                             // (0.55/s → 0.066/s: momentum carries)
  },

  combat: {
    shield: 100, hull: 100,
    shieldRegen: 12,         // shield/sec after delay (was 14 — see below)
    shieldDelay: 6.5,        // seconds out of fire before regen (was 5:
                             // retreat-heal-and-return was near-free)
    boostEnergy: 100,
    boostDrain: 34, boostRegen: 16, boostMin: 12, // engage floor
    boostRearm: 35,          // meter must climb back here after a FULL
                             // burnout before the burner can re-engage
                             // (no more flickering pulses at the floor)
    playerRadius: 2.6,       // player collision sphere
    contactCooldown: 0.4,    // min seconds between collision damages
    contactImpactMin: 12,    // u/s below this is a scrape, not a hit
    contactDmgFactor: 0.65,  // damage per u/s above the floor
    contactDmgMax: 60,       // per-hit damage cap
    spawnGuard: 2.5,         // invulnerability right after launch
  },

  weapons: {
    aimAssist: 0.22,         // lance/seekers fixed-cone assist
    assistCone: 0.09,        // UPGRADE(feel): widened 0.075 → 0.09 — the lance
                             // catches near-misses instead of punishing them
    assistRange: 820,
    // UPGRADE(feel): blaster assist widened + strengthened with linear
    // falloff — easier to shoot, still reads as your aim (not auto-aim)
    // v1.3: assist cone/strength up again (easier to shoot & aim);
    // assistRange up 680→820 so far targets get help too.
    assistConeBlaster: 0.16, // ~9.2° catch cone (easier shooting)
    aimAssistBlaster: 0.58,  // peak lerp at cone center
    assistConePulse: 0.13,   // pulse lance: nearly the blaster's generosity
    aimAssistPulse: 0.5,
    assistConeRail: 0.2,     // railgun: zero-spread heavy hitter — most help
    aimAssistRail: 0.6,
    convergeDist: 620,
    /* FIX(weapons)+UPGRADE(feel): blaster projectile speed 760 → 850 —
       leading a crossing target at normal engagement range (300-500u)
       no longer demands a full ship-length of lead. Still the baseline
       weapon: highest fire rate, lowest per-shot damage. */
    blaster: { name: 'PULSE BLASTER', rate: 8, dmg: 7, speed: 850,
               spread: 0.0035, life: 1.6, tierDmg: [7, 9, 11], tierBolts: [2, 3, 4] },
    // UPGRADE(power): the heavy lance hits like a capital-ship cannon —
    // bigger blast, harder shove, deeper screen kick. AoE shockwaves now
    // also SHOVE ships physically (see Projectiles._explode). v1.3: the
    // full charge is a battleship shell — dmg 190→260, AoE 34→46 (+ splash
    // dmg 90→120), recoil shove 30→55, kick/shake up, charge 1.1s→1.05s.
    /* UPGRADE(weapons): OVERCHARGE — holding past the 1.0 charge ceiling
       keeps building (chargeT up to overMax). An overcharged shot hits
       dramatically harder, but the dump vents the capacitor bank: thrust
       and shields are offline for vulnTime after firing. Risk/reward. */
    lance:   { name: 'HEAVY LANCE', chargeTime: 1.05, dmgMin: 30, dmgMax: 260,
               spdMin: 300, spdMax: 700, aoe: 46, aoeDmg: 120, minRelease: 0.15,
               recoilShove: 55, kick: 0.5, shake: 1.55, waveSpeed: 380,
               overMax: 1.4, overDmg: 390, overAoe: 62, overAoeDmg: 170,
               overSpd: 780, vulnTime: 1.6 },
    // NEW WEAPON: PULSE LANCE — the mid-slot energy cannon. Instant fire,
    // solid damage, small splash, modest recoil. Fills the gap between
    // the spammy blaster and the committed lance charge.
    pulse:   { name: 'PULSE LANCE', rate: 1.7, dmg: 58, speed: 980, life: 1.7,
               aoe: 10, aoeDmg: 20, recoil: 0.22, kick: 0.06, shake: 1.18 },
    /* UPGRADE(weapons): MULTI-LOCK — HOLD the fire key with seekers
       selected to tag targets sequentially (one every tagTime, up to
       lockMax concurrent reticles). RELEASE fires one missile per
       tagged target simultaneously; each tag costs 1 ammo. A quick tap
       still fires the classic 4-missile volley at the current lock. */
    seeker:  { name: 'SEEKER MISSILES', ammoStart: 12, ammoMax: 24, volley: 4,
               volleyGap: 0.16, dmg: 46, aoe: 27, speed: 240, maxSpeed: 400,
               turn: 3.4, lockTime: 0.65, lockRange: 1400, restock: 6,
               lockMax: 4, tagTime: 0.55 },
    // NEW WEAPON: SWARM PODS — dumbfire micro-rocket salvo. No lock needed:
    // click and eight warheads fan out on loose crosshair-aimed vectors.
    swarm:   { name: 'SWARM PODS', rate: 1.15, count: 8, dmg: 17, aoe: 13,
               aoeDmg: 15, speed: 460, maxSpeed: 620, life: 2.2, spread: 0.055,
               turn: 0.55, kick: 0.1, shake: 1.12 },
    // NEW WEAPON: RAILGUN — hitscan-feel hyper-velocity slug. Pierces
    // every enemy along its path, zero spread, huge single-target punch.
    // Balanced by a slow fire rate + brief charge spin-up + heavy shake.
    railgun: { name: 'RAILGUN', rate: 0.85, dmg: 95, speed: 2600, life: 1.2,
               pierce: 5, spinUp: 0.22, kick: 0.5, shake: 0.32, radius: 1.1,
               waveSpeed: 620 },
    // NEW WEAPON (v1.3): ARC TURRET — auto-cannon that fires a HELICAL
    // triple-bolt burst. The three bolts corkscrew around the aim line
    // (phase advances every shot) — reads as electric arc fire, wastes
    // nothing at mid range, and shreds orbiting fighters.
    arc:     { name: 'ARC TURRET', rate: 1.35, dmg: 24, speed: 640, life: 1.5,
               helix: 0.035 },
    // NEW WEAPON (v1.4): SHARD CANNON — close-range shotgun. 7 pellets,
    // brutal inside 150u, useless past 400u. Momentum Burst: land 4+ pellets
    // on one target inside the window and your next shards hit 2.2x harder
    // on knockback (see Player._fireShard momentum logic).
    shard:   { name: 'SHARD CANNON', rate: 1.25, pellets: 7, dmg: 11, speed: 520,
               spread: 0.09, life: 0.55, knock: 22, kick: 0.42, shake: 1.2,
               momentum: { pellets: 4, window: 1.2, dmgMult: 1.35 } },
    // NEW WEAPON (v1.4): VOID MINES — area denial. Drop behind you while
    // kiting; mines arm, blink, then detonate with chain reactions.
    voidmine:{ name: 'VOID MINES', rate: 0.9, maxLive: 8, dmg: 85, radius: 30,
               armTime: 0.8, trigger: 18, chainRadius: 55, chainMax: 3,
               kick: 0.12, shake: 1.4 },
    overdrive: { duration: 12, fireMult: 0.5, accelMult: 1.5 },
  },

  /* PLAYER SKILLS — support abilities on cooldowns, SEPARATE from the
     weapon keys. V = flares, B = nova surge (online from launch).
     N = Blink: hard displacement dash along the flight vector + brief
         invulnerability — pure defensive repositioning.
     G = Overdrive: timed fire-rate + thrust surge on its own cooldown
         (the pickup effect, formalized as a real skill).
     SYSTEM(v1.5): blink & overdrive are LOCKED at launch — they unlock
     through the UTILITY branch of the per-map upgrade pool. */
  skills: {
    flareCd: 9,
    novaCd: 16,
    novaImpulse: 190,
    novaRadius: 95,
    novaDmg: 38,
    blinkCd: 7,
    blinkDist: 110,
    blinkInvuln: 0.3,
    overdriveCd: 24,
    overdriveSkillDur: 8,
  },

  /* SYSTEM (v1.4/v1.5): per-map UPGRADE POOL — on clearing a map the
     player CHOSES one of `offerCount` options on a dedicated screen.
     `cat` drives the screen grouping: firepower / armor / mobility /
     utility. `visual` is the hardpoint tag the ship builder hangs real
     geometry from (engine.js _addPoolUpgradeVisual). Stat keys are read
     by Player.applyUpgrade. UTILITY entries with `unlocks` grant a
     skill slot (blink / overdrive) or a systems bonus — that's the
     escalating weight the skill system hangs on map choice. Each id
     max `maxStacks` stacks; multiplicative stats stack, flats add. */
  upgrades: {
    maxStacks: 2,
    offerCount: 3,
    pool: [
      { id: 'barrel',    name: 'TWIN-LINK BARRELS',  cat: 'firepower', desc: '+20% BLASTER DAMAGE',      visual: 'gun',    dmgBlaster: 1.2 },
      { id: 'capacitor', name: 'STORM CAPACITOR',    cat: 'firepower', desc: '+18% FIRE RATE',           visual: 'cap',    rate: 0.85 },
      { id: 'lancecoil', name: 'LANCE COILS',        cat: 'firepower', desc: '+20% LANCE DAMAGE',        visual: 'cap',    dmgLance: 1.2 },
      { id: 'plating',   name: 'AEGIS PLATING',      cat: 'armor',     desc: '+35 MAX HULL',             visual: 'armor',  hull: 35 },
      { id: 'emitter',   name: 'SHIELD EMITTER',     cat: 'armor',     desc: '+40 SHIELD · +25% REGEN',  visual: 'shield', shield: 40, shieldRegen: 1.25 },
      { id: 'nozzle',    name: 'AFTERBURN NOZZLES',  cat: 'mobility',  desc: '+12% SPEED · +10% THRUST', visual: 'engine', maxSpeed: 1.12, accel: 1.1 },
      { id: 'servos',    name: 'GYRO SERVOS',        cat: 'mobility',  desc: '+15% TURN RATE',           visual: 'fin',    turn: 1.15 },
      { id: 'pod',       name: 'AUGMENT POD',        cat: 'utility',   desc: 'UNLOCKS BLINK [N]',        visual: 'pod',    unlocks: 'blink' },
      { id: 'odcoil',    name: 'REACTOR SURGE COIL', cat: 'utility',   desc: 'UNLOCKS OVERDRIVE [G]',    visual: 'cap',    unlocks: 'overdrive' },
      { id: 'tlink',     name: 'TARGET-LINK ARRAY',  cat: 'utility',   desc: '+2 MISSILE LOCKS · +30% RADAR', visual: 'pod', lockBonus: 2, radar: 1.3 },
      { id: 'vent',      name: 'Capacitor Vents',    cat: 'utility',   desc: 'OVERCHARGE VULNERABILITY −40%', visual: 'fin', vent: 0.6 },
    ],
  },

  /* SYSTEM (v1.5): LAYERED PROCEDURAL MUSIC. Additive WebAudio layers
     crossfaded by combat intensity (enemy count / wave state / boss
     flag) — never hard-cut. Gains are absolute master multipliers. */
  music: {
    master: 0.42,
    ambient: 0.55, combat: 0.8, boss: 0.95,
    combatRamp: 1.4,       // gain-units per intensity point (lerp rate)
    bossThreshold: 0.85,   // intensity at which the boss layer engages
    bpm: 96,
  },

  /* SYSTEM (v1.5): IMPACT POST-PROCESSING — chromatic aberration +
     radial-blur pulse pushed by big hits / overcharged lance / boss
     deaths. Gated behind the quality ladder (off on the low tier). */
  postfx: {
    caStrength: 0.0042,    // max chromatic aberration offset (UV units)
    blurStrength: 0.55,    // max radial blur mix at screen edges
    decay: 2.6,            // pulse envelope decay per second
  },

  /* SYSTEM (v1.4): ELITE MODIFIERS — rolled per spawn against the map's
     eliteChance. Modifiers stack with the HVT "prize ship" elite roll
     (CFG.enemies.elite). `tint` drives a real emissive stripe on the
     hull so elites read at a glance — never a bare recolor. */
  eliteMods: {
    fast:     { speedMult: 1.35, turnMult: 1.3,  tint: 0x66ffcc, tag: 'FAST' },
    armored:  { hpMult: 2.2,                     tint: 0xffaa33, tag: 'ARMORED' },
    volatile: { blast: 55, blastDmg: 30,         tint: 0xff5533, tag: 'VOLATILE' },
  },

  /* SYSTEM (v1.4): versioned localStorage persistence. */
  save: { version: 2, key: 'voidlancer_save_v2' },

  /* UPGRADE(content): flyable ship roster — three full flight models.
     Selected on the start screen; stats are MULTIPLIERS over CFG.flight /
     CFG.combat, applied in Player.reset(). */
  ships: {
    kestrel: { name: 'VL-9 KESTREL', role: 'BALANCED INTERCEPTOR', hull: 1, shield: 1,
      accel: 1, maxSpeed: 1, boostMaxSpeed: 1, pitchRate: 1, yawRate: 1,
      rollRate: 1, blasterRate: 1 },
    aegis: { name: 'SV-7 AEGIS', role: 'HEAVY GUN PLATFORM', hull: 1.65, shield: 1.3,
      accel: 0.82, maxSpeed: 0.85, boostMaxSpeed: 0.85, pitchRate: 0.82,
      yawRate: 0.8, rollRate: 0.8, blasterRate: 0.78 },
    wraith: { name: 'XR-2 WRAITH', role: 'LIGHT STRIKE FRAME', hull: 0.7, shield: 0.75,
      accel: 1.22, maxSpeed: 1.15, boostMaxSpeed: 1.2, pitchRate: 1.18,
      yawRate: 1.22, rollRate: 1.25, blasterRate: 1.15 },
    // NEW SHIP (v1.3): MT-4 TYPHOON — blaster artillery. The Mk III blaster
    // tier from spawn makes it a roaming flak battery; the cost is paper
    // hull + reduced top speed + normal handling.
    typhoon: { name: 'MT-4 TYPHOON', role: 'BLASTER ARTILLERY', hull: 0.85, shield: 0.9,
      accel: 0.96, maxSpeed: 0.95, boostMaxSpeed: 0.95, pitchRate: 0.98,
      yawRate: 1.0, rollRate: 1.02, blasterRate: 1.35 },
  },

  enemies: {
    fighter:  { hp: 26, speed: 95, accel: 55, turn: 2.3, radius: 2.2,
                score: 100, attackRange: 110, orbitDist: 62, fireRange: 420,
                boltDmg: 5, boltSpeed: 380, dropChance: 0.18 },
    gunship:  { hp: 150, speed: 46, accel: 22, turn: 0.7, radius: 5.5,
                score: 250, holdMin: 220, holdMax: 380, fireRange: 620,
                boltDmg: 9, boltSpeed: 330, dropChance: 0.5 },
    turret:   { hp: 60, turn: 1.25, radius: 2.4, score: 80, range: 430,
                boltDmg: 6, boltSpeed: 420, dropChance: 0.3 },
    mine:     { hp: 8, radius: 3, score: 40, trigger: 42, blast: 46,
                blastDmg: 34, dropChance: 0.1 },
    // NEW ENEMY: VULTURE BOMBER — heavy attack craft that strafes the
    // player's projected position with AoE plasma shells. Slow, tough,
    // forces you to keep moving. Fires slow dodgeable orbs.
    bomber:   { hp: 210, speed: 34, accel: 18, turn: 0.55, radius: 6.5,
                score: 400, holdMin: 260, holdMax: 460, fireRange: 700,
                shellDmg: 14, shellSpeed: 210, dropChance: 0.75 },
    // NEW ENEMY: RAZOR DRONE — tiny, fast, fragile kamikaze swarm unit.
    // Dives at the player and detonates. Spawned in packs; dies to one hit.
    drone:    { hp: 6, speed: 150, accel: 90, turn: 3.2, radius: 1.6,
                score: 60, blast: 34, blastDmg: 20, dropChance: 0.05 },
    // NEW ENEMY: RAVAGER — heavy assault craft. Pressure-flak bursts,
    // minesweeper blades that vaporize ordnance, contact-ram bruiser.
    ravager:  { hp: 320, speed: 52, accel: 26, turn: 0.62, radius: 7,
                score: 550, holdMin: 160, holdMax: 340, fireRange: 560,
                flakShots: 6, flakGap: 0.09, flakSpeed: 460, flakDmg: 7,
                shellDmg: 0, shellAoe: 15, shellAoeDmg: 13, dropChance: 0.8 },
    // NEW ENEMY: SENTINEL — hovering shield/repair platform. Projects an
    // aura that regenerates nearby hulls and eats 30% of incoming damage;
    // its guard drones can be shot down. Kill it first or fights drag on.
    sentinel: { hp: 260, speed: 30, accel: 14, turn: 0.5, radius: 6.5,
                score: 600, holdMin: 340, holdMax: 560, fireRange: 640,
                auraRange: 150, regen: 7, guard: 2, guardDmg: 5, guardSpeed: 640,
                boltDmg: 8, boltSpeed: 380, dropChance: 0.9 },
    elite:    { hpMult: 3, score: 800 },      // "prize ship" HVT
    // NEW ENEMY (v1.3): INTERDICTOR — engine-displacement cruiser. Slower
    // than a gunship, twice as tough. Its gravity wells cut the player's
    // top speed by 55% and disable boost inside the radius — kill it first.
    interdictor: { hp: 300, speed: 26, accel: 15, turn: 0.4, radius: 7.5,
                   score: 700, holdMin: 240, holdMax: 420, fireRange: 640,
                   boltDmg: 11, boltSpeed: 340, salvoGap: 3.6,
                   wellRadius: 180, dropChance: 0.85 },
    contactDmg: 22,                            // ram damage dealt to player
    escortTargetChance: 0.3,                   // fighters split fire onto ally
    // NEW ENEMY (v1.4): INTERCEPTOR — hit-and-run duelist. Screams in from
    // side angles, makes one slashing gun pass with hard lead prediction,
    // then blowtorches away to reposition. Punishes stationary play.
    interceptor: { hp: 42, speed: 155, accel: 85, turn: 3.0, radius: 2.4,
                   score: 220, passRange: 560, fireRange: 480,
                   boltDmg: 6, boltSpeed: 470, dropChance: 0.22 },
    // NEW ENEMY (v1.4): HIVE — swarmer carrier. Furry: it stays out of
    // reach and periodically vomits clusters of razor drones at you.
    // Kill it or drown in bodies.
    hive:      { hp: 150, speed: 38, accel: 18, turn: 0.55, radius: 5.5,
                 score: 380, holdMin: 300, holdMax: 480, fireRange: 640,
                 burst: 4, spawnEvery: 4.5, dropChance: 0.8 },
  },

  boss: {
    coreHp: 1500, wpHp: 240, radius: 26, score: 5000,
    heavyDmg: 22, heavySpeed: 330, missileDmg: 16,
    flakDmg: 12, beamDps: 38, holdDist: 420, speed: 9,
    shieldReduce: 0.6,        // damage multiplier while shield dome alive
    escortCap: 3, escortEvery: 12,
  },

  /* UPGRADE(content): boss ARCHETYPES. One hull builder, three behaviors:
     dreadnought = the classic gun-duelist, carrier = swarms fighters,
     fortress = slow triple-beam siege platform. `traitor` marks the
     turret skeleton slots the hull uses for its signature weapons. */
  bossTypes: {
    dreadnought: { speedMult: 1, holdDist: 420, beams: 1,
      weapons: { heavy: 1.5, missiles: 9, flak: 6, beamEvery: 7 } },
    carrier: { speedMult: 1.3, holdDist: 560, beams: 0,
      weapons: { heavy: 2.6, missiles: 7, flak: 8, beamEvery: 0 },
      escortCap: 6, escortEvery: 7 },
    fortress: { speedMult: 0.65, holdDist: 500, beams: 3,
      weapons: { heavy: 2.2, missiles: 12, flak: 5, beamEvery: 9 } },
    /* NEW BOSS (v1.4): SINGULARITY ENGINE — environmental-manipulation
       siege platform. Between attacks it PULLS the player toward it
       (gravity.radius/force); on a long telegraphed cycle it fires a
       gravity PULSE that slams everything in pulseRadius. Fight = manage
       your throttle and break the pull line, not just out-DPS it. */
    singularity: { speedMult: 0.8, holdDist: 460, beams: 0,
      weapons: { heavy: 2.0, missiles: 10, flak: 4, beamEvery: 0 },
      gravity: { radius: 900, force: 55, pulseEvery: 11, pulseWindup: 2.2,
                 pulseForce: 320, pulseRadius: 560 } },
  },

  waves: {
    lull: 8,                  // breather seconds between waves
    baseFighters: 4, fighterGrowth: 2, fighterCap: 26,
    concurrentCap: 14,
    gunshipStart: 2, gunshipPerWave: 2, gunshipCap: 6,
    mineStart: 3, minesPerWave: 1,
    bossEvery: 5,
    hpGrowth: 0.045, speedGrowth: 0.015, speedCap: 1.28, leadGrowth: 0.045,
    escortChance: 0.35,       // chance of a secondary objective (non-boss waves)
    waveBonus: 250, waveBonusGrowth: 100, waveHullRepair: 10,
  },

  world: {
    boundary: 2600,           // soft combat-zone radius
    boundaryDamage: 3, boundaryGrace: 5,
    asteroidCount: 420,
    dustCount: 240, dustRange: 130,
    projAsteroidChecks: 2,    // 1 = every frame, 2 = every 2nd frame (perf)
  },

  pickups: {
    magnet: 70, magnetAccel: 140, collect: 9, life: 45,
    // drop weights (when an enemy dies)
    weights: { health: 30, shield: 25, weapon: 20, ammo: 15, overdrive: 10 },
  },

  radar: { range: 900 },

  score: { comboStep: 0.25, comboMax: 8, comboTimeout: 12 },

  /* CAMPAIGN — all phase / map tuning in one place (see SECTION 17).
     Phase 1 is a scripted intro (two small pad waves), Phase 2 a bounded
     ascent corridor with a power-on ramp; Phase 3 is the existing arena. */
  campaign: {
    phase1: {
      podHp: 300,               // launch pad / pod integrity (fail condition)
      duration: 75,             // seconds before the phase auto-completes
      waveGap: 4,               // breather between the scripted pad waves
      spawnDist: [430, 640],    // attacker spawn ring (front hemisphere)
      waves: [                  // small on purpose — intro, not a gauntlet
        { fighters: 3 },
        { fighters: 4, gunships: 1, turrets: 1 },
      ],
      /* FIX(feel): the pad gunner camera is now FREE-LOOK — the cursor
         drives yaw/pitch RATES (same steering model as flight) instead
         of a ±60°/±30° absolute arc, so orbiting attackers can never
         escape your view. Pitch still clamps so you can't fold backwards. */
      lookYawRate: 2.0,         // rad/s at full cursor deflection
      lookPitchRate: 1.35,
      lookPitchClamp: 1.15,     // ±66°
      shipTrackRate: 3.5,       // parked ship pivots on its ring to follow
      /* support: automated PD turrets on the pad help hold the line
         (support dps only — the player stays the main gunner) */
      turrets: [
        { x: -13.5, z: -7 }, { x: 13.5, z: -7 }, { x: 0, z: -14 },
      ],
      turretDmg: 3.5,
      turretRate: [0.7, 1.1],   // seconds between shots (per turret)
      turretRange: 640,
      turretSpread: 0.014,
      turretSlew: 2.4,          // rad/s tracking speed
    },
    phase2: {
      tubeRadius: 95,           // soft corridor half-width (drift allowed inside)
      hardRadius: 150,          // pulled back onto the tube past this
      pushAccel: 95,            // corrective accel toward the centerline
      powerStart: 0.4,          // thrust / turn / max speed start at 40%...
      powerDur: 50,             // ...and ramp to 100% over this many seconds
      asteroidCount: 300,       // denser local field along the path
    },

    /* WEAPON PROGRESSION — the battery wakes up one system per sector
       instead of dropping all nine on a new pilot. Slot indices:
       0 blaster · 1 heavy lance · 2 pulse lance · 3 seekers · 4 swarm pods
       5 railgun · 6 arc turret · 7 shard cannon · 8 void mines.
       `weaponStart` flies from the first ascent; `weaponUnlocks[i]` is
       added when sector i loads. Endless ignores the ladder (full battery). */
    weaponStart: [0, 2],
    /* UPGRADE(content v1.8.1): the ladder tracks the 30-sector roster and
       the seven unlockable systems are now SPREAD across it — a new weapon
       roughly every fourth sector instead of all of them inside the first
       seven, and a blaster refit at each end of the deep run. Tier entries
       refine the base blaster without granting a new weapon; game.js
       resolves { tier: n } rows, and an empty row still means "no new
       weapon this sector", never a crash. */
    weaponUnlocks: [[1], [], [], [3], [], [], [], [4],
                    [], [], [], [6], [], [], [], [5],
                    [], [], [], [7], [], [], [], [8],
                    [], [], { tier: 1 }, [], [], { tier: 2 }],

    /* PHASE 1 briefing — shown over the pad once per run (see HUD.briefing).
       Explains WHY the ship can't just fly off, plus the controls that
       matter while the gunner view is up. */
    briefing: {
      title: 'MISSION BRIEFING — DEFEND THE LAUNCHPAD',
      lines: [
        'The launch drive is still spinning up — you cannot lift off yet.',
        'Boarding craft hit the pad in waves. You are on the pad gun now:',
        'the MOUSE aims and LMB fires. Hold the pad until the drive is green,',
        'then the ascent corridor opens and you fly.',
      ],
      hint: 'MOUSE aim · LMB fire · SPACE dismiss',
    },
  },

  fx: {
    maxParticles: 3200, maxDebris: 150, maxRings: 16, maxLights: 6,
    maxFlashSpheres: 8,      // UPGRADE: expanding additive fireball cores
    maxEmbers: 90,           // UPGRADE: glowing instanced shards inside blasts
    maxShockwaves: 6,        // UPGRADE: groundless 3D blast-wave domes
    maxStreaks: 56,          // UPGRADE(v1.8.1): boost warp-streak instances
    quality: 2,              // 2 = full, 1 = half particle budget, 0 = minimal
                             // (adaptive quality drops this before resolution)
  },

  /* SYSTEM (v1.4): environmental mechanics. Maps may declare a `hazard`
     table; game.js applies gravity/visibility/lightning per-frame and
     engine.js builds the set dressing (accretion disk / nebula layers). */
  hazards: {
    blackhole: { mass: 9.2e6, minDist2: 6400, clamp: 320, eventHorizon: 90,
                 danger: 260, warn: 520 },
    nebula: { visibility: 700, radarMult: 0.45, arcEvery: 9, arcDamage: 9,
              arcRadius: 55, arcWarn: 1.1 },
    /* UPGRADE(v1.8.1): the two haze/impact systems. ionstorm kills shield
       regen for the sector (engine.js Player reads G.world.ionstorm) and
       flickers its arc nodes; meteors fires volleys from the 'meteor'
       projectile pool. Sector entries override intensity / rate. */
    ionstorm: { intensity: 1.0 },   // arc cadence + node flicker divisor
    meteors: { rate: 1.0 },         // volley frequency multiplier
    /* SYSTEM(v1.6): hazards as weapons — enemies die past the black-hole
       point-of-no-return, take pull damage inside the danger ring, and get
       shoved by knockback toward it. Asteroid ramming is now symmetric. */
    enemyPullDamage: 14,        // dps inside danger ring
    enemyKnockShove: 1,         // multiplier on projectile knock vs black hole
    asteroidEnemyDmg: 34,       // collision damage enemies take per hit
    asteroidEnemyCooldown: 0.6,
    hazardKillScoreMult: 1.25,  // score bonus on hazard-credit kills
  },

  /* ============================================================
     SYSTEM(v1.6) — everything below is the "depth & breadth"
     config layer. All of it is data-driven + feature-flagged via
     CFG.features so passes can land incrementally.
  ============================================================ */

  /* v1.7.0 — the v1.6 "depth" flags below shipped as data + styled DOM with
     nothing behind them. This pass implemented the player-facing half of
     that layer: RADIO chatter (#radio-log), TUTORIAL beats (#tutorial-prompt),
     the PILOT RECORD (#screen-stats), the HANGAR SHOP with endless credits,
     starting perks and hull-painting LIVERIES (#screen-shop), NEW GAME+
     escalation, elite callsigns (#target-tag) and per-sector comms
     (CFG.mapStory). (The v1.9.0 pass below finished this layer: the three
     stubs named here — wrecks, distress calls, runSnapshot — are live.) */
  /* v1.8.1 — CONTENT & RENDER PASS. Sector roster 20 → 30 (ten escalation
     inserts, hpMult ladder 2.25 → 3.30 with EVENT HORIZON raised to 3.35 so
     it keeps the ceiling role); two new planet painters (ashen, magnetar)
     plus UV drift on banded bodies; live atmosphere shaders; boost warp
     streaks; five new hulls (stalker / sapper / warden enemies, spotter /
     sweeper allies); two new hazard systems (ionstorm shields-offline,
     meteors volleys); weapon ladder re-spaced across all 30 rows (one new
     system every fourth sector, blaster refinements at 27 and 30); comms
     log rewritten one entry per sector with the callsign matching the
     sector the player is in (was 10 entries naming the wrong worlds). */
  /* v1.8.2 — HULL & FACTION PASS. Rebuilt all three flyable hulls from
     procedural kits (spine/canopy/chine/keel/strake/pod/shoulder section
     data per chassis): denser silhouettes, gunmetal lit-plate + recess +
     emissive trim merged into one mesh per tier (heavy draw calls
     ÷3, ~5k triangle budget headroom per ship), per-mount engine glow
     discs, engine/RCS anchor points, wingtip pods + missile racks on the
     gunship, deep keel + quad nacelles + rudder fins on the heavy. Sector
     roster identity pass: all 30 maps reworked with unique planet
     painters + sky tints and monotone hp/spd/boss/elite ladders (hp
     1.00 → 3.35, boss to 3.40); hazard carriers kept, ionstorm + meteors
     each exactly one sector. Dev console gained MAX · SANDBOX (arsenal +
     god + one-shot + noclip, weapons/skills stay unlocked after). */
  /* v1.9.0 — SYSTEMS PASS. The four systems whose config, styled DOM and
     radio pools had shipped with NO code behind them are live:
       §6 WRECKS     hold [H] at a derelict — intel, a pickup, or a rigged
                     hull that springs its ordnance; beacon + radar diamonds
                     so a wreck is findable, one salvage per hull per run
       §7 DISTRESS   a timed beacon pod under fire. Reach it for the rescue
                     bounty plus a guaranteed upgrade drop, or watch the
                     raiders kill it. Owns the HUD objective line + clock
                     while it stands (and hands both back), runs in endless
                     AND campaign sectors, and the pod is a real target
       §4 NEMESIS    per-instance damage attribution → a marked rival →
                     one persisted slot → it returns in a later run, renamed,
                     scaled by hp/dmg/speed and tagged pink
       §23 SNAPSHOT  wave-granular run bookmark + start-screen RESUME /
                     DISCARD (CFG.save finally has a reader)
     Also closed two live-but-inert contracts: the §9 modifier score
     multipliers (the ×1.20 badges now actually pay) and the pause menu's
     RESUME button, which had no listener. Salvage is on [H]: the E the DOM
     advertised is roll-right. */
  version: '1.9.0',
  features: {
    chassis: true,          // §1  ship classes
    factions: true,         // §2  enemy faction doctrines
    hazardWeapons: true,    // §3  environmental hazards as weapons
    nemesis: true,          // §4  singular persistent rival
    namedElites: true,      // §5  rare named elite spawns
    wrecks: true,           // §6  derelict exploration beats
    distress: true,         // §7  distress-call side objectives
    shop: true,             // §8  meta-currency shop / loadout
    modifiers: true,        // §9  opt-in difficulty modifiers
    ngplus: true,           // §10 New Game+
    weakpointSlowmo: true,  // §12 boss weak-point kill-cam
    radio: true,            // §13 text radio chatter
    photoMode: true,        // §14 photo mode
    tutorial: true,         // §15 onboarding beat
    difficulty: true,       // §16 Easy/Normal/Hard
    settings: true,         // §17 pause-menu settings
    colorblind: true,       // §18 colorblind-safe palette
    mapStory: true,         // §19 per-map comms log
    ending: true,           // §20 campaign ending sequence
    paint: true,            // §21 ship paint / decals
    statsScreen: true,      // §22 lifetime stats screen
    runSnapshot: true,      // §23 save/resume mid-run snapshot
    responsive: true,        // §25 responsive UI + gamepad
  },

  /* §1 — SHIP CLASSES. Multipliers over CFG.flight / CFG.combat (same
     contract as CFG.ships). `bias` weights map-upgrade offers per
     category (0 = never offered, >1 = more likely). `mesh` params tweak
     the composite hull silhouette in Player._buildMesh. Old CFG.ships
     entries remain for cheats/back-compat; chassis keys are the three
     run-start choices. */
  chassis: {
    interceptor: {
      key: 'interceptor', name: 'IX-3 INTERCEPTOR', role: 'EVADE & OVERWHELM',
      hull: 0.72, shield: 0.8, accel: 1.28, maxSpeed: 1.2, boostMaxSpeed: 1.28,
      pitchRate: 1.3, yawRate: 1.32, rollRate: 1.3, blasterRate: 1.18,
      rate: 0.85,               // faster weapon cooldowns (fire interval mult)
      dmg: 0.95,                // weapon damage mult
      boostDrain: 0.9, boostRegen: 1.15,
      bias: { firepower: 1.6, mobility: 2.0, armor: 0.4, utility: 0.9 },
      mesh: { fuselage: 0.82, wingSpan: 1.28, wingSweep: 1.35, nose: 1.25,
              finSize: 0.9, engineScale: 1.15 },
      blurb: 'LOW HULL · HIGH TURN & BOOST · FAST COOLDOWNS',
    },
    gunship: {
      key: 'gunship', name: 'VL-9 GUNSHIP', role: 'BALANCED DEFAULT',
      hull: 1, shield: 1, accel: 1, maxSpeed: 1, boostMaxSpeed: 1,
      pitchRate: 1, yawRate: 1, rollRate: 1, blasterRate: 1,
      rate: 1, dmg: 1, boostDrain: 1, boostRegen: 1,
      bias: { firepower: 1, armor: 1, mobility: 1, utility: 1 },
      mesh: { fuselage: 1, wingSpan: 1, wingSweep: 1, nose: 1, finSize: 1,
              engineScale: 1 },
      blurb: 'BALANCED STATS · THE STANDARD FIGHTER FRAME',
    },
    heavy: {
      key: 'heavy', name: 'HT-8 BASTION', role: 'TRADE HITS, HOLD GROUND',
      hull: 1.7, shield: 1.35, accel: 0.8, maxSpeed: 0.86, boostMaxSpeed: 0.84,
      pitchRate: 0.78, yawRate: 0.78, rollRate: 0.76, blasterRate: 0.82,
      rate: 1.15,               // slower cooldowns
      dmg: 1.35,                // hits harder
      boostDrain: 1.15, boostRegen: 0.9,
      bias: { firepower: 1.1, armor: 2.0, mobility: 0.4, utility: 1.4 },
      mesh: { fuselage: 1.3, wingSpan: 0.82, wingSweep: 0.75, nose: 0.85,
              finSize: 1.35, engineScale: 1.25 },
      blurb: 'HIGH HULL/SHIELD · SLOW TURN · +35% WEAPON DAMAGE',
    },
  },
  chassisDefault: 'gunship',

  /* §2 — ENEMY FACTION DOCTRINES. Doctrines change spawn timing/grouping
     AND AI coordination flags consumed by Fighter/Gunship/Interceptor
     updates — not just spawn tables. Maps carry `faction` (see MAPS). */
  factions: {
    swarm: {
      name: 'HEX SWARM',
      label: 'SWARM DOCTRINE — OVERWHELM FROM ALL ANGLES',
      /* spawn: units arrive in tight multi-angle pods, short stagger,
         simultaneous engagement from 3-4 bearings */
      spawnStagger: [0.18, 0.45],   // per-unit delay range (vs default)
      groupPods: 3,                 // spawn in pods of ~count/groupPods
      podAngleSpread: 2.4,          // radians between pod bearings
      engageDelay: 0,               // no hesitation before committing
      coord: {
        mutualSupport: false,       // do NOT wait for allies
        screenAllies: false,
        standoffSlack: 0.75,        // press closer, looser formation
        focusFire: false,
        jinkWhileGrouped: true,
      },
      hpMult: 0.85, spdMult: 1.12, scoreMult: 0.9,
    },
    militia: {
      name: 'FREEHOLD MILITIA',
      label: 'MILITIA DOCTRINE — MUTUAL SUPPORT & SCREENING',
      spawnStagger: [0.7, 1.6],     // slower, deliberate roll-out
      groupPods: 1,
      podAngleSpread: 0.7,          // mostly one staging bearing
      engageDelay: 1.4,             // hold until the line is formed
      coord: {
        mutualSupport: true,        // gunships wait for a screen before closing
        screenAllies: true,         // fighters screen nearby gunships
        standoffSlack: 1.25,        // hold wider standoff
        focusFire: true,            // nearby units converge on same target
        jinkWhileGrouped: false,
        screenDist: 90,             // fighter posts within this of a gunship
        supportWait: 2.2,           // seconds a gunship waits for support
      },
      hpMult: 1.15, spdMult: 0.95, scoreMult: 1.15,
    },
    mixed: {
      name: 'COALITION',
      label: 'MIXED DOCTRINE — ADAPTIVE',
      spawnStagger: [0.4, 0.9],
      groupPods: 2,
      podAngleSpread: 1.5,
      engageDelay: 0.5,
      coord: {
        mutualSupport: true, screenAllies: false, standoffSlack: 1,
        focusFire: false, jinkWhileGrouped: true,
      },
      hpMult: 1, spdMult: 1, scoreMult: 1.05,
    },
  },
  factionDefault: 'mixed',

  /* §16 — DIFFICULTY. First-class choice at mode-select. Touches AI
     aggression (range/reaction/fire rate) and spawn density/HP — not
     just flat damage taken/dealt. */
  difficulty: {
    easy: {
      key: 'easy', name: 'EASY', desc: 'TRAINING CRUISE',
      ai: { engagement: 0.75, fireRate: 0.8, reaction: 1.5, leadSkill: 0.6,
            aggression: 0.8 },
      hpMult: 0.8, spawnMult: 0.8, scoreMult: 0.8, dropMult: 1.2,
    },
    normal: {
      key: 'normal', name: 'NORMAL', desc: 'STANDARD PATROL',
      ai: { engagement: 1, fireRate: 1, reaction: 1, leadSkill: 1,
            aggression: 1 },
      hpMult: 1, spawnMult: 1, scoreMult: 1, dropMult: 1,
    },
    hard: {
      key: 'hard', name: 'HARD', desc: 'THEY WANT YOU DEAD',
      ai: { engagement: 1.3, fireRate: 1.25, reaction: 0.55, leadSkill: 1.35,
            aggression: 1.3 },
      hpMult: 1.25, spawnMult: 1.2, scoreMult: 1.5, dropMult: 0.9,
    },
  },
  difficultyDefault: 'normal',

  /* §9 — OPT-IN MODIFIERS (roguelike curses). Stack; each multiplies
     score/currency gain. Entirely separate from difficulty. */
  modifiers: {
    noShieldRegen: { name: 'NO SHIELD REGEN', scoreMult: 1.2,
      desc: 'Shields never recharge without a pickup.' },
    seeThroughFlares: { name: 'ENEMIES SEE THROUGH FLARES', scoreMult: 1.15,
      desc: 'Flares no longer break enemy locks.' },
    noRadar: { name: 'DEAD RADAR', scoreMult: 1.15,
      desc: 'Radar scope is offline. Fly by eyes.' },
    doubleAggro: { name: 'HUNTER KILLERS', scoreMult: 1.25,
      desc: 'Enemies engage at double range and press twice as hard.' },
    oneLife: { name: 'ONE LIFE', scoreMult: 1.4,
      desc: 'Pickups cannot restore hull above 25%.' },
  },

  /* §8 — META-CURRENCY + SHOP. Endless earns credits; shop spends them
     on cosmetics + modest Adventure starting perks. */
  meta: {
    creditPerKill: 1,
    creditPerWave: 12,
    creditPerBoss: 150,
    scoreToCredits: 0.002,      // credits per score point at run end
    endlessOnly: true,          // credits only banked from Endless runs
  },
  shop: {
    perks: [
      { id: 'perk_hull', name: 'REINFORCED KEEL', cost: 250,
        desc: '+25 starting hull on the next Adventure run.',
        apply: { hullBonus: 25 } },
      { id: 'perk_flare', name: 'EXTRA FLARE RACK', cost: 200,
        desc: 'Flare skill cooldown −25% next run.',
        apply: { flareCdMult: 0.75 } },
      { id: 'perk_blink', name: 'BLINK CHIP — EARLY ISSUE', cost: 400,
        desc: 'Blink unlocked from launch next run.',
        apply: { unlock: 'blink' } },
      { id: 'perk_shield', name: 'SHIELD BUFFER CELL', cost: 300,
        desc: '+30 starting shield next run.',
        apply: { shieldBonus: 30 } },
      { id: 'perk_rate', name: 'TRIGGER SPRING KIT', cost: 350,
        desc: '−10% weapon cooldowns next run.',
        apply: { rateMult: 0.9 } },
    ],
    /* §21 — cosmetics: base/accent/emissive livery triples */
    liveries: [
      { id: 'liv_default', name: 'FACTORY GUNMETAL', cost: 0,
        base: 0x39424e, panel: 0x76818d, accent: 0xff9a3c },
      { id: 'liv_ember', name: 'EMBER STRIPE', cost: 150,
        base: 0x4a2c22, panel: 0x8a6a52, accent: 0xff6a2a },
      { id: 'liv_arctic', name: 'ARCTIC GHOST', cost: 150,
        base: 0x2e3d4a, panel: 0x9fb8c8, accent: 0x6ad8ff },
      { id: 'liv_verdant', name: 'VERDANT SIGNAL', cost: 200,
        base: 0x24382c, panel: 0x6f9a7a, accent: 0x58ffb0 },
      { id: 'liv_royal', name: 'ROYAL VOID', cost: 250,
        base: 0x2c2440, panel: 0x8a7ab8, accent: 0xc060ff },
      { id: 'liv_gold', name: 'ACE GOLD', cost: 500,
        base: 0x4a3c1c, panel: 0xc8a84a, accent: 0xffd86a },
    ],
  },

  /* §4 — NEMESIS. One active slot. Candidate flagged when a single
     enemy instance deals ≥ threshold of player's max hull, then the
     player dies / run ends, or the enemy escapes alive. */
  nemesis: {
    damageThreshold: 0.22,      // fraction of max hull from ONE instance
    reappearChance: 0.55,       // chance the candidate shows next map
    hpMult: 1.9, dmgMult: 1.35, speedMult: 1.1, scoreBonus: 1500,
    names: ['VESPER', 'KARROW', 'NIGHTJAR', 'OBSIDIAN WING', 'TALON',
            'REVENANT', 'ASHEN', 'GHOSTWIRE', 'MORRIGAN', 'SABLE'],
    banner: 'NEMESIS RETURN',
  },

  /* §5 — NAMED ELITES. Rare random roll on any spawn (separate flag
     from nemesis). Guaranteed best-tier drop + callsign tag. */
  namedElite: {
    chance: 0.045,              // per spawn (after map eliteChance)
    hpMult: 2.6, dmgMult: 1.3, speedMult: 1.18, scoreBonus: 600,
    names: ['VIPER', 'RAZOR', 'CINDER', 'HALCYON', 'DUSK', 'IRONCLAD',
            'SPECTRE', 'KESTREL PRIME', 'WARBRINGER', 'LONGSHOT',
            'BANSHEE', 'COPPERHEAD', 'FLINT', 'ONYX', 'TEMPEST'],
  },

  /* §6 — DERELICT INTERACTION */
  wrecks: {
    key: 'KeyH',                // FIX(input): was documented as E, which is
                                // roll-right (engine.js rollIn) — the hold key
                                // must not double as a flight control
    radius: 60,                 // approach distance to start hold
    holdTime: 2.4,              // seconds of sustained hold (touch: automatic)
    hazardChance: 0.08,         // rare rigged hull: dormant ordnance wakes up
    intelChance: 0.45,          // otherwise: intel text vs pickup
    scoreBonus: 200,
  },

  /* §7 — DISTRESS-CALL SIDE OBJECTIVES (reuses escort plumbing) */
  distress: {
    chance: 0.28,               // per eligible wave — an INDEPENDENT roll, so
                                // it can land alongside the other secondaries
    timeout: 45,                // seconds of life support before it auto-fails
    rescueReward: 1200,         // extract the survivor
    killReward: 900,            // bounty per hunter destroyed while it stands
    pickupReward: 'upgrade',    // guaranteed upgrade-track pickup on a rescue
    /* v1.9: the actor the call spawns (entities.js Survivor) */
    podHp: 120,                 // pod hull — survives a little fire, not a lot
    podRadius: 2.6,             // pod collision/damage sphere
    rescueRadius: 45,           // fly inside this to extract (drawn as its ring)
    hunters: 2,                 // raiders detailed to kill the pod
  },

  /* §10 — NEW GAME+ (one escalation tier for v1) */
  ngplus: {
    hpMult: 1.6, spdMult: 1.15, bossHpMult: 1.7, eliteChanceBonus: 0.12,
    scoreMult: 2,
  },

  /* §13 — RADIO CHATTER pools (banner/alert extensions, random pick) */
  radio: {
    waveStart: [
      'CONTROL: CONTACTS ON THE SCOPE — GOING HOT.',
      'RADIO: Watch your six, they’re flooding the lane.',
      'CONTROL: Weapons free. Clear the wave.',
      'RADIO: Multiple vectors inbound — pick your angle.',
    ],
    lowHealth: [
      'CONTROL: Hull integrity critical — disengage!',
      'RADIO: You’re leaking atmosphere! Get to cover!',
      'CONTROL: One more hit like that and you’re dust.',
      'RADIO: Patch your hull — I can’t bring you back twice.',
    ],
    bossPhase: [
      'RADIO: It’s shifting fire — new weak points exposed!',
      'CONTROL: Capital ship changing posture — punish it.',
      'RADIO: That armor’s cracking. Hit the open lines!',
    ],
    nemesis: [
      'CONTROL: That signature again… it survived you.',
      'RADIO: The one that gutted you is back on the scope.',
      'CONTROL: Nemesis contact — finish what you started.',
    ],
    distress: [
      'RADIO: Distress beacon — someone’s alive out there.',
      'CONTROL: Priority call for help, off the main lane.',
      'RADIO: Weak signal begging for pickup — your call.',
    ],
    hazardKill: [
      'CONTROL: Gravity did your work for you. Nice push.',
      'RADIO: That one won’t be filing a report.',
      'CONTROL: Environmental kill confirmed — score it.',
    ],
    tutorial: [
      'CONTROL: Systems online. Test your guns — click to fire.',
      'CONTROL: Tap SHIFT for the afterburner — let’s move.',
      'CONTROL: Press F to drop into the cockpit. Your call.',
    ],
    wreckFound: [
      'RADIO: Derelict log cracked — adding to the comms archive.',
      'CONTROL: Salvage secured from that hulk.',
      'RADIO: Whoever flew this didn’t make it. Their loss.',
    ],
  },

  /* §14 — PHOTO MODE (pause menu > PHOTO MODE, ENTER to shoot, P to exit).
     Free orbit camera on the frozen scene: drag orbits the ship, WASD
     pans the focus, Q/E lifts, wheel zooms. HUD toggle + PNG capture. */
  photo: {
    orbitSpeed: 0.0042,      // rad per px dragged
    panSpeed: 0.9,           // focus units per second
    zoomMin: 6, zoomMax: 220,
    zoomStep: 1.12,          // per wheel notch
    ramp: 12,                // camera smoothing rate (per second)
  },

  /* §15 — TUTORIAL beats (first run only, skippable with Escape) */
  tutorial: {
    steps: [
      { id: 'fire',   text: 'CLICK — TEST FIRE',        need: 'fired',   time: 6 },
      { id: 'boost',  text: 'HOLD SHIFT — AFTERBURN',   need: 'boosted', time: 6 },
      { id: 'cockpit',text: 'PRESS F — COCKPIT VIEW',   need: 'cockpit', time: 7 },
      { id: 'weapon', text: 'PRESS 2–9 — SWITCH WEAPONS', need: 'switched', time: 6 },
    ],
    skipKey: 'Escape',
  },

  /* §20 — campaign ending */
  ending: { panTime: 4.5, fov: 55 },

  /* §17/§25 — settings defaults (persisted to localStorage) */
  settings: {
    // FIX: was CFG.flight.mouseSens — the virtual cursor moved only ~0.16px per
    // 100px of pointer travel, so with pointer lock the ship could barely turn
    // or aim. 1.2 px/px reaches full deflection after ~200px of travel.
    mouseSens: 1.2, invertY: false,
    steerAssist: true,          // auto-center the virtual cursor on idle
                                // (fine aim settles; see CFG.flight.assist*)
    flightModel: 'arcade',      // 'arcade' | 'inertial' (momentum carries)
    volMaster: 0.55, volSfx: 1, volMusic: 0.42,
    quality: 'auto',            // 'auto' | 'high' | 'med' | 'low'
    hudScale: 1,                // manual multiplier over auto scale
    colorblind: false,          // §18 alt palette + shape coding
    difficulty: 'normal',       // §16 mode-select pick (Game.diffMult)
    modifiers: [],              // §9 opted-in hazard modifier keys (G.modOn)
  },
  hud: {
    autoBreakpoint: 1100,       // px width → compact HUD variant
    minScale: 0.62, maxScale: 1.35,
  },

  /* §19 — per-map comms-log narrative (2-3 lines, shown on map load).
     v1.8.1: one entry per sector, in roster order, and the callsign in each
     line matches the sector the player is actually standing in. */
  mapStory: [
    ['COMMS // ASHVEIL ORBIT: The picket burned in nine seconds.',
     ' Whoever fired the first shot is not claiming it.',
     ' Sweep the stragglers before the convoy jumps.'],
    ['COMMS // GLACIUS RIFT: Ice this cold keeps wrecks for centuries.',
     ' The rift is full of our old friends.',
     ' Break the line and keep moving.'],
    ['COMMS // FERROUS BASTION: The militia welded a wall out of gunships.',
     ' No ideology. Just steel and sightlines.',
     ' Roll the wall.'],
    ['COMMS // CINDER REACH: The belt is still warm from the first war.',
     ' Escort hulls run the ash lanes in pairs.',
     ' Cut the pairs apart.'],
    ['COMMS // VERDANT MAW: The garrison digs into the canopy.',
     ' Mines in the roots, drones in the mist.',
     ' Root them out.'],
    ['COMMS // MAGMA LATTICE: Sunside blockade — hulls cook out here.',
     ' The siege line rotates with the terminator.',
     ' Break it before the crossing.'],
    ['COMMS // SPORE CHOKE: Hive spores read as friendlies on our scopes.',
     ' Prowlers nest in the drift and wait for the blind.',
     ' Kill the nest.'],
    ['COMMS // KHARYBDIS THRESHOLD: Their threshold. Our problem.',
     ' Elite flights scramble the moment you are scanned.',
     ' End it.'],
    ['COMMS // PRISM SPIRE: Sentinels weld the spire back together as fast as you cut it.',
     ' Interceptors ride the refraction lanes.',
     ' Take the spire down whole.'],
    ['COMMS // SEARING HALO: Interdictor wells are staged along the halo.',
     ' Get caught in one and the burner is dead.',
     ' Kill the wells first.'],
    ['COMMS // ABYSSAL SHELF: The shelf drops away further than the charts admit.',
     ' Hive clusters hold the ridge.',
     ' Clear the ridge.'],
    ['COMMS // OBSIDIAN VEIL: Black fleet anchor coordinates locked.',
     ' Sentinels repair everything you scratch.',
     ' Kill the anchor.'],
    ['COMMS // KERN VEIL: The star is gone. Something holds the ash.',
     ' Gravity is the real garrison here.',
     ' Fight the tide.'],
    ['COMMS // RIME WARDEN: The warden does not chase. It waits.',
     ' Every wreck out here tried to run the middle.',
     ' Take the long line.'],
    ['COMMS // CLOUD OF MAGNUS: The choir blinds our scopes — arcs everywhere.',
     ' Friend-or-foe is a suggestion in this cloud.',
     ' Kill the choir.'],
    ['COMMS // HALCYON SHARD: The shard’s defenders hunt in silence.',
     ' Reaper locks are cheap out here and they know it.',
     ' Break the lock before it matures.'],
    ['COMMS // COBALT WAKE: A battle group crossed this wake and never arrived.',
     ' Ravagers fly the lane like they built it.',
     ' Take the lane.'],
    ['COMMS // AMETHYST GULF: The gulf eats radar the way the choir eats scopes.',
     ' Hive and sentinel share one signal.',
     ' Fire on the ones that move.'],
    ['COMMS // SPECTER KNOT: The knot bends light. Nothing in it is where it looks.',
     ' Reaper flights use the horizon as cover.',
     ' Hold formation and trust the instruments.'],
    ['COMMS // EMBER CASCADE: Sapper gunboats seed the cascade with sleeping mines.',
     ' The lane is a minefield that looks like a lane.',
     ' Sweep before you cross.'],
    ['COMMS // FRACTAL PRISM: Every approach looks like the last one.',
     ' Interceptors use the mirrors to set up the pass.',
     ' Do not take the bait lane.'],
    ['COMMS // WRAITH STORM: The storm hides engine signatures.',
     ' Prowlers work the cloud at knife range.',
     ' Watch your six, not your scope.'],
    ['COMMS // GOLIATH DRIFT: Interdictors and siege bombers, staged in the open.',
     ' They are not hiding. They do not need to.',
     ' Hit them before the wells spin up.'],
    ['COMMS // MALEVOLENT HAZE: Something in the haze has watched this lane a long time.',
     ' Stalkers cloak, line up, and take the shot.',
     ' Never fly straight.'],
    ['COMMS // VITRIFIED SHELL: This is what a fleet looks like after a sun decides.',
     ' Stalkers and sentinels patrol the glass.',
     ' Keep moving, keep turning.'],
    ['COMMS // ABYSSAL FORGE: The forge throws debris on a clock.',
     ' Warden escorts ride the volleys in.',
     ' Cross between the rocks, not during them.'],
    ['COMMS // GLACIAL EMBRACE: The embrace freezes drives solid inside a minute.',
     ' Warden pairs hold the only warm lane.',
     ' Punch the lane open.'],
    ['COMMS // IRON CRUCIBLE: They reforge what is left of us here.',
     ' Sapper hulls seed it, reapers finish it.',
     ' Break the line before the pour.'],
    ['COMMS // MAGNETAR THRONE: The magnetar kills shields. Yours first.',
     ' Wardens and stalkers do not need shields out here.',
     ' Hull, guns, nerve.'],
    ['COMMS // EVENT HORIZON: Last gate. No backup behind us.',
     ' Black hole, nebula, and the whole remnant fleet.',
     ' End it.'],
  ],
};



/* ============================================================
   ADVENTURE MAP ROSTER — data-driven campaign backdrops.
   Thirty sectors: the ten launch-era worlds, ten v1.8 escalation
   inserts, and ten v1.8.1 approach sectors.
============================================================ */
const MAPS = [
  /* UPGRADE(content v1.9): SECTOR IDENTITY PASS. Every sector was reworked
     so that no two share a painter + skyTint + palette signature — the old
     roster reused ice/0x9fd0ff four times and gas/0xffd9a0 twice, so those
     arenas read as the same place under a different name. Each sector also
     carries exactly one signature enemy PAIR (the top two weights: see the
     inline comments), so the combat read changes when the backdrop does.
     The four ladders (hpMult / spdMult / eliteChance / bossMult) are now
     non-decreasing across all thirty — dips at the old SECTOR 20 and
     SECTOR 28 made the endgame boss easier than the one before it.
     Hazards stay where game.js can post its entry callouts: exactly one
     ionstorm (MAGNETAR THRONE) and one meteors sector (ABYSSAL FORGE),
     with three black holes and four nebulae tuned per sector. */
  { name: 'ASHVEIL ORBIT', intro: 'CLEAR THE BURNING PICKET',
    planet: { painter: 'rocky', palette: [[34, 20, 16], [118, 58, 30], [228, 140, 64]],
              pos: [2600, 700, -3600], radius: 620, atmo: 0xff9a50, tilt: -0.25, bump: 5, spin: 0.005 },
    skyTint: 0xff8a5c,
    weights: { fighter: 6, drone: 3, gunship: 1, mine: 1 },   // signature: fighter screen / drone cover
    faction: 'swarm',
    hpMult: 1.0, spdMult: 1.0, eliteChance: 0.05,
    waves: 3, bossMult: 1.0 },
  { name: 'GLACIUS RIFT', intro: 'WRECK FIELD — MIND THE MINES',
    planet: { painter: 'ice', pos: [-3000, 900, -3400], radius: 560,
              atmo: 0x7ab8e8, ring: [172, 208, 246], ringTilt: 0.3, tilt: 0.2, spin: 0.0045 },
    skyTint: 0x7fb6ff,
    weights: { fighter: 4, mine: 4, drone: 2, gunship: 2 },   // signature: fighter / mine (wreck field)
    faction: 'swarm',
    hpMult: 1.12, spdMult: 1.03, eliteChance: 0.07,
    waves: 3, bossMult: 1.15 },
  { name: 'FERROUS BASTION', intro: 'ROLL THE GUNSHIP WALL',
    planet: { painter: 'gas', palette: [[54, 56, 62], [104, 98, 90], [158, 142, 118], [80, 84, 94], [188, 172, 146]],
              pos: [3400, -400, -4200], radius: 900, ring: [196, 178, 148], ringTilt: 0.35, tilt: 0.3, spin: 0.003 },
    skyTint: 0xc8b48c,
    weights: { gunship: 5, bomber: 3, fighter: 2, mine: 1 },   // signature: gunship / bomber (the wall)
    faction: 'militia',
    hpMult: 1.24, spdMult: 1.03, eliteChance: 0.09,
    waves: 3, bossMult: 1.3 },
  { name: 'CINDER REACH', intro: 'CUT THE ESCORT PAIRS',
    planet: { painter: 'desert', palette: [[70, 52, 34], [178, 146, 96], [250, 226, 168]],
              pos: [2400, 560, -3900], radius: 700, atmo: 0xffe0a8, tilt: 0.22, spin: 0.0042 },
    skyTint: 0xffcf7a,
    weights: { fighter: 5, bomber: 4, drone: 3, mine: 2, gunship: 1 },   // signature: fighter / bomber
    faction: 'swarm',
    hpMult: 1.36, spdMult: 1.06, eliteChance: 0.11,
    waves: 4, bossMult: 1.45 },
  { name: 'VERDANT MAW', intro: 'ROOT OUT THE CANOPY NEST',
    planet: { painter: 'terran', city: true, pos: [-2600, 1100, 3600], radius: 640,
              atmo: 0x5f9fe8, tilt: 0.35, spin: 0.004 },
    skyTint: 0x7fffbe,
    weights: { drone: 5, mine: 4, fighter: 3, gunship: 2 },   // signature: drone / mine (mines in the roots)
    faction: 'swarm',
    hpMult: 1.46, spdMult: 1.07, eliteChance: 0.13,
    waves: 4, bossMult: 1.58 },
  { name: 'MAGMA LATTICE', intro: 'BREAK THE FORGE LINE',
    planet: { painter: 'lava', palette: [[20, 8, 6], [148, 38, 14], [255, 132, 44]],
              pos: [-2900, -700, -3600], radius: 820, atmo: 0xff9040, tilt: -0.24, bump: 6, spin: 0.0036 },
    skyTint: 0xff7a3c,
    weights: { ravager: 4, reaper: 3, fighter: 3, bomber: 2, mine: 1 },   // reaper kill-teams fly the forge line
    faction: 'militia',
    hpMult: 1.56, spdMult: 1.07, eliteChance: 0.15,
    waves: 4, bossMult: 1.72 },
  { name: 'SPORE CHOKE', intro: 'KILL THE PROWLER NEST',
    planet: { painter: 'toxic', palette: [[30, 38, 10], [124, 158, 40], [226, 244, 120]],
              pos: [3100, 800, 3500], radius: 660, atmo: 0xd0ff90, tilt: 0.3, spin: 0.0044 },
    skyTint: 0xb6ff6a,
    weights: { prowler: 4, hive: 3, drone: 3, fighter: 2, mine: 2 },   // signature: prowler / hive
    faction: 'swarm',
    hpMult: 1.66, spdMult: 1.1, eliteChance: 0.16,
    waves: 4, bossMult: 1.84 },
  { name: 'KHARYBDIS THRESHOLD', intro: 'SURVIVE THE THRESHOLD FLIGHT',
    planet: { painter: 'gas', palette: [[40, 22, 62], [92, 44, 130], [150, 84, 186], [62, 34, 92], [186, 132, 220]],
              pos: [2800, 1600, -4400], radius: 1100, ring: [196, 152, 222], ringTilt: 0.28, tilt: -0.4, spin: 0.0026 },
    skyTint: 0xb98cff,
    weights: { gunship: 4, drone: 3, bomber: 3, mine: 2, ravager: 2 },   // signature: gunship / drone
    faction: 'mixed',
    hpMult: 1.74, spdMult: 1.12, eliteChance: 0.18,
    waves: 4, bossMult: 1.96 },
  { name: 'PRISM SPIRE', intro: 'SHATTER THE SENTINEL SPIRE',
    planet: { painter: 'crystal', palette: [[26, 24, 54], [112, 100, 196], [212, 204, 255]],
              pos: [-3400, 1200, 3000], radius: 900, atmo: 0xd8ccff,
              ring: [188, 176, 252], ringTilt: 0.24, tilt: 0.34, spin: 0.0034 },
    skyTint: 0xe0d4ff,
    weights: { sentinel: 4, interceptor: 3, reaper: 2, prowler: 2, gunship: 2, mine: 2 },   // signature: sentinel / interceptor
    faction: 'coalition',
    hpMult: 1.8, spdMult: 1.12, eliteChance: 0.19,
    waves: 4, bossMult: 2.06 },
  { name: 'SEARING HALO', intro: 'KILL WELLS BEFORE THEY SPIN',
    planet: { painter: 'gas', palette: [[110, 40, 14], [206, 100, 34], [255, 184, 104], [144, 64, 26], [255, 226, 164]],
              pos: [-3400, -600, -3800], radius: 980, ring: [255, 214, 156], ringTilt: 0.42, tilt: 0.42, spin: 0.0032 },
    skyTint: 0xffbe84,
    weights: { bomber: 4, interdictor: 3, fighter: 3, gunship: 2, mine: 2 },   // interdictor wells stage the sunside line
    faction: 'militia',
    hpMult: 1.88, spdMult: 1.15, eliteChance: 0.2,
    waves: 4, bossMult: 2.16 },
  { name: 'ABYSSAL SHELF', intro: 'CLEAR THE HIVE RIDGE',
    planet: { painter: 'ocean', palette: [[6, 22, 48], [26, 78, 144], [112, 192, 240]],
              pos: [3700, -1000, -3100], radius: 980, atmo: 0x8fc8ff, tilt: -0.28, spin: 0.003 },
    skyTint: 0x5aa8e8,
    weights: { hive: 4, interceptor: 3, prowler: 3, gunship: 2, bomber: 2 },   // signature: hive / interceptor
    faction: 'mixed',
    hpMult: 1.94, spdMult: 1.15, eliteChance: 0.21,
    waves: 4, bossMult: 2.24 },
  { name: 'OBSIDIAN VEIL', intro: 'KILL THE BLACK FLEET ANCHOR',
    planet: { painter: 'rocky', palette: [[12, 10, 16], [30, 24, 38], [62, 50, 80]],
              pos: [3200, -900, 4200], radius: 760, atmo: 0x9a5fe8, tilt: -0.3, bump: 7, spin: 0.0038 },
    skyTint: 0x9c6cff,
    weights: { reaper: 4, sentinel: 3, interdictor: 3, fighter: 2, ravager: 2 },   // signature: reaper / sentinel (repair-anchored core)
    faction: 'militia',
    hpMult: 2.02, spdMult: 1.17, eliteChance: 0.23,
    waves: 5, bossMult: 2.34 },
  { name: 'KERN VEIL', intro: 'FIGHT THE TIDAL PULL',
    /* black hole map: the star is gutted, and the ash world it left behind
       is the only solid landmark in the pull. */
    blackhole: { pos: [0, -140, -1500] },
    planet: { painter: 'ashen', palette: [[26, 24, 24], [74, 70, 68], [178, 96, 52]],
              pos: [-2800, 480, -3300], radius: 700, atmo: 0xffa060, tilt: 0.24, bump: 5, spin: 0.0034 },
    skyTint: 0xff9a6a,
    weights: { drone: 4, interceptor: 4, hive: 3, gunship: 2, bomber: 2, mine: 2 },   // pod swarm in gravity
    faction: 'swarm',
    hpMult: 2.08, spdMult: 1.17, eliteChance: 0.24,
    waves: 4, bossMult: 2.42 },
  { name: 'RIME WARDEN', intro: 'TAKE THE LONG LINE',
    planet: { painter: 'tundra', palette: [[26, 38, 54], [128, 160, 190], [228, 240, 255]],
              pos: [-3600, -1200, -3000], radius: 760, atmo: 0xc8e8ff,
              ring: [204, 226, 250], ringTilt: 0.3, tilt: 0.26, spin: 0.0038 },
    skyTint: 0x8fd8ff,
    weights: { sentinel: 4, drone: 3, reaper: 3, interdictor: 2, fighter: 2, mine: 2 },   // signature: sentinel / drone (a grid that waits)
    faction: 'coalition',
    hpMult: 2.12, spdMult: 1.18, eliteChance: 0.25,
    waves: 4, bossMult: 2.48 },
  { name: 'CLOUD OF MAGNUS', intro: 'KILL THE CHOIR IN THE FOG',
    /* nebula map: layered volumetric clouds, radar at 45%, storm arcs —
       the shrouded giant inside them is the only bulk on the scope. */
    nebula: { density: 1.0, hue: 0.58 },
    planet: { painter: 'gas', palette: [[52, 60, 78], [128, 150, 180], [214, 228, 244], [74, 88, 112], [240, 246, 255]],
              pos: [3200, 1300, 3400], radius: 1200, ring: [186, 206, 236], ringTilt: 0.26, tilt: -0.3, spin: 0.0022 },
    skyTint: 0x6cbcff,
    weights: { interceptor: 4, drone: 3, hive: 3, bomber: 2, gunship: 2, sentinel: 2 },   // signature: interceptor / drone
    faction: 'mixed',
    hpMult: 2.16, spdMult: 1.2, eliteChance: 0.26,
    waves: 4, bossMult: 2.54 },
  { name: 'HALCYON SHARD', intro: 'BREAK THE LOCK BEFORE IT MATURES',
    planet: { painter: 'ice', pos: [2500, 1300, 4000], radius: 620,
              atmo: 0x9fd8ff, ring: [206, 228, 250], ringTilt: 0.36, tilt: -0.2, spin: 0.0046 },
    skyTint: 0xa8e0ff,
    weights: { reaper: 4, prowler: 3, interceptor: 2, ravager: 2, mine: 2 },   // signature: reaper / prowler (cheap locks)
    faction: 'militia',
    hpMult: 2.2, spdMult: 1.2, eliteChance: 0.27,
    waves: 4, bossMult: 2.6 },
  { name: 'COBALT WAKE', intro: 'TAKE THE SUPPLY LANE',
    planet: { painter: 'rocky', palette: [[12, 20, 34], [38, 68, 104], [96, 158, 196]],
              pos: [4000, -300, 2900], radius: 560, atmo: 0x5fb0e8, tilt: 0.2, bump: 4, spin: 0.005 },
    skyTint: 0x5c9cf0,
    weights: { ravager: 4, bomber: 3, prowler: 3, interdictor: 2, fighter: 2 },   // signature: ravager / bomber (freighter escorts)
    faction: 'militia',
    hpMult: 2.24, spdMult: 1.21, eliteChance: 0.28,
    waves: 4, bossMult: 2.66 },
  { name: 'AMETHYST GULF', intro: 'FIRE ON THE ONES THAT MOVE',
    /* nebula + gas giant (the v1.8-only combo): violet fog swallows the
       radar while the bands of the gulf's giant stay on the eye. */
    nebula: { density: 0.85, hue: 0.44 },
    planet: { painter: 'gas', palette: [[44, 22, 66], [104, 58, 148], [176, 124, 222], [66, 38, 100], [210, 176, 244]],
              pos: [-3900, 600, 3400], radius: 1150, atmo: 0xc0a0ff,
              ring: [206, 176, 246], ringTilt: 0.34, tilt: 0.3, spin: 0.0024 },
    skyTint: 0xc48cff,
    weights: { hive: 4, sentinel: 3, interceptor: 3, gunship: 2, drone: 2 },   // signature: hive / sentinel (one signal)
    faction: 'mixed',
    hpMult: 2.28, spdMult: 1.23, eliteChance: 0.29,
    waves: 5, bossMult: 2.72 },
  { name: 'SPECTER KNOT', intro: 'HOLD FORMATION BY INSTRUMENT',
    /* black hole at a fresh offset — a different approach lane than KERN VEIL. */
    blackhole: { pos: [420, -260, -2600] },
    planet: { painter: 'terran', city: true, pos: [3600, 1500, -3600], radius: 700,
              atmo: 0x8f7fe8, tilt: 0.32, spin: 0.0032 },
    skyTint: 0xb87cff,
    weights: { prowler: 4, reaper: 3, ravager: 3, sentinel: 2, interdictor: 2, hive: 2 },   // signature: prowler / ravager
    faction: 'coalition',
    hpMult: 2.32, spdMult: 1.25, eliteChance: 0.3,
    waves: 5, bossMult: 2.78 },
  { name: 'EMBER CASCADE', intro: 'SWEEP THE SLEEPING MINEFIELD',
    planet: { painter: 'ashen', palette: [[20, 12, 10], [78, 44, 30], [214, 124, 54]],
              pos: [2300, -700, -4300], radius: 780, atmo: 0xff9050, tilt: -0.26, bump: 6, spin: 0.0036 },
    skyTint: 0xffb060,
    weights: { sapper: 4, mine: 4, fighter: 3, gunship: 2, drone: 2 },   // sappers seed the lane, mines finish it
    faction: 'militia',
    hpMult: 2.4, spdMult: 1.25, eliteChance: 0.31,
    waves: 4, bossMult: 2.84 },
  { name: 'FRACTAL PRISM', intro: 'DO NOT TAKE THE BAIT LANE',
    planet: { painter: 'crystal', palette: [[16, 14, 44], [84, 60, 164], [228, 168, 255]],
              pos: [-3800, 900, 2800], radius: 880, atmo: 0xe0c8ff,
              ring: [196, 170, 255], ringTilt: 0.22, tilt: 0.3, spin: 0.0032 },
    skyTint: 0xc0b0ff,
    weights: { interceptor: 4, bomber: 3, sentinel: 3, gunship: 2, mine: 2 },   // signature: interceptor / bomber (mirror passes)
    faction: 'coalition',
    hpMult: 2.48, spdMult: 1.26, eliteChance: 0.32,
    waves: 4, bossMult: 2.9 },
  { name: 'WRAITH STORM', intro: 'WATCH YOUR SIX, NOT THE SCOPE',
    /* nebula-only fog over a storm-frozen world — radar dies inside the cell. */
    nebula: { density: 0.9, hue: 0.86 },
    planet: { painter: 'tundra', palette: [[34, 36, 44], [124, 132, 146], [238, 242, 248]],
              pos: [3400, 1400, -4600], radius: 900, atmo: 0xe8f0ff, tilt: -0.36, spin: 0.0034 },
    skyTint: 0xd88cb0,
    weights: { drone: 4, prowler: 3, reaper: 3, interceptor: 2, fighter: 2 },   // signature: drone / prowler (knife range)
    faction: 'mixed',
    hpMult: 2.56, spdMult: 1.28, eliteChance: 0.33,
    waves: 4, bossMult: 2.96 },
  { name: 'GOLIATH DRIFT', intro: 'HIT THEM BEFORE WELLS SPIN UP',
    planet: { painter: 'desert', palette: [[44, 26, 18], [122, 72, 40], [206, 150, 96]],
              pos: [-2700, 1200, 3900], radius: 640, atmo: 0xffb070, tilt: 0.3, spin: 0.004 },
    skyTint: 0xd88a50,
    weights: { ravager: 4, interdictor: 3, bomber: 3, fighter: 2, mine: 2 },   // signature: ravager / interdictor
    faction: 'militia',
    hpMult: 2.64, spdMult: 1.28, eliteChance: 0.34,
    waves: 4, bossMult: 3.0 },
  { name: 'MALEVOLENT HAZE', intro: 'NEVER FLY STRAIGHT HERE',
    /* black hole + sickly teal toxic world: the haze tugs toward the point
       of no return while cloaked stalkers hunt the drift. */
    blackhole: { pos: [380, -220, -2900] },
    planet: { painter: 'toxic', palette: [[10, 24, 22], [64, 116, 104], [146, 232, 196]],
              pos: [3000, -900, 3600], radius: 700, atmo: 0xa0ffd0, tilt: 0.27, spin: 0.0042 },
    skyTint: 0x8fffd0,
    weights: { stalker: 4, hive: 3, drone: 3, gunship: 2, mine: 2 },   // signature: stalker / hive
    faction: 'swarm',
    hpMult: 2.72, spdMult: 1.29, eliteChance: 0.35,
    waves: 5, bossMult: 3.06 },
  { name: 'VITRIFIED SHELL', intro: 'GRIND DOWN THE GLASS PATROL',
    planet: { painter: 'ice', pos: [-2400, 1100, -4100], radius: 640,
              atmo: 0x8fc8f0, ring: [176, 204, 232], ringTilt: 0.34, tilt: -0.22, spin: 0.0044 },
    skyTint: 0x6fb0e0,
    weights: { sentinel: 4, stalker: 3, reaper: 3, fighter: 2, mine: 2 },   // signature: sentinel / stalker
    faction: 'coalition',
    hpMult: 2.8, spdMult: 1.3, eliteChance: 0.35,
    waves: 5, bossMult: 3.12 },
  { name: 'ABYSSAL FORGE', intro: 'CROSS BETWEEN THE VOLLEYS',
    /* meteors: periodic asteroid volleys hammer the deep picket. */
    meteors: { rate: 1.0 },
    planet: { painter: 'ocean', palette: [[4, 18, 44], [20, 70, 140], [84, 166, 230]],
              pos: [3800, -1100, -3400], radius: 1000, atmo: 0x7fb8f0, tilt: 0.28, spin: 0.003 },
    skyTint: 0x3c88d8,
    weights: { warden: 4, bomber: 3, mine: 3, gunship: 2, interceptor: 2 },   // wardens ride the volleys in
    faction: 'mixed',
    hpMult: 2.88, spdMult: 1.3, eliteChance: 0.36,
    waves: 5, bossMult: 3.18 },
  { name: 'GLACIAL EMBRACE', intro: 'PUNCH THE ONLY WARM LANE',
    planet: { painter: 'tundra', palette: [[22, 34, 50], [118, 152, 186], [220, 236, 255]],
              pos: [-3600, -800, 3200], radius: 780, atmo: 0xd0e8ff,
              ring: [206, 228, 252], ringTilt: 0.3, tilt: 0.28, spin: 0.0036 },
    skyTint: 0x74c4ff,
    weights: { warden: 4, interdictor: 3, sentinel: 3, reaper: 2, fighter: 2 },   // warden pairs hold the lane
    faction: 'coalition',
    hpMult: 2.96, spdMult: 1.31, eliteChance: 0.37,
    waves: 5, bossMult: 3.24 },
  { name: 'IRON CRUCIBLE', intro: 'BREAK THE LINE BEFORE THE POUR',
    planet: { painter: 'rocky', palette: [[26, 18, 16], [92, 50, 28], [186, 106, 52]],
              pos: [3400, -600, -3100], radius: 680, atmo: 0xffa060, tilt: 0.24, bump: 6, spin: 0.004 },
    skyTint: 0xff7840,
    weights: { reaper: 4, sapper: 3, ravager: 3, prowler: 2, interdictor: 2 },   // sappers seed it, reapers finish it
    faction: 'militia',
    hpMult: 3.05, spdMult: 1.32, eliteChance: 0.38,
    waves: 5, bossMult: 3.3 },
  { name: 'MAGNETAR THRONE', intro: 'HULL, GUNS, NERVE — NO SHIELDS',
    /* ionstorm: the magnetar's flare field takes shields offline in-sector. */
    ionstorm: { intensity: 1.0 },
    planet: { painter: 'magnetar', palette: [[6, 3, 22], [80, 22, 160], [160, 52, 224]],
              pos: [0, 800, -5000], radius: 1000, atmo: 0x00e8ff,
              ring: [120, 220, 255], ringTilt: 0.4, tilt: 0.4, spin: 0.0022 },
    skyTint: 0x78ccff,
    weights: { stalker: 4, warden: 3, reaper: 3, prowler: 2, sentinel: 2 },   // throne host: cloaked and shielded-free
    faction: 'coalition',
    hpMult: 3.18, spdMult: 1.33, eliteChance: 0.39,
    waves: 5, bossMult: 3.34 },
  { name: 'EVENT HORIZON', intro: 'LAST GATE — NO BACKUP',
    /* finale: black hole + nebula + the whole remnant fleet, all active.
       the lava world here is already coming apart in the tide. */
    blackhole: { pos: [0, -140, -1500] },
    nebula: { density: 0.55, hue: 0.78 },
    planet: { painter: 'lava', palette: [[14, 6, 10], [104, 20, 32], [255, 92, 72]],
              pos: [3300, -300, -4300], radius: 900, atmo: 0xff6a80, tilt: -0.34, bump: 6, spin: 0.003 },
    skyTint: 0xff7ad0,
    weights: { ravager: 4, interceptor: 3, hive: 3, interdictor: 3, sentinel: 2, gunship: 2, bomber: 2 },
    faction: 'mixed',
    hpMult: 3.35, spdMult: 1.35, eliteChance: 0.4,
    waves: 5, bossMult: 3.4 },
];


