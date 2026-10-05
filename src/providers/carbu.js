'use strict';

/*
 * CARBU.COM per-station fuel prices for Belgium (native Node implementation).
 *
 * Scope: one private, self-hosted installation whose operator holds written permission from
 * CARBU.COM for automated retrieval and local caching, without redistribution. The provider only
 * runs when the operator sets CARBU_PRIVATE_USE_ACK=true. See README "CARBU.COM".
 *
 * How it is used:
 * - Only Belgian stations (the /belgie/ station list). Other countries are not requested.
 * - For the Belgian candidate stations of a search, the postal code of the nearest one is looked up
 *   (location lookup, cached 30 days), then ONE station list for that place + fuel is fetched
 *   (covers roughly 25 km around the place; cached for hours). At most CARBU_MAX_LOCATIONS_PER_SEARCH
 *   places per search. Carbu stations are matched to the candidate stations by position.
 * - Plain GET requests, honest User-Agent, >= 1 s between requests, hourly and daily caps.
 * - 401/403 => permanent stop (blocked.json, never retried automatically);
 *   429 => long back-off (Retry-After, at least 6 h); other errors / unexpected pages => 30 min back-off.
 * - Each quote keeps CARBU.COM's per-station update date as the price date.
 */

const fs = require('fs');
const path = require('path');
const { Throttle } = require('../cache');
const { haversineKm } = require('../http');
const { tr } = require('../i18n');

const CARBU_FUEL_CODES = { e10: 'E10', e5_98: 'SP98', diesel: 'GO', lpg: 'GPL' };
const HOUR = 3600000;
const DAY = 24 * HOUR;
const LICENSE = '© CARBU.COM. Used with written permission for this private installation only; no redistribution';

// ---------------------------------------------------------------- HTML helpers
const NAMED_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: '€',
  eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', aacute: 'á', agrave: 'à', acirc: 'â', auml: 'ä',
  iacute: 'í', igrave: 'ì', icirc: 'î', iuml: 'ï', oacute: 'ó', ograve: 'ò', ocirc: 'ô', ouml: 'ö',
  uacute: 'ú', ugrave: 'ù', ucirc: 'û', uuml: 'ü', ccedil: 'ç', ntilde: 'ñ',
  Eacute: 'É', Egrave: 'È', Euml: 'Ë', Ccedil: 'Ç', Ouml: 'Ö', Uuml: 'Ü', Auml: 'Ä',
};

function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, e) ? NAMED_ENTITIES[e] : m;
  });
}

function cleanText(s) {
  return decodeEntities(String(s || '').replace(/<br\s*\/?>/gi, ', ').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ').replace(/\s*,\s*/g, ', ').replace(/^[\s,]+|[\s,]+$/g, '');
}

function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m;
  while ((m = re.exec(tag))) out[m[1].toLowerCase()] = m[3] !== undefined ? m[3] : m[4];
  return out;
}

function cleanPrice(v) {
  const n = Number(String(v || '').trim().replace(',', '.'));
  if (!String(v || '').trim() || !Number.isFinite(n) || n < 0.2 || n > 10) return null;
  return Math.round(n * 1000) / 1000;
}

/** "29/09/26" or "29/09/2026" => "2026-09-29" (calendar date as shown by CARBU.COM, Belgian time). */
function parseCarbuDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = Number(m[1]);
  const mo = Number(m[2]);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const t = new Date(`${iso}T00:00:00Z`);
  return t.getUTCDate() === d ? iso : null;
}

const DATE_LABEL = /(?:Update-datum|Date de mise (?:à|&agrave;) jour|Mise (?:à|&agrave;) jour|Aktualisierungsdatum)\s*:?\s*(?:<[^>]*>\s*)*(\d{1,2}\/\d{1,2}\/\d{2,4})/i;

/**
 * Parse a CARBU.COM station-list page. Returns stations with a price for the requested list fuel
 * (price null when the station has no current price for it).
 */
