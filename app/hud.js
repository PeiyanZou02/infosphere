// hud.js — the calibrated frame around the field. Everything here is an instrument
// driven by the camera pose or a live feed:
//   top     compass tape            right   pitch ladder that doubles as the frequency ruler
//   bottom  directional spectrum    left    live data bars
//   centre  reticle + readout of whatever is being aimed at
import * as THREE from 'three';
import { css } from './gfx.js';
import { DEG, BANDS, BAND_DEG, elOf, dirOf, bitAt } from './space.js';
import { ALLOCATIONS, F_MIN, F_MAX, fx } from './bands.js';
import { S } from './store.js';
import { skyCount, layers } from './field.js';
import { orbitRow, visibleNow } from './orbit.js';

const SANS = '10px "Helvetica Neue", Helvetica, Arial, sans-serif';
const MONO = '10px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const SMALL = '9px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const tmp = new THREE.Vector3();
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const TAU = Math.PI * 2, FAMILY = { near: 0, sky: 5, ground: 2 };

export class Hud {
  constructor(canvas, camera) {
    this.canvas = canvas; this.camera = camera; this.ctx = canvas.getContext('2d');
    this.level = 2;                        // 2 instruments + labels · 1 labels only · 0 nothing
    this.widths = new Map();
    this.wf = document.createElement('canvas');     // waterfall, one cell = 2 css px
    this.wfLast = 0;
    this.history = {};
    this.histLast = 0;
    this.frame = 0;
    this.aim = null;
    this.hoverRow = -1;
    this.aimKey = ''; this.aimHist = []; this.arc = [0, 0]; this.feed = 0;
    this.resize();
  }

  resize() {
    const dpr = Math.min(devicePixelRatio || 1, 3);
    this.W = innerWidth; this.H = innerHeight;
    this.canvas.width = this.W * dpr; this.canvas.height = this.H * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.wf.width = Math.ceil(this.W / 2); this.wf.height = 28;
    this.narrow = this.W < 720;
  }

  textWidth(s) {
    let w = this.widths.get(s);
    if (w === undefined) { w = this.ctx.measureText(s).width; this.widths.set(s, w); if (this.widths.size > 4000) this.widths.clear(); }
    return w;
  }
  rect(x, y, w, h, role = 0) { this.ctx.fillStyle = css(role); this.ctx.fillRect(Math.round(x), Math.round(y), w, h); }
  text(s, x, y, role = 0, font = MONO, align = 'left') {
    const c = this.ctx; c.font = font; c.fillStyle = css(role); c.textAlign = align; c.fillText(s, Math.round(x), Math.round(y));
  }
  // screen position of a world point / of a sky direction, or null when behind the camera
  project(v) {
    tmp.copy(v).project(this.camera);
    if (tmp.z < -1 || tmp.z > 1) return null;
    return [(tmp.x * 0.5 + 0.5) * this.W, (-tmp.y * 0.5 + 0.5) * this.H];
  }
  projectDir(az, el) {
    const d = dirOf(az, el);
    tmp.set(d[0], d[1], d[2]).multiplyScalar(100).add(this.camera.position);
    return this.project(tmp);
  }

  // mode: { zoom 0..2, planet: bool }
  draw(t, targets, pose, info, mode) {
    const c = this.ctx;
    c.clearRect(0, 0, this.W, this.H);
    this.frame++;
    this.mode = mode;
    this.ringR = clamp(Math.min(this.W, this.H) * (this.narrow ? 0.12 : 0.085), 44, 92);
    if (!this.level) return;
    c.textBaseline = 'alphabetic';
    // the ring instrument belongs to the first-person eye: it lets go as the camera backs away
    this.ringAlpha = clamp(1 - mode.zoom / 0.25, 0, 1);
    this.ringR *= 1 + Math.min(mode.zoom, 0.25) * 1.2;
    this.place(targets, pose);
    if (this.level < 2) { this.selection(); return; }
    this.sampleHistory(t);
    this.plates();
    if (mode.planet) this.table();
    else { this.compass(pose, targets); this.ladder(pose); this.spectrum(t, targets); }
    this.bars();
    this.rowHighlight(targets);
    if (this.ringAlpha > 0) { c.globalAlpha = this.ringAlpha; this.reticle(pose, targets); c.globalAlpha = 1; }
    this.selection();
    this.corners(pose, info);
  }

