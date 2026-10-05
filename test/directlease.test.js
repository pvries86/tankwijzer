'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig } = require('../src/config');
const { buildApp } = require('../src/server');
const { makeDirectLeaseProvider, directLeaseQuote } = require('../src/providers/prices');

const START = { lat: 51.44, lon: 4.93, label: 'Baarle' };
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();

// Response shape of the sidecar's POST /quotes (see sidecar/directlease/core.py)
function dlResult(fuels, { fetchedAt = hoursAgo(1), reason = null, parsed = 'raw', codes = {} } = {}) {
  return { match: { siteId: 'directlease_1', name: '', brand: 'Test', distanceM: 20 }, fuels, codes, parsed, fetchedAt, fresh: true, reason };
}

const cfg = { ...loadConfig({}), directLeaseUrl: 'http://dl.invalid:8090', directLeaseAck: true };

function stubHttp(handler) {
  const calls = [];
  return {
    calls,
    async json(url, opts = {}) {
      calls.push({ url, opts });
      return handler(url, opts);
    },
  };
}

// ---------------------------------------------------------------- mapping
test('directlease mapping: by product key, premium grades never used for regular fuel', () => {
  const r = dlResult({
    e10: { price: 2.539, name: 'Euro 95 (E10)' },
    diesel: { price: 2.589, name: 'Diesel (B7)' },
    diesel_special: { price: 2.809, name: 'Premium Diesel (B7)' },
    euro98: { price: 2.869, name: 'Euro 98 (E5)' },
  });
  assert.deepEqual(directLeaseQuote(r, 'diesel'), { price: 2.589, product: 'Diesel (B7)' });
  assert.equal(directLeaseQuote(r, 'e10').price, 2.539);
  assert.equal(directLeaseQuote(r, 'e5_98').price, 2.869);
  assert.equal(directLeaseQuote(r, 'lpg'), null);
  // premium only -> no regular diesel price
  assert.equal(directLeaseQuote(dlResult({ diesel_special: { price: 2.8, name: 'Premium Diesel (B7)' } }), 'diesel'), null);
  assert.equal(directLeaseQuote({ match: null, reason: 'no-directlease-station-nearby' }, 'e10'), null);
});

test('directlease mapping: library-code fallback only for unambiguous codes', () => {
  const r = dlResult({}, { parsed: 'library-codes', codes: { E10: 2.1, B7: 2.8, E5: 2.9 } });
  assert.equal(directLeaseQuote(r, 'e10').price, 2.1);
  assert.equal(directLeaseQuote(r, 'diesel'), null); // B7 may be premium diesel
  assert.equal(directLeaseQuote(r, 'e5_98'), null); // E5 may be 95 or 98
});

test('directlease provider: freshness labelling and stale rejection', () => {
  const p = makeDirectLeaseProvider({ ...cfg, directLeaseMaxAgeH: 36 }, stubHttp(() => ({})));
  const st = { id: 'a' };
  const ctx = (h) => ({ results: { a: dlResult({ e10: { price: 2, name: 'Euro 95 (E10)' } }, { fetchedAt: hoursAgo(h) }) } });
  const fresh = p.stationPrice(st, 'e10', ctx(2));
  assert.equal(fresh.quality, 'live-quote');
  assert.equal(fresh.live, true);
  assert.equal(fresh.estimate, false);
  assert.equal(fresh.kind, 'station');
  assert.equal(fresh.asOf, null); // the source does not report its own price timestamp
  assert.match(fresh.source, /DirectLease/);
  assert.match(fresh.license, /do not redistribute/i);
  const stale = p.stationPrice(st, 'e10', ctx(30));
  assert.equal(stale.quality, 'stale-quote');
  assert.equal(stale.live, false);
  assert.equal(p.stationPrice(st, 'e10', ctx(40)), null);
  assert.match(p.missReason(st, 'e10', ctx(40)), /older than 36 h/);
  assert.equal(p.stationPrice(st, 'e10', ctx(-1 / 3600)).live, true);
});

