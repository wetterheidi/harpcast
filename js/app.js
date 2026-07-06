'use strict';

/* UI-Verdrahtung: Karten, Datenabruf, Statistik-Cache, Rendering.
   Zwei Ergebnis-Tabs: „Analyse“ (Wetterberatung, volle Statistik) und
   „Briefing“ (Springer-Sicht, spiegelt die Analyse-Auswahl, fixierbar). */
(() => {

  const $ = id => document.getElementById(id);

  // Modelle mit Druckflächen-Ensembledaten; 'multi' poolt alle drei
  const MULTI_MODELS = 'ecmwf_ifs025,ecmwf_aifs025,gfs05';
  // deterministische Hauptläufe mit Druckflächendaten (Forecast-API);
  // Modelle außerhalb ihrer Domäne lässt die API stillschweigend weg
  const DET_MODELS = 'ecmwf_ifs025,gfs_global,icon_d2,icon_eu,icon_global,' +
    'gem_global,meteofrance_arpege_europe,ukmo_global_deterministic_10km,' +
    'knmi_harmonie_arome_europe,jma_gsm,cma_grapes_global';
  const MODEL_LABELS = {
    ecmwf_ifs025: 'ECMWF IFS', ecmwf_ifs025_ensemble: 'ECMWF IFS',
    ecmwf_aifs025: 'ECMWF AIFS', ecmwf_aifs025_ensemble: 'ECMWF AIFS',
    gfs05: 'GFS', ncep_gefs05: 'GFS',
    gfs_global: 'GFS', icon_d2: 'ICON-D2', icon_eu: 'ICON-EU', icon_global: 'ICON',
    gem_global: 'GEM', meteofrance_arpege_europe: 'ARPEGE',
    ukmo_global_deterministic_10km: 'UKMO', knmi_harmonie_arome_europe: 'HARMONIE',
    jma_gsm: 'JMA', cma_grapes_global: 'CMA',
  };
  const modelLabel = id => MODEL_LABELS[id] || id;

  const state = {
    data: null,      // geparste Ensembledaten
    stats: [],       // hourStats je Stunde
    t: 0,            // gewählter Stundenindex
    tab: 'analyse',  // sichtbarer Ergebnis-Tab
    frozen: null,    // fixierter Briefing-Stand (Snapshot) oder null = live
    harp: null,      // eigener HARP {lat, lng} oder null = folgt dem Minimax-Punkt
  };

  // --- Karten ------------------------------------------------------------
  // Basiskarten: OSM und Esri-Satellit (mit Label-Overlay). Die Auswahl wird
  // gemerkt und beim Anlegen weiterer Karten übernommen.
  let basemapChoice = 'OpenStreetMap';
  function baseLayers() {
    return {
      'OpenStreetMap': L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '© OpenStreetMap',
      }),
      'Esri Satellit': L.layerGroup([
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
          maxZoom: 19,
          attribution: '© Esri, USDA, USGS, © OpenStreetMap contributors, GIS user community',
        }),
        // Overlay: Labels und Grenzen über dem Satellitenbild
        L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}', {
          maxZoom: 19,
        }),
      ]),
    };
  }
  function addBasemaps(m) {
    const bl = baseLayers();
    (bl[basemapChoice] || bl['OpenStreetMap']).addTo(m);
    L.control.layers(bl, null).addTo(m);
    m.on('baselayerchange', e => { basemapChoice = e.name; });
  }

  // Sidebar-Karte: dient nur der DIP-Planung (Marker setzen/ziehen)
  const map = L.map('map').setView([+$('lat').value, +$('lon').value], 8);
  addBasemaps(map);
  const marker = L.marker([+$('lat').value, +$('lon').value], { draggable: true }).addTo(map);

  function setLocation(lat, lng) {
    $('lat').value = lat.toFixed(4);
    $('lon').value = lng.toFixed(4);
    $('dipMgrs').value = toMgrs(lat, lng);
    marker.setLatLng([lat, lng]);
  }
  map.on('click', e => setLocation(e.latlng.lat, e.latlng.lng));
  marker.on('dragend', () => {
    const p = marker.getLatLng();
    setLocation(p.lat, p.lng);
  });

  // Ergebnis-Karten (Analyse und Briefing) entstehen erst, wenn ihr
  // Container sichtbar ist – Leaflet braucht eine reale Größe
  let mapA = null, mapB = null;
  function makeResultMap(id) {
    const m = L.map(id).setView(marker.getLatLng(), 10);
    addBasemaps(m);
    return { map: m, layer: L.layerGroup().addTo(m) };
  }
  // Ist das Ziel seit dem letzten Rendern dieser Karte gewandert (z. B. neuer
  // DIP + Neuladen, während der andere Tab offen war)? Merkt sich das Zentrum.
  function centerMoved(rm, c) {
    const prev = rm.center;
    rm.center = { lat: c.lat, lng: c.lng };
    return !prev || Math.abs(prev.lat - c.lat) > 1e-6 || Math.abs(prev.lng - c.lng) > 1e-6;
  }

  // --- Koordinatenformat (Dezimalgrad / MGRS) ------------------------------
  const coordFmt = () => $('coordFmt').value;
  const toMgrs = (lat, lng) => {
    try { return mgrs.forward([lng, lat], 5); } catch (e) { return ''; }
  };
  function fromMgrs(str) {
    try {
      const [lng, lat] = mgrs.toPoint(str.replace(/\s+/g, '').toUpperCase());
      return { lat, lng };
    } catch (e) { return null; }
  }
  function applyCoordFmt() {
    const isMgrs = coordFmt() === 'mgrs';
    for (const el of document.querySelectorAll('.coord-deg')) el.hidden = isMgrs;
    for (const el of document.querySelectorAll('.coord-mgrs')) el.hidden = !isMgrs;
    const c = marker.getLatLng();
    $('dipMgrs').value = toMgrs(c.lat, c.lng);
    if (state.data) refreshHarp();   // füllt auch die HARP-Felder neu
  }

  // --- Einheiten -----------------------------------------------------------
  const ALT_F = { m: 1, ft: 3.28084 };
  const SPD_F = { ms: 1, kt: 1.94384, kmh: 3.6 };
  const SPD_LBL = { ms: 'm/s', kt: 'kt', kmh: 'km/h' };
  // Grenzen der Sprungprofil-Felder, metrisch definiert
  const ALT_INPUTS = { exitAGL: [500, 8000], openAGL: [200, 4000], margin: [0, 1000] };
  const SPD_INPUTS = { vFree: [20, 90], vCanopy: [2, 12], vFwd: [2, 25] };
  // Einheit, in der die Eingabefelder aktuell beschriftet/gefüllt sind
  let curAlt = 'm', curSpd = 'ms';

  const unitCtx = () => ({
    altF: ALT_F[curAlt], altLbl: curAlt, altTick: curAlt === 'ft' ? 2000 : 1000,
    spdF: SPD_F[curSpd], spdLbl: SPD_LBL[curSpd],
  });
  const fmtAlt = m => curAlt === 'ft' ? `${Math.round(m * ALT_F.ft)} ft` : `${Math.round(m)} m`;
  const fmtDist = m => curAlt === 'ft'
    ? `${Math.round(m * ALT_F.ft)} ft`
    : m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
  const fmtSpd = ms => {
    const v = ms * SPD_F[curSpd];
    return `${curSpd === 'ms' ? v.toFixed(1) : Math.round(v)} ${SPD_LBL[curSpd]}`;
  };
  // Windangabe „Richtung / Geschwindigkeit“ in der gewählten Anzeigeeinheit
  const fmtWind = w => w
    ? `${String(Math.round(w.dir)).padStart(3, '0')}° / ${fmtSpd(w.spd)}`
    : '–';

  function switchUnits() {
    const nAlt = $('unitAlt').value, nSpd = $('unitSpd').value;
    const conv = (ids, F, oldU, newU, dec) => {
      for (const [id, [min, max]] of Object.entries(ids)) {
        const el = $(id);
        const metric = +el.value / F[oldU];
        el.min = +(min * F[newU]).toFixed(dec);
        el.max = +(max * F[newU]).toFixed(dec);
        el.step = 'any';
        el.value = +(metric * F[newU]).toFixed(dec);
      }
    };
    if (nAlt !== curAlt) { conv(ALT_INPUTS, ALT_F, curAlt, nAlt, 0); curAlt = nAlt; }
    if (nSpd !== curSpd) { conv(SPD_INPUTS, SPD_F, curSpd, nSpd, 1); curSpd = nSpd; }
    for (const el of document.querySelectorAll('.uAlt')) el.textContent = curAlt;
    for (const el of document.querySelectorAll('.uSpd')) el.textContent = SPD_LBL[curSpd];
    updateRLabel();
    if (state.data) { computeStats(); renderAll(); }
  }

  // --- Modellfilter ------------------------------------------------------
  // vom Nutzer abgewählte Modelle; bleibt über Neuladen der Daten erhalten
  const disabledModels = new Set();

  const uniqueModels = () => state.data ? [...new Set(state.data.memberModel)] : [];

  // gefilterte Sicht auf die Daten: nur Member aktiver Modelle
  function activeData() {
    const d = state.data;
    const models = uniqueModels();
    if (models.length < 2 || !models.some(m => disabledModels.has(m))) return d;
    const keep = d.memberModel
      .map((m, i) => disabledModels.has(m) ? -1 : i)
      .filter(i => i >= 0);
    return {
      ...d,
      suffixes: keep.map(i => d.suffixes[i]),
      memberModel: keep.map(i => d.memberModel[i]),
    };
  }

  function renderModelFilter() {
    const models = uniqueModels();
    const wrap = $('modelFilter');
    wrap.hidden = models.length < 2;
    if (wrap.hidden) return;
    const counts = {};
    for (const m of state.data.memberModel) counts[m] = (counts[m] || 0) + 1;
    $('modelFilterList').innerHTML = models.map((m, k) =>
      `<label><input type="checkbox" data-model="${m}" ${disabledModels.has(m) ? '' : 'checked'}>` +
      `<span class="chip" style="background:${Charts.modelColor(k, 1)}"></span>` +
      `${modelLabel(m)}</label>`).join('');
    for (const cb of wrap.querySelectorAll('input[type="checkbox"]')) {
      cb.addEventListener('change', () => {
        cb.checked ? disabledModels.delete(cb.dataset.model) : disabledModels.add(cb.dataset.model);
        updateFilterHint();
        computeStats();
        renderAll();
      });
    }
    updateFilterHint();
  }

  function updateFilterHint() {
    const active = state.data.memberModel.filter(m => !disabledModels.has(m)).length;
    const total = state.data.memberModel.length;
    const el = $('modelFilterHint');
    el.innerHTML = `${active} von ${total} Membern aktiv` +
      (active < 2 ? ' — <span class="warn">unter 2 Membern keine Statistik</span>'
        : active < 5 ? ' — <span class="warn">N &lt; 5: nur orientierend</span>' : '');
  }

  // --- Parameter -------------------------------------------------------
  // liefert immer metrische Werte, unabhängig von der Eingabeeinheit
  function params() {
    const aF = ALT_F[curAlt], sF = SPD_F[curSpd];
    const p = {
      exitAGL: +$('exitAGL').value / aF,
      openAGL: +$('openAGL').value / aF,
      vFree: +$('vFree').value / sF,
      vCanopy: +$('vCanopy').value / sF,
      vFwd: +$('vFwd').value / sF,
      margin: +$('margin').value / aF,
    };
    // korrigierbare Strecke: Eigenfahrt des Schirms über die nutzbare Schirmzeit;
    // die Überhöhung (Höhenreserve über dem DIP, z. B. Landevolte) ist nicht nutzbar
    p.tolerance = Math.max(0, p.vFwd * Math.max(0, p.openAGL - p.margin) / p.vCanopy);
    return p;
  }

  function updateRLabel() {
    const p = params();
    const el = $('rCalc');
    el.textContent = fmtDist(p.tolerance);
    el.classList.toggle('warn', p.tolerance <= 0);
  }

  // --- Datenabruf ------------------------------------------------------
  async function load() {
    const btn = $('loadBtn'), status = $('status');
    btn.disabled = true;
    status.classList.remove('error');
    status.textContent = 'Lade Ensembledaten …';
    try {
      const sel = $('model').value;
      const det = sel === 'det';
      const url = Meteo.buildUrl(+$('lat').value, +$('lon').value,
        det ? DET_MODELS : sel === 'multi' ? MULTI_MODELS : sel, det);
      const res = await fetch(url);
      const json = await res.json();
      if (json.error) throw new Error(json.reason || 'API-Fehler');
      state.data = Meteo.parse(json);
      // bei Einzelmodell-Anfragen tragen die Keys keine Modellkennung
      state.data.memberModel = state.data.memberModel.map(m => m || sel);
      const counts = {};
      for (const m of state.data.memberModel) counts[m] = (counts[m] || 0) + 1;
      const breakdown = Object.entries(counts)
        .map(([m, n]) => n > 1 ? `${modelLabel(m)} ${n}` : modelLabel(m)).join(' · ');
      status.textContent =
        `${state.data.suffixes.length} ${det ? 'Hauptläufe' : 'Member'} (${breakdown}) · ` +
        `Geländehöhe ${Math.round(state.data.elevation)} m MSL`;
      renderModelFilter();
      // eigenen HARP verwerfen, wenn er offensichtlich zu einem anderen Ort gehört
      if (state.harp) {
        const xy = harpXY(marker.getLatLng(), state.harp);
        if (Math.hypot(xy.x, xy.y) > 50000) state.harp = null;
      }
      computeStats();
      state.t = defaultHour();
      $('timeSlider').max = state.data.times.length - 1;
      $('timeSlider').value = state.t;
      $('results').hidden = false;
      // neue Daten: zurück in die Analyse (der Berater prüft zuerst)
      showTab('analyse', false);
      if (!mapA) mapA = makeResultMap('mapAnalysis');
      mapA.map.invalidateSize();
      renderAll(true);
    } catch (err) {
      status.textContent = 'Fehler: ' + err.message;
      status.classList.add('error');
    } finally {
      btn.disabled = false;
    }
  }

  function computeStats() {
    const p = params();
    const ad = activeData();
    state.stats = ad.times.map((_, t) => Meteo.hourStats(ad, t, p));
  }

  function defaultHour() {
    // erste volle Stunde in der Zukunft (Zeiten sind ortslokal, Näherung über Browserzeit)
    const now = new Date();
    const key = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-` +
      `${String(now.getDate()).padStart(2, '0')}T${String(now.getHours()).padStart(2, '0')}:00`;
    const i = state.data.times.findIndex(t => t > key);
    return i < 0 ? 0 : i;
  }

  // --- Rendering -------------------------------------------------------
  function fmtTime(t) {
    const [date, time] = state.data.times[t].split('T');
    const [, mo, day] = date.split('-');
    return `${day}.${mo}. ${time} ${state.data.tzAbbr}`;
  }

  const metric = (val, lbl) =>
    `<div class="metric"><span class="val">${val}</span><span class="lbl">${lbl}</span></div>`;

  function renderAll(fitMap = false) {
    const p = params();
    const s = state.stats[state.t];
    $('timeLabel').textContent = fmtTime(state.t);

    renderScore(s, p);
    renderAnalysisMap(s, p, fitMap);
    renderTable(p);

    const prof = Meteo.profileChartData(activeData(), state.t, p);
    if (prof) {
      prof.allModels = uniqueModels();   // stabile Farbzuordnung trotz Filter
      prof.modelLabels = {};
      for (const m of new Set(prof.lineModels)) prof.modelLabels[m] = modelLabel(m);
      Charts.speedProfile($('chartSpeed'), prof, unitCtx());
      Charts.dirProfile($('chartDir'), prof, unitCtx());
    }
    const tsMap = Charts.timeSeries($('chartTime'), state.data.times, state.stats, state.t, unitCtx());
    $('chartTime').onclick = e => selectHour(tsMap(e.offsetX));
    const stripMap = Charts.qualityStrip($('qualityStrip'), state.stats, state.t);
    $('qualityStrip').onclick = e => selectHour(stripMap(e.offsetX));

    // Briefing spiegelt live (sofern nicht fixiert und gerade sichtbar)
    if (state.tab === 'briefing') renderBriefing();
  }

  function selectHour(t) {
    state.t = t;
    $('timeSlider').value = t;
    renderAll();
  }

  function renderScore(s, p) {
    const card = $('scoreCard');
    if (!s) {
      card.innerHTML = '<p class="hint">Für diesen Termin liegen nicht genug Ensembledaten vor.</p>';
      return;
    }

    // Operationell: Anteil der Korrekturreserve, den die Wetterunsicherheit verbraucht
    const use = s.reserveUse;
    const usePct = isFinite(use) ? `${Math.round(use * 100)} %` : '∞';
    let opCls = (p.tolerance <= 0 || use >= 0.8) ? 'red' : use >= 0.4 ? 'amber' : 'green';
    const safeR = Math.max(0, p.tolerance - s.enc90.r);

    // Meteorologisch: absolute Spread-Maße gegen einstellbare Schwellen
    const thr = {
      distG: +$('thrDistG').value, distR: +$('thrDistR').value,
      dirG: +$('thrDirG').value, dirR: +$('thrDirR').value,
    };
    let metCls = (s.distP90 > thr.distR || s.sigmaDir > thr.dirR) ? 'red'
      : (s.distP90 <= thr.distG && s.sigmaDir <= thr.dirG) ? 'green' : 'amber';

    // kleines Ensemble: Statistik nur orientierend, grün wird nicht vergeben
    if (s.lowN) {
      if (opCls === 'green') opCls = 'amber';
      if (metCls === 'green') metCls = 'amber';
    }

    card.innerHTML =
      (s.lowN
        ? `<p class="hint"><span class="warn">Nur ${s.n} Member verfügbar</span> – alle Maße sind ` +
          `nur orientierend (Quantile ≈ Extremwerte); „grün“ wird bei N &lt; 5 nicht vergeben. ` +
          `Die einzelnen Exitkreise auf der Karte sind hier die belastbarste Darstellung.</p>`
        : '') +
      `<div class="score-block">
         <div class="badge ${opCls}"><span class="big">${usePct}</span>Reserve-Verbrauch</div>
         <div class="metrics">
           ${metric(fmtDist(p.tolerance), 'korrigierbare Strecke R')}
           ${metric(safeR > 0 ? fmtDist(safeR) : 'keine', 'sichere Exitzone (≥ 90 % Member)')}
           ${metric(fmtDist(s.distP90), 'Versatz-Streuung distP90')}
         </div>
       </div>
       <div class="score-block">
         <div class="badge ${metCls}"><span class="big">${fmtDist(s.distP90)}</span>Meteo-Spread</div>
         <div class="metrics">
           ${metric(fmtWind({ dir: s.meanDir, spd: s.meanSpd }), 'Mittelwind Boden–Exit')}
           ${metric(`± ${fmtSpd(s.sigmaSpd)}`, 'σ Geschwindigkeit')}
           ${metric(`± ${Math.round(s.sigmaDir)}°`, 'σ Richtung (zirkular)')}
           ${metric(`${s.n}`, 'gültige Member')}
         </div>
       </div>`;
  }

  // --- Kartendarstellung: Exitzonen bzw. Landepunktwolke ----------------
  const mapMode = () => document.querySelector('input[name="mapMode"]:checked').value;

  function meterScale(c) {
    const mPerDegLat = 111320;
    return { mPerDegLat, mPerDegLon: mPerDegLat * Math.cos(c.lat * Math.PI / 180) };
  }

  const legendChip = (color, label) =>
    `<span><span class="chip" style="background:${color}"></span>${label}</span>`;

  // --- Geplanter HARP ----------------------------------------------------
  // state.harp = null → HARP folgt automatisch dem Minimax-Punkt (Optimum)
  function autoHarp(s, c) {
    const { mPerDegLat, mPerDegLon } = meterScale(c);
    return { lat: c.lat + s.enc90.y / mPerDegLat, lng: c.lng + s.enc90.x / mPerDegLon };
  }
  const resolvedHarp = (s, c) => state.harp || autoHarp(s, c);

  // HARP-Position in Metern relativ zum DIP (x Ost, y Nord)
  function harpXY(c, hp) {
    const { mPerDegLat, mPerDegLon } = meterScale(c);
    return { x: (hp.lng - c.lng) * mPerDegLon, y: (hp.lat - c.lat) * mPerDegLat };
  }

  // Bewertung eines HARPs: Member-Deckung (= Überdeckungsfeld an diesem
  // Punkt) und Worst-Case-Fehlstrecke über die nicht gedeckten Member
  function harpEval(s, p, xy) {
    const R = p.tolerance;
    let hit = 0, worst = 0;
    for (const e of s.exits) {
      const d = Math.hypot(xy.x - e.x, xy.y - e.y);
      if (d <= R) hit++;
      else worst = Math.max(worst, d - R);
    }
    return { hit, n: s.exits.length, frac: hit / s.exits.length, worst };
  }

  // luvseitigster Punkt auf der Driftachse (Strahl vom DIP in Richtung des
  // mittleren Exits), der noch ≥ 90 % der Member deckt – größtmögliche
  // Gleitstrecke bei vertretbarem Risiko. Fallback: weitester Punkt bester Deckung.
  function glideHarp(s, p) {
    const R = p.tolerance;
    const ex = -s.meanDrift.x, ey = -s.meanDrift.y;
    const L0 = Math.hypot(ex, ey);
    const ux = L0 ? ex / L0 : 0, uy = L0 ? ey / L0 : 1;
    const need = Math.ceil(0.9 * s.exits.length);
    let pass = null, bestHit = 0, best = null;
    for (let t = 0; t <= L0 + R + 1000; t += 20) {
      const x = ux * t, y = uy * t;
      let hit = 0;
      for (const e of s.exits) if (Math.hypot(x - e.x, y - e.y) <= R) hit++;
      if (hit >= need) pass = { x, y };
      if (hit > bestHit || (hit === bestHit && hit > 0)) { bestHit = hit; best = { x, y }; }
    }
    return pass || best;
  }

  function drawHarpPin(tgt, hp, readonly) {
    const icon = L.divIcon({ className: '', html: '<div class="harp-pin"></div>', iconSize: [16, 16], iconAnchor: [8, 8] });
    const mk = L.marker([hp.lat, hp.lng], { icon, draggable: !readonly, zIndexOffset: 500 })
      .bindTooltip(readonly ? 'geplanter HARP (fixiert)' : 'geplanter HARP – verschiebbar');
    if (!readonly) {
      mk.on('dragend', () => {
        const q = mk.getLatLng();
        state.harp = { lat: q.lat, lng: q.lng };
        refreshHarp();
      });
    }
    mk.addTo(tgt.layer);
  }

  // nach HARP-Änderung beide Tabs nachziehen
  function refreshHarp() {
    if (!state.data) return;
    renderAnalysisMap(state.stats[state.t], params(), false);
    if (state.tab === 'briefing') renderBriefing();
  }

  // Koordinatenfelder + Bewertungszeile eines Tabs ('A' Analyse, 'B' Briefing)
  function renderHarpUI(sfx, s, p, c, hp, readonly) {
    const latEl = $('harpLat' + sfx), lonEl = $('harpLon' + sfx), mgrsEl = $('harpMgrs' + sfx);
    for (const el of [latEl, lonEl, mgrsEl, $('glide' + sfx), $('reset' + sfx)]) el.disabled = readonly;
    const evalEl = $('harpEval' + sfx);
    if (!s || !hp) { evalEl.textContent = ''; return; }
    latEl.value = hp.lat.toFixed(5);
    lonEl.value = hp.lng.toFixed(5);
    mgrsEl.value = toMgrs(hp.lat, hp.lng);
    mgrsEl.classList.remove('bad');
    const xy = harpXY(c, hp);
    const ev = harpEval(s, p, xy);
    let cls = ev.frac >= 0.9 ? 'green' : ev.frac >= 0.7 ? 'amber' : 'red';
    if (s.lowN && cls === 'green') cls = 'amber';
    const dist = Math.hypot(xy.x, xy.y);
    const brg = Math.round((Math.atan2(xy.x, xy.y) * 180 / Math.PI + 360) % 360);
    evalEl.innerHTML =
      `Geplanter HARP${(!readonly && !state.harp) ? ' (= Optimum)' : ''}: ` +
      `<span class="${cls}-text">${ev.hit} von ${ev.n} Membern (${Math.round(ev.frac * 100)} %)</span> erreichen das Ziel · ` +
      `<b>${fmtDist(dist)}</b> in Richtung <b>${String(brg).padStart(3, '0')}°</b> vom DIP` +
      (ev.worst > 0
        ? ` · schlechtestes Szenario: <b>${fmtDist(ev.worst)}</b> Schirmfahrt fehlen`
        : ' · alle Wetterszenarien gedeckt');
  }

  function renderAnalysisMap(s, p, fit = false) {
    if (!mapA) return;
    mapA.layer.clearLayers();
    if (!s) {
      $('mapInfo').textContent = ''; $('mapLegend').innerHTML = '';
      $('harpEvalA').textContent = '';
      return;
    }
    const tgt = {
      map: mapA.map, layer: mapA.layer, center: marker.getLatLng(),
      legend: $('mapLegend'), info: $('mapInfo'),
    };
    if (centerMoved(mapA, tgt.center)) fit = true;
    const hp = resolvedHarp(s, tgt.center);
    renderHarpUI('A', s, p, tgt.center, hp, false);
    const mode = mapMode();
    if (fit && mode !== 'zones') mapA.map.setView([tgt.center.lat, tgt.center.lng]);
    if (mode === 'zones') renderZones(tgt, s, p, { fit, harp: { pos: hp, readonly: false } });
    else if (mode === 'scatter') renderScatter(tgt, s, p);
    else renderPlanScatter(tgt, s, p, hp, false);
  }

  // Pfeil mit Spitze (zwei Widerhaken am Zielende), Koordinaten [lat, lng]
  function drawArrow(tgt, from, to, mPerDegLat, mPerDegLon, color, tip) {
    const line = L.polyline([from, to], { color, weight: 2.5 }).addTo(tgt.layer);
    if (tip) line.bindTooltip(tip);
    const east = (to[1] - from[1]) * mPerDegLon, north = (to[0] - from[0]) * mPerDegLat;
    const len0 = Math.hypot(east, north);
    if (len0 < 1) return;
    const th = Math.atan2(east, north);            // Peilung from → to
    const len = Math.min(200, 0.25 * len0);
    for (const dphi of [Math.PI * 5 / 6, -Math.PI * 5 / 6]) {
      const a = th + dphi;
      L.polyline([to, [to[0] + Math.cos(a) * len / mPerDegLat, to[1] + Math.sin(a) * len / mPerDegLon]],
        { color, weight: 2.5 }).addTo(tgt.layer);
    }
  }

  // Überdeckungsraster: Anteil der Member, deren Exitkreis den Punkt enthält.
  // opts.briefing: zusätzlich DIP-Marker und Driftpfeil, Info-Text in Springersprache
  function renderZones(tgt, s, p, opts = {}) {
    const c = tgt.center;
    const { mPerDegLat, mPerDegLon } = meterScale(c);
    const pts = s.exits;
    const R = p.tolerance;
    const extent = Math.max(...pts.map(e => Math.hypot(e.x, e.y))) + R * 1.1 + 200;

    const N = 180;
    const cell = 2 * extent / N;
    const cv = document.createElement('canvas');
    cv.width = N; cv.height = N;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(N, N);
    let maxCov = 0;
    for (let j = 0; j < N; j++) {
      const y = extent - (j + 0.5) * cell;          // Zeile 0 = Nordrand
      for (let i = 0; i < N; i++) {
        const x = -extent + (i + 0.5) * cell;
        let hit = 0;
        for (const e of pts) {
          if (Math.hypot(x - e.x, y - e.y) <= R) hit++;
        }
        const frac = hit / pts.length;
        if (frac > maxCov) maxCov = frac;
        const k = (j * N + i) * 4;
        let rgba = null;
        if (frac >= 0.9) rgba = [46, 158, 68, 115];
        else if (frac >= 0.7) rgba = [224, 164, 34, 100];
        else if (frac >= 0.5) rgba = [209, 64, 58, 75];
        if (rgba) { img.data[k] = rgba[0]; img.data[k + 1] = rgba[1]; img.data[k + 2] = rgba[2]; img.data[k + 3] = rgba[3]; }
      }
    }
    ctx.putImageData(img, 0, 0);

    const bounds = [
      [c.lat - extent / mPerDegLat, c.lng - extent / mPerDegLon],
      [c.lat + extent / mPerDegLat, c.lng + extent / mPerDegLon],
    ];
    L.imageOverlay(cv.toDataURL(), bounds, { opacity: 1 }).addTo(tgt.layer);

    // bei kleinen Ensembles die einzelnen Exitkreise zeichnen (Farbe je Modell)
    if (s.n <= 15) {
      const all = uniqueModels();
      s.exits.forEach((e, i) => {
        L.circle([c.lat + e.y / mPerDegLat, c.lng + e.x / mPerDegLon], {
          radius: R, weight: 1.3, fill: false,
          color: Charts.modelColor(Math.max(0, all.indexOf(s.exitModels[i])), 0.75),
        }).bindTooltip(modelLabel(s.exitModels[i])).addTo(tgt.layer);
      });
    }

    // HARP (Ensemble-Mittel) als Referenz
    const harpMean = [c.lat - s.meanDrift.y / mPerDegLat, c.lng - s.meanDrift.x / mPerDegLon];
    L.circleMarker(harpMean, { radius: 4, color: '#1c2733', weight: 2, fillColor: '#fff', fillOpacity: 1 })
      .bindTooltip('HARP (Ensemble-Mittel)').addTo(tgt.layer);

    // Optimaler HARP = Minimax-Punkt der HARPs, dazu die garantierte Zone
    const harpOpt = [c.lat + s.enc90.y / mPerDegLat, c.lng + s.enc90.x / mPerDegLon];
    const safeR = R - s.enc90.r;
    if (safeR > 0) {
      L.circle(harpOpt, { radius: safeR, color: '#14507e', weight: 2, dashArray: '6 6', fill: false })
        .bindTooltip('sichere Exitzone (≥ 90 % der Member)').addTo(tgt.layer);
    }
    L.circleMarker(harpOpt, { radius: 5, color: '#14507e', weight: 2, fillColor: '#14507e', fillOpacity: 1 })
      .bindTooltip('Optimaler HARP (Minimax)').addTo(tgt.layer);

    // Ziel (DIP) deutlich markieren
    L.marker([c.lat, c.lng]).bindTooltip('Ziel (DIP)').addTo(tgt.layer);

    // geplanter HARP als verschiebbarer Pin
    if (opts.harp) drawHarpPin(tgt, opts.harp.pos, opts.harp.readonly);

    if (opts.briefing && opts.harp) {
      // Winddrift als Pfeil: vom geplanten HARP zum erwarteten passiven Landepunkt
      const hp = opts.harp.pos;
      const drift = Math.hypot(s.meanDrift.x, s.meanDrift.y);
      const land = [hp.lat + s.meanDrift.y / mPerDegLat, hp.lng + s.meanDrift.x / mPerDegLon];
      drawArrow(tgt, [hp.lat, hp.lng], land, mPerDegLat, mPerDegLon, '#1c2733',
        `mittlere Winddrift ≈ ${fmtDist(drift)}: nur durch die Windverdriftung landest du etwa hier`);
      // Restlücke zum Ziel = Schirmfahrt aus eigener Fahrt
      const hxy = harpXY(c, hp);
      const needSteer = Math.hypot(hxy.x + s.meanDrift.x, hxy.y + s.meanDrift.y);
      if (needSteer > 30) {
        drawArrow(tgt, land, [c.lat, c.lng], mPerDegLat, mPerDegLon, '#2e9e44',
          `Schirmfahrt: ≈ ${fmtDist(needSteer)} fliegst du aus eigener Fahrt zum Ziel (Reserve: ${fmtDist(R)})`);
      }
    } else if (!opts.briefing) {
      L.polyline([[c.lat, c.lng], harpOpt], { color: '#475569', weight: 1.5, dashArray: '4 5' }).addTo(tgt.layer);
    }

    if (opts.fit) tgt.map.fitBounds(bounds);

    const dist = Math.hypot(s.enc90.x, s.enc90.y);
    const brg = Math.round((Math.atan2(s.enc90.x, s.enc90.y) * 180 / Math.PI + 360) % 360);
    tgt.legend.innerHTML =
      legendChip('rgba(46,158,68,0.55)', '≥ 90 % der Member') +
      legendChip('rgba(224,164,34,0.55)', '70–90 %') +
      legendChip('rgba(209,64,58,0.45)', '50–70 %') +
      legendChip('#14507e', 'optimaler HARP / sichere Zone') +
      (opts.harp ? legendChip('#7c3aed', 'geplanter HARP') : '');
    tgt.info.innerHTML = opts.briefing
      ? `Bester HARP (HARP, blauer Punkt): <b>${fmtDist(dist)}</b> in Richtung ` +
        `<b>${String(brg).padStart(3, '0')}°</b> vom Ziel. Grüne Fläche: Exit hier – und das Ziel bleibt ` +
        `nach fast allen Wettermodellen (≥ 90 %) erreichbar. Der Pfeil zeigt, wohin dich der Wind trägt. ` +
        (safeR > 0
          ? `Blau gestrichelt: sichere Exitzone (Radius <b>${fmtDist(safeR)}</b>) – hier reicht die Schirmfahrt in jedem Wetterszenario.`
          : `<span class="warn">Keine sichere Exitzone – bleib so nah wie möglich am HARP.</span>`)
      : `Exitkreis-Radius R = <b>${fmtDist(R)}</b> je Member. ` +
        `Optimaler HARP (Minimax) liegt <b>${fmtDist(dist)}</b> in Richtung <b>${String(brg).padStart(3, '0')}°</b> vom DIP. ` +
        (safeR > 0
          ? `Garantierte Exitzone (≥ 90 % der Member): Radius <b>${fmtDist(safeR)}</b> um den optimalen HARP.`
          : '<span class="warn">Keine sichere Exitzone – der Ensemble-Spread übersteigt die Korrekturreserve.</span>') +
        (maxCov < 0.999
          ? ` <span class="warn">Kein HARP wird von allen Membern gedeckt (max. ${Math.round(maxCov * 100)} %).</span>`
          : '') +
        (s.n <= 15 ? ' Dünne Kreise: Exitkreis je Member (Tooltip nennt das Modell).' : '');
  }

  // Landepunktwolke um den DIP (HARP auf Ensemble-Mittel geplant)
  function renderScatter(tgt, s, p) {
    const c = tgt.center;
    const { mPerDegLat, mPerDegLon } = meterScale(c);

    L.marker([c.lat, c.lng]).bindTooltip('Ziel (DIP)').addTo(tgt.layer);
    L.circle([c.lat, c.lng], {
      radius: p.tolerance, color: '#2e9e44', weight: 1.5,
      fillColor: '#2e9e44', fillOpacity: 0.06,
    }).addTo(tgt.layer);

    for (const o of s.offsets) {
      const inside = Math.hypot(o.x, o.y) <= p.tolerance;
      L.circleMarker([c.lat + o.y / mPerDegLat, c.lng + o.x / mPerDegLon], {
        radius: 3.5, stroke: false, fillOpacity: 0.75,
        fillColor: inside ? '#1d6fb8' : '#d1403a',
      }).addTo(tgt.layer);
    }

    const inTol = s.offsets.filter(o => Math.hypot(o.x, o.y) <= p.tolerance).length;
    tgt.legend.innerHTML =
      legendChip('#1d6fb8', 'DIP erreichbar (im Radius R)') +
      legendChip('#d1403a', 'außerhalb');
    tgt.info.innerHTML =
      `HARP auf dem Ensemble-Mittel geplant: <b>${inTol} von ${s.n} Membern (${Math.round(s.pTol * 100)} %)</b> ` +
      `innerhalb der korrigierbaren Strecke R = ${fmtDist(p.tolerance)}, ` +
      `90 % der Member näher als <b>${fmtDist(s.distP90)}</b> am Ziel.`;
  }

  // Landepunktwolke für den geplanten HARP: passive Landepunkte je Member,
  // blau = Ziel bleibt mit Schirmfahrt erreichbar, rot = nicht
  function renderPlanScatter(tgt, s, p, hp, readonly) {
    const c = tgt.center;
    const { mPerDegLat, mPerDegLon } = meterScale(c);
    const xy = harpXY(c, hp);
    const R = p.tolerance;

    L.marker([c.lat, c.lng]).bindTooltip('Ziel (DIP)').addTo(tgt.layer);
    L.circle([c.lat, c.lng], {
      radius: R, color: '#2e9e44', weight: 1.5,
      fillColor: '#2e9e44', fillOpacity: 0.06,
    }).bindTooltip('Schirmreserve R um das Ziel').addTo(tgt.layer);

    let inR = 0;
    for (const e of s.exits) {
      // passiver Landepunkt dieses Members: HARP + Drift, in Metern vom DIP
      const lx = xy.x - e.x, ly = xy.y - e.y;
      const inside = Math.hypot(lx, ly) <= R;
      if (inside) inR++;
      L.circleMarker([c.lat + ly / mPerDegLat, c.lng + lx / mPerDegLon], {
        radius: 3.5, stroke: false, fillOpacity: 0.75,
        fillColor: inside ? '#1d6fb8' : '#d1403a',
      }).addTo(tgt.layer);
    }

    drawHarpPin(tgt, hp, readonly);
    const drift = Math.hypot(s.meanDrift.x, s.meanDrift.y);
    const landMean = [hp.lat + s.meanDrift.y / mPerDegLat, hp.lng + s.meanDrift.x / mPerDegLon];
    drawArrow(tgt, [hp.lat, hp.lng], landMean, mPerDegLat, mPerDegLon, '#1c2733',
      `mittlere Winddrift ≈ ${fmtDist(drift)}: nur durch die Windverdriftung landest du etwa hier`);

    // die verbleibende Lücke zum Ziel schließt die Vorwärtsfahrt des Schirms
    const needSteer = Math.hypot(xy.x + s.meanDrift.x, xy.y + s.meanDrift.y);
    if (needSteer > 30) {
      drawArrow(tgt, landMean, [c.lat, c.lng], mPerDegLat, mPerDegLon, '#2e9e44',
        `Schirmfahrt: ≈ ${fmtDist(needSteer)} fliegst du aus eigener Fahrt zum Ziel (Reserve: ${fmtDist(R)})`);
    }

    tgt.legend.innerHTML =
      legendChip('#1d6fb8', 'Ziel erreichbar (Landepunkt im Radius R)') +
      legendChip('#d1403a', 'Ziel nicht erreichbar') +
      legendChip('#7c3aed', 'geplanter HARP') +
      legendChip('#1c2733', 'Winddrift') +
      legendChip('#2e9e44', 'Schirmfahrt zum Ziel');
    tgt.info.innerHTML =
      `Passive Landepunkte aller ${s.n} Member für einen Exit am geplanten HARP – also dort, wo du ` +
      `<b>als Rundkappe</b> ankämst. Die Punkte liegen bewusst nicht am Ziel: Die restliche Strecke ` +
      `(grüner Pfeil, ≈ <b>${fmtDist(needSteer)}</b>) fliegst du mit der Vorwärtsfahrt des Schirms. ` +
      `<b>${inR} von ${s.n} (${Math.round(inR / s.n * 100)} %)</b> der Landepunkte liegen innerhalb der Schirmreserve ` +
      `R = ${fmtDist(R)} um das Ziel – nur in diesen Szenarien reicht die Schirmfahrt bis zum DIP.`;
  }

  function renderTable(p) {
    const rows = Meteo.levelTable(activeData(), state.t, p);
    const aF = ALT_F[curAlt], sF = SPD_F[curSpd];
    const dec = curSpd === 'ms' ? 1 : 0;
    const fmt = r =>
      `<tr><td>${r.label}</td><td>${Math.round(r.hMSL * aF)}</td><td>${Math.round(r.hAGL * aF)}</td>` +
      `<td>${String(Math.round(r.dirMean)).padStart(3, '0')}° ± ${Math.round(r.dirSigma)}°</td>` +
      `<td>${(r.spdMean * sF).toFixed(dec)} ± ${(r.spdSigma * sF).toFixed(dec)}</td>` +
      `<td>${(r.spdMin * sF).toFixed(dec)} – ${(r.spdMax * sF).toFixed(dec)}</td></tr>`;
    $('levelTable').innerHTML =
      `<tr><th>Fläche</th><th>Höhe MSL (${curAlt})</th><th>Höhe AGL (${curAlt})</th>` +
      `<th>Richtung Ø ± σ</th><th>Wind Ø ± σ (${SPD_LBL[curSpd]})</th><th>Min – Max (${SPD_LBL[curSpd]})</th></tr>` +
      rows.map(fmt).join('');
  }

  // --- Springer-Briefing -------------------------------------------------
  // Datenquelle: fixierter Snapshot oder Live-Spiegel der Analyse-Auswahl
  function briefSource() {
    if (state.frozen) return state.frozen;
    const c = marker.getLatLng();
    const s = state.stats[state.t];
    const center = { lat: c.lat, lng: c.lng };
    return {
      s,
      p: params(),
      center,
      harp: s ? resolvedHarp(s, center) : null,
      time: fmtTime(state.t),
      model: $('model').selectedOptions[0].textContent.trim(),
    };
  }

  function renderBriefBanner() {
    const el = $('briefBannerText'), btn = $('freezeBtn'), wrap = $('briefBanner');
    if (state.frozen) {
      const f = state.frozen;
      const liveTime = fmtTime(state.t);
      const changed = f.time !== liveTime || f.pJson !== JSON.stringify(params());
      el.innerHTML = `<b>Fixiert:</b> ${f.time} · ${f.model} · eingefroren um ${f.frozenAt}` +
        (changed ? ` — <span class="warn">die Live-Analyse steht inzwischen auf ${liveTime}</span>` : '');
      btn.textContent = 'Fixierung aufheben';
      wrap.classList.add('frozen');
    } else {
      const b = briefSource();
      el.innerHTML = `<b>Live:</b> spiegelt die aktuelle Auswahl der Analyse – ${b.time} · ${b.model}`;
      btn.textContent = 'Briefing fixieren';
      wrap.classList.remove('frozen');
    }
  }

  // Verdikt bewertet den geplanten HARP (Rückfall: Minimax-Optimum, da
  // resolvedHarp ohne manuellen HARP automatisch dorthin fällt)
  function renderVerdict(s, p, c, hp) {
    const card = $('briefVerdict');
    if (!s || !hp) {
      card.innerHTML = '<p class="hint">Für diesen Termin liegen nicht genug Ensembledaten vor.</p>';
      return;
    }
    const xy = harpXY(c, hp);
    const ev = harpEval(s, p, xy);
    let cls = p.tolerance <= 0 ? 'red'
      : ev.frac >= 0.9 ? 'green' : ev.frac >= 0.7 ? 'amber' : 'red';
    if (s.lowN && cls === 'green') cls = 'amber';

    const pctM = `${ev.hit} von ${ev.n} Wettermodellen`;
    const sentence = p.tolerance <= 0
      ? '<b>Nicht planbar.</b> Mit diesen Schirmwerten bleibt keine Korrekturreserve (R = 0).'
      : cls === 'green'
        ? `<b>Sprung planbar.</b> Vom geplanten HARP erreichen ${pctM} das Ziel` +
          (ev.worst > 0
            ? ` – im schlechtesten Szenario fehlen ${fmtDist(ev.worst)} Schirmfahrt.`
            : ' – alle Wetterszenarien sind gedeckt.')
        : cls === 'amber'
          ? `<b>Machbar, aber mit Sorgfalt.</b> Nur ${pctM} erreichen vom geplanten HARP das Ziel; ` +
            `im schlechtesten Szenario fehlen ${fmtDist(ev.worst)} Schirmfahrt.`
          : `<b>Nicht empfohlen.</b> Nur ${pctM} erreichen vom geplanten HARP das Ziel – ` +
            `setze den HARP zurück („Optimum“) oder wähle einen anderen Termin.`;

    const safeR = Math.max(0, p.tolerance - s.enc90.r);
    const drift = Math.hypot(s.meanDrift.x, s.meanDrift.y);
    const driftDir = Math.round((Math.atan2(s.meanDrift.x, s.meanDrift.y) * 180 / Math.PI + 360) % 360);
    const harpDist = Math.hypot(xy.x, xy.y);
    const course = Math.round((Math.atan2(-xy.x, -xy.y) * 180 / Math.PI + 360) % 360);
    // erwarteter passiver Landepunkt = HARP + mittlere Drift; die Lücke zum
    // Ziel muss die Vorwärtsfahrt des Schirms schließen
    const needSteer = Math.hypot(xy.x + s.meanDrift.x, xy.y + s.meanDrift.y);

    card.innerHTML =
      `<div class="verdict">
         <div class="badge ${cls}"><span class="big">${Math.round(ev.frac * 100)} %</span>Member erreichen das Ziel</div>
         <p class="sentence">${sentence}</p>
       </div>` +
      (s.lowN
        ? `<p class="hint"><span class="warn">Nur ${s.n} Wettermodelle/Member verfügbar</span> – Aussage nur orientierend.</p>`
        : '') +
      `<div class="metrics facts">
         ${metric(`≈ ${fmtDist(harpDist)} · Kurs ${String(course).padStart(3, '0')}°`, 'Entfernung HARP → Ziel')}
         ${metric(`≈ ${fmtDist(drift)} → ${String(driftDir).padStart(3, '0')}°`, 'Winddrift (passiv, ohne Schirmfahrt)')}
         ${metric(`≈ ${fmtDist(needSteer)}`, 'nötige Schirmfahrt zum Ziel (mittleres Szenario)')}
         ${metric(fmtDist(p.tolerance), 'Schirmreserve R')}
         ${metric(safeR > 0 ? fmtDist(safeR) : 'keine', 'sichere Exitzone')}
       </div>
       <div class="metrics facts">
         ${metric(fmtWind(s.ff), 'Mittelwind Freifall')}
         ${metric(fmtWind(s.canopy), 'Mittelwind Schirmfahrt (Öffnung–Überhöhung)')}
         ${metric(fmtWind(s.ground), 'Bodenwind (10 m)')}
       </div>`;
  }

  function renderBriefing(fit = false) {
    if (!state.data) return;
    if (!mapB) { mapB = makeResultMap('mapBrief'); fit = true; }
    mapB.map.invalidateSize();

    const b = briefSource();
    const readonly = !!state.frozen;
    renderBriefBanner();
    renderVerdict(b.s, b.p, b.center, b.harp);
    renderHarpUI('B', b.s, b.p, b.center, b.harp, readonly);

    mapB.layer.clearLayers();
    const cvs = $('briefExplain');
    if (!b.s) {
      $('briefLegend').innerHTML = '';
      $('briefMapInfo').textContent = '';
      $('briefExplainLegend').innerHTML = '';
      $('briefExplainHint').textContent = '';
      cvs.getContext('2d').clearRect(0, 0, cvs.width, cvs.height);
      return;
    }
    const tgt = {
      map: mapB.map, layer: mapB.layer, center: b.center,
      legend: $('briefLegend'), info: $('briefMapInfo'),
    };
    if (centerMoved(mapB, b.center)) fit = true;
    const modeB = document.querySelector('input[name="mapModeB"]:checked').value;
    if (fit && modeB !== 'zones') mapB.map.setView([b.center.lat, b.center.lng]);
    if (modeB === 'zones') {
      renderZones(tgt, b.s, b.p, { fit, briefing: true, harp: { pos: b.harp, readonly } });
    } else {
      renderPlanScatter(tgt, b.s, b.p, b.harp, readonly);
    }

    Charts.driftExplain(cvs, b.s, b.p, unitCtx());
    $('briefExplainLegend').innerHTML =
      legendChip('rgba(29,111,184,0.8)', 'Drift vom Schirm ausgleichbar') +
      legendChip('rgba(209,64,58,0.85)', 'Drift zu groß für den Schirm') +
      legendChip('rgba(46,158,68,0.5)', `Schirmreserve R = ${fmtDist(b.p.tolerance)}`);
    $('briefExplainHint').innerHTML =
      `Jeder Punkt zeigt, wo dich der Wind nach Rechnung <b>eines</b> der ${b.s.n} Wettermodelle absetzen würde, ` +
      `wenn du am empfohlenen HARP aussteigst und nicht steuerst. Der grüne Kreis ist die Strecke, ` +
      `die dein Schirm aus eigener Fahrt wieder gutmachen kann. Rote Punkte außerhalb bedeuten: ` +
      `In diesem Wetterszenario reicht die Schirmfahrt nicht mehr bis zum Ziel.`;
  }

  // --- Tabs --------------------------------------------------------------
  function showTab(name, render = true) {
    state.tab = name;
    $('tabAnalyse').hidden = name !== 'analyse';
    $('tabBriefing').hidden = name !== 'briefing';
    for (const b of document.querySelectorAll('.tabs .tab')) {
      b.classList.toggle('active', b.dataset.tab === name);
    }
    if (!render || !state.data) return;
    if (name === 'analyse') {
      if (mapA) mapA.map.invalidateSize();
      renderAll();
    } else {
      renderBriefing();
    }
  }

  // --- Events ----------------------------------------------------------
  $('loadBtn').addEventListener('click', load);
  $('timeSlider').addEventListener('input', e => selectHour(+e.target.value));
  for (const id of ['exitAGL', 'openAGL', 'vFree', 'vCanopy', 'vFwd', 'margin']) {
    $(id).addEventListener('change', () => {
      updateRLabel();
      if (!state.data) return;
      computeStats();
      renderAll();
    });
  }
  for (const id of ['thrDistG', 'thrDistR', 'thrDirG', 'thrDirR']) {
    $(id).addEventListener('change', () => { if (state.data) renderAll(); });
  }
  for (const radio of document.querySelectorAll('input[name="mapMode"]')) {
    radio.addEventListener('change', () => {
      if (state.data) renderAnalysisMap(state.stats[state.t], params(), mapMode() === 'zones');
    });
  }
  for (const radio of document.querySelectorAll('input[name="mapModeB"]')) {
    radio.addEventListener('change', () => { if (state.data) renderBriefing(); });
  }
  // HARP-Koordinatenfelder und -Knöpfe (synchron in beiden Tabs)
  for (const sfx of ['A', 'B']) {
    const applyCoords = () => {
      if (!state.data) return;
      state.harp = { lat: +$('harpLat' + sfx).value, lng: +$('harpLon' + sfx).value };
      refreshHarp();
    };
    $('harpLat' + sfx).addEventListener('change', applyCoords);
    $('harpLon' + sfx).addEventListener('change', applyCoords);
    $('harpMgrs' + sfx).addEventListener('change', () => {
      if (!state.data) return;
      const el = $('harpMgrs' + sfx);
      const pos = fromMgrs(el.value);
      if (!pos) { el.classList.add('bad'); return; }
      el.classList.remove('bad');
      state.harp = pos;
      refreshHarp();
    });
    $('reset' + sfx).addEventListener('click', () => {
      state.harp = null;
      refreshHarp();
    });
    $('glide' + sfx).addEventListener('click', () => {
      const s = state.stats[state.t];
      if (!s) return;
      const g = glideHarp(s, params());
      if (!g) return;
      const c = marker.getLatLng();
      const { mPerDegLat, mPerDegLon } = meterScale(c);
      state.harp = { lat: c.lat + g.y / mPerDegLat, lng: c.lng + g.x / mPerDegLon };
      refreshHarp();
    });
  }
  for (const btn of document.querySelectorAll('.tabs .tab')) {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  }
  $('freezeBtn').addEventListener('click', () => {
    if (state.frozen) {
      state.frozen = null;
    } else {
      const b = briefSource();
      const now = new Date();
      state.frozen = {
        ...b,
        pJson: JSON.stringify(b.p),
        frozenAt: `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`,
      };
    }
    renderBriefing();
  });
  window.addEventListener('resize', () => {
    if (!state.data) return;
    state.tab === 'analyse' ? renderAll() : renderBriefing();
  });
  $('unitAlt').addEventListener('change', switchUnits);
  $('unitSpd').addEventListener('change', switchUnits);
  $('coordFmt').addEventListener('change', applyCoordFmt);
  $('dipMgrs').addEventListener('change', () => {
    const el = $('dipMgrs');
    const pos = fromMgrs(el.value);
    if (!pos) { el.classList.add('bad'); return; }
    el.classList.remove('bad');
    setLocation(pos.lat, pos.lng);
    map.setView([pos.lat, pos.lng]);
  });
  // --- Einstellungen dauerhaft merken (localStorage) ---------------------
  const PREF_KEY = 'harpcast.settings';
  const PREF_NUM = ['exitAGL', 'openAGL', 'vFree', 'vCanopy', 'vFwd', 'margin',
    'thrDistG', 'thrDistR', 'thrDirG', 'thrDirR'];

  function savePrefs() {
    const o = {
      unitAlt: $('unitAlt').value, unitSpd: $('unitSpd').value,
      coordFmt: $('coordFmt').value, model: $('model').value,
      lat: $('lat').value, lon: $('lon').value,
    };
    for (const id of PREF_NUM) o[id] = $(id).value;
    try { localStorage.setItem(PREF_KEY, JSON.stringify(o)); } catch (e) { /* z. B. Privatmodus */ }
  }

  function restorePrefs() {
    let o = null;
    try { o = JSON.parse(localStorage.getItem(PREF_KEY)); } catch (e) { /* ignorieren */ }
    if (!o) return;
    // Einheiten zuerst: switchUnits() rechnet die Defaultwerte um, danach
    // überschreiben die gespeicherten Werte (bereits in diesen Einheiten)
    if (o.unitAlt in ALT_F) $('unitAlt').value = o.unitAlt;
    if (o.unitSpd in SPD_F) $('unitSpd').value = o.unitSpd;
    switchUnits();
    for (const id of PREF_NUM) {
      if (o[id] !== '' && isFinite(+o[id])) $(id).value = o[id];
    }
    if ([...$('model').options].some(op => op.value === o.model)) $('model').value = o.model;
    if (['deg', 'mgrs'].includes(o.coordFmt)) $('coordFmt').value = o.coordFmt;
    const lat = +o.lat, lon = +o.lon;
    if (isFinite(lat) && isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180) {
      setLocation(lat, lon);
      map.setView([lat, lon]);
    }
  }

  window.addEventListener('pagehide', savePrefs);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePrefs();
  });

  restorePrefs();
  updateRLabel();
  applyCoordFmt();
})();
