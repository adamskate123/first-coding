/**
 * Which way a building faces.
 *
 * Every lot used to be drawn the same way round regardless of where its street
 * was, so a development came out as boxes dropped on a field rather than as
 * houses along a road. A lot now turns to its frontage, and three things
 * follow from that: the massing rotates, the front wall is the one on the
 * street, and the roof ridge runs parallel to it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { orientParts, setBack, massingParts, buildingRecipe } from '../src/render/sprites.js';
import { facadeStyle, facadePlan, EL } from '../src/render/facade.js';
import { makeRng } from '../src/util.js';

const recipe = (massing) => ({
  ...buildingRecipe('R_LOW', 2, 3, 1, 1),
  massing,
  footprint: 0.8,
  height: 20,
});

/** The bounding box a set of parts occupies within its lot. */
function extent(parts) {
  return {
    u0: Math.min(...parts.map((p) => p.u)),
    u1: Math.max(...parts.map((p) => p.u + p.s)),
    v0: Math.min(...parts.map((p) => p.v)),
    v1: Math.max(...parts.map((p) => p.v + p.s)),
  };
}

test('four quarter turns bring a lot back to where it started', () => {
  for (const massing of ['ell', 'tee', 'twin', 'stepped', 'single']) {
    const parts = massingParts(recipe(massing));
    let turned = parts;
    for (let k = 0; k < 4; k++) turned = orientParts(turned, 1);
    for (let k = 0; k < parts.length; k++) {
      assert.ok(Math.abs(turned[k].u - parts[k].u) < 1e-9, `${massing} u drifted`);
      assert.ok(Math.abs(turned[k].v - parts[k].v) < 1e-9, `${massing} v drifted`);
    }
  }
});

test('turning a lot keeps it inside its own plot', () => {
  for (const massing of ['ell', 'tee', 'twin', 'stepped', 'single']) {
    const parts = massingParts(recipe(massing));
    for (const face of [0, 1, 2, 3]) {
      const e = extent(orientParts(parts, face));
      assert.ok(e.u0 >= -1e-9 && e.v0 >= -1e-9, `${massing} face ${face} runs off the plot`);
      assert.ok(e.u1 <= 1 + 1e-9 && e.v1 <= 1 + 1e-9, `${massing} face ${face} overruns the plot`);
    }
  }
});

test('an asymmetric lot actually turns', () => {
  // A plain box has no front until its walls are painted, so it is expected to
  // come out identical -- but an ell has a wing, and the wing has to move.
  const parts = massingParts(recipe('ell'));
  const turned = orientParts(parts, 1);
  assert.notDeepEqual(turned.map((p) => [p.u, p.v]), parts.map((p) => [p.u, p.v]));
});

test('a building stands back from the street it fronts', () => {
  for (const face of [0, 1, 2, 3]) {
    const parts = massingParts(recipe('single'));
    const before = extent(parts);
    const after = extent(setBack(parts, face));
    const axis = face % 2 === 0 ? 'u' : 'v';
    const sign = face < 2 ? -1 : 1;              // move away from the road
    const moved = axis === 'u' ? after.u0 - before.u0 : after.v0 - before.v0;
    assert.ok(Math.sign(moved) === sign || moved === 0,
      `face ${face} moved the wrong way (${moved})`);
  }
});

test('a setback never pushes a building off its plot', () => {
  for (const massing of ['ell', 'tee', 'twin', 'stepped', 'single']) {
    for (const face of [0, 1, 2, 3]) {
      const e = extent(setBack(orientParts(massingParts(recipe(massing)), face), face));
      assert.ok(e.u0 >= -1e-9 && e.v0 >= -1e-9, `${massing}/${face} off the plot`);
      assert.ok(e.u1 <= 1 + 1e-9 && e.v1 <= 1 + 1e-9, `${massing}/${face} overruns`);
    }
  }
});

// ------------------------------------------------------------------ walls --

const style = facadeStyle(makeRng(4), 'C', 1, 1);
const plan = (front) => facadePlan(style, 30, 40, 'C', 77, front);

test('only the front wall gets the front door', () => {
  const kinds = (p) => new Set(p.elements.map((e) => e.kind));
  assert.ok(kinds(plan(true)).has(EL.DOOR) || kinds(plan(true)).has(EL.SHOPFRONT),
    'the street wall should have a way in');
  assert.ok(!kinds(plan(false)).has(EL.DOOR), 'a flank wall has no front door');
  assert.ok(!kinds(plan(false)).has(EL.SHOPFRONT), 'and no shopfront either');
});

test('a flank is plainer than a front', () => {
  // Counted as openings rather than windows: a shopfront is not a window, so
  // a commercial front can carry fewer windows than its own flank while being
  // very much the busier wall.
  const OPENINGS = [EL.WINDOW, EL.DOOR, EL.SHOPFRONT, EL.BALCONY, EL.LOUVRE];
  const openings = (p) => p.elements.filter((e) => OPENINGS.includes(e.kind)).length;
  for (const cat of ['R', 'C', 'I']) {
    const st = facadeStyle(makeRng(4), cat, 1, 1);
    for (const [h, w] of [[18, 25], [30, 40], [60, 50]]) {
      const front = openings(facadePlan(st, h, w, cat, 77, true));
      const flank = openings(facadePlan(st, h, w, cat, 77, false));
      assert.ok(flank < front,
        `${cat} ${h}x${w}: flank has ${flank} openings to the front's ${front}`);
    }
  }
});

test('a flank is still a wall, not a blank slab', () => {
  const flank = plan(false);
  assert.ok(flank.elements.length > 0, 'a flank with nothing on it reads as a mistake');
  assert.ok(flank.bands.length > 0);
});

test('a wall is drawn the same way every time it is asked for', () => {
  assert.deepEqual(plan(true), plan(true));
  assert.deepEqual(plan(false), plan(false));
});
