'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFodMaxPricePdf, decodePdfString } = require('../src/providers/fodPdf');
const { parseCbsRecords, makeStationFileProvider } = require('../src/providers/prices');
const { parseOverpassResponse, buildOverpassQuery, selectStations } = require('../src/providers/stations');
const { stationFuelAvailability, getFuel } = require('../src/fuels');
const { parseLatLon, makeHaversineRouter, makePhotonGeocoder, photonLabel } = require('../src/providers/routing');
const { TtlCache, Throttle } = require('../src/cache');

test('photon geocoder: prefix results, readable labels, country filter, location bias, cached', async () => {
  const calls = [];
  const feat = (props, lon, lat) => ({ type: 'Feature', geometry: { type: 'Point', coordinates: [lon, lat] }, properties: props });
  const http = {
    async json(url) {
      calls.push(url);
      return { features: [
        feat({ name: 'Bilthoven', state: 'Utrecht', country: 'Netherlands', countrycode: 'NL', type: 'city' }, 5.2046, 52.1290),
        feat({ name: 'Bilthovenseweg', city: 'De Bilt', postcode: '3732', state: 'Utrecht', country: 'Netherlands', countrycode: 'NL', type: 'street' }, 5.17, 52.10),
        feat({ name: 'Bilbao', state: 'Basque Country', country: 'Spain', countrycode: 'ES', type: 'city' }, -2.93, 43.26),
        feat({ name: 'Somewhere', country: 'United States', countrycode: 'US', type: 'city' }, -80, 40),
      ] };
    },
  };
  const g = makePhotonGeocoder({ photonUrl: 'https://photon.test', geocodeCountries: 'nl,be,es' }, http, new TtlCache(), new Throttle(0));
  const r = await g.search('biltho', { near: { lat: 52.129, lon: 5.2 } });
  assert.deepEqual(r.map((x) => x.label), [
    'Bilthoven, Utrecht, Netherlands',
    'Bilthovenseweg, 3732 De Bilt, Utrecht, Netherlands',
    'Bilbao, Basque Country, Spain',
  ]);
  assert.deepEqual([r[0].lat, r[0].lon], [52.129, 5.2046]);
  const u = new URL(calls[0]);
  assert.equal(u.pathname, '/api/');
  assert.equal(u.searchParams.get('q'), 'biltho');
  assert.equal(u.searchParams.get('lat'), '52.1');
  assert.equal(u.searchParams.get('lon'), '5.2');
  await g.search('Biltho', { near: { lat: 52.13, lon: 5.21 } });
  assert.equal(calls.length, 1, 'same query + rounded bias is served from cache');
  assert.equal(photonLabel({ name: 'Kleine Beer 1', street: 'Kleine Beer', housenumber: '1', city: 'Bilthoven', postcode: '3721RH', country: 'Netherlands', type: 'house' }),
    'Kleine Beer 1, 3721RH Bilthoven, Netherlands');
});

/** Build a tiny PDF resembling the FOD layout: one Flate stream with positioned Tj text. */
function fakeFodPdf(rows) {
  const ops = [];
  rows.forEach((cells, r) => {
    const y = 700 - r * 20;
    cells.forEach((c, i) => ops.push(`BT 1 0 0 1 ${50 + i * 80} ${y} Tm (${c.replace(/[()\\]/g, '\\$&')})Tj ET`));
  });
  const stream = zlib.deflateSync(Buffer.from(ops.join('\n'), 'latin1'));
  return Buffer.concat([
    Buffer.from('%PDF-1.4\n1 0 obj <</Length ' + stream.length + ' /Filter /FlateDecode>>\nstream\n', 'latin1'),
    stream,
    Buffer.from('\nendstream\nendobj\n2 0 obj <</Length 5>>\nstream\nhello\nendstream\nendobj\n%%EOF', 'latin1'),
  ]);
}

