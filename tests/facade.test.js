/**
 * The facade grammar.
 *
 * A wall is split into bands and bays and filled with openings, all in pixels.
 * The interesting failures are dimensional and none of them throw: openings
 * that overflow their bay, bands that do not add up to the wall, or -- the one
 * that actually happened -- sizing bays by tile span instead of by pixels, so
 * a two-storey cottage covering most of a tile but only twenty-five pixels of
 * wall got a single window the size of a garage door. It rendered perfectly
 * and looked ridiculous, which is exactly the kind of fault a canvas cannot
 * report and arithmetic can.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { facadeStyle, facadePlan, EL } from '../src/render/facade.js';
import { buildingRecipe, massingParts, VARIANTS } from '../src/render/sprites.js';
import { makeRng } from '../src/util.js';

const styleFor = (category, wealth = 1, era = 1, seed = 7) =>
  facadeStyle(makeRng(seed), category, wealth, era);

/** The pixel width of a face, the way the sprite painter measures it. */
const faceWidth = (span) => Math.hypot(span * 32, span * 16);

// ------------------------------------------------------------ dimensions --

test('bands tile the wall exactly, with no gap and no overlap', () => {
  for (const h of [8, 14, 22, 40, 90, 140]) {
    const plan = facadePlan(styleFor('C'), h, faceWidth(0.9), 'C', 1);
    if (!plan.bands.length) continue;
    assert.equal(plan.bands[0].v0, 0, `wall ${h}px does not start at its foot`);
    assert.ok(Math.abs(plan.bands[plan.bands.length - 1].v1 - h) < 1e-6, `wall ${h}px does not reach its top`);
    for (let k = 1; k < plan.bands.length; k++) {
      assert.ok(Math.abs(plan.bands[k].v0 - plan.bands[k - 1].v1) < 1e-6,
        `wall ${h}px has a seam between bands ${k - 1} and ${k}`);
    }
  }
});

test('every opening stays on the wall it is cut into', () => {
  for (const cat of ['R', 'C', 'I']) {
    for (const h of [10, 18, 35, 80, 130]) {
      for (const s of [0.6, 0.9, 1.4]) {
        const w = faceWidth(s);
        const plan = facadePlan(styleFor(cat), h, w, cat, 3);
        for (const e of plan.elements) {
          assert.ok(e.u0 >= -1e-9 && e.u1 <= 1 + 1e-9, `${cat} ${h}x${s}: element off the side (${e.u0}-${e.u1})`);
          assert.ok(e.v0 >= -2 && e.v1 <= h + 1e-6, `${cat} ${h}x${s}: element off the top (${e.v0}-${e.v1} of ${h})`);
          assert.ok(e.u1 > e.u0 && e.v1 > e.v0, `${cat} ${h}x${s}: inside-out element`);
        }
      }
    }
  }
});

test('a small house gets several small windows, not one enormous one', () => {
  // The regression. A level-2 cottage is about 25px of wall and 15px tall.
  const w = faceWidth(0.72);
  let worst = 0, fewest = 99;
  for (let v = 0; v < VARIANTS; v++) {
    const rec = buildingRecipe('R_LOW', 2, v, 1, 1);
    const plan = facadePlan(rec.facade, rec.height, w, 'R', rec.seed);
    const openings = plan.elements.filter((e) => e.kind === EL.WINDOW || e.kind === EL.DOOR);
    fewest = Math.min(fewest, openings.length);
    for (const e of openings) worst = Math.max(worst, (e.u1 - e.u0) * w);
  }
  assert.ok(worst <= 11.5, `widest opening on a house is ${worst.toFixed(1)}px -- that is a garage door`);
  assert.ok(fewest >= 2, `some house faces got only ${fewest} opening(s)`);
});

test('an opening never outgrows its bay', () => {
  for (const cat of ['R', 'C', 'I']) {
    const w = faceWidth(1);
    const style = styleFor(cat);
    const plan = facadePlan(style, 60, w, cat, 5);
    const bayW = w / plan.bays;
    for (const e of plan.elements) {
      if (e.kind === EL.CORNICE || e.kind === EL.STRING || e.kind === EL.PIER) continue;
      assert.ok((e.u1 - e.u0) * w <= bayW + 1e-6,
        `${cat}: a ${((e.u1 - e.u0) * w).toFixed(1)}px opening in a ${bayW.toFixed(1)}px bay`);
    }
  }
});

// --------------------------------------------------------------- storeys --

