/**
 * Monthly budget and civic approval.
 *
 * Revenue scales with land value as well as headcount, so improving a district
 * pays twice: better buildings hold more people, and each of them is taxed on a
 * more valuable parcel. Upkeep, meanwhile, scales with everything you have ever
 * built -- which is what eventually punishes sprawl.
 */

import { ROAD_INFO, POWERLINE_UPKEEP, BUILDINGS, TAX_PER_RESIDENT, TAX_PER_JOB, Z, T,
         BRIDGE_UPKEEP_MULTIPLIER, POWERLINE_CROSSING_MULTIPLIER } from '../config.js';
import { clamp } from '../util.js';

export function monthlyBudget(world) {
  const n = world.size * world.size;
  const st = world.stats;

  // --- revenue -------------------------------------------------------------
  let taxR = 0, taxC = 0, taxI = 0;
  for (let i = 0; i < n; i++) {
    const z = world.zone[i];
    if (!z || world.level[i] === 0) continue;
    // A parcel at half the map's land value yields roughly half the tax.
    const lvFactor = 0.45 + (world.landValue[i] / 255) * 1.25;

    if (z === Z.R_LOW || z === Z.R_HIGH) {
      taxR += world.pop[i] * TAX_PER_RESIDENT * lvFactor * (world.tax.R / 10);
    } else if (z === Z.C_LOW || z === Z.C_HIGH) {
      taxC += world.jobs[i] * TAX_PER_JOB * lvFactor * (world.tax.C / 10);
    } else {
      taxI += world.jobs[i] * TAX_PER_JOB * lvFactor * (world.tax.I / 10);
    }
  }
  const income = taxR + taxC + taxI;

  // --- upkeep --------------------------------------------------------------
  let roadCost = 0, lineCost = 0, serviceCost = 0;
  for (let i = 0; i < n; i++) {
    // Spans over water cost more to keep standing than road laid on soil.
    const overWater = world.terrain[i] === T.WATER;
    if (world.road[i]) {
      roadCost += ROAD_INFO[world.road[i]].upkeep * (overWater ? BRIDGE_UPKEEP_MULTIPLIER : 1);
    }
    if (world.powerLine[i]) {
      lineCost += POWERLINE_UPKEEP * (overWater ? POWERLINE_CROSSING_MULTIPLIER : 1);
    }
  }
  for (const b of world.activeBuildings()) {
    if (b.on) serviceCost += BUILDINGS[b.type].upkeep;
  }
  const expenses = roadCost + lineCost + serviceCost;

  const balance = income - expenses;
  world.funds += balance;

  st.income = income;
  st.expenses = expenses;
  st.lastBalance = balance;
  st.breakdown = { taxR, taxC, taxI, roadCost, lineCost, serviceCost };

  updateApproval(world);

  world.history.push({
    month: world.month, year: world.year,
    population: st.population, funds: world.funds,
    income, expenses, approval: st.approval,
    landValue: st.avgLandValue, pollution: st.avgPollution,
    unemployment: st.unemployment,
  });
  if (world.history.length > 600) world.history.shift();

  return balance;
}

/**
 * Approval is the citizens' summary judgement. It feeds back into residential
 * demand, so neglecting services slowly strangles growth rather than producing
 * an immediate complaint and nothing else.
 */
function updateApproval(world) {
  const st = world.stats;
  let score = 62;

  score -= st.unemployment * 55;
  score -= clamp(st.avgPollution / 2.4, 0, 26);
  score -= clamp(averageField(world, world.crime) / 3.2, 0, 20);
  score -= clamp((st.congestion - 0.55) * 34, 0, 20);
  score -= clamp(st.brownoutShare || 0, 0, 1) * 18;

  // Taxes: mild gratitude below 9%, sharp resentment in the high teens.
  const avgTax = (world.tax.R + world.tax.C + world.tax.I) / 3;
  score -= avgTax > 9 ? (avgTax - 9) * 2.6 : (avgTax - 9) * 0.9;

  // Service coverage where people actually live.
  if (st.population > 0) {
    score += coverageScore(world, 'police') * 6;
    score += coverageScore(world, 'fire') * 5;
    score += coverageScore(world, 'health') * 7;
    score += coverageScore(world, 'education') * 8;
    score += coverageScore(world, 'park') * 6;
  }

  st.approval = clamp(Math.round(score), 0, 100);
}

/** Mean of a field over land tiles only. */
function averageField(world, field) {
  const n = world.size * world.size;
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (world.terrain[i] !== 0) { sum += field[i]; count++; }
  }
  return count ? sum / count : 0;
}

/** Population-weighted coverage for one service, in [0, 1]. */
function coverageScore(world, key) {
  const n = world.size * world.size;
  const field = world.coverage[key];
  let weighted = 0, people = 0;
  for (let i = 0; i < n; i++) {
    const p = world.pop[i];
    if (!p) continue;
    weighted += (field[i] / 255) * p;
    people += p;
  }
  return people ? weighted / people : 0;
}
