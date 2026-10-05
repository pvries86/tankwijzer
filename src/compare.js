'use strict';

const { compareOptions, detourKm, round } = require('./economics');
const { getFuel } = require('./fuels');
const { selectStations } = require('./providers/stations');
const { haversineKm } = require('./http');
const { normLang, tr, fmtNum } = require('./i18n');

class InputError extends Error {}

function num(v) {
  return v === null || v === undefined || v === '' ? NaN : Number(v);
}

function point(p, name, required) {
  if (!p) {
    if (required) throw new InputError(`${name} is required`);
    return null;
  }
  const lat = num(p.lat);
  const lon = num(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new InputError(`${name} must have valid lat/lon`);
  }
  return { lat, lon, label: typeof p.label === 'string' ? p.label.slice(0, 200) : null };
}

function parseInput(body, config) {
  const lang = normLang(body.lang);
  const start = point(body.start, 'start', true);
  const destination = point(body.destination, 'destination', false);
  if (destination && haversineKm(start, destination) > 250) {
    throw new InputError('destination is too far away (max 250 km straight-line) for this MVP');
  }
  const fuel = getFuel(body.fuel);
  if (!fuel) throw new InputError('unknown fuel type');
  const litres = num(body.litres);
  const consumption = num(body.consumption);
  const perKmCost = body.perKmCost === undefined || body.perKmCost === '' ? 0 : num(body.perKmCost);
  if (!(litres > 0 && litres <= 200)) throw new InputError('litres must be between 0 and 200');
  if (!(consumption >= 0 && consumption <= 50)) throw new InputError('consumption must be between 0 and 50 L/100 km');
  if (!(perKmCost >= 0 && perKmCost <= 2)) throw new InputError('per-km cost must be between 0 and 2 EUR/km');
  const radius = body.radiusKm === undefined || body.radiusKm === '' ? config.searchRadiusKm : num(body.radiusKm);
  if (!(radius >= 1 && radius <= 50)) throw new InputError('search radius must be between 1 and 50 km');
  const timeValuePerHour = body.timeValuePerHour === undefined || body.timeValuePerHour === '' || body.timeValuePerHour === null ? 0 : num(body.timeValuePerHour);
  if (!(timeValuePerHour >= 0 && timeValuePerHour <= 200)) throw new InputError('the detour rule must be between 0 and 33 EUR per 10 extra minutes');
  const minSaving = body.minSaving === undefined || body.minSaving === '' || body.minSaving === null ? (Number.isFinite(config.minWorthwhileSaving) ? config.minWorthwhileSaving : 1) : num(body.minSaving);
  if (!(minSaving >= 0 && minSaving <= 100)) throw new InputError('minimum saving must be between 0 and 100 EUR');

  let baseline = { mode: 'nearest' };
  if (body.baseline && body.baseline.mode === 'custom') {
    const p = num(body.baseline.price);
    if (!(p > 0.3 && p < 5)) throw new InputError('reference price must be between 0.30 and 5.00 EUR/L');
    baseline = { mode: 'custom', price: p, label: tr(lang)('Your reference price (no extra km)', 'Je eigen referentieprijs (zonder extra km)') };
  }
  return { lang, start, destination, fuel, litres, consumption, perKmCost, timeValuePerHour, minSaving, radiusKm: radius, baseline };
}

function navigationLinks(start, station, destination) {
  const ll = (p) => `${p.lat.toFixed(6)},${p.lon.toFixed(6)}`;
  const g = new URLSearchParams({ api: '1', origin: ll(start), travelmode: 'driving' });
  if (destination) {
    g.set('destination', ll(destination));
    g.set('waypoints', ll(station));
  } else {
    g.set('destination', ll(station));
  }
  // openstreetmap.org directions only supports a single from/to pair, so link the leg to the station.
  const osmRoute = [start, station].map(ll).join(';');
  return {
    google: `https://www.google.com/maps/dir/?${g}`,
    osm: `https://www.openstreetmap.org/directions?engine=fossgis_osrm_car&route=${encodeURIComponent(osmRoute)}`,
    geo: `geo:${ll(station)}?q=${ll(station)}(${encodeURIComponent(station.name || 'Fuel station')})`,
    apple: `https://maps.apple.com/?${new URLSearchParams({ saddr: ll(start), daddr: ll(station), dirflg: 'd' })}`,
  };
}

