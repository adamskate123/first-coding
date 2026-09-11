# Metropolis

A city-building simulator that runs in the browser. It aims for the
presentation of *SimCity 3000* — warm isometric pixel art, a dense readable
interface, one city on one map — over a simulation built along the lines of
*Cities: Skylines*: layered systems that interact, rather than a single
growth curve.

Sandbox only. No campaigns, no scenarios, no win condition.

Current version **0.6.0**, shown in the title bar. `VERSION` in
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
| `Esc` | Cancel the current drag |

The **Data view** dropdown overlays land value, pollution, crime, traffic, the
power grid, and each service's coverage. **Budget** sets tax rates separately
for residential, commercial and industrial.

## How the simulation works

Systems run at different cadences — occupancy every tick, the diffusion fields
every fifth, the traffic sweep every tenth — so the frame cost stays flat
instead of spiking whenever a slow system comes due.

**Power** is not a global pool. Tiles conduct to their orthogonal neighbours,
so the map partitions into independent networks and each balances its own
supply against its own demand. A district wired to nothing browns out while a
plant across town sits idle. Power reaches a vacant lot from the lot next door,
one lot deep, so a block builds outward from the grid rather than needing a
pylon on every tile.

**Traffic** routes aggregate commuter flow rather than individual cars. A
multi-source breadth-first sweep builds a distance-to-work field over the road
graph, and every populated tile walks downhill along it, depositing load on the
roads it crosses. Flow concentrates on the links that join districts, so a lone
arterial saturates while parallel routes sit empty — and congestion feeds back
into land value and pollution.

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
draws differ — the deck is lifted clear of the water and stood on piers. The
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

All building art is drawn procedurally as isometric volumes at load time and
cached, so there are no image assets in the repository. The cache key is zone
type x level x variant x wealth x era x lit — over ten thousand combinations —
so it is held in a bounded LRU rather than a plain map.

## Layout

```
index.html          shell and UI chrome
styles.css          interface styling
src/
  config.js         every balance and presentation constant
  world.js          tile state (struct-of-arrays) and terrain generation
  iso.js            projection, camera, cursor picking
  tools.js          build tools and pointer handling
  save.js           serialisation
  sim/
    index.js        tick orchestration
    networks.js     road access and the power grid
    fields.js       coverage, pollution, crime, land value
    traffic.js      commuter flow
    demand.js       RCI demand
    growth.js       zone development and abandonment
    economy.js      budget and civic approval
  render/
    renderer.js     the isometric renderer
    sprites.js      procedural building art
    palette.js      colour
  ui/index.js       toolbar, readouts, inspector, advisors
tests/              node --test, no DOM required
```

## Tests

```bash
npm test            # node --test tests/*.test.js
```

132 tests covering the headless half of the game — everything under `src/sim`
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

**Save** writes to `localStorage`. Only authored state is stored — terrain,
what you zoned and built, and how far each lot developed. Every derived field
is recomputed on load, which keeps a save small and lets old saves survive
changes to the balance tables.

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
- [ ] **Individual agent simulation** to replace aggregate commuter flow, so
      citizens have homes, jobs and journeys you can follow.
- [ ] **Graphs and history**, using the monthly snapshots already recorded.
- [ ] **Larger maps with chunked terrain caching**, once redraw cost justifies
      it.
- [ ] **An offline sprite pipeline**, if the art should go beyond what can be
      drawn at runtime. This is how SimCity 3000 did it, and it would mean
      binary assets and a build step — a change in what the project is.
