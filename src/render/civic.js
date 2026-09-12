/**
 * The civic catalogue: power stations, services and parks.
 *
 * Every one of these used to be the same box. `buildingSprite` took the
 * generic wall-and-window grammar the zoned lots use, fed it the building's
 * height and tint, and stopped there -- so a police station, a clinic and a
 * fire station differed only in hue, and the two power stations differed only
 * in how grey they were. At play zoom none of them read as what they are, and
 * a player who has just spent $2,600 on a school deserves to be able to find
 * it without hovering over the tile.
 *
 * So each type is modelled instead. The rule followed throughout: pick the one
 * feature that makes the real building recognisable from a distance -- the
 * appliance bay doors, the drill tower, the portico, the gabled teaching wing,
 * the chimneys, the rows of panels -- and build the silhouette around it.
 * Detail that does not survive being shrunk to forty pixels is not worth
 * drawing, so the identifying feature is always part of the *massing*, with
 * colour and signage only reinforcing it.
 */

import { TILE_W, TILE_H } from '../config.js';
import { FACE, WINDOW_LIT, shade, mix } from './palette.js';
import {
  isoSlab, isoBox, isoCylinder, cylinderBands, rhombusUV, poly,
  groundShadowUV, gableRoofUV, drawTreeAt, faces, panel,
} from './volumes.js';
import { hash2 } from '../util.js';

/**
 * Headroom above the catalogue height each type needs in its sprite canvas.
 *
 * A chimney, a drill tower or a radio mast stands well above the wall height
 * the building is specified at, and a sprite canvas sized from that height
 * alone would guillotine it.
 */
export const CIVIC_HEADROOM = {
  coal: 54, gas: 34, solar: 10, police: 26, fire: 34,
  clinic: 16, school: 30, park: 12, plaza: 18,
};

// ------------------------------------------------------------------ tools --

/** Screen position of the tile-space point (u, v) within a footprint. */
const at = (ox, oy, u, v) => ({ x: ox + (u - v) * (TILE_W / 2), y: oy + (u + v) * (TILE_H / 2) });

/**
 * Regular civic fenestration.
 *
 * Deliberately not the split grammar the zoned lots use. A school, a clinic
 * and a station are all institutional buildings with one window repeated on a
 * fixed bay, and drawing them with the variety grammar is what made them look
 * like offices. Windows are sized in pixels so a long wing and a short wing
 * get the same window, not the same number of windows.
 */
function windowGrid(ctx, box, o) {
  const { rows = 2, floorH = 11, sill = 5, winH = 6, pitch = 9, winW = 5.5 } = o;
  const seed = o.seed || 7;
  for (const face of faces(box)) {
    const n = Math.max(1, Math.round(face.len / pitch));
    const half = (winW / 2) / face.len;
    for (let r = 0; r < rows; r++) {
      const v0 = sill + r * floorH;
      if (v0 + winH > box.height - 2) break;
      for (let k = 0; k < n; k++) {
        const c = (k + 0.5) / n;
        const on = o.lit && hash2(k, r, seed) % 100 < 58;
        const glass = on ? mix(o.glass, WINDOW_LIT, 0.82) : shade(o.glass, face.tint);
        panel(ctx, face, c - half, c + half, v0, v0 + winH, glass);
        if (o.frame) {
          ctx.strokeStyle = shade(o.frame, face.tint * 1.05);
          ctx.lineWidth = 0.8;
          ctx.stroke();
        }
      }
    }
  }
}

/** A flat shape lying on the ground or a roof, given in tile-space points. */
function flatShape(ctx, ox, oy, pts, lift, fill) {
  ctx.fillStyle = fill;
  ctx.beginPath();
  pts.forEach(([u, v], k) => {
    const p = at(ox, oy, u, v);
    if (k === 0) ctx.moveTo(p.x, p.y - lift);
    else ctx.lineTo(p.x, p.y - lift);
  });
  ctx.closePath();
  ctx.fill();
}

/** The twelve corners of a plus sign, centred on (cu, cv). */
function crossPoints(cu, cv, arm, thick) {
  const a = arm, t = thick;
  return [
    [-t, -a], [t, -a], [t, -t], [a, -t], [a, t], [t, t],
    [t, a], [-t, a], [-t, t], [-a, t], [-a, -t], [-t, -t],
  ].map(([u, v]) => [cu + u, cv + v]);
}

