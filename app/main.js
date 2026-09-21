// INFOSPHERE v4.2 — one AR signal field, drawn in hard-edged pixel blocks and 1 px lines.
// Bearing is true, distance is logarithmic, and the band of sky just above the horizon
// is a frequency axis: the horizon itself is the spectrum wall. Screen edges are instruments.
// One continuous zoom: 0 first person -> 1 third person over your own shoulder -> 2 the planet.
import * as THREE from 'three';
import { uniforms, BG } from './gfx.js';
import { DEG, dirOf, geoVec } from './space.js';
import { world, layers, layer, setLayerVisible, localTargets, setAim, setViewCone, update } from './field.js';
import './web.js';
import { Flow } from './flow.js';
import { planet, RG, orbitTargets, setOrbitAim, updateOrbit } from './orbit.js';
import { Hud } from './hud.js';
import { followLocation, Orientation, toggleCamera } from './ar.js';
import { S, on } from './store.js';

const mobile = matchMedia('(pointer: coarse)').matches;
const $ = id => document.getElementById(id);
const clamp = THREE.MathUtils.clamp, lerp = THREE.MathUtils.lerp;

// pixelRatio 1 + no antialias: one block edge = one hard pixel edge
const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
renderer.setPixelRatio(1);
renderer.setClearColor(BG, 1);
$('scene').appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.add(world, planet);
const camera = new THREE.PerspectiveCamera(70, 1, 0.5, 40000);
camera.rotation.order = 'YXZ';
const hud = new Hud($('hud'), camera);

// the magnetosphere cloud lives in whichever scene is showing
const flowLayer = layer('flow', 'magnetosphere');
const flow = new Flow(mobile ? 40000 : 120000);
flowLayer.group.add(flow.obj);
flow.setLocal(); flow.drive();
on('obs', () => { if (!inOrbit) flow.setLocal(); });
on('sw', () => flow.drive());
setInterval(() => flow.drive(), 5000);

function resize() {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  uniforms.uRes.value.set(innerWidth, innerHeight);
  uniforms.uScale.value = innerHeight / (2 * Math.tan(camera.fov * DEG / 2));
  hud.resize();
}
addEventListener('resize', resize);

// ---- looking around: device orientation when there is one, drag otherwise ----
const orientation = new Orientation();
let yaw = 0, pitch = 9 * DEG;             // where you face
let plon = null, plat = 20;               // where the orbital camera hangs (degrees)
let zoom = 0, zoomTo = 0, inOrbit = false, camOn = false;
const ORBIT_AT = 1.5;                     // the hard cut from the room to the planet
const pointers = new Map();
let pinch = 0;
let pick = null, dragged = 0, downAt = null;     // where the selecting pointer is; null while dragging or away

const el = renderer.domElement;
el.addEventListener('pointerdown', e => {
  const row = hud.rowAt(e.clientX, e.clientY);
  if (row >= 0) {                                   // the data bars are the filter: a click shows / hides that row's layers
    const ids = hud.rowLayers(row), show = !ids.some(id => layers[id].visible);
    for (const id of ids) showLayer(id, show);
    return;
  }
  pointers.set(e.pointerId, [e.clientX, e.clientY]); pinch = 0; dragged = 0; downAt = [e.clientX, e.clientY];
});
addEventListener('pointerup', e => {
  pointers.delete(e.pointerId); pinch = 0;
  if (e.pointerType !== 'mouse' && downAt) pick = dragged < 8 ? { x: downAt[0], y: downAt[1] } : pick;   // touch: a tap selects, and stays
  else if (e.pointerType === 'mouse') pick = { x: e.clientX, y: e.clientY };
  downAt = null;
});
el.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') pick = null; });
addEventListener('pointercancel', e => pointers.delete(e.pointerId));
addEventListener('pointermove', e => {
  const last = pointers.get(e.pointerId);
  if (!last) {
    hud.hoverRow = e.target === el ? hud.rowAt(e.clientX, e.clientY) : -1;
    el.style.cursor = hud.hoverRow >= 0 ? 'pointer' : '';
    if (e.pointerType === 'mouse' && e.target === el) pick = hud.hoverRow >= 0 ? null : { x: e.clientX, y: e.clientY };
    return;
  }
  dragged += Math.abs(e.clientX - last[0]) + Math.abs(e.clientY - last[1]);
  if (dragged > 8) pick = null;                                   // a drag is not a selection
  pointers.set(e.pointerId, [e.clientX, e.clientY]);
  if (pointers.size === 2) {                                   // pinch = the same zoom as the wheel
    const [a, b] = [...pointers.values()], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (pinch) zoomTo = clamp(zoomTo - (d - pinch) * 0.005, 0, 2);
    pinch = d;
    return;
  }
  const k = camera.fov * DEG / innerHeight, dx = e.clientX - last[0], dy = e.clientY - last[1];
  if (inOrbit) { plon -= dx * 0.25; plat = clamp(plat + dy * 0.25, -85, 85); }
  else if (!orientation.active) { yaw += dx * k; pitch = clamp(pitch - dy * k, -1.5, 1.5); }
});
el.addEventListener('wheel', e => {
  if (e.shiftKey) { camera.fov = clamp(camera.fov + e.deltaY * 0.03, 20, 95); resize(); }
  else zoomTo = clamp(zoomTo + e.deltaY * 0.0011, 0, 2);
}, { passive: true });
el.addEventListener('dblclick', () => { zoomTo = 0; });

