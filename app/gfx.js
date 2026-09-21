// gfx.js — rendering primitives.
// Blocks, barcodes and lines are always hard-edged and single-coloured; signal strength
// is the duty cycle of a binary flicker, never transparency. Only three things are allowed
// to be soft: the white glow behind a few chosen blocks, the magnetosphere point cloud
// (flow.js) and the additive overlap of network edges (web.js).
import * as THREE from 'three';

// colour roles. Dark grey is for reference marks only — nothing that carries data uses it.
// Red means exactly one thing: this is what you have selected.
export const C = { WHITE: 0, DIM: 1, RED: 2, GRAY: 3, DRED: 4, BLUE: 5, MBLUE: 6, PBLUE: 7 };
const HEX = [0xffffff, 0x4d4d4d, 0xff2211, 0xb4b4b4, 0xb3160c, 0x4da3ff, 0x2f6fe0, 0x9cd0ff];
export const BG = 0x000000;
export const css = role => role < 0 ? '#000000' : '#' + HEX[role].toString(16).padStart(6, '0');

export const MODE = { STATIC: 0, TRAVEL: 1, SHELL: 2, JITTER: 3, PULSE: 4, FLOOR: 6 };
export const SHAPE = { RECT: 0, CROSS: 3, HOLLOW: 4 };

export const uniforms = {
  uTime: { value: 0 },
  uRes: { value: new THREE.Vector2(1, 1) },
  uScale: { value: 1 },          // pixels per world unit at distance 1
  uPulse: { value: -1 },         // radius of the floor scan pulse
  uGlow: { value: 1 },           // halo strength; main.js lowers it as the camera pulls back
  uPal: { value: HEX.map(c => new THREE.Color(c)) },
};

const HASH = /* glsl */`
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }`;

// ---------------------------------------------------------------- blocks
const VERT = /* glsl */`
attribute vec3 iPos;
attribute vec3 iDir;
attribute vec4 iA;   // width, height (world units; negative = fixed pixels), intensity, seed
attribute vec4 iB;   // mode, rate, phase, flicker Hz
attribute vec2 iC;   // shape, colour role
uniform float uTime, uScale, uPulse;
uniform vec2 uRes;
uniform vec3 uPal[8];
varying vec2 vUv;
varying float vShape;
varying vec3 vCol;
${HASH}
void main() {
  float mode = iB.x;
  vec3 p = iPos;
  float inten = iA.z;
  float role = iC.y;

  if (mode == 1.0 || mode == 2.0) {                         // travel along iDir, looping
    float u = fract(uTime * iB.y + iB.z);
    p += iDir * u;
    if (mode == 2.0) inten *= 1.0 - u;
  } else if (mode == 3.0) {                                 // nervous jitter inside box iDir
    float s = floor(uTime * iB.y + iB.z * 10.0);
    p += (vec3(hash(vec2(iA.w, s)), hash(vec2(iA.w + 1.3, s)), hash(vec2(iA.w + 2.7, s))) - 0.5) * iDir;
  }

  float lit;
  if (mode == 4.0) {                                        // pulsar: true period in seconds
    lit = step(fract(uTime / iB.y + iB.z), 0.18);
  } else {
    float s = floor(uTime * iB.w + iA.w * 17.0);
    lit = step(hash(vec2(iA.w * 91.7, s)), inten);
  }
  if (mode == 6.0 && abs(length(p.xz) - uPulse) < 2.5) role = 3.0;

  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vec4 clip = projectionMatrix * mv;
  float k = uScale / max(-mv.z, 0.001);
  // world-sized blocks stay blocks: never below one pixel, never a slab in your face
  vec2 sz = vec2(iA.x < 0.0 ? -iA.x : clamp(floor(iA.x * k + 0.5), 1.0, 48.0),
                 iA.y < 0.0 ? -iA.y : clamp(floor(iA.y * k + 0.5), 1.0, 48.0));
  // snap to the pixel grid so every block is a crisp whole-pixel rectangle
  vec2 px = floor((clip.xy / clip.w * 0.5 + 0.5) * uRes);
  vec2 corner = px - floor(sz * 0.5) + (position.xy + 0.5) * sz;
  gl_Position = vec4((corner / uRes * 2.0 - 1.0) * clip.w, clip.z, clip.w);
  if (lit < 0.5 || mv.z > -0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);

  vUv = position.xy * 2.0;
  vShape = iC.x;
  vCol = uPal[int(role)];
}`;

