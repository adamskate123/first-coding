/**
 * Cursor picking.
 *
 * The tile under the pointer must be the tile that was drawn there. That held
 * while terrain was flat plates, then broke when it started being drawn as
 * sloped quads: picking still tested a flat rhombus at the tile's centre
 * height, so on any slope the cursor selected a neighbouring tile.
 *
 * These are round-trip tests. Project a tile's own drawn surface to a screen
 * position, pick that position, and require the same tile back. They need no
 * canvas, because picking works in world space off the same geometry the
 * renderer draws.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world.js';
import { Camera, pickTile, tileQuad, pointInQuad, tileToWorld } from '../src/iso.js';
import { T, SEA_LEVEL, TILE_W, TILE_H } from '../src/config.js';

function cameraOn(world, tx, ty, zoom = 1) {
  const cam = new Camera(1200, 800);
  cam.centerOn(tx, ty);
  cam.zoom = zoom;
  return cam;
}

/** Middle of a tile's drawn surface, in world space. */
function surfaceCentre(world, x, y) {
  const q = tileQuad(world, x, y);
  return {
    x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  };
}

/** Where that middle lands on screen. */
function screenCentre(world, camera, x, y) {
  const c = surfaceCentre(world, x, y);
  return camera.worldToScreen(c.x, c.y);
}

function flatWorld(size = 30, elevation = 14) {
  const w = new World(size, 4);
  w.terrain.fill(T.GRASS);
  w.elevation.fill(elevation);
  w._corners = null;
  w._waterDist = null;
  return w;
}

// --------------------------------------------------------------- flat ground --

test('clicking the middle of a tile picks that tile, on flat ground', () => {
  const w = flatWorld();
  const cam = cameraOn(w, 15, 15);

  for (let y = 10; y < 21; y++) {
    for (let x = 10; x < 21; x++) {
      const s = screenCentre(w, cam, x, y);
      assert.deepEqual(pickTile(w, cam, s.x, s.y), { x, y },
        `flat ground: click on (${x},${y}) picked elsewhere`);
    }
  }
});

test('picking holds at every zoom level', () => {
  const w = flatWorld();
  for (const zoom of [0.4, 1, 1.7, 2.4]) {
    const cam = cameraOn(w, 15, 15, zoom);
    for (const [x, y] of [[12, 13], [15, 15], [19, 11]]) {
      const s = screenCentre(w, cam, x, y);
      assert.deepEqual(pickTile(w, cam, s.x, s.y), { x, y }, `zoom ${zoom}: (${x},${y})`);
    }
  }
});

// ------------------------------------------------------------------ slopes --

test('clicking the middle of a tile picks that tile, on a slope', () => {
  // The regression: a sloped surface and a flat hit test disagree by up to half
  // the corner height difference, which is several pixels of offset.
  const w = flatWorld(30, 10);
  for (let y = 0; y < 30; y++) {
    for (let x = 0; x < 30; x++) w.elevation[y * 30 + x] = 6 + x;   // a steady ramp
  }
  w._corners = null;
  const cam = cameraOn(w, 15, 15);

  for (let y = 11; y < 20; y++) {
    for (let x = 11; x < 20; x++) {
      const s = screenCentre(w, cam, x, y);
      assert.deepEqual(pickTile(w, cam, s.x, s.y), { x, y },
        `slope: click on (${x},${y}) picked elsewhere`);
    }
  }
});

/**
 * What the renderer would have drawn last at a point: the frontmost tile whose
 * surface contains it. Scans every tile, so it is the reference pickTile's
 * bounded search has to match.
 */
function frontmostTileAt(world, camera, sx, sy) {
  const p = camera.screenToWorld(sx, sy);
  let best = null, bestDepth = -Infinity;
  for (let y = 0; y < world.size; y++) {
    for (let x = 0; x < world.size; x++) {
      if (x + y <= bestDepth) continue;
      if (!pointInQuad(tileQuad(world, x, y), p.x, p.y)) continue;
      best = { x, y };
      bestDepth = x + y;
    }
  }
  return best;
}

test('on real terrain, picking agrees with an exhaustive search', () => {
  // A tile's own middle is not always its own: on a slope a nearer, higher tile
  // is drawn over it, and picking that occluder is correct -- you get what you
  // see. So the invariant is not "a tile picks itself", it is "picking returns
  // whatever the renderer drew last there". This checks the bounded search
  // never misses a tile the exhaustive one finds, which is what would break if
  // the search range were too small for the terrain's height range.
  for (const seed of [3, 77, 424242]) {
    const w = new World(48, seed);
    const cam = cameraOn(w, 24, 24);
    let checked = 0, occluded = 0;

    for (let y = 16; y < 33; y++) {
      for (let x = 16; x < 33; x++) {
        const s = screenCentre(w, cam, x, y);
        const got = pickTile(w, cam, s.x, s.y);
        const want = frontmostTileAt(w, cam, s.x, s.y);
        assert.deepEqual(got, want,
          `seed ${seed}: at (${x},${y}) the bounded search disagreed with the exhaustive one`);
        if (got && (got.x !== x || got.y !== y)) occluded++;
        checked++;
      }
    }
    assert.ok(checked > 200);
    // Sanity: if nothing were ever occluded this test would prove little.
    assert.ok(occluded < checked * 0.5,
      `seed ${seed}: ${occluded} of ${checked} tiles occluded, terrain looks wrong`);
  }
});