function makeCompareService({ config, stationProvider, fallbackStationProvider, priceProviders, router, fallbackRouter }) {
  const stationPriceProviders = priceProviders.filter((p) => typeof p.stationPrice === 'function');
  const referenceProviders = priceProviders.filter((p) => typeof p.reference === 'function');
  const prefetchProviders = priceProviders.filter((p) => typeof p.prefetch === 'function');

  async function referencePrice(fuelId, country, warnings, t) {
    for (const p of referenceProviders.filter((x) => x.country === country)) {
      try {
        const r = await p.reference(fuelId);
        if (r) return { ...r, provider: p.id };
      } catch (err) {
        warnings.push(t(`${p.label}: unavailable (${err.message}).`, `${p.label}: niet beschikbaar (${err.message}).`));
      }
    }
    return null;
  }

  return async function compare(body) {
    const input = parseInput(body || {}, config);
    const { start, destination, fuel, lang } = input;
    const t = tr(lang);
    const warnings = [];

    // 1. stations
    let stationResult;
    let lastErr = null;
    for (const sp of [stationProvider, fallbackStationProvider].filter(Boolean)) {
      try {
        stationResult = await sp.find(input);
        if (lastErr) {
          const a = stationProvider.label || stationProvider.id;
          const b = sp.label || sp.id;
          warnings.push(t(`${a} unavailable (${lastErr.message}). Showing ${b} stations instead; their prices are station prices only where another source has them, otherwise country ESTIMATES.`,
            `${a} niet beschikbaar (${lastErr.message}). In plaats daarvan worden stations van ${b} getoond; hun prijzen zijn alleen stationsprijzen als een andere bron ze heeft, anders landelijke SCHATTINGEN.`));
        }
        break;
      } catch (err) {
        lastErr = err;
      }
    }
    if (!stationResult) throw new Error(t(`Station data unavailable: ${lastErr.message}`, `Stationsgegevens niet beschikbaar: ${lastErr.message}`));
    if (stationResult.source && Array.isArray(stationResult.source.warnings)) warnings.push(...stationResult.source.warnings);

    const stations = selectStations(stationResult.stations, {
      start, destination, fuelId: fuel.id, maxPerCountry: config.maxStationsPerCountry, radiusKm: input.radiusKm,
    });

    // 2. prices
    const refs = {};
    for (const c of ['NL', 'BE']) {
      refs[c] = await referencePrice(fuel.id, c, warnings, t);
    }
    // Station-specific sources (e.g. DirectLease via the sidecar) are asked once for all candidates.
    const ctxs = {};
    const priceStatus = {};
    for (const p of prefetchProviders) {
      try {
        ctxs[p.id] = await p.prefetch(stations, { fuelId: fuel.id, start, destination, radiusKm: input.radiusKm, lang });
      } catch (err) {
        ctxs[p.id] = { error: err.message, results: {}, status: null };
      }
      if (typeof p.warnings === 'function') warnings.push(...p.warnings(ctxs[p.id], stations, lang));
      priceStatus[p.id] = ctxs[p.id].error ? { ok: false, error: ctxs[p.id].error } : ctxs[p.id].status;
    }
    const fuelName = t(fuel.label, fuel.labelNl || fuel.label);
    const priced = stations.map((s) => {
      let price = null;
      const misses = [];
      for (const p of stationPriceProviders) {
        price = p.stationPrice(s, fuel.id, ctxs[p.id]);
        if (price) {
          price = { ...price, provider: p.id };
          break;
        }
        if (typeof p.missReason === 'function') misses.push(p.missReason(s, fuel.id, ctxs[p.id], lang));
      }
      const fallbackReason = misses.filter(Boolean).join('; ') || null;
      // Country reference = explicit per-station ESTIMATE, never presented as this pump's price.
      if (!price && refs[s.country]) {
        price = { ...refs[s.country], quality: 'country-estimate', estimate: true, fallbackReason };
      }
      return { ...s, price };
    });
    if (prefetchProviders.length) {
      const est = priced.filter((s) => s.price && s.price.estimate);
      if (est.length) {
        warnings.push(t(`${est.length} of ${priced.length} stations have no current station-specific ${fuel.label} price and use a country ESTIMATE (NL national average / BE legal maximum) instead.`,
          `${est.length} van ${priced.length} stations hebben geen actuele eigen prijs voor ${fuelName} en gebruiken een landelijke SCHATTING (NL landelijk gemiddelde / BE wettelijke maximumprijs).`));
      }
    }
    if (!priced.length) {
      warnings.push(t(`No stations selling ${fuel.label} found within ${input.radiusKm} km${destination ? ' of your route' : ''}.`,
        `Geen stations met ${fuelName} gevonden binnen ${input.radiusKm} km${destination ? ' van je route' : ''}.`));
    }
    const unpriced = {};
    for (const s of priced) {
      if (!s.price) unpriced[s.country] = (unpriced[s.country] || 0) + 1;
    }
    for (const [c, n] of Object.entries(unpriced)) {
      warnings.push(t(`${n} ${c} station(s) skipped: no current station-specific ${fuel.label} price${refs[c] ? '' : ' and no country estimate'}.`,
        `${n} ${c}-station(s) overgeslagen: geen actuele eigen prijs voor ${fuelName}${refs[c] ? '' : ' en geen landelijke schatting'}.`));
    }
    const skippedCountries = Object.keys(unpriced);

    // 3. routing
    const routable = priced.filter((s) => s.price);
    let routes = null;
    if (routable.length) {
      try {
        routes = await router.distances({ start, destination, stations: routable });
        if (!Number.isFinite(routes.baseTripKm)) throw new Error('no route between start and destination');
      } catch (err) {
        warnings.push(t(`Road routing unavailable (${err.message}); distances are straight-line × ${config.roadFactor} estimates.`,
          `Routeplanner niet beschikbaar (${err.message}); afstanden zijn schattingen (hemelsbreed × ${config.roadFactor}).`));
        routes = await fallbackRouter.distances({ start, destination, stations: routable });
      }
    }

    const options = [];
    routable.forEach((s, i) => {
      const to = routes.toStation[i];
      const from = routes.fromStation[i];
      if (!Number.isFinite(to) || !Number.isFinite(from)) return;
      s.route = {
        toStationKm: to,
        fromStationKm: from,
        detourKm: detourKm({ startToStationKm: to, stationToEndKm: from, baseTripKm: routes.baseTripKm }),
        detourMin: Math.max(0, (routes.toStationMin[i] || 0) + (routes.fromStationMin[i] || 0) - (routes.baseTripMin || 0)),
      };
      options.push({ id: s.id, price: s.price.price, detourKm: s.route.detourKm, detourMin: s.route.detourMin, label: s.name });
    });

    const cmp = options.length
      ? compareOptions({ options, litres: input.litres, consumptionL100: input.consumption, perKmCost: input.perKmCost, timeValuePerHour: input.timeValuePerHour, baseline: input.baseline })
      : { baseline: null, results: [], best: null };

    const byId = new Map(priced.map((s) => [s.id, s]));
    const results = cmp.results.map((r) => {
      const s = byId.get(r.id);
      return {
        id: s.id,
        name: s.name,
        brand: s.brand,
        country: s.country,
        address: s.address,
        lat: s.lat,
        lon: s.lon,
        osmUrl: s.osmUrl || null,
        fuelAvailability: s.fuelAvailability,
        localFuelName: fuel.local[s.country] || fuelName,
        price: s.price,
        route: {
          toStationKm: round(s.route.toStationKm, 1),
          fromStationKm: round(s.route.fromStationKm, 1),
          detourKm: round(s.route.detourKm, 1),
          detourMin: round(s.route.detourMin, 0),
        },
        extraKm: round(r.extraKm, 1),
        extraMin: round(r.extraMin, 0),
        detourFuelL: round(r.cost.detourFuelL, 2),
        fuelCost: round(r.cost.fuelCost, 2),
        detourCost: round(r.cost.detourCashCost, 2),
        timeCost: round(r.cost.detourTimeCost, 2),
        total: round(r.cost.cashTotal, 2),
        saving: round(r.saving, 2),
        cashSaving: round(r.cashSaving, 2),
        breakEven: { kind: r.breakEven.kind, litres: r.breakEven.litres === null ? null : round(r.breakEven.litres, 1) },
        isBaseline: r.isBaseline,
        navigation: navigationLinks(start, s, destination),
      };
    });

    const baseline = cmp.baseline && {
      id: cmp.baseline.id,
      label: cmp.baseline.id === '__baseline__' ? cmp.baseline.label
        : t(`Nearest station: ${byId.get(cmp.baseline.id).name} (${byId.get(cmp.baseline.id).country})`,
          `Dichtstbijzijnde station: ${byId.get(cmp.baseline.id).name} (${byId.get(cmp.baseline.id).country})`),
      name: cmp.baseline.id === '__baseline__' ? null : `${byId.get(cmp.baseline.id).name} (${byId.get(cmp.baseline.id).country})`,
      price: cmp.baseline.price,
      detourKm: round(cmp.baseline.detourKm, 1),
      total: round(cmp.baseline.cost.cashTotal, 2),
    };

    const recommendation = recommend(results, baseline, input, config, routes);
    const bestByCountry = {};
    for (const r of results) {
      if (!bestByCountry[r.country]) bestByCountry[r.country] = { id: r.id, name: r.name, saving: r.saving, cashSaving: r.cashSaving, total: r.total };
    }

    return {
      input: {
        start, destination, fuel: { id: fuel.id, label: fuel.label, labelNl: fuel.labelNl, local: fuel.local },
        lang,
        litres: input.litres, consumption: input.consumption, perKmCost: input.perKmCost,
        timeValuePerHour: input.timeValuePerHour, minSaving: input.minSaving,
        radiusKm: input.radiusKm, baseline: input.baseline, mode: destination ? 'route' : 'round-trip',
      },
      recommendation,
      baseline,
      bestByCountry,
      results,
      skippedCountries,
      references: refs,
      sources: {
        stations: stationResult.source,
        routing: routes ? { provider: routes.provider, mode: routes.mode } : null,
        prices: priceStatus,
      },
      warnings,
      assumptions: assumptions(input, config, routes),
      generatedAt: new Date().toISOString(),
    };
  };
}

