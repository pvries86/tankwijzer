'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../public/vehicle-calc');
const {
  mapVehicle, mapRecalls, makeRdwClient, RdwError, BASIS_DATASET, FUEL_DATASET,
  RECALL_STATUS_DATASET, RECALL_DETAIL_DATASET, RECALL_RISK_DATASET, BODY_DATASET, AXLE_DATASET,
} = require('../src/providers/rdw');
const { TtlCache } = require('../src/cache');
const { loadConfig } = require('../src/config');
const { buildApp } = require('../src/server');

// Fictional plates only (valid format, not real vehicles in docs/tests).
const basis = (over = {}) => ({ kenteken: 'XX999X', merk: 'TESTMERK', handelsbenaming: 'MODEL', inrichting: 'hatchback', voertuigsoort: 'Personenauto', datum_eerste_toelating: '20190315', massa_rijklaar: '1180', ...over });
const fuel = (over = {}) => ({ kenteken: 'XX999X', brandstof_volgnummer: '1', brandstof_omschrijving: 'Benzine', nettomaximumvermogen: '81.00', ...over });

test('kenteken display formatting follows sidecode runs', () => {
  assert.equal(calc.formatKenteken('xx999x'), 'XX-999-X');
  assert.equal(calc.formatKenteken('XX99XX'), 'XX-99-XX');
  assert.equal(calc.formatKenteken('9XXX99'), '9-XXX-99');
  assert.equal(calc.formatKenteken('XXXX99'), 'XX-XX-99');
  assert.equal(calc.formatKenteken('99XXXX'), '99-XX-XX');
  assert.equal(calc.formatKenteken('XX9'), 'XX9', 'incomplete input untouched');
});

test('kenteken normalisation, validation and masking', () => {
  assert.equal(calc.normalizeKenteken(' xx-999-x '), 'XX999X');
  assert.equal(calc.normalizeKenteken('ab.12.cd'), 'AB12CD');
  assert.equal(calc.normalizeKenteken(null), '');
  assert.ok(calc.isValidKenteken('XX999X'));
  assert.ok(calc.isValidKenteken('1ABC23'));
  assert.ok(!calc.isValidKenteken('ABCDEF'), 'needs a digit');
  assert.ok(!calc.isValidKenteken('XX999'), 'too short');
  assert.ok(!calc.isValidKenteken('XX9999X'), 'too long');
  assert.ok(!calc.isValidKenteken('XX99?X'));
  assert.equal(calc.maskKenteken('xx-999-x'), 'XX**9X');
  assert.equal(calc.maskKenteken('ab'), '***');
});

test('mapVehicle: petrol with WLTP', () => {
  const v = mapVehicle(basis(), [fuel({ brandstof_verbruik_gecombineerd_wltp: '5.40', emissie_co2_gecombineerd_wltp: '123' })]);
  assert.equal(v.fuelId, 'e10');
  assert.equal(v.fuelSupport, 'ok');
  assert.deepEqual(v.consumption, { value: 5.4, source: 'wltp' });
  assert.deepEqual(v.tank, { value: 50, source: 'range', rangeKm: 920, consumption: 5.4 });
  assert.equal(v.year, 2019);
  assert.equal(v.firstAdmission, '2019-03-15');
  assert.equal(v.powerKw, 81);
  assert.equal(v.powerPk, 110);
  assert.deepEqual(v.warnings, []);
});

test('mapVehicle: diesel with NEDC fallback', () => {
  const v = mapVehicle(basis({ massa_rijklaar: '1600' }), [fuel({ brandstof_omschrijving: 'Diesel', brandstofverbruik_gecombineerd: '4.1' })]);
  assert.equal(v.fuelId, 'diesel');
  assert.deepEqual(v.consumption, { value: 4.1, source: 'nedc' });
  assert.equal(v.tank.value, 50, '980 km × 1.2 × 4.1 L/100 = 48 L → 50');
  assert.equal(v.tank.rangeKm, 1176);
});