// ---- controls ----
const cycleView = () => { zoomTo = zoomTo < 0.5 ? 1 : zoomTo < 1.5 ? 2 : 0; };
$('btn-view').onclick = cycleView;
$('btn-ar').onclick = async () => {
  if (orientation.enabled) { orientation.disable(); $('btn-ar').classList.remove('on'); return; }
  $('btn-ar').classList.toggle('on', await orientation.enable());
};
$('btn-cam').onclick = async () => {
  try { camOn = await toggleCamera($('camera')); } catch (e) { camOn = false; }
  $('btn-cam').classList.toggle('on', camOn);
  renderer.setClearAlpha(camOn ? 0 : 1);
};
$('btn-hud').onclick = () => { hud.level = (hud.level + 2) % 3; };
addEventListener('keydown', e => {
  if (e.key === 'h') $('btn-hud').onclick();
  if (e.key === 'o') zoomTo = zoomTo < 0.5 ? 1 : 0;
});
const layerButtons = {};
function showLayer(id, show) { setLayerVisible(id, show); layerButtons[id]?.classList.toggle('on', show); }
for (const l of Object.values(layers)) {
  const b = layerButtons[l.id] = document.createElement('button');
  b.textContent = l.name;
  b.className = 'on';
  b.onclick = () => showLayer(l.id, !l.visible);
  $('layers').appendChild(b);
}

// ---- go ----
resize();
followLocation();
if (mobile && typeof window.DeviceOrientationEvent?.requestPermission !== 'function')
  orientation.enable().then(ok => $('btn-ar').classList.toggle('on', ok));

// console helper: infosphere.look(headingDeg, pitchDeg, zoom)
window.infosphere = { look(h, p = 0, z) { yaw = h * DEG; pitch = p * DEG; if (z != null) zoomTo = z; }, point(x, y) { pick = { x, y }; }, layers, hud, S };

const clock = new THREE.Clock(), fwd = new THREE.Vector3(), ORIGIN = new THREE.Vector3();
const ease = t => t * t * (3 - 2 * t);
let fps = 60;

function enterOrbit(on_) {
  inOrbit = on_;
  world.visible = !on_;
  planet.visible = on_;
  (on_ ? planet : flowLayer.group).add(flow.obj);
  if (on_) { flow.setPlanet(RG); if (plon === null) { plon = S.obs.lon; plat = clamp(S.obs.lat - 12, -80, 80); } }
  else flow.setLocal();
  flow.drive();
}

function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(clock.getDelta(), 0.1), t = clock.elapsedTime;
  fps += (1 / Math.max(dt, 1e-3) - fps) * 0.05;
  zoom += (zoomTo - zoom) * Math.min(1, dt * 5);
  if (Math.abs(zoomTo - zoom) < 0.001) zoom = zoomTo;
  if ((zoom >= ORBIT_AT) !== inOrbit) enterOrbit(zoom >= ORBIT_AT);
  update(t, dt, mobile);
  flow.obj.visible = flowLayer.visible;
  uniforms.uGlow.value = inOrbit ? 1 : 1 - 0.5 * Math.min(zoom, 1);   // many halos in few pixels would burn out

  let pose, view;
  if (inOrbit) {
    // the planet: the camera hangs over (plat, plon) and backs away as you keep zooming
    const k = (zoom - ORBIT_AT) / (2 - ORBIT_AT), dist = RG * lerp(2.3, 15, ease(k)), p = geoVec(plat, plon);
    camera.position.set(p[0] * dist, p[1] * dist, p[2] * dist);
    camera.up.set(0, 1, 0);
    camera.lookAt(ORIGIN);
    updateOrbit(mobile);
    pose = { heading: -plon * DEG, pitch: plat * DEG };
    view = `orbit · ${Math.round(dist / RG * 6371 - 6371)} km up`;
  } else {
    if (orientation.active) {                                  // the device is the window
      fwd.set(0, 0, -1).applyQuaternion(orientation.q);
      yaw = Math.atan2(fwd.x, -fwd.z); pitch = Math.asin(clamp(fwd.y, -1, 1));
    }
    // zoom 0: your eye. Beyond it the camera backs out along the line of sight and rises,
    // always looking at you — turn around and it swings round with you.
    const e = ease(clamp(zoom, 0, 1)), dist = 900 * e + Math.max(0, zoom - 1) * 2600;
    if (dist < 0.01) {
      camera.position.set(0, 0, 0);
      if (orientation.active) camera.quaternion.slerp(orientation.q, 0.3);
      else camera.rotation.set(pitch, -yaw, 0);
    } else {
      const f = dirOf(yaw, lerp(pitch, Math.min(pitch - 35 * DEG, -10 * DEG), e));
      camera.position.set(-f[0] * dist, -f[1] * dist, -f[2] * dist);
      camera.up.set(0, 1, 0);
      camera.lookAt(ORIGIN);
    }
    view = orientation.active ? `${orientation.source}${orientation.accuracy != null ? ' ±' + Math.round(orientation.accuracy) + '°' : ''}` : 'drag';
    if (zoom > 0.02) view += ` · 3rd person ${zoom.toFixed(2)}`;
  }
  camera.updateMatrixWorld();
  if (!inOrbit) {
    camera.getWorldDirection(fwd);
    // heading / pitch drive the instruments; face* is where YOU look, whatever the camera is doing
    pose = { heading: Math.atan2(fwd.x, -fwd.z), pitch: Math.asin(clamp(fwd.y, -1, 1)), faceHeading: yaw, facePitch: pitch };
    setViewCone(yaw, 44 * DEG, zoom > 0.25);
  }
  const vfov = camera.fov * DEG;
  pose.vfov = vfov; pose.hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);

  hud.draw(t, inOrbit ? orbitTargets() : localTargets(), pose, { fps: Math.round(fps), heading: view }, { zoom, planet: inOrbit, pick });
  if (inOrbit) setOrbitAim(hud.aim); else setAim(hud.aim);
  renderer.render(scene, camera);
}
frame();
