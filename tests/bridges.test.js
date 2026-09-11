/**
 * Bridges and water crossings.
 *
 * A bridge carries no state of its own -- it is simply a road tile that sits on
 * water -- so these tests check the three things that actually distinguish one:
 * it may only be laid bank to bank, it is priced and maintained as a structure,
 * and the road network treats it as ordinary road once it is standing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { World } from '../src/world.js';
import { T, Z, ROAD, ROAD_INFO, BRIDGE_COST_MULTIPLIER, BRIDGE_UPKEEP_MULTIPLIER,
         POWERLINE_COST, POWERLINE_CROSSING_MULTIPLIER, SEA_LEVEL,
         BRIDGE_CLEARANCE } from '../src/config.js';
import { ToolController, TOOL } from '../src/tools.js';
import { updateRoadAccess, updatePower, updateBridgeDecks } from '../src/sim/networks.js';
import { updateTraffic } from '../src/sim/traffic.js';
import { monthlyBudget } from '../src/sim/economy.js';

/**
 * A map split by a north-south channel: dry land either side, water in the
 * middle columns. Bank to bank is a four-tile span.
 */
function channelWorld(size = 30) {
  const w = new World(size, 99);
  w.terrain.fill(T.GRASS);
  w.elevation.fill(12);
  w.tree.fill(0);
  for (let y = 0; y < size; y++) {
    for (let x = 13; x <= 16; x++) {
      const i = w.idx(x, y);
      w.terrain[i] = T.WATER;
      w.elevation[i] = 7;
    }
  }
  w._waterDist = null;
  w.funds = 200000;
  return w;
}

/** The minimum surface ToolController touches, so it can run without a DOM. */
function fakeGame(world) {
  const game = {
    world,
    toasts: [],
    renderer: { preview: [], previewValid: true, hover: null, markDirty() {} },
    sim: { topologyDirty: false },
    ui: { refresh() {} },
    toast(msg) { game.toasts.push(msg); },
  };
  return game;
}

/** Drag a road from a to b with the given tool. */
function dragRoad(game, kind, a, b) {
  const tools = new ToolController(game);
  tools.select(`road:${kind}`, kind);
  tools.onPointerDown(a);
  tools.onPointerMove(b);
  tools.onPointerUp(b);
  return tools;
}

// ------------------------------------------------------------- placement --

test('a span laid bank to bank crosses the water', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 20, y: 15 });

  for (let x = 10; x <= 20; x++) {
    assert.equal(w.road[w.idx(x, 15)], ROAD.STREET, `no road at x=${x}`);
  }
  assert.equal(w.isBridge(14, 15), true, 'the tiles over water are bridge');
  assert.equal(w.isBridge(10, 15), false, 'the tiles on land are not');
});

test('a run that starts in the water is refused', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 14, y: 15 }, { x: 20, y: 15 });

  assert.equal(w.road[w.idx(14, 15)], ROAD.NONE, 'nothing was built');
  assert.match(game.toasts.join(' '), /both banks/i);
});

test('a run that stops in the water is refused', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 15, y: 15 });
  assert.equal(w.road[w.idx(15, 15)], ROAD.NONE);
});

test('an existing span can be extended from its own deck', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 20, y: 15 });

  // Widen the crossing by one row, anchoring on the deck already standing.
  w.road[w.idx(13, 16)] = ROAD.STREET;              // a toe-hold on the water
  const tools = new ToolController(game);
  tools.select('road:STREET', 'STREET');
  tools.onPointerDown({ x: 13, y: 16 });
  tools.onPointerMove({ x: 20, y: 16 });
  tools.onPointerUp({ x: 20, y: 16 });

  assert.equal(w.road[w.idx(16, 16)], ROAD.STREET, 'the extension was built');
});

test('road on dry land is unaffected by the crossing rule', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 2, y: 4 }, { x: 8, y: 4 });
  assert.equal(w.road[w.idx(5, 4)], ROAD.STREET);
});

// ------------------------------------------------------------------ cost --

