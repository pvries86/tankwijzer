'use strict';

// Pure vehicle-profile helpers shared by the browser (window.VehicleCalc) and the server/tests (require).
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VehicleCalc = api;
}(typeof self !== 'undefined' ? self : this, () => {
  const round1 = (v) => Math.round(v * 10) / 10;

  /** Strip spaces/dashes/dots, uppercase. */
  function normalizeKenteken(input) {
    return String(input == null ? '' : input).replace(/[\s.\-–]/g, '').toUpperCase();
  }

  /** Dutch plates are 6 letters/digits and every sidecode contains at least one digit. */
  function isValidKenteken(k) {
    return /^[A-Z0-9]{6}$/.test(k) && /[0-9]/.test(k);
  }

  /** Display form with sidecode dashes (e.g. "XX999X" → "XX-999-X"); invalid input is returned normalized. */
  function formatKenteken(input) {
    const k = normalizeKenteken(input);
    if (!isValidKenteken(k)) return k;
    const runs = k.match(/[A-Z]+|[0-9]+/g);
    if (runs.length === 2) {
      const i = runs.findIndex((r) => r.length === 4);
      if (i >= 0) runs.splice(i, 1, runs[i].slice(0, 2), runs[i].slice(2));
    }
    return runs.length === 3 ? runs.join('-') : k;
  }

  /** For logs: keep the first two and last two characters only. */
  function maskKenteken(k) {
    const s = normalizeKenteken(k);
    if (s.length < 4) return '***';
    return `${s.slice(0, 2)}${'*'.repeat(s.length - 4)}${s.slice(-2)}`;
  }

  // Litres per 100 km ≈ CO2 [g/km] / factor. Factors from fuel carbon content (≈2.37 kg CO2/L petrol,
  // ≈2.65 kg/L diesel, ≈1.61 kg/L LPG).
  const CO2_FACTORS = { e10: 23.7, e5_98: 23.7, diesel: 26.5, lpg: 16.1 };

  function estimateFromCo2(co2, fuelId) {
    const f = CO2_FACTORS[fuelId];
    const g = Number(co2);
    if (!f || !Number.isFinite(g) || g <= 0) return null;
    return round1(g / f);
  }

  /** Transparent tank-size heuristic from kerb weight (massa rijklaar). Returns null when unknown. */
  function estimateTank(massaRijklaar) {
    const m = Number(massaRijklaar);
    if (!Number.isFinite(m) || m <= 0) return null;
    if (m < 1050) return 35;
    if (m < 1250) return 42;
    if (m <= 1500) return 52;
    return 60;
  }

  const TANK_SIZES = [35, 40, 42, 45, 50, 52, 55, 60, 65, 70, 75, 80];

  /** Typical design range (km on a full tank) by kerb weight; diesels get ×1.2 (similar tanks, lower consumption). */
  function targetRangeKm(massaRijklaar, fuelId) {
    const m = Number(massaRijklaar);
    if (!Number.isFinite(m) || m <= 0) return null;
    const base = m < 1100 ? 750 : m < 1600 ? 920 : m < 2000 ? 980 : 1050;
    return fuelId === 'diesel' ? Math.round(base * 1.2) : base;
  }

  /**
   * Tank estimate from target range × lab consumption (before any realism uplift):
   * theoretical = range × L/100km / 100, snapped to the nearest common tank size, clamped to 30–80 L.
   * Returns null when mass or consumption is unknown (caller falls back to estimateTank).
   */
  function estimateTankFromRange(massaRijklaar, labConsumption, fuelId) {
    const rangeKm = targetRangeKm(massaRijklaar, fuelId);
    const c = Number(labConsumption);
    if (!rangeKm || !Number.isFinite(c) || c <= 0) return null;
    const theoretical = (rangeKm * c) / 100;
    const snapped = TANK_SIZES.reduce((best, s) => (Math.abs(s - theoretical) < Math.abs(best - theoretical) ? s : best));
    return { value: Math.min(80, Math.max(30, snapped)), rangeKm, consumption: c, theoretical: round1(theoretical) };
  }

  /** Estimated range in km for a tank size and (real-world) consumption. */
  function rangeKm(tankL, consumption) {
    const t = Number(tankL);
    const c = Number(consumption);
    if (!Number.isFinite(t) || t <= 0 || !Number.isFinite(c) || c <= 0) return null;
    return Math.round((t / c) * 100);
  }

  function applyUplift(value, pct, enabled) {
    const v = Number(value);
    if (!Number.isFinite(v)) return null;
    const p = Number(pct);
    if (!enabled || !Number.isFinite(p) || p === 0) return round1(v);
    return round1(v * (1 + p / 100));
  }

  /** Litres to buy from tank capacity and current level (0–100 %). */
  function litresToBuy(tankL, levelPct) {
    const tank = Number(tankL);
    const lvl = Math.min(100, Math.max(0, Number(levelPct)));
    if (!Number.isFinite(tank) || tank <= 0 || !Number.isFinite(lvl)) return null;
    return Math.max(0, Math.round(tank * (1 - lvl / 100)));
  }

  /**
   * Which consumption value to use. A manual edit always wins and is used as-is; otherwise the RDW lab value
   * with (optional) realism uplift.
   * @returns {{ value:number|null, origin:'manual'|'rdw'|'none', uplifted:boolean }}
   */
  function resolveConsumption({ manual, lab, upliftPct, upliftEnabled }) {
    if (manual != null && manual !== '' && Number.isFinite(Number(manual))) {
      return { value: Number(manual), origin: 'manual', uplifted: false };
    }
    if (lab == null || !Number.isFinite(Number(lab))) return { value: null, origin: 'none', uplifted: false };
    const uplifted = !!upliftEnabled && Number(upliftPct) !== 0 && Number.isFinite(Number(upliftPct));
    return { value: applyUplift(lab, upliftPct, upliftEnabled), origin: 'rdw', uplifted };
  }

  /** Litres to buy: a direct litres entry wins over the tank × level derivation. */
  function resolveLitres({ manual, tankL, levelPct }) {
    if (manual != null && manual !== '' && Number.isFinite(Number(manual))) return { value: Number(manual), origin: 'manual' };
    const v = litresToBuy(tankL, levelPct);
    return v == null ? { value: null, origin: 'none' } : { value: v, origin: 'tank' };
  }

  /**
   * Why the vehicle details must be shown expanded, or null when the collapsed summary is enough.
   * Warnings about the looked-up car win over plain missing/invalid field values.
   * @returns {null|'electric'|'unsupported-fuel'|'phev'|'lookup-failed'|'consumption'|'litres'}
   */
  function vehicleAttention({ warnings = [], lookupFailed = false, consumption, litres, consMin = 0.1, consMax = 50 } = {}) {
    for (const w of ['electric', 'unsupported-fuel', 'phev']) if (warnings.includes(w)) return w;
    if (lookupFailed) return 'lookup-failed';
    const c = Number(String(consumption ?? '').replace(',', '.'));
    if (consumption === '' || consumption == null || !Number.isFinite(c) || c < consMin || c > consMax) return 'consumption';
    const l = Number(String(litres ?? '').replace(',', '.'));
    if (litres === '' || litres == null || !Number.isFinite(l) || l < 1 || l > 200) return 'litres';
    return null;
  }

  /** Today's date (YYYY-MM-DD) in Europe/Amsterdam, regardless of the host time zone. */
  function todayAmsterdam(now = new Date()) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Amsterdam', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  }

  /**
   * APK (MOT) status for an expiry date (YYYY-MM-DD) relative to today (YYYY-MM-DD).
   * level: expired (<0 days) | soon (<=30) | upcoming (<=60) | ok | unknown.
   */
  function apkStatus(expiryIso, todayIso) {
    const re = /^\d{4}-\d{2}-\d{2}$/;
    if (!re.test(String(expiryIso || '')) || !re.test(String(todayIso || ''))) return { level: 'unknown', days: null, date: null };
    const days = Math.round((Date.parse(`${expiryIso}T00:00:00Z`) - Date.parse(`${todayIso}T00:00:00Z`)) / 86400000);
    const level = days < 0 ? 'expired' : days <= 30 ? 'soon' : days <= 60 ? 'upcoming' : 'ok';
    return { level, days, date: expiryIso };
  }

  /**
   * Drive layout from RDW axle rows (3huj-srit: as_nummer, aangedreven_as 'J'/'N'/empty).
   * >1 driven axle → awd; only axle 1 → fwd; only axle 2 → rwd; otherwise unknown.
   */
  function driveFromAxles(rows) {
    const driven = (Array.isArray(rows) ? rows : [])
      .filter((r) => String(r && r.aangedreven_as || '').trim().toUpperCase() === 'J')
      .map((r) => Number(r.as_nummer))
      .filter((n) => Number.isFinite(n));
    const uniq = [...new Set(driven)];
    if (uniq.length > 1) return 'awd';
    if (uniq.length === 1 && uniq[0] === 1) return 'fwd';
    if (uniq.length === 1 && uniq[0] === 2) return 'rwd';
    return 'unknown';
  }

  return {
    normalizeKenteken, formatKenteken, isValidKenteken, maskKenteken, estimateFromCo2, estimateTank, estimateTankFromRange, targetRangeKm, rangeKm,
    applyUplift, litresToBuy, resolveConsumption, resolveLitres, vehicleAttention,
    todayAmsterdam, apkStatus, driveFromAxles,
  };
}));
