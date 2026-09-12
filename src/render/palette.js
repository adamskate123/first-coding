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
  street: '#726f68',
  streetEdge: '#5c5952',
  // Darker, newer-looking tarmac, so an avenue reads as the bigger road even
  // before its markings are legible.
  avenue: '#5b5852',
  markings: '#c9c2a8',
  // A developer's lane: laid cheap, worn at the edges, no markings at all.
  lane: '#8a8375',
  laneEdge: '#756f63',
  // A divided carriageway's median: kerbed, and planted where there is room.
  median: '#9d9787',
  medianEdge: '#7d7868',
  planting: '#5f7f45',
  kerb: '#8e8a7e',
  // Where the tarmac heads as a road jams up.
  congested: '#9c4a38',
};

/**
 * What a roof is made of.
 *
 * The roof is the surface an isometric camera sees most of -- measured on a
 * dense city, changing every wall in the frame moved only 3% of its pixels
 * because the roofs, which are most of what is on screen, were untouched. So
 * roofs get their own material rather than inheriting a shade of the wall: a
 * street of tiled pitches and tarred flats reads as a street, where a street
 * of walls in slightly different browns reads as one building repeated.
 */
export const ROOF_MATERIALS = [
  { key: 'tile', tint: '#96553c', mix: 0.5 },
  { key: 'slate', tint: '#464d57', mix: 0.52 },
  { key: 'lead', tint: '#6d7175', mix: 0.42 },
  { key: 'tar', tint: '#39382f', mix: 0.55 },
  { key: 'copper', tint: '#4c7d6a', mix: 0.38 },
  { key: 'garden', tint: '#5f7f45', mix: 0.5 },
  { key: 'gravel', tint: '#8a8375', mix: 0.4 },
];

/**
 * A window with the light on.
 *
 * Not a lightened version of the glass: under the blue wash of night a
 * brighter grey stays grey, and the whole point of nightfall in a city builder
 * is to see which windows are lit. A warm lamp colour reads through it.
 */
export const WINDOW_LIT = '#ffd79a';

/** Tint a palette's roof colour towards a material. */
export function roofColor(base, material) {
  const m = ROOF_MATERIALS[material % ROOF_MATERIALS.length];
  return mix(base, m.tint, m.mix);
}

/**
 * Paintwork for the traffic.
 *
 * Muted and a little dusty, so a street full of cars reads as texture rather
 * than as confetti; a few brighter ones keep it from looking like a car park.
 * Each tone is shaded once at load, because a busy city repaints several
 * hundred of these thirty times a second and re-parsing a colour string per car
 * per frame is not free.
 */
const CAR_PAINT = [
  '#cfd1cc', '#b9bcb8', '#7c8189', '#4a5568', '#2e3947',
  '#7d3a33', '#a8503c', '#3f5f47', '#8b7a3e', '#5b5f63',
  '#9aa0a3', '#33414d', '#6d5a52', '#c2b49a',
];
const TRUCK_PAINT = ['#d8d8d2', '#8f958f', '#41586e', '#7a4a3c'];
const BUS_PAINT = ['#d9a53a', '#c26a35', '#48677f'];

/** kind -> tones, each pre-shaded into a roof colour and a side colour. */
export const VEHICLE_TONES = [CAR_PAINT, TRUCK_PAINT, BUS_PAINT].map((family) =>
  family.map((c) => ({ roof: c, side: shade(c, 0.68), glass: shade(c, 0.45) })));

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
/**
 * Zoned but unbuilt land.
 *
 * Faint on purpose. At the old strength this was a flat colour over every
 * zoned tile, and since most of a growing city is zoned and unbuilt, it was
 * the single largest element in the frame -- a dashed quilt of green, blue and
 * yellow diamonds over the landscape. A zoned plot is land that has been
 * cleared and marked, so it reads as cleared ground with its boundary drawn,
 * and the colour only has to say which use was marked.
 */
export const ZONE_TINT = {
  1: 'rgba(96, 186, 96, 0.16)',
  2: 'rgba(52, 150, 72, 0.18)',
  3: 'rgba(96, 150, 220, 0.16)',
  4: 'rgba(56, 106, 200, 0.18)',
  5: 'rgba(214, 178, 74, 0.17)',
  6: 'rgba(178, 120, 40, 0.19)',
};

/** The boundary of a zoned area, where the colour actually gets to speak. */
export const ZONE_EDGE = {
  1: 'rgba(120, 214, 118, 0.85)',
  2: 'rgba(70, 186, 96, 0.85)',
  3: 'rgba(126, 180, 245, 0.85)',
  4: 'rgba(84, 138, 232, 0.85)',
  5: 'rgba(236, 200, 96, 0.85)',
  6: 'rgba(206, 146, 58, 0.85)',
};

/** Cleared, graded ground: what a marked-out plot looks like before it builds. */
export const ZONE_GROUND = ['#8a7f66', '#857a62', '#8f846a'];

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

/** Blend two colours. `t` is how far to move from `a` towards `b`. */
export function mix(a, b, t) {
  const [r1, g1, b1] = parseColor(a);
  const [r2, g2, b2] = parseColor(b);
  const k = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(r1 + (r2 - r1) * k)},${Math.round(g1 + (g2 - g1) * k)},${Math.round(b1 + (b2 - b1) * k)})`;
}

/**
 * Tint a colour way towards an architectural period.
 *
 * The period is mixed *into* the wealth palette rather than replacing it, so
 * the two compose: a poor Edwardian terrace and a rich one share a period but
 * not a budget. Glazing carries most of the era signal -- small dark panes
 * early, bright curtain walling late -- so windows get their own, stronger mix.
 */
export function applyEra(way, era) {
  return {
    wall: mix(way.wall, era.accent, era.mix),
    roof: mix(way.roof, era.accent, era.mix * 0.8),
    win: mix(way.win, era.winAccent, era.winMix),
  };
}

function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }

/** Shift a colour towards white (t > 1) or black (t < 1). Composable. */
export function shade(color, t) {
  let [r, g, b] = parseColor(color);
  if (t >= 1) {
    const k = Math.min(1, t - 1);
    r += (255 - r) * k; g += (255 - g) * k; b += (255 - b) * k;
  } else {
    r *= Math.max(0, t); g *= Math.max(0, t); b *= Math.max(0, t);
  }
  // A channel out of range makes the whole string invalid, and a canvas
  // rejects an invalid fillStyle in silence -- the shape simply comes out in
  // whatever colour was set last, which is a maddening thing to track down.
  return `rgb(${clamp255(r)},${clamp255(g)},${clamp255(b)})`;
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
