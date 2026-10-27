/* ============================================================
   FX.JS — all visual effects
   ------------------------------------------------------------
   LOAD ORDER: after engine.js (uses U, scratch vectors, CFG;
   binds G.scene at FX.init). Pooled particles / debris / shock
   rings / flashes / embers / explosion compositor + trauma
   (screen shake). Split from the old core — logic untouched.
============================================================ */

/* ============================================================
   [SECTION 5] FX — particles, debris, shock rings, lights, shake
   ------------------------------------------------------------
   Everything here is POOLED. The particle system is a single
   THREE.Points draw call with custom shader attributes — up to
   2600 particles, allocated from a ring buffer (oldest particle
   is recycled when full). Debris chunks are one InstancedMesh.
   This is what keeps "chaos" cheap: 300 live sparks = 1 draw call.
============================================================ */

/* ---------------- particle pool ---------------- */
class ParticlePool {
  constructor(scene, max) {
    this.max = max; this.cursor = 0;
    // simulation state (SoA — cache friendly, no per-particle objects)
    this.px = new Float32Array(max); this.py = new Float32Array(max); this.pz = new Float32Array(max);
    this.vx = new Float32Array(max); this.vy = new Float32Array(max); this.vz = new Float32Array(max);
    this.life = new Float32Array(max); this.maxLife = new Float32Array(max);
    this.drag = new Float32Array(max); this.grow = new Float32Array(max);
    this.baseSize = new Float32Array(max);
    // GPU attribute mirrors
    this.aPos = new Float32Array(max * 3);
    this.aCol = new Float32Array(max * 3);
    this.aSize = new Float32Array(max);
    this.aLife01 = new Float32Array(max);

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.aPos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aColor', new THREE.BufferAttribute(this.aCol, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aSize', new THREE.BufferAttribute(this.aSize, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('aLife01', new THREE.BufferAttribute(this.aLife01, 1).setUsage(THREE.DynamicDrawUsage));

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 600 } },
      vertexShader: `
        attribute vec3 aColor; attribute float aSize; attribute float aLife01;
        uniform float uScale;
        varying vec3 vColor; varying float vLife;
        void main(){
          vColor = aColor; vLife = aLife01;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          // perspective-correct point size (world-size ~ aSize at distance z)
          gl_PointSize = min(aSize * (uScale / max(1.0, -mv.z)), 96.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor; varying float vLife;
        void main(){
          if (vLife <= 0.0) discard;
          vec2 uv = gl_PointCoord * 2.0 - 1.0;
          float r2 = dot(uv, uv);
          if (r2 > 1.0) discard;
          float mask = (1.0 - r2); mask *= mask;              // soft round falloff
          float fade = smoothstep(0.0, 0.12, vLife) * vLife;  // pop-in, ease-out
          gl_FragColor = vec4(vColor * (0.75 + 0.7 * vLife), fade * mask);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(geo, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
    this.alive = 0;
    this._colDirty = false;
  }

  // ring-buffer spawn: recycles the OLDEST slot when saturated
  spawn(x, y, z, vx, vy, vz, r, g, b, size, life, drag, grow) {
    const i = this.cursor; this.cursor = (this.cursor + 1) % this.max;
    this.px[i] = x; this.py[i] = y; this.pz[i] = z;
    this.vx[i] = vx; this.vy[i] = vy; this.vz[i] = vz;
    this.life[i] = life; this.maxLife[i] = life;
    this.drag[i] = drag; this.grow[i] = grow || 0;
    this.baseSize[i] = size;
    const j = i * 3;
    this.aCol[j] = r; this.aCol[j + 1] = g; this.aCol[j + 2] = b;
    this._colDirty = true;
  }

  clear() { this.life.fill(0); this.aLife01.fill(0); this.cursor = 0; this.alive = 0; }

  update(dt) {
    let alive = 0;
    for (let i = 0; i < this.max; i++) {
      const l = this.life[i];
      if (l <= 0) { this.aLife01[i] = 0; continue; }
      alive++;
      const nl = l - dt;
      if (nl <= 0) { this.life[i] = 0; this.aLife01[i] = 0; continue; }
      this.life[i] = nl;
      // integrate + drag
      const dr = Math.max(0, 1 - this.drag[i] * dt);
      this.vx[i] *= dr; this.vy[i] *= dr; this.vz[i] *= dr;
      this.px[i] += this.vx[i] * dt; this.py[i] += this.vy[i] * dt; this.pz[i] += this.vz[i] * dt;
      const j = i * 3;
      this.aPos[j] = this.px[i]; this.aPos[j + 1] = this.py[i]; this.aPos[j + 2] = this.pz[i];
      this.aLife01[i] = nl / this.maxLife[i];
      this.aSize[i] = this.baseSize[i] + this.grow[i] * (this.maxLife[i] - nl);
    }
    this.alive = alive;
    // UPGRADE(perf): when nothing is alive (menus, quiet moments) skip ALL
    // attribute re-uploads. One extra upload fires on the frame the last
    // particle dies so the GPU sees the cleared aLife01.
    if (!alive && !this._hadAlive && !this._colDirty) return;
    this._hadAlive = alive > 0;
    const g = this.points.geometry;
    g.attributes.position.needsUpdate = true;
    // FIX(perf): colors only ever change on spawn — skip the re-upload
    // unless something spawned this frame.
    g.attributes.aColor.needsUpdate = !!this._colDirty;
    this._colDirty = false;
    g.attributes.aSize.needsUpdate = true;
    g.attributes.aLife01.needsUpdate = true;
  }

  // keep the point-size/scale consistent with canvas size + FOV kicks
  syncScale(camera, canvasH) {
    this.mat.uniforms.uScale.value = canvasH / (2 * Math.tan(camera.fov * 0.5 * Math.PI / 180));
  }
}

/* ---------------- tumbling debris chunks (one InstancedMesh) ---------------- */
class DebrisPool {
  constructor(scene, count) {
    this.count = count;
    const geo = new THREE.IcosahedronGeometry(0.55, 0);
    displaceVertices(geo, 0.5, 2); // craggy little rocks
    const mat = new THREE.MeshStandardMaterial({ color: 0x6b5f52, roughness: 0.9, metalness: 0.15, flatShading: true });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.dummy = new THREE.Object3D();
    this.slots = [];
    for (let i = 0; i < count; i++) {
      this.slots.push({ active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        rot: new THREE.Euler(), rvx: 0, rvy: 0, rvz: 0, scale: 1, life: 0, maxLife: 1 });
      this._hide(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  _hide(i) { this.dummy.position.set(0, 0, 0); this.dummy.scale.setScalar(0); this.dummy.updateMatrix();
    this.mesh.setMatrixAt(i, this.dummy.matrix); }
  spawn(pos, vel, scale, life) {
    for (let i = 0; i < this.count; i++) {
      const s = this.slots[i];
      if (!s.active) {
        s.active = true;
        s.pos.copy(pos); s.vel.copy(vel);
        s.rot.set(U.rand(0, 6.28), U.rand(0, 6.28), U.rand(0, 6.28));
        s.rvx = U.rand(-6, 6); s.rvy = U.rand(-6, 6); s.rvz = U.rand(-6, 6);
        s.scale = scale * U.rand(0.6, 1.4);
        s.life = s.maxLife = life * U.rand(0.7, 1.3);
        return;
      }
    }
  }
  burst(pos, count, power, scale) {
    for (let i = 0; i < count; i++) {
      U.randomDir(_v1).multiplyScalar(U.rand(0.3, 1) * power);
      _v1.addScaledVector(G.player ? G.player.vel : _v2.set(0, 0, 0), 0.25);
      this.spawn(pos, _v1, scale, U.rand(1.4, 2.6));
    }
  }
  update(dt) {
    let anyActive = false;
    for (let i = 0; i < this.count; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      anyActive = true;
      s.life -= dt;
      if (s.life <= 0) { s.active = false; this._hide(i); continue; }
      s.pos.addScaledVector(s.vel, dt);
      s.vel.multiplyScalar(Math.max(0, 1 - 0.25 * dt));
      s.rot.x += s.rvx * dt; s.rot.y += s.rvy * dt; s.rot.z += s.rvz * dt;
      // shrink out over the last 25% of life (cheap "fade")
      const k = Math.min(1, s.life / (s.maxLife * 0.25));
      this.dummy.position.copy(s.pos);
      this.dummy.rotation.copy(s.rot);
      this.dummy.scale.setScalar(s.scale * k);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    // UPGRADE(perf): skip the GPU upload entirely on empty frames
    if (anyActive) this.mesh.instanceMatrix.needsUpdate = true;
  }
  clear() { for (let i = 0; i < this.count; i++) { this.slots[i].active = false; this._hide(i); }
    this.mesh.instanceMatrix.needsUpdate = true; }
}

/* ---------------- expanding shock rings ---------------- */
class RingPool {
  constructor(scene, count) {
    this.pool = [];
    const geo = new THREE.RingGeometry(0.86, 1, 48);
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false; m.frustumCulled = false;
      scene.add(m);
      this.pool.push({ mesh: m, t: 0, dur: 0.5, maxR: 20 });
    }
  }
  spawn(pos, maxR, color, dur = 0.55) {
    for (const r of this.pool) {
      if (r.mesh.visible) continue;
      r.mesh.visible = true; r.mesh.position.copy(pos);
      r.t = 0; r.dur = dur; r.maxR = maxR;
      r.mesh.material.color.set(color);
      return;
    }
  }
  update(dt) {
    for (const r of this.pool) {
      if (!r.mesh.visible) continue;
      r.t += dt;
      const k = r.t / r.dur;
      if (k >= 1) { r.mesh.visible = false; continue; }
      const e = 1 - Math.pow(1 - k, 3);          // easeOutCubic expansion
      r.mesh.scale.setScalar(U.lerp(2, r.maxR, e));
      r.mesh.material.opacity = Math.pow(1 - k, 1.6) * 0.85;
      r.mesh.quaternion.copy(G.camera.quaternion); // billboard toward camera
    }
  }
  clear() { for (const r of this.pool) r.mesh.visible = false; }
}

/* ---------------- pooled flash point-lights ---------------- */
class FlashPool {
  constructor(scene, count) {
    this.pool = [];
    for (let i = 0; i < count; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 320, 2);
      scene.add(l);
      this.pool.push({ light: l, t: 0, dur: 0.3, peak: 3 });
    }
  }
  spawn(pos, color, peak, dur = 0.3) {
    let best = this.pool[0];
    for (const f of this.pool) { if (f.t >= f.dur) { best = f; break; }
      if (f.t > best.t) best = f; }
    best.light.position.copy(pos);
    best.light.color.set(color);
    best.peak = peak; best.t = 0; best.dur = dur;
    best.light.intensity = peak;
  }
  update(dt) {
    for (const f of this.pool) {
      if (f.t >= f.dur) { f.light.intensity = 0; continue; }
      f.t += dt;
      const k = U.clamp(f.t / f.dur, 0, 1);
      f.light.intensity = f.peak * (1 - k) * (1 - k); // quadratic decay reads as a "bang"
    }
  }
  clear() { for (const f of this.pool) { f.t = f.dur; f.light.intensity = 0; } }
}

/* ---------------- UPGRADE(explosions): expanding fireball cores ----------
   Additive spheres that punch out of the blast center — fast expand,
   fast fade. Reads as the SOLID heart of the explosion between the
   spark spray and the debris. One shared geometry, recycled slots. */
class FlashSpherePool {
  constructor(scene, count) {
    const geo = new THREE.SphereGeometry(1, 20, 14);
    this.pool = [];
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true,
        opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false; m.frustumCulled = false;
      scene.add(m);
      this.pool.push({ mesh: m, t: 0, dur: 0.4, maxR: 10 });
    }
  }
  spawn(pos, maxR, color, dur = 0.4) {
    for (const f of this.pool) {
      if (f.mesh.visible) continue;
      f.mesh.visible = true;
      f.mesh.position.copy(pos);
      f.t = 0; f.dur = dur; f.maxR = maxR;
      f.mesh.material.color.set(color);
      f.mesh.scale.setScalar(0.1);
      return;
    }
  }
  update(dt) {
    for (const f of this.pool) {
      if (!f.mesh.visible) continue;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) { f.mesh.visible = false; continue; }
      const e = 1 - Math.pow(1 - k, 2.2);          // fast out, gentle settle
      f.mesh.scale.setScalar(0.4 + e * f.maxR);
      f.mesh.material.opacity = Math.pow(1 - k, 1.4) * 0.95;
    }
  }
  clear() { for (const f of this.pool) f.mesh.visible = false; }
}

/* ---------------- UPGRADE(explosions): glowing ember shards --------------
   Molten fragments blown OUT of a kill: brighter, faster and longer-lived
   than the dull rock debris, they spin, cool white→orange→deep red via
   per-instance color, and shrink out. Own InstancedMesh so the standard
   debris keeps its cold look. */
class EmberPool {
  constructor(scene, count) {
    this.count = count;
    const geo = new THREE.TetrahedronGeometry(0.32, 0);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(geo, mat, count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);
    this.dummy = new THREE.Object3D();
    this._c = new THREE.Color();
    this.slots = [];
    for (let i = 0; i < count; i++) {
      this.slots.push({ active: false, pos: new THREE.Vector3(), vel: new THREE.Vector3(),
        ax: new THREE.Vector3(0, 1, 0), rv: 8, scale: 1, life: 0, maxLife: 1 });
      this._hide(i);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  _hide(i) { this.dummy.position.set(0, 0, 0); this.dummy.scale.setScalar(0);
    this.dummy.updateMatrix(); this.mesh.setMatrixAt(i, this.dummy.matrix); }
  burst(pos, count, power, scale) {
    for (let n = 0; n < count; n++) {
      let slot = -1;
      for (let i = 0; i < this.count; i++) if (!this.slots[i].active) { slot = i; break; }
      if (slot < 0) return;                       // pool saturated — skip
      const s = this.slots[slot];
      s.active = true;
      s.pos.copy(pos);
      U.randomDir(s.vel).multiplyScalar(U.rand(0.4, 1) * power);
      if (G.player) s.vel.addScaledVector(G.player.vel, 0.3);
      s.scale = scale * U.rand(0.5, 1.3);
      s.life = s.maxLife = U.rand(0.7, 1.6);
      s.ax.set(U.rand(-1, 1), U.rand(-1, 1), U.rand(-1, 1)).normalize();
      s.rv = U.rand(4, 14);
    }
  }
  update(dt) {
    let dirty = false;
    for (let i = 0; i < this.count; i++) {
      const s = this.slots[i];
      if (!s.active) continue;
      dirty = true;
      s.life -= dt;
      if (s.life <= 0) { s.active = false; this._hide(i); continue; }
      s.pos.addScaledVector(s.vel, dt);
      s.vel.multiplyScalar(Math.max(0, 1 - 0.5 * dt));
      this.dummy.position.copy(s.pos);
      this.dummy.quaternion.setFromAxisAngle(s.ax, s.life * s.rv);
      const heat = Math.min(1, s.life / (s.maxLife * 0.4));
      this.dummy.scale.setScalar(s.scale * heat);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
      // cool: white-hot → orange → deep red as it dies
      this._c.setRGB(1, 0.3 + heat * 0.68, 0.08 + heat * 0.55);
      this.mesh.setColorAt(i, this._c);
    }
    if (dirty) {
      this.mesh.instanceMatrix.needsUpdate = true;
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }
  }
  clear() { for (let i = 0; i < this.count; i++) { this.slots[i].active = false; this._hide(i); }
    this.mesh.instanceMatrix.needsUpdate = true; }
}

/* ---------------- UPGRADE(explosions): 3D blast waves ---------------------
   The old shock rings billboarded toward the camera — readable but
   flat. These are expanding translucent SPHERE DOMES: a real 3D
   pressure front that reads correctly from any angle, with a hot
   leading edge (fresnel-ish falloff via BackSide + additive). Slot
   count is tiny; they only exist for ~0.6s per blast. */
class ShockwavePool {
  constructor(scene, count) {
    const geo = new THREE.SphereGeometry(1, 28, 18);
    this.pool = [];
    for (let i = 0; i < count; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true,
        opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false,
        side: THREE.BackSide });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false; m.frustumCulled = false;
      scene.add(m);
      this.pool.push({ mesh: m, t: 0, dur: 0.6, maxR: 30 });
    }
  }
  spawn(pos, maxR, color, dur = 0.6) {
    for (const s of this.pool) {
      if (s.mesh.visible) continue;
      s.mesh.visible = true;
      s.mesh.position.copy(pos);
      s.t = 0; s.dur = dur; s.maxR = maxR;
      s.mesh.material.color.set(color);
      return;
    }
  }
  update(dt) {
    for (const s of this.pool) {
      if (!s.mesh.visible) continue;
      s.t += dt;
      const k = s.t / s.dur;
      if (k >= 1) { s.mesh.visible = false; continue; }
      // fast-out expansion that decelerates like a real pressure front
      const e = 1 - Math.pow(1 - k, 2.6);
      s.mesh.scale.setScalar(Math.max(0.1, e * s.maxR));
      s.mesh.material.opacity = Math.pow(1 - k, 1.7) * 0.5;
    }
  }
  clear() { for (const s of this.pool) s.mesh.visible = false; }
}

/* ---------------- UPGRADE(v1.5): NOISE-DRIVEN FIREBALL SHADER -----------
   The old flash spheres were flat additive blobs. This pool runs a
   real fragment shader: 3-octave value noise churns the sphere's
   alpha/emission over its lifetime, so every blast has turbulent,
   boiling structure instead of a smooth ball. One shared geometry,
   one shader, recycled slots — quality tier gates the count. */
function _noiseGLSL() {
  return `
  float h3(vec3 p){ return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
  float n3(vec3 p){
    vec3 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = h3(i), b = h3(i + vec3(1,0,0)), c = h3(i + vec3(0,1,0)), d = h3(i + vec3(1,1,0));
    float e = h3(i + vec3(0,0,1)), g = h3(i + vec3(1,0,1)), h = h3(i + vec3(0,1,1)), k = h3(i + vec3(1,1,1));
    return mix(mix(mix(a,b,f.x), mix(c,d,f.x), f.y), mix(mix(e,g,f.x), mix(h,k,f.x), f.y), f.z);
  }
  float fbm3(vec3 p){
    float s = 0.0, a = 0.5;
    for (int i = 0; i < 3; i++){ s += a * n3(p); p *= 2.1; a *= 0.5; }
    return s;
  }`;
}
class FireballPool {
  constructor(scene, count) {
    const geo = new THREE.SphereGeometry(1, 24, 18);
    this.pool = [];
    this._time = 0;
    for (let i = 0; i < count; i++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: {
          uTime: { value: 0 }, uSeed: { value: U.rand(0, 100) },
          uColor: { value: new THREE.Color(1, 0.55, 0.2) },
          uOpacity: { value: 0 },
        },
        vertexShader: `varying vec3 vN; varying vec3 vP;
          void main(){ vN = normalize(normal); vP = position;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
        fragmentShader: `uniform float uTime; uniform float uSeed;
          uniform vec3 uColor; uniform float uOpacity;
          varying vec3 vN; varying vec3 vP;
          ${_noiseGLSL()}
          void main(){
            // turbulent burn: noise scrolls through the sphere volume
            float n = fbm3(vP * 2.2 + vec3(uSeed) + vec3(0.0, -uTime * 1.6, uTime * 0.9));
            float limb = pow(1.0 - abs(dot(normalize(vN), vec3(0.0, 0.0, 1.0))), 1.4);
            float core = smoothstep(0.28, 0.72, n);
            vec3 hot = vec3(1.0, 0.92, 0.62);
            vec3 col = mix(uColor, hot, core);
            float a = uOpacity * (0.35 + 0.65 * core) * (0.55 + 0.45 * limb);
            gl_FragColor = vec4(col * (1.2 + core * 1.6), a);
          }`,
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      });
      const m = new THREE.Mesh(geo, mat);
      m.visible = false; m.frustumCulled = false;
      scene.add(m);
      this.pool.push({ mesh: m, t: 0, dur: 0.5, maxR: 8 });
    }
  }
  spawn(pos, maxR, color, dur = 0.5) {
    for (const f of this.pool) {
      if (f.mesh.visible) continue;
      f.mesh.visible = true;
      f.mesh.position.copy(pos);
      f.t = 0; f.dur = dur; f.maxR = maxR;
      f.mesh.material.uniforms.uColor.value.set(color);
      f.mesh.material.uniforms.uSeed.value = U.rand(0, 100);
      f.mesh.scale.setScalar(0.2);
      return;
    }
  }
  update(dt) {
    this._time += dt;
    for (const f of this.pool) {
      if (!f.mesh.visible) continue;
      f.t += dt;
      const k = f.t / f.dur;
      if (k >= 1) { f.mesh.visible = false; continue; }
      const e = 1 - Math.pow(1 - k, 2.0);
      f.mesh.scale.setScalar(0.3 + e * f.maxR);
      f.mesh.material.uniforms.uTime.value = f.t;
      f.mesh.material.uniforms.uOpacity.value = Math.pow(1 - k, 1.5);
    }
  }
  clear() { for (const f of this.pool) f.mesh.visible = false; }
}

