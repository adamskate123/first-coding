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

import { TILE_W, TILE_H, ELEV_STEP, T, Z, ZONE_INFO, ROAD, ROAD_INFO, BUILDINGS, SEA_LEVEL, BRIDGE_CLEARANCE, DAY_TICKS } from '../config.js';
import { tileToWorld, tileQuad, flatQuad, quadPoint } from '../iso.js';
import { TERRAIN, ROAD_COLORS, ZONE_TINT, ZONE_EDGE, ZONE_GROUND, SKY, LOT, VEHICLE_TONES, heatColor, shade, mix } from './palette.js';
import { zoneSprite, buildingSprite, treeSprite, VARIANTS } from './sprites.js';
import { vehicleLocal, KIND_SIZE } from '../sim/vehicles.js';
import { hash2, clamp } from '../util.js';

/** Neighbour offsets, indexed the same way as frontage() and quadEdgeMid(). */
const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** Middle of a tile's surface. */
export function quadCentre(q) {
  return {
    x: (q[0].x + q[1].x + q[2].x + q[3].x) / 4,
    y: (q[0].y + q[1].y + q[2].y + q[3].y) / 4,
  };
}

/**
 * Midpoint of the edge a tile shares with neighbour direction `k`, using the
 * same indexing as DIRS: +x, +y, -x, -y.
 */
export function quadEdgeMid(q, k) {
  const pair = [[1, 2], [3, 2], [0, 3], [0, 1]][k];
  return {
    x: (q[pair[0]].x + q[pair[1]].x) / 2,
    y: (q[pair[0]].y + q[pair[1]].y) / 2,
  };
}

/** A quad shrunk towards its own centre, keeping it on the sloped surface. */
export function quadInset(q, scale) {
  const c = quadCentre(q);
  return q.map((pt) => ({
    x: c.x + (pt.x - c.x) * scale,
    y: c.y + (pt.y - c.y) * scale,
  }));
}

/** A clock that works in a browser and in a bare node test alike. */
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Whether this lot is part of a larger building, and where that building sits.
 *
 * Every zoned lot used to be its own one-tile building, so a dense district
 * came out as a grid of separate boxes on a five-tile pitch -- the single
 * biggest reason a built-up area read as tiling rather than as a city. Lots
 * that match their neighbours closely enough now share one building across
 * them.
 *
 * Merging is decided on a fixed parity grid rather than by searching for
 * groups. That matters more than it looks: a search would have to break ties,
 * and any tie broken differently from one frame to the next makes buildings
 * jump between footprints as a district grows. On a fixed grid a block either
 * qualifies or it does not, every lot belongs to exactly one, and the answer
 * never depends on the order anything was examined.
 *
 * Purely a matter of drawing: population, jobs and power are per lot as they
 * always were, so nothing here is saved or simulated.
 */
export const MERGE_SPAN = 2;

