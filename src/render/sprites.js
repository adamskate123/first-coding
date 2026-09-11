/**
 * Procedural building art.
 *
 * Every structure is assembled from isometric volumes drawn at runtime -- no
 * image assets, so the whole game stays a handful of text files. Each sprite is
 * rasterised once into an offscreen canvas and cached by shape, so the cost is
 * paid on the frame a building first appears and never again.
 *
 * A lot's appearance comes from a *recipe*: a deterministic spec derived from
 * its variant number, choosing massing, roof form, height, window treatment and
 * details. The recipe is a pure function, so it can be tested without a canvas
 * and a given lot looks the same for the life of the city without storing
 * anything about how it was drawn.
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

import { TILE_W, TILE_H, BUILDINGS, ERAS } from '../config.js';
import { buildingPalette, applyEra, TREE_COLORS, FACE, shade } from './palette.js';
import { hash2, makeRng, clamp, createLruCache } from '../util.js';

const PAD = 10;

/**
 * Sprite cache, bounded.
 *
 * The key space is zone type x level x variant x wealth x era x lit -- over ten
 * thousand combinations. A session will only ever touch a fraction of that, but
 * without a limit the fraction it does touch is never released.
 */
const CACHE_LIMIT = 400;
const cache = createLruCache(CACHE_LIMIT);

const cacheGet = (key) => cache.get(key);
const cacheSet = (key, sprite) => cache.set(key, sprite);

/** Number of sprites currently held. Exposed for tests. */
export function spriteCacheSize() { return cache.size; }

/** Distinct designs available per zone type and level. */
export const VARIANTS = 16;

/** Baseline wall height in pixels, by development level. */
const ZONE_HEIGHTS = {
  R_LOW: [0, 13, 17, 22],
  R_HIGH: [0, 24, 42, 70, 108],
  C_LOW: [0, 15, 21, 28],
  C_HIGH: [0, 28, 50, 84, 126],
  I_LIGHT: [0, 17, 23, 29],
  I_HEAVY: [0, 25, 34, 47],
};

/**
 * The vocabulary each zone type draws from.
 *
 * Repeats in a pool are weights: listing 'single' twice makes plain blocks
 * twice as likely as any one alternative, which keeps a street coherent while
 * still varying it. `footprint` is how much of the lot the building covers --
 * houses sit back from the line, towers fill it.
 */
const STYLES = {
  R_LOW: {
    roofs: ['hip', 'gable', 'gable', 'hip'],
    massing: ['single', 'single', 'twin', 'ell'],
    windows: ['grid', 'grid', 'sparse'],
    footprint: [0.66, 0.82], jitter: 0.24, chimney: 0.75,
  },
  R_HIGH: {
    roofs: ['flat', 'flat', 'flat', 'gable'],
    massing: ['single', 'single', 'setback', 'ell'],
    windows: ['grid', 'grid', 'columns'],
    footprint: [0.82, 0.95], jitter: 0.20, chimney: 0.15,
  },
  C_LOW: {
    roofs: ['flat', 'flat', 'gable'],
    massing: ['single', 'single', 'ell'],
    windows: ['ribbon', 'ribbon', 'grid'],
    footprint: [0.60, 0.74], jitter: 0.18, chimney: 0, awning: 0.65,
  },
  C_HIGH: {
    roofs: ['flat'],
    massing: ['single', 'setback', 'podium', 'single'],
    windows: ['ribbon', 'columns', 'grid'],
    footprint: [0.84, 0.96], jitter: 0.22, chimney: 0, awning: 0.3,
  },
  I_LIGHT: {
    roofs: ['flat', 'flat', 'gable'],
    massing: ['single', 'single', 'ell'],
    windows: ['sparse'],
    footprint: [0.64, 0.78], jitter: 0.16, chimney: 0,
  },
  I_HEAVY: {
    roofs: ['flat'],
    massing: ['single', 'single', 'twin', 'ell'],
    windows: ['sparse'],
    footprint: [0.84, 0.96], jitter: 0.16, chimney: 0,
  },
};

