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
import { buildingPalette, applyEra, roofColor, TREE_COLORS, FACE, shade } from './palette.js';
import { facadeStyle, facadePlan, EL } from './facade.js';
import { hash2, makeRng, clamp, createLruCache } from '../util.js';

const PAD = 10;

/**
 * Sprite cache, bounded.
 *
 * The key space is zone type x level x variant x wealth x era x lit -- over ten
 * thousand combinations. A session will only ever touch a fraction of that, but
 * without a limit the fraction it does touch is never released.
 */
// Sized with headroom: a mature city mixing several zone types, levels,
// wealth tiers and periods can legitimately need a few hundred distinct
// sprites, and a cache that evicts ones still on screen would regenerate them
// every frame.
const CACHE_LIMIT = 800;
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
    massing: ['single', 'twin', 'ell', 'stepped', 'tee', 'single'],
    windows: ['grid', 'grid', 'sparse'],
    footprint: [0.66, 0.82], jitter: 0.30, chimney: 0.75,
  },
  R_HIGH: {
    roofs: ['flat', 'flat', 'flat', 'gable'],
    massing: ['single', 'setback', 'ell', 'stepped', 'twin', 'tee'],
    windows: ['grid', 'grid', 'columns'],
    footprint: [0.82, 0.95], jitter: 0.32, chimney: 0.15,
  },
  C_LOW: {
    roofs: ['flat', 'flat', 'gable'],
    massing: ['single', 'ell', 'tee', 'stepped', 'single'],
    windows: ['ribbon', 'ribbon', 'grid'],
    footprint: [0.60, 0.74], jitter: 0.26, chimney: 0, awning: 0.65,
  },
  C_HIGH: {
    roofs: ['flat'],
    massing: ['single', 'setback', 'podium', 'stepped', 'tee', 'ell'],
    windows: ['ribbon', 'columns', 'grid'],
    footprint: [0.84, 0.96], jitter: 0.34, chimney: 0, awning: 0.3,
  },
  I_LIGHT: {
    roofs: ['flat', 'flat', 'gable'],
    massing: ['single', 'ell', 'tee', 'stepped'],
    windows: ['sparse'],
    footprint: [0.64, 0.78], jitter: 0.24, chimney: 0,
  },
  I_HEAVY: {
    roofs: ['flat'],
    massing: ['single', 'twin', 'ell', 'stepped', 'tee'],
    windows: ['sparse'],
    footprint: [0.84, 0.96], jitter: 0.26, chimney: 0,
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

/** What a stacked form becomes when the building is too short for it. */
const LOW_RISE_FORMS = ['stepped', 'tee', 'ell', 'twin'];

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
  // A setback or podium on a two-storey building just looks like a mistake --
  // but falling back to a plain block was worse. Measured, commercial high at
  // level 1 produced sixteen identical boxes, because its whole vocabulary was
  // stacked forms and every one of them was too short to stack. Fall back to a
  // form that works at low rise instead.
  if ((massing === 'setback' || massing === 'podium') && height < STACK_MIN_HEIGHT) {
    massing = LOW_RISE_FORMS[Math.floor(rng() * LOW_RISE_FORMS.length)];
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
    // How this building's walls are organised. Drawn from the same generator,
    // so it is as much a part of the design as the massing.
    facade: facadeStyle(rng, category, tier, periodIndex),
    roofMaterial: roofMaterialFor(pitched, tier, periodIndex, rng),
    category,
    seed: hash2(variant, capped * 8 + tier, 0x51ed),
  };
}

/**
 * What this building's roof is made of.
 *
 * The pitch decides most of it -- you do not tar a gable or tile a flat -- and
 * the rest follows money and period: lead and copper on the good Edwardian
 * stock, gravel and tar on everything cheap, a planted roof only on a modern
 * building that can afford one.
 */
