/**
 * Entry point: wiring, input, and the frame loop.
 *
 * Rendering and simulation are decoupled. The simulation advances on a fixed
 * wall-clock interval set by the speed control, while the renderer only repaints
 * when something has actually changed -- so a paused city costs nothing, and a
 * fast-forwarded one never renders more often than it simulates.
 */

import { MAP_SIZE, SPEED_TICK_MS, AUTOSAVE_INTERVAL_MS } from './config.js';
import { World } from './world.js';
import { Camera, pickTile } from './iso.js';
import { Simulation } from './sim/index.js';
import { Renderer } from './render/renderer.js';
import { ToolController, TOOL } from './tools.js';
import { UI } from './ui/index.js';
import { saveToStorage, loadFromStorage, hasSave, serialize, deserialize } from './save.js';

class Game {
  constructor(canvas) {
    this.canvas = canvas;
    this.speed = 2;
    this.lastTick = 0;
    this.pointerDown = false;
    this.panning = false;

    this.lastSaveAt = 0;
    this.savedLabel = null;

    // Resume the city you were playing. A reload that silently threw it away
    // and generated a new map is the whole reason this exists.
    const resumed = this.restore();
    this.world = resumed ? resumed.world : freshWorld();
    this.sim = new Simulation(this.world);
    this.sim.topologyDirty = true;

    this.camera = new Camera(canvas.width, canvas.height);
    if (resumed && resumed.camera) {
      this.camera.x = resumed.camera.x;
      this.camera.y = resumed.camera.y;
      this.camera.zoom = resumed.camera.zoom;
    } else {
      this.camera.centerOn(MAP_SIZE / 2, MAP_SIZE / 2);
    }

    this.renderer = new Renderer(canvas, this.world, this.camera);
    this.tools = new ToolController(this);
    this.ui = new UI(this);

    this.bindInput();
    this.resize();
    if (resumed) {
      this.sim.notify(`Welcome back, Mayor. Your city stands at ${this.sim.dateLabel}.`, 'info');
    } else {
      this.sim.notify('Welcome, Mayor. Lay some road, zone beside it, and connect power.', 'info');
      this.saveNow();            // so a reload right away resumes this map
    }
    this.ui.refresh();
    requestAnimationFrame((t) => this.frame(t));
  }

  // ------------------------------------------------------------ lifecycle --

  /**
   * Read the autosaved city, or null if there isn't one.
   *
   * A corrupt or half-written save must not brick the game: now that startup
   * loads automatically, an unreadable one has to fall back to a new map
   * rather than leaving a blank screen.
   */
  restore() {
    if (!hasSave()) return null;
    try {
      return loadFromStorage();
    } catch (err) {
      console.warn('Stored city could not be read; starting a new one.', err);
      return null;
    }
  }

  /** Swap in a world, pointing everything that holds a reference at it. */
  adopt(world) {
    this.world = world;
    this.sim = new Simulation(world);
    this.sim.topologyDirty = true;
    this.renderer.world = world;
    this.tools.cancel();
    this.ui.selected = null;
    this.renderer.markDirty();
    this.ui.refresh();
  }

  newCity() {
    this.adopt(freshWorld());
    this.camera.centerOn(MAP_SIZE / 2, MAP_SIZE / 2);
    this.sim.notify('A fresh site. Good luck.', 'info');
    // Replace the autosave straight away, so a reload resumes *this* city
    // rather than resurrecting the one just abandoned.
    this.saveNow();
    this.ui.refresh();
  }

  /** Write the city out now, whatever the autosave timer says. */
  saveNow() {
    try {
      saveToStorage(this.world, this.camera);
      this.lastSaveAt = Date.now();
      this.savedLabel = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      this.ui?.setSaveStatus(this.savedLabel);
      return true;
    } catch (err) {
      // Quota exhausted, or storage blocked in a private window.
      this.ui?.setSaveStatus('failed');
      this.toast('Could not save: ' + err.message);
      return false;
    }
  }

  /** Called every tick; writes at most once per AUTOSAVE_INTERVAL_MS. */
  autoSave() {
    if (Date.now() - this.lastSaveAt < AUTOSAVE_INTERVAL_MS) return;
    this.saveNow();
  }

  save() {
    if (this.saveNow()) this.toast('City saved.');
  }

  load() {
    const restored = this.restore();
    if (!restored) { this.toast('No saved city found.'); return; }
    this.adopt(restored.world);
    if (restored.camera) {
      this.camera.x = restored.camera.x;
      this.camera.y = restored.camera.y;
      this.camera.zoom = restored.camera.zoom;
      this.renderer.markDirty();
    }
    this.toast('Reverted to the saved city.');
  }

  /** Hand the player a file they can keep. Browser storage is per-browser
   *  and per-site, and a cleared cache takes it with them. */
  exportCity() {
    try {
      const data = JSON.stringify(serialize(this.world, this.camera));
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `metropolis-${this.world.year}-${String(this.world.month + 1).padStart(2, '0')}.json`;
      a.click();
      URL.revokeObjectURL(url);
      this.toast('City exported.');
    } catch (err) {
      this.toast('Could not export: ' + err.message);
    }
  }

  importCity() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const data = JSON.parse(String(reader.result));
          this.adopt(deserialize(data));
          if (data.camera) {
            this.camera.x = data.camera.x;
            this.camera.y = data.camera.y;
            this.camera.zoom = data.camera.zoom;
            this.renderer.markDirty();
          }
          this.saveNow();
          this.toast('City imported.');
        } catch (err) {
          this.toast('Not a readable city file.');
        }
      };
      reader.readAsText(file);
    });
    input.click();
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
      this.autoSave();
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

    // Flush on the way out. `pagehide` fires where `beforeunload` does not --
    // notably on mobile and when a page enters the back/forward cache -- and
    // the visibility check covers tab switches and app backgrounding.
    window.addEventListener('pagehide', () => this.saveNow());
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') this.saveNow();
    });

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

function freshWorld() {
  return new World(MAP_SIZE, (Math.random() * 0xffffffff) >>> 0);
}

const canvas = document.getElementById('view');
window.game = new Game(canvas);
