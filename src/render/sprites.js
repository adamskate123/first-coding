/**
 * Procedural building art.
 *
 * Every structure is assembled from isometric volumes drawn at runtime -- no
 * image assets, so the whole game stays a handful of text files. Each sprite is
 * rasterised once into an offscreen canvas and cached by shape, so the cost is
 * paid on the frame a building first appears and never again.
 *
 * Geometry convention: a tile's *origin* is the top corner of its rhombus. A
 * span-N footprint is a rhombus N*TILE_W wide and N*TILE_H tall, centred
 * horizontally on that origin:
 *
 *        top (0, 0)
 *        /        \
 *   left            right  (+-N*W/2, N*H/2)
 *        \        /
 *       bottom (0, N*H)
 */

import { TILE_W, TILE_H, BUILDINGS } from '../config.js';
import { BUILDING_PALETTES, TREE_COLORS, FACE, shade } from './palette.js';
import { hash2 } from '../util.js';

const cache = new Map();
const PAD = 8;

/** Building heights in pixels, indexed by development level. */
const ZONE_HEIGHTS = {
  R_LOW: [0, 13, 17, 22],
  R_HIGH: [0, 24, 42, 70, 108],
  C_LOW: [0, 15, 21, 28],
  C_HIGH: [0, 28, 50, 84, 126],
  I_LIGHT: [0, 17, 23, 29],
  I_HEAVY: [0, 25, 34, 47],
};

function makeCanvas(w, h) {
  const c = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
  return c;
}

// ------------------------------------------------------------- primitives --

/** Trace the rhombus of a span-N footprint, lifted by `lift` pixels. */
function rhombus(ctx, ox, oy, span, lift = 0) {
  const w2 = (span * TILE_W) / 2;
  const h2 = (span * TILE_H) / 2;
  ctx.beginPath();
  ctx.moveTo(ox, oy - lift);
  ctx.lineTo(ox + w2, oy + h2 - lift);
  ctx.lineTo(ox, oy + h2 * 2 - lift);
  ctx.lineTo(ox - w2, oy + h2 - lift);
  ctx.closePath();
}

/**
 * A solid isometric box: roof, front-left face, front-right face.
 * Returns the geometry so callers can decorate the faces.
 */
function isoBox(ctx, ox, oy, span, height, colors) {
  const w2 = (span * TILE_W) / 2;
  const h2 = (span * TILE_H) / 2;
  const bottom = { x: ox, y: oy + h2 * 2 };
  const left = { x: ox - w2, y: oy + h2 };
  const right = { x: ox + w2, y: oy + h2 };

  // front-left face
  ctx.fillStyle = shade(colors.wall, FACE.left);
  ctx.beginPath();
  ctx.moveTo(left.x, left.y);
  ctx.lineTo(bottom.x, bottom.y);
  ctx.lineTo(bottom.x, bottom.y - height);
  ctx.lineTo(left.x, left.y - height);
  ctx.closePath();
  ctx.fill();

  // front-right face
  ctx.fillStyle = shade(colors.wall, FACE.right);
  ctx.beginPath();
  ctx.moveTo(bottom.x, bottom.y);
  ctx.lineTo(right.x, right.y);
  ctx.lineTo(right.x, right.y - height);
  ctx.lineTo(bottom.x, bottom.y - height);
  ctx.closePath();
  ctx.fill();

  // roof
  ctx.fillStyle = colors.roof;
  rhombus(ctx, ox, oy, span, height);
  ctx.fill();

  return { bottom, left, right, w2, h2, height };
}

/**
 * Lay a grid of windows across one face.
 * `anchor` is the face's lower corner, `du` the vector along its base.
 */
function windows(ctx, anchor, du, height, cols, rows, color, seedBase, lit) {
  if (cols < 1 || rows < 1 || height < 8) return;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // Leave a scattering of windows dark so facades aren't uniform.
      const h = hash2(c, r, seedBase);
      if ((h & 7) === 0) continue;
      const on = lit && (h & 3) !== 0;

      const u0 = (c + 0.22) / cols, u1 = (c + 0.78) / cols;
      const v0 = height * ((r + 0.24) / rows), v1 = height * ((r + 0.76) / rows);
      ctx.fillStyle = on ? shade(color, 1.35) : shade(color, 0.75);
      ctx.beginPath();
      ctx.moveTo(anchor.x + du.x * u0, anchor.y + du.y * u0 - v0);
      ctx.lineTo(anchor.x + du.x * u1, anchor.y + du.y * u1 - v0);
      ctx.lineTo(anchor.x + du.x * u1, anchor.y + du.y * u1 - v1);
      ctx.lineTo(anchor.x + du.x * u0, anchor.y + du.y * u0 - v1);
      ctx.closePath();
      ctx.fill();
    }
  }
}

