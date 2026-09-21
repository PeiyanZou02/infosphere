// space.js — the three rules the whole scene is read by.
//   1. bearing is always true        (-Z north, +X east, +Y up)
//   2. distance is log-compressed    (a 3 m earbud and a 36 000 km satellite share one room)
//   3. elevation 0°..24.5° above the horizon is a frequency axis for ground emitters;
//      above it is the real sky.
// The scene and the right-edge HUD ruler both call elOf(), so they stay aligned.

export const DEG = Math.PI / 180;
export const FLOOR = -10;            // floor plane, world units below the eye
export const BAND_DEG = 3.5;         // angular height of one frequency band

export const R = d => 60 * Math.log10(1 + Math.max(d, 0) / 1.5);
export const RANGE_RINGS = [[10, '10 m'], [100, '100 m'], [1e3, '1 km'], [1e4, '10 km'],
                            [1e5, '100 km'], [1e6, '1 000 km'], [1e7, '10 000 km']];

export function dirOf(az, el) {
  const c = Math.cos(el);
  return [Math.sin(az) * c, Math.sin(el), -Math.cos(az) * c];
}
export function place(az, el, dist) {
  const r = R(dist), d = dirOf(az, el);
  return [d[0] * r, d[1] * r, d[2] * r];
}

// observer-relative east / north metres -> bearing + ground distance
const M_PER_DEG = 111320;
export function enu(obs, lat, lon) {
  const e = (lon - obs.lon) * M_PER_DEG * Math.cos(obs.lat * DEG);
  const n = (lat - obs.lat) * M_PER_DEG;
  return { e, n, az: Math.atan2(e, n), ground: Math.hypot(e, n) };
}
// elevation of something `alt` metres up at `ground` metres away, earth curvature included
export const elevationOf = (ground, alt) => Math.atan2(alt - ground * ground / 12742000, ground);

export function metresBetween(a, b) {
  return Math.hypot((a.lat - b.lat) * M_PER_DEG, (a.lon - b.lon) * M_PER_DEG * Math.cos(a.lat * DEG));
}

// ---- rule 3: the horizon frequency wall, stacked bands bottom to top ----
const tvChannel = f => f < 75 ? 2 + (f - 57) / 6 : f < 95 ? 5 + (f - 79) / 6
                     : f < 300 ? 7 + (f - 177) / 6 : 14 + (f - 473) / 6;
export const BANDS = [
  { id: 'am',   name: 'AM',       lo: 0.53, hi: 1.71, ticks: [[0.54, '540 kHz'], [1.0, '1000'], [1.7, '1700']] },
  { id: 'fm',   name: 'FM',       lo: 87.9, hi: 108.1, ticks: [[88, '88 MHz'], [98, '98'], [108, '108']] },
  { id: 'tv',   name: 'TV',       lo: 1.5,  hi: 36.5, map: tvChannel,
    ticks: [[57, 'ch 2'], [177, 'ch 7'], [473, 'ch 14'], [605, 'ch 36']] },
  { id: 'cell', name: 'CELLULAR', lo: 600,  hi: 4000, log: true,
    ticks: [[617, '600 MHz'], [881, '850'], [1960, '1900'], [2600, '2.6 G'], [3700, '3.7 G']] },
  { id: 'ism',  name: 'ISM 2.4',  lo: 2400, hi: 2500,
    ticks: [[2412, 'ch 1'], [2437, 'ch 6'], [2462, 'ch 11'], [2480, 'ble 39']] },
  { id: 'w5',   name: 'WIFI 5 G', lo: 5150, hi: 5900, ticks: [[5180, 'ch 36'], [5500, 'ch 100'], [5825, 'ch 165']] },
  { id: 'w6',   name: 'WIFI 6 E', lo: 5925, hi: 7125, ticks: [[5955, '5955'], [6500, '6500'], [7095, '7095']] },
];
BANDS.forEach((b, i) => { b.index = i; });
export const BAND = Object.fromEntries(BANDS.map(b => [b.id, b]));
export const WALL_TOP = BANDS.length * BAND_DEG * DEG;

function frac(b, f) {
  if (b.map) f = b.map(f);
  const t = b.log ? Math.log(f / b.lo) / Math.log(b.hi / b.lo) : (f - b.lo) / (b.hi - b.lo);
  return Math.min(1, Math.max(0, t));
}
// elevation (radians) of frequency f (MHz) inside band `id`
export const elOf = (id, f) => (BAND[id].index + 0.04 + 0.92 * frac(BAND[id], f)) * BAND_DEG * DEG;
// angular thickness of a signal `bw` MHz wide centred on f
export const elSpan = (id, f, bw) => Math.max(0, elOf(id, f + bw / 2) - elOf(id, f - bw / 2));

export const wifiBand = f => f < 3000 ? 'ism' : f < 5915 ? 'w5' : 'w6';

// ---- received power ----
// WiFi / BLE are measured. Everything else is an estimate: free-space loss to 1 km,
// then a 35 dB/decade terrain slope; AM adds daytime ground / D-layer loss.
export function estimateDbm(erpKw, distM, fMhz, amDay = false) {
  const km = Math.max(distM, 50) / 1000;
  let loss = 32.44 + 20 * Math.log10(fMhz) + (km < 1 ? 20 : 35) * Math.log10(km);
  if (amDay) loss += km * 0.12;
  return 10 * Math.log10(Math.max(erpKw, 1e-4) * 1e6) - loss;
}
export const level = dbm => Math.min(1, Math.max(0.04, (dbm + 100) / 70));

export function hashAngle(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 36000) / 100 * DEG;
}
export function hash01(s) { return hashAngle(s) / (2 * Math.PI); }

export function hexBytes(hex) {
  const out = new Uint8Array(hex.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
export const textBytes = s => Uint8Array.from(s, c => c.charCodeAt(0) & 255);
export const bitAt = (bytes, i) => bytes.length ? (bytes[(i >> 3) % bytes.length] >> (7 - (i & 7))) & 1 : 1;

// ---- the planet: one Earth radius = 1, +Y through the north pole, lon 0 on +X ----
export const RE_KM = 6371;
export const geoVec = (lat, lon) => {
  const c = Math.cos(lat * DEG);
  return [c * Math.cos(lon * DEG), Math.sin(lat * DEG), -c * Math.sin(lon * DEG)];
};
// satellite.js ECF kilometres -> planet frame, in Earth radii
export const ecfVec = e => [e.x / RE_KM, e.z / RE_KM, -e.y / RE_KM];
// local east / north / up unit vectors at a place, in the planet frame
export function enuBasis(lat, lon) {
  const sl = Math.sin(lat * DEG), cl = Math.cos(lat * DEG), so = Math.sin(lon * DEG), co = Math.cos(lon * DEG);
  return { east: [-so, 0, -co], north: [-sl * co, cl, sl * so], up: [cl * co, sl, -cl * so] };
}
