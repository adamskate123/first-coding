/**
 * Release notes.
 *
 * Two ways this goes wrong and neither of them throws: a player who has missed
 * three releases is told about one of them, or a player who is up to date is
 * shown notes every time they open the game. Both look fine in the code and
 * are only obvious to someone playing, so the decision is a pure function over
 * version strings and is tested here.
 *
 * The specific trap is comparison. Compared as text "0.9.0" sorts *after*
 * "0.10.0", so a player upgrading from 0.9.0 would be told that nothing had
 * changed since -- which is exactly the case that matters, because it is the
 * one where the notes are most wanted.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CHANGELOG, compareVersions, entriesSince } from '../src/changelog.js';
import { VERSION } from '../src/config.js';

test('every released version has a note, including this one', () => {
  // A release nobody wrote a note for is a silent release.
  const versions = CHANGELOG.map((e) => e.version);
  assert.ok(versions.includes(VERSION), `no release note for the current version ${VERSION}`);
  for (const e of CHANGELOG) {
    assert.match(e.version, /^\d+\.\d+\.\d+$/, `"${e.version}" is not a usable version`);
    assert.ok(e.headline && e.headline.length > 3, `${e.version} has no headline`);
    assert.ok(Array.isArray(e.changes) && e.changes.length, `${e.version} lists no changes`);
    for (const c of e.changes) assert.ok(c.length > 10, `${e.version} has a change with nothing in it`);
  }
});

test('the notes run newest first, with no repeats', () => {
  const seen = new Set();
  for (let i = 0; i < CHANGELOG.length; i++) {
    const v = CHANGELOG[i].version;
    assert.ok(!seen.has(v), `${v} appears twice`);
    seen.add(v);
    if (i > 0) {
      assert.equal(compareVersions(CHANGELOG[i - 1].version, v), 1,
        `${CHANGELOG[i - 1].version} should come after ${v}`);
    }
  }
});

// ------------------------------------------------------------- comparison --

test('versions compare as numbers, not as text', () => {
  assert.equal(compareVersions('0.9.0', '0.10.0'), -1, 'ten is after nine');
  assert.equal(compareVersions('0.10.0', '0.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '0.99.99'), 1);
  assert.equal(compareVersions('0.13.0', '0.13.0'), 0);
  assert.equal(compareVersions('0.13', '0.13.0'), 0, 'a missing part is zero');
  assert.equal(compareVersions('0.13.1', '0.13'), 1);
});

// ---------------------------------------------------------------- picking --

const LOG = [
  { version: '0.4.0', headline: 'four', changes: ['the fourth thing'] },
  { version: '0.3.0', headline: 'three', changes: ['the third thing'] },
  { version: '0.2.0', headline: 'two', changes: ['the second thing'] },
  { version: '0.1.0', headline: 'one', changes: ['the first thing'] },
];
const versions = (list) => list.map((e) => e.version);

test('a player who missed three releases hears about all three', () => {
  assert.deepEqual(versions(entriesSince('0.1.0', LOG, '0.4.0')), ['0.4.0', '0.3.0', '0.2.0']);
});

test('a player who is up to date hears nothing', () => {
  assert.deepEqual(entriesSince('0.4.0', LOG, '0.4.0'), []);
});

test('notes for a version that is not out yet are not shown', () => {
  // The note for a release is written in the same commit that makes it, so
  // between writing and releasing the entry exists and the version does not.
  assert.deepEqual(versions(entriesSince('0.2.0', LOG, '0.3.0')), ['0.3.0']);
});

test('a player whose marker is somehow newer is told nothing', () => {
  // A rollback, or a save carried back from a newer build. Inventing news is
  // worse than silence.
  assert.deepEqual(entriesSince('0.9.0', LOG, '0.4.0'), []);
});

test('a player with no marker at all gets the whole history', () => {
  // Which is right for someone whose marker predates the feature: the caller
  // decides whether to show it, and passes the version their save was written
  // by when it has one.
  assert.deepEqual(versions(entriesSince(null, LOG, '0.4.0')), ['0.4.0', '0.3.0', '0.2.0', '0.1.0']);
});

test('the nine-to-ten upgrade is not silently empty', () => {
  // The whole reason comparison is arithmetic. With text comparison this
  // returns nothing, and the release a player most wants to read about is the
  // one they are never told about.
  const real = entriesSince('0.9.0', CHANGELOG, '0.13.0');
  assert.ok(real.length >= 4, `expected several releases since 0.9.0, got ${real.length}`);
  assert.ok(versions(real).includes('0.10.0'));
  assert.ok(!versions(real).includes('0.9.0'), 'the version they already saw is not news');
});

test('what the player is shown is what was actually released', () => {
  // Run against the real log at the real version: everything offered must be
  // a genuine entry at or below the running version.
  for (const e of entriesSince('0.6.0', CHANGELOG, VERSION)) {
    assert.ok(CHANGELOG.includes(e));
    assert.ok(compareVersions(e.version, VERSION) <= 0, `${e.version} is not released yet`);
  }
});
