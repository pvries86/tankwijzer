'use strict';

// ANWB Onderweg provider tests. All fixtures below are hand-written; no real ANWB data is stored
// and no network request is made (fetch is always a stub).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { buildApp } = require('../src/server');
const { selectStations } = require('../src/providers/stations');
const {
  makeAnwbClient, makeAnwbStationProvider, makeAnwbPriceProvider, parseAnwbResponse,
  anwbFuelAvailability, tilesFor, cleanPrice, countryOf, dataOriginOf,
} = require('../src/providers/anwb');

const T0 = Date.parse('2026-10-01T10:00:00Z');
const HOUR = 3600000;

function rec(id, { lat, lon, iso3, country, title = 'Station', prices = [] }) {
  return {
    id,
    type: 'FUEL_STATION',
    title,
    coordinates: { latitude: lat, longitude: lon },
    address: { streetAddress: 'Teststraat 1', postalCode: '1234', city: 'Testdorp', country, iso3CountryCode: iso3 },
    prices,
  };
}
const p = (fuelType, value, fuelName = fuelType) => ({ fuelType, fuelName, value, currency: 'EUR', priceTier: 'REGULAR' });

const FIXTURE = {
  value: [
    rec('appitup_1001', { lat: 51.445, lon: 4.93, iso3: 'NLD', country: 'Nederland', title: 'NL Near',
      prices: [p('EURO95', 2.059, 'Euro 95 (E10)'), p('DIESEL', 1.799, 'Diesel (B7)'), p('DIESEL_SPECIAL', 1.999), p('EURO98', 0)] }),
    rec('xavvy_abc|BEL|42', { lat: 51.40, lon: 4.93, title: 'BE Far',
      prices: [p('EURO95', 1.7489999999999999, 'Benzine 95 E10'), p('DIESEL', 1.8290000000000002), p('AUTOGAS', 0.859)] }),
    rec('xavvy_3f2a9c0e-0000-4000-8000-000000000001', { lat: 51.37, lon: 6.20, iso3: 'DEU', country: 'Deutschland', title: 'DE Tank',
      prices: [p('EURO95', 1.689, 'Super E10'), p('EURO98', 1.799, 'Super Plus')] }),
    rec('appitup_2002', { lat: 51.44, lon: 4.95, iso3: 'NLD', title: 'NL LPG only', prices: [p('AUTOGAS', 0.899)] }),
    { id: 'xavvy_nocountry', type: 'FUEL_STATION', title: 'Unknown', coordinates: { latitude: 51.4, longitude: 4.9 }, prices: [p('EURO95', 1.5)] },
    { id: 'poi_other', type: 'PARKING', coordinates: { latitude: 51.4, longitude: 4.9 } },
  ],
  totalResults: 6,
};

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'anwb-test-'));
}

function cfg(over = {}) {
  return {
    ...loadConfig({}),
    anwbAck: true,
    anwbDataDir: tmpDir(),
    anwbMinIntervalMs: 1000,
    rateLimitPerMin: 1000,
    ...over,
  };
}

// fetch stub: records calls, returns a configurable response
function fakeFetch(respond = () => ({ status: 200, body: FIXTURE })) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = respond(url, calls.length);
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] || null },
      async json() { return r.body; },
    };
  };
  fn.calls = calls;
  return fn;
}

const noThrottle = { run: (f) => f() };
function client(config, fetch, clock) {
  return makeAnwbClient(config, { fetch, now: () => clock.t, throttle: noThrottle });
}

const SEARCH = { start: { lat: 51.44, lon: 4.93 }, radiusKm: 10 };

