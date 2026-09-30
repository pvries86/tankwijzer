'use strict';

class TtlCache {
  constructor(maxEntries = 500) {
    this.map = new Map();
    this.maxEntries = maxEntries;
  }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (e.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    return e.value;
  }
  /** Returns a value even if expired (for stale-if-error). */
  getStale(key) {
    const e = this.map.get(key);
    return e ? e.value : undefined;
  }
  set(key, value, ttlS) {
    if (this.map.size >= this.maxEntries) {
      const first = this.map.keys().next().value;
      this.map.delete(first);
    }
    this.map.set(key, { value, expires: Date.now() + ttlS * 1000 });
  }
  /** Get or compute; concurrent callers share the same in-flight promise. On error, serve stale if available. */
  async wrap(key, ttlS, fn) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    this.inflight = this.inflight || new Map();
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const v = await fn();
        this.set(key, v, ttlS);
        return v;
      } catch (err) {
        const stale = this.getStale(key);
        if (stale !== undefined) return stale;
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

/** Serialises calls so that at least `intervalMs` passes between them (e.g. Nominatim 1 req/s policy). */
class Throttle {
  constructor(intervalMs) {
    this.intervalMs = intervalMs;
    this.chain = Promise.resolve();
    this.last = 0;
  }
  run(fn) {
    const next = this.chain.then(async () => {
      const wait = this.last + this.intervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      return fn();
    });
    this.chain = next.catch(() => {});
    return next;
  }
}

/** Fixed-window per-key rate limiter. */
class RateLimiter {
  constructor(perMinute) {
    this.perMinute = perMinute;
    this.windows = new Map();
  }
  allow(key) {
    const now = Date.now();
    const w = this.windows.get(key);
    if (!w || now - w.start > 60000) {
      this.windows.set(key, { start: now, count: 1 });
      if (this.windows.size > 10000) this.windows.clear();
      return true;
    }
    w.count += 1;
    return w.count <= this.perMinute;
  }
}

module.exports = { TtlCache, Throttle, RateLimiter };
