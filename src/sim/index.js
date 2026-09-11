/**
 * Simulation orchestrator.
 *
 * Systems run at different cadences. Occupancy is cheap and updates every
 * tick; the diffusion fields and the traffic sweep are the expensive passes and
 * run on a stagger. Spreading them across the tick cycle keeps the frame budget
 * flat instead of spiking every time a slow system comes due.
 */

import { TICKS_PER_MONTH } from '../config.js';
import { updateRoadAccess, updatePower } from './networks.js';
import { updateCoverage, updatePollution, updateCrime, updateLandValue } from './fields.js';
import { updateTraffic } from './traffic.js';
import { updateDemand } from './demand.js';
import { updateGrowth, tallyCity } from './growth.js';
import { monthlyBudget } from './economy.js';
import { makeRng } from '../util.js';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class Simulation {
  constructor(world) {
    this.world = world;
    this.rng = makeRng(world.seed ^ 0x5f3759df);
    /** Set when the player edits the map, to force the slow passes to re-run. */
    this.topologyDirty = true;
  }

  step() {
    const w = this.world;
    const t = w.tick;

    if (this.topologyDirty || t % 3 === 0) {
      updateRoadAccess(w);
      updatePower(w);
      this.topologyDirty = false;
    }

    if (t % 5 === 0) {
      updateCoverage(w);
      updatePollution(w);
      updateCrime(w);
      updateLandValue(w);
    }

    if (t % 10 === 0) updateTraffic(w);

    updateGrowth(w, this.rng);
    tallyCity(w);
    if (t % 4 === 0) updateDemand(w);

    w.tick++;

    if (w.tick % TICKS_PER_MONTH === 0) this.endOfMonth();
  }

  endOfMonth() {
    const w = this.world;
    monthlyBudget(w);

    w.month++;
    if (w.month >= 12) { w.month = 0; w.year++; }

    if (w.funds < 0) {
      this.notify('Treasury is overdrawn. Raise taxes or cut services.', 'bad');
    }
    if (w.stats.brownout) {
      this.notify('Parts of the grid are browning out.', 'bad');
    }
    if (w.stats.unemployment > 0.25 && w.stats.population > 200) {
      this.notify('Unemployment is high. The city needs jobs.', 'warn');
    }
    if (w.stats.congestion > 1.0) {
      this.notify('Traffic is at a standstill on the main routes.', 'warn');
    }
  }

  notify(text, kind = 'info') {
    const w = this.world;
    const now = w.year * 12 + w.month;

    // Suppress an advisory we have already given recently. This has to scan a
    // window of recent entries, not just the newest one: with two standing
    // problems the messages alternate, so neither is ever the last entry and a
    // single-entry check lets both repeat every month forever.
    for (let i = w.log.length - 1; i >= 0 && i >= w.log.length - 8; i--) {
      const m = w.log[i];
      if (m.text === text && now - (m.year * 12 + m.month) < 6) return;
    }

    w.log.push({ text, kind, month: w.month, year: w.year });
    if (w.log.length > 40) w.log.shift();
  }

  get dateLabel() {
    return `${MONTH_NAMES[this.world.month]} ${this.world.year}`;
  }
}
