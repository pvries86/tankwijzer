'use strict';

/*
 * ANWB Onderweg per-station fuel prices (NL / BE / DE and more), from the public
 * points-of-interest endpoint used by the ANWB Onderweg app / route planner.
 *
 * Scope: one private, self-hosted installation of the operator, who was advised by App It Up
 * (the NL data supplier) to use ANWB Onderweg. ANWB publishes no API terms, and every response
 * carries a copyright notice requiring ANWB's prior written approval for reuse. The provider
 * therefore only runs when the operator sets ANWB_PRIVATE_USE_ACK=true. See README "ANWB Onderweg".
 *
 * Conservative use:
 * - plain GET requests with an honest User-Agent; no keys, no header tricks
 * - grid-aligned tiles (default 0.5 deg lat x 0.75 deg lon) so nearby searches share one cached tile
 * - tile cache (default 3 h, max 24 h), a global min interval, hourly and daily request caps
 * - 401/403 => permanent stop (blocked.json, never retried automatically);
 *   429 => long back-off (Retry-After, at least 6 h); other errors => 30 min back-off
 */

const fs = require('fs');
const path = require('path');
const { Throttle } = require('../cache');
const { tr } = require('../i18n');

const ANWB_FUEL_TYPES = { EURO95: 'e10', EURO98: 'e5_98', DIESEL: 'diesel', AUTOGAS: 'lpg', LPG: 'lpg' };
// DIESEL_SPECIAL (premium diesel), CNG and LEADED are never used for the regular grades above.

const ISO3_TO_ISO2 = {
  NLD: 'NL', BEL: 'BE', DEU: 'DE', LUX: 'LU', FRA: 'FR', AUT: 'AT', CHE: 'CH', DNK: 'DK', ITA: 'IT',
  ESP: 'ES', PRT: 'PT', GBR: 'GB', IRL: 'IE', POL: 'PL', CZE: 'CZ', SWE: 'SE', NOR: 'NO', FIN: 'FI',
  HRV: 'HR', SVN: 'SI', SVK: 'SK', HUN: 'HU', LIE: 'LI', AND: 'AD', MCO: 'MC', SMR: 'SM', BIH: 'BA',
  SRB: 'RS', MNE: 'ME', MKD: 'MK', ALB: 'AL', GRC: 'GR', BGR: 'BG', ROU: 'RO', EST: 'EE', LVA: 'LV', LTU: 'LT',
};

const DATA_ORIGIN = [
  [/^appitup_/i, 'App It Up'],
  [/^xavvy_/i, 'Xavvy'],
];

const TILE_DECIMALS = 4;
const HOUR = 3600000;

function cleanPrice(v) {
  const n = typeof v === 'string' ? Number(v.replace(',', '.')) : Number(v);
  if (!Number.isFinite(n) || n < 0.2 || n > 10) return null; // 0 = "not sold / unknown" in ANWB data
  return Math.round(n * 1000) / 1000;
}

function countryOf(rec) {
  const iso3 = rec && rec.address && String(rec.address.iso3CountryCode || '').toUpperCase();
  if (iso3 && ISO3_TO_ISO2[iso3]) return ISO3_TO_ISO2[iso3];
  const m = /\|([A-Z]{3})\|/.exec(String((rec && rec.id) || ''));
  if (m && ISO3_TO_ISO2[m[1]]) return ISO3_TO_ISO2[m[1]];
  if (iso3 && iso3.length === 3) return iso3; // unknown but explicit: keep, never guess
  return null;
}

function dataOriginOf(id) {
  for (const [re, name] of DATA_ORIGIN) if (re.test(String(id || ''))) return name;
  return null;
}

function attribution(origin) {
  return origin ? `ANWB Onderweg (data: ${origin})` : 'ANWB Onderweg';
}

