# Metropolis

A city-building simulator that runs in the browser. It aims for the
presentation of *SimCity 3000* — warm isometric pixel art, a dense readable
interface, one city on one map — over a simulation built along the lines of
*Cities: Skylines*: layered systems that interact, rather than a single
growth curve.

Sandbox only. No campaigns, no scenarios, no win condition.

Current version **0.11.0**, shown in the title bar. `VERSION` in
`src/config.js` is the single source of truth — `package.json` carries the same
number for tooling and a test asserts the two agree. Minor versions track
feature releases; saves record the version that wrote them, though
compatibility is decided by the save `format`, not the version, so an older
build's city still loads.

## Running it

The game is plain ES modules with no build step and no dependencies, but
browsers refuse to load modules over `file://`, so it needs a local server:

```bash
python3 -m http.server 8000     # or: npm start
```

Then open <http://localhost:8000>. Any static file server works.

## Playing

Lay some **street**, zone beside it, then connect **power**. Nothing develops
without all three: road access, power, and demand.

To cross water, drag a road or power line from one bank to the other in a
single gesture — a span has to reach both banks, so you cannot leave a pier
stranded mid-river. Crossings cost eight times ordinary road and four times as
much to maintain, which makes *where* you put them a real decision.

| | |
|---|---|
| Left click / drag | Use the selected tool. Zones drag as a rectangle; roads and power lines follow an L-shaped run |
| Right click / middle drag / space+drag | Pan |
| Scroll | Zoom |
| `0` `1` `2` `3` | Speed: paused, slow, normal, fast |
| `B` | Bulldoze |
| `G` | Toggle the tile grid |
| `V` | Show or hide the traffic |
| `Esc` | Cancel the current drag |

The **Data view** dropdown overlays land value, pollution, crime, traffic, the
power grid, and each service's coverage. **Cars** turns the moving traffic on
and off.

When a new version has been deployed, a banner says so and offers a reload;
taking it writes the city out first, so nothing laid since the last autosave is
lost. Nothing reloads on its own — dropping a city mid-placement to pick up a
cosmetic change would be worse than the staleness it fixes. **Budget** sets tax rates separately
for residential, commercial and industrial.

## Staying current, and working offline

GitHub Pages serves everything with `Cache-Control: max-age=600`, so a deploy
does not reach an open tab, and often does not reach a reload either — each
module expires on its own stagger. Measured against a server sending that exact
header: a reload after a deploy served the **old** build, and a plain fetch of
the version manifest still reported the old version.

Two pieces fix it, and each was measured against the same header:

- **A service worker** (`sw.js`) fetches everything for this origin with the
  HTTP cache stepped over (`cache: 'no-store'`) and keeps what comes back only
  as a fallback for when the network is gone. Same experiment, with it in
  charge: the reload served the **new** build. It is registered with the version
  in its URL, so a release is a new script to the browser rather than something
  it might get round to noticing.
- **An update notice.** The page fetches `version.json` past the cache — the one
  request that must not be cached, since `no-store` is the difference between
  reporting the old version forever and seeing the deploy at once — every five
  minutes and whenever the tab comes back to the front. If the deployed version
  is not the one running, the banner appears.

The fallback cache means the city is playable with no network at all, which the
old arrangement never was. The first visit after the worker installs still comes
from the HTTP cache; every load after that does not.

If the worker ever needs to be cleared out, this in the browser console does it:

```js
navigator.serviceWorker.getRegistrations().then((rs) => rs.forEach((r) => r.unregister()));
```

## How the simulation works

Systems run at different cadences — occupancy every tick, the diffusion fields
every fifth, the traffic sweep every tenth — so the frame cost stays flat
instead of spiking whenever a slow system comes due.

**Power** is not a global pool. Tiles conduct to their orthogonal neighbours,
so the map partitions into independent networks and each balances its own
supply against its own demand. A district wired to nothing browns out while a
plant across town sits idle. Zoned land conducts whether or not anything stands
on it yet, so wiring the edge of a district serves all of it — a lot with
nothing on it draws nothing, so this cannot let a network carry load it has not
accounted for.

