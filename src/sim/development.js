/**
 * How zoned land becomes a neighbourhood.
 *
 * Zoning a block used to make houses appear on it, each lot independently, as
 * soon as it was connected and powered. That is the least convincing thing the
 * game did: land does not become a suburb, it gets subdivided first, and then
 * built out plot by plot over years. A large zoned rectangle either developed
 * only round its rim -- everything further than ROAD_REACH from a road being
 * permanently unreachable -- or, if the player drew a grid fine enough, filled
 * in all at once.
 *
 * Two things happen here instead.
 *
 * Developers cut **lanes**: narrow roads laid one tile at a time from the
 * public road into whatever they hold that has no frontage yet. A lane is an
 * ordinary road type, so access, traffic, power reach, upkeep and the save
 * file all handle it without knowing it is special. The lanes form a tree
 * rooted in the city's own roads, which is what a real subdivision is, and
 * they persist: once a district is laid out, the layout is what later
 * buildings are rebuilt along.
 *
 * And every plot spends time as a **building site** before it is a building.
 * Growth no longer moves a lot up a level directly; it starts construction,
 * and construction runs through its stages first.
 */

import { Z, ZONE_INFO, ROAD, T, LANE_INTERVAL, LANES_PER_PASS,
         BUILD_STAGES, STAGE_CHANCE, onLaneGrid } from '../config.js';

/**
 * Advance every site under construction, and lay a little more lane.
 *
 * Both are rate-limited rather than run to completion: the point of this is
 * that a district arrives over years, so the interesting state -- half-laid
 * lanes, plots at different stages along them -- is the state it spends most
 * of its time in.
 */
export function updateDevelopment(world, rng) {
  advanceSites(world, rng);
  if (world.tick % LANE_INTERVAL === 0) layLanes(world, rng);
}

/**
 * Is this a plot a developer could cut a lane across?
 *
 * Not one with a building standing on it. A lane appearing under a finished
 * house is the one thing worse than no lane at all, and letting the network
 * path through developed land is how that happens.
 */
function developable(world, i) {
  return world.terrain[i] !== T.WATER && world.build[i] === -1 && world.level[i] === 0;
}

/**
 * Extend the lane network towards zoned land that has no frontage.
 *
 * One breadth-first sweep out from every road tile gives, for each plot, both
 * its distance from a road and the neighbour it was reached through. Walking
 * that chain back from a plot that wants frontage lands on the tile where the
 * network currently ends, and that is where the next stretch of lane goes.
 * Growing from the near end rather than the far one is what makes a
 * subdivision spread outward from the road instead of appearing in the middle
 * of a field.
 */
function layLanes(world, rng) {
  const s = world.size, n = s * s;
  const dist = world._laneDist && world._laneDist.length === n
    ? world._laneDist : (world._laneDist = new Int32Array(n));
  const from = world._laneFrom && world._laneFrom.length === n
    ? world._laneFrom : (world._laneFrom = new Int32Array(n));
  const queue = world._laneQueue && world._laneQueue.length === n
    ? world._laneQueue : (world._laneQueue = new Int32Array(n));

  // Breadth-first from every road, travelling only along the lattice, so the
  // route it finds is a route a lane could actually take.
  dist.fill(-1);
  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (world.road[i]) { dist[i] = 0; from[i] = -1; queue[tail++] = i; }
  }
  if (tail === 0) return;                 // no public road, nothing to grow from

  while (head < tail) {
    const i = queue[head++];
    const x = i % s, y = (i / s) | 0;
    const nd = dist[i] + 1;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
      const j = ny * s + nx;
      if (dist[j] !== -1 || !developable(world, j) || !onLaneGrid(nx, ny)) continue;
      dist[j] = nd;
      from[j] = i;
      queue[tail++] = j;
    }
  }

  // Where a lane would earn its place: a lattice tile, reachable, not already
  // road, and with plots behind it that a lane would bring into frontage.
  const candidates = [];
  for (let i = 0; i < n; i++) {
    if (dist[i] <= 0 || world.road[i]) continue;
    if (!serves(world, i)) continue;
    candidates.push(i);
  }
  if (!candidates.length) return;
  // Nearest first, so the network grows outward from the road in order rather
  // than sprouting in three places at once.
  candidates.sort((a, b) => dist[a] - dist[b] || a - b);

  let laid = 0;
  for (const target of candidates) {
    if (laid >= LANES_PER_PASS) break;
    // Walk back to the tile whose parent is already road: the far end of the
    // network, and so the next tile of lane.
    let at = target;
    while (from[at] !== -1 && dist[from[at]] > 0) at = from[at];
    if (world.road[at] || !developable(world, at)) continue;
    // Re-checked here rather than trusted from the sweep: a lane laid earlier
    // in this same pass may already have given these plots their frontage.
    if (!serves(world, at)) continue;
    world.road[at] = ROAD.LANE;
    world.stage[at] = 0;
    world.level[at] = 0;
    world.pop[at] = 0;
    world.jobs[at] = 0;
    world.growthTimer[at] = 0;
    world.touch();
    world.dirty = true;
    laid++;
    dist[at] = 0;
  }
}

