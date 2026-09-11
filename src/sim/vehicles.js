/**
 * The cars you actually see driving.
 *
 * The traffic model proper is aggregate: it routes commuter *volume* over the
 * road graph and never knows about a single vehicle (see traffic.js). That is
 * the right way to simulate a city of a hundred thousand people, but it gives
 * you nothing to look at -- a saturated road and an empty one differ only in
 * colour.
 *
 * So this layer drives a few hundred visible cars over the same road graph and
 * lets the aggregate field steer them: where they spawn is weighted by the
 * traffic each tile carries, and how fast they move falls away as that tile
 * approaches its capacity. Watch a junction for a few seconds and you can see
 * which way the city commutes, and a jam looks like a jam -- dense and crawling
 * -- rather than like a red stripe.
 *
 * Nothing here feeds back into the simulation. These cars are a read-out of it,
 * they cost nothing, carry nobody, and are never saved: a reloaded city
 * repopulates its roads from the traffic field within a second.
 *
 * Geometry is kept in tile-local coordinates -- (0,0) at the tile's origin
 * corner, (1,1) at the far one -- so this file never touches a canvas and the
 * renderer can lay a car's path onto whatever surface the tile actually has,
 * sloped ground or a bridge deck alike.
 */

import { ROAD_INFO, VEHICLE_FRAME_MS, VEHICLE_BUDGET_SHARE } from '../config.js';
import { clamp, makeRng } from '../util.js';

/** Neighbour offsets. An index into this also names the tile edge crossed. */
export const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const OPPOSITE = [2, 3, 0, 1];

/** Midpoint of each edge, in tile-local coordinates, ordered as DIRS. */
const EDGE = [[1, 0.5], [0.5, 1], [0, 0.5], [0.5, 0]];

/** How far a lane sits from the centreline, in tile widths. */
export const LANE = 0.17;

/** Ceiling on the fleet, so a gridlocked metropolis still renders in budget. */
export const MAX_VEHICLES = 400;

/** Cars visible on a road tile running at its rated capacity. */
const CARS_PER_SATURATED_TILE = 1.7;

/** Free-running speed, in tiles per second. */
const SPEED = { 1: 1.35, 2: 1.9 };

/** What is left of that speed on a road at capacity. */
const MIN_PACE = 0.22;

/** A car at a junction prefers to carry straight on rather than turn. */
const STRAIGHT_WEIGHT = 3;

/** Trips end after this many tiles, so the fleet keeps reshuffling. */
const TRIP_MIN = 40, TRIP_SPREAD = 60;

export const KIND = { CAR: 0, TRUCK: 1, BUS: 2 };

/** Body sizes in tile widths, plus how tall the box stands in screen pixels. */
export const KIND_SIZE = {
  [KIND.CAR]: { length: 0.26, width: 0.135, height: 4.5 },
  [KIND.TRUCK]: { length: 0.36, width: 0.15, height: 6.5 },
  [KIND.BUS]: { length: 0.44, width: 0.155, height: 7 },
};

const right = (d) => [-d[1], d[0]];

/** An edge midpoint shifted into the right-hand lane for a car heading `d`. */
function laneAt(edge, d) {
  const r = right(d);
  return [edge[0] + LANE * r[0], edge[1] + LANE * r[1]];
}

/**
 * Where a car is inside its tile, and which way it points.
 *
 * The path runs entry edge -> centre -> exit edge as a quadratic bezier, so a
 * car turning a corner sweeps through it instead of pivoting on the spot. Both
 * ends sit a lane's width to the right of centre, which is what makes traffic
 * on a two-way street read as two opposing streams -- and, because neighbouring
 * tiles share an edge and derive the same offset from it, a car crosses from
 * one tile to the next without a seam.
 */
export function vehicleLocal(v, t = v.t) {
  const u = clamp(t, 0, 1);
  const inDir = DIRS[OPPOSITE[v.from]];        // heading as it enters
  const outDir = DIRS[v.to];                   // heading as it leaves
  const p0 = laneAt(EDGE[v.from], inDir);
  const p2 = laneAt(EDGE[v.to], outDir);
  // The control point keeps the same offset through the bend, averaged over
  // the two headings so a straight run stays exactly straight.
  const ri = right(inDir), ro = right(outDir);
  const p1 = [0.5 + LANE * (ri[0] + ro[0]) / 2, 0.5 + LANE * (ri[1] + ro[1]) / 2];

  const m = 1 - u;
  return {
    x: m * m * p0[0] + 2 * m * u * p1[0] + u * u * p2[0],
    y: m * m * p0[1] + 2 * m * u * p1[1] + u * u * p2[1],
    dx: 2 * m * (p1[0] - p0[0]) + 2 * u * (p2[0] - p1[0]),
    dy: 2 * m * (p1[1] - p0[1]) + 2 * u * (p2[1] - p1[1]),
  };
}

/**
 * How long to wait between animation steps, given what a repaint currently
 * costs. Held to a share of the clock, so the traffic can never crowd out the
 * rest of the frame on a city that is expensive to draw.
 */
export function vehicleInterval(renderCost) {
  return Math.max(VEHICLE_FRAME_MS, (renderCost || 0) / VEHICLE_BUDGET_SHARE);
}

export class VehicleField {
  constructor(world, seed = 0x5eed1e) {
    this.rng = makeRng(seed);
    this.list = [];
    this.rate = 1;              // multiplier from the game speed control
    this.reset(world);
  }

  /** Point at a world, dropping every car that was driving on the old one. */
  reset(world) {
    this.world = world;
    this.list.length = 0;
    this.tiles = [];            // road tiles carrying traffic
    this.cumulative = [];       // running sum of their weights, for sampling
    this.target = 0;
    this.stamp = -1;
  }