test('a bridge tile is priced as a structure, not as road', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  const tools = new ToolController(game);
  tools.select('road:STREET', 'STREET');

  const onLand = tools.costOf([{ x: 2, y: 4 }]);
  const onWater = tools.costOf([{ x: 14, y: 4 }]);
  assert.equal(onLand, ROAD_INFO[ROAD.STREET].cost);
  assert.equal(onWater, ROAD_INFO[ROAD.STREET].cost * BRIDGE_COST_MULTIPLIER);
});

test('a power crossing is priced above ordinary line', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  const tools = new ToolController(game);
  tools.select(TOOL.POWERLINE);
  assert.equal(tools.costOf([{ x: 2, y: 4 }]), POWERLINE_COST);
  assert.equal(tools.costOf([{ x: 14, y: 4 }]), POWERLINE_COST * POWERLINE_CROSSING_MULTIPLIER);
});

test('building a crossing actually debits the treasury', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  const before = w.funds;
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 20, y: 15 });
  assert.ok(w.funds < before, 'the span was paid for');
});

test('a bridge costs more to maintain than the same road on soil', () => {
  const bridged = channelWorld();
  for (let x = 13; x <= 16; x++) bridged.road[bridged.idx(x, 15)] = ROAD.STREET;
  monthlyBudget(bridged);

  const paved = channelWorld();
  for (let x = 2; x <= 5; x++) paved.road[paved.idx(x, 15)] = ROAD.STREET;
  monthlyBudget(paved);

  assert.equal(
    Math.round(bridged.stats.breakdown.roadCost * 100),
    Math.round(paved.stats.breakdown.roadCost * BRIDGE_UPKEEP_MULTIPLIER * 100),
  );
});

// --------------------------------------------------------- the network ----

test('road access reaches across a completed span', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 20, y: 15 });
  updateRoadAccess(w);
  assert.equal(w.roadAccess[w.idx(18, 16)], 1, 'the far bank is served');
});

test('commuters cross the bridge to reach work on the far bank', () => {
  // This is the whole point of the feature: without a span the two banks are
  // separate cities, and with one the commute concentrates on it.
  const w = channelWorld();
  const game = fakeGame(w);

  for (let y = 14; y <= 16; y++) for (let x = 6; x <= 12; x++) w.road[w.idx(x, y)] = ROAD.STREET;
  for (let y = 14; y <= 16; y++) for (let x = 17; x <= 24; x++) w.road[w.idx(x, y)] = ROAD.STREET;
  for (let x = 6; x <= 12; x++) {
    const i = w.idx(x, 13);
    w.zone[i] = Z.R_HIGH; w.level[i] = 2; w.pop[i] = 60;
  }
  for (let x = 17; x <= 24; x++) {
    const i = w.idx(x, 17);
    w.zone[i] = Z.I_LIGHT; w.level[i] = 2; w.jobs[i] = 20;
  }

  updateTraffic(w);
  assert.equal(w.traffic[w.idx(14, 15)], 0, 'no traffic before the span exists');

  dragRoad(game, 'STREET', { x: 12, y: 15 }, { x: 17, y: 15 });
  updateTraffic(w);
  assert.ok(w.traffic[w.idx(14, 15)] > 0, 'the span now carries the commute');
});

test('power crosses water on a line and lights the far bank', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  w.placeBuilding('coal', 4, 14);

  const tools = new ToolController(game);
  tools.select(TOOL.POWERLINE);
  tools.onPointerDown({ x: 7, y: 15 });
  tools.onPointerMove({ x: 22, y: 15 });
  tools.onPointerUp({ x: 22, y: 15 });

  const i = w.idx(22, 15);
  w.zone[i] = Z.R_LOW;
  w.level[i] = 1;
  updatePower(w);

  assert.equal(w.powerLine[w.idx(14, 15)], 1, 'the line spans the channel');
  assert.equal(w.powered[i], 1, 'the far bank is energised');
});

// -------------------------------------------------------------- removal --

test('bulldozing a span leaves open water behind', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 20, y: 15 });
  assert.equal(w.isBridge(14, 15), true);

  w.clearTile(14, 15);
  assert.equal(w.road[w.idx(14, 15)], ROAD.NONE);
  assert.equal(w.terrain[w.idx(14, 15)], T.WATER, 'the water is still there');
  assert.equal(w.isBridge(14, 15), false);
});

