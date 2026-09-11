/**
 * Simulation tests.
 *
 * These exercise the headless half of the game -- everything under src/sim
 * plus the world model and projection maths. Nothing here touches the DOM, so
 * the whole suite runs under plain `node --test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world.js';
import { Z, ROAD, T, ZONE_INFO, WEALTH_THRESHOLDS, WEALTH_HYSTERESIS } from '../src/config.js';
import { updateRoadAccess, updatePower } from '../src/sim/networks.js';
import { updateCoverage, updateLandValue, updatePollution } from '../src/sim/fields.js';
import { updateTraffic } from '../src/sim/traffic.js';
import { updateGrowth, tallyCity, wealthTier } from '../src/sim/growth.js';
import { monthlyBudget } from '../src/sim/economy.js';
import { Simulation } from '../src/sim/index.js';
import { tileToWorld, worldToTile } from '../src/iso.js';
import { serialize, deserialize } from '../src/save.js';
import { makeRng } from '../src/util.js';
import { anchorX, anchorY } from '../src/render/renderer.js';

/** A small flat map with no water, so tests aren't at the mercy of terrain. */
function flatWorld(size = 24) {
  const w = new World(size, 42);
  w.terrain.fill(T.GRASS);
  w.elevation.fill(12);
  w.tree.fill(0);
  w._waterDist = null;
  return w;
}

/** Run the full pipeline enough times for the fields to settle. */
function settle(world, ticks = 90) {
  const sim = new Simulation(world);
  for (let i = 0; i < ticks; i++) sim.step();
  return sim;
}

// ------------------------------------------------------------ projection --

test('isometric projection round-trips on flat ground', () => {
  for (const [x, y] of [[0, 0], [5, 3], [17, 22], [63, 1]]) {
    const p = tileToWorld(x, y, 0);
    const back = worldToTile(p.x, p.y);
    assert.equal(Math.round(back.x), x);
    assert.equal(Math.round(back.y), y);
  }
});

test('elevation lifts a tile up the screen without moving it sideways', () => {
  const flat = tileToWorld(10, 10, 0);
  const high = tileToWorld(10, 10, 8);
  assert.equal(flat.x, high.x);
  assert.ok(high.y < flat.y, 'raised tiles draw higher on screen');
});

// ------------------------------------------------------------- generation --

test('terrain generation is deterministic for a given seed', () => {
  const a = new World(32, 12345);
  const b = new World(32, 12345);
  const c = new World(32, 999);
  assert.deepEqual(Array.from(a.elevation), Array.from(b.elevation));
  assert.notDeepEqual(Array.from(a.elevation), Array.from(c.elevation));
});

test('water tiles are never buildable', () => {
  const w = new World(32, 7);
  let checked = 0;
  for (let i = 0; i < w.terrain.length; i++) {
    if (w.terrain[i] === T.WATER) {
      const x = i % w.size, y = (i / w.size) | 0;
      assert.equal(w.isBuildable(x, y), false);
      checked++;
    }
  }
  assert.ok(checked > 0, 'the generator should produce some water');
});

// ---------------------------------------------------------- road access ---

test('road access reaches ROAD_REACH tiles and no further', () => {
  const w = flatWorld();
  w.road[w.idx(10, 10)] = ROAD.STREET;
  updateRoadAccess(w);

  assert.equal(w.roadAccess[w.idx(10, 10)], 1);
  assert.equal(w.roadAccess[w.idx(13, 10)], 1, '3 tiles away is in reach');
  assert.equal(w.roadAccess[w.idx(14, 10)], 0, '4 tiles away is not');
});

// --------------------------------------------------------------- power ----

test('power does not jump between unconnected networks', () => {
  const w = flatWorld();
  // A plant wired to one house. The plant is 3x3 and occupies rows 2-4, so the
  // run of line has to start at row 5 -- leave a gap and the house goes dark.
  w.placeBuilding('coal', 2, 2);
  w.powerLine[w.idx(2, 5)] = 1;
  w.powerLine[w.idx(2, 6)] = 1;
  w.powerLine[w.idx(2, 7)] = 1;
  w.zone[w.idx(2, 8)] = Z.R_LOW;
  w.level[w.idx(2, 8)] = 1;
  // ...and a second house far away with no connection at all.
  w.zone[w.idx(20, 20)] = Z.R_LOW;
  w.level[w.idx(20, 20)] = 1;

  updatePower(w);

  assert.equal(w.powered[w.idx(2, 8)], 1, 'the wired house has power');
  assert.equal(w.powered[w.idx(20, 20)], 0, 'the isolated house does not');
  assert.notEqual(w.netId[w.idx(2, 8)], w.netId[w.idx(20, 20)]);
});

