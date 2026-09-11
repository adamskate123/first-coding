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
  g.vehicles.reset(g.world);
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

  // Traffic has to populate from the traffic field, move, and be drawn on both
  // surfaces a road can take -- the ground and a bridge deck. It is also the
  // one thing that repaints on its own, so a fault in it would otherwise show
  // up as the whole game freezing.
  const cars = await page.evaluate(async () => {
    const g = window.game;
    const w = g.world;
    for (let i = 0; i < w.road.length; i++) if (w.road[i]) w.traffic[i] = 140;
    w.tick++;
    g.setSpeed(2);
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    await settle(800);

    const snapshot = () => g.vehicles.list
      .map((v) => `${v.i}:${v.t.toFixed(4)}`).sort().join('|');
    const before = snapshot();
    const onDeck = g.vehicles.list.filter((v) => w.deckHeight[v.i] > 0).length;
    await settle(400);
    const moved = snapshot() !== before;

    // Both drawing paths: the plain roof blob when zoomed out, the full body
    // with glazing when zoomed in.
    for (const z of [0.4, 1, 1.6, 2.4]) {
      g.camera.zoom = z;
      g.renderer.markDirty();
      g.renderer.render();
    }
    const drawn = g.renderer.carsByTile.size;

    g.ui.toggleVehicles();
    g.renderer.render();
    const hidden = g.renderer.carsByTile.size;
    g.ui.toggleVehicles();

    g.setSpeed(0);
    return { count: g.vehicles.list.length, moved, onDeck, drawn, hidden };
  });
  if (!cars.count) fail('no cars appeared on roads carrying traffic');
  else if (!cars.moved) fail(`${cars.count} cars appeared but none of them moved`);
  else if (!cars.onDeck) fail('no car ever drove onto a bridge deck');
  else if (!cars.drawn) fail('cars were simulated but never handed to the renderer');
  else if (cars.hidden) fail('cars were still drawn after being switched off');
  else ok(`${cars.count} cars driving, ${cars.onDeck} on bridges, over ${cars.drawn} tiles`);

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

  // The update notice: the real check against the real manifest, standing in a
  // version that cannot be the deployed one.
  const notice = await page.evaluate(async () => {
    const { UpdateWatch } = await import('/src/update.js');
    const watch = new UpdateWatch({
      version: '0.0.0-not-deployed',
      onReady: (v) => window.game.ui.showUpdate(v),
    });
    const fired = await watch.check();
    watch.stop();
    const banner = document.getElementById('update-banner');
    const shown = !banner.classList.contains('hidden');
    const text = document.getElementById('update-text').textContent;
    document.getElementById('update-later').click();
    return { fired, shown, text, dismissed: banner.classList.contains('hidden') };
  });
  if (!notice.fired) fail('the update check did not notice a different deployed version');
  else if (!notice.shown) fail('an update was found but no banner appeared');
  else if (!/\d+\.\d+\.\d+/.test(notice.text)) fail(`the banner does not name the version: "${notice.text}"`);
  else if (!notice.dismissed) fail('the banner cannot be dismissed');
  else ok(`the update notice appears and dismisses ("${notice.text}")`);

  // A check that finds the version it is already running must stay quiet.
  const quiet = await page.evaluate(async () => {
    const { UpdateWatch } = await import('/src/update.js');
    const { VERSION } = await import('/src/config.js');
    const watch = new UpdateWatch({ version: VERSION, onReady: () => window.game.ui.showUpdate('wrong') });
    const fired = await watch.check();
    watch.stop();
    return { fired, shown: !document.getElementById('update-banner').classList.contains('hidden') };
  });
  if (quiet.fired || quiet.shown) fail('the update banner fired on the version already running');
  else ok('no banner when the running version is the deployed one');

  // Taking the update saves the city first, then reloads onto the new build --
  // so this doubles as the check that a reload resumes what was built.
  await page.evaluate(() => window.game.ui.showUpdate('9.9.9'));
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'networkidle' }),
    page.click('#update-reload'),
  ]);
  await page.waitForTimeout(700);
  const resumed = await page.evaluate(() => window.game.world.buildings.length);
  if (resumed !== built.buildings) fail(`reload lost the city (${resumed} of ${built.buildings} buildings)`);
  else ok('taking the update saves the city and reloads it');

  // The service worker is what makes that reload land on the new build rather
  // than on whatever the browser had cached, so it has to be in charge.
  const worker = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration();
    return { controlled: !!navigator.serviceWorker.controller, script: reg && reg.active && reg.active.scriptURL };
  });
  if (!worker.controlled) fail('the service worker is not controlling the page');
  else if (!/sw\.js\?v=\d+\.\d+\.\d+/.test(worker.script || '')) fail(`the worker is registered without a version: ${worker.script}`);
  else ok('the service worker controls the page, versioned by release');

  // And with the network gone it should still deal the game out of its cache.
  await page.context().setOffline(true);
  let offlineBoot = null;
  try {
    await page.reload({ waitUntil: 'load' });
    await page.waitForTimeout(900);
    offlineBoot = await page.evaluate(() => !!(window.game && window.game.world));
  } catch (err) {
    offlineBoot = `threw: ${err.message.split('\n')[0]}`;
  }
  await page.context().setOffline(false);
  if (offlineBoot !== true) fail(`the game does not boot offline (${offlineBoot})`);
  else ok('the game still boots with the network gone');

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
