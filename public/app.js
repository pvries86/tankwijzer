'use strict';

(function () {
  const $ = (id) => document.getElementById(id);
  const state = { start: null, destination: null, config: null, map: null, layer: null };
  const pointRevision = { start: 0, destination: 0 };

  // ------------------------------------------------------------ language (Dutch default, English optional)
  const LANG_KEY = 'tankwijzer:lang';
  let lang = (() => { try { return (localStorage.getItem(LANG_KEY) || localStorage.getItem('fuel-detour:lang')) === 'en' ? 'en' : 'nl'; } catch { return 'nl'; } })();
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
  /** Keyboard-focusable ⓘ with the explanation as tooltip and accessible name (always plain text). */
  function infoTip(text, attrs) {
    const s = String(text == null ? '' : text);
    return el('span', { class: 'info-tip', tabindex: '0', role: 'note', 'aria-label': s, title: s, text: 'ⓘ', ...attrs });
  }
  function setTip(node, text) {
    const s = String(text == null ? '' : text);
    node.title = s;
    node.setAttribute('aria-label', s);
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
  });
  const CONFIDENCE_LABEL = () => ({
    // High confidence is the normal case and is not shown.
    medium: { label: t('Medium confidence', 'Gemiddelde zekerheid'), reason: t('Compares a station quote with an estimate (or an older quote).', 'Vergelijkt een stationsprijs met een schatting (of een oudere prijs).') },
    low: { label: t('Low confidence', 'Lage zekerheid'), reason: t('Based on country estimates, not pump prices.', 'Gebaseerd op landelijke schattingen, niet op pompprijzen.') },
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
    return `${what} (${fmtAge(r.asOf)}).`;
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
  // One pill under Verbruik: "≈15,9 km/L · CO₂ +15%" (unit conversion + short origin); full text in the tooltip.
  function updateConsumptionHint() {
    const node = $('consumption-origin');
    const n = Number($('consumption').value);
    const conv = n > 0 ? `≈${num(convertConsumption(n), 1)} ${consUnit === 'kml' ? 'L/100 km' : 'km/L'}` : '';
    const kind = veh.origins.consumption;
    let extra = '';
    if (['wltp', 'nedc', 'co2'].includes(kind) && $('uplift').checked && Number($('uplift-pct').value)) extra = ` +${num($('uplift-pct').value, 0)}%`;
    const short = { wltp: 'WLTP', nedc: 'NEDC', co2: 'CO₂', manual: t('edited', 'aangepast'), example: t('example', 'voorbeeld') }[kind] || '';
    const text = [conv, short && short + extra].filter(Boolean).join(' · ');
    if (!text) { node.hidden = true; node.textContent = ''; return; }
    node.className = `origin origin-${!kind || kind === 'manual' ? 'manual' : 'auto'}`;
    node.textContent = text;
    node.title = [conv, kind && originText(kind) + extra].filter(Boolean).join(' · ');
    node.hidden = false;
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
  const PREF_KEY = 'tankwijzer:prefs';
  const LEGACY_PREF_KEYS = ['fuel-detour:prefs', 'border-fuel:prefs'];
  let vehicleForgotten = false;
  let vehicleStorageFailure = null;
  const memory = VehicleMemory.create(() => localStorage, (operation) => {
    if (vehicleStorageFailure !== 'forget' || operation === 'forget') vehicleStorageFailure = operation;
    renderStorageError();
  });
  function renderStorageError() {
    const box = $('vehicle-storage-error');
    box.hidden = !vehicleStorageFailure;
    box.textContent = vehicleStorageFailure === 'forget'
      ? t('Could not delete all saved car data in this browser. The car is cleared for now; clear this site browser data before reloading.',
        'Niet alle opgeslagen autogegevens konden worden gewist. De auto is nu gewist; verwijder de browsergegevens van deze site voordat je herlaadt.')
      : t('Car data could not be read or saved in this browser. You can keep using the app, but your edits may not survive a reload.',
        'Autogegevens konden niet worden gelezen of opgeslagen in deze browser. Je kunt de app gebruiken, maar aanpassingen blijven mogelijk niet bewaard na herladen.');
  }
  function loadPrefs() {
    const prefs = [PREF_KEY, ...LEGACY_PREF_KEYS].map((k) => memory.read(k)).find(Boolean) || {};
    vehicleForgotten = !!prefs.vehicleForgotten;
    if (!prefs.balancedDefaultApplied) {
      if (!prefs.priority || prefs.priority === 'cheapest') {
        prefs.priority = 'balanced';
        prefs.per10min = 2;
        prefs.minsaving = 2;
      }
      prefs.balancedDefaultApplied = true;
      memory.write(PREF_KEY, prefs);
    }
    return prefs;
  }
  function savePrefs() {
    const p = {
      fuel: $('fuel').value, consumption: consumptionL100(), consUnit, litres: $('litres').value, radius: $('radius').value, perkm: $('perkm').value, priority: $('priority').value, per10min: $('per10min').value, minsaving: $('minsaving').value,
      tank: $('tank').value, tankOrigin: veh.origins.tank, level: $('level').value, litresOrigin: veh.origins.litres, upliftEnabled: $('uplift').checked, upliftPct: $('uplift-pct').value,
      consumptionOrigin: veh.origins.consumption,
      balancedDefaultApplied: true,
    };
    memory.write(PREF_KEY, vehicleForgotten ? VehicleMemory.withoutVehicle(p) : p);
    saveRememberedCar();
  }

  // ------------------------------------------------------------ vehicle profile (optional RDW kenteken lookup)
  // Every prefilled value carries an origin; any user edit flips it to 'manual' and is never overwritten silently.
  const VC = window.VehicleCalc;
  const CAR_KEY = 'tankwijzer:vehicle';
  const veh = { vehicle: null, lab: null, origins: { fuel: null, consumption: null, tank: null, litres: null } };
  function hasRememberedCar() { return !vehicleForgotten && VehicleMemory.hasCar(veh.vehicle, veh.origins); }

  function originText(kind) {
    const v = veh.vehicle;
    switch (kind) {
      case 'rdw-fuel': return t('RDW', 'RDW');
      case 'wltp': return 'RDW WLTP';
      case 'nedc': return 'RDW NEDC';
      case 'co2': return t(`estimated from CO₂ (${v && v.consumption.co2} g/km)`, `geschat uit CO₂ (${v && v.consumption.co2} g/km)`);
      case 'weight': return t(`estimated from weight (${v && v.massaRijklaar} kg)`, `geschat uit gewicht (${v && v.massaRijklaar} kg)`);
      case 'range': return t(`estimated (±${v && v.tank.rangeKm} km × ${num(v && v.tank.consumption, 1)} L/100)`, `geschat (±${v && v.tank.rangeKm} km × ${num(v && v.tank.consumption, 1)} L/100)`);
      case 'tank': {
        const free = 100 - Number($('level').value), tank = num($('tank').value, 0);
        return t(`${free}% of ${tank} L tank`, `${free}% van ${tank} L tank`);
      }
      case 'manual': return t('adjusted by you', 'door jou aangepast');
      case 'example': return t('example value, adjust for your car', 'voorbeeldwaarde, pas aan voor jouw auto');
      default: return '';
    }
  }
  function setOriginBadge(id, kind, extra) {
    const node = $(id);
    if (!kind) { node.hidden = true; node.textContent = ''; return; }
    node.className = `origin origin-${kind === 'manual' ? 'manual' : 'auto'}`;
    node.textContent = originText(kind) + (extra || '');
    node.title = kind === 'range'
      ? t(`Tank size is not registered by RDW. Estimate: typical range for a car of ${veh.vehicle.massaRijklaar} kg${veh.vehicle.fuelId === 'diesel' ? ' (diesel ×1.2)' : ''} × lab consumption, rounded to a common tank size. Adjust if you know better.`,
        `Tankinhoud staat niet bij de RDW. Schatting: gangbare actieradius voor een auto van ${veh.vehicle.massaRijklaar} kg${veh.vehicle.fuelId === 'diesel' ? ' (diesel ×1,2)' : ''} × labverbruik, afgerond op een gangbare tankmaat. Pas aan als je het beter weet.`)
      : node.textContent;
    node.hidden = false;
  }
  function renderOrigins() {
    const o = veh.origins;
    setOriginBadge('fuel-origin', o.fuel);
    updateConsumptionHint();
    setOriginBadge('tank-origin', o.tank);
    setOriginBadge('litres-origin', o.litres);
    $('level-out').textContent = `${$('level').value}%`;
    if ($('tank').value) $('level-hint').hidden = true;
    renderUpliftHint();
    renderRangeInfo();
    renderVehicleSummary();
  }
  function renderRangeInfo() {
    const node = $('vehicle-range');
    if (!node) return;
    const km = VC.rangeKm($('tank').value, consumptionL100());
    node.hidden = !km;
    node.textContent = km ? t(`Estimated range ±${num(km, 0)} km (tank ÷ consumption).`, `Geschatte actieradius ±${num(km, 0)} km (tank ÷ verbruik).`) : '';
  }

  // ------------------------------------------------------------ collapsed vehicle summary
  let vehExpanded = false;
  let lookupFailed = false;
  let vehicleLookupRevision = 0;
  let dismissedReason = null;
  function vehicleAttentionReason() {
    const inp = $('consumption');
    if (!veh.vehicle && !lookupFailed && !inp.value && !$('litres').value) return null;
    return VC.vehicleAttention({
      warnings: veh.vehicle ? veh.vehicle.warnings : [],
      lookupFailed,
      consumption: inp.value, consMin: Number(inp.min), consMax: Number(inp.max),
      litres: $('litres').value,
    });
  }
  function reasonText(code) {
    return {
      electric: t('Fully electric car: Tankwijzer compares liquid fuel only. Choose a fuel and consumption yourself.', 'Volledig elektrische auto: Tankwijzer vergelijkt alleen vloeibare brandstof. Kies zelf een brandstof en verbruik.'),
      'unsupported-fuel': t('This fuel is not supported. Choose a fuel and consumption yourself.', 'Deze brandstof wordt niet ondersteund. Kies zelf een brandstof en verbruik.'),
      phev: t('Plug-in hybrid: check the consumption. The lab figure is far too low for driving on fuel only.', 'Plug-in hybride: controleer het verbruik. De labwaarde is veel te laag als je alleen op brandstof rijdt.'),
      'lookup-failed': t('The licence plate lookup did not work. Fill in your car yourself.', 'Kenteken opzoeken lukte niet. Vul je auto zelf in.'),
      consumption: t('Fill in a valid consumption.', 'Vul een geldig verbruik in.'),
      litres: t('Fill in how many litres you want to buy (1–200).', 'Vul in hoeveel liter je wilt tanken (1–200).'),
    }[code] || '';
  }
  function renderVehicleSummary() {
    const v = veh.vehicle;
    const title = v ? [[v.merk, v.handelsbenaming].filter(Boolean).join(' ') || v.kenteken, v.inrichting].filter(Boolean).join(' · ') : '';
    const cons = Number(String($('consumption').value).replace(',', '.'));
    const tank = Number($('tank').value);
    const litres = Number($('litres').value);
    const parts = [
      fuelLabel($('fuel').value),
      cons > 0 ? `${num(cons, 1)} ${consUnit === 'kml' ? 'km/L' : 'L/100 km'}` : null,
      tank > 0 ? t(`${num(tank, 0)} L tank`, `${num(tank, 0)} L tank`) : null,
      litres > 0 ? t(`~${num(litres, 0)} L to buy`, `~${num(litres, 0)} L tanken`) : null,
    ].filter(Boolean);
    const example = Object.values(veh.origins).includes('example');
    $('vehicle-summary-title').replaceChildren(
      title || (example ? t('Example car', 'Voorbeeldauto') : t('Your car', 'Je auto')),
      ...(example ? [' ', infoTip(t('Example values. Adjust them for your car or look up your licence plate.',
        'Voorbeeldwaarden. Pas ze aan voor jouw auto of zoek je kenteken op.'))] : []));
    $('vehicle-summary-line').textContent = parts.join(' · ');
    $('vehicle-badges').replaceChildren(...vehicleBadges(v));
    $('vehicle-memory-actions').hidden = !(hasRememberedCar() || $('kenteken').value.trim());
    const reason = vehicleAttentionReason();
    const hard = reason === 'consumption' || reason === 'litres';
    if (!reason) dismissedReason = null;
    if (reason && reason !== dismissedReason && !vehExpanded && (v || lookupFailed)) setVehicleExpanded(true, { persist: false });
    const box = $('vehicle-reason');
    box.textContent = reason ? reasonText(reason) : '';
    box.hidden = !reason || (!hard && reason === dismissedReason);
    setToggleText();
  }
  function setToggleText() {
    $('vehicle-toggle').textContent = vehExpanded ? t('Done', 'Klaar') : (veh.vehicle ? t('Edit', 'Aanpassen') : t('Fill in manually', 'Handmatig invullen'));
  }
  function setVehicleExpanded(open, { persist = true, focus = false } = {}) {
    vehExpanded = !!open;
    Disclosures.transition($('vehicle-details'), vehExpanded);
    $('vehicle-summary').classList.toggle('open', vehExpanded);
    $('vehicle-toggle').setAttribute('aria-expanded', String(vehExpanded));
    setToggleText();
    if (focus && vehExpanded) $('fuel').focus();
    if (persist) saveRememberedCar();
  }
  function toggleVehicleDetails() {
    if (vehExpanded) {
      const reason = vehicleAttentionReason();
      dismissedReason = reason; // a warning the user has seen; don't pop open again for it
      $('vehicle-reason').hidden = true;
      setVehicleExpanded(false);
      $('vehicle-toggle').focus();
    } else setVehicleExpanded(true, { focus: true });
  }

  function upliftPct() { return Number(String($('uplift-pct').value).replace(',', '.')) || 0; }
  function renderUpliftHint() {
    const wrap = $('uplift-wrap');
    wrap.hidden = veh.lab == null;
    if (veh.lab == null) return;
    const src = { wltp: 'RDW WLTP', nedc: 'RDW NEDC', co2: t('CO₂ estimate', 'CO₂-schatting') }[veh.vehicle.consumption.source];
    const res = VC.resolveConsumption({ lab: veh.lab, upliftPct: upliftPct(), upliftEnabled: $('uplift').checked });
    const base = `${src} ${num(veh.lab, 1)} L/100 km`;
    let txt = res.uplifted
      ? t(`${base} → realistic ${num(res.value, 1)} (+${num(upliftPct(), 0)}%)`, `${base} → realistisch ${num(res.value, 1)} (+${num(upliftPct(), 0)}%)`)
      : t(`${base} (lab value)`, `${base} (labwaarde)`);
    if (veh.origins.consumption === 'manual') txt += ' · ' + t('own value used', 'eigen waarde gebruikt');
    const hint = $('uplift-hint');
    hint.textContent = txt;
    hint.title = txt;
  }

  function setConsumptionL100(v) {
    $('consumption').value = consUnit === 'kml' ? convertConsumption(v) : v;
    updateConsumptionHint();
  }
  function applyLabConsumption() {
    if (veh.lab == null) return;
    const res = VC.resolveConsumption({ lab: veh.lab, upliftPct: upliftPct(), upliftEnabled: $('uplift').checked });
    setConsumptionL100(res.value);
    veh.origins.consumption = veh.vehicle.consumption.source;
  }
  function deriveLitres() {
    const res = VC.resolveLitres({ tankL: $('tank').value, levelPct: $('level').value });
    if (res.value == null || !$('tank').validity.valid) {
      if (veh.origins.litres === 'tank') $('litres').value = '';
      return false;
    }
    $('litres').value = Math.max(1, res.value);
    veh.origins.litres = veh.origins.tank === 'example' ? 'example' : 'tank';
    return true;
  }

  function fuelLabel(id) {
    const f = state.config.fuels.find((x) => x.id === id);
    return f ? (lang === 'nl' && f.labelNl ? f.labelNl : f.label) : id;
  }
  function apkInfo(v) {
    const x = v && v.extras;
    return x && x.apkExpiry ? VC.apkStatus(x.apkExpiry, VC.todayAmsterdam()) : null;
  }
  function relDays(d) {
    if (d === 0) return t('today', 'vandaag');
    if (d < 0) return t(`${-d} day${d === -1 ? '' : 's'} ago`, `${-d} dag${d === -1 ? '' : 'en'} geleden`);
    return t(`in ${d} day${d === 1 ? '' : 's'}`, `over ${d} dag${d === 1 ? '' : 'en'}`);
  }
  function fmtDate(iso) {
    return new Date(`${iso}T12:00:00`).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
  }
  /** Compact badges for the collapsed summary: only things that need attention. */
  function vehicleBadges(v) {
    const out = [];
    const apk = apkInfo(v);
    if (apk && apk.level === 'expired') out.push(el('span', { class: 'veh-badge bad', text: t('MOT expired', 'APK verlopen') }));
    else if (apk && apk.level === 'soon') out.push(el('span', { class: 'veh-badge warn', text: t(`MOT ${relDays(apk.days)}`, `APK ${relDays(apk.days)}`) }));
    else if (apk && apk.level === 'upcoming') out.push(el('span', { class: 'veh-badge info', text: t(`MOT ${relDays(apk.days)}`, `APK ${relDays(apk.days)}`) }));
    const open = v && v.extras && v.extras.recalls ? v.extras.recalls.open.length : 0;
    if (open) out.push(el('span', { class: 'veh-badge bad', text: t(`${open} open recall${open === 1 ? '' : 's'}`, `${open} open terugroepactie${open === 1 ? '' : 's'}`) }));
    return out;
  }
  function vehicleExtrasNodes(v) {
    const x = v.extras;
    if (!x) return [];
    const nodes = [];
    const apk = apkInfo(v);
    if (apk && apk.level !== 'unknown') {
      const cls = { expired: 'warning', soon: 'warning', upcoming: 'hint' }[apk.level];
      const txt = apk.level === 'expired'
        ? t(`MOT (APK) expired on ${fmtDate(apk.date)} (${relDays(apk.days)}).`, `APK verlopen op ${fmtDate(apk.date)} (${relDays(apk.days)}).`)
        : t(`MOT (APK) valid until ${fmtDate(apk.date)} (${relDays(apk.days)}).`, `APK geldig tot ${fmtDate(apk.date)} (${relDays(apk.days)}).`);
      if (cls) nodes.push(el('p', { class: `${cls} small apk-${apk.level}`, text: txt }));
    }
    const r = x.recalls;
    if (r && r.open.length) {
      nodes.push(el('div', { class: 'recall-box' },
        el('strong', { text: t(`${r.open.length} open recall${r.open.length === 1 ? '' : 's'}`, `${r.open.length} openstaande terugroepactie${r.open.length === 1 ? '' : 's'}`) }),
        r.open.map((o) => el('details', { class: 'recall' },
          el('summary', null, `${o.code}${o.defect ? `: ${o.defect.length > 70 ? o.defect.slice(0, 70) + '…' : o.defect}` : ''}`),
          o.defect ? el('p', { class: 'small' }, el('b', { text: t('Defect: ', 'Defect: ') }), o.defect) : null,
          o.risks.length ? el('p', { class: 'small' }, el('b', { text: t('Possible danger: ', 'Mogelijk gevaar: ') }), o.risks.join('; ')) : null,
          o.remedy ? el('p', { class: 'small' }, el('b', { text: t('Repair: ', 'Herstel: ') }), o.remedy) : null,
          o.published ? el('p', { class: 'small muted', text: t(`Published by RDW ${fmtDate(o.published)}`, `Gepubliceerd door RDW ${fmtDate(o.published)}`) }) : null,
          o.infoUrl ? el('p', { class: 'small' }, el('a', { href: o.infoUrl, target: '_blank', rel: 'noopener noreferrer', text: t('More information', 'Meer informatie') })) : null)),
        el('p', { class: 'small muted' }, t('Contact your dealer', 'Neem contact op met je dealer'), ' ', infoTip(t('The repair is usually free.', 'Herstel is meestal gratis.')))));
    }
    if (r && r.resolvedCount) {
      nodes.push(el('details', { class: 'recall small' },
        el('summary', null, t(`${r.resolvedCount} recall${r.resolvedCount === 1 ? '' : 's'} repaired (reported by manufacturer)`, `${r.resolvedCount} terugroepactie${r.resolvedCount === 1 ? '' : 's'} hersteld (gemeld door producent)`)),
        el('p', { class: 'small muted', text: r.resolvedCodes.join(', ') })));
    }
    if (x.missing && x.missing.length) {
      nodes.push(el('p', { class: 'hint small', text: t('Some extra RDW data (recalls, body or drive) could not be loaded right now.', 'Sommige extra RDW-gegevens (terugroepacties, carrosserie of aandrijving) konden nu niet worden opgehaald.') }));
    }
    return nodes;
  }
  function renderVehicleCard() {
    const card = $('vehicle-card');
    const v = veh.vehicle;
    if (!v) { card.hidden = true; card.replaceChildren(); return; }
    const title = [v.merk, v.handelsbenaming].filter(Boolean).join(' ') || v.kenteken;
    const x = v.extras || {};
    const rows = [
      [t('Body', 'Inrichting'), v.inrichting],
      [t('First registered', 'Eerste toelating'), v.firstAdmission ? new Date(v.firstAdmission).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' }) : null],
      [t('Fuel (RDW)', 'Brandstof (RDW)'), v.fuels.join(' + ') || null],
      [t('Hybrid class', 'Hybride klasse'), v.hybridClass],
      [t('Power', 'Vermogen'), v.powerKw ? `${num(v.powerKw, 0)} kW / ${num(v.powerPk, 0)} pk` : null],
      [t('Kerb weight', 'Massa rijklaar'), v.massaRijklaar ? `${num(v.massaRijklaar, 0)} kg` : null],
      [t('Body type', 'Carrosserie'), x.body ? [x.body.description || x.body.code, x.doors ? t(`${x.doors} doors`, `${x.doors} deuren`) : null].filter(Boolean).join(', ') : (x.doors ? t(`${x.doors} doors`, `${x.doors} deuren`) : null)],
      [t('Drive', 'Aandrijving'), { awd: t('4x4 / AWD', '4x4 / vierwielaandrijving'), fwd: t('Front-wheel drive', 'Voorwielaandrijving'), rwd: t('Rear-wheel drive', 'Achterwielaandrijving') }[x.drive] || null],
      [t('Colour', 'Kleur'), x.color ? x.color.charAt(0) + x.color.slice(1).toLowerCase() : null],
      [t('Emission class', 'Emissieklasse'), x.emissionClass],
    ].filter((r) => r[1]);
    const warn = {
      electric: t('This is a fully electric car. Tankwijzer compares liquid fuel only, so nothing was filled in.', 'Dit is een volledig elektrische auto. Tankwijzer vergelijkt alleen vloeibare brandstof, dus er is niets ingevuld.'),
      'unsupported-fuel': t(`Fuel "${v.fuels.join(', ')}" is not supported (only petrol, diesel and LPG). Nothing was filled in.`, `Brandstof "${v.fuels.join(', ')}" wordt niet ondersteund (alleen benzine, diesel en LPG). Er is niets ingevuld.`),
      'bifuel-lpg': t('Petrol + LPG car: LPG was selected. Switch to petrol above if you fill up with petrol.', 'Benzine + LPG-auto: LPG is gekozen. Kies hierboven benzine als je benzine tankt.'),
      phev: t('Plug-in hybrid: the lab consumption assumes a charged battery and is far too low for driving on fuel only. Enter your real fuel consumption.', 'Plug-in hybride: het labverbruik gaat uit van een opgeladen accu en is veel te laag als je alleen op brandstof rijdt. Vul je echte brandstofverbruik in.'),
    };
    const fetched = v.fetchedAt ? fmtAge(v.fetchedAt) : '';
    card.replaceChildren(
      el('div', { class: 'vehicle-head' },
        el('div', null,
          el('strong', { text: title }),
          v.year ? el('span', { class: 'muted', text: ` · ${v.year}` }) : null),
        el('span', { class: 'plate', text: v.kenteken })),
      el('dl', { class: 'vehicle-specs' }, rows.flatMap(([k, val]) => [el('dt', { text: k }), el('dd', { text: val })])),
      el('p', { class: 'hint small', id: 'vehicle-range', hidden: true }),
      ...v.warnings.map((w) => el('p', { class: 'warning small', text: warn[w] })),
      ...vehicleExtrasNodes(v),
      el('p', { class: 'hint small source-line' },
        t('Source: RDW (CC0)', 'Bron: RDW (CC0)'), ' ',
        infoTip(t(`RDW Open Data (CC0), ${fetched}. Tank size is not registered by RDW and is estimated. Every value below stays editable.`,
          `RDW Open Data (CC0), ${fetched}. Tankinhoud staat niet bij de RDW en is geschat. Alle waarden hieronder blijven aan te passen.`))),
    );
    card.hidden = false;
    renderRangeInfo();
  }

  /** Fill fuel / consumption / tank / litres from an RDW vehicle. Only called right after a lookup or restore. */
  function prefillFromVehicle(v) {
    vehicleForgotten = false;
    for (const id of ['consumption', 'tank', 'litres']) {
      if (veh.origins[id] === 'example') { $(id).value = ''; veh.origins[id] = null; }
    }
    veh.vehicle = v;
    veh.lab = null;
    veh.origins = { ...veh.origins, fuel: null, consumption: null, tank: null };
    if (v.fuelSupport === 'ok') {
      // Petrol defaults to E10, but keep an explicit E5/98 choice.
      const keep = v.fuelId === 'e10' && $('fuel').value === 'e5_98';
      if (!keep) $('fuel').value = v.fuelId;
      veh.origins.fuel = 'rdw-fuel';
      if (v.consumption && v.consumption.value) { veh.lab = v.consumption.value; applyLabConsumption(); }
      if (v.tank && v.tank.value) {
        $('tank').value = v.tank.value;
        veh.origins.tank = v.tank.source;
        if (veh.origins.litres !== 'manual') deriveLitres();
      }
    }
    renderVehicleCard();
    renderOrigins();
  }

  function clearVehicle() {
    vehicleLookupRevision++;
    updater.invalidate();
    const prefs = loadPrefs();
    vehicleForgotten = true;
    veh.vehicle = null;
    veh.lab = null;
    veh.origins = { fuel: null, consumption: null, tank: null, litres: null };
    for (const id of ['consumption', 'tank', 'litres']) $(id).value = '';
    setConsumptionUnit('l100', false);
    $('level').value = 25;
    $('uplift').checked = true;
    $('uplift-pct').value = state.config.vehicle?.realismUpliftPct ?? 15;
    $('kenteken-error').hidden = true;
    $('kenteken-lookup').disabled = false;
    $('kenteken-lookup').textContent = t('Look up', 'Opzoeken');
    $('kenteken').value = '';
    lookupFailed = false;
    dismissedReason = null;
    renderVehicleCard();
    renderOrigins();
    setVehicleExpanded(false, { persist: false });
    vehicleStorageFailure = null;
    memory.forget(prefs);
    renderStorageError();
    $('vehicle-toggle').focus();
    updater.schedule(0);
  }

  function saveRememberedCar() {
    if (hasRememberedCar()) memory.write(CAR_KEY, { vehicle: veh.vehicle, origins: veh.origins, expanded: vehExpanded });
  }
  function restoreRememberedCar() {
    if (vehicleForgotten) return;
    const saved = memory.read(CAR_KEY);
    if (!saved) return;
    if (!saved.vehicle) { vehExpanded = !!saved.expanded; return; }
    veh.vehicle = saved.vehicle;
    veh.lab = saved.vehicle.fuelSupport === 'ok' && saved.vehicle.consumption ? saved.vehicle.consumption.value || null : null;
    veh.origins = { ...veh.origins, ...saved.origins };
    $('kenteken').value = VC.formatKenteken(saved.vehicle.kenteken || '');
    vehExpanded = !!saved.expanded;
    renderVehicleCard();
  }

  async function lookupKenteken() {
    const errBox = $('kenteken-error');
    errBox.hidden = true;
    const k = VC.normalizeKenteken($('kenteken').value);
    if (!VC.isValidKenteken(k)) {
      errBox.textContent = t('That is not a valid Dutch licence plate (6 letters/digits, e.g. AB-123-C). Belgian plates are not supported.', 'Dat is geen geldig Nederlands kenteken (6 letters/cijfers, bijv. AB-123-C). Belgische kentekens worden niet ondersteund.');
      errBox.hidden = false;
      return;
    }
    const btn = $('kenteken-lookup');
    const revision = ++vehicleLookupRevision;
    btn.disabled = true;
    btn.textContent = t('Looking up…', 'Zoeken…');
    try {
      const res = await fetch(`/api/kenteken?k=${encodeURIComponent(k)}`);
      const body = await res.json().catch(() => ({}));
      if (revision !== vehicleLookupRevision) return;
      if (!res.ok) {
        const msg = {
          invalid: t('That is not a valid Dutch licence plate.', 'Dat is geen geldig Nederlands kenteken.'),
          'not-found': t('This licence plate is not in the RDW register. Check it, or fill in your car yourself.', 'Dit kenteken staat niet in het RDW-register. Controleer het, of vul je auto zelf in.'),
          'rate-limited': t('Too many lookups right now. Wait a minute, or fill in your car yourself.', 'Te veel zoekopdrachten op dit moment. Wacht een minuut, of vul je auto zelf in.'),
          unavailable: t('RDW is not reachable right now. Fill in your car yourself below; everything else works as usual.', 'De RDW is nu niet bereikbaar. Vul je auto hieronder zelf in; de rest werkt gewoon.'),
          disabled: t('Licence plate lookup is switched off on this server.', 'Kentekens opzoeken staat uit op deze server.'),
        }[body.code] || t(`Lookup failed (${res.status}). Fill in your car yourself.`, `Opzoeken mislukt (${res.status}). Vul je auto zelf in.`);
        errBox.textContent = msg;
        errBox.hidden = false;
        if (body.code !== 'invalid') { lookupFailed = true; dismissedReason = null; renderVehicleSummary(); }
        return;
      }
      $('kenteken').value = VC.formatKenteken(body.vehicle.kenteken);
      lookupFailed = false;
      dismissedReason = null;
      prefillFromVehicle(body.vehicle);
      if (!vehicleAttentionReason()) setVehicleExpanded(false);
      savePrefs();
      scheduleAutoCompare(0);
    } catch (err) {
      if (revision !== vehicleLookupRevision) return;
      errBox.textContent = t(`RDW lookup failed: ${err.message}. Fill in your car yourself.`, `Opzoeken bij de RDW mislukt: ${err.message}. Vul je auto zelf in.`);
      errBox.hidden = false;
      lookupFailed = true;
      dismissedReason = null;
      renderVehicleSummary();
    } finally {
      if (revision === vehicleLookupRevision) {
        btn.disabled = false;
        btn.textContent = t('Look up', 'Opzoeken');
      }
    }
  }

  function wireVehicle() {
    $('kenteken-lookup').addEventListener('click', lookupKenteken);
    $('kenteken').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lookupKenteken(); } });
    $('kenteken').addEventListener('input', (e) => {
      vehicleLookupRevision++;
      $('kenteken-lookup').disabled = false;
      $('kenteken-lookup').textContent = t('Look up', 'Opzoeken');
      $('kenteken-error').hidden = true;
      const el = e.target;
      const pos = el.selectionStart;
      const atEnd = pos === el.value.length;
      const raw = el.value.toUpperCase();
      const formatted = VC.isValidKenteken(VC.normalizeKenteken(raw)) ? VC.formatKenteken(raw) : raw;
      if (formatted !== el.value) {
        el.value = formatted;
        const p = atEnd ? formatted.length : Math.min(pos, formatted.length);
        el.setSelectionRange(p, p);
      }
      renderVehicleSummary();
    });
    $('fuel').addEventListener('change', () => { if (veh.origins.fuel) veh.origins.fuel = 'manual'; renderOrigins(); });
    $('consumption').addEventListener('input', () => { veh.origins.consumption = $('consumption').value ? 'manual' : null; renderOrigins(); });
    for (const id of ['uplift', 'uplift-pct']) {
      $(id).addEventListener(id === 'uplift' ? 'change' : 'input', () => { applyLabConsumption(); renderOrigins(); });
    }
    $('tank').addEventListener('input', () => {
      veh.origins.tank = $('tank').value ? 'manual' : null;
      if (veh.origins.litres !== 'manual') deriveLitres();
      renderOrigins();
    });
    // Moving the level slider is an explicit request to derive litres from the tank again.
    $('level').addEventListener('input', () => {
      $('level-hint').hidden = !!deriveLitres();
      renderOrigins();
    });
    $('litres').addEventListener('input', () => { veh.origins.litres = 'manual'; renderOrigins(); });
    $('vehicle-forget').addEventListener('click', clearVehicle);
    $('vehicle-toggle').addEventListener('click', toggleVehicleDetails);
  }

  // ------------------------------------------------------------ init
  async function init() {
    applyStaticTexts();
    Disclosures.init(document);
    ScrollControls.backToTop($('back-to-top'), [...document.querySelectorAll('.form-panel, .results-panel')], document.querySelector('.footer'), window, document);
    const cfg = await fetch('/api/config').then((r) => r.json());
    state.config = cfg;
    const prefs = loadPrefs();
    renderFuelOptions();
    $('fuel').value = prefs.fuel || 'e10';
    $('consumption').value = prefs.consumptionOrigin ? prefs.consumption : '';
    veh.origins.consumption = prefs.consumptionOrigin || null;
    setConsumptionUnit(prefs.consUnit || 'l100');
    $('litres').value = prefs.litresOrigin ? prefs.litres : '';
    veh.origins.litres = prefs.litresOrigin || null;
    $('radius').value = prefs.radius || cfg.defaults.radiusKm;
    $('perkm').value = prefs.perkm || '';
    setPriority(prefs.priority || 'balanced', prefs);
    const vcfg = cfg.vehicle || {};
    $('kenteken-wrap').hidden = !vcfg.kentekenLookup;
    $('uplift-pct').value = prefs.upliftPct ?? (vcfg.realismUpliftPct ?? 15);
    $('uplift').checked = prefs.upliftEnabled ?? true;
    if (prefs.tank) $('tank').value = prefs.tank;
    veh.origins.tank = prefs.tankOrigin === 'example' ? 'example' : null;
    if (prefs.level != null && prefs.level !== '') $('level').value = prefs.level;
    if (prefs.litresOrigin === 'tank' && prefs.tank) veh.origins.litres = 'tank';
    restoreRememberedCar();
    if (veh.vehicle) {
      if (!prefs.consumptionOrigin && veh.origins.consumption) {
        if (veh.origins.consumption === 'manual') setConsumptionL100(prefs.consumption || '');
        else applyLabConsumption();
      }
      if (!$('litres').value && veh.origins.litres === 'tank') {
        if (!$('tank').value && veh.vehicle.tank) $('tank').value = veh.vehicle.tank.value || '';
        deriveLitres();
      }
    }
    if (prefs.tank && !veh.origins.tank) veh.origins.tank = prefs.tankOrigin || (veh.vehicle && veh.vehicle.tank && Number(prefs.tank) === veh.vehicle.tank.value ? veh.vehicle.tank.source : 'manual');
    const examples = AutoCompare.initialExamples(prefs, !!veh.vehicle);
    if (examples.consumption != null) { setConsumptionL100(examples.consumption); veh.origins.consumption = 'example'; }
    if (examples.litres != null) { $('litres').value = examples.litres; veh.origins.litres = 'example'; }
    if (examples.tank != null) {
      $('tank').value = examples.tank;
      $('level').value = examples.level;
      veh.origins.tank = 'example';
    }
    setVehicleExpanded(vehExpanded, { persist: false });
    renderOrigins();
    wireVehicle();
    saveRememberedCar();
    if (cfg.build) $('app-build').textContent = cfg.build;
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
    renderStorageError();
    if (!state.config) return;
    renderFuelOptions();
    updateConsumptionHint();
    renderVehicleCard();
    renderOrigins();
    setTip($('priority-tip'), PRESETS()[$('priority').value].hint);
    for (const which of ['start', 'destination']) {
      if (!state[which]) setPoint(which, null, { quiet: true });
      else if (state[which].auto) setPoint(which, { ...state[which], label: state[which].auto() }, { quiet: true });
    }
    // Server-written texts (recommendation, warnings, assumptions) come in the requested language: fetch again.
    scheduleAutoCompare(0);
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
    if (!presets[name]) name = 'balanced';
    $('priority').value = name;
    const p = presets[name];
    if (name === 'custom') {
      if (prefs) { $('per10min').value = prefs.per10min ?? 0; $('minsaving').value = prefs.minsaving ?? state.config.minWorthwhileSaving; }
    } else {
      $('per10min').value = p.per10min;
      $('minsaving').value = p.minsaving ?? state.config.minWorthwhileSaving;
    }
    setTip($('priority-tip'), p.hint);
  }


  function initMap() {
    if (!window.L) {
      $('map').classList.add('no-map');
      return;
    }
    state.map = L.map('map', { scrollWheelZoom: false }).setView([52.1, 5.3], 7);
    const gestureHint = el('div', { class: 'map-gesture-hint', hidden: true, 'aria-live': 'polite' });
    $('map').append(gestureHint);
    ScrollControls.mapGestures(state.map, $('map'), gestureHint, t, /Mac|iPhone|iPad/.test(navigator.platform));
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
    if (which === 'destination') Disclosures.transition($('dest-block'), true, true);
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
    pointRevision[which]++;
    state[which] = p;
    const chosen = $(which === 'start' ? 'start-chosen' : 'dest-chosen');
    if (p) {
      chosen.textContent = p.label || `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}`;
      chosen.classList.add('ok');
    } else {
      chosen.textContent = which === 'start' ? t('No location chosen yet.', 'Nog geen locatie gekozen.')
        : t('No destination: a round trip from your start is assumed.', 'Geen bestemming: er wordt uitgegaan van heen en terug vanaf je start.');
      chosen.classList.remove('ok');
    }
    drawPins();
    if (quiet) return;
    if (p && state.map && !state.map.getBounds().contains([p.lat, p.lon])) state.map.panTo([p.lat, p.lon]);
    scheduleAutoCompare(400);
  }

  const geoSeq = {};
  const geoCache = new Map(); // query+area -> results, so backspacing / retyping is instant
  const geoAbort = {};
  const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  async function fetchGeocode(q, inputId, fast = false) {
    const params = new URLSearchParams({ q });
    const near = state.start || (state.map && { lat: state.map.getCenter().lat, lon: state.map.getCenter().lng });
    if (near) { params.set('lat', near.lat.toFixed(1)); params.set('lon', near.lon.toFixed(1)); }
    if (fast) params.set('fast', '1');
    const key = params.toString();
    if (geoCache.has(key)) return geoCache.get(key);
    const slot = inputId + (fast ? ':fast' : '');
    if (geoAbort[slot]) geoAbort[slot].abort();
    const ctrl = (geoAbort[slot] = new AbortController());
    const res = await fetch(`/api/geocode?${params}`, { signal: ctrl.signal });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || t('Address search failed', 'Adres zoeken mislukt'));
    if (geoCache.size > 300) geoCache.delete(geoCache.keys().next().value);
    geoCache.set(key, json.results);
    return json.results;
  }
  // While a search runs: keep earlier suggestions that still match the typed words and show a "searching" row.
  function showSearching(list, q) {
    const words = norm(q).split(/\s+/).filter(Boolean);
    for (const li of [...list.children]) {
      if (li.classList.contains('searching') || !li.querySelector('button') || !words.every((w) => norm(li.textContent).includes(w))) li.remove();
    }
    list.prepend(el('li', { class: 'muted searching', text: t('Searching…', 'Zoeken…') }));
    list.hidden = false;
  }
  function renderSuggestions(inputId, list, which, results, searching) {
    list.replaceChildren();
    const counts = {};
    for (const r of results) counts[r.label] = (counts[r.label] || 0) + 1;
    for (const r of results) {
      const text = counts[r.label] > 1 ? `${r.label} (${r.lat.toFixed(3)}, ${r.lon.toFixed(3)})` : r.label;
      const b = el('button', { type: 'button', text });
      b.addEventListener('click', () => {
        setPoint(which, r);
        $(inputId).value = r.label;
        list.hidden = true;
        $(inputId).focus({ preventScroll: true });
      });
      list.append(el('li', null, b));
    }
    if (searching) list.append(el('li', { class: 'muted searching', text: t('Searching more results…', 'Meer resultaten zoeken…') }));
    list.hidden = !list.children.length;
  }
  // Instant offline town/postcode suggestions; the full search (streets, addresses) replaces them when it arrives.
  async function geocodeFast(inputId, listId, which) {
    const q = $(inputId).value.trim();
    const seq = geoSeq[inputId];
    let results;
    try { results = await fetchGeocode(q, inputId, true); } catch { return; }
    if (seq !== geoSeq[inputId] || geoDone[inputId] === seq || $(inputId).value.trim() !== q || !results.length) return;
    renderSuggestions(inputId, $(listId), which, results, true);
  }
  const geoDone = {};
  async function geocode(inputId, listId, which, autoPick = false) {
    const q = $(inputId).value.trim();
    const list = $(listId);
    const seq = autoPick ? (geoSeq[inputId] = (geoSeq[inputId] || 0) + 1) : geoSeq[inputId];
    if (q.length < 2) { list.replaceChildren(); list.hidden = true; return null; }
    let results;
    try {
      results = await fetchGeocode(q, inputId);
    } catch (err) {
      if (err.name === 'AbortError') return null;
      if (seq === geoSeq[inputId]) { list.replaceChildren(); list.hidden = true; }
      throw err;
    }
    if (seq !== geoSeq[inputId] || $(inputId).value.trim() !== q) return null; // user kept typing
    geoDone[inputId] = seq;
    list.replaceChildren();
    list.hidden = true;
    if (!results.length) {
      if (autoPick) throw new Error(t(`No places found for “${q}” in the supported countries.`, `Geen plaatsen gevonden voor “${q}” in de ondersteunde landen.`));
      list.append(el('li', { class: 'muted', text: t('No matches yet. Keep typing or check the spelling.', 'Nog geen resultaten. Typ verder of controleer de spelling.') }));
      list.hidden = false;
      return null;
    }
    if (autoPick) {
      setPoint(which, results[0]);
      $(inputId).value = results[0].label;
      return results[0];
    }
    renderSuggestions(inputId, list, which, results, false);
    return null;
  }

  function debounceGeocode(inputId, listId, which) {
    let timer;
    let fastTimer;
    $(inputId).addEventListener('input', () => {
      setPoint(which, null, { quiet: true });
      updater.invalidate();
      clearAdvice(null);
      clearTimeout(timer);
      clearTimeout(fastTimer);
      geoSeq[inputId] = (geoSeq[inputId] || 0) + 1;
      const q = $(inputId).value.trim();
      if (q.length < 2) { $(listId).replaceChildren(); $(listId).hidden = true; return; }
      showSearching($(listId), q);
      fastTimer = setTimeout(() => geocodeFast(inputId, listId, which), 120);
      timer = setTimeout(() => geocode(inputId, listId, which).catch(showError), 300);
    });
    $(inputId).addEventListener('keydown', (e) => {
      const buttons = [...$(listId).querySelectorAll('button')];
      if (e.key === 'ArrowDown' && buttons.length) { e.preventDefault(); buttons[0].focus(); }
      if (e.key === 'Enter') { e.preventDefault(); geocode(inputId, listId, which, true).catch(showError); }
      if (e.key === 'Escape') $(listId).hidden = true;
    });
    $(listId).addEventListener('keydown', (e) => {
      const buttons = [...$(listId).querySelectorAll('button')];
      const i = buttons.indexOf(document.activeElement);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        if (buttons[next]) buttons[next].focus(); else $(inputId).focus();
      } else if (e.key === 'Escape') { $(listId).hidden = true; $(inputId).focus(); }
    });
  }

  // Shows GPS problems right under the button (the form error sits far below it on phones).
  function gpsMessage(msg) {
    const chosen = $('start-chosen');
    chosen.textContent = msg;
    chosen.classList.remove('ok');
  }

  function useGps() {
    if (!window.isSecureContext) {
      return gpsMessage(t('GPS only works over HTTPS (or on localhost). Open the app via https:// or type an address.',
        'GPS werkt alleen via HTTPS (of op localhost). Open de app via https:// of typ een adres.'));
    }
    if (!navigator.geolocation) return gpsMessage(t('Your browser does not support location access.', 'Je browser ondersteunt geen locatiebepaling.'));
    const btn = $('gps');
    const revision = ++pointRevision.start;
    btn.disabled = true;
    btn.textContent = '📍 …';
    gpsMessage(t('Getting your location…', 'Locatie ophalen…'));
    let settled = false;
    // Firefox-based browsers may never call back (e.g. dismissed prompt, no location provider).
    const watchdog = setTimeout(() => {
      if (settled) return;
      settled = true;
      btn.disabled = false; btn.textContent = '📍 GPS';
      gpsMessage(t('Your browser did not return a location. Check its location permission for this site, try another browser, or type an address.',
        'Je browser gaf geen locatie terug. Controleer de locatietoestemming voor deze site, probeer een andere browser of typ een adres.'));
    }, 40000);
    const done = () => { settled = true; clearTimeout(watchdog); btn.disabled = false; btn.textContent = '📍 GPS'; };
    const ok = (pos) => {
      if (settled) return;
      done();
      if (revision !== pointRevision.start) return;
      $('start-q').value = '';
      const acc = Math.round(pos.coords.accuracy);
      const label = () => t(`Your location (±${acc} m)`, `Jouw locatie (±${acc} m)`);
      setPoint('start', { lat: pos.coords.latitude, lon: pos.coords.longitude, label: label(), auto: label });
    };
    const fail = (err) => {
      if (settled) return;
      done();
      if (revision !== pointRevision.start) return;
      const detail = err && err.message ? ` (${err.message})` : '';
      gpsMessage(err && err.code === 1
        ? t(`Location permission denied${detail}. Allow location for this site in your browser, and for the browser app in your phone settings (precise location on), or type an address.`,
          `Geen toestemming voor locatie${detail}. Sta locatie toe voor deze site in je browser én voor de browser-app in je telefooninstellingen (precieze locatie aan), of typ een adres.`)
        : t(`Could not get your location${detail}. Check that your browser app has (precise) location permission in your phone settings, try again, or type an address.`,
          `Kon je locatie niet bepalen${detail}. Controleer of je browser-app (precieze) locatietoestemming heeft in je telefooninstellingen, probeer opnieuw of typ een adres.`));
    };
    // Precise GPS first; on timeout/unavailable, fall back once to a coarser (network) position.
    navigator.geolocation.getCurrentPosition(ok, (err) => {
      if (settled) return;
      if (err.code === 1) return fail(err);
      navigator.geolocation.getCurrentPosition(ok, fail, { enableHighAccuracy: false, timeout: 15000, maximumAge: 300000 });
    }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 60000 });
  }

  function showError(err) {
    const e = $('form-error');
    e.textContent = err && err.message ? err.message : String(err);
    e.hidden = false;
    $('retry').hidden = false;
  }

  function adviceReady() {
    return AutoCompare.adviceReady({
      consumption: consumptionL100(), litres: $('litres').value,
      consumptionOrigin: veh.origins.consumption, litresOrigin: veh.origins.litres,
      valid: $('consumption').validity.valid && $('litres').validity.valid
        && (veh.origins.litres !== 'tank' || $('tank').validity.valid)
        && (!$('uplift').checked || $('uplift-pct').validity.valid),
      needsRealConsumption: !!(veh.vehicle && veh.vehicle.warnings.includes('phev')),
    });
  }

  function comparisonBody() {
    if (!state.config || !state.start || (!state.destination && $('dest-q').value.trim())) return null;
    const advice = adviceReady();
    const fields = ['radius', ...(advice ? ['perkm', 'per10min', 'minsaving', ...($('baseline-mode').value === 'custom' ? ['baseline-price'] : [])] : [])];
    if (fields.some((id) => !$(id).validity.valid || (id === 'baseline-price' && !$(id).value))) {
      showError(t('Check the search radius and cost settings. Correct the invalid value to update.', 'Controleer de zoekstraal en kosteninstellingen. Corrigeer de ongeldige waarde om bij te werken.'));
      return null;
    }
    return {
      start: state.start,
      destination: state.destination,
      fuel: $('fuel').value,
      advice,
      ...(advice ? { consumption: consumptionL100(), litres: $('litres').value } : {}),
      radiusKm: $('radius').value,
      ...(advice ? {
        perKmCost: $('perkm').value,
        timeValuePerHour: $('per10min').value === '' ? '' : Number($('per10min').value) * 6,
        minSaving: $('minsaving').value,
        baseline: $('baseline-mode').value === 'custom' ? { mode: 'custom', price: $('baseline-price').value } : { mode: 'nearest' },
      } : {}),
      lang,
    };
  }

  function clearAdvice(body) {
    const data = state.lastData;
    if (!data) return;
    if (!body || !sameTrip(data.input, { ...body, radiusKm: Number(body.radiusKm) }) || data.input.fuel.id !== body.fuel) {
      $('results').hidden = true;
      $('empty').hidden = false;
      if (state.layer) state.layer.clearLayers();
      return;
    }
    if (!data.input.advice) return;
    const preview = {
      ...data, input: { ...data.input, advice: false }, baseline: null, recommendation: null,
      pendingAdvice: body.advice,
      assumptions: [t('Savings advice is unavailable while the inputs are being updated.', 'Besparingsadvies is niet beschikbaar terwijl de invoer wordt bijgewerkt.')],
      results: data.results.map(({ saving, cashSaving, total, fuelCost, detourCost, timeCost, breakEven, isBaseline, extraKm, extraMin, ...s }) => s)
        .sort((a, b) => (a.route?.detourKm ?? Infinity) - (b.route?.detourKm ?? Infinity) || a.id.localeCompare(b.id)),
    };
    render(preview, { keepView: true });
  }

  const updater = AutoCompare.create({
    getBody: comparisonBody,
    onPending: clearAdvice,
    request: async (body, signal) => {
      const res = await fetch('/api/compare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || t('Comparison failed', 'Vergelijken mislukt'));
      return json;
    },
    onResult: (json) => {
      $('form-error').hidden = true;
      $('retry').hidden = true;
      $('empty').hidden = true;
      state.lastData = json;
      render(json, { keepView: !!state.hasRendered });
      state.hasRendered = true;
    },
    onError: showError,
    onStatus: (status) => {
      const busy = status !== 'idle';
      $('loading').hidden = !busy || !$('results').hidden;
      $('updating').hidden = !busy || $('results').hidden;
      $('results').setAttribute('aria-busy', String(busy));
    },
  });

  function scheduleAutoCompare(delay = 400) {
    if (!state.config) return;
    savePrefs();
    updater.schedule(delay);
  }

  function sameTrip(a, b) {
    const eq = (p, q) => (!p && !q) || (p && q && p.lat === q.lat && p.lon === q.lon);
    return eq(a.start, b.start) && eq(a.destination, b.destination) && a.radiusKm === b.radiusKm;
  }

  // ------------------------------------------------------------ render
  function render(data, { keepView = false } = {}) {
    const active = document.activeElement;
    const href = active.getAttribute && active.getAttribute('href');
    const label = active.getAttribute && active.getAttribute('aria-label');
    const activeStation = active.closest && active.closest('li.station');
    const stationId = activeStation && activeStation.dataset.stationId;
    const focusIndex = activeStation ? [...activeStation.querySelectorAll('a, button, [tabindex]')].indexOf(active) : -1;
    const panel = document.querySelector('.results-panel');
    const scroll = panel.scrollTop;
    const pageScroll = window.scrollY;
    const selectedId = state.lastRendered && state.selectedStation != null ? state.lastRendered.results[state.selectedStation]?.id : null;
    $('results').hidden = false;
    setTip($('station-sort-tip'), data.input.advice ? t('Sorted by net saving.', 'Gesorteerd op nettobesparing.') : t('Sorted by detour distance. No savings ranking yet.', 'Gesorteerd op omwegafstand. Nog geen rangschikking op besparing.'));
    renderRecommendation(data);
    renderWarnings(data);
    renderSummary(data);
    renderList(data);
    renderAssumptions(data);
    renderSources(data);
    renderMap(data, keepView);
    state.lastRendered = data;
    const selected = data.results.findIndex((s) => s.id === selectedId);
    if (selected >= 0) selectStation(selected, { flash: false });
    if (stationId && !active.isConnected) {
      const li = [...$('station-list').children].find((n) => n.dataset.stationId === stationId);
      const target = li && li.querySelectorAll('a, button, [tabindex]')[focusIndex];
      if (target) target.focus({ preventScroll: true });
    } else if (!active.isConnected && (href || label)) {
      const target = [...$('results').querySelectorAll('a, button, [tabindex]')].find((n) =>
        href ? n.getAttribute('href') === href : n.getAttribute('aria-label') === label);
      if (target) target.focus({ preventScroll: true });
    }
    panel.scrollTop = scroll;
    if (window.scrollY !== pageScroll) window.scrollTo({ top: pageScroll, behavior: 'instant' });
  }

  function renderRecommendation(data) {
    const r = data.recommendation;
    const box = $('recommendation');
    box.hidden = !r;
    if (!r) { box.replaceChildren(); return; }
    box.className = `recommendation ${r.level}`;
    const best = data.results.find((s) => s.id === r.stationId);
    const conf = CONFIDENCE_LABEL()[r.confidence];
    box.replaceChildren(...[
      el('h2', { text: r.headline }),
      ['consumption', 'litres'].some((id) => veh.origins[id] === 'example')
        ? el('p', { class: 'caveat', text: t('Calculated with example car values. Adjust consumption and litres to buy for personal advice.',
          'Berekend met voorbeeldwaarden voor de auto. Pas verbruik en liters tanken aan voor persoonlijk advies.') }) : null,
      conf ? el('p', { class: `confidence ${r.confidence}` }, conf.label, ' ', infoTip(conf.reason)) : null,
      el('p', { text: r.detail }),
      ...(r.caveats || []).map((c) => el('p', { class: 'caveat', text: `⚠ ${c}` })),
      best ? el('div', { class: 'actions' }, navLinks(best, true)) : null,
    ].filter(Boolean));
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
    if (!data.input.advice) {
      s.textContent = data.pendingAdvice ? t('Updating savings advice. Stations are temporarily ordered by detour distance.',
        'Besparingsadvies bijwerken. Stations staan tijdelijk op volgorde van omwegafstand.') : t('Stations and prices for the selected fuel. Enter valid consumption and litres to buy for savings advice. Ordered by detour distance.',
        'Stations en prijzen voor de gekozen brandstof. Vul geldig verbruik en liters tanken in voor besparingsadvies. Op volgorde van omwegafstand.');
      return;
    }
    if (!data.baseline) return;
    const route = data.input.mode === 'route';
    const modeBtn = el('button', { type: 'button', class: 'linkish', text: route ? t('change destination', 'bestemming wijzigen') : t('add a destination', 'voeg een bestemming toe') });
    modeBtn.addEventListener('click', () => { Disclosures.transition($('dest-block'), true, true); $('dest-q').focus({ preventScroll: true }); $('dest-block').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'center' }); });
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
      const advice = data.input.advice;
      const cls = ['station', s.id === recId ? 'best' : '', s.isBaseline ? 'baseline' : ''].join(' ');
      const timed = data.input.timeValuePerHour > 0;
      const cash = s.cashSaving ?? s.saving;
      const savingCls = s.saving > 0.005 ? 'pos' : s.saving < -0.005 ? 'neg' : '';
      const savingText = s.isBaseline ? t('baseline', 'vergelijkingspunt') : `${cash >= 0 ? '+' : '−'}${eur(Math.abs(cash))}`;
      const savingKey = s.isBaseline ? t('reference', 'referentie') : !timed || cash <= 0.005 ? t('net saving', 'nettobesparing')
        : s.saving >= 0 ? t(`${eur(s.saving)} after extra time`, `${eur(s.saving)} na extra tijd`) : t('not worth the extra time', 'extra tijd niet waard');
      const p = s.price || { kind: 'unavailable' };
      const estNote = p.kind === 'legal-maximum' ? t('The actual price is usually lower.', 'De echte prijs is meestal lager.')
        : p.kind === 'national-average' ? t('The actual price can differ by ±20 ct/L.', 'De echte prijs kan ±20 ct/L afwijken.') : '';
      list.append(el('li', { class: cls, id: `st-${i}`, 'data-station-id': s.id },
        el('div', { class: 'station-head' },
          el('div', null,
            el('div', { class: 'station-name' }, el('span', { class: `flag ${s.country}`, text: s.country }), s.name),
            el('div', { class: 'station-addr', text: [s.brand && s.brand !== s.name ? s.brand : null, s.address].filter(Boolean).join(' · ') || ' ' })),
          advice ? el('div', { class: 'saving' }, el('div', { class: `v ${savingCls}`, text: savingText }), el('div', { class: 'k', text: savingKey })) : null),
        el('div', { class: 'facts' },
          s.price ? el('span', null, el('b', { text: eurL(p.price) }), ' ', el('span', { class: `tag ${p.kind}${p.estimate ? ' estimate' : ''} ${p.quality || ''}`, text: priceLabel(p) })) : el('span', { text: t('Price unavailable', 'Prijs niet beschikbaar') }),
          s.route ? el('span', null, t('Detour ', 'Omweg '), el('b', { text: `${km(s.route.detourKm)} km` }), s.route.detourMin ? ` (~${s.route.detourMin} min)` : '') : el('span', { text: t('Route unavailable', 'Route niet beschikbaar') }),
          advice ? [
            el('span', null, t('Extra vs baseline ', 'Extra t.o.v. vergelijkingspunt '), el('b', { text: `${s.extraKm > 0 ? '+' : ''}${km(s.extraKm)} km` }), s.extraMin ? ` / ${s.extraMin > 0 ? '+' : ''}${s.extraMin} min` : '', timed && s.extraMin > 0 && !s.isBaseline ? t(` (must save ≥ ${eur(s.extraMin * data.input.timeValuePerHour / 60)})`, ` (moet ≥ ${eur(s.extraMin * data.input.timeValuePerHour / 60)} besparen)`) : ''),
            el('span', null, t('Total ', 'Totaal '), el('b', { text: eur(s.total) }), t(` (fuel ${eur(s.fuelCost)} + driving ${eur(s.detourCost)})`, ` (brandstof ${eur(s.fuelCost)} + rijden ${eur(s.detourCost)})`)),
            el('span', null, t('Break-even: ', 'Omslagpunt: '), el('b', { text: breakEvenText(s.breakEven) })),
          ] : null),
        el('div', { class: 'provenance', text: `${s.localFuelName}${p.product ? t(` (listed as "${p.product}")`, ` (vermeld als "${p.product}")`) : ''}${s.price ? ` · ${p.source} · ${priceFreshness(p)}` : ''}${s.fuelAvailability === 'unknown' ? t(' · fuel availability not confirmed in OSM', ' · beschikbaarheid brandstof niet bevestigd in OSM') : ''}` }),
        p.estimate ? el('div', { class: 'provenance estimate-note' }, t("Not this pump's price", 'Niet de prijs van deze pomp'),
          [p.fallbackReason, estNote].filter(Boolean).length ? [' ', infoTip([p.fallbackReason, estNote].filter(Boolean).join(' - '))] : null) : null,
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
      const quoted = data.results.filter((r) => r.price?.provider === 'carbu').length;
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
      const quoted = data.results.filter((r) => r.price?.provider === 'anwb').length;
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
        const origins = [...new Set(data.results.filter((r) => r.price?.provider === 'anwb' && r.price.dataOrigin).map((r) => r.price.dataOrigin))];
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
      const quoted = data.results.filter((r) => r.price?.provider === 'directlease').length;
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
        r ? `${eurL(r.price)}: ${refSourceText(r)} ` : t('not available. ', 'niet beschikbaar. '),
        r && r.sourceUrl ? el('a', { href: r.sourceUrl, target: '_blank', rel: 'noopener', text: t('Source', 'Bron') }) : null));
    }
    const st = data.sources.stations;
    box.append(el('p', { class: 'source-row' }, el('b', { text: 'Stations: ' }),
      st.provider === 'anwb' ? t(`ANWB Onderweg (${st.endpoint}); oldest area retrieved ${fmtAge(st.fetchedAt)}. No country estimates are used outside NL/BE.`,
          `ANWB Onderweg (${st.endpoint}); oudste gebied opgehaald ${fmtAge(st.fetchedAt)}. Buiten NL/BE worden geen landelijke schattingen gebruikt.`)
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
  function selectStation(i, { scroll = false, pan = false, flash = true } = {}) {
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
      if (flash) {
        li.classList.remove('flash');
        void li.offsetWidth; // restart the flash animation
        li.classList.add('flash');
      }
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
    const openId = state.lastRendered && state.stationMarkers
      ? state.lastRendered.results[state.stationMarkers.findIndex((m) => m.isPopupOpen())]?.id : null;
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
      const price = s.price ? eurL(s.price.price) : t('Price unavailable', 'Prijs niet beschikbaar');
      const popup = el('div', null, el('b', { text: `${s.country} · ${s.name}` }), el('br'), price,
        data.input.advice ? ` · ${t('saving', 'besparing')} ${eur(s.cashSaving ?? s.saving)}` : null);
      if (s.price?.estimate) popup.append(el('br'), el('i', { text: t('estimated price', 'geschatte prijs') }));
      m.bindPopup(popup, { autoPan: !keepView });
      const cs = s.cashSaving ?? s.saving;
      const delta = !data.input.advice ? { cls: 'base', text: '' } : s.isBaseline ? { cls: 'base', text: t('nearest · reference', 'dichtstbij · referentie') }
        : cs > 0.005 ? { cls: 'pos', text: t(`saves ${eur(cs)}`, `bespaart ${eur(cs)}`) }
          : cs < -0.005 ? { cls: 'neg', text: t(`${eur(-cs)} more`, `${eur(-cs)} duurder`) } : { cls: 'base', text: t('same cost', 'even duur') };
      const tip = el('div', { class: 'st-tip' },
        el('div', { class: 'st-tip-head' }, el('span', { class: `flag ${s.country}`, text: s.country }), el('span', { class: 'st-tip-name', text: s.name })),
        s.address ? el('div', { class: 'st-tip-addr', text: s.address }) : null,
        el('div', { class: 'st-tip-row' },
          el('span', { class: 'st-tip-price', text: price }),
          el('span', { class: `st-tip-delta ${delta.cls}`, text: delta.text })),
        s.price?.estimate ? el('div', { class: 'st-tip-est', text: t('Estimated price, not this pump', 'Geschatte prijs, niet van deze pomp') }) : null,
        s.route ? el('div', { class: 'st-tip-meta', text: `${km(s.route.detourKm)} km ${t('detour', 'omweg')}${s.route.detourMin ? ` · ~${s.route.detourMin} min` : ''}` }) : null);
      m.bindTooltip(tip, { direction: 'top', offset: [0, -10], opacity: 1, className: 'st-tooltip' });
      m.on('tooltipopen', (e) => placeTooltip(m, e.tooltip));
      m.on('popupopen', () => m.closeTooltip());
      m.on('click', () => selectStation(i, { scroll: true }));
      m.addTo(state.layer);
      state.stationMarkers.push(m);
      if (s.id === openId) m.openPopup();
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
  $('form').addEventListener('submit', (ev) => ev.preventDefault());
  $('retry').addEventListener('click', () => {
    if (!state.config) { init().catch(showError); return; }
    if (!state.start && $('start-q').value.trim()) geocode('start-q', 'start-suggestions', 'start', true).catch(showError);
    else if (!state.destination && $('dest-q').value.trim()) geocode('dest-q', 'dest-suggestions', 'destination', true).catch(showError);
    else updater.retry();
  });
  // Native validation can't focus fields inside the collapsed panel: open it first.
  $('form').addEventListener('invalid', (ev) => {
    if ($('vehicle-details').contains(ev.target) && !vehExpanded) setVehicleExpanded(true, { persist: false });
  }, true);
  $('gps').addEventListener('click', useGps);
  for (const b of document.querySelectorAll('#cons-toggle button')) b.addEventListener('click', () => { setConsumptionUnit(b.dataset.unit); scheduleAutoCompare(); });
  $('consumption').addEventListener('input', updateConsumptionHint);
  // Open navigation links via window.open: some embedded/in-app browsers ignore target=_blank anchors.
  // With 'noopener' the return value is always null, so it cannot be used to detect blocking; never fall back
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
    $(id).addEventListener('input', () => { $('priority').value = 'custom'; setTip($('priority-tip'), PRESETS().custom.hint); });
  }
  for (const b of document.querySelectorAll('.lang-toggle button')) b.addEventListener('click', () => setLanguage(b.dataset.lang));
  debounceGeocode('start-q', 'start-suggestions', 'start');
  debounceGeocode('dest-q', 'dest-suggestions', 'destination');
  // Settings changes refresh the results automatically (address fields update via their suggestions / pins).
  const isAddress = (t) => t && (t.id === 'start-q' || t.id === 'dest-q' || t.id === 'kenteken');
  function onSettingsChange(e) {
    if (isAddress(e.target)) return;
    if (['fuel', 'consumption', 'tank', 'litres', 'level', 'uplift', 'uplift-pct'].includes(e.target.id)
      && VehicleMemory.hasCar(veh.vehicle, veh.origins)) vehicleForgotten = false;
    scheduleAutoCompare();
    renderVehicleSummary();
  }
  $('form').addEventListener('input', onSettingsChange);
  $('form').addEventListener('change', onSettingsChange);
  init().catch((err) => showError(t(`Could not load app configuration: ${err.message}`, `Kon de app-configuratie niet laden: ${err.message}`)));
})();
