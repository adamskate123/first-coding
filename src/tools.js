/**
 * Build tools and pointer handling.
 *
 * Zones drag out as a rectangle, roads and power lines follow an L-shaped path
 * between the drag endpoints, and service buildings are placed with a single
 * click. Every tool previews exactly the tiles it will affect and refuses --
 * visibly, before the click lands -- if the city cannot afford them or the
 * ground will not take them.
 */

import { Z, ZONE_INFO, ROAD, ROAD_INFO, POWERLINE_COST, BULLDOZE_COST, BUILDINGS, T,
         BRIDGE_COST_MULTIPLIER, POWERLINE_CROSSING_MULTIPLIER } from './config.js';

export const TOOL = {
  SELECT: 'select',
  BULLDOZE: 'bulldoze',
  POWERLINE: 'powerline',
};

export class ToolController {
  constructor(game) {
    this.game = game;
    this.tool = TOOL.SELECT;
    this.arg = null;
    this.dragStart = null;
    this.dragEnd = null;
  }

  select(tool, arg = null) {
    this.tool = tool;
    this.arg = arg;
    this.dragStart = null;
    this.dragEnd = null;
    this.game.renderer.preview = [];
    this.game.renderer.markDirty();
  }

  get isDragTool() {
    return this.tool.startsWith('zone:') || this.tool.startsWith('road:') ||
           this.tool === TOOL.POWERLINE || this.tool === TOOL.BULLDOZE;
  }

  // ------------------------------------------------------------- pointer --

  onPointerDown(tile) {
    if (!tile || this.tool === TOOL.SELECT) return;
    if (this.isDragTool) {
      this.dragStart = tile;
      this.dragEnd = tile;
      this.refreshPreview();
    }
  }

  onPointerMove(tile) {
    const r = this.game.renderer;
    r.hover = tile;
    if (this.dragStart && tile) {
      this.dragEnd = tile;
      this.refreshPreview();
    } else if (tile && this.tool.startsWith('build:')) {
      this.refreshPreview();
    } else if (!this.dragStart) {
      r.preview = [];
      r.previewValid = true;
    }
    r.markDirty();
  }

  onPointerUp(tile) {
    if (this.tool === TOOL.SELECT) {
      if (tile) this.game.inspect(tile);
      return;
    }
    if (this.tool.startsWith('build:')) {
      if (tile) this.applyBuilding(tile);
      this.game.renderer.markDirty();
      return;
    }
    if (this.dragStart) {
      this.applyTiles(this.affectedTiles());
      this.dragStart = null;
      this.dragEnd = null;
      this.refreshPreview();
    }
  }

  cancel() {
    this.dragStart = null;
    this.dragEnd = null;
    this.game.renderer.preview = [];
    this.game.renderer.markDirty();
  }

  // ------------------------------------------------------------- preview --

  refreshPreview() {
    const r = this.game.renderer;
    const tiles = this.affectedTiles();
    r.preview = tiles;
    const cost = this.costOf(tiles);
    this.previewCost = cost;
    this.previewAnchored = this.crossingIsAnchored(tiles);
    r.previewValid = tiles.length > 0 && cost <= this.game.world.funds && this.previewAnchored;
    r.markDirty();
  }

  /**
   * A span over water has to reach both banks.
   *
   * Without this a player could drop a lone road tile in the middle of a lake.
   * Requiring both ends of the run to rest on something -- dry land, or a
   * crossing already built -- means a bridge is always laid bank to bank, and
   * an existing span can still be widened or extended from either end.
   */
  crossingIsAnchored(tiles) {
    if (!tiles.length) return true;
    const w = this.game.world;
    const isCrossingTool = this.tool.startsWith('road:') || this.tool === TOOL.POWERLINE;
    if (!isCrossingTool) return true;
    if (!tiles.some((t) => w.isWater(t.x, t.y))) return true;

    const first = tiles[0], last = tiles[tiles.length - 1];
    return w.supportsCrossing(first.x, first.y) && w.supportsCrossing(last.x, last.y);
  }

