// astro.js — where the natural radio sources are right now.
// Low-precision formulae (Astronomical Almanac): good to ~0.1°, plenty for a block of pixels.
import { DEG } from './space.js';

const jd = date => date.getTime() / 86400000 + 2440587.5;

// J2000 right ascension (hours) / declination (degrees) -> { az, el } in radians
export function raDecToAzEl(raHours, decDeg, obs, date = new Date()) {
  const n = jd(date) - 2451545.0;
  const gmst = 280.46061837 + 360.98564736629 * n;
  const H = (gmst + obs.lon - raHours * 15) * DEG;
  const phi = obs.lat * DEG, dec = decDeg * DEG;
  const el = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(-Math.cos(dec) * Math.sin(H),
                        Math.sin(dec) * Math.cos(phi) - Math.cos(dec) * Math.cos(H) * Math.sin(phi));
  return { az: (az + 2 * Math.PI) % (2 * Math.PI), el };
}

export const gmstDeg = (date = new Date()) => 280.46061837 + 360.98564736629 * (jd(date) - 2451545.0);

// the point on Earth directly under the sun: { lat, lon } in degrees
export function subsolarPoint(date = new Date()) {
  const n = jd(date) - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * DEG, g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / DEG;
  const lon = (((ra - gmstDeg(date)) % 360) + 540) % 360 - 180;
  return { lat: Math.asin(Math.sin(eps) * Math.sin(lam)) / DEG, lon };
}

export function sunAzEl(obs, date = new Date()) {
  const n = jd(date) - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * DEG, g = (357.528 + 0.9856003 * n) * DEG;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * DEG;
  const eps = (23.439 - 0.0000004 * n) * DEG;
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lam), Math.cos(lam)) / DEG / 15;
  const dec = Math.asin(Math.sin(eps) * Math.sin(lam)) / DEG;
  return raDecToAzEl(ra, dec, obs, date);
}
