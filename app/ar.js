// ar.js — the device as a window: live position, full 3-DOF orientation, optional camera.
// All three need a secure context on phones, which is why server.py also serves HTTPS.
import * as THREE from 'three';
import { setObserver, fallbackLocation } from './store.js';

// ---- position: follow the device; the fallback is only for "no fix at all" ----
export function followLocation() {
  let fixed = false;
  const giveUp = async why => {
    if (fixed) return;
    const f = await fallbackLocation();
    if (!fixed) setObserver(f.lat, f.lon, null, `fallback (${why})`, f.label);
  };
  if (!navigator.geolocation) return giveUp('no geolocation api');
  const timer = setTimeout(() => giveUp('no fix yet'), 7000);
  navigator.geolocation.watchPosition(p => {
    fixed = true;
    clearTimeout(timer);
    setObserver(p.coords.latitude, p.coords.longitude, p.coords.accuracy, 'live');
  }, err => { clearTimeout(timer); giveUp(err.code === 1 ? 'permission denied' : 'unavailable'); },
  { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
}

// ---- orientation: alpha / beta / gamma -> camera quaternion (-Z north, +Y up) ----
const zee = new THREE.Vector3(0, 0, 1), euler = new THREE.Euler();
const q0 = new THREE.Quaternion(), q1 = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const RAD = Math.PI / 180;

export class Orientation {
  constructor() {
    this.q = new THREE.Quaternion();
    this.active = false;
    this.enabled = false;
    this.source = 'drag';
    this.accuracy = null;
    this.offset = null;           // iOS: alpha is relative, compass heading anchors it to north
    this.listening = false;
  }

  async enable() {
    const D = window.DeviceOrientationEvent;
    if (!D) return false;
    if (typeof D.requestPermission === 'function') {          // iOS wants a tap first
      try { if (await D.requestPermission() !== 'granted') return false; } catch (e) { return false; }
    }
    if (!this.listening) {
      this.listening = true;
      const abs = 'ondeviceorientationabsolute' in window;
      addEventListener(abs ? 'deviceorientationabsolute' : 'deviceorientation', e => this.onEvent(e, abs));
    }
    this.enabled = true;
    return true;
  }

  disable() { this.enabled = this.active = false; }

  onEvent(e, abs) {
    if (!this.enabled || e.alpha == null || e.beta == null) return;
    let alpha = e.alpha;
    if (e.webkitCompassHeading != null) {
      const want = ((360 - e.webkitCompassHeading - e.alpha) % 360 + 360) % 360;
      if (this.offset == null) this.offset = want;
      else this.offset += ((((want - this.offset) % 360) + 540) % 360 - 180) * 0.05;   // ease toward north
      alpha += this.offset;
      this.accuracy = e.webkitCompassAccuracy;
      this.source = 'compass';
    } else this.source = abs || e.absolute ? 'compass' : 'gyro · relative';
    const orient = (screen.orientation?.angle ?? window.orientation ?? 0) * RAD;
    euler.set(e.beta * RAD, alpha * RAD, -e.gamma * RAD, 'YXZ');
    this.q.setFromEuler(euler).multiply(q1).multiply(q0.setFromAxisAngle(zee, -orient));
    this.active = true;
  }
}

// ---- camera passthrough: off by default, and kept dark and grey when on ----
export async function toggleCamera(video) {
  if (video.srcObject) {
    video.srcObject.getTracks().forEach(t => t.stop());
    video.srcObject = null;
    return false;
  }
  video.srcObject = await navigator.mediaDevices.getUserMedia(
    { video: { facingMode: { ideal: 'environment' } }, audio: false });
  await video.play();
  return true;
}
