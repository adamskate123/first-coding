/**
 * Architectural periods.
 *
 * A lot records the year it was last built and draws in that period's style
 * for as long as it stands, which is what lets a city accumulate visible
 * history. These tests cover the three things that has to get right: the year
 * is recorded when a lot is actually rebuilt, it survives a save, and the
 * period genuinely changes how the building looks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world.js';
import { Z, ROAD, T, ERAS, START_YEAR, eraFor } from '../src/config.js';
import { updateGrowth } from '../src/sim/growth.js';
import { updateDevelopment } from '../src/sim/development.js';
import { buildingRecipe, VARIANTS, spriteCacheSize } from '../src/render/sprites.js';
import { buildingPalette, applyEra, mix } from '../src/render/palette.js';
import { serialize, deserialize } from '../src/save.js';
import { makeRng, createLruCache } from '../src/util.js';

function flatWorld(size = 20) {
  const w = new World(size, 3);
  w.terrain.fill(T.GRASS);
  w.elevation.fill(12);
  w.tree.fill(0);
  w._waterDist = null;
  return w;
}

/**
 * One step of the development cycle.
 *
 * Growth breaks ground and construction finishes the job, so a lot only
 * reaches its next level once both have run. Driving growth alone -- which is
 * all these tests used to do -- now starts a building site and leaves it
 * standing there.
 */
function develop(w, rng) {
  updateGrowth(w, rng);
  updateDevelopment(w, rng);
  w.tick++;
}

/** A lot primed to grow on the next tick. */
function readyLot(w, x, y, zone = Z.R_LOW) {
  const i = w.idx(x, y);
  w.zone[i] = zone;
  w.roadAccess[i] = 1;
  w.powered[i] = 1;
  w.landValue[i] = 120;
  w.demand.R = 1; w.demand.C = 1; w.demand.I = 1;
  return i;
}

// ----------------------------------------------------------- era boundaries --

test('every year falls in exactly one period', () => {
  for (let year = 1900; year <= 2150; year += 1) {
    const index = eraFor(year);
    assert.ok(index >= 0 && index < ERAS.length, `${year} -> ${index}`);
    assert.ok(year >= ERAS[index].from, `${year} placed before its period starts`);
    const next = ERAS[index + 1];
    if (next) assert.ok(year < next.from, `${year} should have been in the next period`);
  }
});

test('periods are declared in chronological order', () => {
  for (let k = 1; k < ERAS.length; k++) {
    assert.ok(ERAS[k].from > ERAS[k - 1].from, `${ERAS[k].key} does not follow ${ERAS[k - 1].key}`);
  }
});

test('a year before the first period still resolves', () => {
  assert.equal(eraFor(1500), 0);
});

// -------------------------------------------------------------- recording --

test('a lot records the year it is built', () => {
  const w = flatWorld();
  w.year = 1926;
  const i = readyLot(w, 5, 5);

  const rng = makeRng(1);
  for (let k = 0; k < 960; k++) { if (w.level[i] !== 0) break; develop(w, rng); }

  assert.ok(w.level[i] > 0, 'the lot developed');
  assert.equal(w.builtYear(i), 1926);
  assert.equal(w.eraOf(i), eraFor(1926));
});

test('a lot keeps its period as it grows', () => {
  // Restamping on every level change erases the city's history: measured on a
  // city expanded in four waves across a century, continuous improvement
  // re-dated every standing lot into a single period and no strata survived.
  const w = flatWorld();
  w.year = 1930;
  const i = readyLot(w, 5, 5, Z.R_HIGH);
  const rng = makeRng(2);
  for (let k = 0; k < 960; k++) { if (w.level[i] !== 0) break; develop(w, rng); }
  assert.equal(w.builtYear(i), 1930);

  w.year = 2010;
  const wasLevel = w.level[i];
  for (let k = 0; k < 2400; k++) { if (w.level[i] !== wasLevel) break; develop(w, rng); }
  assert.ok(w.level[i] > wasLevel, 'the lot grew');
  assert.equal(w.builtYear(i), 1930, 'but kept the period it was founded in');
});