test('FOD PDF parser extracts list number, validity and pump prices incl. VAT', () => {
  const pdf = fakeFodPdf([
    ['Lijst nr:', '2026/188'],
    ['geldig vanaf :', '30/09/2026'],
    ['Benzine 98 RON E5', 'aan de pomp', 'l', '1,8314 (-0,0876)', '21', '2,216 (-0,106)'],
    ['Benzine 95 RON E10', 'aan de pomp', 'l', '1,662 (-0,0801)', '21', '2,011 (-0,097)'],
    ['Diesel B7', 'aan de pomp', 'l', '2,0025 (+0,01)', '21', '2,423 (+0,012)'],
    ['Diesel B7', 'in bulk', 'l', '1,5', '21', '1,815'],
    ['Autogas LPG', 'aan de pomp', 'l', '0,8033', '21', '0,972'],
  ]);
  const r = parseFodMaxPricePdf(pdf);
  assert.equal(r.validFrom, '2026-09-30');
  assert.equal(r.listNo, '2026/188');
  assert.deepEqual(r.prices, { e5_98: 2.216, e10: 2.011, diesel: 2.423, lpg: 0.972 });
});

test('FOD PDF parser returns no prices for unrelated PDFs', () => {
  const r = parseFodMaxPricePdf(fakeFodPdf([['Hello world']]));
  assert.deepEqual(r.prices, {});
  assert.equal(r.validFrom, null);
});

test('decodePdfString handles escapes and octal', () => {
  assert.equal(decodePdfString('a\\(b\\)\\\\c\\351'), 'a(b)\\c\u00e9');
});

test('CBS parser picks the latest non-empty value per fuel', () => {
  const latest = parseCbsRecords({
    value: [
      { Perioden: '20260920', BenzineEuro95_1: 2.4, Diesel_2: 2.1, Lpg_3: 0.9 },
      { Perioden: '20260921', BenzineEuro95_1: 2.449, Diesel_2: null, Lpg_3: 0.946 },
      { Perioden: '2026MM09', BenzineEuro95_1: 9 },
    ],
  });
  assert.deepEqual(latest, {
    e10: { date: '2026-09-21', value: 2.449 },
    diesel: { date: '2026-09-20', value: 2.1 },
    lpg: { date: '2026-09-21', value: 0.946 },
  });
  assert.deepEqual(parseCbsRecords(null), {});
});

test('fuel availability mapping from OSM tags', () => {
  assert.equal(stationFuelAvailability({ 'fuel:diesel': 'yes' }, 'diesel'), 'yes');
  assert.equal(stationFuelAvailability({ 'fuel:diesel': 'no' }, 'diesel'), 'no');
  assert.equal(stationFuelAvailability({}, 'diesel'), 'unknown');
  assert.equal(stationFuelAvailability({}, 'lpg'), 'no');
  assert.equal(stationFuelAvailability({ 'fuel:lpg': 'yes' }, 'lpg'), 'yes');
  assert.equal(stationFuelAvailability({ 'fuel:octane_95': 'no', 'fuel:e10': 'yes' }, 'e10'), 'yes');
  assert.equal(stationFuelAvailability({}, 'nope'), 'no');
  assert.match(getFuel('e10').local.NL, /Euro95/);
  assert.match(getFuel('e10').local.BE, /E10/);
});

test('Overpass response is split into NL and BE by the count separator', () => {
  const s = parseOverpassResponse({
    elements: [
      { type: 'node', id: 1, lat: 51.4, lon: 4.9, tags: { name: 'A', 'addr:street': 'Weg', 'addr:housenumber': '1', 'addr:city': 'Baarle' } },
      { type: 'way', id: 2, center: { lat: 51.41, lon: 4.91 }, tags: { brand: 'Shell' } },
      { type: 'count', id: 0, tags: { total: '2' } },
      { type: 'node', id: 3, lat: 51.3, lon: 4.8, tags: {} },
      { type: 'node', id: 4, tags: {} },
    ],
  });
  assert.deepEqual(s.map((x) => [x.id, x.country, x.name]), [
    ['osm:node/1', 'NL', 'A'], ['osm:way/2', 'NL', 'Shell'], ['osm:node/3', 'BE', 'Fuel station'],
  ]);
  assert.equal(s[0].address, 'Weg 1, Baarle');
});

test('Overpass query covers start (and destination corridor) for both countries', () => {
  const q = buildOverpassQuery({ start: { lat: 51.4, lon: 4.9 }, destination: { lat: 51.2, lon: 4.4 }, radiusKm: 15 });
  assert.match(q, /around:15000,51\.40000,4\.90000,51\.20000,4\.40000/);
  assert.match(q, /area\.nl/);
  assert.match(q, /out count;/);
  assert.match(q, /area\.be/);
});

