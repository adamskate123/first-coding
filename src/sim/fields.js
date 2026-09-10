/**
 * Scalar fields: service coverage, pollution, crime, land value.
 *
 * Each is a per-tile Uint8 map that spreads spatially, which is what makes
 * placement matter. A park lifts its neighbourhood; a heavy-industry district
 * poisons the land downwind of it; a police station's effect fades with
 * distance rather than stopping at a hard line. Land value then reads all of
 * them and decides what the market is willing to build.
 */

import { SERVICE_KEYS, SERVICE_WEIGHT, BUILDINGS, ZONE_POLLUTION, ZONE_INFO, T, ROAD_INFO } from '../config.js';
import { clamp } from '../util.js';

/** Distance (in tiles, capped) from every tile to open water. Terrain is
 *  static, so this is computed once and cached on the world. */
export function waterDistance(world) {
  if (world._waterDist) return world._waterDist;
  const s = world.size, n = s * s;
  const dist = new Uint8Array(n).fill(255);
  const queue = new Int32Array(n);
  let head = 0, tail = 0;

  for (let i = 0; i < n; i++) {
    if (world.terrain[i] === T.WATER) { dist[i] = 0; queue[tail++] = i; }
  }
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i];
    if (d >= 30) continue;
    const x = i % s, y = (i / s) | 0;
    const nd = d + 1;
    if (x > 0 && dist[i - 1] > nd) { dist[i - 1] = nd; queue[tail++] = i - 1; }
    if (x < s - 1 && dist[i + 1] > nd) { dist[i + 1] = nd; queue[tail++] = i + 1; }
    if (y > 0 && dist[i - s] > nd) { dist[i - s] = nd; queue[tail++] = i - s; }
    if (y < s - 1 && dist[i + s] > nd) { dist[i + s] = nd; queue[tail++] = i + s; }
  }
  world._waterDist = dist;
  return dist;
}

/**
 * Stamp every service building's radial influence into its coverage field.
 * Unpowered buildings provide nothing, which is how a blackout cascades into
 * a crime wave rather than merely dimming the lights.
 */
export function updateCoverage(world) {
  for (const k of SERVICE_KEYS) world.coverage[k].fill(0);
  const s = world.size;

  for (const b of world.activeBuildings()) {
    const spec = BUILDINGS[b.type];
    if (!spec.service || !b.on) continue;
    // Parks need no power; staffed services do.
    if (spec.category !== 'park' && !b.powered) continue;

    const field = world.coverage[spec.service];
    const r = spec.radius;
    const cx = b.x + (b.span - 1) / 2;
    const cy = b.y + (b.span - 1) / 2;
    const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(s - 1, Math.ceil(cx + r));
    const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(s - 1, Math.ceil(cy + r));

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x - cx, dy = y - cy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d > r) continue;
        // Smooth falloff: full strength at the door, zero at the rim.
        const strength = Math.round(255 * (1 - d / r) ** 0.8);
        const i = y * s + x;
        if (strength > field[i]) field[i] = Math.min(255, field[i] + strength);
      }
    }
  }
}

/** Emit pollution from industry, dense commerce and busy roads, then spread it. */
export function updatePollution(world) {
  const s = world.size, n = s * s;
  const src = world._pollSrc && world._pollSrc.length === n ? world._pollSrc : (world._pollSrc = new Float32Array(n));
  src.fill(0);

  for (let i = 0; i < n; i++) {
    const z = world.zone[i];
    if (z && world.level[i] > 0) {
      const table = ZONE_POLLUTION[z];
      if (table) src[i] += table[world.level[i]] || 0;
    }
    const r = world.road[i];
    if (r) {
      const cap = ROAD_INFO[r].capacity;
      src[i] += Math.min(18, (world.traffic[i] / cap) * 16);
    }
  }

  for (const b of world.activeBuildings()) {
    const spec = BUILDINGS[b.type];
    if (!spec.pollution || !b.on) continue;
    for (let dy = 0; dy < b.span; dy++) {
      for (let dx = 0; dx < b.span; dx++) {
        src[(b.y + dy) * s + (b.x + dx)] += spec.pollution;
      }
    }
    }

  const spread = diffuse(world, src, 3, 0.92);
  for (let i = 0; i < n; i++) world.pollution[i] = clamp(Math.round(spread[i]), 0, 255);
}

