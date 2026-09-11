/**
 * Commuter traffic.
 *
 * Rather than simulate individual vehicles, this routes aggregate commuter
 * flow: a multi-source breadth-first sweep over the road graph builds a
 * distance-to-work field, and every populated tile then walks *downhill* along
 * that field towards the nearest employment, depositing load on each road tile
 * it crosses.
 *
 * The emergent behaviour is what matters and it matches the real thing --
 * flow concentrates on the few links that connect districts, so a single
 * bridge or a lone arterial saturates while parallel routes sit empty.
 * Congestion then feeds back into land value and pollution, which is what
 * makes road layout a design problem instead of decoration.
 */

import { ROAD_INFO } from '../config.js';
import { clamp } from '../util.js';

const MAX_COMMUTE = 90;     // tiles; beyond this, workers give up
const UNREACHED = 65535;

export function updateTraffic(world) {
  const s = world.size, n = s * s;

  const dist = world._trafDist && world._trafDist.length === n ? world._trafDist : (world._trafDist = new Uint16Array(n));
  const queue = world._trafQueue && world._trafQueue.length === n ? world._trafQueue : (world._trafQueue = new Int32Array(n));
  const load = world._trafLoad && world._trafLoad.length === n ? world._trafLoad : (world._trafLoad = new Float32Array(n));
  dist.fill(UNREACHED);
  load.fill(0);

  // --- 1. seed the field at roads that touch a job ------------------------
  let head = 0, tail = 0;
  let totalJobs = 0;
  for (let i = 0; i < n; i++) {
    if (world.jobs[i] === 0) continue;
    totalJobs += world.jobs[i];
    const x = i % s, y = (i / s) | 0;
    // Any adjacent road becomes a destination for commuters.
    if (x > 0 && world.road[i - 1] && dist[i - 1] !== 0) { dist[i - 1] = 0; queue[tail++] = i - 1; }
    if (x < s - 1 && world.road[i + 1] && dist[i + 1] !== 0) { dist[i + 1] = 0; queue[tail++] = i + 1; }
    if (y > 0 && world.road[i - s] && dist[i - s] !== 0) { dist[i - s] = 0; queue[tail++] = i - s; }
    if (y < s - 1 && world.road[i + s] && dist[i + s] !== 0) { dist[i + s] = 0; queue[tail++] = i + s; }
  }

  // --- 2. breadth-first sweep across the road graph -----------------------
  while (head < tail) {
    const i = queue[head++];
    const d = dist[i];
    if (d >= MAX_COMMUTE) continue;
    const x = i % s, y = (i / s) | 0;
    const nd = d + 1;
    if (x > 0 && world.road[i - 1] && dist[i - 1] > nd) { dist[i - 1] = nd; queue[tail++] = i - 1; }
    if (x < s - 1 && world.road[i + 1] && dist[i + 1] > nd) { dist[i + 1] = nd; queue[tail++] = i + 1; }
    if (y > 0 && world.road[i - s] && dist[i - s] > nd) { dist[i - s] = nd; queue[tail++] = i - s; }
    if (y < s - 1 && world.road[i + s] && dist[i + s] > nd) { dist[i + s] = nd; queue[tail++] = i + s; }
  }

  // --- 3. push each home's commuters downhill to work ---------------------
  let reachedWorkers = 0, totalWorkers = 0;

  for (let i = 0; i < n; i++) {
    const people = world.pop[i];
    if (!people) continue;
    const commuters = people * 0.5;          // roughly half a household works
    totalWorkers += commuters;

    // Enter the network at the best-connected adjacent road tile.
    const x = i % s, y = (i / s) | 0;
    let cur = -1, best = UNREACHED;
    if (x > 0 && world.road[i - 1] && dist[i - 1] < best) { best = dist[i - 1]; cur = i - 1; }
    if (x < s - 1 && world.road[i + 1] && dist[i + 1] < best) { best = dist[i + 1]; cur = i + 1; }
    if (y > 0 && world.road[i - s] && dist[i - s] < best) { best = dist[i - s]; cur = i - s; }
    if (y < s - 1 && world.road[i + s] && dist[i + s] < best) { best = dist[i + s]; cur = i + s; }
    if (cur === -1 || best === UNREACHED) continue;

    reachedWorkers += commuters;

    // Walk strictly downhill. The BFS guarantees a descending neighbour exists
    // until we reach a source tile, so this terminates.
    let steps = 0;
    while (steps++ < MAX_COMMUTE) {
      load[cur] += commuters;
      const d = dist[cur];
      if (d === 0) break;
      const cx = cur % s, cy = (cur / s) | 0;
      let next = -1, nbest = d;
      if (cx > 0 && world.road[cur - 1] && dist[cur - 1] < nbest) { nbest = dist[cur - 1]; next = cur - 1; }
      if (cx < s - 1 && world.road[cur + 1] && dist[cur + 1] < nbest) { nbest = dist[cur + 1]; next = cur + 1; }
      if (cy > 0 && world.road[cur - s] && dist[cur - s] < nbest) { nbest = dist[cur - s]; next = cur - s; }
      if (cy < s - 1 && world.road[cur + s] && dist[cur + s] < nbest) { nbest = dist[cur + s]; next = cur + s; }
      if (next === -1) break;
      cur = next;
    }
  }

  // --- 4. ease towards the new load and derive congestion -----------------
  let congestionSum = 0, roadTiles = 0;
  for (let i = 0; i < n; i++) {
    if (!world.road[i]) { world.traffic[i] = 0; continue; }
    // Smooth over several updates so a single edit doesn't whipsaw the map.
    const eased = world.traffic[i] * 0.6 + load[i] * 0.4;
    world.traffic[i] = clamp(Math.round(eased), 0, 65535);
    congestionSum += Math.min(2, world.traffic[i] / ROAD_INFO[world.road[i]].capacity);
    roadTiles++;
  }

  // Roads are tinted by how loaded they are, so a change here changes the
  // picture and the renderer's cached layers have to be rebuilt.
  if (world.traffic.some((v, i) => v !== 0 && world.road[i])) world.touch();

  world.stats.congestion = roadTiles ? congestionSum / roadTiles : 0;
  world.stats.jobAccess = totalWorkers > 0 ? reachedWorkers / totalWorkers : 1;
  world.stats.totalJobSlots = totalJobs;
  world.trafficDist = dist;
}
