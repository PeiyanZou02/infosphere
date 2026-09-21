// flow.js — the magnetosphere as a point cloud you stand inside.
// Dipole field lines are closed loops (r = L·cos²λ); the solar wind flattens them on the
// day side and drags them into a tail on the night side. ~120 000 one-pixel white points
// ride those loops; they add up, so density reads as brightness.
//
// This is an analytic model DRIVEN by measurements, not a measurement of the field:
//   solar wind speed -> flow speed and tail length      sun position -> which way it leans
//   IMF Bz south     -> day side opens up, gets ragged  Kp           -> turbulence, polar density
//   X-ray flux       -> overall brightness
// Geometry lives in the planet frame (one Earth radius = 1); a matrix drops it either
// around you (local view, you are on the surface looking up) or around the globe (orbit view).
import * as THREE from 'three';
import { uniforms as shared } from './gfx.js';
import { geoVec, enuBasis } from './space.js';
import { subsolarPoint } from './astro.js';
import { S } from './store.js';

const MAG_POLE = [80.7, -72.7];        // geomagnetic north pole (IGRF dipole, 2025)

const u = {
  uTime: shared.uTime,
  uMag: { value: new THREE.Matrix3() },      // magnetic frame -> planet frame
  uSun: { value: new THREE.Vector3(1, 0, 0) }, // sun direction, magnetic frame
  uWind: { value: 1 }, uKp: { value: 0.2 }, uOpen: { value: 0 }, uGain: { value: 0.16 },
  uLocal: { value: 1 },                      // 1: around you, log-compressed like everything else · 0: around the globe
};

const material = new THREE.ShaderMaterial({
  uniforms: u, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  vertexShader: /* glsl */`
    attribute vec4 aS;      // L shell, magnetic longitude, phase, kind (0 field line, 1 solar wind)
    attribute vec2 aJ;      // jitter seeds
    uniform float uTime, uWind, uKp, uOpen, uLocal;
    uniform mat3 uMag;
    uniform vec3 uSun;
    varying float vA;
    void main() {
      vec3 p;
      float day;
      if (aS.w < 0.5) {
        float lmax = acos(sqrt(1.0 / aS.x));
        float lam = mix(lmax, -lmax, fract(aS.z + uTime * 0.012 * uWind / sqrt(aS.x)));
        float r = aS.x * cos(lam) * cos(lam);
        p = vec3(r * cos(lam) * cos(aS.y), r * sin(lam), r * cos(lam) * sin(aS.y));
        day = dot(p, uSun);
        p -= uSun * max(day, 0.0) * 0.32 * min(uWind, 1.6);                  // pressed in on the day side
        p -= uSun * pow(max(-day, 0.0), 1.45) * 0.22 * uWind;                // dragged out into the tail
      } else {
        // solar wind: straight in from the sun, shouldered aside by the magnetopause
        float x = 14.0 - 44.0 * fract(aS.z + uTime * 0.02 * uWind);
        vec3 a = normalize(cross(uSun, vec3(0.0, 1.0, 0.0))), b = cross(uSun, a);
        float rho = max(aS.x, 1.7 * sqrt(max(0.0, 10.5 - x)));
        p = uSun * x + (a * cos(aS.y) + b * sin(aS.y)) * rho;
        day = x;
      }
      float r = length(p);
      float rough = (0.012 + 0.05 * uKp + (day > 0.0 ? 0.12 * uOpen : 0.0)) * r;
      p += rough * vec3(sin(p.y * 2.7 + uTime * 0.31 + aJ.x * 6.3), sin(p.z * 3.1 + uTime * 0.27 + aJ.y * 6.3),
                        sin(p.x * 2.9 + uTime * 0.23 + aJ.x * 3.1));
      vec4 wp = modelMatrix * vec4(uMag * p, 1.0);
      if (uLocal > 0.5) {
        // rule 2 of the field: true direction from you, distance log-compressed — the whole
        // magnetosphere folds into a shell on your sky at the density you see from orbit
        float d = length(wp.xyz) * 6371000.0;
        wp.xyz = normalize(wp.xyz) * 60.0 * log(1.0 + d / 1.5) / 2.302585;
      }
      gl_Position = projectionMatrix * viewMatrix * wp;
      if ((uLocal > 0.5 && wp.y < 0.0) || r < 1.02) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      gl_PointSize = 1.0;
      vA = aS.w < 0.5 ? 1.0 : 0.45;
    }`,
  fragmentShader: /* glsl */`
    uniform float uGain;
    varying float vA;
    void main() { gl_FragColor = vec4(vec3(1.0), uGain * vA); }`,
});