/** Parse one ANWB POI v3 response into normalised stations with their per-fuel prices. */
function parseAnwbResponse(json, fetchedAt) {
  if (!json || !Array.isArray(json.value)) throw new Error('unexpected ANWB response (no "value" list)');
  const out = [];
  for (const rec of json.value) {
    if (!rec || (rec.type && rec.type !== 'FUEL_STATION')) continue;
    const lat = Number(rec.coordinates && rec.coordinates.latitude);
    const lon = Number(rec.coordinates && rec.coordinates.longitude);
    const country = countryOf(rec);
    if (!rec.id || !Number.isFinite(lat) || !Number.isFinite(lon) || !country) continue;
    const fuels = {};
    const listed = [];
    for (const p of Array.isArray(rec.prices) ? rec.prices : []) {
      const type = String((p && p.fuelType) || '').toUpperCase();
      if (type) listed.push(type);
      const id = ANWB_FUEL_TYPES[type];
      const price = cleanPrice(p && p.value);
      if (!id || price === null) continue;
      if (p.currency && p.currency !== 'EUR') continue;
      if (!fuels[id]) fuels[id] = { price, fuelName: p.fuelName || type, fuelType: type };
    }
    const a = rec.address || {};
    const address = [a.streetAddress, [a.postalCode, a.city].filter(Boolean).join(' ')].filter(Boolean).join(', ');
    const origin = dataOriginOf(rec.id);
    out.push({
      id: `anwb:${rec.id}`,
      anwbId: String(rec.id),
      name: rec.title || 'Fuel station',
      brand: rec.title || null,
      lat,
      lon,
      country,
      address: address || null,
      tags: {},
      dataOrigin: origin,
      anwbFuels: fuels,
      listedFuelTypes: listed,
      fetchedAt,
    });
  }
  return out;
}

/** Whether an ANWB station sells the fuel: listed with a price => yes; other fuels listed => no. */
function anwbFuelAvailability(station, fuelId, requireTag) {
  if (station.anwbFuels && station.anwbFuels[fuelId]) return 'yes';
  if (station.listedFuelTypes && station.listedFuelTypes.length) return 'no';
  return requireTag ? 'no' : 'unknown';
}

// ---------------------------------------------------------------- tiles
function tileKey(i, j) {
  return `${i}:${j}`;
}

function segmentDistanceKm(p, a, b) {
  const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 110.57;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
  if (!b) return Math.hypot(ax, ay);
  const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/**
 * Grid-aligned tiles covering the search area (circle around start, or corridor start->destination),
 * nearest to the start first. Each tile's bbox is exactly the grid cell, so it is cacheable.
 */
function tilesFor({ start, destination, radiusKm }, tileLat, tileLon) {
  const pts = [start, destination].filter(Boolean);
  const dLat = radiusKm / 110.57;
  const minLat = Math.min(...pts.map((p) => p.lat)) - dLat;
  const maxLat = Math.max(...pts.map((p) => p.lat)) + dLat;
  const cos = Math.max(0.2, Math.cos((Math.max(Math.abs(minLat), Math.abs(maxLat)) * Math.PI) / 180));
  const dLon = radiusKm / (111.32 * cos);
  const minLon = Math.min(...pts.map((p) => p.lon)) - dLon;
  const maxLon = Math.max(...pts.map((p) => p.lon)) + dLon;
  const tiles = [];
  for (let i = Math.floor(minLat / tileLat); i * tileLat < maxLat; i++) {
    for (let j = Math.floor(minLon / tileLon); j * tileLon < maxLon; j++) {
      const bbox = [i * tileLat, j * tileLon, (i + 1) * tileLat, (j + 1) * tileLon].map((v) => Number(v.toFixed(TILE_DECIMALS)));
      // nearest point of the tile to the search segment (approx.: clamp start/destination into the tile)
      const near = Math.min(...pts.map((p) => segmentDistanceKm(
        { lat: Math.min(Math.max(p.lat, bbox[0]), bbox[2]), lon: Math.min(Math.max(p.lon, bbox[1]), bbox[3]) }, start, destination)));
      const center = { lat: (bbox[0] + bbox[2]) / 2, lon: (bbox[1] + bbox[3]) / 2 };
      const halfDiagKm = Math.hypot((tileLat / 2) * 110.57, (tileLon / 2) * 111.32 * cos);
      const centerDist = segmentDistanceKm(center, start, destination);
      if (Math.min(near, centerDist - halfDiagKm) > radiusKm) continue;
      tiles.push({ key: tileKey(i, j), bbox, order: segmentDistanceKm(center, start, null) });
    }
  }
  return tiles.sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------- client
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value));
    fs.renameSync(tmp, file);
  } catch (err) {
    console.warn(`[anwb] could not write ${file}: ${err.message}`);
  }
}

