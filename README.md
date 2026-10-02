# Tankwijzer — is the cheaper pump worth the drive?

Self-hosted web app that tells you whether it pays to drive a bit further — to another town or across the border — to
refuel. It finds stations around you (or along your route), routes to each one and compares
**total cost = fuel bought + cost of the extra kilometres**. It then recommends a station, shows the saving and the
number of litres from which the trip pays off.

- Start from browser GPS, a typed address or coordinates, or a pin on the map. You can add an optional destination.
- Fuels: Petrol 95 (E10), Petrol 98 (E5), Diesel (B7), LPG, mapped to each country's local names.
- Enter consumption in L/100 km or km/L, litres to buy and optional running cost per km.
- Round trip (start → station → start) or detour along a route (start → station → destination).
- Results: net saving, extra km/minutes, break-even litres, recommendation with confidence, and a map with station
  tooltips.
- Navigation links: Google Maps, OSM, `geo:` on Android, Apple Maps on iOS.
- Every price shows its kind, source and date or age. Estimates are always labelled as such.
- Dutch UI by default, with an NL/EN toggle.
- Scroll over the map to continue through results; Ctrl/⌘ + wheel zooms. Click or focus the map to temporarily enable normal wheel zoom (until leaving it). On touchscreens, use two fingers to move/zoom the map; one finger scrolls the page. The floating arrow returns the page and desktop scroll panels to the top, respecting reduced-motion preferences.
- No npm dependencies: runs on the Node 22 standard library, with vanilla JS and Leaflet in the browser.

## Quick start

### Docker Compose

```bash
cp .env.example .env        # optional; set CONTACT_EMAIL at least
docker compose up -d --build
# open http://localhost:8080
```

