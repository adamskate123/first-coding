/**
 * The civic catalogue, tested without a canvas.
 *
 * Drawing code is the part of this project a unit test reaches least well, and
 * two of the three faults that have ever shipped in it were invisible rather
 * than loud: a colour string with a channel out of range, which a canvas
 * rejects in silence so the shape comes out in whatever colour was set last;
 * and geometry that ran off the edge of the sprite canvas, which simply
 * guillotines a chimney. A recording stub catches both -- it plays the part of
 * a 2D context, remembers every colour assigned and every coordinate touched,
 * and lets the assertions run in plain node.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILDINGS, TILE_W, TILE_H } from '../src/config.js';
import { civicSprite, CIVIC_HEADROOM } from '../src/render/civic.js';

/** Everything the models actually ask a context for. */
function recorder() {
  const colors = [];
  const box = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity };
  let ops = 0;
  const see = (x, y) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`non-finite point ${x},${y}`);
    box.minX = Math.min(box.minX, x); box.maxX = Math.max(box.maxX, x);
    box.minY = Math.min(box.minY, y); box.maxY = Math.max(box.maxY, y);
  };
  // A gradient is a legitimate paint, so only the string colours are recorded
  // -- including the stops inside a gradient, which are colours like any other.
  const gradient = () => ({ addColorStop(stop, color) { colors.push(color); } });
  const paint = (v) => { if (typeof v === 'string') colors.push(v); };
  const ctx = {
    lineWidth: 1, font: '', textAlign: '', globalAlpha: 1,
    set fillStyle(v) { paint(v); }, get fillStyle() { return '#000'; },
    set strokeStyle(v) { paint(v); }, get strokeStyle() { return '#000'; },
    beginPath() {}, closePath() {}, save() {}, restore() {}, setLineDash() {},
    fill() { ops++; }, stroke() { ops++; },
    moveTo: see, lineTo: see,
    quadraticCurveTo(cx, cy, x, y) { see(cx, cy); see(x, y); },
    bezierCurveTo(a, b, c, d, x, y) { see(a, b); see(c, d); see(x, y); },
    rect(x, y, w, h) { see(x, y); see(x + w, y + h); },
    fillRect(x, y, w, h) { ops++; see(x, y); see(x + w, y + h); },
    arc(x, y, r) { see(x - r, y - r); see(x + r, y + r); },
    ellipse(x, y, rx, ry) { see(x - rx, y - ry); see(x + rx, y + ry); },
    createLinearGradient: gradient, createRadialGradient: gradient,
  };
  return { ctx, colors, box, ops: () => ops };
}

/** Is this something a canvas would actually accept as a paint? */
function validColor(v) {
  if (typeof v !== 'string') return false;
  if (/^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{3}$/.test(v)) return true;
  const m = v.match(/^rgba?\(([^)]+)\)$/);
  if (!m) return false;
  const parts = m[1].split(',').map((s) => Number(s.trim()));
  if (parts.length < 3 || parts.length > 4) return false;
  if (parts.some((n) => !Number.isFinite(n))) return false;
  if (parts.slice(0, 3).some((n) => n < 0 || n > 255)) return false;
  return parts.length === 3 || (parts[3] >= 0 && parts[3] <= 1);
}

/** The sprite canvas buildingSprite would allocate for this type. */
const PAD = 10, FOOT = 22, SIDE = 30;
function sheet(type) {
  const spec = BUILDINGS[type];
  const totalH = spec.height + (CIVIC_HEADROOM[type] || 0) + spec.span * 14 + 20;
  return {
    w: spec.span * TILE_W + PAD * 2 + SIDE * 2,
    h: spec.span * TILE_H + totalH + PAD * 2 + FOOT,
    ox: (spec.span * TILE_W + PAD * 2 + SIDE * 2) / 2,
    oy: totalH + PAD,
  };
}

const TYPES = Object.keys(BUILDINGS);

