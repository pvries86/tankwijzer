'use strict';

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AutoCompare = api;
}(typeof self !== 'undefined' ? self : this, () => {
  function adviceReady({ consumption, litres, consumptionOrigin, litresOrigin, valid = true, needsRealConsumption = false }) {
    const c = Number(consumption), l = Number(litres);
    return valid && ['manual', 'wltp', 'nedc', 'co2', 'example'].includes(consumptionOrigin)
      && ['manual', 'tank', 'example'].includes(litresOrigin) && c > 0 && c <= 50 && l >= 1 && l <= 200
      && (!needsRealConsumption || consumptionOrigin === 'manual');
  }

  function initialExamples(prefs, hasVehicle) {
    if (hasVehicle || prefs.vehicleForgotten) return {};
    const values = {};
    if (!Object.hasOwn(prefs, 'consumptionOrigin')) values.consumption = 6.5;
    if (!Object.hasOwn(prefs, 'litresOrigin')) values.litres = 40;
    if (!Object.hasOwn(prefs, 'tank')) { values.tank = 50; values.level = 20; }
    return values;
  }

  function create({ getBody, request, onResult, onError, onStatus, onPending,
    setTimer = setTimeout, clearTimer = clearTimeout }) {
    let revision = 0, timer, controller, desired = null, last = null;
    function invalidate() {
      revision++;
      clearTimer(timer);
      timer = null;
      if (controller) controller.abort();
      controller = null;
      desired = null;
      onStatus('idle');
    }
    function schedule(delay = 400, force = false) {
      const body = getBody();
      const key = body && JSON.stringify(body);
      if (!force && key && key === desired) return;
      invalidate();
      onPending(body);
      if (!body) return;
      desired = key;
      const seq = revision;
      if (!force && last && last.key === key && last.expires > Date.now()) {
        onResult(last.data);
        return;
      }
      onStatus('pending');
      timer = setTimer(async () => {
        timer = null;
        controller = new AbortController();
        onStatus('loading');
        try {
          const data = await request(force ? { ...body, refresh: true } : body, controller.signal);
          if (seq !== revision) return;
          last = { key, data, expires: Date.now() + 300000 };
          onResult(data);
        } catch (err) {
          if (seq !== revision) return;
          desired = null;
          if (err.name !== 'AbortError') onError(err);
        } finally {
          if (seq === revision) { controller = null; onStatus('idle'); }
        }
      }, delay);
    }
    return { schedule, invalidate, retry: () => schedule(0, true) };
  }
  return { adviceReady, initialExamples, create };
}));
