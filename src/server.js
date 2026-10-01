'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { loadConfig } = require('./config');
const { makeHttp } = require('./http');
const { TtlCache, Throttle, RateLimiter } = require('./cache');
const { FUELS } = require('./fuels');
const { makeOverpassProvider } = require('./providers/stations');
const { makeCbsProvider, makeFodProvider, makeStationFileProvider, makeDirectLeaseProvider } = require('./providers/prices');
const { makeAnwbClient, makeAnwbStationProvider, makeAnwbPriceProvider } = require('./providers/anwb');
const { makeCarbuClient, makeCarbuPriceProvider } = require('./providers/carbu');
const { makeOsrmRouter, makeHaversineRouter, makeNominatimGeocoder, makePhotonGeocoder, parseLatLon } = require('./providers/routing');
const { makePlaceIndex, mergeResults } = require('./providers/places');
const { makeOfficialGeocoders } = require('./providers/addressRegisters');
const { makeCompareService, InputError } = require('./compare');
const { makeRdwClient, RdwError } = require('./providers/rdw');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const { version: APP_VERSION } = require('../package.json');

// Shown in the page footer so users can tell a stale cached page from the current release.
// Docker/CI sets APP_BUILD (date + commit); local runs fall back to the newest public/ file date.
function buildLabel(env = process.env) {
  if (env.APP_BUILD) return `v${APP_VERSION} · ${env.APP_BUILD}`;
  let newest = 0;
  try {
    for (const f of fs.readdirSync(PUBLIC_DIR)) newest = Math.max(newest, fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs);
  } catch { /* ignore */ }
  return newest ? `v${APP_VERSION} · dev ${new Date(newest).toISOString().slice(0, 16).replace('T', ' ')} UTC` : `v${APP_VERSION} · dev`;
}
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function buildApp(config = loadConfig(), deps = {}) {
  const client = deps.http || makeHttp(config);
  const cache = new TtlCache(1000);

  // One ANWB client (tile cache, throttle, budgets, block file) shared by stations and prices.
  const anwbClient = deps.anwbClient || makeAnwbClient(config, deps.anwbDeps || {});
  const carbuClient = deps.carbuClient || makeCarbuClient(config, deps.carbuDeps || {});
  const priceFactories = {
    'station-file': () => makeStationFileProvider(config),
    carbu: () => makeCarbuPriceProvider(carbuClient, config),
    anwb: () => makeAnwbPriceProvider(anwbClient),
    directlease: () => makeDirectLeaseProvider(config, client),
    'cbs-nl': () => makeCbsProvider(config, client, cache),
    'fod-be': () => makeFodProvider(config, client, cache),
  };
  const priceProviders = deps.priceProviders || config.priceProviders
    .filter((id) => priceFactories[id] || console.warn(`[config] unknown price provider "${id}" ignored`))
    .map((id) => priceFactories[id]());

  const overpass = makeOverpassProvider(config, client, cache);
  let stationProvider = deps.stationProvider;
  let fallbackStationProvider = deps.fallbackStationProvider || null;
  if (!stationProvider) {
    if (config.stationProvider === 'anwb') {
      stationProvider = makeAnwbStationProvider(anwbClient);
      fallbackStationProvider = fallbackStationProvider || overpass; // OSM stations + estimates if ANWB is unavailable
    } else {
      stationProvider = overpass;
    }
  }
  const fallbackRouter = makeHaversineRouter(config);
  const router = deps.router || (config.routingProvider === 'osrm' ? makeOsrmRouter(config, client, cache) : fallbackRouter);
  const geocoder = deps.geocoder || (
    config.geocoder === 'photon' ? makePhotonGeocoder(config, client, cache, new Throttle(300, { overlap: true }))
      : config.geocoder === 'nominatim' ? makeNominatimGeocoder(config, client, cache, new Throttle(1100))
        : null);
  const places = deps.places !== undefined ? deps.places : (config.localPlaces ? makePlaceIndex(config) : null);
  const official = deps.officialGeocoders || (deps.geocoder !== undefined ? [] : makeOfficialGeocoders(config, client, cache));
  if (places && !deps.places) setTimeout(() => { try { places.search('warm up'); } catch (err) { console.warn('place index unavailable:', err.message); } }, 0).unref();
  const compare = makeCompareService({
    config,
    stationProvider,
    fallbackStationProvider,
    priceProviders,
    router,
    fallbackRouter,
  });
  const limiter = new RateLimiter(config.rateLimitPerMin);
  // Search-as-you-type makes more (small, cached, upstream-throttled) requests than comparisons do.
  const geoLimiter = new RateLimiter(Math.max(60, config.rateLimitPerMin * 3));
  const fastGeoLimiter = new RateLimiter(Math.max(150, config.rateLimitPerMin * 5)); // offline index + NL/Flanders registers
  const kentekenLimiter = new RateLimiter(20);
  const rdw = config.kentekenLookup ? (deps.rdw || makeRdwClient(config, client, cache)) : null;

  function send(res, status, body, headers = {}) {
    const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...headers,
    });
    res.end(data);
  }

  function readBody(req, limit = 20000) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => {
        size += c.length;
        if (size > limit) {
          reject(new InputError('request body too large'));
          req.destroy();
        } else chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          reject(new InputError('invalid JSON'));
        }
      });
      req.on('error', reject);
    });
  }

  function publicConfig() {
    return {
      fuels: Object.values(FUELS).map((f) => ({ id: f.id, label: f.label, labelNl: f.labelNl, local: f.local })),
      defaults: { litres: 40, consumption: 6.5, radiusKm: config.searchRadiusKm, perKmCost: 0 },
      providers: {
        stations: stationProvider.id,
        prices: priceProviders.map((p) => p.id),
        routing: router.id,
        geocoder: geocoder ? geocoder.id : null,
      },
      map: { tileUrl: config.tileUrl, attribution: config.tileAttribution },
      minWorthwhileSaving: config.minWorthwhileSaving,
      vehicle: { kentekenLookup: !!rdw, realismUpliftPct: config.vehicleRealismUpliftPct },
      build: buildLabel(),
    };
  }

  async function handleApi(req, res, url) {
    const ip = req.socket.remoteAddress || 'unknown';
    if (url.pathname === '/api/health') return send(res, 200, { ok: true });
    if (url.pathname === '/api/config') return send(res, 200, publicConfig());
    const isGeo = url.pathname === '/api/geocode';
    const isKenteken = url.pathname === '/api/kenteken';
    const lim = isKenteken ? kentekenLimiter : !isGeo ? limiter : url.searchParams.get('fast') === '1' ? fastGeoLimiter : geoLimiter;
    if (!lim.allow(ip)) {
      return send(res, 429, { error: 'Too many requests, please wait a minute.', ...(isKenteken ? { code: 'rate-limited' } : {}) });
    }

    if (isKenteken && req.method === 'GET') {
      if (!rdw) return send(res, 501, { error: 'Licence-plate lookup is disabled on this server.', code: 'disabled' });
      try {
        return send(res, 200, { vehicle: await rdw.lookup(url.searchParams.get('k') || '') });
      } catch (err) {
        if (err instanceof RdwError) return send(res, err.status, { error: err.message, code: err.code });
        throw err;
      }
    }

    if (url.pathname === '/api/geocode' && req.method === 'GET') {
      const q = (url.searchParams.get('q') || '').trim().slice(0, 200);
      if (q.length < 2) return send(res, 400, { error: 'query too short' });
      const ll = parseLatLon(q);
      if (ll) return send(res, 200, { results: [{ label: `${ll.lat}, ${ll.lon}`, ...ll }], source: 'coordinates' });
      if (!geocoder && !places && !official.length) return send(res, 501, { error: 'Address search is disabled on this server. Enter coordinates or use GPS.' });
      const near = { lat: Number(url.searchParams.get('lat')), lon: Number(url.searchParams.get('lon')) };
      const fast = url.searchParams.get('fast') === '1';
      let local = [];
      try { local = places ? places.search(q, { near }) : []; } catch (err) { console.warn('place index unavailable:', err.message); }
      const settle = (p, id) => p.catch((err) => { console.warn(`geocoder ${id} failed: ${err.message}`); return []; });
      const officialP = Promise.all(official.map((g) => settle(g.search(q, { near, timeoutMs: fast ? 2000 : undefined }), g.id)))
        .then((lists) => lists.flat());
      // fast=1: offline index + official NL/Flanders registers (~0.2 s). The client asks for the full result in parallel.
      if (fast || !geocoder) {
        const results = mergeResults([{ items: local, cap: 3 }, { items: await officialP }]);
        return send(res, 200, { results, source: 'GeoNames / PDOK / Digitaal Vlaanderen', partial: !!geocoder });
      }
      const [reg, remote] = await Promise.all([officialP, geocoder.search(q, { near })]);
      const results = mergeResults([{ items: local, cap: 3 }, { items: reg, cap: 4 }, { items: remote }]);
      return send(res, 200, { results, source: geocoder.attribution || geocoder.id });
    }

    if (url.pathname === '/api/prices' && req.method === 'GET') {
      const out = {};
      for (const p of priceProviders) {
        try {
          out[p.id] = { label: p.label, ...(await p.status()) };
        } catch (err) {
          out[p.id] = { label: p.label, ok: false, error: err.message };
        }
      }
      return send(res, 200, { providers: out });
    }

    if (url.pathname === '/api/compare' && req.method === 'POST') {
      const body = await readBody(req);
      return send(res, 200, await compare(body));
    }
    return send(res, 404, { error: 'not found' });
  }

  function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(res, 403, { error: 'forbidden' });
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' });
      send(res, 200, data, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
    });
  }

  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'geolocation=(self)',
    'Content-Security-Policy': [
      "default-src 'self'",
      "script-src 'self' https://unpkg.com",
      "style-src 'self' https://unpkg.com",
      "img-src 'self' data: https:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
    ].join('; '),
  };

  const server = http.createServer(async (req, res) => {
    for (const [k, v] of Object.entries(securityHeaders)) res.setHeader(k, v);
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'method not allowed' });
      return serveStatic(req, res, url);
    } catch (err) {
      if (err instanceof InputError || err instanceof RangeError || err instanceof URIError) return send(res, 400, { error: err.message });
      console.error(`[error] ${req.method} ${url.pathname}:`, err.message);
      return send(res, 502, { error: `Upstream data problem: ${err.message}` });
    }
  });
  return { server, config };
}

if (require.main === module) {
  const { server, config } = buildApp();
  server.listen(config.port, config.host, () => {
    console.log(`tankwijzer listening on http://${config.host}:${config.port} (stations: ${config.stationProvider}; prices: ${config.priceProviders.join(', ')})`);
  });
  const shutdown = () => server.close(() => process.exit(0));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { buildApp, buildLabel };
