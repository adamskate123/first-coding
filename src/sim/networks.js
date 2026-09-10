/**
 * Connectivity: road access and the power grid.
 *
 * Power is deliberately *not* a single global pool. Tiles conduct power to
 * their orthogonal neighbours, so the map is partitioned into independent
 * networks and each one balances its own supply against its own demand. Wire a
 * new suburb to nothing and it browns out even while a plant across town idles
 * -- the same failure mode Cities: Skylines models, and the reason power lines
 * are worth thinking about at all.
 *
 * Both passes are flat loops over typed arrays with no per-iteration closures;
 * they run over every tile on the map several times a second.
 */

import { ROAD_REACH, BUILDINGS, BUILDING_POWER, ZONE_INFO } from '../config.js';

/**
 * Flood outwards from every road tile and mark tiles within ROAD_REACH.
 * Unreachable land can be zoned but will never develop.
 */
export function updateRoadAccess(world) {
  const s = world.size;
  const n = s * s;
  const dist = world._roadDist && world._roadDist.length === n ? world._roadDist : (world._roadDist = new Uint8Array(n));
  const queue = world._roadQueue && world._roadQueue.length === n ? world._roadQueue : (world._roadQueue = new Int32Array(n));
  dist.fill(255);

  let head = 0, tail = 0;
  for (let i = 0; i < n; i++) {
    if (world.road[i]) { dist[i] = 0; queue[tail++] = i; }
  }

  while (head < tail) {
    const i = queue[head++];
    const d = dist[i];
    if (d >= ROAD_REACH) continue;
    const x = i % s, y = (i / s) | 0;
    const nd = d + 1;
    if (x > 0 && dist[i - 1] > nd) { dist[i - 1] = nd; queue[tail++] = i - 1; }
    if (x < s - 1 && dist[i + 1] > nd) { dist[i + 1] = nd; queue[tail++] = i + 1; }
    if (y > 0 && dist[i - s] > nd) { dist[i - s] = nd; queue[tail++] = i - s; }
    if (y < s - 1 && dist[i + s] > nd) { dist[i + s] = nd; queue[tail++] = i + s; }
  }

  for (let i = 0; i < n; i++) world.roadAccess[i] = dist[i] <= ROAD_REACH ? 1 : 0;
  world.roadDist = dist;
}

/** Does this tile carry power to its neighbours? */
function conducts(world, i) {
  return world.powerLine[i] === 1 || world.level[i] > 0 || world.build[i] !== -1;
}

/**
 * Partition conductive tiles into networks, then balance each network.
 *
 * A network short of supply browns out: every consumer on it loses power, which
 * in turn stalls growth and eventually triggers abandonment.
 */
export function updatePower(world) {
  const s = world.size;
  const n = s * s;
  world.netId.fill(-1);
  world.powered.fill(0);

  const stack = world._powerStack && world._powerStack.length === n ? world._powerStack : (world._powerStack = new Int32Array(n));
  const nets = [];

  for (let start = 0; start < n; start++) {
    if (world.netId[start] !== -1 || !conducts(world, start)) continue;

    const id = nets.length;
    const net = { id, supply: 0, demand: 0, tiles: [] };
    nets.push(net);

    let sp = 0;
    stack[sp++] = start;
    world.netId[start] = id;

    while (sp > 0) {
      const i = stack[--sp];
      net.tiles.push(i);
      const x = i % s, y = (i / s) | 0;
      let j;
      if (x > 0) { j = i - 1; if (world.netId[j] === -1 && conducts(world, j)) { world.netId[j] = id; stack[sp++] = j; } }
      if (x < s - 1) { j = i + 1; if (world.netId[j] === -1 && conducts(world, j)) { world.netId[j] = id; stack[sp++] = j; } }
      if (y > 0) { j = i - s; if (world.netId[j] === -1 && conducts(world, j)) { world.netId[j] = id; stack[sp++] = j; } }
      if (y < s - 1) { j = i + s; if (world.netId[j] === -1 && conducts(world, j)) { world.netId[j] = id; stack[sp++] = j; } }
    }
  }

  // Tally supply and demand per network. A multi-tile building must only be
  // counted once, no matter how many of its tiles the flood fill visited.
  const seen = new Set();
  let totalSupply = 0, totalDemand = 0, unservedDemand = 0;

  for (const net of nets) {
    for (const i of net.tiles) {
      const bIdx = world.build[i];
      if (bIdx !== -1) {
        if (seen.has(bIdx)) continue;
        seen.add(bIdx);
        const b = world.buildings[bIdx];
        const spec = BUILDINGS[b.type];
        if (spec.supply) { if (b.on) net.supply += spec.supply; }
        else net.demand += BUILDING_POWER[b.type] || 0;
        continue;
      }
      const zi = ZONE_INFO[world.zone[i]];
      if (zi && world.level[i] > 0) net.demand += zi.power[world.level[i]] || 0;
    }
    totalSupply += net.supply;
    totalDemand += net.demand;

    // A network needs an actual generator on it. Without this check, a run of
    // power line with no plant attached would satisfy `supply >= demand` at
    // 0 >= 0 and silently energise everything hanging off it.
    net.energised = net.supply > 0 && net.supply >= net.demand;
    if (net.energised) {
      for (const i of net.tiles) world.powered[i] = 1;
    } else {
      unservedDemand += net.demand;
    }
  }

  // Power reaches a *vacant* lot from the lot next door. Without this, an
  // undeveloped tile conducts nothing, so it can never be powered, so it can
  // never develop -- and the player is forced to run a pylon onto every single
  // tile they zone. One dilation step reproduces the familiar behaviour: wire
  // the grid to the edge of a block and it builds out from there, each new
  // building carrying power to its own neighbours.
  //
  // Only level-0 tiles are dilated, and those draw no power, so this cannot
  // let a network serve load it has not accounted for.
  const reached = [];
  for (let i = 0; i < n; i++) {
    if (world.zone[i] === 0 || world.level[i] !== 0 || world.powered[i]) continue;
    const x = i % s, y = (i / s) | 0;
    if ((x > 0 && world.powered[i - 1]) ||
        (x < s - 1 && world.powered[i + 1]) ||
        (y > 0 && world.powered[i - s]) ||
        (y < s - 1 && world.powered[i + s])) {
      reached.push(i);
    }
  }
  for (const i of reached) world.powered[i] = 1;

  for (const b of world.activeBuildings()) {
    b.powered = world.powered[world.idx(b.x, b.y)] === 1;
  }

  world.networks = nets;
  world.stats.powerSupply = totalSupply;
  world.stats.powerDemand = totalDemand;

  // Report the *scale* of the shortfall, not merely that one exists. A single
  // unwired police station on the far side of town should not read as a
  // citywide blackout, because downstream systems (demand, approval) scale
  // their response by this figure.
  world.stats.unservedDemand = unservedDemand;
  world.stats.brownoutShare = totalDemand > 0 ? unservedDemand / totalDemand : 0;
  world.stats.brownout = world.stats.brownoutShare > 0.05;
}
