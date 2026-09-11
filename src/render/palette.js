/**
 * Colour.
 *
 * SimCity 3000's look came from restraint: warm, slightly dusty hues, low
 * saturation, and a narrow value range so the whole city reads as one
 * illustration rather than a pile of bright toys. Every colour here is picked
 * to sit in that register, and building families share a palette so districts
 * develop a recognisable character as they grow.
 */

export const SKY = '#20303a';
export const VOID = '#16222a';

/** Terrain base colours, varied per tile by a small deterministic jitter. */
export const TERRAIN = {
  water: ['#3f6b86', '#44718c', '#3a6480'],
  sand: ['#c3ae7f', '#bda877', '#c8b489'],
  grass: ['#6d8a48', '#748f4e', '#657f42', '#7a9455', '#6a8746'],
  rock: ['#8a8276', '#807869', '#928a7d'],
};

/** Face shading multipliers: light falls from the upper left. */
export const FACE = { top: 1.0, left: 0.82, right: 0.62 };

export const ROAD_COLORS = {
  street: '#6e6b64',
  streetEdge: '#5c5952',
  avenue: '#66635c',
  markings: '#c9c2a8',
};

/**
 * Building colour families, chosen per lot from its variant number.
 *
 * Each family stays within one narrow range of value and saturation, so a
 * street reads as a single neighbourhood even though no two lots match. The
 * variation that carries is in hue and roof colour, not brightness -- a
 * too-light or too-dark building pops out of the illustration immediately.
 */
export const BUILDING_PALETTES = {
  R_LOW: [
    { wall: '#c9b184', roof: '#8c5a44', win: '#4a5b63' },
    { wall: '#b9c0a4', roof: '#7a6a52', win: '#4a5b63' },
    { wall: '#d3c1a0', roof: '#6f4f3f', win: '#53646c' },
    { wall: '#a8b8b0', roof: '#7d5c48', win: '#46565e' },
    { wall: '#cbb8a2', roof: '#5f5245', win: '#4d5e66' },
    { wall: '#c2a98f', roof: '#8a6348', win: '#4f6069' },
    { wall: '#bcc4b2', roof: '#6b5a46', win: '#48585f' },
    { wall: '#d6c7ab', roof: '#7c4f3c', win: '#51626a' },
    { wall: '#b4a893', roof: '#8f6a4e', win: '#4a5c64' },
    { wall: '#c8bca6', roof: '#67503f', win: '#4e5f67' },
  ],
  R_HIGH: [
    { wall: '#b3a692', roof: '#6b6055', win: '#5d7b8a' },
    { wall: '#a89b93', roof: '#645a52', win: '#63808f' },
    { wall: '#9d9c96', roof: '#5d5a54', win: '#6a8797' },
    { wall: '#bfae9b', roof: '#6f6153', win: '#5a7886' },
    { wall: '#ab9f8e', roof: '#665c50', win: '#607e8c' },
    { wall: '#b6ada1', roof: '#6a625a', win: '#65838f' },
    { wall: '#a2968c', roof: '#5f564e', win: '#5e7c8b' },
    { wall: '#c0b4a2', roof: '#71675a', win: '#62808e' },
  ],
  C_LOW: [
    { wall: '#c6b9a3', roof: '#7d7365', win: '#7fa3b5' },
    { wall: '#bcae9c', roof: '#6e6558', win: '#89adbe' },
    { wall: '#cfc4ad', roof: '#7a705f', win: '#7ba0b3' },
    { wall: '#c3b49f', roof: '#84705c', win: '#84a8b9' },
    { wall: '#cabda6', roof: '#726a5c', win: '#7da2b4' },
    { wall: '#b8ac99', roof: '#7f7566', win: '#86aabb' },
    { wall: '#d2c6b0', roof: '#6a6154', win: '#80a5b6' },
  ],
  C_HIGH: [
    { wall: '#8fa3ad', roof: '#5d6b73', win: '#a8c6d4' },
    { wall: '#9aa8ae', roof: '#616d74', win: '#b3cedb' },
    { wall: '#a5aeb0', roof: '#666e70', win: '#9fc0cf' },
    { wall: '#87969f', roof: '#586369', win: '#aac8d6' },
    { wall: '#93a5ac', roof: '#5f6a70', win: '#adc9d7' },
    { wall: '#9eaab0', roof: '#636d72', win: '#a4c3d1' },
    { wall: '#8b9ba5', roof: '#5a666c', win: '#b0ccd9' },
    { wall: '#a0adb3', roof: '#657075', win: '#a1c1d0' },
  ],
  I_LIGHT: [
    { wall: '#b0a68c', roof: '#7c7462', win: '#5f6b62' },
    { wall: '#a89a7c', roof: '#736a58', win: '#5a665e' },
    { wall: '#bbae93', roof: '#82796a', win: '#626e66' },
    { wall: '#b4a689', roof: '#797060', win: '#5d6a61' },
    { wall: '#aca084', roof: '#7f7566', win: '#606c63' },
    { wall: '#b7ab90', roof: '#766d5c', win: '#5b6760' },
  ],
  I_HEAVY: [
    { wall: '#9c8a72', roof: '#6d5f4e', win: '#55605a' },
    { wall: '#8f8776', roof: '#645d50', win: '#4f5a55' },
    { wall: '#a3907a', roof: '#71624f', win: '#59645e' },
    { wall: '#978b76', roof: '#695c4c', win: '#525d58' },
    { wall: '#9f8f78', roof: '#6f6050', win: '#57625c' },
    { wall: '#938a74', roof: '#665a4b', win: '#505b56' },
  ],
};

