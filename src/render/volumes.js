/**
 * Isometric volumes.
 *
 * The vocabulary every drawn structure is built from: boxes, cylinders, roofs
 * and the shading that makes them read as solid. Kept apart from the buildings
 * themselves so the zoned-lot art and the civic catalogue can share one set of
 * primitives instead of each growing its own.
 *
 * Geometry convention: a footprint's *origin* is the top corner of its
 * rhombus. Footprints are measured in tiles along two axes -- `su` runs to the
 * lower right, `sv` to the lower left -- so a square span-N plot is su = sv = N:
 *
 *        top (0, 0)
 *        /        \
 *   left            right   left = (-sv*W/2, sv*H/2), right = (su*W/2, su*H/2)
 *        \        /
 *       bottom            bottom = ((su-sv)*W/2, (su+sv)*H/2)
 */

import { TILE_W, TILE_H } from '../config.js';
import { FACE, TREE_COLORS, shade } from './palette.js';
import { hash2, clamp } from '../util.js';

export function makeCanvas(w, h) {
  return typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(w, h)
    : Object.assign(document.createElement('canvas'), { width: w, height: h });
}

// ------------------------------------------------------------- primitives --

/** Offset in screen pixels for a displacement of (u, v) tiles. */
export function isoOffset(u, v) {
  return { x: (u - v) * (TILE_W / 2), y: (u + v) * (TILE_H / 2) };
}

/** The four corners of an su x sv footprint, lifted by `lift` pixels. */
export function corners(ox, oy, su, sv, lift = 0) {
  const uw = (su * TILE_W) / 2, uh = (su * TILE_H) / 2;
  const vw = (sv * TILE_W) / 2, vh = (sv * TILE_H) / 2;
  return {
    top: { x: ox, y: oy - lift },
    right: { x: ox + uw, y: oy + uh - lift },
    left: { x: ox - vw, y: oy + vh - lift },
    bottom: { x: ox + uw - vw, y: oy + uh + vh - lift },
    uw, uh, vw, vh,
  };
}

/** Trace the rhombus of an su x sv footprint, lifted by `lift` pixels. */
export function rhombusUV(ctx, ox, oy, su, sv, lift = 0) {
  const c = corners(ox, oy, su, sv, lift);
  ctx.beginPath();
  ctx.moveTo(c.top.x, c.top.y);
  ctx.lineTo(c.right.x, c.right.y);
  ctx.lineTo(c.bottom.x, c.bottom.y);
  ctx.lineTo(c.left.x, c.left.y);
  ctx.closePath();
}

/** Trace the rhombus of a square span-N footprint. */
export function rhombus(ctx, ox, oy, span, lift = 0) {
  rhombusUV(ctx, ox, oy, span, span, lift);
}

