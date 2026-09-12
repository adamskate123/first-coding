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
import { buildingPalette, applyEra, roofColor, TREE_COLORS, FACE, WINDOW_LIT, shade, mix } from './palette.js';
import { facadeStyle, facadePlan, EL } from './facade.js';
import { hash2, makeRng, clamp, createLruCache } from '../util.js';
import {
  makeCanvas, isoOffset, isoBox, groundShadow, drawTreeAt,
  hipRoof, gableRoof, flatRoofDetail, chimney, awning,
} from './volumes.js';
import { civicSprite, CIVIC_HEADROOM } from './civic.js';
import { isWorks, drawWorks, worksHeight, worksHeadroom } from './works.js';
import { drawSite } from './site.js';

const PAD = 10;

/**
 * Extra room around a civic sprite, for the shadow it drops beyond its own
 * plot. The shadow is cast down and to the right and lengthens with height, so
 * a power station on a three-tile plot reaches well past the tile it stands
 * on. The sprite's anchor moves with the margin, so nothing is displaced --
 * only the canvas is bigger.
 */
const FOOT = 22, SIDE = 30;

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
  // Lit glass is a lamp, not a paler pane: the night wash sits over the whole
  // frame, and a brighter grey under it is still grey.
  const glassLit = shade(mix(colors.win, WINDOW_LIT, 0.86), 0.85 + faceTint * 0.25);
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
  paintFacade(ctx, box.left, { x: box.uw, y: box.uh }, plan, colors, lit, seed, FACE.left);
  paintFacade(ctx, box.bottom, { x: box.vw, y: -box.vh }, plan, colors, lit, seed + 91, FACE.right);
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
export function zoneSprite(zoneKey, level, variant, wealth, era, lit, span = 1) {
  const key = `z:${zoneKey}:${level}:${variant}:${wealth}:${era}:${lit ? 1 : 0}:${span}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  // Industry is drawn by its own generator. Sharing the house vocabulary is
  // what made a light-industrial lot come out as a cottage and a heavy one as
  // an apartment block: a works is long and low, roofed north-light or flat,
  // glazed at the eaves, and surrounded by plant -- none of which the massing
  // and facade grammar can express.
  if (isWorks(zoneKey)) {
    const height = worksHeight(zoneKey, level, era);
    const totalH = height + worksHeadroom(zoneKey, level) + 24;
    const w = span * TILE_W + PAD * 2;
    const h = span * TILE_H + totalH + PAD * 2 + FOOT;
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const ox = w / 2, oy = totalH + PAD;
    drawWorks(ctx, ox, oy, zoneKey, level, variant, wealth, era, lit, span);
    return cacheSet(key, { canvas, ox: -ox, oy: -oy });
  }

  const rec = buildingRecipe(zoneKey, level, variant, wealth, era);
  const palettes = buildingPalette(zoneKey[0], rec.wealth);
  const base = applyEra(palettes[rec.palette % palettes.length], ERAS[rec.era]);
  const colors = { ...base, roof: roofColor(base.roof, rec.roofMaterial) };

  const roofRise = rec.roof === 'flat' ? 0 : Math.round(rec.height * rec.roofRise);
  const totalH = recipeHeight(rec) + roofRise + 24;

  // A merged lot is the same design over a wider footprint: the massing is in
  // fractions of the plot, so it scales without a second vocabulary.
  const w = span * TILE_W + PAD * 2;
  const h = span * TILE_H + totalH + PAD * 2;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const ox = w / 2;
  const oy = totalH + PAD;

  groundShadow(ctx, ox, oy + ((span - rec.footprint * span) * TILE_H) / 2, rec.footprint * span, recipeHeight(rec));

  // Back to front within the lot, then bottom to top for stacked masses.
  const parts = massingParts(rec)
    .sort((a, b) => (a.u + a.v) - (b.u + b.v) || a.lift - b.lift);

  for (const part of parts) {
    const off = isoOffset(part.u * span, part.v * span);
    const box = isoBox(ctx, ox + off.x, oy + off.y - part.lift, part.s * span, part.h, colors);
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


/**
 * Sprite for a placed service building.
 *
 * The catalogue types are modelled individually in `civic.js` -- a fire
 * station gets appliance doors and a drill tower, a school gets a long gabled
 * wing, a power station gets chimneys. `civicSprite` returns false for
 * anything without a model, and that case still falls back to the generic
 * box-and-windows treatment, so adding a new catalogue entry never leaves a
 * hole in the map while its art is being drawn.
 */
/**
 * Sprite for a plot under construction.
 *
 * Keyed on the stage and on roughly what will stand here when it is done, so
 * a site for a tower gets a crane and a steel frame while a site for a house
 * gets neither.
 */
export function siteSprite(stage, targetHeight, seed, span = 1, lit = false) {
  const h = Math.min(160, Math.max(8, Math.round(targetHeight / 6) * 6));
  const key = `s:${stage}:${h}:${seed % 8}:${span}:${lit ? 1 : 0}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  const totalH = Math.round(h * 1.15) + 60;
  const w = span * TILE_W + PAD * 2 + SIDE * 2;
  const canvas = makeCanvas(w, span * TILE_H + totalH + PAD * 2 + FOOT);
  const ctx = canvas.getContext('2d');
  const ox = w / 2, oy = totalH + PAD;
  drawSite(ctx, ox, oy, stage, h, seed, span, lit);
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
  const totalH = height + (CIVIC_HEADROOM[type] || 0) + span * 14 + 20;

  // Room below the footprint as well as above it: the contact shadow is cast
  // down and to the right and grows with the building, so a tall one on a
  // large plot throws shade past the bottom corner of its own tile.
  const w = span * TILE_W + PAD * 2 + SIDE * 2;
  const h = span * TILE_H + totalH + PAD * 2 + FOOT;
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const ox = w / 2;
  const oy = totalH + PAD;

  if (!civicSprite(ctx, type, spec, ox, oy, lit)) {
    groundShadow(ctx, ox, oy + ((span - span * 0.9) * TILE_H) / 2, span * 0.9, height);
    const colors = { wall: spec.color, roof: shade(spec.color, 0.86), win: '#cfe0e6' };
    const box = isoBox(ctx, ox, oy, span * 0.9, height, colors);
    const rng = makeRng(hash2(type.length * 131, span * 17, 0x0c171c));
    const style = facadeStyle(rng, spec.supply ? 'I' : 'C', 1, 1);
    const plan = facadePlan(style, height, Math.hypot(box.w2, box.h2), spec.supply ? 'I' : 'C', type.length * 37);
    dressBox(ctx, box, plan, colors, 5, lit);
    flatRoofDetail(ctx, box, colors, { tanks: 1 + (span % 2), antenna: false, seed: type.length * 37 + span });
  }

  return cacheSet(key, { canvas, ox: -ox, oy: -oy });
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


export function clearSpriteCache() { cache.clear(); }
