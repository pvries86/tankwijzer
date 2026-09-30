'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detourKm, optionCost, breakEven, compareOptions, validateInputs, round } = require('../src/economics');

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

test('detourKm: round trip counts both legs', () => {
  assert.equal(detourKm({ startToStationKm: 12, stationToEndKm: 11.5 }), 23.5);
});

test('detourKm: along a route only the extra part counts', () => {
  // start -> dest = 100 km, via station = 103 km -> 3 km detour
  assert.equal(detourKm({ startToStationKm: 40, stationToEndKm: 63, baseTripKm: 100 }), 3);
});

test('detourKm: station on the route gives zero, routing asymmetry never negative', () => {
  assert.equal(detourKm({ startToStationKm: 40, stationToEndKm: 60, baseTripKm: 100 }), 0);
  assert.equal(detourKm({ startToStationKm: 40, stationToEndKm: 59.8, baseTripKm: 100 }), 0);
});

test('detourKm rejects invalid distances', () => {
  assert.throws(() => detourKm({ startToStationKm: -1, stationToEndKm: 1 }), RangeError);
  assert.throws(() => detourKm({ startToStationKm: NaN, stationToEndKm: 1 }), RangeError);
});

test('optionCost: fuel plus detour fuel valued at station price plus per-km cost', () => {
  const c = optionCost({ price: 2, detourKm: 20, litres: 40, consumptionL100: 5, perKmCost: 0.1 });
  close(c.fuelCost, 80);
  close(c.detourFuelL, 1);
  close(c.detourFuelCost, 2);
  close(c.detourOtherCost, 2);
  close(c.total, 84);
  close(c.netLitresGained, 39);
});

test('optionCost rejects non-positive price and negative detour', () => {
  assert.throws(() => optionCost({ price: 0, detourKm: 0, litres: 1, consumptionL100: 5 }), RangeError);
  assert.throws(() => optionCost({ price: 1, detourKm: -1, litres: 1, consumptionL100: 5 }), RangeError);
});

test('compareOptions: worked border example (Belgium cheaper despite detour)', () => {
  // NL nearest: 2.40, 2 km round trip. BE: 1.95, 24 km round trip. 40 L, 6.5 L/100 km.
  const r = compareOptions({
    options: [{ id: 'nl', price: 2.4, detourKm: 2 }, { id: 'be', price: 1.95, detourKm: 24 }],
    litres: 40,
    consumptionL100: 6.5,
  });
  assert.equal(r.baseline.id, 'nl');
  assert.equal(r.best.id, 'be');
  // NL: 96 + 0.13*2.4 = 96.312 ; BE: 78 + 1.56*1.95 = 81.042
  close(r.best.saving, 96.312 - 81.042, 1e-9);
  close(r.best.extraKm, 22);
  assert.equal(r.best.breakEven.kind, 'min');
  // L*(2.4-1.95) = 3.042 - 0.312 -> 6.0667 L
  close(r.best.breakEven.litres, (3.042 - 0.312) / 0.45, 1e-9);
  const nl = r.results.find((x) => x.id === 'nl');
  assert.equal(nl.isBaseline, true);
  assert.equal(nl.saving, 0);
});

test('compareOptions: small purchase makes the far cheap station not worth it', () => {
  const r = compareOptions({
    options: [{ id: 'near', price: 2.4, detourKm: 2 }, { id: 'far', price: 1.95, detourKm: 60 }],
    litres: 5,
    consumptionL100: 7,
  });
  assert.equal(r.best.id, 'near');
  const far = r.results.find((x) => x.id === 'far');
  assert.ok(far.saving < 0);
  assert.equal(far.breakEven.kind, 'min');
  assert.ok(far.breakEven.litres > 5);
  // at exactly the break-even amount savings are zero
  const at = compareOptions({ options: [{ id: 'near', price: 2.4, detourKm: 2 }, { id: 'far', price: 1.95, detourKm: 60 }], litres: far.breakEven.litres, consumptionL100: 7 });
  close(at.results.find((x) => x.id === 'far').saving, 0, 1e-9);
});

test('compareOptions: nearest baseline tie broken by lower price', () => {
  const r = compareOptions({
    options: [{ id: 'a', price: 2.1, detourKm: 3 }, { id: 'b', price: 2.0, detourKm: 3 }],
    litres: 30,
    consumptionL100: 6,
  });
  assert.equal(r.baseline.id, 'b');
});

test('compareOptions: custom baseline has zero detour and extraKm equals detour', () => {
  const r = compareOptions({
    options: [{ id: 'x', price: 2.0, detourKm: 10 }],
    litres: 40,
    consumptionL100: 5,
    baseline: { mode: 'custom', price: 2.2 },
  });
  assert.equal(r.baseline.id, '__baseline__');
  assert.equal(r.results[0].extraKm, 10);
  close(r.results[0].saving, 88 - (80 + 1)); // 7
  assert.equal(r.results[0].isBaseline, false);
});

test('compareOptions: zero consumption (EV-like/edge) means only price matters', () => {
  const r = compareOptions({
    options: [{ id: 'near', price: 2.4, detourKm: 0 }, { id: 'far', price: 2.39, detourKm: 100 }],
    litres: 1,
    consumptionL100: 0,
  });
  assert.equal(r.best.id, 'far');
  assert.equal(r.best.breakEven.kind, 'always');
});

test('compareOptions: per-km cost can flip the decision', () => {
  const opts = [{ id: 'near', price: 2.4, detourKm: 2 }, { id: 'far', price: 2.2, detourKm: 30 }];
  const a = compareOptions({ options: opts, litres: 40, consumptionL100: 6 });
  const b = compareOptions({ options: opts, litres: 40, consumptionL100: 6, perKmCost: 0.3 });
  assert.equal(a.best.id, 'far');
  assert.equal(b.best.id, 'near');
});

