/**
 * World state.
 *
 * Tile data is held in parallel typed arrays (a struct-of-arrays layout) rather
 * than an array of objects. The simulation sweeps whole fields at a time --
 * diffusing pollution, flood-filling power -- and contiguous typed arrays keep
 * those sweeps cache-friendly and cheap to serialise.
 */

import { MAP_SIZE, SEA_LEVEL, T, Z, ZONE_INFO, ROAD, BUILDINGS, SERVICE_KEYS, START_FUNDS, START_YEAR, TAX_DEFAULT } from './config.js';
import { fbm, clamp, lerp, hash2 } from './util.js';

/**
 * Terrain shape constants, tuned by sweeping them against three targets:
 * roughly a quarter of the map under water, a single contiguous landmass, and
 * dry ground at the centre where the camera starts. See tests/terrain.test.js,
 * which asserts those properties hold across many seeds.
 */
const SHORE_OFFSET = 1.25;      // radial distance at which land reaches sea level
const SHORE_WIDTH = 0.50;       // how gradually the coast tapers
const RIVER_HALF_WIDTH = 0.032; // river width, as a fraction of the map
const RIVER_REACH = 1.25;       // how far down the map the river runs

export class World {
  constructor(size = MAP_SIZE, seed = 1) {
    this.size = size;
    this.seed = seed;
    const n = size * size;

    // --- terrain ---------------------------------------------------------
    this.elevation = new Uint8Array(n);
    this.terrain = new Uint8Array(n);
    this.tree = new Uint8Array(n);

    // --- player-placed ---------------------------------------------------
    this.zone = new Uint8Array(n);
    this.road = new Uint8Array(n);
    this.powerLine = new Uint8Array(n);
    this.build = new Int32Array(n).fill(-1);   // index into this.buildings, or -1

    // --- simulated -------------------------------------------------------
    this.level = new Uint8Array(n);            // development stage of a zoned tile
    this.pop = new Uint16Array(n);             // residents on this tile
    this.jobs = new Uint16Array(n);            // jobs on this tile
    this.landValue = new Uint8Array(n);
    this.pollution = new Uint8Array(n);
    this.crime = new Uint8Array(n);
    this.traffic = new Uint16Array(n);
    this.powered = new Uint8Array(n);
    this.roadAccess = new Uint8Array(n);
    this.netId = new Int32Array(n).fill(-1);   // power network membership
    this.growthTimer = new Int8Array(n);       // hysteresis for grow/decay
    this.coverage = {};
    for (const k of SERVICE_KEYS) this.coverage[k] = new Uint8Array(n);

    // --- placed building instances ---------------------------------------
    this.buildings = [];   // { id, type, x, y, span, powered, on }

    // --- city-wide state --------------------------------------------------
    this.funds = START_FUNDS;
    this.tick = 0;
    this.month = 0;
    this.year = START_YEAR;
    this.tax = { R: TAX_DEFAULT, C: TAX_DEFAULT, I: TAX_DEFAULT };
    this.demand = { R: 0.55, C: 0.2, I: 0.35 };
    this.stats = {
      population: 0, jobs: 0, employed: 0, unemployment: 0,
      income: 0, expenses: 0, lastBalance: 0,
      powerSupply: 0, powerDemand: 0, brownout: false,
      avgLandValue: 0, avgPollution: 0, approval: 50, congestion: 0,
    };
    this.history = [];      // monthly snapshots for the graphs
    this.log = [];          // advisor messages

    this.generateTerrain(seed);
  }

  idx(x, y) { return y * this.size + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.size && y < this.size; }

  /** True when a tile can be built on: land, and not already occupied. */
  isBuildable(x, y) {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    return this.terrain[i] !== T.WATER && this.build[i] === -1;
  }

  isWater(x, y) {
    if (!this.inBounds(x, y)) return false;
    return this.terrain[this.idx(x, y)] === T.WATER;
  }

  /** A road over water is a bridge. No separate state is needed. */
  isBridge(x, y) {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    return this.road[i] !== ROAD.NONE && this.terrain[i] === T.WATER;
  }

  /**
   * Can a road or line laid here rest on something?
   *
   * Dry land supports anything. Water supports a crossing only where one is
   * already built, which is what lets a span be extended without letting a
   * player drop an isolated pier in the middle of a lake.
   */
  supportsCrossing(x, y) {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    return this.terrain[i] !== T.WATER || this.road[i] !== ROAD.NONE || this.powerLine[i] === 1;
  }

  /** Building instance occupying a tile, or null. */
  buildingAt(x, y) {
    if (!this.inBounds(x, y)) return null;
    const b = this.build[this.idx(x, y)];
    return b === -1 ? null : this.buildings[b];
  }

