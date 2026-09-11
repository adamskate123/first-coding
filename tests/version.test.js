/**
 * Version reporting.
 *
 * A version string is only useful if every place that shows one agrees. The
 * game reads `VERSION` from the configuration; `package.json` carries the same
 * number for tooling. These tests exist so the two cannot drift apart quietly,
 * which is the usual fate of a hand-maintained version.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { VERSION } from '../src/config.js';
import { World } from '../src/world.js';
import { serialize, deserialize } from '../src/save.js';
import { T } from '../src/config.js';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

test('the version is a plain three-part number', () => {
  assert.match(VERSION, /^\d+\.\d+\.\d+$/, `"${VERSION}" is not a usable version`);
});

test('package.json agrees with the version the game reports', () => {
  assert.equal(pkg.version, VERSION,
    `package.json says ${pkg.version} but the game reports ${VERSION}`);
});

test('a new city is stamped with the version that made it', () => {
  const w = new World(16, 1);
  assert.equal(w.savedWith, VERSION);
});

test('a save records the version that wrote it', () => {
  const w = new World(16, 2);
  const data = serialize(w);
  assert.equal(data.version, VERSION);
});

test('loading a city reports the version that saved it, not the one loading', () => {
  // Which build wrote a city is what makes an odd-looking save explicable, so
  // it must survive the round trip rather than being overwritten on load.
  const w = new World(16, 3);
  const data = serialize(w);
  data.version = '0.1.0';

  const restored = deserialize(data);
  assert.equal(restored.savedWith, '0.1.0');
});

test('a save with no version recorded still loads', () => {
  const w = new World(16, 4);
  w.terrain.fill(T.GRASS);
  const data = serialize(w);
  delete data.version;
  data.format = 1;

  const restored = deserialize(data);
  assert.equal(restored.savedWith, null, 'an unversioned save reports no version');
  assert.equal(restored.size, 16, 'and otherwise loads normally');
});

test('compatibility is decided by the format, not the version', () => {
  // The version is informational. A city written by an older build of the same
  // save format must still load, or every release would orphan saves.
  const w = new World(16, 5);
  const data = serialize(w);
  data.version = '0.0.1';
  assert.doesNotThrow(() => deserialize(data));
});
