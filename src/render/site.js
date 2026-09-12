/**
 * Building sites.
 *
 * A plot under construction, drawn at whichever of its stages it has reached.
 * The stages are chosen to be legible at forty pixels rather than to be an
 * accurate account of how a house goes up: hoarding and a cleared plot, then
 * groundworks, then a frame, then a shell under scaffold. What matters is that
 * a district being built out looks like a district being built out -- several
 * plots at different stages along the same new lane -- rather than like a row
 * of finished houses that appeared between two glances.
 */

import { TILE_W, TILE_H, BUILD_STAGES } from '../config.js';
import { shade, mix } from './palette.js';
import { isoSlab, isoBox, rhombusUV, poly, groundShadowUV } from './volumes.js';
import { hash2, makeRng } from '../util.js';

/** Ground, hoarding, muck and plant. */
const SITE = {
  ground: '#9a8f76',
  rut: '#8a7f66',
  spoil: '#7d7059',
  hoarding: '#9ba07f',
  hoardingDark: '#7d8265',
  slab: '#b4b0a6',
  footing: '#a09b90',
  frame: '#b79a6e',
  steel: '#8d9298',
  scaffold: '#b8aa83',
  wrap: '#c8cdd2',
  plant: '#d8a53f',
};

/** How tall the frame stands at each stage, as a fraction of the finished wall. */
const FRAME_RISE = [0, 0, 0.18, 0.58, 0.92];

/**
 * Draw the plot at `stage`, on a span-tile footprint anchored at its origin.
 *
 * `targetHeight` is roughly what will eventually stand here, so a site for a
 * tower reads as a bigger job than a site for a house -- the crane and the
 * frame are scaled from it.
 */
export function drawSite(ctx, ox, oy, stage, targetHeight, seed, span = 1, lit = false) {
  const rng = makeRng(hash2(seed * 37 + stage, span * 91, 0x51ed2701));
  const S = (u, v) => ({ x: ox + (u - v) * (TILE_W / 2) * span, y: oy + (u + v) * (TILE_H / 2) * span });
  const k = Math.max(1, Math.min(BUILD_STAGES, stage));

  // The plot: scraped ground, with ruts where the plant has been over it.
  ctx.fillStyle = SITE.ground;
  rhombusUV(ctx, ox, oy, span, span, 0);
  ctx.fill();
  ctx.strokeStyle = SITE.rut;
  ctx.lineWidth = 1.6;
  ctx.beginPath();
  for (let r = 0; r < 3; r++) {
    const a = S(0.08 + r * 0.12, 0.95), b = S(0.95, 0.12 + r * 0.14);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();

  // Hoarding round the two open sides. Present from the first day and kept to
  // the last, because it is the thing that says "site" at any size.
  hoarding(ctx, S, span);

  // A spoil heap and a site hut, from the first stage on.
  const heap = S(0.82, 0.22);
  ctx.fillStyle = SITE.spoil;
  ctx.beginPath();
  ctx.moveTo(heap.x - 11 * span, heap.y);
  ctx.bezierCurveTo(heap.x - 6 * span, heap.y - 8 * span, heap.x + 4 * span, heap.y - 8 * span,
    heap.x + 11 * span, heap.y);
  ctx.closePath();
  ctx.fill();
  const hut = S(0.14, 0.2);
  isoBox(ctx, hut.x, hut.y, 0.22 * span, 6, { wall: '#9aa3a8', roof: '#767d81' });

  if (k >= 2) {
    // Groundworks: footings marked out, then a slab poured inside them.
    const o = S(0.12, 0.12);
    ctx.fillStyle = SITE.footing;
    rhombusUV(ctx, o.x, o.y, 0.76 * span, 0.76 * span, 0);
    ctx.fill();
    ctx.fillStyle = SITE.slab;
    const p = S(0.18, 0.18);
    rhombusUV(ctx, p.x, p.y, 0.64 * span, 0.64 * span, 0);
    ctx.fill();
    ctx.strokeStyle = shade(SITE.slab, 0.8);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  if (k >= 3) {
    // The frame: posts and floor plates, open to the sky. Whether it reads as
    // timber or as steel follows the size of the job, which is how it works.
    const rise = Math.max(7, Math.round(targetHeight * FRAME_RISE[k]));
    const heavy = targetHeight > 40;
    frame(ctx, S, span, rise, heavy, k >= BUILD_STAGES, rng);
  }

  if (k >= BUILD_STAGES) {
    // Topped out: the shell is up and sheeted, with scaffold still round it.
    const o = S(0.18, 0.18);
    const wall = mix(SITE.wrap, '#9a9f9c', 0.3);
    const shell = isoSlab(ctx, o.x, o.y, 0.64 * span, 0.64 * span,
      Math.max(8, Math.round(targetHeight * 0.9)), { wall, roof: shade(wall, 0.82) });
    scaffold(ctx, shell, lit);
  }

  // A crane once the job is big enough to need one.
  if (k >= 3 && targetHeight >= 42) crane(ctx, S, span, targetHeight, lit);

  groundShadowUV(ctx, ox, oy, span, span, 6);
}

/** Site hoarding along the two edges the camera sees. */
function hoarding(ctx, S, span) {
  const a = S(0.99, 0.02), b = S(0.99, 0.99), c = S(0.02, 0.99);
  const H = 7;
  for (const [p, q] of [[a, b], [b, c]]) {
    ctx.fillStyle = SITE.hoarding;
    poly(ctx, [
      { x: p.x, y: p.y - H }, { x: q.x, y: q.y - H },
      { x: q.x, y: q.y }, { x: p.x, y: p.y },
    ]);
    ctx.fill();
    ctx.strokeStyle = SITE.hoardingDark;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let n = 0; n <= 4; n++) {
      const f = n / 4;
      const px = p.x + (q.x - p.x) * f, py = p.y + (q.y - p.y) * f;
      ctx.moveTo(px, py); ctx.lineTo(px, py - H);
    }
    ctx.moveTo(p.x, p.y - H); ctx.lineTo(q.x, q.y - H);
    ctx.stroke();
  }
}

/** Posts and floor plates, open to the sky. */
function frame(ctx, S, span, rise, heavy, topped, rng) {
  const color = heavy ? SITE.steel : SITE.frame;
  const posts = [[0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8], [0.5, 0.5]];
  const floors = Math.max(1, Math.round(rise / 11));

  ctx.strokeStyle = shade(color, 0.9);
  ctx.lineWidth = heavy ? 2.2 : 1.6;
  ctx.beginPath();
  for (const [u, v] of posts) {
    const p = S(u, v);
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x, p.y - rise);
  }
  ctx.stroke();

  // Floor plates, drawn as thin rhombi so the frame reads as storeys rather
  // than as a handful of sticks.
  for (let f = 1; f <= floors; f++) {
    const h = (rise * f) / floors;
    const o = S(0.2, 0.2);
    ctx.fillStyle = topped ? shade(color, 1.05) : `rgba(190, 172, 132, ${0.55 + 0.1 * (f % 2)})`;
    rhombusUV(ctx, o.x, o.y, 0.6 * span, 0.6 * span, h);
    ctx.fill();
    ctx.strokeStyle = shade(color, 0.75);
    ctx.lineWidth = 0.8;
    ctx.stroke();
  }
}

