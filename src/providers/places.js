'use strict';

/**
 * Offline place-name + postcode index (GeoNames, CC BY 4.0) for instant autocomplete.
 * Public Photon takes several seconds per query; this answers town names and 4-digit
 * NL/BE/LU postcodes in about a millisecond. Streets and addresses still come from Photon.
 * Rebuild the data file with `python scripts/build_places.py`.
 */
const fs = require('fs');
const path = require('path');

const COUNTRY = {
  NL: 'Netherlands', BE: 'Belgium', DE: 'Germany', LU: 'Luxembourg', FR: 'France', AT: 'Austria', CH: 'Switzerland',
  LI: 'Liechtenstein', DK: 'Denmark', IT: 'Italy', ES: 'Spain', PT: 'Portugal', AD: 'Andorra', MC: 'Monaco',
  SM: 'San Marino', GB: 'United Kingdom', IE: 'Ireland', PL: 'Poland', CZ: 'Czechia', SK: 'Slovakia', HU: 'Hungary',
  SI: 'Slovenia', HR: 'Croatia', BA: 'Bosnia and Herzegovina', RS: 'Serbia', ME: 'Montenegro', MK: 'North Macedonia',
  AL: 'Albania', GR: 'Greece', BG: 'Bulgaria', RO: 'Romania', SE: 'Sweden', NO: 'Norway', FI: 'Finland',
  EE: 'Estonia', LV: 'Latvia', LT: 'Lithuania',
};

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();

function parse(text, allowed) {
  const out = [];
  for (const line of text.split('\n')) {
    if (!line || line[0] === '#') continue;
    const [kind, name, alts, region, cc, lat, lon, pop] = line.split('\t');
    if (allowed.size && !allowed.has(cc)) continue;
    const altList = alts ? alts.split('|') : [];
    const country = COUNTRY[cc] || cc;
    out.push({
      kind, name, alts: altList, region, cc, country,
      lat: Number(lat), lon: Number(lon), pop: Number(pop) || 0,
      keys: kind === 'z' ? [name.toLowerCase()] : [name, ...altList].map(norm),
      context: norm(`${region} ${country} ${cc}`).split(' '),
    });
  }
  return out;
}

function distKm(a, b) {
  const r = Math.PI / 180;
  const x = (b.lon - a.lon) * r * Math.cos(((a.lat + b.lat) / 2) * r);
  const y = (b.lat - a.lat) * r;
  return Math.sqrt(x * x + y * y) * 6371;
}

function makePlaceIndex(config, { file, text } = {}) {
  const allowed = new Set(String(config.geocodeCountries || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean));
  let entries = null;
  const load = () => {
    if (!entries) {
      const src = text != null ? text : fs.readFileSync(file || path.join(__dirname, '..', '..', 'data', 'places.tsv'), 'utf8');
      entries = parse(src, allowed);
    }
    return entries;
  };

  function match(e, qn, words) {
    if (e.kind === 'z') {
      // "62", "6221", "6221bt", "6221 bt", "6221 maastricht"
      const m = /^(\d{2,4})([a-z]{0,2})$/.exec(words[0]);
      if (!m || !e.keys[0].startsWith(m[1])) return null;
      let rest = words.slice(1);
      if (!m[2] && rest.length && /^[a-z]{1,2}$/.test(rest[0])) rest = rest.slice(1);
      const place = norm(e.alts[0]).split(' ');
      if (!rest.every((w) => place.some((t) => t.startsWith(w)))) return null;
      return { score: e.keys[0] === m[1] ? 110 : 90, key: 0 };
    }
    let best = null;
    e.keys.forEach((k, i) => {
      let s = null;
      if (k === qn) s = 130;
      else if (k.startsWith(qn)) s = 100;
      else if (words.length > 1 && k.startsWith(words[0])) {
        // "venlo limburg", "hasselt belgie": first word is the place, the rest narrows by region/country.
        const nameWords = k.split(' ');
        let used = 1;
        while (used < words.length && nameWords[used] && nameWords[used].startsWith(words[used])) used++;
        const rest = words.slice(used);
        if (rest.every((w) => e.context.some((c) => c.startsWith(w)) || (w === 'belgie' && e.cc === 'BE') || (w === 'duitsland' && e.cc === 'DE'))) s = 85;
      }
      if (s != null) {
        if (i > 0) s -= 8; // alternate / translated name
        if (!best || s > best.score) best = { score: s, key: i };
      }
    });
    return best;
  }

  return {
    id: 'places',
    attribution: 'GeoNames (CC BY 4.0)',
    search(q, { near, limit = 6 } = {}) {
      const qn = norm(q);
      if (qn.length < 2) return [];
      const words = qn.split(' ');
      const bias = near && Number.isFinite(near.lat) && Number.isFinite(near.lon) ? near : null;
      const hits = [];
      for (const e of load()) {
        const m = match(e, qn, words);
        if (!m) continue;
        let score = m.score + Math.log10(e.pop + 10) * 6;
        if (bias) score -= Math.min(40, distKm(bias, e) / 15);
        hits.push({ e, m, score });
      }
      hits.sort((a, b) => b.score - a.score);
      const out = [];
      const seen = new Set();
      for (const { e, m } of hits) {
        let label;
        if (e.kind === 'z') label = `${e.name} ${e.alts[0]}, ${e.region}, ${e.country}`;
        else {
          const shown = m.key > 0 ? `${e.alts[m.key - 1]} (${e.name})` : e.name;
          label = [shown, e.region, e.country].filter(Boolean).join(', ');
        }
        if (seen.has(label)) continue;
        seen.add(label);
        out.push({ label, lat: e.lat, lon: e.lon, name: e.kind === 'z' ? e.alts[0] : e.name, source: 'places' });
        if (out.length >= limit) break;
      }
      return out;
    },
  };
}

/**
 * Merge result lists in priority order (each `{ items, cap }`), skipping repeats of the same place:
 * the same town from several sources, or the same street/address within 150 m.
 * Named places *in* a town (stations, streets) are kept.
 */
function mergeResults(lists, max = 7) {
  const out = [];
  const head = (r) => norm(String(r.label).split(',')[0]);
  for (const { items, cap = max } of lists) {
    let taken = 0;
    for (const r of items || []) {
      if (out.length >= max || taken >= cap) break;
      const parts = String(r.label).split(',');
      const h = head(r);
      const dup = out.some((l) => {
        const d = distKm(l, r);
        if (d < 0.15 && head(l) === h) return true;
        return parts.length <= 3 && l.source === 'places' && d < 5 && (norm(l.name) === h || head(l) === h);
      });
      if (!dup) { out.push(r); taken++; }
    }
  }
  return out.map(({ label, lat, lon }) => ({ label, lat, lon }));
}

module.exports = { makePlaceIndex, mergeResults, normPlace: norm };
