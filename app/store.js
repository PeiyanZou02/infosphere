// store.js — every feed the scene reads, polled from server.py, plus the observer.
// S.obs follows the device's live position; the fallback is only used when no fix comes.
import { metresBetween } from './space.js';

export const S = {
  obs: { lat: 0, lon: 0, acc: null, status: 'waiting', label: '' },
  wifi: null, ble: null, net: null, aircraft: null, sondes: null, sw: null, tle: null,
  masts: null, hotspots: null, fm: null, am: null, tv: null, cells: null,
  state: {},                    // feed -> 'live' | 'offline' | 'loading'
};

const listeners = {};
export function on(kind, fn) { (listeners[kind] ||= []).push(fn); }
function emit(kind) { for (const fn of listeners[kind] || []) fn(S[kind]); }

const RELOAD_METRES = 250;      // ground datasets are refetched after walking this far
let anchor = null, started = false;
const here = () => `lat=${S.obs.lat.toFixed(5)}&lon=${S.obs.lon.toFixed(5)}`;

async function load(kind, url) {
  try {
    const r = await fetch(url);
    const data = await r.json();
    if (!r.ok || (data.error && !data.stale)) throw new Error(data.error || r.status);
    S[kind] = data;
    S.state[kind] = data.stale ? 'stale' : 'live';
    emit(kind);
  } catch (e) {
    S.state[kind] = 'offline';
    emit('state');
  }
}

function every(kind, url, seconds) {
  const tick = () => load(kind, typeof url === 'function' ? url() : url);
  tick();
  setInterval(tick, seconds * 1000);
}

function loadGround() {
  anchor = { lat: S.obs.lat, lon: S.obs.lon };
  for (const k of ['fm', 'am', 'tv', 'masts', 'hotspots']) load(k, `/api/${k}?${here()}`);
  load('cells', `/api/towers?${here()}&r=5000`);
}

export function setObserver(lat, lon, acc, status, label = '') {
  Object.assign(S.obs, { lat, lon, acc, status, label });
  emit('obs');
  if (!started) {
    started = true;
    every('wifi', '/api/wifi', 4);
    every('ble', '/api/ble', 4);
    every('net', '/api/net', 2);
    every('aircraft', () => `/api/aircraft?${here()}&r=150`, 10);
    every('sondes', () => `/api/sondes?${here()}&r=400`, 30);
    every('sw', '/api/spaceweather', 120);
    every('tle', '/api/tle', 3600);
    loadGround();
  } else if (metresBetween(anchor, S.obs) > RELOAD_METRES) {
    loadGround();
  }
}

export const fallbackLocation = () => fetch('/api/config').then(r => r.json()).then(c => c.fallback_location);