  // ---- labels in screen space, Hertzian style: a tick, a name, a value ----
  place(targets, pose) {
    const c = this.ctx, full = this.level === 2, hover = this.ringAlpha <= 0, pick = this.mode.pick;
    const cx = hover ? pick?.x : this.W / 2, cy = hover ? pick?.y : this.H / 2;
    // what the spectrum strip hears: a cone from YOU along where you face — not whatever the camera frames
    const face = dirOf(pose.faceHeading ?? pose.heading, pose.facePitch ?? pose.pitch), cosHalf = Math.cos(44 * DEG);
    const bottom = this.H - (full ? 108 : 0), topEdge = full ? 96 : 4;
    // instruments own the edges: labels keep out of the data bars and the ladder
    const placed = full ? [[0, 0, this.narrow ? 130 : 172, this.H], [this.W - (this.narrow ? 70 : 128), 0, this.W, this.H]] : [];
    let best = null, bestD = hover ? 40 : this.ringR * 0.92;
    const cap = Math.round(130 - 70 * clamp(this.mode.zoom, 0, 1));
    const vis = [];
    for (const t of targets) {
      const s = this.project(t.pos), len = t.pos.length() || 1;
      t.on = false;
      t.cone = !this.mode.planet && (t.pos.x * face[0] + t.pos.y * face[1] + t.pos.z * face[2]) / len > cosHalf;
      if (!s || s[0] < -40 || s[0] > this.W + 40 || s[1] < -40 || s[1] > this.H + 40) continue;
      t.on = true; t.sx = s[0]; t.sy = s[1];
      if (!t.noAim && cx != null) { const d = Math.hypot(s[0] - cx, s[1] - cy); if (d < bestD) { bestD = d; best = t; } }
      if (!t.noLabel && t.prio > 0) vis.push(t);
    }
    this.aim = best;
    this.panel = full && best ? this.panelBox(best) : null;
    if (this.panel) placed.push(this.panel);
    vis.sort((a, b) => b.prio - a.prio);
    c.font = SANS;
    let n = 0;
    for (const t of vis) {
      if (n > cap) break;
      const w = Math.max(this.textWidth(t.name), t.sub ? this.textWidth(t.sub) : 0) + 8;
      const x = Math.round(t.sx), y = Math.round(t.sy), h = t.sub ? 25 : 14;
      const box = [x - 2, y - h - 3, x + w, y + 2];
      if (box[1] < topEdge || box[3] > bottom) continue;
      if (placed.some(p => box[0] < p[2] && box[2] > p[0] && box[1] < p[3] && box[3] > p[1])) continue;
      placed.push(box); n++;
      if (t === best) continue;                       // the selection speaks through its red frame and panel
      const role = t.plain ? 1 : 0;
      this.rect(x, y - h - 2, 1, h, role);
      this.text(t.name, x + 4, y - h + 7, role, SANS);
      if (t.sub) this.text(t.sub, x + 4, y - h + 18, 3, SANS);
    }
    this.cands = vis;
  }

