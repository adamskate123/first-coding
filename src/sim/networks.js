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

import { ROAD_REACH, BUILDINGS, BUILDING_POWER, ZONE_INFO, Z, T, SEA_LEVEL, BRIDGE_CLEARANCE } from '../config.js';

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

/**
 * How high each bridge deck sits.
 *
 * A span takes the level of the banks it joins rather than a fixed lift above
 * the water, so the road crosses straight over instead of dipping down and
 * climbing back. Every tile in a span shares one height, because a deck is
 * level; where the two banks differ the higher one wins, so the crossing never
 * drops below either approach.
 *
 * Derived from roads and terrain, so it is recomputed whenever the player
 * changes either, alongside road access.
 */
const APPROACH_REACH = 3;

/**
 * The level of the road leading up to a crossing.
 *
 * Not simply the tile at the water's edge: corner smoothing already drags the
 * shoreline down towards the waterline, so matching it would leave the road
 * descending the bank before it ever reached the deck. Walking a few tiles
 * inland along the road finds the level the road actually runs at.
 */
function approachHeight(world, start, reach) {
  const s = world.size;
  let best = world.tileHeight(start % s, (start / s) | 0);
  let frontier = [start];
  const seen = new Set([start]);

  for (let step = 0; step < reach; step++) {
    const next = [];
    for (const i of frontier) {
      const x = i % s, y = (i / s) | 0;
      const around = [
        x > 0 ? i - 1 : -1, x < s - 1 ? i + 1 : -1,
        y > 0 ? i - s : -1, y < s - 1 ? i + s : -1,
      ];
      for (const j of around) {
        if (j < 0 || seen.has(j)) continue;
        if (world.road[j] === 0 || world.terrain[j] === T.WATER) continue;
        seen.add(j);
        next.push(j);
        best = Math.max(best, world.tileHeight(j % s, (j / s) | 0));
      }
    }
    frontier = next;
  }
  return best;
}

export function updateBridgeDecks(world) {
  const s = world.size, n = s * s;
  const deck = world.deckHeight;
  const floor = SEA_LEVEL + BRIDGE_CLEARANCE;
  deck.fill(0);

  const onWater = (i) => world.road[i] !== 0 && world.terrain[i] === T.WATER;
  const seen = world._deckSeen && world._deckSeen.length === n ? world._deckSeen : (world._deckSeen = new Uint8Array(n));
  seen.fill(0);
  const stack = [];
  const span = [];

  for (let start = 0; start < n; start++) {
    if (seen[start] || !onWater(start)) continue;

    // Flood this span, noting the height of every road tile on dry land that
    // touches it -- those are its approaches.
    let height = floor;
    stack.length = 0;
    span.length = 0;
    stack.push(start);
    seen[start] = 1;
    const approaches = new Set();

    while (stack.length) {
      const i = stack.pop();
      span.push(i);
      const x = i % s, y = (i / s) | 0;
      const neighbours = [
        x > 0 ? i - 1 : -1, x < s - 1 ? i + 1 : -1,
        y > 0 ? i - s : -1, y < s - 1 ? i + s : -1,
      ];
      for (const j of neighbours) {
        if (j < 0) continue;
        if (onWater(j)) {
          if (!seen[j]) { seen[j] = 1; stack.push(j); }
        } else if (world.road[j] !== 0) {
          height = Math.max(height, approachHeight(world, j, APPROACH_REACH));
          approaches.add(j);
        }
      }
    }

    for (const i of span) deck[i] = height;
    // The road tile on each bank carries the deck too, as an abutment. Without
    // it the carriageway followed the shoreline down -- terrain smoothing pulls
    // the water's edge towards the waterline -- and the span appeared to start
    // in mid-air, with the road diving away beneath it.
    for (const i of approaches) deck[i] = Math.max(deck[i], height);
  }
}

/**
 * Does this tile carry power to its neighbours?
 *
 * Zoned land conducts whether or not anything stands on it yet. Only built
 * tiles used to, with vacant lots reached one step further by a dilation pass
 * -- which meant wiring the edge of a district powered exactly one row of it
 * and the rest read as dark, both on the map and in the overlay. Serviced land
 * is serviced land; a lot with nothing on it draws nothing, so this cannot let
 * a network carry load it has not accounted for.
 */
function conducts(world, i) {
  return world.powerLine[i] === 1
    || world.zone[i] !== Z.NONE
    || world.level[i] > 0
    || world.build[i] !== -1;
}

/**
 * Spend a short network's supply on as much of its load as it will cover.
 *
 * A grid one percent short used to black out everything on it, because a
 * network was either energised or it was not. Measured on a city that grew
 * into its supply, a 1.9% shortfall darkened 100% of the load, and since
 * losing power makes a lot decay immediately rather than on a die roll, the
 * whole city emptied, demand collapsed, the lights came back, and it rebuilt
 * -- a cycle that repeated for as long as it was left running.
 *
 * Real grids shed load; so does this now. Consumers are served in a fixed
 * order until the supply runs out, so the same districts stay dark rather than
 * flickering -- a consistently unserved quarter is something a player can see
 * in the power view and fix, where a city-wide strobe is only bewildering.
 * Returns the demand left unserved.
 */
function allocate(world, net) {
  let budget = net.supply;
  let unserved = 0;
  const counted = new Set();

  for (const i of net.tiles) {
    let draw = 0;
    const bIdx = world.build[i];
    if (bIdx !== -1) {
      if (counted.has(bIdx)) { world.powered[i] = world.powered[net.anchor.get(bIdx)] || 0; continue; }
      counted.add(bIdx);
      const b = world.buildings[bIdx];
      const spec = BUILDINGS[b.type];
      draw = spec.supply ? 0 : (BUILDING_POWER[b.type] || 0);
      net.anchor.set(bIdx, i);
    } else {
      const zi = ZONE_INFO[world.zone[i]];
      draw = zi && world.level[i] > 0 ? (zi.power[world.level[i]] || 0) : 0;
    }

    if (draw <= budget) {
      budget -= draw;
      world.powered[i] = 1;
    } else {
      unserved += draw;
    }
  }
  return unserved;
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
    const net = { id, supply: 0, demand: 0, tiles: [], anchor: new Map() };
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
    } else if (net.supply > 0) {
      unservedDemand += allocate(world, net);
    } else {
      unservedDemand += net.demand;
    }
  }

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