// ------------------------------------------------------------------ parser + mapping
test('anwb parser: prices, float noise, zero price, fuel mapping, country, origin', () => {
  const st = parseAnwbResponse(FIXTURE, '2026-10-01T10:00:00.000Z');
  assert.equal(st.length, 4, 'station without country and non-fuel POI are skipped');
  const nl = st.find((s) => s.anwbId === 'appitup_1001');
  assert.equal(nl.id, 'anwb:appitup_1001');
  assert.equal(nl.country, 'NL');
  assert.equal(nl.dataOrigin, 'App It Up');
  assert.deepEqual(Object.keys(nl.anwbFuels).sort(), ['diesel', 'e10']);
  assert.equal(nl.anwbFuels.e10.price, 2.059);
  assert.equal(nl.anwbFuels.e10.fuelName, 'Euro 95 (E10)');
  assert.equal(nl.anwbFuels.diesel.price, 1.799, 'DIESEL_SPECIAL must not replace regular diesel');
  assert.equal(nl.anwbFuels.e5_98, undefined, 'price 0 means not available');
  assert.ok(nl.listedFuelTypes.includes('EURO98'));
  assert.equal(nl.address, 'Teststraat 1, 1234 Testdorp');

  const be = st.find((s) => s.anwbId.startsWith('xavvy_abc'));
  assert.equal(be.country, 'BE', 'country from |BEL| in the ID when iso3 is missing');
  assert.equal(be.dataOrigin, 'Xavvy');
  assert.equal(be.anwbFuels.e10.price, 1.749);
  assert.equal(be.anwbFuels.diesel.price, 1.829);
  assert.equal(be.anwbFuels.lpg.price, 0.859);

  const de = st.find((s) => s.name === 'DE Tank');
  assert.equal(de.country, 'DE');
  assert.equal(de.anwbFuels.e5_98.price, 1.799);
  assert.throws(() => parseAnwbResponse({ nope: 1 }), /unexpected ANWB response/);
});

test('anwb helpers: cleanPrice, countryOf, dataOriginOf, availability', () => {
  assert.equal(cleanPrice(0), null);
  assert.equal(cleanPrice(null), null);
  assert.equal(cleanPrice('abc'), null);
  assert.equal(cleanPrice(15), null);
  assert.equal(cleanPrice(2.0589999999999997), 2.059);
  assert.equal(countryOf({ address: { iso3CountryCode: 'LUX' } }), 'LU');
  assert.equal(countryOf({ id: 'xavvy_x|BEL|1', address: {} }), 'BE');
  assert.equal(countryOf({ address: { iso3CountryCode: 'XYZ' } }), 'XYZ', 'unknown explicit ISO3 is kept, not guessed');
  assert.equal(countryOf({ id: 'foo', address: {} }), null);
  assert.equal(dataOriginOf('appitup_1'), 'App It Up');
  assert.equal(dataOriginOf('xavvy_1'), 'Xavvy');
  assert.equal(dataOriginOf('other_1'), null);

  const [nl, , , lpgOnly] = parseAnwbResponse(FIXTURE, new Date(T0).toISOString());
  assert.equal(anwbFuelAvailability(nl, 'e10'), 'yes');
  assert.equal(anwbFuelAvailability(lpgOnly, 'e10'), 'no', 'station lists other fuels only');
  assert.equal(anwbFuelAvailability({ anwbFuels: {}, listedFuelTypes: [] }, 'e10'), 'unknown');
  assert.equal(anwbFuelAvailability({ anwbFuels: {}, listedFuelTypes: [] }, 'lpg', true), 'no');
});

test('anwb tiles: grid-aligned, cover the radius, nearest first, corridor for a route', () => {
  const t = tilesFor(SEARCH, 0.5, 0.75);
  assert.ok(t.length >= 1 && t.length <= 4);
  assert.equal(t[0].key, '102:6', 'tile containing the start comes first');
  assert.deepEqual(t[0].bbox, [51, 4.5, 51.5, 5.25]);
  for (const x of t) assert.ok(x.bbox[2] - x.bbox[0] === 0.5);
  const route = tilesFor({ start: { lat: 51.44, lon: 4.93 }, destination: { lat: 51.44, lon: 6.2 }, radiusKm: 5 }, 0.5, 0.75);
  assert.ok(route.length > t.length - 1);
  assert.ok(route.some((x) => x.bbox[1] <= 6.2 && x.bbox[3] >= 6.2), 'destination tile included');
});

