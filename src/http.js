'use strict';

class UpstreamError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
  }
}

function makeHttp(config) {
  async function request(url, { method = 'GET', headers = {}, body, timeoutMs = config.httpTimeoutMs } = {}) {
    const res = await fetch(url, {
      method,
      headers: { 'User-Agent': config.userAgent, Accept: '*/*', ...headers },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      throw new UpstreamError(`${new URL(url).host} responded ${res.status}`, res.status);
    }
    return res;
  }
  return {
    async json(url, opts) {
      const res = await request(url, { ...opts, headers: { Accept: 'application/json', ...(opts && opts.headers) } });
      return res.json();
    },
    async buffer(url, opts) {
      const res = await request(url, opts);
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

function haversineKm(a, b) {
  const R = 6371.0088;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

module.exports = { makeHttp, haversineKm, UpstreamError };