test('every building in the catalogue has a model of its own', () => {
  for (const type of TYPES) {
    const { ctx } = recorder();
    const s = sheet(type);
    assert.equal(civicSprite(ctx, type, BUILDINGS[type], s.ox, s.oy, false), true,
      `${type} falls back to the generic box`);
  }
});

test('a type with no model says so rather than drawing nothing', () => {
  const { ctx, ops } = recorder();
  assert.equal(civicSprite(ctx, 'observatory', { span: 2, height: 20, color: '#888' }, 50, 50, false), false);
  assert.equal(ops(), 0);
});

test('every model actually draws something substantial', () => {
  for (const type of TYPES) {
    const { ctx, ops } = recorder();
    const s = sheet(type);
    civicSprite(ctx, type, BUILDINGS[type], s.ox, s.oy, false);
    assert.ok(ops() > 12, `${type} drew only ${ops()} shapes`);
  }
});

test('no model ever sets a colour a canvas would reject', () => {
  for (const type of TYPES) {
    for (const lit of [false, true]) {
      const { ctx, colors } = recorder();
      const s = sheet(type);
      civicSprite(ctx, type, BUILDINGS[type], s.ox, s.oy, lit);
      const bad = colors.filter((c) => !validColor(c));
      assert.deepEqual(bad, [], `${type}${lit ? ' (lit)' : ''} used ${bad.join(', ')}`);
    }
  }
});

test('nothing a model draws falls outside its sprite canvas', () => {
  // A chimney or a drill tower reaches well above the height the catalogue
  // records, and the headroom table is the only thing stopping it being cut
  // off. Two pixels of slack for stroke width.
  for (const type of TYPES) {
    const { ctx, box } = recorder();
    const s = sheet(type);
    civicSprite(ctx, type, BUILDINGS[type], s.ox, s.oy, true);
    assert.ok(box.minY >= -2, `${type} draws ${(-box.minY).toFixed(1)}px above its canvas`);
    assert.ok(box.maxY <= s.h + 2, `${type} draws ${(box.maxY - s.h).toFixed(1)}px below its canvas`);
    assert.ok(box.minX >= -2, `${type} draws ${(-box.minX).toFixed(1)}px left of its canvas`);
    assert.ok(box.maxX <= s.w + 2, `${type} draws ${(box.maxX - s.w).toFixed(1)}px right of its canvas`);
  }
});

test('lighting a building changes what it paints', () => {
  // Night is not a tint applied over the top for these: lit windows, the blue
  // lamps on a station, the warning lights on a chimney are all drawn or not.
  for (const type of ['police', 'fire', 'clinic', 'school', 'coal', 'plaza']) {
    const day = recorder(), night = recorder();
    const s = sheet(type);
    civicSprite(day.ctx, type, BUILDINGS[type], s.ox, s.oy, false);
    civicSprite(night.ctx, type, BUILDINGS[type], s.ox, s.oy, true);
    assert.notDeepEqual(day.colors, night.colors, `${type} looks the same at night`);
  }
});

test('a model is a pure function of its inputs', () => {
  // Sprites are cached for the life of a session and shared between every
  // instance, so a model that consulted Math.random would give one police
  // station a different building from the next for no reason.
  for (const type of TYPES) {
    const a = recorder(), b = recorder();
    const s = sheet(type);
    civicSprite(a.ctx, type, BUILDINGS[type], s.ox, s.oy, false);
    civicSprite(b.ctx, type, BUILDINGS[type], s.ox, s.oy, false);
    assert.deepEqual(a.colors, b.colors, `${type} draws differently each time`);
    assert.deepEqual(a.box, b.box, `${type} is not in the same place each time`);
  }
});

test('headroom is declared for every type that needs it', () => {
  for (const type of TYPES) {
    assert.ok(type in CIVIC_HEADROOM, `${type} has no headroom entry`);
    assert.ok(CIVIC_HEADROOM[type] >= 0, `${type} has negative headroom`);
  }
  for (const type of Object.keys(CIVIC_HEADROOM)) {
    assert.ok(type in BUILDINGS, `headroom declared for ${type}, which is not in the catalogue`);
  }
});
