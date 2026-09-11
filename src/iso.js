/**
 * Isometric projection and camera.
 *
 * The projection is 2:1 dimetric -- one tile is TILE_W wide and TILE_H tall on
 * screen, the same ratio SimCity 3000 used. Elevation lifts a tile straight up
 * the screen, so height reads as height rather than as depth.
 */

import { TILE_W, TILE_H, ELEV_STEP, SEA_LEVEL, MAX_ELEVATION, T } from './config.js';

/** Tile (x, y, elevation) -> world-space pixel of the tile's top corner. */
export function tileToWorld(x, y, elev = 0) {
  return {
    x: (x - y) * (TILE_W / 2),
    y: (x + y) * (TILE_H / 2) - elev * ELEV_STEP,
  };
}

/**
 * World-space pixel -> fractional tile coordinates, ignoring elevation.
 *
 * Inverting the projection exactly would require knowing the height of the
 * tile under the cursor before we know which tile that is. Callers resolve
 * that by probing candidate tiles from far to near (see pickTile).
 */
export function worldToTile(wx, wy) {
  const a = wx / (TILE_W / 2);
  const b = wy / (TILE_H / 2);
  return { x: (b + a) / 2, y: (b - a) / 2 };
}

export class Camera {
  constructor(viewW, viewH) {
    this.x = 0;            // world-space pixel at the centre of the viewport
    this.y = 0;
    this.zoom = 1;
    this.minZoom = 0.35;
    this.maxZoom = 2.4;
    this.viewW = viewW;
    this.viewH = viewH;
  }

  resize(w, h) { this.viewW = w; this.viewH = h; }

  /** Centre the camera on a tile. */
  centerOn(tx, ty) {
    const p = tileToWorld(tx, ty, 0);
    this.x = p.x;
    this.y = p.y;
  }

  worldToScreen(wx, wy) {
    return {
      x: (wx - this.x) * this.zoom + this.viewW / 2,
      y: (wy - this.y) * this.zoom + this.viewH / 2,
    };
  }

  screenToWorld(sx, sy) {
    return {
      x: (sx - this.viewW / 2) / this.zoom + this.x,
      y: (sy - this.viewH / 2) / this.zoom + this.y,
    };
  }

  /** Zoom about a screen anchor so the point under the cursor stays put. */
  zoomAt(sx, sy, factor) {
    const before = this.screenToWorld(sx, sy);
    this.zoom = Math.min(this.maxZoom, Math.max(this.minZoom, this.zoom * factor));
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Keep the camera somewhere near the island rather than lost in the void. */
  clampTo(size) {
    const half = size * (TILE_W / 2);
    const maxY = size * TILE_H;
    this.x = Math.max(-half, Math.min(half, this.x));
    this.y = Math.max(-TILE_H * 4, Math.min(maxY, this.y));
  }
}

/**
 * The four world-space corners of a tile's drawn surface: top, right, bottom,
 * left.
 *
 * Both the renderer and cursor picking call this, which is the point: what you
 * click is exactly what was drawn, and the two cannot drift apart. They did
 * once -- picking still tested a flat rhombus at the tile's centre height after
 * the terrain had started being drawn as a sloped quad, so on any slope the
 * cursor selected a tile next to the one under the pointer.
 *
 * Water is the exception, drawn as a flat plane at sea level however the
 * corners around it average out, so it is picked that way too.
 */
export function tileQuad(world, x, y) {
  const p = tileToWorld(x, y, 0);
  const w2 = TILE_W / 2;

  if (world.terrain[world.idx(x, y)] === T.WATER) {
    const lift = SEA_LEVEL * ELEV_STEP;
    return [
      { x: p.x, y: p.y - lift },
      { x: p.x + w2, y: p.y + TILE_H / 2 - lift },
      { x: p.x, y: p.y + TILE_H - lift },
      { x: p.x - w2, y: p.y + TILE_H / 2 - lift },
    ];
  }

  const stride = world.size + 1;
  const c = world.cornerHeights();
  return [
    { x: p.x, y: p.y - c[y * stride + x] * ELEV_STEP },
    { x: p.x + w2, y: p.y + TILE_H / 2 - c[y * stride + x + 1] * ELEV_STEP },
    { x: p.x, y: p.y + TILE_H - c[(y + 1) * stride + x + 1] * ELEV_STEP },
    { x: p.x - w2, y: p.y + TILE_H / 2 - c[(y + 1) * stride + x] * ELEV_STEP },
  ];
}

/** Which side of the line a->b the point falls on. */
function side(px, py, a, b) {
  return (px - b.x) * (a.y - b.y) - (a.x - b.x) * (py - b.y);
}

function inTriangle(px, py, a, b, c) {
  const d1 = side(px, py, a, b);
  const d2 = side(px, py, b, c);
  const d3 = side(px, py, c, a);
  const neg = d1 < 0 || d2 < 0 || d3 < 0;
  const pos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(neg && pos);
}

/**
 * Is a world-space point inside a tile's surface?
 *
 * Split into two triangles rather than assuming convexity: a steep enough
 * corner difference can push the top corner below the bottom one.
 */
export function pointInQuad(q, px, py) {
  return inTriangle(px, py, q[0], q[1], q[2]) || inTriangle(px, py, q[0], q[2], q[3]);
}

/**
 * How far towards the viewer a click may have to search, in tiles per axis.
 *
 * Height lifts a tile straight up the screen, so the tile under the pointer can
 * be one that would otherwise sit further down. The tallest possible terrain
 * sets how far that reaches.
 */
const PICK_REACH = Math.ceil((MAX_ELEVATION * ELEV_STEP) / TILE_H) + 1;

/**
 * Screen pixel -> the tile the cursor is actually over.
 *
 * Tests the real drawn surface of each candidate and takes the frontmost hit --
 * greatest x + y, which the painter's-order sweep draws last and therefore on
 * top. Falling back to the flat-ground tile keeps the shorelines clickable,
 * where the bank between the land edge and the water belongs to no tile.
 */
export function pickTile(world, camera, sx, sy) {
  const p = camera.screenToWorld(sx, sy);
  const flat = worldToTile(p.x, p.y);
  const x0 = Math.floor(flat.x), y0 = Math.floor(flat.y);

  let best = null, bestDepth = -Infinity;
  for (let dy = -1; dy <= PICK_REACH; dy++) {
    for (let dx = -1; dx <= PICK_REACH; dx++) {
      const tx = x0 + dx, ty = y0 + dy;
      if (tx + ty <= bestDepth || !world.inBounds(tx, ty)) continue;
      if (!pointInQuad(tileQuad(world, tx, ty), p.x, p.y)) continue;
      best = { x: tx, y: ty };
      bestDepth = tx + ty;
    }
  }
  if (best) return best;

  return world.inBounds(x0, y0) ? { x: x0, y: y0 } : null;
}