function parseCarbuStationList(html, fetchedAt) {
  const text = String(html || '');
  const starts = [];
  // Quote-aware: attribute values (e.g. data-address) contain literal "<br/>".
  const re = /<div\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
  let m;
  while ((m = re.exec(text))) {
    if (/\sid\s*=\s*"item_\d+"/i.test(m[0])) starts.push({ index: m.index, end: re.lastIndex, tag: m[0] });
  }
  const out = [];
  starts.forEach((s, k) => {
    const a = attrs(s.tag);
    const id = a['data-id'];
    const lat = Number(a['data-lat']);
    const lon = Number(a['data-lng']);
    if (!id || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    const body = text.slice(s.end, k + 1 < starts.length ? starts[k + 1].index : Math.min(text.length, s.end + 30000));
    const dm = DATE_LABEL.exec(body);
    const price = cleanPrice(a['data-price']);
    const distance = Number(a['data-distance']);
    out.push({
      carbuId: String(id),
      name: cleanText(a['data-name']) || 'Fuel station',
      address: cleanText(a['data-address']) || null,
      lat,
      lon,
      price,
      fuelName: cleanText(a['data-fuelname']) || null,
      priceDate: price !== null && dm ? parseCarbuDate(dm[1]) : null,
      distanceKm: Number.isFinite(distance) ? Math.round(distance * 100) / 100 : null,
      link: /^https:\/\/(www\.)?carbu\.com\//.test(a['data-link'] || '') ? a['data-link'] : null,
      fetchedAt,
    });
  });
  return out;
}

/** Parse the location lookup JSON and pick the Belgian entry for the postal code. */
function parseCarbuLocation(json, postalCode) {
  const list = Array.isArray(json) ? json : [];
  const be = list.filter((x) => x && x.id && x.n && String(x.c || '').toUpperCase() === 'BE');
  const hit = be.find((x) => String(x.pc) === String(postalCode)) || be[0];
  if (!hit) return null;
  return { id: String(hit.id), town: String(hit.n), postalCode: String(hit.pc || postalCode) };
}

/** Belgian postal code (4 digits) from a station address like "Street 1, 2387 Baarle-Hertog". */
function postalCodeOf(station) {
  const t = station && station.tags;
  if (t && /^\d{4}$/.test(String(t['addr:postcode'] || '').trim())) return String(t['addr:postcode']).trim();
  const m = /(?:^|,\s*)(?:B-)?(\d{4})\s+\S/.exec(String((station && station.address) || ''));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------- persistence
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
    console.warn(`[carbu] could not write ${file}: ${err.message}`);
  }
}

function describeReason(why, detail, lang) {
  const t = tr(lang);
  switch (why) {
    case 'not-acknowledged': return t('CARBU.COM provider not enabled (CARBU_PRIVATE_USE_ACK is not set)', 'CARBU.COM-bron staat uit (CARBU_PRIVATE_USE_ACK is niet gezet)');
    case 'paused': return t('CARBU.COM paused by operator (CARBU_PAUSED)', 'CARBU.COM gepauzeerd door de beheerder (CARBU_PAUSED)');
    case 'blocked': return t('CARBU.COM blocked access; not retrying', 'CARBU.COM heeft de toegang geblokkeerd; er wordt niet opnieuw geprobeerd');
    case 'backoff': return t('CARBU.COM requests paused after an error or rate limit', 'CARBU.COM-verzoeken gepauzeerd na een fout of limiet');
    case 'daily-budget': return t('CARBU.COM daily request budget reached', 'dagelijks CARBU.COM-verzoekbudget bereikt');
    case 'hourly-budget': return t('CARBU.COM hourly request budget reached', 'CARBU.COM-verzoekbudget per uur bereikt');
    case 'fetch-failed': return t(`CARBU.COM request failed (${detail})`, `CARBU.COM-verzoek mislukt (${detail})`);
    case 'no-postal-code': return t('no Belgian postal code known for the nearby stations', 'geen Belgische postcode bekend voor de stations in de buurt');
    case 'unknown-location': return t('CARBU.COM does not know this place', 'CARBU.COM kent deze plaats niet');
    default: return t('no CARBU.COM data', 'geen CARBU.COM-gegevens');
  }
}

