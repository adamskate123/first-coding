/**
 * Render smoke test.
 *
 * The unit suite runs under plain `node --test` and never touches a canvas, so
 * nothing in it can catch a drawing fault. Two have now shipped that way:
 * multi-tile buildings painted over by their own ground tiles, and a bridge
 * deck passed to drawRoad as a point after that function started taking a
 * quad -- which threw on every frame a bridge was visible and froze the game.
 *
 * So this builds a city containing every drawable thing, renders it at several
 * zooms, cycles every data overlay, and drives each tool over the map. It
 * fails on any page error, and on the animation loop dying.
 *
 * Run with `npm run test:render`. Needs Chromium via Playwright.
 */

import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
};

function serve() {
  const server = createServer(async (req, res) => {
    try {
      const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
      const path = join(ROOT, rel === '/' ? 'index.html' : rel);
      const body = await readFile(path);
      res.writeHead(200, { 'Content-Type': TYPES[extname(path)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

/** Fill a world with one of everything worth drawing. */
const BUILD_EVERYTHING = `
  const g = window.game;
  const { World } = await import('/src/world.js');
  const { Simulation } = await import('/src/sim/index.js');
  const { BUILDINGS, ERAS, START_YEAR } = await import('/src/config.js');

  g.world = new World(64, 2468);
  g.sim = new Simulation(g.world);
  g.renderer.world = g.world;
  const w = g.world;
  w.funds = 5000000;
  g.setSpeed(0);

  // A channel, so there is water to bridge and a shoreline to bank.
  for (let y = 0; y < 64; y++) {
    for (let x = 28; x <= 32; x++) { w.terrain[w.idx(x, y)] = 0; w.elevation[w.idx(x, y)] = 7; }
  }
  w._corners = null; w._waterDist = null;

  // Street bridge, avenue bridge, and a power crossing over the same channel.
  for (let x = 12; x <= 50; x++) w.road[w.idx(x, 20)] = 1;
  for (let x = 12; x <= 50; x++) w.road[w.idx(x, 30)] = 2;
  for (let x = 12; x <= 50; x++) w.powerLine[w.idx(x, 25)] = 1;

  // Every zone, at every level, wealth tier and era they can take.
  let placed = 0;
  for (let zone = 1; zone <= 6; zone++) {
    for (let level = 1; level <= 4; level++) {
      for (let tier = 0; tier <= 2; tier++) {
        for (let era = 0; era < ERAS.length; era++) {
          const x = 2 + (placed % 24);
          const y = 36 + Math.floor(placed / 24);
          placed++;
          if (!w.inBounds(x, y) || w.terrain[w.idx(x, y)] === 0) continue;
          const i = w.idx(x, y);
          w.zone[i] = zone; w.level[i] = level; w.wealth[i] = tier;
          w.builtAge[i] = ERAS[era].from + 5 - START_YEAR;
        }
      }
    }
  }
  // Undeveloped zoning too, so the zone tints and the no-road marker draw.
  for (let x = 40; x < 50; x++) for (let y = 5; y < 12; y++) w.zone[w.idx(x, y)] = 2;

  // One of every catalogue building. Scan for somewhere each will actually
  // fit rather than marching along a line -- every sprite needs drawing, so a
  // type that quietly failed to place would go untested.
  const missing = [];
  for (const type of Object.keys(BUILDINGS)) {
    let done = false;
    for (let y = 2; y < 16 && !done; y += 1) {
      for (let x = 2; x < 60 && !done; x += 1) done = w.placeBuilding(type, x, y);
    }
    if (!done) missing.push(type);
  }

  w.powered.fill(1);
  for (const b of w.buildings) b.powered = true;
  g.sim.topologyDirty = true;
  for (let t = 0; t < 60; t++) g.sim.step();
  g.setSpeed(0);
  return { zonedLots: placed, buildings: w.buildings.length, missing };
`;

const OVERLAYS = ['none', 'landvalue', 'pollution', 'crime', 'traffic', 'power',
                  'police', 'fire', 'health', 'education', 'park'];

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  const errors = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });

  const fail = (why) => { console.error(`FAIL  ${why}`); process.exitCode = 1; };
  const ok = (what) => console.log(`ok    ${what}`);

  await page.goto(`${base}/index.html`, { waitUntil: 'networkidle' });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  ok('the game boots');

  const built = await page.evaluate(`(async () => { ${BUILD_EVERYTHING} })()`);
  if (built.missing.length) fail(`could not place: ${built.missing.join(', ')} -- their sprites go untested`);
  else ok(`scene built: ${built.zonedLots} zoned lots, ${built.buildings} buildings, every type placed`);

  for (const zoom of [0.4, 1, 1.8, 2.6]) {
    await page.evaluate((z) => {
      const g = window.game;
      g.camera.centerOn(30, 25);
      g.camera.zoom = z;
      g.renderer.markDirty();
      g.renderer.render();
    }, zoom);
    ok(`renders at zoom ${zoom}`);
  }

  for (const overlay of OVERLAYS) {
    await page.evaluate((o) => {
      const g = window.game;
      g.renderer.overlay = o;
      g.renderer.markDirty();
      g.renderer.render();
    }, overlay);
    ok(`renders the ${overlay} overlay`);
  }
  await page.evaluate(() => { window.game.renderer.overlay = 'none'; });

  // Drive every tool across the map, including over water, so previews draw.
  const tools = await page.evaluate(() => Array.from(
    document.querySelectorAll('#tool-groups .tool-btn'), (b) => b.dataset.tool));
  for (const tool of tools) {
    await page.evaluate((t) => {
      const btn = document.querySelector(`#tool-groups .tool-btn[data-tool="${t}"]`);
      if (btn) btn.click();
    }, tool);
    await page.mouse.move(500, 340);
    await page.mouse.down();
    await page.mouse.move(820, 470, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(25);
  }
  ok(`drove ${tools.length} tools across the map`);

  // The loop must still be running after all that.
  await page.evaluate(() => { window.game.setSpeed(3); window.__t0 = window.game.world.tick; });
  await page.waitForTimeout(900);
  const alive = await page.evaluate(() => ({ t0: window.__t0, now: window.game.world.tick }));
  if (alive.now <= alive.t0) fail(`the animation loop stopped (tick stuck at ${alive.t0})`);
  else ok(`the loop is alive (tick ${alive.t0} -> ${alive.now})`);

  // And a reload must resume what was built.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  const resumed = await page.evaluate(() => window.game.world.buildings.length);
  if (resumed !== built.buildings) fail(`reload lost the city (${resumed} of ${built.buildings} buildings)`);
  else ok('a reload resumes the city');

  if (errors.length) {
    fail(`${errors.length} page error(s):`);
    for (const e of [...new Set(errors)].slice(0, 10)) console.error(`      ${e}`);
  } else {
    ok('no page errors');
  }

  await browser.close();
  server.close();
  console.log(process.exitCode ? '\nrender smoke test FAILED' : '\nrender smoke test passed');
}

main();
