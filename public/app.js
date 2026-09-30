'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const state = { start: null, destination: null, config: null, map: null, layer: null };

  // ------------------------------------------------------------ language (Dutch default, English optional)
  const LANG_KEY = 'fuel-detour:lang';
  let lang = (() => { try { return localStorage.getItem(LANG_KEY) === 'en' ? 'en' : 'nl'; } catch { return 'nl'; } })();
  const t = (en, nl) => (lang === 'nl' ? nl : en);
  const locale = () => (lang === 'nl' ? 'nl-NL' : 'en-GB');
  const num = (v, d) => Number(v).toLocaleString(locale(), { minimumFractionDigits: d, maximumFractionDigits: d });
  const eur = (v) => `€${num(v, 2)}`;
  const eurL = (v) => `€${num(v, 3)}/L`;
  const km = (v) => Number(v).toLocaleString(locale(), { maximumFractionDigits: 1 });

  // Static HTML is written in Dutch; English lives in data-en (innerHTML) and data-en-<attr> attributes.
  const STATIC_ATTRS = ['placeholder', 'title', 'aria-label'];
  function applyStaticTexts() {
    document.documentElement.lang = lang;
    for (const node of document.querySelectorAll('[data-en]')) {
      if (node.dataset.nl === undefined) node.dataset.nl = node.innerHTML;
      node.innerHTML = lang === 'en' ? node.dataset.en : node.dataset.nl;
    }
    for (const attr of STATIC_ATTRS) {
      const key = `en-${attr}`;
      for (const node of document.querySelectorAll(`[data-${key}]`)) {
        const store = `data-nl-${attr}`;
        if (!node.hasAttribute(store)) node.setAttribute(store, node.getAttribute(attr) || '');
        node.setAttribute(attr, lang === 'en' ? node.getAttribute(`data-${key}`) : node.getAttribute(store));
      }
    }
    for (const b of document.querySelectorAll('.lang-toggle button')) b.setAttribute('aria-checked', String(b.dataset.lang === lang));
  }

  function el(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function fmtAge(iso) {
    if (!iso) return t('unknown date', 'onbekende datum');
    const ts = Date.parse(iso);
    if (!Number.isFinite(ts)) return iso;
    const h = (Date.now() - ts) / 3600000;
    const date = new Date(ts).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
    if (h < 0) return t(`valid from ${date}`, `geldig vanaf ${date}`);
    if (h < 1) return t('less than 1 hour old', 'minder dan 1 uur oud');
    if (h < 48) return t(`${Math.round(h)} h old`, `${Math.round(h)} uur oud`);
    return t(`${date} (${Math.round(h / 24)} days old)`, `${date} (${Math.round(h / 24)} dagen oud)`);
  }

  const KIND_LABEL = () => ({
    station: t('Station price', 'Stationsprijs'),
    'national-average': t('Estimate: NL national average', 'Schatting: NL landelijk gemiddelde'),
    'legal-maximum': t('Estimate: BE legal maximum', 'Schatting: BE wettelijk maximum'),
    user: t('Estimate: your price', 'Schatting: jouw prijs'),
  });
  const QUALITY_LABEL = () => ({
    'live-quote': t('Station quote', 'Stationsprijs'),
    'stale-quote': t('Station quote (retrieved earlier)', 'Stationsprijs (eerder opgehaald)'),
    'station-report': t('Station report', 'Stationsmelding'),
  });
  const CONFIDENCE_LABEL = () => ({
    high: t('High confidence: actual pump prices for this station and the comparison point', 'Hoge zekerheid: echte pompprijzen voor dit station én het vergelijkingspunt'),
    medium: t('Medium confidence: compares a station quote with an estimate (or an older quote)', 'Gemiddelde zekerheid: vergelijkt een stationsprijs met een schatting (of een oudere prijs)'),
    low: t('Low confidence: based on country estimates, not pump prices', 'Lage zekerheid: gebaseerd op landelijke schattingen, niet op pompprijzen'),
  });

  function priceLabel(p) {
    return QUALITY_LABEL()[p.quality] || KIND_LABEL()[p.kind] || p.kind;
  }

  function priceFreshness(p) {
    if (p.priceDateKnown === false) {
      const at = p.fetchedAt ? new Date(p.fetchedAt).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '?';
      return t(`retrieved at ${at} (${fmtAge(p.fetchedAt)}), price date unknown`, `opgehaald op ${at} (${fmtAge(p.fetchedAt)}), prijsdatum onbekend`);
    }
    if (p.provider === 'carbu') {
      const d = p.priceDate ? new Date(`${p.priceDate}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : t('not shown', 'niet vermeld');
      return t(`price date ${d} (CARBU.COM), retrieved ${fmtAge(p.fetchedAt)}`, `prijsdatum ${d} (CARBU.COM), opgehaald ${fmtAge(p.fetchedAt)}`);
    }
    if (p.provider === 'directlease') {
      return t(`retrieved ${fmtAge(p.fetchedAt)} (DirectLease does not report when the station last changed the price)`,
        `opgehaald ${fmtAge(p.fetchedAt)} (DirectLease meldt niet wanneer het station de prijs voor het laatst wijzigde)`);
    }
    return fmtAge(p.asOf);
  }

  // Country reference figures (CBS/FOD) come with English notes from the server; describe them locally.
  function refSourceText(r) {
    if (lang === 'en') return `${r.source}, ${fmtAge(r.asOf)}. ${r.note || ''}`;
    const what = r.kind === 'legal-maximum'
      ? `${r.source.replace('FOD Economie official maximum price', 'FOD Economie officiële maximumprijs').replace('(list', '(lijst')}. Wettelijke MAXIMUMprijs incl. btw, geldig vanaf de getoonde datum; veel Belgische stations zitten eronder (vaak 5–15 ct/L), dus Belgische besparingen zijn voorzichtig`
      : r.kind === 'national-average'
        ? 'CBS (Centraal Bureau voor de Statistiek), tabel 80416ned. Landelijk daggemiddelde incl. btw, gepubliceerd met enkele dagen vertraging; losse stations (vooral onbemand/snelweg) kunnen ±20 ct afwijken'
        : r.source;
    return `${what} — ${fmtAge(r.asOf)}.`;
  }

  // ------------------------------------------------------------ consumption unit (L/100 km <-> km/L)
  // The API always receives L/100 km; km/L is converted client-side (L/100 km = 100 / km/L).
  let consUnit = 'l100';
  const round1 = (n) => Math.round(n * 10) / 10;
  function convertConsumption(v) {
    const n = Number(String(v).replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? round1(100 / n) : '';
  }
  function consumptionL100() {
    const v = $('consumption').value;
    return consUnit === 'kml' ? convertConsumption(v) : v;
  }
  function updateConsumptionHint() {
    const n = Number($('consumption').value);
    const hint = $('consumption-hint');
    if (!(n > 0)) { hint.hidden = true; return; }
    hint.textContent = consUnit === 'kml' ? `= ${convertConsumption(n)} L/100 km` : `= ${convertConsumption(n)} km/L`;
    hint.hidden = false;
  }
  function setConsumptionUnit(unit, convert = true) {
    if (unit !== 'l100' && unit !== 'kml') unit = 'l100';
    if (convert && unit !== consUnit && $('consumption').value) $('consumption').value = convertConsumption($('consumption').value);
    consUnit = unit;
    for (const b of document.querySelectorAll('#cons-toggle button')) b.setAttribute('aria-checked', String(b.dataset.unit === unit));
    const inp = $('consumption');
    inp.max = unit === 'kml' ? '100' : '50';
    inp.min = unit === 'kml' ? '2' : '0.1';
    updateConsumptionHint();
  }

  // ------------------------------------------------------------ prefs
  const PREF_KEY = 'fuel-detour:prefs';
  const LEGACY_PREF_KEY = 'border-fuel:prefs';
  function loadPrefs() {
    try { return JSON.parse(localStorage.getItem(PREF_KEY) || localStorage.getItem(LEGACY_PREF_KEY)) || {}; } catch { return {}; }
  }
  function savePrefs() {
    const p = { fuel: $('fuel').value, consumption: consumptionL100(), consUnit, litres: $('litres').value, radius: $('radius').value, perkm: $('perkm').value, priority: $('priority').value, per10min: $('per10min').value, minsaving: $('minsaving').value };
    try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* private mode */ }
  }

  // ------------------------------------------------------------ init
  async function init() {
    applyStaticTexts();
    const cfg = await fetch('/api/config').then((r) => r.json());
    state.config = cfg;
    const prefs = loadPrefs();
    renderFuelOptions();
    $('fuel').value = prefs.fuel || 'e10';
    $('consumption').value = prefs.consumption || cfg.defaults.consumption;
    setConsumptionUnit(prefs.consUnit || 'l100');
    $('litres').value = prefs.litres || cfg.defaults.litres;
    $('radius').value = prefs.radius || cfg.defaults.radiusKm;
    $('perkm').value = prefs.perkm || '';
    setPriority(prefs.priority || 'cheapest', prefs);
    updateFuelHint();
    initMap();
  }

  function renderFuelOptions() {
    const sel = $('fuel');
    const cur = sel.value;
    sel.replaceChildren(...state.config.fuels.map((f) => el('option', { value: f.id, text: lang === 'nl' && f.labelNl ? f.labelNl : f.label })));
    if (cur) sel.value = cur;
  }

  function setLanguage(next) {
    if (next === lang || (next !== 'nl' && next !== 'en')) return;
    lang = next;
    try { localStorage.setItem(LANG_KEY, lang); } catch { /* private mode */ }
    applyStaticTexts();
    if (!state.config) return;
    renderFuelOptions();
    updateFuelHint();
    updateConsumptionHint();
    $('priority-hint').textContent = PRESETS()[$('priority').value].hint;
    for (const which of ['start', 'destination']) {
      if (!state[which]) setPoint(which, null, { quiet: true });
      else if (state[which].auto) setPoint(which, { ...state[which], label: state[which].auto() }, { quiet: true });
    }
    renderOverrides(state.lastData || {});
    // Server-written texts (recommendation, warnings, assumptions) come in the requested language: fetch again.
    if (state.lastData) runCompare({ auto: true, keepView: true });
  }

  // ------------------------------------------------------------ time vs savings preference
  const PRESETS = () => ({
    cheapest: { per10min: 0, minsaving: null, hint: t('Picks the station that saves the most money, even if it is a long drive. The detour fuel and running cost are always included.', 'Kiest het station dat het meeste geld bespaart, ook als dat ver rijden is. De brandstof en rijkosten voor de omweg tellen altijd mee.') },
    balanced: { per10min: 2, minsaving: 2, hint: t('A further station must save at least €2 for every 10 extra minutes of driving, and at least €2 in total.', 'Een verder station moet minstens €2 per 10 extra minuten rijden besparen, en in totaal minstens €2.') },
    hassle: { per10min: 5, minsaving: 5, hint: t('A further station must save at least €5 for every 10 extra minutes of driving, and at least €5 in total.', 'Een verder station moet minstens €5 per 10 extra minuten rijden besparen, en in totaal minstens €5.') },
    custom: { hint: t('Using your own detour rule from Advanced.', 'Je eigen omrijregel uit Geavanceerd wordt gebruikt.') },
  });
  function setPriority(name, prefs) {
    const presets = PRESETS();
    if (!presets[name]) name = 'cheapest';
    $('priority').value = name;
    const p = presets[name];
    if (name === 'custom') {
      if (prefs) { $('per10min').value = prefs.per10min ?? 0; $('minsaving').value = prefs.minsaving ?? state.config.minWorthwhileSaving; }
    } else {
      $('per10min').value = p.per10min;
      $('minsaving').value = p.minsaving ?? state.config.minWorthwhileSaving;
    }
    $('priority-hint').textContent = p.hint;
  }

  function updateFuelHint() {
    const f = state.config.fuels.find((x) => x.id === $('fuel').value);
    $('fuel-local').textContent = f ? `${t('At the pump', 'Aan de pomp')}: 🇳🇱 ${f.local.NL} · 🇧🇪 ${f.local.BE}${f.local.DE ? ` · 🇩🇪 ${f.local.DE}` : ''}` : '';
  }

  function initMap() {
    if (!window.L) {
      $('map').classList.add('no-map');
      return;
    }
    state.map = L.map('map', { scrollWheelZoom: true }).setView([51.3, 4.6], 8);
    // OSM's tile usage policy requires a Referer; the page itself is served with no-referrer,
    // so tiles opt in to sending just the origin (never paths or query strings).
    L.tileLayer(state.config.map.tileUrl, {
      maxZoom: 18,
      attribution: state.config.map.attribution,
      referrerPolicy: 'strict-origin-when-cross-origin',
    }).addTo(state.map);
    state.layer = L.layerGroup().addTo(state.map);
    state.pinLayer = L.layerGroup().addTo(state.map);
    state.map.on('click', (e) => openDropPopup(e.latlng));
  }

  // ------------------------------------------------------------ pin drop
  const pinIcon = (kind) => L.divIcon({
    className: `pin pin-${kind}`,
    html: `<span><b>${kind === 'start' ? 'A' : 'B'}</b></span>`,
    iconSize: [28, 36],
    iconAnchor: [14, 36],
    popupAnchor: [0, -32],
  });

  function droppedPoint(latlng) {
    const lat = Number(latlng.lat.toFixed(5));
    const lon = Number(L.Util.wrapNum(latlng.lng, [-180, 180], true).toFixed(5));
    const auto = () => t(`Dropped pin (${lat.toFixed(5)}, ${lon.toFixed(5)})`, `Geplaatste pin (${lat.toFixed(5)}, ${lon.toFixed(5)})`);
    return { lat, lon, label: auto(), auto };
  }

  function usePin(which, latlng) {
    const p = droppedPoint(latlng);
    $(which === 'start' ? 'start-q' : 'dest-q').value = `${p.lat}, ${p.lon}`;
    if (which === 'destination') $('dest-block').open = true;
    setPoint(which, p);
  }

  function openDropPopup(latlng) {
    const box = el('div', { class: 'drop-popup' });
    const mk = (which, text) => {
      const b = el('button', { type: 'button', text });
      b.addEventListener('click', () => { state.map.closePopup(); usePin(which, latlng); });
      return b;
    };
    box.append(mk('start', t('📍 Set as start', '📍 Als start instellen')), mk('destination', t('🏁 Set as destination', '🏁 Als bestemming instellen')));
    L.popup({ closeButton: true }).setLatLng(latlng).setContent(box).openOn(state.map);
  }

  function drawPins() {
    if (!state.pinLayer) return;
    state.pinLayer.clearLayers();
    for (const which of ['start', 'destination']) {
      const p = state[which];
      if (!p) continue;
      const m = L.marker([p.lat, p.lon], {
        icon: pinIcon(which),
        draggable: true,
        keyboard: true,
        title: which === 'start' ? t('Start (drag to move)', 'Start (sleep om te verplaatsen)') : t('Destination (drag to move)', 'Bestemming (sleep om te verplaatsen)'),
        zIndexOffset: 1000,
      });
      m.bindTooltip(`${which === 'start' ? 'Start' : t('Destination', 'Bestemming')}: ${p.label || ''}`);
      m.on('dragend', () => usePin(which, m.getLatLng()));
      m.addTo(state.pinLayer);
    }
  }

  // ------------------------------------------------------------ location
  function setPoint(which, p, { quiet = false } = {}) {
    state[which] = p;
    const chosen = $(which === 'start' ? 'start-chosen' : 'dest-chosen');
    if (p) {
      chosen.textContent = p.label || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      chosen.classList.add('ok');
    } else {
      chosen.textContent = which === 'start' ? t('No location chosen yet.', 'Nog geen locatie gekozen.')
        : t('No destination — a round trip from your start is assumed.', 'Geen bestemming — er wordt uitgegaan van heen en terug vanaf je start.');
      chosen.classList.remove('ok');
    }
    drawPins();
    if (quiet) return;
    if (p && state.map && !state.map.getBounds().contains([p.lat, p.lon])) state.map.panTo([p.lat, p.lon]);
    scheduleAutoCompare(300);
  }

  const geoSeq = {};
  async function geocode(inputId, listId, which, autoPick = false) {
    const q = $(inputId).value.trim();
    const list = $(listId);
    const seq = (geoSeq[inputId] = (geoSeq[inputId] || 0) + 1);
    if (q.length < 2) { list.replaceChildren(); list.hidden = true; return null; }
    const params = new URLSearchParams({ q });
    const near = state.start || (state.map && { lat: state.map.getCenter().lat, lon: state.map.getCenter().lng });
    if (near) { params.set('lat', near.lat); params.set('lon', near.lon); }
    const res = await fetch(`/api/geocode?${params}`);
    const json = await res.json();
    if (seq !== geoSeq[inputId] || $(inputId).value.trim() !== q) return null; // user kept typing
    list.replaceChildren();
    list.hidden = true;
    if (!res.ok) throw new Error(json.error || t('Address search failed', 'Adres zoeken mislukt'));
    if (!json.results.length) {
      if (autoPick) throw new Error(t(`No places found for “${q}” in the supported countries.`, `Geen plaatsen gevonden voor “${q}” in de ondersteunde landen.`));
      list.append(el('li', { class: 'muted', text: t('No matches yet. Keep typing or check the spelling.', 'Nog geen resultaten. Typ verder of controleer de spelling.') }));
      list.hidden = false;
      return null;
    }
    if (json.results.length === 1 || autoPick) {
      setPoint(which, json.results[0]);
      return json.results[0];
    }
    const counts = {};
    for (const r of json.results) counts[r.label] = (counts[r.label] || 0) + 1;
    for (const r of json.results) {
      const text = counts[r.label] > 1 ? `${r.label} (${r.lat.toFixed(3)}, ${r.lon.toFixed(3)})` : r.label;
      const b = el('button', { type: 'button', text });
      b.addEventListener('click', () => {
        setPoint(which, r);
        $(inputId).value = r.label;
        list.hidden = true;
      });
      list.append(el('li', null, b));
    }
    list.hidden = false;
    return null;
  }

  function debounceGeocode(inputId, listId, which) {
    let timer;
    $(inputId).addEventListener('input', () => {
      setPoint(which, null);
      clearTimeout(timer);
      timer = setTimeout(() => geocode(inputId, listId, which).catch(showError), 350);
    });
  }

  // onLoad = started on page load (mobile): only report a denied permission, never overwrite a location chosen meanwhile.
  function useGps(onLoad = false) {
    if (!navigator.geolocation) return onLoad ? undefined : showError(t('Your browser does not support location access.', 'Je browser ondersteunt geen locatiebepaling.'));
    const btn = $('gps');
    btn.disabled = true;
    btn.textContent = '📍 …';
    const done = () => { btn.disabled = false; btn.textContent = '📍 GPS'; };
    const ok = (pos) => {
      done();
      if (onLoad && (state.start || $('start-q').value.trim())) return;
      $('start-q').value = '';
      const acc = Math.round(pos.coords.accuracy);
      const label = () => t(`Your location (±${acc} m)`, `Jouw locatie (±${acc} m)`);
      setPoint('start', { lat: pos.coords.latitude, lon: pos.coords.longitude, label: label(), auto: label });
    };
    const fail = (err) => {
      done();
      if (onLoad && err.code !== 1) return;
      showError(err.code === 1 ? t('Location permission denied. Allow location for this site, or type an address.', 'Geen toestemming voor locatie. Sta locatie toe voor deze site, of typ een adres.')
        : t('Could not get your location. Type an address instead.', 'Kon je locatie niet bepalen. Typ in plaats daarvan een adres.'));
    };
    // Precise GPS first; if that times out or is unavailable, accept a coarser (network) position.
    navigator.geolocation.getCurrentPosition(ok, (err) => {
      if (err.code === 1) return fail(err);
      navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
    }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }

  function showError(err) {
    const e = $('form-error');
    e.textContent = err && err.message ? err.message : String(err);
    e.hidden = false;
  }

  // ------------------------------------------------------------ submit
  function submit(ev) {
    ev.preventDefault();
    return runCompare({ auto: false });
  }

  let compareSeq = 0;
  let autoTimer = null;
  // Re-run the comparison after a settings change, once results are on screen.
  function scheduleAutoCompare(delay = 600) {
    if (!state.lastData || !state.start) return;
    clearTimeout(autoTimer);
    autoTimer = setTimeout(() => {
      if (!$('form').checkValidity()) return; // half-typed / out-of-range value: wait for a valid one
      runCompare({ auto: true });
    }, delay);
  }

  async function runCompare({ auto, keepView = false }) {
    clearTimeout(autoTimer);
    $('form-error').hidden = true;
    if (!auto) {
      try {
        if (!state.start && $('start-q').value.trim()) await geocode('start-q', 'start-suggestions', 'start', true);
        if (!state.start) throw new Error(t('Choose your location first (GPS or type an address).', 'Kies eerst je locatie (GPS of typ een adres).'));
        if (!state.destination && $('dest-q').value.trim()) await geocode('dest-q', 'dest-suggestions', 'destination', true);
      } catch (err) {
        return showError(err);
      }
      clearTimeout(autoTimer);
    }
    savePrefs();
    const body = {
      start: state.start,
      destination: state.destination,
      fuel: $('fuel').value,
      consumption: consumptionL100(),
      litres: $('litres').value,
      radiusKm: $('radius').value,
      perKmCost: $('perkm').value,
      timeValuePerHour: $('per10min').value === '' ? '' : Number($('per10min').value) * 6,
      minSaving: $('minsaving').value,
      overrides: collectOverrides(),
      baseline: $('baseline-mode').value === 'custom' ? { mode: 'custom', price: $('baseline-price').value } : { mode: 'nearest' },
      lang,
    };
    const seq = ++compareSeq;
    $('submit').disabled = true;
    if (auto) {
      $('results').classList.add('updating');
      $('updating').hidden = false;
    } else {
      $('empty').hidden = true;
      $('results').hidden = true;
      $('loading').hidden = false;
    }
    try {
      const res = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      if (seq !== compareSeq) return; // a newer request superseded this one
      if (!res.ok) throw new Error(json.error || t('Comparison failed', 'Vergelijken mislukt'));
      const samePlaces = auto && state.lastData && sameTrip(state.lastData.input, json.input);
      state.lastData = json;
      render(json, { keepView: samePlaces || keepView });
    } catch (err) {
      if (seq !== compareSeq) return;
      showError(err);
      if (!auto) $('empty').hidden = false;
    } finally {
      if (seq === compareSeq) {
        $('submit').disabled = false;
        $('loading').hidden = true;
        $('updating').hidden = true;
        $('results').classList.remove('updating');
      }
    }
  }

  function sameTrip(a, b) {
    const eq = (p, q) => (!p && !q) || (p && q && p.lat === q.lat && p.lon === q.lon);
    return eq(a.start, b.start) && eq(a.destination, b.destination) && a.radiusKm === b.radiusKm;
  }

  // Manual per-country prices: one field per country seen in results (plus any already filled in).
  const overrideValues = {};
  function collectOverrides() {
    for (const inp of $('overrides').querySelectorAll('input[data-country]')) overrideValues[inp.dataset.country] = inp.value;
    const out = {};
    for (const [c, v] of Object.entries(overrideValues)) if (v !== '') out[c] = v;
    return out;
  }
  function flagEmoji(c) {
    return /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : '';
  }
  function renderOverrides(data) {
    collectOverrides();
    const seen = new Set([...(data.results || []).map((s) => s.country), ...(data.skippedCountries || []),
      ...Object.keys(overrideValues).filter((c) => overrideValues[c] !== '')]);
    const countries = [...seen].filter((c) => /^[A-Z]{2}$/.test(c)).sort();
    const box = $('overrides');
    const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.country : null;
    box.replaceChildren(...countries.map((c) => {
      const id = `ov-${c.toLowerCase()}`;
      const inp = el('input', { id, type: 'number', min: '0.3', max: '5', step: '0.001', placeholder: t('no manual price', 'geen handmatige prijs') });
      inp.dataset.country = c;
      inp.value = overrideValues[c] || '';
      return el('div', null, el('label', { for: id }, `${flagEmoji(c)} ${c} ${t('price', 'prijs')} `, el('span', { class: 'unit', text: '€/L' })), inp);
    }));
    $('overrides-empty').hidden = countries.length > 0;
    if (focused) { const f = $(`ov-${focused.toLowerCase()}`); if (f) f.focus(); }
  }

  // ------------------------------------------------------------ render
  function render(data, { keepView = false } = {}) {
    $('results').hidden = false;
    renderRecommendation(data);
    renderWarnings(data);
    renderSummary(data);
    renderList(data);
    renderAssumptions(data);
    renderSources(data);
    renderMap(data, keepView);
    renderOverrides(data);
  }

  function renderRecommendation(data) {
    const r = data.recommendation;
    const box = $('recommendation');
    box.className = `recommendation ${r.level}`;
    const best = data.results.find((s) => s.id === r.stationId);
    const conf = CONFIDENCE_LABEL()[r.confidence];
    box.replaceChildren(
      el('h2', { text: r.headline }),
      conf ? el('p', { class: `confidence ${r.confidence}`, text: conf }) : null,
      el('p', { text: r.detail }),
      ...(r.caveats || []).map((c) => el('p', { class: 'caveat', text: `⚠ ${c}` })),
      best ? el('div', { class: 'actions' }, navLinks(best, true)) : null,
    );
  }

  function renderWarnings(data) {
    const w = $('warnings');
    w.replaceChildren();
    for (const m of data.warnings) w.append(el('p', { class: 'warning', text: m }));
  }

  // One line of context: what savings are measured against and how extra km are counted.
  function renderSummary(data) {
    const s = $('summary');
    s.replaceChildren();
    if (!data.baseline) return;
    const route = data.input.mode === 'route';
    const modeBtn = el('button', { type: 'button', class: 'linkish', text: route ? t('change destination', 'bestemming wijzigen') : t('add a destination', 'voeg een bestemming toe') });
    modeBtn.addEventListener('click', () => { $('dest-block').open = true; $('dest-q').focus(); $('dest-block').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    const base = data.baseline.name ? t(`the nearest station, ${data.baseline.name}`, `het dichtstbijzijnde station, ${data.baseline.name}`) : data.baseline.label;
    s.append(
      t('Savings are compared with ', 'Besparingen zijn vergeleken met '), el('b', { text: base }),
      t(`, which would cost ${eur(data.baseline.total)} for ${data.input.litres} L. `, `, dat ${eur(data.baseline.total)} zou kosten voor ${data.input.litres} L. `),
      route ? t('Only the kilometres you add to your route count. ', 'Alleen de kilometers die je aan je route toevoegt tellen. ')
        : t('Detours count there and back from your start. ', 'Omwegen tellen heen en terug vanaf je start. '),
      route ? '' : t('Driving somewhere anyway? ', 'Rij je toch al ergens heen? '), modeBtn, '.');
  }

  // geo: links only work where the OS registers a maps handler (Android); iOS gets Apple Maps; desktop neither.
  const PLATFORM = /android/i.test(navigator.userAgent) ? 'android'
    : /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'ios' : 'desktop';

  function navLinks(s, main) {
    const n = s.navigation;
    const ext = (href, text, cls) => el('a', { href, target: '_blank', rel: 'noopener noreferrer', class: ['ext-nav', cls].filter(Boolean).join(' '), text });
    return el('div', { class: 'nav' },
      ext(n.google, t('Navigate (Google Maps)', 'Navigeer (Google Maps)'), main ? 'main' : null),
      ext(n.osm, t('Route to station (OSM)', 'Route naar station (OSM)')),
      PLATFORM === 'android' && n.geo ? el('a', { href: n.geo, text: t('Open in maps app', 'Open in kaarten-app') }) : null,
      PLATFORM === 'ios' && n.apple ? ext(n.apple, t('Open in Apple Maps', 'Open in Apple Kaarten')) : null);
  }

  function breakEvenText(b) {
    switch (b.kind) {
      case 'always': return t('cheaper for any amount', 'goedkoper bij elke hoeveelheid');
      case 'min': return t(`worth it from ${b.litres} L`, `de moeite waard vanaf ${b.litres} L`);
      case 'max': return t(`cheaper only below ${b.litres} L`, `alleen goedkoper onder ${b.litres} L`);
      default: return t('never cheaper', 'nooit goedkoper');
    }
  }

  function renderList(data) {
    const list = $('station-list');
    list.replaceChildren();
    const recId = data.recommendation && data.recommendation.stationId;
    data.results.forEach((s, i) => {
      const cls = ['station', s.id === recId ? 'best' : '', s.isBaseline ? 'baseline' : ''].join(' ');
      const timed = data.input.timeValuePerHour > 0;
      const cash = s.cashSaving ?? s.saving;
      const savingCls = s.saving > 0.005 ? 'pos' : s.saving < -0.005 ? 'neg' : '';
      const savingText = s.isBaseline ? t('baseline', 'vergelijkingspunt') : `${cash >= 0 ? '+' : '−'}${eur(Math.abs(cash))}`;
      const savingKey = s.isBaseline ? t('reference', 'referentie') : !timed || cash <= 0.005 ? t('net saving', 'nettobesparing')
        : s.saving >= 0 ? t(`${eur(s.saving)} after extra time`, `${eur(s.saving)} na extra tijd`) : t('not worth the extra time', 'extra tijd niet waard');
      const p = s.price;
      const estNote = p.kind === 'legal-maximum' ? t('The actual price is usually lower.', 'De echte prijs is meestal lager.')
        : p.kind === 'national-average' ? t('The actual price can differ by ±20 ct/L.', 'De echte prijs kan ±20 ct/L afwijken.') : '';
      list.append(el('li', { class: cls, id: `st-${i}` },
        el('div', { class: 'station-head' },
          el('div', null,
            el('div', { class: 'station-name' }, el('span', { class: `flag ${s.country}`, text: s.country }), s.name),
            el('div', { class: 'station-addr', text: [s.brand && s.brand !== s.name ? s.brand : null, s.address].filter(Boolean).join(' · ') || ' ' })),
          el('div', { class: 'saving' }, el('div', { class: `v ${savingCls}`, text: savingText }), el('div', { class: 'k', text: savingKey }))),
        el('div', { class: 'facts' },
          el('span', null, el('b', { text: eurL(p.price) }), ' ', el('span', { class: `tag ${p.kind}${p.estimate ? ' estimate' : ''} ${p.quality || ''}`, text: priceLabel(p) })),
          el('span', null, t('Detour ', 'Omweg '), el('b', { text: `${km(s.route.detourKm)} km` }), s.route.detourMin ? ` (~${s.route.detourMin} min)` : ''),
          el('span', null, t('Extra vs baseline ', 'Extra t.o.v. vergelijkingspunt '), el('b', { text: `${s.extraKm > 0 ? '+' : ''}${km(s.extraKm)} km` }), s.extraMin ? ` / ${s.extraMin > 0 ? '+' : ''}${s.extraMin} min` : '', timed && s.extraMin > 0 && !s.isBaseline ? t(` (must save ≥ ${eur(s.extraMin * data.input.timeValuePerHour / 60)})`, ` (moet ≥ ${eur(s.extraMin * data.input.timeValuePerHour / 60)} besparen)`) : ''),
          el('span', null, t('Total ', 'Totaal '), el('b', { text: eur(s.total) }), t(` (fuel ${eur(s.fuelCost)} + driving ${eur(s.detourCost)})`, ` (brandstof ${eur(s.fuelCost)} + rijden ${eur(s.detourCost)})`)),
          el('span', null, t('Break-even: ', 'Omslagpunt: '), el('b', { text: breakEvenText(s.breakEven) }))),
        el('div', { class: 'provenance', text: `${s.localFuelName}${p.product ? t(` (listed as "${p.product}")`, ` (vermeld als "${p.product}")`) : ''} · ${p.source} · ${priceFreshness(p)}${s.fuelAvailability === 'unknown' ? t(' · fuel availability not confirmed in OSM', ' · beschikbaarheid brandstof niet bevestigd in OSM') : ''}` }),
        p.estimate ? el('div', { class: 'provenance estimate-note', text: `${t("Not this pump's price", 'Niet de prijs van deze pomp')}${p.fallbackReason ? ` — ${p.fallbackReason}` : ''}. ${estNote}` }) : null,
        navLinks(s, false)));
    });
    if (!data.results.length) list.append(el('li', { class: 'muted', text: t('No stations with a known price.', 'Geen stations met een bekende prijs.') }));
  }

  function renderAssumptions(data) {
    $('assumptions').replaceChildren(...data.assumptions.map((a) => el('li', { text: a })));
  }

  function renderSources(data) {
    const box = $('sources');
    box.replaceChildren();
    const cb = data.sources.prices && data.sources.prices.carbu;
    const when = (iso) => new Date(iso).toLocaleString(locale());
    const budget = (x) => t(`Requests: ${x.requestsLastHour}/${x.hourlyBudget} last hour, ${x.requestsLast24h}/${x.dailyBudget} last 24 h. `,
      `Verzoeken: ${x.requestsLastHour}/${x.hourlyBudget} afgelopen uur, ${x.requestsLast24h}/${x.dailyBudget} afgelopen 24 u. `);
    const pausedUntil = (x) => (x.backoffUntil ? t(`Requests paused until ${when(x.backoffUntil)}. `, `Verzoeken gepauzeerd tot ${when(x.backoffUntil)}. `) : '');
    if (cb !== undefined && !(cb && cb.reason === 'not-acknowledged')) {
      const quoted = data.results.filter((r) => r.price.provider === 'carbu').length;
      const be = data.results.filter((r) => r.country === 'BE').length;
      let text;
      if (!cb || cb.ok === false) {
        const reason = cb && cb.reason;
        const code = (cb && cb.blocked && cb.blocked.httpStatus) || 403;
        const since = fmtAge(cb && cb.blocked && cb.blocked.at);
        text = reason === 'paused' ? t('CARBU.COM paused by the operator (CARBU_PAUSED); no requests are made. ', 'CARBU.COM gepauzeerd door de beheerder (CARBU_PAUSED); er worden geen verzoeken gedaan. ')
          : reason === 'blocked' ? t(`CARBU.COM blocked (${code}) since ${since}; all CARBU.COM requests are stopped. Do not work around this; contact CARBU.COM. `,
            `CARBU.COM geblokkeerd (${code}) sinds ${since}; alle CARBU.COM-verzoeken zijn gestopt. Omzeil dit niet; neem contact op met CARBU.COM. `)
          : t(`CARBU.COM unavailable${cb && cb.error ? ` (${cb.error})` : ''}. `, `CARBU.COM niet beschikbaar${cb && cb.error ? ` (${cb.error})` : ''}. `);
      } else {
        text = t(`CARBU.COM (Belgium): ${quoted} of ${be} Belgian stations quoted, with each station's price date. Lists are cached for ${cb.cacheTtlH} h. `,
          `CARBU.COM (België): ${quoted} van ${be} Belgische stations met prijs, elk met de prijsdatum van het station. Lijsten worden ${cb.cacheTtlH} u bewaard. `) +
          pausedUntil(cb) + budget(cb);
      }
      box.append(el('p', { class: 'source-row' }, el('b', { text: t('Belgian station prices: ', 'Belgische stationsprijzen: ') }), text,
        t('© CARBU.COM. Used with written permission for this private installation only; no redistribution. ',
          '© CARBU.COM. Gebruikt met schriftelijke toestemming, alleen voor deze privé-installatie; niet verspreiden. '),
        el('a', { href: 'https://carbu.com/belgie/', target: '_blank', rel: 'noopener', text: 'CARBU.COM' })));
    }
    const an = data.sources.prices && data.sources.prices.anwb;
    if (an !== undefined) {
      const quoted = data.results.filter((r) => r.price.provider === 'anwb').length;
      let text;
      if (!an || an.ok === false) {
        const reason = an && an.reason;
        const code = (an && an.blocked && an.blocked.httpStatus) || 403;
        const since = fmtAge(an && an.blocked && an.blocked.at);
        text = reason === 'not-acknowledged' ? t('ANWB Onderweg is off (ANWB_PRIVATE_USE_ACK not set); country estimates are used. ', 'ANWB Onderweg staat uit (ANWB_PRIVATE_USE_ACK niet ingesteld); landelijke schattingen worden gebruikt. ')
          : reason === 'paused' ? t('ANWB Onderweg paused by the operator (ANWB_PAUSED); no requests are made. ', 'ANWB Onderweg gepauzeerd door de beheerder (ANWB_PAUSED); er worden geen verzoeken gedaan. ')
          : reason === 'blocked' ? t(`ANWB blocked (${code}) since ${since}; all ANWB requests are stopped. Do not work around this; contact ANWB. `,
            `ANWB geblokkeerd (${code}) sinds ${since}; alle ANWB-verzoeken zijn gestopt. Omzeil dit niet; neem contact op met de ANWB. `)
          : t(`ANWB Onderweg unavailable${an && an.error ? ` (${an.error})` : ''}. `, `ANWB Onderweg niet beschikbaar${an && an.error ? ` (${an.error})` : ''}. `);
      } else {
        const origins = [...new Set(data.results.filter((r) => r.price.provider === 'anwb' && r.price.dataOrigin).map((r) => r.price.dataOrigin))];
        const orig = origins.length ? ` (${t('data', 'gegevens')}: ${origins.join(' / ')})` : '';
        text = t(`ANWB Onderweg${orig}: ${quoted} of ${data.results.length} stations quoted. Prices are retrieved and cached per area for ${an.cacheTtlH} h; ANWB does not report when a station set its price. `,
          `ANWB Onderweg${orig}: ${quoted} van ${data.results.length} stations met prijs. Prijzen worden per gebied opgehaald en ${an.cacheTtlH} u bewaard; de ANWB meldt niet wanneer een station zijn prijs heeft ingesteld. `) +
          pausedUntil(an) + budget(an);
      }
      box.append(el('p', { class: 'source-row' }, el('b', { text: t('Station prices: ', 'Stationsprijzen: ') }), text,
        t('© ANWB and/or its licensors. Private personal use on this installation only; no redistribution. ',
          '© ANWB en/of haar licentiegevers. Alleen privé persoonlijk gebruik op deze installatie; niet verspreiden. '),
        el('a', { href: 'https://www.anwb.nl/mobiel/onderweg-app', target: '_blank', rel: 'noopener', text: 'ANWB Onderweg' })));
    }
    const dl = data.sources.prices && data.sources.prices.directlease;
    if (dl !== undefined && !(dl && dl.reason === 'not-acknowledged')) {
      const quoted = data.results.filter((r) => r.price.provider === 'directlease').length;
      const code = (dl && dl.blocked && dl.blocked.httpStatus) || 403;
      box.append(el('p', { class: 'source-row' }, el('b', { text: t('Station prices: ', 'Stationsprijzen: ') }),
        !dl || dl.ok === false
          ? ((dl && (dl.reason === 'paused' || (dl.blocked && dl.blocked.paused))) ? t('DirectLease paused by the operator (DIRECTLEASE_PAUSED); no requests are made and country estimates are used. ', 'DirectLease gepauzeerd door de beheerder (DIRECTLEASE_PAUSED); er worden geen verzoeken gedaan en landelijke schattingen worden gebruikt. ')
            : dl && dl.blocked ? t(`DirectLease blocked (${code}) since ${fmtAge(dl.blocked.at)}; all DirectLease requests are stopped and country estimates are used. Do not work around this; contact App It Up. `,
              `DirectLease geblokkeerd (${code}) sinds ${fmtAge(dl.blocked.at)}; alle DirectLease-verzoeken zijn gestopt en landelijke schattingen worden gebruikt. Omzeil dit niet; neem contact op met App It Up. `)
              : t(`DirectLease unavailable${dl && dl.error ? ` (${dl.error})` : ''}. `, `DirectLease niet beschikbaar${dl && dl.error ? ` (${dl.error})` : ''}. `))
          : t(`DirectLease Tankservice (App It Up BV): ${quoted} of ${data.results.length} stations quoted; cached up to 24 h, requests today ${dl.requestsToday ?? '?'}/${dl.dailyBudget ?? '?'}. `,
            `DirectLease Tankservice (App It Up BV): ${quoted} van ${data.results.length} stations met prijs; tot 24 u bewaard, verzoeken vandaag ${dl.requestsToday ?? '?'}/${dl.dailyBudget ?? '?'}. `),
        t('Private use with permission only; no redistribution.', 'Alleen privégebruik met toestemming; niet verspreiden.')));
    }
    for (const c of ['NL', 'BE']) {
      const r = data.references[c];
      box.append(el('p', { class: 'source-row' },
        el('b', { text: t(`${c} fallback estimate: `, `${c} terugvalschatting: `) }),
        r ? `${eurL(r.price)} — ${refSourceText(r)} ` : t('not available. ', 'niet beschikbaar. '),
        r && r.sourceUrl ? el('a', { href: r.sourceUrl, target: '_blank', rel: 'noopener', text: t('Source', 'Bron') }) : null));
    }
    const st = data.sources.stations;
    box.append(el('p', { class: 'source-row' }, el('b', { text: 'Stations: ' }),
      st.provider === 'anwb' ? t(`ANWB Onderweg (${st.endpoint}); oldest area retrieved ${fmtAge(st.fetchedAt)}. Stations outside NL/BE only appear with a station quote or a manual price.`,
          `ANWB Onderweg (${st.endpoint}); oudste gebied opgehaald ${fmtAge(st.fetchedAt)}. Stations buiten NL/BE verschijnen alleen met een stationsprijs of een handmatige prijs.`)
          : t(`OpenStreetMap via Overpass (${st.endpoint}); station list ${fmtAge(st.fetchedAt)}. © OpenStreetMap contributors, ODbL.`,
            `OpenStreetMap via Overpass (${st.endpoint}); stationslijst ${fmtAge(st.fetchedAt)}. © OpenStreetMap-bijdragers, ODbL.`)));
    if (data.sources.routing) {
      box.append(el('p', { class: 'source-row' }, el('b', { text: t('Routing: ', 'Routes: ') }),
        data.sources.routing.mode === 'road' ? t(`road distances from ${data.sources.routing.provider.toUpperCase()}.`, `afstanden over de weg via ${data.sources.routing.provider.toUpperCase()}.`)
          : t('straight-line estimate (routing service unavailable).', 'hemelsbrede schatting (routeplanner niet beschikbaar).')));
    }
    box.append(el('p', { class: 'source-row muted', text: t(`Computed ${when(data.generatedAt)}.`, `Berekend ${when(data.generatedAt)}.`) }));
  }

  // Highlight one station in both the list and on the map.
  function selectStation(i, { scroll = false, pan = false } = {}) {
    const prev = state.selectedStation;
    if (prev != null) {
      const pli = $(`st-${prev}`);
      if (pli) { pli.classList.remove('selected'); pli.removeAttribute('aria-current'); }
      const pm = state.stationMarkers && state.stationMarkers[prev];
      if (pm) pm.setStyle(pm.baseStyle).setRadius(pm.baseStyle.radius);
    }
    state.selectedStation = i;
    const li = $(`st-${i}`);
    if (li) {
      li.classList.add('selected');
      li.setAttribute('aria-current', 'true');
      li.classList.remove('flash');
      void li.offsetWidth; // restart the flash animation
      li.classList.add('flash');
      if (scroll) li.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    const m = state.stationMarkers && state.stationMarkers[i];
    if (m) {
      m.setStyle({ color: '#1f5fd1', weight: 4 }).setRadius(m.baseStyle.radius + 5).bringToFront();
      if (pan) {
        // Keep the map's zoom; only pan if the station is not comfortably in view.
        const inner = state.map.getBounds().pad(-0.15);
        if (!inner.contains(m.getLatLng())) state.map.panTo(m.getLatLng());
        m.openPopup();
      }
    }
  }

  // Keep marker tooltips inside the map: flip below / beside the marker near the edges.
  function placeTooltip(marker, tooltip) {
    const node = tooltip.getElement();
    if (!node) return;
    const p = state.map.latLngToContainerPoint(marker.getLatLng());
    const size = state.map.getSize();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const gap = 16;
    let dir = 'top';
    if (p.y - h - gap < 0) dir = p.y + h + gap <= size.y ? 'bottom' : null;
    if (!dir || p.x - w / 2 < 4 || p.x + w / 2 > size.x - 4) {
      if (!dir || p.y - h / 2 >= 0) dir = p.x + w + gap <= size.x ? 'right' : 'left';
    }
    const offsets = { top: [0, -10], bottom: [0, 10], right: [10, 0], left: [-10, 0] };
    if (tooltip.options.direction === dir) return;
    tooltip.options.direction = dir;
    tooltip.options.offset = offsets[dir];
    tooltip.update();
  }

  function renderMap(data, keepView = false) {
    if (!state.map) return;
    state.layer.clearLayers();
    const pts = [];
    const start = data.input.start;
    pts.push([start.lat, start.lon]);
    if (data.input.destination) {
      const d = data.input.destination;
      pts.push([d.lat, d.lon]);
    }
    state.stationMarkers = [];
    const recId = data.recommendation && data.recommendation.stationId;
    data.results.forEach((s, i) => {
      const color = { NL: '#e1581f', BE: '#c49a00', DE: '#5a5a5a' }[s.country] || '#3f6fb5';
      const rec = s.id === recId;
      const base = { radius: rec ? 10 : 7, color: rec ? '#0f6b4f' : '#333', weight: rec ? 3 : 1, fillColor: color, fillOpacity: 0.9 };
      const m = L.circleMarker([s.lat, s.lon], base);
      m.baseStyle = base;
      const popup = el('div', null, el('b', { text: `${s.country} · ${s.name}` }), el('br'), `${eurL(s.price.price)} · ${t('saving', 'besparing')} ${eur(s.cashSaving ?? s.saving)}`);
      if (s.price.estimate) popup.append(el('br'), el('i', { text: t('estimated price', 'geschatte prijs') }));
      m.bindPopup(popup);
      const cs = s.cashSaving ?? s.saving;
      const delta = s.isBaseline ? { cls: 'base', text: t('nearest · reference', 'dichtstbij · referentie') }
        : cs > 0.005 ? { cls: 'pos', text: t(`saves ${eur(cs)}`, `bespaart ${eur(cs)}`) }
          : cs < -0.005 ? { cls: 'neg', text: t(`${eur(-cs)} more`, `${eur(-cs)} duurder`) } : { cls: 'base', text: t('same cost', 'even duur') };
      const tip = el('div', { class: 'st-tip' },
        el('div', { class: 'st-tip-head' }, el('span', { class: `flag ${s.country}`, text: s.country }), el('span', { class: 'st-tip-name', text: s.name })),
        s.address ? el('div', { class: 'st-tip-addr', text: s.address }) : null,
        el('div', { class: 'st-tip-row' },
          el('span', { class: 'st-tip-price', text: eurL(s.price.price) }),
          el('span', { class: `st-tip-delta ${delta.cls}`, text: delta.text })),
        s.price.estimate ? el('div', { class: 'st-tip-est', text: t('Estimated price, not this pump', 'Geschatte prijs, niet van deze pomp') }) : null,
        el('div', { class: 'st-tip-meta', text: `${km(s.route.detourKm)} km ${t('detour', 'omweg')}${s.route.detourMin ? ` · ~${s.route.detourMin} min` : ''}` }));
      m.bindTooltip(tip, { direction: 'top', offset: [0, -10], opacity: 1, className: 'st-tooltip' });
      m.on('tooltipopen', (e) => placeTooltip(m, e.tooltip));
      m.on('popupopen', () => m.closeTooltip());
      m.on('click', () => selectStation(i, { scroll: true }));
      m.addTo(state.layer);
      state.stationMarkers.push(m);
      pts.push([s.lat, s.lon]);
    });
    state.selectedStation = null;
    const recIdx = data.results.findIndex((s) => s.id === recId);
    if (recIdx >= 0) state.stationMarkers[recIdx].bringToFront();
    if (keepView) return;
    if (pts.length > 1) state.map.fitBounds(pts, { padding: [24, 24], maxZoom: 13 });
    else state.map.setView(pts[0], 12);
  }

  // ------------------------------------------------------------ wire up
  $('form').addEventListener('submit', submit);
  $('gps').addEventListener('click', () => useGps());
  $('fuel').addEventListener('change', updateFuelHint);
  for (const b of document.querySelectorAll('#cons-toggle button')) b.addEventListener('click', () => setConsumptionUnit(b.dataset.unit));
  $('consumption').addEventListener('input', updateConsumptionHint);
  // Open navigation links via window.open: some embedded/in-app browsers ignore target=_blank anchors.
  // With 'noopener' the return value is always null, so it cannot be used to detect blocking — never fall back
  // to navigating this tab (that caused a double open).
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a.ext-nav');
    if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    window.open(a.href, '_blank', 'noopener');
  });
  $('station-list').addEventListener('click', (e) => {
    if (e.target.closest('a, button, summary, details')) return;
    const li = e.target.closest('li.station');
    if (li && li.id.startsWith('st-')) selectStation(Number(li.id.slice(3)), { pan: true });
  });
  $('dest-clear').addEventListener('click', () => { $('dest-q').value = ''; setPoint('destination', null); $('dest-suggestions').hidden = true; });
  $('baseline-mode').addEventListener('change', () => { $('baseline-price-wrap').hidden = $('baseline-mode').value !== 'custom'; });
  $('priority').addEventListener('change', () => setPriority($('priority').value, { per10min: $('per10min').value, minsaving: $('minsaving').value }));
  for (const id of ['per10min', 'minsaving']) {
    $(id).addEventListener('input', () => { $('priority').value = 'custom'; $('priority-hint').textContent = PRESETS().custom.hint; });
  }
  for (const b of document.querySelectorAll('.lang-toggle button')) b.addEventListener('click', () => setLanguage(b.dataset.lang));
  debounceGeocode('start-q', 'start-suggestions', 'start');
  debounceGeocode('dest-q', 'dest-suggestions', 'destination');
  // Settings changes refresh the results automatically (address fields update via their suggestions / pins).
  const isAddress = (t) => t && (t.id === 'start-q' || t.id === 'dest-q');
  $('form').addEventListener('input', (e) => { if (!isAddress(e.target)) scheduleAutoCompare(e.target.tagName === 'SELECT' ? 0 : 700); });
  $('form').addEventListener('change', (e) => { if (!isAddress(e.target)) scheduleAutoCompare(e.target.tagName === 'SELECT' ? 0 : 300); });
  // On phones, use GPS by default (the browser still asks permission once; skipped if it was denied before).
  const isMobile = window.matchMedia('(pointer: coarse)').matches && window.matchMedia('(max-width: 900px)').matches;
  async function autoGps() {
    if (!isMobile || !navigator.geolocation || !window.isSecureContext || state.start) return;
    try {
      const perm = navigator.permissions && await navigator.permissions.query({ name: 'geolocation' });
      if (perm && perm.state === 'denied') return;
    } catch { /* Permissions API unsupported: just try */ }
    useGps(true);
  }
  init().then(autoGps).catch((err) => showError(t(`Could not load app configuration: ${err.message}`, `Kon de app-configuratie niet laden: ${err.message}`)));
})();