function makeAnwbClient(config, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => Date.now());
  const dir = config.anwbDataDir ? path.resolve(config.anwbDataDir) : null;
  const files = dir && {
    blocked: path.join(dir, 'blocked.json'),
    state: path.join(dir, 'state.json'),
    cache: path.join(dir, 'tiles.json'),
  };
  const ttlMs = Math.min(24, Math.max(1, config.anwbCacheTtlH)) * HOUR;
  const maxAgeMs = Math.max(ttlMs, Math.min(48, config.anwbMaxAgeH) * HOUR);
  const staleAfterMs = Math.max(ttlMs, config.anwbStaleAfterH * HOUR);
  const throttle = deps.throttle || new Throttle(Math.max(1000, config.anwbMinIntervalMs));

  const persisted = (files && readJson(files.state)) || {};
  const state = {
    requests: Array.isArray(persisted.requests) ? persisted.requests.filter((t) => now() - t < 24 * HOUR) : [],
    backoffUntil: persisted.backoffUntil || null,
    backoffReason: persisted.backoffReason || null,
    consecutive429: persisted.consecutive429 || 0,
    lastError: persisted.lastError || null,
    lastSuccess: persisted.lastSuccess || null,
  };
  let blocked = files ? readJson(files.blocked) : null;
  const tiles = new Map(Object.entries((files && readJson(files.cache)) || {}));
  for (const [k, t] of tiles) if (!t || now() - Date.parse(t.fetchedAt) > maxAgeMs) tiles.delete(k);

  function saveState() {
    if (files) writeJson(files.state, state);
  }
  function saveCache() {
    if (!files) return;
    const obj = {};
    for (const [k, t] of tiles) if (now() - Date.parse(t.fetchedAt) <= maxAgeMs) obj[k] = t;
    writeJson(files.cache, obj);
  }
  function reloadBlock() {
    if (files) blocked = readJson(files.blocked);
    return blocked;
  }
  function setBlocked(httpStatus, host) {
    blocked = {
      at: new Date(now()).toISOString(),
      httpStatus,
      host,
      message: `ANWB refused access (HTTP ${httpStatus}). No further ANWB requests are made until this file is removed by the operator.`,
    };
    if (files) writeJson(files.blocked, blocked);
    console.warn(`[anwb] BLOCKED: HTTP ${httpStatus} from ${host}. All ANWB requests stopped (see README).`);
  }

  function disabledReason() {
    if (!config.anwbAck) return 'not-acknowledged';
    if (config.anwbPaused) return 'paused';
    if (reloadBlock()) return 'blocked';
    return null;
  }

  function budgetReason() {
    const t = now();
    state.requests = state.requests.filter((x) => t - x < 24 * HOUR);
    if (state.backoffUntil && t < Date.parse(state.backoffUntil)) return 'backoff';
    if (state.requests.length >= config.anwbDailyBudget) return 'daily-budget';
    if (state.requests.filter((x) => t - x < HOUR).length >= config.anwbHourlyBudget) return 'hourly-budget';
    return null;
  }

  function backoff(ms, reason) {
    state.backoffUntil = new Date(now() + ms).toISOString();
    state.backoffReason = reason;
    saveState();
  }

  async function fetchTile(tile) {
    const url = `${config.anwbUrl}?type-filter=FUEL_STATION&bounding-box-filter=${tile.bbox.join(',')}`;
    const host = new URL(url).host;
    state.requests.push(now());
    let res;
    try {
      res = await fetchImpl(url, {
        headers: { 'User-Agent': config.anwbUserAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(config.anwbTimeoutMs),
      });
    } catch (err) {
      state.lastError = { at: new Date(now()).toISOString(), message: `network error: ${err.message}` };
      backoff(config.anwbErrorBackoffMin * 60000, 'error');
      throw new Error(state.lastError.message);
    }
    if (res.status === 401 || res.status === 403) {
      state.lastError = { at: new Date(now()).toISOString(), message: `HTTP ${res.status}`, httpStatus: res.status };
      saveState();
      setBlocked(res.status, host);
      const e = new Error(`ANWB blocked (HTTP ${res.status})`);
      e.blocked = true;
      throw e;
    }
    if (res.status === 429) {
      state.consecutive429 += 1;
      const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
      const min = 6 * HOUR * 2 ** Math.min(3, state.consecutive429 - 1);
      state.lastError = { at: new Date(now()).toISOString(), message: 'HTTP 429 (rate limited)', httpStatus: 429 };
      backoff(Math.max(min, Number.isFinite(ra) ? ra * 1000 : 0), 'rate-limited');
      throw new Error('ANWB rate limited (HTTP 429)');
    }
    if (!res.ok) {
      state.lastError = { at: new Date(now()).toISOString(), message: `HTTP ${res.status}`, httpStatus: res.status };
      backoff(config.anwbErrorBackoffMin * 60000, 'error');
      throw new Error(`ANWB responded ${res.status}`);
    }
    let stations;
    const fetchedAt = new Date(now()).toISOString();
    try {
      stations = parseAnwbResponse(await res.json(), fetchedAt);
    } catch (err) {
      state.lastError = { at: fetchedAt, message: err.message };
      backoff(config.anwbErrorBackoffMin * 60000, 'error');
      throw err;
    }
    state.consecutive429 = 0;
    state.lastSuccess = fetchedAt;
    state.backoffUntil = null;
    state.backoffReason = null;
    saveState();
    const entry = { fetchedAt, bbox: tile.bbox, stations };
    tiles.set(tile.key, entry);
    saveCache();
    return entry;
  }

  /** Stations for a search. Returns { stations, tiles: summary, reasons } or throws if nothing usable. */
  async function find(search) {
    const all = tilesFor(search, config.anwbTileLatDeg, config.anwbTileLonDeg);
    const wanted = all.slice(0, config.anwbMaxTilesPerSearch);
    const summary = { total: all.length, used: 0, fetched: 0, cached: 0, stale: 0, missing: 0, skippedOverLimit: all.length - wanted.length };
    const reasons = {};
    const entries = [];
    const isBlocked = !!reloadBlock();
    for (const tile of wanted) {
      const cached = tiles.get(tile.key);
      const age = cached ? now() - Date.parse(cached.fetchedAt) : Infinity;
      if (cached && age <= ttlMs && !isBlocked) {
        entries.push(cached);
        summary.cached += 1;
        continue;
      }
      const why = disabledReason() || budgetReason();
      let entry = null;
      if (!why) {
        try {
          entry = await throttle.run(() => fetchTile(tile));
          summary.fetched += 1;
        } catch (err) {
          reasons[err.blocked ? 'blocked' : 'fetch-failed'] = err.message;
        }
      } else {
        reasons[why] = true;
      }
      // Never keep serving earlier ANWB data once ANWB has refused access.
      if (!entry && cached && age <= maxAgeMs && why !== 'blocked' && !reasons.blocked) {
        entry = cached;
        summary.stale += 1;
      }
      if (entry) entries.push(entry);
      else summary.missing += 1;
    }
    summary.used = entries.length;
    if (!entries.length) {
      const why = Object.keys(reasons)[0] || 'no-data';
      const e = new Error(describeReason(why, reasons[why], search && search.lang));
      e.reason = why;
      throw e;
    }
    const seen = new Set();
    const stations = [];
    for (const e of entries) {
      for (const s of e.stations) {
        if (seen.has(s.id)) continue;
        seen.add(s.id);
        stations.push(s);
      }
    }
    return {
      stations,
      tiles: summary,
      reasons,
      oldestFetchedAt: entries.map((e) => e.fetchedAt).sort()[0],
    };
  }

  function status() {
    const t = now();
    const reason = disabledReason();
    return {
      ok: !reason,
      enabled: !!config.anwbAck,
      paused: !!config.anwbPaused,
      blocked: reloadBlock(),
      backoffUntil: state.backoffUntil && t < Date.parse(state.backoffUntil) ? state.backoffUntil : null,
      backoffReason: state.backoffUntil && t < Date.parse(state.backoffUntil) ? state.backoffReason : null,
      requestsLastHour: state.requests.filter((x) => t - x < HOUR).length,
      requestsLast24h: state.requests.filter((x) => t - x < 24 * HOUR).length,
      hourlyBudget: config.anwbHourlyBudget,
      dailyBudget: config.anwbDailyBudget,
      cacheTtlH: ttlMs / HOUR,
      cachedTiles: tiles.size,
      lastSuccess: state.lastSuccess,
      lastError: state.lastError,
      reason,
    };
  }

  return { find, status, now, ttlMs, maxAgeMs, staleAfterMs, _tiles: tiles, _state: state };
}

