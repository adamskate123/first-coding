/**
 * Lots that share a building.
 *
 * Every zoned lot used to be its own one-tile building, so a dense district
 * came out as a grid of separate boxes -- the largest single reason a built-up
 * area read as tiling rather than as a city.
 *
 * The property that matters is not that merging happens but that it is
 * *unambiguous*: every developed lot is drawn exactly once, by exactly one
 * building, and the answer never depends on what was examined first. Get that
 * wrong and lots either vanish or are painted twice, and a growing district
 * flickers between footprints.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world.js';
import { T, Z, ROAD } from '../src/config.js';
import { mergedBlock, MERGE_SPAN } from '../src/render/renderer.js';

function plainWorld(size = 24) {
  const w = new World(size, 3);
  w.terrain.fill(T.GRASS);
  w.elevation.fill(10);
  w.tree.fill(0);
  w._corners = null; w._waterDist = null;
  return w;
}

/** Zone and build out a rectangle, uniformly. */
function build(w, x0, y0, x1, y1, { zone = Z.R_HIGH, level = 3, wealth = 1, powered = 1 } = {}) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = w.idx(x, y);
      w.zone[i] = zone; w.level[i] = level; w.wealth[i] = wealth; w.powered[i] = powered;
    }
  }
}

test('a uniform district merges into larger buildings', () => {
  const w = plainWorld();
  build(w, 4, 4, 11, 11);
  const block = mergedBlock(w, 5, 5);
  assert.ok(block, 'a uniform block should merge');
  assert.equal(block.span, MERGE_SPAN);
  assert.equal(block.ox, 4);
  assert.equal(block.oy, 4);
});

test('every developed lot is drawn exactly once', () => {
  // The property the whole scheme rests on. A lot is drawn either by its own
  // one-tile building or by the block that owns it, never by both and never
  // by neither.
  const w = plainWorld(32);
  build(w, 4, 4, 19, 19);
  build(w, 8, 8, 11, 13, { level: 2 });            // a patch at another level
  build(w, 14, 6, 15, 7, { wealth: 2 });           // and another at another budget
  for (let y = 4; y < 20; y++) w.road[w.idx(12, y)] = ROAD.STREET;   // a street through it

  const drawn = new Map();
  for (let y = 0; y < w.size; y++) {
    for (let x = 0; x < w.size; x++) {
      const i = w.idx(x, y);
      if (!w.zone[i] || !w.level[i] || w.road[i]) continue;
      const block = mergedBlock(w, x, y);
      if (!block) { drawn.set(i, (drawn.get(i) || 0) + 1); continue; }
      // Only the near corner draws, and it covers the whole block.
      if (x !== block.ox + block.span - 1 || y !== block.oy + block.span - 1) continue;
      for (let dy = 0; dy < block.span; dy++) {
        for (let dx = 0; dx < block.span; dx++) {
          const j = w.idx(block.ox + dx, block.oy + dy);
          drawn.set(j, (drawn.get(j) || 0) + 1);
        }
      }
    }
  }

  let lots = 0;
  for (let i = 0; i < w.zone.length; i++) {
    if (!w.zone[i] || !w.level[i] || w.road[i]) continue;
    lots++;
    assert.equal(drawn.get(i), 1, `lot ${i % w.size},${(i / w.size) | 0} drawn ${drawn.get(i) || 0} times`);
  }
  assert.ok(lots > 100, 'the test needs a district worth checking');
});

test('lots that differ are left as they are', () => {
  const w = plainWorld();
  build(w, 4, 4, 11, 11);

  const vary = (mutate, why) => {
    const copy = plainWorld();
    build(copy, 4, 4, 11, 11);
    mutate(copy);
    assert.equal(mergedBlock(copy, 4, 4), null, why);
  };
  vary((c) => { c.level[c.idx(5, 5)] = 2; }, 'a different level should not merge');
  vary((c) => { c.wealth[c.idx(5, 5)] = 2; }, 'a different budget should not merge');
  vary((c) => { c.zone[c.idx(5, 5)] = Z.C_HIGH; }, 'a different use should not merge');
  vary((c) => { c.powered[c.idx(5, 5)] = 0; }, 'a dark lot should not merge with a lit one');
  vary((c) => { c.road[c.idx(5, 5)] = ROAD.STREET; }, 'a street should not be built over');
  vary((c) => { c.builtAge[c.idx(5, 5)] = 90; }, 'buildings of different periods should not merge');
  vary((c) => { c.terrain[c.idx(5, 5)] = T.WATER; }, 'water should not be built over');
});

test('houses are left alone', () => {
  // Four identical houses welded into one block looks less like a city.
  const w = plainWorld();
  build(w, 4, 4, 11, 11, { zone: Z.R_LOW, level: 1 });
  assert.equal(mergedBlock(w, 4, 4), null);
});

test('the answer does not depend on which lot is asked', () => {
  const w = plainWorld();
  build(w, 4, 4, 11, 11);
  const from = (x, y) => JSON.stringify(mergedBlock(w, x, y));
  assert.equal(from(4, 4), from(5, 5));
  assert.equal(from(4, 5), from(5, 4));
  assert.notEqual(from(4, 4), from(6, 6), 'different blocks are different buildings');
});

test('a block that straddles the edge of the map is not merged', () => {
  // Odd-sized on purpose: with an even map every block fits, and the guard
  // against running off the edge would never be exercised at all.
  const w = plainWorld(25);
  build(w, 0, 0, w.size - 1, w.size - 1);
  assert.ok(mergedBlock(w, 0, 0), 'an interior block is fine');
  assert.equal(mergedBlock(w, w.size - 1, w.size - 1), null, 'a block running off the map is not');
});
