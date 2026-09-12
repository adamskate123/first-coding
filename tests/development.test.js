/**
 * How zoned land becomes a neighbourhood.
 *
 * Two things stand between zoning and a building now: developers cut lanes
 * into land that has no frontage, and every plot spends time as a building
 * site. Both run on their own clock, which makes them easy to get subtly
 * wrong -- a lane network that never stops growing, or a site that never
 * finishes -- so these pin down the shape of both.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world.js';
import { Z, T, ROAD, ROAD_REACH, BUILD_STAGES, onLaneGrid,
         LANE_ROW_PITCH } from '../src/config.js';
import { updateRoadAccess } from '../src/sim/networks.js';
import { updateDevelopment, isSite, reservedForLane, hasFrontage } from '../src/sim/development.js';
import { updateGrowth } from '../src/sim/growth.js';
import { serialize, deserialize } from '../src/save.js';
import { makeRng } from '../src/util.js';

function flatWorld(size = 40) {
  const w = new World(size, 11);
  w.terrain.fill(T.GRASS);
  w.elevation.fill(12);
  w.tree.fill(0);
  w._waterDist = null;
  w.demand.R = 1; w.demand.C = 1; w.demand.I = 1;
  return w;
}

/**
 * One road along the top, and a block of residential behind it far too deep
 * for the road to reach on its own.
 */
function subdivision(size = 40) {
  const w = flatWorld(size);
  for (let x = 2; x < size - 2; x++) w.road[w.idx(x, 2)] = ROAD.STREET;
  for (let y = 3; y < size - 2; y++) {
    for (let x = 2; x < size - 2; x++) {
      const i = w.idx(x, y);
      w.zone[i] = Z.R_LOW;
      w.powered[i] = 1;
      w.landValue[i] = 110;
    }
  }
  updateRoadAccess(w);
  return w;
}

/** Run the developers for a while, keeping road access honest as they go. */
function develop(w, ticks, rng = makeRng(5)) {
  for (let k = 0; k < ticks; k++) {
    updateRoadAccess(w);
    updateDevelopment(w, rng);
    w.tick++;
  }
  updateRoadAccess(w);
}

const countLanes = (w) => w.road.reduce((n, r) => n + (r === ROAD.LANE ? 1 : 0), 0);
const countZoned = (w) => w.zone.reduce((n, z) => n + (z ? 1 : 0), 0);

// -------------------------------------------------------------------- lanes --

test('developers cut lanes into land the road cannot reach', () => {
  const w = subdivision();
  const deep = w.idx(20, 30);
  assert.equal(w.roadAccess[deep], 0, 'the far side starts with no frontage');

  develop(w, 1200);
  assert.ok(countLanes(w) > 0, 'no lane was ever laid');
  assert.equal(w.roadAccess[deep], 1, 'the far side never got frontage');
});

test('laying out a district takes minutes, not hours or seconds', () => {
  // The pace is the whole point, so it is worth holding to a range rather
  // than only checking that it finishes. Measured at normal speed: a small
  // district is laid out in under half a minute, a very large one in a
  // couple of minutes, and building starts as soon as the first lane lands
  // rather than waiting for the layout to be done.
  const w = subdivision(30);
  const rng = makeRng(5);
  let done = -1;
  for (let k = 0; k < 4000 && done < 0; k++) {
    updateRoadAccess(w);
    updateDevelopment(w, rng);
    w.tick++;
    let unserved = 0;
    for (let i = 0; i < w.zone.length; i++) {
      if (w.zone[i] && !w.roadAccess[i] && !w.road[i]) unserved++;
    }
    if (unserved === 0) done = k;
  }
  assert.ok(done > 60, `laid out in ${done} ticks, which is too fast to watch`);
  assert.ok(done < 1500, `laid out in ${done} ticks, which is too slow to bother`);
});

test('every plot ends up with a street beside it', () => {
  // Frontage, not access. A plot within reach of a road can be built on, but a
  // building faces the street *next door*, so a plot three tiles away has
  // nothing to face. Measured on blocks ringed by the player's own roads,
  // between 36% and 49% of plots had nothing adjacent -- which is why the
  // interior of a district came out as houses backing onto each other.
  const w = subdivision();
  develop(w, 4000);

  let strandedPlots = 0;
  for (let i = 0; i < w.zone.length; i++) {
    if (!w.zone[i] || w.road[i]) continue;
    if (!hasFrontage(w, i)) strandedPlots++;
  }
  assert.equal(strandedPlots, 0, `${strandedPlots} plots have no street beside them`);
});

