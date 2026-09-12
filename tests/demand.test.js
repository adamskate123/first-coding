/**
 * RCI demand.
 *
 * The model is a set of pushes and pulls on three numbers, which makes it easy
 * to write and hard to trust: a term can be quietly wrong for a whole class of
 * cities without anything looking broken. These pin down the cases a player
 * would notice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { updateDemand, WORKFORCE_RATIO } from '../src/sim/demand.js';

/** A city with nothing remarkable about it, ready to be pushed out of shape. */
function city(stats = {}) {
  return {
    tax: { R: 9, C: 9, I: 9 },
    demand: { R: 0, C: 0, I: 0 },
    stats: {
      population: 12000, jobsC: 2200, jobsI: 2400, jobsS: 0, jobs: 4600,
      approval: 55, avgPollution: 2, congestion: 0.2, brownoutShare: 0,
      jobAccess: 1, unemployment: 0,
      ...stats,
    },
  };
}

/** Run to a steady state; demand eases towards its target rather than jumping. */
function settle(world, n = 300) {
  for (let k = 0; k < n; k++) updateDemand(world);
  return world.demand;
}

test('idle workers pull commerce and industry up', () => {
  // The reported fault: a city sitting on a seventh of its workforce out of
  // work, with industrial demand flat and nothing on screen to explain it.
  // Demand was worked out sector by sector against population, so once each
  // sector had its share of jobs, nothing wanted to expand however many people
  // had nowhere to go.
  const pop = 17790;
  const short = city({ population: pop, jobsC: 3700, jobsI: 3877, jobs: 7577 });
  const full = city({ population: pop, jobsC: 3700, jobsI: 3877, jobs: pop * WORKFORCE_RATIO });

  const idle = settle(short);
  const employed = settle(full);

  assert.ok(idle.I > 0.2, `industry should want to expand, got ${idle.I.toFixed(2)}`);
  assert.ok(idle.I > employed.I + 0.15, 'and want it more than a city in full employment does');
  assert.ok(idle.C > employed.C, 'commerce too, though less strongly');
});

test('the strongest driver of each bar is named', () => {
  const w = city({ population: 17790, jobsC: 3700, jobsI: 3877, jobs: 7577 });
  settle(w);
  for (const k of ['R', 'C', 'I']) {
    assert.ok(w.demand.why[k].length > 0, `${k} has no explanation`);
  }
  assert.equal(w.demand.why.I[0].label, 'Workers available',
    'the answer to "how do I grow industry" should be the first thing it says');
});

test('a driver is reported with the sign it actually contributes', () => {
  // Penalties used to be recorded as magnitudes and subtracted at the call
  // site, so a city choking on its own smoke was told "Pollution +0.31".
  const w = city({ avgPollution: 90, brownoutShare: 0.4, congestion: 0.95, jobAccess: 0.5 });
  settle(w);
  const find = (k, label) => w.demand.why[k].find((t) => t.label === label);
  assert.ok(find('R', 'Pollution').v < 0, 'pollution pushes residential demand down');
  assert.ok(find('R', 'Power shortage').v < 0);
  assert.ok(find('C', 'Gridlock').v < 0);
  assert.ok(find('I', 'Workers cannot reach it').v < 0);
});

test('every listed driver is a real number with a name', () => {
  const w = city({ population: 400, jobs: 40, jobsC: 20, jobsI: 20 });
  settle(w);
  for (const k of ['R', 'C', 'I']) {
    for (const term of w.demand.why[k]) {
      assert.equal(typeof term.label, 'string');
      assert.ok(term.label.length > 0);
      assert.ok(Number.isFinite(term.v), `${term.label} is ${term.v}`);
      assert.ok(Math.abs(term.v) >= 0.02, 'terms too small to matter are not listed');
    }
  }
});

test('drivers are listed strongest first', () => {
  const w = city({ population: 17790, jobs: 7577 });
  settle(w);
  for (const k of ['R', 'C', 'I']) {
    const mags = w.demand.why[k].map((t) => Math.abs(t.v));
    const sorted = [...mags].sort((a, b) => b - a);
    assert.deepEqual(mags, sorted, `${k} is not in order of influence`);
  }
});

test('over-taxing a sector hollows it out without touching the others', () => {
  const base = settle(city());
  const taxed = city();
  taxed.tax.I = 19;
  const heavy = settle(taxed);
  assert.ok(heavy.I < base.I - 0.2, 'industry should flee a punitive rate');
  assert.ok(Math.abs(heavy.R - base.R) < 0.1, 'residents should barely notice');
});

test('demand drifts rather than jumping', () => {
  const w = city();
  updateDemand(w);
  const first = w.demand.I;
  assert.ok(Math.abs(first) < 0.4, 'one tick should not swing the bar to its target');
});