/** Hipped roof: four triangles meeting at a central apex. */
function hipRoof(ctx, ox, oy, span, lift, rise, color) {
  const w2 = (span * TILE_W) / 2;
  const h2 = (span * TILE_H) / 2;
  const top = { x: ox, y: oy - lift };
  const right = { x: ox + w2, y: oy + h2 - lift };
  const bottom = { x: ox, y: oy + h2 * 2 - lift };
  const left = { x: ox - w2, y: oy + h2 - lift };
  const apex = { x: ox, y: oy + h2 - lift - rise };

  const face = (a, b, tint) => {
    ctx.fillStyle = shade(color, tint);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(apex.x, apex.y);
    ctx.closePath(); ctx.fill();
  };
  face(left, top, 0.9);      // back-left
  face(top, right, 0.78);    // back-right
  face(left, bottom, 1.06);  // front-left, catches the light
  face(bottom, right, 0.7);  // front-right
}

// --------------------------------------------------------------- sprites --

/**
 * Sprite for a developed zone tile.
 * Returns { canvas, ox, oy } where (ox, oy) is the offset from the tile origin
 * to the sprite's top-left corner.
 */
export function zoneSprite(zoneKey, level, variant, lit) {
  const key = `z:${zoneKey}:${level}:${variant}:${lit ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const heights = ZONE_HEIGHTS[zoneKey];
  const baseH = heights[level] || heights[heights.length - 1];
  const palettes = BUILDING_PALETTES[zoneKey];
  const colors = palettes[variant % palettes.length];

  const lowRise = zoneKey === 'R_LOW' || zoneKey === 'C_LOW';
  const roofRise = lowRise ? Math.round(baseH * 0.5) : 0;
  const totalH = baseH + roofRise + 12;

  const w = TILE_W + PAD * 2;
  const h = TILE_H + totalH + PAD * 2;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const ox = w / 2;
  const oy = totalH + PAD;

  // Suburban stock sits back from the lot line; towers fill it.
  const span = lowRise ? 0.78 : 0.94;
  const seed = hash2(variant, level, zoneKey.length * 31);

  const box = isoBox(ctx, ox, oy + (1 - span) * TILE_H * 0.5, span, baseH, colors);

  const floors = Math.max(1, Math.round(baseH / (lowRise ? 11 : 13)));
  const cols = Math.max(1, Math.round(span * (lowRise ? 2 : 3)));
  windows(ctx, box.left, { x: box.w2, y: box.h2 }, baseH, cols, floors, colors.win, seed, lit);
  windows(ctx, box.bottom, { x: box.w2, y: -box.h2 }, baseH, cols, floors, colors.win, seed + 91, lit);

  if (lowRise) {
    hipRoof(ctx, ox, oy + (1 - span) * TILE_H * 0.5, span, baseH, roofRise, colors.roof);
  } else {
    rooftopClutter(ctx, ox, oy + (1 - span) * TILE_H * 0.5, span, baseH, colors, seed);
  }

  const sprite = { canvas, ox: -ox, oy: -oy };
  cache.set(key, sprite);
  return sprite;
}

/** Vents, stair housings and a parapet -- the details that sell a flat roof. */
function rooftopClutter(ctx, ox, oy, span, height, colors, seed) {
  const w2 = (span * TILE_W) / 2;
  const h2 = (span * TILE_H) / 2;

  // parapet
  ctx.strokeStyle = shade(colors.roof, 0.72);
  ctx.lineWidth = 1.5;
  rhombus(ctx, ox, oy, span, height);
  ctx.stroke();

  const count = 1 + (seed % 3);
  for (let k = 0; k < count; k++) {
    const hx = hash2(k, seed, 17) / 4294967296;
    const hy = hash2(k, seed, 29) / 4294967296;
    // Keep clutter inside the roof rhombus: |u| + |v| <= 1 in rhombus space.
    const u = (hx - 0.5) * 1.1, v = (hy - 0.5) * 1.1;
    if (Math.abs(u) + Math.abs(v) > 0.62) continue;
    const cx = ox + u * w2 + v * w2;
    const cy = oy + h2 - height + (u * h2 - v * h2);
    const bh = 3 + (seed >> (k * 3)) % 5;
    isoBox(ctx, cx, cy - h2 * 0.18, span * 0.22, bh, { wall: colors.roof, roof: shade(colors.roof, 1.12) });
  }
}

/** Sprite for a placed service building. */
export function buildingSprite(type, lit) {
  const key = `b:${type}:${lit ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const spec = BUILDINGS[type];
  const span = spec.span;
  const height = spec.height;
  const totalH = height + span * 14 + 20;   // headroom for stacks and clutter

  const w = span * TILE_W + PAD * 2;
  const h = span * TILE_H + totalH + PAD * 2;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const ox = w / 2;
  const oy = totalH + PAD;

  if (spec.category === 'park') {
    drawPark(ctx, ox, oy, span);
  } else {
    const colors = { wall: spec.color, roof: shade(spec.color, 0.86), win: '#cfe0e6' };
    const box = isoBox(ctx, ox, oy, span * 0.9, height, colors);
    // Two storeys of windows on anything tall enough to have them.
    const rows = Math.max(1, Math.round(height / 15));
    windows(ctx, box.left, { x: box.w2, y: box.h2 }, height, span * 2, rows, colors.win, 5, lit);
    windows(ctx, box.bottom, { x: box.w2, y: -box.h2 }, height, span * 2, rows, colors.win, 41, lit);
    rooftopClutter(ctx, ox, oy, span * 0.9, height, colors, type.length * 37 + span);
    if (spec.supply) drawStacks(ctx, ox, oy, span, height, spec);
  }

  const sprite = { canvas, ox: -ox, oy: -oy };
  cache.set(key, sprite);
  return sprite;
}

function drawPark(ctx, ox, oy, span) {
  ctx.fillStyle = '#5c8a3f';
  rhombus(ctx, ox, oy, span, 0);
  ctx.fill();
  ctx.strokeStyle = '#4a7333';
  ctx.lineWidth = 1;
  ctx.stroke();
  // a path and a couple of trees
  ctx.strokeStyle = '#b6a986';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(ox - span * TILE_W * 0.3, oy + span * TILE_H * 0.5);
  ctx.lineTo(ox + span * TILE_W * 0.3, oy + span * TILE_H * 0.5);
  ctx.stroke();
  drawTreeAt(ctx, ox - span * 8, oy + span * TILE_H * 0.32, 0);
  drawTreeAt(ctx, ox + span * 7, oy + span * TILE_H * 0.68, 1);
}

/** Cooling stacks give power plants their unmistakable silhouette. */
function drawStacks(ctx, ox, oy, span, height, spec) {
  if (spec.supply <= 0) return;
  const stackH = spec.pollution > 10 ? 34 : 16;
  const positions = [[-0.22, -0.1], [0.16, 0.14]];
  for (const [u, v] of positions) {
    const cx = ox + (u + v) * (span * TILE_W) / 2;
    const cy = oy + (span * TILE_H) / 2 - height + (u - v) * (span * TILE_H) / 2;
    isoBox(ctx, cx, cy, span * 0.2, stackH, { wall: '#9a9188', roof: '#3a352f' });
  }
}

/** A single tree, used for both terrain scatter and park decoration. */
export function treeSprite(variant) {
  const key = `t:${variant}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const w = 26, h = 34;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  drawTreeAt(ctx, w / 2, h - 6, variant);
  const sprite = { canvas, ox: -w / 2, oy: -(h - 6 - TILE_H / 2) };
  cache.set(key, sprite);
  return sprite;
}

function drawTreeAt(ctx, x, baseY, variant) {
  const c = TREE_COLORS[variant % TREE_COLORS.length];
  ctx.fillStyle = c.trunk;
  ctx.fillRect(x - 1, baseY - 7, 2, 7);
  ctx.fillStyle = c.canopy;
  ctx.beginPath();
  ctx.ellipse(x, baseY - 12, 7, 8, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = c.shade;
  ctx.beginPath();
  ctx.ellipse(x + 2.2, baseY - 10, 4.4, 5.4, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Drop cached sprites (called when the lighting mode flips day/night). */
export function clearSpriteCache() { cache.clear(); }
