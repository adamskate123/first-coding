/**
 * Isometric projection and camera.
 *
 * The projection is 2:1 dimetric -- one tile is TILE_W wide and TILE_H tall on
 * screen, the same ratio SimCity 3000 used. Elevation lifts a tile straight up
 * the screen, so height reads as height rather than as depth.
 */

import { TILE_W, TILE_H, ELEV_STEP } from './config.js';

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
 * Screen pixel -> the tile the cursor is actually over.
 *
 * Because raised tiles cover ground behind them, we start from the flat-ground
 * guess and walk *towards the viewer* (decreasing x+y), accepting the first
 * tile whose elevated rhombus contains the point. That resolves the ambiguity
 * correctly for hills without a depth buffer.
 */
export function pickTile(world, camera, sx, sy) {
  const w = camera.screenToWorld(sx, sy);
  const flat = worldToTile(w.x, w.y);

  const PROBE = 14;  // tiles of lookahead; covers the tallest terrain we make
  for (let step = PROBE; step >= -2; step--) {
    const tx = Math.floor(flat.x + step / 2);
    const ty = Math.floor(flat.y + step / 2);
    if (!world.inBounds(tx, ty)) continue;
    const origin = tileToWorld(tx, ty, world.tileHeight(tx, ty));
    if (pointInRhombus(w.x - origin.x, w.y - origin.y)) return { x: tx, y: ty };
  }

  const fx = Math.floor(flat.x), fy = Math.floor(flat.y);
  return world.inBounds(fx, fy) ? { x: fx, y: fy } : null;
}

/** Is (px, py) inside a TILE_W x TILE_H rhombus whose top corner is the origin? */
function pointInRhombus(px, py) {
  const hx = TILE_W / 2, hy = TILE_H / 2;
  const dx = Math.abs(px - hx) / hx;
  const dy = Math.abs(py - hy) / hy;
  return dx + dy <= 1;
}