/* ---------------- the FX facade everything else talks to ----------------
   Screen shake uses the "trauma" model: events ADD trauma (0..1+), the
   applied shake is trauma^2 (so small hits stay subtle, big ones slam),
   and trauma decays linearly. See CameraRig.applyShake().
   v1.5 adds TWO more channels beside trauma:
     kick   — a SHARP instant impulse (fast attack, ~6/s decay) layered
              on top of trauma so hits "punch" instead of only wobbling
     pulse  — the post-processing impact envelope (chromatic aberration
              + radial blur), consumed by the composer pass in game.js
------------------------------------------------------------------------- */
/* ---------------- UPGRADE(graphics v1.8.1): BOOST WARP STREAKS ----------
   Speed is the one thing a cockpit view cannot show. Past normal cruise a
   sparse field of additive streaks streams past the camera along the
   velocity axis, so the eye reads the ship MOVING even though the skybox
   is static. One instanced draw, camera-relative offsets, no allocations
   in the frame loop; the whole effect fades in with the speed envelope. */
const _wv1 = new THREE.Vector3(), _wv2 = new THREE.Vector3(), _wv3 = new THREE.Vector3(), _wv4 = new THREE.Vector3();
class WarpStreakPool {
  constructor(scene, count) {
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshBasicMaterial({ color: 0xbfe8ff, transparent: true, opacity: 0,
        blending: THREE.AdditiveBlending, depthWrite: false }), count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.count = count;
    this.dummy = new THREE.Object3D();
    this.s = [];
    for (let i = 0; i < count; i++) {
      const a = U.rand(0, U.TAU), r = 26 + Math.sqrt(Math.random()) * 70;
      this.s.push({ p: Math.random(), ox: Math.cos(a) * r, oy: Math.sin(a) * r, len: U.rand(0.5, 1.5) });
    }
    this.gain = 0;
  }
  update(dt) {
    const pl = G.player;
    const sp = (pl && pl.alive) ? pl.vel.length() : 0;
    // envelope: nothing at cruise (130), full at boost (235+)
    const want = U.clamp((sp - 132) / 88, 0, 1);
    this.gain = U.damp(this.gain, want, 5, dt);
    this.mesh.visible = this.gain > 0.03;
    if (!this.mesh.visible) return;
    this.mesh.material.opacity = 0.55 * this.gain;
    _wv1.copy(pl.vel).normalize();                       // travel axis
    _wv2.set(_wv1.z, 0, -_wv1.x);                        // right-ish basis
    if (_wv2.lengthSq() < 1e-5) _wv2.set(1, 0, 0);
    _wv2.normalize();
    _wv3.crossVectors(_wv1, _wv2);                       // up-ish basis
    _wv4.set(0, 0, 1);
    this.dummy.quaternion.setFromUnitVectors(_wv4, _wv1);
    const step = (sp * dt) / 260;
    for (let i = 0; i < this.count; i++) {
      const s = this.s[i];
      s.p -= step;
      if (s.p < 0) {
        s.p += 1;
        const a = U.rand(0, U.TAU), r = 26 + Math.sqrt(Math.random()) * 70;
        s.ox = Math.cos(a) * r; s.oy = Math.sin(a) * r; s.len = U.rand(0.5, 1.5);
      }
      // p=1 ahead (+130u) → p=0 behind (−40u), relative to the ship
      const along = -40 + 170 * s.p;
      this.dummy.position.copy(pl.pos)
        .addScaledVector(_wv1, along)
        .addScaledVector(_wv2, s.ox)
        .addScaledVector(_wv3, s.oy);
      const len = 6 + 46 * this.gain * s.len;
      this.dummy.scale.set(0.12, 0.12, len);
      this.dummy.updateMatrix();
      this.mesh.setMatrixAt(i, this.dummy.matrix);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }
  /* run teardown: hide the field and zero the envelope so a new run's first
     frames never show leftover streaks at cruise speed */
  clear() {
    this.gain = 0;
    this.mesh.visible = false;
    this.mesh.material.opacity = 0;
  }
}
const FX = {
  trauma: 0,
  kickAmt: 0,
  pulse: 0,
  _queue: [],                     // UPGRADE: delayed secondary burst slots
  init(scene) {
    this.particles = new ParticlePool(scene, CFG.fx.maxParticles);
    this.debris = new DebrisPool(scene, CFG.fx.maxDebris);
    this.rings = new RingPool(scene, CFG.fx.maxRings);
    this.lights = new FlashPool(scene, CFG.fx.maxLights);
    // UPGRADE(explosions): fireball cores + molten embers
    this.flashes = new FlashSpherePool(scene, CFG.fx.maxFlashSpheres || 8);
    this.embers = new EmberPool(scene, CFG.fx.maxEmbers || 90);
    // UPGRADE(explosions): true-3D pressure domes
    this.shockwaves = new ShockwavePool(scene, CFG.fx.maxShockwaves || 6);
    // UPGRADE(v1.5): turbulent shader fireballs (tier-gated count)
    this.fireballs = new FireballPool(scene, CFG.fx.quality >= 2 ? 6 : 2);
    // UPGRADE(graphics v1.8.1): boost warp streaks (speed readout for the eye)
    this.streaks = new WarpStreakPool(scene, CFG.fx.maxStreaks || 56);
    // dedicated flickery muzzle light (alternates between two for fast re-fire)
    this.muzzleLights = [new THREE.PointLight(0x9ff3ff, 0, 90, 2),
                         new THREE.PointLight(0xffb46a, 0, 90, 2)];
    this.muzzleLights.forEach((l) => scene.add(l));
    this._mi = 0; this._muzzleT = [9, 9];
  },
  addTrauma(x) { this.trauma = Math.min(1.25, this.trauma + x); },
  /* v1.5: sharp impact impulse — fast attack, fast decay, applied as an
     instant directional jolt by the camera rig (NOT more sine wobble). */
  kick(x) { this.kickAmt = Math.min(1.2, this.kickAmt + x); },
  /* v1.5: post-processing impact pulse (CA + radial blur) — strength
     0..1; the composer pass reads FX.pulse each frame and decays it. */
  postPulse(x) { if (G.composer) this.pulse = Math.min(1.3, this.pulse + x); },

  muzzle(pos, enemy) {
    const l = this.muzzleLights[this._mi]; this._mi = 1 - this._mi;
    l.position.copy(pos);
    l.color.set(enemy ? 0xff9a5a : 0x9ff3ff);
    l.intensity = 2.4;
    this._muzzleT[this._mi === 0 ? 1 : 0] = 0;
    // a few spark particles for the visual flash
    for (let i = 0; i < 3; i++) {
      U.randomDir(_v1).multiplyScalar(U.rand(6, 18));
      const c = enemy ? [1, 0.55, 0.25] : [0.6, 0.95, 1];
      this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z, c[0], c[1], c[2],
        U.rand(0.5, 1.1), 0.09, 2, 0);
    }
  },