test('mapVehicle: missing consumption is estimated from CO2 per fuel', () => {
  const p = mapVehicle(basis(), [fuel({ co2_uitstoot_gecombineerd: '119' })]);
  assert.equal(p.consumption.source, 'co2');
  assert.equal(p.consumption.value, 5.0);
  assert.equal(p.consumption.co2Cycle, 'nedc');
  const d = mapVehicle(basis(), [fuel({ brandstof_omschrijving: 'Diesel', emissie_co2_gecombineerd_wltp: '133' })]);
  assert.equal(d.consumption.value, 5.0);
  assert.equal(d.consumption.co2Cycle, 'wltp');
  const none = mapVehicle(basis(), [fuel()]);
  assert.deepEqual(none.consumption, { value: null, source: null });
});

test('mapVehicle: non-plug-in hybrid uses the petrol row and has no PHEV warning', () => {
  const v = mapVehicle(basis(), [
    fuel({ brandstof_volgnummer: '2', brandstof_omschrijving: 'Elektriciteit', klasse_hybride_elektrisch_voertuig: 'NOVC-HEV' }),
    fuel({ brandstof_volgnummer: '1', klasse_hybride_elektrisch_voertuig: 'NOVC-HEV', brandstof_verbruik_gecombineerd_wltp: '4.3' }),
  ]);
  assert.deepEqual(v.fuels, ['Benzine', 'Elektriciteit']);
  assert.equal(v.fuelId, 'e10');
  assert.equal(v.hybridClass, 'NOVC-HEV');
  assert.equal(v.consumption.value, 4.3);
  assert.ok(!v.warnings.includes('phev'));
});

test('mapVehicle: plug-in hybrid warns', () => {
  const v = mapVehicle(basis(), [
    fuel({ klasse_hybride_elektrisch_voertuig: 'OVC-HEV', brandstof_verbruik_gecombineerd_wltp: '1.4' }),
    fuel({ brandstof_volgnummer: '2', brandstof_omschrijving: 'Elektriciteit', klasse_hybride_elektrisch_voertuig: 'OVC-HEV' }),
  ]);
  assert.ok(v.warnings.includes('phev'));
  assert.equal(v.fuelSupport, 'ok');
  assert.deepEqual(v.tank, { value: 42, source: 'weight' }, 'PHEV lab value is meaningless for tank size');
});

test('mapVehicle: electric-only is not prefilled', () => {
  const v = mapVehicle(basis(), [fuel({ brandstof_omschrijving: 'Elektriciteit', nettomaximumvermogen: undefined, netto_max_vermogen_elektrisch: '150' })]);
  assert.equal(v.fuelSupport, 'electric');
  assert.equal(v.fuelId, null);
  assert.equal(v.tank.value, null);
  assert.deepEqual(v.consumption, { value: null, source: null });
  assert.deepEqual(v.warnings, ['electric']);
  assert.equal(v.powerKw, 150);
});

test('mapVehicle: unsupported fuel (e.g. hydrogen) and missing fuel rows', () => {
  assert.equal(mapVehicle(basis(), [fuel({ brandstof_omschrijving: 'Waterstof' })]).fuelSupport, 'unsupported');
  const v = mapVehicle(basis(), []);
  assert.equal(v.fuelSupport, 'unsupported');
  assert.deepEqual(v.warnings, ['unsupported-fuel']);
});

test('mapVehicle: bi-fuel LPG prefers LPG and warns', () => {
  const v = mapVehicle(basis(), [fuel({ co2_uitstoot_gecombineerd: '140' }), fuel({ brandstof_volgnummer: '2', brandstof_omschrijving: 'LPG', co2_uitstoot_gecombineerd: '125' })]);
  assert.equal(v.fuelId, 'lpg');
  assert.ok(v.warnings.includes('bifuel-lpg'));
  assert.equal(v.consumption.value, 7.8);
});