test('clearing a lot lets it be rebuilt in the present day', () => {
  // Demolition is what actually replaces a building, so it is what resets the
  // date -- this is the route by which a city does modernise.
  const w = flatWorld();
  w.year = 1912;
  const i = readyLot(w, 7, 7);
  const rng = makeRng(8);
  for (let k = 0; k < 960; k++) { if (w.level[i] !== 0) break; develop(w, rng); }
  assert.equal(w.builtYear(i), 1912);

  w.clearTile(7, 7);
  w.year = 2005;
  readyLot(w, 7, 7);
  for (let k = 0; k < 960; k++) { if (w.level[i] !== 0) break; develop(w, rng); }
  assert.equal(w.builtYear(i), 2005, 'the replacement is of its own time');
});

test('a building that empties out keeps the period it went up in', () => {
  const w = flatWorld();
  w.year = 1935;
  const i = readyLot(w, 5, 5);
  const rng = makeRng(3);
  for (let k = 0; k < 960; k++) { if (w.level[i] !== 0) break; develop(w, rng); }
  const built = w.builtYear(i);

  // Cut the power and let it decay: same building, just emptying.
  w.year = 2020;
  w.powered[i] = 0;
  const wasLevel = w.level[i];
  for (let k = 0; k < 3600; k++) { if (w.level[i] !== wasLevel) break; develop(w, rng); }

  assert.ok(w.level[i] < wasLevel, 'the lot decayed');
  assert.equal(w.builtYear(i), built, 'decay is not a rebuild');
});

test('bulldozing clears the build year', () => {
  const w = flatWorld();
  w.year = 1950;
  const i = readyLot(w, 6, 6);
  const rng = makeRng(4);
  for (let k = 0; k < 960; k++) { if (w.level[i] !== 0) break; develop(w, rng); }
  w.clearTile(6, 6);
  assert.equal(w.builtAge[i], 0);
});

test('a build year far in the future is clamped rather than wrapping', () => {
  const w = flatWorld();
  const i = w.idx(3, 3);
  w.year = START_YEAR + 9000;
  w.recordBuild(i);
  assert.equal(w.builtAge[i], 255, 'stored age saturates');
  assert.ok(w.builtYear(i) > START_YEAR);
});

// ---------------------------------------------------------------- saving ---

test('build years survive a save and reload', () => {
  // Unlike every other appearance field this is authored history, not derived
  // state, so it cannot be recomputed on load and has to be written out.
  const w = flatWorld(24);
  for (let x = 0; x < 20; x++) w.road[w.idx(x, 10)] = ROAD.STREET;
  const a = w.idx(4, 11), b = w.idx(6, 11);
  w.zone[a] = Z.R_LOW; w.level[a] = 2; w.builtAge[a] = 1912 - START_YEAR;
  w.zone[b] = Z.R_LOW; w.level[b] = 2; w.builtAge[b] = 2004 - START_YEAR;

  const restored = deserialize(JSON.parse(JSON.stringify(serialize(w))));
  assert.equal(restored.builtYear(a), 1912);
  assert.equal(restored.builtYear(b), 2004);
  assert.notEqual(restored.eraOf(a), restored.eraOf(b));
});

test('a save written before build years were recorded still loads', () => {
  const w = flatWorld(20);
  w.zone[w.idx(4, 4)] = Z.R_LOW;
  w.level[w.idx(4, 4)] = 1;

  const old = serialize(w);
  old.format = 1;
  delete old.builtAge;

  const restored = deserialize(old);
  assert.equal(restored.level[restored.idx(4, 4)], 1, 'the city came back');
  assert.equal(restored.builtYear(restored.idx(4, 4)), START_YEAR);
});

// ------------------------------------------------------------ appearance ---

test('the same lot looks different in different periods', () => {
  const shapes = ERAS.map((_, era) => {
    const r = buildingRecipe('R_HIGH', 3, 0, 1, era);
    return [r.roof, r.windows, r.height, r.footprint.toFixed(3)].join('|');
  });
  assert.equal(new Set(shapes).size, ERAS.length, 'periods produce identical buildings');
});

test('early periods build pitched, late periods build flat', () => {
  const pitchedShare = (era) => {
    const rs = Array.from({ length: VARIANTS }, (_, v) => buildingRecipe('R_HIGH', 2, v, 1, era));
    return rs.filter((r) => r.roof !== 'flat').length / VARIANTS;
  };
  assert.ok(pitchedShare(0) > pitchedShare(ERAS.length - 1),
    'the contemporary city is not flatter-roofed than the Edwardian one');
});

test('late periods glaze more than early ones', () => {
  const glassShare = (era) => {
    const rs = Array.from({ length: VARIANTS }, (_, v) => buildingRecipe('C_HIGH', 3, v, 1, era));
    return rs.filter((r) => r.windows === 'ribbon' || r.windows === 'columns').length / VARIANTS;
  };
  assert.ok(glassShare(ERAS.length - 1) > glassShare(0),
    'contemporary offices are not more glazed than Edwardian ones');
});