test('the lattice costs what a subdivision costs, and no more', () => {
  // Giving every plot a street of its own is not free: rows have to sit three
  // apart -- lane, plot, plot, lane -- so about a third of a block becomes
  // road. That is what a real subdivision spends on streets. Much beyond it
  // and something has gone wrong with the lattice.
  const w = subdivision();
  develop(w, 4000);
  const share = countLanes(w) / countZoned(w);
  assert.ok(share > 0.2, `only ${(100 * share).toFixed(0)}% lane: too few to give frontage`);
  assert.ok(share < 0.45, `lanes took ${(100 * share).toFixed(0)}% of the block`);
});

test('every lane sits on the lattice', () => {
  const w = subdivision();
  develop(w, 2000);
  for (let i = 0; i < w.road.length; i++) {
    if (w.road[i] !== ROAD.LANE) continue;
    const x = i % w.size, y = (i / w.size) | 0;
    assert.ok(onLaneGrid(x, y), `a lane at ${x},${y} is off the grid`);
  }
});

test('the lattice is close enough together to serve what lies between', () => {
  // Rows have to be no further apart than twice the reach plus one, or the
  // plots in the middle of a block can never be built on at all.
  assert.ok(LANE_ROW_PITCH <= ROAD_REACH * 2 + 1);
});

test('empty ground is taken before anybody\'s house is', () => {
  // A lane that can be laid across a field is laid there. Only a district
  // already built solid, which has no empty ground left on the lattice, pays
  // for its streets in houses.
  const w = subdivision();
  const lost = [];
  const before = Array.from(w.level);
  develop(w, 4000);
  for (let i = 0; i < before.length; i++) {
    if (before[i] > 0 && w.road[i] === ROAD.LANE) lost.push(i);
  }
  assert.equal(lost.length, 0, `${lost.length} houses pulled down on open land`);
});

test('a district built out before its streets existed still gets them', () => {
  // The case an existing city is in. Every tile of the lattice has a house on
  // it, so a network that refuses to path through developed land can never be
  // laid at all: measured, no lane anywhere and 893 of 896 plots still with no
  // street after 6,000 ticks. Cutting a street through built-up land is how
  // real cities got theirs.
  const w = subdivision();
  for (let i = 0; i < w.zone.length; i++) {
    if (w.zone[i] && !w.road[i]) { w.level[i] = 2; w.pop[i] = 20; }
  }
  develop(w, 4000);

  assert.ok(countLanes(w) > 0, 'no street was ever cut through the district');
  let stranded = 0;
  for (let i = 0; i < w.zone.length; i++) {
    if (!w.zone[i] || w.road[i]) continue;
    if (!hasFrontage(w, i)) stranded++;
  }
  assert.ok(stranded < 40, `${stranded} plots still have no street beside them`);
});

test('a lane is never cut through something the player placed', () => {
  // A house is the developers\' to pull down. A power station is not.
  const w = subdivision();
  for (let i = 0; i < w.zone.length; i++) if (w.zone[i]) w.zone[i] = Z.NONE;
  const placed = w.placeBuilding('coal', 10, 10);
  assert.ok(placed, 'the test needs a building on the ground');
  for (let y = 6; y < 30; y++) {
    for (let x = 6; x < 30; x++) {
      const i = w.idx(x, y);
      if (w.build[i] === -1 && !w.road[i]) w.zone[i] = Z.R_LOW;
    }
  }
  develop(w, 4000);
  for (let dy = 0; dy < 3; dy++) {
    for (let dx = 0; dx < 3; dx++) {
      const i = w.idx(10 + dx, 10 + dy);
      assert.equal(w.road[i], 0, `a lane was cut through the power station at ${10 + dx},${10 + dy}`);
      assert.notEqual(w.build[i], -1, 'and the station should still be standing');
    }
  }
});

test('lanes stay put once the district is built out', () => {
  const w = subdivision();
  develop(w, 1500);
  const before = Array.from(w.road);
  develop(w, 1500);
  assert.deepEqual(Array.from(w.road), before, 'the layout should settle, not keep churning');
});

test('nothing is laid with no road to grow from', () => {
  const w = flatWorld();
  for (let y = 3; y < 30; y++) for (let x = 3; x < 30; x++) w.zone[w.idx(x, y)] = Z.R_LOW;
  develop(w, 400);
  assert.equal(countLanes(w), 0);
});

test('a plot kept clear for a lane does not build on itself', () => {
  const w = subdivision();
  // Straight after zoning, the lattice is reserved because plots behind it
  // still have no frontage.
  let reserved = 0;
  for (let i = 0; i < w.zone.length; i++) if (reservedForLane(w, i)) reserved++;
  assert.ok(reserved > 0, 'nothing was reserved');

  // Once everything is served, the leftovers are free to build like any other.
  develop(w, 2000);
  let stillReserved = 0;
  for (let i = 0; i < w.zone.length; i++) if (reservedForLane(w, i)) stillReserved++;
  assert.equal(stillReserved, 0, 'land is still being held for lanes nobody needs');
});

// ------------------------------------------------------------ construction --