test('mapVehicle: missing mass gives no tank estimate', () => {
  const v = mapVehicle(basis({ massa_rijklaar: undefined }), [fuel()]);
  assert.deepEqual(v.tank, { value: null, source: null });
  assert.equal(v.massaRijklaar, null);
});

test('CO2 estimate and tank heuristic boundaries', () => {
  assert.equal(calc.estimateFromCo2(0, 'e10'), null);
  assert.equal(calc.estimateFromCo2(120, 'electric'), null);
  assert.equal(calc.estimateTank(1049), 35);
  assert.equal(calc.estimateTank(1050), 42);
  assert.equal(calc.estimateTank(1249), 42);
  assert.equal(calc.estimateTank(1250), 52);
  assert.equal(calc.estimateTank(1500), 52);
  assert.equal(calc.estimateTank(1501), 60);
  assert.equal(calc.estimateTank(null), null);
});

test('tank from range × lab consumption', () => {
  // Light petrol car: 750 km × 4.8 = 36 L → 35.
  assert.equal(calc.estimateTankFromRange(1000, 4.8, 'e10').value, 35);
  // Full hybrid with low lab consumption: 920 km × 3.8 = 35 L.
  const hyb = calc.estimateTankFromRange(1350, 3.8, 'e10');
  assert.deepEqual(hyb, { value: 35, rangeKm: 920, consumption: 3.8, theoretical: 35 });
  // Diesel correction: same car would get 42 L on petrol, 50 L as diesel (range ×1.2).
  assert.equal(calc.estimateTankFromRange(1450, 4.5, 'e10').value, 42);
  const d = calc.estimateTankFromRange(1450, 4.5, 'diesel');
  assert.equal(d.rangeKm, 1104);
  assert.equal(d.value, 50);
  // Heavy, thirsty car clamps at 80 L; very frugal small car never below 35 (smallest snap size).
  assert.equal(calc.estimateTankFromRange(2300, 9.5, 'e10').value, 80);
  assert.equal(calc.estimateTankFromRange(1000, 2.0, 'e10').value, 35);
  // Range boundaries.
  assert.equal(calc.targetRangeKm(1099, 'e10'), 750);
  assert.equal(calc.targetRangeKm(1100, 'e10'), 920);
  assert.equal(calc.targetRangeKm(1600, 'e10'), 980);
  assert.equal(calc.targetRangeKm(2000, 'e10'), 1050);
  // Missing inputs.
  assert.equal(calc.estimateTankFromRange(1200, null, 'e10'), null);
  assert.equal(calc.estimateTankFromRange(null, 5, 'e10'), null);
  assert.equal(calc.rangeKm(50, 6.2), 806);
  assert.equal(calc.rangeKm(0, 6), null);
});

test('mapVehicle: missing consumption falls back to the weight heuristic', () => {
  const v = mapVehicle(basis(), [fuel()]);
  assert.deepEqual(v.tank, { value: 42, source: 'weight' });
  const co2 = mapVehicle(basis(), [fuel({ emissie_co2_gecombineerd_wltp: '131' })]);
  assert.equal(co2.tank.source, 'range', 'CO2-estimated consumption also feeds the range model');
  assert.equal(co2.tank.consumption, 5.5);
});

test('litres to buy from tank × level', () => {
  assert.equal(calc.litresToBuy(50, 25), 38);
  assert.equal(calc.litresToBuy(50, 0), 50);
  assert.equal(calc.litresToBuy(50, 100), 0);
  assert.equal(calc.litresToBuy(50, 150), 0);
  assert.equal(calc.litresToBuy(50, -10), 50);
  assert.equal(calc.litresToBuy(0, 25), null);
  assert.equal(calc.litresToBuy('', 25), null);
});

