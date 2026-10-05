'use strict';

// CARBU.COM provider tests. The HTML/JSON fixtures are small hand-written imitations of the page
// structure (no stored CARBU.COM data) and fetch is always a stub: no network request is made.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { loadConfig } = require('../src/config');
const { buildApp } = require('../src/server');
const {
  makeCarbuClient, makeCarbuPriceProvider, parseCarbuStationList, parseCarbuLocation, parseCarbuDate,
  postalCodeOf, decodeEntities, CARBU_FUEL_CODES,
} = require('../src/providers/carbu');
const { makeAnwbClient, makeAnwbPriceProvider } = require('../src/providers/anwb');

const T0 = Date.parse('2026-10-01T10:00:00Z');
const HOUR = 3600000;
const noThrottle = { run: (f) => f() };

function item({ id, lat, lng, name, fuelname = 'Super 95 (E10)', price, date, address = 'Straat 1<br/>2387 Baarle-Hertog' }) {
  const priced = price !== undefined && price !== '';
  return `
		<div class="station-content col-xs-12">
					<div
					id="item_${id}"
					data-lat="${lat}"
					data-lng="${lng}"
					data-id="${id}"
					data-logo=""
					data-name="${name}"
					data-fuelname="${priced ? fuelname : ''}"
					data-price="${priced ? price : ''}"
					data-distance="3.0319544912705"
					data-link="https://carbu.com/belgie/index.php/station/x/baarle-hertog/2387/${id}"
					data-address="${address}"
					class="stationItem panel panel-default">
					<div id="price_${id}" class="col-xs-3">
					${priced ? `<span style="font-size:0.6em">${fuelname}</span><span id="price_${id}">${String(price).replace('.', ',')} &euro;/L</span><br/><span class="visible-md">Update-datum: <br/>${date}</span><span>${date}</span>` : `<span id="price_${id}"></span>`}
					</div>
					<script>$(function(){ distance(1,2,${lat},${lng}); });</script>
					</div></div>`;
}

const LIST_HTML = `<!DOCTYPE html><html><head><title>Carbu</title></head><body>
<h2>Resultaten van uw zoekopdracht in Baarle-Hertog (2387)</h2>
<select><option value="https://carbu.com/belgie/index.php/liste-stations-service/E10/Baarle-Hertog/2387/BE_a_377?a=x">Sorteer</option></select>
<div class="stations-grid row">
${item({ id: 3439, lat: 51.431023, lng: 4.932036, name: 'Shell Baarle-Hertog', price: '2.088', date: '26/09/26', address: 'Turnhoutseweg 42<br/>2387 Baarle-Hertog' })}
${item({ id: 1465, lat: 51.393739, lng: 4.6, name: 'Gabri&euml;ls Wuustwezel', price: '1.999', date: '29/09/26', address: 'Bredabaan 1<br/>2990 Wuustwezel' })}
${item({ id: 1795, lat: 51.438107, lng: 4.931798, name: 'Tango Baarle-Hertog' })}
${item({ id: 901, lat: 51.40, lng: 4.95, name: 'Old Date', price: '1.899', date: '20/09/26' })}
${item({ id: 900, lat: 51.41, lng: 4.96, name: 'Very Old', price: '1.799', date: '01/08/26' })}
<div id="item_999" data-id="999" data-name="Broken no coordinates" data-price="1.5" class="stationItem"></div>
</div></body></html>`;

const LOCATION_JSON = [{ id: 'BE_a_377', ac: 'BE_a_377', n: 'Baarle-Hertog', pn: 'Anvers', c: 'BE', cn: 'Belgique', pc: '2387', rn: '' }];

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'carbu-test-'));
}

function cfg(over = {}) {
  return {
    ...loadConfig({}),
    carbuAck: true,
    carbuDataDir: tmpDir(),
    anwbAck: true,
    anwbDataDir: tmpDir(),
    rateLimitPerMin: 1000,
    ...over,
  };
}

function respondCarbu(url) {
  if (url.includes('getlocation')) return { status: 200, text: JSON.stringify(LOCATION_JSON) };
  if (url.includes('liste-stations-service')) return { status: 200, text: LIST_HTML };
  return { status: 404, text: '' };
}