/**
 * How wealth bends a design.
 *
 * Money buys frontage, pitch and ornament: an affluent lot builds bigger, roofs
 * it more steeply and decorates it more, while a poor one is smaller and
 * plainer. These are multipliers on the zone's own vocabulary rather than a
 * separate set of buildings, so a rich factory still reads as a factory.
 */
const WEALTH_STYLE = {
  0: { footprint: 0.90, height: 0.94, roofRise: 0.88, detail: 0.55, plainBias: 0.40 },
  1: { footprint: 1.00, height: 1.00, roofRise: 1.00, detail: 1.00, plainBias: 0 },
  2: { footprint: 1.07, height: 1.06, roofRise: 1.18, detail: 1.40, plainBias: -0.45 },
};

/** Stacked forms need enough height to be legible as stacked. */
const STACK_MIN_HEIGHT = 44;

/**
 * Derive a lot's design from its variant number.
 *
 * Pure and deterministic: the same arguments always give the same building, so
 * nothing about appearance needs storing or saving.
 */
export function buildingRecipe(zoneKey, level, variant, wealth = 1, era = 1) {
  const style = STYLES[zoneKey];
  const heights = ZONE_HEIGHTS[zoneKey];
  if (!style || !heights) return null;

  const tier = Math.max(0, Math.min(2, wealth | 0));
  const periodIndex = Math.max(0, Math.min(ERAS.length - 1, era | 0));
  const period = ERAS[periodIndex];
  const money = WEALTH_STYLE[tier];
  const category = zoneKey[0];                 // 'R', 'C' or 'I'
  const palettes = buildingPalette(category, tier);

  const capped = Math.min(level, heights.length - 1);
  const base = heights[capped];
  const rng = makeRng(hash2(
    variant * 131 + capped,
    zoneKey.length * 37 + capped * 7 + tier * 1013 + periodIndex * 7919,
    0x9e3779b9,
  ));
  const pick = (pool) => pool[Math.min(pool.length - 1, Math.floor(rng() * pool.length))];

  const jitter = 1 + (rng() * 2 - 1) * style.jitter;
  const height = Math.max(6, Math.round(base * jitter * money.height * period.height));
  const footprint = clamp(
    (style.footprint[0] + rng() * (style.footprint[1] - style.footprint[0]))
      * money.footprint * period.footprint,
    0.5, 0.97,
  );

  let massing = pick(style.massing);
  // Cheap stock is plain; money buys shape.
  if (money.plainBias > 0 && rng() < money.plainBias) {
    massing = 'single';
  } else if (money.plainBias < 0 && massing === 'single' && rng() < -money.plainBias) {
    const fancier = style.massing.filter((m) => m !== 'single');
    if (fancier.length) massing = fancier[Math.floor(rng() * fancier.length)];
  }
  // A setback or podium on a two-storey building just looks like a mistake.
  if ((massing === 'setback' || massing === 'podium') && height < STACK_MIN_HEIGHT) {
    massing = 'single';
  }

  // The period decides pitch, but only among the forms the zone actually uses.
  // A contemporary house still has a pitched roof -- what goes flat in a modern
  // city is the apartment blocks and offices, whose vocabulary includes it.
  const pitchedOptions = style.roofs.filter((r) => r !== 'flat');
  const flatAvailable = style.roofs.includes('flat');
  let roof;
  if (pitchedOptions.length && (!flatAvailable || rng() < period.pitchBias)) {
    roof = pitchedOptions[Math.floor(rng() * pitchedOptions.length)];
  } else {
    roof = 'flat';
  }

  // Pitched roofs belong on single masses of modest height; on a stacked tower
  // they read as a hat.
  const stacked = massing === 'setback' || massing === 'podium';
  if (stacked || height > 60) roof = 'flat';

  // Glazing carries the period more than anything else: small punched openings
  // early, continuous curtain walling late.
  let windows = pick(style.windows);
  const GLASSY = ['ribbon', 'columns'];
  const wanted = rng() < period.glassBias
    ? style.windows.filter((k) => GLASSY.includes(k))
    : style.windows.filter((k) => !GLASSY.includes(k));
  if (wanted.length) windows = wanted[Math.floor(rng() * wanted.length)];

  const pitched = roof !== 'flat';
  const chance = (base) => rng() < base * money.detail * period.ornament;

  return {
    wealth: tier,
    era: periodIndex,
    palette: Math.floor(rng() * palettes.length),
    height,
    footprint,
    massing,
    roof,
    roofRise: clamp((0.38 + rng() * 0.3) * money.roofRise, 0.2, 0.85),
    windows,
    chimney: pitched && chance(style.chimney ?? 0),
    antenna: !pitched && height > 72 && chance(0.55),
    tanks: pitched ? 0 : Math.floor(rng() * 3),
    awning: !!style.awning && chance(style.awning),
    seed: hash2(variant, capped * 8 + tier, 0x51ed),
  };
}

