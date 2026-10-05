'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { buildApp } = require('../src/server');
const { navigationLinks, parseInput } = require('../src/compare');

const START = { lat: 51.44, lon: 4.93, label: 'Baarle' };

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

const stations = [
  { id: 'nl1', name: 'NL Near', country: 'NL', lat: 51.445, lon: 4.93, tags: {} },
  { id: 'be1', name: 'BE Far', country: 'BE', lat: 51.40, lon: 4.93, tags: {} },
];

// Deterministic router: distance = index-based fixed km
const stubRouter = {
  id: 'stub',
  async distances({ destination, stations: st }) {
    const km = { nl1: 1, be1: 5 };
    return {
      mode: 'road', provider: 'stub',
      toStation: st.map((s) => km[s.id] ?? 3),
      fromStation: st.map((s) => (km[s.id] ?? 3) + (destination ? 20 : 0)),
      baseTripKm: destination ? 21 : 0,
      toStationMin: st.map(() => 1), fromStationMin: st.map(() => 1), baseTripMin: 0,
    };
  },
};

async function withApp(deps, envOverrides, fn) {
  const config = { ...loadConfig({}), rateLimitPerMin: 1000, ...envOverrides };
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

const liveDeps = () => ({
  stationProvider: { id: 'stub', async find() { return { stations, source: { provider: 'stub', fetchedAt: new Date().toISOString() } }; } },
  priceProviders: [refProvider('NL', 2.4, 'national-average'), refProvider('BE', 2.0, 'legal-maximum')],
  router: stubRouter,
  geocoder: { id: 'stub', async search(q) { return [{ label: q, lat: 51, lon: 4 }]; } },
});

test('compare: round trip recommends Belgium with correct economics and provenance', async () => {
  await withApp(liveDeps(), {}, async (base) => {
    const res = await post(base, { start: START, fuel: 'e10', litres: 40, consumption: 6 });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.input.mode, 'round-trip');
    assert.equal(d.recommendation.level, 'go');
    assert.equal(d.recommendation.stationId, 'be1');
    const be = d.results.find((r) => r.id === 'be1');
    const nl = d.results.find((r) => r.id === 'nl1');
    assert.equal(nl.isBaseline, true);
    assert.equal(be.route.detourKm, 10);
    assert.equal(be.extraKm, 8);
    // NL 96 + 0.12*2.4 = 96.288 ; BE 80 + 0.6*2 = 81.2
    assert.equal(be.saving, 15.09);
    assert.equal(be.price.kind, 'legal-maximum');
    assert.equal(be.localFuelName, 'Benzine 95 RON E10 (E10)');
    assert.equal(be.price.estimate, true);
    assert.equal(d.recommendation.confidence, 'low');
    assert.ok(d.recommendation.caveats.some((c) => /legal MAXIMUM/.test(c)));
    assert.ok(d.recommendation.caveats.some((c) => /national AVERAGE/.test(c)));
    assert.match(d.recommendation.headline, /estimated price/);
    assert.match(be.navigation.google, /destination=51\.400000%2C4\.930000/);
    assert.ok(d.assumptions.some((a) => /Round-trip/.test(a)));
  });
});

test('compare: lang=nl gives Dutch texts with decimal commas, same economics', async () => {
  await withApp(liveDeps(), {}, async (base) => {
    const d = await (await post(base, { start: START, fuel: 'e10', litres: 40, consumption: 6, lang: 'nl' })).json();
    assert.equal(d.recommendation.stationId, 'be1');
    assert.equal(d.results.find((r) => r.id === 'be1').saving, 15.09);
    assert.match(d.recommendation.headline, /^Tank bij/);
    assert.ok(d.assumptions.some((a) => /Heen-en-terug/i.test(a)));
    assert.ok(!d.assumptions.some((a) => /Round-trip/.test(a)));
    assert.ok(d.recommendation.caveats.every((c) => !/legal MAXIMUM/.test(c)));
  });
});

