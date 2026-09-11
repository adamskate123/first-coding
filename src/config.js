/**
 * Central tuning constants.
 *
 * Every balance knob the simulation reads lives here, so the city can be
 * re-tuned without touching simulation logic. Values are deliberately plain
 * numbers rather than derived expressions so they can be tweaked in isolation.
 */

// ---------------------------------------------------------------- geometry --

export const MAP_SIZE = 96;          // tiles per side
export const TILE_W = 64;            // screen width of one tile's rhombus
export const TILE_H = 32;            // screen height of one tile's rhombus
export const ELEV_STEP = 7;          // pixels of lift per elevation unit
export const SEA_LEVEL = 7;          // elevation at or below this is water

// -------------------------------------------------------------------- time --

export const TICKS_PER_MONTH = 60;
export const SPEED_LABELS = ['Paused', 'Slow', 'Normal', 'Fast'];
export const SPEED_TICK_MS = [Infinity, 420, 150, 45];
export const START_YEAR = 1950;
export const START_FUNDS = 60000;

// ----------------------------------------------------------------- terrain --

export const T = { WATER: 0, SAND: 1, GRASS: 2, ROCK: 3 };

// ------------------------------------------------------------------- zones --

export const Z = {
  NONE: 0,
  R_LOW: 1, R_HIGH: 2,
  C_LOW: 3, C_HIGH: 4,
  I_LIGHT: 5, I_HEAVY: 6,
};

/**
 * Per-zone capacity and requirements.
 *
 *  cap    - residents (R) or jobs (C/I) held at each development level
 *  lvNeed - land value (0-255) required before a tile will grow to that level
 *  power  - power units drawn at each level
 */
export const ZONE_INFO = {
  [Z.R_LOW]: {
    key: 'R_LOW', name: 'Residential', sub: 'Low Density', cat: 'R', tint: '#4f9d4f',
    cost: 12, cap: [0, 6, 14, 26], lvNeed: [0, 0, 55, 100], power: [0, 4, 9, 16],
  },
  [Z.R_HIGH]: {
    key: 'R_HIGH', name: 'Residential', sub: 'High Density', cat: 'R', tint: '#2f7d3f',
    cost: 34, cap: [0, 24, 60, 130, 240], lvNeed: [0, 70, 105, 140, 180], power: [0, 16, 38, 80, 145],
  },
  [Z.C_LOW]: {
    key: 'C_LOW', name: 'Commercial', sub: 'Low Density', cat: 'C', tint: '#4f7fc4',
    cost: 14, cap: [0, 5, 12, 22], lvNeed: [0, 0, 60, 105], power: [0, 6, 13, 24],
  },
  [Z.C_HIGH]: {
    key: 'C_HIGH', name: 'Commercial', sub: 'High Density', cat: 'C', tint: '#2f5aa8',
    cost: 38, cap: [0, 20, 52, 105, 190], lvNeed: [0, 80, 115, 150, 190], power: [0, 22, 52, 105, 185],
  },
  [Z.I_LIGHT]: {
    key: 'I_LIGHT', name: 'Industrial', sub: 'Light', cat: 'I', tint: '#c9a13b',
    cost: 16, cap: [0, 9, 20, 34], lvNeed: [0, 0, 30, 55], power: [0, 12, 26, 46],
  },
  [Z.I_HEAVY]: {
    key: 'I_HEAVY', name: 'Industrial', sub: 'Heavy', cat: 'I', tint: '#a06a1f',
    cost: 30, cap: [0, 28, 65, 120], lvNeed: [0, 0, 25, 45], power: [0, 40, 90, 165],
  },
};

/** Pollution emitted per level, by zone. Industry dominates; homes barely register. */
export const ZONE_POLLUTION = {
  [Z.R_LOW]: [0, 1, 1, 2], [Z.R_HIGH]: [0, 2, 3, 4, 6],
  [Z.C_LOW]: [0, 1, 2, 3], [Z.C_HIGH]: [0, 3, 5, 7, 9],
  [Z.I_LIGHT]: [0, 10, 18, 26], [Z.I_HEAVY]: [0, 30, 52, 78],
};

// ------------------------------------------------------------------- roads --

