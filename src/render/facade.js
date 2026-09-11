/**
 * Facades, by grammar.
 *
 * A building's face used to be a grid: pick a column count and a row count,
 * stamp identical rectangles across the whole wall. That reads as a barcode,
 * and it is why sixteen variants of the same zone came out looking like one
 * building drawn nine times -- the only thing that actually differed between
 * them was paint.
 *
 * Real facades are not a grid, they are a *split*. A wall divides vertically
 * into a ground storey, a repeating shaft and a cap; the ground storey divides
 * horizontally into bays, and each bay holds something -- a shopfront, a door,
 * a window, a vent. Which elements are available depends on what the building
 * is for, and the proportions vary from building to building. That is the same
 * shape grammar city-modelling tools use, and it is what makes a street look
 * like a street rather than like wallpaper.
 *
 * Everything here is pure geometry in face-local coordinates: `u` runs 0..1
 * along the base of the face, `v` is height in pixels from its foot. No canvas,
 * no colour -- the painter in sprites.js turns a plan into parallelograms. That
 * keeps the interesting decisions testable without rendering anything.
 */

import { hash2, clamp } from '../util.js';

/** What can occupy a bay. The painter decides how each one looks. */
export const EL = {
  WINDOW: 'window',
  DOOR: 'door',
  SHOPFRONT: 'shopfront',
  BALCONY: 'balcony',
  LOUVRE: 'louvre',
  VENT: 'vent',
  BLANK: 'blank',
  CORNICE: 'cornice',
  STRING: 'string',
  PIER: 'pier',
};

/**
 * Everything here is sized in pixels, not in tiles.
 *
 * The first cut of this scaled bays by the tile span, which is fine for a
 * tower and absurd for a house: a two-storey cottage covers most of a tile but
 * only twenty-five pixels of wall, so "two bays per tile" gave it one window
 * the size of a garage door. Pixels are what the eye is actually judging, so
 * pixels are what the grammar counts.
 */
const BAY_PITCH = [7, 13];       // px of frontage per bay
const MIN_FLOOR = 7;             // px; below this a face is a single storey
const OPENING_W = [2.5, 11];     // px
const OPENING_H = [2.5, 10];     // px

/**
 * The dimensions and habits of one building's facade.
 *
 * Derived from the same seeded generator as the rest of the recipe, so a lot
 * keeps its design for the life of the city without anything being stored --
 * and so two neighbours drawing on the same vocabulary still differ in bay
 * rhythm, storey height and detailing, which is most of what the eye reads as
 * "a different building".
 */
export function facadeStyle(rng, category, wealth = 1, era = 1) {
  const rich = wealth === 2, poor = wealth === 0;

  // A tight bay rhythm reads as older and finer, a wide one as later and
  // cheaper.
  const pitchBias = category === 'C' ? -1.5 : category === 'I' ? 2 : 0;
  const bayPitch = clamp(
    BAY_PITCH[0] + rng() * (BAY_PITCH[1] - BAY_PITCH[0]) + pitchBias + (era >= 2 ? 1.5 : -0.5),
    BAY_PITCH[0], BAY_PITCH[1],
  );

  const floorH = (category === 'I' ? 13 : 10) * (0.85 + rng() * 0.4) * (rich ? 1.1 : 1);

  return {
    bayPitch,
    floorH,
    // Shops need a tall ground floor to put a window in; a house does not.
    groundRatio: category === 'C' ? 1.4 + rng() * 0.45
               : category === 'I' ? 1.2 + rng() * 0.35
               : 1 + rng() * 0.2,
    // A cornice or parapet band is what stops a flat-topped box reading as a
    // box. Money and age buy a deeper one.
    cornice: rng() < (rich ? 0.9 : poor ? 0.4 : 0.7),
    corniceH: (1.5 + rng() * 2) * (rich ? 1.4 : 1) * (era <= 1 ? 1.2 : 0.8),
    // A band between ground floor and shaft, the way a real building steps
    // back from its shopfront.
    stringCourse: rng() < (era <= 1 ? 0.55 : 0.25),
    // Vertical piers between bays: the difference between a curtain wall and
    // a framed one.
    piers: rng() < (category === 'C' ? 0.4 : 0.2),
    balconyRate: category === 'R' ? (rng() < 0.4 ? 0.15 + rng() * 0.4 : 0) : 0,
    blankRate: category === 'I' ? 0.4 : poor ? 0.16 : 0.07,
    // How much of a bay, and of a storey, the opening takes.
    openU: clamp(0.4 + rng() * 0.26 + (rich ? 0.06 : 0), 0.3, 0.76),
    openV: clamp(0.38 + rng() * 0.26, 0.3, 0.72),
  };
}

/**
 * Split one face into bands and fill each band's bays.
 *
 * `height` is the wall height and `faceWidth` the length of its base, both in
 * pixels. Elements come back ordered for painting: bands bottom-up, bays left
 * to right, with `u` normalised 0..1 along the base so the painter can map
 * them onto the parallelogram of the wall.
 */
