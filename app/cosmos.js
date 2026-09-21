// cosmos.js — natural transmitters. J2000 positions; pulsar periods are the real ones,
// so a pulsar block blinks at the rate the neutron star actually spins.
const h = (hh, mm, ss) => hh + mm / 60 + ss / 3600;
const d = (dd, mm, ss) => Math.sign(dd || 1) * (Math.abs(dd) + mm / 60 + ss / 3600);

export const RADIO_SOURCES = [
  { name: 'SGR A*', note: 'galactic centre · 4 million solar mass black hole', ra: h(17, 45, 40), dec: d(-29, 0, 28) },
  { name: 'CAS A',  note: 'supernova remnant · brightest radio source beyond the sun', ra: h(23, 23, 24), dec: d(58, 48, 54) },
  { name: 'CYG A',  note: 'radio galaxy · 760 million light years', ra: h(19, 59, 28), dec: d(40, 44, 2) },
  { name: 'TAU A',  note: 'crab nebula · supernova of 1054', ra: h(5, 34, 32), dec: d(22, 0, 52) },
  { name: 'VIR A',  note: 'M87 · relativistic jet', ra: h(12, 30, 49), dec: d(12, 23, 28) },
];

export const PULSARS = [
  { name: 'PSR B0329+54', period: 0.714520, ra: h(3, 32, 59),  dec: d(54, 34, 44) },
  { name: 'PSR B1919+21', period: 1.337302, ra: h(19, 21, 45), dec: d(21, 53, 2), note: 'CP 1919 · the first pulsar, 1967' },
  { name: 'PSR B0531+21', period: 0.033800, ra: h(5, 34, 32),  dec: d(22, 0, 52), note: 'crab pulsar · 30 Hz' },
  { name: 'PSR B0950+08', period: 0.253065, ra: h(9, 53, 9),   dec: d(7, 55, 36) },
  { name: 'PSR B1133+16', period: 1.187913, ra: h(11, 36, 3),  dec: d(15, 51, 4) },
  { name: 'PSR B0833-45', period: 0.089328, ra: h(8, 35, 21),  dec: d(-45, 10, 35), note: 'vela pulsar' },
  { name: 'PSR B1937+21', period: 0.001558, ra: h(19, 39, 39), dec: d(21, 34, 59), note: '642 Hz · faster than the display can show' },
];
