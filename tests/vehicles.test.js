/**
 * The visible traffic.
 *
 * These cars are decoration in the sense that nothing in the economy depends on
 * them -- but they are decoration that claims to be a read-out of the traffic
 * model, so what is tested here is that the claim holds: they appear where the
 * traffic is, they slow where it saturates, and they stay on the road.
 *
 * The geometry gets the same treatment. A car crossing from one tile to the
 * next has to arrive exactly where it left, or the whole effect falls apart
 * into cars flickering between lanes at every tile boundary, and that seam is
 * far easier to catch in arithmetic than by staring at a moving screen.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world.js';
import { T, ROAD, ROAD_INFO, VEHICLE_FRAME_MS, VEHICLE_BUDGET_SHARE } from '../src/config.js';
import { VehicleField, vehicleLocal, vehicleInterval, DIRS, LANE, MAX_VEHICLES, KIND_SIZE }
  from '../src/sim/vehicles.js';

const OPPOSITE = [2, 3, 0, 1];

/** Flat land with a road grid every four tiles, and traffic on all of it. */
function gridWorld(size = 24, traffic = 40) {
  const w = new World(size, 7);
  w.terrain.fill(T.GRASS);
  w.elevation.fill(10);
  w.tree.fill(0);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (x % 4 === 0 || y % 4 === 0) {
        const i = w.idx(x, y);
        w.road[i] = ROAD.STREET;
        w.traffic[i] = traffic;
      }
    }
  }
  return w;
}

/** A car's position in absolute tile coordinates. */
function absolute(v, world, t) {
  const loc = vehicleLocal(v, t);
  return { x: (v.i % world.size) + loc.x, y: ((v.i / world.size) | 0) + loc.y };
}

// ----------------------------------------------------------------- paths --

test('a car hands off to the next tile at exactly the point it left', () => {
  const w = gridWorld();
  for (let k = 0; k < 4; k++) {
    // Leaving a tile by edge k, and arriving in that neighbour by the edge
    // they share, must be the same point on the map.
    const leaving = { i: w.idx(8, 8), from: OPPOSITE[k], to: k, t: 1 };
    const nx = 8 + DIRS[k][0], ny = 8 + DIRS[k][1];
    const arriving = { i: w.idx(nx, ny), from: OPPOSITE[k], to: k, t: 0 };

    const a = absolute(leaving, w, 1);
    const b = absolute(arriving, w, 0);
    assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9,
      `edge ${k}: left at ${JSON.stringify(a)} but arrived at ${JSON.stringify(b)}`);
  }
});

test('a turn hands off just as cleanly as a straight run', () => {
  const w = gridWorld();
  // Into the tile heading +x, out of it heading +y, then on into that tile.
  const turning = { i: w.idx(8, 8), from: 2, to: 1, t: 1 };
  const next = { i: w.idx(8, 9), from: 3, to: 1, t: 0 };
  const a = absolute(turning, w, 1);
  const b = absolute(next, w, 0);
  assert.ok(Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9);
});

test('a car stays inside its own tile for the whole crossing', () => {
  for (let from = 0; from < 4; from++) {
    for (let to = 0; to < 4; to++) {
      const v = { from, to, t: 0 };
      for (let t = 0; t <= 1.0001; t += 0.05) {
        const p = vehicleLocal(v, t);
        assert.ok(p.x >= -1e-9 && p.x <= 1 + 1e-9 && p.y >= -1e-9 && p.y <= 1 + 1e-9,
          `from ${from} to ${to} at t=${t.toFixed(2)} left the tile`);
      }
    }
  }
});

test('opposing traffic keeps to opposite sides of the centreline', () => {
  // Both cars run along the x axis: one heading +x, one heading -x.
  const east = vehicleLocal({ from: 2, to: 0, t: 0.5 });
  const west = vehicleLocal({ from: 0, to: 2, t: 0.5 });
  assert.ok(east.y > 0.5, 'eastbound should sit south of the centreline');
  assert.ok(west.y < 0.5, 'westbound should sit north of it');
  assert.ok(Math.abs(east.y - 0.5) > LANE * 0.9);
  assert.equal(Math.round((east.y - 0.5) * 1e6), Math.round((0.5 - west.y) * 1e6));
});

