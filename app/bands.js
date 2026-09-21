// bands.js — who owns which slice of the spectrum (US allocations, MHz).
// Used by the bottom-edge spectrum ruler, Hertzian Landscapes style.
export const ALLOCATIONS = [
  [0.53, 1.71, 'AM'], [3, 30, 'SHORTWAVE'], [54, 88, 'TV VHF'], [88, 108, 'FM'],
  [118, 137, 'AIRBAND'], [137, 138, 'WX SAT'], [144, 148, 'HAM 2M'], [156, 162.6, 'MARINE · NOAA WX'],
  [174, 216, 'TV VHF-HI'], [225, 400, 'MIL AIR'], [400, 406, 'RADIOSONDE'], [420, 450, 'HAM 70CM'],
  [470, 608, 'TV UHF'], [617, 698, '600'], [698, 806, '700'], [824, 894, '850'], [902, 928, 'ISM 900'],
  [1090, 1090, 'ADS-B'], [1176.45, 1176.45, 'GPS L5'], [1227.6, 1227.6, 'GPS L2'],
  [1575.42, 1575.42, 'GPS L1'], [1616, 1626.5, 'IRIDIUM'], [1710, 1780, 'AWS'], [1850, 1995, 'PCS'],
  [2110, 2200, 'AWS DL'], [2400, 2483.5, 'ISM 2.4 · WIFI · BLE'], [2496, 2690, 'N41'],
  [3550, 3700, 'CBRS'], [3700, 3980, 'C-BAND 5G'], [5150, 5895, 'WIFI 5 G'], [5925, 7125, 'WIFI 6E'],
  [9000, 10000, 'X RADAR'], [10700, 12700, 'KU · STARLINK'],
];

// downlink blocks a US cell site may be radiating (OSM antennas carry no frequency tag)
export const CELL_DOWNLINKS = [[617, 652], [729, 768], [869, 894], [1930, 1995], [2110, 2200],
                               [2496, 2690], [3450, 3980]];

export const F_MIN = 0.3, F_MAX = 13000;
export const fx = f => Math.log(f / F_MIN) / Math.log(F_MAX / F_MIN);   // MHz -> 0..1 on the log ruler

// carrier frequencies for things whose data feed does not state one (MHz, bandwidth)
export const SAT_FREQ = {
  gnss: [1575.42, 24], stations: [437.8, 0.03], weather: [1700, 4], amateur: [436.5, 0.03],
  'iridium-NEXT': [1621, 10], oneweb: [11500, 250], starlink: [11700, 2000], visual: [2250, 5],
};
export const ADSB = [1090, 2];
