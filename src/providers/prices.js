'use strict';

const fs = require('fs');
const path = require('path');
const { parseFodMaxPricePdf } = require('./fodPdf');
const { haversineKm } = require('../http');
const { tr } = require('../i18n');

/*
 * Price model. Every price carries provenance so the UI never presents a reference
 * value as a live pump price:
 *   kind: 'station'          - price for this specific station (DirectLease quote or station-file report)
 *         'national-average' - CBS daily national average pump price (NL)
 *         'legal-maximum'    - FOD Economie official maximum price (BE); actual pump prices are often lower
 *         'user'             - entered by the user in the UI
 *   quality: live-quote | stale-quote | station-report | user | country-estimate
 *   estimate: true when the price is NOT specific to this station (country reference / user figure)
 */

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function ageHours(iso, now = Date.now()) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 3600000) : null;
}

// ---------------------------------------------------------------- CBS (NL)
const CBS_FIELDS = { e10: 'BenzineEuro95_1', diesel: 'Diesel_2', lpg: 'Lpg_3' };

function parseCbsRecords(json) {
  const rows = (json && json.value) || [];
  const latest = {};
  for (const row of rows) {
    const p = String(row.Perioden || '').trim();
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(p);
    if (!m) continue;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    for (const [fuel, field] of Object.entries(CBS_FIELDS)) {
      const v = row[field];
      if (typeof v === 'number' && v > 0 && (!latest[fuel] || latest[fuel].date < date)) {
        latest[fuel] = { date, value: v };
      }
    }
  }
  return latest;
}

function makeCbsProvider(config, http, cache) {
  const since = () => isoDate(new Date(Date.now() - 45 * 86400000)).replace(/-/g, '');
  const load = () =>
    cache.wrap('cbs-nl', config.priceCacheTtlS, async () => {
      const url = `${config.cbsUrl}?$filter=${encodeURIComponent(`Perioden ge '${since()}'`)}`;
      const json = await http.json(url);
      return { latest: parseCbsRecords(json), fetchedAt: new Date().toISOString() };
    });
  return {
    id: 'cbs-nl',
    country: 'NL',
    label: 'CBS StatLine 80416ned — daily national average pump price (NL)',
    async reference(fuelId) {
      const data = await load();
      const rec = data.latest[fuelId];
      if (!rec) return null;
      return {
        price: rec.value,
        kind: 'national-average',
        quality: 'country-estimate',
        estimate: true,
        source: 'CBS (Statistics Netherlands), table 80416ned',
        sourceUrl: 'https://opendata.cbs.nl/statline/#/CBS/nl/dataset/80416ned/table',
        license: 'CC BY 4.0',
        asOf: rec.date,
        fetchedAt: data.fetchedAt,
        live: false,
        note: 'National daily average incl. VAT, published with a delay of several days. Individual stations (especially unmanned/motorway) can differ by ±20 ct.',
      };
    },
    async status() {
      const data = await load();
      return { ok: true, fetchedAt: data.fetchedAt, latest: data.latest };
    },
  };
}

// ---------------------------------------------------------------- FOD Economie (BE)
function makeFodProvider(config, http, cache) {
  const load = () =>
    cache.wrap('fod-be', config.priceCacheTtlS, async () => {
      const buf = await http.buffer(config.fodPdfUrl, { headers: { Accept: 'application/pdf' } });
      const parsed = parseFodMaxPricePdf(buf);
      if (!Object.keys(parsed.prices).length) throw new Error('FOD PDF could not be parsed (layout changed?)');
      return { ...parsed, fetchedAt: new Date().toISOString() };
    });
  return {
    id: 'fod-be',
    country: 'BE',
    label: 'FOD Economie — official maximum pump prices (BE)',
    async reference(fuelId) {
      const data = await load();
      const v = data.prices[fuelId];
      if (!v) return null;
      return {
        price: v,
        kind: 'legal-maximum',
        quality: 'country-estimate',
        estimate: true,
        source: `FOD Economie official maximum price${data.listNo ? ` (list ${data.listNo})` : ''}`,
        sourceUrl: 'https://economie.fgov.be/nl/themas/energie/energieprijzen/maximumprijzen/officieel-tarief-van-de',
        license: 'Public government publication',
        asOf: data.validFrom,
        fetchedAt: data.fetchedAt,
        live: false,
        note: 'Legal MAXIMUM price incl. VAT valid from the date shown. Many Belgian stations sell below it (often 5–15 ct/L), so Belgian savings shown are conservative.',
      };
    },
    async status() {
      const data = await load();
      return { ok: true, fetchedAt: data.fetchedAt, validFrom: data.validFrom, listNo: data.listNo, prices: data.prices };
    },
  };
}