test('compare: route detour computed as via-station minus direct', async () => {
  await withApp(liveDeps(), {}, async (base) => {
    const d = await (await post(base, { start: START, destination: { lat: 51.5, lon: 5.0 }, fuel: 'diesel', litres: 40, consumption: 6 })).json();
    const be = d.results.find((r) => r.id === 'be1');
    const nl = d.results.find((r) => r.id === 'nl1');
    assert.equal(be.route.detourKm, 9); // 5 + 25 - 21
    assert.equal(nl.route.detourKm, 1); // 1 + 21 - 21
    assert.match(be.navigation.google, /waypoints=/);
    assert.ok(d.assumptions.some((a) => /Route mode/.test(a)));
  });
});

test('compare: small purchase -> stay recommendation', async () => {
  await withApp(liveDeps(), {}, async (base) => {
    const d = await (await post(base, { start: START, fuel: 'e10', litres: 1, consumption: 8 })).json();
    assert.equal(d.recommendation.level, 'stay');
    assert.equal(d.recommendation.stationId, 'nl1');
  });
});

test('compare: custom baseline; manual price overrides are ignored', async () => {
  await withApp(liveDeps(), {}, async (base) => {
    const d = await (await post(base, {
      start: START, fuel: 'e10', litres: 40, consumption: 6,
      overrides: { NL: 1.5 }, baseline: { mode: 'custom', price: 2.5 },
    })).json();
    const nl = d.results.find((r) => r.id === 'nl1');
    assert.notEqual(nl.price.kind, 'user');
    assert.notEqual(nl.price.price, 1.5);
    assert.equal(d.baseline.id, '__baseline__');
    assert.ok(d.results.every((r) => r.price.kind !== 'user'));
  });
});

test('compare: station failure is an error, not fake data', async () => {
  const deps = { ...liveDeps(), stationProvider: { id: 'broken', async find() { throw new Error('boom'); } } };
  await withApp(deps, {}, async (base) => {
    const res = await post(base, { start: START, fuel: 'e10', litres: 40, consumption: 6 });
    assert.equal(res.status, 502);
  });
});

test('compare: routing failure falls back to estimate with warning', async () => {
  const deps = { ...liveDeps(), router: { id: 'x', async distances() { throw new Error('down'); } } };
  await withApp(deps, {}, async (base) => {
    const d = await (await post(base, { start: START, fuel: 'e10', litres: 40, consumption: 6 })).json();
    assert.equal(d.sources.routing.mode, 'estimate');
    assert.ok(d.warnings.some((w) => /Road routing unavailable/.test(w)));
  });
});

test('compare: missing prices produce warning and no crash', async () => {
  const deps = { ...liveDeps(), priceProviders: [] };
  await withApp(deps, {}, async (base) => {
    const d = await (await post(base, { start: START, fuel: 'e10', litres: 40, consumption: 6 })).json();
    assert.equal(d.results.length, 0);
    assert.equal(d.recommendation.level, 'none');
    assert.ok(d.warnings.some((w) => /station\(s\) skipped in savings advice: no current station-specific .* price and no country estimate/.test(w)));
    assert.deepEqual([...d.skippedCountries].sort(), ['BE', 'NL']);
  });
});

