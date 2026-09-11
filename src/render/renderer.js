/**
 * The isometric renderer.
 *
 * Tiles are painted back to front along screen diagonals (constant x+y), which
 * is the correct painter's order for this projection -- anything nearer the
 * viewer is drawn later and simply covers what is behind it, so no depth buffer
 * is needed even with tall towers on uneven ground.
 *
 * Redraws are dirty-flagged. A city is static between simulation ticks, so
 * there is no reason to burn a frame re-painting an unchanged skyline.
 */

import { TILE_W, TILE_H, ELEV_STEP, T, Z, ZONE_INFO, ROAD, BUILDINGS, SEA_LEVEL, BRIDGE_LIFT } from '../config.js';
import { tileToWorld } from '../iso.js';
import { TERRAIN, ROAD_COLORS, ZONE_TINT, SKY, LOT, heatColor, shade } from './palette.js';
import { zoneSprite, buildingSprite, treeSprite, VARIANTS } from './sprites.js';
import { hash2, clamp } from '../util.js';

/** Largest building footprint in the catalogue, used to size the draw margin. */
const MAX_SPAN = Math.max(...Object.values(BUILDINGS).map((b) => b.span));

/**
 * The footprint tile a building's sprite is drawn on: the corner nearest the
 * viewer. Exported so the draw-order rule can be tested without a canvas.
 */
export const anchorX = (b) => b.x + b.span - 1;
export const anchorY = (b) => b.y + b.span - 1;