// ---------------------------------------------------------------- station-specific JSON file
/*
 * File format (see data/station-prices.example.json):
 * { "source": "...", "prices": [ { "stationId": "osm:node/123", "lat": 51.4, "lon": 4.9,
 *     "fuel": "e10", "price": 1.899, "observedAt": "2026-09-29T08:00:00Z", "source": "..." } ] }
 * Match by stationId, or by coordinates within 75 m.
 */
function makeStationFileProvider(config) {
  const file = path.resolve(config.stationPriceFile);
  let cached = { mtimeMs: -1, data: null };
  function load() {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      return null;
    }
    if (st.mtimeMs !== cached.mtimeMs) {
      try {
        cached = { mtimeMs: st.mtimeMs, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
      } catch (err) {
        cached = { mtimeMs: st.mtimeMs, data: null, error: err.message };
      }
    }
    return cached.data;
  }
  return {
    id: 'station-file',
    label: `Station price file (${config.stationPriceFile})`,
    stationPrice(station, fuelId) {
      const data = load();
      if (!data || !Array.isArray(data.prices)) return null;
      const now = Date.now();
      const candidates = data.prices.filter((p) =>
        p.fuel === fuelId &&
        Number.isFinite(p.price) && p.price > 0 &&
        (p.stationId === station.id ||
          (Number.isFinite(p.lat) && Number.isFinite(p.lon) && haversineKm(p, station) < 0.075)));
      candidates.sort((a, b) => Date.parse(b.observedAt || 0) - Date.parse(a.observedAt || 0));
      const p = candidates[0];
      if (!p) return null;
      const age = ageHours(p.observedAt, now);
      if (age === null || age > config.stationPriceMaxAgeH) return null;
      return {
        price: p.price,
        kind: 'station',
        quality: 'station-report',
        estimate: false,
        source: p.source || data.source || 'Station price file',
        sourceUrl: p.sourceUrl || data.sourceUrl || null,
        license: data.license || null,
        asOf: p.observedAt,
        fetchedAt: new Date(cached.mtimeMs).toISOString(),
        live: age <= 24,
        note: 'Station-specific price supplied by the operator of this installation.',
      };
    },
    status() {
      const data = load();
      return { ok: !!data, file: config.stationPriceFile, entries: data && Array.isArray(data.prices) ? data.prices.length : 0, error: cached.error || null };
    },
  };
}

// ---------------------------------------------------------------- DirectLease (via sidecar)
/*
 * Per-station NL/BE prices from DirectLease Tankservice (App It Up BV), fetched by the Python
 * sidecar (sidecar/directlease) through pyfuelprices. The sidecar owns all throttling, caching
 * (24 h) and block handling; this provider only asks it about the stations being compared.
 * Mapping is by DirectLease's own product key, so premium grades (e.g. "diesel_special",
 * "Premium Diesel (B7)") are never used for the regular grade.
 */
const DIRECTLEASE_KEYS = { e10: ['e10'], e5_98: ['euro98'], diesel: ['diesel'], lpg: ['lpg'] };
// only used if the sidecar could not see raw entries and had to use the library's parsed codes
const DIRECTLEASE_CODE_FALLBACK = { e10: 'E10', lpg: 'LPG' };
const DIRECTLEASE_SOURCE = 'DirectLease Tankservice (App It Up BV), via pyfuelprices';

function directLeaseQuote(result, fuelId) {
  if (!result || !result.match) return null;
  const fuels = result.fuels || {};
  for (const key of DIRECTLEASE_KEYS[fuelId] || []) {
    const f = fuels[key];
    if (f && Number.isFinite(f.price) && f.price > 0) return { price: f.price, product: f.name || key };
  }
  if (result.parsed !== 'raw') {
    const code = DIRECTLEASE_CODE_FALLBACK[fuelId];
    const v = code && result.codes && result.codes[code];
    if (Number.isFinite(v) && v > 0) return { price: v, product: code };
  }
  return null;
}