test('directlease provider: miss reasons and warnings', () => {
  const p = makeDirectLeaseProvider(cfg, stubHttp(() => ({})));
  const st = { id: 'a' };
  assert.match(p.missReason(st, 'e10', { error: 'ECONNREFUSED' }), /unavailable/);
  assert.match(p.missReason(st, 'e10', { results: { a: { match: null, reason: 'no-directlease-station-nearby' } } }), /within 150 m/);
  const notFetched = { match: { siteId: 'x', distanceM: 5 }, fuels: {}, fetchedAt: null, reason: 'daily-budget' };
  assert.match(p.missReason(st, 'e10', { results: { a: notFetched } }), /daily request budget/);
  assert.match(p.missReason(st, 'lpg', { results: { a: dlResult({ e10: { price: 2, name: 'x' } }) } }), /no price for this fuel/);

  const blocked = p.warnings({ status: { blocked: { at: '2026-09-29T10:00:00Z', reason: '403' } }, results: {} });
  assert.equal(blocked.length, 1);
  assert.match(blocked[0], /DirectLease blocked \(403\)/);
  const paused = p.warnings({ status: { blocked: { at: '2026-09-29T10:00:00Z', paused: true, reason: 'operator' } }, results: {} });
  assert.match(paused[0], /DirectLease paused/);
  assert.doesNotMatch(paused[0], /blocked \(403\)/);
  assert.match(blocked[0], /will not be retried/);
  assert.match(blocked[0], /Do not change IP address, VPN or proxy/);
  assert.match(blocked[0], /contact App It Up/);
  assert.match(p.warnings({ error: 'timeout' })[0], /unreachable/);
  const budget = p.warnings({ status: { dailyBudget: 200 }, results: { a: notFetched } });
  assert.match(budget[0], /daily request budget reached \(200/);
});

test('directlease provider: prefetch posts station points to the sidecar only', async () => {
  const http = stubHttp(() => ({ results: {}, status: { ok: true } }));
  const p = makeDirectLeaseProvider({ ...cfg, directLeaseTimeoutMs: 1234 }, http);
  await p.prefetch([{ id: 'osm:1', lat: 51.1, lon: 4.9, name: 'x', tags: { secret: 1 } }]);
  assert.equal(http.calls.length, 1);
  assert.equal(http.calls[0].url, 'http://dl.invalid:8090/quotes');
  assert.equal(http.calls[0].opts.method, 'POST');
  assert.equal(http.calls[0].opts.timeoutMs, 1234);
  assert.deepEqual(JSON.parse(http.calls[0].opts.body), { points: [{ id: 'osm:1', lat: 51.1, lon: 4.9 }] });
  assert.deepEqual(await p.prefetch([]), { results: {}, status: null });
  assert.equal(http.calls.length, 1);
});

// ---------------------------------------------------------------- compare integration
function refProvider(country, price, kind) {
  return {
    id: `stub-${country}`, country, label: `stub ${country}`,
    async reference() { return { price, kind, source: `stub ${country}`, sourceUrl: null, asOf: '2026-09-30', fetchedAt: null, live: false, note: '' }; },
    async status() { return { ok: true }; },
  };
}

const stations = [
  { id: 'nl1', name: 'NL Near', country: 'NL', lat: 51.445, lon: 4.93, tags: {} },
  { id: 'be1', name: 'BE Far', country: 'BE', lat: 51.40, lon: 4.93, tags: {} },
  { id: 'be2', name: 'BE Mid', country: 'BE', lat: 51.41, lon: 4.93, tags: {} },
];

const stubRouter = {
  id: 'stub',
  async distances({ stations: st }) {
    const km = { nl1: 1, be1: 5, be2: 3 };
    return {
      mode: 'road', provider: 'stub',
      toStation: st.map((s) => km[s.id]), fromStation: st.map((s) => km[s.id]), baseTripKm: 0,
      toStationMin: st.map(() => 1), fromStationMin: st.map(() => 1), baseTripMin: 0,
    };
  },
};

async function compareWith(dlHandler, body = {}) {
  const config = { ...cfg, rateLimitPerMin: 1000 };
  const deps = {
    stationProvider: { id: 'stub', async find() { return { stations, source: { provider: 'stub' } }; } },
    priceProviders: [
      makeDirectLeaseProvider(config, stubHttp(dlHandler)),
      refProvider('NL', 2.4, 'national-average'),
      refProvider('BE', 2.0, 'legal-maximum'),
    ],
    router: stubRouter,
    geocoder: { id: 'stub', async search() { return []; } },
  };
  const { server } = buildApp(config, deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/compare`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: START, fuel: 'e10', litres: 40, consumption: 6, ...body }),
    });
    assert.equal(res.status, 200);
    return await res.json();
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const q = (price) => dlResult({ e10: { price, name: 'Euro 95 (E10)' } });

test('compare+directlease: live quotes drive economics; missing stations fall back to labelled estimates', async () => {
  const d = await compareWith(() => ({
    status: { ok: true, blocked: null },
    results: { nl1: q(2.3), be1: { match: null, reason: 'no-directlease-station-nearby' }, be2: q(2.1) },
  }));
  const nl1 = d.results.find((r) => r.id === 'nl1');
  const be1 = d.results.find((r) => r.id === 'be1');
  const be2 = d.results.find((r) => r.id === 'be2');
  assert.equal(nl1.price.price, 2.3);
  assert.equal(nl1.price.quality, 'live-quote');
  assert.equal(nl1.price.provider, 'directlease');
  // be1: no DirectLease match -> BE legal maximum, explicitly an estimate with the reason
  assert.equal(be1.price.kind, 'legal-maximum');
  assert.equal(be1.price.estimate, true);
  assert.equal(be1.price.quality, 'country-estimate');
  assert.match(be1.price.fallbackReason, /no matching DirectLease station/);
  // economics use the quoted prices: baseline nl1 = 40*2.3 + 0.12*2.3 = 92.276 ; be2 = 84 + 0.36*2.1 = 84.756
  assert.equal(be2.saving, 7.52);
  assert.ok(d.warnings.some((w) => /1 of 3 stations .* country ESTIMATE/.test(w)));
  assert.equal(d.sources.prices.directlease.ok, true);
  // be1 (estimate, 2.0 legal max) ranks first: 80 + 0.6*2 = 81.2 -> recommendation must flag it
  assert.equal(d.recommendation.stationId, 'be1');
  assert.equal(d.recommendation.confidence, 'medium');
  assert.match(d.recommendation.headline, /estimated price/);
  assert.deepEqual(d.recommendation.quotedAlternative, { id: 'be2', name: 'BE Mid', country: 'BE', saving: 7.52 });
  assert.ok(d.recommendation.caveats.some((c) => /indicative/.test(c)));
});

test('compare+directlease: all stations quoted -> high confidence, no estimate caveats', async () => {
  const d = await compareWith(() => ({ status: { ok: true }, results: { nl1: q(2.3), be1: q(1.95), be2: q(2.1) } }));
  assert.equal(d.recommendation.confidence, 'high');
  assert.equal(d.recommendation.stationId, 'be1');
  assert.doesNotMatch(d.recommendation.headline, /estimated/);
  assert.ok(!d.recommendation.caveats.some((c) => /estimate/i.test(c)));
  assert.ok(d.results.every((r) => r.price.estimate === false));
  assert.ok(!d.warnings.some((w) => /ESTIMATE/.test(w)));
});

test('compare+directlease: blocked sidecar -> no station quotes, explicit no-circumvention warning, estimates', async () => {
  const d = await compareWith(() => ({
    status: { ok: false, blocked: { at: '2026-09-29T10:00:00Z', reason: 'HTTP 403' } },
    results: { nl1: { match: { siteId: 'x', distanceM: 3 }, fuels: {}, fetchedAt: null, reason: 'blocked' } },
  }));
  assert.ok(d.results.every((r) => r.price.estimate === true));
  assert.ok(d.results.every((r) => /blocked/.test(r.price.fallbackReason)));
  assert.ok(d.warnings.some((w) => /DirectLease blocked \(403\)/.test(w) && /Do not change IP/.test(w)));
  assert.equal(d.sources.prices.directlease.blocked.reason, 'HTTP 403');
  assert.ok(d.results.every((r) => r.price.estimate && r.price.quality === 'country-estimate'));
  assert.equal(d.recommendation.confidence, 'low');
});

test('compare+directlease: unreachable sidecar -> app keeps working with estimates', async () => {
  const d = await compareWith(() => { throw new Error('connect ECONNREFUSED'); });
  assert.equal(d.results.length, 3);
  assert.ok(d.results.every((r) => r.price.estimate === true && /unavailable/.test(r.price.fallbackReason)));
  assert.ok(d.warnings.some((w) => /unreachable/.test(w)));
  assert.equal(d.sources.prices.directlease.ok, false);
});

test('compare+directlease: stale quote beyond max age is not used as station price', async () => {
  const old = dlResult({ e10: { price: 1.5, name: 'Euro 95 (E10)' } }, { fetchedAt: hoursAgo(48) });
  const d = await compareWith(() => ({ status: { ok: true }, results: { nl1: q(2.3), be1: old, be2: q(2.1) } }));
  const be1 = d.results.find((r) => r.id === 'be1');
  assert.equal(be1.price.kind, 'legal-maximum');
  assert.match(be1.price.fallbackReason, /older than/);
});

test('directlease provider: not acknowledged -> no sidecar contact, no warning, no station quotes', async () => {
  const http = stubHttp(() => { throw new Error('must not be called'); });
  const p = makeDirectLeaseProvider({ ...cfg, directLeaseAck: false }, http);
  const pre = await p.prefetch([{ id: 'a', lat: 51.1, lon: 4.9 }]);
  assert.equal(pre.status.reason, 'not-acknowledged');
  assert.deepEqual(p.warnings(pre, [], 'en'), []);
  assert.equal(p.missReason({ id: 'a' }, 'e10', pre), null);
  assert.deepEqual(await p.status(), { ok: false, reason: 'not-acknowledged' });
  assert.equal(http.calls.length, 0);
});

test('directlease provider: paused -> no sidecar contact, one paused warning', async () => {
  const http = stubHttp(() => { throw new Error('must not be called'); });
  const p = makeDirectLeaseProvider({ ...cfg, directLeasePaused: true }, http);
  const pre = await p.prefetch([{ id: 'a', lat: 51.1, lon: 4.9 }]);
  assert.equal(pre.status.reason, 'paused');
  const w = p.warnings(pre, [], 'en');
  assert.equal(w.length, 1);
  assert.match(w[0], /DirectLease paused/);
  assert.equal((await p.status()).reason, 'paused');
  assert.equal(http.calls.length, 0);
});

test('compare+directlease: without ACK the sidecar is never contacted and estimates are used', async () => {
  const config = { ...cfg, directLeaseAck: false, rateLimitPerMin: 1000 };
  let called = 0;
  const { server } = buildApp(config, {
    stationProvider: { id: 'stub', async find() { return { stations, source: { provider: 'stub' } }; } },
    priceProviders: [makeDirectLeaseProvider(config, stubHttp(() => { called++; return {}; })), refProvider('NL', 2.4, 'national-average'), refProvider('BE', 2.0, 'legal-maximum')],
    router: stubRouter, geocoder: { id: 's', async search() { return []; } },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const d = await (await fetch(`http://127.0.0.1:${server.address().port}/api/compare`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ start: START, fuel: 'e10', litres: 40, consumption: 6 }),
    })).json();
    assert.equal(called, 0);
    assert.ok(d.results.length > 0);
    assert.ok(d.results.every((r) => r.price.provider !== 'directlease'));
    assert.ok(!d.warnings.some((w) => /DirectLease/.test(w)));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('config: DirectLease is in the default list but off without ACK; still configurable', () => {
  const c = loadConfig({});
  assert.equal(c.directLeaseAck, false);
  assert.equal(c.directLeasePaused, false);
  assert.equal(loadConfig({ DIRECTLEASE_PRIVATE_USE_ACK: 'true' }).directLeaseAck, true);
  assert.deepEqual(c.priceProviders, ['station-file', 'carbu', 'anwb', 'directlease', 'cbs-nl', 'fod-be']);
  assert.deepEqual(loadConfig({ PRICE_PROVIDERS: 'station-file,directlease,cbs-nl,fod-be' }).priceProviders,
    ['station-file', 'directlease', 'cbs-nl', 'fod-be']);
  assert.equal(c.directLeaseMaxAgeH, 36);
  assert.equal(loadConfig({ DIRECTLEASE_URL: 'http://directlease:8090' }).directLeaseUrl, 'http://directlease:8090');
});