// ------------------------------------------------------------------ client: caching, rate limit, blocks
test('anwb client: honest UA, one request per tile, cached within TTL, refreshed after', async () => {
  const clock = { t: T0 };
  const fetch = fakeFetch();
  const c = client(cfg({ anwbCacheTtlH: 3 }), fetch, clock);
  const r1 = await c.find(SEARCH);
  const n = fetch.calls.length;
  assert.ok(n >= 1);
  assert.match(fetch.calls[0].url, /type-filter=FUEL_STATION&bounding-box-filter=51,4\.5,51\.5,5\.25$/);
  assert.match(fetch.calls[0].opts.headers['User-Agent'], /^tankwijzer\/.*private self-hosted/);
  assert.equal(Object.keys(fetch.calls[0].opts.headers).length, 2, 'only UA + Accept, nothing spoofed');
  assert.ok(r1.stations.length >= 3);
  assert.equal(new Set(r1.stations.map((s) => s.id)).size, r1.stations.length, 'deduplicated across tiles');

  clock.t += 2 * HOUR;
  const r2 = await c.find(SEARCH);
  assert.equal(fetch.calls.length, n, 'no new requests within TTL');
  assert.equal(r2.tiles.cached, n);

  clock.t += 2 * HOUR; // 4 h > 3 h TTL
  await c.find(SEARCH);
  assert.equal(fetch.calls.length, 2 * n, 'refreshed after TTL');
});

test('anwb client: tile cache persists across restarts', async () => {
  const clock = { t: T0 };
  const config = cfg();
  const f1 = fakeFetch();
  await client(config, f1, clock).find(SEARCH);
  const f2 = fakeFetch();
  clock.t += HOUR;
  const r = await client(config, f2, clock).find(SEARCH);
  assert.equal(f2.calls.length, 0);
  assert.ok(r.stations.length > 0);
});

test('anwb client: hourly budget and per-search tile cap are enforced', async () => {
  const clock = { t: T0 };
  const fetch = fakeFetch();
  const c = client(cfg({ anwbHourlyBudget: 1, anwbMaxTilesPerSearch: 1 }), fetch, clock);
  const big = { start: { lat: 51.49, lon: 5.24 }, radiusKm: 30 };
  const r = await c.find(big);
  assert.equal(fetch.calls.length, 1);
  assert.ok(r.tiles.skippedOverLimit > 0);
  const other = { start: { lat: 52.2, lon: 6.0 }, radiusKm: 5 };
  await assert.rejects(c.find(other), (e) => e.reason === 'hourly-budget');
  assert.equal(fetch.calls.length, 1, 'no request above the hourly budget');
  assert.equal(c.status().requestsLastHour, 1);
});

test('anwb client: not acknowledged or paused => no requests at all', async () => {
  const clock = { t: T0 };
  for (const [over, reason] of [[{ anwbAck: false }, 'not-acknowledged'], [{ anwbPaused: true }, 'paused']]) {
    const fetch = fakeFetch();
    const c = client(cfg(over), fetch, clock);
    await assert.rejects(c.find(SEARCH), (e) => e.reason === reason);
    assert.equal(fetch.calls.length, 0);
    assert.equal(c.status().reason, reason);
  }
  assert.equal(loadConfig({}).anwbAck, false, 'ANWB is off unless ANWB_PRIVATE_USE_ACK=true');
  assert.equal(loadConfig({ ANWB_PRIVATE_USE_ACK: 'true' }).anwbAck, true);
});

test('anwb client: 403 writes blocked.json, stops all requests, no cached reuse, survives restart', async () => {
  const clock = { t: T0 };
  const config = cfg({ anwbCacheTtlH: 1 });
  const ok = fakeFetch();
  await client(config, ok, clock).find(SEARCH); // warm cache
  clock.t += 2 * HOUR; // cache expired but within max age
  const denied = fakeFetch(() => ({ status: 403, body: {} }));
  const c = client(config, denied, clock);
  await assert.rejects(c.find(SEARCH), (e) => e.reason === 'blocked');
  assert.equal(denied.calls.length, 1, 'stops after the first 403');
  const file = path.join(config.anwbDataDir, 'blocked.json');
  assert.ok(fs.existsSync(file));
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).httpStatus, 403);

  const later = fakeFetch();
  clock.t += 72 * HOUR;
  const c2 = client(config, later, clock);
  await assert.rejects(c2.find(SEARCH), (e) => e.reason === 'blocked');
  assert.equal(later.calls.length, 0, 'block is permanent until the operator removes the file');
  assert.equal(c2.status().blocked.httpStatus, 403);

  fs.unlinkSync(file); // operator resolves the issue with ANWB
  await c2.find(SEARCH);
  assert.ok(later.calls.length > 0);
});

