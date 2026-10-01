'use strict';

function list(value, fallback) {
  const v = (value ?? '').trim();
  if (!v) return fallback;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function loadConfig(env = process.env) {
  const contact = env.CONTACT_EMAIL || '';
  return {
    port: num(env.PORT, 8080),
    host: env.HOST || '0.0.0.0',
    userAgent: env.HTTP_USER_AGENT || `tankwijzer/0.2 (self-hosted${contact ? `; ${contact}` : ''})`,
    contactEmail: contact,
    httpTimeoutMs: num(env.HTTP_TIMEOUT_MS, 15000),

    // anwb = ANWB Onderweg stations with per-station prices (needs ANWB_PRIVATE_USE_ACK=true, otherwise
    // the OpenStreetMap/Overpass station list is used); overpass = OSM stations only.
    stationProvider: (env.STATION_PROVIDER || 'anwb').toLowerCase(),

    // ANWB Onderweg (see README "ANWB Onderweg"). Off unless the operator acknowledges the
    // personal-use conditions and holds their own permission.
    anwbAck: bool(env.ANWB_PRIVATE_USE_ACK, false),
    anwbPaused: bool(env.ANWB_PAUSED, false),
    anwbUrl: env.ANWB_URL || 'https://api.anwb.nl/routing/points-of-interest/v3/all',
    anwbUserAgent: env.ANWB_USER_AGENT ||
      `tankwijzer/0.2 (private self-hosted instance, personal use; ANWB Onderweg fuel prices${contact ? `; ${contact}` : ''})`,
    anwbDataDir: env.ANWB_DATA_DIR || 'data/anwb',
    anwbCacheTtlH: num(env.ANWB_CACHE_TTL_H, 3),
    anwbStaleAfterH: num(env.ANWB_STALE_AFTER_H, 12),
    anwbMaxAgeH: num(env.ANWB_MAX_AGE_H, 24),
    anwbTileLatDeg: num(env.ANWB_TILE_LAT_DEG, 0.5),
    anwbTileLonDeg: num(env.ANWB_TILE_LON_DEG, 0.75),
    anwbMaxTilesPerSearch: num(env.ANWB_MAX_TILES_PER_SEARCH, 6),
    anwbMinIntervalMs: num(env.ANWB_MIN_INTERVAL_MS, 2000),
    anwbHourlyBudget: num(env.ANWB_HOURLY_BUDGET, 30),
    anwbDailyBudget: num(env.ANWB_DAILY_BUDGET, 150),
    anwbErrorBackoffMin: num(env.ANWB_ERROR_BACKOFF_MIN, 30),
    anwbTimeoutMs: num(env.ANWB_TIMEOUT_MS, 20000),
    // CARBU.COM Belgian per-station prices (see README "CARBU.COM"). Off unless the operator
    // acknowledges that they hold CARBU.COM's written permission for this private installation.
    carbuAck: bool(env.CARBU_PRIVATE_USE_ACK, false),
    carbuPaused: bool(env.CARBU_PAUSED, false),
    carbuBaseUrl: env.CARBU_BASE_URL || 'https://carbu.com',
    carbuUserAgent: env.CARBU_USER_AGENT ||
      `tankwijzer/0.3 (private self-hosted instance, personal use with permission; CARBU.COM fuel prices${contact ? `; ${contact}` : ''})`,
    carbuReferer: env.CARBU_REFERER === undefined ? 'https://carbu.com/' : env.CARBU_REFERER,
    carbuDataDir: env.CARBU_DATA_DIR || 'data/carbu',
    carbuCacheTtlH: num(env.CARBU_CACHE_TTL_H, 3),
    carbuStaleAfterH: num(env.CARBU_STALE_AFTER_H, 12),
    carbuMaxAgeH: num(env.CARBU_MAX_AGE_H, 24),
    carbuLocationTtlD: num(env.CARBU_LOCATION_TTL_D, 30),
    carbuMaxLocationsPerSearch: num(env.CARBU_MAX_LOCATIONS_PER_SEARCH, 2),
    carbuCoverKm: num(env.CARBU_COVER_KM, 20),
    carbuMatchRadiusM: num(env.CARBU_MATCH_RADIUS_M, 200),
    carbuPriceStaleDays: num(env.CARBU_PRICE_STALE_DAYS, 7),
    carbuPriceMaxDays: num(env.CARBU_PRICE_MAX_DAYS, 30),
    carbuMinIntervalMs: num(env.CARBU_MIN_INTERVAL_MS, 1500),
    carbuHourlyBudget: num(env.CARBU_HOURLY_BUDGET, 20),
    carbuDailyBudget: num(env.CARBU_DAILY_BUDGET, 100),
    carbuErrorBackoffMin: num(env.CARBU_ERROR_BACKOFF_MIN, 30),
    carbuTimeoutMs: num(env.CARBU_TIMEOUT_MS, 30000),

    overpassUrls: list(env.OVERPASS_URLS, [
      'https://overpass-api.de/api/interpreter',
      'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
      'https://overpass.kumi.systems/api/interpreter',
    ]),
    stationCacheTtlS: num(env.STATION_CACHE_TTL_S, 24 * 3600),
    searchRadiusKm: num(env.SEARCH_RADIUS_KM, 20),
    maxStationsPerCountry: num(env.MAX_STATIONS_PER_COUNTRY, 12),

    // Order = priority per station: CARBU.COM (BE), ANWB Onderweg, DirectLease (sidecar), then CBS/FOD
    // country ESTIMATES (clearly labelled). Each per-station source only runs when its *_PRIVATE_USE_ACK is set.
    priceProviders: list(env.PRICE_PROVIDERS, ['station-file', 'carbu', 'anwb', 'directlease', 'cbs-nl', 'fod-be']),
    // DirectLease Tankservice via the pyfuelprices sidecar (Compose profile "directlease").
    directLeaseAck: bool(env.DIRECTLEASE_PRIVATE_USE_ACK, false),
    directLeasePaused: bool(env.DIRECTLEASE_PAUSED, false),
    directLeaseUrl: env.DIRECTLEASE_URL || 'http://127.0.0.1:8090',
    directLeaseTimeoutMs: num(env.DIRECTLEASE_TIMEOUT_MS, 60000),
    directLeaseMaxAgeH: num(env.DIRECTLEASE_MAX_AGE_H, 36),
    stationPriceFile: env.STATION_PRICE_FILE || 'data/station-prices.json',
    stationPriceMaxAgeH: num(env.STATION_PRICE_MAX_AGE_H, 48),
    priceCacheTtlS: num(env.PRICE_CACHE_TTL_S, 3 * 3600),
    cbsUrl: env.CBS_URL || 'https://opendata.cbs.nl/ODataApi/odata/80416ned/TypedDataSet',
    fodPdfUrl: env.FOD_PDF_URL ||
      'https://economie.fgov.be/sites/default/files/Files/Energy/prices/Officiele-Maximumtarieven-aardolieproducten.pdf',

    routingProvider: (env.ROUTING_PROVIDER || 'osrm').toLowerCase(),
    osrmUrl: (env.OSRM_URL || 'https://router.project-osrm.org').replace(/\/$/, ''),
    roadFactor: num(env.ROAD_FACTOR, 1.3),

    geocoder: (env.GEOCODER || 'photon').toLowerCase(),
    photonUrl: (env.PHOTON_URL || 'https://photon.komoot.io').replace(/\/$/, ''),
    // Offline GeoNames town/postcode index (data/places.tsv) for instant suggestions while Photon loads.
    localPlaces: !['0', 'false', 'no', 'off'].includes(String(env.LOCAL_PLACES || 'true').toLowerCase()),
    // Fast official address registers (open data, no key): pdok = Netherlands, vlaanderen = Flanders + Brussels.
    officialGeocoders: env.OFFICIAL_GEOCODERS != null ? env.OFFICIAL_GEOCODERS : 'pdok,vlaanderen',
    pdokUrl: (env.PDOK_URL || 'https://api.pdok.nl/bzk/locatieserver/search/v3_1').replace(/\/$/, ''),
    vlaanderenGeoUrl: (env.VLAANDEREN_GEO_URL || 'https://geo.api.vlaanderen.be/geolocation/v4').replace(/\/$/, ''),
    nominatimUrl: (env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org').replace(/\/$/, ''),
    // Default: the European countries ANWB Onderweg covers. Set e.g. GEOCODE_COUNTRIES=nl,be to narrow it.
    geocodeCountries: env.GEOCODE_COUNTRIES ||
      'nl,be,de,lu,fr,at,ch,li,dk,it,es,pt,ad,mc,sm,gb,ie,pl,cz,sk,hu,si,hr,ba,rs,me,mk,al,gr,bg,ro,se,no,fi,ee,lv,lt',

    tileUrl: env.MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    tileAttribution: env.MAP_TILE_ATTRIBUTION ||
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',

    minWorthwhileSaving: num(env.MIN_WORTHWHILE_SAVING_EUR, 1.0),
    rateLimitPerMin: num(env.RATE_LIMIT_PER_MIN, 30),

    // Optional Dutch licence-plate lookup via RDW Open Data (CC0). KENTEKEN_LOOKUP=false hides it.
    kentekenLookup: !['0', 'false', 'no', 'off'].includes(String(env.KENTEKEN_LOOKUP || 'true').toLowerCase()),
    rdwUrl: (env.RDW_URL || 'https://opendata.rdw.nl').replace(/\/$/, ''),
    rdwAppToken: env.RDW_APP_TOKEN || '', // Socrata app token; server-side only
    // Default realism uplift on RDW lab (WLTP/NEDC) consumption figures, in percent. Editable in the UI.
    vehicleRealismUpliftPct: num(env.VEHICLE_REALISM_UPLIFT_PCT, 15),
  };
}

module.exports = { loadConfig };