test('a single missing tile of line breaks the connection', () => {
  const w = flatWorld();
  w.placeBuilding('coal', 2, 2);
  w.powerLine[w.idx(2, 6)] = 1;      // note the gap at row 5
  w.powerLine[w.idx(2, 7)] = 1;
  w.zone[w.idx(2, 8)] = Z.R_LOW;
  w.level[w.idx(2, 8)] = 1;

  updatePower(w);
  assert.equal(w.powered[w.idx(2, 8)], 0, 'power does not jump the gap');
});

test('a network browns out when demand exceeds its own supply', () => {
  const w = flatWorld(40);
  w.placeBuilding('coal', 0, 0);           // 6000 units of supply
  // Wire up far more high-density demand than one plant can carry.
  for (let y = 4; y < 36; y++) {
    for (let x = 0; x < 36; x++) {
      const i = w.idx(x, y);
      w.zone[i] = Z.R_HIGH;
      w.level[i] = 4;                       // 145 units each
    }
  }
  w.powerLine[w.idx(0, 3)] = 1;
  updatePower(w);

  assert.ok(w.stats.powerDemand > w.stats.powerSupply);
  assert.equal(w.stats.brownout, true);
  assert.equal(w.powered[w.idx(10, 10)], 0, 'an overloaded network carries nobody');
});

test('a power plant on its own network reports supply but no brownout', () => {
  const w = flatWorld();
  w.placeBuilding('gas', 5, 5);
  updatePower(w);
  assert.equal(w.stats.powerSupply, 9500);
  assert.equal(w.stats.brownout, false);
});

// --------------------------------------------------------------- growth ---

test('zoned land will not develop without a road', () => {
  const w = flatWorld();
  const i = w.idx(12, 12);
  w.zone[i] = Z.R_LOW;
  w.powerLine[i] = 1;
  w.placeBuilding('coal', 2, 2);
  w.powerLine[w.idx(3, 6)] = 1;

  settle(w, 120);
  assert.equal(w.level[i], 0, 'no road means no building');
});

test('zoned land will not develop without power', () => {
  const w = flatWorld();
  for (let x = 0; x < 20; x++) w.road[w.idx(x, 11)] = ROAD.STREET;
  const i = w.idx(12, 12);
  w.zone[i] = Z.R_LOW;

  settle(w, 120);
  assert.equal(w.level[i], 0, 'no power means no building');
});

test('a serviced, powered, road-connected lot develops and houses people', () => {
  const w = flatWorld(30);
  for (let x = 0; x < 30; x++) w.road[w.idx(x, 11)] = ROAD.STREET;
  w.placeBuilding('coal', 1, 1);                       // occupies (1..3, 1..3)

  // Wire the plant down and across to the estate, with no gaps -- power only
  // travels between orthogonally adjacent conducting tiles.
  for (let y = 4; y <= 12; y++) w.powerLine[w.idx(1, y)] = 1;
  for (let x = 1; x < 16; x++) w.powerLine[w.idx(x, 12)] = 1;

  for (let x = 4; x < 16; x++) {
    for (let y = 12; y < 15; y++) {
      w.zone[w.idx(x, y)] = Z.R_LOW;
      w.powerLine[w.idx(x, y)] = 1;
    }
  }
  settle(w, 400);

  assert.ok(w.stats.population > 0, `expected residents, got ${w.stats.population}`);
  const built = Array.from(w.level).filter((l) => l > 0).length;
  assert.ok(built > 0, 'at least one lot should be built');
});

test('development stops at the zone type maximum level', () => {
  const w = flatWorld();
  const info = ZONE_INFO[Z.R_LOW];
  const i = w.idx(10, 12);
  w.zone[i] = Z.R_LOW;
  w.level[i] = info.cap.length - 1;
  w.roadAccess[i] = 1;
  w.powered[i] = 1;
  w.landValue[i] = 255;
  w.demand.R = 1;

  const rng = makeRng(1);
  for (let k = 0; k < 200; k++) updateGrowth(w, rng);
  assert.equal(w.level[i], info.cap.length - 1);
});

