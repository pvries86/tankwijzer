'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adviceReady, create } = require('../public/auto-compare');

test('advice needs actual usable input origins, not hidden defaults', () => {
  const values = { consumption: 6, litres: 40 };
  assert.equal(adviceReady(values), false);
  const manual = { ...values, consumptionOrigin: 'manual', litresOrigin: 'manual' };
  assert.equal(adviceReady(manual), true);
  assert.equal(adviceReady({ ...manual, consumption: '' }), false);
  assert.equal(adviceReady({ ...manual, consumption: 0 }), false);
  assert.equal(adviceReady({ ...manual, consumption: 51 }), false);
  assert.equal(adviceReady({ ...manual, litres: -1 }), false);
  assert.equal(adviceReady({ ...manual, litres: 201 }), false);
  assert.equal(adviceReady({ ...manual, valid: false }), false);
  assert.equal(adviceReady({ ...manual, consumptionOrigin: 'wltp', needsRealConsumption: true }), false);
  assert.equal(adviceReady({ ...manual, needsRealConsumption: true }), true);
  assert.equal(adviceReady({ ...values, consumptionOrigin: 'co2', litresOrigin: 'tank' }), true, 'usable remembered/RDW profile');
});

function harness() {
  let body = { start: 'A', fuel: 'e10', advice: false }, timer;
  const calls = [], results = [], errors = [], statuses = [], pending = [];
  const api = create({
    getBody: () => body,
    setTimer: (fn, delay) => { timer = { fn, delay }; return timer; },
    clearTimer: (id) => { if (timer === id) timer = null; },
    request: (value, signal) => new Promise((resolve, reject) => calls.push({ value, signal, resolve, reject })),
    onResult: (data) => results.push(data), onError: (err) => errors.push(err),
    onStatus: (status) => statuses.push(status), onPending: (value) => pending.push(value),
  });
  return { api, calls, results, errors, statuses, pending, set: (v) => { body = v; }, timer: () => timer,
    start: () => { const fn = timer.fn; timer = null; return fn(); } };
}

test('automatic discovery, debounce, duplicate input/change and transition to advice', async () => {
  const h = harness();
  h.api.schedule();
  assert.equal(h.timer().delay, 400);
  h.api.schedule();
  assert.equal(h.pending.length, 1, 'input/change with identical snapshot schedules once');
  const p = h.start();
  h.api.schedule();
  assert.equal(h.calls.length, 1);
  h.calls[0].resolve({ advice: false }); await p;
  h.set({ start: 'A', fuel: 'e10', advice: true, consumption: 6, litres: 40 });
  h.api.schedule();
  const q = h.start(); h.calls[1].resolve({ advice: true }); await q;
  assert.deepEqual(h.results, [{ advice: false }, { advice: true }]);
  assert.equal(h.statuses.at(-1), 'idle');
});

test('rapid location/fuel changes and invalidation reject stale success and error responses', async () => {
  const h = harness();
  h.api.schedule(); const a = h.start();
  h.set({ start: 'B', fuel: 'diesel', advice: false }); h.api.schedule();
  assert.equal(h.calls[0].signal.aborted, true);
  h.calls[0].resolve({ stale: true }); await a;
  assert.deepEqual(h.results, []);
  const b = h.start();
  h.set(null); h.api.schedule();
  h.calls[1].reject(new Error('stale error')); await b;
  assert.deepEqual(h.errors, []);
  assert.equal(h.statuses.at(-1), 'idle');
  assert.equal(h.timer(), null);
  h.set({ start: 'C', fuel: 'e10', advice: false }); h.api.schedule();
  const c = h.start(); h.calls[2].resolve({ current: true }); await c;
  assert.deepEqual(h.results, [{ current: true }]);
});

test('explicit retry bypasses result deduplication, errors are visible and no auto retry loops occur', async () => {
  const h = harness();
  h.api.schedule(); const a = h.start();
  h.calls[0].reject(new Error('offline')); await a;
  assert.equal(h.errors[0].message, 'offline');
  assert.equal(h.timer(), null);
  h.api.retry(); const b = h.start();
  assert.equal(h.calls[1].value.refresh, true);
  h.calls[1].resolve({ recovered: true }); await b;
  h.api.invalidate(); h.api.schedule();
  assert.equal(h.calls.length, 2, 'identical recent successful state can be reused');
  h.api.retry(); const c = h.start();
  h.calls[2].resolve({ refreshed: true }); await c;
  assert.equal(h.results.at(-1).refreshed, true);
});