test('houses keep pitched roofs in every period', () => {
  // The period biases choices within a zone's own vocabulary. Low-density
  // housing has no flat roof in its pool, so it must never acquire one.
  for (let era = 0; era < ERAS.length; era++) {
    for (let v = 0; v < VARIANTS; v++) {
      const r = buildingRecipe('R_LOW', 2, v, 1, era);
      assert.notEqual(r.roof, 'flat', `a house went flat-roofed in ${ERAS[era].key}`);
    }
  }
});

test('period and wealth compose rather than overriding each other', () => {
  const poor = buildingRecipe('R_LOW', 2, 0, 0, 0);
  const rich = buildingRecipe('R_LOW', 2, 0, 2, 0);
  assert.notEqual(poor.footprint, rich.footprint, 'wealth stopped mattering inside a period');

  const early = buildingRecipe('R_LOW', 2, 0, 2, 0);
  const late = buildingRecipe('R_LOW', 2, 0, 2, ERAS.length - 1);
  assert.notEqual(early.height, late.height, 'period stopped mattering at a fixed wealth');
});

test('era tinting shifts colour without producing an invalid one', () => {
  const way = buildingPalette('R', 1)[0];
  const seen = new Set();
  for (const era of ERAS) {
    const tinted = applyEra(way, era);
    for (const slot of ['wall', 'roof', 'win']) {
      assert.match(tinted[slot], /^rgb\(\d+,\d+,\d+\)$/, `${era.key}.${slot} = ${tinted[slot]}`);
    }
    seen.add(tinted.win);
  }
  assert.equal(seen.size, ERAS.length, 'periods share glazing colour');
});

test('mixing clamps rather than overshooting', () => {
  assert.equal(mix('#000000', '#ffffff', 0), 'rgb(0,0,0)');
  assert.equal(mix('#000000', '#ffffff', 1), 'rgb(255,255,255)');
  assert.equal(mix('#000000', '#ffffff', 4), 'rgb(255,255,255)');
  assert.equal(mix('#000000', '#ffffff', -2), 'rgb(0,0,0)');
});

test('an out-of-range era is clamped rather than breaking', () => {
  for (const bad of [-3, 99, 1.7]) {
    const r = buildingRecipe('C_LOW', 2, 0, 1, bad);
    assert.ok(r.era >= 0 && r.era < ERAS.length, `era ${bad} became ${r.era}`);
  }
});

test('the sprite cache is reported and bounded', () => {
  assert.equal(typeof spriteCacheSize(), 'number');
  assert.ok(spriteCacheSize() <= 800);
});

// -------------------------------------------------------------- lru cache --

test('the cache evicts the least recently used entry when full', () => {
  // Sprites cannot be built without a canvas, so the cache's behaviour is
  // tested directly. The key space grew by 4x with eras, which is what makes
  // an unbounded cache a real problem rather than a theoretical one.
  const cache = createLruCache(3);
  cache.set('a', 1); cache.set('b', 2); cache.set('c', 3);
  assert.equal(cache.size, 3);

  cache.get('a');            // 'a' is now the most recent, 'b' the least
  cache.set('d', 4);

  assert.equal(cache.size, 3, 'the cache stayed within its limit');
  assert.equal(cache.has('b'), false, 'the least recently used entry went');
  for (const key of ['a', 'c', 'd']) {
    assert.equal(cache.has(key), true, `${key} should have been kept`);
  }
});

test('re-setting a key refreshes it rather than duplicating it', () => {
  const cache = createLruCache(2);
  cache.set('a', 1);
  cache.set('b', 2);
  cache.set('a', 9);
  cache.set('c', 3);

  assert.equal(cache.size, 2);
  assert.equal(cache.get('a'), 9, 'the refreshed entry survived and updated');
  assert.equal(cache.has('b'), false);
});

test('a miss returns undefined without disturbing the cache', () => {
  const cache = createLruCache(2);
  cache.set('a', 1);
  assert.equal(cache.get('nope'), undefined);
  assert.equal(cache.size, 1);
});

test('clearing empties the cache', () => {
  const cache = createLruCache(4);
  cache.set('a', 1); cache.set('b', 2);
  cache.clear();
  assert.equal(cache.size, 0);
});
