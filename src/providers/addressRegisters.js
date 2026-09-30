'use strict';

/*
 * Official, open address registers with fast search-as-you-type endpoints (no key needed):
 *  - PDOK Locatieserver (NL, BAG/BRT, CC0): https://api.pdok.nl/bzk/locatieserver/search/v3_1/
 *  - Geolocation API of Digitaal Vlaanderen (Flanders + Brussels, CRAB/Adressenregister):
 *    https://geo.api.vlaanderen.be/geolocation/
 * Both answer in about 0.1-0.3 s, unlike the public Photon (3-5 s). Wallonia, Germany etc. still come from Photon.
 */

function bias(near) {
  return near && Number.isFinite(near.lat) && Number.isFinite(near.lon)
    ? { lat: near.lat.toFixed(1), lon: near.lon.toFixed(1) } : null;
}

function parsePoint(wkt) {
  const m = /POINT\(\s*(-?[\d.]+)\s+(-?[\d.]+)\s*\)/.exec(wkt || '');
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : null;
}

function makePdokGeocoder(config, http, cache) {
  const base = config.pdokUrl;
  return {
    id: 'pdok',
    country: 'NL',
    attribution: 'PDOK Locatieserver (Kadaster, CC0)',
    async search(q, { near, timeoutMs } = {}) {
      const b = bias(near);
      const key = `pdok:${q.toLowerCase()}:${b ? `${b.lat},${b.lon}` : ''}`;
      return cache.wrap(key, 7 * 86400, async () => {
        const params = new URLSearchParams({
          q, rows: '6', fl: 'type,weergavenaam,centroide_ll',
          fq: 'type:(woonplaats OR weg OR postcode OR adres)',
        });
        if (b) { params.set('lat', b.lat); params.set('lon', b.lon); }
        const json = await http.json(`${base}/suggest?${params}`, timeoutMs ? { timeoutMs } : undefined);
        const out = [];
        for (const d of (json && json.response && json.response.docs) || []) {
          const p = parsePoint(d.centroide_ll);
          if (!p || !d.weergavenaam) continue;
          out.push({ label: `${d.weergavenaam}, Netherlands`, ...p, kind: d.type });
        }
        return out;
      });
    },
  };
}

function makeVlaanderenGeocoder(config, http, cache) {
  const base = config.vlaanderenGeoUrl;
  return {
    id: 'vlaanderen',
    country: 'BE',
    attribution: 'Geolocation API, Digitaal Vlaanderen',
    async search(q, { timeoutMs } = {}) {
      return cache.wrap(`vl:${q.toLowerCase()}`, 7 * 86400, async () => {
        const params = new URLSearchParams({ q, c: '5' });
        const json = await http.json(`${base}/Location?${params}`, timeoutMs ? { timeoutMs } : undefined);
        const out = [];
        for (const r of (json && json.LocationResult) || []) {
          const loc = r.Location || {};
          if (!Number.isFinite(loc.Lat_WGS84) || !Number.isFinite(loc.Lon_WGS84) || !r.FormattedAddress) continue;
          out.push({ label: `${r.FormattedAddress}, Belgium`, lat: loc.Lat_WGS84, lon: loc.Lon_WGS84, kind: r.LocationType });
        }
        return out;
      });
    },
  };
}

/** Builds the enabled official geocoders, limited to the countries in GEOCODE_COUNTRIES. */
function makeOfficialGeocoders(config, http, cache) {
  const allowed = new Set(String(config.geocodeCountries || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean));
  const wanted = String(config.officialGeocoders || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  const all = { pdok: makePdokGeocoder, vlaanderen: makeVlaanderenGeocoder };
  return wanted.filter((id) => all[id]).map((id) => all[id](config, http, cache))
    .filter((g) => !allowed.size || allowed.has(g.country));
}

module.exports = { makePdokGeocoder, makeVlaanderenGeocoder, makeOfficialGeocoders, parsePoint };