  /** Tiles the current gesture would touch. */
  affectedTiles() {
    const w = this.game.world;

    if (this.tool.startsWith('build:')) {
      const t = this.game.renderer.hover;
      if (!t) return [];
      const spec = BUILDINGS[this.arg];
      const out = [];
      for (let dy = 0; dy < spec.span; dy++) {
        for (let dx = 0; dx < spec.span; dx++) out.push({ x: t.x + dx, y: t.y + dy });
      }
      return out;
    }

    if (!this.dragStart || !this.dragEnd) {
      return this.game.renderer.hover ? [this.game.renderer.hover] : [];
    }

    const a = this.dragStart, b = this.dragEnd;

    // Roads and power lines lay an L-shaped run; zoning fills the rectangle.
    if (this.tool.startsWith('road:') || this.tool === TOOL.POWERLINE) {
      const out = [];
      const stepX = Math.sign(b.x - a.x) || 1;
      for (let x = a.x; x !== b.x + stepX; x += stepX) out.push({ x, y: a.y });
      const stepY = Math.sign(b.y - a.y) || 1;
      for (let y = a.y + stepY; y !== b.y + stepY; y += stepY) out.push({ x: b.x, y });
      return out.filter((t) => w.inBounds(t.x, t.y));
    }

    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    const out = [];
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) if (w.inBounds(x, y)) out.push({ x, y });
    }
    return out;
  }

  /** What the gesture would cost, counting only tiles that would change. */
  costOf(tiles) {
    const w = this.game.world;
    let total = 0;
    for (const t of tiles) {
      if (!w.inBounds(t.x, t.y)) continue;
      const i = w.idx(t.x, t.y);

      if (this.tool === TOOL.BULLDOZE) {
        if (w.zone[i] || w.road[i] || w.powerLine[i] || w.build[i] !== -1 || w.tree[i]) total += BULLDOZE_COST;
      } else if (this.tool.startsWith('zone:')) {
        const z = Z[this.arg];
        if (w.terrain[i] !== T.WATER && w.build[i] === -1 && w.road[i] === 0 && w.zone[i] !== z) total += ZONE_INFO[z].cost;
      } else if (this.tool.startsWith('road:')) {
        const kind = ROAD[this.arg];
        if (w.build[i] === -1 && w.road[i] !== kind) {
          const overWater = w.terrain[i] === T.WATER;
          total += ROAD_INFO[kind].cost * (overWater ? BRIDGE_COST_MULTIPLIER : 1);
        }
      } else if (this.tool === TOOL.POWERLINE) {
        if (w.build[i] === -1 && !w.powerLine[i]) {
          const overWater = w.terrain[i] === T.WATER;
          total += POWERLINE_COST * (overWater ? POWERLINE_CROSSING_MULTIPLIER : 1);
        }
      } else if (this.tool.startsWith('build:')) {
        return BUILDINGS[this.arg].cost;
      }
    }
    return total;
  }

  // --------------------------------------------------------------- apply --

  applyTiles(tiles) {
    const w = this.game.world;
    const cost = this.costOf(tiles);
    if (cost > w.funds) {
      this.game.toast('Not enough funds.');
      return;
    }
    if (!this.crossingIsAnchored(tiles)) {
      this.game.toast('A crossing must reach both banks.');
      return;
    }

    let changed = false;
    for (const t of tiles) {
      if (!w.inBounds(t.x, t.y)) continue;
      const i = w.idx(t.x, t.y);

      if (this.tool === TOOL.BULLDOZE) {
        if (w.clearTile(t.x, t.y)) changed = true;
      } else if (this.tool.startsWith('zone:')) {
        const z = Z[this.arg];
        if (w.terrain[i] === T.WATER || w.build[i] !== -1 || w.road[i]) continue;
        if (w.zone[i] !== z) {
          w.zone[i] = z;
          w.level[i] = 0; w.pop[i] = 0; w.jobs[i] = 0; w.growthTimer[i] = 0; w.tree[i] = 0;
          changed = true;
        }
      } else if (this.tool.startsWith('road:')) {
        const kind = ROAD[this.arg];
        if (w.build[i] !== -1) continue;
        if (w.road[i] !== kind) {
          w.road[i] = kind;
          w.zone[i] = Z.NONE; w.level[i] = 0; w.pop[i] = 0; w.jobs[i] = 0; w.tree[i] = 0;
          changed = true;
        }
      } else if (this.tool === TOOL.POWERLINE) {
        if (w.build[i] !== -1) continue;
        if (!w.powerLine[i]) { w.powerLine[i] = 1; w.tree[i] = 0; changed = true; }
      }
    }

    if (changed) {
      w.funds -= cost;
      this.game.sim.topologyDirty = true;
      this.game.renderer.markDirty();
      this.game.ui.refresh();
    }
  }

  applyBuilding(tile) {
    const w = this.game.world;
    const spec = BUILDINGS[this.arg];
    if (spec.cost > w.funds) { this.game.toast('Not enough funds.'); return; }
    if (!w.placeBuilding(this.arg, tile.x, tile.y)) {
      this.game.toast('That site is blocked.');
      return;
    }
    w.funds -= spec.cost;
    this.game.sim.topologyDirty = true;
    this.game.renderer.markDirty();
    this.game.ui.refresh();
  }
}
