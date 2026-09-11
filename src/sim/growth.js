/**
 * Zone development.
 *
 * Every zoned tile is a small market actor. It checks whether it is connected,
 * powered, wanted, and whether the surrounding land value justifies the next
 * building up -- then edges towards growth or abandonment. A hysteresis timer
 * on each tile stops districts flickering between built and derelict when a
 * value sits right on a threshold.
 */

import { ZONE_INFO, Z, WEALTH_THRESHOLDS, WEALTH_HYSTERESIS } from '../config.js';
import { clamp } from '../util.js';

/**
 * Timer units needed to add or drop a level.
 *
 * Decay is deliberately far slower than growth. An earlier symmetric version
 * oscillated violently: demand would tip negative, every oversupplied lot in
 * the city would decay on the same tick, supply would collapse to nothing,
 * demand would spike, and the whole district would rebuild -- over and over.
 * Making abandonment slow and probabilistic breaks that lockstep, so the market
 * settles at mild oversupply instead of cycling.
 */
const GROW_THRESHOLD = 12;
const DECAY_THRESHOLD = -24;

/** Demand must clear this before anyone builds. */
const GROW_DEMAND = 0.08;
/** ...and fall below this before anyone walks away. */
const ABANDON_DEMAND = -0.40;

/** Per-tick chance that a lot acts on the pressure it feels. */
const GROW_CHANCE = 0.5;
const DECAY_CHANCE = 0.12;

export function updateGrowth(world, rng) {
  const s = world.size, n = s * s;

  for (let i = 0; i < n; i++) {
    const z = world.zone[i];
    if (z === Z.NONE) continue;
    const info = ZONE_INFO[z];
    if (!info) continue;

    const maxLevel = info.cap.length - 1;
    const level = world.level[i];
    const demand = world.demand[info.cat];

    // --- hard requirements ------------------------------------------------
    const connected = world.roadAccess[i] === 1;
    const powered = world.powered[i] === 1;

    let pressure = 0;

    if (!connected) {
      pressure = -3;                       // nothing gets built off-road
    } else if (!powered) {
      pressure = level > 0 ? -2 : -1;      // dark buildings empty out
    } else {
      const lv = world.landValue[i];
      const nextLevel = Math.min(level + 1, maxLevel);
      const needed = info.lvNeed[nextLevel];

      // Can the land support the next step up?
      const canUpgrade = level < maxLevel && lv >= needed;
      // Has the neighbourhood fallen below what this building needs?
      const undercut = level > 0 && lv < info.lvNeed[level] - 22;

      if (undercut) {
        pressure = -2;
      } else if (demand > GROW_DEMAND && canUpgrade) {
        // Strong demand and good land build faster.
        pressure = 1 + (demand > 0.4 ? 1 : 0) + (lv > needed + 40 ? 1 : 0);
      } else if (demand < ABANDON_DEMAND) {
        pressure = level > 0 ? -1 : 0;     // deep oversupply empties the weakest stock
      } else {
        pressure = 0;                      // the deadband where the market rests
      }

      // Nuisance drives people out of homes and shoppers out of stores.
      if (info.cat !== 'I') {
        if (world.pollution[i] > 150) pressure -= 1;
        if (world.crime[i] > 170) pressure -= 1;
      }
    }

    // --- accumulate, with a little noise so districts fill in unevenly ----
    // Both directions are gated on a die roll. Without it every lot in a
    // district reaches its threshold on the same tick and the city pulses.
    if (pressure > 0) {
      if (rng() < GROW_CHANCE) world.growthTimer[i] = clamp(world.growthTimer[i] + pressure, -60, 60);
    } else if (pressure < 0) {
      // Losing power or road access is felt immediately; mere oversupply is not.
      const urgent = !connected || !powered;
      if (urgent || rng() < DECAY_CHANCE) {
        world.growthTimer[i] = clamp(world.growthTimer[i] + pressure, -60, 60);
      }
    } else {
      world.growthTimer[i] = Math.round(world.growthTimer[i] * 0.94);
    }

    // --- resolve -----------------------------------------------------------
    if (world.growthTimer[i] >= GROW_THRESHOLD && level < maxLevel) {
      world.level[i] = level + 1;
      world.growthTimer[i] = 0;
      world.dirty = true;
    } else if (world.growthTimer[i] <= DECAY_THRESHOLD && level > 0) {
      world.level[i] = level - 1;
      world.growthTimer[i] = 0;
      world.dirty = true;
    }

    // --- how prosperous the lot presents as -------------------------------
    world.wealth[i] = wealthTier(world.landValue[i], world.wealth[i]);

    // --- occupancy follows the built level --------------------------------
    const cap = info.cap[world.level[i]] || 0;
    if (info.cat === 'R') { world.pop[i] = cap; world.jobs[i] = 0; }
    else { world.jobs[i] = cap; world.pop[i] = 0; }
  }
}

/**
 * Which wealth tier a lot presents as, given the land value under it and the
 * tier it currently shows.
 *
 * Applied with hysteresis: land has to move a clear margin past a boundary
 * before the tier changes, so a district sitting right on a threshold does not
 * flicker between two building styles every time the field settles.
 */
export function wealthTier(landValue, current = 0) {
  const [lower, upper] = WEALTH_THRESHOLDS;
  const m = WEALTH_HYSTERESIS;
  let tier = current;

  if (landValue >= upper + m) tier = Math.max(tier, 2);
  else if (landValue >= lower + m) tier = Math.max(tier, 1);

  if (landValue < upper - m) tier = Math.min(tier, 1);
  if (landValue < lower - m) tier = Math.min(tier, 0);

  return tier;
}

/** Roll up per-tile occupancy into the city-wide figures. */
export function tallyCity(world) {
  const n = world.size * world.size;
  let pop = 0, jobsC = 0, jobsI = 0, lvSum = 0, lvCount = 0, pollSum = 0;

  for (let i = 0; i < n; i++) {
    pop += world.pop[i];
    const z = world.zone[i];
    if (z === Z.C_LOW || z === Z.C_HIGH) jobsC += world.jobs[i];
    else if (z === Z.I_LIGHT || z === Z.I_HEAVY) jobsI += world.jobs[i];

    if (world.terrain[i] !== 0) { lvSum += world.landValue[i]; lvCount++; pollSum += world.pollution[i]; }
  }

  const st = world.stats;
  st.population = pop;
  st.jobsC = jobsC;
  st.jobsI = jobsI;
  st.jobs = jobsC + jobsI;
  st.avgLandValue = lvCount ? lvSum / lvCount : 0;
  st.avgPollution = lvCount ? pollSum / lvCount : 0;

  const workforce = pop * 0.5;
  st.employed = Math.min(workforce, st.jobs);
  st.unemployment = workforce > 0 ? clamp((workforce - st.jobs) / workforce, 0, 1) : 0;
}