/**
 * Crime rises with density and joblessness, falls with policing and wealth.
 * It is computed from last tick's land value, which is fine -- the fields
 * settle into equilibrium over a few months either way.
 */
export function updateCrime(world) {
  const s = world.size, n = s * s;
  const src = world._crimeSrc && world._crimeSrc.length === n ? world._crimeSrc : (world._crimeSrc = new Float32Array(n));
  src.fill(0);

  const unemployment = clamp(world.stats.unemployment, 0, 1);
  const police = world.coverage.police;

  for (let i = 0; i < n; i++) {
    const people = world.pop[i];
    if (!people) continue;
    const density = Math.min(1, people / 120);
    const poverty = 1 - world.landValue[i] / 255;
    let c = 120 * density * (0.35 + 0.65 * poverty) * (0.55 + unemployment);
    c *= 1 - 0.85 * (police[i] / 255);
    src[i] = c;
  }

  const spread = diffuse(world, src, 2, 0.88);
  for (let i = 0; i < n; i++) world.crime[i] = clamp(Math.round(spread[i]), 0, 255);
}

/**
 * Land value: the single number the growth model consults.
 *
 * Positives are amenity (water views, trees, parks, schools, safety); negatives
 * are nuisance (pollution, crime, gridlock, heavy industry next door). The
 * result is blurred so values grade smoothly across a neighbourhood instead of
 * snapping tile by tile.
 */
export function updateLandValue(world) {
  const s = world.size, n = s * s;
  const wd = waterDistance(world);
  const raw = world._lvRaw && world._lvRaw.length === n ? world._lvRaw : (world._lvRaw = new Float32Array(n));

  for (let i = 0; i < n; i++) {
    if (world.terrain[i] === T.WATER) { raw[i] = 0; continue; }

    let v = 42;                                        // baseline scrubland

    const d = wd[i];
    if (d <= 12) v += (1 - d / 12) * 34;               // waterfront premium
    v += clamp((world.elevation[i] - 8) * 1.4, -6, 16); // views from the hills
    if (world.tree[i]) v += 7;

    for (const k of SERVICE_KEYS) {
      v += (world.coverage[k][i] / 255) * 100 * SERVICE_WEIGHT[k];
    }

    if (world.roadAccess[i]) v += 10;
    const r = world.road[i];
    if (r) {
      const congestion = world.traffic[i] / ROAD_INFO[r].capacity;
      v -= clamp(congestion, 0, 2) * 14;               // nobody wants the arterial
    }

    v -= (world.pollution[i] / 255) * 95;
    v -= (world.crime[i] / 255) * 60;

    raw[i] = v;
  }

  const smooth = diffuse(world, raw, 2, 1.0);
  for (let i = 0; i < n; i++) {
    world.landValue[i] = world.terrain[i] === T.WATER ? 0 : clamp(Math.round(smooth[i]), 0, 255);
  }
}

/**
 * Separable box blur, `passes` times, with a per-pass retention factor.
 * Repeated box blurs approximate a Gaussian, which is plenty for a field that
 * only ever gets quantised to 8 bits.
 */
function diffuse(world, src, passes, retain) {
  const s = world.size, n = s * s;
  let a = src;
  let b = world._diffTmp && world._diffTmp.length === n ? world._diffTmp : (world._diffTmp = new Float32Array(n));

  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < s; y++) {
      const row = y * s;
      for (let x = 0; x < s; x++) {
        const i = row + x;
        const l = x > 0 ? a[i - 1] : a[i];
        const r = x < s - 1 ? a[i + 1] : a[i];
        b[i] = (l + a[i] * 2 + r) * 0.25 * retain;
      }
    }
    // vertical
    for (let y = 0; y < s; y++) {
      const row = y * s;
      for (let x = 0; x < s; x++) {
        const i = row + x;
        const u = y > 0 ? b[i - s] : b[i];
        const d = y < s - 1 ? b[i + s] : b[i];
        a[i] = (u + b[i] * 2 + d) * 0.25 * retain;
      }
    }
  }
  return a;
}