**Traffic** routes aggregate commuter flow rather than individual cars. A
multi-source breadth-first sweep builds a distance-to-work field over the road
graph, and every populated tile walks downhill along it, depositing load on the
roads it crosses. Flow concentrates on the links that join districts, so a lone
arterial saturates while parallel routes sit empty — and congestion feeds back
into land value and pollution.

**The cars you can see** are driven off that field rather than replacing it.
Where they spawn is weighted by the traffic each tile carries, and they slow as
that tile approaches its capacity, so a jam looks like a jam — dense and
crawling — and a glance at a junction tells you which way the city commutes.
They carry nobody and are never saved; a reloaded city puts its own traffic back
within a second. Drawing them is the one thing that repaints without the city
having changed, so it is held to a share of the clock: thirty frames a second
where the scene is cheap to draw, slower where it is not, and nothing at all
while the game is paused.

**Land value** is the number the market consults. Amenity raises it
(waterfront, trees, parks, schools, safety); nuisance lowers it (pollution,
crime, gridlock, heavy industry next door). Each contribution is a field that
spreads spatially, then the whole thing is blurred so values grade across a
neighbourhood instead of snapping tile by tile.

**Growth** treats each zoned tile as a small market actor that checks whether it
is connected, powered, wanted, and whether local land value justifies the next
building up. Abandonment is deliberately far slower than growth and gated on a
die roll — an earlier symmetric version oscillated violently, with whole
commercial districts emptying and rebuilding on a cycle forever.

**Bridges** carry no state of their own: a road tile that sits on water *is* a
bridge, and a power line on water is a crossing. Only price, upkeep and how it
draws differ — the deck is stood on piers at the level of the banks it joins,
so the road spans across rather than dipping to the waterline and climbing
back. The
road network, traffic solver and power grid all treat a finished span as
ordinary road, so a bridge becomes a bottleneck exactly the way a real one
does.

**Relief** is sampled at tile *corners*, not tile centres. One height per tile
forces every tile to be a flat plate, so a gentle hill comes out as a staircase
with a vertical cliff at every step. Sampling at corners lets each tile be
drawn as a sloped quad, and because neighbouring tiles share their corners the
whole surface is watertight — no steps, no cliff faces between tiles, and no
cracks needing to be papered over. With those faces gone, relief is carried by
shading each quad according to its own gradient.

The one place a vertical face is still needed is the waterline: water is a flat
plane at sea level while the shore above it is not, so land drops a bank to
meet it. Anything standing on a tile — buildings, trees, roads, lot surfaces —
is anchored on the surface as drawn rather than on the plate the height map
nominally describes, so a road rides a slope instead of stepping down it.

Cursor picking reads the same `tileQuad` the renderer draws, and takes the
frontmost tile whose surface contains the pointer — so what you click is what
you see, including when a hill is drawn over the ground behind it.

**Terrain** blends an fBm height field with a radial shore falloff and a carved
river. The constants were tuned by sweeping them against explicit targets:
about a quarter of the map under water, land resolving into at most two
substantial banks rather than an archipelago, and dry ground at the centre
where the camera starts. Roughly half of all seeds produce a river that
genuinely splits the map — which is the point, now that you can bridge it.
`tests/terrain.test.js` asserts those properties across many seeds.

**Eras.** A lot records the year it was first built out and draws in that
period's style for as long as it stands — Edwardian, post-war, modern,
contemporary. Steep roofs, small punched windows and ornament early; flat
roofs, curtain walling and height late. The period is mixed *into* the wealth
palette rather than replacing it, so the two compose: a poor Edwardian terrace
and a rich one share a period but not a budget. Periods also bias only within a
zone's own vocabulary, so a contemporary *house* still has a pitched roof —
what goes flat in a modern city is the apartment blocks and offices.

A lot keeps its period as it grows, and only demolition resets the date.
Restamping on every level change was tried first and is wrong in practice:
measured on a city expanded in four waves across a century, continuous
improvement re-dated the entire standing stock into a single period and no
historical strata survived at all. The build year is also the one piece of
appearance that is authored history rather than derived state, so unlike every
other field it has to be written into the save.