export const ROAD = { NONE: 0, STREET: 1, AVENUE: 2 };
export const ROAD_INFO = {
  [ROAD.STREET]: { name: 'Street', cost: 18, upkeep: 0.7, capacity: 220 },
  [ROAD.AVENUE]: { name: 'Avenue', cost: 55, upkeep: 2.1, capacity: 700 },
};

export const POWERLINE_COST = 8;
export const POWERLINE_UPKEEP = 0.4;
export const BULLDOZE_COST = 4;

/**
 * Bridges and crossings.
 *
 * A bridge needs no state of its own: a road tile that happens to sit on water
 * *is* a bridge, and a power line on water is a crossing. What changes is the
 * price, the upkeep, and how it draws -- the deck is lifted clear of the water
 * and stood on piers.
 *
 * Crossings are expensive on purpose. A river should be a decision, not a
 * formality, and the traffic model already funnels a whole district's commute
 * over whatever links the banks.
 */
export const BRIDGE_COST_MULTIPLIER = 8;
export const BRIDGE_UPKEEP_MULTIPLIER = 4;
export const POWERLINE_CROSSING_MULTIPLIER = 6;
/** Elevation units the deck sits above the water surface. */
export const BRIDGE_LIFT = 3;

/** How far a tile may sit from a road and still be developable. */
export const ROAD_REACH = 3;

// -------------------------------------------------------- service catalogue --

/**
 * Placeable buildings. `span` is the square footprint in tiles, `service` names
 * the coverage field the building feeds, and `radius` is in tiles.
 *
 * `height` is the wall height in pixels and must be set in proportion to the
 * footprint: a span-N building is N*TILE_W pixels wide on screen, so a fixed
 * height makes big buildings read as pancakes. Roughly 14-18px per tile of span
 * looks right. Deliberately flat things -- solar arrays, parks, plazas -- carry
 * a small height on purpose.
 */
export const BUILDINGS = {
  coal:   { name: 'Coal Power Plant',  span: 3, height: 46, cost: 8000,  upkeep: 320, supply: 6000,  pollution: 46, color: '#7d7468', category: 'power' },
  gas:    { name: 'Gas Power Plant',   span: 3, height: 42, cost: 13000, upkeep: 470, supply: 9500,  pollution: 20, color: '#8d8577', category: 'power' },
  solar:  { name: 'Solar Farm',        span: 4, height: 9,  cost: 24000, upkeep: 210, supply: 5200,  pollution: 0,  color: '#4a5a72', category: 'power' },
  police: { name: 'Police Station',    span: 2, height: 30, cost: 900,   upkeep: 110, service: 'police',    radius: 18, color: '#3f5b86', category: 'service' },
  fire:   { name: 'Fire Station',      span: 2, height: 28, cost: 1000,  upkeep: 130, service: 'fire',      radius: 16, color: '#9c3b32', category: 'service' },
  clinic: { name: 'Health Clinic',     span: 2, height: 32, cost: 1400,  upkeep: 175, service: 'health',    radius: 16, color: '#c9c3b6', category: 'service' },
  school: { name: 'Grade School',      span: 3, height: 40, cost: 2600,  upkeep: 260, service: 'education', radius: 20, color: '#a8875e', category: 'service' },
  park:   { name: 'Small Park',        span: 1, height: 0,  cost: 160,   upkeep: 12,  service: 'park',      radius: 8,  color: '#3f7d3a', category: 'park' },
  plaza:  { name: 'Plaza',             span: 2, height: 0,  cost: 700,   upkeep: 38,  service: 'park',      radius: 13, color: '#a89a80', category: 'park' },
};

/** Power drawn by each service building while it operates. */
export const BUILDING_POWER = { police: 40, fire: 40, clinic: 60, school: 70, park: 0, plaza: 5 };

// ----------------------------------------------------------------- economy --

export const TAX_DEFAULT = 9;        // percent
export const TAX_MIN = 0;
export const TAX_MAX = 20;
/** Annual revenue per resident / per job at a 10% rate, scaled by land value. */
export const TAX_PER_RESIDENT = 1.15;
export const TAX_PER_JOB = 1.65;

// ---------------------------------------------------------------- services --

export const SERVICE_KEYS = ['police', 'fire', 'health', 'education', 'park'];

/** How strongly each coverage field lifts land value. */
export const SERVICE_WEIGHT = { police: 0.20, fire: 0.14, health: 0.18, education: 0.24, park: 0.24 };
