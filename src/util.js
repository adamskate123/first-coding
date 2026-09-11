/** Small shared helpers: deterministic noise, clamping, formatting. */

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;

/** Mulberry32 - compact, fast, seedable PRNG. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stable hash of two integers plus a salt. Used to give every tile a fixed
 * visual variant that survives save/load without being stored.
 */
export function hash2(x, y, salt = 0) {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b9);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** Value noise with fractal octaves, in [0,1]. */
export function fbm(x, y, seed, octaves = 5, persistence = 0.5) {
  let total = 0, amplitude = 1, frequency = 1, maxValue = 0;
  for (let o = 0; o < octaves; o++) {
    total += valueNoise(x * frequency, y * frequency, seed + o * 1013) * amplitude;
    maxValue += amplitude;
    amplitude *= persistence;
    frequency *= 2;
  }
  return total / maxValue;
}

function valueNoise(x, y, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf);
  const v = yf * yf * (3 - 2 * yf);
  const n00 = hash2(xi, yi, seed) / 4294967296;
  const n10 = hash2(xi + 1, yi, seed) / 4294967296;
  const n01 = hash2(xi, yi + 1, seed) / 4294967296;
  const n11 = hash2(xi + 1, yi + 1, seed) / 4294967296;
  return lerp(lerp(n00, n10, u), lerp(n01, n11, u), v);
}

/**
 * A bounded cache with least-recently-used eviction.
 *
 * A Map iterates in insertion order, so re-inserting an entry on read moves it
 * to the back and makes the first key the least recently used. That is all an
 * LRU needs, and it keeps every operation O(1).
 */
export function createLruCache(limit) {
  const entries = new Map();
  return {
    get(key) {
      const hit = entries.get(key);
      if (hit === undefined) return undefined;
      entries.delete(key);
      entries.set(key, hit);
      return hit;
    },
    set(key, value) {
      if (entries.has(key)) entries.delete(key);
      entries.set(key, value);
      if (entries.size > limit) entries.delete(entries.keys().next().value);
      return value;
    },
    has(key) { return entries.has(key); },
    clear() { entries.clear(); },
    get size() { return entries.size; },
    get limit() { return limit; },
  };
}

/** 12,345 -> "12,345" */
export const commas = (n) => Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** -4200 -> "-$4,200" */
export function money(n) {
  const sign = n < 0 ? '-' : '';
  return `${sign}$${commas(Math.abs(n))}`;
}