const FRAG = /* glsl */`
varying vec2 vUv;
varying float vShape;
varying vec3 vCol;
void main() {
  vec2 a = abs(vUv);
  if (vShape == 3.0 && a.x > 0.2 && a.y > 0.2) discard;     // cross
  if (vShape == 4.0 && max(a.x, a.y) < 0.64) discard;       // hollow frame
  gl_FragColor = vec4(vCol, 1.0);
}`;

// the halo: always white, radial falloff, additive — drawn behind the hard block it belongs to
const FRAG_GLOW = /* glsl */`
uniform float uGlow;
varying vec2 vUv;
void main() {
  float f = max(0.0, 1.0 - length(vUv));
  gl_FragColor = vec4(vec3(1.0), f * f * 0.42 * uGlow);
}`;

const blockMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG,
  side: THREE.DoubleSide });
const glowMaterial = new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG_GLOW,
  side: THREE.DoubleSide, transparent: true, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending });

const QUAD = new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]);

// A growable batch of blocks drawn in one instanced call.
export class BlockCloud {
  constructor(capacity = 1024, glow = false) {
    this.n = 0;
    this.mesh = new THREE.Mesh(new THREE.InstancedBufferGeometry(), glow ? glowMaterial : blockMaterial);
    this.mesh.frustumCulled = false;
    if (glow) this.mesh.renderOrder = -1;
    this.halo = null;            // lazily created BlockCloud of glow quads
    this.haloOf = new Map();     // block index -> halo index
    this._alloc(capacity);
  }