function makeCanvas(w, h) {
  return typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

// ------------------------------------------------------------- primitives --

/** Offset in screen pixels for a displacement of (u, v) tiles. */
function isoOffset(u, v) {
  return { x: (u - v) * (TILE_W / 2), y: (u + v) * (TILE_H / 2) };
}

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

/** Trace a polygon. */
function poly(ctx, pts) {
  ctx.beginPath();
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k].x, pts[k].y);
  ctx.closePath();
}

/**
 * Ambient occlusion, faked.
 *
 * Real pre-rendered isometric sprites carry baked soft shadowing, and its
 * absence is most of why flat-filled volumes look like they are hovering. Two
 * cheap approximations get most of the way: a gradient darkening the foot of
 * every wall, and a soft contact shadow on the ground. No canvas blur filter is
 * used -- support for it is patchy -- so the shadow is a few nested shapes at
 * low alpha instead.
 */
const AO_STRENGTH = 0.26;
const AO_RISE = 0.42;        // fraction of the wall the darkening reaches up

function occludeFace(ctx, pts, baseY, height) {
  if (height < 4) return;
  const grad = ctx.createLinearGradient(0, baseY - height * AO_RISE, 0, baseY);
  grad.addColorStop(0, 'rgba(24, 28, 22, 0)');
  grad.addColorStop(1, `rgba(24, 28, 22, ${AO_STRENGTH})`);
  ctx.fillStyle = grad;
  poly(ctx, pts);
  ctx.fill();
}

/** A soft contact shadow on the ground, offset away from the light. */
function groundShadow(ctx, ox, oy, span) {
  for (let k = 3; k >= 1; k--) {
    const grow = 1 + k * 0.07;
    // Keep the enlarged rhombus concentric with the footprint.
    const oyAdj = oy + ((span - span * grow) * TILE_H) / 2;
    ctx.fillStyle = `rgba(28, 34, 24, ${0.07})`;
    rhombus(ctx, ox + 3, oyAdj + 2, span * grow, 0);
    ctx.fill();
  }
}

/**
 * A solid isometric box: roof slab, front-left face, front-right face.
 * Returns its geometry so callers can decorate the faces.
 */
