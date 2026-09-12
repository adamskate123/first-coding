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
/**
 * How hard unfilled labour pulls each sector.
 *
 * Industry harder than commerce: a factory hires whoever is going, while a
 * shop only opens where there are customers to serve as well as staff to hire.
 */
const SLACK_PULL = { C: 0.5, I: 0.85 };

/**
 * Why each bar sits where it does, in the player's terms.
 *
 * The model was legible to nobody but itself: industrial demand could sit flat
 * while a seventh of the workforce was out of work, and the game offered no
 * account of why or what to do about it. Every term now records the name of
 * what it is and which way it pushed, so the city can be asked.
 */
export function updateDemand(world) {
  const st = world.stats;
  const pop = st.population;
  const jobsC = st.jobsC;
  const jobsI = st.jobsI;
  const jobs = st.jobs;
  const workforce = pop * WORKFORCE_RATIO;

  const why = { R: [], C: [], I: [] };
  // Every term is added, never subtracted, so what a driver contributes and
  // what it is reported as are the same number. Recording the magnitude of a
  // penalty and subtracting it at the call site listed "Pollution +0.3" for
  // something that was pushing demand down.
  const add = (k, label, v) => {
    if (Math.abs(v) >= 0.02) why[k].push({ label, v });
    return v;
  };

  // A young city gets a starter appetite so the first blocks actually build.
  const seed = clamp(1 - pop / 400, 0, 1);

  // Workers with nowhere to go. This is the term that was missing: demand was
  // worked out sector by sector against population, so once each sector had
  // its "share" of jobs nothing wanted to expand, however many people were out
  // of work. Unfilled labour is exactly what makes an employer open a second
  // shift, and it is the lever a player pulls by zoning more of it.
  const slack = workforce > 0
    ? clamp((workforce - jobs) / Math.max(150, workforce * 0.4), -1, 1)
    : 0;

  // --- residential: are there jobs to move here for? ----------------------
  let dR = add('R', 'Jobs going spare', softRatio(jobs - workforce, Math.max(90, workforce * 1.5)));
  dR += add('R', 'A new city', seed * 0.6);
  dR += add('R', 'Residential tax', taxPull(world.tax.R) * 1.1);
  dR += add('R', 'Approval', (st.approval - 50) / 140);
  dR += add('R', 'Pollution', -clamp(st.avgPollution / 160, 0, 0.5));
  dR += add('R', 'Power shortage', -clamp(st.brownoutShare || 0, 0, 1) * 0.45);

  // --- commercial: are there customers to sell to? ------------------------
  const cTarget = pop * C_JOBS_PER_RESIDENT;
  let dC = add('C', 'Customers to serve', softRatio(cTarget - jobsC, Math.max(60, cTarget * 1.5)));
  dC += add('C', 'A new city', seed * 0.35);
  dC += add('C', 'Commercial tax', taxPull(world.tax.C) * 1.2);
  dC += add('C', 'Workers available', slack * SLACK_PULL.C);
  dC += add('C', 'Gridlock', -clamp(st.congestion - 0.7, 0, 1) * 0.4);

  // --- industrial: local orders plus an external market --------------------
  const external = 55 + Math.sqrt(Math.max(0, pop)) * 3.4;
  const iTarget = pop * I_JOBS_PER_RESIDENT + external;
  let dI = add('I', 'Orders to fill', softRatio(iTarget - jobsI, Math.max(70, iTarget * 1.5)));
  dI += add('I', 'A new city', seed * 0.5);
  dI += add('I', 'Industrial tax', taxPull(world.tax.I) * 1.3);
  dI += add('I', 'Workers available', slack * SLACK_PULL.I);
  dI += add('I', 'Workers cannot reach it',
    -clamp(st.jobAccess !== undefined ? (1 - st.jobAccess) * 0.5 : 0, 0, 0.5));

  for (const k of ['R', 'C', 'I']) why[k].sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  world.demand.why = why;

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
