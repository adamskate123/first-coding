/**
 * Density feeding back into land value, and grids that run short.
 *
 * Land value used to be a sum of amenities, which gave every district the same
 * ceiling -- measured across a built-out city, the highest land value anywhere
 * was 94 while dense residential needs 140 to reach its third level and 180 for
 * its fourth. The towers existed in the art and could not be built.
 *
 * What these guard is the loop that fixed it, because a feedback loop is the
 * easiest thing in a simulation to get wrong: too weak and it does nothing,
 * too strong and the city oscillates, too fast and it whipsaws. All three were
 * observed while building it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world.js';
import { Simulation } from '../src/sim/index.js';
import { T, Z, ROAD, BUILDING_POWER } from '../src/config.js';
import { updateLandValue, updatePrestige } from '../src/sim/fields.js';
import { updateRoadAccess, updatePower } from '../src/sim/networks.js';

/** Flat, dry, wired land with a road grid -- no terrain effects to confound. */
function plainWorld(size = 48) {
  const w = new World(size, 5);
  w.terrain.fill(T.GRASS);
  w.elevation.fill(10);
  w.tree.fill(0);
  w._corners = null; w._waterDist = null;
  w.funds = 5e7;
  for (let y = 2; y < size - 2; y++) for (let x = 2; x < size - 2; x++) {
    if (x % 5 === 0 || y % 5 === 0) { w.road[w.idx(x, y)] = ROAD.STREET; w.powerLine[w.idx(x, y)] = 1; }
  }
  return w;
}

/** Build out a square of lots at a given level. */
function develop(w, cx, cy, radius, level, zone = Z.R_HIGH) {
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const i = w.idx(x, y);
      if (w.road[i] || w.build[i] !== -1) continue;
      w.zone[i] = zone;
      w.level[i] = level;
      w.powered[i] = 1;
    }
  }
}

/** Run the land value field to its settled value rather than one pass of it. */
function settle(w, passes = 220) {
  for (let k = 0; k < passes; k++) updateLandValue(w);
}

// ------------------------------------------------------------ prestige --

test('a lot beside a dense district is worth more than the same lot in a field', () => {
  const w = plainWorld();
  develop(w, 12, 12, 6, 3);
  updateRoadAccess(w);
  settle(w);

  const downtown = w.landValue[w.idx(12, 12)];
  const nowhere = w.landValue[w.idx(40, 40)];
  assert.ok(downtown > nowhere + 30,
    `a built-up centre (${downtown}) should clearly beat empty land (${nowhere})`);
});

test('the lift falls away with distance, so a centre is a centre', () => {
  const w = plainWorld(64);
  develop(w, 16, 16, 6, 4);
  updateRoadAccess(w);
  settle(w);

  const at = (d) => w.landValue[w.idx(16 + d, 16)];
  assert.ok(at(0) > at(10), 'the middle should beat the edge of town');
  assert.ok(at(10) > at(26), 'and the edge of town should beat the outskirts');
});

test('density is worth more than sprawl of the same footprint', () => {
  // The same number of lots, concentrated or spread: concentration should win,
  // which is what makes a downtown a thing a player builds on purpose.
  const dense = plainWorld(64);
  develop(dense, 20, 20, 5, 4);
  updateRoadAccess(dense);
  settle(dense);

  const thin = plainWorld(64);
  develop(thin, 20, 20, 5, 1);
  updateRoadAccess(thin);
  settle(thin);

  assert.ok(dense.landValue[dense.idx(20, 20)] > thin.landValue[thin.idx(20, 20)] + 25,
    'stacking should pay more than spreading');
});

test('the lift saturates, so a core plateaus rather than running away', () => {
  const w = plainWorld(64);
  develop(w, 30, 30, 14, 4);
  updateRoadAccess(w);
  settle(w, 400);
  const peak = Math.max(...w.prestige);
  assert.ok(peak <= 90 + 1e-6, `prestige reached ${peak.toFixed(1)}, past its cap`);
  assert.ok(peak > 60, `a solid block of towers should approach the cap, got ${peak.toFixed(1)}`);
});

test('standing follows what is built slowly, not instantly', () => {
  // Sticky on purpose: recomputed from scratch each pass, the loop oscillated
  // hard enough to swing a city between 9.8k and 17.8k people every few years.
  const w = plainWorld();
  develop(w, 12, 12, 6, 4);
  updateRoadAccess(w);

  updatePrestige(w);
  const first = w.prestige[w.idx(12, 12)];
  updatePrestige(w);
  const second = w.prestige[w.idx(12, 12)];
  for (let k = 0; k < 300; k++) updatePrestige(w);
  const settled = w.prestige[w.idx(12, 12)];

  assert.ok(first > 0, 'it should start moving at once');
  assert.ok(second > first, 'and keep moving');
  assert.ok(first < settled * 0.25, `one pass jumped to ${first.toFixed(1)} of ${settled.toFixed(1)}`);
});

test('a city that empties loses the standing it earned', () => {
  const w = plainWorld();
  develop(w, 12, 12, 6, 4);
  updateRoadAccess(w);
  settle(w, 400);
  const before = w.landValue[w.idx(12, 12)];

  w.level.fill(0);
  settle(w, 400);
  const after = w.landValue[w.idx(12, 12)];
  assert.ok(after < before - 30, `value should fall with the buildings (${before} -> ${after})`);
});