test('occupancy matches the capacity table for the built level', () => {
  const w = flatWorld();
  const i = w.idx(9, 9);
  w.zone[i] = Z.C_LOW;
  w.level[i] = 2;
  w.roadAccess[i] = 1;
  w.powered[i] = 1;

  const rng = makeRng(3);
  updateGrowth(w, rng);
  tallyCity(w);
  assert.equal(w.jobs[i], ZONE_INFO[Z.C_LOW].cap[2]);
  assert.equal(w.pop[i], 0, 'commercial lots hold jobs, not residents');
});

// -------------------------------------------------------------- fields ----

test('parks raise land value nearby and industry lowers it', () => {
  const w = flatWorld(40);
  updateLandValue(w);
  const baseline = w.landValue[w.idx(10, 10)];

  w.placeBuilding('park', 10, 10);
  w.buildings[w.buildings.length - 1].powered = true;
  updateCoverage(w);
  updateLandValue(w);
  assert.ok(w.landValue[w.idx(11, 11)] > baseline, 'a park lifts its neighbourhood');

  const w2 = flatWorld(40);
  updateLandValue(w2);
  const before = w2.landValue[w2.idx(30, 30)];
  for (let x = 28; x < 34; x++) {
    for (let y = 28; y < 34; y++) {
      w2.zone[w2.idx(x, y)] = Z.I_HEAVY;
      w2.level[w2.idx(x, y)] = 3;
    }
  }
  updatePollution(w2);
  updateLandValue(w2);
  assert.ok(w2.landValue[w2.idx(30, 30)] < before, 'heavy industry poisons the land');
});

test('pollution spreads beyond the tile that emits it', () => {
  const w = flatWorld(40);
  const i = w.idx(20, 20);
  w.zone[i] = Z.I_HEAVY;
  w.level[i] = 3;
  updatePollution(w);
  assert.ok(w.pollution[i] > 0, 'the source is polluted');
  assert.ok(w.pollution[w.idx(22, 20)] > 0, 'and so are its neighbours');
  assert.ok(w.pollution[w.idx(22, 20)] < w.pollution[i], 'but less so with distance');
});

test('service coverage falls off with distance and stops at the radius', () => {
  const w = flatWorld(40);
  w.placeBuilding('police', 20, 20);
  w.buildings[0].powered = true;
  updateCoverage(w);

  const near = w.coverage.police[w.idx(21, 20)];
  const far = w.coverage.police[w.idx(30, 20)];
  const outside = w.coverage.police[w.idx(39, 39)];
  assert.ok(near > far, 'coverage weakens with distance');
  assert.equal(outside, 0, 'and ends at the radius');
});

test('an unpowered police station provides no coverage', () => {
  const w = flatWorld(40);
  w.placeBuilding('police', 20, 20);
  w.buildings[0].powered = false;
  updateCoverage(w);
  assert.equal(w.coverage.police[w.idx(21, 20)], 0);
});

// ------------------------------------------------------------- traffic ----

test('commuter flow concentrates on a single connecting link', () => {
  const w = flatWorld(30);
  // Homes on the left, jobs on the right, joined by one horizontal road.
  for (let x = 2; x < 28; x++) w.road[w.idx(x, 15)] = ROAD.STREET;
  for (let y = 12; y < 15; y++) {
    for (let x = 2; x < 8; x++) { w.zone[w.idx(x, y)] = Z.R_HIGH; w.level[w.idx(x, y)] = 2; w.pop[w.idx(x, y)] = 60; }
  }
  for (let y = 16; y < 19; y++) {
    for (let x = 22; x < 28; x++) { w.zone[w.idx(x, y)] = Z.I_LIGHT; w.level[w.idx(x, y)] = 2; w.jobs[w.idx(x, y)] = 20; }
  }
  updateTraffic(w);

  const midpoint = w.traffic[w.idx(15, 15)];
  const behindHomes = w.traffic[w.idx(3, 15)];
  assert.ok(midpoint > 0, 'the connecting road carries traffic');
  assert.ok(midpoint > behindHomes, 'load builds towards the jobs');
});