test('selectStations filters unavailable/private stations and caps per country', () => {
  const start = { lat: 51.4, lon: 4.9 };
  const mk = (id, country, lat, tags = {}) => ({ id, country, lat, lon: 4.9, tags });
  const out = selectStations([
    mk('n1', 'NL', 51.41), mk('n2', 'NL', 51.42), mk('n3', 'NL', 51.43),
    mk('b1', 'BE', 51.39), mk('b2', 'BE', 51.38, { 'fuel:diesel': 'no' }), mk('b3', 'BE', 51.37, { access: 'private' }),
    mk('n1', 'NL', 51.41),
  ], { start, fuelId: 'diesel', maxPerCountry: 2 });
  assert.deepEqual(out.map((s) => s.id), ['n1', 'n2', 'b1']);
});

test('selectStations drops stations outside the search radius (e.g. from whole ANWB tiles)', () => {
  const start = { lat: 52.13, lon: 5.2 }; // Bilthoven
  const out = selectStations([
    { id: 'near', country: 'NL', lat: 52.15, lon: 5.2, tags: {} },
    { id: 'kranenburg', country: 'DE', lat: 51.8074, lon: 5.9624, tags: {} }, // ~62 km
  ], { start, fuelId: 'e10', maxPerCountry: 5, radiusKm: 20 });
  assert.deepEqual(out.map((s) => s.id), ['near']);
  const route = selectStations([{ id: 'kranenburg', country: 'DE', lat: 51.8074, lon: 5.9624, tags: {} }],
    { start, destination: { lat: 51.82, lon: 6.1 }, fuelId: 'e10', maxPerCountry: 5, radiusKm: 20 });
  assert.equal(route.length, 1, 'kept when it lies near the route');
});

test('parseLatLon', () => {
  assert.deepEqual(parseLatLon('51.44, 4.93'), { lat: 51.44, lon: 4.93 });
  assert.deepEqual(parseLatLon('51.44 4.93'), { lat: 51.44, lon: 4.93 });
  assert.equal(parseLatLon('Baarle-Nassau'), null);
  assert.equal(parseLatLon('95, 4'), null);
});

test('haversine router: round trip vs route', async () => {
  const r = makeHaversineRouter({ roadFactor: 1 });
  const start = { lat: 51, lon: 4 };
  const st = [{ lat: 51.1, lon: 4 }];
  const rt = await r.distances({ start, stations: st });
  assert.equal(rt.baseTripKm, 0);
  assert.ok(Math.abs(rt.toStation[0] - rt.fromStation[0]) < 1e-9);
  const route = await r.distances({ start, destination: { lat: 51.2, lon: 4 }, stations: st });
  assert.ok(Math.abs(route.toStation[0] + route.fromStation[0] - route.baseTripKm) < 1e-6);
});

test('station price file: match by id or coordinates, reject stale entries', () => {
  const file = path.join(os.tmpdir(), `bf-prices-${process.pid}.json`);
  const now = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify({
    source: 'test',
    prices: [
      { stationId: 'osm:node/1', fuel: 'e10', price: 1.9, observedAt: now },
      { lat: 51.5, lon: 4.5, fuel: 'e10', price: 1.8, observedAt: now },
      { stationId: 'osm:node/3', fuel: 'e10', price: 1.7, observedAt: '2020-01-01T00:00:00Z' },
    ],
  }));
  try {
    const p = makeStationFileProvider({ stationPriceFile: file, stationPriceMaxAgeH: 48 });
    assert.equal(p.stationPrice({ id: 'osm:node/1', lat: 0, lon: 0 }, 'e10').price, 1.9);
    assert.equal(p.stationPrice({ id: 'osm:node/1', lat: 0, lon: 0 }, 'e10').kind, 'station');
    assert.equal(p.stationPrice({ id: 'x', lat: 51.5003, lon: 4.5 }, 'e10').price, 1.8);
    assert.equal(p.stationPrice({ id: 'x', lat: 51.51, lon: 4.5 }, 'e10'), null);
    assert.equal(p.stationPrice({ id: 'osm:node/3', lat: 0, lon: 0 }, 'e10'), null);
    assert.equal(p.stationPrice({ id: 'osm:node/1', lat: 0, lon: 0 }, 'diesel'), null);
  } finally {
    fs.unlinkSync(file);
  }
  const missing = makeStationFileProvider({ stationPriceFile: file, stationPriceMaxAgeH: 48 });
  assert.equal(missing.stationPrice({ id: 'osm:node/1' }, 'e10'), null);
});
