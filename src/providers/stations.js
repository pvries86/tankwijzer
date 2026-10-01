'use strict';

const { haversineKm } = require('../http');
const { stationFuelAvailability, getFuel } = require('../fuels');
const { anwbFuelAvailability } = require('./anwb');

/** Distance (km) from point p to segment a-b using an equirectangular projection (fine for < 200 km). */
function distanceToSegmentKm(p, a, b) {
  if (!b) return haversineKm(p, a);
  const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180);
  const ky = 110.57;
  const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
  const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.sqrt(cx * cx + cy * cy);
}

function normaliseOsm(el, country) {
  const tags = el.tags || {};
  const lat = el.lat ?? (el.center && el.center.lat);
  const lon = el.lon ?? (el.center && el.center.lon);
  const street = [tags['addr:street'], tags['addr:housenumber']].filter(Boolean).join(' ');
  const address = [street, [tags['addr:postcode'], tags['addr:city']].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return {
    id: `osm:${el.type}/${el.id}`,
    name: tags.name || tags.brand || tags.operator || 'Fuel station',
    brand: tags.brand || tags.operator || null,
    lat,
    lon,
    country,
    address: address || null,
    tags,
    osmUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
  };
}

/** Split Overpass output into NL and BE using the `out count;` separator element. */
function parseOverpassResponse(json) {
  const out = [];
  let country = 'NL';
  for (const el of json.elements || []) {
    if (el.type === 'count') {
      country = 'BE';
      continue;
    }
    const s = normaliseOsm(el, country);
    if (Number.isFinite(s.lat) && Number.isFinite(s.lon)) out.push(s);
  }
  return out;
}

function buildOverpassQuery({ start, destination, radiusKm }) {
  const r = Math.round(radiusKm * 1000);
  const pts = [start, destination].filter(Boolean).map((p) => `${p.lat.toFixed(5)},${p.lon.toFixed(5)}`).join(',');
  const sel = `nwr["amenity"="fuel"](around:${r},${pts})`;
  return [
    '[out:json][timeout:40];',
    '(area["ISO3166-1"="NL"];area["ISO3166-1:alpha2"="NL"];)->.nl;',
    '(area["ISO3166-1"="BE"];area["ISO3166-1:alpha2"="BE"];)->.be;',
    `${sel}(area.nl);`,
    'out center tags;',
    'out count;',
    `${sel}(area.be);`,
    'out center tags;',
  ].join('\n');
}

function selectStations(stations, { start, destination, fuelId, maxPerCountry, radiusKm }) {
  const byCountry = {};
  const seen = new Set();
  const fuel = getFuel(fuelId);
  for (const s of stations) {
    if (seen.has(s.id) || !s.country) continue;
    seen.add(s.id);
    const straightKm = distanceToSegmentKm(s, start, destination);
    // Providers may return whole map tiles; keep only stations within the search radius of the start/route.
    if (Number.isFinite(radiusKm) && !(straightKm <= radiusKm)) continue;
    const availability = s.anwbFuels
      ? anwbFuelAvailability(s, fuelId, fuel && fuel.requireTag)
      : stationFuelAvailability(s.tags, fuelId);
    if (availability === 'no') continue;
    if (s.tags && (s.tags.disused === 'yes' || s.tags['access'] === 'private' || s.tags['hgv'] === 'only')) continue;
    (byCountry[s.country] = byCountry[s.country] || []).push({
      ...s,
      fuelAvailability: availability,
      straightKm,
    });
  }
  const pick = (arr) => arr.sort((a, b) => a.straightKm - b.straightKm).slice(0, maxPerCountry);
  const order = (c) => (c === 'NL' ? 0 : c === 'BE' ? 1 : 2);
  return Object.keys(byCountry).sort((a, b) => order(a) - order(b) || a.localeCompare(b)).flatMap((c) => pick(byCountry[c]));
}

function makeOverpassProvider(config, http, cache) {
  return {
    id: 'overpass',
    label: 'OpenStreetMap (Overpass API)',
    license: 'ODbL 1.0 — © OpenStreetMap contributors',
    async find({ start, destination, radiusKm }) {
      const key = `overpass:${start.lat.toFixed(3)},${start.lon.toFixed(3)}:${destination ? `${destination.lat.toFixed(3)},${destination.lon.toFixed(3)}` : '-'}:${radiusKm}`;
      return cache.wrap(key, config.stationCacheTtlS, async () => {
        const query = buildOverpassQuery({ start, destination, radiusKm });
        let lastErr;
        for (const url of config.overpassUrls) {
          try {
            const json = await http.json(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: `data=${encodeURIComponent(query)}`,
              timeoutMs: Math.max(config.httpTimeoutMs, 45000),
            });
            return { stations: parseOverpassResponse(json), source: { provider: 'overpass', endpoint: new URL(url).host, fetchedAt: new Date().toISOString() } };
          } catch (err) {
            lastErr = err;
          }
        }
        throw lastErr || new Error('no Overpass endpoint configured');
      });
    },
  };
}

module.exports = {
  makeOverpassProvider,
  parseOverpassResponse,
  buildOverpassQuery,
  selectStations,
};