function describeReason(why, detail, lang) {
  const t = tr(lang);
  switch (why) {
    case 'not-acknowledged': return t('ANWB provider not enabled (ANWB_PRIVATE_USE_ACK is not set)', 'ANWB-bron staat uit (ANWB_PRIVATE_USE_ACK is niet gezet)');
    case 'paused': return t('ANWB paused by operator (ANWB_PAUSED)', 'ANWB gepauzeerd door de beheerder (ANWB_PAUSED)');
    case 'blocked': return t('ANWB blocked access; not retrying', 'ANWB heeft de toegang geblokkeerd; er wordt niet opnieuw geprobeerd');
    case 'backoff': return t('ANWB requests paused after an error or rate limit', 'ANWB-verzoeken gepauzeerd na een fout of limiet');
    case 'daily-budget': return t('ANWB daily request budget reached', 'dagelijks ANWB-verzoekbudget bereikt');
    case 'hourly-budget': return t('ANWB hourly request budget reached', 'ANWB-verzoekbudget per uur bereikt');
    case 'fetch-failed': return t(`ANWB request failed (${detail})`, `ANWB-verzoek mislukt (${detail})`);
    default: return t('no ANWB data', 'geen ANWB-gegevens');
  }
}

// ---------------------------------------------------------------- station + price providers
function makeAnwbStationProvider(client) {
  return {
    id: 'anwb',
    label: 'ANWB Onderweg (stations with prices)',
    license: '© ANWB and/or its licensors — private personal use only, no redistribution',
    async find(search) {
      const r = await client.find(search);
      const lang = search && search.lang;
      const t = tr(lang);
      const warnings = [];
      if (r.tiles.missing || r.tiles.skippedOverLimit) {
        const parts = [];
        const why = Object.keys(r.reasons).map((k) => describeReason(k, r.reasons[k], lang)).join('; ');
        if (r.tiles.missing) parts.push(t(`${r.tiles.missing} area tile(s) could not be loaded (${why})`, `${r.tiles.missing} gebiedstegel(s) konden niet worden geladen (${why})`));
        if (r.tiles.skippedOverLimit) parts.push(t(`${r.tiles.skippedOverLimit} tile(s) were skipped to stay within the per-search request limit`, `${r.tiles.skippedOverLimit} tegel(s) overgeslagen om binnen de verzoeklimiet per zoekopdracht te blijven`));
        warnings.push(t(`ANWB coverage is incomplete for this search: ${parts.join('; ')}. Stations there are not shown.`,
          `ANWB-dekking is onvolledig voor deze zoekopdracht: ${parts.join('; ')}. Stations daar worden niet getoond.`));
      }
      if (r.tiles.stale) {
        warnings.push(t(`${r.tiles.stale} ANWB area tile(s) could not be refreshed and use prices retrieved earlier (marked as older).`,
          `${r.tiles.stale} ANWB-gebiedstegel(s) konden niet worden ververst en gebruiken eerder opgehaalde prijzen (gemarkeerd als ouder).`));
      }
      return {
        stations: r.stations,
        source: {
          provider: 'anwb',
          endpoint: 'api.anwb.nl',
          fetchedAt: r.oldestFetchedAt,
          tiles: r.tiles,
          warnings,
        },
      };
    },
  };
}

