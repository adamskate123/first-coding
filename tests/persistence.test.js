/**
 * Browser-storage persistence.
 *
 * The game keeps one autosaved city and resumes it on load, so these cover the
 * storage round trip and — more importantly — what happens when the stored data
 * is unusable. Startup reads it automatically now, so an unreadable save has to
 * be survivable rather than a blank screen.
 *
 * Node has no localStorage, so a minimal stand-in is installed. That is the
 * point: it tests this code against the storage contract, not against a browser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world.js';
import { Camera } from '../src/iso.js';
import { Z, ROAD, T, START_YEAR } from '../src/config.js';
import { saveToStorage, loadFromStorage, hasSave, clearStorage, serialize, deserialize } from '../src/save.js';

/** The smallest thing that behaves like Web Storage. */
function installStorage({ failOnWrite = false } = {}) {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => {
      if (failOnWrite) {
        const err = new Error('The quota has been exceeded.');
        err.name = 'QuotaExceededError';
        throw err;
      }
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
    get length() { return store.size; },
  };
  return store;
}

function cityWithSomethingInIt() {
  const w = new World(24, 17);
  w.terrain.fill(T.GRASS);
  w.elevation.fill(12);
  w._corners = null;
  w._waterDist = null;
  for (let x = 2; x < 20; x++) w.road[w.idx(x, 10)] = ROAD.STREET;
  w.zone[w.idx(5, 11)] = Z.R_LOW;
  w.level[w.idx(5, 11)] = 2;
  w.builtAge[w.idx(5, 11)] = 1931 - START_YEAR;
  w.funds = 44321;
  w.year = 1958;
  w.month = 7;
  return w;
}

// ------------------------------------------------------------ round trip --

test('a city written to storage comes back intact', () => {
  installStorage();
  const w = cityWithSomethingInIt();

  saveToStorage(w);
  const restored = loadFromStorage();

  assert.ok(restored, 'nothing came back');
  assert.equal(restored.world.funds, 44321);
  assert.equal(restored.world.year, 1958);
  assert.equal(restored.world.month, 7);
  assert.equal(restored.world.road[restored.world.idx(5, 10)], ROAD.STREET);
  assert.equal(restored.world.zone[restored.world.idx(5, 11)], Z.R_LOW);
  assert.equal(restored.world.builtYear(restored.world.idx(5, 11)), 1931);
});

test('the camera is stored, so resuming looks at the same place', () => {
  installStorage();
  const w = cityWithSomethingInIt();
  const cam = new Camera(1000, 700);
  cam.centerOn(9, 14);
  cam.zoom = 1.85;

  saveToStorage(w, cam);
  const restored = loadFromStorage();

  assert.ok(restored.camera, 'the camera was not stored');
  assert.equal(restored.camera.zoom, 1.85);
  assert.equal(restored.camera.x, cam.x);
  assert.equal(restored.camera.y, cam.y);
});

test('saving without a camera is fine', () => {
  installStorage();
  saveToStorage(cityWithSomethingInIt());
  assert.equal(loadFromStorage().camera, null);
});

// ---------------------------------------------------------- presence ------

test('storage reports whether a city is waiting', () => {
  installStorage();
  assert.equal(hasSave(), false);
  assert.equal(loadFromStorage(), null, 'reading nothing returns nothing');

  saveToStorage(cityWithSomethingInIt());
  assert.equal(hasSave(), true);

  clearStorage();
  assert.equal(hasSave(), false);
});

// ------------------------------------------------------------- failure ----

test('an unreadable save throws, so the caller can start fresh', () => {
  // Startup reads storage automatically. It has to be able to tell a broken
  // save from a missing one, and a broken one must not leave a blank screen.
  installStorage();
  localStorage.setItem('metropolis.save.v1', '{ not json at all');
  assert.throws(() => loadFromStorage());
});

test('a truncated save throws rather than loading half a city', () => {
  installStorage();
  const good = JSON.stringify(serialize(cityWithSomethingInIt()));
  localStorage.setItem('metropolis.save.v1', good.slice(0, good.length / 2));
  assert.throws(() => loadFromStorage());
});

test('a save from an unknown format is refused', () => {
  installStorage();
  const data = serialize(cityWithSomethingInIt());
  data.format = 999;
  localStorage.setItem('metropolis.save.v1', JSON.stringify(data));
  assert.throws(() => loadFromStorage(), /format/i);
});

test('storage that refuses writes surfaces the error', () => {
  // Private windows and a full quota both do this; the game reports it rather
  // than silently losing the city.
  installStorage({ failOnWrite: true });
  assert.throws(() => saveToStorage(cityWithSomethingInIt()), /quota/i);
});

// -------------------------------------------------------------- files -----

test('an exported city round-trips through a file', () => {
  // Export and import go through the same pair as storage, so a file written
  // by one browser loads in another.
  const w = cityWithSomethingInIt();
  const cam = new Camera(900, 600);
  cam.centerOn(11, 11);

  const text = JSON.stringify(serialize(w, cam));
  const restored = deserialize(JSON.parse(text));

  assert.equal(restored.funds, 44321);
  assert.equal(restored.year, 1958);
  assert.equal(JSON.parse(text).camera.zoom, cam.zoom);
});
