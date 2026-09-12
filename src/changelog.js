/**
 * What changed, in the player's words.
 *
 * The game already tells you when a new version has been deployed and offers
 * to reload; this is the other half of that conversation -- once you have
 * reloaded, it says what you reloaded *for*. Written for someone who plays the
 * game rather than someone who reads the commits: what is different on screen,
 * not what moved in the source.
 *
 * Newest first. Every released version needs an entry and a test enforces it,
 * because a release note nobody writes is a release note nobody reads.
 */

import { VERSION } from './config.js';

export const CHANGELOG = [
  {
    version: '0.16.0',
    headline: 'Services you can count, demand you can read, a century you can feel',
    changes: [
      'Services are now provided city-wide against a capacity instead of a radius on the map. The city panel says how many residents each one covers and how many are going without, so one more school is a decision you can actually make.',
      'Civic buildings employ people. A police station, a school or a power plant is an employer like any other, and their staff now count against unemployment.',
      'Demand was ignoring your unemployed. Industry and commerce now expand when there are workers with nowhere to go, which is what was missing when a seventh of the city was out of work and the industrial bar would not move.',
      'The city panel explains each demand bar: the three things pushing it up or down, strongest first. No more guessing what industry is waiting for.',
      'New things unlock as the decades pass — gas in 1938, the hospital in 1952, solar in 1982, wind in 1996 — and the city tells you when one arrives.',
      'Avenues are divided carriageways now: a kerbed and planted median, lanes either side, and kerbs where the road ends. They no longer look like streets.',
      'Industry looks like industry: north-light sheds, loading docks, silos, tanks, stacks and gantries behind a palisade, instead of the same houses in beige.',
      'Bridges got proper piers on a spacing, abutments where they meet the bank, and railings with posts — and no longer put a step across the road at each end.',
      'Nightfall takes three minutes instead of thirty-six seconds, and night eases to deep blue rather than to black.',
    ],
  },
  {
    version: '0.15.0',
    headline: 'Every civic building is its own building now',
    changes: [
      'Scrolling no longer smears the city down the side of the screen.',
      'The fire station has appliance bay doors and a drill tower; the police station a portico, squad cars and a radio mast; the clinic an ambulance canopy and a red cross you can spot from across the map; the school a long gabled wing with a bell cupola and a ball court.',
      'Power stations look like power stations: banded chimneys and a coal yard under a grab gantry, or gas holders beside the turbine hall.',
      'The solar farm is rows of tilted panels rather than a blue slab.',
      'Parks and plazas gained paths, planting, benches, lamps and a fountain.',
      'At night the bay doors glow, the blue lamps come on, and the chimneys carry warning lights.',
    ],
  },
  {
    version: '0.14.0',
    headline: 'A note on what changed',
    changes: [
      'After an update, the game now tells you what is new — this window.',
      'Click the version number in the title bar to read it again at any time.',
    ],
  },
  {
    version: '0.13.0',
    headline: 'Night falls, and districts grow up together',
    changes: [
      'Night and day. Lit windows now mean the lights are on, and a blackout is something you can see from across the map. Press N to keep it in daylight.',
      'Blocks of matching lots share one larger building instead of each standing alone, so a developed district reads as a city rather than a grid of boxes.',
      'Power carries across a street, so a line down one road serves the blocks either side. Wiring a city is no longer a chore, and districts connected to no plant at all are named.',
      'A History window: population, treasury, approval, land value and unemployment, month by month since 1900.',
      'Empty zoned land reads as cleared ground with its boundary marked, instead of a coloured quilt over everything.',
      'Large cities draw far faster, so the traffic keeps moving however far out you zoom.',
    ],
  },
  {
    version: '0.12.0',
    headline: 'Cities grow a centre',
    changes: [
      'Land value now feeds on the density around it, so investment concentrates and a real downtown forms — with the towers and affluent quarters that were previously impossible to reach.',
      'A grid that is short of power sheds load instead of blacking out entirely, so an under-supplied city settles rather than collapsing.',
      'Roofs have materials — tile, slate, lead, tar, copper, even planted roofs — with ridges, parapets, stair housings and rooftop plant.',
      'More varied building shapes, so a street of one zone is no longer a row of identical boxes.',
    ],
  },
  {
    version: '0.11.0',
    headline: 'Buildings get facades',
    changes: [
      'Walls are properly composed now: shopfronts with stall risers, doors, storeys, cornices, balconies and the occasional drawn blind.',
      'Neighbouring buildings differ in bay rhythm, storey height and detail, and wealth and period change how a wall is put together.',
    ],
  },
  {
    version: '0.10.0',
    headline: 'Updates that arrive, and a game that works offline',
    changes: [
      'A new version now reaches you promptly instead of hours later, and a banner says when one is ready. Taking it saves your city first.',
      'The game works with no network at all.',
    ],
  },
  {
    version: '0.9.0',
    headline: 'Traffic you can watch',
    changes: [
      'Cars drive the roads, gathering where the traffic actually is and crawling where it jams. Press V to hide them.',
    ],
  },
  {
    version: '0.8.0',
    headline: 'Bridges, power and congestion',
    changes: [
      'Bridges meet their banks properly instead of the road diving away beneath them.',
      'Power flows through zoned land whether or not anything stands on it yet.',
      'Busy roads darken towards red, and the city panel shows power produced against power consumed.',
    ],
  },
  {
    version: '0.7.1',
    headline: 'The bridge freeze',
    changes: [
      'Fixed a fault that froze the game whenever a bridge was on screen.',
      'Bridges span at the level of the banks they join rather than dipping to the water.',
    ],
  },
  {
    version: '0.7.0',
    headline: 'Your city is saved',
    changes: [
      'The city saves itself as you play and resumes when you come back, instead of a reload throwing it away.',
      'Export a city to a file, and import one back.',
    ],
  },
  {
    version: '0.6.1',
    headline: 'Cursor accuracy',
    changes: [
      'The cursor now selects the tile actually under the pointer, rather than one several tiles away on sloping ground.',
    ],
  },
  {
    version: '0.6.0',
    headline: 'Version numbering',
    changes: [
      'The game reports its version in the title bar.',
    ],
  },
];

/**
 * Order two version strings.
 *
 * Compared part by part as numbers, never as text: as strings "0.9.0" sorts
 * after "0.10.0", which would have told a player upgrading from 0.9.0 that
 * nothing had changed since.
 */
export function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The entries a player who last saw `seen` has not read yet.
 *
 * Everything since, not merely the newest: someone who comes back after three
 * releases should find out about all three. Nothing at all when they are up to
 * date, and nothing when the version they last saw is somehow newer than this
 * one -- a rollback is not news, and inventing some is worse than silence.
 */
export function entriesSince(seen, log = CHANGELOG, current = VERSION) {
  const released = log.filter((e) => compareVersions(e.version, current) <= 0);
  if (!seen) return released;
  return released.filter((e) => compareVersions(e.version, seen) > 0);
}