test('a car points the way it is going at both ends of the tile', () => {
  const v = { from: 2, to: 1, t: 0 };            // in heading +x, out heading +y
  const start = vehicleLocal(v, 0);
  const end = vehicleLocal(v, 1);
  assert.ok(start.dx > 0 && Math.abs(start.dy) < Math.abs(start.dx));
  assert.ok(end.dy > 0 && Math.abs(end.dx) < Math.abs(end.dy));
});

test('the whole catalogue of cars has a body to draw', () => {
  for (const size of Object.values(KIND_SIZE)) {
    assert.ok(size.length > 0 && size.width > 0 && size.height > 0);
    assert.ok(size.length > size.width, 'a car is longer than it is wide');
  }
});

// ----------------------------------------------------------------- fleet --

test('empty roads get no cars, and ask for no repaint', () => {
  const w = gridWorld(24, 0);
  const fleet = new VehicleField(w);
  assert.equal(fleet.update(33), false);
  assert.equal(fleet.count, 0);
  assert.equal(fleet.target, 0);
});

test('a city with traffic fills its roads', () => {
  const w = gridWorld(24, 60);
  const fleet = new VehicleField(w);
  for (let f = 0; f < 120; f++) fleet.update(33);
  assert.ok(fleet.count > 0, 'no cars appeared on a city full of traffic');
  assert.equal(fleet.count, fleet.target);
});

test('the fleet is sized by how loaded the roads are, not how many there are', () => {
  const quiet = new VehicleField(gridWorld(24, 20));
  const busy = new VehicleField(gridWorld(24, 200));
  quiet.survey();
  busy.survey();
  assert.ok(busy.target > quiet.target * 2,
    `expected a busy city to run more cars: ${busy.target} vs ${quiet.target}`);
});

test('even gridlock stays within the drawing budget', () => {
  const w = gridWorld(48, 65535);
  const fleet = new VehicleField(w);
  for (let f = 0; f < 400; f++) fleet.update(33);
  assert.ok(fleet.count <= MAX_VEHICLES);
  assert.equal(fleet.target, MAX_VEHICLES);
});

test('cars stay on the road, however long they drive', () => {
  const w = gridWorld(24, 60);
  const fleet = new VehicleField(w);
  for (let f = 0; f < 600; f++) {
    fleet.update(33);
    for (const v of fleet.list) {
      assert.ok(v.i >= 0 && v.i < w.size * w.size, 'a car drove off the map');
      assert.ok(w.road[v.i] !== ROAD.NONE, 'a car drove onto open ground');
      assert.ok(v.t >= 0 && v.t < 1);
    }
  }
  assert.ok(fleet.count > 0);
});

test('cars cannot leave the network they started on', () => {
  // A ring of road with no way off it, and a separate road far away.
  const w = gridWorld(24, 0);
  w.road.fill(ROAD.NONE);
  const ring = [];
  for (let k = 0; k < 6; k++) {
    for (const [x, y] of [[2 + k, 2], [2 + k, 7], [2, 2 + k], [7, 2 + k]]) {
      const i = w.idx(x, y);
      w.road[i] = ROAD.STREET;
      w.traffic[i] = 80;
      ring.push(i);
    }
  }
  const inRing = new Set(ring);
  const fleet = new VehicleField(w);
  for (let f = 0; f < 300; f++) {
    fleet.update(33);
    for (const v of fleet.list) assert.ok(inRing.has(v.i), 'a car escaped the ring');
  }
  assert.ok(fleet.count > 0);
});

test('a dead end turns a car around rather than stranding it', () => {
  const w = gridWorld(24, 0);
  w.road.fill(ROAD.NONE);
  for (let x = 3; x <= 8; x++) { const i = w.idx(x, 5); w.road[i] = ROAD.STREET; w.traffic[i] = 90; }
  const fleet = new VehicleField(w);
  const stub = new Set([3, 4, 5, 6, 7, 8].map((x) => w.idx(x, 5)));
  for (let f = 0; f < 400; f++) {
    fleet.update(33);
    for (const v of fleet.list) assert.ok(stub.has(v.i));
  }
  assert.ok(fleet.count > 0, 'a cul-de-sac should still carry cars');
});

