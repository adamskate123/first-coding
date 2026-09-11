/**
 * Noticing a new deploy.
 *
 * The failure this guards against is not subtle but it is easy to ship: a
 * banner that fires on every check, or one that never fires at all. Both look
 * fine in the code and are obvious only in front of a player, so the decision
 * itself is kept as a plain function over two strings and tested here, along
 * with the reading of the manifest that feeds it -- including the ways that
 * fetch can come back wrong, which is most of them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { updateReady, fetchDeployedVersion, UpdateWatch, MANIFEST } from '../src/update.js';
import { VERSION } from '../src/config.js';

/** A fetch that answers with whatever this test wants it to. */
function fakeFetch(body, { ok = true, status = 200, json } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return {
      ok, status,
      json: json || (async () => body),
    };
  };
  impl.calls = calls;
  return impl;
}

// --------------------------------------------------------------- deciding --

test('the same version is not an update', () => {
  assert.equal(updateReady('0.10.0', '0.10.0'), false);
});

test('a different version is', () => {
  assert.equal(updateReady('0.10.0', '0.10.1'), true);
});

test('a rollback counts too', () => {
  // Whichever way the deploy went, the page is no longer running what is
  // served, and a reload is the fix either way.
  assert.equal(updateReady('0.10.0', '0.9.0'), true);
});

test('surrounding whitespace is not a new version', () => {
  assert.equal(updateReady('0.10.0', ' 0.10.0\n'), false);
});

test('nothing readable means no banner', () => {
  // A proxy error page, a half-written file, a manifest still uploading: none
  // of these should put a notice on screen that cannot be made to go away.
  for (const served of [null, undefined, '', '   ', 42, {}, []]) {
    assert.equal(updateReady('0.10.0', served), false, `${JSON.stringify(served)} should not fire`);
  }
});

// ---------------------------------------------------------------- reading --

test('the deployed version is read from the manifest', async () => {
  const impl = fakeFetch({ version: '1.2.3' });
  assert.equal(await fetchDeployedVersion(impl), '1.2.3');
});

test('the manifest is fetched past the HTTP cache', async () => {
  // The whole point is to see through a cached copy of the very file that says
  // what is deployed, so this is the one request that must not be cached.
  const impl = fakeFetch({ version: '1.2.3' });
  await fetchDeployedVersion(impl);
  assert.equal(impl.calls[0].url, MANIFEST);
  assert.equal(impl.calls[0].init.cache, 'no-store');
});

test('a manifest without a version reads as unknown, not as an update', async () => {
  const impl = fakeFetch({ build: 'nope' });
  assert.equal(await fetchDeployedVersion(impl), null);
  assert.equal(updateReady(VERSION, null), false);
});

test('a failed request throws rather than reporting a version', async () => {
  const impl = fakeFetch(null, { ok: false, status: 404 });
  await assert.rejects(() => fetchDeployedVersion(impl), /404/);
});

test('a body that is not JSON throws', async () => {
  const impl = fakeFetch(null, { json: async () => { throw new SyntaxError('nope'); } });
  await assert.rejects(() => fetchDeployedVersion(impl));
});

// ---------------------------------------------------------------- watching --

test('the watch announces once and then stops asking', async () => {
  const seen = [];
  const watch = new UpdateWatch({ version: '0.10.0', onReady: (v) => seen.push(v) });
  global.fetch = fakeFetch({ version: '0.11.0' });

  assert.equal(await watch.check(), true);
  assert.equal(await watch.check(), false, 'a second find would re-announce');
  assert.deepEqual(seen, ['0.11.0']);
  watch.stop();
});

test('a matching version announces nothing', async () => {
  let fired = false;
  const watch = new UpdateWatch({ version: '0.10.0', onReady: () => { fired = true; } });
  global.fetch = fakeFetch({ version: '0.10.0' });

  assert.equal(await watch.check(), false);
  assert.equal(fired, false);
  watch.stop();
});

test('a check that cannot reach the network is quiet, and tries again later', async () => {
  let fired = false;
  const watch = new UpdateWatch({ version: '0.10.0', onReady: () => { fired = true; } });
  global.fetch = async () => { throw new TypeError('offline'); };

  assert.equal(await watch.check(), false, 'an offline tab is not an update');
  assert.equal(fired, false);
  assert.equal(watch.announced, false, 'and the watch stays live for the next one');

  global.fetch = fakeFetch({ version: '0.11.0' });
  assert.equal(await watch.check(), true);
  watch.stop();
});

test('registering the worker is skipped where there is none', () => {
  // Node has no navigator, which stands in for an old browser or a page opened
  // from the filesystem: the version check must still work without one.
  const watch = new UpdateWatch({ version: '0.10.0' });
  assert.equal(watch.registerWorker(), null);
});