const QUOTED = new Set(['live-quote']);

// 'quote' = price for that pump (fresh), 'stale' = pump quote older than 24 h, 'estimate' = country figure
function certainty(price) {
  if (!price) return 'estimate';
  if (QUOTED.has(price.quality)) return 'quote';
  if (price.quality === 'stale-quote') return 'stale';
  return 'estimate';
}

function estimateText(price, t) {
  if (price.kind === 'legal-maximum') {
    return t('the Belgian legal MAXIMUM price; the pump is usually cheaper, so the real saving is probably larger',
      'de Belgische wettelijke MAXIMUMprijs; de pomp is meestal goedkoper, dus de echte besparing is waarschijnlijk groter');
  }
  if (price.kind === 'national-average') {
    return t('the Dutch national AVERAGE; this pump can be ±20 ct/L different, so the saving may be smaller, larger or absent',
      'het Nederlandse landelijk GEMIDDELDE; deze pomp kan ±20 ct/L afwijken, dus de besparing kan kleiner, groter of afwezig zijn');
  }
  return t('a country-level estimate', 'een landelijke schatting');
}

function confidenceOf(a, b) {
  if (a === 'quote' && b === 'quote') return 'high';
  if (a === 'estimate' && b === 'estimate') return 'low';
  return 'medium';
}

