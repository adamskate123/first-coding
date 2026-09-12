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
const SERVICE_LIFT = 62;

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

    // Services lift land, but they cannot be the whole story: at the old scale
    // a thoroughly serviced city sat at 125-150 almost everywhere, which left
    // no gradient for density to climb and made every district equally prime.
    for (const k of SERVICE_KEYS) {
      v += (world.coverage[k][i] / 255) * SERVICE_LIFT * SERVICE_WEIGHT[k];
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
  const prestige = updatePrestige(world);
  for (let i = 0; i < n; i++) {
    world.landValue[i] = world.terrain[i] === T.WATER
      ? 0
      : clamp(Math.round(smooth[i] + prestige[i]), 0, 255);
  }
}

/**
 * Agglomeration: value begets value.
 *
 * Land value used to be a sum of amenities and nuisances, which gave every
 * district the same ceiling -- measured across a fully built 96x96 city, the
 * highest land value anywhere was 94, while dense residential needs 140 to
 * reach its third level and 180 for its fourth. The top half of the game was
 * unreachable by construction, not by bad play: the towers and the wealthy
 * tier existed in the art and could never be built.
 *
 * What was missing is the feedback real cities run on. Development raises the
 * value of the land around it, which supports denser development, which raises
 * it further -- so a centre emerges where investment concentrates rather than
 * value being a thin function of parks and coastline. The effect saturates, so
 * a core plateaus instead of running away, and it is spatial, so building a
 * second downtown across the river means starting again rather than inheriting
 * the first one's prestige.
 *
 * Deliberately added *after* the amenity blur rather than before it. A box
 * blur can never produce a maximum higher than its input -- it only ever
 * lowers peaks -- so mixing this in beforehand would flatten the very thing it
 * exists to create.
 */
const PRESTIGE_BY_LEVEL = [0, 7, 15, 26, 38];
/**
 * Tiles. District scale, not street scale -- but narrower than it looks: three
 * passes of a radius-7 window reach about twenty tiles, which is wider than
 * most districts, so a neighbourhood ended up diluting itself against the
 * empty land around it. Measured, a 13-tile block of towers earned 22 points
 * of a possible 90.
 */
const PRESTIGE_RADIUS = 5;
const PRESTIGE_PASSES = 2;
const PRESTIGE_CAP = 90;           // most a neighbourhood can earn this way
/**
 * Blurred concentration at which a district earns the whole cap.
 *
 * Set from measurement, not from the table above: a district is not solid
 * towers, it is towers with streets, power lines and vacant lots between them,
 * so the smoothed figure even in a dense core runs about half what the
 * per-lot scores suggest. Reading it off the table gave a downtown eleven
 * points of a hundred and no visible feedback at all.
 */
const PRESTIGE_REF = 15;
/** Above one, so ordinary streets earn little and only a real core earns a lot. */
const PRESTIGE_CURVE = 1.7;
/** How fast a neighbourhood's standing follows what is built on it. */
const PRESTIGE_EASE = 0.06;

/**
 * Bring a neighbourhood's standing straight to what its buildings imply.
 *
 * The easing exists to damp a feedback loop over time, but a city that has
 * just been loaded has no time to damp -- it arrives fully built with its
 * standing at zero, and spends the next few months believing it is worthless.
 * Measured on a saved city, land value fell from 186 to 127 on load and took
 * five game months to climb back, which is close enough to the abandonment
 * threshold that a slightly different city would have started demolishing
 * itself for no reason the player could see.
 *
 * Nothing needs saving to fix it: the settled value is entirely determined by
 * what stands on the map, so it can simply be recomputed on arrival.
 */
export function primePrestige(world) {
  for (let k = 0; k < 240; k++) updatePrestige(world);
  return world.prestige;
}

export function updatePrestige(world) {
  const s = world.size, n = s * s;
  const src = world._prestigeSrc && world._prestigeSrc.length === n
    ? world._prestigeSrc : (world._prestigeSrc = new Float32Array(n));
  const out = world.prestige && world.prestige.length === n
    ? world.prestige : (world.prestige = new Float32Array(n));
  src.fill(0);

  let any = false;
  for (let i = 0; i < n; i++) {
    const level = world.level[i];
    if (!level || !world.zone[i]) continue;
    any = true;
    // Wealthier stock carries more of the neighbourhood with it, and a lot
    // that is dark or cut off is contributing nothing to anybody.
    const tier = 1 + world.wealth[i] * 0.22;
    src[i] = (PRESTIGE_BY_LEVEL[Math.min(4, level)] || 0) * tier * (world.powered[i] ? 1 : 0.35);
  }
  if (!any) { out.fill(0); return out; }

  const target = world._prestigeTarget && world._prestigeTarget.length === n
    ? world._prestigeTarget : (world._prestigeTarget = new Float32Array(n));
  boxBlur(world, src, target, PRESTIGE_RADIUS, PRESTIGE_PASSES);

  // Capped, and deliberately steeper than linear. An exponential knee was tried
  // first and handed nearly the whole lift to any built-up street at all, which
  // made a uniformly developed city uniformly prime -- measured, 1786 of 1975
  // lots came out in the top wealth tier, and a city with no poor districts has
  // no gradient for the market to climb.
  // Eased towards the figure rather than snapped to it, because this is a
  // feedback loop: value raises density, density raises value. Recomputed from
  // scratch each pass it oscillated hard -- measured on one city, population
  // swung 9.9k -> 16.8k -> 18.6k and land value 137 -> 92 -> 159 as districts
  // built out, crashed the market, emptied and rebuilt. Standing in a city
  // watching whole quarters blink in and out is worse than no feedback at all.
  //
  // Land values are sticky in reality for the same reason: a neighbourhood's
  // reputation is a memory of what has stood there, not a reading of what
  // stands there this month.
  for (let i = 0; i < n; i++) {
    const v = Math.min(1, target[i] / PRESTIGE_REF);
    const goal = PRESTIGE_CAP * Math.pow(v, PRESTIGE_CURVE);
    out[i] += (goal - out[i]) * PRESTIGE_EASE;
  }
  return out;
}

/**
 * Separable box blur with a sliding window, so the cost does not depend on the
 * radius. The narrow [1,2,1] kernel below is right for smoothing a field over
 * a few tiles; spreading influence across a whole district with it would take
 * over a hundred passes.
 */
function boxBlur(world, src, dst, radius, passes) {
  const s = world.size, n = s * s;
  const tmp = world._blurTmp && world._blurTmp.length === n
    ? world._blurTmp : (world._blurTmp = new Float32Array(n));
  const width = radius * 2 + 1;
  dst.set(src);

  for (let p = 0; p < passes; p++) {
    // horizontal
    for (let y = 0; y < s; y++) {
      const row = y * s;
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += dst[row + clamp(k, 0, s - 1)];
      for (let x = 0; x < s; x++) {
        tmp[row + x] = sum / width;
        sum -= dst[row + clamp(x - radius, 0, s - 1)];
        sum += dst[row + clamp(x + radius + 1, 0, s - 1)];
      }
    }
    // vertical
    for (let x = 0; x < s; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++) sum += tmp[clamp(k, 0, s - 1) * s + x];
      for (let y = 0; y < s; y++) {
        dst[y * s + x] = sum / width;
        sum -= tmp[clamp(y - radius, 0, s - 1) * s + x];
        sum += tmp[clamp(y + radius + 1, 0, s - 1) * s + x];
      }
    }
  }
  return dst;
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
