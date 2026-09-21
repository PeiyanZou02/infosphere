// orbit.js — pull back far enough and the room becomes a planet.
// A globe drawn only with latitude scan lines over land, every tracked satellite at its real
// 3D position (linear scale here, not logarithmic), a ghost trail of where each has been,
// you as a glowing point with lines to whatever is above your horizon right now.
import * as THREE from 'three';
import { BlockCloud, LineSet, TrailLines, smoothPath, C } from './gfx.js';
import { DEG, RE_KM, geoVec, ecfVec, enuBasis, textBytes } from './space.js';
import { subsolarPoint } from './astro.js';
import { sats, satAt, skyCount, SAT_STYLE, mhz } from './field.js';
import { SAT_FREQ } from './bands.js';
import { S } from './store.js';

/* global satellite */

export const RG = 100;                       // world units per Earth radius
export const planet = new THREE.Group();
planet.visible = false;
const scale = v => [v[0] * RG, v[1] * RG, v[2] * RG];

// the body: an unlit black sphere so the far side of everything is hidden, then line work on top
planet.add(new THREE.Mesh(new THREE.SphereGeometry(RG * 0.994, 96, 64), new THREE.MeshBasicMaterial({ color: 0x000000 })));
const land = new LineSet(C.WHITE), grid = new LineSet(C.DIM), dusk = new LineSet(C.GRAY);
const links = new LineSet(C.PBLUE, 0.35), horizon = new LineSet(C.GRAY), orbits = new LineSet(C.RED), crewed = new LineSet(C.GRAY, 0.5);
const cloud = new BlockCloud(14000), trails = new TrailLines(), you = new BlockCloud(4);
planet.add(land.obj, grid.obj, dusk.obj, links.obj, horizon.obj, orbits.obj, crewed.obj, cloud.mesh, trails.obj, you.mesh);

fetch('./land.json').then(r => r.json()).then(({ rows }) => {
  for (const [lat, spans] of rows) for (let i = 0; i < spans.length; i += 2)
    for (let lon = spans[i]; lon < spans[i + 1]; lon += 3)                       // follow the curve in 3° chords
      land.seg(scale(geoVec(lat, lon)), scale(geoVec(lat, Math.min(lon + 3, spans[i + 1]))));
  land.commit();
});
for (let lat = -60; lat <= 60; lat += 30) for (let lon = -180; lon < 180; lon += 4)
  grid.seg(scale(geoVec(lat, lon)), scale(geoVec(lat, lon + 4)));
for (let lon = -180; lon < 180; lon += 30) for (let lat = -88; lat < 88; lat += 4)
  grid.seg(scale(geoVec(lat, lon)), scale(geoVec(lat + 4, lon)));
grid.commit();

// circle of angular radius `a` around unit vector c
function ring(set, c, a, r = RG * 1.002) {
  const n = new THREE.Vector3(...c), u = new THREE.Vector3(0, 1, 0).cross(n);
  if (u.lengthSq() < 1e-6) u.set(1, 0, 0);
  u.normalize();
  const v = n.clone().cross(u), pts = [];
  for (let k = 0; k <= 120; k++) {
    const t = k / 120 * 2 * Math.PI;
    const p = n.clone().multiplyScalar(Math.cos(a)).addScaledVector(u, Math.sin(a) * Math.cos(t)).addScaledVector(v, Math.sin(a) * Math.sin(t));
    pts.push([p.x * r, p.y * r, p.z * r]);
  }
  set.path(pts);
}

let cloudBuiltFor = null, lastPass = -1, aimed = null, targets = [], youTarget = null;
const posOf = s => scale(ecfVec(s.ecf));

function buildCloud() {
  cloudBuiltFor = sats;
  cloud.clear();
  targets = [];
  for (const s of sats) {
    const st = SAT_STYLE[s.group];
    s.orbitIdx = cloud.add(0, 1e6, 0, { w: s.big ? -9 : s.group === 'starlink' ? -2 : st.w, shape: st.shape ?? 0,
      color: st.color, flick: 0, glow: s.big ? 22 : 0 });
    const [f] = SAT_FREQ[s.group];
    targets.push(s.orbitTarget = {                      // fields are read live, straight from the propagator's last result
      pos: new THREE.Vector3(0, 1e6, 0), name: s.name, sat: s, fam: 'sky', truth: [0, 1, 0], glyph: 'dot', f, bw: 1, p: 0.25,
      bytes: textBytes(s.l1 + s.l2), raw: [s.name, s.l1, s.l2], blocks: [cloud, s.orbitIdx, 1],
      noLabel: !(s.big || s.group === 'weather' || (s.group === 'gnss' && s.n % 6 === 0) || (s.group === 'visual' && s.n % 9 === 0)),
      prio: s.big ? 1.5 : 0.4,
      get geo() {
        const e = s.ecf, r = Math.hypot(e.x, e.y, e.z);
        return { alt: r - RE_KM, lat: Math.asin(e.z / r) / DEG, lon: Math.atan2(e.y, e.x) / DEG };
      },
      get sub() { return `${Math.round(this.geo.alt)} km`; },
      get keys() { const g = this.geo; return [['altitude', `${Math.round(g.alt)} km`], ['velocity', `${s.speed.toFixed(2)} km/s`], ['over', `${g.lat.toFixed(1)}° ${g.lon.toFixed(1)}°`]]; },
      get info() {
        const g = this.geo, l = s.look;
        return [['norad id', s.id], ['constellation', s.group], ['altitude', `${Math.round(g.alt)} km`],
          ['ground point', `${g.lat.toFixed(2)}°  ${g.lon.toFixed(2)}°`], ['velocity', `${s.speed.toFixed(2)} km/s`],
          ['from you', l.elevation > 0 ? `az ${(l.azimuth / DEG).toFixed(1)}° · el ${(l.elevation / DEG).toFixed(1)}°` : 'below your horizon'],
          ['range', `${Math.round(l.rangeSat)} km`], ['downlink', `${mhz(f)} · typical`], ['orbit', 'sgp4 · celestrak elements']];
      },
    });
  }
}