- Out of the box the app uses OpenStreetMap stations with labelled CBS/FOD country estimates.
- Per-station price providers are off by default; see [Price sources](#price-sources).
- `HOST_PORT=9000 docker compose up -d` changes the host port.
- `env_file … required: false` needs Docker Compose ≥ 2.24.

### Prebuilt image (GitHub Container Registry)

`.github/workflows/docker.yml` runs the tests and publishes a multi-arch image (`linux/amd64`, `linux/arm64`) to
`ghcr.io/<github-user>/tankwijzer`:

- on every push to `main`, tagged `latest` and `sha-…`;
- on version tags `vX.Y.Z`, tagged `X.Y.Z` and `X.Y`.

To run it:

```bash
cp .env.example .env
echo "TANKWIJZER_IMAGE=ghcr.io/<github-user>/tankwijzer:latest" >> .env
docker compose pull tankwijzer && docker compose up -d --no-build
```

or without Compose:

```bash
docker run -d --name tankwijzer -p 8080:8080 --env-file .env \
  -v tankwijzer-anwb:/app/data/anwb -v tankwijzer-carbu:/app/data/carbu \
  ghcr.io/<github-user>/tankwijzer:latest
```

The image contains only code. It has no `.env` and no cached price data.

### Without Docker

Requires Node.js ≥ 20.6.

```bash
npm start                                  # http://localhost:8080
node --env-file=.env src/server.js         # same, reading settings from .env
npm test                                   # unit + API tests (no network needed)
```

## How the comparison works

For every station *S* with a price *P(S)*:

```
detourKm(S)   = km(start → S) + km(S → end) − km(base trip)      (never below 0)
                 round trip : end = start,        base trip = 0
                 route      : end = destination,  base trip = start → destination
cash(S)       = litres × P(S) + detourKm(S) × (consumption/100 × P(S) + otherCostPerKm)
cost(S)       = cash(S) + detourMinutes(S)/10 × requiredSavingPer10Min   (the "detour rule")
cashSaving(S) = cash(baseline) − cash(S)          (real money, shown as the € amount)
saving(S)     = cost(baseline) − cost(S)          (what it is worth to you; used for ranking)
extraKm(S)    = detourKm(S) − detourKm(baseline)
break-even    = litres at which saving(S) = 0
```

- **Baseline:** by default, the station with the smallest detour — the one you'd use without comparing.
  Alternatively, a price you pay anyway, with 0 extra km.
- **Round trip without a destination** assumes you would otherwise not drive at all, so all km to the station and
  back count. If you're driving somewhere anyway, add a destination: then only the extra km compared with the
  direct route count.
- Detour fuel is valued at the price of the station you refuel at.
- A saving smaller than the minimum saving (default €1) results in "refuel at the nearest station".
- Not included: tolls, parking, loyalty discounts, card fees, queueing.
- Stations are pre-selected by straight-line distance (the N closest per country), then routed by road.

### Form settings

Changing any setting re-runs the comparison automatically.

| Setting | Meaning |
|---|---|
| **Is a detour worth it to you?** | *Any saving counts*: money only. *Only if the extra driving is worth it*: €2 per 10 extra min, minimum €2. *Only for a clear win*: €5 per 10 extra min, minimum €5. Editing the two fields below switches to *My own rule*. |
| Every 10 extra min must save (€) | A further station must beat the nearest one by at least this much per 10 extra minutes (OSRM travel times). Used for ranking; the € saving shown stays real money. |
| Ignore savings below (€) | Below this, recommend the nearest station. |
| Search radius (km) | Radius around the start (or along the route) in which stations are considered. |
| Other running cost (€/km) | Wear, tyres and maintenance per detour km (e.g. €0.05–0.15). |
| Compare against | *Nearest station* or *a price I pay anyway*. |
| Price per country | Your own observed pump price. It is used only for stations without a station-specific price. |

### Vehicle and kenteken lookup (optional)

You can type a **Dutch** licence plate (kenteken), or skip it and fill everything in yourself. The manual flow works
as before. Belgian and German plates are not supported.

The server looks the plate up in RDW Open Data (CC0) and combines two datasets:

- `m9d7-ebf2`: make, model, body type, first admission and kerb weight;
- `8ys7-d773`: fuel rows, hybrid class, power, consumption, CO₂ and emission class (`uitlaatemissieniveau`).

Extra vehicle info and warnings are fetched **in parallel** from these datasets (also CC0) and are best-effort. If one of
them fails, the lookup still succeeds with a partial profile, and the card names what is missing:

- **APK** from `m9d7-ebf2` `vervaldatum_apk` (YYYYMMDD), relative to today in Europe/Amsterdam: expired is red,
  ≤30 days orange, ≤60 days a subtle hint. This shows as a compact badge in the collapsed summary and in detail on the card.
- **Recalls**:
  - `t49b-isb7` gives the status per plate. Code `O` is an open recall; `P` means the manufacturer has reported the repair.
  - For open recalls, the details come from `j9yg-7rg9` (defect, repair, more-info link and publication date), looked up by `referentiecode_rdw`.
  - The possible danger comes from `9ihi-jgpf` (`mogelijk_gevaar`).
  - Resolved recalls are only shown as a collapsible count.
- **Body type** from `vezc-m2t6` (`carrosserietype`, `type_carrosserie_europese_omschrijving`). The number of doors comes from
  `m9d7-ebf2` `aantal_deuren`.
- **Drive** from `3huj-srit` (`as_nummer`, `aangedreven_as` = `J`/`N`):
  - more than one driven axle → 4x4/AWD
  - only axle 1 → front-wheel
  - only axle 2 → rear-wheel
  - otherwise unknown and not shown. The field is often empty in RDW.
- **Extras:** pk (kW × 1.36), colour (`eerste_kleur`) and emission class.

The extras use the same 24 h cache. If a profile is remembered in the browser, its recall data can be out of date until the
next lookup; the APK status is always recomputed against today.

The app shows the vehicle for you to confirm. It then fills in the fields below; each one stays editable, and a label shows where its value came from:

| Field | Source, in order | Label |
|---|---|---|
| Fuel | Benzine → Euro95 E10 (you can switch to E5/98), Diesel → B7, LPG → LPG (preferred when the car runs on both petrol and LPG) | RDW |
| Consumption | WLTP combined → NEDC combined → estimated from CO₂ (petrol CO₂/23.7, diesel CO₂/26.5, LPG CO₂/16.1) | RDW WLTP / RDW NEDC / *geschat uit CO₂* |
| Tank capacity | not in RDW; estimated as *target range × lab consumption* (before the realism uplift), see below. Falls back to kerb weight (<1050 kg 35 L, 1050–1250 kg 42 L, 1250–1500 kg 52 L, >1500 kg 60 L) when consumption is missing, and for plug-in hybrids | *geschat (±920 km × 5,5 L/100)* / *geschat uit gewicht* |

Tank model: target range by kerb weight is <1100 kg → 750 km, <1600 kg → 920 km, <2000 kg → 980 km, otherwise
1050 km. For diesel the target is ×1.2, because diesels have similar tanks but use less fuel. The result
(`range × L/100 km ÷ 100`) is snapped to the nearest of 35, 40, 42, 45, 50, 52, 55, 60, 65, 70, 75 or 80 L and
clamped to 30–80 L. The vehicle card also shows the estimated range: tank ÷ the consumption you are actually using.

Any value you change is labelled *door jou aangepast*.

- **Lab values.** WLTP and NEDC are lab figures; real-world consumption is usually higher. A visible *+15% realism*
  option is on by default (`VEHICLE_REALISM_UPLIFT_PCT`). You can switch it off or change the percentage. The raw
  RDW value is always shown next to it.
- **Plug-in hybrids** (OVC-HEV) get a warning: their lab consumption assumes battery driving and is unrealistic for
  fuel-only use.
- **Electric-only cars** are not prefilled, because this app is for liquid fuel.
- **Litres to buy** = tank capacity × (1 − tank level). Set the level with the slider. The litres field remains a
  direct override.

Privacy and robustness:

- The lookup runs server-side (`/api/kenteken`).
- Results are cached in memory for 24 h; a "not found" is cached for 1 h.
- The endpoint has its own rate limit of 20 per minute.
- Logs contain only a masked plate (`AB**3D`).
- The plate is stored in the browser only if you tick *onthoud mijn auto*.
- The detailed vehicle fields are collapsed behind a one-line summary (*Aanpassen* / *Handmatig invullen*). They open automatically, with the reason shown, for an EV, a plug-in hybrid, a failed lookup or a missing/invalid consumption or litres value. The open/closed state is only remembered as part of the opt-in profile.
- Errors are explicit: invalid format, not found, RDW unavailable or rate limited. In each case manual entry keeps
  working.

A possible future tank-capacity source is the CarQuery API. It is not integrated because its availability and terms
for this use could not be confirmed.

### Language

The UI is Dutch by default; the **NL / EN** toggle in the header switches it, and the choice is remembered in the
browser. The client sends `lang` (`nl`/`en`) with each comparison, so recommendation, warnings and assumptions come
back in that language.

The API defaults to English. Some texts are English only:

- input validation errors;
- geocoder place labels;
- DirectLease price notes.

## Price sources

Price priority per station:

1. station price file;
2. CARBU.COM (Belgium);
3. ANWB Onderweg;
4. DirectLease, if enabled;
5. country estimate.

Estimates are never presented as station prices, and the recommendation's confidence is lowered when they are used.

| Purpose | Source | Notes |
|---|---|---|
| Stations + prices (NL, BE, DE, …) | ANWB Onderweg POI API | Off by default (`ANWB_PRIVATE_USE_ACK`). No price date, so the retrieval time is shown. Cached 3 h per area tile. |
| Station prices (BE) | CARBU.COM station lists | Off by default (`CARBU_PRIVATE_USE_ACK`). Includes each station's price date. Cached 3 h. |
| Station prices (NL, BE) | DirectLease via the optional `pyfuelprices` sidecar | Off by default (`DIRECTLEASE_PRIVATE_USE_ACK`). Cached 24 h per station. |
| Station prices | Local JSON file (`station-file`) | Prices you collect yourself. |
| NL estimate | [CBS StatLine 80416ned](https://opendata.cbs.nl/statline/#/CBS/nl/dataset/80416ned/table) | Open data (CC BY 4.0). Daily national average, published about a week late. No 98 octane. |
| BE estimate | [FOD Economie maximum prices](https://economie.fgov.be/nl/themas/energie/energieprijzen/maximumprijzen/officieel-tarief-van-de) | Legal maximum price. Stations often sell lower, so BE savings are conservative. |
| Stations (fallback) | OpenStreetMap via Overpass | ODbL. Used when ANWB is off or unavailable. NL/BE only. |
| Routing | [OSRM](https://project-osrm.org/) public demo | Falls back to straight line × `ROAD_FACTOR`, labelled as such. |
| Geocoding | [Photon](https://photon.komoot.io/) (or Nominatim) | Search-as-you-type, cached. The public Photon takes about 3–5 s per query. |
| Instant place suggestions | [GeoNames](https://www.geonames.org/) (`data/places.tsv`) | CC BY 4.0. Offline index of towns and NL/BE/LU 4-digit postcodes, answers in milliseconds while Photon loads streets/addresses. Rebuild with `python scripts/build_places.py`; turn off with `LOCAL_PLACES=false`. |
| Fast streets/addresses NL | [PDOK Locatieserver](https://api.pdok.nl/bzk/locatieserver/search/v3_1/ui/) (Kadaster, BAG/NWB) | Open data (CC0), no key. ~0.1-0.3 s per query, biased towards your location. |
| Fast streets/addresses Flanders + Brussels | [Digitaal Vlaanderen geolocation](https://geo.api.vlaanderen.be/geolocation/v4/Location) | Open service, no key. Wallonia, Germany and the rest still come from Photon (slow public server; self-host Photon via `PHOTON_URL` to fix). Turn off with `OFFICIAL_GEOCODERS=`. |
| Map tiles | OpenStreetMap | [Tile usage policy](https://operations.osmfoundation.org/policies/tiles/) |

**ANWB Onderweg, CARBU.COM and DirectLease data is not open data.** Only enable these providers if you have the
provider's own permission, for a private installation. Each provider:

- uses normal requests with an honest User-Agent;
- caches results and enforces request budgets;
- on HTTP 401/403, writes `blocked.json` in its data directory and stops all requests to that provider.

Remove `blocked.json` only after the provider has restored access.

### Countries without an estimate

Stations in countries without a country estimate (e.g. DE, FR, LU) are compared only when they have a station price,
or when you enter a price per country under Advanced.

## Configuration

All settings are environment variables (see `.env.example`). Nothing secret is sent to the browser.

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Listen address |
| `CONTACT_EMAIL` | – | Added to outgoing User-Agents (recommended by OSM policies) |
| `HTTP_USER_AGENT` | `tankwijzer/0.2 (self-hosted; <email>)` | Outgoing User-Agent for OSM services |
| `HTTP_TIMEOUT_MS` | `15000` | Outgoing request timeout |
| `STATION_PROVIDER` | `anwb` | `anwb` (falls back to Overpass) or `overpass`; if both fail, the app shows an error |
| `OVERPASS_URLS` | public mirrors | Comma-separated, tried in order |
| `STATION_CACHE_TTL_S` | `86400` | Station cache |
| `SEARCH_RADIUS_KM` | `20` | Default radius (UI allows 1–50) |
| `MAX_STATIONS_PER_COUNTRY` | `12` | Stations routed per country |
| `PRICE_PROVIDERS` | `station-file,carbu,anwb,directlease,cbs-nl,fod-be` | Order = priority; providers without their ACK stay inactive |
| `ANWB_PRIVATE_USE_ACK` / `ANWB_PAUSED` | `false` / `false` | Enable ANWB Onderweg / make no ANWB requests |
| `ANWB_DATA_DIR` | `data/anwb` | Tile cache, request log, `blocked.json` |
| `ANWB_CACHE_TTL_H` | `3` | Re-fetch an area tile at most once per TTL |
| `ANWB_STALE_AFTER_H` / `ANWB_MAX_AGE_H` | `12` / `24` | Mark older quotes / never use older quotes |
| `ANWB_MIN_INTERVAL_MS` | `2000` | Gap between requests |
| `ANWB_HOURLY_BUDGET` / `ANWB_DAILY_BUDGET` | `30` / `150` | Request caps |
| `ANWB_MAX_TILES_PER_SEARCH` | `6` | Area tiles fetched per search |
| `ANWB_ERROR_BACKOFF_MIN` / `ANWB_TIMEOUT_MS` | `30` / `20000` | Pause after errors / request timeout |
| `CARBU_PRIVATE_USE_ACK` / `CARBU_PAUSED` | `false` / `false` | Enable CARBU.COM / make no CARBU.COM requests |
| `CARBU_DATA_DIR` | `data/carbu` | List/location cache, request log, `blocked.json` |
| `CARBU_CACHE_TTL_H` | `3` | Re-fetch a station list at most once per TTL |
| `CARBU_STALE_AFTER_H` / `CARBU_MAX_AGE_H` | `12` / `24` | Mark older lists / never use older lists |
| `CARBU_PRICE_STALE_DAYS` / `CARBU_PRICE_MAX_DAYS` | `7` / `30` | Mark / drop quotes by price date |
| `CARBU_MAX_LOCATIONS_PER_SEARCH` | `2` | Station lists fetched per search |
| `CARBU_MATCH_RADIUS_M` | `200` | Max distance for matching a station |
| `CARBU_MIN_INTERVAL_MS` | `1500` | Gap between requests |
| `CARBU_HOURLY_BUDGET` / `CARBU_DAILY_BUDGET` | `20` / `100` | Request caps |
| `DIRECTLEASE_URL` | `http://127.0.0.1:8090` | Sidecar URL (Compose profile `directlease`) |
| `DIRECTLEASE_PRIVATE_USE_ACK` / `DIRECTLEASE_PAUSED` | `false` / `false` | Enable DirectLease / make no DirectLease requests (app and sidecar) |
| `DIRECTLEASE_CACHE_TTL_H` / `DIRECTLEASE_MAX_AGE_H` | `24` / `36` | Sidecar cache / never use older quotes |
| `STATION_PRICE_FILE` | `data/station-prices.json` | Station price file |
| `STATION_PRICE_MAX_AGE_H` | `48` | Older station prices are ignored |
| `PRICE_CACHE_TTL_S` | `10800` | CBS/FOD cache |
| `CBS_URL`, `FOD_PDF_URL` | official URLs | Override if they move |
| `ROUTING_PROVIDER` | `osrm` | `osrm` or `estimate` (no network) |
| `OSRM_URL` | public demo | Point to your own OSRM for heavier use |
| `ROAD_FACTOR` | `1.3` | Straight-line → road multiplier for the fallback |
| `GEOCODER` | `photon` | `photon`, `nominatim` (whole words only) or `none` |
| `PHOTON_URL`, `NOMINATIM_URL`, `GEOCODE_COUNTRIES` | public instances, European countries | Geocoder. A self-hosted Photon (`PHOTON_URL`) makes street/address search fast too. |
| `LOCAL_PLACES` | `true` | Instant offline town/postcode suggestions (GeoNames) |
| `OFFICIAL_GEOCODERS` | `pdok,vlaanderen` | Fast official address registers (NL, Flanders/Brussels); empty disables; only used for countries in `GEOCODE_COUNTRIES` |
| `PDOK_URL` / `VLAANDEREN_GEO_URL` | public endpoints | Override the register base URLs |
| `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION` | OSM tiles | Map tiles |
| `MIN_WORTHWHILE_SAVING_EUR` | `1.0` | Below this, recommend the nearest station |
| `RATE_LIMIT_PER_MIN` | `30` | Per-IP limit for geocode/compare/prices |

### Station price file

With Docker Compose, put `station-prices.json` in `./prices/`. The format is shown in
[`data/station-prices.example.json`](data/station-prices.example.json).

- Entries match a station by `stationId` or by coordinates within 75 m.
- `observedAt` is required. Entries older than `STATION_PRICE_MAX_AGE_H` are ignored.
- The file is re-read when it changes.

### DirectLease sidecar (optional)

```bash
docker compose --profile directlease up -d
# or locally (Python 3.11+):
python -m venv .venv-dl && .venv-dl/bin/pip install -r sidecar/directlease/requirements.txt
DIRECTLEASE_DATA_DIR=./directlease-data .venv-dl/bin/python sidecar/directlease/app.py   # :8090
python -m unittest discover -s sidecar/directlease
```

To use it, set `DIRECTLEASE_PRIVATE_USE_ACK=true` in `.env` (read by both the app and the sidecar).

### Adding a provider

In `src/providers/prices.js`, a price provider is an object with one of:

- `stationPrice(station, fuelId, ctx)`, with an optional async `prefetch(stations)`;
- `reference(fuelId)`, per country.

Either one returns:

```js
{ price, kind: 'station'|'national-average'|'legal-maximum', quality: 'live-quote'|'stale-quote'|'station-report'|'country-estimate',
  estimate, source, sourceUrl, license, asOf, fetchedAt, live, note }
```

Register it in `priceFactories` in `src/server.js` and add its id to `PRICE_PROVIDERS`.

### Production notes

The public OSRM, Photon, Nominatim and OSM tile servers are community resources meant for light use. For heavier use,
self-host them or use a commercial provider.

Put the app behind a TLS reverse proxy: browsers only allow GPS on HTTPS or `localhost`.

## API

- `GET /api/health` — liveness
- `GET /api/config` — fuels, defaults, providers
- `GET /api/geocode?q=` — address search (or `lat,lon`)
- `GET /api/prices` — status of price providers
- `GET /api/kenteken?k=` — RDW vehicle lookup (Dutch plates; 400 invalid, 404 not found, 429 rate limited, 501 disabled, 502 RDW unavailable)
- `POST /api/compare` — `{ start:{lat,lon}, destination?, fuel, litres, consumption, perKmCost?, radiusKm?, baseline?:{mode:'nearest'|'custom', price?}, lang? }`

## Project layout

```
src/economics.js        pure cost model
src/compare.js          orchestration, validation, price priority, recommendation
src/i18n.js             NL/EN helpers for server texts
src/providers/          ANWB, CARBU.COM, stations (Overpass), prices (CBS, FOD, file, DirectLease), routing, geocoding
sidecar/directlease/    optional Python pyfuelprices sidecar
src/server.js           HTTP server, static files, security headers, rate limiting
public/                 UI (vanilla JS + Leaflet)
data/                   example station price file, offline place index (places.tsv), runtime caches
prices/                 optional place for your own station-prices.json
scripts/                build_places.py: rebuilds data/places.tsv from GeoNames (CC BY 4.0)
test/                   node:test suites
.github/workflows/      CI: tests + multi-arch image to ghcr.io
```

## Limitations

- ANWB gives no price date, so freshness means the retrieval time. Always check the pump.
- Many Belgian CARBU.COM prices equal the legal maximum.
- There is no NL 98-octane estimate: enter a price under Advanced.
- Without Leaflet (loaded from unpkg.com), the app works without the map.
