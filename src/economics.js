'use strict';

/*
 * Pure economic model. No I/O. All distances in km, prices in EUR per litre,
 * consumption in L/100 km, money in EUR.
 *
 * Model
 * -----
 *  - Trip without refuelling ("base trip"):  round-trip mode -> 0 km (you stay home);
 *                                            route mode      -> start -> destination.
 *  - Trip with refuelling at station S:      round-trip mode -> start -> S -> start;
 *                                            route mode      -> start -> S -> destination.
 *  - detourKm(S) = trip-with-S - base trip  (never negative).
 *  - Fuel burned for the detour is valued at the price paid at S (you replace it there),
 *    plus an optional per-km running cost (wear, tyres, ...).
 *  - totalCost(S) = litres * price(S) + detourKm(S) * (consumption/100 * price(S) + perKmCost)
 *                   + detourMinutes(S) / 60 * timeValuePerHour   (time term optional, default 0)
 *    cashTotal(S) is the same without the time term (money actually spent).
 *  - The baseline is either the station with the smallest detour ("nearest") or a
 *    user-given price with zero detour (e.g. "my usual station on my normal route").
 *  - saving(S) = totalCost(baseline) - totalCost(S) (net of time value); cashSaving(S) uses cashTotal.
 *    extraKm(S) = detourKm(S) - detourKm(baseline)
 */

const EPS = 1e-9;

function round(n, digits = 2) {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
}

/** Detour in km caused by visiting the station. Clamped at 0 (routing asymmetry can give tiny negatives). */
function detourKm({ startToStationKm, stationToEndKm, baseTripKm = 0 }) {
  for (const v of [startToStationKm, stationToEndKm, baseTripKm]) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError('distances must be finite and >= 0');
  }
  return Math.max(0, startToStationKm + stationToEndKm - baseTripKm);
}

function validateInputs({ litres, consumptionL100, perKmCost = 0, timeValuePerHour = 0 }) {
  if (!Number.isFinite(litres) || litres <= 0 || litres > 1000) {
    throw new RangeError('litres must be a number > 0 and <= 1000');
  }
  if (!Number.isFinite(consumptionL100) || consumptionL100 < 0 || consumptionL100 > 100) {
    throw new RangeError('consumption must be a number between 0 and 100 L/100 km');
  }
  if (!Number.isFinite(perKmCost) || perKmCost < 0 || perKmCost > 10) {
    throw new RangeError('per-km cost must be a number between 0 and 10 EUR/km');
  }
  if (!Number.isFinite(timeValuePerHour) || timeValuePerHour < 0 || timeValuePerHour > 500) {
    throw new RangeError('time value must be a number between 0 and 500 EUR/hour');
  }
}

/**
 * Cost breakdown of refuelling `litres` at `price` with a detour of `detourKmValue` km / `detourMin` minutes.
 * `cashTotal` is money actually spent; `total` additionally charges detour time at `timeValuePerHour`.
 */
function optionCost({ price, detourKm: d, detourMin = 0, litres, consumptionL100, perKmCost = 0, timeValuePerHour = 0 }) {
  if (!Number.isFinite(price) || price <= 0) throw new RangeError('price must be > 0');
  if (!Number.isFinite(d) || d < 0) throw new RangeError('detourKm must be >= 0');
  const mins = Number.isFinite(detourMin) && detourMin > 0 ? detourMin : 0;
  const detourFuelL = (d * consumptionL100) / 100;
  const fuelCost = litres * price;
  const detourFuelCost = detourFuelL * price;
  const detourOtherCost = d * perKmCost;
  const detourTimeCost = (mins / 60) * timeValuePerHour;
  const detourCashCost = detourFuelCost + detourOtherCost;
  const detourCost = detourCashCost + detourTimeCost;
  return {
    fuelCost,
    detourFuelL,
    detourFuelCost,
    detourOtherCost,
    detourTimeCost,
    detourCashCost,
    detourCost,
    cashTotal: fuelCost + detourCashCost,
    total: fuelCost + detourCost,
    netLitresGained: litres - detourFuelL,
  };
}

