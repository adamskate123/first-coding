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

function survey(world) {
  const n = world.terrain.length;
  const size = world.size;
  let water = 0;
  for (let i = 0; i < n; i++) if (world.terrain[i] === T.WATER) water++;

  // Largest contiguous run of dry land, as a share of all dry land.
  const seen = new Uint8Array(n);
  const stack = [];
  let biggest = 0;
  for (let i = 0; i < n; i++) {
    if (seen[i] || world.terrain[i] === T.WATER) continue;
    let count = 0;
    stack.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const j = stack.pop();
      count++;
      const x = j % size, y = (j / size) | 0;
      if (x > 0 && !seen[j - 1] && world.terrain[j - 1] !== T.WATER) { seen[j - 1] = 1; stack.push(j - 1); }
      if (x < size - 1 && !seen[j + 1] && world.terrain[j + 1] !== T.WATER) { seen[j + 1] = 1; stack.push(j + 1); }
      if (y > 0 && !seen[j - size] && world.terrain[j - size] !== T.WATER) { seen[j - size] = 1; stack.push(j - size); }
      if (y < size - 1 && !seen[j + size] && world.terrain[j + size] !== T.WATER) { seen[j + size] = 1; stack.push(j + size); }
    }
    if (count > biggest) biggest = count;
  }

  const land = n - water;
  return { waterShare: water / n, landmassShare: land ? biggest / land : 0 };
}

test('every generated map has a meaningful amount of water', () => {
  for (const seed of SEEDS) {
    const { waterShare } = survey(new World(MAP_SIZE, seed));
    assert.ok(waterShare > 0.10, `seed ${seed}: only ${(waterShare * 100).toFixed(1)}% water`);
    assert.ok(waterShare < 0.45, `seed ${seed}: ${(waterShare * 100).toFixed(1)}% water leaves too little to build on`);
  }
});

test('dry land forms one contiguous mass, not an archipelago', () => {
  // Roads cannot cross water, so a fragmented map would strand the player.
  for (const seed of SEEDS) {
    const { landmassShare } = survey(new World(MAP_SIZE, seed));
    assert.ok(landmassShare > 0.85,
      `seed ${seed}: largest landmass is only ${(landmassShare * 100).toFixed(1)}% of dry land`);
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