export class Flow {
  constructor(count) {
    const aS = new Float32Array(count * 4), aJ = new Float32Array(count * 2), LINES = 260;
    const lines = Array.from({ length: LINES }, () => [1.15 + 9 * Math.random() ** 2.2, Math.random() * 2 * Math.PI]);
    for (let i = 0; i < count; i++) {
      if (i % 10 < 7) {                                // on one of a few hundred discrete field lines, so loops read as loops
        const [L, phi] = lines[i % LINES], g = (Math.random() + Math.random() - 1) * 0.035;
        aS.set([L * (1 + g), phi + g, Math.random(), 0], i * 4);
      } else aS.set([2 + 16 * Math.random() ** 1.5, Math.random() * 2 * Math.PI, Math.random(), 1], i * 4);
      aJ.set([Math.random(), Math.random()], i * 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.setAttribute('aS', new THREE.BufferAttribute(aS, 4));
    g.setAttribute('aJ', new THREE.BufferAttribute(aJ, 2));
    this.obj = new THREE.Points(g, material);
    this.obj.frustumCulled = false;
    this.obj.matrixAutoUpdate = false;
    // magnetic frame: +Y along the dipole axis
    const m = new THREE.Vector3(...geoVec(...MAG_POLE));
    const a = new THREE.Vector3(0, 1, 0).cross(m).normalize(), b = m.clone().cross(a);
    this.basis = new THREE.Matrix4().makeBasis(a, m, b);
    u.uMag.value.setFromMatrix4(this.basis);
    this.toMag = this.basis.clone().invert();
  }

  // around you: planet frame -> your east / up / north, you at the origin, still in Earth radii
  // (the shader then log-compresses the distance, exactly like satellites)
  setLocal() {
    const { east, north, up } = enuBasis(S.obs.lat, S.obs.lon);
    const rot = new THREE.Matrix4().set(
      east[0], east[1], east[2], 0, up[0], up[1], up[2], 0, -north[0], -north[1], -north[2], 0, 0, 0, 0, 1);
    this.obj.matrix.copy(rot).setPosition(0, -1, 0);         // rot * you = (0, 1, 0): put that at the origin
    this.obj.matrixWorldNeedsUpdate = true;
    this.obj.renderOrder = 0;
    u.uLocal.value = 1;
    this.local = true;
  }
  // around the globe of the orbital view; drawn after the satellites so it is never buried
  setPlanet(radius) {
    this.obj.matrix.makeScale(radius, radius, radius);
    this.obj.matrixWorldNeedsUpdate = true;
    this.obj.renderOrder = 5;
    u.uLocal.value = 0;
    this.local = false;
  }

  // once a second: hand the live space-weather numbers to the shader
  drive() {
    const sw = S.sw || {}, sun = subsolarPoint();
    u.uSun.value.set(...geoVec(sun.lat, sun.lon)).applyMatrix4(this.toMag).normalize();
    u.uWind.value = (sw.wind_kms ?? 400) / 400;
    u.uKp.value = (sw.kp ?? 1) / 9;
    u.uOpen.value = Math.min(1, Math.max(0, -(sw.bz_nt ?? 0) / 12));
    const flare = Math.max(0, Math.log10((sw.xray_flux ?? 1e-7) / 1e-6));        // C-class and up brightens it
    u.uGain.value = (this.local ? 0.34 : 0.26) + 0.06 * Math.min(flare, 2);
  }
}