// ---------------------------------------------------------------- client
function makeCarbuClient(config, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => Date.now());
  const dir = config.carbuDataDir ? path.resolve(config.carbuDataDir) : null;
  const files = dir && {
    blocked: path.join(dir, 'blocked.json'),
    state: path.join(dir, 'state.json'),
    lists: path.join(dir, 'lists.json'),
    locations: path.join(dir, 'locations.json'),
  };
  const base = String(config.carbuBaseUrl || 'https://carbu.com').replace(/\/+$/, '');
  const ttlMs = Math.min(24, Math.max(1, config.carbuCacheTtlH)) * HOUR;
  const maxAgeMs = Math.max(ttlMs, Math.min(48, config.carbuMaxAgeH) * HOUR);
  const staleAfterMs = Math.max(ttlMs, config.carbuStaleAfterH * HOUR);
  const locationTtlMs = Math.max(1, config.carbuLocationTtlD) * DAY;
  const throttle = deps.throttle || new Throttle(Math.max(1000, config.carbuMinIntervalMs));

  const persisted = (files && readJson(files.state)) || {};
  const state = {
    requests: Array.isArray(persisted.requests) ? persisted.requests.filter((t) => now() - t < DAY) : [],
    backoffUntil: persisted.backoffUntil || null,
    backoffReason: persisted.backoffReason || null,
    consecutive429: persisted.consecutive429 || 0,
    lastError: persisted.lastError || null,
    lastSuccess: persisted.lastSuccess || null,
  };
  let blocked = files ? readJson(files.blocked) : null;
  const lists = new Map(Object.entries((files && readJson(files.lists)) || {}));
  for (const [k, l] of lists) if (!l || now() - Date.parse(l.fetchedAt) > maxAgeMs) lists.delete(k);
  const locations = new Map(Object.entries((files && readJson(files.locations)) || {}));
  for (const [k, l] of locations) if (!l || now() - Date.parse(l.at) > locationTtlMs) locations.delete(k);

  const saveState = () => files && writeJson(files.state, state);
  const saveLists = () => {
    if (!files) return;
    const obj = {};
    for (const [k, l] of lists) if (now() - Date.parse(l.fetchedAt) <= maxAgeMs) obj[k] = l;
    writeJson(files.lists, obj);
  };
  const saveLocations = () => files && writeJson(files.locations, Object.fromEntries(locations));
  const reloadBlock = () => {
    if (files) blocked = readJson(files.blocked);
    return blocked;
  };

  function disabledReason() {
    if (!config.carbuAck) return 'not-acknowledged';
    if (config.carbuPaused) return 'paused';
    if (reloadBlock()) return 'blocked';
    return null;
  }

  function budgetReason() {
    const t = now();
    state.requests = state.requests.filter((x) => t - x < DAY);
    if (state.backoffUntil && t < Date.parse(state.backoffUntil)) return 'backoff';
    if (state.requests.length >= config.carbuDailyBudget) return 'daily-budget';
    if (state.requests.filter((x) => t - x < HOUR).length >= config.carbuHourlyBudget) return 'hourly-budget';
    return null;
  }

  function backoff(ms, reason) {
    state.backoffUntil = new Date(now() + ms).toISOString();
    state.backoffReason = reason;
    saveState();
  }

  function fail(message, httpStatus) {
    state.lastError = { at: new Date(now()).toISOString(), message, ...(httpStatus ? { httpStatus } : {}) };
    backoff(config.carbuErrorBackoffMin * 60000, 'error');
    return new Error(message);
  }

  /** One GET request under all guards. `parse(res)` turns a 200 response into data or throws. */
  async function request(url, accept, parse) {
    const why = disabledReason() || budgetReason();
    if (why) {
      const e = new Error(describeReason(why));
      e.reason = why;
      throw e;
    }
    return throttle.run(async () => {
      const again = disabledReason() || budgetReason();
      if (again) {
        const e = new Error(describeReason(again));
        e.reason = again;
        throw e;
      }
      const host = new URL(url).host;
      state.requests.push(now());
      const headers = { 'User-Agent': config.carbuUserAgent, Accept: accept };
      if (config.carbuReferer) headers.Referer = config.carbuReferer;
      let res;
      try {
        res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(config.carbuTimeoutMs) });
      } catch (err) {
        throw fail(`network error: ${err.message}`);
      }
      if (res.status === 401 || res.status === 403) {
        state.lastError = { at: new Date(now()).toISOString(), message: `HTTP ${res.status}`, httpStatus: res.status };
        saveState();
        blocked = {
          at: new Date(now()).toISOString(),
          httpStatus: res.status,
          host,
          message: `CARBU.COM refused access (HTTP ${res.status}). No further CARBU.COM requests are made until this file is removed by the operator.`,
        };
        if (files) writeJson(files.blocked, blocked);
        console.warn(`[carbu] BLOCKED: HTTP ${res.status} from ${host}. All CARBU.COM requests stopped (see README).`);
        const e = new Error(`CARBU.COM blocked (HTTP ${res.status})`);
        e.reason = 'blocked';
        throw e;
      }
      if (res.status === 429) {
        state.consecutive429 += 1;
        const ra = Number(res.headers && res.headers.get && res.headers.get('retry-after'));
        const min = 6 * HOUR * 2 ** Math.min(3, state.consecutive429 - 1);
        state.lastError = { at: new Date(now()).toISOString(), message: 'HTTP 429 (rate limited)', httpStatus: 429 };
        backoff(Math.max(min, Number.isFinite(ra) ? ra * 1000 : 0), 'rate-limited');
        throw new Error('CARBU.COM rate limited (HTTP 429)');
      }
      if (!res.ok) throw fail(`HTTP ${res.status}`, res.status);
      let data;
      try {
        data = await parse(res);
      } catch (err) {
        throw fail(`unexpected response: ${err.message}`);
      }
      state.consecutive429 = 0;
      state.lastSuccess = new Date(now()).toISOString();
      state.backoffUntil = null;
      state.backoffReason = null;
      saveState();
      return data;
    });
  }

  async function location(postalCode) {
    const key = `BE:${postalCode}`;
    const hit = locations.get(key);
    if (hit) return hit.location;
    const url = `${base}//commonFunctions/getlocation/controller.getlocation_JSON.php?location=${encodeURIComponent(postalCode)}&SHRT=1`;
    const loc = await request(url, 'application/json, text/javascript, */*', async (res) => {
      const body = await res.text();
      let json;
      try {
        json = JSON.parse(body);
      } catch {
        throw new Error('location lookup did not return JSON');
      }
      if (!Array.isArray(json)) throw new Error('location lookup did not return a list');
      return parseCarbuLocation(json, postalCode);
    });
    locations.set(key, { at: new Date(now()).toISOString(), location: loc });
    saveLocations();
    return loc;
  }

  function listKey(loc, fuelId) {
    return `${loc.id}|${CARBU_FUEL_CODES[fuelId]}`;
  }

  /** Station list for one place and fuel. Returns { entry, cached, stale } or throws. */
  async function list(loc, fuelId) {
    const code = CARBU_FUEL_CODES[fuelId];
    if (!code) throw new Error(`fuel ${fuelId} not available on CARBU.COM`);
    const key = listKey(loc, fuelId);
    const cached = lists.get(key);
    const age = cached ? now() - Date.parse(cached.fetchedAt) : Infinity;
    if (cached && age <= ttlMs) return { entry: cached, cached: true, stale: false };
    const url = `${base}/belgie//liste-stations-service/${encodeURIComponent(code)}/${encodeURIComponent(loc.town)}/${encodeURIComponent(loc.postalCode)}/${encodeURIComponent(loc.id)}`;
    try {
      const fetchedAt = new Date(now()).toISOString();
      const stations = await request(url, 'text/html', async (res) => {
        const html = await res.text();
        const parsed = parseCarbuStationList(html, fetchedAt);
        if (!parsed.length && !/liste-stations-service|stationItem/.test(html)) throw new Error('no station list in page');
        return parsed;
      });
      const entry = { fetchedAt, location: loc, fuelCode: code, stations };
      lists.set(key, entry);
      saveLists();
      return { entry, cached: false, stale: false };
    } catch (err) {
      // Earlier data may be shown (marked older) after errors, but never once CARBU.COM refused access.
      if (cached && age <= maxAgeMs && err.reason !== 'blocked' && !reloadBlock()) {
        return { entry: cached, cached: true, stale: true, error: err };
      }
      throw err;
    }
  }

  function status() {
    const t = now();
    const reason = disabledReason();
    const inBackoff = state.backoffUntil && t < Date.parse(state.backoffUntil);
    return {
      ok: !reason,
      enabled: !!config.carbuAck,
      paused: !!config.carbuPaused,
      blocked: reloadBlock(),
      backoffUntil: inBackoff ? state.backoffUntil : null,
      backoffReason: inBackoff ? state.backoffReason : null,
      requestsLastHour: state.requests.filter((x) => t - x < HOUR).length,
      requestsLast24h: state.requests.filter((x) => t - x < DAY).length,
      hourlyBudget: config.carbuHourlyBudget,
      dailyBudget: config.carbuDailyBudget,
      cacheTtlH: ttlMs / HOUR,
      cachedLists: lists.size,
      lastSuccess: state.lastSuccess,
      lastError: state.lastError,
      reason,
    };
  }

  return { location, list, status, disabledReason, now, ttlMs, maxAgeMs, staleAfterMs, _lists: lists, _state: state };
}

