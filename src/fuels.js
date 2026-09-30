'use strict';

// Canonical fuel types used by the app, with the local product names per country.
// NL: "Euro95" at the pump has been E10 since Oct 2019 (E5 is sold as "Super Plus 98" or "E5 95").
// DE: 'Super E10' / 'Super Plus'; ANWB maps DE stations to the same EURO95/EURO98/DIESEL/AUTOGAS types.
// BE: pump labels follow EN 228 / EN 590 identifiers ("E10", "E5", "B7"); 95 RON E10 is the standard petrol.
const FUELS = {
  e10: {
    id: 'e10',
    label: 'Petrol 95 (Euro95 / E10)',
    labelNl: 'Benzine 95 (Euro95 / E10)',
    local: { NL: 'Euro95 (E10)', BE: 'Benzine 95 RON E10 (E10)', DE: 'Super E10' },
    osmTags: ['fuel:octane_95', 'fuel:e10'],
    requireTag: false,
  },
  e5_98: {
    id: 'e5_98',
    label: 'Petrol 98 (Super Plus / E5)',
    labelNl: 'Benzine 98 (Super Plus / E5)',
    local: { NL: 'Super Plus 98 (E5)', BE: 'Benzine 98 RON E5 (E5)', DE: 'Super Plus (98, E5)' },
    osmTags: ['fuel:octane_98'],
    requireTag: false,
  },
  diesel: {
    id: 'diesel',
    label: 'Diesel (B7)',
    labelNl: 'Diesel (B7)',
    local: { NL: 'Diesel (B7)', BE: 'Diesel B7 (B7)', DE: 'Diesel (B7)' },
    osmTags: ['fuel:diesel'],
    requireTag: false,
  },
  lpg: {
    id: 'lpg',
    label: 'LPG / Autogas',
    labelNl: 'LPG / autogas',
    local: { NL: 'LPG', BE: 'Autogas LPG', DE: 'Autogas (LPG)' },
    osmTags: ['fuel:lpg'],
    requireTag: true, // only a minority of stations sell LPG, so require a positive tag
  },
};

function getFuel(id) {
  return FUELS[id] || null;
}

/**
 * Determine whether a station (OSM tags) sells the fuel.
 * Returns 'yes' (tagged), 'no' (tagged as not sold) or 'unknown' (no tag; assumed available for common fuels).
 */
function stationFuelAvailability(tags, fuelId) {
  const fuel = getFuel(fuelId);
  if (!fuel) return 'no';
  const values = fuel.osmTags.map((t) => (tags && tags[t] ? String(tags[t]).toLowerCase() : undefined));
  if (values.some((v) => v === 'yes')) return 'yes';
  if (values.length && values.every((v) => v === 'no')) return 'no';
  if (fuel.requireTag) return 'no';
  return 'unknown';
}

module.exports = { FUELS, getFuel, stationFuelAvailability };