**Wealth** is the biggest lever on a city's character. Land value is already
simulated per tile, so it costs almost nothing to let it choose a lot's whole
style family as well as its density: weathered boards and faded paint at the
bottom, tidy warm suburbia in the middle, brick and slate at the top, with
matching families for commerce and industry. Money also buys frontage, roof
pitch and ornament. Tiers are applied with hysteresis, so a district sitting on
a boundary does not flicker between two looks, and the thresholds are
calibrated against the land values a real city actually reaches rather than
against the theoretical range -- set naively, the top tier is unreachable and
no city ever grows an affluent quarter.

**Lots are furnished**, not dropped on bare grass: mown lawn and a drive for a
house, asphalt and bay markings for a shop, a concrete apron for a works. A
garden stops short of the road while commercial and industrial lots are paved
to the lot line, so neighbouring ones run together into a continuous surface
the way a trading estate does. The drive runs out to whichever neighbouring
tile carries the road.

**Shading is faked, cheaply.** Pre-rendered isometric sprites carry baked soft
shadowing, and its absence is most of why flat-filled volumes look like they
are hovering. Two approximations get most of the way: a gradient darkening the
foot of every wall, and a soft contact shadow on the ground. No canvas blur
filter is used -- support for it is patchy -- so the shadow is a few nested
shapes at low alpha.

**Building design** comes from a *recipe*: a pure function of a lot's variant
number and wealth tier that picks massing (a plain block, a twin, an L, a
setback, a podium and tower), roof form (hipped, gabled, flat), height, window
treatment (grid, ribbon, columns, sparse) and details like chimneys, roof tanks
and antennae.
Because it is pure and deterministic, a lot looks the same for the life of the
city without storing anything about how it was drawn -- and the variety is
*measurable*, so `tests/buildings.test.js` can assert that a street is not
forty copies of one house. Sixteen designs exist per zone type and level.

The recipe is also where coherence is enforced: setbacks never appear on
two-storey buildings, pitched roofs never land on towers, and height stays
within a jitter band of the level baseline so a building's size still reads as
its development stage.

**Facades are a grammar, not a grid.** A wall used to be a lattice: pick a
column count and a row count and stamp identical rectangles across the whole
thing. That reads as a barcode, and it was why sixteen variants of one zone
came out looking like one building drawn sixteen times — measured, the only
thing that differed between them was paint. A wall now *splits*: vertically
into a ground storey, a repeating shaft and a cap; horizontally into bays; and
each bay holds something the building's use calls for — a shopfront with a
stall riser and fascia, a door, a window with a frame and occasionally the
blinds down, a balcony, a louvre. Bay rhythm, storey height, cornice depth and
detailing all vary per building and shift with wealth and period, so a rich
building has a deeper cornice and a modern one has almost none.

Everything in `facade.js` is pure geometry in pixels, with no canvas and no
colour, which is what makes the dimensional faults testable: openings that
overflow their bay, bands that do not add up to the wall, and the one that
actually happened — sizing bays by tile span rather than by pixels, so a
cottage covering most of a tile but only twenty-five pixels of wall got a
single window the size of a garage door. It rendered perfectly and looked
ridiculous.

All building art is drawn procedurally as isometric volumes at load time and
cached, so there are no image assets in the repository. The cache key is zone
type x level x variant x wealth x era x lit — over ten thousand combinations —
so it is held in a bounded LRU rather than a plain map.

## Layout

```
index.html          shell and UI chrome
styles.css          interface styling
sw.js               service worker: freshness, and offline play
version.json        the deployed version, polled by the update notice
src/
  config.js         every balance and presentation constant
  world.js          tile state (struct-of-arrays) and terrain generation
  iso.js            projection, camera, cursor picking
  tools.js          build tools and pointer handling
  save.js           serialisation
  update.js         noticing that a new version has been deployed
  sim/
    index.js        tick orchestration
    networks.js     road access and the power grid
    fields.js       coverage, pollution, crime, land value
    traffic.js      commuter flow
    vehicles.js     the cars you can see driving
    demand.js       RCI demand
    growth.js       zone development and abandonment
    economy.js      budget and civic approval
  render/
    renderer.js     the isometric renderer
    sprites.js      procedural building art
    facade.js       the split grammar that organises a wall
    palette.js      colour
  ui/index.js       toolbar, readouts, inspector, advisors
tests/              node --test, no DOM required
```

## Tests

```bash
npm test            # node --test tests/*.test.js
```

