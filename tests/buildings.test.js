/**
 * Building design recipes.
 *
 * A lot's appearance is derived from its variant number by a pure function, so
 * the thing players actually notice -- whether a street looks like forty copies
 * of one house -- is measurable rather than a matter of taste. These tests
 * assert that variety exists, that it stays within the bounds that keep a
 * neighbourhood coherent, and that it never changes for a given lot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildingRecipe, massingParts, VARIANTS } from '../src/render/sprites.js';
import { buildingPalette, PALETTE_FAMILIES, shade } from '../src/render/palette.js';
import { ZONE_INFO, Z, WEALTH } from '../src/config.js';

/** Every zone key paired with each of its real development levels. */
const CASES = Object.values(Z)
  .filter((z) => z !== Z.NONE)
  .flatMap((z) => {
    const info = ZONE_INFO[z];
    return info.cap.slice(1).map((_, k) => ({ key: info.key, level: k + 1 }));
  });

function recipesFor(key, level, wealth = WEALTH.MIDDLE) {
  return Array.from({ length: VARIANTS }, (_, v) => buildingRecipe(key, level, v, wealth));
}

const TIERS = [WEALTH.POOR, WEALTH.MIDDLE, WEALTH.RICH];

// ---------------------------------------------------------- determinism ---

test('a recipe is the same every time it is asked for', () => {
  for (const { key, level } of CASES) {
    for (let v = 0; v < VARIANTS; v++) {
      assert.deepEqual(buildingRecipe(key, level, v), buildingRecipe(key, level, v));
    }
  }
});

test('different variants give different buildings', () => {
  const a = buildingRecipe('R_LOW', 2, 0);
  const b = buildingRecipe('R_LOW', 2, 1);
  assert.notDeepEqual(a, b);
});

test('an unknown zone key yields no recipe rather than throwing', () => {
  assert.equal(buildingRecipe('NOT_A_ZONE', 1, 0), null);
});

// -------------------------------------------------------------- variety ---

test('a street of one zone and level is not forty copies of one building', () => {
  // Regression: silhouette used to be fixed per zone and level, so only colour
  // and window seed varied and a neighbourhood looked stamped.
  for (const { key, level } of CASES) {
    const silhouettes = new Set(
      recipesFor(key, level).map((r) => [r.massing, r.roof, r.windows, r.height].join('|')),
    );
    assert.ok(silhouettes.size >= 8,
      `${key} level ${level}: only ${silhouettes.size} distinct silhouettes in ${VARIANTS} variants`);
  }
});

test('buildings of the same kind differ in height', () => {
  for (const { key, level } of CASES) {
    const heights = new Set(recipesFor(key, level).map((r) => r.height));
    assert.ok(heights.size >= 4,
      `${key} level ${level}: only ${heights.size} distinct heights`);
  }
});

test('every zone type reaches more than one massing across its levels', () => {
  const byKey = {};
  for (const { key, level } of CASES) {
    byKey[key] ??= new Set();
    for (const r of recipesFor(key, level)) byKey[key].add(r.massing);
  }
  for (const [key, massings] of Object.entries(byKey)) {
    assert.ok(massings.size >= 2, `${key} only ever uses ${[...massings].join(', ')}`);
  }
});

test('colour ways are spread across the family, not stuck on one', () => {
  for (const { key, level } of CASES) {
    for (const wealth of TIERS) {
      const used = new Set(recipesFor(key, level, wealth).map((r) => r.palette));
      assert.ok(used.size >= 3, `${key} level ${level} tier ${wealth}: only ${used.size} colour ways`);
      const family = buildingPalette(key[0], wealth);
      for (const p of used) {
        assert.ok(p >= 0 && p < family.length, `${key}: palette ${p} out of range for tier ${wealth}`);
      }
    }
  }
});

// ---------------------------------------------------------------- wealth --

test('the same lot looks different at different wealth tiers', () => {
  // This is the whole point of the feature: a district that gets richer should
  // visibly change character, not merely get taller.
  for (const { key, level } of CASES) {
    const shapes = TIERS.map((w) => {
      const r = buildingRecipe(key, level, 0, w);
      return [r.massing, r.roof, r.height, r.footprint.toFixed(3)].join('|');
    });
    assert.equal(new Set(shapes).size, 3,
      `${key} level ${level}: wealth tiers produce ${new Set(shapes).size} distinct designs`);
  }
});