export const TREE_COLORS = [
  { canopy: '#3f6b34', shade: '#2f5228', trunk: '#4a3a2a' },
  { canopy: '#456f38', shade: '#33562b', trunk: '#4a3a2a' },
  { canopy: '#3a6330', shade: '#2b4b24', trunk: '#463726' },
];

/** Zone tints for undeveloped land, in the SC3K dotted-overlay style. */
export const ZONE_TINT = {
  1: 'rgba(96, 186, 96, 0.42)',
  2: 'rgba(52, 150, 72, 0.46)',
  3: 'rgba(96, 150, 220, 0.42)',
  4: 'rgba(56, 106, 200, 0.46)',
  5: 'rgba(214, 178, 74, 0.44)',
  6: 'rgba(178, 120, 40, 0.48)',
};

/**
 * Parse either of the two colour forms used here into RGB components.
 *
 * `shade` returns `rgb(...)`, and its output is regularly fed back into it --
 * a detail shaded from an already-shaded surface, for instance. Accepting both
 * forms is what makes shading composable. When it only understood hex, the
 * second pass produced `rgb(NaN,NaN,NaN)`, which canvas rejects *silently*:
 * the assignment is ignored and the previous fillStyle stays in force, so the
 * shape came out painted in whatever colour happened to be current.
 */
function parseColor(color) {
  if (typeof color === 'string' && color[0] === '#') {
    const n = parseInt(color.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (m) {
    const parts = m[1].split(',').map((v) => parseFloat(v));
    if (parts.length >= 3 && parts.every((v) => Number.isFinite(v))) {
      return [parts[0], parts[1], parts[2]];
    }
  }
  return [128, 128, 128];   // visibly wrong, but never invalid
}

/** Shift a colour towards white (t > 1) or black (t < 1). Composable. */
export function shade(color, t) {
  let [r, g, b] = parseColor(color);
  if (t >= 1) {
    const k = Math.min(1, t - 1);
    r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k;
  } else {
    r *= t; g *= t; b *= t;
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/** Blue -> green -> yellow -> red ramp for the data overlays. */
export function heatColor(v) {
  const t = Math.max(0, Math.min(1, v));
  const stops = [
    [40, 70, 140], [50, 140, 120], [180, 190, 70], [200, 120, 50], [180, 50, 45],
  ];
  const p = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(p));
  const f = p - i;
  const a = stops[i], b = stops[i + 1];
  return `rgb(${(a[0] + (b[0] - a[0]) * f) | 0},${(a[1] + (b[1] - a[1]) * f) | 0},${(a[2] + (b[2] - a[2]) * f) | 0})`;
}