function makeAnwbPriceProvider(client) {
  function quote(station, fuelId) {
    return station.anwbFuels ? station.anwbFuels[fuelId] || null : null;
  }
  return {
    id: 'anwb',
    label: 'ANWB Onderweg per-station prices',
    async prefetch() {
      return { results: {}, status: client.status() };
    },
    stationPrice(station, fuelId) {
      const q = quote(station, fuelId);
      if (!q || !station.fetchedAt) return null;
      const age = (client.now ? client.now() : Date.now()) - Date.parse(station.fetchedAt);
      if (!Number.isFinite(age) || age > client.maxAgeMs) return null;
      const live = age <= client.staleAfterMs;
      const src = attribution(station.dataOrigin);
      return {
        price: q.price,
        kind: 'station',
        quality: live ? 'live-quote' : 'stale-quote',
        estimate: false,
        source: src,
        dataOrigin: station.dataOrigin,
        sourceUrl: 'https://www.anwb.nl/mobiel/onderweg-app',
        license: '© ANWB and/or its licensors — private personal use only, no redistribution',
        asOf: null,
        priceDateKnown: false,
        fetchedAt: station.fetchedAt,
        live,
        product: q.fuelName,
        note: `Price for "${q.fuelName}" retrieved from ${src} at ${station.fetchedAt}. ` +
          'ANWB does not report when the station set this price (price date unknown).' +
          (live ? '' : ' Retrieved a while ago because a refresh was not possible.'),
      };
    },
    missReason(station, fuelId, ctx, lang) {
      const t = tr(lang);
      if (!station.anwbFuels) {
        const st = ctx && ctx.status;
        if (st && st.reason) return describeReason(st.reason, undefined, lang);
        return t('station not in ANWB data', 'station staat niet in de ANWB-gegevens');
      }
      if (!quote(station, fuelId)) return t('ANWB lists no price for this fuel here', 'ANWB heeft hier geen prijs voor deze brandstof');
      return t('ANWB price too old', 'ANWB-prijs te oud');
    },
    warnings(ctx, stations, lang) {
      const t = tr(lang);
      const st = (ctx && ctx.status) || {};
      if (st.reason === 'not-acknowledged') {
        return [t('ANWB Onderweg station prices are off: set ANWB_PRIVATE_USE_ACK=true only if you accept the personal-use conditions in the README. Country ESTIMATES (CBS / FOD) are shown instead.',
          'ANWB Onderweg-stationsprijzen staan uit: zet ANWB_PRIVATE_USE_ACK=true alleen als je de voorwaarden voor persoonlijk gebruik in de README accepteert. In plaats daarvan worden landelijke SCHATTINGEN (CBS / FOD) getoond.')];
      }
      if (st.reason === 'paused') {
        return [t('ANWB Onderweg paused by the operator (ANWB_PAUSED): no ANWB requests are made; cached or estimated prices are used.',
          'ANWB Onderweg gepauzeerd door de beheerder (ANWB_PAUSED): er worden geen ANWB-verzoeken gedaan; gecachte of geschatte prijzen worden gebruikt.')];
      }
      if (st.reason === 'blocked') {
        const b = st.blocked || {};
        const since = b.at ? t(` since ${b.at}`, ` sinds ${b.at}`) : '';
        return [t(`ANWB blocked (${b.httpStatus || 403})${since}: all ANWB requests are stopped and will not be retried. ` +
          'Do not change IP address, VPN or proxy to get around this. Contact ANWB, and delete blocked.json from the ANWB data directory only after the issue is resolved (see README). ' +
          'Country ESTIMATES (CBS / FOD) are shown instead.',
        `ANWB geblokkeerd (${b.httpStatus || 403})${since}: alle ANWB-verzoeken zijn gestopt en worden niet opnieuw geprobeerd. ` +
          'Verander geen IP-adres, VPN of proxy om dit te omzeilen. Neem contact op met ANWB en verwijder blocked.json uit de ANWB-datamap pas als het is opgelost (zie README). ' +
          'In plaats daarvan worden landelijke SCHATTINGEN (CBS / FOD) getoond.')];
      }
      if (st.backoffUntil) {
        const why = st.backoffReason === 'rate-limited' ? t('ANWB rate-limited this installation', 'ANWB heeft deze installatie afgeremd') : t('after an error', 'na een fout');
        return [t(`ANWB requests are paused until ${st.backoffUntil} (${why}); cached prices are used where available.`,
          `ANWB-verzoeken zijn gepauzeerd tot ${st.backoffUntil} (${why}); waar mogelijk worden gecachte prijzen gebruikt.`)];
      }
      return [];
    },
    async status() {
      return client.status();
    },
  };
}

module.exports = {
  makeAnwbClient,
  makeAnwbStationProvider,
  makeAnwbPriceProvider,
  parseAnwbResponse,
  anwbFuelAvailability,
  tilesFor,
  cleanPrice,
  countryOf,
  dataOriginOf,
  describeReason,
};