test('anwb client: 429 backs off >= 6 h (Retry-After honoured), network errors back off briefly', async () => {
  const clock = { t: T0 };
  const fetch = fakeFetch(() => ({ status: 429, body: {}, headers: { 'retry-after': String(12 * 3600) } }));
  const c = client(cfg(), fetch, clock);
  await assert.rejects(c.find(SEARCH), (e) => e.reason === 'fetch-failed');
  assert.equal(fetch.calls.length, 1);
  const st = c.status();
  assert.equal(st.backoffReason, 'rate-limited');
  assert.equal(Date.parse(st.backoffUntil) - clock.t, 12 * HOUR);
  clock.t += 11 * HOUR;
  await assert.rejects(c.find(SEARCH), (e) => e.reason === 'backoff');
  assert.equal(fetch.calls.length, 1);

  const clock2 = { t: T0 };
  const netErr = fakeFetch(() => new Error('ECONNRESET'));
  const c2 = client(cfg({ anwbErrorBackoffMin: 30 }), netErr, clock2);
  await assert.rejects(c2.find(SEARCH));
  assert.equal(Date.parse(c2.status().backoffUntil) - clock2.t, 30 * 60000);
  assert.equal(c2.status().blocked, null, 'network errors never count as a block');
});

test('anwb client: stale tiles are used up to max age when refresh is impossible', async () => {
  const clock = { t: T0 };
  const config = cfg({ anwbCacheTtlH: 1, anwbMaxAgeH: 24 });
  await client(config, fakeFetch(), clock).find(SEARCH);
  clock.t += 5 * HOUR;
  const failing = fakeFetch(() => ({ status: 500, body: {} }));
  const c = client(config, failing, clock);
  const sp = makeAnwbStationProvider(c);
  const r = await sp.find(SEARCH);
  assert.ok(r.stations.length > 0);
  assert.ok(r.source.tiles.stale > 0);
  assert.ok(r.source.warnings.some((w) => /could not be refreshed/.test(w)));
  clock.t += 30 * HOUR;
  await assert.rejects(client(config, fakeFetch(() => ({ status: 500, body: {} })), clock).find(SEARCH));
});

// ------------------------------------------------------------------ price provider
test('anwb price provider: station quote, price date unknown, attribution, staleness', async () => {
  const clock = { t: T0 };
  const c = client(cfg({ anwbCacheTtlH: 3, anwbStaleAfterH: 12, anwbMaxAgeH: 24 }), fakeFetch(), clock);
  const { stations } = await c.find(SEARCH);
  const pp = makeAnwbPriceProvider(c);
  const nl = stations.find((s) => s.anwbId === 'appitup_1001');
  const q = pp.stationPrice(nl, 'e10');
  assert.equal(q.price, 2.059);
  assert.equal(q.kind, 'station');
  assert.equal(q.estimate, false);
  assert.equal(q.asOf, null, 'never imply a price date');
  assert.equal(q.priceDateKnown, false);
  assert.equal(q.fetchedAt, new Date(T0).toISOString());
  assert.equal(q.quality, 'live-quote');
  assert.equal(q.source, 'ANWB Onderweg (data: App It Up)');
  assert.match(q.note, /price date unknown/);
  const be = stations.find((s) => s.country === 'BE');
  assert.equal(pp.stationPrice(be, 'e10').source, 'ANWB Onderweg (data: Xavvy)');
  assert.equal(pp.stationPrice(nl, 'lpg'), null);
  assert.equal(pp.missReason(nl, 'lpg', {}), 'ANWB lists no price for this fuel here');
  assert.equal(pp.missReason({ id: 'osm:1' }, 'e10', { status: { reason: 'blocked' } }), 'ANWB blocked access; not retrying');

  clock.t += 13 * HOUR;
  assert.equal(pp.stationPrice(nl, 'e10').quality, 'stale-quote');
  clock.t += 12 * HOUR;
  assert.equal(pp.stationPrice(nl, 'e10'), null, 'too old => no station price');

  const ctx = await pp.prefetch();
  assert.equal(ctx.status.ok, true);
  assert.deepEqual(pp.warnings({ status: { reason: 'not-acknowledged' } }).length, 1);
  assert.match(pp.warnings({ status: { reason: 'blocked', blocked: { httpStatus: 403 } } })[0], /Do not change IP address, VPN or proxy/);
});

