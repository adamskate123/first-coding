/**
 * Noticing that a new version has been deployed.
 *
 * The running page has no way to know a release happened -- it holds the code
 * it loaded, and nothing tells it otherwise. So it asks: a small manifest is
 * fetched past the HTTP cache every few minutes and whenever the tab comes
 * back to the front, and if the deployed version is not the one running, the
 * game says so and offers a reload rather than leaving you to wonder whether
 * what you are playing is current.
 *
 * Deliberately no automatic reload. Dropping a city mid-placement to pick up a
 * cosmetic change would be a worse bug than the staleness it fixes; the player
 * decides when, and the city is written out before the page goes.
 *
 * The service worker does the other half -- it makes that reload actually land
 * on the new build instead of on whatever the browser still had cached.
 */

import { VERSION } from './config.js';

/** How often to ask, while the tab is open and visible. */
export const CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** Where the deployed version is published, relative to the page. */
export const MANIFEST = 'version.json';

/**
 * Should the player be told?
 *
 * Any difference counts, not just a higher number: a rollback is as much a
 * reason to reload as a release. Anything unreadable means no -- a proxy error
 * page or a half-written file must not put a permanent banner on the screen.
 */
export function updateReady(running, served) {
  if (typeof served !== 'string') return false;
  const trimmed = served.trim();
  if (!trimmed) return false;
  return trimmed !== running;
}

/** Read the deployed version, going round the HTTP cache to do it. */
export async function fetchDeployedVersion(fetchImpl, url = MANIFEST) {
  const response = await fetchImpl(url, { cache: 'no-store' });
  if (!response || !response.ok) {
    throw new Error(`${url} responded ${response ? response.status : 'not at all'}`);
  }
  const data = await response.json();
  return data && typeof data.version === 'string' ? data.version : null;
}

/**
 * Polls for a new deploy and calls back once, the first time it finds one.
 *
 * Every failure mode here is silent on purpose. No network, an offline tab, a
 * manifest that has not finished uploading -- none of that is the player's
 * problem, and a game that nags about its own update check would be worse than
 * one that never checked at all.
 */
export class UpdateWatch {
  constructor({ onReady, version = VERSION, interval = CHECK_INTERVAL_MS } = {}) {
    this.onReady = onReady;
    this.version = version;
    this.interval = interval;
    this.announced = false;
    this.timer = null;
  }

  /** Register the worker, then check now and keep checking. */
  start() {
    this.registerWorker();
    this.check();
    this.timer = setInterval(() => this.check(), this.interval);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden) this.check();
      });
    }
    return this;
  }

  stop() {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * The version in the script URL is what makes a release visible to the
   * browser as a new worker; without it the file is byte-identical between
   * deploys and the old one stays in charge.
   */
  registerWorker() {
    if (typeof navigator === 'undefined' || !navigator.serviceWorker) return null;
    if (typeof location !== 'undefined' && location.protocol === 'file:') return null;
    this.worker = navigator.serviceWorker
      .register(`sw.js?v=${encodeURIComponent(this.version)}`, { updateViaCache: 'none' })
      .catch(() => null);
    return this.worker;
  }

  async check() {
    if (this.announced) return false;
    try {
      const served = await fetchDeployedVersion(fetch);
      if (!updateReady(this.version, served)) return false;
      this.announced = true;
      this.stop();
      if (this.onReady) this.onReady(served);
      return true;
    } catch {
      return false;                 // offline, or mid-deploy; ask again later
    }
  }
}