function fakeFetch(respond = respondCarbu) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = respond(url, calls.length);
    if (r instanceof Error) throw r;
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k) => (r.headers || {})[k.toLowerCase()] || null },
      async text() { return r.text !== undefined ? r.text : JSON.stringify(r.body); },
      async json() { return r.body !== undefined ? r.body : JSON.parse(r.text); },
    };
  };
  fn.calls = calls;
  return fn;
}

function client(config, fetch, clock) {
  return makeCarbuClient(config, { fetch, now: () => clock.t, throttle: noThrottle });
}

const BE_ANCHOR = { id: 'anwb:be1', name: 'Shell', country: 'BE', lat: 51.4311, lon: 4.9321, address: 'Turnhoutseweg 42, 2387 Baarle-Hertog' };
const SEARCH = { fuelId: 'e10', start: { lat: 51.44, lon: 4.93 }, radiusKm: 20 };

// ------------------------------------------------------------------ parser + helpers
test('carbu parser: station cards, prices, price dates, entities, unpriced and broken items', () => {
  const s = parseCarbuStationList(LIST_HTML, '2026-10-01T10:00:00.000Z');
  assert.equal(s.length, 5, 'item without coordinates is skipped');
  const byId = Object.fromEntries(s.map((x) => [x.carbuId, x]));
  assert.deepEqual(
    { name: byId['3439'].name, address: byId['3439'].address, price: byId['3439'].price, fuel: byId['3439'].fuelName, date: byId['3439'].priceDate, lat: byId['3439'].lat, lon: byId['3439'].lon },
    { name: 'Shell Baarle-Hertog', address: 'Turnhoutseweg 42, 2387 Baarle-Hertog', price: 2.088, fuel: 'Super 95 (E10)', date: '2026-09-26', lat: 51.431023, lon: 4.932036 },
  );
  assert.equal(byId['1465'].name, 'Gabriëls Wuustwezel');
  assert.equal(byId['1465'].priceDate, '2026-09-29');
  assert.equal(byId['1795'].price, null);
  assert.equal(byId['1795'].priceDate, null);
  assert.equal(byId['3439'].distanceKm, 3.03);
  assert.match(byId['3439'].link, /^https:\/\/carbu\.com\/belgie\//);
  assert.deepEqual(parseCarbuStationList('<html>nothing</html>', 'x'), []);
});

test('carbu helpers: dates, location lookup, postal codes, entities, fuel codes', () => {
  assert.equal(parseCarbuDate('29/09/26'), '2026-09-29');
  assert.equal(parseCarbuDate('1/2/2026'), '2026-02-01');
  assert.equal(parseCarbuDate('31/02/26'), null);
  assert.equal(parseCarbuDate('2026-09-29'), null);
  assert.deepEqual(parseCarbuLocation(LOCATION_JSON, '2387'), { id: 'BE_a_377', town: 'Baarle-Hertog', postalCode: '2387' });
  assert.equal(parseCarbuLocation([{ id: 'FR_1', n: 'Paris', c: 'FR', pc: '75001' }], '75001'), null);
  assert.equal(parseCarbuLocation({}, '2387'), null);
  assert.equal(postalCodeOf({ address: 'Turnhoutseweg 42, 2387 Baarle-Hertog' }), '2387');
  assert.equal(postalCodeOf({ address: 'Main 5, B-2300 Turnhout' }), '2300');
  assert.equal(postalCodeOf({ address: null, tags: { 'addr:postcode': '2381' } }), '2381');
  assert.equal(postalCodeOf({ address: 'Teststraat 1' }), null);
  assert.equal(decodeEntities('Gabri&euml;ls &amp; Zn &#233; &#xe9; &bogus;'), 'Gabriëls & Zn é é &bogus;');
  assert.deepEqual(CARBU_FUEL_CODES, { e10: 'E10', e5_98: 'SP98', diesel: 'GO', lpg: 'GPL' });
});

test('config: CARBU.COM off by default, before ANWB in the price order, >= 1 s between requests', () => {
  const c = loadConfig({});
  assert.equal(c.carbuAck, false);
  assert.deepEqual(c.priceProviders, ['carbu', 'anwb', 'directlease', 'cbs-nl', 'fod-be']);
  assert.ok(c.carbuMinIntervalMs >= 1000);
  assert.match(c.carbuUserAgent, /tankwijzer.*private self-hosted.*CARBU\.COM/);
  assert.equal(loadConfig({ CARBU_PRIVATE_USE_ACK: 'true' }).carbuAck, true);
});

// ------------------------------------------------------------------ client
test('carbu client: not acknowledged or paused => no requests at all', async () => {
  for (const over of [{ carbuAck: false }, { carbuPaused: true }]) {
    const config = cfg(over);
    const f = fakeFetch();
    const p = makeCarbuPriceProvider(client(config, f, { t: T0 }), config);
    const ctx = await p.prefetch([BE_ANCHOR], SEARCH);
    assert.equal(f.calls.length, 0);
    assert.equal(p.stationPrice(BE_ANCHOR, 'e10', ctx), null);
    assert.ok(!fs.existsSync(path.join(config.carbuDataDir, 'state.json')), 'nothing written while disabled');
  }
});

test('carbu client: honest headers, one lookup + one list, cached within TTL, persisted across restarts', async () => {
  const config = cfg();
  const f = fakeFetch();
  const clock = { t: T0 };
  const p = makeCarbuPriceProvider(client(config, f, clock), config);
  const ctx = await p.prefetch([BE_ANCHOR], SEARCH);
  assert.equal(f.calls.length, 2);
  assert.match(f.calls[0].url, /^https:\/\/carbu\.com\/\/commonFunctions\/getlocation\/controller\.getlocation_JSON\.php\?location=2387&SHRT=1$/);
  assert.equal(f.calls[1].url, 'https://carbu.com/belgie//liste-stations-service/E10/Baarle-Hertog/2387/BE_a_377');
  const h = f.calls[1].opts.headers;
  assert.match(h['User-Agent'], /tankwijzer.*private self-hosted/);
  assert.equal(h.Referer, 'https://carbu.com/');
  assert.deepEqual(Object.keys(h).sort(), ['Accept', 'Referer', 'User-Agent']);
  assert.ok(ctx.results[BE_ANCHOR.id]);

  clock.t += 2 * HOUR;
  await p.prefetch([BE_ANCHOR], SEARCH);
  assert.equal(f.calls.length, 2, 'served from cache within TTL');

  // restart: location and list come from disk
  const f2 = fakeFetch();
  const p2 = makeCarbuPriceProvider(client(config, f2, clock), config);
  const ctx2 = await p2.prefetch([BE_ANCHOR], SEARCH);
  assert.equal(f2.calls.length, 0);
  assert.equal(ctx2.results[BE_ANCHOR.id].price, 2.088);

  // after TTL only the list is fetched again (location cached for 30 days)
  clock.t += 2 * HOUR;
  await p2.prefetch([BE_ANCHOR], SEARCH);
  assert.equal(f2.calls.length, 1);
  assert.match(f2.calls[0].url, /liste-stations-service/);

  // another fuel = another list with the CARBU fuel code
  await p2.prefetch([BE_ANCHOR], { ...SEARCH, fuelId: 'diesel' });
  assert.match(f2.calls[1].url, /liste-stations-service\/GO\//);
});

test('carbu client: 403 writes blocked.json, stops all requests, no cached reuse, survives restart', async () => {
  const config = cfg();
  const clock = { t: T0 };
  let deny = false;
  const f = fakeFetch((url) => (deny ? { status: 403, text: 'Forbidden' } : respondCarbu(url)));
  const p = makeCarbuPriceProvider(client(config, f, clock), config);
  await p.prefetch([BE_ANCHOR], SEARCH);
  deny = true;
  clock.t += 4 * HOUR; // cache expired, a refresh is attempted
  const ctx = await p.prefetch([BE_ANCHOR], SEARCH);
  assert.equal(f.calls.length, 3);
  assert.equal(p.stationPrice(BE_ANCHOR, 'e10', ctx), null, 'no cached price after a block');
  assert.ok(fs.existsSync(path.join(config.carbuDataDir, 'blocked.json')));
  assert.equal(ctx.status.reason, 'blocked');
  assert.ok(p.warnings(ctx, [BE_ANCHOR]).some((w) => /Do not change IP address, VPN or proxy/.test(w)));

  const f2 = fakeFetch();
  const p2 = makeCarbuPriceProvider(client(config, f2, clock), config);
  clock.t += 48 * HOUR;
  const ctx2 = await p2.prefetch([BE_ANCHOR], SEARCH);
  assert.equal(f2.calls.length, 0, 'still blocked after restart');
  assert.match(p2.missReason(BE_ANCHOR, 'e10', ctx2), /blocked/);
});

test('carbu client: 429 backs off >= 6 h, errors back off 30 min and keep the older list (marked stale)', async () => {
  const config = cfg();
  const clock = { t: T0 };
  let mode = 'ok';
  const f = fakeFetch((url) => (mode === '429' ? { status: 429, headers: { 'retry-after': '60' }, text: '' }
    : mode === '500' ? { status: 500, text: '' } : respondCarbu(url)));
  const c = client(config, f, clock);
  const p = makeCarbuPriceProvider(c, config);
  await p.prefetch([BE_ANCHOR], SEARCH);

  clock.t += 4 * HOUR;
  mode = '500';
  const ctx = await p.prefetch([BE_ANCHOR], SEARCH);
  const q = p.stationPrice(BE_ANCHOR, 'e10', ctx);
  assert.equal(q.price, 2.088);
  assert.equal(q.quality, 'stale-quote');
  assert.equal(q.live, false);
  let st = c.status();
  assert.equal(st.backoffReason, 'error');
  assert.equal(Date.parse(st.backoffUntil) - clock.t, 30 * 60000);
  const n = f.calls.length;
  await p.prefetch([BE_ANCHOR], SEARCH);
  assert.equal(f.calls.length, n, 'no request during back-off');

  clock.t += 31 * 60000;
  mode = '429';
  await p.prefetch([BE_ANCHOR], SEARCH);
  st = c.status();
  assert.equal(st.backoffReason, 'rate-limited');
  assert.ok(Date.parse(st.backoffUntil) - clock.t >= 6 * HOUR);
  assert.ok(!fs.existsSync(path.join(config.carbuDataDir, 'blocked.json')), '429 is not a block');

  clock.t += 30 * HOUR; // older than max age: not used any more
  mode = '500';
  const ctx3 = await p.prefetch([BE_ANCHOR], SEARCH);
  assert.equal(p.stationPrice(BE_ANCHOR, 'e10', ctx3), null);
});

test('carbu client: unexpected page (no station list) is an error, hourly budget is enforced', async () => {
  const config = cfg({ carbuHourlyBudget: 2 });
  const clock = { t: T0 };
  const f = fakeFetch((url) => (url.includes('getlocation') ? respondCarbu(url) : { status: 200, text: '<html>captcha?</html>' }));
  const c = client(config, f, clock);
  const p = makeCarbuPriceProvider(c, config);
  const ctx = await p.prefetch([BE_ANCHOR], SEARCH);
  assert.equal(p.stationPrice(BE_ANCHOR, 'e10', ctx), null);
  assert.match(c.status().lastError.message, /unexpected response/);
  clock.t += 31 * 60000;
  await p.prefetch([BE_ANCHOR], SEARCH);
  assert.equal(f.calls.length, 2, 'hourly budget of 2 reached: no third request');
  assert.ok(ctx.notes.length);
});

// ------------------------------------------------------------------ price provider
test('carbu price provider: position matching, BE only, price date, staleness by price date', async () => {
  const config = cfg();
  const clock = { t: T0 };
  const p = makeCarbuPriceProvider(client(config, fakeFetch(), clock), config);
  const stations = [
    BE_ANCHOR,
    { id: 'be-tango', country: 'BE', lat: 51.43812, lon: 4.9318, address: 'Molenstraat 90, 2387 Baarle-Hertog' },
    { id: 'be-old', country: 'BE', lat: 51.40005, lon: 4.95, address: null },
    { id: 'be-veryold', country: 'BE', lat: 51.41, lon: 4.96, address: null },
    { id: 'be-far', country: 'BE', lat: 51.42, lon: 4.99, address: null },
    { id: 'nl-1', country: 'NL', lat: 51.431023, lon: 4.932036, address: '5111 AA Baarle-Nassau' },
  ];
  const ctx = await p.prefetch(stations, SEARCH);
  const q = p.stationPrice(BE_ANCHOR, 'e10', ctx);
  assert.equal(q.price, 2.088);
  assert.equal(q.kind, 'station');
  assert.equal(q.quality, 'live-quote');
  assert.equal(q.estimate, false);
  assert.equal(q.source, 'CARBU.COM');
  assert.equal(q.priceDate, '2026-09-26');
  assert.equal(q.asOf, '2026-09-26');
  assert.equal(q.priceDateKnown, true);
  assert.ok(q.matchDistanceM < 50);
  assert.match(q.note, /price date 2026-09-26/);

  assert.equal(p.stationPrice(stations[1], 'e10', ctx), null);
  assert.match(p.missReason(stations[1], 'e10', ctx), /no current price/);
  const old = p.stationPrice(stations[2], 'e10', ctx);
  assert.equal(old.quality, 'stale-quote', 'price date > 7 days');
  assert.equal(p.stationPrice(stations[3], 'e10', ctx), null, 'price date > 30 days is not used');
  assert.equal(p.stationPrice(stations[4], 'e10', ctx), null);
  assert.match(p.missReason(stations[4], 'e10', ctx), /not found in CARBU\.COM list/);
  assert.equal(p.stationPrice(stations[5], 'e10', ctx), null, 'never used for NL stations');
  assert.equal(p.missReason(stations[5], 'e10', ctx), null);
});

// ------------------------------------------------------------------ fallback order + economics
function anwbRec(id, { lat, lon, iso3, title, postal, city, prices }) {
  return {
    id, type: 'FUEL_STATION', title,
    coordinates: { latitude: lat, longitude: lon },
    address: { streetAddress: 'Straat 1', postalCode: postal, city, iso3CountryCode: iso3 },
    prices: prices.map(([fuelType, value]) => ({ fuelType, fuelName: fuelType, value, currency: 'EUR' })),
  };
}
const ANWB = {
  value: [
    anwbRec('appitup_1', { lat: 51.445, lon: 4.93, iso3: 'NLD', title: 'NL Near', postal: '5111 AA', city: 'Baarle-Nassau', prices: [['EURO95', 2.2]] }),
    anwbRec('xavvy_a|BEL|1', { lat: 51.4311, lon: 4.9321, iso3: 'BEL', title: 'BE Shell', postal: '2387', city: 'Baarle-Hertog', prices: [['EURO95', 2.0]] }),
    anwbRec('xavvy_b|BEL|2', { lat: 51.425, lon: 4.99, iso3: 'BEL', title: 'BE Other', postal: '2387', city: 'Baarle-Hertog', prices: [['EURO95', 1.95]] }),
  ],
};

function appDeps(config, carbuRespond = respondCarbu, osmStations = []) {
  const fetchImpl = fakeFetch((url) => (url.includes('api.anwb.nl') ? { status: 200, body: ANWB } : carbuRespond(url)));
  const anwbClient = makeAnwbClient(config, { fetch: fetchImpl, throttle: noThrottle });
  const carbuClient = makeCarbuClient(config, { fetch: fetchImpl, throttle: noThrottle });
  const ref = (country, price, kind) => ({
    id: `stub-${country}`, country, label: `stub ${country}`,
    async reference() { return { price, kind, source: `stub ${country}`, sourceUrl: null, asOf: '2026-09-30', fetchedAt: null, live: false, note: '' }; },
    async status() { return { ok: true }; },
  });
  return {
    fetchImpl,
    deps: {
      anwbClient,
      carbuClient,
      priceProviders: [makeCarbuPriceProvider(carbuClient, config), makeAnwbPriceProvider(anwbClient), ref('NL', 2.3, 'national-average'), ref('BE', 2.108, 'legal-maximum')],
      fallbackStationProvider: { id: 'overpass', label: 'OSM', async find() { return { stations: osmStations, source: { provider: 'overpass' } }; } },
      router: {
        id: 'stub',
        async distances({ stations: st }) {
          return {
            mode: 'road', provider: 'stub',
            toStation: st.map((s) => (s.country === 'NL' ? 1 : 4)), fromStation: st.map((s) => (s.country === 'NL' ? 1 : 4)), baseTripKm: 0,
            toStationMin: st.map(() => 1), fromStationMin: st.map(() => 1), baseTripMin: 0,
          };
        },
      },
      geocoder: null,
    },
  };
}

async function compareWith(config, deps, body) {
  const { server } = buildApp(config, deps);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/api/compare`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 200);
    const prices = await (await fetch(`${base}/api/prices`)).json();
    return { d: await res.json(), prices };
  } finally {
    await new Promise((r) => server.close(r));
  }
}

const BODY = { start: { lat: 51.44, lon: 4.93 }, fuel: 'e10', litres: 40, consumption: 5, radiusKm: 20 };

test('compare + CARBU: CARBU.COM price wins for BE, ANWB fills unmatched BE and NL, economics use it', async () => {
  const config = cfg({ stationProvider: 'anwb' });
  const { deps } = appDeps(config);
  const { d, prices } = await compareWith(config, deps, BODY);
  const by = Object.fromEntries(d.results.map((r) => [r.name, r]));
  assert.equal(by['BE Shell'].price.provider, 'carbu');
  assert.equal(by['BE Shell'].price.price, 2.088);
  assert.equal(by['BE Shell'].price.priceDate, '2026-09-26');
  assert.equal(by['BE Other'].price.provider, 'anwb', 'not in CARBU list => ANWB quote');
  assert.equal(by['BE Other'].price.price, 1.95);
  assert.equal(by['NL Near'].price.provider, 'anwb');
  assert.ok(!d.results.some((r) => r.price.estimate));
  // NL baseline 40*2.2 + 2 km*0.05*2.2 = 88.22 ; BE Shell 40*2.088 + 8*0.05*2.088 = 84.355 => 3.86 (3.8648)
  assert.equal(by['BE Shell'].saving, 3.86);
  assert.equal(prices.providers.carbu.ok, true);
  assert.equal(prices.providers.carbu.requestsLast24h, 2);
});

test('compare + CARBU blocked: BE falls back to ANWB, then to the labelled BE estimate', async () => {
  const config = cfg({ stationProvider: 'anwb' });
  fs.writeFileSync(path.join(config.carbuDataDir, 'blocked.json'), JSON.stringify({ at: '2026-10-01T00:00:00Z', httpStatus: 403 }));
  const { deps, fetchImpl } = appDeps(config);
  const { d } = await compareWith(config, deps, BODY);
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes('carbu.com')), 'no CARBU request while blocked');
  const shell = d.results.find((r) => r.name === 'BE Shell');
  assert.equal(shell.price.provider, 'anwb');
  assert.equal(shell.price.price, 2.0);
  assert.ok(d.warnings.some((w) => /CARBU\.COM blocked/.test(w)));

  // CARBU blocked AND ANWB blocked (OSM stations) => labelled country ESTIMATE for BE, never a station price
  fs.writeFileSync(path.join(config.anwbDataDir, 'blocked.json'), JSON.stringify({ at: '2026-10-01T00:00:00Z', httpStatus: 403 }));
  const osm = [{ id: 'osm:b1', name: 'OSM BE', country: 'BE', lat: 51.4311, lon: 4.9321, address: 'Turnhoutseweg 42, 2387 Baarle-Hertog', tags: {} }];
  const { deps: deps2, fetchImpl: f2 } = appDeps(config, respondCarbu, osm);
  const { d: d2 } = await compareWith(config, deps2, BODY);
  assert.equal(f2.calls.length, 0);
  assert.equal(d2.results.length, 1);
  const r = d2.results[0];
  assert.equal(r.price.estimate, true);
  assert.equal(r.price.quality, 'country-estimate');
  assert.equal(r.price.price, 2.108);
  assert.match(r.price.fallbackReason, /CARBU\.COM blocked/);
  assert.match(r.price.fallbackReason, /ANWB/);
});

test('compare + CARBU not enabled: no CARBU requests and no CARBU warnings', async () => {
  const config = cfg({ stationProvider: 'anwb', carbuAck: false });
  const { deps, fetchImpl } = appDeps(config);
  const { d } = await compareWith(config, deps, BODY);
  assert.ok(!fetchImpl.calls.some((c) => c.url.includes('carbu.com')));
  assert.ok(!d.warnings.some((w) => /CARBU/.test(w)));
  assert.equal(d.results.find((r) => r.name === 'BE Shell').price.provider, 'anwb');
});