export function mergedBlock(world, x, y) {
  const ox = x - (x % MERGE_SPAN), oy = y - (y % MERGE_SPAN);
  if (!world.inBounds(ox + MERGE_SPAN - 1, oy + MERGE_SPAN - 1)) return null;

  const a = world.idx(ox, oy);
  const zone = world.zone[a];
  const level = world.level[a];
  // Below level 2 the lots are houses, and a terrace of four identical houses
  // welded into one block looks less like a city, not more.
  if (zone === Z.NONE || level < 2) return null;

  const wealth = world.wealth[a];
  const era = world.eraOf(a);
  const powered = world.powered[a];

  for (let dy = 0; dy < MERGE_SPAN; dy++) {
    for (let dx = 0; dx < MERGE_SPAN; dx++) {
      const i = world.idx(ox + dx, oy + dy);
      if (world.zone[i] !== zone || world.level[i] !== level) return null;
      if (world.wealth[i] !== wealth || world.eraOf(i) !== era) return null;
      if (world.powered[i] !== powered) return null;
      if (world.road[i] || world.build[i] !== -1) return null;
      if (world.terrain[i] === T.WATER) return null;
    }
  }
  return { ox, oy, span: MERGE_SPAN, zone, level, wealth, era, powered };
}

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
    this.showVehicles = true;
    this.showNight = true;
    this.vehicles = null;      // a VehicleField, once the game has one
    this.renderCost = 0;       // rolling cost of a full repaint, in ms
    this.layers = null;        // { ground, structures } offscreen canvases
    this.layerKey = null;      // what those layers were drawn for
    this.layerCost = 0;        // rolling cost of rebuilding them
  }

  markDirty() { this.dirty = true; }

  /**
   * How far into the dark it is: 0 in daylight, 1 at the deepest point.
   *
   * A smooth curve so dusk and dawn are gradual, but the *lit* state of the
   * windows is a step -- see `windowsLit`. Only the step goes in the cache
   * key, so the light fades continuously while the city is only redrawn twice
   * a cycle.
   */
  nightAmount() {
    if (!this.showNight) return 0;
    const t = ((this.world.tick % DAY_TICKS) + DAY_TICKS) % DAY_TICKS / DAY_TICKS;
    // Flat daylight for the first half, then down into night and back.
    const k = Math.cos(t * Math.PI * 2);
    return clamp((0.35 - k) / 1.1, 0, 1);
  }

  /** Whether the windows are on, which is what the sprite cache keys off. */
  windowsLit() { return this.nightAmount() > 0.35; }

  /**
   * What the cached layers were drawn for.
   *
   * Anything not in here can change without a rebuild -- which is the point:
   * the cursor follows the mouse and the traffic moves thirty times a second,
   * and neither is a reason to repaint a city.
   */
  currentKey() {
    const cam = this.camera;
    return `${cam.x}|${cam.y}|${cam.zoom}|${this.canvas.width}|${this.canvas.height}`
      + `|${this.overlay}|${this.showGrid ? 1 : 0}|${this.world.revision}|${this.world.size}`
      + `|${this.windowsLit() ? 1 : 0}`;
  }

  render() {
    if (!this.dirty) return;
    this.dirty = false;
    const started = now();

    const key = this.currentKey();
    if (key !== this.layerKey) {
      this.buildLayers();
      this.layerKey = key;
    }
    this.compose();

    // Eased, so one slow frame does not decide the animation's pace.
    this.renderCost = this.renderCost * 0.8 + (now() - started) * 0.2;
  }

  /**
   * An offscreen canvas the size of the view, cleared and ready.
   *
   * The transform is reset *before* the clear, and that is the whole point of
   * doing it here rather than at the call site. A context keeps its transform
   * between frames, so a layer still carrying the previous camera cleared a
   * camera-space rectangle instead of the canvas -- which, when the camera had
   * moved, left a band of the previous frame's skyline standing at the edge of
   * the view. It showed up as buildings smearing down the side of the screen
   * while scrolling, and only while scrolling: a still camera never rebuilds.
   */
  surface(existing) {
    const { width, height } = this.canvas;
    const canvas = existing && existing.width === width && existing.height === height
      ? existing
      : (typeof OffscreenCanvas !== 'undefined'
        ? new OffscreenCanvas(width, height)
        : Object.assign(document.createElement('canvas'), { width, height }));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return canvas;
  }

  /**
   * Draw the city into two cached layers: everything the traffic drives over,
   * and everything it drives behind.
   *
   * A city is static between simulation ticks, but the traffic is not, and
   * repainting several thousand tiles thirty times a second to move a few
   * hundred cars is most of the frame budget -- measured at 174ms a repaint on
   * a built-out map at wide zoom, which no amount of tuning the cars
   * themselves would have fixed.
   *
   * Splitting at the road surface is what keeps the cars sitting *in* the city
   * rather than on top of it: the ground layer goes down, the cars go on it,
   * and the structures layer covers whatever should hide them. Within each
   * layer the diagonal sweep still decides what covers what, exactly as
   * before.
   */
  buildLayers() {
    const begun = now();
    const { width, height } = this.canvas;
    const cam = this.camera;
    const w = this.world;
    const s = w.size;

    this.layers = this.layers || {};
    this.layers.ground = this.surface(this.layers.ground);
    this.layers.structures = this.surface(this.layers.structures);

    const place = (canvas) => {
      const c = canvas.getContext('2d');
      c.setTransform(cam.zoom, 0, 0, cam.zoom, width / 2 - cam.x * cam.zoom, height / 2 - cam.y * cam.zoom);
      return c;
    };
    const groundCtx = place(this.layers.ground);
    const structureCtx = place(this.layers.structures);

    // Viewport in world space, with margin for tall buildings. The margin has
    // to cover the largest building: its sprite is anchored at the footprint
    // origin but drawn when the sweep reaches the far corner.
    const tl = cam.screenToWorld(0, 0);
    const br = cam.screenToWorld(width, height);
    const reach = MAX_SPAN * TILE_W;
    this.clip = { x0: tl.x - reach, y0: tl.y - 300, x1: br.x + reach, y1: br.y + MAX_SPAN * TILE_H };

    // The draw methods all paint through this.ctx, so it is pointed at each
    // layer in turn rather than threading a context through every one of them.
    const real = this.ctx;
    const sweep = (fn) => {
      for (let d = 0; d <= 2 * (s - 1); d++) {
        const xStart = Math.max(0, d - s + 1);
        const xEnd = Math.min(s - 1, d);
        for (let x = xStart; x <= xEnd; x++) fn.call(this, x, d - x);
      }
    };

    this.ctx = groundCtx;
    groundCtx.fillStyle = SKY;
    groundCtx.save();
    groundCtx.setTransform(1, 0, 0, 1, 0, 0);
    groundCtx.fillRect(0, 0, width, height);
    groundCtx.restore();
    sweep(this.drawGroundTile);

    this.ctx = structureCtx;
    sweep(this.drawStructureTile);
    if (this.overlay !== 'none') this.drawOverlay();

    this.ctx = real;
    this.layerCost = this.layerCost * 0.7 + (now() - begun) * 0.3;
  }

  /** Ground, then the traffic on it, then everything that stands above it. */
  compose() {
    const ctx = this.ctx;
    const { width, height } = this.canvas;
    const cam = this.camera;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layers.ground, 0, 0);

    ctx.setTransform(cam.zoom, 0, 0, cam.zoom, width / 2 - cam.x * cam.zoom, height / 2 - cam.y * cam.zoom);
    this.drawTraffic();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(this.layers.structures, 0, 0);

    // Night goes over everything, at its exact strength, so the light can fade
    // continuously without the city underneath being redrawn.
    const dark = this.nightAmount();
    if (dark > 0.01) {
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgba(12, 22, 52, ${(dark * 0.52).toFixed(3)})`;
      ctx.fillRect(0, 0, width, height);
    }

    ctx.setTransform(cam.zoom, 0, 0, cam.zoom, width / 2 - cam.x * cam.zoom, height / 2 - cam.y * cam.zoom);
    this.drawCursor();
  }

  /**
   * Every car on screen, back to front.
   *
   * Sorted by depth rather than drawn tile by tile, because the tiles are no
   * longer being walked at this point -- only the cars are.
   */
  drawTraffic() {
    if (!this.vehicles || !this.showVehicles || !this.vehicles.list.length) return;
    const w = this.world;
    const order = this.vehicles.list
      .filter((v) => w.road[v.i])
      .sort((a, b) => (a.i % w.size + ((a.i / w.size) | 0)) - (b.i % w.size + ((b.i / w.size) | 0)));

    for (const v of order) {
      const x = v.i % w.size, y = (v.i / w.size) | 0;
      const p = tileToWorld(x, y, w.tileHeight(x, y));
      if (!this.visible(p.x, p.y)) continue;
      const surface = w.deckHeight[v.i] > 0
        ? flatQuad(x, y, Math.max(w.deckHeight[v.i], SEA_LEVEL + BRIDGE_CLEARANCE))
        : tileQuad(w, x, y);
      this.drawVehicle(v, surface);
    }
  }

  /** Screen-space rejection for a tile, before any drawing work. */
  visible(wx, wy) {
    return wx > this.clip.x0 && wx < this.clip.x1 && wy > this.clip.y0 && wy < this.clip.y1;
  }

  /** The ground, and everything laid flat on it: roads, lots, zoning. */
  drawGroundTile(x, y) {
    const w = this.world;
    const i = w.idx(x, y);
    // Anything standing on the tile is anchored at the middle of the surface
    // as drawn, not at the plate the raw height map describes.
    const p = tileToWorld(x, y, w.tileHeight(x, y));
    if (!this.visible(p.x, p.y)) return;

    const terrain = w.terrain[i];
    const quad = tileQuad(w, x, y);

    if (terrain === T.WATER) {
      this.drawWater(x, y);
    } else {
      this.drawGround(x, y, quad, terrain);
    }

    if (w.road[i]) {
      // A bridge lays its own carriageway on the deck.
      if (w.deckHeight[i] > 0) this.drawBridge(x, y, i, terrain);
      else this.drawRoad(x, y, i, quad);
    }

    const zone = w.zone[i];
    if (zone !== Z.NONE && w.level[i] === 0) this.drawZoneTint(x, y, quad, zone, w.roadAccess[i]);
    else if (zone !== Z.NONE && w.build[i] === -1) {
      this.drawLot(x, y, quad, ZONE_INFO[zone].cat, w.wealth[i]);
    }
  }

  /** Everything that stands up off the ground, and hides what is behind it. */
  drawStructureTile(x, y) {
    const w = this.world;
    const i = w.idx(x, y);
    const p = tileToWorld(x, y, w.tileHeight(x, y));
    if (!this.visible(p.x, p.y)) return;

    const ctx = this.ctx;
    const zone = w.zone[i];

    if (w.powerLine[i]) this.drawPowerLine(x, y, i, p);

    if (w.tree[i] && !w.road[i] && zone === Z.NONE && w.build[i] === -1) {
      const sp = treeSprite(hash2(x, y, 5) % 3);
      ctx.drawImage(sp.canvas, p.x + sp.ox, p.y + sp.oy);
    }

    const bIdx = w.build[i];
    if (bIdx !== -1) {
      const b = w.buildings[bIdx];
      // A multi-tile building must be painted only once the ground beneath its
      // whole footprint is down, so it is drawn on the footprint tile nearest
      // the viewer -- the one with the greatest x+y, which this diagonal sweep
      // reaches last. Drawing it at the origin instead lets the remaining
      // ground tiles paint over its walls, leaving a roof floating on grass.
      if (x === anchorX(b) && y === anchorY(b)) {
        const origin = tileToWorld(b.x, b.y, this.footprintHeight(b));
        const sp = buildingSprite(b.type, b.powered && this.windowsLit());
        ctx.drawImage(sp.canvas, origin.x + sp.ox, origin.y + sp.oy);
      }
    } else if (zone !== Z.NONE && w.level[i] > 0) {
      const info = ZONE_INFO[zone];
      const block = mergedBlock(w, x, y);

      if (block) {
        // Drawn once, on the corner of the block nearest the viewer, for the
        // same reason a service building is: the ground under the whole
        // footprint has to be down first.
        if (x !== block.ox + block.span - 1 || y !== block.oy + block.span - 1) return;
        const lit = block.powered === 1 && this.windowsLit();
        const variant = hash2(block.ox, block.oy, 11) % VARIANTS;
        const sp = zoneSprite(info.key, block.level, variant, block.wealth, block.era, lit, block.span);
        const origin = tileToWorld(block.ox, block.oy, this.blockHeight(block));
        ctx.drawImage(sp.canvas, origin.x + sp.ox, origin.y + sp.oy);
        if (block.powered !== 1) this.drawNoPowerMark(p);
        return;
      }

      const variant = hash2(x, y, 11) % VARIANTS;
      const lit = w.powered[i] === 1 && this.windowsLit();
      const sp = zoneSprite(info.key, w.level[i], variant, w.wealth[i], w.eraOf(i), lit);
      ctx.drawImage(sp.canvas, p.x + sp.ox, p.y + sp.oy);

      if (w.powered[i] !== 1) this.drawNoPowerMark(p);
    }
  }

  /**
   * A tile's surface: one quad spanning its four corner heights.
   *
   * Because neighbouring tiles share those corners the surface is watertight,
   * so there are no cliff faces to draw and no cracks to hide. Relief instead
   * comes from shading each quad by its own gradient.
   */
  drawGround(x, y, quad, terrain) {
    const ctx = this.ctx;
    const family = terrain === T.SAND ? TERRAIN.sand : terrain === T.ROCK ? TERRAIN.rock : TERRAIN.grass;
    const base = family[hash2(x, y, 3) % family.length];

    ctx.fillStyle = shade(base, this.slopeLight(x, y));
    this.quadPath(quad);
    ctx.fill();

    this.drawBanks(x, y, quad, base);

    if (this.showGrid) {
      ctx.strokeStyle = 'rgba(0,0,0,0.10)';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  /**
   * The bank where land meets water, or runs off the edge of the map.
   *
   * Land tiles form one watertight surface, so no faces are needed between
   * them. Water is different: it is a flat plane at sea level while the shore
   * above it is not, which leaves a vertical gap along every waterline. This
   * fills that gap by dropping a skirt from the shore edge to the water.
   *
   * Drawn as part of the land tile, which works in both directions: a water
   * neighbour behind this tile is already painted, and one in front starts at
   * sea level exactly where the skirt ends.
   */
  drawBanks(x, y, quad, base) {
    const ctx = this.ctx;
    const w = this.world;
    // Corner pairs per direction, matching DIRS and quadEdgeMid.
    const EDGES = [
      [1, 2, [x + 1, y], [x + 1, y + 1]],
      [3, 2, [x, y + 1], [x + 1, y + 1]],
      [0, 3, [x, y], [x, y + 1]],
      [0, 1, [x, y], [x + 1, y]],
    ];

    for (let k = 0; k < 4; k++) {
      const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
      const offMap = !w.inBounds(nx, ny);
      if (!offMap && w.terrain[w.idx(nx, ny)] !== T.WATER) continue;

      const [a, b, gridA, gridB] = EDGES[k];
      const seaA = tileToWorld(gridA[0], gridA[1], SEA_LEVEL);
      const seaB = tileToWorld(gridB[0], gridB[1], SEA_LEVEL);
      if (quad[a].y >= seaA.y && quad[b].y >= seaB.y) continue;   // nothing to fill

      // Banks facing the viewer catch less light than the ground above them.
      ctx.fillStyle = shade(base, k === 0 ? 0.54 : k === 1 ? 0.66 : 0.78);
      ctx.beginPath();
      ctx.moveTo(quad[a].x, quad[a].y);
      ctx.lineTo(quad[b].x, quad[b].y);
      ctx.lineTo(seaB.x, seaB.y);
      ctx.lineTo(seaA.x, seaA.y);
      ctx.closePath();
      ctx.fill();
    }
  }

  /** Water is a flat plane at sea level, whatever the land around it does. */
  drawWater(x, y) {
    const ctx = this.ctx;
    const surface = tileToWorld(x, y, SEA_LEVEL);
    const family = TERRAIN.water;
    ctx.fillStyle = family[hash2(x, y, 9) % family.length];
    this.rhombusPath(surface.x, surface.y);
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

  drawRoad(x, y, i, quad) {
    const ctx = this.ctx;
    const w = this.world;
    const isAvenue = w.road[i] === ROAD.AVENUE;

    // The carriageway is the tile's own surface, so a road rides the slope
    // rather than sitting on a plate above or below it.
    //
    // Busy roads darken towards red. Free-running ones keep their ordinary
    // tarmac, so congestion reads as something gone wrong rather than as a
    // permanent colour scheme -- you can see where the city is choking without
    // opening the traffic view.
    let surface = isAvenue ? ROAD_COLORS.avenue : ROAD_COLORS.street;
    const load = w.traffic[i] / ROAD_INFO[w.road[i]].capacity;
    const strain = clamp((load - 0.35) / 0.75, 0, 1);
    if (strain > 0) surface = mix(surface, ROAD_COLORS.congested, strain * 0.72);
    ctx.fillStyle = surface;
    this.quadPath(quad);
    ctx.fill();

    // Centre markings run towards each connected neighbour, so junctions and
    // dead ends read correctly without a tileset.
    const centre = quadCentre(quad);
    ctx.strokeStyle = ROAD_COLORS.markings;
    ctx.lineWidth = isAvenue ? 1.6 : 1;
    ctx.setLineDash(isAvenue ? [4, 3] : [3, 4]);
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
      if (!w.inBounds(nx, ny) || !w.road[w.idx(nx, ny)]) continue;
      const edge = quadEdgeMid(quad, k);
      ctx.moveTo(centre.x, centre.y);
      ctx.lineTo(edge.x, edge.y);
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
  drawBridge(x, y, i, terrain) {
    const ctx = this.ctx;
    const w = this.world;
    // The span sits at the level of the banks it joins, worked out per span in
    // the simulation. The fallback covers the first frame, before the topology
    // pass has run.
    const height = Math.max(w.deckHeight[i], SEA_LEVEL + BRIDGE_CLEARANCE);
    const deck = tileToWorld(x, y, height);
    // The carriageway needs the deck as a four-corner surface, the same form
    // every other road is drawn on. Handing drawRoad a bare point instead threw
    // on every frame a bridge was visible, which killed the animation loop and
    // froze the game outright.
    const deckQuad = flatQuad(x, y, height);
    // Piers reach from the deck down to whatever is beneath: the waterline out
    // over the channel, the ground itself where the deck lands on a bank.
    const base = terrain === T.WATER ? SEA_LEVEL : w.tileHeight(x, y);
    const lift = Math.max(0, (height - base) * ELEV_STEP);

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

    this.drawRoad(x, y, i, deckQuad);

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

    return deckQuad;
  }

  // ------------------------------------------------------------- traffic --

  /**
   * One car: a small box on the carriageway, oriented along its path.
   *
   * Body and width axes are unit vectors in *tile* space before they are
   * projected, so a car heading down-right is foreshortened exactly as the tile
   * beneath it is -- take the projection first and normalise after, and every
   * car comes out the same length on screen whichever way it faces, which reads
   * as wrong immediately even though it is hard to name.
   */
  drawVehicle(v, quad) {
    const ctx = this.ctx;
    const loc = vehicleLocal(v);
    const p = quadPoint(quad, loc.x, loc.y);
    if (!this.visible(p.x, p.y)) return;

    const size = KIND_SIZE[v.kind] || KIND_SIZE[0];
    const tone = VEHICLE_TONES[v.kind][v.tone % VEHICLE_TONES[v.kind].length];

    const mag = Math.hypot(loc.dx, loc.dy) || 1;
    const tx = loc.dx / mag, ty = loc.dy / mag;      // heading, in tile space
    const rx = -ty, ry = tx;                         // its right-hand side

    const ax = (tx - ty) * (TILE_W / 2) * size.length / 2;
    const ay = (tx + ty) * (TILE_H / 2) * size.length / 2;
    const bx = (rx - ry) * (TILE_W / 2) * size.width / 2;
    const by = (rx + ry) * (TILE_H / 2) * size.width / 2;

    const g = [
      { x: p.x + ax + bx, y: p.y + ay + by },
      { x: p.x + ax - bx, y: p.y + ay - by },
      { x: p.x - ax - bx, y: p.y - ay - by },
      { x: p.x - ax + bx, y: p.y - ay + by },
    ];

    // Zoomed out a car is a couple of pixels across, and the box, its shadow
    // and its sides would all land on the same ones. Draw the roof alone.
    if (this.camera.zoom < 0.6) {
      ctx.fillStyle = tone.roof;
      this.quadPath(g);
      ctx.fill();
      return;
    }

    // A shadow under the body stops it floating off the tarmac.
    ctx.fillStyle = 'rgba(20, 18, 14, 0.30)';
    this.quadPath(g.map((c) => ({ x: c.x + 1.5, y: c.y + 1 })));
    ctx.fill();

    const h = size.height;
    const roof = g.map((c) => ({ x: c.x, y: c.y - h }));

    // Only the flanks facing the viewer are drawn: the far ones are inside the
    // silhouette, so painting them would only cost time.
    ctx.fillStyle = tone.side;
    for (let k = 0; k < 4; k++) {
      const a = g[k], b = g[(k + 1) % 4];
      if ((a.y + b.y) / 2 <= p.y) continue;
      this.quadPath([a, b, roof[(k + 1) % 4], roof[k]]);
      ctx.fill();
    }

    ctx.fillStyle = tone.roof;
    this.quadPath(roof);
    ctx.fill();

    // A darker band across the middle reads as glazing at this size, and gives
    // the eye something to track as the car moves.
    if (this.camera.zoom >= 1.1) {
      const inset = 0.34;
      ctx.fillStyle = tone.glass;
      this.quadPath([
        { x: p.x + ax * inset + bx, y: p.y + ay * inset + by - h },
        { x: p.x + ax * inset - bx, y: p.y + ay * inset - by - h },
        { x: p.x - ax * inset - bx, y: p.y - ay * inset - by - h },
        { x: p.x - ax * inset + bx, y: p.y - ay * inset + by - h },
      ]);
      ctx.fill();
    }
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
      const rise = w.tileHeight(nx, ny) - w.tileHeight(x, y);
      ctx.moveTo(cx, cy - 15);
      ctx.lineTo(cx + dx, cy + dy - 15 - rise * ELEV_STEP);
    }
    ctx.stroke();
  }

  /**
   * Mean surface height under a building's whole footprint.
   *
   * A multi-tile building is anchored at one corner of its plot, so on sloping
   * ground the far corner would otherwise float or sink. Averaging across the
   * footprint splits the difference.
   */
  /** The ground a merged block stands on: the mean of the lots under it. */
  blockHeight(block) {
    const w = this.world;
    let sum = 0;
    for (let dy = 0; dy < block.span; dy++) {
      for (let dx = 0; dx < block.span; dx++) sum += w.tileHeight(block.ox + dx, block.oy + dy);
    }
    return sum / (block.span * block.span);
  }

  footprintHeight(b) {
    const w = this.world;
    let sum = 0, count = 0;
    for (let dy = 0; dy < b.span; dy++) {
      for (let dx = 0; dx < b.span; dx++) {
        sum += w.tileHeight(b.x + dx, b.y + dy);
        count++;
      }
    }
    return count ? sum / count : 0;
  }

  /**
   * Which orthogonal neighbour carries the road a lot fronts onto, as an index
   * into the direction table, or -1 if the lot has no street frontage.
   */
  frontage(x, y) {
    const w = this.world;
    for (let k = 0; k < 4; k++) {
      const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
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
  drawLot(x, y, quad, category, wealth) {
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
    const pad = quadInset(quad, inset);
    ctx.fillStyle = surface;
    this.quadPath(pad);
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
    const edge = quadEdgeMid(quad, k);
    const centre = quadCentre(quad);
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

  /**
   * A plot that has been zoned but not yet built on.
   *
   * Drawn as cleared ground with the zoning marked at its boundary, rather
   * than as a coloured wash over every tile. Most of a growing city is zoned
   * and empty, so the old flat tint was the largest single element in the
   * frame -- a dashed quilt of green, blue and yellow diamonds laid over the
   * landscape, which told you the same thing four thousand times over. The
   * edge of a district carries all the information the fill was carrying.
   */
  drawZoneTint(x, y, quad, zone, hasRoad) {
    const ctx = this.ctx;
    const w = this.world;

    ctx.fillStyle = ZONE_GROUND[hash2(x, y, 19) % ZONE_GROUND.length];
    this.quadPath(quad);
    ctx.fill();
    ctx.fillStyle = ZONE_TINT[zone];
    ctx.fill();

    // Only the sides where this zoning stops. Inside a district there is
    // nothing to draw, which is most of the saving as well as most of the
    // visual quiet.
    const edges = [];
    for (let k = 0; k < 4; k++) {
      const nx = x + DIRS[k][0], ny = y + DIRS[k][1];
      if (w.inBounds(nx, ny) && w.zone[w.idx(nx, ny)] === zone && w.level[w.idx(nx, ny)] === 0) continue;
      edges.push(k);
    }
    if (!edges.length && hasRoad) return;

    // Zoned land with no road access is marked all round, so the mistake is
    // visible rather than implied by a missing edge.
    ctx.strokeStyle = hasRoad ? ZONE_EDGE[zone] : 'rgba(220,90,70,0.85)';
    ctx.lineWidth = 1.2;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    const pairs = [[1, 2], [3, 2], [0, 3], [0, 1]];
    for (const k of (hasRoad ? edges : [0, 1, 2, 3])) {
      const [a, b] = pairs[k];
      ctx.moveTo(quad[a].x, quad[a].y);
      ctx.lineTo(quad[b].x, quad[b].y);
    }
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
        const p = tileToWorld(x, y, w.tileHeight(x, y));
        if (!this.visible(p.x, p.y)) continue;
        ctx.fillStyle = heatColor(v);
        this.quadPath(tileQuad(w, x, y));
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
      this.quadPath(tileQuad(w, t.x, t.y));
      ctx.fill();
      ctx.stroke();
    }
  }

  /**
   * How brightly a tile's surface catches the light, from its own gradient.
   *
   * With no cliff faces left to read, this is what carries relief: a slope
   * facing up-left towards the light is lifted, one facing away is dropped.
   */
  slopeLight(x, y) {
    const w = this.world;
    const stride = w.size + 1;
    const c = w.cornerHeights();
    const h00 = c[y * stride + x], h10 = c[y * stride + x + 1];
    const h01 = c[(y + 1) * stride + x], h11 = c[(y + 1) * stride + x + 1];
    const dx = ((h10 + h11) - (h00 + h01)) / 2;
    const dy = ((h01 + h11) - (h00 + h10)) / 2;
    return clamp(1 - dx * 0.16 - dy * 0.06, 0.68, 1.32);
  }

  quadPath(q) {
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(q[0].x, q[0].y);
    ctx.lineTo(q[1].x, q[1].y);
    ctx.lineTo(q[2].x, q[2].y);
    ctx.lineTo(q[3].x, q[3].y);
    ctx.closePath();
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
