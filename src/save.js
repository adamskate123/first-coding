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
import { SERVICE_KEYS, VERSION } from './config.js';

const SAVE_KEY = 'metropolis.save.v1';

/**
 * The last version whose release notes this player has seen.
 *
 * Kept apart from the save on purpose: it belongs to the player, not to the
 * city. Importing someone else's city should not make you re-read notes you
 * have already read, and starting a new city should not reset them.
 */
const SEEN_KEY = 'metropolis.seenVersion';
const FORMAT = 2;

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

export function serialize(world, camera = null) {
  return {
    format: FORMAT,
    // Informational: `format` alone decides compatibility, but knowing which
    // build wrote a city makes an odd-looking save far easier to explain.
    version: VERSION,
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
    builtAge: encode(world.builtAge),
    buildings: [...world.activeBuildings()].map((b) => ({ t: b.type, x: b.x, y: b.y, on: b.on })),
    log: world.log.slice(-20),
    history: world.history.slice(-240),
    // Where you were looking. Restoring it means resuming puts you back over
    // your city rather than over the middle of the map.
    camera: camera ? { x: camera.x, y: camera.y, zoom: camera.zoom } : null,
  };
}

export function deserialize(data) {
  // Format 1 predates build years being recorded. Its cities load fine; their
  // buildings simply all read as having gone up in the founding year.
  if (!data || !(data.format === FORMAT || data.format === 1)) {
    throw new Error('Unrecognised save format');
  }

  const world = new World(data.size, data.seed);
  world.elevation.set(decode(data.elevation, Uint8Array));
  world.terrain.set(decode(data.terrain, Uint8Array));
  world.tree.set(decode(data.tree, Uint8Array));
  world.zone.set(decode(data.zone, Uint8Array));
  world.road.set(decode(data.road, Uint8Array));
  world.powerLine.set(decode(data.powerLine, Uint8Array));
  world.level.set(decode(data.level, Uint8Array));
  if (data.builtAge) world.builtAge.set(decode(data.builtAge, Uint8Array));

  world.funds = data.funds;
  world.tick = data.tick;
  world.month = data.month;
  world.year = data.year;
  world.tax = { ...data.tax };
  world.demand = { ...data.demand };
  world.savedWith = data.version || null;
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
  world._corners = null;
  for (const k of SERVICE_KEYS) world.coverage[k].fill(0);
  return world;
}

export function saveToStorage(world, camera = null) {
  localStorage.setItem(SAVE_KEY, JSON.stringify(serialize(world, camera)));
}

/**
 * Read the stored city back.
 *
 * Returns the world and the camera separately, since the caller owns the
 * camera. Throws if the stored data is unreadable -- the caller decides
 * whether that means starting fresh.
 */
export function loadFromStorage() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) return null;
  const data = JSON.parse(raw);
  return { world: deserialize(data), camera: data.camera || null };
}

export function hasSave() {
  return localStorage.getItem(SAVE_KEY) !== null;
}

export function clearStorage() {
  localStorage.removeItem(SAVE_KEY);
}

/**
 * Which version's release notes this player has read, or null.
 *
 * Guarded, like everything else that touches storage: it throws outright in a
 * private window and can be switched off entirely, and a game that refused to
 * start because it could not read a release-note marker would be an absurd
 * trade.
 */
export function seenVersion() {
  try {
    return localStorage.getItem(SEEN_KEY);
  } catch {
    return null;
  }
}

export function markVersionSeen(version) {
  try {
    localStorage.setItem(SEEN_KEY, version);
    return true;
  } catch {
    return false;
  }
}
