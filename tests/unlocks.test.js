/**
 * A catalogue that grows with the calendar.
 *
 * A city that runs from 1900 to the present ought to have a different set of
 * things to build at each end of that run. These check the gate itself and the
 * two places it has to hold: what the palette offers, and what the tool will
 * actually let you put down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { BUILDINGS, CATALOGUE_START, isUnlocked, unlockedIn } from '../src/config.js';

const TYPES = Object.keys(BUILDINGS);

test('a building with no year has always been available', () => {
  for (const type of TYPES) {
    if (BUILDINGS[type].from) continue;
    assert.equal(isUnlocked(type, CATALOGUE_START), true, `${type} should be in the opening catalogue`);
  }
});

test('a dated building is locked before its year and open from it', () => {
  for (const type of TYPES) {
    const from = BUILDINGS[type].from;
    if (!from) continue;
    assert.equal(isUnlocked(type, from - 1), false, `${type} should still be locked in ${from - 1}`);
    assert.equal(isUnlocked(type, from), true, `${type} should open in ${from}`);
    assert.equal(isUnlocked(type, from + 40), true);
  }
});

test('the catalogue grows over the century', () => {
  const at = (year) => TYPES.filter((t) => isUnlocked(t, year)).length;
  const opening = at(CATALOGUE_START);
  assert.ok(opening > 0, 'there has to be something to build on day one');
  assert.ok(at(1960) > opening, 'the catalogue should have grown by 1960');
  assert.ok(at(2020) > at(1960), 'and again by 2020');
  assert.equal(at(2020), TYPES.length, 'and everything should be reachable eventually');
});

test('every era brings something, and nothing arrives before the city does', () => {
  for (const type of TYPES) {
    const from = BUILDINGS[type].from;
    if (!from) continue;
    assert.ok(from > CATALOGUE_START, `${type} is dated ${from}, which is not later than the start`);
  }
  // Each dated building is announced in exactly the year it arrives.
  for (const type of TYPES) {
    const from = BUILDINGS[type].from;
    if (!from) continue;
    assert.ok(unlockedIn(from).includes(type), `${type} is not announced in ${from}`);
    assert.ok(!unlockedIn(from + 1).includes(type), `${type} is announced again in ${from + 1}`);
  }
});

test('an unknown type is never unlocked', () => {
  assert.equal(isUnlocked('fusion', 3000), false);
  assert.deepEqual(unlockedIn(1901), []);
});

test('a later unlock is a real alternative, not a strict upgrade in name only', () => {
  // A hospital has to be worth the money over the clinic it supersedes, and a
  // wind farm has to buy something the coal plant does not.
  assert.ok(BUILDINGS.hospital.capacity > BUILDINGS.clinic.capacity * 3);
  assert.ok(BUILDINGS.hospital.cost > BUILDINGS.clinic.cost);
  assert.equal(BUILDINGS.wind.pollution, 0);
  assert.ok(BUILDINGS.wind.supply < BUILDINGS.coal.supply, 'cleaner, but not simply better');
});