// one full orbit, frozen in today's Earth frame
function orbitPath(set, s) {
  const period = 2 * Math.PI / s.rec.no * 60000, now = Date.now(), gmst = satellite.gstime(new Date()), pts = [];
  for (let k = 0; k <= 160; k++) {
    const q = satAt(s, new Date(now + period * k / 160));
    if (q) pts.push(scale(ecfVec(satellite.eciToEcf(q.eci, gmst))));
  }
  set.path(pts);
}

let painted = null;
export function setOrbitAim(t) {
  if (t === aimed) return;
  if (painted) { cloud.paint(painted[0], 1, painted[1]); painted = null; }
  if (t?.sat) painted = [t.sat.orbitIdx, cloud.paint(t.sat.orbitIdx, 1, C.RED)];
  aimed = t;
  orbits.clear();
  if (t?.sat) orbitPath(orbits, t.sat);
  orbits.commit();
}

export function orbitTargets() { return youTarget ? [youTarget, ...targets] : targets; }

// called every frame while the orbital view is showing
export function updateOrbit(mobile) {
  if (cloudBuiltFor !== sats) buildCloud();
  for (const s of sats) {
    if (!s.ecf) continue;
    const p = posOf(s);
    cloud.setPos(s.orbitIdx, p[0], p[1], p[2]);
    s.orbitTarget.pos.set(p[0], p[1], p[2]);
  }
  cloud.commit(['iPos']);
  if (skyCount.pass === lastPass) return;
  lastPass = skyCount.pass;                       // the rest only changes once per propagation pass

  const here = geoVec(S.obs.lat, S.obs.lon), p0 = scale(here);
  you.clear(); you.add(p0[0], p0[1], p0[2], { w: -5, flick: 0, glow: 18 }); you.commit();
  youTarget = { pos: new THREE.Vector3(...p0), name: 'YOU', sub: `${S.obs.lat.toFixed(4)}°  ${S.obs.lon.toFixed(4)}°`, prio: 2, noAim: true };

  trails.clear(); links.clear(); horizon.clear(); dusk.clear(); crewed.clear();
  const thin = mobile ? 8 : 4;
  for (const s of sats) {
    if (!s.ecf) continue;
    if (s.look.elevation > 0 && s.group !== 'starlink' && s.group !== 'oneweb') links.seg(p0, posOf(s));   // you can hear it right now
    if (s.histE.length > 1 && (s.group !== 'starlink' || s.n % thin === 0))
      trails.trail(smoothPath([posOf(s), ...s.histE.map(h => scale(ecfVec(h.p)))]), SAT_STYLE[s.group].trail);
    if (s.big) orbitPath(crewed, s);
  }
  ring(horizon, here, 23 * DEG);                                   // how far a 550 km satellite can be and still see you
  const sun = subsolarPoint();
  ring(dusk, geoVec(sun.lat, sun.lon), 90 * DEG);                  // day | night
  trails.commit(); links.commit(); horizon.commit(); dusk.commit(); crewed.commit();
  if (aimed?.sat) { orbits.clear(); orbitPath(orbits, aimed.sat); orbits.commit(); }
}

// frame for the HUD's data table
export function orbitRow(t) {
  const s = t.sat, g = t.geo, [f] = SAT_FREQ[s.group];
  return { 'NORAD ID': s.id, 'SAT NAME': s.name.slice(0, 18), AZIMUTH: (s.look.azimuth / DEG).toFixed(1), ELEVATION: (s.look.elevation / DEG).toFixed(1),
    RANGE: `${Math.round(s.look.rangeSat)} km`, VELOCITY: `${s.speed.toFixed(2)} km/s`, ALT: `${Math.round(g.alt)} km`,
    LATITUDE: g.lat.toFixed(2), LONGITUDE: g.lon.toFixed(2), DOWNLINK: mhz(f), GROUP: s.group };
}
export const visibleNow = () => sats.filter(s => s.ecf && s.look.elevation > 0 && (s.big || s.group === 'weather' || s.group === 'gnss' || s.group === 'stations'))
  .sort((a, b) => b.look.elevation - a.look.elevation).slice(0, 14);
