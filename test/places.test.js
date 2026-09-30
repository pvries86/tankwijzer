'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makePlaceIndex, mergeResults } = require('../src/providers/places');

const TSV = [
  '# header',
  'p\tMaastricht\tMaestricht\tLimburg\tNL\t50.8483\t5.6889\t122378',
  'p\tThe Hague\tDen Haag|La Haye\tSouth Holland\tNL\t52.0767\t4.2986\t474292',
  'p\tKöln\tCologne|Keulen\tNorth Rhine-Westphalia\tDE\t50.9333\t6.9500\t1024621',
  'p\tVenlo\t\tLimburg\tNL\t51.3704\t6.1724\t101000',
  'p\tVenray\t\tLimburg\tNL\t51.5258\t5.9750\t43000',
  'p\tHasselt\t\tFlanders\tBE\t50.9307\t5.3378\t77000',
  'p\tHasselt\t\tOverijssel\tNL\t52.5917\t6.0917\t7000',
  'p\tMadrid\t\tMadrid\tES\t40.4165\t-3.7026\t3255944',
  'z\t6221\tMaastricht\tLimburg\tNL\t50.8475\t5.7029\t0',
  'z\t3500\tHasselt\tVlaanderen\tBE\t50.9307\t5.3378\t0',
].join('\n');
const idx = (countries = 'nl,be,de') => makePlaceIndex({ geocodeCountries: countries }, { text: TSV });

test('places: prefix, diacritics and translated names match instantly', () => {
  const i = idx();
  assert.equal(i.search('maas')[0].label, 'Maastricht, Limburg, Netherlands');
  assert.equal(i.search('koln')[0].label, 'Köln, North Rhine-Westphalia, Germany');
  assert.equal(i.search('keulen')[0].label, 'Keulen (Köln), North Rhine-Westphalia, Germany');
  assert.equal(i.search('den haag')[0].label, 'Den Haag (The Hague), South Holland, Netherlands');
  assert.deepEqual(i.search('ven').map((r) => r.label.split(',')[0]), ['Venlo', 'Venray']);
  assert.deepEqual(i.search('x'), []);
  assert.deepEqual(i.search('stationsplein'), []);
});

test('places: country filter, region narrowing and location bias', () => {
  const i = idx();
  assert.deepEqual(i.search('madrid'), []); // ES not in GEOCODE_COUNTRIES
  assert.equal(i.search('hasselt overijssel')[0].label, 'Hasselt, Overijssel, Netherlands');
  assert.equal(i.search('hasselt belgie')[0].label, 'Hasselt, Flanders, Belgium');
  assert.equal(i.search('hasselt', { near: { lat: 52.5, lon: 6.1 } })[0].label, 'Hasselt, Overijssel, Netherlands');
  assert.equal(i.search('hasselt', { near: { lat: 50.9, lon: 5.4 } })[0].label, 'Hasselt, Flanders, Belgium');
});

test('places: 4-digit postcodes, also with letters or a place name', () => {
  const i = idx();
  for (const q of ['6221', '622', '6221bt', '6221 BT', '6221 maas']) {
    assert.equal(i.search(q)[0].label, '6221 Maastricht, Limburg, Netherlands', q);
  }
  assert.equal(i.search('3500')[0].label, '3500 Hasselt, Vlaanderen, Belgium');
  assert.deepEqual(i.search('6221 venlo'), []);
});

test('mergeResults: priority order, caps, and the same place from several sources only once', () => {
  const local = idx().search('maastricht');
  const registers = [
    { label: 'Maastricht, Netherlands', lat: 50.851, lon: 5.69 }, // same town as the offline hit
    { label: 'Stationsplein, Maastricht, Netherlands', lat: 50.8496, lon: 5.7051 },
  ];
  const photon = [
    { label: 'Maastricht, Limburg, Netherlands', lat: 50.85, lon: 5.69 },
    { label: 'Stationsplein, 6221 BT Maastricht, Limburg, Netherlands', lat: 50.8497, lon: 5.7052 }, // same street, 15 m
    { label: 'Maastricht Aachen Airport, Beek', lat: 50.91, lon: 5.77 },
  ];
  const out = mergeResults([{ items: local, cap: 3 }, { items: registers, cap: 4 }, { items: photon }]);
  assert.deepEqual(out.map((r) => r.label), [
    'Maastricht, Limburg, Netherlands', 'Stationsplein, Maastricht, Netherlands', 'Maastricht Aachen Airport, Beek',
  ]);
  assert.ok(out.every((r) => Object.keys(r).join() === 'label,lat,lon'));
  const many = Array.from({ length: 9 }, (_, i) => ({ label: `Straat ${i}, X`, lat: 50 + i, lon: 5 }));
  assert.equal(mergeResults([{ items: many, cap: 2 }, { items: [{ label: 'Y', lat: 1, lon: 1 }] }]).length, 3);
  assert.equal(mergeResults([{ items: many }]).length, 7);
});

test('places: bundled data file loads and answers fast', () => {
  const i = makePlaceIndex({ geocodeCountries: 'nl,be,de' });
  i.search('warmup');
  const t0 = process.hrtime.bigint();
  const r = i.search('eindh');
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.match(r[0].label, /^Eindhoven, North Brabant, Netherlands/);
  assert.ok(ms < 100, `took ${ms} ms`);
});