const moneyFor = (lang) => (v) => `€${fmtNum(v, 2, lang)}`;

function recommend(results, baseline, input, config, routes) {
  const t = tr(input.lang);
  const money = moneyFor(input.lang);
  if (!results.length) {
    return {
      level: 'none',
      confidence: 'none',
      headline: t('No priced stations found', 'Geen stations met een prijs gevonden'),
      detail: t('Try a larger search radius or another location.',
        'Probeer een grotere zoekstraal of een andere locatie.'),
      caveats: [],
    };
  }
  const best = results[0];
  const nearest = results.find((r) => r.isBaseline);
  const baseQ = input.baseline.mode === 'custom' ? 'quote' : certainty(nearest && nearest.price);
  const caveats = [];
  if (routes && routes.mode === 'estimate') caveats.push(t('Distances are estimates, not road routes.', 'Afstanden zijn schattingen, geen routes over de weg.'));

  const place = `${best.name} (${best.country})`;
  const minSaving = input.minSaving;
  const tv = input.timeValuePerHour || 0;
  const per10 = money(tv / 6);
  const timeNote = (r) => (tv > 0 && r.timeCost > 0
    ? t(` once its ${r.extraMin} extra min of driving are counted (your rule: ${per10} per 10 min)`,
      ` als je de ${r.extraMin} extra minuten rijden meetelt (jouw regel: ${per10} per 10 min)`)
    : '');
  if (best.isBaseline || best.saving < minSaving) {
    const q = baseQ;
    const confidence = confidenceOf(q, best.isBaseline ? q : certainty(best.price));
    if (nearest && certainty(nearest.price) === 'estimate') {
      caveats.push(t(`The nearest station's price is ${estimateText(nearest.price, t)}. Check the pump price.`,
        `De prijs van het dichtstbijzijnde station is ${estimateText(nearest.price, t)}. Controleer de pompprijs.`));
    }
    if (!best.isBaseline && certainty(best.price) === 'estimate') {
      caveats.push(t(`${place} uses ${estimateText(best.price, t)}.`, `${place} gebruikt ${estimateText(best.price, t)}.`));
    }
    const cashBest = results.filter((r) => !r.isBaseline).sort((a, b) => b.cashSaving - a.cashSaving)[0];
    if (tv > 0 && cashBest && cashBest.cashSaving >= minSaving) {
      caveats.push(t(`Counting money only, ${cashBest.name} (${cashBest.country}) would save ${money(cashBest.cashSaving)}, but it takes ${cashBest.extraMin} extra min; your detour rule asks ${per10} per 10 extra min.`,
        `Als alleen geld telt, bespaart ${cashBest.name} (${cashBest.country}) ${money(cashBest.cashSaving)}, maar dat kost ${cashBest.extraMin} extra min; jouw omrijregel vraagt ${per10} per 10 extra min.`));
    }
    return {
      level: 'stay',
      confidence,
      headline: nearest
        ? t(`Refuel at the nearest station: ${nearest.name} (${nearest.country})`, `Tank bij het dichtstbijzijnde station: ${nearest.name} (${nearest.country})`)
        : t('Refuel at your usual price', 'Tank tegen je gebruikelijke prijs'),
      detail: best.isBaseline
        ? t(`No other station is cheaper once the extra driving${tv > 0 ? ' and your detour rule are' : ' is'} included.`,
          `Geen ander station is goedkoper als je het extra rijden${tv > 0 ? ' en je omrijregel' : ''} meetelt.`)
        : t(`The best alternative (${place}) saves only ${money(best.saving)}${timeNote(best)}, below your ${money(minSaving)} minimum.`,
          `Het beste alternatief (${place}) bespaart maar ${money(best.saving)}${timeNote(best)}, minder dan je minimum van ${money(minSaving)}.`),
      stationId: nearest ? nearest.id : null,
      caveats,
    };
  }
  const bestQ = certainty(best.price);
  const confidence = confidenceOf(bestQ, baseQ);
  let quotedAlternative = null;
  if (bestQ === 'estimate') {
    caveats.push(t(`The price for ${place} is not a quote for that pump but ${estimateText(best.price, t)}.`,
      `De prijs voor ${place} is geen prijs van die pomp, maar ${estimateText(best.price, t)}.`));
    const alt = results.find((r) => !r.isBaseline && certainty(r.price) === 'quote' && r.saving >= minSaving);
    if (alt) {
      quotedAlternative = { id: alt.id, name: alt.name, country: alt.country, saving: alt.saving };
      caveats.push(t(`Best option with a current station quote: ${alt.name} (${alt.country}), saving about ${money(alt.cashSaving)}.`,
        `Beste optie met een actuele stationsprijs: ${alt.name} (${alt.country}), besparing ongeveer ${money(alt.cashSaving)}.`));
    }
  }
  if (baseQ === 'estimate' && nearest) {
    caveats.push(t(`The comparison baseline (${nearest.name}) uses ${estimateText(nearest.price, t)}.`,
      `Het vergelijkingspunt (${nearest.name}) gebruikt ${estimateText(nearest.price, t)}.`));
  }
  if (confidence === 'medium' && (bestQ === 'estimate' || baseQ === 'estimate')) {
    caveats.push(t('This compares a station quote with a country estimate: treat the saving as indicative.',
      'Hier wordt een stationsprijs vergeleken met een landelijke schatting: zie de besparing als indicatie.'));
  }
  if (bestQ === 'stale' || baseQ === 'stale') {
    caveats.push(t('At least one station quote is older: it was retrieved a while ago and could not be refreshed, or its price date is several days old.',
      'Minstens één stationsprijs is ouder: hij is een tijd geleden opgehaald en kon niet worden ververst, of de prijsdatum is enkele dagen oud.'));
  }
  if ((best.price && best.price.priceDateKnown === false) || (nearest && nearest.price && nearest.price.priceDateKnown === false)) {
    caveats.push(t('ANWB does not report when a station last changed its price (price date unknown); check the pump price before you drive.',
      'ANWB meldt niet wanneer een station zijn prijs voor het laatst wijzigde (prijsdatum onbekend); controleer de pompprijs voordat je gaat rijden.'));
  }
  const be = best.breakEven;
  const baseLabel = baseline.name ? t(`the nearest station, ${baseline.name}`, `het dichtstbijzijnde station, ${baseline.name}`) : baseline.label;
  return {
    level: 'go',
    confidence,
    headline: t(`Refuel at ${place}${bestQ === 'estimate' ? ' (estimated price)' : ''}: save about ${money(best.cashSaving)}`,
      `Tank bij ${place}${bestQ === 'estimate' ? ' (geschatte prijs)' : ''}: bespaar ongeveer ${money(best.cashSaving)}`),
    detail: t(`Compared with ${baseline.label}. Includes ${best.extraKm.toFixed(1)} extra km (≈ ${money(best.detourCost)} of driving cost for the full ${best.route.detourKm.toFixed(1)} km detour).`,
      `Vergeleken met ${baseLabel}. Inclusief ${fmtNum(best.extraKm, 1, "nl")} extra km (≈ ${money(best.detourCost)} rijkosten voor de hele omweg van ${fmtNum(best.route.detourKm, 1, "nl")} km).`) +
      (tv > 0 ? t(` Worth ${money(best.saving)} to you${timeNote(best)}.`, ` Voor jou ${money(best.saving)} waard${timeNote(best)}.`) : '') +
      (be.kind === 'min' ? t(` Worth it from about ${be.litres} L.`, ` De moeite waard vanaf ongeveer ${be.litres} L.`)
        : be.kind === 'always' ? t(' Cheaper for any amount.', ' Goedkoper bij elke hoeveelheid.') : ''),
    stationId: best.id,
    quotedAlternative,
    caveats,
  };
}