function isoBox(ctx, ox, oy, span, height, colors) {
  const w2 = (span * TILE_W) / 2;
  const h2 = (span * TILE_H) / 2;
  const bottom = { x: ox, y: oy + h2 * 2 };
  const left = { x: ox - w2, y: oy + h2 };
  const right = { x: ox + w2, y: oy + h2 };

  const leftFace = [
    left, bottom,
    { x: bottom.x, y: bottom.y - height },
    { x: left.x, y: left.y - height },
  ];
  ctx.fillStyle = shade(colors.wall, FACE.left);
  poly(ctx, leftFace);
  ctx.fill();
  occludeFace(ctx, leftFace, bottom.y, height);

  const rightFace = [
    bottom, right,
    { x: right.x, y: right.y - height },
    { x: bottom.x, y: bottom.y - height },
  ];
  ctx.fillStyle = shade(colors.wall, FACE.right);
  poly(ctx, rightFace);
  ctx.fill();
  occludeFace(ctx, rightFace, bottom.y, height);

  ctx.fillStyle = colors.roof;
  rhombus(ctx, ox, oy, span, height);
  ctx.fill();

  return { ox, oy, span, bottom, left, right, w2, h2, height };
}

/** Window layout parameters for each treatment. */
function windowLayout(style, height, span) {
  const floors = Math.max(1, Math.round(height / 13));
  switch (style) {
    case 'ribbon':   return { cols: 1, rows: floors, insetU: 0.06, insetV: 0.30, skip: 0 };
    // Segmented rather than one unbroken stripe per bay: a full-height run of
    // glazing at this scale reads as a barcode rather than as a curtain wall.
    case 'columns':  return { cols: Math.max(2, Math.round(span * 4)), rows: Math.max(1, Math.round(floors / 3)), insetU: 0.32, insetV: 0.10, skip: 0 };
    case 'sparse':   return { cols: Math.max(1, Math.round(span * 2)), rows: Math.max(1, Math.round(floors / 2)), insetU: 0.30, insetV: 0.32, skip: 3 };
    default:         return { cols: Math.max(1, Math.round(span * 3)), rows: floors, insetU: 0.22, insetV: 0.24, skip: 7 };
  }
}

/**
 * Lay windows across one face. `anchor` is the face's lower corner and `du`
 * the vector along its base.
 */
function windows(ctx, anchor, du, height, layout, color, seedBase, lit) {
  const { cols, rows, insetU, insetV, skip } = layout;
  if (cols < 1 || rows < 1 || height < 8) return;

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = hash2(c, r, seedBase);
      // A scattering of dark windows keeps facades from looking printed.
      if (skip > 0 && (h & skip) === 0) continue;
      const on = lit && (h & 3) !== 0;

      const u0 = (c + insetU) / cols, u1 = (c + 1 - insetU) / cols;
      const v0 = height * ((r + insetV) / rows), v1 = height * ((r + 1 - insetV) / rows);
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

function dressBox(ctx, box, layout, colors, seed, lit) {
  windows(ctx, box.left, { x: box.w2, y: box.h2 }, box.height, layout, colors.win, seed, lit);
  windows(ctx, box.bottom, { x: box.w2, y: -box.h2 }, box.height, layout, colors.win, seed + 91, lit);
}

// ------------------------------------------------------------------ roofs --

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
  face(left, top, 0.9);
  face(top, right, 0.78);
  face(left, bottom, 1.06);
  face(bottom, right, 0.7);
}

/** Gabled roof: two slopes meeting at a ridge, with a triangular end wall. */
function gableRoof(ctx, ox, oy, span, lift, rise, color, wall) {
  const w2 = (span * TILE_W) / 2;
  const h2 = (span * TILE_H) / 2;
  const top = { x: ox, y: oy - lift };
  const right = { x: ox + w2, y: oy + h2 - lift };
  const bottom = { x: ox, y: oy + h2 * 2 - lift };
  const left = { x: ox - w2, y: oy + h2 - lift };
  // Ridge runs from the midpoint of one pair of edges to the other.
  const ridgeA = { x: ox - w2 / 2, y: oy + h2 / 2 - lift - rise };
  const ridgeB = { x: ox + w2 / 2, y: oy + h2 * 1.5 - lift - rise };

  // Gable end walls first; the slopes overlap their upper edges.
  ctx.fillStyle = shade(wall, 0.86);
  ctx.beginPath();
  ctx.moveTo(top.x, top.y); ctx.lineTo(left.x, left.y); ctx.lineTo(ridgeA.x, ridgeA.y);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(wall, 0.64);
  ctx.beginPath();
  ctx.moveTo(right.x, right.y); ctx.lineTo(bottom.x, bottom.y); ctx.lineTo(ridgeB.x, ridgeB.y);
  ctx.closePath(); ctx.fill();

  const plane = (a, b, tint) => {
    ctx.fillStyle = shade(color, tint);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.lineTo(ridgeB.x, ridgeB.y); ctx.lineTo(ridgeA.x, ridgeA.y);
    ctx.closePath(); ctx.fill();
  };
  plane(top, right, 0.74);     // far slope
  plane(left, bottom, 1.05);   // near slope, catching the light
}