test('API input validation returns 400', async () => {
  await withApp(liveDeps(), {}, async (base) => {
    for (const body of [
      {},
      { start: START, fuel: 'e10', litres: 0, consumption: 6 },
      { start: START, fuel: 'e10', litres: 40, consumption: 0 },
      { start: START, fuel: 'e10', litres: 40 },
      { start: START, fuel: 'kerosene', litres: 10, consumption: 6 },
      { start: { lat: 999, lon: 0 }, fuel: 'e10', litres: 10, consumption: 6 },
      { start: START, destination: { lat: 40, lon: 4 }, fuel: 'e10', litres: 10, consumption: 6 },
    ]) {
      const res = await post(base, body);
      assert.equal(res.status, 400, JSON.stringify(body));
    }
    const bad = await fetch(`${base}/api/compare`, { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
  });
});

  test('discovery: stations, prices, provenance and navigation without invented economics', async () => {
    await withApp(liveDeps(), {}, async (base) => {
      const res = await post(base, { start: START, fuel: 'e10', advice: false });
      assert.equal(res.status, 200);
      const d = await res.json();
      assert.equal(d.input.advice, false);
      assert.equal(d.input.consumption, null);
      assert.equal(d.input.litres, null);
      assert.equal(d.recommendation, null);
      assert.equal(d.baseline, null);
      assert.deepEqual(d.bestByCountry, {});
      assert.deepEqual(d.results.map((s) => s.id), ['nl1', 'be1']);
      for (const s of d.results) {
        for (const key of ['saving', 'cashSaving', 'total', 'breakEven', 'isBaseline']) assert.equal(s[key], undefined);
        assert.ok(s.price.source);
        assert.ok(s.navigation.google);
        assert.ok(s.route.detourKm > 0);
      }
      assert.ok(d.assumptions.some((a) => /ordered by detour distance/.test(a)));
      assert.ok(d.assumptions.every((a) => !/null L|Baseline:|ranked by saving/.test(a)));
      const advice = await (await post(base, { start: START, fuel: 'e10', consumption: 6, litres: 40 })).json();
      assert.equal(advice.input.advice, true);
      assert.equal(advice.recommendation.stationId, 'be1');
    });
  });

  test('discovery: unpriced and unroutable stations stay visible, never enter savings advice', async () => {
    const deps = { ...liveDeps(), priceProviders: [], router: { async distances() {
      return { ...await stubRouter.distances({ stations }), toStation: [NaN, 5] };
    } } };
    await withApp(deps, {}, async (base) => {
      const d = await (await post(base, { start: START, fuel: 'e10', advice: false, lang: 'nl' })).json();
      assert.equal(d.results.length, 2);
      assert.ok(d.results.every((s) => s.price === null && s.saving === undefined));
      assert.equal(d.results.find((s) => s.id === 'nl1').route, null);
      assert.ok(d.assumptions.some((a) => /niet van besparing/.test(a)));
    });
  });

  test('discovery/advice preparation is shared in flight and reused for arithmetic changes', async () => {
    const deps = liveDeps();
    let finds = 0, prices = 0, routes = 0;
    const find = deps.stationProvider.find;
    deps.stationProvider.find = async (...args) => { finds++; return find(...args); };
    const reference = deps.priceProviders[0].reference;
    deps.priceProviders[0].reference = async (...args) => { prices++; return reference(...args); };
    deps.router = { async distances(...args) { routes++; return stubRouter.distances(...args); } };
    await withApp(deps, {}, async (base) => {
      const body = { start: START, fuel: 'e10', advice: false };
      const [discovery, advice] = await Promise.all([
        post(base, body).then((r) => r.json()),
        post(base, { ...body, advice: true, consumption: 6, litres: 40 }).then((r) => r.json()),
      ]);
      assert.equal(discovery.recommendation, null);
      assert.equal(advice.recommendation.stationId, 'be1');
      const changed = await (await post(base, { ...body, advice: true, consumption: 7, litres: 20, timeValuePerHour: 30, minSaving: 5 })).json();
      assert.notEqual(changed.results[0].total, advice.results[0].total);
      assert.deepEqual([finds, prices, routes], [1, 1, 1]);
      await post(base, { ...body, fuel: 'diesel' });
      await post(base, { ...body, radiusKm: 25 });
      await post(base, { ...body, refresh: true });
      assert.deepEqual([finds, prices, routes], [4, 4, 4]);
    });
  });

  test('discovery errors can be retried and malformed locations/fuels remain rejected', async () => {
    const deps = liveDeps();
    let fail = true;
    deps.stationProvider = { async find() {
      if (fail) throw new Error('temporarily offline');
      return { stations, source: { provider: 'stub' } };
    } };
    await withApp(deps, {}, async (base) => {
      const body = { start: START, fuel: 'e10', advice: false };
      assert.equal((await post(base, body)).status, 502);
      fail = false;
      assert.equal((await post(base, body)).status, 200);
      for (const change of [{ start: null }, { fuel: 'unknown' }, { radiusKm: 0 }]) {
        assert.equal((await post(base, { ...body, ...change })).status, 400);
      }
    });
  });

test('API: config, geocode, static files and security headers', async () => {
  await withApp(liveDeps(), {}, async (base) => {
    const cfg = await (await fetch(`${base}/api/config`)).json();
    assert.ok(cfg.fuels.find((f) => f.id === 'e10'));
    assert.equal(cfg.dataMode, undefined);
    assert.ok(!JSON.stringify(cfg).match(/key|secret|token/i));
    const g = await (await fetch(`${base}/api/geocode?q=51.1,4.2`)).json();
    assert.deepEqual(g.results[0], { label: '51.1, 4.2', lat: 51.1, lon: 4.2 });
    const g2 = await (await fetch(`${base}/api/geocode?q=Hoogstraten`)).json();
    assert.equal(g2.results[0].label, 'Hoogstraten, Flanders, Belgium'); // offline GeoNames index first
    assert.ok(g2.results.length >= 1 && g2.source !== 'GeoNames (CC BY 4.0)');
    const fast = await (await fetch(`${base}/api/geocode?q=Hoogstr&fast=1`)).json();
    assert.equal(fast.partial, true);
    assert.equal(fast.results[0].label, 'Hoogstraten, Flanders, Belgium');
    const html = await fetch(`${base}/`);
    assert.equal(html.status, 200);
    assert.match(html.headers.get('content-security-policy'), /default-src 'self'/);
    assert.equal((await fetch(`${base}/app.js`)).status, 200);
    assert.equal((await fetch(`${base}/..%2Fpackage.json`)).status, 403);
    assert.equal((await fetch(`${base}/%E0%A4%A`)).status, 400);
    assert.equal((await fetch(`${base}/api/nope`)).status, 404);
  });
});

test('navigationLinks: OSM links the start->station leg; Apple/geo target the station', () => {
  const s = { lat: 51.4, lon: 4.9, name: 'X & Y' };
  const n = navigationLinks({ lat: 51.5, lon: 4.8 }, s, null);
  assert.match(n.osm, /route=51\.500000%2C4\.800000%3B51\.400000%2C4\.900000$/);
  assert.match(n.geo, /X%20%26%20Y/);
  assert.match(n.apple, /saddr=51\.500000%2C4\.800000&daddr=51\.400000%2C4\.900000&dirflg=d/);
  assert.match(n.google, /origin=51\.500000%2C4\.800000.*destination=51\.400000%2C4\.900000/);
});

test('parseInput defaults radius and per-km cost', () => {
  const i = parseInput({ start: START, fuel: 'e10', litres: '30', consumption: '5.5' }, { searchRadiusKm: 20 });
  assert.equal(i.radiusKm, 20);
  assert.equal(i.perKmCost, 0);
  assert.equal(i.litres, 30);
});

test('default discovery grows beyond 22 km; an operator station cap is explicit', async () => {
  assert.equal(loadConfig({}).maxStationsPerCountry, 0);
  const start = { lat: 51, lon: 4 };
  const candidates = Array.from({ length: 35 }, (_, i) => ({
    id: `station${i}`, name: `Station ${i}`, country: 'NL', lat: 51 + (i + 1) / 111, lon: 4, tags: {},
  }));
  const deps = { ...liveDeps(), stationProvider: { async find() { return { stations: candidates, source: { provider: 'stub' } }; } } };
  await withApp(deps, {}, async (base) => {
    const body = { start, fuel: 'e10', advice: false };
    const small = await (await post(base, { ...body, radiusKm: 22 })).json();
    const large = await (await post(base, { ...body, radiusKm: 35 })).json();
    assert.ok(small.results.length > 12);
    assert.ok(large.results.length > small.results.length);
    assert.ok(large.assumptions.some((a) => /All eligible stations/.test(a)));
    assert.ok(!large.warnings.some((a) => /MAX_STATIONS_PER_COUNTRY/.test(a)));
  });
  await withApp(deps, { maxStationsPerCountry: 12 }, async (base) => {
    const d = await (await post(base, { start, fuel: 'e10', advice: false, radiusKm: 35, lang: 'nl' })).json();
    assert.equal(d.results.length, 12);
    assert.ok(d.warnings.some((a) => /MAX_STATIONS_PER_COUNTRY/.test(a)));
    assert.ok(d.assumptions.some((a) => /12 dichtstbijzijnde/.test(a)));
  });
});

test('parseInput: time value and minimum saving defaults and ranges', () => {
  const base = { start: START, fuel: 'e10', litres: '30', consumption: '5.5' };
  const cfg = { searchRadiusKm: 20, minWorthwhileSaving: 1 };
  const d = parseInput(base, cfg);
  assert.equal(d.timeValuePerHour, 0);
  assert.equal(d.minSaving, 1);
  const v = parseInput({ ...base, timeValuePerHour: '12', minSaving: '2.5' }, cfg);
  assert.equal(v.timeValuePerHour, 12);
  assert.equal(v.minSaving, 2.5);
  assert.throws(() => parseInput({ ...base, timeValuePerHour: '-1' }, cfg));
  assert.throws(() => parseInput({ ...base, timeValuePerHour: '1000' }, cfg));
  assert.throws(() => parseInput({ ...base, minSaving: '-1' }, cfg));
});

test('compare API: valuing time can turn a cash saving into "stay"', async () => {
  await withApp(liveDeps(), {}, async (base) => {
    const body = { start: START, fuel: 'e10', litres: 40, consumption: 6 };
    const cash = await (await post(base, body)).json();
    assert.equal(cash.recommendation.level, 'go');
    const be = cash.results.find((r) => r.country === 'BE');
    assert.equal(be.saving, be.cashSaving);
    const timed = await (await post(base, { ...body, timeValuePerHour: 12, minSaving: 50 })).json();
    assert.equal(timed.input.timeValuePerHour, 12);
    assert.equal(timed.input.minSaving, 50);
    assert.equal(timed.recommendation.level, 'stay');
    assert.match(timed.recommendation.detail, /below your €50\.00 minimum/);
    assert.ok(timed.assumptions.some((a) => /€2\.00 per 10 extra minutes/.test(a)));
  });
});

test('build label: CI value wins, local falls back to dev + file date', () => {
  const { buildLabel } = require('../src/server');
  const { version } = require('../package.json');
  assert.equal(buildLabel({ APP_BUILD: '2026-09-30 abc1234' }), `v${version} · 2026-09-30 abc1234`);
  assert.match(buildLabel({}), new RegExp(`^v${version.replace(/\./g, '\\.')} · dev( \\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2} UTC)?$`));
});

test('API geocode: official registers in fast and full mode; a failing register is ignored', async () => {
  const deps = liveDeps();
  deps.officialGeocoders = [
    { id: 'pdok', async search() { return [{ label: 'Kerkstraat, Tegelen, Netherlands', lat: 51.34, lon: 6.14 }]; } },
    { id: 'down', async search() { throw new Error('boom'); } },
  ];
  await withApp(deps, {}, async (base) => {
    const fast = await (await fetch(`${base}/api/geocode?q=kerkstraat&fast=1`)).json();
    assert.equal(fast.partial, true);
    assert.ok(fast.results.some((r) => r.label === 'Kerkstraat, Tegelen, Netherlands'));
    const full = await (await fetch(`${base}/api/geocode?q=kerkstraat`)).json();
    assert.ok(full.results.some((r) => r.label === 'Kerkstraat, Tegelen, Netherlands'));
    assert.ok(full.results.some((r) => r.label === 'kerkstraat'), 'photon/stub results still included');
  });
});