test('the tile picked always contains the point clicked', () => {
  for (const seed of [5, 99]) {
    const w = new World(40, seed);
    const cam = cameraOn(w, 20, 20);
    for (let y = 14; y < 27; y++) {
      for (let x = 14; x < 27; x++) {
        const s = screenCentre(w, cam, x, y);
        const hit = pickTile(w, cam, s.x, s.y);
        assert.ok(hit, `seed ${seed}: (${x},${y}) picked nothing`);
        const p = cam.screenToWorld(s.x, s.y);
        assert.ok(pointInQuad(tileQuad(w, hit.x, hit.y), p.x, p.y),
          `seed ${seed}: picked (${hit.x},${hit.y}) which does not contain the click`);
      }
    }
  }
});

test('a raised tile is picked in front of the ground behind it', () => {
  // A hill lifts a tile straight up the screen, so it can cover a tile that
  // would otherwise occupy that position. The nearer one must win.
  const w = flatWorld(30, 8);
  for (let y = 14; y <= 17; y++) {
    for (let x = 14; x <= 17; x++) w.elevation[y * 30 + x] = 26;
  }
  w._corners = null;
  const cam = cameraOn(w, 15, 15);

  const s = screenCentre(w, cam, 16, 16);
  const hit = pickTile(w, cam, s.x, s.y);
  assert.deepEqual(hit, { x: 16, y: 16 }, 'the raised tile was not picked');
  assert.ok(w.elevation[hit.y * 30 + hit.x] === 26, 'picked the low ground behind the hill');
});

// ------------------------------------------------------------------- water --

test('water is picked as the flat plane it is drawn as', () => {
  const w = new World(30, 9);
  w.terrain.fill(T.GRASS);
  w.elevation.fill(14);
  for (let y = 12; y <= 18; y++) {
    for (let x = 12; x <= 18; x++) {
      w.terrain[y * 30 + x] = T.WATER;
      w.elevation[y * 30 + x] = SEA_LEVEL;
    }
  }
  w._corners = null;
  w._waterDist = null;
  const cam = cameraOn(w, 15, 15);

  const q = tileQuad(w, 15, 15);
  const flat = tileToWorld(15, 15, SEA_LEVEL);
  assert.equal(q[0].y, flat.y, 'a water tile is not quadded at sea level');

  const s = screenCentre(w, cam, 15, 15);
  assert.deepEqual(pickTile(w, cam, s.x, s.y), { x: 15, y: 15 });
});

// ------------------------------------------------------------------ bounds --

test('clicking well outside the map picks nothing', () => {
  const w = flatWorld(20);
  const cam = cameraOn(w, 10, 10);
  const far = camera => camera.worldToScreen(0, -100000);
  const s = far(cam);
  assert.equal(pickTile(w, cam, s.x, s.y), null);
});

test('points away from a tile centre still pick correctly', () => {
  // A centre-only test would miss an offset that only shows up near the edges.
  const w = flatWorld(40, 12);
  const cam = cameraOn(w, 20, 20);

  for (let y = 17; y < 24; y++) {
    for (let x = 17; x < 24; x++) {
      const q = tileQuad(w, x, y);
      const centre = surfaceCentre(w, x, y);
      for (let k = 0; k < 4; k++) {
        // Halfway from the middle towards each corner: well inside the tile.
        const px = centre.x + (q[k].x - centre.x) * 0.5;
        const py = centre.y + (q[k].y - centre.y) * 0.5;
        assert.ok(pointInQuad(q, px, py), `(${x},${y}): sample fell outside its own quad`);
        const s = cam.worldToScreen(px, py);
        assert.deepEqual(pickTile(w, cam, s.x, s.y), { x, y },
          `(${x},${y}): a point towards corner ${k} picked a different tile`);
      }
    }
  }
});

// ------------------------------------------------------- geometry is shared --

test('adjacent tiles share the quad edge between them', () => {
  // Picking and drawing read the same corners, so a point on a shared edge
  // belongs to both tiles and never to a gap.
  const w = new World(30, 12);
  for (let y = 2; y < 28; y++) {
    for (let x = 2; x < 28; x++) {
      if (w.terrain[w.idx(x, y)] === T.WATER || w.terrain[w.idx(x + 1, y)] === T.WATER) continue;
      const here = tileQuad(w, x, y);
      const east = tileQuad(w, x + 1, y);
      assert.deepEqual(here[1], east[0], `(${x},${y}) right corner != east neighbour top`);
      assert.deepEqual(here[2], east[3], `(${x},${y}) bottom corner != east neighbour left`);
    }
  }
});