/** Scaffold standing off the face of a shell, with a lift and a sheet of net. */
function scaffold(ctx, box, lit) {
  const { left, bottom, right, height } = box;
  const OUT = 2.5;
  for (const [a, b] of [[left, bottom], [bottom, right]]) {
    ctx.strokeStyle = SITE.scaffold;
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let k = 0; k <= 3; k++) {
      const f = k / 3;
      const px = a.x + (b.x - a.x) * f, py = a.y + (b.y - a.y) * f + OUT;
      ctx.moveTo(px, py); ctx.lineTo(px, py - height - 3);
    }
    for (let lvl = 1; lvl <= Math.max(1, Math.round(height / 12)); lvl++) {
      const h = (height * lvl) / Math.max(1, Math.round(height / 12));
      ctx.moveTo(a.x, a.y + OUT - h); ctx.lineTo(b.x, b.y + OUT - h);
    }
    ctx.stroke();
  }
  if (lit) {
    ctx.fillStyle = '#ffd98a';
    ctx.fillRect(bottom.x - 1, bottom.y - height - 6, 2, 2);
  }
}

/** A tower crane: mast, jib, counter-jib and a hook. */
function crane(ctx, S, span, targetHeight, lit) {
  const base = S(0.92, 0.88);
  const mast = Math.round(targetHeight * 1.15) + 16;
  const top = { x: base.x, y: base.y - mast };

  ctx.strokeStyle = SITE.plant;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(base.x, base.y);
  ctx.lineTo(top.x, top.y);
  ctx.stroke();
  // Lattice, so the mast is not a bare stick.
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  for (let h = 6; h < mast; h += 7) {
    ctx.moveTo(base.x - 2, base.y - h);
    ctx.lineTo(base.x + 2, base.y - h - 3.5);
    ctx.moveTo(base.x + 2, base.y - h);
    ctx.lineTo(base.x - 2, base.y - h - 3.5);
  }
  ctx.stroke();

  const jib = 30 * span;
  ctx.strokeStyle = SITE.plant;
  ctx.lineWidth = 2.4;
  ctx.beginPath();
  ctx.moveTo(top.x - jib * 0.35, top.y + 3);
  ctx.lineTo(top.x + jib, top.y - 2);
  ctx.stroke();
  // Counterweight and hook.
  ctx.fillStyle = '#6f6a60';
  ctx.fillRect(top.x - jib * 0.4, top.y + 1, 6, 5);
  ctx.strokeStyle = '#8d8a80';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(top.x + jib * 0.62, top.y - 1);
  ctx.lineTo(top.x + jib * 0.62, top.y + 16);
  ctx.stroke();
  if (lit) {
    ctx.fillStyle = '#ff7a68';
    ctx.beginPath(); ctx.arc(top.x, top.y - 2, 1.6, 0, Math.PI * 2); ctx.fill();
  }
}