test('a tall wall gets storeys and a short one does not', () => {
  const tall = facadePlan(styleFor('C'), 120, faceWidth(1), 'C', 9);
  const short = facadePlan(styleFor('R'), 11, faceWidth(0.7), 'R', 9);
  assert.ok(tall.floors >= 5, `a 120px wall got ${tall.floors} floors`);
  assert.equal(short.floors, 0, 'an 11px wall should be a single storey');
});

test('the ground storey is not just another floor', () => {
  // Shops on the street, homes behind a door, plant behind a louvre.
  const shop = facadePlan(styleFor('C'), 70, faceWidth(1), 'C', 2);
  assert.ok(shop.elements.some((e) => e.kind === EL.SHOPFRONT), 'a shop with no shopfront');
  assert.ok(shop.elements.some((e) => e.kind === EL.DOOR), 'a shop with no door');

  const house = facadePlan(styleFor('R'), 40, faceWidth(0.8), 'R', 2);
  assert.ok(!house.elements.some((e) => e.kind === EL.SHOPFRONT), 'a house should not have a shopfront');
  assert.ok(house.elements.some((e) => e.kind === EL.DOOR), 'a house with no door');

  const works = facadePlan(styleFor('I'), 46, faceWidth(1), 'I', 2);
  assert.ok(works.elements.some((e) => e.kind === EL.LOUVRE), 'industry with no plant on show');
});

test('a shopfront stands on the pavement, a window floats in its storey', () => {
  const plan = facadePlan(styleFor('C'), 80, faceWidth(1), 'C', 4);
  const front = plan.elements.find((e) => e.kind === EL.SHOPFRONT);
  const win = plan.elements.find((e) => e.kind === EL.WINDOW);
  assert.ok(front.v0 < 2, `shopfront starts ${front.v0.toFixed(1)}px up the wall`);
  assert.ok(win.v0 > 2, 'an upper window should not sit on the ground');
});

// --------------------------------------------------------- differentiation --

test('the same building is drawn the same way every time', () => {
  const a = facadePlan(styleFor('C', 1, 1, 42), 60, faceWidth(1), 'C', 11);
  const b = facadePlan(styleFor('C', 1, 1, 42), 60, faceWidth(1), 'C', 11);
  assert.deepEqual(a, b);
});

test('neighbours on one street get visibly different walls', () => {
  // The whole point of the change: sixteen variants of the same zone, level,
  // wealth and period used to differ only in paint, because every one of them
  // got the same window grid.
  for (const [zone, level, cat] of [['C_HIGH', 1, 'C'], ['R_LOW', 2, 'R'], ['I_LIGHT', 1, 'I']]) {
    const seen = new Set();
    for (let v = 0; v < VARIANTS; v++) {
      const rec = buildingRecipe(zone, level, v, 0, 0);
      const part = massingParts(rec)[0];
      const plan = facadePlan(rec.facade, part.h, faceWidth(part.s), cat, rec.seed);
      // What the eye actually picks up: rhythm, storey count, what is on the
      // ground floor, and whether it is crowned.
      seen.add([
        plan.bays, plan.floors,
        plan.elements.filter((e) => e.kind === EL.CORNICE).length,
        plan.elements.length,
      ].join('/'));
    }
    assert.ok(seen.size >= 6,
      `${zone} level ${level}: only ${seen.size} distinct facades across ${VARIANTS} variants`);
  }
});

test('wealth and period each change how a wall is put together', () => {
  // Held at one period, money buys a deeper cornice and a wider opening.
  const poor = styleFor('R', 0, 1, 3);
  const rich = styleFor('R', 2, 1, 3);
  assert.ok(rich.corniceH > poor.corniceH, 'money should buy a deeper cornice');
  assert.ok(rich.openU > poor.openU, 'money should buy more glass');
  assert.ok(rich.blankRate < poor.blankRate, 'cheap stock has more blank wall');

  // Held at one budget, the period moves the cornice the other way -- a
  // modern building drops it, which is the whole visual signature of the era.
  const edwardian = styleFor('R', 1, 0, 3);
  const modern = styleFor('R', 1, 3, 3);
  assert.ok(edwardian.corniceH > modern.corniceH, 'the period should decide the crown');
  assert.ok(modern.bayPitch > edwardian.bayPitch, 'later buildings should have a wider rhythm');
});

test('a wall too small to hold anything is left alone rather than scribbled on', () => {
  const plan = facadePlan(styleFor('R'), 3, faceWidth(0.5), 'R', 1);
  assert.equal(plan.elements.length, 0);
  assert.equal(plan.bands.length, 0);
});