test('traffic is zero when homes and jobs are not connected', () => {
  const w = flatWorld(30);
  for (let x = 2; x < 8; x++) w.road[w.idx(x, 10)] = ROAD.STREET;
  for (let x = 22; x < 28; x++) w.road[w.idx(x, 20)] = ROAD.STREET;
  w.zone[w.idx(3, 11)] = Z.R_HIGH; w.level[w.idx(3, 11)] = 2; w.pop[w.idx(3, 11)] = 60;
  w.zone[w.idx(23, 21)] = Z.I_LIGHT; w.level[w.idx(23, 21)] = 2; w.jobs[w.idx(23, 21)] = 20;

  updateTraffic(w);
  assert.equal(w.traffic[w.idx(5, 10)], 0, 'commuters with no route generate no traffic');
});

// -------------------------------------------------------------- economy ---

test('taxes produce revenue and raising the rate raises it', () => {
  const w = flatWorld(20);
  for (let x = 2; x < 12; x++) {
    const i = w.idx(x, 5);
    w.zone[i] = Z.R_LOW;
    w.level[i] = 2;
    w.pop[i] = 14;
    w.landValue[i] = 128;
  }
  tallyCity(w);

  w.tax.R = 5;
  monthlyBudget(w);
  const low = w.stats.income;

  w.tax.R = 15;
  monthlyBudget(w);
  assert.ok(w.stats.income > low, 'a higher rate collects more');
});

test('upkeep is charged for roads and service buildings', () => {
  const w = flatWorld(20);
  for (let x = 0; x < 20; x++) w.road[w.idx(x, 10)] = ROAD.STREET;
  w.placeBuilding('police', 2, 2);
  monthlyBudget(w);
  assert.ok(w.stats.expenses > 0);
  assert.ok(w.stats.breakdown.roadCost > 0);
  assert.ok(w.stats.breakdown.serviceCost > 0);
});

test('the treasury moves by exactly the reported balance', () => {
  const w = flatWorld(20);
  for (let x = 0; x < 20; x++) w.road[w.idx(x, 10)] = ROAD.STREET;
  const before = w.funds;
  const balance = monthlyBudget(w);
  assert.equal(w.funds, before + balance);
});

// -------------------------------------------------------------- bulldoze --

test('bulldozing a multi-tile building frees every tile it occupied', () => {
  const w = flatWorld();
  assert.equal(w.placeBuilding('school', 5, 5), true);   // 3x3
  assert.equal(w.build[w.idx(7, 7)] !== -1, true);

  w.clearTile(6, 6);                                      // hit the middle
  for (let y = 5; y < 8; y++) {
    for (let x = 5; x < 8; x++) assert.equal(w.build[w.idx(x, y)], -1);
  }
  assert.equal([...w.activeBuildings()].length, 0);
});

test('buildings cannot overlap', () => {
  const w = flatWorld();
  assert.equal(w.placeBuilding('police', 5, 5), true);
  assert.equal(w.placeBuilding('police', 6, 6), false, 'overlapping placement is refused');
});

// ---------------------------------------------------------------- saving --

test('a saved city reloads with its authored state intact', () => {
  const w = flatWorld(24);
  for (let x = 0; x < 20; x++) w.road[w.idx(x, 10)] = ROAD.STREET;
  w.zone[w.idx(4, 11)] = Z.C_HIGH;
  w.level[w.idx(4, 11)] = 2;
  w.powerLine[w.idx(4, 12)] = 1;
  w.placeBuilding('coal', 15, 15);
  w.funds = 12345;
  w.year = 1987;
  w.month = 6;
  w.tax.I = 17;

  const restored = deserialize(JSON.parse(JSON.stringify(serialize(w))));

  assert.equal(restored.funds, 12345);
  assert.equal(restored.year, 1987);
  assert.equal(restored.month, 6);
  assert.equal(restored.tax.I, 17);
  assert.equal(restored.road[restored.idx(5, 10)], ROAD.STREET);
  assert.equal(restored.zone[restored.idx(4, 11)], Z.C_HIGH);
  assert.equal(restored.level[restored.idx(4, 11)], 2);
  assert.equal(restored.powerLine[restored.idx(4, 12)], 1);
  assert.deepEqual(Array.from(restored.elevation), Array.from(w.elevation));

  const b = restored.buildingAt(15, 15);
  assert.ok(b, 'the power plant came back');
  assert.equal(b.type, 'coal');
});

test('a reloaded city keeps simulating', () => {
  const w = flatWorld(24);
  for (let x = 0; x < 24; x++) w.road[w.idx(x, 10)] = ROAD.STREET;
  const restored = deserialize(serialize(w));
  assert.doesNotThrow(() => settle(restored, 30));
});