/** Trace a polygon. */
export function poly(ctx, pts) {
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

export function occludeFace(ctx, pts, baseY, height) {
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
export function groundShadow(ctx, ox, oy, span, height = 0) {
  const reach = clamp(height * 0.22, 0, 14);
  for (let k = 3; k >= 1; k--) {
    const grow = 1 + k * 0.07;
    const oyAdj = oy + ((span - span * grow) * TILE_H) / 2;
    ctx.fillStyle = 'rgba(26, 32, 22, 0.075)';
    rhombus(ctx, ox + 3 + reach, oyAdj + 2 + reach * 0.5, span * grow, 0);
    ctx.fill();
  }
}

/** The same, for a footprint that is not square. */
export function groundShadowUV(ctx, ox, oy, su, sv, height = 0) {
  const reach = clamp(height * 0.22, 0, 14);
  for (let k = 3; k >= 1; k--) {
    const grow = 1 + k * 0.07;
    ctx.fillStyle = 'rgba(26, 32, 22, 0.065)';
    rhombusUV(ctx, ox + 3 + reach, oy + 2 + reach * 0.5 - ((su + sv) * (grow - 1) * TILE_H) / 4,
      su * grow, sv * grow, 0);
    ctx.fill();
  }
}

/**
 * A solid isometric slab: roof, front-left face, front-right face.
 *
 * Returns its geometry so callers can decorate the faces. `su` and `sv` are
 * the footprint's extent in tiles along each axis, which is what lets a long
 * teaching wing or a squat turbine hall be one volume rather than a row of
 * cubes pretending to be one.
 */
export function isoSlab(ctx, ox, oy, su, sv, height, colors) {
  const c = corners(ox, oy, su, sv);
  const { top, left, right, bottom } = c;

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
  rhombusUV(ctx, ox, oy, su, sv, height);
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
    ctx.lineTo(top.x, top.y - height);
    ctx.lineTo(right.x, right.y - height);
    ctx.stroke();
  }

  return {
    ox, oy, su, sv, span: su, height,
    top, bottom, left, right,
    w2: c.uw, h2: c.uh, uw: c.uw, uh: c.uh, vw: c.vw, vh: c.vh,
  };
}

/** A solid isometric box on a square footprint. */
export function isoBox(ctx, ox, oy, span, height, colors) {
  return isoSlab(ctx, ox, oy, span, span, height, colors);
}

/**
 * An upright cylinder: chimneys, gas holders, cooling towers, silos.
 *
 * Shaded with a horizontal gradient rather than two flat faces, because a
 * cylinder faceted into a box is exactly the thing that makes a power station
 * read as another office block. `taper` narrows the top, which is what tells a
 * cooling tower apart from a storage tank.
 */
export function isoCylinder(ctx, ox, oy, span, height, colors, taper = 1) {
  const rx = (span * TILE_W) / 2;
  const ry = (span * TILE_H) / 2;
  const cx = ox, cy = oy + ry;               // centre of the base ellipse
  const tx = rx * taper, ty = ry * taper;

  const grad = ctx.createLinearGradient(cx - rx, 0, cx + rx, 0);
  grad.addColorStop(0, shade(colors.wall, FACE.left * 0.92));
  grad.addColorStop(0.38, shade(colors.wall, 1.1));
  grad.addColorStop(1, shade(colors.wall, FACE.right * 0.88));
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(cx - tx, cy - height);
  ctx.lineTo(cx - rx, cy);
  ctx.ellipse(cx, cy, rx, ry, 0, Math.PI, 0, true);   // the near half of the base
  ctx.lineTo(cx + tx, cy - height);
  ctx.ellipse(cx, cy - height, tx, ty, 0, 0, Math.PI, true);
  ctx.closePath();
  ctx.fill();

  // The foot, in shadow, and the open top.
  ctx.fillStyle = 'rgba(24, 28, 22, 0.18)';
  ctx.beginPath();
  ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI);
  ctx.fill();
  ctx.fillStyle = colors.roof || shade(colors.wall, 0.6);
  ctx.beginPath();
  ctx.ellipse(cx, cy - height, tx, ty, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = shade(colors.wall, 1.3);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.ellipse(cx, cy - height, tx, ty, 0, 0, Math.PI * 2);
  ctx.stroke();

  return { cx, cy, rx, ry, tx, ty, height };
}

/** Horizontal bands around a cylinder -- hazard stripes, tank rings. */
export function cylinderBands(ctx, cyl, bands) {
  for (const b of bands) {
    const y = cyl.cy - cyl.height * b.at;
    const k = 1 - (1 - cyl.tx / cyl.rx) * b.at;
    ctx.fillStyle = b.color;
    ctx.beginPath();
    ctx.ellipse(cyl.cx, y, cyl.rx * k, cyl.ry * k, 0, 0, Math.PI);
    ctx.lineTo(cyl.cx - cyl.rx * k, y - b.h);
    // Back along the *near* half of the upper ellipse. Tracing its far half
    // instead bulges the band upward, which turns a hazard stripe into a cap.
    ctx.ellipse(cyl.cx, y - b.h, cyl.rx * k, cyl.ry * k, 0, Math.PI, 0, true);
    ctx.closePath();
    ctx.fill();
  }
}

/** The two faces of a slab the camera can see, with the axis each runs along. */
export function faces(box) {
  return [
    { anchor: box.left, dir: { x: box.uw, y: box.uh }, tint: FACE.left, len: Math.hypot(box.uw, box.uh) },
    { anchor: box.bottom, dir: { x: box.vw, y: -box.vh }, tint: FACE.right, len: Math.hypot(box.vw, box.vh) },
  ];
}

/**
 * A rectangle lying in the plane of one wall.
 *
 * `f0`/`f1` run 0..1 along the face and `v0`/`v1` are heights in pixels above
 * its foot, so a door, a sign or a strip of glazing can be placed without the
 * caller doing any projection of its own.
 */
export function panel(ctx, face, f0, f1, v0, v1, fill) {
  const { anchor, dir } = face;
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.moveTo(anchor.x + dir.x * f0, anchor.y + dir.y * f0 - v0);
  ctx.lineTo(anchor.x + dir.x * f1, anchor.y + dir.y * f1 - v0);
  ctx.lineTo(anchor.x + dir.x * f1, anchor.y + dir.y * f1 - v1);
  ctx.lineTo(anchor.x + dir.x * f0, anchor.y + dir.y * f0 - v1);
  ctx.closePath();
  ctx.fill();
}

/**
 * A north-light roof: a run of asymmetric bays, each a sloped plane with a
 * glazed face standing at its high edge.
 *
 * The single most recognisable industrial roof there is, and the reason a shed
 * reads as a works rather than as a warehouse-shaped house. Bays run across
 * the v axis so the sawtooth profile faces the camera.
 */
export function sawtoothRoof(ctx, ox, oy, su, sv, lift, rise, bays, roof, glass) {
  const P = (u, v, h) => ({
    x: ox + (u - v) * (TILE_W / 2),
    y: oy + (u + v) * (TILE_H / 2) - h,
  });
  const step = sv / bays;
  for (let k = 0; k < bays; k++) {
    const a = k * step, b = a + step;
    // The glazed face, standing at the back edge of this bay...
    ctx.fillStyle = glass;
    poly(ctx, [P(0, a, lift + rise), P(su, a, lift + rise), P(su, a, lift), P(0, a, lift)]);
    ctx.fill();
    ctx.strokeStyle = shade(roof, 0.6);
    ctx.lineWidth = 0.8;
    ctx.stroke();
    // ...and the slope falling away from it towards the viewer.
    ctx.fillStyle = shade(roof, k % 2 ? 1.04 : 0.96);
    poly(ctx, [P(0, a, lift + rise), P(su, a, lift + rise), P(su, b, lift), P(0, b, lift)]);
    ctx.fill();
    ctx.strokeStyle = shade(roof, 1.24);
    ctx.beginPath();
    ctx.moveTo(P(0, a, lift + rise).x, P(0, a, lift + rise).y);
    ctx.lineTo(P(su, a, lift + rise).x, P(su, a, lift + rise).y);
    ctx.stroke();
  }
}

// ------------------------------------------------------------------ roofs --

/** Hipped roof: four triangles meeting at a central apex. */
export function hipRoof(ctx, ox, oy, span, lift, rise, color) {
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

/**
 * Gabled roof: two slopes meeting at a ridge, with a triangular end wall.
 *
 * The ridge runs along the u axis, so a wing that is long in u gets a long
 * ridge rather than a pyramid -- which is the whole reason a school reads as a
 * school and not as a big house.
 */
export function gableRoofUV(ctx, ox, oy, su, sv, lift, rise, color, wall) {
  const c = corners(ox, oy, su, sv, lift);
  const { top, right, bottom, left } = c;
  // Ridge: midway across the v extent, running the length of u.
  const ridgeA = { x: ox - c.vw / 2, y: oy + c.vh / 2 - lift - rise };
  const ridgeB = { x: ridgeA.x + c.uw, y: ridgeA.y + c.uh };

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
  return { ridgeA, ridgeB };
}

/** A gabled roof on a square footprint. */
export function gableRoof(ctx, ox, oy, span, lift, rise, color, wall) {
  return gableRoofUV(ctx, ox, oy, span, span, lift, rise, color, wall);
}

/**
 * Parapet, deck and plant -- what sells a flat roof.
 *
 * This is the surface the camera sees most of, and a bare fill of one colour
 * is why a block of flat-roofed buildings used to read as a grid of tiles
 * rather than as rooftops. A rim, a recessed deck of a different tone, and
 * some plant standing on it are the whole difference.
 */
export function flatRoofDetail(ctx, box, colors, rec) {
  const { ox, oy, height } = box;
  const su = box.su ?? box.span, sv = box.sv ?? box.span;

  // The parapet rim, then the deck recessed inside it.
  const k = 0.84;
  ctx.fillStyle = shade(colors.roof, 1.16);
  rhombusUV(ctx, ox, oy, su, sv, height);
  ctx.fill();
  ctx.fillStyle = shade(colors.roof, 0.9);
  rhombusUV(ctx, ox + ((1 - k) * (su - sv) * TILE_W) / 4,
    oy + ((1 - k) * (su + sv) * TILE_H) / 4, su * k, sv * k, height);
  ctx.fill();

  const w2 = (su * TILE_W) / 2;
  const h2 = ((su + sv) * TILE_H) / 4;
  const span = Math.min(su, sv);

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
  for (let k2 = 0; k2 < units; k2++) {
    const hx = hash2(k2, rec.seed, 71) / 4294967296 - 0.5;
    const hy = hash2(k2, rec.seed, 83) / 4294967296 - 0.5;
    if (Math.abs(hx) + Math.abs(hy) > 0.5) continue;
    const cx = ox + (hx + hy) * w2 * 0.9;
    const cy = oy + h2 - height + (hx - hy) * h2 * 0.9;
    ctx.fillRect(cx - 2, cy - 3, 4, 3);
  }
  for (let k2 = 0; k2 < rec.tanks; k2++) {
    const hx = hash2(k2, rec.seed, 17) / 4294967296;
    const hy = hash2(k2, rec.seed, 29) / 4294967296;
    const u = (hx - 0.5) * 1.1, v = (hy - 0.5) * 1.1;
    if (Math.abs(u) + Math.abs(v) > 0.62) continue;
    const cx = ox + (u + v) * w2;
    const cy = oy + h2 - height + (u - v) * h2;
    const bh = 3 + (rec.seed >> (k2 * 3)) % 6;
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
export function chimney(ctx, box, colors, rec) {
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
export function awning(ctx, box, colors) {
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

// ----------------------------------------------------------------- nature --

/** A single tree, used for terrain scatter, parks and civic grounds. */
export function drawTreeAt(ctx, x, baseY, variant, scale = 1) {
  const c = TREE_COLORS[variant % TREE_COLORS.length];
  ctx.fillStyle = 'rgba(28, 34, 24, 0.18)';
  ctx.beginPath();
  ctx.ellipse(x + 3 * scale, baseY - 1, 8 * scale, 4 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = c.trunk;
  ctx.fillRect(x - 1 * scale, baseY - 7 * scale, 2 * scale, 7 * scale);
  ctx.fillStyle = c.canopy;
  ctx.beginPath();
  ctx.ellipse(x, baseY - 12 * scale, 7 * scale, 8 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = c.shade;
  ctx.beginPath();
  ctx.ellipse(x + 2.2 * scale, baseY - 10 * scale, 4.4 * scale, 5.4 * scale, 0, 0, Math.PI * 2);
  ctx.fill();
}