test('selectStations: ANWB stations of any country, fuel availability from ANWB prices', () => {
  const st = parseAnwbResponse(FIXTURE, new Date(T0).toISOString());
  const sel = selectStations(st, { start: { lat: 51.44, lon: 4.93 }, fuelId: 'e10', maxPerCountry: 5 });
  assert.deepEqual(sel.map((s) => s.country).sort(), ['BE', 'DE', 'NL']);
  assert.ok(!sel.some((s) => s.name === 'NL LPG only'));
  const lpg = selectStations(st, { start: { lat: 51.44, lon: 4.93 }, fuelId: 'lpg', maxPerCountry: 5 });
  assert.deepEqual(lpg.map((s) => s.name).sort(), ['BE Far', 'NL LPG only']);
});

// ------------------------------------------------------------------ economics integration
function refProvider(country, price, kind) {
  return {
    id: `stub-${country}`,
    country,
    label: `stub ${country}`,
    async reference() {
      return { price, kind, source: `stub ${country}`, sourceUrl: null, asOf: '2026-09-30', fetchedAt: null, live: false, note: '' };
    },
    async status() { return { ok: true }; },
  };
}
const stubRouter = {
  id: 'stub',
  async distances({ stations: st }) {
    const km = { NL: 1, BE: 5, DE: 20 };
    return {
      mode: 'road', provider: 'stub',
      toStation: st.map((s) => km[s.country]), fromStation: st.map((s) => km[s.country]), baseTripKm: 0,
      toStationMin: st.map(() => 1), fromStationMin: st.map(() => 1), baseTripMin: 0,
    };
  },
};