/** Parapet, stair housings and vents -- what sells a flat roof. */
function flatRoofDetail(ctx, box, colors, rec) {
  const { ox, oy, span, height } = box;
  ctx.strokeStyle = shade(colors.roof, 0.72);
  ctx.lineWidth = 1.5;
  rhombus(ctx, ox, oy, span, height);
  ctx.stroke();

  const w2 = (span * TILE_W) / 2;
  const h2 = (span * TILE_H) / 2;
  for (let k = 0; k < rec.tanks; k++) {
    const hx = hash2(k, rec.seed, 17) / 4294967296;
    const hy = hash2(k, rec.seed, 29) / 4294967296;
    const u = (hx - 0.5) * 1.1, v = (hy - 0.5) * 1.1;
    if (Math.abs(u) + Math.abs(v) > 0.62) continue;
    const cx = ox + (u + v) * w2;
    const cy = oy + h2 - height + (u - v) * h2;
    const bh = 3 + (rec.seed >> (k * 3)) % 6;
    isoBox(ctx, cx, cy - h2 * 0.18, span * 0.22, bh, { wall: colors.roof, roof: shade(colors.roof, 1.12) });
  }

  if (rec.antenna) {
    const mastH = 12 + (rec.seed % 10);
    const cx = ox, cy = oy + h2 - height;
    ctx.strokeStyle = '#4d4a44';
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(cx, cy); ctx.lineTo(cx, cy - mastH);
    ctx.stroke();
    ctx.fillStyle = '#c2554a';
    ctx.fillRect(cx - 1, cy - mastH - 2, 2, 2);
  }
}

/**
 * A chimney poking out of a pitched roof.
 *
 * Kept short and brick-coloured on purpose: a tall dark one reads as an
 * industrial smokestack and pulls the eye straight off the houses.
 */
function chimney(ctx, box, colors, rec) {
  const { ox, oy, span, height } = box;
  const h2 = (span * TILE_H) / 2;
  const side = (rec.seed & 1) ? 0.2 : -0.2;
  const cx = ox + side * (span * TILE_W) / 2;
  const cy = oy + h2 - height + side * h2 * 0.5;
  const stackH = 5 + (rec.seed % 4);
  isoBox(ctx, cx, cy, span * 0.14, stackH, {
    wall: shade(colors.roof, 1.12), roof: shade(colors.roof, 0.7),
  });
}

/** A shop canopy along the two street-facing edges. */
function awning(ctx, box, colors) {
  const { bottom, left, right } = box;
  const drop = 5;
  ctx.fillStyle = shade(colors.roof, 1.18);
  ctx.beginPath();
  ctx.moveTo(left.x, left.y - drop - 3);
  ctx.lineTo(bottom.x, bottom.y - drop - 3);
  ctx.lineTo(bottom.x, bottom.y - drop);
  ctx.lineTo(left.x, left.y - drop);
  ctx.closePath(); ctx.fill();
  ctx.fillStyle = shade(colors.roof, 0.95);
  ctx.beginPath();
  ctx.moveTo(bottom.x, bottom.y - drop - 3);
  ctx.lineTo(right.x, right.y - drop - 3);
  ctx.lineTo(right.x, right.y - drop);
  ctx.lineTo(bottom.x, bottom.y - drop);
  ctx.closePath(); ctx.fill();
}