  _alloc(cap) {
    const old = this.arr;
    this.cap = cap;
    this.arr = { iPos: new Float32Array(cap * 3), iDir: new Float32Array(cap * 3),
                 iA: new Float32Array(cap * 4), iB: new Float32Array(cap * 4),
                 iC: new Float32Array(cap * 2) };
    if (old) for (const k in old) this.arr[k].set(old[k]);
    this.mesh.geometry.dispose();
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(QUAD, 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    for (const [k, size] of [['iPos', 3], ['iDir', 3], ['iA', 4], ['iB', 4], ['iC', 2]]) {
      const a = new THREE.InstancedBufferAttribute(this.arr[k], size);
      a.setUsage(THREE.DynamicDrawUsage);
      g.setAttribute(k, a);
    }
    g.instanceCount = this.n;
    this.mesh.geometry = g;
  }

  clear() { this.n = 0; this.haloOf.clear(); this.halo?.clear(); return this; }

  // o: { w, h, i (intensity 0..1), seed, dir [x,y,z], mode, rate, phase, flick, shape, color,
  //      glow (halo radius in pixels) }
  add(x, y, z, o = {}) {
    if (this.n >= this.cap) this._alloc(this.cap * 2);
    const i = this.n++, a = this.arr, w = o.w ?? 0.4, d = o.dir;
    a.iPos.set([x, y, z], i * 3);
    a.iDir.set(d || [0, 0, 0], i * 3);
    a.iA.set([w, o.h ?? w, o.i ?? 1, o.seed ?? Math.random()], i * 4);
    a.iB.set([o.mode ?? 0, o.rate ?? 0, o.phase ?? 0, o.flick ?? 12], i * 4);
    a.iC.set([o.shape ?? 0, o.color ?? 0], i * 2);
    if (o.glow) {
      if (!this.halo) { this.halo = new BlockCloud(64, true); this.mesh.add(this.halo.mesh); }
      const pulse = o.mode === MODE.PULSE;
      this.haloOf.set(i, this.halo.add(x, y, z, { w: -2 * o.glow, i: 1, flick: 0, dir: d,
        mode: pulse || o.mode === MODE.TRAVEL ? o.mode : 0, rate: o.rate, phase: o.phase }));
    }
    return i;
  }

  setPos(i, x, y, z) {
    this.arr.iPos.set([x, y, z], i * 3);
    const h = this.haloOf.get(i);
    if (h !== undefined) this.halo.arr.iPos.set([x, y, z], h * 3);
  }

  // recolour a run of instances; returns their previous roles so the caller can put them back
  paint(start, count, role) {
    const c = this.arr.iC, before = [];
    for (let i = start; i < start + count && i < this.n; i++) { before.push(c[i * 2 + 1]); c[i * 2 + 1] = Array.isArray(role) ? role[i - start] : role; }
    this.mesh.geometry.attributes.iC.needsUpdate = true;
    return before;
  }

  commit(which) {
    const g = this.mesh.geometry;
    g.instanceCount = this.n;
    for (const k of which || ['iPos', 'iDir', 'iA', 'iB', 'iC']) g.attributes[k].needsUpdate = true;
    this.halo?.commit(which);
  }
}

// ---------------------------------------------------------------- plain 1 px lines
export class LineSet {
  constructor(role = C.DIM, additive = 0) {
    this.pts = [];
    const m = new THREE.LineBasicMaterial({ color: HEX[role] });
    if (additive) Object.assign(m, { transparent: true, opacity: additive, depthWrite: false,
                                     blending: THREE.AdditiveBlending });
    this.obj = new THREE.LineSegments(new THREE.BufferGeometry(), m);
    this.obj.frustumCulled = false;
  }
  clear() { this.pts.length = 0; return this; }
  seg(a, b) { this.pts.push(a[0], a[1], a[2], b[0], b[1], b[2]); }
  path(points, closed = false) {
    for (let i = 1; i < points.length; i++) this.seg(points[i - 1], points[i]);
    if (closed && points.length > 2) this.seg(points[points.length - 1], points[0]);
  }
  commit() {
    this.obj.geometry.dispose();
    this.obj.geometry = new THREE.BufferGeometry().setAttribute('position',
      new THREE.Float32BufferAttribute(this.pts, 3));
  }
}

// ---------------------------------------------------------------- wavefront rings
// Coaxial 3D rings that leave an emitter, travel down its axis and widen: a cone of
// circles. Animated on the GPU. A ring is one object: it lights or goes dark as a whole,
// and the few gaps cut into it are placed by the emitter's real bytes.
const waveMaterial = new THREE.ShaderMaterial({
  uniforms,
  vertexShader: /* glsl */`
    attribute vec3 aAxis;    // full travel vector
    attribute vec3 aRim;     // unit vector from the axis to this rim point
    attribute vec4 aP;       // phase, rate, final radius, intensity
    attribute vec2 aQ;       // ring seed, colour role
    uniform float uTime;
    uniform vec3 uPal[8];
    varying vec3 vCol;
    ${HASH}
    void main() {
      float u = fract(uTime * aP.y + aP.x);
      vec3 p = position + aAxis * u + aRim * (0.4 + aP.z * u);
      float s = floor(uTime * 5.0 + aQ.x * 31.0);
      float lit = step(hash(vec2(aQ.x * 57.3, s)), aP.w) * step(u, 0.94);
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      if (lit < 0.5) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vCol = uPal[int(aQ.y)];
    }`,
  fragmentShader: /* glsl */`varying vec3 vCol; void main() { gl_FragColor = vec4(vCol, 1.0); }`,
});

export class WaveLines {
  constructor() {
    this.obj = new THREE.LineSegments(new THREE.BufferGeometry(), waveMaterial);
    this.obj.frustumCulled = false;
    this.clear();
  }
  clear() { this.a = { position: [], aAxis: [], aRim: [], aP: [], aQ: [] }; return this; }
  // rings from `from` towards `to`; o.bytes cuts a handful of gaps into each circle
  beam(from, to, o) {
    const axis = new THREE.Vector3(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const n = axis.clone().normalize();
    const u = new THREE.Vector3(0, 1, 0).cross(n);
    if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
    u.normalize();
    const v = n.clone().cross(u), SEG = o.segments ?? 96, bytes = o.bytes?.length ? o.bytes : [90, 17, 203, 66];
    const rim = Array.from({ length: SEG + 1 }, (_, k) => {
      const t = k / SEG * 2 * Math.PI;
      return u.clone().multiplyScalar(Math.cos(t)).addScaledVector(v, Math.sin(t));
    });
    for (let r = 0; r < o.rings; r++) {
      const seed = Math.random(), open = new Uint8Array(SEG);
      for (let g = 0; g < 5; g++) {                               // five gaps: where and how wide come from the bytes
        const at = bytes[(r * 5 + g) % bytes.length] / 256 * SEG, wide = 2 + (bytes[(r * 5 + g + 1) % bytes.length] & 7);
        for (let k = 0; k < wide; k++) open[Math.floor(at + k) % SEG] = 1;
      }
      for (let k = 0; k < SEG; k++) {
        if (open[k]) continue;
        for (const e of [rim[k], rim[k + 1]]) {
          this.a.position.push(from[0], from[1], from[2]);
          this.a.aAxis.push(axis.x, axis.y, axis.z);
          this.a.aRim.push(e.x, e.y, e.z);
          this.a.aP.push(r / o.rings, o.rate, o.radius, o.intensity);
          this.a.aQ.push(seed, o.color ?? C.WHITE);
        }
      }
    }
  }
  commit() {
    const g = new THREE.BufferGeometry();
    for (const [k, size] of [['position', 3], ['aAxis', 3], ['aRim', 3], ['aP', 4], ['aQ', 2]])
      g.setAttribute(k, new THREE.Float32BufferAttribute(this.a[k], size));
    this.obj.geometry.dispose();
    this.obj.geometry = g;
  }
}

// ---------------------------------------------------------------- trails
// A meteor's wake: a smooth curve through where the thing really was, bright and nearly
// white at the head, fading continuously to nothing at the tail. Additive, no flicker.
const trailMaterial = new THREE.ShaderMaterial({
  uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute vec2 aT;       // age 0..1 (negative = steady), colour role
    uniform vec3 uPal[8];
    varying vec4 vCol;
    void main() {
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      float age = max(aT.x, 0.0), k = (1.0 - age) * (1.0 - age);
      vec3 c = mix(uPal[int(aT.y)], vec3(1.0), aT.x < 0.0 ? 0.0 : 0.75 * k * k);     // the head burns white
      vCol = vec4(c, aT.x < 0.0 ? 1.0 : k);
    }`,
  fragmentShader: /* glsl */`varying vec4 vCol; void main() { gl_FragColor = vCol; }`,
});

// Catmull-Rom through sparse samples, so a wake bends instead of kinking
export function smoothPath(pts, sub = 2) {
  if (pts.length < 3) return pts;
  const out = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
    for (let k = 0; k < sub; k++) {
      const t = k / sub, t2 = t * t, t3 = t2 * t;
      out.push([0, 1, 2].map(a => 0.5 * (2 * p1[a] + (p2[a] - p0[a]) * t + (2 * p0[a] - 5 * p1[a] + 4 * p2[a] - p3[a]) * t2
        + (3 * p1[a] - p0[a] - 3 * p2[a] + p3[a]) * t3)));
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export class TrailLines {
  constructor() {
    this.obj = new THREE.LineSegments(new THREE.BufferGeometry(), trailMaterial);
    this.obj.frustumCulled = false;
    this.clear();
  }
  clear() { this.pos = []; this.t = []; return this; }
  // points run newest -> oldest; steady = one flat colour end to end (the selected object)
  trail(points, color, steady = false) {
    const n = points.length - 1;
    for (let i = 0; i < n; i++) {
      const a = points[i], b = points[i + 1], head = !steady && i < n * 0.25;
      for (const lift of head ? [0, 0.16] : [0]) {                 // doubled near the head: thick front, thin tail
        this.pos.push(a[0], a[1] + lift, a[2], b[0], b[1] + lift, b[2]);
        this.t.push(steady ? -1 : i / n, color, steady ? -1 : (i + 1) / n, color);
      }
    }
  }
  commit() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('aT', new THREE.Float32BufferAttribute(this.t, 2));
    this.obj.geometry.dispose();
    this.obj.geometry = g;
  }
}
