'use strict';

const { haversineKm } = require('../http');

/*
 * Routing returns, for N stations:
 *   toStation[i]   km start -> station i
 *   fromStation[i] km station i -> end (end = destination, or start for a round trip)
 *   baseTripKm     km start -> destination (0 for a round trip)
 * plus durations in minutes where available.
 */

function makeHaversineRouter(config) {
  const speedKmh = 50;
  return {
    id: 'estimate',
    label: `Straight-line distance × ${config.roadFactor} (estimate)`,
    async distances({ start, destination, stations }) {
      const end = destination || start;
      const f = config.roadFactor;
      const toStation = stations.map((s) => haversineKm(start, s) * f);
      const fromStation = stations.map((s) => haversineKm(s, end) * f);
      const baseTripKm = destination ? haversineKm(start, destination) * f : 0;
      const min = (km) => (km / speedKmh) * 60;
      return {
        mode: 'estimate',
        provider: 'estimate',
        toStation,
        fromStation,
        baseTripKm,
        toStationMin: toStation.map(min),
        fromStationMin: fromStation.map(min),
        baseTripMin: min(baseTripKm),
      };
    },
  };
}

function makeOsrmRouter(config, http, cache) {
  return {
    id: 'osrm',
    label: `OSRM (${new URL(config.osrmUrl).host})`,
    async distances({ start, destination, stations }) {
      if (!stations.length && destination) return table(start, destination, stations);
      const result = {
        mode: 'road', provider: 'osrm', toStation: [], fromStation: [],
        toStationMin: [], fromStationMin: [], baseTripKm: 0, baseTripMin: 0,
      };
      // Keep each public OSRM table small, even for a large search radius.
      for (let offset = 0; offset < stations.length; offset += 40) {
        const batch = await table(start, destination, stations.slice(offset, offset + 40));
        for (const key of ['toStation', 'fromStation', 'toStationMin', 'fromStationMin']) result[key].push(...batch[key]);
        result.baseTripKm = batch.baseTripKm;
        result.baseTripMin = batch.baseTripMin;
      }
      return result;
    },
  };

  async function table(start, destination, stations) {
    const points = [start, ...(destination ? [destination] : []), ...stations];
    const coords = points.map((p) => `${p.lon.toFixed(5)},${p.lat.toFixed(5)}`).join(';');
    const url = `${config.osrmUrl}/table/v1/driving/${coords}?annotations=distance,duration`;
    const json = await cache.wrap(`osrm:${coords}`, 6 * 3600, () => http.json(url));
    if (json.code !== 'Ok' || !Array.isArray(json.distances)) throw new Error(`OSRM error: ${json.code || 'unknown'}`);
    const D = json.distances;
    const T = json.durations || [];
    const off = destination ? 2 : 1;
    const endIdx = destination ? 1 : 0;
    const km = (v) => (v === null || v === undefined ? NaN : v / 1000);
    const min = (v) => (v === null || v === undefined ? NaN : v / 60);
    return {
      mode: 'road',
      provider: 'osrm',
      toStation: stations.map((_, i) => km(D[0][off + i])),
      fromStation: stations.map((_, i) => km(D[off + i][endIdx])),
      baseTripKm: destination ? km(D[0][1]) : 0,
      toStationMin: stations.map((_, i) => min(T[0] && T[0][off + i])),
      fromStationMin: stations.map((_, i) => min(T[off + i] && T[off + i][endIdx])),
      baseTripMin: destination ? min(T[0] && T[0][1]) : 0,
    };
  }
}

function makeNominatimGeocoder(config, http, cache, throttle) {
  return {
    id: 'nominatim',
    attribution: 'Nominatim / © OpenStreetMap contributors (ODbL)',
    async search(q) {
      const key = `geo:${q.toLowerCase()}`;
      return cache.wrap(key, 7 * 86400, async () => {
        const params = new URLSearchParams({
          q,
          format: 'jsonv2',
          limit: '5',
          addressdetails: '0',
          countrycodes: config.geocodeCountries,
        });
        if (config.contactEmail) params.set('email', config.contactEmail);
        const json = await throttle.run(() => http.json(`${config.nominatimUrl}/search?${params}`));
        return (json || []).map((r) => ({
          label: r.display_name,
          lat: Number(r.lat),
          lon: Number(r.lon),
        }));
      });
    },
  };
}

/** Build a readable one-line label from a Photon (GeoJSON) feature. */
function photonLabel(p) {
  const street = p.street ? [p.street, p.housenumber].filter(Boolean).join(' ') : null;
  const place = p.city || p.town || p.village || p.district || p.county;
  const parts = [];
  const add = (x) => { if (x && !parts.includes(x)) parts.push(x); };
  add(p.name);
  if (!p.name || p.type === 'house') add(street);
  add([p.postcode && p.type !== 'city' ? p.postcode : null, place].filter(Boolean).join(' ') || null);
  add(p.state);
  add(p.country);
  return parts.join(', ');
}

/**
 * Photon (komoot, OSM data): built for search-as-you-type, so partial words like "biltho" work.
 * Nominatim's usage policy forbids autocomplete, and it has no prefix matching.
 */
function makePhotonGeocoder(config, http, cache, throttle) {
  const allowed = new Set(String(config.geocodeCountries || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean));
  return {
    id: 'photon',
    attribution: 'Photon (komoot) / © OpenStreetMap contributors (ODbL)',
    async search(q, { near } = {}) {
      const bias = near && Number.isFinite(near.lat) && Number.isFinite(near.lon)
        ? { lat: near.lat.toFixed(1), lon: near.lon.toFixed(1) } : null;
      const key = `photon:${q.toLowerCase()}:${bias ? `${bias.lat},${bias.lon}` : ''}`;
      return cache.wrap(key, 7 * 86400, async () => {
        const params = new URLSearchParams({ q, limit: '15', lang: 'en' });
        if (bias) { params.set('lat', bias.lat); params.set('lon', bias.lon); }
        const json = await throttle.run(() => http.json(`${config.photonUrl}/api/?${params}`));
        const out = [];
        const seen = new Set();
        for (const f of (json && json.features) || []) {
          const p = f.properties || {};
          const [lon, lat] = (f.geometry && f.geometry.coordinates) || [];
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
          if (allowed.size && !allowed.has(String(p.countrycode || '').toUpperCase())) continue;
          const label = photonLabel(p);
          if (!label || seen.has(label)) continue;
          seen.add(label);
          out.push({ label, lat, lon });
          if (out.length >= 6) break;
        }
        return out;
      });
    },
  };
}

/** Parse "51.44, 4.93" style input. */
function parseLatLon(q) {
  const m = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,; ]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(q || '');
  if (!m) return null;
  const lat = Number(m[1]);
  const lon = Number(m[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

module.exports = { makeHaversineRouter, makeOsrmRouter, makeNominatimGeocoder, makePhotonGeocoder, photonLabel, parseLatLon };
