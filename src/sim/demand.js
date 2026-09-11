/**
 * RCI demand.
 *
 * The classic three-bar indicator, driven by an actual balance rather than a
 * script. Residents chase unfilled jobs, shops chase customers, and industry
 * chases orders from both local commerce and an external market that grows
 * with the city's reputation. Tax rates shift each curve independently, so
 * over-taxing industry really does hollow out the industrial districts while
 * leaving the neighbourhoods alone.
 */

import { TAX_DEFAULT } from '../config.js';
import { clamp, lerp } from '../util.js';

/** Fraction of residents who hold, or want, a job. */
export const WORKFORCE_RATIO = 0.5;
/** Commercial jobs the city can sustain per resident. */
const C_JOBS_PER_RESIDENT = 0.18;
/** Industrial jobs per resident, before external demand. */
const I_JOBS_PER_RESIDENT = 0.20;

export function updateDemand(world) {
  const st = world.stats;
  const pop = st.population;
  const jobsC = st.jobsC;
  const jobsI = st.jobsI;
  const jobs = jobsC + jobsI;
  const workforce = pop * WORKFORCE_RATIO;

  // A young city gets a starter appetite so the first blocks actually build.
  const seed = clamp(1 - pop / 400, 0, 1);

  // --- residential: are there jobs to move here for? ----------------------
  let dR = softRatio(jobs - workforce, Math.max(90, workforce * 1.5));
  dR += seed * 0.6;
  dR += taxPull(world.tax.R) * 1.1;
  dR += (st.approval - 50) / 140;               // reputation matters
  dR -= clamp(st.avgPollution / 160, 0, 0.5);
  dR -= clamp(st.brownoutShare || 0, 0, 1) * 0.45;

  // --- commercial: are there customers to sell to? ------------------------
  const cTarget = pop * C_JOBS_PER_RESIDENT;
  let dC = softRatio(cTarget - jobsC, Math.max(60, cTarget * 1.5));
  dC += seed * 0.35;
  dC += taxPull(world.tax.C) * 1.2;
  dC -= clamp(st.congestion - 0.7, 0, 1) * 0.4;  // gridlock kills retail

  // --- industrial: local orders plus an external market --------------------
  const external = 55 + Math.sqrt(Math.max(0, pop)) * 3.4;
  const iTarget = pop * I_JOBS_PER_RESIDENT + external;
  let dI = softRatio(iTarget - jobsI, Math.max(70, iTarget * 1.5));
  dI += seed * 0.5;
  dI += taxPull(world.tax.I) * 1.3;
  dI -= clamp(st.jobAccess !== undefined ? (1 - st.jobAccess) * 0.5 : 0, 0, 0.5);

  // Ease towards the new figures; demand should drift, not jump.
  world.demand.R = lerp(world.demand.R, clamp(dR, -1, 1), 0.12);
  world.demand.C = lerp(world.demand.C, clamp(dC, -1, 1), 0.12);
  world.demand.I = lerp(world.demand.I, clamp(dI, -1, 1), 0.12);
}

/** Signed, saturating ratio in roughly [-1, 1]. */
function softRatio(delta, scale) {
  return Math.tanh(delta / scale);
}

/** Below the default rate, demand lifts; above it, demand falls away sharply. */
function taxPull(rate) {
  const d = TAX_DEFAULT - rate;
  return d >= 0 ? d * 0.045 : d * 0.075;
}