test('realism uplift and override precedence', () => {
  assert.equal(calc.applyUplift(5.4, 15, true), 6.2);
  assert.equal(calc.applyUplift(5.4, 15, false), 5.4);
  assert.equal(calc.applyUplift(5.4, 25, true), 6.8);
  assert.deepEqual(calc.resolveConsumption({ lab: 5.4, upliftPct: 15, upliftEnabled: true }), { value: 6.2, origin: 'rdw', uplifted: true });
  assert.deepEqual(calc.resolveConsumption({ lab: 5.4, upliftPct: 15, upliftEnabled: false }), { value: 5.4, origin: 'rdw', uplifted: false });
  assert.deepEqual(calc.resolveConsumption({ manual: '7', lab: 5.4, upliftPct: 15, upliftEnabled: true }), { value: 7, origin: 'manual', uplifted: false });
  assert.deepEqual(calc.resolveConsumption({ manual: '', lab: null }), { value: null, origin: 'none', uplifted: false });
  assert.deepEqual(calc.resolveLitres({ manual: '30', tankL: 50, levelPct: 25 }), { value: 30, origin: 'manual' });
  assert.deepEqual(calc.resolveLitres({ manual: '', tankL: 50, levelPct: 25 }), { value: 38, origin: 'tank' });
  assert.deepEqual(calc.resolveLitres({ tankL: null, levelPct: 25 }), { value: null, origin: 'none' });
});

function fakeHttp(responder) {
  const calls = [];
  return {
    calls,
    async json(url, opts) {
      calls.push({ url, headers: (opts && opts.headers) || {} });
      return responder(url);
    },
  };
}

const EXTRA_DATASETS = [RECALL_STATUS_DATASET, RECALL_DETAIL_DATASET, RECALL_RISK_DATASET, BODY_DATASET, AXLE_DATASET];
const okResponder = (url) => {
  if (url.includes(BASIS_DATASET)) return [basis()];
  if (EXTRA_DATASETS.some((d) => url.includes(d))) return [];
  return [fuel({ brandstof_verbruik_gecombineerd_wltp: '5.4' })];
};

test('rdw client: lookup, cache, not-found, upstream errors', async () => {
  const http = fakeHttp(okResponder);
  const client = makeRdwClient({ rdwUrl: 'https://rdw.test/' }, http, new TtlCache(10));
  const a = await client.lookup('xx-999-x');
  assert.equal(a.cached, false);
  assert.equal(a.source, 'RDW Open Data (CC0)');
  assert.ok(http.calls.some((c) => c.url === `https://rdw.test/resource/${FUEL_DATASET}.json?kenteken=XX999X`));
  const b = await client.lookup('XX999X');
  assert.equal(b.cached, true);
  assert.equal(http.calls.length, 5, 'basis, fuel + 3 extra datasets; second lookup served from cache');

  await assert.rejects(client.lookup('ABCDEF'), (e) => e instanceof RdwError && e.code === 'invalid' && e.status === 400);

  const nf = fakeHttp(() => []);
  const c2 = makeRdwClient({}, nf, new TtlCache(10));
  await assert.rejects(c2.lookup('YY111Y'), (e) => e.code === 'not-found' && e.status === 404);
  await assert.rejects(c2.lookup('YY111Y'), (e) => e.code === 'not-found');
  assert.equal(nf.calls.length, 5, 'not-found is cached');

  const err = (status) => fakeHttp(() => { const e = new Error('boom'); e.status = status; throw e; });
  await assert.rejects(makeRdwClient({}, err(429), new TtlCache(10)).lookup('XX999X'), (e) => e.code === 'rate-limited' && e.status === 429);
  await assert.rejects(makeRdwClient({}, err(503), new TtlCache(10)).lookup('XX999X'), (e) => e.code === 'unavailable' && e.status === 502);
});