export class Renderer {
  constructor(canvas, world, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false });
    this.world = world;
    this.camera = camera;
    this.overlay = 'none';
    this.hover = null;       // { x, y }
    this.preview = [];       // tiles the pending drag would affect
    this.previewValid = true;
    this.dirty = true;
    this.showGrid = false;
  }

  markDirty() { this.dirty = true; }

  render() {
    if (!this.dirty) return;
    this.dirty = false;

    const ctx = this.ctx;
    const { width, height } = this.canvas;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = SKY;
    ctx.fillRect(0, 0, width, height);

    const cam = this.camera;
    ctx.setTransform(cam.zoom, 0, 0, cam.zoom, width / 2 - cam.x * cam.zoom, height / 2 - cam.y * cam.zoom);

    // Viewport in world space, with margin for tall buildings.
    const tl = cam.screenToWorld(0, 0);
    const br = cam.screenToWorld(width, height);
    // The margin has to cover the largest building: its sprite is anchored at
    // the footprint origin but drawn when the sweep reaches the far corner.
    const reach = MAX_SPAN * TILE_W;
    this.clip = { x0: tl.x - reach, y0: tl.y - 300, x1: br.x + reach, y1: br.y + MAX_SPAN * TILE_H };

    const w = this.world;
    const s = w.size;

    // Diagonal sweep: every tile on diagonal d satisfies x + y === d.
    for (let d = 0; d <= 2 * (s - 1); d++) {
      const xStart = Math.max(0, d - s + 1);
      const xEnd = Math.min(s - 1, d);
      for (let x = xStart; x <= xEnd; x++) {
        const y = d - x;
        this.drawTile(x, y);
      }
    }

    if (this.overlay !== 'none') this.drawOverlay();
    this.drawCursor();
  }

  /** Screen-space rejection for a tile, before any drawing work. */
  visible(wx, wy) {
    return wx > this.clip.x0 && wx < this.clip.x1 && wy > this.clip.y0 && wy < this.clip.y1;
  }

  drawTile(x, y) {
    const w = this.world;
    const i = w.idx(x, y);
    const elev = w.elevation[i];
    const p = tileToWorld(x, y, elev);
    if (!this.visible(p.x, p.y)) return;

    const ctx = this.ctx;
    const terrain = w.terrain[i];

    // --- the ground itself -------------------------------------------------
    if (terrain === T.WATER) {
      this.drawWater(x, y, p);
    } else {
      this.drawGround(x, y, i, p, terrain, elev);
    }

    // --- what the player put there ----------------------------------------
    if (w.road[i]) {
      if (terrain === T.WATER) this.drawBridge(x, y, i);
      else this.drawRoad(x, y, i, p);
    }

    const zone = w.zone[i];
    if (zone !== Z.NONE && w.level[i] === 0) this.drawZoneTint(p, zone, w.roadAccess[i]);
    else if (zone !== Z.NONE && w.build[i] === -1) {
      this.drawLot(x, y, p, ZONE_INFO[zone].cat, w.wealth[i]);
    }

    if (w.powerLine[i]) this.drawPowerLine(x, y, i, p);

    if (w.tree[i] && !w.road[i] && zone === Z.NONE && w.build[i] === -1) {
      const sp = treeSprite(hash2(x, y, 5) % 3);
      ctx.drawImage(sp.canvas, p.x + sp.ox, p.y + sp.oy);
    }

    // --- structures --------------------------------------------------------
    const bIdx = w.build[i];
    if (bIdx !== -1) {
      const b = w.buildings[bIdx];
      // A multi-tile building must be painted only once the ground beneath its
      // whole footprint is down, so it is drawn on the footprint tile nearest
      // the viewer -- the one with the greatest x+y, which this diagonal sweep
      // reaches last. Drawing it at the origin instead lets the remaining
      // ground tiles paint over its walls, leaving a roof floating on grass.
      if (x === anchorX(b) && y === anchorY(b)) {
        const origin = tileToWorld(b.x, b.y, w.elevation[w.idx(b.x, b.y)]);
        const sp = buildingSprite(b.type, b.powered);
        ctx.drawImage(sp.canvas, origin.x + sp.ox, origin.y + sp.oy);
      }
    } else if (zone !== Z.NONE && w.level[i] > 0) {
      const info = ZONE_INFO[zone];
      const variant = hash2(x, y, 11) % VARIANTS;
      const sp = zoneSprite(info.key, w.level[i], variant, w.wealth[i], w.eraOf(i), w.powered[i] === 1);
      ctx.drawImage(sp.canvas, p.x + sp.ox, p.y + sp.oy);

      if (w.powered[i] !== 1) this.drawNoPowerMark(p);
    }
  }

  drawGround(x, y, i, p, terrain, elev) {
    const ctx = this.ctx;
    const w = this.world;
    const family = terrain === T.SAND ? TERRAIN.sand : terrain === T.ROCK ? TERRAIN.rock : TERRAIN.grass;
    const base = family[hash2(x, y, 3) % family.length];

    // Cliff faces where this tile stands above its two front neighbours.
    const southElev = y + 1 < w.size ? w.elevation[i + w.size] : elev;
    const eastElev = x + 1 < w.size ? w.elevation[i + 1] : elev;
    const dropL = Math.max(0, elev - southElev) * ELEV_STEP;
    const dropR = Math.max(0, elev - eastElev) * ELEV_STEP;

    if (dropL > 0) {
      ctx.fillStyle = shade(base, 0.68);
      ctx.beginPath();
      ctx.moveTo(p.x - TILE_W / 2, p.y + TILE_H / 2);
      ctx.lineTo(p.x, p.y + TILE_H);
      ctx.lineTo(p.x, p.y + TILE_H + dropL);
      ctx.lineTo(p.x - TILE_W / 2, p.y + TILE_H / 2 + dropL);
      ctx.closePath();
      ctx.fill();
    }
    if (dropR > 0) {
      ctx.fillStyle = shade(base, 0.52);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y + TILE_H);
      ctx.lineTo(p.x + TILE_W / 2, p.y + TILE_H / 2);
      ctx.lineTo(p.x + TILE_W / 2, p.y + TILE_H / 2 + dropR);
      ctx.lineTo(p.x, p.y + TILE_H + dropR);
      ctx.closePath();
      ctx.fill();
    }

    ctx.fillStyle = base;
    this.rhombusPath(p.x, p.y);
    ctx.fill();

    if (this.showGrid) {
      ctx.strokeStyle = 'rgba(0,0,0,0.10)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  drawWater(x, y, p) {
    const ctx = this.ctx;
    const family = TERRAIN.water;
    ctx.fillStyle = family[hash2(x, y, 9) % family.length];
    this.rhombusPath(p.x, p.y);
    ctx.fill();

    // A brighter band where water meets land reads as a shoreline.
    const w = this.world;
    const touchesLand =
      (x > 0 && !w.isWater(x - 1, y)) || (y > 0 && !w.isWater(x, y - 1)) ||
      (x < w.size - 1 && !w.isWater(x + 1, y)) || (y < w.size - 1 && !w.isWater(x, y + 1));
    if (touchesLand) {
      ctx.strokeStyle = 'rgba(190, 215, 225, 0.30)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
  }

  drawRoad(x, y, i, p) {
    const ctx = this.ctx;
    const w = this.world;
    const isAvenue = w.road[i] === ROAD.AVENUE;

    ctx.fillStyle = isAvenue ? ROAD_COLORS.avenue : ROAD_COLORS.street;
    this.rhombusPath(p.x, p.y);
    ctx.fill();

    // Centre markings run towards each connected neighbour, so junctions and
    // dead ends read correctly without a tileset.
    const cx = p.x, cy = p.y + TILE_H / 2;
    ctx.strokeStyle = ROAD_COLORS.markings;
    ctx.lineWidth = isAvenue ? 1.6 : 1;
    ctx.setLineDash(isAvenue ? [4, 3] : [3, 4]);

    const links = [
      [x + 1, y, TILE_W / 2, TILE_H / 2],
      [x - 1, y, -TILE_W / 2, -TILE_H / 2],
      [x, y + 1, -TILE_W / 2, TILE_H / 2],
      [x, y - 1, TILE_W / 2, -TILE_H / 2],
    ];
    ctx.beginPath();
    for (const [nx, ny, dx, dy] of links) {
      if (!w.inBounds(nx, ny) || !w.road[w.idx(nx, ny)]) continue;
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + dx, cy + dy);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * A bridge: the same road surface, lifted clear of the water and stood on
   * piers, with railings along any edge that does not meet another road.
   *
   * Everything is drawn inside the tile's own footprint, so the diagonal sweep
   * still paints it in the right order -- the piers stop at the waterline
   * rather than hanging down into the tile in front.
   */
  drawBridge(x, y, i) {
    const ctx = this.ctx;
    const w = this.world;
    const deck = tileToWorld(x, y, SEA_LEVEL + BRIDGE_LIFT);
    const lift = BRIDGE_LIFT * ELEV_STEP;

    // piers dropping to the waterline
    ctx.fillStyle = '#544f46';
    const cx = deck.x, cy = deck.y + TILE_H / 2;
    ctx.fillRect(cx - 9, cy, 4, lift + 3);
    ctx.fillRect(cx + 5, cy, 4, lift + 3);

    // the deck's own thickness, along the two edges facing the viewer
    const THICK = 4;
    ctx.fillStyle = '#443f39';
    ctx.beginPath();
    ctx.moveTo(deck.x - TILE_W / 2, deck.y + TILE_H / 2);
    ctx.lineTo(deck.x, deck.y + TILE_H);
    ctx.lineTo(deck.x + TILE_W / 2, deck.y + TILE_H / 2);
    ctx.lineTo(deck.x + TILE_W / 2, deck.y + TILE_H / 2 + THICK);
    ctx.lineTo(deck.x, deck.y + TILE_H + THICK);
    ctx.lineTo(deck.x - TILE_W / 2, deck.y + TILE_H / 2 + THICK);
    ctx.closePath();
    ctx.fill();

    this.drawRoad(x, y, i, deck);

    // Railings close off the open sides, so a span reads as a bridge rather
    // than as road that happens to be floating.
    const T_ = { x: deck.x, y: deck.y };
    const R_ = { x: deck.x + TILE_W / 2, y: deck.y + TILE_H / 2 };
    const B_ = { x: deck.x, y: deck.y + TILE_H };
    const L_ = { x: deck.x - TILE_W / 2, y: deck.y + TILE_H / 2 };
    const edges = [
      [x + 1, y, R_, B_], [x - 1, y, T_, L_],
      [x, y + 1, L_, B_], [x, y - 1, T_, R_],
    ];
    const RAIL_H = 6;
    ctx.strokeStyle = '#a49d8e';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [nx, ny, a, b] of edges) {
      if (w.inBounds(nx, ny) && w.road[w.idx(nx, ny)]) continue;
      ctx.moveTo(a.x, a.y - RAIL_H);
      ctx.lineTo(b.x, b.y - RAIL_H);
      // posts at the ends, so a long run reads as railing rather than a stripe
      ctx.moveTo(a.x, a.y - RAIL_H); ctx.lineTo(a.x, a.y);
      ctx.moveTo(b.x, b.y - RAIL_H); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  drawPowerLine(x, y, i, p) {
    const ctx = this.ctx;
    const w = this.world;
    const cx = p.x, cy = p.y + TILE_H / 2;

    // pylon
    ctx.fillStyle = '#5a5348';
    ctx.fillRect(cx - 1.5, cy - 16, 3, 16);
    ctx.fillStyle = '#6b6355';
    ctx.fillRect(cx - 5, cy - 16, 10, 2);

    // catenary to connected neighbours
    ctx.strokeStyle = 'rgba(30,30,30,0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    const links = [[x + 1, y, TILE_W / 2, TILE_H / 2], [x, y + 1, -TILE_W / 2, TILE_H / 2]];
    for (const [nx, ny, dx, dy] of links) {
      if (!w.inBounds(nx, ny)) continue;
      const j = w.idx(nx, ny);
      if (!w.powerLine[j]) continue;
      const nElev = w.elevation[j] - w.elevation[i];
      ctx.moveTo(cx, cy - 15);
      ctx.lineTo(cx + dx, cy + dy - 15 - nElev * ELEV_STEP);
    }
    ctx.stroke();
  }

  /**
   * Which orthogonal neighbour carries the road a lot fronts onto, as an index
   * into the direction table, or -1 if the lot has no street frontage.
   */
  frontage(x, y) {
    const w = this.world;
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    for (let k = 0; k < 4; k++) {
      const nx = x + dirs[k][0], ny = y + dirs[k][1];
      if (w.inBounds(nx, ny) && w.road[w.idx(nx, ny)]) return k;
    }
    return -1;
  }

  /**
   * Furnish a developed lot: mown lawn and a drive for a house, asphalt and
   * bay markings for a shop, a concrete apron for a works.
   *
   * Bare grass running right up to every wall is most of why a city reads as
   * sparse, and the drive running out to the street is what ties a building to
   * the road it was built for.
   */
  drawLot(x, y, p, category, wealth) {
    const ctx = this.ctx;
    const rich = wealth >= 2;

    let surface;
    if (category === 'R') {
      const family = rich ? LOT.lawnRich : LOT.lawn;
      surface = family[hash2(x, y, 23) % family.length];
    } else if (category === 'C') {
      surface = LOT.asphalt;
    } else {
      surface = LOT.concrete;
    }

    // A garden stops short of the road; a yard or forecourt is paved to the
    // lot line, so neighbouring commercial and industrial lots run together
    // into one continuous surface the way a trading estate does.
    const inset = category === 'R' ? 0.92 : 1;
    ctx.fillStyle = surface;
    this.lotPath(p, inset);
    ctx.fill();

    // A hedge marks out a well-to-do garden.
    if (category === 'R' && rich) {
      ctx.strokeStyle = LOT.hedge;
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    const k = this.frontage(x, y);
    if (k === -1) return;

    // The drive is drawn as a wedge widest at the street, because the building
    // sits over the middle of the lot and would hide an even-width strip.
    const edge = this.edgeMidpoint(p, k);
    const centre = { x: p.x, y: p.y + TILE_H / 2 };
    const along = { x: centre.x - edge.x, y: centre.y - edge.y };
    const across = { x: -along.y, y: along.x };   // perpendicular, in screen space
    const wide = category === 'R' ? 0.30 : 0.62;
    const narrow = wide * 0.45;

    ctx.fillStyle = category === 'R' ? LOT.drive : shade(surface, 1.16);
    ctx.beginPath();
    ctx.moveTo(edge.x + across.x * wide, edge.y + across.y * wide);
    ctx.lineTo(edge.x - across.x * wide, edge.y - across.y * wide);
    ctx.lineTo(centre.x - across.x * narrow, centre.y - across.y * narrow);
    ctx.lineTo(centre.x + across.x * narrow, centre.y + across.y * narrow);
    ctx.closePath();
    ctx.fill();

    // Parking bays on commercial frontage.
    if (category === 'C') {
      ctx.strokeStyle = LOT.stripe;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let b = -1; b <= 1; b++) {
        const t = 0.35 + b * 0.22;
        const bx = edge.x + (centre.x - edge.x) * t;
        const by = edge.y + (centre.y - edge.y) * t;
        ctx.moveTo(bx - 5, by - 2.5);
        ctx.lineTo(bx + 5, by + 2.5);
      }
      ctx.stroke();
    }
  }

  /** Midpoint of the tile edge shared with neighbour direction `k`. */
  edgeMidpoint(p, k) {
    switch (k) {
      case 0: return { x: p.x + TILE_W / 4, y: p.y + TILE_H * 0.75 };   // +x
      case 1: return { x: p.x - TILE_W / 4, y: p.y + TILE_H * 0.75 };   // +y
      case 2: return { x: p.x - TILE_W / 4, y: p.y + TILE_H * 0.25 };   // -x
      default: return { x: p.x + TILE_W / 4, y: p.y + TILE_H * 0.25 };  // -y
    }
  }

  /** A rhombus inset from the tile edge, concentric with the tile. */
  lotPath(p, scale) {
    const ctx = this.ctx;
    const cx = p.x, cy = p.y + TILE_H / 2;
    const hw = (scale * TILE_W) / 2, hh = (scale * TILE_H) / 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy - hh);
    ctx.lineTo(cx + hw, cy);
    ctx.lineTo(cx, cy + hh);
    ctx.lineTo(cx - hw, cy);
    ctx.closePath();
  }

  drawZoneTint(p, zone, hasRoad) {
    const ctx = this.ctx;
    ctx.fillStyle = ZONE_TINT[zone];
    this.rhombusPath(p.x, p.y);
    ctx.fill();
    // Zoned land with no road access is marked so the mistake is visible.
    ctx.strokeStyle = hasRoad ? 'rgba(255,255,255,0.28)' : 'rgba(220,90,70,0.8)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  drawNoPowerMark(p) {
    const ctx = this.ctx;
    ctx.fillStyle = 'rgba(240, 200, 60, 0.95)';
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('⚡', p.x, p.y - 4);
    ctx.textAlign = 'left';
  }

  /** Flood the map with a data field: land value, pollution, traffic, coverage. */
  drawOverlay() {
    const w = this.world;
    const ctx = this.ctx;
    const s = w.size;
    const field = this.overlayField();
    if (!field) return;

    ctx.globalAlpha = 0.72;
    for (let d = 0; d <= 2 * (s - 1); d++) {
      const xStart = Math.max(0, d - s + 1);
      const xEnd = Math.min(s - 1, d);
      for (let x = xStart; x <= xEnd; x++) {
        const y = d - x;
        const i = w.idx(x, y);
        if (w.terrain[i] === T.WATER) continue;
        const v = field(i);
        if (v <= 0.001) continue;
        const p = tileToWorld(x, y, w.elevation[i]);
        if (!this.visible(p.x, p.y)) continue;
        ctx.fillStyle = heatColor(v);
        this.rhombusPath(p.x, p.y);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  overlayField() {
    const w = this.world;
    switch (this.overlay) {
      case 'landvalue': return (i) => w.landValue[i] / 255;
      case 'pollution': return (i) => w.pollution[i] / 255;
      case 'crime': return (i) => w.crime[i] / 255;
      case 'traffic': return (i) => (w.road[i] ? clamp(w.traffic[i] / 400, 0, 1) : 0);
      case 'power': return (i) => (w.netId[i] === -1 ? 0 : w.powered[i] ? 0.28 : 0.95);
      case 'police': case 'fire': case 'health': case 'education': case 'park':
        return (i) => w.coverage[this.overlay][i] / 255;
      default: return null;
    }
  }

  /** Hover highlight and drag preview. */
  drawCursor() {
    const ctx = this.ctx;
    const w = this.world;
    const tiles = this.preview.length ? this.preview : (this.hover ? [this.hover] : []);
    if (!tiles.length) return;

    ctx.lineWidth = 1.6;
    ctx.strokeStyle = this.previewValid ? 'rgba(250, 250, 210, 0.95)' : 'rgba(235, 90, 70, 0.95)';
    ctx.fillStyle = this.previewValid ? 'rgba(250, 250, 210, 0.16)' : 'rgba(235, 90, 70, 0.20)';

    for (const t of tiles) {
      if (!w.inBounds(t.x, t.y)) continue;
      const p = tileToWorld(t.x, t.y, w.elevation[w.idx(t.x, t.y)]);
      this.rhombusPath(p.x, p.y);
      ctx.fill();
      ctx.stroke();
    }
  }

  rhombusPath(ox, oy) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + TILE_W / 2, oy + TILE_H / 2);
    ctx.lineTo(ox, oy + TILE_H);
    ctx.lineTo(ox - TILE_W / 2, oy + TILE_H / 2);
    ctx.closePath();
  }
}