/** A flat plate of ground -- asphalt, paving, gravel, lawn. */
function plate(ctx, ox, oy, u, v, su, sv, fill, edge) {
  const p = at(ox, oy, u, v);
  ctx.fillStyle = fill;
  rhombusUV(ctx, p.x, p.y, su, sv, 0);
  ctx.fill();
  if (edge) {
    ctx.strokeStyle = edge;
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

/** A painted line on the ground, from one tile-space point to another. */
function groundLine(ctx, ox, oy, u0, v0, u1, v1, color, width = 1.2, dash = null) {
  const a = at(ox, oy, u0, v0), b = at(ox, oy, u1, v1);
  ctx.save();
  if (dash) ctx.setLineDash(dash);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.stroke();
  ctx.restore();
}

/** A pole with something on top: flag, lamp, aerial. */
function pole(ctx, ox, oy, u, v, height, color = '#b8bdc4') {
  const p = at(ox, oy, u, v);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.lineTo(p.x, p.y - height);
  ctx.stroke();
  return { x: p.x, y: p.y - height, foot: p };
}

function flagpole(ctx, ox, oy, u, v, height, flag) {
  const top = pole(ctx, ox, oy, u, v, height);
  ctx.fillStyle = flag;
  ctx.beginPath();
  ctx.moveTo(top.x + 1, top.y + 1);
  ctx.lineTo(top.x + 9, top.y + 3.5);
  ctx.lineTo(top.x + 1, top.y + 7);
  ctx.closePath();
  ctx.fill();
}

/** A street lamp, with the pool of light it casts once the sun is down. */
function lamp(ctx, ox, oy, u, v, height, lit) {
  const p = at(ox, oy, u, v);
  if (lit) {
    const glow = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 17);
    glow.addColorStop(0, 'rgba(255, 226, 150, 0.42)');
    glow.addColorStop(1, 'rgba(255, 226, 150, 0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 17, 9, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const top = pole(ctx, ox, oy, u, v, height, '#4e545c');
  ctx.fillStyle = lit ? '#ffe9a8' : '#cfd4d8';
  ctx.beginPath();
  ctx.ellipse(top.x, top.y, 2.4, 1.6, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** A bench: too small to model, big enough to matter in a park. */
function bench(ctx, ox, oy, u, v, along = 'u') {
  const p = at(ox, oy, u, v);
  const d = along === 'u' ? { x: 5, y: 2.5 } : { x: -5, y: 2.5 };
  ctx.strokeStyle = '#6b5843';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(p.x - d.x, p.y - d.y - 3);
  ctx.lineTo(p.x + d.x, p.y + d.y - 3);
  ctx.stroke();
  ctx.strokeStyle = '#4a3d2f';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(p.x - d.x, p.y - d.y);
  ctx.lineTo(p.x + d.x, p.y + d.y);
  ctx.stroke();
}

/**
 * A parked vehicle, drawn small.
 *
 * Cars in the yard are the cheapest possible cue that a building is in use,
 * and for the two stations that keep a fleet they are also a label: nothing
 * says fire station like an appliance sitting on the apron.
 */
function parkedCar(ctx, ox, oy, u, v, body, roof, bar) {
  const p = at(ox, oy, u, v);
  isoBox(ctx, p.x, p.y, 0.34, 4, { wall: body, roof: shade(body, 1.06) });
  const c = at(ox, oy, u + 0.08, v + 0.08);
  isoBox(ctx, c.x, c.y - 4, 0.2, 3, { wall: roof, roof: shade(roof, 1.1) });
  if (bar) {
    ctx.fillStyle = bar;
    ctx.fillRect(c.x - 2, c.y - 8.5, 4, 1.4);
  }
}

// ------------------------------------------------------------- despatchers --

/**
 * Draw one catalogue building at the origin of its footprint.
 *
 * Returns false for a type with no model of its own, so the caller can fall
 * back to the generic box rather than drawing nothing at all.
 */
export function civicSprite(ctx, type, spec, ox, oy, lit) {
  const fn = MODELS[type];
  if (!fn) return false;
  fn(ctx, ox, oy, spec, lit);
  return true;
}

// ------------------------------------------------------------------ police --

function police(ctx, ox, oy, spec, lit) {
  const navy = spec.color;                         // '#3f5b86'
  const stone = '#b3b0a4';
  const trim = shade(navy, 0.8);

  groundShadowUV(ctx, ox, oy, 2, 2, spec.height);
  plate(ctx, ox, oy, 0, 0, 2, 2, '#6e7166');
  plate(ctx, ox, oy, 0.95, 1.25, 1.05, 0.75, '#55575a');   // the yard

  // Two-storey stone block with a navy plinth, set back behind its forecourt.
  const p = at(ox, oy, 0, 0);
  const main = isoSlab(ctx, p.x, p.y, 2, 1.25, spec.height, {
    wall: stone, roof: shade(navy, 0.62),
  });
  for (const face of faces(main)) panel(ctx, face, 0, 1, 0, 7, shade(navy, face.tint * 0.9));
  windowGrid(ctx, main, { rows: 2, floorH: 11, sill: 10, winH: 7, pitch: 10, glass: '#9fb4c6', lit, seed: 31 });
  // Cornice and roof deck. A civic building of this period would have a
  // cornice; what it would not have is a black well where its roof should be,
  // which is what a strongly tinted recess reads as from above.
  ctx.fillStyle = shade(stone, 1.2);
  rhombusUV(ctx, p.x, p.y, 2, 1.25, spec.height);
  ctx.fill();
  ctx.fillStyle = '#7a7d80';
  rhombusUV(ctx, p.x + TILE_W * 0.04, p.y + TILE_H * 0.08, 1.84, 1.09, spec.height);
  ctx.fill();
  ctx.fillStyle = '#8b8e90';
  rhombusUV(ctx, p.x + TILE_W * 0.1, p.y + TILE_H * 0.2, 1.6, 0.85, spec.height);
  ctx.fill();
  // Plant and a stair head, so it reads as a roof and not as a lid.
  const plantA = at(ox, oy, 1.35, 0.3);
  isoBox(ctx, plantA.x, plantA.y - spec.height, 0.34, 6, { wall: '#9aa0a4', roof: '#6e7376' });
  const plantB = at(ox, oy, 0.55, 0.85);
  isoBox(ctx, plantB.x, plantB.y - spec.height, 0.24, 4, { wall: '#8f9498', roof: '#686d70' });

  // The portico. Four columns and a pediment: the one thing that reads as
  // "station house" rather than "office" at any zoom.
  const e = at(ox, oy, 0.3, 1.25);
  const entry = isoSlab(ctx, e.x, e.y, 1.4, 0.55, 17, { wall: stone, roof: shade(stone, 0.74) });
  const front = faces(entry)[0];
  panel(ctx, front, 0.34, 0.66, 0, 11, shade('#39424f', front.tint));   // the doorway
  for (let k = 0; k < 4; k++) {
    const c = 0.12 + k * 0.254;
    panel(ctx, front, c - 0.035, c + 0.035, 0, 15, shade(stone, front.tint * 1.16));
  }
  // Blue lamps either side of the door, which are lit at night.
  for (const c of [0.26, 0.74]) {
    const x = front.anchor.x + front.dir.x * c;
    const y = front.anchor.y + front.dir.y * c - 12;
    if (lit) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 8);
      glow.addColorStop(0, 'rgba(120, 170, 255, 0.75)');
      glow.addColorStop(1, 'rgba(120, 170, 255, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(x, y, 8, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = lit ? '#cfe2ff' : '#4b6ea8';
    ctx.beginPath(); ctx.arc(x, y, 2, 0, Math.PI * 2); ctx.fill();
  }

  // Mast and dish on the roof; a station is a radio station too.
  const mast = pole(ctx, ox, oy, 0.45, 0.3, spec.height + 22, '#5a5f66');
  ctx.strokeStyle = '#5a5f66';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(mast.x - 4, mast.y + 4); ctx.lineTo(mast.x + 4, mast.y + 4);
  ctx.moveTo(mast.x - 3, mast.y + 9); ctx.lineTo(mast.x + 3, mast.y + 9);
  ctx.stroke();
  if (lit) {
    ctx.fillStyle = '#e06a5c';
    ctx.fillRect(mast.x - 1, mast.y - 2, 2, 2);
  }

  flagpole(ctx, ox, oy, 1.82, 1.1, 26, '#c8cdd4');
  parkedCar(ctx, ox, oy, 1.12, 1.42, '#dfe3e6', navy, lit ? '#7fc4ff' : '#3f72c0');
  parkedCar(ctx, ox, oy, 1.5, 1.66, '#dfe3e6', navy, lit ? '#ff8f7a' : '#c05050');
}

// -------------------------------------------------------------------- fire --

function fire(ctx, ox, oy, spec, lit) {
  const red = spec.color;                          // '#9c3b32'
  const brick = mix(red, '#6b3a30', 0.35);
  const door = '#d8b24a';

  groundShadowUV(ctx, ox, oy, 2, 2, spec.height + 16);
  plate(ctx, ox, oy, 0, 0, 2, 2, '#6e7166');
  plate(ctx, ox, oy, 0, 1.85, 2, 0.15, '#5c5e60');           // the apron
  // Hatched kerb: keep clear of the appliance doors.
  for (let k = 0; k < 6; k++) {
    groundLine(ctx, ox, oy, 0.15 + k * 0.3, 1.98, 0.35 + k * 0.3, 1.86, '#d9d4c4', 1.4);
  }

  // Rear block: the watch room and the dormitory above it.
  const r = at(ox, oy, 0, 0);
  const rear = isoSlab(ctx, r.x, r.y, 2, 1.0, spec.height, { wall: brick, roof: shade(brick, 0.58) });
  windowGrid(ctx, rear, { rows: 2, floorH: 11, sill: 6, winH: 6, pitch: 9, glass: '#a7b6bd', lit, seed: 17 });

  // The drill tower, where hose is hung to dry. Tall, narrow and unmistakable.
  const t = at(ox, oy, 1.5, 0.06);
  const tower = isoSlab(ctx, t.x, t.y, 0.5, 0.5, spec.height + 20, { wall: brick, roof: shade(brick, 0.5) });
  for (const face of faces(tower)) {
    for (let k = 0; k < 3; k++) panel(ctx, face, 0.28, 0.72, 12 + k * 12, 19 + k * 12, shade('#2f3438', face.tint));
  }
  ctx.fillStyle = shade(brick, 1.2);
  rhombusUV(ctx, t.x, t.y, 0.62, 0.62, spec.height + 20);
  ctx.fill();

  // The appliance bay: a low wide shed whose whole frontage is doors.
  const b = at(ox, oy, 0, 1.0);
  const bay = isoSlab(ctx, b.x, b.y, 2, 0.85, 19, { wall: red, roof: shade(red, 0.55) });
  const front = faces(bay)[0];
  for (const c of [0.27, 0.73]) {
    panel(ctx, front, c - 0.2, c + 0.2, 0, 15, shade('#efe7d6', front.tint));          // surround
    panel(ctx, front, c - 0.17, c + 0.17, 0, 13.5, shade(door, front.tint * 0.98));    // the door
    // Roller slats, so it reads as a door and not as a yellow rectangle.
    for (let k = 1; k < 5; k++) {
      panel(ctx, front, c - 0.17, c + 0.17, k * 2.7, k * 2.7 + 0.7, shade(door, front.tint * 0.8));
    }
    if (lit) {
      const x = front.anchor.x + front.dir.x * c, y = front.anchor.y + front.dir.y * c - 17;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, 14);
      glow.addColorStop(0, 'rgba(255, 228, 168, 0.5)');
      glow.addColorStop(1, 'rgba(255, 228, 168, 0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(x, y, 14, 0, Math.PI * 2); ctx.fill();
    }
  }
  // A white band across the bay parapet, the way stations are signed.
  panel(ctx, front, 0.04, 0.96, 15.5, 18, shade('#efe7d6', front.tint));

  flagpole(ctx, ox, oy, 1.95, 1.6, 22, '#c8cdd4');
  parkedCar(ctx, ox, oy, 0.55, 1.95, red, shade(red, 0.8), lit ? '#ff8f7a' : '#c8443a');
}

// ------------------------------------------------------------------ clinic --

function clinic(ctx, ox, oy, spec, lit) {
  const cream = spec.color;                        // '#c9c3b6'
  const cross = '#c4453c';

  groundShadowUV(ctx, ox, oy, 2, 2, spec.height);
  plate(ctx, ox, oy, 0, 0, 2, 2, '#7d8a6e');
  plate(ctx, ox, oy, 0.2, 1.3, 1.8, 0.7, '#8e9188');       // the ambulance bay

  const p = at(ox, oy, 0, 0);
  const main = isoSlab(ctx, p.x, p.y, 2, 1.3, spec.height, {
    wall: cream, roof: shade(cream, 0.8),
  });
  // Horizontal ribbon glazing: post-war health-service architecture in one
  // gesture, and it separates the clinic from the punched-window station next
  // door at a glance.
  for (const face of faces(main)) {
    for (let r = 0; r < 3; r++) {
      const v0 = 7 + r * 9;
      if (v0 + 5 > spec.height - 3) break;
      panel(ctx, face, 0.06, 0.94, v0, v0 + 5,
        lit ? mix('#9fb8c4', WINDOW_LIT, 0.78) : shade('#9fb8c4', face.tint));
      panel(ctx, face, 0.06, 0.94, v0 + 5, v0 + 6, shade(cream, face.tint * 0.86));
    }
  }

  // The red cross, twice: on the wall for the near view and on the roof for
  // the far one, where the wall is barely two pixels tall.
  const sign = faces(main)[1];
  panel(ctx, sign, 0.62, 0.86, spec.height - 11, spec.height - 3, shade('#f2efe6', sign.tint));
  panel(ctx, sign, 0.70, 0.78, spec.height - 10, spec.height - 4, shade(cross, sign.tint));
  panel(ctx, sign, 0.65, 0.83, spec.height - 8.5, spec.height - 5.5, shade(cross, sign.tint));

  ctx.fillStyle = shade(cream, 1.12);
  rhombusUV(ctx, p.x, p.y, 2, 1.3, spec.height);
  ctx.fill();
  // Painted flat on the deck, in the plane of the roof -- the identifier that
  // survives at the zoom where the wall is three pixels tall.
  flatShape(ctx, ox, oy, crossPoints(1.0, 0.62, 0.4, 0.14), spec.height, shade(cross, 0.94));
  flatShape(ctx, ox, oy, crossPoints(1.0, 0.62, 0.32, 0.1), spec.height, cross);

  // Rooftop plant.
  const v = at(ox, oy, 1.45, 0.95);
  isoBox(ctx, v.x, v.y - spec.height, 0.42, 6, { wall: shade(cream, 0.9), roof: shade(cream, 0.7) });

  // The porte-cochere ambulances pull under, on four thin posts.
  const canopy = at(ox, oy, 0.35, 1.3);
  for (const [pu, pv] of [[0.35, 1.32], [1.35, 1.32], [0.35, 1.82], [1.35, 1.82]]) {
    const q = at(ox, oy, pu, pv);
    ctx.fillStyle = '#8c8f92';
    ctx.fillRect(q.x - 1, q.y - 13, 2, 13);
  }
  isoSlab(ctx, canopy.x, canopy.y - 13, 1.05, 0.55, 3, { wall: shade(cream, 0.92), roof: shade('#e6e2d8', 1.0) });
  parkedCar(ctx, ox, oy, 0.62, 1.46, '#eceee9', cross, lit ? '#7fc4ff' : '#8fa8c4');
}

// ------------------------------------------------------------------ school --

function school(ctx, ox, oy, spec, lit) {
  const brick = spec.color;                        // '#a8875e'
  const stone = '#ddd6c2';

  groundShadowUV(ctx, ox, oy, 3, 3, spec.height);
  plate(ctx, ox, oy, 0, 0, 3, 3, '#6f8a52');
  plate(ctx, ox, oy, 1.45, 1.35, 1.5, 1.55, '#6f6a60', '#8a8478');   // the ball court
  groundLine(ctx, ox, oy, 1.55, 2.12, 2.85, 2.12, '#e8e4d6', 1.2);
  groundLine(ctx, ox, oy, 2.2, 1.45, 2.2, 2.8, '#e8e4d6', 1.2);
  for (const [hu, hv] of [[1.62, 2.12], [2.78, 2.12]]) {
    const h = at(ox, oy, hu, hv);
    ctx.strokeStyle = '#d8d2c2'; ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.moveTo(h.x, h.y); ctx.lineTo(h.x, h.y - 13); ctx.stroke();
    ctx.fillStyle = '#c96f4a';
    ctx.beginPath(); ctx.ellipse(h.x, h.y - 14, 3, 1.6, 0, 0, Math.PI * 2); ctx.fill();
  }

  // The teaching wing: long, two storeys, a proper ridged roof. A school is a
  // long low building with a lot of identical windows, and the length is what
  // distinguishes it from every other civic block.
  const w = at(ox, oy, 0, 0);
  const wing = isoSlab(ctx, w.x, w.y, 3, 1.15, 26, { wall: brick, roof: shade(brick, 0.6) });
  for (const face of faces(wing)) panel(ctx, face, 0, 1, 0, 5, shade(stone, face.tint * 0.92));
  windowGrid(ctx, wing, { rows: 2, floorH: 10, sill: 7, winH: 7, pitch: 8.5, glass: '#a9bcc4', lit, seed: 53 });
  const ridge = gableRoofUV(ctx, w.x, w.y, 3, 1.15, 26, 11, '#6b4f43', brick);

  // A bell cupola on the ridge, with a clock face.
  const cu = { x: (ridge.ridgeA.x + ridge.ridgeB.x) / 2, y: (ridge.ridgeA.y + ridge.ridgeB.y) / 2 };
  isoBox(ctx, cu.x, cu.y - 12, 0.34, 9, { wall: stone, roof: shade(stone, 0.78) });
  ctx.fillStyle = lit ? '#fff3cf' : '#f5f1e4';
  ctx.beginPath(); ctx.arc(cu.x - 3, cu.y - 14, 2.6, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#4b4436'; ctx.lineWidth = 0.7;
  ctx.beginPath(); ctx.arc(cu.x - 3, cu.y - 14, 2.6, 0, Math.PI * 2); ctx.stroke();
  ctx.fillStyle = '#5d4a3a';
  poly(ctx, [
    { x: cu.x - 5, y: cu.y - 21 }, { x: cu.x, y: cu.y - 27 },
    { x: cu.x + 5, y: cu.y - 21 }, { x: cu.x, y: cu.y - 18 },
  ]);
  ctx.fill();

  // The hall: taller, blank-walled, flat-roofed -- every school has one.
  const h = at(ox, oy, 0.1, 1.15);
  const hall = isoSlab(ctx, h.x, h.y, 1.3, 1.4, 33, { wall: mix(brick, stone, 0.25), roof: shade(brick, 0.55) });
  for (const face of faces(hall)) {
    for (let k = 0; k < 3; k++) {
      const c = 0.2 + k * 0.3;
      panel(ctx, face, c - 0.06, c + 0.06, 17, 27,
        lit ? mix('#a9bcc4', WINDOW_LIT, 0.7) : shade('#a9bcc4', face.tint));
    }
  }
  ctx.fillStyle = '#6b4f43';
  rhombusUV(ctx, h.x, h.y, 1.3, 1.4, 33);
  ctx.fill();
  ctx.fillStyle = '#5d6062';
  rhombusUV(ctx, h.x + TILE_W * 0.05, h.y + TILE_H * 0.1, 1.16, 1.26, 33);
  ctx.fill();
  const vent = at(ox, oy, 0.95, 1.55);
  isoBox(ctx, vent.x, vent.y - 33, 0.28, 5, { wall: '#8d9094', roof: '#63676a' });

  flagpole(ctx, ox, oy, 1.3, 2.95, 26, '#dcdfe3');
  drawTreeAt(ctx, ...treeAt(ox, oy, 0.75, 2.85), 0, 0.85);
  drawTreeAt(ctx, ...treeAt(ox, oy, 1.15, 2.7), 2, 0.75);
}

/** drawTreeAt takes screen x and a base y; this saves repeating the unpack. */
function treeAt(ox, oy, u, v) {
  const p = at(ox, oy, u, v);
  return [p.x, p.y];
}

// ----------------------------------------------------------- power station --

function coal(ctx, ox, oy, spec, lit) {
  const body = spec.color;                         // '#7d7468'
  const metal = mix(body, '#aeb4b8', 0.45);

  groundShadowUV(ctx, ox, oy, 3, 3, spec.height + 30);
  plate(ctx, ox, oy, 0, 0, 3, 3, '#6b6a60');

  // Turbine hall: long, low, ribbed metal, shallow pitch.
  const t = at(ox, oy, 0, 0);
  const hall = isoSlab(ctx, t.x, t.y, 3, 1.1, 24, { wall: metal, roof: shade(metal, 0.7) });
  for (const face of faces(hall)) {
    const n = Math.round(face.len / 6);
    for (let k = 1; k < n; k++) {
      panel(ctx, face, k / n - 0.006, k / n + 0.006, 0, 24, shade(metal, face.tint * 0.86));
    }
    panel(ctx, face, 0.05, 0.95, 15, 20,
      lit ? mix('#b9c6cc', WINDOW_LIT, 0.5) : shade('#b9c6cc', face.tint));
  }
  gableRoofUV(ctx, t.x, t.y, 3, 1.1, 24, 6, shade(metal, 0.8), metal);

  // Two banded chimneys. This is the silhouette the whole building exists for,
  // and they go down before the boiler house, which stands in front of them.
  for (const [u, v, hgt, r] of [[2.25, 0.35, spec.height + 44, 0.32], [2.55, 1.0, spec.height + 32, 0.27]]) {
    const p = at(ox, oy, u, v);
    const stack = isoCylinder(ctx, p.x, p.y, r, hgt, { wall: '#cfc7bb', roof: '#4a443c' }, 0.82);
    cylinderBands(ctx, stack, [
      { at: 0.93, h: 4, color: '#b24a3c' },
      { at: 0.81, h: 4, color: '#b24a3c' },
    ]);
    if (lit) {
      ctx.fillStyle = '#ff7a68';
      ctx.beginPath(); ctx.arc(stack.cx, stack.cy - hgt, 1.8, 0, Math.PI * 2); ctx.fill();
    }
  }

  // Boiler house: the tall blind mass the chimneys rise out of.
  const b = at(ox, oy, 0.15, 1.1);
  const boiler = isoSlab(ctx, b.x, b.y, 1.6, 1.5, spec.height, { wall: body, roof: shade(body, 0.58) });
  for (const face of faces(boiler)) {
    for (let k = 0; k < 4; k++) {
      panel(ctx, face, 0.1, 0.9, 8 + k * 10, 10 + k * 10, shade(body, face.tint * 0.78));
    }
    if (lit) panel(ctx, face, 0.32, 0.46, 6, 12, mix('#d8a45a', WINDOW_LIT, 0.5));
  }
  isoBox(ctx, b.x, b.y - spec.height, 0.5, 7, { wall: shade(body, 1.08), roof: shade(body, 0.7) });

  // The fuel yard: a heap of coal under a grab gantry. The gantry is set on
  // the anti-diagonal on purpose -- a run laid the other way projects to a
  // near-vertical line a pixel wide, which is what the conveyor it replaces
  // looked like.
  const heap = at(ox, oy, 2.3, 2.3);
  ctx.fillStyle = '#332f2c';
  ctx.beginPath();
  ctx.moveTo(heap.x - 30, heap.y);
  ctx.bezierCurveTo(heap.x - 20, heap.y - 19, heap.x + 10, heap.y - 20, heap.x + 30, heap.y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = '#4c4741';
  ctx.beginPath();
  ctx.moveTo(heap.x - 30, heap.y);
  ctx.bezierCurveTo(heap.x - 20, heap.y - 19, heap.x - 3, heap.y - 20, heap.x + 4, heap.y - 15);
  ctx.bezierCurveTo(heap.x - 2, heap.y - 7, heap.x - 12, heap.y - 2, heap.x - 30, heap.y);
  ctx.closePath();
  ctx.fill();

  const legA = at(ox, oy, 1.75, 2.85), legB = at(ox, oy, 2.9, 1.7);
  const BEAM = 30;
  ctx.strokeStyle = '#6e6a62';
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(legA.x, legA.y); ctx.lineTo(legA.x, legA.y - BEAM);
  ctx.moveTo(legB.x, legB.y); ctx.lineTo(legB.x, legB.y - BEAM);
  ctx.stroke();
  ctx.fillStyle = '#8e8a80';
  poly(ctx, [
    { x: legA.x, y: legA.y - BEAM }, { x: legB.x, y: legB.y - BEAM },
    { x: legB.x, y: legB.y - BEAM + 4 }, { x: legA.x, y: legA.y - BEAM + 4 },
  ]);
  ctx.fill();
  // The grab, hanging over the heap.
  const grabX = (legA.x + legB.x) / 2;
  const grabY = (legA.y + legB.y) / 2 - BEAM;
  ctx.strokeStyle = '#57544e';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(grabX, grabY + 4); ctx.lineTo(grabX, grabY + 15); ctx.stroke();
  ctx.fillStyle = '#5f5b54';
  ctx.fillRect(grabX - 4, grabY + 15, 8, 5);
}

function gas(ctx, ox, oy, spec, lit) {
  const body = spec.color;                         // '#8d8577'
  const metal = mix(body, '#b8bec2', 0.5);
  const holder = '#9aa49c';

  groundShadowUV(ctx, ox, oy, 3, 3, spec.height);
  plate(ctx, ox, oy, 0, 0, 3, 3, '#6f6e64');

  // Turbine hall, as at the coal station -- same industry, same shed.
  const t = at(ox, oy, 0, 0);
  const hall = isoSlab(ctx, t.x, t.y, 3, 1.2, 26, { wall: metal, roof: shade(metal, 0.72) });
  for (const face of faces(hall)) {
    const n = Math.round(face.len / 6);
    for (let k = 1; k < n; k++) {
      panel(ctx, face, k / n - 0.006, k / n + 0.006, 0, 26, shade(metal, face.tint * 0.86));
    }
    panel(ctx, face, 0.05, 0.95, 16, 22,
      lit ? mix('#bccbd2', WINDOW_LIT, 0.5) : shade('#bccbd2', face.tint));
  }
  gableRoofUV(ctx, t.x, t.y, 3, 1.2, 26, 7, shade(metal, 0.82), metal);

  // One slim stack: gas burns cleaner, and the silhouette should say so.
  const sp = at(ox, oy, 2.55, 0.3);
  const stack = isoCylinder(ctx, sp.x, sp.y, 0.24, spec.height + 14, { wall: '#c6c0b4', roof: '#4a443c' }, 0.88);
  cylinderBands(ctx, stack, [{ at: 0.95, h: 3.5, color: '#b24a3c' }]);
  if (lit) {
    ctx.fillStyle = '#ff7a68';
    ctx.beginPath(); ctx.arc(stack.cx, stack.cy - spec.height - 14, 1.6, 0, Math.PI * 2); ctx.fill();
  }

  // The gas holders: two fat cylinders, which nothing else in the game has.
  const pipe = (u0, v0, u1, v1) => {
    const a = at(ox, oy, u0, v0), b = at(ox, oy, u1, v1);
    ctx.strokeStyle = '#8d9296'; ctx.lineWidth = 3.5;
    ctx.beginPath(); ctx.moveTo(a.x, a.y - 9); ctx.lineTo(b.x, b.y - 9); ctx.stroke();
    ctx.strokeStyle = '#aab0b4'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(a.x, a.y - 10.5); ctx.lineTo(b.x, b.y - 10.5); ctx.stroke();
  };
  pipe(0.55, 1.45, 1.95, 2.35);

  for (const [u, v, r, hgt] of [[0.1, 1.2, 0.8, 50], [1.55, 1.95, 0.68, 38]]) {
    const p = at(ox, oy, u, v);
    const tank = isoCylinder(ctx, p.x, p.y, r, hgt, { wall: holder, roof: shade(holder, 0.86) });
    cylinderBands(ctx, tank, [
      { at: 0.3, h: 1.6, color: 'rgba(40, 46, 44, 0.28)' },
      { at: 0.62, h: 1.6, color: 'rgba(40, 46, 44, 0.28)' },
      { at: 0.9, h: 1.6, color: 'rgba(40, 46, 44, 0.28)' },
    ]);
    // The spiral guide rail, which is what makes a gas holder look like one.
    ctx.strokeStyle = 'rgba(60, 66, 62, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(tank.cx - tank.rx, tank.cy - hgt * 0.15);
    ctx.lineTo(tank.cx + tank.rx, tank.cy - hgt * 0.75);
    ctx.stroke();
  }
}

function solar(ctx, ox, oy, spec, lit) {
  const panelDark = '#26304a';
  const panelLit = '#4d6a92';

  plate(ctx, ox, oy, 0, 0, 4, 4, '#8a8470');
  // Gravel speckle, so the ground under the array does not read as tarmac.
  for (let k = 0; k < 90; k++) {
    const u = (hash2(k, 3, 91) / 4294967296) * 3.8 + 0.1;
    const v = (hash2(k, 5, 97) / 4294967296) * 3.8 + 0.1;
    const p = at(ox, oy, u, v);
    ctx.fillStyle = k % 3 ? 'rgba(120, 114, 96, 0.6)' : 'rgba(158, 152, 132, 0.6)';
    ctx.fillRect(p.x, p.y, 1.4, 1);
  }

  // Rows of tilted arrays, drawn back to front. The tilt is the whole model:
  // a flat blue square reads as a pond, a tilted plane reads as a panel.
  for (let row = 0; row < 5; row++) {
    const v = 0.42 + row * 0.76;
    const lo = at(ox, oy, 0.3, v), hi = at(ox, oy, 0.3, v - 0.4);
    const lo2 = at(ox, oy, 3.7, v), hi2 = at(ox, oy, 3.7, v - 0.4);
    const RISE_LOW = 4, RISE_HIGH = 12;

    // Legs, then the panel plane, then the mullions.
    ctx.strokeStyle = '#5d6066';
    ctx.lineWidth = 1.4;
    for (let k = 0; k <= 4; k++) {
      const f = k / 4;
      const b = { x: lo.x + (lo2.x - lo.x) * f, y: lo.y + (lo2.y - lo.y) * f };
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x, b.y - RISE_LOW); ctx.stroke();
    }

    const quad = [
      { x: hi.x, y: hi.y - RISE_HIGH }, { x: hi2.x, y: hi2.y - RISE_HIGH },
      { x: lo2.x, y: lo2.y - RISE_LOW }, { x: lo.x, y: lo.y - RISE_LOW },
    ];
    const grad = ctx.createLinearGradient(quad[0].x, quad[0].y, quad[2].x, quad[2].y);
    grad.addColorStop(0, lit ? '#1b2338' : panelLit);
    grad.addColorStop(0.55, lit ? '#161d2e' : panelDark);
    grad.addColorStop(1, lit ? '#1e2740' : shade(panelDark, 1.18));
    ctx.fillStyle = grad;
    poly(ctx, quad);
    ctx.fill();

    ctx.strokeStyle = 'rgba(150, 170, 200, 0.35)';
    ctx.lineWidth = 0.7;
    ctx.beginPath();
    for (let k = 1; k < 10; k++) {
      const f = k / 10;
      ctx.moveTo(quad[0].x + (quad[1].x - quad[0].x) * f, quad[0].y + (quad[1].y - quad[0].y) * f);
      ctx.lineTo(quad[3].x + (quad[2].x - quad[3].x) * f, quad[3].y + (quad[2].y - quad[3].y) * f);
    }
    ctx.moveTo((quad[0].x + quad[3].x) / 2, (quad[0].y + quad[3].y) / 2);
    ctx.lineTo((quad[1].x + quad[2].x) / 2, (quad[1].y + quad[2].y) / 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(210, 226, 246, 0.5)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(quad[0].x, quad[0].y); ctx.lineTo(quad[1].x, quad[1].y);
    ctx.stroke();
  }

  // Inverter housing and a transformer, at the corner nearest the viewer.
  const s = at(ox, oy, 3.1, 3.5);
  isoBox(ctx, s.x, s.y, 0.55, 9, { wall: '#a9a798', roof: '#7d7c70' });
  const tr = at(ox, oy, 3.62, 3.1);
  isoBox(ctx, tr.x, tr.y, 0.3, 6, { wall: '#8d9298', roof: '#5f646a' });
  if (lit) {
    ctx.fillStyle = 'rgba(255, 226, 150, 0.8)';
    ctx.fillRect(s.x - 2, s.y - 6, 3, 2);
  }
}

// ------------------------------------------------------------------- parks --

function park(ctx, ox, oy, spec, lit) {
  plate(ctx, ox, oy, 0, 0, 1, 1, '#5c8a3f', '#4a7333');
  // Two mown tones, so a run of parks does not read as one flat green field.
  ctx.fillStyle = 'rgba(122, 166, 88, 0.5)';
  rhombusUV(ctx, at(ox, oy, 0.1, 0.1).x, at(ox, oy, 0.1, 0.1).y, 0.45, 0.8, 0);
  ctx.fill();

  // A path across the corner, a bed of planting, benches, and trees of three
  // different sizes -- a park is variety, and the old one had two clones.
  groundLine(ctx, ox, oy, 0.05, 0.62, 0.95, 0.38, '#c3b596', 2.6);
  ctx.fillStyle = '#b8546a';
  rhombusUV(ctx, at(ox, oy, 0.58, 0.06).x, at(ox, oy, 0.58, 0.06).y, 0.34, 0.22, 0);
  ctx.fill();

  bench(ctx, ox, oy, 0.34, 0.5);
  bench(ctx, ox, oy, 0.76, 0.62, 'v');
  drawTreeAt(ctx, ...treeAt(ox, oy, 0.22, 0.26), 0, 0.9);
  drawTreeAt(ctx, ...treeAt(ox, oy, 0.76, 0.2), 1, 0.7);
  drawTreeAt(ctx, ...treeAt(ox, oy, 0.45, 0.86), 2, 1);
  lamp(ctx, ox, oy, 0.55, 0.52, 14, lit);
}

function plaza(ctx, ox, oy, spec, lit) {
  const stone = spec.color;                        // '#a89a80'
  plate(ctx, ox, oy, 0, 0, 2, 2, stone, shade(stone, 0.78));
  // Paving joints. Regular, because that is what makes paving read as paving.
  ctx.strokeStyle = shade(stone, 0.86);
  ctx.lineWidth = 0.7;
  for (let k = 1; k < 8; k++) {
    groundLine(ctx, ox, oy, k * 0.25, 0, k * 0.25, 2, shade(stone, 0.86), 0.7);
    groundLine(ctx, ox, oy, 0, k * 0.25, 2, k * 0.25, shade(stone, 0.86), 0.7);
  }
  // A darker inlaid border and a band of planting at the back.
  ctx.strokeStyle = shade(stone, 0.7);
  ctx.lineWidth = 2;
  rhombusUV(ctx, at(ox, oy, 0.18, 0.18).x, at(ox, oy, 0.18, 0.18).y, 1.64, 1.64, 0);
  ctx.stroke();

  // The fountain: a raised basin with water in it and a jet above.
  const f = at(ox, oy, 0.74, 0.74);
  isoCylinder(ctx, f.x, f.y, 0.52, 5, { wall: shade(stone, 1.08), roof: '#5f8fa8' });
  ctx.fillStyle = lit ? '#8fc4dd' : '#79b2cc';
  ctx.beginPath();
  ctx.ellipse(f.x, f.y + (0.52 * TILE_H) / 2 - 5, (0.52 * TILE_W) / 2 - 2, (0.52 * TILE_H) / 2 - 1, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(225, 242, 250, 0.85)';
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(f.x, f.y + (0.52 * TILE_H) / 2 - 6);
  ctx.lineTo(f.x, f.y + (0.52 * TILE_H) / 2 - 17);
  ctx.stroke();
  ctx.fillStyle = 'rgba(225, 242, 250, 0.6)';
  ctx.beginPath();
  ctx.ellipse(f.x, f.y + (0.52 * TILE_H) / 2 - 18, 3.4, 1.8, 0, 0, Math.PI * 2);
  ctx.fill();

  bench(ctx, ox, oy, 0.4, 1.5);
  bench(ctx, ox, oy, 1.5, 1.4, 'v');
  bench(ctx, ox, oy, 1.55, 0.45);
  drawTreeAt(ctx, ...treeAt(ox, oy, 0.28, 0.3), 1, 0.85);
  drawTreeAt(ctx, ...treeAt(ox, oy, 1.72, 0.9), 0, 0.75);
  lamp(ctx, ox, oy, 0.3, 1.1, 16, lit);
  lamp(ctx, ox, oy, 1.35, 1.85, 16, lit);
}

const MODELS = { police, fire, clinic, school, coal, gas, solar, park, plaza };