151 tests covering the headless half of the game — everything under `src/sim`
plus the world model, projection maths, build tools and save format. They
include regression tests for each bug found so far: the power model energising
ungrounded wire, the growth oscillation, multi-tile buildings being repainted
by their own ground tiles, and advisors repeating themselves forever.

`tests/bridges.test.js` drives the real `ToolController` against a stub game
object, so span placement, pricing and refusal are tested through the same code
path the mouse uses. `tests/buildings.test.js` tests appearance without a
canvas, by checking the recipes rather than the pixels -- including that the
three wealth tiers really do produce different buildings, and that all three
are reachable from land values a city actually produces. `tests/eras.test.js`
covers build years being recorded, kept and saved, and the LRU cache's
eviction. `tests/terrain.test.js` asserts the relief invariant that makes the
surface watertight: neighbouring tiles must agree exactly on the corners they
share.

## Saving

**The city saves itself.** It writes to browser storage every 30 seconds while
you play, whenever the page is hidden or closed, and on demand from **Save** —
and it resumes automatically when you come back, camera included. Losing a city
to a reload was the previous behaviour and it was simply wrong.

The other buttons:

| | |
|---|---|
| **Save** | Write it out now rather than waiting for the next autosave |
| **Revert** | Throw away changes since the last save and reload the stored city |
| **Export** | Download the city as a file you can keep |
| **Import** | Load a city from a file |
| **New city** | Start over — this replaces the saved city, so export first if you want it |

Export exists because browser storage is **per browser and per site**: a city
played at `localhost` is not the city played on the deployed page, and clearing
site data takes it with it. A file is the only real backup.

Only authored state is stored — terrain, what you zoned and built, how far each
lot developed, and the year each was built. Every derived field is recomputed on
load, which keeps a save small and lets old saves survive changes to the balance
tables. Compatibility is decided by the save `format`, not the game version, so
a city written by an older build still loads. A save that cannot be read at all
is discarded and a new city started, rather than leaving you on a blank screen.

## Known rough edges

- No tunnels yet, so hills must be gone around rather than through.
- A century of game time is a long session at present pacing, so a single city
  will usually span one or two architectural periods rather than all four.
- Avenues carry more traffic than streets but draw at the same width.
- Lots are one tile, so there are no large footprint buildings in the zones --
  only service buildings span more than a tile.
- Data overlays draw over buildings rather than flattening the city, so a
  dense district reads as muddy under an overlay.
- Terrain cannot be edited; there is no landscaping tool.
- Multi-tile service buildings sit at the average height of their footprint, so
  on a steep slope one corner still rides slightly high.
- No day/night cycle, weather, or seasons.

## Roadmap

- [x] **Bridges** — roads and power lines across water, priced as structures
      and laid bank to bank. Rivers now run the full length of the map.
- [x] **Wealth tiers, furnished lots and faked ambient occlusion** — land
      value now drives building style, lots carry drives and forecourts, and
      contact shadowing grounds the volumes.
- [x] **Era styles** — cities start in 1900 and buildings keep the period they
      went up in, so a city accumulates visible history.
- [x] **Smooth relief** — terrain is sampled at tile corners and drawn as a
      continuous sloped surface instead of stepped plates.
- [ ] **Tunnels**, so hills can be crossed as well as rivers.
- [ ] **Water and sewage** as a second utility network, reusing the power
      model's per-network balancing.
- [ ] **Public transit** — bus routes and rail, sharing the commuter-flow
      solver that already exists.
- [ ] **Districts and policies**: paint an area, apply rules to it.
- [x] **Moving traffic** — a few hundred cars driven off the traffic field,
      spawned where the load is and slowed where it saturates.
- [ ] **Individual agent simulation** to replace aggregate commuter flow, so
      citizens have homes, jobs and journeys you can follow. The visible cars
      are a read-out of the aggregate model, not that.
- [ ] **Graphs and history**, using the monthly snapshots already recorded.
- [ ] **Larger maps with chunked terrain caching**, once redraw cost justifies
      it.
- [ ] **An offline sprite pipeline**, if the art should go beyond what can be
      drawn at runtime. This is how SimCity 3000 did it, and it would mean
      binary assets and a build step — a change in what the project is.