/** A single plot, connected, powered and wanted. */
function readyPlot(w, x, y) {
  const i = w.idx(x, y);
  w.zone[i] = Z.R_LOW;
  w.road[w.idx(x, y - 1)] = ROAD.STREET;
  w.roadAccess[i] = 1;
  w.powered[i] = 1;
  w.landValue[i] = 120;
  return i;
}

test('growth breaks ground rather than handing over a building', () => {
  const w = flatWorld(20);
  const i = readyPlot(w, 8, 8);
  const rng = makeRng(3);
  for (let k = 0; k < 200 && !w.stage[i]; k++) updateGrowth(w, rng);

  assert.ok(isSite(w, i), 'the plot should be a building site');
  assert.equal(w.level[i], 0, 'and nothing should be standing on it yet');
  assert.equal(w.pop[i], 0, 'and nobody should have moved in');
});

test('a site passes through every stage before it is a building', () => {
  const w = flatWorld(20);
  const i = readyPlot(w, 8, 8);
  const rng = makeRng(3);
  for (let k = 0; k < 200 && !w.stage[i]; k++) updateGrowth(w, rng);

  const seen = new Set([w.stage[i]]);
  for (let k = 0; k < 4000 && w.level[i] === 0; k++) {
    updateDevelopment(w, rng);
    w.tick++;
    if (w.stage[i]) seen.add(w.stage[i]);
  }
  assert.equal(w.level[i], 1, 'the building never finished');
  assert.equal(w.stage[i], 0, 'and the site should be cleared when it does');
  for (let s = 1; s <= BUILD_STAGES; s++) {
    assert.ok(seen.has(s), `stage ${s} was skipped`);
  }
});

test('a building takes real time to go up', () => {
  const w = flatWorld(20);
  const i = readyPlot(w, 8, 8);
  const rng = makeRng(7);
  let started = -1;
  for (let k = 0; k < 4000 && w.level[i] === 0; k++) {
    updateGrowth(w, rng);
    updateDevelopment(w, rng);
    w.tick++;
    if (started < 0 && w.stage[i]) started = k;
  }
  assert.ok(w.level[i] === 1, 'it should finish eventually');
  assert.ok(w.tick - started > BUILD_STAGES * 4,
    `construction took ${w.tick - started} ticks, which is not long enough to watch`);
});

test('work stops when a site loses its road or its power', () => {
  for (const cut of ['road', 'power']) {
    const w = flatWorld(20);
    const i = readyPlot(w, 8, 8);
    const rng = makeRng(3);
    for (let k = 0; k < 200 && !w.stage[i]; k++) updateGrowth(w, rng);
    assert.ok(isSite(w, i));

    if (cut === 'road') w.roadAccess[i] = 0; else w.powered[i] = 0;
    updateDevelopment(w, rng);
    assert.equal(w.stage[i], 0, `a site should be abandoned when it loses ${cut}`);
    assert.equal(w.level[i], 0, 'and nothing should have been finished');
  }
});

test('a finished building records the year it was completed', () => {
  const w = flatWorld(20);
  w.year = 1964;
  const i = readyPlot(w, 8, 8);
  const rng = makeRng(3);
  for (let k = 0; k < 4000 && w.level[i] === 0; k++) {
    updateGrowth(w, rng);
    updateDevelopment(w, rng);
    w.tick++;
  }
  assert.equal(w.level[i], 1);
  assert.equal(w.builtYear(i), 1964);
});

// ------------------------------------------------------------------- saves --

test('lanes and half-built plots survive a save', () => {
  const w = subdivision(30);
  develop(w, 500);
  const rng = makeRng(9);
  for (let k = 0; k < 60; k++) { updateGrowth(w, rng); updateDevelopment(w, rng); w.tick++; }

  const lanes = countLanes(w);
  const sites = w.stage.reduce((n, s) => n + (s ? 1 : 0), 0);
  assert.ok(lanes > 0 && sites > 0, 'the test needs both to exist before saving');

  const back = deserialize(JSON.parse(JSON.stringify(serialize(w))));
  assert.equal(countLanes(back), lanes, 'lanes were lost');
  assert.deepEqual(Array.from(back.stage), Array.from(w.stage), 'sites were lost');
});

test('a city saved before building sites existed loads with none', () => {
  const w = subdivision(30);
  const data = JSON.parse(JSON.stringify(serialize(w)));
  delete data.stage;
  const back = deserialize(data);
  assert.equal(back.stage.reduce((n, s) => n + s, 0), 0);
});

test('bulldozing clears a site as well as a building', () => {
  const w = flatWorld(20);
  const i = readyPlot(w, 8, 8);
  const rng = makeRng(3);
  for (let k = 0; k < 200 && !w.stage[i]; k++) updateGrowth(w, rng);
  assert.ok(isSite(w, i));
  w.clearTile(8, 8);
  assert.equal(w.stage[i], 0);
});