test('money buys frontage and plainness is for the poor', () => {
  for (const { key, level } of CASES) {
    const meanFootprint = (w) => {
      const fs = recipesFor(key, level, w).map((r) => r.footprint);
      return fs.reduce((a, b) => a + b, 0) / fs.length;
    };
    assert.ok(meanFootprint(WEALTH.RICH) > meanFootprint(WEALTH.POOR),
      `${key} level ${level}: rich lots are not built larger than poor ones`);

    const plainShare = (w) =>
      recipesFor(key, level, w).filter((r) => r.massing === 'single').length / VARIANTS;
    assert.ok(plainShare(WEALTH.POOR) >= plainShare(WEALTH.RICH),
      `${key} level ${level}: poor stock is not plainer than rich`);
  }
});

test('each wealth tier draws on its own colour family', () => {
  for (const category of ['R', 'C', 'I']) {
    const families = TIERS.map((w) => buildingPalette(category, w));
    const walls = families.map((f) => f.map((c) => c.wall).join(','));
    assert.equal(new Set(walls).size, 3, `${category}: wealth tiers share colour ways`);
  }
});

test('an out-of-range wealth value is clamped rather than breaking', () => {
  for (const bad of [-4, 9, 2.7]) {
    const r = buildingRecipe('R_LOW', 2, 0, bad);
    assert.ok(r.wealth >= 0 && r.wealth <= 2, `wealth ${bad} became ${r.wealth}`);
    const family = buildingPalette('R', r.wealth);
    assert.ok(r.palette < family.length);
  }
});

test('a recipe defaults to the middle tier when wealth is not given', () => {
  assert.deepEqual(buildingRecipe('C_LOW', 2, 3), buildingRecipe('C_LOW', 2, 3, WEALTH.MIDDLE));
});

// ------------------------------------------------------------- coherence --

test('height stays within the jitter band of the level baseline', () => {
  // Variety must not turn a two-storey house into a tower; the growth model
  // and the skyline both depend on level reading as height.
  for (const { key, level } of CASES) {
    const heights = recipesFor(key, level).map((r) => r.height);
    const lo = Math.min(...heights), hi = Math.max(...heights);
    assert.ok(hi / lo < 2.2, `${key} level ${level}: heights range ${lo}-${hi}, too wide`);
    assert.ok(lo >= 6, `${key} level ${level}: ${lo}px is too short to draw`);
  }
});

test('taller levels are still taller than shorter ones on average', () => {
  for (const key of ['R_HIGH', 'C_HIGH', 'R_LOW']) {
    const mean = (lvl) => {
      const hs = recipesFor(key, lvl).map((r) => r.height);
      return hs.reduce((a, b) => a + b, 0) / hs.length;
    };
    assert.ok(mean(2) > mean(1), `${key}: level 2 is not taller than level 1`);
  }
});

test('stacked forms are only used where there is height to carry them', () => {
  for (const { key, level } of CASES) {
    for (const r of recipesFor(key, level)) {
      if (r.massing === 'setback' || r.massing === 'podium') {
        assert.ok(r.height >= 44,
          `${key} level ${level}: ${r.massing} on a ${r.height}px building`);
      }
    }
  }
});

test('pitched roofs never land on towers or stacked masses', () => {
  for (const { key, level } of CASES) {
    for (const r of recipesFor(key, level)) {
      if (r.roof === 'flat') continue;
      assert.ok(r.height <= 60, `${key}: pitched roof on a ${r.height}px building`);
      assert.equal(r.massing === 'setback' || r.massing === 'podium', false,
        `${key}: pitched roof on a stacked mass`);
    }
  }
});

test('detail only appears where it makes sense', () => {
  for (const { key, level } of CASES) {
    for (const r of recipesFor(key, level)) {
      if (r.chimney) assert.notEqual(r.roof, 'flat', `${key}: chimney on a flat roof`);
      if (r.tanks > 0) assert.equal(r.roof, 'flat', `${key}: roof tanks on a pitched roof`);
      if (r.antenna) assert.ok(r.height > 72, `${key}: antenna on a ${r.height}px building`);
    }
  }
});