// ------------------------------------------------------------- stability --

test('a full simulation run stays finite and non-negative where it should', () => {
  const w = new World(48, 2024);
  const sim = new Simulation(w);
  for (let i = 0; i < 300; i++) sim.step();

  assert.ok(Number.isFinite(w.funds));
  assert.ok(Number.isFinite(w.stats.approval));
  assert.ok(w.stats.approval >= 0 && w.stats.approval <= 100);
  assert.ok(w.stats.population >= 0);
  for (const k of ['R', 'C', 'I']) {
    assert.ok(w.demand[k] >= -1 && w.demand[k] <= 1, `${k} demand stays in range`);
    assert.ok(Number.isFinite(w.demand[k]));
  }
});

test('the calendar advances a year every twelve months', () => {
  const w = flatWorld(16);
  const sim = new Simulation(w);
  const startYear = w.year;
  for (let m = 0; m < 12; m++) sim.endOfMonth();
  assert.equal(w.year, startYear + 1);
  assert.equal(w.month, 0);
});

// ------------------------------------------------- power sourcing rules ---

test('power lines with no plant attached energise nothing', () => {
  const w = flatWorld();
  for (let x = 0; x < 20; x++) w.road[w.idx(x, 10)] = ROAD.STREET;
  for (let x = 0; x < 20; x++) w.powerLine[w.idx(x, 11)] = 1;
  const i = w.idx(5, 11);
  w.zone[i] = Z.R_LOW;

  updatePower(w);
  assert.equal(w.powered[i], 0, 'a wire is not a generator');

  settle(w, 200);
  assert.equal(w.level[i], 0, 'and nothing grows on an unpowered lot');
});

test('shortfall is reported as a share, not just a flag', () => {
  const w = flatWorld(30);
  // A properly powered district...
  w.placeBuilding('coal', 1, 1);
  for (let y = 4; y < 10; y++) w.powerLine[w.idx(1, y)] = 1;
  for (let x = 1; x < 6; x++) {
    const i = w.idx(x, 10);
    w.zone[i] = Z.R_LOW; w.level[i] = 1; w.powerLine[i] = 1;
  }
  w.powerLine[w.idx(1, 10)] = 1;
  // ...plus one stranded police station.
  w.placeBuilding('police', 25, 25);
  updatePower(w);

  assert.ok(w.stats.brownoutShare > 0, 'the stranded station registers');
  assert.ok(w.stats.brownoutShare < 0.9, 'but it does not read as a total blackout');
  assert.equal(w.powered[w.idx(3, 10)], 1, 'the wired district keeps its power');
});

// ------------------------------------------------------------ stability ---

/** A powered, road-served district with room for all three zone types. */
function districtWorld() {
  const w = flatWorld(60);
  for (let x = 10; x < 50; x++) for (const y of [20, 26, 32]) w.road[w.idx(x, y)] = ROAD.STREET;
  for (let y = 20; y < 33; y++) for (const x of [10, 20, 30, 40]) w.road[w.idx(x, y)] = ROAD.STREET;
  w.placeBuilding('coal', 4, 4);
  for (let y = 7; y <= 21; y++) w.powerLine[w.idx(4, y)] = 1;
  for (let x = 4; x < 50; x++) w.powerLine[w.idx(x, 21)] = 1;

  const zone = (x0, x1, y0, y1, z) => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = w.idx(x, y);
      if (!w.road[i] && w.build[i] === -1) { w.zone[i] = z; w.powerLine[i] = 1; }
    }
  };
  zone(11, 19, 21, 25, Z.R_LOW);
  zone(21, 29, 21, 25, Z.C_LOW);
  zone(31, 39, 21, 25, Z.I_LIGHT);
  zone(11, 19, 27, 31, Z.R_LOW);
  w.funds = 500000;
  return w;
}

test('a built-out city reaches equilibrium instead of oscillating', () => {
  // Regression: growth and decay were once symmetric and ungated, so an
  // oversupplied district would abandon en masse, spike demand, and rebuild --
  // commercial employment cycled between ~200 jobs and zero, forever.
  const w = districtWorld();
  const sim = new Simulation(w);

  for (let t = 0; t < 500; t++) sim.step();   // let it overshoot and settle

  const samples = [];
  for (let t = 0; t < 700; t++) {
    sim.step();
    if (t % 25 === 0) samples.push(w.stats.jobsC);
  }

  const peak = Math.max(...samples);
  const trough = Math.min(...samples);
  assert.ok(peak > 0, 'commercial districts should exist at all');
  assert.ok(trough > peak * 0.5,
    `commercial employment collapsed: peak ${peak}, trough ${trough}`);
});