/**
 * Litres needed for option to break even against the baseline.
 * saving(L) = L*(Pb - Po) + (Kb - Ko), where K = fixed detour cost (independent of litres).
 * Returns { kind, litres }:
 *   'always' -> option is at least as cheap for any amount (litres = 0)
 *   'min'    -> option is cheaper when buying MORE than `litres`
 *   'max'    -> option is cheaper only when buying LESS than `litres` (it is closer but pricier)
 *   'never'  -> option is never cheaper
 */
function breakEven({ basePrice, baseDetourCost, optionPrice, optionDetourCost }) {
  const dp = basePrice - optionPrice; // price advantage per litre
  const dk = optionDetourCost - baseDetourCost; // extra fixed cost of the option
  if (Math.abs(dp) < EPS) {
    return dk <= EPS ? { kind: 'always', litres: 0 } : { kind: 'never', litres: null };
  }
  const l = dk / dp;
  if (dp > 0) {
    return l <= 0 ? { kind: 'always', litres: 0 } : { kind: 'min', litres: l };
  }
  // option more expensive per litre
  return l > 0 ? { kind: 'max', litres: l } : { kind: 'never', litres: null };
}

/**
 * Compare options.
 * @param {object} p
 * @param {Array<{id:string, price:number, detourKm:number}>} p.options
 * @param {number} p.litres
 * @param {number} p.consumptionL100
 * @param {number} [p.perKmCost]
 * @param {number} [p.timeValuePerHour] value of detour time; options may carry `detourMin`
 * @param {{mode:'nearest'}|{mode:'custom', price:number, label?:string}} [p.baseline]
 */
function compareOptions({ options, litres, consumptionL100, perKmCost = 0, timeValuePerHour = 0, baseline = { mode: 'nearest' } }) {
  validateInputs({ litres, consumptionL100, perKmCost, timeValuePerHour });
  const priced = (options || []).filter((o) => Number.isFinite(o.price) && o.price > 0 && Number.isFinite(o.detourKm));
  if (!priced.length) {
    return { baseline: null, results: [], best: null };
  }

  const params = { litres, consumptionL100, perKmCost, timeValuePerHour };
  const evaluated = priced.map((o) => ({ ...o, cost: optionCost({ price: o.price, detourKm: o.detourKm, detourMin: o.detourMin, ...params }) }));

  let base;
  if (baseline && baseline.mode === 'custom') {
    if (!Number.isFinite(baseline.price) || baseline.price <= 0) throw new RangeError('baseline price must be > 0');
    base = {
      id: '__baseline__',
      label: baseline.label || 'Your reference price (no detour)',
      price: baseline.price,
      detourKm: 0,
      detourMin: 0,
      cost: optionCost({ price: baseline.price, detourKm: 0, ...params }),
    };
  } else {
    // nearest = smallest detour; ties broken by lower price
    base = evaluated.reduce((a, b) =>
      b.detourKm < a.detourKm - EPS || (Math.abs(b.detourKm - a.detourKm) <= EPS && b.price < a.price) ? b : a);
    base = { ...base, label: base.label || 'Nearest station' };
  }

  const results = evaluated.map((o) => {
    const saving = base.cost.total - o.cost.total;
    return {
      ...o,
      extraKm: o.detourKm - base.detourKm,
      extraMin: (Number.isFinite(o.detourMin) ? o.detourMin : 0) - (Number.isFinite(base.detourMin) ? base.detourMin : 0),
      saving,
      cashSaving: base.cost.cashTotal - o.cost.cashTotal,
      savingPerLitre: saving / litres,
      breakEven: breakEven({
        basePrice: base.price,
        baseDetourCost: base.cost.detourCost,
        optionPrice: o.price,
        optionDetourCost: o.cost.detourCost,
      }),
      isBaseline: o.id === base.id,
    };
  });
  results.sort((a, b) => b.saving - a.saving || a.detourKm - b.detourKm);
  return { baseline: base, results, best: results[0] };
}

module.exports = { round, detourKm, optionCost, breakEven, compareOptions, validateInputs };