function roofMaterialFor(pitched, tier, era, rng) {
  const r = rng();
  if (pitched) {
    if (era <= 1) return r < 0.72 ? 0 : 1;                    // tile, else slate
    return r < 0.5 ? 1 : r < 0.8 ? 0 : 2;                     // slate, tile, lead
  }
  if (tier === 2 && era >= 2 && r < 0.3) return 5;            // roof garden
  if (tier === 2 && era <= 1 && r < 0.35) return 4;           // copper
  if (tier === 0) return r < 0.6 ? 3 : 6;                     // tar, gravel
  return r < 0.45 ? 3 : r < 0.75 ? 6 : 2;                     // tar, gravel, lead
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

/**
 * The shadow a building drops on its own plot.
 *
 * Cast down and to the right, away from the light the faces are already shaded
 * for, and lengthened by the building's height -- a tower throwing the same
 * stub of shade as a bungalow is one of those things nobody consciously
 * notices and everybody reads as wrong. Layered at low alpha rather than
 * blurred: canvas filter support is patchy enough not to rely on.
 */
function groundShadow(ctx, ox, oy, span, height = 0) {
  const reach = clamp(height * 0.22, 0, 14);
  for (let k = 3; k >= 1; k--) {
    const grow = 1 + k * 0.07;
    const oyAdj = oy + ((span - span * grow) * TILE_H) / 2;
    ctx.fillStyle = 'rgba(26, 32, 22, 0.075)';
    rhombus(ctx, ox + 3 + reach, oyAdj + 2 + reach * 0.5, span * grow, 0);
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

  if (height >= 3) {
    // A darker line around the silhouette. Flat-filled volumes of similar
    // value merge into each other without one, which is most of why a dense
    // block reads as a single grey mass rather than as separate buildings.
    ctx.strokeStyle = shade(colors.wall, 0.42);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(left.x, left.y - height);
    ctx.lineTo(left.x, left.y);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.lineTo(right.x, right.y);
    ctx.lineTo(right.x, right.y - height);
    ctx.stroke();

    // The vertical corner facing the light catches it.
    ctx.strokeStyle = shade(colors.wall, 1.28);
    ctx.beginPath();
    ctx.moveTo(bottom.x, bottom.y - height);
    ctx.lineTo(bottom.x, bottom.y);
    ctx.stroke();

    // ...and so does the roof edge on that side.
    ctx.beginPath();
    ctx.moveTo(left.x, left.y - height);
    ctx.lineTo(ox, oy - height);
    ctx.lineTo(right.x, right.y - height);
    ctx.stroke();
  }

  return { ox, oy, span, bottom, left, right, w2, h2, height };
}

/**
 * Paint one facade plan onto a face.
 *
 * `anchor` is the face's lower corner and `du` the vector along its base, so a
 * plan's (u, v) maps to a parallelogram lying in the plane of the wall. The
 * face's own shading factor is passed in so an opening on the dark side of the
 * building stays on the dark side -- glass that ignores which way it faces is
 * the fastest way to flatten a volume back out.
 */
function paintFacade(ctx, anchor, du, plan, colors, lit, seed, faceTint) {
  const rect = (e) => {
    ctx.beginPath();
    ctx.moveTo(anchor.x + du.x * e.u0, anchor.y + du.y * e.u0 - e.v0);
    ctx.lineTo(anchor.x + du.x * e.u1, anchor.y + du.y * e.u1 - e.v0);
    ctx.lineTo(anchor.x + du.x * e.u1, anchor.y + du.y * e.u1 - e.v1);
    ctx.lineTo(anchor.x + du.x * e.u0, anchor.y + du.y * e.u0 - e.v1);
    ctx.closePath();
  };

  const glass = shade(colors.win, faceTint);
  const glassLit = shade(colors.win, faceTint * 2.1);
  const frame = shade(colors.wall, faceTint * 0.72);
  const trim = shade(colors.wall, faceTint * 1.18);

  for (let k = 0; k < plan.elements.length; k++) {
    const e = plan.elements[k];
    const h = hash2(k, seed, 0x2f6b);

    switch (e.kind) {
      case EL.CORNICE:
      case EL.STRING:
        ctx.fillStyle = trim;
        rect(e);
        ctx.fill();
        break;

      case EL.PIER:
        ctx.fillStyle = frame;
        rect(e);
        ctx.fill();
        break;

      case EL.SHOPFRONT: {
        // A stall riser under the glass and a fascia over it: the two things
        // that make a shopfront read as a shop rather than a big window.
        const riser = { ...e, v1: e.v0 + (e.v1 - e.v0) * 0.16 };
        const pane = { ...e, v0: e.v0 + (e.v1 - e.v0) * 0.16, v1: e.v1 - (e.v1 - e.v0) * 0.14 };
        const fascia = { ...e, v0: e.v1 - (e.v1 - e.v0) * 0.14 };
        ctx.fillStyle = frame; rect(riser); ctx.fill();
        ctx.fillStyle = lit ? glassLit : glass; rect(pane); ctx.fill();
        ctx.fillStyle = (h & 7) === 0 ? shade(colors.roof, 1.1) : trim;
        rect(fascia); ctx.fill();
        break;
      }

      case EL.DOOR:
        ctx.fillStyle = frame;
        rect(e);
        ctx.fill();
        ctx.fillStyle = shade(colors.roof, faceTint * 0.9);
        rect({ ...e, u0: e.u0 + (e.u1 - e.u0) * 0.18, u1: e.u1 - (e.u1 - e.u0) * 0.18, v1: e.v1 - (e.v1 - e.v0) * 0.12 });
        ctx.fill();
        break;

      case EL.LOUVRE: {
        ctx.fillStyle = frame;
        rect(e);
        ctx.fill();
        // Three slats, enough to read as plant at this size.
        const band = (e.v1 - e.v0) / 5;
        ctx.fillStyle = shade(colors.wall, faceTint * 0.55);
        for (let b = 1; b < 5; b += 2) {
          rect({ ...e, v0: e.v0 + band * b, v1: e.v0 + band * (b + 0.7) });
          ctx.fill();
        }
        break;
      }

      case EL.BALCONY: {
        ctx.fillStyle = lit && (h & 3) !== 0 ? glassLit : glass;
        rect(e);
        ctx.fill();
        // The slab and its rail, standing proud of the wall.
        ctx.fillStyle = trim;
        rect({ u0: e.u0 - 0.008, u1: e.u1 + 0.008, v0: e.v0 - 1.6, v1: e.v0 });
        ctx.fill();
        ctx.fillStyle = frame;
        rect({ u0: e.u0 - 0.008, u1: e.u1 + 0.008, v0: e.v0, v1: e.v0 + (e.v1 - e.v0) * 0.34 });
        ctx.fill();
        break;
      }

      default: {
        // A window: a frame, the pane, and a sill if the building runs to one.
        ctx.fillStyle = frame;
        rect(e);
        ctx.fill();
        const inset = 0.14;
        const uw = (e.u1 - e.u0) * inset, vh = (e.v1 - e.v0) * inset;
        ctx.fillStyle = lit && (h & 3) !== 0 ? glassLit : glass;
        rect({ u0: e.u0 + uw, u1: e.u1 - uw, v0: e.v0 + vh, v1: e.v1 - vh });
        ctx.fill();
        // A few rooms have the blinds down.
        if ((h & 15) === 0) {
          ctx.fillStyle = trim;
          rect({ u0: e.u0 + uw, u1: e.u1 - uw, v0: e.v1 - vh - (e.v1 - e.v0) * 0.3, v1: e.v1 - vh });
          ctx.fill();
        }
        break;
      }
    }
  }
}

/** Paint both visible faces of a box from one plan. */
function dressBox(ctx, box, plan, colors, seed, lit) {
  paintFacade(ctx, box.left, { x: box.w2, y: box.h2 }, plan, colors, lit, seed, FACE.left);
  paintFacade(ctx, box.bottom, { x: box.w2, y: -box.h2 }, plan, colors, lit, seed + 91, FACE.right);
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

  // The hips themselves. Four flat triangles meeting at a point read as a
  // pyramid of paint; the arrises are what make it read as a roof.
  ctx.strokeStyle = shade(color, 1.3);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left.x, left.y); ctx.lineTo(apex.x, apex.y);
  ctx.moveTo(bottom.x, bottom.y); ctx.lineTo(apex.x, apex.y);
  ctx.stroke();
  ctx.strokeStyle = shade(color, 0.6);
  ctx.beginPath();
  ctx.moveTo(top.x, top.y); ctx.lineTo(apex.x, apex.y);
  ctx.moveTo(right.x, right.y); ctx.lineTo(apex.x, apex.y);
  // and the eaves, where the roof oversails the wall
  ctx.moveTo(left.x, left.y); ctx.lineTo(bottom.x, bottom.y); ctx.lineTo(right.x, right.y);
  ctx.stroke();
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

  // Ridge and eaves. Without them the two slopes merge into one lozenge.
  ctx.strokeStyle = shade(color, 1.34);
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(ridgeA.x, ridgeA.y); ctx.lineTo(ridgeB.x, ridgeB.y);
  ctx.stroke();
  ctx.strokeStyle = shade(color, 0.58);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(left.x, left.y); ctx.lineTo(bottom.x, bottom.y); ctx.lineTo(right.x, right.y);
  ctx.stroke();
}

/**
 * Parapet, deck and plant -- what sells a flat roof.
 *
 * This is the surface the camera sees most of, and a bare fill of one colour
 * is why a block of flat-roofed buildings used to read as a grid of tiles
 * rather than as rooftops. A rim, a recessed deck of a different tone, and
 * some plant standing on it are the whole difference.
 */
function flatRoofDetail(ctx, box, colors, rec) {
  const { ox, oy, span, height } = box;

  // The parapet rim, then the deck recessed inside it.
  const deck = span * 0.84;
  ctx.fillStyle = shade(colors.roof, 1.16);
  rhombus(ctx, ox, oy, span, height);
  ctx.fill();
  ctx.fillStyle = shade(colors.roof, 0.9);
  rhombus(ctx, ox, oy + ((span - deck) * TILE_H) / 2, deck, height);
  ctx.fill();

  const w2 = (span * TILE_W) / 2;
  const h2 = (span * TILE_H) / 2;

  // A stair housing, which every flat roof in the world has.
  if (span > 0.45) {
    const sx = ox + w2 * 0.28, sy = oy + h2 - height + h2 * 0.1;
    isoBox(ctx, sx, sy, span * 0.2, 5 + (rec.seed % 4), {
      wall: shade(colors.roof, 1.05), roof: shade(colors.roof, 0.72),
    });
  }

  // Plant: a huddle of small units, the way real roofs carry air handling.
  const units = 1 + (rec.seed >> 5) % 3;
  ctx.fillStyle = shade(colors.roof, 0.66);
  for (let k = 0; k < units; k++) {
    const hx = hash2(k, rec.seed, 71) / 4294967296 - 0.5;
    const hy = hash2(k, rec.seed, 83) / 4294967296 - 0.5;
    if (Math.abs(hx) + Math.abs(hy) > 0.5) continue;
    const cx = ox + (hx + hy) * w2 * 0.9;
    const cy = oy + h2 - height + (hx - hy) * h2 * 0.9;
    ctx.fillRect(cx - 2, cy - 3, 4, 3);
  }
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
    case 'stepped': {
      // Two masses side by side at different heights: the cheapest way to put
      // a step in a silhouette that is only two storeys tall.
      const a = f * 0.54;
      const b = f * 0.44;
      return [
        { u: c, v: c, s: a, h, lift: 0, roofed: true },
        { u: c + f - b, v: c + (f - b) * 0.45, s: b, h: Math.round(h * 0.64), lift: 0, roofed: true },
      ];
    }
    case 'tee': {
      const main = f * 0.62;
      const wing = f * 0.38;
      return [
        { u: c, v: c + (f - main) / 2, s: main, h, lift: 0, roofed: true },
        { u: c + main * 0.58, v: c, s: wing, h: Math.round(h * 0.8), lift: 0, roofed: true },
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
  const base = applyEra(palettes[rec.palette % palettes.length], ERAS[rec.era]);
  const colors = { ...base, roof: roofColor(base.roof, rec.roofMaterial) };

  const roofRise = rec.roof === 'flat' ? 0 : Math.round(rec.height * rec.roofRise);
  const totalH = recipeHeight(rec) + roofRise + 24;

  const w = TILE_W + PAD * 2;
  const h = TILE_H + totalH + PAD * 2;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const ox = w / 2;
  const oy = totalH + PAD;

  groundShadow(ctx, ox, oy + ((1 - rec.footprint) * TILE_H) / 2, rec.footprint, recipeHeight(rec));

  // Back to front within the lot, then bottom to top for stacked masses.
  const parts = massingParts(rec)
    .sort((a, b) => (a.u + a.v) - (b.u + b.v) || a.lift - b.lift);

  for (const part of parts) {
    const off = isoOffset(part.u, part.v);
    const box = isoBox(ctx, ox + off.x, oy + off.y - part.lift, part.s, part.h, colors);
    const faceWidth = Math.hypot(box.w2, box.h2);
    const plan = facadePlan(rec.facade, part.h, faceWidth, rec.category, rec.seed + Math.round(part.u * 1000));
    dressBox(ctx, box, plan, colors, rec.seed + part.u * 1000, lit);

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
    groundShadow(ctx, ox, oy + ((span - span * 0.9) * TILE_H) / 2, span * 0.9, height);
    const colors = { wall: spec.color, roof: shade(spec.color, 0.86), win: '#cfe0e6' };
    const box = isoBox(ctx, ox, oy, span * 0.9, height, colors);
    // Civic buildings get the same grammar, drawn from a seed fixed by type so
    // every police station in the city is recognisably the same building.
    const rng = makeRng(hash2(type.length * 131, span * 17, 0x0c171c));
    const style = facadeStyle(rng, spec.supply ? 'I' : 'C', 1, 1);
    const plan = facadePlan(style, height, Math.hypot(box.w2, box.h2), spec.supply ? 'I' : 'C', type.length * 37);
    dressBox(ctx, box, plan, colors, 5, lit);
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
