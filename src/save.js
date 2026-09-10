/**
 * Saving and loading.
 *
 * Only *authored* state is written out -- terrain, what the player zoned and
 * built, and how far each lot has developed. Every derived field (land value,
 * pollution, coverage, traffic, power) is recomputed by the simulation within a
 * few ticks of loading, which keeps a save around 40x smaller than dumping
 * every array and means old saves survive changes to the balance tables.
 */

import { World } from './world.js';
import { SERVICE_KEYS } from './config.js';

const SAVE_KEY = 'metropolis.save.v1';
const FORMAT = 1;

/** Uint8Array -> base64, in chunks so large maps don't blow the call stack. */
function encode(arr) {
  const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
  let out = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}

function decode(b64, Type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Type(bytes.buffer, 0, bin.length / Type.BYTES_PER_ELEMENT);
}

export function serialize(world) {
  return {
    format: FORMAT,
    size: world.size,
    seed: world.seed,
    funds: world.funds,
    tick: world.tick,
    month: world.month,
    year: world.year,
    tax: { ...world.tax },
    demand: { ...world.demand },
    elevation: encode(world.elevation),
    terrain: encode(world.terrain),
    tree: encode(world.tree),
    zone: encode(world.zone),
    road: encode(world.road),
    powerLine: encode(world.powerLine),
    level: encode(world.level),
    buildings: [...world.activeBuildings()].map((b) => ({ t: b.type, x: b.x, y: b.y, on: b.on })),
    log: world.log.slice(-20),
    history: world.history.slice(-240),
  };
}

export function deserialize(data) {
  if (!data || data.format !== FORMAT) throw new Error('Unrecognised save format');

  const world = new World(data.size, data.seed);
  world.elevation.set(decode(data.elevation, Uint8Array));
  world.terrain.set(decode(data.terrain, Uint8Array));
  world.tree.set(decode(data.tree, Uint8Array));
  world.zone.set(decode(data.zone, Uint8Array));
  world.road.set(decode(data.road, Uint8Array));
  world.powerLine.set(decode(data.powerLine, Uint8Array));
  world.level.set(decode(data.level, Uint8Array));

  world.funds = data.funds;
  world.tick = data.tick;
  world.month = data.month;
  world.year = data.year;
  world.tax = { ...data.tax };
  world.demand = { ...data.demand };
  world.log = data.log || [];
  world.history = data.history || [];

  world.buildings = [];
  world.build.fill(-1);
  for (const b of data.buildings || []) {
    if (world.placeBuilding(b.t, b.x, b.y)) {
      world.buildings[world.buildings.length - 1].on = b.on !== false;
    }
  }

  // Occupancy follows from the saved development level; the growth pass will
  // confirm it on the next tick.
  world._waterDist = null;
  for (const k of SERVICE_KEYS) world.coverage[k].fill(0);
  return world;
}

export function saveToStorage(world) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(serialize(world)));
}

export function loadFromStorage() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  return deserialize(JSON.parse(raw));
}

export function hasSave() {
  return localStorage.getItem(SAVE_KEY) !== null;
}