  get count() { return this.list.length; }

  /**
   * Re-read the traffic field: which tiles are worth putting cars on, and how
   * many the city should have. Once per simulation tick is plenty -- the field
   * itself only changes that often.
   */
  survey() {
    const w = this.world;
    const n = w.size * w.size;
    this.tiles.length = 0;
    this.cumulative.length = 0;

    let running = 0, saturation = 0;
    for (let i = 0; i < n; i++) {
      const road = w.road[i];
      if (!road || w.traffic[i] <= 0) continue;
      const load = Math.min(1, w.traffic[i] / ROAD_INFO[road].capacity);
      saturation += load;
      // A road with barely any traffic still deserves the occasional car.
      running += Math.max(0.04, load);
      this.tiles.push(i);
      this.cumulative.push(running);
    }

    this.weightTotal = running;
    this.target = this.tiles.length
      ? clamp(Math.round(saturation * CARS_PER_SATURATED_TILE), 1, MAX_VEHICLES)
      : 0;
    this.stamp = w.tick;
  }

  /**
   * Advance every car by `dtMs` of wall-clock time. Returns whether anything is
   * on the road, which is what tells the renderer a repaint is worth doing.
   */
  update(dtMs) {
    const w = this.world;
    if (!w) return false;
    if (w.tick !== this.stamp) this.survey();

    // A long stall -- a background tab, a slow first frame -- must not teleport
    // the fleet across the map.
    const dt = clamp(dtMs, 0, 250) / 1000 * this.rate;

    const list = this.list;
    for (let k = list.length - 1; k >= 0; k--) {
      if (!this.advance(list[k], dt)) {
        list[k] = list[list.length - 1];
        list.pop();
      }
    }

    // Fill towards the target a few at a time, so a newly laid road fills up
    // over a second or two instead of a jam appearing out of nowhere.
    const room = Math.min(this.target - list.length, 8);
    for (let s = 0; s < room; s++) this.spawn();

    return list.length > 0;
  }

  /** One car's step. False means it has left the simulation for good. */
  advance(v, dt) {
    const w = this.world;
    const road = w.road[v.i];
    if (!road) return false;             // the road was bulldozed under it

    const load = w.traffic[v.i] / ROAD_INFO[road].capacity;
    const pace = SPEED[road] * v.pace * (1 - (1 - MIN_PACE) * clamp(load, 0, 1));
    v.t += dt * pace;

    while (v.t >= 1) {
      v.t -= 1;
      if (--v.trip <= 0) return false;                       // journey's end
      // Shed cars gradually when the city needs fewer, rather than vanishing a
      // block of them the moment traffic eases.
      if (this.list.length > this.target && this.rng() < 0.5) return false;
      if (!this.hop(v)) return false;
    }
    return true;
  }

  /** Move a car onto the next tile and choose its way across it. */
  hop(v) {
    const w = this.world;
    const d = DIRS[v.to];
    const x = (v.i % w.size) + d[0];
    const y = ((v.i / w.size) | 0) + d[1];
    if (!w.inBounds(x, y)) return false;
    const ni = w.idx(x, y);
    if (!w.road[ni]) return false;
    v.i = ni;
    v.from = OPPOSITE[v.to];
    v.to = this.chooseExit(ni, v.from);
    return true;
  }

  /**
   * Which way out of a tile, given the edge the car came in by.
   *
   * Weighted towards carrying straight on: the aggregate model already decides
   * where traffic goes, so all this has to do is look like plausible driving
   * rather than a random walk. A dead end turns the car around.
   */
  chooseExit(i, from) {
    const w = this.world;
    const x = i % w.size, y = (i / w.size) | 0;
    const straight = OPPOSITE[from];
    const weight = [0, 0, 0, 0];
    let total = 0;

    for (let k = 0; k < 4; k++) {
      if (k === from) continue;
      const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
      if (!w.inBounds(nx, ny) || !w.road[w.idx(nx, ny)]) continue;
      weight[k] = k === straight ? STRAIGHT_WEIGHT : 1;
      total += weight[k];
    }
    if (total === 0) return from;                 // nowhere on: turn around

    let r = this.rng() * total;
    for (let k = 0; k < 4; k++) {
      if (weight[k] === 0) continue;
      r -= weight[k];
      if (r <= 0) return k;
    }
    return straight;
  }

  /** A road tile to spawn on, drawn in proportion to the traffic it carries. */
  pickTile() {
    const r = this.rng() * this.weightTotal;
    let lo = 0, hi = this.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return this.tiles[lo];
  }

  /** The edge a car appears from: any that actually joins another road. */
  pickEntry(i) {
    const w = this.world;
    const x = i % w.size, y = (i / w.size) | 0;
    const open = [];
    for (let k = 0; k < 4; k++) {
      const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
      if (w.inBounds(nx, ny) && w.road[w.idx(nx, ny)]) open.push(k);
    }
    if (!open.length) return 0;
    return open[Math.floor(this.rng() * open.length) % open.length];
  }

  spawn() {
    if (!this.tiles.length || this.list.length >= MAX_VEHICLES) return null;
    const i = this.pickTile();
    const from = this.pickEntry(i);
    const roll = this.rng();
    const v = {
      i,
      from,
      to: this.chooseExit(i, from),
      t: this.rng(),
      pace: 0.85 + this.rng() * 0.35,            // no two cars in lockstep
      trip: TRIP_MIN + Math.floor(this.rng() * TRIP_SPREAD),
      kind: roll < 0.08 ? KIND.TRUCK : roll < 0.12 ? KIND.BUS : KIND.CAR,
      tone: (this.rng() * 4096) | 0,
    };
    this.list.push(v);
    return v;
  }
}