// ---------------------------------------------------------------- massing --

/**
 * Break a recipe into the boxes that make up the building.
 *
 * Each part carries its offset within the lot (in tiles), its span, its wall
 * height, how far it is lifted off the ground, and whether it is the mass that
 * gets the roof.
 */
export function massingParts(rec) {
  const f = rec.footprint;
  const h = rec.height;
  const c = (1 - f) / 2;         // inset that centres the footprint in the lot

  switch (rec.massing) {
    case 'twin': {
      const s = f * 0.46;
      const gap = f - s;
      return [
        { u: c, v: c, s, h, lift: 0, roofed: true },
        { u: c + gap, v: c, s, h: Math.round(h * 0.88), lift: 0, roofed: true },
      ];
    }
    case 'ell': {
      const main = f * 0.70;
      const wing = f * 0.42;
      return [
        { u: c, v: c, s: main, h, lift: 0, roofed: true },
        { u: c, v: c + main * 0.62, s: wing, h: Math.round(h * 0.74), lift: 0, roofed: true },
      ];
    }
    case 'setback': {
      const lower = Math.round(h * 0.62);
      const upper = h - lower;
      const s2 = f * 0.72;
      return [
        { u: c, v: c, s: f, h: lower, lift: 0, roofed: false },
        { u: c + (f - s2) / 2, v: c + (f - s2) / 2, s: s2, h: upper, lift: lower, roofed: true },
      ];
    }
    case 'podium': {
      const podium = Math.round(h * 0.24);
      const tower = h - podium;
      const s2 = f * 0.56;
      return [
        { u: c, v: c, s: f, h: podium, lift: 0, roofed: false },
        { u: c + (f - s2) / 2, v: c + (f - s2) / 2, s: s2, h: tower, lift: podium, roofed: true },
      ];
    }
    default:
      return [{ u: c, v: c, s: f, h, lift: 0, roofed: true }];
  }
}

/** Total height of the tallest stack, used to size the sprite canvas. */
function recipeHeight(rec) {
  return Math.max(...massingParts(rec).map((p) => p.h + p.lift));
}

// --------------------------------------------------------------- sprites --

/**
 * Sprite for a developed zone tile.
 * Returns { canvas, ox, oy } where (ox, oy) is the offset from the tile origin
 * to the sprite's top-left corner.
 */