// ---------------------------------------------------------------- price provider
function daysBetween(isoDate, t) {
  return (t - Date.parse(`${isoDate}T12:00:00Z`)) / DAY;
}

function makeCarbuPriceProvider(client, config) {
  const matchKm = Math.max(0.02, (config.carbuMatchRadiusM || 200) / 1000);
  const coverKm = config.carbuCoverKm || 20;
  const maxLocations = Math.max(1, config.carbuMaxLocationsPerSearch || 2);

  async function prefetch(stations, search = {}) {
    const fuelId = search.fuelId;
    const lang = search.lang;
    const t = tr(lang);
    const results = {};
    const misses = {};
    const notes = [];
    const be = stations.filter((s) => s.country === 'BE');
    const origin = search.start || (be[0] && { lat: be[0].lat, lon: be[0].lon });
    const ctx = { results, misses, notes, lists: [], status: null };
    if (!be.length || !CARBU_FUEL_CODES[fuelId]) {
      ctx.status = client.status();
      return ctx;
    }
    const disabled = client.disabledReason();
    if (disabled) {
      for (const s of be) misses[s.id] = describeReason(disabled, undefined, lang);
      ctx.status = client.status();
      return ctx;
    }
    const ordered = [...be].sort((a, b) => haversineKm(origin, a) - haversineKm(origin, b));
    const pending = new Set(ordered.map((s) => s.id));
    const carbuStations = [];
    const triedPostal = new Set();
    let locationsUsed = 0;
    for (const anchor of ordered) {
      if (!pending.has(anchor.id) || locationsUsed >= maxLocations) continue;
      const pc = postalCodeOf(anchor);
      if (!pc) {
        misses[anchor.id] = describeReason('no-postal-code', undefined, lang);
        continue;
      }
      if (triedPostal.has(pc)) continue;
      triedPostal.add(pc);
      locationsUsed += 1;
      try {
        const loc = await client.location(pc);
        if (!loc) {
          notes.push(t(`CARBU.COM does not know postal code ${pc}.`, `CARBU.COM kent postcode ${pc} niet.`));
          continue;
        }
        const r = await client.list(loc, fuelId);
        ctx.lists.push({ place: `${loc.town} (${loc.postalCode})`, fetchedAt: r.entry.fetchedAt, cached: r.cached, stale: r.stale, stations: r.entry.stations.length });
        if (r.stale) {
          notes.push(t(`CARBU.COM list for ${loc.town} could not be refreshed (${r.error.message}); using the copy retrieved at ${r.entry.fetchedAt}.`,
            `CARBU.COM-lijst voor ${loc.town} kon niet worden ververst (${r.error.message}); de kopie van ${r.entry.fetchedAt} wordt gebruikt.`));
        }
        for (const c of r.entry.stations) carbuStations.push({ ...c, stale: r.stale });
        for (const s of ordered) if (pending.has(s.id) && haversineKm(anchor, s) <= coverKm) pending.delete(s.id);
      } catch (err) {
        notes.push(`${describeReason(err.reason || 'fetch-failed', err.message, lang)}.`);
        if (err.reason === 'blocked' || err.reason === 'backoff' || err.reason === 'daily-budget' || err.reason === 'hourly-budget') break;
      }
    }
    for (const s of be) {
      let best = null;
      let bestD = Infinity;
      for (const c of carbuStations) {
        const d = haversineKm(s, c);
        if (d < bestD) {
          best = c;
          bestD = d;
        }
      }
      if (best && bestD <= matchKm) {
        if (best.price !== null) results[s.id] = { ...best, matchM: Math.round(bestD * 1000) };
        else misses[s.id] = t('CARBU.COM lists no current price for this fuel here', 'CARBU.COM heeft hier geen actuele prijs voor deze brandstof');
      } else if (!misses[s.id]) {
        misses[s.id] = carbuStations.length ? t('station not found in CARBU.COM list', 'station niet gevonden in de CARBU.COM-lijst') : t('no CARBU.COM list for this area', 'geen CARBU.COM-lijst voor dit gebied');
      }
    }
    ctx.status = client.status();
    return ctx;
  }

  function stationPrice(station, fuelId, ctx) {
    if (station.country !== 'BE' || !ctx || !ctx.results) return null;
    const q = ctx.results[station.id];
    if (!q) return null;
    const t = client.now();
    const fetchedAge = t - Date.parse(q.fetchedAt);
    if (!Number.isFinite(fetchedAge) || fetchedAge > client.maxAgeMs) return null;
    const priceAgeDays = q.priceDate ? daysBetween(q.priceDate, t) : null;
    if (priceAgeDays !== null && priceAgeDays > (config.carbuPriceMaxDays || 30)) return null;
    const oldPrice = priceAgeDays === null || priceAgeDays > (config.carbuPriceStaleDays || 7);
    const live = !q.stale && fetchedAge <= client.staleAfterMs && !oldPrice;
    return {
      price: q.price,
      kind: 'station',
      quality: live ? 'live-quote' : 'stale-quote',
      estimate: false,
      source: 'CARBU.COM',
      sourceUrl: q.link || 'https://carbu.com/belgie/',
      license: LICENSE,
      asOf: q.priceDate,
      priceDate: q.priceDate,
      priceDateKnown: !!q.priceDate,
      fetchedAt: q.fetchedAt,
      live,
      product: q.fuelName,
      carbuId: q.carbuId,
      carbuName: q.name,
      matchDistanceM: q.matchM,
      note: `Price for "${q.fuelName || fuelId}" at ${q.name} from CARBU.COM, ` +
        (q.priceDate ? `price date ${q.priceDate}` : 'price date not shown') +
        `, retrieved at ${q.fetchedAt}.` +
        (oldPrice && q.priceDate ? ` The price date is more than ${config.carbuPriceStaleDays || 7} days old.` : '') +
        (q.stale || fetchedAge > client.staleAfterMs ? ' Retrieved a while ago because a refresh was not possible.' : ''),
    };
  }

  return {
    id: 'carbu',
    label: 'CARBU.COM per-station prices (BE)',
    prefetch,
    stationPrice,
    missReason(station, fuelId, ctx, lang) {
      const t = tr(lang);
      if (station.country !== 'BE') return null;
      if (!CARBU_FUEL_CODES[fuelId]) return t('fuel not listed on CARBU.COM', 'brandstof staat niet op CARBU.COM');
      return (ctx && ctx.misses && ctx.misses[station.id]) || t('no CARBU.COM price', 'geen CARBU.COM-prijs');
    },
    warnings(ctx, stations, lang) {
      const t = tr(lang);
      const st = (ctx && ctx.status) || {};
      const hasBe = (stations || []).some((s) => s.country === 'BE');
      if (st.reason === 'not-acknowledged' || !hasBe) return [];
      if (st.reason === 'paused') {
        return [t('CARBU.COM paused by the operator (CARBU_PAUSED): no CARBU.COM requests are made; ANWB prices or estimates are used for Belgian stations.',
          'CARBU.COM gepauzeerd door de beheerder (CARBU_PAUSED): er worden geen CARBU.COM-verzoeken gedaan; voor Belgische stations worden ANWB-prijzen of schattingen gebruikt.')];
      }
      if (st.reason === 'blocked') {
        const b = st.blocked || {};
        const since = b.at ? t(` since ${b.at}`, ` sinds ${b.at}`) : '';
        return [t(`CARBU.COM blocked (${b.httpStatus || 403})${since}: all CARBU.COM requests are stopped and will not be retried. ` +
          'Do not change IP address, VPN or proxy to get around this. Contact CARBU.COM, and delete blocked.json from the CARBU data directory only after the issue is resolved (see README). ' +
          'ANWB prices or country ESTIMATES are used for Belgian stations instead.',
        `CARBU.COM geblokkeerd (${b.httpStatus || 403})${since}: alle CARBU.COM-verzoeken zijn gestopt en worden niet opnieuw geprobeerd. ` +
          'Verander geen IP-adres, VPN of proxy om dit te omzeilen. Neem contact op met CARBU.COM en verwijder blocked.json uit de CARBU-datamap pas als het is opgelost (zie README). ' +
          'Voor Belgische stations worden in plaats daarvan ANWB-prijzen of landelijke SCHATTINGEN gebruikt.')];
      }
      const w = [];
      if (ctx && Array.isArray(ctx.notes) && ctx.notes.length) w.push(...ctx.notes.map((n) => `CARBU.COM: ${n}`));
      else if (ctx && ctx.error) {
        w.push(t(`CARBU.COM unavailable (${ctx.error}); ANWB prices or estimates are used for Belgian stations.`,
          `CARBU.COM niet beschikbaar (${ctx.error}); voor Belgische stations worden ANWB-prijzen of schattingen gebruikt.`));
      }
      return w;
    },
    async status() {
      return client.status();
    },
  };
}

module.exports = {
  makeCarbuClient,
  makeCarbuPriceProvider,
  parseCarbuStationList,
  parseCarbuLocation,
  parseCarbuDate,
  postalCodeOf,
  decodeEntities,
  describeReason,
  CARBU_FUEL_CODES,
};