  // small hit sparks where a bolt connects
  hit(pos, count = 6, warm = true) {
    for (let i = 0; i < count; i++) {
      U.randomDir(_v1).multiplyScalar(U.rand(8, 30));
      const w = warm ? U.rand(0.5, 1) : U.rand(0, 0.4);
      this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z,
        1, 0.75 + w * 0.2, 0.3 + w * 0.5, U.rand(0.4, 0.9), U.rand(0.12, 0.3), 1.5, 0);
    }
  },

  shieldHit(pos) {
    for (let i = 0; i < 14; i++) {
      U.randomDir(_v1).multiplyScalar(U.rand(4, 16));
      this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z, 0.35, 0.8, 1,
        U.rand(0.8, 1.6), U.rand(0.25, 0.45), 2.5, 0.5);
    }
    this.rings.spawn(pos, 6, 0x37c8ff, 0.35);
  },

  /* v1.5 EXPLOSION TIERING — a fighter kill, a boss weak-point pop and a
     full capital death must look CATEGORICALLY different. Each tier maps
     to explicit budgets (fireball size, layer counts, shake, post pulse).
     GAME.feel: every gameplay death routes through onEnemyKilled, which
     picks the tier — explosions stay layered + pooled underneath. */
  tiers: {
    small:        { size: 3.2,  shake: 0.14, kick: 0,    pulse: 0,    fireball: 5,    rings: 1 },
    medium:       { size: 6,    shake: 0.26, kick: 0.12, pulse: 0,    fireball: 9,    rings: 2 },
    large:        { size: 11,   shake: 0.5,  kick: 0.3,  pulse: 0.25, fireball: 15,   rings: 3 },
    bossWeakpoint:{ size: 10,   shake: 0.45, kick: 0.35, pulse: 0.4,  fireball: 13,   rings: 2 },
    bossDeath:    { size: 30,   shake: 1.1,  kick: 0.9,  pulse: 1.0,  fireball: 34,   rings: 4 },
  },
  tiered(pos, tierName, palette) {
    const T = this.tiers[tierName] || this.tiers.medium;
    const q = CFG.fx.quality;
    const p = palette || [[1, 0.92, 0.65], [1, 0.62, 0.22], [1, 0.3, 0.1], [0.55, 0.12, 0.06]];
    if (q > 0) {
      // turbulent shader fireball — the heart of the new-tier look
      this.fireballs.spawn(pos, T.fireball * (q === 1 ? 0.8 : 1), 0xff7a2a, 0.5 + T.size * 0.012);
      if (T.size > 8) this.fireballs.spawn(pos, T.fireball * 0.62, 0xffc36a, 0.7 + T.size * 0.008);
    }
    this.explosion(pos, T.size, p);
    if (T.rings > 1) this.rings.spawn(pos, 8 + T.size * 1.6, 0xffe9c0, 0.55);
    if (T.rings > 2) this.rings.spawn(pos, 4 + T.size * 1.1, 0x9ff3ff, 0.5);
    if (T.rings > 3) this.rings.spawn(pos, 16 + T.size * 2.6, 0xffffff, 0.9);
    this.addTrauma(T.shake);
    if (T.kick > 0) this.kick(T.kick);
    if (T.pulse > 0) this.postPulse(T.pulse);
  },

  /* v1.3 EXPLOSIONS — the money shot. Staged, size- and quality-scaled:
     Layer 1  double flash core (white heart + colored shell) — bigger
     Layer 2  spark spray: white-hot + deep ember mix, faster &amp; denser
     Layer 3  fireball bloom (denser, lingers longer) + smoke tail
     Layer 4  shock rings (up to 3) + 3D pressure domes (2 on big blasts)
     Layer 5  molten embers + tumbling debris (budgets scaled with size)
     Layer 6  hot point light (longer hold)
     Layer 7  chained cook-off bursts (now up to 4 on capital kills)
     Layer 8  NEW: rising ember column — a lingering vertical plume that
              sells "the wreck is still burning" for a full second after. */
  explosion(pos, size, palette) {
    const q = CFG.fx.quality;                    // 2 full / 1 half / 0 minimal
    if (q <= 0) { this.lights.spawn(pos, 0xffb46a, 1.4, 0.25); return; }
    const p = palette || [[1, 0.92, 0.65], [1, 0.62, 0.22], [1, 0.3, 0.1], [0.55, 0.12, 0.06]];
    const s = Math.min(18, size);
    const cap = q === 2 ? 1 : 0.5;
    // 1 — flash core (double-layered: hot white heart + colored shell)
    this.flashes.spawn(pos, 2.6 + s * 1.05, 0xfff4d8, 0.3 + s * 0.014);
    if (s > 3) this.flashes.spawn(pos, (2.6 + s * 1.05) * 1.5, 0xffa04a, 0.4 + s * 0.018);
    // 2 — sparks (white-hot core sparks + ember spray mix)
    const nSpark = Math.round((12 + s * 2) * cap);
    for (let i = 0; i < nSpark; i++) {
      U.randomDir(_v1).multiplyScalar(U.rand(0.5, 1) * (16 + s * 3.6));
      this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z,
        1, 0.85, 0.55, U.rand(0.35, 0.8), U.rand(0.25, 0.5), 2.4, 0);
    }
    const nEmberSpark = Math.round((8 + s * 1.4) * cap);
    for (let i = 0; i < nEmberSpark; i++) {
      U.randomDir(_v1).multiplyScalar(U.rand(0.5, 1) * (12 + s * 2.8));
      this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z,
        1, 0.45 + Math.random() * 0.3, 0.12, U.rand(0.25, 0.55), U.rand(0.4, 0.9), 1.8, 0);
    }
    // 3 — fireball bloom (denser + lingering smoke-tinted tail)
    const nFire = Math.round((26 + s * 3.6) * cap);
    for (let i = 0; i < nFire; i++) {
      U.randomDir(_v1).multiplyScalar(U.rand(0.12, 0.9) * (8 + s * 2.2));
      const c = p[(Math.random() * p.length) | 0];
      this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z,
        c[0], c[1], c[2], U.rand(1.2, 2.6) + s * 0.1, U.rand(0.5, 1.15) + s * 0.024,
        1.1, U.rand(1.4, 3.8));
    }
    const nSmoke = Math.round((7 + s * 1.1) * cap);
    for (let i = 0; i < nSmoke; i++) {
      U.randomDir(_v1).multiplyScalar(U.rand(0.1, 0.5) * (4 + s * 0.9));
      this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z,
        0.16, 0.14, 0.13, U.rand(1.6, 2.6) + s * 0.12, U.rand(0.9, 1.6), 0.9, U.rand(2.2, 4));
    }
    // 4 — shock rings (big kills get a third wide slow ring)
    this.rings.spawn(pos, 6 + s * 2.9, 0xffc37a, 0.5 + s * 0.033);
    if (s > 5) this.rings.spawn(pos, 4 + s * 1.9, 0x9ff3ff, 0.45);
    if (s > 10) this.rings.spawn(pos, 10 + s * 3.6, 0xffffff, 0.8);
    // 4b — 3D pressure domes (the air itself igniting) — two on big blasts
    this.shockwaves.spawn(pos, 16 + s * 4.6, 0xffb060, 0.42 + s * 0.024);
    if (s > 7) this.shockwaves.spawn(pos, 9 + s * 2.4, 0xfff0d0, 0.32);
    // 5 — solids: embers + debris (budgets scale with the blast)
    this.embers.burst(pos, Math.min(q === 2 ? 24 : 12, 5 + ((s * 0.9) | 0)), 10 + s * 1.6, 0.34 + s * 0.05);
    this.debris.burst(pos, Math.min(q === 2 ? 18 : 9, 4 + ((s * 0.75) | 0)), 7 + s * 1.1, 0.4 + s * 0.05);
    // 6 — light (hotter, longer for sizeable blasts)
    this.lights.spawn(pos, 0xffb46a, 2.6 + s * 0.44, 0.42 + s * 0.022);
    // 7 — chained cook-off bursts (up to 4 on capital kills)
    if (s >= 9) {
      const nChain = s >= 14 ? (q === 2 ? 4 : 3) : 2;
      for (let i = 0; i < nChain; i++) {
        this._queue.push({
          t: 0.12 + i * (0.14 + Math.random() * 0.1),
          x: pos.x + U.rand(-1, 1) * s * 0.55,
          y: pos.y + U.rand(-1, 1) * s * 0.55,
          z: pos.z + U.rand(-1, 1) * s * 0.55,
          size: Math.min(9.5, s * U.rand(0.35, 0.55)),
        });
      }
    }
    // 8 — NEW: rising ember column. A vertical plume of burning debris that
    // drifts "up" for ~1s — reads as the wreck still burning. Cheap (≤12
    // particles), reuses the main pool.
    if (s >= 4) {
      const nCol = Math.round(Math.min(12, 3 + s * 0.5) * cap);
      for (let i = 0; i < nCol; i++) {
        _v1.set(U.rand(-1, 1), U.rand(0.6, 1), U.rand(-1, 1)).normalize()
          .multiplyScalar(U.rand(2, 7) + s * 0.35);
        this.particles.spawn(pos.x + U.rand(-s, s) * 0.3,
          pos.y + U.rand(-s, s) * 0.3, pos.z + U.rand(-s, s) * 0.3,
          _v1.x, _v1.y, _v1.z,
          1, 0.5 + Math.random() * 0.3, 0.12, U.rand(0.7, 1.3) + s * 0.04,
          U.rand(0.5, 0.9), 1.4, 0.8);
      }
    }
  },

  // engine exhaust; intensity 0..1, overdrive tints it violet
  engine(pos, backDir, intensity, overdrive) {
    if (intensity <= 0.04) return;
    const jitter = 0.35;
    _v1.copy(backDir).multiplyScalar(U.rand(14, 26) * (0.6 + intensity));
    _v1.x += U.rand(-jitter, jitter); _v1.y += U.rand(-jitter, jitter); _v1.z += U.rand(-jitter, jitter);
    const hot = intensity > 0.85;
    const r = overdrive ? 0.75 : (hot ? 0.75 : 0.4),
          g = overdrive ? 0.45 : (hot ? 0.93 : 0.8),
          b = overdrive ? 1.0 : 1.0;
    this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z, r, g, b,
      0.8 + intensity * 1.3, 0.3 + intensity * 0.25, 1.8, 0.6);
  },

  pickupPop(pos, color) {
    for (let i = 0; i < 12; i++) {
      U.randomDir(_v1).multiplyScalar(U.rand(6, 20));
      this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z,
        color[0], color[1], color[2], U.rand(0.6, 1.2), 0.4, 2, 0);
    }
    this.rings.spawn(pos, 5, ((color[0] * 255) << 16) | ((color[1] * 255) << 8) | (color[2] * 255), 0.4);
  },

  // UPGRADE(skills): flare chaff — bright slow-burning particles that linger as missile
  // decoys. Call: FX.flare(pos, jitterDir, inheritVel)
  flare(pos, dir, baseVel) {
    const N = 10;
    for (let i = 0; i < N; i++) {
      _v1.copy(dir).multiplyScalar(U.rand(6, 16));
      if (baseVel) { _v1.x += baseVel.x * 0.55; _v1.y += baseVel.y * 0.55; _v1.z += baseVel.z * 0.55; }
      const flicker = Math.random() < 0.3 ? 1.5 : 1.0;
      this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z,
        1.0 * flicker, 0.72 * flicker, 0.22 * flicker,
        U.rand(1.0, 1.9), 0.32, 1.1, 1.8);
    }
    // smoky tail
    for (let i = 0; i < 6; i++) {
      _v1.copy(dir).multiplyScalar(U.rand(2, 7));
      if (baseVel) { _v1.x += baseVel.x * 0.4; _v1.y += baseVel.y * 0.4; _v1.z += baseVel.z * 0.4; }
      this.particles.spawn(pos.x, pos.y, pos.z, _v1.x, _v1.y, _v1.z,
        0.45, 0.45, 0.5, U.rand(1.3, 2.2), 0.5, 0.9, 0.5);
    }
  },

  missileTrail(pos) {
    this.particles.spawn(pos.x, pos.y, pos.z, U.rand(-2, 2), U.rand(-2, 2), U.rand(-2, 2),
      1, 0.6, 0.3, 0.7, 0.28, 1.5, 1.2);
    this.particles.spawn(pos.x, pos.y, pos.z, 0, 0, 0, 0.5, 0.5, 0.55, 1.1, 0.5, 0.8, 1.6);
  },

  update(dt) {
    this.particles.update(dt);
    this.debris.update(dt);
    this.rings.update(dt);
    this.lights.update(dt);
    this.flashes.update(dt);
    this.embers.update(dt);
    this.shockwaves.update(dt);
    this.fireballs.update(dt);
    this.streaks.update(dt);
    // v1.5 envelopes: kick decays fast (the "punch"), pulse follows CFG
    this.kickAmt = Math.max(0, this.kickAmt - 6 * dt);
    this.pulse = Math.max(0, this.pulse - CFG.postfx.decay * dt);
    // UPGRADE: detonate queued secondary bursts (magazine cook-offs)
    while (this._queue.length) {
      const b = this._queue[0];
      b.t -= dt;
      if (b.t > 0) break;
      this._queue.shift();
      this.explosion(_v6.set(b.x, b.y, b.z), b.size);
      G.audio.explosion(b.size * 0.18);
    }
    // muzzle lights: intensity spike + high-freq flicker while hot
    for (let i = 0; i < 2; i++) {
      this._muzzleT[i] += dt;
      const l = this.muzzleLights[i];
      if (this._muzzleT[i] < 0.09) {
        l.intensity = 2.4 * (1 - this._muzzleT[i] / 0.09) * (0.7 + 0.3 * Math.sin(performance.now() * 0.09));
      } else l.intensity = 0;
    }
    this.trauma = Math.max(0, this.trauma - 2.0 * dt);
  },

  clear() { this.particles.clear(); this.debris.clear(); this.rings.clear(); this.lights.clear();
    this.flashes.clear(); this.embers.clear(); this.shockwaves.clear(); this.fireballs.clear();
    this.streaks.clear();
    this._queue.length = 0;
    this.trauma = 0; this.kickAmt = 0; this.pulse = 0; },
};


