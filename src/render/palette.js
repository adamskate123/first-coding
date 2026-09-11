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
 * Building colour families, keyed by use and wealth tier.
 *
 * Wealth carries the colour, not density. A cheap tower block and a cheap house
 * are built of the same materials -- what differs between them is form, which
 * the recipe handles separately. Splitting it this way means nine families
 * cover the whole city instead of one per zone type, and it is what makes a
 * rising neighbourhood visibly change character rather than merely get taller.
 *
 * Each family stays within one narrow range of value and saturation so a
 * street reads as a single place; the variation that carries is in hue and
 * roof colour.
 */
const PALETTE_FAMILIES = {
  // --- residential -------------------------------------------------------
  'R0': [   // weathered boards and faded paint
    { wall: '#a89e8c', roof: '#6b5a4c', win: '#4c5a60' },
    { wall: '#9e9c8e', roof: '#63564a', win: '#495760' },
    { wall: '#b0a48f', roof: '#725f4e', win: '#4e5c63' },
    { wall: '#a09684', roof: '#5e5245', win: '#47555c' },
    { wall: '#aaa392', roof: '#6d6151', win: '#4b595f' },
  ],
  'R1': [   // tidy warm suburbia
    { wall: '#c9b184', roof: '#8c5a44', win: '#4a5b63' },
    { wall: '#b9c0a4', roof: '#7a6a52', win: '#4a5b63' },
    { wall: '#d3c1a0', roof: '#6f4f3f', win: '#53646c' },
    { wall: '#a8b8b0', roof: '#7d5c48', win: '#46565e' },
    { wall: '#cbb8a2', roof: '#5f5245', win: '#4d5e66' },
    { wall: '#c2a98f', roof: '#8a6348', win: '#4f6069' },
  ],
  'R2': [   // brick, cut stone, slate
    { wall: '#b8705c', roof: '#4e5a63', win: '#5e7480' },
    { wall: '#d8cdb4', roof: '#55606a', win: '#617783' },
    { wall: '#a86550', roof: '#47525b', win: '#5a7078' },
    { wall: '#cfc3a8', roof: '#5b5048', win: '#647a86' },
    { wall: '#c4a98c', roof: '#4c5560', win: '#5f757f' },
  ],

  // --- commercial --------------------------------------------------------
  'C0': [   // tired parades and lock-ups
    { wall: '#b0a695', roof: '#6f6759', win: '#7a9099' },
    { wall: '#a69c8b', roof: '#685f53', win: '#748a94' },
    { wall: '#b8ab96', roof: '#756b5c', win: '#7d939c' },
    { wall: '#aaa08d', roof: '#6a6254', win: '#778d97' },
  ],
  'C1': [   // ordinary high street
    { wall: '#c6b9a3', roof: '#7d7365', win: '#7fa3b5' },
    { wall: '#bcae9c', roof: '#6e6558', win: '#89adbe' },
    { wall: '#cfc4ad', roof: '#7a705f', win: '#7ba0b3' },
    { wall: '#c3b49f', roof: '#84705c', win: '#84a8b9' },
    { wall: '#cabda6', roof: '#726a5c', win: '#7da2b4' },
  ],
  'C2': [   // glass and steel
    { wall: '#8fa3ad', roof: '#5d6b73', win: '#a8c6d4' },
    { wall: '#9aa8ae', roof: '#616d74', win: '#b3cedb' },
    { wall: '#a5aeb0', roof: '#666e70', win: '#9fc0cf' },
    { wall: '#87969f', roof: '#586369', win: '#aac8d6' },
    { wall: '#93a5ac', roof: '#5f6a70', win: '#adc9d7' },
  ],

  // --- industrial --------------------------------------------------------
  'I0': [   // rust and grime
    { wall: '#8f7a63', roof: '#5d4e40', win: '#4d564f' },
    { wall: '#877e6c', roof: '#564e42', win: '#495249' },
    { wall: '#96805f', roof: '#63523f', win: '#505a52' },
    { wall: '#8a7c68', roof: '#5a4f42', win: '#4b544d' },
  ],
  'I1': [   // plain working sheds
    { wall: '#b0a68c', roof: '#7c7462', win: '#5f6b62' },
    { wall: '#a89a7c', roof: '#736a58', win: '#5a665e' },
    { wall: '#bbae93', roof: '#82796a', win: '#626e66' },
    { wall: '#b4a689', roof: '#797060', win: '#5d6a61' },
  ],
  'I2': [   // clean light industry
    { wall: '#c2c0b4', roof: '#82806f', win: '#6b7a74' },
    { wall: '#b8bcae', roof: '#7a7a6a', win: '#68776f' },
    { wall: '#cac5b6', roof: '#888374', win: '#6e7d76' },
    { wall: '#bfbdb0', roof: '#7e7c6c', win: '#667570' },
  ],
};

/** Colour ways available to a given use ('R', 'C', 'I') and wealth tier. */
export function buildingPalette(category, wealth) {
  const tier = Math.max(0, Math.min(2, wealth | 0));
  return PALETTE_FAMILIES[`${category}${tier}`] ?? PALETTE_FAMILIES.R1;
}

export { PALETTE_FAMILIES };

/**
 * Ground surfaces. A developed lot is furnished rather than dropped on bare
 * grass -- mown lawn and a drive for a house, asphalt and bay markings for a
 * shop, a concrete apron for a works.
 */
export const LOT = {
  // Mown lawn reads lighter and yellower than the wild grass around it, so a
  // tended lot is distinguishable from the field it was built on.
  lawn: ['#8aa65c', '#8fac62', '#849f55'],
  lawnRich: ['#84a854', '#8aae5b', '#7ea14e'],
  drive: '#b5ae9e',
  asphalt: '#6f6c66',
  concrete: '#9b968a',
  stripe: '#bdb7a0',
  hedge: '#3d6b33',
  path: '#b3ab98',
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
