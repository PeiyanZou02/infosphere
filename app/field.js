// field.js — the signal field. Every layer turns a real feed into blocks and lines (gfx.js)
// placed by the three rules of space.js, and publishes `targets`: the things the HUD can
// label, aim at and sum into the directional spectrum.
//
// Colour is a family, lightness a rank inside it:
//   white / grey  everything on and near the ground      blue  the sky      red  only what you have selected
import * as THREE from 'three';
import { BlockCloud, LineSet, WaveLines, TrailLines, smoothPath, MODE, SHAPE, C, uniforms } from './gfx.js';
import { DEG, FLOOR, R, RANGE_RINGS, dirOf, place, enu, elevationOf, elOf, elSpan,
         wifiBand, estimateDbm, level, hashAngle, hexBytes, textBytes, bitAt } from './space.js';
import { CELL_DOWNLINKS, SAT_FREQ, ADSB } from './bands.js';
import { RADIO_SOURCES, PULSARS } from './cosmos.js';
import { raDecToAzEl, sunAzEl } from './astro.js';
import { S, on } from './store.js';

/* global satellite */

export const world = new THREE.Group();
export const layers = {};       // id -> { id, name, group, targets, visible }
export const nodes = { wifi: [], ble: [], stations: {} };   // what web.js strings edges between
const clamp = THREE.MathUtils.clamp;
const V = a => new THREE.Vector3(a[0], a[1], a[2]);
// how each number on a target was obtained: [measured, database, estimated]
const TRUTH = { near: [1, 0, 1], db: [0, 1, 1], orbit: [0, 1, 0], live: [1, 0, 1] };