  /**
   * Height-map generation.
   *
   * Three ingredients: an fBm height field for the shape of the land, a radial
   * shore falloff that multiplies the map down to sea level near the edges, and
   * a carved river. The falloff is multiplicative rather than additive -- that
   * is what lets low-lying noise in the interior dip below sea level too, so
   * the map gets lakes and inlets instead of one clean disc of land.
   */
  generateTerrain(seed) {
    const s = this.size;

    for (let y = 0; y < s; y++) {
      for (let x = 0; x < s; x++) {
        const i = this.idx(x, y);
        const nx = x / s, ny = y / s;

        const continental = fbm(x / 34, y / 34, seed, 5, 0.55);
        const detail = fbm(x / 12, y / 12, seed + 7777, 4, 0.5);
        let h = continental * 0.68 + detail * 0.32;

        // Shore falloff: full height through the middle, tapering to nothing
        // at the rim so the map ends in coastline rather than a cliff.
        const cx = (nx - 0.5) * 2, cy = (ny - 0.5) * 2;
        const r = Math.sqrt(cx * cx + cy * cy);
        h *= clamp((SHORE_OFFSET - r) / SHORE_WIDTH, 0, 1);

        // A river wandering in from the north and running the length of the
        // map. It used to fade out partway down, because a channel that cut
        // the map in two would have stranded half of it -- now that bridges
        // exist, a real river is the point: it forces the player to choose
        // where the crossings go, and the traffic model funnels the commute
        // over them.
        const wobble = (fbm(y / 22, 3.5, seed + 4242, 3, 0.5) - 0.5) * 0.62;
        const bank = Math.abs(nx - (0.5 + wobble));
        const reach = clamp((RIVER_REACH - ny) / 0.22, 0, 1);
        if (bank < RIVER_HALF_WIDTH && reach > 0) {
          const depth = (1 - bank / RIVER_HALF_WIDTH) * reach;
          h = lerp(h, h * 0.10, depth);
        }

        const elev = clamp(Math.round(h * 30), 0, 30);
        this.elevation[i] = elev;

        if (elev <= SEA_LEVEL) this.terrain[i] = T.WATER;
        else if (elev <= SEA_LEVEL + 1) this.terrain[i] = T.SAND;
        else if (elev >= 23) this.terrain[i] = T.ROCK;
        else this.terrain[i] = T.GRASS;

        // Trees cluster on gentle green ground; they raise land value and are
        // cleared automatically when something is built on the tile.
        if (this.terrain[i] === T.GRASS) {
          const forest = fbm(x / 9, y / 9, seed + 313, 3, 0.5);
          this.tree[i] = forest > 0.60 && (hash2(x, y, seed) % 100) < 62 ? 1 : 0;
        }
      }
    }
    this.flattenWaterEdges();
  }

  /** Water should read as flat; step-shaped shorelines look wrong in iso. */
  flattenWaterEdges() {
    for (let i = 0; i < this.terrain.length; i++) {
      if (this.terrain[i] === T.WATER) this.elevation[i] = SEA_LEVEL;
    }
  }

  // ----------------------------------------------------------- mutations --

  /** Clear whatever a tile holds. Returns true if anything was removed. */
  clearTile(x, y) {
    if (!this.inBounds(x, y)) return false;
    const i = this.idx(x, y);
    let changed = false;

    const bIdx = this.build[i];
    if (bIdx !== -1) {
      const b = this.buildings[bIdx];
      for (let dy = 0; dy < b.span; dy++) {
        for (let dx = 0; dx < b.span; dx++) {
          const j = this.idx(b.x + dx, b.y + dy);
          this.build[j] = -1;
        }
      }
      b.removed = true;
      changed = true;
    }
    if (this.zone[i] !== Z.NONE) { this.zone[i] = Z.NONE; changed = true; }
    if (this.road[i] !== ROAD.NONE) { this.road[i] = ROAD.NONE; changed = true; }
    if (this.powerLine[i]) { this.powerLine[i] = 0; changed = true; }
    if (this.tree[i]) { this.tree[i] = 0; changed = true; }
    if (this.level[i]) changed = true;

    this.level[i] = 0;
    this.pop[i] = 0;
    this.jobs[i] = 0;
    this.growthTimer[i] = 0;
    return changed;
  }

  /** Place a catalogue building with its top-left corner at (x, y). */
  placeBuilding(type, x, y) {
    const spec = BUILDINGS[type];
    if (!spec) return false;
    const span = spec.span;
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        if (!this.isBuildable(x + dx, y + dy)) return false;
      }
    }
    const inst = { id: this.buildings.length, type, x, y, span, powered: false, on: true };
    this.buildings.push(inst);
    for (let dy = 0; dy < span; dy++) {
      for (let dx = 0; dx < span; dx++) {
        const j = this.idx(x + dx, y + dy);
        this.build[j] = inst.id;
        this.zone[j] = Z.NONE;
        this.road[j] = ROAD.NONE;
        this.level[j] = 0;
        this.pop[j] = 0;
        this.jobs[j] = 0;
        this.tree[j] = 0;
      }
    }
    return true;
  }

  /** Live building instances, skipping bulldozed ones. */
  *activeBuildings() {
    for (const b of this.buildings) if (!b.removed) yield b;
  }

  zoneInfo(i) { return ZONE_INFO[this.zone[i]] || null; }
}