function assumptions(input, config, routes) {
  const t = tr(input.lang);
  const money = moneyFor(input.lang);
  const a = [];
  if (input.destination) {
    a.push(t('Route mode: extra km = (start → station → destination) − (start → destination).',
      'Routemodus: extra km = (start → station → bestemming) − (start → bestemming).'));
  } else {
    a.push(t('Round-trip mode (no destination): extra km = start → station → start. Use this if you would otherwise not drive anywhere.',
      'Heen-en-terugmodus (geen bestemming): extra km = start → station → start. Gebruik dit als je anders nergens heen zou rijden.'));
  }
  a.push(input.baseline.mode === 'custom'
    ? t(`Baseline: refuelling at €${input.baseline.price.toFixed(3)}/L with no extra driving.`,
      `Vergelijkingspunt: tanken voor €${fmtNum(input.baseline.price, 3, "nl")}/L zonder extra rijden.`)
    : t('Baseline: the station with the smallest detour (the nearest one), whatever its country.',
      'Vergelijkingspunt: het station met de kleinste omweg (het dichtstbijzijnde), in welk land dan ook.'));
  a.push(t(`Detour fuel (${input.consumption} L/100 km) is valued at the price paid at that station; plus €${input.perKmCost.toFixed(2)}/km other running costs.`,
    `Brandstof voor de omweg (${input.consumption} L/100 km) wordt gerekend tegen de prijs bij dat station; plus €${fmtNum(input.perKmCost, 2, "nl")}/km overige rijkosten.`));
  a.push(input.timeValuePerHour > 0
    ? t(`Detour rule: a further station must save at least ${money(input.timeValuePerHour / 6)} per 10 extra minutes of driving (travel times from the routing service). Stations are ranked by saving minus that amount; the € savings shown are real money.`,
      `Omrijregel: een verder station moet minstens ${money(input.timeValuePerHour / 6)} per 10 extra minuten rijden besparen (reistijden van de routeplanner). Stations worden gerangschikt op besparing min dat bedrag; de getoonde €-besparingen zijn echt geld.`)
    : t('Extra driving time is not counted: only money counts.', 'Extra rijtijd telt niet mee: alleen geld telt.'));
  a.push(t(`A different station is only recommended if it is worth at least ${money(input.minSaving)} to you.`,
    `Een ander station wordt alleen aangeraden als het je minstens ${money(input.minSaving)} oplevert.`));
  a.push(t('Tolls, parking, loyalty discounts and card fees are not included.', 'Tol, parkeren, spaarkortingen en pastransactiekosten zijn niet meegerekend.'));
  a.push(t(`Stations are the ${config.maxStationsPerCountry} closest per country within ${input.radiusKm} km (straight-line pre-selection); with ANWB, stations that list prices for other fuels but not this one are skipped.`,
    `Stations zijn de ${config.maxStationsPerCountry} dichtstbijzijnde per land binnen ${input.radiusKm} km (hemelsbrede voorselectie); bij ANWB worden stations overgeslagen die wel prijzen voor andere brandstoffen hebben, maar niet voor deze.`));
  a.push(t('Prices: a station-specific quote where available (Belgium: CARBU.COM first, with the station\'s price date; otherwise ANWB Onderweg, retrieved at most ~24 h ago, price date not reported); otherwise, for NL/BE only, a country ESTIMATE (NL: CBS national average, BE: FOD legal maximum), marked as such. Stations in other countries are only shown with a station quote.',
    'Prijzen: een eigen stationsprijs waar beschikbaar (België: eerst CARBU.COM, met de prijsdatum van het station; anders ANWB Onderweg, hooguit ~24 u geleden opgehaald, prijsdatum niet gemeld); anders, alleen voor NL/BE, een landelijke SCHATTING (NL: CBS landelijk gemiddelde, BE: FOD wettelijke maximumprijs), als zodanig gemarkeerd. Stations in andere landen worden alleen getoond met een stationsprijs.'));
  if (routes) {
    a.push(routes.mode === 'road'
      ? t('Distances: shortest-time car route from the routing service.', 'Afstanden: snelste autoroute volgens de routeplanner.')
      : t(`Distances: straight-line × ${config.roadFactor} estimate.`, `Afstanden: schatting (hemelsbreed × ${config.roadFactor}).`));
  }
  return a;
}

module.exports = { makeCompareService, parseInput, navigationLinks, InputError };