async function withApp(env, http, fn) {
  const config = { ...loadConfig({}), rateLimitPerMin: 1000, ...env };
  const { server } = buildApp(config, { http, places: null, geocoder: null, officialGeocoders: [] });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('/api/kenteken route: success, errors, app token stays server-side', async () => {
  const http = fakeHttp((url) => {
    if (url.includes('kenteken=ZZ000Z')) return [];
    if (url.includes('kenteken=QQ500Q')) { const e = new Error('down'); e.status = 500; throw e; }
    return okResponder(url);
  });
  await withApp({ rdwAppToken: 'secret-token-123' }, http, async (base) => {
    const ok = await fetch(`${base}/api/kenteken?k=xx-999-x`);
    assert.equal(ok.status, 200);
    const { vehicle } = await ok.json();
    assert.equal(vehicle.fuelId, 'e10');
    assert.equal(vehicle.consumption.value, 5.4);
    assert.equal(http.calls[0].headers['X-App-Token'], 'secret-token-123');

    assert.equal((await fetch(`${base}/api/kenteken?k=ABCDEF`)).status, 400);
    const nf = await fetch(`${base}/api/kenteken?k=ZZ000Z`);
    assert.equal(nf.status, 404);
    assert.equal((await nf.json()).code, 'not-found');
    const down = await fetch(`${base}/api/kenteken?k=QQ500Q`);
    assert.equal(down.status, 502);
    assert.equal((await down.json()).code, 'unavailable');

    const cfgText = await (await fetch(`${base}/api/config`)).text();
    assert.ok(!cfgText.includes('secret-token-123'));
    assert.equal(JSON.parse(cfgText).vehicle.kentekenLookup, true);
    assert.equal(JSON.parse(cfgText).vehicle.realismUpliftPct, 15);
  });
});

test('/api/kenteken route: disabled and own rate limit', async () => {
  await withApp({ kentekenLookup: false }, fakeHttp(okResponder), async (base) => {
    const r = await fetch(`${base}/api/kenteken?k=XX999X`);
    assert.equal(r.status, 501);
    assert.equal((await r.json()).code, 'disabled');
    assert.equal((await (await fetch(`${base}/api/config`)).json()).vehicle.kentekenLookup, false);
  });
  await withApp({}, fakeHttp(okResponder), async (base) => {
    let last;
    for (let i = 0; i < 21; i++) last = await fetch(`${base}/api/kenteken?k=XX999X`);
    assert.equal(last.status, 429);
    assert.equal((await last.json()).code, 'rate-limited');
  });
});

test('vehicleAttention: why the collapsed vehicle panel must open', () => {
  const ok = { consumption: '6', litres: '30' };
  assert.equal(calc.vehicleAttention(ok), null);
  assert.equal(calc.vehicleAttention({ ...ok, warnings: ['electric'] }), 'electric');
  assert.equal(calc.vehicleAttention({ ...ok, warnings: ['unsupported-fuel'] }), 'unsupported-fuel');
  assert.equal(calc.vehicleAttention({ ...ok, warnings: ['bifuel-lpg', 'phev'] }), 'phev');
  assert.equal(calc.vehicleAttention({ ...ok, warnings: ['bifuel-lpg'] }), null);
  assert.equal(calc.vehicleAttention({ ...ok, lookupFailed: true }), 'lookup-failed');
  assert.equal(calc.vehicleAttention({ ...ok, warnings: ['phev'], lookupFailed: true }), 'phev');
  assert.equal(calc.vehicleAttention({ consumption: '', litres: '30' }), 'consumption');
  assert.equal(calc.vehicleAttention({ consumption: '0', litres: '30' }), 'consumption');
  assert.equal(calc.vehicleAttention({ consumption: '51', litres: '30' }), 'consumption');
  assert.equal(calc.vehicleAttention({ consumption: '6,5', litres: '30' }), null);
  assert.equal(calc.vehicleAttention({ consumption: '6', litres: '' }), 'litres');
  assert.equal(calc.vehicleAttention({ consumption: '6', litres: '0.5' }), 'litres');
  assert.equal(calc.vehicleAttention({ consumption: '6', litres: '201' }), 'litres');
  assert.equal(calc.vehicleAttention({ consumption: '6', litres: 'abc' }), 'litres');
  assert.equal(calc.vehicleAttention({ consumption: '20', litres: '30', consMax: 15 }), 'consumption');
});

test('apkStatus thresholds and todayAmsterdam', () => {
  const t = '2025-06-15';
  assert.equal(calc.apkStatus('2025-06-14', t).level, 'expired');
  assert.equal(calc.apkStatus('2025-06-14', t).days, -1);
  assert.equal(calc.apkStatus('2025-06-15', t).level, 'soon');
  assert.equal(calc.apkStatus('2025-07-15', t).level, 'soon');
  assert.equal(calc.apkStatus('2025-07-15', t).days, 30);
  assert.equal(calc.apkStatus('2025-07-16', t).level, 'upcoming');
  assert.equal(calc.apkStatus('2025-08-14', t).level, 'upcoming');
  assert.equal(calc.apkStatus('2025-08-15', t).level, 'ok');
  assert.equal(calc.apkStatus(null, t).level, 'unknown');
  assert.equal(calc.apkStatus('garbage', t).level, 'unknown');
  // 23:30 UTC on 31 Dec is already 1 Jan in Amsterdam
  assert.equal(calc.todayAmsterdam(new Date('2024-12-31T23:30:00Z')), '2025-01-01');
});

test('driveFromAxles: derived from aangedreven_as J/N', () => {
  const ax = (n, j) => ({ as_nummer: String(n), ...(j === undefined ? {} : { aangedreven_as: j }) });
  assert.equal(calc.driveFromAxles([ax(1, 'J'), ax(2, 'J')]), 'awd');
  assert.equal(calc.driveFromAxles([ax(1, 'J'), ax(2, 'N')]), 'fwd');
  assert.equal(calc.driveFromAxles([ax(1, 'N'), ax(2, 'J')]), 'rwd');
  assert.equal(calc.driveFromAxles([ax(1), ax(2)]), 'unknown');
  assert.equal(calc.driveFromAxles([]), 'unknown');
  assert.equal(calc.driveFromAxles(null), 'unknown');
});

test('mapRecalls: open (O) with details + risks, resolved (P) only counted', () => {
  const r = mapRecalls(
    [
      { referentiecode_rdw: 'RC-1', code_status: 'O', status: 'Openstaande terugroepactie' },
      { referentiecode_rdw: 'RC-1', code_status: 'O' },
      { referentiecode_rdw: 'RC-2', code_status: 'P', status: 'Producent heeft herstel gemeld' },
      { referentiecode_rdw: 'RC-3', code_status: 'P' },
    ],
    [{ referentiecode_rdw: 'RC-1', omschrijving_defect: 'Defect X', beschrijving_van_het_herstel: 'Vervangen', meer_informatie_op_internet: '(Nog) niet bekend', publicatiedatum_rdw: '20240102' }],
    [{ referentiecode_rdw: 'RC-1', mogelijk_gevaar: 'Brand' }, { referentiecode_rdw: 'RC-1', mogelijk_gevaar: 'Letsel' }],
  );
  assert.equal(r.open.length, 1);
  assert.deepEqual(r.open[0], { code: 'RC-1', status: 'Openstaande terugroepactie', defect: 'Defect X', remedy: 'Vervangen', infoUrl: null, published: '2024-01-02', risks: ['Brand', 'Letsel'] });
  assert.equal(r.resolvedCount, 2);
  assert.deepEqual(r.resolvedCodes, ['RC-2', 'RC-3']);
  const bare = mapRecalls([{ referentiecode_rdw: 'RC-9', code_status: 'O' }]);
  assert.equal(bare.open[0].defect, null);
  assert.deepEqual(bare.open[0].risks, []);
  assert.equal(mapRecalls(null).open.length, 0);
});

const extrasResponder = (over = {}) => (url) => {
  for (const [ds, fn] of Object.entries(over)) if (url.includes(ds)) return fn(url);
  if (url.includes(BASIS_DATASET)) return [basis({ vervaldatum_apk: '20280930', aantal_deuren: '5', eerste_kleur: 'GRIJS' })];
  if (url.includes(RECALL_STATUS_DATASET)) return [{ referentiecode_rdw: 'RC-1', code_status: 'O', status: 'Openstaande terugroepactie' }, { referentiecode_rdw: 'RC-2', code_status: 'P' }];
  if (url.includes(RECALL_DETAIL_DATASET)) return [{ referentiecode_rdw: 'RC-1', omschrijving_defect: 'Defect X', meer_informatie_op_internet: 'https://example.test/rc1' }];
  if (url.includes(RECALL_RISK_DATASET)) return [{ referentiecode_rdw: 'RC-1', mogelijk_gevaar: 'Brand' }];
  if (url.includes(BODY_DATASET)) return [{ carrosserie_volgnummer: '1', carrosserietype: 'AB', type_carrosserie_europese_omschrijving: 'Hatchback' }];
  if (url.includes(AXLE_DATASET)) return [{ as_nummer: '1', aangedreven_as: 'J' }, { as_nummer: '2', aangedreven_as: 'N' }];
  return [fuel({ brandstof_verbruik_gecombineerd_wltp: '5.4', uitlaatemissieniveau: 'EURO 6' })];
};
const boom = (status) => () => { const e = new Error('x'); e.status = status; throw e; };

test('rdw client: extras mapped (APK, recalls, body, drive, doors, colour, emission)', async () => {
  const http = fakeHttp(extrasResponder());
  const v = await makeRdwClient({}, http, new TtlCache(10)).lookup('XX999X');
  assert.equal(v.fuelId, 'e10');
  assert.equal(v.extras.apkExpiry, '2028-09-30');
  assert.equal(v.extras.doors, 5);
  assert.equal(v.extras.color, 'GRIJS');
  assert.equal(v.extras.emissionClass, 'EURO 6');
  assert.deepEqual(v.extras.body, { code: 'AB', description: 'Hatchback' });
  assert.equal(v.extras.drive, 'fwd');
  assert.equal(v.extras.recalls.open.length, 1);
  assert.equal(v.extras.recalls.open[0].infoUrl, 'https://example.test/rc1');
  assert.deepEqual(v.extras.recalls.open[0].risks, ['Brand']);
  assert.equal(v.extras.recalls.resolvedCount, 1);
  assert.deepEqual(v.extras.missing, []);
  const detailCall = http.calls.find((c) => c.url.includes(RECALL_DETAIL_DATASET));
  assert.ok(decodeURIComponent(detailCall.url).includes("referentiecode_rdw in('RC-1')"), 'details only for open recalls');
});

test('rdw client: failing extra datasets give a partial profile, never a failed lookup', async () => {
  const warn = console.warn; const logged = []; console.warn = (m) => logged.push(m);
  try {
    const http = fakeHttp(extrasResponder({ [RECALL_STATUS_DATASET]: boom(500), [BODY_DATASET]: boom(429), [AXLE_DATASET]: () => { throw new TypeError('network'); } }));
    const v = await makeRdwClient({}, http, new TtlCache(10)).lookup('XX999X');
    assert.equal(v.fuelId, 'e10');
    assert.equal(v.extras.recalls, null);
    assert.equal(v.extras.body, null);
    assert.equal(v.extras.drive, 'unknown');
    assert.deepEqual(v.extras.missing.sort(), ['body', 'drive', 'recalls']);
    assert.equal(v.extras.apkExpiry, '2028-09-30', 'basis-derived extras survive');

    const http2 = fakeHttp(extrasResponder({ [RECALL_DETAIL_DATASET]: boom(503), [RECALL_RISK_DATASET]: boom(503) }));
    const v2 = await makeRdwClient({}, http2, new TtlCache(10)).lookup('XX999X');
    assert.equal(v2.extras.recalls.open.length, 1, 'open recall still reported without details');
    assert.equal(v2.extras.recalls.open[0].defect, null);
    assert.deepEqual(v2.extras.missing.sort(), ['recall-details', 'recall-risks']);
    assert.ok(logged.length && logged.every((m) => !m.includes('XX999X')), 'no full plate in logs');
  } finally { console.warn = warn; }
});