test('compareOptions: ignores options without price or distance, empty -> null', () => {
  const r = compareOptions({ options: [{ id: 'a', price: null, detourKm: 1 }, { id: 'b', price: 2, detourKm: NaN }], litres: 10, consumptionL100: 6 });
  assert.deepEqual(r, { baseline: null, results: [], best: null });
});

test('compareOptions: results sorted by saving desc', () => {
  const r = compareOptions({
    options: [{ id: 'a', price: 2.3, detourKm: 1 }, { id: 'b', price: 2.0, detourKm: 10 }, { id: 'c', price: 2.1, detourKm: 5 }],
    litres: 40,
    consumptionL100: 6,
  });
  const savings = r.results.map((x) => x.saving);
  assert.deepEqual(savings, [...savings].sort((x, y) => y - x));
});

test('breakEven: all kinds', () => {
  assert.deepEqual(breakEven({ basePrice: 2, baseDetourCost: 1, optionPrice: 2, optionDetourCost: 1 }), { kind: 'always', litres: 0 });
  assert.deepEqual(breakEven({ basePrice: 2, baseDetourCost: 1, optionPrice: 2, optionDetourCost: 2 }), { kind: 'never', litres: null });
  assert.deepEqual(breakEven({ basePrice: 2, baseDetourCost: 1, optionPrice: 1.9, optionDetourCost: 0.5 }), { kind: 'always', litres: 0 });
  const min = breakEven({ basePrice: 2, baseDetourCost: 0, optionPrice: 1.8, optionDetourCost: 2 });
  assert.equal(min.kind, 'min');
  close(min.litres, 10);
  // closer but more expensive than the (custom) baseline with larger fixed costs
  const max = breakEven({ basePrice: 2, baseDetourCost: 3, optionPrice: 2.1, optionDetourCost: 0 });
  assert.equal(max.kind, 'max');
  close(max.litres, 30);
  assert.deepEqual(breakEven({ basePrice: 2, baseDetourCost: 0, optionPrice: 2.1, optionDetourCost: 1 }), { kind: 'never', litres: null });
});

test('validateInputs edges', () => {
  assert.doesNotThrow(() => validateInputs({ litres: 0.1, consumptionL100: 0 }));
  assert.throws(() => validateInputs({ litres: 0, consumptionL100: 5 }), RangeError);
  assert.throws(() => validateInputs({ litres: 1001, consumptionL100: 5 }), RangeError);
  assert.throws(() => validateInputs({ litres: 10, consumptionL100: -1 }), RangeError);
  assert.throws(() => validateInputs({ litres: 10, consumptionL100: 5, perKmCost: -0.1 }), RangeError);
  assert.throws(() => validateInputs({ litres: '10', consumptionL100: 5 }), RangeError);
});

test('round', () => {
  assert.equal(round(1.005, 2), 1.01);
  assert.equal(round(2.3456, 1), 2.3);
  assert.ok(Number.isNaN(round(NaN)));
});

test('time value: detour minutes are charged and can change the ranking', () => {
  const options = [{ id: 'nl', price: 2.4, detourKm: 2, detourMin: 3 }, { id: 'be', price: 1.95, detourKm: 24, detourMin: 27 }];
  const cash = compareOptions({ options, litres: 40, consumptionL100: 6.5 });
  assert.equal(cash.best.id, 'be');
  close(cash.best.saving, cash.best.cashSaving, 1e-9);
  assert.equal(cash.best.extraMin, 24);
  // 24 extra min at 12/h = 4.80 of time
  const bal = compareOptions({ options, litres: 40, consumptionL100: 6.5, timeValuePerHour: 12 });
  const be = bal.results.find((x) => x.id === 'be');
  close(be.cashSaving, 96.312 - 81.042, 1e-9);
  close(be.saving, 96.312 - 81.042 - 4.8, 1e-9);
  close(be.cost.detourTimeCost, 27 / 60 * 12, 1e-9);
  assert.equal(bal.best.id, 'be');
  // at 50/h the 24 extra minutes (20) outweigh the 15.27 cash saving
  const hassle = compareOptions({ options, litres: 40, consumptionL100: 6.5, timeValuePerHour: 50 });
  assert.equal(hassle.best.id, 'nl');
  assert.ok(hassle.results.find((x) => x.id === 'be').cashSaving > 15);
});

test('time value: custom baseline has no detour time; missing minutes count as zero', () => {
  const r = compareOptions({
    options: [{ id: 'a', price: 1.9, detourKm: 10, detourMin: 12 }, { id: 'b', price: 1.9, detourKm: 10 }],
    litres: 40, consumptionL100: 5, timeValuePerHour: 30, baseline: { mode: 'custom', price: 2.0 },
  });
  const a = r.results.find((x) => x.id === 'a');
  const b = r.results.find((x) => x.id === 'b');
  close(a.cashSaving, b.cashSaving, 1e-9);
  close(b.saving - a.saving, 6, 1e-9);
  assert.equal(a.extraMin, 12);
  assert.equal(r.best.id, 'b');
});

test('time value: validation', () => {
  assert.throws(() => compareOptions({ options: [], litres: 10, consumptionL100: 5, timeValuePerHour: -1 }), RangeError);
  assert.throws(() => compareOptions({ options: [], litres: 10, consumptionL100: 5, timeValuePerHour: 501 }), RangeError);
  assert.throws(() => compareOptions({ options: [], litres: 10, consumptionL100: 5, timeValuePerHour: NaN }), RangeError);
});