export function zoneSprite(zoneKey, level, variant, wealth, era, lit) {
  const key = `z:${zoneKey}:${level}:${variant}:${wealth}:${era}:${lit ? 1 : 0}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const rec = buildingRecipe(zoneKey, level, variant, wealth, era);
  const palettes = buildingPalette(zoneKey[0], rec.wealth);
  const colors = applyEra(palettes[rec.palette % palettes.length], ERAS[rec.era]);

  const roofRise = rec.roof === 'flat' ? 0 : Math.round(rec.height * rec.roofRise);
  const totalH = recipeHeight(rec) + roofRise + 24;

  const w = TILE_W + PAD * 2;
  const h = TILE_H + totalH + PAD * 2;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const ox = w / 2;
  const oy = totalH + PAD;

  groundShadow(ctx, ox, oy + ((1 - rec.footprint) * TILE_H) / 2, rec.footprint);

  // Back to front within the lot, then bottom to top for stacked masses.
  const parts = massingParts(rec)
    .sort((a, b) => (a.u + a.v) - (b.u + b.v) || a.lift - b.lift);

  for (const part of parts) {
    const off = isoOffset(part.u, part.v);
    const box = isoBox(ctx, ox + off.x, oy + off.y - part.lift, part.s, part.h, colors);
    dressBox(ctx, box, windowLayout(rec.windows, part.h, part.s), colors, rec.seed + part.u * 1000, lit);

    if (!part.roofed) {
      flatRoofDetail(ctx, box, colors, { ...rec, tanks: 0, antenna: false });
      continue;
    }

    const rise = rec.roof === 'flat' ? 0 : Math.round(part.h * rec.roofRise);
    if (rec.roof === 'hip') {
      hipRoof(ctx, box.ox, box.oy, part.s, part.h, rise, colors.roof);
      if (rec.chimney) chimney(ctx, box, colors, rec);
    } else if (rec.roof === 'gable') {
      gableRoof(ctx, box.ox, box.oy, part.s, part.h, rise, colors.roof, colors.wall);
      if (rec.chimney) chimney(ctx, box, colors, rec);
    } else {
      flatRoofDetail(ctx, box, colors, rec);
    }
    if (rec.awning) awning(ctx, box, colors);
  }

  return cacheSet(key, { canvas, ox: -ox, oy: -oy });
}

/** Sprite for a placed service building. */
export function buildingSprite(type, lit) {
  const key = `b:${type}:${lit ? 1 : 0}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const spec = BUILDINGS[type];
  const span = spec.span;
  const height = spec.height;
  const totalH = height + span * 14 + 20;

  const w = span * TILE_W + PAD * 2;
  const h = span * TILE_H + totalH + PAD * 2;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const ox = w / 2;
  const oy = totalH + PAD;

  if (spec.category === 'park') {
    drawPark(ctx, ox, oy, span);
  } else {
    groundShadow(ctx, ox, oy + ((span - span * 0.9) * TILE_H) / 2, span * 0.9);
    const colors = { wall: spec.color, roof: shade(spec.color, 0.86), win: '#cfe0e6' };
    const box = isoBox(ctx, ox, oy, span * 0.9, height, colors);
    const layout = { cols: span * 2, rows: Math.max(1, Math.round(height / 15)), insetU: 0.22, insetV: 0.24, skip: 7 };
    dressBox(ctx, box, layout, colors, 5, lit);
    flatRoofDetail(ctx, box, colors, { tanks: 1 + (span % 2), antenna: false, seed: type.length * 37 + span });
    if (spec.supply) drawStacks(ctx, ox, oy, span, height, spec);
  }

  return cacheSet(key, { canvas, ox: -ox, oy: -oy });
}

function drawPark(ctx, ox, oy, span) {
  ctx.fillStyle = '#5c8a3f';
  rhombus(ctx, ox, oy, span, 0);
  ctx.fill();
  ctx.strokeStyle = '#4a7333';
  ctx.lineWidth = 1;
  ctx.stroke();
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
  for (const [u, v] of [[-0.22, -0.1], [0.16, 0.14]]) {
    const cx = ox + (u + v) * (span * TILE_W) / 2;
    const cy = oy + (span * TILE_H) / 2 - height + (u - v) * (span * TILE_H) / 2;
    isoBox(ctx, cx, cy, span * 0.2, stackH, { wall: '#9a9188', roof: '#3a352f' });
  }
}

/** A single tree, used for terrain scatter and park decoration. */
export function treeSprite(variant) {
  const key = `t:${variant}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const w = 26, h = 34;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  drawTreeAt(ctx, w / 2, h - 6, variant);
  return cacheSet(key, { canvas, ox: -w / 2, oy: -(h - 6 - TILE_H / 2) });
}

function drawTreeAt(ctx, x, baseY, variant) {
  const c = TREE_COLORS[variant % TREE_COLORS.length];
  ctx.fillStyle = 'rgba(28, 34, 24, 0.18)';
  ctx.beginPath();
  ctx.ellipse(x + 3, baseY - 1, 8, 4, 0, 0, Math.PI * 2);
  ctx.fill();
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

export function clearSpriteCache() { cache.clear(); }