// --------------------------------------------------------- load shedding --

test('a grid that is short sheds load instead of blacking out', () => {
  // It used to be all or nothing: a network one percent short darkened every
  // lot on it, and since losing power empties a lot immediately, the whole
  // city collapsed and rebuilt on a loop.
  const w = plainWorld(32);
  develop(w, 16, 16, 7, 3);          // level 3 draws well past one coal plant
  updateRoadAccess(w);

  // One plant, deliberately too small for the district hanging off it.
  w.placeBuilding('coal', 3, 3);
  for (let y = 3; y <= 16; y++) w.powerLine[w.idx(4, y)] = 1;
  updatePower(w);

  let zoned = 0, lit = 0;
  for (let i = 0; i < w.zone.length; i++) {
    if (!w.zone[i] || !w.level[i]) continue;
    zoned++;
    if (w.powered[i]) lit++;
  }
  assert.ok(zoned > 50, 'the test needs a district worth browning out');
  assert.ok(lit > 0, 'a short grid should still serve what it can');
  assert.ok(lit < zoned, 'and should not serve everything');
  assert.ok(w.stats.brownoutShare > 0 && w.stats.brownoutShare < 1,
    `partial service should report a partial shortfall, got ${w.stats.brownoutShare}`);
});

test('the same lots stay dark, rather than the city strobing', () => {
  const w = plainWorld(32);
  develop(w, 16, 16, 7, 3);
  updateRoadAccess(w);
  w.placeBuilding('coal', 3, 3);
  for (let y = 3; y <= 16; y++) w.powerLine[w.idx(4, y)] = 1;

  updatePower(w);
  const first = w.powered.slice();
  updatePower(w);
  assert.deepEqual(Array.from(w.powered), Array.from(first),
    'an unchanged city should shed exactly the same load twice running');
});

test('a grid with no plant at all still powers nothing', () => {
  const w = plainWorld(32);
  develop(w, 16, 16, 5, 2);
  updateRoadAccess(w);
  updatePower(w);
  for (let i = 0; i < w.zone.length; i++) {
    if (w.zone[i] && w.level[i]) assert.equal(w.powered[i], 0, 'no plant means no power');
  }
});

// -------------------------------------------------------- redevelopment --

test('land worth far more than what stands on it gets rebuilt, even in a flat market', () => {
  // A settled market has demand at zero forever, which used to cap every city
  // below the top however valuable its land became. Low-density housing on
  // land clearing its next threshold by a clear margin is the simplest case.
  // The classic case: a low-density holdout standing on land the district
  // around it has made valuable.
  const w = plainWorld(40);
  develop(w, 20, 20, 9, 3, Z.R_HIGH);
  const holdouts = [];
  for (let y = 19; y <= 21; y++) for (let x = 19; x <= 21; x++) {
    const i = w.idx(x, y);
    if (w.road[i]) continue;
    w.zone[i] = Z.R_LOW;                       // needs only 55 for its next step
    w.level[i] = 1;
    holdouts.push(i);
  }
  updateRoadAccess(w);
  w.placeBuilding('gas', 3, 3);
  for (let y = 3; y <= 20; y++) w.powerLine[w.idx(4, y)] = 1;
  settle(w, 400);

  const centre = w.landValue[holdouts[0]];
  assert.ok(centre >= 80, `the test needs prime land to redevelop, got ${centre}`);
  assert.ok(holdouts.length >= 4, 'the test needs some holdouts');

  const sim = new Simulation(w);
  sim.topologyDirty = true;

  const count = () => holdouts.filter((i) => w.level[i] >= 2).length;
  const before = count();
  for (let t = 0; t < 1400; t++) {
    sim.step();
    w.demand.R = 0; w.demand.C = 0; w.demand.I = 0;   // hold the market in balance
  }
  assert.ok(count() > before, `nothing redeveloped on prime land (${before} -> ${count()})`);
});

test('but land only just good enough is left alone', () => {
  // Otherwise every lot in the city creeps upward for ever, and the margin
  // that makes redevelopment mean "outgrown" stops meaning anything.
  const w = plainWorld(40);
  develop(w, 20, 20, 4, 1, Z.R_HIGH);        // needs 105 to reach level 2
  updateRoadAccess(w);
  w.placeBuilding('gas', 3, 3);
  for (let y = 3; y <= 20; y++) w.powerLine[w.idx(4, y)] = 1;
  settle(w, 400);
  assert.ok(w.landValue[w.idx(20, 20)] < 130, 'this lot should be short of the redevelopment margin');

  const sim = new Simulation(w);
  sim.topologyDirty = true;
  for (let t = 0; t < 900; t++) {
    sim.step();
    w.demand.R = 0; w.demand.C = 0; w.demand.I = 0;
  }
  let risen = 0;
  for (let i = 0; i < w.level.length; i++) if (w.level[i] >= 2) risen++;
  assert.equal(risen, 0, 'a flat market should not lift a lot whose land is merely adequate');
});
