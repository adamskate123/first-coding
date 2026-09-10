/**
 * Entry point: wiring, input, and the frame loop.
 *
 * Rendering and simulation are decoupled. The simulation advances on a fixed
 * wall-clock interval set by the speed control, while the renderer only repaints
 * when something has actually changed -- so a paused city costs nothing, and a
 * fast-forwarded one never renders more often than it simulates.
 */

import { MAP_SIZE, SPEED_TICK_MS } from './config.js';
import { World } from './world.js';
import { Camera, pickTile } from './iso.js';
import { Simulation } from './sim/index.js';
import { Renderer } from './render/renderer.js';
import { ToolController, TOOL } from './tools.js';
import { UI } from './ui/index.js';
import { saveToStorage, loadFromStorage, hasSave } from './save.js';

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.speed = 2;
    this.lastTick = 0;
    this.pointerDown = false;
    this.panning = false;

    this.world = new World(MAP_SIZE, (Math.random() * 0xffffffff) >>> 0);
    this.sim = new Simulation(this.world);
    this.camera = new Camera(canvas.width, canvas.height);
    this.camera.centerOn(MAP_SIZE / 2, MAP_SIZE / 2);
    this.renderer = new Renderer(canvas, this.world, this.camera);
    this.tools = new ToolController(this);
    this.ui = new UI(this);

    this.bindInput();
    this.resize();
    this.sim.notify('Welcome, Mayor. Lay some road, zone beside it, and connect power.', 'info');
    this.ui.refresh();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ lifecycle --

  newCity() {
    this.world = new World(MAP_SIZE, (Math.random() * 0xffffffff) >>> 0);
    this.sim = new Simulation(this.world);
    this.renderer.world = this.world;
    this.tools.cancel();
    this.ui.selected = null;
    this.camera.centerOn(MAP_SIZE / 2, MAP_SIZE / 2);
    this.sim.notify('A fresh site. Good luck.', 'info');
    this.renderer.markDirty();
    this.ui.refresh();
  }

  save() {
    try {
      saveToStorage(this.world);
      this.toast('City saved.');
    } catch (err) {
      this.toast('Could not save: ' + err.message);
    }
  }

  load() {
    if (!hasSave()) { this.toast('No saved city found.'); return; }
    try {
      const world = loadFromStorage();
      this.world = world;
      this.sim = new Simulation(world);
      this.sim.topologyDirty = true;
      this.renderer.world = world;
      this.tools.cancel();
      this.ui.selected = null;
      this.renderer.markDirty();
      this.ui.refresh();
      this.toast('City loaded.');
    } catch (err) {
      this.toast('Could not load: ' + err.message);
    }
  }

  setSpeed(s) {
    this.speed = s;
    this.ui.refresh();
  }

  inspect(tile) {
    this.ui.inspect(tile);
  }

  toast(text) { this.ui.toast(text); }

  // ----------------------------------------------------------- frame loop --

  frame(now) {
    const interval = SPEED_TICK_MS[this.speed];
    if (Number.isFinite(interval) && now - this.lastTick >= interval) {
      this.lastTick = now;
      this.sim.step();
      this.renderer.markDirty();
      // The readouts are cheap, but not free -- refresh a few times a second.
      if (this.world.tick % 4 === 0) this.ui.refresh();
    }
    this.renderer.render();
    requestAnimationFrame((t) => this.frame(t));
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = window.innerWidth, h = window.innerHeight;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.canvas.style.width = w + 'px';
    this.canvas.style.height = h + 'px';
    this.dpr = dpr;
    this.camera.resize(this.canvas.width, this.canvas.height);
    this.renderer.markDirty();
  }

  /** Client coordinates -> canvas backing-store coordinates. */
  toCanvas(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * this.dpr, y: (e.clientY - rect.top) * this.dpr };
  }

  // ---------------------------------------------------------------- input --

  bindInput() {
    const c = this.canvas;
    window.addEventListener('resize', () => this.resize());

    c.addEventListener('contextmenu', (e) => e.preventDefault());

    c.addEventListener('pointerdown', (e) => {
      c.setPointerCapture(e.pointerId);
      // Right button, middle button or space-drag pans the map.
      if (e.button === 1 || e.button === 2 || this.spaceHeld) {
        this.panning = true;
        this.panFrom = { x: e.clientX, y: e.clientY };
        c.classList.add('panning');
        return;
      }
      this.pointerDown = true;
      const p = this.toCanvas(e);
      this.tools.onPointerDown(pickTile(this.world, this.camera, p.x, p.y));
      this.syncCost();
    });

    c.addEventListener('pointermove', (e) => {
      if (this.panning) {
        const dx = (e.clientX - this.panFrom.x) * this.dpr;
        const dy = (e.clientY - this.panFrom.y) * this.dpr;
        this.panFrom = { x: e.clientX, y: e.clientY };
        this.camera.x -= dx / this.camera.zoom;
        this.camera.y -= dy / this.camera.zoom;
        this.camera.clampTo(this.world.size);
        this.renderer.markDirty();
        return;
      }
      const p = this.toCanvas(e);
      this.tools.onPointerMove(pickTile(this.world, this.camera, p.x, p.y));
      this.syncCost();
    });

    const endPointer = (e) => {
      if (this.panning) {
        this.panning = false;
        c.classList.remove('panning');
        return;
      }
      if (!this.pointerDown) return;
      this.pointerDown = false;
      const p = this.toCanvas(e);
      this.tools.onPointerUp(pickTile(this.world, this.camera, p.x, p.y));
      this.syncCost();
    };
    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', () => { this.pointerDown = false; this.panning = false; this.tools.cancel(); });

    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const p = this.toCanvas(e);
      this.camera.zoomAt(p.x, p.y, e.deltaY < 0 ? 1.12 : 1 / 1.12);
      this.camera.clampTo(this.world.size);
      this.renderer.markDirty();
    }, { passive: false });

    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
      switch (e.code) {
        case 'Space': this.spaceHeld = true; e.preventDefault(); break;
        case 'Escape': this.tools.cancel(); this.ui.closeModal(); break;
        case 'Digit0': this.setSpeed(0); break;
        case 'Digit1': this.setSpeed(1); break;
        case 'Digit2': this.setSpeed(2); break;
        case 'Digit3': this.setSpeed(3); break;
        case 'KeyB': this.tools.select(TOOL.BULLDOZE); this.ui.setActiveTool(TOOL.BULLDOZE); break;
        case 'KeyG': this.renderer.showGrid = !this.renderer.showGrid; this.renderer.markDirty(); break;
        default: break;
      }
      const pan = 60 / this.camera.zoom;
      if (e.code === 'ArrowLeft') { this.camera.x -= pan; this.renderer.markDirty(); }
      if (e.code === 'ArrowRight') { this.camera.x += pan; this.renderer.markDirty(); }
      if (e.code === 'ArrowUp') { this.camera.y -= pan; this.renderer.markDirty(); }
      if (e.code === 'ArrowDown') { this.camera.y += pan; this.renderer.markDirty(); }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') this.spaceHeld = false; });
  }

  syncCost() {
    const t = this.tools;
    if (t.tool === TOOL.SELECT) { this.ui.setCost(0, true); return; }
    const cost = t.previewCost || 0;
    this.ui.setCost(cost, cost <= this.world.funds);
  }
}

const canvas = document.getElementById('view');
window.game = new Game(canvas);