test('demand settles near equilibrium rather than pinning to the rails', () => {
  const w = districtWorld();
  const sim = new Simulation(w);
  for (let t = 0; t < 900; t++) sim.step();

  for (const k of ['R', 'C', 'I']) {
    assert.ok(Math.abs(w.demand[k]) < 0.85,
      `${k} demand stayed pinned at ${w.demand[k].toFixed(2)}`);
  }
});

test('the built stock stops churning once the market clears', () => {
  const w = districtWorld();
  const sim = new Simulation(w);
  for (let t = 0; t < 700; t++) sim.step();

  const builtAt = () => Array.from(w.level).filter((l) => l > 0).length;
  const before = builtAt();
  for (let t = 0; t < 300; t++) sim.step();
  const after = builtAt();

  assert.ok(Math.abs(after - before) <= Math.max(4, before * 0.1),
    `built stock churned from ${before} to ${after}`);
});

// ------------------------------------------------------------- advisors ---

test('advisors do not repeat the same warning every month', () => {
  // Regression: the duplicate check only looked at the newest log entry, so two
  // standing problems would alternate and both repeat forever.
  const w = flatWorld(16);
  const sim = new Simulation(w);
  w.log.length = 0;

  for (let m = 0; m < 6; m++) {
    sim.notify('Unemployment is high. The city needs jobs.', 'warn');
    sim.notify('Parts of the grid are browning out.', 'bad');
    w.month++;
    if (w.month >= 12) { w.month = 0; w.year++; }
  }

  const unemployment = w.log.filter((m) => m.text.startsWith('Unemployment')).length;
  const brownout = w.log.filter((m) => m.text.startsWith('Parts of the grid')).length;
  assert.equal(unemployment, 1, `unemployment warned ${unemployment} times in 6 months`);
  assert.equal(brownout, 1, `brownout warned ${brownout} times in 6 months`);
});

test('an advisory returns once enough time has passed', () => {
  const w = flatWorld(16);
  const sim = new Simulation(w);
  w.log.length = 0;

  sim.notify('Traffic is at a standstill on the main routes.', 'warn');
  w.year += 2;
  sim.notify('Traffic is at a standstill on the main routes.', 'warn');
  assert.equal(w.log.length, 2, 'a stale warning may be repeated');
});

// ------------------------------------------------------- power spreading --

test('a vacant lot draws power from the developed lot next door', () => {
  // Otherwise an undeveloped tile conducts nothing, so it is never powered, so
  // it never develops -- forcing a pylon onto literally every zoned tile.
  const w = flatWorld(30);
  w.placeBuilding('coal', 1, 1);
  for (let y = 4; y <= 10; y++) w.powerLine[w.idx(1, y)] = 1;
  for (let x = 1; x <= 6; x++) w.powerLine[w.idx(x, 10)] = 1;

  // Zone a block beside the line, with no pylons on it at all.
  for (let x = 2; x <= 6; x++) w.zone[w.idx(x, 11)] = Z.R_LOW;

  updatePower(w);
  assert.equal(w.powered[w.idx(3, 11)], 1, 'the lot beside the line is served');
});

test('the spread is one lot deep, not unlimited', () => {
  const w = flatWorld(30);
  w.placeBuilding('coal', 1, 1);
  for (let y = 4; y <= 10; y++) w.powerLine[w.idx(1, y)] = 1;
  for (let x = 1; x <= 6; x++) w.powerLine[w.idx(x, 10)] = 1;
  for (let y = 11; y <= 14; y++) for (let x = 2; x <= 6; x++) w.zone[w.idx(x, y)] = Z.R_LOW;

  updatePower(w);
  assert.equal(w.powered[w.idx(3, 11)], 1, 'the first row is served');
  assert.equal(w.powered[w.idx(3, 12)], 0, 'the second row waits for the first to build');
});

test('an unpowered grid still serves nothing, however it is zoned', () => {
  const w = flatWorld(30);
  for (let x = 1; x <= 6; x++) w.powerLine[w.idx(x, 10)] = 1;   // no plant
  for (let x = 2; x <= 6; x++) w.zone[w.idx(x, 11)] = Z.R_LOW;

  updatePower(w);
  assert.equal(w.powered[w.idx(3, 11)], 0);
});