export function layer(id, name, mobileOff = false) {
  const group = new THREE.Group();
  world.add(group);
  return (layers[id] = { id, name, group, targets: [], visible: true, mobileOff });
}
export function setLayerVisible(id, v) { layers[id].visible = layers[id].group.visible = v; }
export function localTargets() {
  const out = [];
  for (const l of Object.values(layers)) if (l.visible) for (const t of l.targets) { t.layer = l.id; out.push(t); }
  return out;
}
function kit(l, cap, lineRole = C.GRAY, weight = 0.28) {
  const cloud = new BlockCloud(cap), lines = new LineSet(lineRole, weight);
  l.group.add(cloud.mesh, lines.obj);
  return { cloud, lines };
}
const km = m => m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(m < 1e4 ? 1 : 0)} km`;
export const mhz = f => f < 3 ? `${Math.round(f * 1000)} kHz` : f >= 3000 ? `${(f / 1000).toFixed(3)} GHz` : `${(+f).toFixed(f < 200 ? 1 : 0)} MHz`;
const bearing = az => `${((az / DEG + 360) % 360).toFixed(1)}°`;

// ---------- floor: Ikeda dot grid, log range rings, and you ----------
{
  const floor = new BlockCloud(28000);
  const N = 82, STEP = 6;
  for (let i = -N; i <= N; i++) for (let j = -N; j <= N; j++) {
    if (Math.hypot(i, j) * STEP > 470) continue;
    floor.add(i * STEP, FLOOR, j * STEP, { w: -1, color: C.DIM, mode: MODE.FLOOR, flick: 0 });
  }
  floor.commit();
  const rings = new LineSet(C.DIM);
  for (const [m] of RANGE_RINGS) {
    const r = R(m);
    for (let a = 0; a < 360; a += 2)
      rings.seg([r * Math.sin(a * DEG), FLOOR, -r * Math.cos(a * DEG)],
                [r * Math.sin((a + 2) * DEG), FLOOR, -r * Math.cos((a + 2) * DEG)]);
  }
  rings.commit();
  // you: seen once the camera pulls back into third person
  const you = new BlockCloud(4), pole = new LineSet(C.WHITE);
  you.add(0, 0, 0, { w: -5, flick: 0, glow: 22 });
  you.commit();
  pole.seg([0, FLOOR, 0], [0, 0, 0]);
  pole.commit();
  world.add(floor.mesh, rings.obj, you.mesh, pole.obj);
  const l = layer('grid', 'range');
  for (const [m, text] of RANGE_RINGS) for (const az of [45, 135, 225, 315]) {
    const r = R(m);
    l.targets.push({ pos: new THREE.Vector3(r * Math.sin(az * DEG), FLOOR, -r * Math.cos(az * DEG)),
                     name: text, prio: 0.2, plain: true, noAim: true });
  }
}

// ---------- shared builders ----------
// A spectral barcode: stripes are the emitter's real bytes, sitting at
// (true bearing, frequency-as-elevation); thickness is its real bandwidth.
function mark(cloud, az, dist, band, f, bw, p, bytes, o = {}) {
  const r = R(dist), el = elOf(band, f), d = dirOf(az, el);
  const pos = [d[0] * r, d[1] * r, d[2] * r];
  const bits = o.bits ?? 24;
  const width = r * (o.span ?? (1.4 + 2.6 * p)) * DEG;
  const thick = Math.max(r * elSpan(band, f, bw), 0.0001);
  const sw = width / bits, tx = Math.cos(az), tz = Math.sin(az);
  pos.first = cloud.n;
  for (let i = 0; i < bits; i++) {
    if (!bitAt(bytes, i + (o.offset ?? 0))) continue;
    const t = (i - (bits - 1) / 2) * sw;
    cloud.add(pos[0] + tx * t, pos[1], pos[2] + tz * t,
      { w: sw, h: thick, i: o.solid ? 1 : 0.3 + 0.7 * p, flick: o.flick ?? 10, color: o.color ?? C.WHITE });
  }
  pos.count = cloud.n - pos.first;
  return pos;
}
// A triangular lattice mast, kept light: three legs and one brace per face.
function truss(lines, x, z, height) {
  const levels = Math.max(2, Math.round(height / 4)), leg = (k, t) => {
    const a = k * 2.0944 + 0.5, r = 1.2 * (1 - t) + 0.22 * t;
    return [x + Math.cos(a) * r, FLOOR + height * t, z + Math.sin(a) * r];
  };
  for (let i = 0; i < levels; i++) {
    const t0 = i / levels, t1 = (i + 1) / levels;
    for (let k = 0; k < 3; k++) {
      lines.seg(leg(k, t0), leg(k, t1));
      lines.seg(leg(k, t0), leg((k + 1) % 3, t1));
    }
  }
}
// structure under a mark: a lattice mast for the strong ones, a hairline for the rest
function support(thin, heavy, pos, height) {
  if (!heavy) return thin.seg([pos[0], FLOOR, pos[2]], pos);
  const h = Math.min(height, Math.max(3, pos[1] - FLOOR));
  truss(heavy, pos[0], pos[2], h);
  if (pos[1] > FLOOR + h) heavy.seg([pos[0], FLOOR + h, pos[2]], pos);
}

// ---------- the power rose: a polar diagram on the floor around your feet ----------
// One radial spike per emitter along its true bearing; length = received power, tip glowing.
// The envelope is a peak-hold trace, as on a spectrum analyser: lit spikes push it up and it
// sinks back by itself — steady where signals are strong, breathing where they are weak.
const ROSE_R0 = 8, ROSE_LEN = 46, ROSE_Y = FLOOR + 0.08, roseSrc = {};
let roseDirty = false, roseAll = [];
const roseR = p => ROSE_R0 + ROSE_LEN * p;
const roseAt = (az, r, y = ROSE_Y) => [r * Math.sin(az), y, -r * Math.cos(az)];
function setRose(id, entries) { roseSrc[id] = entries; roseDirty = true; }
const hull = new Float32Array(360);
let hullSlot = -1;
{
  const l = layer('rose', 'rose');
  const sets = { [C.WHITE]: new LineSet(C.WHITE, 0.5), [C.GRAY]: new LineSet(C.GRAY, 0.4), [C.MBLUE]: new LineSet(C.MBLUE, 0.6) };
  const rays = new LineSet(C.GRAY, 0.18), frame = new LineSet(C.GRAY), axes = new LineSet(C.GRAY, 0.3), scale = new LineSet(C.DIM);
  const tips = new BlockCloud(512);
  const envGeo = new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array(360 * 3), 3));
  const envelope = new THREE.LineLoop(envGeo, new THREE.LineBasicMaterial({ color: 0xb4b4b4 }));
  envelope.frustumCulled = false;
  l.group.add(...Object.values(sets).map(s => s.obj), rays.obj, frame.obj, axes.obj, scale.obj, tips.mesh, envelope);
  const circle = (set, r, step = 3) => { for (let a = 0; a < 360; a += step) set.seg(roseAt(a * DEG, r), roseAt((a + step) * DEG, r)); };
  circle(frame, ROSE_R0);
  for (let a = 0; a < 360; a += 10) frame.seg(roseAt(a * DEG, ROSE_R0), roseAt(a * DEG, ROSE_R0 - (a % 90 ? 0.8 : 2)));
  for (const dbm of [-90, -70, -50, -30]) {
    circle(scale, roseR(level(dbm)), 2);
    l.targets.push({ pos: V(roseAt(20 * DEG, roseR(level(dbm)))), name: `${dbm} dBm`, prio: 0.22, plain: true, noAim: true });
  }
  scale.commit(); frame.commit();
  axes.seg([-470, ROSE_Y, 0], [-ROSE_R0, ROSE_Y, 0]); axes.seg([ROSE_R0, ROSE_Y, 0], [470, ROSE_Y, 0]);
  axes.seg([0, ROSE_Y, -470], [0, ROSE_Y, -ROSE_R0]); axes.seg([0, ROSE_Y, ROSE_R0], [0, ROSE_Y, 470]);
  axes.commit();

  l.rebuild = () => {
    roseDirty = false;
    for (const s of Object.values(sets)) s.clear();
    rays.clear(); tips.clear();
    roseAll = Object.values(roseSrc).flat().sort((a, b) => b.p - a.p);
    roseAll.slice(0, 150).forEach((e, rank) => {               // only the loudest get a spike; the rest live in the envelope
      const tip = roseAt(e.az, roseR(e.p));
      sets[e.color].seg(roseAt(e.az, ROSE_R0), tip);
      if (e.measured) sets[e.color].seg(roseAt(e.az + 0.004, ROSE_R0), roseAt(e.az + 0.004, roseR(e.p)));
      if (rank < 40 && e.foot && Math.hypot(e.foot[0], e.foot[2]) > roseR(e.p)) rays.seg(tip, [e.foot[0], ROSE_Y, e.foot[2]]);
      tips.add(tip[0], tip[1], tip[2], { w: -2, i: 0.25 + 0.75 * e.p, flick: 9, color: e.measured ? C.WHITE : C.GRAY, glow: rank < 30 ? 4 : 0 });   // a hint of light on the loudest tips
    });
    for (const s of Object.values(sets)) s.commit();
    rays.commit(); tips.commit();
  };

  // every frame: sink, then let whichever spikes are lit in this flicker slot push the trace up
  l.tick = (t, dt, pulse) => {
    const slot = Math.floor(t * 9), sink = dt / 1.5;
    for (let d = 0; d < 360; d++) hull[d] = Math.max(0, hull[d] - sink);
    if (slot !== hullSlot) {
      hullSlot = slot;
      for (const e of roseAll) {
        if (Math.random() > 0.25 + 0.75 * e.p) continue;
        const d0 = Math.round(e.az / DEG);
        for (let k = -3; k <= 3; k++) { const d = ((d0 + k) % 360 + 360) % 360, v = e.p * (1 - Math.abs(k) * 0.12); if (v > hull[d]) hull[d] = v; }
      }
    }
    if (pulse > ROSE_R0 && pulse < roseR(1)) {                  // the scan pulse rolls a ripple through the trace
      const lift = (pulse - ROSE_R0) / ROSE_LEN;
      for (let d = 0; d < 360; d++) if (hull[d] < lift) hull[d] = Math.min(lift, hull[d] + 0.25);
    }
    const a = envGeo.attributes.position.array;
    for (let d = 0; d < 360; d++) { const r = roseR(hull[d]); a[d * 3] = r * Math.sin(d * DEG); a[d * 3 + 1] = ROSE_Y; a[d * 3 + 2] = -r * Math.cos(d * DEG); }
    envGeo.attributes.position.needsUpdate = true;
  };
}

// ---------- WiFi: measured dBm, real beacon bytes, real channel width and load ----------
let pulseStart = -1e9;
{
  const l = layer('wifi', 'wifi'), { cloud, lines } = kit(l, 8192), waves = new WaveLines();
  l.group.add(waves.obj);
  let lastScan = 0;
  on('wifi', data => {
    cloud.clear(); lines.clear(); waves.clear(); l.targets = []; nodes.wifi = [];
    const rose = [];
    data.networks.slice(0, 90).forEach((n, rank) => {
      const az = hashAngle(n.bssid.slice(3, 16)) + (parseInt(n.bssid.slice(-1), 16) - 7.5) * 0.45 * DEG;
      const band = wifiBand(n.freq_mhz), bw = n.width_mhz || 20;
      const p = clamp((n.rssi_dbm + 95) / 60, 0.05, 1), busy = n.ch_util ?? 0.1;
      const bytes = hexBytes(n.ie_hex || n.bssid.replace(/:/g, ''));
      const mine = n.bssid === data.connected;
      const pos = mark(cloud, az, n.est_distance_m, band, n.freq_mhz, bw, p, bytes, { bits: 40, flick: 6 + busy * 50 });
      lines.seg([pos[0], FLOOR, pos[2]], pos);
      cloud.add(pos[0], pos[1], pos[2], { w: -3, flick: 0, glow: mine ? 24 : 5 + 11 * p });        // every access point is a small light above the floor
      // a beam of line rings toward you, only for the few loudest: ring spacing follows the
      // real wavelength ratio 12.5 : 5.8 : 4.6 cm, dashes are beacon bits, busy channels run faster
      const loud = rank < 5 || mine, full = band === 'ism' ? 3 : band === 'w5' ? 5 : 6;
      if (rank < 24 || mine) waves.beam(pos, [pos[0] * 0.3, pos[1] * 0.3, pos[2] * 0.3], {
        rings: loud ? full : Math.max(2, full - 2), rate: 0.08 + busy * 0.4, radius: loud ? 5 + 9 * p : 3 + 6 * p,
        intensity: loud ? 0.55 + 0.45 * p : 0.25 + 0.5 * p, color: loud ? C.WHITE : C.GRAY, bytes });
      nodes.wifi.push({ pos, p, ssid: n.ssid, bssid: n.bssid, router: n.bssid.slice(3, 16), channel: n.channel, band, mine });
      rose.push({ az, p, color: C.WHITE, measured: true });
      l.targets.push({ pos: V(pos), name: n.ssid || '‹hidden›', sub: `${n.rssi_dbm} dBm · ch ${n.channel}${mine ? ' · connected' : ''}`,
        prio: 0.5 + p + (mine ? 1 : 0), f: n.freq_mhz, bw, p, tex: 'burst', busy, bytes, fam: 'near', truth: TRUTH.near,
        glyph: 'barcode', rose: { az, p }, blocks: [cloud, pos.first, pos.count], keys: [['signal', `${n.rssi_dbm} dBm`], ['channel', n.channel], ['clients', n.sta_count ?? '—']],
        info: [['bssid', n.bssid], ['signal', `${n.rssi_dbm} dBm · measured`], ['frequency', `${mhz(n.freq_mhz)} · ${bw} MHz wide`],
          ['standard', `wifi ${n.gen ?? '?'} · ${n.radio}`], ['stations', n.sta_count ?? 'not announced'],
          ['channel busy', n.ch_util != null ? `${(n.ch_util * 100).toFixed(1)} %` : 'not announced'],
          ['beacon', `${n.beacon_tu} TU · country ${n.country ?? '—'}`], ['chipset oui', (n.vendors || []).join(' ') || '—'],
          ['distance', `~${n.est_distance_m} m · path-loss estimate`], ['bearing', 'hashed from bssid · not measured']] });
    });
    cloud.commit(); lines.commit(); waves.commit();
    setRose('wifi', rose);
    if (data.last_scan !== lastScan) { lastScan = data.last_scan; pulseStart = performance.now(); }
  });
}

// ---------- BLE: body-worn radios on the three advertising channels ----------
{
  const l = layer('ble', 'ble'), { cloud, lines } = kit(l, 4096), waves = new WaveLines();
  l.group.add(waves.obj);
  on('ble', data => {
    cloud.clear(); lines.clear(); waves.clear(); l.targets = []; nodes.ble = [];
    const rose = [];
    for (const d of (data.devices || []).slice(0, 120)) {
      const az = hashAngle(d.addr), dist = clamp(d.est_distance_m || 3, 1.2, 40);
      const p = clamp((d.rssi_dbm + 100) / 60, 0.05, 1);
      const bytes = hexBytes(d.payload_hex || d.addr.replace(/[^0-9a-f]/gi, ''));
      let pos;
      for (const [k, f] of [2402, 2426, 2480].entries()) {
        const q = mark(cloud, az, dist, 'ism', f, 2, p, bytes, { bits: 16, span: 1.2, flick: 24, offset: k * 16, color: C.GRAY });
        if (k === 1) pos = q;
      }
      lines.seg([pos[0], FLOOR, pos[2]], pos);
      const shape = d.kind === 'find-my' ? SHAPE.CROSS : d.kind === 'airpods' ? SHAPE.HOLLOW : SHAPE.RECT;
      cloud.add(pos[0], pos[1] - 2, pos[2], { w: shape ? -7 : -3, shape, color: C.GRAY, flick: 0 });
      waves.beam([pos[0], pos[1] - 2, pos[2]], [pos[0] * 0.8, pos[1] * 0.8 - 2, pos[2] * 0.8],
        { rings: 2, rate: 0.6, radius: 1.6, intensity: 0.5 + 0.5 * p, color: C.GRAY, segments: 32, bytes });
      nodes.ble.push({ pos, p, group: d.kind || d.company || null });
      rose.push({ az, p, color: C.GRAY, measured: true });
      l.targets.push({ pos: V(pos), name: d.name || d.company || 'ble device', sub: `${d.rssi_dbm} dBm${d.kind ? ' · ' + d.kind : ''}`,
        prio: 0.3 + p * (d.name ? 1 : 0.5), f: 2441, bw: 80, p, tex: 'sparse', bytes, fam: 'near', truth: TRUTH.near, glyph: 'ring',
        rose: { az, p }, keys: [['signal', `${d.rssi_dbm} dBm`], ['maker', d.company ?? '—'], ['type', d.kind ?? '—']],
        info: [['address', d.addr], ['signal', `${d.rssi_dbm} dBm · measured`], ['maker', d.company ?? 'not announced'],
          ['message', d.kind ?? '—'], ['tx power', d.tx_power != null ? `${d.tx_power} dBm` : 'not announced'],
          ['services', d.services], ['distance', `~${d.est_distance_m} m · path-loss estimate`],
          ['bearing', 'hashed from address · not measured']] });
    }
    cloud.commit(); lines.commit(); waves.commit();
    setRose('ble', rose);
  });
}

// ---------- broadcast: FM / AM / TV from the FCC database ----------
let sunUp = true;
function broadcast(id, name, band, bw, roseColor, accent) {
  const l = layer(id, name), { cloud, lines } = kit(l, 8192), masts = new LineSet(C.GRAY, 0.45);
  l.group.add(masts.obj);
  const build = () => {
    const data = S[id];
    if (!data) return;
    cloud.clear(); lines.clear(); masts.clear(); l.targets = [];
    const flare = id === 'am' && (S.sw?.xray_flux ?? 0) >= 1e-5 ? 0.35 : 1;   // M-class: D-layer absorption
    const list = data.stations.map(s => {
      const g = enu(S.obs, s.lat, s.lon), dist = Math.max(g.ground, 30);
      const dbm = estimateDbm(s.erp_kw, dist, s.freq_mhz, id === 'am' && sunUp);
      return { s, g, dist, dbm, p: level(dbm) * flare };
    }).filter(e => e.p >= 0.06).sort((a, b) => b.p - a.p);
    const rose = [], sites = {};
    list.forEach(({ s, g, dist, dbm, p }, rank) => {
      const bytes = textBytes(`${s.callsign}${s.freq_mhz}${s.city}`);
      const pos = mark(cloud, g.az, dist, band, s.freq_mhz, bw, p, bytes, { bits: 28, color: p > 0.5 ? C.WHITE : C.GRAY });
      accent?.(cloud, g.az, dist, s, p);
      support(lines, rank < 12 ? masts : null, pos, 8 + Math.sqrt(Math.max(s.erp_kw, 0.01)) * 2.6);
      cloud.add(pos[0], pos[1], pos[2], { w: -2, flick: 0, glow: 3 + 7 * p });                   // a small light at the very tip, brighter for stronger stations
      rose.push({ az: g.az, p, color: roseColor, foot: pos });
      (sites[`${s.lat.toFixed(3)},${s.lon.toFixed(3)}`] ||= []).push({ pos, f: s.freq_mhz, p });
      l.targets.push({ pos: V(pos), name: s.callsign, sub: `${mhz(s.freq_mhz)} · ${km(dist)}`, prio: p * 0.9,
        f: s.freq_mhz, bw, p, tex: id, bytes, fam: 'ground', truth: TRUTH.db, glyph: 'barcode', rose: { az: g.az, p, foot: pos },
        blocks: [cloud, pos.first, cloud.n - pos.first],
        keys: [['frequency', mhz(s.freq_mhz)], ['distance', km(dist)], ['received', `~${dbm.toFixed(0)} dBm`]],
        info: [['service', `${name} · ${s.class || '—'}`], ['frequency', mhz(s.freq_mhz)],
          ['licensed to', `${s.city}${s.state ? ', ' + s.state : ''}`], ['power', `${s.erp_kw} kW erp`],
          ['distance', km(dist)], ['bearing', `${bearing(g.az)} true`],
          ['received', `~${dbm.toFixed(0)} dBm · estimated`], ['rose', 'spike length = est. rx power'],
          ['source', 'fcc licence database']] });
    });
    nodes.stations[id] = sites;
    cloud.commit(); lines.commit(); masts.commit();
    setRose(id, rose);
  };
  on(id, build);
  return build;
}
const rebuildGround = [
  broadcast('fm', 'fm', 'fm', 0.2, C.WHITE),
  broadcast('am', 'am', 'am', 0.01, C.GRAY, (cloud, az, dist, s, p) =>    // carrier line through the sidebands
    mark(cloud, az, dist, 'am', s.freq_mhz, 0.001, p, [255], { bits: 3, span: 0.5, solid: true })),
  broadcast('tv', 'tv', 'tv', 6, C.GRAY, (cloud, az, dist, s, p) =>       // ATSC pilot on the channel's lower edge
    mark(cloud, az, dist, 'tv', s.freq_mhz - 2.7, 0.3, p, [255], { bits: 8, span: 1.4 + 2.6 * p, solid: true })),
];

// ---------- masts and cells: structures that exist; their bands are allocation, not measurement ----------
{
  const l = layer('masts', 'masts'), { cloud, lines } = kit(l, 16384), towers = new LineSet(C.GRAY, 0.4);
  l.group.add(towers.obj);
  const build = () => {
    cloud.clear(); lines.clear(); towers.clear(); l.targets = [];
    const sites = [...(S.masts?.masts || []).map(m => ({ ...m, osm: true })),
                   ...(S.cells?.towers || []).map((t, i) => ({ ...t, id: `cell${i}`, kind: t.radio, uses: ['mobile_phone'] }))]
      .map(m => ({ m, g: enu(S.obs, m.lat, m.lon) })).sort((a, b) => a.g.ground - b.g.ground);
    const rose = [];
    sites.forEach(({ m, g }, rank) => {
      const dist = Math.max(g.ground, 20), dbm = estimateDbm(0.4, dist, 1900), p = level(dbm);
      const bytes = textBytes(String(m.id)), mobile = !m.uses.length || m.uses.includes('mobile_phone');
      let pos;
      for (const [k, [lo, hi]] of CELL_DOWNLINKS.entries()) {
        if (!mobile && k > 2) break;
        pos = mark(cloud, g.az, dist, 'cell', (lo + hi) / 2, hi - lo, p, bytes, { bits: 10, span: 0.9, offset: k * 7, color: C.GRAY, flick: 5 });
      }
      support(lines, rank < 12 ? towers : null, pos, clamp((m.height_m || 25) * 0.35, 6, 24));
      cloud.add(pos[0], pos[1], pos[2], { w: -2, color: C.GRAY, flick: 0, glow: 3 + 5 * p });     // and on every mast top
      rose.push({ az: g.az, p: p * 0.8, color: C.MBLUE, foot: pos });
      l.targets.push({ pos: V(pos), name: m.name || m.operator || m.kind, sub: km(dist), prio: 0.2 + p * 0.4,
        f: 1900, bw: 1, spans: mobile ? CELL_DOWNLINKS : CELL_DOWNLINKS.slice(0, 3), p: p * 0.5, tex: 'cell', bytes,
        fam: 'ground', truth: TRUTH.db, glyph: 'barcode', rose: { az: g.az, p: p * 0.8, foot: pos },
        keys: [['structure', m.kind], ['distance', km(dist)], ['height', m.height_m ? `${m.height_m} m` : '—']],
        info: [['structure', m.kind], ['carries', m.uses.join(' · ') || 'unspecified'], ['operator', m.operator ?? '—'],
          ['height', m.height_m ? `${m.height_m} m` : '—'], ['distance', km(dist)], ['bearing', `${bearing(g.az)} true`],
          ['bands shown', 'us downlink allocations · not measured'],
          ['source', m.osm ? `openstreetmap node ${m.id}` : 'opencellid']] });
    });
    cloud.commit(); lines.commit(); towers.commit();
    setRose('masts', rose);
  };
  on('masts', build); on('cells', build);
  rebuildGround.push(build);
}

// ---------- the middle distance: places that announce public WiFi, and telecom plant ----------
// Between the ~80 m your own radio can hear and the first broadcast mast kilometres out there
// is nothing to measure — but OpenStreetMap knows where networks are offered. True bearing and
// distance; existence is from the map, nothing here is a measurement.
{
  const l = layer('hotspots', 'hotspots'), { cloud, lines } = kit(l, 4096);
  const build = () => {
    cloud.clear(); lines.clear(); l.targets = [];
    for (const h of S.hotspots?.hotspots || []) {
      const g = enu(S.obs, h.lat, h.lon), dist = Math.max(g.ground, 15), wifi = h.kind === 'wifi';
      const bytes = textBytes(`${h.id}${h.name ?? ''}${h.ssid ?? ''}`), p = level(estimateDbm(0.0001, dist, 2440));
      const pos = mark(cloud, g.az, dist, wifi ? 'ism' : 'cell', wifi ? 2437 : 1900, wifi ? 20 : 60, 0.35, bytes,
                       { bits: 14, span: 1.1, color: C.GRAY, flick: 4 });
      lines.seg([pos[0], FLOOR, pos[2]], pos);
      cloud.add(pos[0], pos[1], pos[2], { w: -5, shape: wifi ? SHAPE.HOLLOW : SHAPE.CROSS, color: C.GRAY, flick: 0, glow: 4 });
      l.targets.push({ pos: V(pos), name: h.name || h.place || h.kind, sub: `${wifi ? 'public wifi' : h.kind} · ${km(dist)}`,
        prio: 0.28 + 0.3 * p, fam: 'ground', truth: TRUTH.db, glyph: 'hollow', bytes, blocks: [cloud, pos.first, cloud.n - pos.first],
        keys: [['kind', wifi ? 'public wifi' : h.kind], ['distance', km(dist)], ['bearing', bearing(g.az)]],
        info: [['offers', wifi ? `wifi${h.ssid ? ' · ssid ' + h.ssid : ''}` : h.kind], ['place', h.place ?? '—'],
          ['operator', h.operator ?? '—'], ['fee', h.fee ?? '—'], ['distance', km(dist)], ['bearing', `${bearing(g.az)} true`],
          ['signal', 'too far to receive here · not measured'], ['source', `openstreetmap ${h.id}`]] });
    }
    cloud.commit(); lines.commit();
  };
  on('hotspots', build);
  rebuildGround.push(build);
}

// ---------- aircraft (ADS-B) and radiosondes: true bearing and elevation ----------
const flying = new Map();
{
  const l = layer('aircraft', 'adsb'), { cloud } = kit(l, 1024), trails = new TrailLines();
  l.group.add(trails.obj);
  on('aircraft', data => {
    const now = performance.now() / 1000, seen = new Set();
    for (const a of data.aircraft) {
      seen.add(a.icao);
      const g = enu(S.obs, a.lat, a.lon);
      flying.set(a.icao, { ...a, e: g.e, n: g.n, t: now });
    }
    for (const [k, a] of flying) if (!seen.has(k) && now - a.t > 60) flying.delete(k);
  });
  l.tick = dt => {
    cloud.clear(); trails.clear(); l.targets = [];
    const now = performance.now() / 1000;
    for (const a of flying.values()) {
      const h = a.heading * DEG;
      a.e += Math.sin(h) * a.vel_ms * dt; a.n += Math.cos(h) * a.vel_ms * dt;    // dead reckoning between polls
      a.alt_m += (a.vrate_ms || 0) * dt;
      const at = back => {
        const e = a.e - Math.sin(h) * a.vel_ms * back, n = a.n - Math.cos(h) * a.vel_ms * back;
        const ground = Math.hypot(e, n);
        return place(Math.atan2(e, n), elevationOf(ground, a.alt_m - (a.vrate_ms || 0) * back), Math.hypot(ground, a.alt_m));
      };
      const pos = at(0), slant = Math.hypot(a.e, a.n, a.alt_m), fresh = now - a.t;
      // a new squitter just landed: flash, then settle
      cloud.add(pos[0], pos[1], pos[2], { w: -9, shape: SHAPE.HOLLOW, flick: 0, glow: fresh < 1.6 ? 26 * (1 - fresh / 1.6) : 0 });
      trails.trail(Array.from({ length: 16 }, (_, k) => at(k * 5)), C.WHITE);
      l.targets.push({ pos: V(pos), name: a.callsign || a.icao, sub: `${a.type ?? ''} ${Math.round(a.alt_m)} m`.trim(),
        prio: 0.75, f: ADSB[0], bw: ADSB[1], p: level(estimateDbm(0.25, slant, 1090)), tex: 'sparse', fam: 'ground', truth: TRUTH.live,
        glyph: 'hollow', bytes: textBytes(a.icao + a.callsign + (a.squawk ?? '')),
        keys: [['altitude', `${Math.round(a.alt_m)} m`], ['speed', `${Math.round(a.vel_ms * 3.6)} km/h`], ['track', `${Math.round(a.heading)}°`]],
        info: [['icao', a.icao], ['type', a.type ?? '—'], ['registration', a.reg ?? '—'], ['squawk', a.squawk ?? '—'],
          ['altitude', `${Math.round(a.alt_m)} m`], ['speed', `${Math.round(a.vel_ms * 3.6)} km/h`],
          ['track', `${Math.round(a.heading)}°`], ['climb', `${a.vrate_ms} m/s`], ['slant range', km(slant)],
          ['transmits', '1090 MHz · ads-b squitter']] });
    }
    cloud.commit(); trails.commit();
  };
}
{
  const l = layer('sondes', 'sondes'), { cloud } = kit(l, 512);
  const build = () => {
    cloud.clear(); l.targets = [];
    for (const s of S.sondes?.sondes || []) {
      const g = enu(S.obs, s.lat, s.lon), slant = Math.hypot(g.ground, s.alt_m);
      const pos = place(g.az, elevationOf(g.ground, s.alt_m), slant), foot = place(g.az, 0, g.ground);
      cloud.add(pos[0], pos[1], pos[2], { w: -9, shape: SHAPE.CROSS, i: 0.85, flick: 2 });
      for (let k = 1; k < 12; k++)
        cloud.add(pos[0] + (foot[0] - pos[0]) * k / 12, pos[1] + (FLOOR - pos[1]) * k / 12,
                  pos[2] + (foot[2] - pos[2]) * k / 12, { w: -2, color: C.GRAY, flick: 0 });
      l.targets.push({ pos: V(pos), name: `sonde ${s.serial}`, sub: `${s.freq_mhz ?? '40x'} MHz · ${Math.round(s.alt_m)} m`,
        prio: 0.8, f: s.freq_mhz || 403, bw: 0.02, p: level(estimateDbm(0.0001, slant, 403)), tex: 'fm', fam: 'ground',
        truth: TRUTH.live, glyph: 'cross', bytes: textBytes(s.serial),
        keys: [['altitude', `${Math.round(s.alt_m)} m`], ['frequency', `${s.freq_mhz} MHz`], ['air temp', s.temp_c != null ? `${s.temp_c} °C` : '—']],
        info: [['type', s.type ?? '—'], ['frequency', `${s.freq_mhz} MHz`],
          ['altitude', `${Math.round(s.alt_m)} m`], ['air temp', s.temp_c != null ? `${s.temp_c} °C` : '—'],
          ['humidity', s.humidity != null ? `${s.humidity} %` : '—'], ['slant range', km(slant)],
          ['last frame', s.datetime], ['source', 'sondehub · amateur receiver network']] });
    }
    cloud.commit();
  };
  on('sondes', build);
  rebuildGround.push(build);
}

// ---------- satellites: SGP4 on real elements, a slice of the catalogue every frame ----------
export const SAT_STYLE = {
  stations: { w: -9, shape: SHAPE.CROSS, color: C.WHITE, trail: C.WHITE, label: 1 },
  gnss: { w: -7, shape: SHAPE.HOLLOW, color: C.PBLUE, trail: C.PBLUE, label: 0.6 },
  weather: { w: -7, shape: SHAPE.CROSS, color: C.PBLUE, trail: C.PBLUE, label: 0.55 },
  amateur: { w: -3, color: C.PBLUE, trail: C.PBLUE, label: 0.3 },
  visual: { w: -3, color: C.PBLUE, trail: C.PBLUE, label: 0.35 },
  'iridium-NEXT': { w: -3, color: C.MBLUE, trail: C.MBLUE },
  oneweb: { w: -3, color: C.MBLUE, trail: C.MBLUE },
  starlink: { w: -3, color: C.BLUE, trail: C.MBLUE },
};
const satLayers = { sats: layer('sats', 'sat'), gnss: layer('gnss', 'gnss'), starlink: layer('starlink', 'starlink') };
const satKits = Object.fromEntries(Object.entries(satLayers).map(([k, l]) => {
  const o = kit(l, k === 'starlink' ? 12000 : 2048, C.PBLUE);
  o.trails = new TrailLines();
  l.group.add(o.trails.obj);
  return [k, o];
}));
export let sats = [];
export const skyCount = { above: 0, starlink: 0, gnss: 0, pass: 0 };
const TRAIL_EVERY = 5, TRAIL_POINTS = 24;        // local wake: ~2 minutes of real positions
const ORBIT_EVERY = 30;                          // orbital view ghost: ~5 minutes
let satCursor = 0;

on('tle', data => {
  const seen = new Set();
  sats = [];
  for (const k of Object.values(satKits)) k.cloud.clear();
  for (const group of ['stations', 'gnss', 'weather', 'amateur', 'visual', 'iridium-NEXT', 'oneweb', 'starlink']) {
    for (const [name, l1, l2] of data.groups[group] || []) {
      const id = l1.slice(2, 7);
      if (seen.has(id)) continue;
      seen.add(id);
      let rec;
      try { rec = satellite.twoline2satrec(l1, l2); } catch (e) { continue; }
      if (rec.error) continue;
      const home = group === 'starlink' ? 'starlink' : group === 'gnss' ? 'gnss' : 'sats';
      const st = SAT_STYLE[group], big = group === 'stations' && /^(ISS|CSS)\b|TIANHE/.test(name);
      const idx = satKits[home].cloud.add(0, -1e6, 0, { w: big ? -11 : st.w, shape: st.shape ?? 0,
        color: group === 'stations' && !big ? C.GRAY : st.color, i: 0.96, flick: 3, glow: big ? 30 : 0 });
      sats.push({ rec, name, group, home, idx, id, big, l1, l2, up: false, hist: [], ecf: null, histE: [], n: sats.length });
    }
  }
  for (const k of Object.values(satKits)) k.cloud.commit();
});

const gd = () => ({ latitude: S.obs.lat * DEG, longitude: S.obs.lon * DEG, height: 0 });
// where a satellite is / was / will be: { look angles from you, ecf km, speed km/s }
export function satAt(s, date, observer = gd()) {
  const pv = satellite.propagate(s.rec, date);
  if (!pv || !pv.position) return null;
  const ecf = satellite.eciToEcf(pv.position, satellite.gstime(date));
  return { ecf, eci: pv.position, look: satellite.ecfToLookAngles(observer, ecf),
           speed: pv.velocity ? Math.hypot(pv.velocity.x, pv.velocity.y, pv.velocity.z) : 0 };
}
const localPos = look => place(look.azimuth, look.elevation, look.rangeSat * 1000);

function tickSats(budget) {
  if (!sats.length) return;
  const now = new Date(), t = now.getTime() / 1000, observer = gd();
  for (let k = 0; k < budget; k++) {
    const s = sats[satCursor];
    satCursor = (satCursor + 1) % sats.length;
    if (satCursor === 0) finishSatPass();
    const cloud = satKits[s.home].cloud, q = satAt(s, now, observer), wasUp = s.up;
    s.up = false;
    if (!q) { s.ecf = null; cloud.setPos(s.idx, 0, -1e6, 0); continue; }
    s.ecf = q.ecf; s.speed = q.speed; s.look = q.look;
    if (!s.histE.length || t - s.histE[0].t > ORBIT_EVERY) {
      s.histE.unshift({ t, p: q.ecf });
      if (s.histE.length > TRAIL_POINTS) s.histE.pop();
    }
    if (q.look.elevation > 0.01 && satLayers[s.home].visible) {
      s.up = true; s.pos = localPos(q.look);
      cloud.setPos(s.idx, s.pos[0], s.pos[1], s.pos[2]);
      if (!wasUp) {                                 // just rose: recover where it has really been
        s.hist = [];
        for (let back = 10; back <= 120; back += 10) {
          const b = satAt(s, new Date(now.getTime() - back * 1000), observer);
          if (b) s.hist.push({ t: t - back, p: localPos(b.look) });
        }
      }
      if (!s.hist.length || t - s.hist[0].t > TRAIL_EVERY) {
        s.hist.unshift({ t, p: s.pos });
        if (s.hist.length > TRAIL_POINTS) s.hist.pop();
      }
    } else cloud.setPos(s.idx, 0, -1e6, 0);
  }
  for (const k of Object.values(satKits)) k.cloud.commit(['iPos']);
}

function finishSatPass() {
  for (const l of Object.values(satLayers)) l.targets = [];
  for (const k of Object.values(satKits)) { k.trails.clear(); k.lines.clear(); }
  skyCount.above = skyCount.starlink = skyCount.gnss = 0;
  skyCount.pass++;
  const labelled = new Set(sats.filter(s => s.up && s.group === 'starlink')
    .sort((a, b) => b.look.elevation - a.look.elevation).slice(0, 12));
  for (const s of sats) {
    if (!s.up) continue;
    skyCount.above++;
    const st = SAT_STYLE[s.group], k = satKits[s.home];
    if (s.group === 'starlink') skyCount.starlink++;
    if (s.group === 'gnss') {                       // you are receiving these: a short line that points at you
      skyCount.gnss++;
      k.lines.seg(s.pos, [s.pos[0] * 0.7, s.pos[1] * 0.7, s.pos[2] * 0.7]);
    }
    k.trails.trail(smoothPath([s.pos, ...s.hist.map(h => h.p)]), st.trail);
    const [f, bw] = SAT_FREQ[s.group];
    satLayers[s.home].targets.push({ pos: V(s.pos), name: s.name, prio: s.big ? 1.2 : labelled.has(s) ? 0.45 : st.label ?? 0,
      noLabel: !st.label && !labelled.has(s), sat: s, blocks: [k.cloud, s.idx, 1], fam: 'sky', truth: TRUTH.orbit,
      glyph: st.shape === SHAPE.CROSS ? 'cross' : st.shape ? 'hollow' : 'dot',
      sub: `${Math.round(s.look.rangeSat)} km · el ${(s.look.elevation / DEG).toFixed(0)}°`,
      f, bw, p: s.group === 'gnss' ? 0.1 : 0.25, tex: s.group === 'gnss' ? 'haze' : 'sparse', bytes: textBytes(s.l1 + s.l2),
      raw: [s.name, s.l1, s.l2],
      keys: [['range', `${Math.round(s.look.rangeSat)} km`], ['elevation', `${(s.look.elevation / DEG).toFixed(1)}°`], ['velocity', `${s.speed.toFixed(2)} km/s`]],
      info: [['norad id', s.id], ['constellation', s.group],
        ['azimuth', `${(s.look.azimuth / DEG).toFixed(1)}°`], ['elevation', `${(s.look.elevation / DEG).toFixed(1)}°`],
        ['range', `${Math.round(s.look.rangeSat)} km`], ['velocity', `${s.speed.toFixed(2)} km/s`],
        ['downlink', `${mhz(f)} · typical for the constellation`], ['orbit', 'sgp4 · celestrak elements']] });
  }
  for (const k of Object.values(satKits)) { k.trails.commit(); k.lines.commit(); }
  refreshAim();
}

// ---------- cosmos: the sun, radio sources, pulsars ----------
{
  const l = layer('cosmos', 'cosmos'), { cloud } = kit(l, 256);
  let wasUp = null;
  l.slow = () => {
    cloud.clear(); l.targets = [];
    const sw = S.sw || {}, sun = sunAzEl(S.obs);
    sunUp = sun.el > -6 * DEG;
    const add = (src, o, info) => {
      const { az, el } = src.az != null ? src : raDecToAzEl(src.ra, src.dec, S.obs);
      if (el < 0.01) return;
      const pos = place(az, el, 3e7);
      cloud.add(pos[0], pos[1], pos[2], o);
      l.targets.push({ pos: V(pos), name: src.name, sub: o.sub, prio: o.prio ?? 0.45, f: o.f ?? 1420.4, bw: o.bwid ?? 40,
        p: o.p ?? 0.08, tex: 'haze', bytes: textBytes(src.name), fam: 'sky', truth: TRUTH.orbit, glyph: 'hollow',
        keys: [['azimuth', `${(az / DEG).toFixed(1)}°`], ['elevation', `${(el / DEG).toFixed(1)}°`], info[0]],
        info: [...info, ['azimuth', `${(az / DEG).toFixed(1)}°`], ['elevation', `${(el / DEG).toFixed(1)}°`]] });
    };
    add({ name: 'SUN', ...sun }, { w: -15, shape: SHAPE.HOLLOW, flick: 0, glow: 40, prio: 1, f: 2800, bwid: 400, p: 0.3,
      sub: sw.f107_sfu ? `F10.7 ${sw.f107_sfu} sfu` : '' }, [['radio flux', `${sw.f107_sfu ?? '—'} sfu at 2800 MHz · measured`],
      ['x-ray', `${sw.xray_class ?? '—'} · goes`], ['solar wind', `${sw.wind_kms ?? '—'} km/s`], ['source', 'noaa swpc']]);
    for (const s of RADIO_SOURCES)
      add(s, { w: -5, shape: SHAPE.HOLLOW, flick: 0, sub: 'radio source' }, [['object', s.note]]);
    for (const s of PULSARS)
      add(s, { w: -5, mode: MODE.PULSE, rate: s.period, glow: 16, sub: `${(s.period * 1000).toFixed(1)} ms` },
        [['period', `${s.period} s · blinking at true rate`], ['object', s.note ?? 'pulsar']]);
    cloud.commit();
    if (wasUp !== sunUp) { wasUp = sunUp; rebuildGround[1](); }        // AM reach changes at dusk / dawn
  };
  on('sw', () => { l.slow(); rebuildGround[1](); });
}

// ---------- the selection: the only red in the field ----------
// Its barcode, its spike and ray on the rose, its stretch of envelope, its wake and its
// predicted path all turn red; everything else stays white, grey and blue.
const aimLines = new LineSet(C.RED), aimTrail = new TrailLines();
world.add(aimLines.obj, aimTrail.obj);
let aimed = null, painted = null;
export function setAim(t) { if (t !== aimed) { aimed = t; refreshAim(); } }
function refreshAim() {
  aimLines.clear(); aimTrail.clear();
  if (painted) { const [cloud, first, before] = painted; if (first + before.length <= cloud.n) cloud.paint(first, before.length, before); painted = null; }
  const t = aimed;
  if (t?.blocks && t.blocks[0].n >= t.blocks[1] + t.blocks[2])
    painted = [t.blocks[0], t.blocks[1], t.blocks[0].paint(t.blocks[1], t.blocks[2], C.RED)];
  if (t?.rose && layers.rose.visible) {
    const { az, p, foot } = t.rose, y = ROSE_Y + 0.04;
    for (const d of [-0.006, 0, 0.006]) aimLines.seg(roseAt(az + d, ROSE_R0, y), roseAt(az + d, roseR(p), y));
    if (foot) { aimLines.seg(roseAt(az, roseR(p), y), [foot[0], y, foot[2]]); aimLines.seg([foot[0], FLOOR, foot[2]], foot); }
  }
  if (t?.sat?.up) {
    const s = t.sat, now = Date.now(), ahead = [s.pos];
    aimTrail.trail(smoothPath([s.pos, ...s.hist.map(h => h.p)]), C.RED, true);
    for (let k = 1; k <= 12; k++) { const q = satAt(s, new Date(now + k * 10000)); if (q && q.look.elevation > 0) ahead.push(localPos(q.look)); }
    for (let k = 1; k < ahead.length; k += 2) aimLines.seg(ahead[k - 1], ahead[k]);      // prediction, dashed
  }
  aimLines.commit(); aimTrail.commit();
}

// ---------- the cone your spectrum strip listens to, drawn on the floor once you step back ----------
const cone = new LineSet(C.WHITE, 0.35);
world.add(cone.obj);
export function setViewCone(heading, half, show) {
  cone.obj.visible = show;
  if (!show) return;
  cone.clear();
  const y = FLOOR + 0.12, r = 300;
  cone.seg(roseAt(heading - half, ROSE_R0, y), roseAt(heading - half, r, y));
  cone.seg(roseAt(heading + half, ROSE_R0, y), roseAt(heading + half, r, y));
  for (let k = 0; k < 16; k++) cone.seg(roseAt(heading - half + k / 16 * 2 * half, r, y), roseAt(heading - half + (k + 1) / 16 * 2 * half, r, y));
  cone.commit();
}

// ---------- observer moved ----------
let built = null;
on('obs', () => {
  if (built && Math.hypot(built.lat - S.obs.lat, built.lon - S.obs.lon) < 0.00015) return;   // ~15 m of GPS noise
  built = { lat: S.obs.lat, lon: S.obs.lon };
  for (const f of rebuildGround) f();
  layers.cosmos.slow();
});

// ---------- per-frame ----------
let slowClock = 0;
export function update(t, dt, mobile) {
  uniforms.uTime.value = t;
  const age = (performance.now() - pulseStart) / 1000;
  uniforms.uPulse.value = age < 4 ? age * 120 : -1;
  if (layers.aircraft.visible) layers.aircraft.tick(dt);
  tickSats(mobile ? 150 : 450);
  if (roseDirty) layers.rose.rebuild();
  if (layers.rose.visible) layers.rose.tick(t, dt, uniforms.uPulse.value);
  if ((slowClock += dt) > 1) { slowClock = 0; layers.cosmos.slow(); }
}