function makeDirectLeaseProvider(config, http) {
  const base = config.directLeaseUrl.replace(/\/$/, '');
  // Nothing is sent to the sidecar unless the operator enabled it and it is not paused.
  const disabledReason = () => (!config.directLeaseAck ? 'not-acknowledged' : config.directLeasePaused ? 'paused' : null);
  return {
    id: 'directlease',
    label: 'DirectLease Tankservice per-station prices (sidecar)',
    async prefetch(stations) {
      const off = disabledReason();
      if (off) return { disabled: off, results: {}, status: { ok: false, reason: off } };
      const points = stations.map((s) => ({ id: s.id, lat: s.lat, lon: s.lon }));
      if (!points.length) return { results: {}, status: null };
      const json = await http.json(`${base}/quotes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ points }),
        timeoutMs: config.directLeaseTimeoutMs,
      });
      return { results: json.results || {}, status: json.status || null };
    },
    stationPrice(station, fuelId, ctx) {
      const r = ctx && ctx.results && ctx.results[station.id];
      const q = directLeaseQuote(r, fuelId);
      if (!q) return null;
      const age = ageHours(r.fetchedAt);
      if (age === null || age > config.directLeaseMaxAgeH) return null;
      const live = age <= 24;
      return {
        price: q.price,
        kind: 'station',
        quality: live ? 'live-quote' : 'stale-quote',
        estimate: false,
        source: DIRECTLEASE_SOURCE,
        sourceUrl: 'https://tankservice.app-it-up.com',
        license: 'Private use with permission of App It Up BV — do not redistribute',
        asOf: null,
        fetchedAt: r.fetchedAt,
        live,
        product: q.product,
        matchedStation: { id: r.match.siteId, brand: r.match.brand || null, distanceM: r.match.distanceM },
        note: `Price for "${q.product}" at the DirectLease station ${r.match.distanceM} m from this station. ` +
          'Retrieved at the time shown; DirectLease does not report when the station last changed the price.' +
          (live ? '' : ' Older than 24 h because a refresh was not possible.'),
      };
    },
    missReason(station, fuelId, ctx, lang) {
      const t = tr(lang);
      if (!ctx || ctx.disabled === 'not-acknowledged') return null;
      if (ctx.disabled === 'paused') return t('DirectLease paused by operator (DIRECTLEASE_PAUSED)', 'DirectLease gepauzeerd door de beheerder (DIRECTLEASE_PAUSED)');
      if (ctx.error) return t(`DirectLease unavailable (${ctx.error})`, `DirectLease niet beschikbaar (${ctx.error})`);
      if (ctx.status && ctx.status.blocked) {
        return ctx.status.blocked.paused ? t('DirectLease paused by operator', 'DirectLease gepauzeerd door de beheerder')
          : t('DirectLease blocked (403), not retrying', 'DirectLease geblokkeerd (403), geen nieuwe pogingen');
      }
      const r = ctx.results && ctx.results[station.id];
      if (!r) return t('DirectLease not queried for this station', 'DirectLease niet gevraagd voor dit station');
      if (!r.match) {
        return r.reason === 'no-directlease-station-nearby' ? t('no matching DirectLease station within 150 m', 'geen DirectLease-station binnen 150 m')
          : r.reason === 'station-list-unavailable' ? t('DirectLease station list unavailable', 'DirectLease-stationslijst niet beschikbaar')
            : `DirectLease: ${r.reason || 'no match'}`;
      }
      if (!directLeaseQuote(r, fuelId)) {
        if (!r.fetchedAt) {
          const why = { 'daily-budget': t('daily request budget reached', 'dagelijks aantal verzoeken bereikt'),
            'request-limit': t('per-search request limit reached', 'limiet per zoekopdracht bereikt'),
            'error-backoff': t('pausing after an error', 'pauze na een fout'), 'fetch-failed': t('request failed', 'verzoek mislukt'),
            blocked: t('access blocked', 'toegang geblokkeerd') }[r.reason];
          return t(`DirectLease price not fetched (${why || r.reason || 'unknown'})`, `DirectLease-prijs niet opgehaald (${why || r.reason || 'onbekend'})`);
        }
        return t('DirectLease lists no price for this fuel here', 'DirectLease heeft hier geen prijs voor deze brandstof');
      }
      return t(`DirectLease quote older than ${config.directLeaseMaxAgeH} h`, `DirectLease-prijs ouder dan ${config.directLeaseMaxAgeH} u`);
    },
    warnings(ctx, stations, lang) {
      const t = tr(lang);
      const out = [];
      if (!ctx || ctx.disabled === 'not-acknowledged') return out;
      if (ctx.disabled === 'paused' || (ctx.status && ctx.status.blocked && ctx.status.blocked.paused)) {
        out.push(t('DirectLease paused by the operator (DIRECTLEASE_PAUSED): no DirectLease requests are made; other sources or estimates are used.',
          'DirectLease gepauzeerd door de beheerder (DIRECTLEASE_PAUSED): er worden geen DirectLease-verzoeken gedaan; andere bronnen of schattingen worden gebruikt.'));
        return out;
      }
      if (ctx.error) {
        out.push(t(`DirectLease price service unreachable (${ctx.error}). Check that the "directlease" container is running.`,
          `DirectLease-prijsdienst niet bereikbaar (${ctx.error}). Controleer of de container "directlease" draait.`));
        return out;
      }
      const st = ctx.status || {};
      if (st.blocked) {
        const code = st.blocked.httpStatus || 403;
        out.push(t(`DirectLease blocked (${code}): all DirectLease requests are stopped and will not be retried. Do not change IP address, VPN or proxy to get around this; contact App It Up and delete blocked.json only after they have restored access.`,
          `DirectLease geblokkeerd (${code}): alle DirectLease-verzoeken zijn gestopt en worden niet opnieuw geprobeerd. Verander geen IP-adres, VPN of proxy om dit te omzeilen; neem contact op met App It Up en verwijder blocked.json pas als zij de toegang hebben hersteld.`));
        return out;
      }
      const reasons = Object.values(ctx.results || {}).map((r) => r && r.reason).filter(Boolean);
      const count = (r) => reasons.filter((x) => x === r).length;
      if (count('daily-budget')) {
        out.push(t(`DirectLease daily request budget reached (${st.dailyBudget ?? '?'} requests); ${count('daily-budget')} station(s) were not refreshed today.`,
          `Dagelijks aantal DirectLease-verzoeken bereikt (${st.dailyBudget ?? '?'}); ${count('daily-budget')} station(s) zijn vandaag niet ververst.`));
      }
      if (count('request-limit')) {
        out.push(t(`Only a limited number of DirectLease stations are fetched per search; ${count('request-limit')} more will be fetched on later searches.`,
          `Per zoekopdracht wordt maar een beperkt aantal DirectLease-stations opgehaald; ${count('request-limit')} volgen bij latere zoekopdrachten.`));
      }
      if (count('error-backoff') || count('fetch-failed')) {
        const msg = st.lastError ? ` (${st.lastError.message})` : '';
        out.push(t(`DirectLease had an error${msg}; requests are paused for a while and older or estimated prices are used.`,
          `DirectLease gaf een fout${msg}; verzoeken worden even gepauzeerd en oudere of geschatte prijzen worden gebruikt.`));
      }
      if (count('station-list-unavailable')) {
        out.push(t('DirectLease station list is currently unavailable; other sources or estimates are used.',
          'DirectLease-stationslijst is nu niet beschikbaar; andere bronnen of schattingen worden gebruikt.'));
      }
      return out;
    },
    async status() {
      const off = disabledReason();
      if (off) return { ok: false, reason: off };
      const st = await http.json(`${base}/health`, { timeoutMs: 5000 });
      return { ...st, ok: st.ok !== false };
    },
  };
}

module.exports = {
  makeCbsProvider,
  makeFodProvider,
  makeStationFileProvider,
  makeDirectLeaseProvider,
  directLeaseQuote,
  parseCbsRecords,
};
