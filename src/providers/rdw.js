'use strict';

// RDW Open Data (CC0) vehicle lookup for Dutch licence plates. Only used when the user enters a plate.
const calc = require('../../public/vehicle-calc');

const BASIS_DATASET = 'm9d7-ebf2';
const FUEL_DATASET = '8ys7-d773';
const RECALL_STATUS_DATASET = 't49b-isb7';
const RECALL_DETAIL_DATASET = 'j9yg-7rg9';
const RECALL_RISK_DATASET = '9ihi-jgpf';
const BODY_DATASET = 'vezc-m2t6';
const AXLE_DATASET = '3huj-srit';
const LIQUID = { Benzine: 'e10', Diesel: 'diesel', LPG: 'lpg' };
const CACHE_TTL_S = 24 * 3600;
const NOT_FOUND_TTL_S = 3600;

class RdwError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = 'RdwError';
    this.code = code; // invalid | not-found | rate-limited | unavailable
    this.status = status;
  }
}

const numOrNull = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function isoDate(yyyymmdd) {
  const s = String(yyyymmdd || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : null;
}

/** Map the raw RDW rows (basiskenmerken row + brandstof rows) to the vehicle profile the UI needs. */
function mapVehicle(basis, fuelRows) {
  const rows = (Array.isArray(fuelRows) ? fuelRows : [])
    .slice()
    .sort((a, b) => (numOrNull(a.brandstof_volgnummer) ?? 9) - (numOrNull(b.brandstof_volgnummer) ?? 9));
  const fuels = rows.map((r) => r.brandstof_omschrijving).filter(Boolean);
  const liquidRows = rows.filter((r) => LIQUID[r.brandstof_omschrijving]);
  // Bi-fuel LPG cars list Benzine first; someone who installed LPG most likely tanks LPG.
  const row = liquidRows.find((r) => r.brandstof_omschrijving === 'LPG') || liquidRows[0] || null;
  const hybridClass = rows.map((r) => r.klasse_hybride_elektrisch_voertuig).find(Boolean) || null;
  const warnings = [];

  let fuelSupport = 'ok';
  if (!row) {
    fuelSupport = fuels.length && fuels.every((f) => f === 'Elektriciteit') ? 'electric' : 'unsupported';
    warnings.push(fuelSupport === 'electric' ? 'electric' : 'unsupported-fuel');
  }
  if (row && liquidRows.length > 1 && row.brandstof_omschrijving === 'LPG') warnings.push('bifuel-lpg');
  if (hybridClass && hybridClass.startsWith('OVC')) warnings.push('phev');

  const fuelId = row ? LIQUID[row.brandstof_omschrijving] : null;
  let consumption = { value: null, source: null };
  if (row) {
    const wltp = numOrNull(row.brandstof_verbruik_gecombineerd_wltp);
    const nedc = numOrNull(row.brandstofverbruik_gecombineerd);
    const co2Wltp = numOrNull(row.emissie_co2_gecombineerd_wltp);
    const co2Nedc = numOrNull(row.co2_uitstoot_gecombineerd);
    if (wltp && wltp > 0) consumption = { value: wltp, source: 'wltp' };
    else if (nedc && nedc > 0) consumption = { value: nedc, source: 'nedc' };
    else {
      const co2 = co2Wltp || co2Nedc;
      const est = calc.estimateFromCo2(co2, fuelId);
      if (est) consumption = { value: est, source: 'co2', co2, co2Cycle: co2Wltp ? 'wltp' : 'nedc' };
    }
  }

  const kws = rows.map((r) => numOrNull(r.nettomaximumvermogen)).filter((v) => v && v > 0);
  const kwEl = rows.map((r) => numOrNull(r.netto_max_vermogen_elektrisch)).filter((v) => v && v > 0);
  const powerKw = kws.length ? Math.max(...kws) : kwEl.length ? Math.max(...kwEl) : null;
  const massa = numOrNull(basis.massa_rijklaar);
  // Range × lab consumption (before uplift); PHEV lab values are meaningless for fuel-only use → weight heuristic.
  const byRange = row && !warnings.includes('phev') ? calc.estimateTankFromRange(massa, consumption.value, fuelId) : null;
  const tankWeight = row && !byRange ? calc.estimateTank(massa) : null;
  const tankInfo = byRange
    ? { value: byRange.value, source: 'range', rangeKm: byRange.rangeKm, consumption: byRange.consumption }
    : { value: tankWeight, source: tankWeight ? 'weight' : null };
  const firstAdmission = isoDate(basis.datum_eerste_toelating);

  return {
    kenteken: calc.normalizeKenteken(basis.kenteken),
    merk: basis.merk || null,
    handelsbenaming: basis.handelsbenaming || null,
    inrichting: basis.inrichting || null,
    voertuigsoort: basis.voertuigsoort || null,
    firstAdmission,
    year: firstAdmission ? Number(firstAdmission.slice(0, 4)) : null,
    massaRijklaar: massa,
    fuels,
    hybridClass,
    powerKw,
    powerPk: powerKw ? Math.round(powerKw * 1.36) : null,
    fuelId,
    fuelSupport,
    consumption,
    tank: tankInfo,
    warnings,
  };
}

/** Recall rows (t49b-isb7) + optional details (j9yg-7rg9) and risks (9ihi-jgpf) → recall summary. */
function mapRecalls(statusRows, detailRows = [], riskRows = []) {
  const rows = Array.isArray(statusRows) ? statusRows : [];
  const details = new Map((Array.isArray(detailRows) ? detailRows : []).map((d) => [d.referentiecode_rdw, d]));
  const risks = new Map();
  for (const r of Array.isArray(riskRows) ? riskRows : []) {
    if (!r.referentiecode_rdw || !r.mogelijk_gevaar) continue;
    risks.set(r.referentiecode_rdw, [...(risks.get(r.referentiecode_rdw) || []), r.mogelijk_gevaar]);
  }
  const seen = new Set();
  const open = [];
  const resolved = [];
  const other = [];
  for (const r of rows) {
    const code = r.referentiecode_rdw;
    if (!code || seen.has(code)) continue;
    seen.add(code);
    const st = String(r.code_status || '').toUpperCase();
    if (st === 'O') {
      const d = details.get(code) || {};
      const info = d.meer_informatie_op_internet && /^https?:\/\//i.test(d.meer_informatie_op_internet) ? d.meer_informatie_op_internet : null;
      open.push({
        code,
        status: r.status || 'Openstaande terugroepactie',
        defect: d.omschrijving_defect || null,
        remedy: d.beschrijving_van_het_herstel || null,
        infoUrl: info,
        published: isoDate(d.publicatiedatum_rdw),
        risks: risks.get(code) || [],
      });
    } else if (st === 'P') resolved.push(code);
    else other.push({ code, status: r.status || st || null });
  }
  return { open, resolvedCount: resolved.length, resolvedCodes: resolved, other };
}

/** Body (vezc-m2t6) rows → first body type. */
function mapBody(rows) {
  const r = (Array.isArray(rows) ? rows : [])
    .slice()
    .sort((a, b) => (numOrNull(a.carrosserie_volgnummer) ?? 9) - (numOrNull(b.carrosserie_volgnummer) ?? 9))[0];
  return r ? { code: r.carrosserietype || null, description: r.type_carrosserie_europese_omschrijving || null } : null;
}

const cleanReg = (v) => (v && !/^(niet geregistreerd|n\.?v\.?t\.?)$/i.test(v) ? v : null);

/** Extra, non-essential vehicle info from the basis + fuel rows (no extra requests). */
function mapBasisExtras(basis, fuelRows) {
  const rows = Array.isArray(fuelRows) ? fuelRows : [];
  return {
    apkExpiry: isoDate(basis.vervaldatum_apk),
    doors: numOrNull(basis.aantal_deuren),
    color: cleanReg(basis.eerste_kleur),
    emissionClass: rows.map((r) => r.uitlaatemissieniveau).find(Boolean) || null,
  };
}

const SAFE_CODE = /^[A-Z0-9-]{3,20}$/;
const MAX_RECALL_DETAILS = 10;

function makeRdwClient(config, http, cache) {
  const base = String(config.rdwUrl || 'https://opendata.rdw.nl').replace(/\/+$/, '');
  const headers = config.rdwAppToken ? { 'X-App-Token': config.rdwAppToken } : {};

  async function getWhereIn(dataset, field, values) {
    const list = values.filter((v) => SAFE_CODE.test(v)).map((v) => `'${v}'`).join(',');
    if (!list) return [];
    const url = `${base}/resource/${dataset}.json?$where=${encodeURIComponent(`${field} in(${list})`)}&$limit=200`;
    return http.json(url, { headers, timeoutMs: 8000 });
  }

  /** Fetch the optional datasets; any failure only marks that part as missing. */
  async function fetchExtras(k) {
    const [recallRes, bodyRes, axleRes] = await Promise.allSettled([
      get(RECALL_STATUS_DATASET, k), get(BODY_DATASET, k), get(AXLE_DATASET, k),
    ]);
    const missing = [];
    const out = { body: null, drive: 'unknown', recalls: null };
    if (bodyRes.status === 'fulfilled') out.body = mapBody(bodyRes.value);
    else missing.push('body');
    if (axleRes.status === 'fulfilled') out.drive = calc.driveFromAxles(axleRes.value);
    else missing.push('drive');
    if (recallRes.status === 'fulfilled') {
      const statusRows = Array.isArray(recallRes.value) ? recallRes.value : [];
      const openCodes = [...new Set(statusRows
        .filter((r) => String(r.code_status || '').toUpperCase() === 'O')
        .map((r) => r.referentiecode_rdw))].slice(0, MAX_RECALL_DETAILS);
      let detailRows = [];
      let riskRows = [];
      if (openCodes.length) {
        const [dRes, rRes] = await Promise.allSettled([
          getWhereIn(RECALL_DETAIL_DATASET, 'referentiecode_rdw', openCodes),
          getWhereIn(RECALL_RISK_DATASET, 'referentiecode_rdw', openCodes),
        ]);
        if (dRes.status === 'fulfilled') detailRows = dRes.value; else missing.push('recall-details');
        if (rRes.status === 'fulfilled') riskRows = rRes.value; else missing.push('recall-risks');
      }
      out.recalls = mapRecalls(statusRows, detailRows, riskRows);
    } else missing.push('recalls');
    if (missing.length) console.warn(`rdw extras ${calc.maskKenteken(k)} partial: ${missing.join(', ')} unavailable`);
    return { ...out, missing };
  }

  async function get(dataset, k) {
    const url = `${base}/resource/${dataset}.json?kenteken=${encodeURIComponent(k)}`;
    try {
      return await http.json(url, { headers, timeoutMs: 8000 });
    } catch (err) {
      if (err.status === 429) throw new RdwError('rate-limited', 'RDW rate limit reached', 429);
      throw new RdwError('unavailable', `RDW unavailable (${err.status || err.name})`, 502);
    }
  }

  async function lookup(input) {
    const k = calc.normalizeKenteken(input);
    if (!calc.isValidKenteken(k)) throw new RdwError('invalid', 'Not a valid Dutch licence plate', 400);
    const key = `rdw:${k}`;
    const hit = cache.get(key);
    if (hit !== undefined) {
      if (hit === null) throw new RdwError('not-found', 'Licence plate not found in RDW register', 404);
      return { ...hit, cached: true };
    }
    let basis;
    let fuelRows;
    const extrasP = fetchExtras(k).catch(() => ({ body: null, drive: 'unknown', recalls: null, missing: ['body', 'drive', 'recalls'] }));
    try {
      [basis, fuelRows] = await Promise.all([get(BASIS_DATASET, k), get(FUEL_DATASET, k)]);
    } catch (err) {
      console.warn(`rdw lookup ${calc.maskKenteken(k)} failed: ${err.message}`);
      throw err;
    }
    if (!Array.isArray(basis) || !basis.length) {
      cache.set(key, null, NOT_FOUND_TTL_S);
      throw new RdwError('not-found', 'Licence plate not found in RDW register', 404);
    }
    const extras = { ...mapBasisExtras(basis[0], fuelRows), ...(await extrasP) };
    const vehicle = { ...mapVehicle(basis[0], fuelRows), extras, fetchedAt: new Date().toISOString(), source: 'RDW Open Data (CC0)' };
    cache.set(key, vehicle, CACHE_TTL_S);
    return { ...vehicle, cached: false };
  }

  return { lookup };
}

module.exports = {
  makeRdwClient, mapVehicle, mapRecalls, mapBody, mapBasisExtras, RdwError,
  BASIS_DATASET, FUEL_DATASET, RECALL_STATUS_DATASET, RECALL_DETAIL_DATASET, RECALL_RISK_DATASET, BODY_DATASET, AXLE_DATASET,
};