test('water still refuses zoning and buildings', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 20, y: 15 });

  assert.equal(w.isBuildable(14, 16), false, 'no building on open water');
  assert.equal(w.placeBuilding('police', 13, 18), false);

  const tools = new ToolController(game);
  tools.select('zone:R_LOW', 'R_LOW');
  tools.applyTiles([{ x: 14, y: 16 }]);
  assert.equal(w.zone[w.idx(14, 16)], Z.NONE, 'no zoning on water');
});

// ------------------------------------------------------- deck elevation ---

test('a span sits at the level of the banks it joins', () => {
  // A fixed lift above the water made the road dip down to cross and climb
  // back, which is wrong nearly everywhere since banks stand above the
  // waterline by more than the clearance.
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 20, y: 15 });
  updateBridgeDecks(w);

  const bank = w.tileHeight(10, 15);
  for (let x = 13; x <= 16; x++) {
    assert.ok(Math.abs(w.deckHeight[w.idx(x, 15)] - bank) < 1e-6,
      `deck at x=${x} sits at ${w.deckHeight[w.idx(x, 15)]}, the bank at ${bank}`);
  }
});

test('a deck is level along its whole span', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 20, y: 15 });
  updateBridgeDecks(w);

  const heights = new Set();
  for (let x = 13; x <= 16; x++) heights.add(w.deckHeight[w.idx(x, 15)]);
  assert.equal(heights.size, 1, `the deck steps: ${[...heights].join(', ')}`);
});

test('where the banks differ the deck takes the higher one', () => {
  // Never below either approach, so a crossing is never a dip.
  const w = channelWorld();
  for (let y = 0; y < w.size; y++) {
    for (let x = 17; x < w.size; x++) w.elevation[w.idx(x, y)] = 20;   // raise the east bank
  }
  w._corners = null;
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 22, y: 15 });
  updateBridgeDecks(w);

  const west = w.tileHeight(10, 15), east = w.tileHeight(22, 15);
  assert.ok(east > west, 'the test did not actually raise one bank');
  assert.ok(w.deckHeight[w.idx(14, 15)] >= east - 1e-6, 'the deck dropped below the higher bank');
});

test('a deck never sits lower than its clearance above the water', () => {
  const w = channelWorld();
  // Drop both banks to just above the waterline.
  for (let y = 0; y < w.size; y++) {
    for (let x = 0; x < w.size; x++) {
      if (w.terrain[w.idx(x, y)] !== T.WATER) w.elevation[w.idx(x, y)] = SEA_LEVEL + 1;
    }
  }
  w._corners = null;
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 20, y: 15 });
  updateBridgeDecks(w);

  assert.ok(w.deckHeight[w.idx(14, 15)] >= SEA_LEVEL + BRIDGE_CLEARANCE - 1e-6,
    'the deck came down below its clearance');
});

test('two separate spans get their own heights', () => {
  const w = channelWorld();
  for (let y = 0; y < w.size; y++) {
    for (let x = 17; x < w.size; x++) w.elevation[w.idx(x, y)] = 22;
  }
  w._corners = null;
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 8 }, { x: 22, y: 8 });      // crosses to the high bank
  dragRoad(game, 'STREET', { x: 10, y: 20 }, { x: 12, y: 20 });    // stays on the low bank
  // A second crossing, low bank to low bank only, by bridging a lone column.
  updateBridgeDecks(w);

  const crossing = w.deckHeight[w.idx(14, 8)];
  assert.ok(crossing > SEA_LEVEL + BRIDGE_CLEARANCE, 'the crossing did not take the bank height');
  assert.equal(w.deckHeight[w.idx(14, 20)], 0, 'a tile with no span has no deck height');
});

test('land tiles never get a deck height', () => {
  const w = channelWorld();
  const game = fakeGame(w);
  dragRoad(game, 'STREET', { x: 10, y: 15 }, { x: 20, y: 15 });
  updateBridgeDecks(w);
  assert.equal(w.deckHeight[w.idx(10, 15)], 0, 'road on dry land was given a deck');
  assert.equal(w.deckHeight[w.idx(5, 5)], 0);
});
