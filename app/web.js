// web.js — the luminous network. Only relations that really exist become edges:
//   wifi   same SSID (one network, many access points) · same channel (they interfere)
//          · same router (BSSIDs that differ in the last digit) · you hear every one of them
//   ble    same maker / message type · you hear every one of them
//   tcp    you -> a hub per /16 prefix (one cloud / CDN) -> each remote host, from the socket table
//   radio  stations sharing one physical tower
// Every edge is a faint additive 1 px line, so a crowded channel, a big ESS or a busy CDN
// becomes bright by overlap — nothing is drawn brighter by hand except your own link.
import * as THREE from 'three';
import { BlockCloud, LineSet, MODE, SHAPE, C } from './gfx.js';
import { FLOOR, R, DEG, dirOf, hashAngle, hash01, textBytes } from './space.js';
import { layer, nodes } from './field.js';
import { S, on } from './store.js';

const ME = [0, 0, 0];
const web = layer('web', 'web'), net = layer('net', 'tcp');
const faint = new LineSet(C.WHITE, 0.06), mid = new LineSet(C.WHITE, 0.16), mine = new LineSet(C.WHITE);
web.group.add(faint.obj, mid.obj, mine.obj);
const tcpEdges = new LineSet(C.WHITE, 0.16), tcpCloud = new BlockCloud(2048);
net.group.add(tcpEdges.obj, tcpCloud.mesh);

function groupBy(list, key) {
  const out = new Map();
  for (const n of list) { const k = key(n); if (k != null && k !== '') (out.get(k) || out.set(k, []).get(k)).push(n); }
  return [...out.values()].filter(g => g.length > 1);
}
// star to the strongest member: n-1 edges say "these belong together" without n² clutter
const star = (set, group) => { const hub = group.reduce((a, b) => b.p > a.p ? b : a); for (const n of group) if (n !== hub) set.seg(hub.pos, n.pos); };

function rebuild() {
  faint.clear(); mid.clear(); mine.clear();
  const wifi = nodes.wifi, ble = nodes.ble;
  for (const n of wifi) (n.mine ? mine : faint).seg(ME, n.pos);                  // you receive their beacons
  for (const g of groupBy(wifi, n => n.ssid)) star(mid, g);
  for (const g of groupBy(wifi, n => n.router)) star(mid, g);
  for (const g of groupBy(wifi, n => `${n.band}:${n.channel}`))                  // co-channel: everyone hears everyone
    for (let i = 0; i < g.length; i++) for (let j = i + 1; j < Math.min(g.length, i + 5); j++) faint.seg(g[i].pos, g[j].pos);
  for (const n of ble) faint.seg(ME, n.pos);
  for (const g of groupBy(ble, n => n.group)) star(mid, g);
  for (const sites of Object.values(nodes.stations)) for (const site of Object.values(sites))
    for (let i = 1; i < site.length; i++) mid.seg(site[i - 1].pos, site[i].pos);  // one tower, many stations
  faint.commit(); mid.commit(); mine.commit();
}
for (const k of ['wifi', 'ble', 'fm', 'am', 'tv', 'obs']) on(k, rebuild);

on('net', data => {
  tcpEdges.clear(); tcpCloud.clear(); net.targets = [];
  const speed = bps => 0.08 + 0.5 * Math.min(1, Math.log10(1 + bps) / 8);
  const up = speed(data.tx_bps), down = speed(data.rx_bps), hubs = new Map();
  const gateway = data.neighbours.find(n => n.host === '1') || data.neighbours[0];
  const gw = [0, FLOOR + 1.5, -R(4)];
  if (gateway) { tcpEdges.seg(ME, gw); tcpCloud.add(gw[0], gw[1], gw[2], { w: -7, shape: SHAPE.HOLLOW, flick: 0, glow: 10 }); }
  const from = gateway ? gw : ME;
  for (const c of data.connections.slice(0, 90)) {
    let hub = hubs.get(c.remote);
    if (!hub) {
      const d = dirOf(hashAngle(c.remote), (8 + 42 * hash01(c.remote + 'e')) * DEG), r = 46 + 22 * hash01(c.remote + 'r');
      hub = { pos: [d[0] * r, d[1] * r, d[2] * r], n: 0 };
      hubs.set(c.remote, hub);
      tcpEdges.seg(from, hub.pos);
      tcpCloud.add(hub.pos[0], hub.pos[1], hub.pos[2], { w: -5, shape: SHAPE.HOLLOW, flick: 0 });
      // packets: white leaves you, grey comes back, both at the interface's real throughput
      const dir = hub.pos.map((v, i) => v - from[i]);
      tcpCloud.add(from[0], from[1], from[2], { w: -3, flick: 0, mode: MODE.TRAVEL, dir, rate: up, phase: hash01(c.remote) });
      tcpCloud.add(hub.pos[0], hub.pos[1], hub.pos[2], { w: -3, color: C.GRAY, flick: 0, mode: MODE.TRAVEL,
        dir: dir.map(v => -v), rate: down, phase: hash01(c.remote + 'd') });
    }
    const a = hashAngle(c.id), b = hashAngle(c.id + 'b'), k = 3 + 5 * hash01(c.id + 'k');
    const pos = [hub.pos[0] + Math.cos(a) * Math.sin(b) * k, hub.pos[1] + Math.cos(b) * k, hub.pos[2] + Math.sin(a) * Math.sin(b) * k];
    hub.n++;
    tcpEdges.seg(hub.pos, pos);
    tcpCloud.add(pos[0], pos[1], pos[2], { w: -3, flick: 0, glow: 5 });
    net.targets.push({ pos: new THREE.Vector3(...pos), name: `${c.remote}:${c.port}`, prio: 0.15, bytes: textBytes(c.id + c.remote + c.port),
      fam: 'near', truth: [1, 0, 1], glyph: 'dot', p: 0.3,
      keys: [['port', c.port], ['↑', `${(data.tx_bps / 1e3).toFixed(1)} kb/s`], ['↓', `${(data.rx_bps / 1e3).toFixed(1)} kb/s`]],
      info: [['remote', `${c.remote} · masked`], ['port', c.port], ['state', 'established'],
             ['link ↑', `${(data.tx_bps / 1e3).toFixed(1)} kbit/s · whole interface`],
             ['link ↓', `${(data.rx_bps / 1e3).toFixed(1)} kbit/s · whole interface`],
             ['position', 'hashed from address · networks have no bearing']] });
  }
  for (const n of data.neighbours) {
    if (n === gateway) continue;
    const az = hashAngle(n.id), r = R(6), pos = [r * Math.sin(az), FLOOR + 0.8, -r * Math.cos(az)];
    tcpEdges.seg(gw, pos);
    tcpCloud.add(pos[0], pos[1], pos[2], { w: -5, shape: SHAPE.HOLLOW, color: C.GRAY, flick: 0 });
    net.targets.push({ pos: new THREE.Vector3(...pos), name: `lan .${n.host}`, sub: n.oui, prio: 0.25, bytes: textBytes(n.id),
      fam: 'near', truth: [1, 0, 1], glyph: 'hollow', p: 0.3, keys: [['host', `.${n.host}`], ['oui', n.oui], ['private mac', n.random_mac ? 'yes' : 'no']],
      info: [['oui', `${n.oui} · rest masked`], ['host', `.${n.host}`], ['private mac', n.random_mac ? 'yes' : 'no']] });
  }
  tcpEdges.commit(); tcpCloud.commit();
});