test('bulldozing the road takes its cars with it', () => {
  const w = gridWorld(24, 60);
  const fleet = new VehicleField(w);
  for (let f = 0; f < 120; f++) fleet.update(33);
  assert.ok(fleet.count > 0);

  w.road.fill(ROAD.NONE);
  w.traffic.fill(0);
  w.tick++;                                   // the traffic field has moved on
  for (let f = 0; f < 200; f++) fleet.update(33);
  assert.equal(fleet.count, 0, 'cars were still driving on roads that are gone');
});

test('congestion slows the traffic down', () => {
  const distance = (traffic) => {
    const w = gridWorld(24, traffic);
    const fleet = new VehicleField(w);
    for (let f = 0; f < 60; f++) fleet.update(33);   // let the fleet build up
    const before = fleet.list.map((v) => ({ i: v.i, t: v.t }));
    const steps = [];
    for (let k = 0; k < fleet.list.length; k++) {
      const v = fleet.list[k];
      const start = { i: v.i, t: v.t };
      let travelled = 0, last = start.t;
      for (let f = 0; f < 30; f++) {
        fleet.advance(v, 33 / 1000);
        travelled += v.t >= last ? v.t - last : v.t + 1 - last;
        last = v.t;
      }
      steps.push(travelled);
    }
    assert.ok(before.length > 0);
    return steps.reduce((a, b) => a + b, 0) / steps.length;
  };

  const free = distance(10);
  const jammed = distance(ROAD_INFO[ROAD.STREET].capacity);
  assert.ok(jammed < free * 0.45,
    `jammed traffic should crawl: ${jammed.toFixed(3)} vs ${free.toFixed(3)} tiles`);
  assert.ok(jammed > 0, 'jammed traffic should still be moving');
});

test('the speed control carries the traffic with it', () => {
  const w = gridWorld(24, 40);
  const fleet = new VehicleField(w);
  for (let f = 0; f < 60; f++) fleet.update(33);
  const v = fleet.list[0];

  fleet.rate = 0;
  const held = { i: v.i, t: v.t };
  fleet.update(33);
  assert.equal(v.i, held.i);
  assert.equal(v.t, held.t, 'a paused city should not move its cars');
});

test('a long stall does not teleport the fleet', () => {
  const w = gridWorld(24, 40);
  const fleet = new VehicleField(w);
  for (let f = 0; f < 60; f++) fleet.update(33);
  const v = fleet.list[0];
  const before = { ...v };
  fleet.update(60000);                        // a minute in a background tab
  // A quarter second of movement at most, so nothing crosses more than a tile.
  assert.ok(v.t >= 0 && v.t < 1);
  assert.ok(w.road[v.i] !== ROAD.NONE);
  assert.ok(before.i !== undefined);
});

test('a new city starts with empty roads', () => {
  const w = gridWorld(24, 60);
  const fleet = new VehicleField(w);
  for (let f = 0; f < 120; f++) fleet.update(33);
  assert.ok(fleet.count > 0);

  fleet.reset(gridWorld(24, 0));
  assert.equal(fleet.count, 0);
  assert.equal(fleet.update(33), false);
});

// ------------------------------------------------------------- animation --

test('the animation gives way on a city that is expensive to draw', () => {
  const cheap = vehicleInterval(6);
  assert.equal(cheap, VEHICLE_FRAME_MS, 'a cheap scene should animate at the full rate');

  const dear = vehicleInterval(40);
  assert.ok(dear > cheap, 'an expensive scene should animate less often');
  // Never more than the agreed share of the clock spent repainting.
  assert.ok(40 / dear <= VEHICLE_BUDGET_SHARE + 1e-9);

  assert.equal(vehicleInterval(0), VEHICLE_FRAME_MS);
  assert.equal(vehicleInterval(undefined), VEHICLE_FRAME_MS);
  assert.ok(vehicleInterval(80) > vehicleInterval(60));
});