async function withApp(config, deps, fn) {
  const { server } = buildApp(config, deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}
const post = (base, body) => fetch(`${base}/api/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

function anwbDeps(fetchImpl, overpassStations) {
  return {
    anwbDeps: { fetch: fetchImpl, throttle: noThrottle },
    fallbackStationProvider: {
      id: 'overpass', label: 'OpenStreetMap (Overpass API)',
      async find() { return { stations: overpassStations, source: { provider: 'overpass', fetchedAt: new Date().toISOString() } }; },
    },
    router: stubRouter,
    geocoder: null,
  };
}

function appConfig(over = {}) {
  return cfg({ stationProvider: 'anwb', priceProviders: ['anwb', 'cbs-nl', 'fod-be'], ...over });
}

test('compare + ANWB: station prices (NL/BE/DE) drive the economics, price-date caveat shown', async () => {
  const config = appConfig();
  const deps = anwbDeps(fakeFetch(), []);
  // Replace the CBS/FOD network providers with stubs, keep the ANWB price provider from the factory.
  const { makeAnwbClient: mk } = require('../src/providers/anwb');
  const c = mk(config, deps.anwbDeps);
  deps.anwbClient = c;
  deps.priceProviders = [makeAnwbPriceProvider(c), refProvider('NL', 2.2, 'national-average'), refProvider('BE', 1.9, 'legal-maximum')];
  await withApp(config, deps, async (base) => {
    // Route towards Germany: the DE station lies near the route, so it is within the search corridor.
    const res = await post(base, { start: { lat: 51.44, lon: 4.93 }, destination: { lat: 51.37, lon: 6.25 }, fuel: 'e10', litres: 40, consumption: 6, radiusKm: 30 });
        assert.equal(res.status, 200);
        const d = await res.json();
        const byName = Object.fromEntries(d.results.map((r) => [r.name, r]));
        assert.ok(byName['DE Tank'], 'DE station included');
        assert.equal(byName['DE Tank'].country, 'DE');
    assert.equal(byName['DE Tank'].localFuelName, 'Super E10');
    assert.equal(byName['NL Near'].price.price, 2.059);
    assert.equal(byName['NL Near'].price.estimate, false);
    assert.equal(byName['NL Near'].price.priceDateKnown, false);
    assert.equal(byName['NL Near'].isBaseline, true);
    // totals include each option's full detour: NL 82.36 + 2 km*0.06*2.059 = 82.607 ; BE 69.96 + 10*0.06*1.749 = 71.009
    assert.equal(byName['BE Far'].saving, 11.6);
    assert.ok(d.bestByCountry.DE && d.bestByCountry.BE && d.bestByCountry.NL);
    assert.equal(d.recommendation.stationId, byName['BE Far'].id);
    assert.ok(d.recommendation.caveats.some((x) => /price date unknown/.test(x)));
    assert.ok(!d.results.some((r) => r.price.estimate), 'no estimates when ANWB has station prices');
  });
});

test('compare + ANWB blocked: falls back to OSM stations with clearly labelled estimates, never ANWB prices', async () => {
  const config = appConfig();
  fs.writeFileSync(path.join(config.anwbDataDir, 'blocked.json'), JSON.stringify({ at: '2026-10-01T00:00:00Z', httpStatus: 403 }));
  const fetchImpl = fakeFetch();
  const osm = [
    { id: 'osm:n1', name: 'OSM NL', country: 'NL', lat: 51.445, lon: 4.93, tags: {} },
    { id: 'osm:b1', name: 'OSM BE', country: 'BE', lat: 51.40, lon: 4.93, tags: {} },
  ];
  const deps = anwbDeps(fetchImpl, osm);
  const c = makeAnwbClient(config, deps.anwbDeps);
  deps.anwbClient = c;
  deps.priceProviders = [makeAnwbPriceProvider(c), refProvider('NL', 2.2, 'national-average'), refProvider('BE', 1.9, 'legal-maximum')];
  await withApp(config, deps, async (base) => {
    const d = await (await post(base, { start: { lat: 51.44, lon: 4.93 }, fuel: 'e10', litres: 40, consumption: 6 })).json();
    assert.equal(fetchImpl.calls.length, 0, 'no request while blocked');
    assert.equal(d.results.length, 2);
    for (const r of d.results) {
      assert.equal(r.price.estimate, true);
      assert.equal(r.price.quality, 'country-estimate');
      assert.match(r.price.fallbackReason, /ANWB blocked/);
    }
    assert.ok(d.warnings.some((w) => /Showing OpenStreetMap \(Overpass API\) stations instead/.test(w)));
    assert.ok(d.warnings.some((w) => /Do not change IP address, VPN or proxy/.test(w)));
    const st = await (await fetch(`${base}/api/prices`)).json();
    assert.equal(st.providers.anwb.ok, false);
    assert.equal(st.providers.anwb.reason, 'blocked');
  });
});

test('compare + ANWB: DE station without a price for the fuel is skipped (no DE estimate exists)', async () => {
  const config = appConfig();
  const only = { value: [FIXTURE.value[0], rec('xavvy_de2', { lat: 51.43, lon: 4.94, iso3: 'DEU', title: 'DE Diesel only', prices: [p('DIESEL', 1.6)] })] };
  const deps = anwbDeps(fakeFetch(() => ({ status: 200, body: only })), []);
  const c = makeAnwbClient(config, deps.anwbDeps);
  deps.anwbClient = c;
  deps.priceProviders = [makeAnwbPriceProvider(c), refProvider('NL', 2.2, 'national-average'), refProvider('BE', 1.9, 'legal-maximum')];
  await withApp(config, deps, async (base) => {
    const d = await (await post(base, { start: { lat: 51.44, lon: 4.93 }, fuel: 'e10', litres: 40, consumption: 6 })).json();
    assert.deepEqual(d.results.map((r) => r.country), ['NL']);
    const dd = await (await post(base, { start: { lat: 51.44, lon: 4.93 }, fuel: 'diesel', litres: 40, consumption: 6 })).json();
    assert.ok(dd.results.some((r) => r.country === 'DE' && r.price.price === 1.6 && !r.price.estimate));
  });
});