export function facadePlan(style, height, faceWidth, category, seed) {
  const elements = [];
  if (height < 4 || faceWidth < 4) return { bands: [], elements, floors: 0, bays: 0 };

  const bays = clamp(Math.round(faceWidth / style.bayPitch), 1, 14);
  const bayW = faceWidth / bays;
  const cap = style.cornice ? Math.min(style.corniceH, height * 0.16) : 0;

  // --- vertical split: ground, shaft, cap ---------------------------------
  let ground = Math.min(style.floorH * style.groundRatio, height - cap);
  let shaft = height - cap - ground;
  let floors = Math.floor(shaft / Math.max(MIN_FLOOR, style.floorH * 0.8));
  if (floors < 1) {
    ground = height - cap;                       // too short for a shaft
    shaft = 0;
    floors = 0;
  }
  const floorH = floors > 0 ? shaft / floors : 0;

  const bands = [{ v0: 0, v1: ground, kind: 'ground' }];
  for (let f = 0; f < floors; f++) {
    bands.push({ v0: ground + f * floorH, v1: ground + (f + 1) * floorH, kind: 'floor' });
  }
  if (cap > 0) bands.push({ v0: height - cap, v1: height, kind: 'cap' });

  const pick = (salt) => hash2(salt, seed, 0x1f2e3d) / 4294967296;
  const put = (b, v0, v1, kind, wide) => {
    const e = opening(b, bayW, faceWidth, v0, v1, kind, style, wide);
    if (e) elements.push(e);
  };

  // --- ground storey -------------------------------------------------------
  // One bay gets the entrance; the rest get whatever the use calls for. A
  // shopfront needs room to be one, so below that it stays an ordinary window.
  const shopfrontable = category === 'C' && ground >= 7 && bayW >= 6;
  const doorBay = bays > 1 ? Math.floor(pick(7001) * bays) : 0;
  for (let b = 0; b < bays; b++) {
    const kind = b === doorBay && ground >= 6 ? EL.DOOR
      : shopfrontable ? EL.SHOPFRONT
      : category === 'I' ? (pick(b * 31 + 11) < 0.5 ? EL.LOUVRE : EL.BLANK)
      : (pick(b * 31 + 13) < 0.22 ? EL.BLANK : EL.WINDOW);
    if (kind === EL.BLANK) continue;
    put(b, 0, ground, kind, kind === EL.SHOPFRONT);
  }

  if (style.stringCourse && floors > 0 && height > 18) {
    elements.push({ u0: 0, u1: 1, v0: ground - 1.2, v1: ground + 0.4, kind: EL.STRING });
  }

  // --- shaft ---------------------------------------------------------------
  for (let f = 0; f < floors; f++) {
    const v0 = ground + f * floorH;
    for (let b = 0; b < bays; b++) {
      if (pick(f * 131 + b * 17 + 3) < style.blankRate) continue;
      const balcony = style.balconyRate > 0 && floorH >= 8 && bayW >= 7
        && pick(f * 197 + b * 23 + 5) < style.balconyRate;
      put(b, v0, v0 + floorH, balcony ? EL.BALCONY : EL.WINDOW, false);
    }
  }

  // --- piers and cap -------------------------------------------------------
  if (style.piers && floors > 0 && bayW >= 7) {
    for (let b = 1; b < bays; b++) {
      const u = b / bays;
      elements.push({ u0: u - 0.01, u1: u + 0.01, v0: ground, v1: height - cap, kind: EL.PIER });
    }
  }
  if (cap > 0) elements.push({ u0: 0, u1: 1, v0: height - cap, v1: height, kind: EL.CORNICE });

  return { bands, elements, floors, bays };
}

/**
 * One opening, centred in its bay and sized in pixels.
 *
 * Clamped at both ends: big enough to be visible at all, and never so big that
 * it swallows the wall it is cut into.
 */
function opening(b, bayW, faceWidth, v0, v1, kind, style, wide) {
  const storey = v1 - v0;
  if (storey < 3) return null;

  const wantW = bayW * (wide ? 0.86 : style.openU);
  const w = clamp(wantW, Math.min(OPENING_W[0], bayW * 0.9), Math.min(OPENING_W[1], bayW * 0.92));

  const tall = kind === EL.SHOPFRONT || kind === EL.DOOR;
  const wantH = storey * (tall ? 0.7 : style.openV);
  const h = clamp(wantH, Math.min(OPENING_H[0], storey * 0.8), Math.min(OPENING_H[1], storey * 0.82));
  if (w <= 0.5 || h <= 0.5) return null;

  const centre = (b + 0.5) * bayW;
  // A door or a shopfront stands on the floor; a window floats in its storey.
  const foot = tall ? v0 + Math.min(1.2, storey * 0.12) : v0 + (storey - h) / 2;

  return {
    u0: (centre - w / 2) / faceWidth,
    u1: (centre + w / 2) / faceWidth,
    v0: foot,
    v1: foot + h,
    kind,
  };
}