// ------------------------------------------------------- render ordering --

test('a multi-tile building is anchored on its viewer-nearest corner', () => {
  // The isometric sweep paints tiles in order of increasing x+y, so a building
  // must be drawn on the footprint tile with the greatest x+y. Anchoring it at
  // the origin lets later ground tiles repaint over its walls.
  const b = { x: 10, y: 20, span: 3 };
  assert.equal(anchorX(b), 12);
  assert.equal(anchorY(b), 22);

  let latest = -Infinity;
  for (let dy = 0; dy < b.span; dy++) {
    for (let dx = 0; dx < b.span; dx++) latest = Math.max(latest, (b.x + dx) + (b.y + dy));
  }
  assert.equal(anchorX(b) + anchorY(b), latest, 'the anchor is the last tile painted');
});

test('a single-tile building anchors on itself', () => {
  const b = { x: 4, y: 7, span: 1 };
  assert.equal(anchorX(b), 4);
  assert.equal(anchorY(b), 7);
});

// ---------------------------------------------------------------- wealth ---

test('wealth tier follows land value', () => {
  const [lower, upper] = WEALTH_THRESHOLDS;
  assert.equal(wealthTier(lower - 40, 0), 0, 'cheap land is a modest neighbourhood');
  assert.equal(wealthTier(lower + 30, 0), 1, 'mid land is comfortable');
  assert.equal(wealthTier(upper + 60, 0), 2, 'expensive land is affluent');
});

test('wealth tier has hysteresis, so a district on a boundary does not flicker', () => {
  // Land value is a diffused field that settles rather than snapping, so a lot
  // sitting on a threshold would otherwise swap building style every few ticks.
  const [lower] = WEALTH_THRESHOLDS;
  const m = WEALTH_HYSTERESIS;
  assert.equal(wealthTier(lower + m - 2, 0), 0, 'just over the line is not enough to rise');
  assert.equal(wealthTier(lower + 2, 1), 1, 'nor enough to fall back once risen');
  assert.equal(wealthTier(lower + m + 5, 0), 1, 'a clear margin does move it up');
  assert.equal(wealthTier(lower - m - 5, 1), 0, 'and a clear margin moves it down');
});

test('all three wealth tiers are reachable from land values a city actually produces', () => {
  // Bands set naively across the full 0-255 range left the top tier
  // unreachable: developed lots top out near 130 in a well-serviced city, so a
  // threshold of 155 meant no city ever grew an affluent quarter.
  const reached = new Set();
  for (let lv = 60; lv <= 140; lv += 2) reached.add(wealthTier(lv, wealthTier(lv, 0)));
  assert.ok(reached.has(0), 'no land value in normal range reads as modest');
  assert.ok(reached.has(1), 'no land value in normal range reads as comfortable');
  assert.ok(reached.has(2), 'affluence is unreachable in a real city');
});

test('wealth never leaves the valid tier range', () => {
  for (let lv = 0; lv <= 255; lv += 5) {
    for (const current of [0, 1, 2]) {
      const t = wealthTier(lv, current);
      assert.ok(t >= 0 && t <= 2, `landValue ${lv} from tier ${current} gave ${t}`);
      assert.ok(Number.isInteger(t));
    }
  }
});

test('a lot that gets richer land eventually presents as richer', () => {
  const w = flatWorld(20);
  const i = w.idx(10, 10);
  w.zone[i] = Z.R_LOW;
  w.level[i] = 1;
  w.roadAccess[i] = 1;
  w.powered[i] = 1;
  w.landValue[i] = 20;

  const rng = makeRng(5);
  updateGrowth(w, rng);
  assert.equal(w.wealth[i], 0);

  w.landValue[i] = 230;
  for (let k = 0; k < 5; k++) updateGrowth(w, rng);
  assert.equal(w.wealth[i], 2, 'the lot caught up with its neighbourhood');
});

test('bulldozing resets a lot to no wealth', () => {
  const w = flatWorld(20);
  const i = w.idx(5, 5);
  w.zone[i] = Z.R_LOW;
  w.level[i] = 2;
  w.wealth[i] = 2;
  w.clearTile(5, 5);
  assert.equal(w.wealth[i], 0);
});