  // ---- top: compass tape ----
  compass(pose, targets) {
    const y0 = 22, el = clamp(pose.pitch, -55 * DEG, 55 * DEG), head = pose.heading / DEG;
    const half = pose.hfov / DEG / 2 + 4, a0 = Math.floor(head - half), a1 = Math.ceil(head + half);
    const pxPerDeg = this.W / (pose.hfov / DEG);
    this.rect(0, y0, this.W, 1, 1);
    for (let a = a0; a <= a1; a++) {
      const s = this.projectDir(a * DEG, el);
      if (!s) continue;
      const az = ((a % 360) + 360) % 360, x = s[0];
      if (az % 10 === 0) {
        this.rect(x, y0, 1, 10, 0);
        const name = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }[az];
        if (name || pxPerDeg > 5 || az % 30 === 0)
          this.text(name ?? String(az).padStart(3, '0'), x, y0 - 5, name ? 0 : 3, MONO, 'center');
      } else if (az % 5 === 0) this.rect(x, y0, 1, 6, 3);
      else if (pxPerDeg > 7) this.rect(x, y0, 1, 3, 1);
    }
    // bearings of the strongest emitters: turn until the pip meets the caret
    const strong = targets.filter(t => t.p && !t.noLabel).sort((a, b) => b.p - a.p).slice(0, 24);
    for (const t of strong) {
      const az = Math.atan2(t.pos.x, -t.pos.z), s = this.projectDir(az, el);
      if (s) this.rect(s[0] - 1, y0 + 12, 2, 2 + Math.round(t.p * 5), t === this.aim ? 2 : 3);
    }
    const cx = Math.round(this.W / 2);
    this.rect(cx, y0 - 4, 1, 22, 0);
    this.rect(cx - 25, y0 + 22, 51, 15, 0);
    this.text(`${((head % 360 + 360) % 360).toFixed(1).padStart(5, '0')}°`, cx, y0 + 33, -1, MONO, 'center');
  }

  // ---- right: pitch ladder. Between 0° and the top of the wall it is a frequency ruler,
  //      projected with the same elOf() the scene uses, so ticks meet the marks they measure.
  ladder(pose) {
    const x0 = this.W - (this.narrow ? 30 : 46);
    const off = Math.atan(((x0 - this.W / 2) / (this.W / 2)) * Math.tan(pose.hfov / 2));
    const yOf = el => { const s = this.projectDir(pose.heading + off, el); return s ? s[1] : null; };
    this.rect(x0, 44, 1, this.H - 44 - 108, 1);
    for (let e = -40; e <= 90; e++) {
      const y = yOf(e * DEG);
      if (y === null || y < 48 || y > this.H - 112) continue;
      if (e % 10 === 0) { this.rect(x0, y, 12, 1, 0); this.text(`${e > 0 ? '+' : ''}${e}°`, x0 + 15, y + 3, e === 0 ? 0 : 3, SMALL); }
      else if (e % 5 === 0) this.rect(x0, y, 7, 1, 3);
      else this.rect(x0, y, 3, 1, 1);
    }
    for (const b of this.mode.zoom > 0.15 ? [] : BANDS) {
      const yLo = yOf(b.index * BAND_DEG * DEG), yHi = yOf((b.index + 1) * BAND_DEG * DEG);
      if (yLo === null || yHi === null || yHi > this.H - 112 || yLo < 48) continue;
      this.rect(x0 - 5, yHi, 5, 1, 0); this.rect(x0 - 5, yLo, 5, 1, 0); this.rect(x0 - 5, yHi, 1, yLo - yHi, 0);
      if (yLo - yHi < 22) continue;                    // too squeezed to annotate
      this.text(b.name, x0 - 9, (yLo + yHi) / 2 + 3, 0, SMALL, 'right');
      if (this.narrow) continue;
      let lastY = 1e9;
      for (const [f, label] of b.ticks) {
        const y = yOf(elOf(b.id, f));
        if (y === null || Math.abs(y - lastY) < 10 || Math.abs(y - ((yLo + yHi) / 2)) < 9) continue;
        lastY = y;
        this.rect(x0 - 66, y, 8, 1, 3);
        this.text(label, x0 - 70, y + 3, 3, SMALL, 'right');
      }
    }
    const yp = clamp(this.H / 2, 48, this.H - 112);
    this.rect(x0 - 3, yp, 7, 1, 0);
    this.text(`${pose.pitch >= 0 ? '+' : ''}${(pose.pitch / DEG).toFixed(1)}°`, x0 - 8, yp - 4, 0, SMALL, 'right');
  }

  // ---- left: live data bars ----
  metrics() {
    const n = S.net || {}, w = S.wifi || {}, sw = S.sw || {};
    const nets = w.networks || [], top = nets[0] || {};
    const logv = (v, lo, hi) => clamp((Math.log10(Math.max(v, lo)) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)), 0, 1);
    const bps = v => v == null ? '—' : v > 1e6 ? `${(v / 1e6).toFixed(2)} Mb/s` : `${(v / 1e3).toFixed(1)} kb/s`;
    const count = (k, arr) => S[k] ? String(arr.length).padStart(3, '0') : '—';
    return [
      ['link ↓', bps(n.rx_bps), logv(n.rx_bps || 0, 1e3, 1e8), ['net']],
      ['link ↑', bps(n.tx_bps), logv(n.tx_bps || 0, 1e3, 1e8), ['net']],
      ['tcp sockets', count('net', n.connections || []), (n.conn_count || 0) / 120, ['net']],
      ['wifi networks', count('wifi', nets), nets.length / 90, ['wifi', 'web']],
      ['wifi clients', String(nets.reduce((a, x) => a + (x.sta_count || 0), 0)).padStart(3, '0'), nets.reduce((a, x) => a + (x.sta_count || 0), 0) / 120, ['wifi']],
      ['channel busy', top.ch_util != null ? `${(top.ch_util * 100).toFixed(1)} %` : '—', top.ch_util || 0, ['wifi']],
      ['ble devices', S.ble?.status === 'live' ? String(S.ble.count).padStart(3, '0') : S.ble?.status ?? '—', (S.ble?.count || 0) / 80, ['ble']],
      ['aircraft', count('aircraft', S.aircraft?.aircraft || []), (S.aircraft?.count || 0) / 60, ['aircraft', 'sondes']],
      ['sat above', String(skyCount.above).padStart(4, '0'), skyCount.above / 700, ['sats', 'gnss', 'starlink']],
      ['starlink', layers.starlink.visible ? String(skyCount.starlink).padStart(4, '0') : 'off', skyCount.starlink / 600, ['starlink']],
      ['gnss locked-on', String(skyCount.gnss).padStart(3, '0'), skyCount.gnss / 50, ['gnss']],
      ['broadcast', String((S.fm?.stations.length || 0) + (S.am?.stations.length || 0) + (S.tv?.stations.length || 0)).padStart(3, '0'), 0.5, ['fm', 'am', 'tv']],
      ['masts · hotspots', String((S.masts?.masts.length || 0) + (S.hotspots?.hotspots.length || 0)).padStart(3, '0'), ((S.masts?.masts.length || 0) + (S.hotspots?.hotspots.length || 0)) / 300, ['masts', 'hotspots']],
      ['kp index', sw.kp != null ? sw.kp.toFixed(2) : '—', (sw.kp || 0) / 9, ['flow']],
      ['solar wind', sw.wind_kms != null ? `${sw.wind_kms} km/s` : '—', clamp(((sw.wind_kms || 250) - 250) / 650, 0, 1), ['flow']],
      ['imf bz', sw.bz_nt != null ? `${sw.bz_nt > 0 ? '+' : ''}${sw.bz_nt} nT` : '—', clamp(0.5 + (sw.bz_nt || 0) / 40, 0, 1), ['flow']],
      ['x-ray', sw.xray_class ? `${sw.xray_class} ${sw.xray_flux.toExponential(1)}` : '—', logv(sw.xray_flux || 1e-9, 1e-8, 1e-3), ['cosmos']],
      ['f10.7', sw.f107_sfu != null ? `${sw.f107_sfu} sfu` : '—', clamp(((sw.f107_sfu || 60) - 60) / 240, 0, 1), ['cosmos']],
    ];
  }
  sampleHistory(t) {
    if (t - this.histLast < 0.5) return;
    this.histLast = t;
    for (const [k, , v] of this.metrics()) { const h = (this.history[k] ||= []); h.push(v); if (h.length > 40) h.shift(); }
  }
  bars() {
    const rows = this.metrics(), x = 22, top = 78, step = this.narrow ? 24 : 27;
    const room = Math.floor((this.H - top - 120) / step);
    this.rowBox = { x0: 0, x1: 186, top: top - 12, step, n: Math.min(room, rows.length) };
    rows.slice(0, room).forEach(([k, v, lv, ids], i) => {
      const y = top + i * step, segs = 22, lit = Math.round(clamp(lv, 0, 1) * segs);
      const shown = ids.some(id => layers[id]?.visible), hot = i === this.hoverRow;
      // a checkbox per row: the bars are also the filter. Hover = red, and its things light up red in the field
      this.ctx.strokeStyle = css(hot ? 2 : 3); this.ctx.lineWidth = 1; this.ctx.strokeRect(8.5, y - 7.5, 7, 7);
      if (shown) this.rect(10, y - 6, 4, 4, hot ? 2 : 0);
      if (hot) { this.rect(x, y + 12, 164, 1, 2); this.rect(2, y - 10, 2, 22, 2); }
      this.text(k, x, y, hot ? 2 : shown ? 3 : 1, SMALL);
      this.text(shown ? v : 'hidden', x + 108, y, shown ? 0 : 1, SMALL, 'right');
      for (let s = 0; s < segs; s++) this.rect(x + s * 5, y + 4, 3, 6, shown && s < lit ? 0 : 1);
      const h = this.history[k] || [];
      if (!this.narrow && shown) h.forEach((hv, j) => { const hh = 1 + Math.round(clamp(hv, 0, 1) * 9); this.rect(x + 118 + j, y + 10 - hh, 1, hh, j === h.length - 1 ? 0 : 3); });
    });
  }
  // which data row is under this screen point, if any
  rowAt(px, py) {
    const b = this.rowBox;
    if (!b || this.level < 2 || px < b.x0 || px > b.x1) return -1;
    const i = Math.floor((py - b.top) / b.step);
    return i >= 0 && i < b.n ? i : -1;
  }
  rowLayers(i) { return this.metrics()[i]?.[3] || []; }
  // everything that belongs to the hovered row gets a small red frame in the field
  rowHighlight(targets) {
    if (this.hoverRow < 0) return;
    const ids = new Set(this.rowLayers(this.hoverRow));
    let n = 0;
    for (const t of targets) {
      if (!t.on || !ids.has(t.layer) || ++n > 900) continue;
      const x = Math.round(t.sx), y = Math.round(t.sy);
      this.rect(x - 4, y - 4, 9, 1, 2); this.rect(x - 4, y + 4, 9, 1, 2); this.rect(x - 4, y - 4, 1, 9, 2); this.rect(x + 4, y - 4, 1, 9, 2);
    }
  }

  // ---- bottom: spectrum of whatever is inside the field of view ----
  spectrum(t, targets) {
    const c = this.ctx, w = this.wf.width, hCells = this.wf.height, g = this.wf.getContext('2d');
    const yTop = this.H - 92, hPx = hCells * 2, inView = targets.filter(q => q.cone && q.f);
    if (t - this.wfLast > 0.06) {
      this.wfLast = t;
      g.globalCompositeOperation = 'copy';            // scroll must replace, not pile up
      g.drawImage(this.wf, 0, 1);
      g.globalCompositeOperation = 'source-over';
      const row = g.createImageData(w, 1), d = row.data, pal = [0, 1, 3].map(r => css(r)).map(h => [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16)));
      const put = (x, role) => { const p = pal[role], o = x * 4; d[o] = p[0]; d[o + 1] = p[1]; d[o + 2] = p[2]; d[o + 3] = 255; };
      // energy per cell: crowded bands get dense, but never a flat slab — Hertzian texture
      const e = new Float32Array(w), peak = new Float32Array(w);
      for (const q of inView) {
        if (q.f < F_MIN || q.f > F_MAX) continue;
        const p = q.p ?? 0.3;
        if (q.tex === 'burst' && Math.random() > 0.12 + (q.busy || 0) * 3) continue;   // wifi talks in bursts
        const prob = q.tex === 'burst' ? 0.3 + 0.7 * p : q.tex === 'sparse' ? 0.1 * (0.4 + p)
                   : q.tex === 'haze' ? 0.06 : q.tex === 'cell' ? p * 0.02 : p * p * 0.5;
        for (const [lo, hi] of q.spans || [[q.f - q.bw / 2, q.f + q.bw / 2]]) {
          const x0 = Math.floor(fx(Math.max(F_MIN, lo)) * w), x1 = Math.max(x0, Math.floor(fx(hi) * w));
          for (let x = x0; x <= x1 && x < w; x++) { e[x] += prob; if (q.tex !== 'haze' && p > peak[x]) peak[x] = p; }
        }
      }
      const noise = 0.006 + ((S.sw?.f107_sfu || 80) / 100) * 0.008;      // quiet sun, quiet floor
      for (let x = 0; x < w; x++) {
        if (Math.random() < Math.min(0.68, 1 - Math.exp(-e[x] * 0.9))) put(x, peak[x] > 0.55 ? 0 : peak[x] > 0 ? 2 : 1);
        else if (Math.random() < noise) put(x, 1);
      }
      g.putImageData(row, 0, 0);
    }
    c.imageSmoothingEnabled = false;
    c.drawImage(this.wf, 0, yTop, w * 2, hPx);
    this.rect(0, yTop - 1, this.W, 1, 1);
    this.rect(0, yTop + hPx, this.W, 1, 0);
    // ruler: 1-2-5 ticks per decade
    for (let dec = -1; dec <= 4; dec++) for (const m of [1, 2, 5]) {
      const f = m * 10 ** dec;
      if (f < F_MIN || f > F_MAX) continue;
      const x = fx(f) * this.W;
      this.rect(x, yTop + hPx, 1, m === 1 ? 7 : 4, 0);
      if (m === 1 || !this.narrow) this.text(f >= 1000 ? `${f / 1000} GHz` : f < 1 ? `${f * 1000} kHz` : `${f} MHz`, x + 3, yTop + hPx + 11, m === 1 ? 0 : 3, SMALL);
    }
    let lastX = -1e9;
    c.font = SMALL;
    for (const [lo, hi, name] of ALLOCATIONS) {
      const x = fx(lo) * this.W, x1 = fx(hi) * this.W;
      if (x < lastX + 4) continue;
      this.rect(x, yTop + hPx + 15, Math.max(1, x1 - x), 2, 3);
      this.text(name, x, yTop + hPx + 27, 1, SMALL);
      lastX = x + this.textWidth(name);
    }
    // the loudest things in view, labelled the Hertzian way
    let right = -1e9;
    for (const q of inView.filter(q => q.p > 0.2).sort((a, b) => fx(a.f) - fx(b.f) || b.p - a.p)) {
      const x = fx(q.f) * this.W;
      if (x < right + 6 || x > this.W - 60) continue;
      const label = `${q.name}  ${q.f >= 1000 ? (q.f / 1000).toFixed(3) + ' GHz' : q.f < 3 ? Math.round(q.f * 1000) + ' kHz' : (+q.f).toFixed(1) + ' MHz'}`;
      this.rect(x, yTop - 14, 1, 13, q === this.aim ? 2 : 3);
      this.text(label, x + 3, yTop - 5, q === this.aim ? 2 : 3, SMALL);
      right = x + 3 + this.textWidth(label);
    }
    if (this.aim?.f >= F_MIN && this.aim.f <= F_MAX) this.rect(fx(this.aim.f) * this.W, yTop - 14, 1, hPx + 14, 2);   // the selection, even outside the cone
    // say what this is, on a solid plate so it never tangles with the allocation names
    const note = this.narrow ? 'FACING · RECONSTRUCTED' : 'SPECTRUM OF WHAT YOU FACE · RECONSTRUCTED FROM KNOWN EMITTERS';
    c.font = SMALL;
    this.rect(this.W - this.textWidth(note) - 16, yTop - 15, this.textWidth(note) + 16, 13, -1);
    this.text(note, this.W - 8, yTop - 5, 3, SMALL, 'right');
  }

  // ---- centre: a ring instrument. Every arc is a live reading, none is ornament. ----
  arcPath(r, a0, a1, width = 1, role = 0) {              // angles run clockwise from the top
    const c = this.ctx;
    c.beginPath();
    c.arc(this.W / 2, this.H / 2, r, a0 - Math.PI / 2, a1 - Math.PI / 2);
    c.lineWidth = width; c.strokeStyle = css(role); c.stroke();
  }
  radial(angle, r0, r1, role = 0, width = 1) {
    const cx = this.W / 2, cy = this.H / 2, sx = Math.sin(angle), sy = -Math.cos(angle), c = this.ctx;
    c.beginPath(); c.moveTo(cx + sx * r0, cy + sy * r0); c.lineTo(cx + sx * r1, cy + sy * r1);
    c.lineWidth = width; c.strokeStyle = css(role); c.stroke();
  }
  polar(angle, r) { return [this.W / 2 + Math.sin(angle) * r, this.H / 2 - Math.cos(angle) * r]; }
  dot(x, y, r, role, hollow = false) {
    const c = this.ctx;
    c.beginPath(); c.arc(x, y, r, 0, TAU);
    if (hollow) { c.lineWidth = 1; c.strokeStyle = css(role); c.stroke(); } else { c.fillStyle = css(role); c.fill(); }
  }
  elbow(points, role = 3) {
    const c = this.ctx;
    c.beginPath(); c.moveTo(...points[0]);
    for (const p of points.slice(1)) c.lineTo(...p);
    c.lineWidth = 1; c.strokeStyle = css(role); c.stroke();
  }

  reticle(pose, targets) {
    const c = this.ctx, cx = this.W / 2, cy = this.H / 2, a = this.aim, R1 = this.ringR, full = !this.narrow;
    const R2 = R1 * 1.36, R3 = R1 * 1.6, R4 = R1 * 1.76, R5 = R1 * 1.92, planet = this.mode.planet;

    // keep a short memory of whatever is being aimed at (targets are rebuilt under us, so key by name)
    const key = a ? `${a.fam}|${a.name}` : '';
    if (key !== this.aimKey) { this.aimKey = key; this.aimHist = []; }
    const strength = a ? (a.sat ? clamp(a.sat.look.elevation / (Math.PI / 2), 0, 1) : a.p ?? 0) : 0;
    const second = a ? (a.busy ?? (a.sat ? clamp(1 - a.sat.look.rangeSat / 42000, 0, 1) : a.p ?? 0)) : 0;
    this.arc[0] += (strength - this.arc[0]) * 0.18; this.arc[1] += (second - this.arc[1]) * 0.18;
    if (a && this.frame % 30 === 0) { this.aimHist.push(strength); if (this.aimHist.length > 60) this.aimHist.shift(); }

    // centre: a small open x
    for (const k of [45, 135, 225, 315]) this.radial(k * DEG, 5, 11, 0);
    // inner ring: signal strength of the aimed thing; second arc: its type-specific quantity
    this.arcPath(R1, 0, TAU, 1, 3);
    if (this.arc[0] > 0.004) this.arcPath(R1, 0, this.arc[0] * TAU, 3, 0);
    if (this.arc[1] > 0.004) { this.arcPath(R1 - 7, 0, this.arc[1] * TAU * 0.75, 1, 0); this.dot(...this.polar(this.arc[1] * TAU * 0.75, R1 - 7), 2.5, 0, true); }
    for (let k = 0; k < 8; k++) this.radial(k * 45 * DEG, R1 + 4, R1 + (k % 2 ? 9 : 14), 3);

    // heading ring: the gap is north (orbital view: the gap faces the camera's meridian)
    const north = -pose.heading;
    this.arcPath(R2, north + 14 * DEG, north + 346 * DEG, 2, 0);
    this.dot(...this.polar(north, R2), 3, 0, true);
    c.textBaseline = 'middle';
    this.text(planet ? '0' : 'N', ...this.polar(north, R2 + 11), 0, SMALL, 'center');
    c.textBaseline = 'alphabetic';

    if (full) {
      // bearing ticks ride with the heading ring, shown on the left half
      for (let b = 0; b < 360; b += 5) {
        const an = ((north + b * DEG) % TAU + TAU) % TAU;
        if (an > Math.PI * 1.02 && an < Math.PI * 1.98) this.radial(an, R2 + 5, R2 + (b % 30 ? 9 : 14), b % 30 ? 3 : 0);
      }
      // pitch arc (orbital view: latitude of the camera)
      this.arcPath(R4, 0, Math.max(0.01, Math.abs(pose.pitch)) * 2, 1, 0);
      this.dot(...this.polar(Math.abs(pose.pitch) * 2, R4), 2, 0, pose.pitch < 0);
      // frequency scale, lower right; outside it the last 30 s of the aimed signal
      const A0 = 100 * DEG, A1 = 172 * DEG, fa = f => A0 + (A1 - A0) * fx(f);
      for (let dec = 0; dec <= 4; dec++) for (const m of [1, 2, 5]) {
        const f = m * 10 ** dec;
        if (f <= F_MAX) this.radial(fa(f), R2 + 5, R2 + (m === 1 ? 12 : 8), a?.f ? 3 : 1);
      }
      if (a?.f) {
        const an = fa(clamp(a.f, F_MIN, F_MAX)), tip = this.polar(an, R2 + 20), end = this.polar(an, R5 + 26);
        this.radial(an, R2 + 3, R2 + 20, 0, 2);
        this.elbow([[a.sx, a.sy], tip, end, [end[0] + 46, end[1]]]);
        this.text(a.f >= 1000 ? `${(a.f / 1000).toFixed(3)} GHz` : a.f < 3 ? `${Math.round(a.f * 1000)} kHz` : `${(+a.f).toFixed(1)} MHz`, end[0] + 4, end[1] - 4, 0, SMALL);
      }
      this.aimHist.forEach((v, i) => this.radial(A0 + (A1 - A0) * (i / 60), R3 + 3, R3 + 4 + v * 10, i === this.aimHist.length - 1 ? 0 : 3));
    }

    if (!planet) {
      // what surrounds you, by bearing relative to where you face: 72 bins of summed power
      const bins = new Float32Array(72), quad = [[], [], [], []];
      let ground = null, sky = null;
      for (const t of targets) {
        if (!t.p || t.noAim) continue;
        const rel = ((Math.atan2(t.pos.x, -t.pos.z) - pose.heading) % TAU + TAU) % TAU;
        bins[Math.floor(rel / TAU * 72) % 72] += t.p;
        quad[Math.floor(((rel + Math.PI / 4) % TAU) / (Math.PI / 2))].push([t.p, rel]);
        if (t.cone && t.fam === 'ground' && (!ground || t.p > ground.p)) ground = t;
        if (t.cone && t.fam === 'sky' && (!sky || t.pos.y > sky.pos.y)) sky = t;
      }
      const top = Math.max(1, ...bins);
      bins.forEach((v, i) => { const q = v / top; this.dot(...this.polar((i + 0.5) / 72 * TAU, R5), 0.7 + 2.2 * q, q > 0.5 ? 0 : q > 0.12 ? 3 : 1); });
      if (full) quad.forEach((list, k) => {
        const mid = k * Math.PI / 2, fill = clamp(list.length / 120, 0, 1);
        this.arcPath(R3, mid - 38 * DEG, mid + 38 * DEG, 2, 1);
        this.arcPath(R3, mid - 38 * DEG, mid - 38 * DEG + fill * 76 * DEG, 2, 3);
        if (!list.length) return;
        const best = list.reduce((m, e) => e[0] > m[0] ? e : m), p = this.polar(best[1], R3 + 6), q = this.polar(best[1], R3 + 12);
        const n = [Math.cos(best[1]) * 3.5, Math.sin(best[1]) * 3.5];                // loudest source in this quadrant
        c.beginPath(); c.moveTo(...p); c.lineTo(q[0] + n[0], q[1] + n[1]); c.lineTo(q[0] - n[0], q[1] - n[1]); c.closePath();
        c.fillStyle = css(0); c.fill();
      });
      // loudest ground source in view, and the highest thing in the sky in view
      if (full && ground) { const [x, y] = this.polar(232 * DEG, R5 + 16); this.text(`△ ${ground.name}`, x, y, 0, SMALL, 'right'); this.text(ground.sub ?? '', x, y + 11, 3, SMALL, 'right'); }
      if (full && sky) { const [x, y] = this.polar(52 * DEG, R5 + 16); this.text(`▽ ${sky.name}`, x, y, 0, SMALL); this.text(sky.sub ?? '', x, y + 11, 3, SMALL); }
    }

    for (const t of this.cands || []) if (t !== a && Math.hypot(t.sx - cx, t.sy - cy) < R1) this.dot(t.sx, t.sy, 1.5, 3);
    if (!a) return;

    // inside the ring: what kind of thing it is (left) and its three live numbers (right)
    const gx = cx - R1 * 0.62;
    if (a.glyph === 'barcode') { for (let i = 0; i < 9; i++) if (bitAt(a.bytes || [170], i)) this.rect(gx - 9 + i * 2, cy - 5, 2, 10, 0); }
    else if (a.glyph === 'cross') { this.rect(gx - 6, cy - 1, 13, 2, 0); this.rect(gx - 1, cy - 6, 2, 13, 0); }
    else if (a.glyph === 'ring') this.dot(gx, cy, 6, 0, true);
    else if (a.glyph === 'hollow') { c.lineWidth = 2; c.strokeStyle = css(0); c.strokeRect(gx - 5, cy - 5, 10, 10); }
    else this.dot(gx, cy, 3, 0);
    (a.keys || []).forEach(([k, v], i) => {
      this.text(String(v), cx + R1 - 8, cy - 12 + i * 13, 0, SMALL, 'right');
      if (full) this.text(k, cx + R1 - 8 - this.textWidth(String(v)) - 6, cy - 12 + i * 13, 3, SMALL, 'right');
    });

    // family marker, top left of the ring: white near you, blue sky, red ground
    const [tx, ty] = this.polar(318 * DEG, R5 + 14);
    c.beginPath(); c.moveTo(tx - 7, ty - 6); c.lineTo(tx + 7, ty - 6); c.lineTo(tx, ty + 6); c.closePath();
    c.lineWidth = 2; c.strokeStyle = css(FAMILY[a.fam] ?? 0); c.stroke();

    // how these numbers were obtained: filled white measured, filled grey database, hollow estimated
    const truth = a.truth || [0, 0, 0], [dx, dy] = this.polar(212 * DEG, R5 + (full ? 44 : 14));
    this.elbow([this.polar(212 * DEG, R3), [dx + 40, dy - 10], [dx - 30, dy - 10]]);
    const names = [];
    [['measured', 0, false], ['database', 3, false], ['estimated', 0, true]].forEach(([name, role, hollow], i) => {
      this.dot(dx - 24 + i * 12, dy, 3.2, truth[i] ? role : 1, hollow || !truth[i]);
      if (truth[i]) names.push(name);
    });
    if (full) this.text(names.join(' + '), dx + 40, dy + 14, 3, SMALL, 'right');

  }

  // ---- the selection, in any view: red corner frame on the thing itself, a leader that starts
  //      at that frame, and the full record on an opaque plate ----
  selection() {
    const a = this.aim, c = this.ctx;
    if (!a) return;
    const x = Math.round(a.sx), y = Math.round(a.sy), r = 11;
    for (const [sx, sy] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) {
      this.rect(x + sx * r - (sx > 0 ? 5 : 0), y + sy * r - (sy > 0 ? 1 : 0), 6, 2, 2);
      this.rect(x + sx * r - (sx > 0 ? 1 : 0), y + sy * r - (sy > 0 ? 5 : 0), 2, 6, 2);
    }
    if (!this.panel) return;
    const rows = a.info || [], [px, py] = this.panel, right = px > x;
    // leader: from the frame's edge, one clean diagonal, then a level run into the panel's corner
    const ex = right ? px : this.panel[2], ky = py + 6, kx = ex + (right ? -18 : 18);
    const ang = Math.atan2(ky - y, kx - x), sx0 = x + Math.cos(ang) * (r + 4), sy0 = y + Math.sin(ang) * (r + 4);
    c.beginPath(); c.moveTo(sx0, sy0); c.lineTo(kx, ky); c.lineTo(ex, ky);
    c.lineWidth = 1; c.strokeStyle = css(2); c.stroke();
    this.rect(px, py - 4, this.panel[2] - px, this.panel[3] - py + 4, -1);
    this.rect(right ? px : this.panel[2] - 1, py, 1, rows.length * 12 + 46, 2);
    this.text(a.name, px + 7, py + 9, 2, SANS);
    if (a.sub) this.text(a.sub, px + 7, py + 21, 0, SANS);
    rows.forEach(([k, v], i) => { this.text(k, px + 7, py + 36 + i * 12, 3, SMALL); this.text(String(v).slice(0, 38), px + 84, py + 36 + i * 12, 0, SMALL); });
    if (a.bytes?.length) {                            // its raw bytes as a scrolling barcode
      const by = py + 34 + rows.length * 12, shift = Math.floor(performance.now() / 45);
      for (let i = 0; i < 118; i++) if (bitAt(a.bytes, i + shift)) this.rect(px + 7 + i * 2, by, 2, 10, 0);
    }
  }

  // opaque black behind every instrument, so the field never bleeds through a scale or a number
  plates() {
    const W = this.W, H = this.H;
    this.rect(0, 0, W, 40, -1);                                          // compass tape
    this.rect(0, H - 112, W, 112, -1); this.rect(0, H - 112, W, 1, 3);   // spectrum strip / satellite table
    if (this.narrow) return;
    const rows = Math.min(18, Math.floor((H - 78 - 120) / 27));
    this.rect(0, 30, 186, 44 + rows * 27, -1);                           // title + data bars
    this.rect(W - 340, 40, 340, 172, -1);                                // position, view, raw bytes
    if (!this.mode.planet) this.rect(W - 62, 212, 62, H - 212 - 112, -1); // pitch ladder
  }

  panelBox(a) {
    const cx = this.W / 2, cy = this.H / 2, h = (a.info || []).length * 12 + 52, wide = 262, R = this.ringR * 1.92;
    let x, y;
    if (this.ringAlpha > 0) {
      x = this.narrow ? Math.max(8, cx - wide / 2) : Math.min(cx + R + 40, this.W - wide - 140);
      y = this.narrow ? cy + R + 24 : cy - R - 10;
    } else {                                           // follow the target: right of it, or left when there is no room
      x = a.sx + 70 + wide > this.W - 140 ? a.sx - 70 - wide : a.sx + 70;
      y = a.sy - 50;
    }
    x = Math.round(clamp(x, this.narrow ? 8 : 190, this.W - wide - 8));
    y = Math.round(clamp(y, 104, this.H - 116 - h));
    return [x, y, x + wide, y + h];
  }

  // ---- orbital view, bottom: the aimed satellite as a data table, then who can see you now ----
  table() {
    const a = this.aim?.sat ? this.aim : null, y0 = this.H - 96, c = this.ctx;
    this.rect(0, y0 - 6, this.W, 1, 1);
    const row = a ? orbitRow(a) : null, cols = ['NORAD ID', 'SAT NAME', 'GROUP', 'ALT', 'VELOCITY', 'LATITUDE', 'LONGITUDE', 'AZIMUTH', 'ELEVATION', 'RANGE', 'DOWNLINK'];
    const shown = this.narrow ? cols.slice(0, 4) : cols, cw = (this.W - 28) / shown.length;
    shown.forEach((k, i) => {
      const x = 14 + i * cw, hot = a && (k === 'SAT NAME' || k === 'ALT');
      this.rect(x, y0, cw - 3, 14, 1);
      this.text(k, x + 5, y0 + 10, 3, SMALL);
      this.rect(x, y0 + 16, cw - 3, 16, hot ? 2 : -1);
      c.strokeStyle = css(1); c.lineWidth = 1; c.strokeRect(x + 0.5, y0 + 16.5, cw - 4, 15);
      this.text(row ? String(row[k]) : '—', x + 5, y0 + 27, 0, SMALL);
    });
    this.text('ABOVE YOUR HORIZON NOW', 14, y0 + 48, 3, SMALL);
    visibleNow().slice(0, Math.floor((this.W - 28) / 118)).forEach((s, i) => {
      const x = 14 + i * 118, hot = a?.sat === s;
      this.rect(x, y0 + 54, 114, 16, hot ? 2 : -1);
      c.strokeStyle = css(s.big ? 0 : 1); c.strokeRect(x + 0.5, y0 + 54.5, 113, 15);
      this.text(s.name.slice(0, 12), x + 4, y0 + 65, 0, SMALL);
      this.text(`${(s.look.elevation / DEG).toFixed(0)}°`, x + 110, y0 + 65, hot ? 0 : 3, SMALL, 'right');
    });
  }

  // ---- the raw material: real bytes of the aimed thing, or the last feed as it arrived ----
  rawBlock(x, y, lines, width) {
    const a = this.aim, scroll = Math.floor(performance.now() / 700);
    let text;
    if (a?.raw) text = a.raw;
    else if (a?.bytes?.length) {
      const hex = Array.from(a.bytes, b => b.toString(16).padStart(2, '0')), bits = Array.from(a.bytes, b => b.toString(2).padStart(8, '0'));
      text = [];
      for (let i = 0; i < hex.length; i += 12) text.push(hex.slice(i, i + 12).join(' '), bits.slice(i, i + 4).join(' '));
    } else {
      const keys = ['net', 'wifi', 'aircraft', 'sw', 'ble', 'sondes'].filter(k => S[k]);
      if (!keys.length) return;
      const k = keys[Math.floor(performance.now() / 5000) % keys.length], json = JSON.stringify(S[k]);
      text = [`< /api/${k} >`];
      for (let i = 0; i < Math.min(json.length, width * 40); i += width) text.push(json.slice(i, i + width));
    }
    for (let i = 0; i < lines; i++) {
      const line = text[(i + (text.length > lines ? scroll : 0)) % text.length];
      if (line) this.text(line.slice(0, width), x, y + i * 11, i ? 3 : 0, SMALL, 'right');
    }
  }

  corners(pose, info) {
    const W = this.W, H = this.H, o = S.obs;
    for (const [x, y] of [[8, 8], [W - 9, 8], [8, H - 9], [W - 9, H - 9]]) { this.rect(x - 4, y, 9, 1, 0); this.rect(x, y - 4, 1, 9, 0); }
    this.text('I N F O S P H E R E', 20, 46, 0, SANS);
    this.text(new Date().toISOString().replace('T', ' ').replace('Z', ' UTC'), 20, 60, 3, SMALL);
    const fixed = o.status === 'live';
    this.text(`${o.lat.toFixed(5)}  ${o.lon.toFixed(5)}`, W - 20, 58, 0, SMALL, 'right');
    this.text(fixed ? `location: live ±${Math.round(o.acc)} m` : `location: ${o.status}${o.label ? ' · ' + o.label : ''}`, W - 20, 70, fixed ? 3 : 0, SMALL, 'right');
    this.text(`view: ${info.heading}`, W - 20, 82, 3, SMALL, 'right');
    this.text(`frame ${String(this.frame).padStart(7, '0')} · ${info.fps} fps · fov ${Math.round(pose.vfov / DEG)}°`, W - 20, 94, 3, SMALL, 'right');
    const dead = Object.entries(S.state).filter(([, v]) => v === 'offline').map(([k]) => k);
    if (dead.length) this.text(`offline: ${dead.join(' ')}`, W - 20, 106, 0, SMALL, 'right');
    if (!this.narrow) this.rawBlock(W - (this.mode.planet ? 20 : 150), 132, 7, 47);
  }
}
