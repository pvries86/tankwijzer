'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, withoutVehicle, hasCar, prefKeys, carKey } = require('../public/vehicle-memory');
const { initialExamples, adviceReady } = require('../public/auto-compare');

function storage() {
  const entries = new Map();
  return { entries, getItem: k => entries.get(k) ?? null, setItem: (k, v) => entries.set(k, v), removeItem: k => entries.delete(k) };
}

test('only a looked-up vehicle or conscious manual edits count as a remembered car', () => {
  assert.equal(hasCar(null, { consumption: 'example', litres: 'example', tank: 'example' }), false);
  assert.equal(hasCar(null, { consumption: null, litres: null }), false);
  assert.equal(hasCar(null, { tank: 'manual' }), true);
  assert.equal(hasCar({ fuelSupport: 'ok' }, {}), true);
});

test('forget clears modern and legacy car fields, preserves non-car preferences and blocks default refill', () => {
  const s = storage(), errors = [];
  const m = create(() => s, operation => errors.push(operation));
  const prefs = { consumption: 7, consumptionOrigin: 'manual', litres: 30, litresOrigin: 'manual',
    tank: 60, tankOrigin: 'range', level: 50, consUnit: 'kml', upliftEnabled: true, upliftPct: 20,
    radius: 30, priority: 'balanced', fuel: 'diesel', perkm: 0.2 };
  for (const k of prefKeys) m.write(k, prefs);
  m.write(carKey, { vehicle: { kenteken: 'AB123C' } });
  assert.equal(m.forget(prefs), true);
  const expected = { radius: 30, priority: 'balanced', fuel: 'diesel', perkm: 0.2, vehicleForgotten: true };
  assert.deepEqual(m.read(prefKeys[0]), expected);
  assert.deepEqual(withoutVehicle(prefs), expected);
  assert.equal(m.read(carKey), null);
  for (const key of prefKeys.slice(1)) assert.equal(m.read(key), null);
  assert.deepEqual(initialExamples(expected, false), {});
  assert.equal(adviceReady(expected), false);
  // A later general-settings save must remain scrubbed.
  m.write(prefKeys[0], withoutVehicle({ ...prefs, radius: 40 }));
  assert.equal(m.read(prefKeys[0]).consumption, undefined);
  assert.deepEqual(errors, []);
});

test('legacy profile format survives automatic saves without losing origins or edits', () => {
  const s = storage(), m = create(() => s, () => assert.fail('unexpected storage error'));
  const saved = { vehicle: { kenteken: 'AB123C', consumption: { value: 5, source: 'wltp' } },
    origins: { consumption: 'manual', litres: 'tank', tank: 'range' }, expanded: true };
  m.write(carKey, saved);
  assert.deepEqual(m.read(carKey), saved);
  m.write(carKey, { ...m.read(carKey), expanded: false });
  assert.deepEqual(m.read(carKey).origins, saved.origins);
});

test('unavailable, corrupt or full storage reports explicit failures without breaking the visit', () => {
  const errors = [];
  const blocked = create(() => { throw new Error('blocked'); }, op => errors.push(op));
  assert.equal(blocked.read(carKey), null);
  assert.equal(blocked.write(carKey, {}), false);
  assert.equal(blocked.forget({ radius: 20 }), false);
  assert.ok(errors.includes('read') && errors.includes('save') && errors.includes('forget'));
  const s = storage();
  s.entries.set(carKey, '{broken');
  const m = create(() => s, op => errors.push(op));
  assert.equal(m.read(carKey), null);
  s.setItem = () => { throw new Error('quota'); };
  assert.equal(m.write(carKey, {}), false);
});
