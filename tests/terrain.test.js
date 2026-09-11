/**
 * Terrain generation properties.
 *
 * The generator is stochastic, so these assert *distributional* guarantees
 * across many seeds rather than exact height maps. They are the contract the
 * shape constants in world.js were tuned to satisfy, and they are what would
 * catch a retune that quietly turns every map into an archipelago or a
 * featureless plain.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world.js';
import { T, MAP_SIZE } from '../src/config.js';

const SEEDS = Array.from({ length: 12 }, (_, k) => k * 7919 + 13);

/**
 * Label every contiguous region of dry land and report their sizes as shares
 * of all dry land, largest first, plus which region the map's centre sits in.
 */
function survey(world) {
  const n = world.terrain.length;
  const size = world.size;
  let water = 0;
  for (let i = 0; i < n; i++) if (world.terrain[i] === T.WATER) water++;

  const region = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = [];
  for (let i = 0; i < n; i++) {
    if (region[i] !== -1 || world.terrain[i] === T.WATER) continue;
    const id = sizes.length;
    let count = 0;
    stack.length = 0;
    stack.push(i);
    region[i] = id;
    while (stack.length) {
      const j = stack.pop();
      count++;
      const x = j % size, y = (j / size) | 0;
      if (x > 0 && region[j - 1] === -1 && world.terrain[j - 1] !== T.WATER) { region[j - 1] = id; stack.push(j - 1); }
      if (x < size - 1 && region[j + 1] === -1 && world.terrain[j + 1] !== T.WATER) { region[j + 1] = id; stack.push(j + 1); }
      if (y > 0 && region[j - size] === -1 && world.terrain[j - size] !== T.WATER) { region[j - size] = id; stack.push(j - size); }
      if (y < size - 1 && region[j + size] === -1 && world.terrain[j + size] !== T.WATER) { region[j + size] = id; stack.push(j + size); }
    }
    sizes.push(count);
  }

  const land = n - water;
  const mid = size >> 1;
  const centreRegion = region[mid * size + mid];
  return {
    waterShare: water / n,
    shares: sizes.map((c) => c / land).sort((a, b) => b - a),
    centreShare: centreRegion === -1 ? 0 : sizes[centreRegion] / land,
  };
}

test('every generated map has a meaningful amount of water', () => {
  for (const seed of SEEDS) {
    const { waterShare } = survey(new World(MAP_SIZE, seed));
    assert.ok(waterShare > 0.10, `seed ${seed}: only ${(waterShare * 100).toFixed(1)}% water`);
    assert.ok(waterShare < 0.45, `seed ${seed}: ${(waterShare * 100).toFixed(1)}% water leaves too little to build on`);
  }
});

test('the river may split the map, but only into banks worth building on', () => {
  // Since bridges exist, a river that cuts the map in two is a feature rather
  // than a trap. What must not happen is the map shattering into islets: land
  // should resolve into at most two substantial banks that between them hold
  // nearly all the dry ground.
  for (const seed of SEEDS) {
    const { shares } = survey(new World(MAP_SIZE, seed));
    const major = shares.filter((s) => s > 0.03);

    assert.ok(major.length <= 2,
      `seed ${seed}: land broke into ${major.length} major regions`);
    assert.ok(major[0] >= 0.40,
      `seed ${seed}: the largest bank is only ${(major[0] * 100).toFixed(1)}% of dry land`);

    const accounted = major.reduce((a, b) => a + b, 0);
    assert.ok(accounted > 0.95,
      `seed ${seed}: only ${(accounted * 100).toFixed(1)}% of land is in a usable bank`);
  }
});

test('the player never starts on a sliver of land', () => {
  for (const seed of SEEDS) {
    const { centreShare } = survey(new World(MAP_SIZE, seed));
    assert.ok(centreShare > 0.30,
      `seed ${seed}: the camera starts on a region holding only ${(centreShare * 100).toFixed(1)}% of land`);
  }
});

test('the centre of the map, where the camera starts, is always buildable', () => {
  for (const seed of SEEDS) {
    const w = new World(MAP_SIZE, seed);
    const mid = MAP_SIZE >> 1;
    assert.notEqual(w.terrain[w.idx(mid, mid)], T.WATER, `seed ${seed} starts the player over water`);
  }
});

test('maps contain a mix of terrain types', () => {
  const w = new World(MAP_SIZE, 4242);
  const kinds = new Set(w.terrain);
  assert.ok(kinds.has(T.WATER), 'water');
  assert.ok(kinds.has(T.GRASS), 'grass');
  assert.ok(kinds.has(T.SAND), 'shoreline sand');
});

test('water is rendered flat at a single sea level', () => {
  const w = new World(64, 8);
  const levels = new Set();
  for (let i = 0; i < w.terrain.length; i++) {
    if (w.terrain[i] === T.WATER) levels.add(w.elevation[i]);
  }
  assert.equal(levels.size, 1, 'all water sits at one elevation');
});
