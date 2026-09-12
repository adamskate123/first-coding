/**
 * Industrial buildings.
 *
 * Industry used to be drawn with the same generator as everything else: the
 * house vocabulary -- hipped and gabled roofs, punched windows, domestic
 * massing -- rendered in beige. A light-industrial lot at level 1 came out as
 * a cottage, and a heavy one at level 3 as an apartment block. Nothing about
 * an industrial district read as industry.
 *
 * A works is not a big house, and the differences are specific: it is long and
 * low rather than tall and square; its roof is north-light or flat, never
 * pitched; its glazing is a clerestory strip near the eaves rather than
 * windows people look out of; its frontage is roller doors on a raised dock;
 * and it is surrounded by plant -- silos, tanks, stacks, gantries -- standing
 * on a concrete apron rather than a lawn. Those are what this draws.
 *
 * Everything is a pure function of the recipe, exactly as the zoned-lot
 * generator is, so a given lot looks the same for the life of the city.
 */

import { TILE_W, TILE_H, ERAS } from '../config.js';
import { FACE, WINDOW_LIT, shade, mix } from './palette.js';
import {
  isoSlab, isoBox, isoCylinder, cylinderBands, rhombusUV, poly,
  groundShadowUV, sawtoothRoof, faces, panel,
} from './volumes.js';
import { hash2, makeRng, clamp } from '../util.js';

/** How tall a works stands, by zone and level. Long and low, not tall. */
const SHED_HEIGHT = {
  I_LIGHT: [0, 17, 23, 30],
  I_HEAVY: [0, 24, 34, 48],
};

/**
 * Plant that can stand in the yard, and what it looks like.
 *
 * Kept as a small vocabulary drawn from deterministically rather than as a
 * per-level script, so two neighbouring works of the same grade differ without
 * either of them being a special case.
 */
const PLANT = ['silo', 'tank', 'stack', 'hopper', 'gantry'];

/** How much of the frontage a works of this grade gives over to doors. */
const DOOR_RATE = { I_LIGHT: 0.55, I_HEAVY: 0.35 };

/**
 * Does this zone draw as a works?
 *
 * Exported so the sprite generator can branch without knowing the vocabulary,
 * and so a test can assert the branch covers exactly the industrial zones.
 */
export function isWorks(zoneKey) {
  return zoneKey === 'I_LIGHT' || zoneKey === 'I_HEAVY';
}

/** The wall height a works of this zone and level stands at. */
export function worksHeight(zoneKey, level, era = 1) {
  const table = SHED_HEIGHT[zoneKey];
  if (!table) return 0;
  const h = table[Math.min(level, table.length - 1)];
  return Math.round(h * ERAS[clamp(era, 0, ERAS.length - 1)].height);
}

/** How far above the wall the tallest thing on the lot reaches. */
export function worksHeadroom(zoneKey, level) {
  return zoneKey === 'I_HEAVY' ? 34 + level * 11 : 20 + level * 7;
}

/**
 * Draw a works filling a `span`-tile plot, anchored at the plot origin.
 *
 * The layout is always the same in kind -- apron, shed, yard plant, dock --
 * and varies in the particulars, which is how real industrial estates look:
 * obviously all the same sort of thing, no two identical.
 */