// -------------------------------------------------------------- massing ---

test('every mass stays inside its own lot', () => {
  // Parts are placed in tile-space offsets; one that overruns would draw into
  // the neighbouring lot and be painted over by it.
  for (const { key, level } of CASES) {
    for (const r of recipesFor(key, level)) {
      for (const p of massingParts(r)) {
        assert.ok(p.u >= 0 && p.v >= 0, `${key}: part at (${p.u}, ${p.v}) starts outside the lot`);
        assert.ok(p.u + p.s <= 1.0001, `${key}: part overruns the lot on u (${p.u} + ${p.s})`);
        assert.ok(p.v + p.s <= 1.0001, `${key}: part overruns the lot on v (${p.v} + ${p.s})`);
        assert.ok(p.s > 0.1, `${key}: part span ${p.s} is too small to see`);
      }
    }
  }
});

test('a stacked building is as tall as its recipe claims', () => {
  for (const { key, level } of CASES) {
    for (const r of recipesFor(key, level)) {
      if (r.massing !== 'setback' && r.massing !== 'podium') continue;
      const parts = massingParts(r);
      const top = Math.max(...parts.map((p) => p.h + p.lift));
      assert.equal(top, r.height, `${key}: stack totals ${top}, recipe says ${r.height}`);
    }
  }
});

test('exactly one mass carries the roof on a stacked form', () => {
  for (const { key, level } of CASES) {
    for (const r of recipesFor(key, level)) {
      if (r.massing !== 'setback' && r.massing !== 'podium') continue;
      const roofed = massingParts(r).filter((p) => p.roofed);
      assert.equal(roofed.length, 1, `${key}: ${roofed.length} masses claim the roof`);
      assert.ok(roofed[0].lift > 0, `${key}: the roof went on the podium, not the tower`);
    }
  }
});

test('split forms produce separate masses, single forms produce one', () => {
  const twin = recipesFor('I_HEAVY', 2).find((r) => r.massing === 'twin');
  if (twin) assert.equal(massingParts(twin).length, 2);

  const single = recipesFor('I_HEAVY', 2).find((r) => r.massing === 'single');
  if (single) assert.equal(massingParts(single).length, 1);
});

// --------------------------------------------------------------- colour ---

test('shading composes, so a detail shaded from a shaded surface stays valid', () => {
  // Regression: shade() only parsed hex, so feeding its own rgb() output back
  // in produced "rgb(NaN,NaN,NaN)". Canvas rejects that *silently* -- the
  // fillStyle assignment is ignored and the previous colour stays in force --
  // which is why chimneys came out painted in the roof's dark trim.
  const once = shade('#8c5a44', 1.12);
  const twice = shade(once, 0.82);
  const thrice = shade(twice, 1.3);

  for (const [label, value] of [['once', once], ['twice', twice], ['thrice', thrice]]) {
    assert.match(value, /^rgb\(\d+,\d+,\d+\)$/, `${label}: ${value} is not a usable colour`);
    assert.ok(!value.includes('NaN'), `${label} produced NaN`);
  }
});

test('shading lightens and darkens in the right direction', () => {
  const lum = (c) => c.match(/\d+/g).map(Number).reduce((a, b) => a + b, 0);
  const base = '#808080';
  assert.ok(lum(shade(base, 1.4)) > lum(shade(base, 1.0)), 'above 1 should lighten');
  assert.ok(lum(shade(base, 0.6)) < lum(shade(base, 1.0)), 'below 1 should darken');
});

test('an unparseable colour degrades to grey rather than to NaN', () => {
  const out = shade('not a colour', 0.8);
  assert.match(out, /^rgb\(\d+,\d+,\d+\)$/);
});

test('every palette entry is a parseable hex colour', () => {
  for (const [family, ways] of Object.entries(PALETTE_FAMILIES)) {
    for (const way of ways) {
      for (const slot of ['wall', 'roof', 'win']) {
        assert.match(way[slot], /^#[0-9a-f]{6}$/i, `${family}.${slot} = ${way[slot]}`);
      }
    }
  }
});