/** Does this plot have a road immediately next to it to face? */
export function hasFrontage(world, i) {
  const s = world.size;
  const x = i % s, y = (i / s) | 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue;
    if (world.road[ny * s + nx]) return true;
  }
  return false;
}

/**
 * Would a lane here give frontage to anything worth building on?
 *
 * Frontage, not access. A plot within ROAD_REACH of a road can be built on,
 * but a building faces the street *next door* to it -- so a plot three tiles
 * from the nearest road has nothing to face, and a district full of them comes
 * out as houses backing onto each other at no angle in particular. Only the
 * four orthogonal neighbours count, which is why the lattice rows sit three
 * apart: lane, plot, plot, lane.
 *
 * Deliberately not conditioned on demand. It was, and that deadlocked: only
 * the plots already on the rim could develop, a handful of houses satisfied
 * the market, demand went negative, lane-laying stopped, and the plots that
 * would have carried the next wave of building could never get frontage to
 * be built on. Measured: 933 of 1,152 plots stranded with no street and a
 * district frozen at 96 houses. Developers lay out land when they buy it,
 * not plot by plot as buyers turn up, and the upkeep on a lane nobody builds
 * along is the honest cost of zoning ground you did not need.
 */
export function serves(world, i) {
  const s = world.size;
  const ax = i % s, ay = (i / s) | 0;
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = ax + dx, y = ay + dy;
    if (x < 0 || y < 0 || x >= s || y >= s) continue;
    const j = y * s + x;
    if (world.zone[j] === Z.NONE || world.road[j]) continue;
    if (hasFrontage(world, j)) continue;
    if (ZONE_INFO[world.zone[j]]) return true;
  }
  return false;
}

/**
 * Move every site under construction along.
 *
 * A site that loses its road or its power stops being a site: the work is
 * abandoned rather than paused, which keeps a half-built plot from sitting
 * there for a decade after the district around it failed.
 */
function advanceSites(world, rng) {
  const n = world.size * world.size;
  for (let i = 0; i < n; i++) {
    if (!world.stage[i]) continue;
    if (world.zone[i] === Z.NONE || !world.roadAccess[i] || !world.powered[i]) {
      world.stage[i] = 0;
      world.touch();
      continue;
    }
    if (rng() > STAGE_CHANCE) continue;
    if (world.stage[i] < BUILD_STAGES) {
      world.stage[i]++;
      world.touch();
      continue;
    }
    finish(world, i);
  }
}

/** Hand a finished building over: the site becomes the next level up. */
function finish(world, i) {
  const info = ZONE_INFO[world.zone[i]];
  const maxLevel = info ? info.cap.length - 1 : 0;
  const level = world.level[i];
  world.stage[i] = 0;
  if (level >= maxLevel) { world.touch(); return; }

  world.level[i] = level + 1;
  world.growthTimer[i] = 0;
  // A lot is stamped with its period when it is first built out, and keeps it
  // thereafter -- see the note in growth.js on why improvement does not
  // re-date a building.
  if (level === 0) world.recordBuild(i);
  world.touch();
  world.dirty = true;
}

/**
 * Is this plot being kept clear for a lane that has not been laid yet?
 *
 * The lattice has to be reserved, or the race is lost before it starts: plots
 * along the public road develop within a few ticks, and if one of them sits on
 * the lattice it severs the column the whole district behind it would have
 * been reached through -- leaving a block that can never be built out at all.
 * Reserving only while something still lacks frontage means that once a
 * district is fully served its remaining lattice plots are free to build like
 * any other.
 */
export function reservedForLane(world, i) {
  const s = world.size;
  if (world.road[i]) return false;
  if (!onLaneGrid(i % s, (i / s) | 0)) return false;
  return serves(world, i);
}

/** Whether a plot is mid-construction, for the renderer and for tests. */
export function isSite(world, i) {
  return world.stage[i] > 0;
}