export function drawWorks(ctx, ox, oy, zoneKey, level, variant, wealth, era, lit, span = 1, face = 0) {
  const heavy = zoneKey === 'I_HEAVY';
  const period = ERAS[clamp(era, 0, ERAS.length - 1)];
  const rng = makeRng(hash2(variant * 719 + level * 31, (heavy ? 7919 : 104729) + wealth * 97, 0x5bf03635));
  const height = worksHeight(zoneKey, level, era);
  const S = (u, v) => ({ x: ox + (u - v) * (TILE_W / 2) * span, y: oy + (u + v) * (TILE_H / 2) * span });

  // Early works are brick; later ones are clad in profiled metal. That single
  // material change carries most of the period on its own.
  const brickish = period.pitchBias > 0.4;
  const base = brickish
    ? mix('#8a6a52', '#6e594a', rng() * 0.6)
    : mix('#9aa0a2', '#7f868a', rng() * 0.7);
  const wall = heavy ? shade(base, 0.88) : base;
  const roofColor = brickish ? '#5d4a3e' : shade(wall, 0.72);
  const glass = brickish ? '#7f8f94' : '#9fb4bd';
  const litGlass = mix(glass, WINDOW_LIT, 0.7);

  // The apron: concrete, marked out, with a bay line along the dock edge.
  groundShadowUV(ctx, ox, oy, span, span, height);
  ctx.fillStyle = heavy ? '#77736a' : '#87837a';
  rhombusUV(ctx, ox, oy, span, span, 0);
  ctx.fill();
  ctx.strokeStyle = 'rgba(40, 44, 40, 0.25)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // The shed. Long along u, shallow along v, which is what makes it read as a
  // shed rather than as a block: an industrial building is a span, and a span
  // has a direction.
  const shedU = 0.94, shedV = clamp(0.42 + rng() * 0.16 + level * 0.04, 0.4, 0.68);
  const origin = S(0.03, 0.04);
  const shed = isoSlab(ctx, origin.x, origin.y, shedU * span, shedV * span, height,
    { wall, roof: roofColor });

  // Clerestory glazing: one strip near the eaves, the way a daylit shed is
  // glazed. Punched windows here are exactly what made these look domestic.
  for (const face of faces(shed)) {
    panel(ctx, face, 0.04, 0.96, height - 8, height - 3,
      lit ? litGlass : shade(glass, face.tint));
    // Profiled cladding, or brick piers -- the vertical rhythm of a big wall.
    const ribs = Math.max(3, Math.round(face.len / (brickish ? 11 : 6)));
    for (let k = 1; k < ribs; k++) {
      panel(ctx, face, k / ribs - 0.004, k / ribs + 0.004, 0, height - 9,
        shade(wall, face.tint * (brickish ? 0.88 : 0.93)));
    }
  }

  // Roller doors on a raised loading dock, on whichever visible wall fronts
  // the street. A works backs onto its yard and presents its dock to the road,
  // and putting the doors on a fixed side meant half of them opened onto the
  // fence.
  const front = faces(shed)[face === 0 ? 1 : 0];
  const doors = Math.max(1, Math.round(front.len * DOOR_RATE[zoneKey] / 14));
  const dockH = Math.min(5, height * 0.2);
  panel(ctx, front, 0, 1, 0, dockH, shade('#8e8a80', front.tint));
  for (let k = 0; k < doors; k++) {
    const c = (k + 0.5) / doors;
    const half = 5.5 / front.len;
    const top = Math.min(height - 11, dockH + 13);
    panel(ctx, front, c - half, c + half, dockH, top, shade('#5e5a52', front.tint));
    panel(ctx, front, c - half + 0.004, c + half - 0.004, dockH, top - 1,
      shade(brickish ? '#9a8f72' : '#adb2b4', front.tint));
    if (lit) panel(ctx, front, c - half, c + half, top, top + 1.4, mix('#ffe6b0', WINDOW_LIT, 0.6));
  }

  // The roof: north-light where the shed is wide enough to carry bays, flat
  // with plant where it is not.
  const bays = Math.round((shedV * span) / 0.22);
  if (bays >= 2 && !(heavy && level >= 3)) {
    sawtoothRoof(ctx, origin.x, origin.y, shedU * span, shedV * span, height,
      Math.max(5, Math.round(height * 0.22)), bays, roofColor,
      lit ? litGlass : shade(glass, 0.92));
  } else {
    ctx.fillStyle = shade(roofColor, 1.1);
    rhombusUV(ctx, origin.x, origin.y, shedU * span, shedV * span, height);
    ctx.fill();
    ctx.fillStyle = shade(roofColor, 0.88);
    rhombusUV(ctx, origin.x + TILE_W * 0.03 * span, origin.y + TILE_H * 0.05 * span,
      shedU * span * 0.9, shedV * span * 0.86, height);
    ctx.fill();
    // Extract fans, which every flat industrial roof carries.
    for (let k = 0; k < 3; k++) {
      const p = S(0.2 + k * 0.28, 0.06 + (k % 2) * 0.12);
      isoBox(ctx, p.x, p.y - height, 0.12 * span, 4, { wall: '#8d9296', roof: '#676c70' });
    }
  }

  // An office, on the corner, so the works has a front door. Two storeys of
  // ordinary windows -- the one place a works does look like a building.
  if (level >= 2) {
    const o = face === 0 ? S(shedU + 0.02, 0.04) : S(0.03, shedV + 0.04);
    const officeH = Math.round(height * 0.62);
    const office = isoSlab(ctx, o.x, o.y, 0.3 * span, 0.3 * span, officeH,
      { wall: mix(wall, '#cfd3d0', 0.35), roof: shade(wall, 0.7) });
    for (const face of faces(office)) {
      for (let r = 0; r < 2; r++) {
        const v0 = 5 + r * 9;
        if (v0 + 5 > officeH - 2) break;
        panel(ctx, face, 0.15, 0.85, v0, v0 + 5,
          lit ? litGlass : shade(glass, face.tint));
      }
    }
  }

  // Yard plant, laid out back to front so nothing paints over what is in front
  // of it. This is most of what separates a works from a warehouse.
  const slots = [
    { u: shedU + 0.02, v: 0.05 }, { u: shedU + 0.02, v: 0.3 },
    { u: 0.45, v: shedV + 0.12 }, { u: 0.72, v: shedV + 0.2 },
  ].slice(0, heavy ? 2 + level : 1 + level);
  slots.sort((a, b) => (a.u + a.v) - (b.u + b.v));
  for (const slot of slots) {
    const kind = PLANT[Math.floor(rng() * PLANT.length)];
    drawPlant(ctx, S(slot.u, slot.v), kind, span, heavy, level, wall, lit, rng);
  }

  // A stack is not optional on heavy industry: it is the silhouette.
  if (heavy) {
    const p = S(0.86, 0.08);
    const stackH = height + 10 + level * 6;
    const stack = isoCylinder(ctx, p.x, p.y, 0.2 * span, stackH,
      { wall: brickish ? '#8c6a55' : '#c2bbb0', roof: '#443e37' }, 0.86);
    cylinderBands(ctx, stack, [{ at: 0.92, h: 3, color: brickish ? '#6f5343' : '#a8483c' }]);
    if (lit) {
      ctx.fillStyle = '#ff7a68';
      ctx.beginPath();
      ctx.arc(stack.cx, stack.cy - stackH, 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Palisade fence along the open edges of the plot. A works is fenced, and
  // the fence is what turns a shed on grass into a shed on a works site.
  ctx.strokeStyle = 'rgba(86, 84, 76, 0.75)';
  ctx.lineWidth = 1;
  const a = S(0.99, 0.04), b = S(0.99, 0.99), c = S(0.04, 0.99);
  ctx.beginPath();
  for (const [p, q] of [[a, b], [b, c]]) {
    ctx.moveTo(p.x, p.y - 4); ctx.lineTo(q.x, q.y - 4);
    for (let k = 0; k <= 3; k++) {
      const f = k / 3;
      const px = p.x + (q.x - p.x) * f, py = p.y + (q.y - p.y) * f;
      ctx.moveTo(px, py); ctx.lineTo(px, py - 4);
    }
  }
  ctx.stroke();
}

/** One piece of yard plant. */
function drawPlant(ctx, p, kind, span, heavy, level, wall, lit, rng) {
  const s = span;
  switch (kind) {
    case 'silo': {
      // A pair of silos, because they are never built alone.
      for (const [dx, h] of [[0, 26 + level * 5], [9 * s, 21 + level * 4]]) {
        const silo = isoCylinder(ctx, p.x + dx, p.y + dx * 0.5, 0.13 * s, h,
          { wall: '#c3bfb2', roof: '#8e897c' }, 0.96);
        cylinderBands(ctx, silo, [{ at: 0.88, h: 2, color: 'rgba(70, 66, 58, 0.35)' }]);
      }
      break;
    }
    case 'tank': {
      const tank = isoCylinder(ctx, p.x, p.y, 0.3 * s, 12 + level * 3,
        { wall: '#a7b0ae', roof: '#8a9391' });
      cylinderBands(ctx, tank, [
        { at: 0.35, h: 1.4, color: 'rgba(60, 66, 64, 0.3)' },
        { at: 0.72, h: 1.4, color: 'rgba(60, 66, 64, 0.3)' },
      ]);
      break;
    }
    case 'stack': {
      const h = 18 + level * 5;
      const st = isoCylinder(ctx, p.x, p.y, 0.13 * s, h, { wall: '#b4ada2', roof: '#453f38' }, 0.85);
      cylinderBands(ctx, st, [{ at: 0.9, h: 2.4, color: '#a8483c' }]);
      break;
    }
    case 'hopper': {
      isoBox(ctx, p.x, p.y, 0.26 * s, 9, { wall: '#8f8b80', roof: '#6e6a60' });
      isoBox(ctx, p.x, p.y - 9, 0.18 * s, 13, { wall: '#a5a196', roof: '#7d7a70' });
      break;
    }
    default: {
      // A gantry: two legs and a beam, laid across the screen so it reads.
      const legA = { x: p.x - 13 * s, y: p.y + 6 * s };
      const legB = { x: p.x + 13 * s, y: p.y - 6 * s };
      const H = 17;
      ctx.strokeStyle = '#6b675e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(legA.x, legA.y); ctx.lineTo(legA.x, legA.y - H);
      ctx.moveTo(legB.x, legB.y); ctx.lineTo(legB.x, legB.y - H);
      ctx.stroke();
      ctx.fillStyle = '#8b877c';
      poly(ctx, [
        { x: legA.x, y: legA.y - H }, { x: legB.x, y: legB.y - H },
        { x: legB.x, y: legB.y - H + 3 }, { x: legA.x, y: legA.y - H + 3 },
      ]);
      ctx.fill();
      break;
    }
  }
}
