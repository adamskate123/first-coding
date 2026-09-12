/**
 * Simulation orchestrator.
 *
 * Systems run at different cadences. Occupancy is cheap and updates every
 * tick; the diffusion fields and the traffic sweep are the expensive passes and
 * run on a stagger. Spreading them across the tick cycle keeps the frame budget
 * flat instead of spiking every time a slow system comes due.
 */

import { TICKS_PER_MONTH, BUILDINGS, unlockedIn } from '../config.js';
import { updateRoadAccess, updatePower, updateBridgeDecks } from './networks.js';
import { updateCoverage, updatePollution, updateCrime, updateLandValue, primePrestige } from './fields.js';
import { updateTraffic } from './traffic.js';
import { updateDemand } from './demand.js';
import { updateGrowth, tallyCity } from './growth.js';
import { updateDevelopment } from './development.js';
import { monthlyBudget } from './economy.js';
import { makeRng } from '../util.js';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export class Simulation {
  constructor(world) {
    this.world = world;
    this.rng = makeRng(world.seed ^ 0x5f3759df);
    /** Set when the player edits the map, to force the slow passes to re-run. */
    this.topologyDirty = true;
    // A city can arrive here fully built -- loaded, imported, or handed over
    // after an edit -- so the state that is derived rather than saved is
    // brought up to what the map already implies, instead of being discovered
    // over the following months. Land value is the one that matters: arriving
    // at zero, a restored city reads as worthless and can begin abandoning
    // itself for no reason a player could see.
    //
    // Order matters here, and getting it wrong is quiet. Coverage needs to
    // know which service buildings have power, and a neighbourhood's standing
    // is discounted where the lights are off -- so priming before the grid is
    // worked out restores a city that believes it is unlit, which recovered
    // only a third of the shortfall.
    updateRoadAccess(world);
    updateBridgeDecks(world);
    updatePower(world);
    updateCoverage(world);
    primePrestige(world);
    updateLandValue(world);
  }

  step() {
    const w = this.world;
    const t = w.tick;

    if (this.topologyDirty || t % 3 === 0) {
      updateRoadAccess(w);
      updateBridgeDecks(w);
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
    updateDevelopment(w, this.rng);
    tallyCity(w);
    if (t % 4 === 0) updateDemand(w);

    w.tick++;

    if (w.tick % TICKS_PER_MONTH === 0) this.endOfMonth();
  }

  endOfMonth() {
    const w = this.world;
    monthlyBudget(w);

    w.month++;
    if (w.month >= 12) {
      w.month = 0;
      w.year++;
      this.announceUnlocks();
    }

    if (w.funds < 0) {
      this.notify('Treasury is overdrawn. Raise taxes or cut services.', 'bad');
    }
    if (w.stats.deadNetworks > 0) {
      const n = w.stats.deadNetworks;
      this.notify(`${n} district${n === 1 ? ' is' : 's are'} wired to no power plant.`, 'bad');
    } else if (w.stats.brownout) {
      this.notify('Parts of the grid are browning out.', 'bad');
    }
    if (w.stats.unemployment > 0.25 && w.stats.population > 200) {
      this.notify('Unemployment is high. The city needs jobs.', 'warn');
    }
    if (w.stats.congestion > 1.0) {
      this.notify('Traffic is at a standstill on the main routes.', 'warn');
    }
  }

  /**
   * Say what the new year has made possible.
   *
   * A catalogue that grows is only worth having if the player is told it grew;
   * otherwise the gas plant that became available in 1938 is discovered in
   * 1974, by accident, while looking for something else.
   */
  announceUnlocks() {
    const w = this.world;
    for (const type of unlockedIn(w.year)) {
      this.notify(`${BUILDINGS[type].name} can now be built.`, 'good');
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
