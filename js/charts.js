'use strict';

/* Canvas-Rendering: Vertikalprofile (Spaghetti + Band), Zeitreihe, Ampelstreifen. */
const Charts = (() => {

  const C = {
    member: 'rgba(29, 111, 184, 0.13)',
    memberDot: 'rgba(29, 111, 184, 0.22)',
    mean: '#14507e',
    band: 'rgba(29, 111, 184, 0.16)',
    axis: '#94a3b8',
    grid: '#e6ebf1',
    text: '#475569',
    marker: '#d1403a',
    green: '#2e9e44',
    amber: '#e0a422',
    red: '#d1403a',
    invalid: '#cbd5e1',
  };

  // je ein Farbton pro Modell (Multi-Modell / Hauptläufe), bis 11 unterscheidbar
  const HUES = [210, 27, 276, 174, 96, 330, 52, 240, 0, 150, 312];
  const modelColor = (k, a) => `hsla(${HUES[k % HUES.length]}, 62%, 42%, ${a})`;

  function setup(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.font = '11px sans-serif';
    return { ctx, w, h };
  }

  function niceMax(v) {
    if (v <= 0) return 1;
    const step = v <= 10 ? 2 : v <= 25 ? 5 : 10;
    return Math.ceil(v / step) * step;
  }

  function frame(ctx, m, w, h, xTicks, yTicks, xFmt, yFmt, xLabel) {
    ctx.strokeStyle = C.grid;
    ctx.fillStyle = C.text;
    ctx.lineWidth = 1;
    for (const t of xTicks) {
      const x = m.x(t);
      ctx.beginPath(); ctx.moveTo(x, m.t); ctx.lineTo(x, h - m.b); ctx.stroke();
      ctx.textAlign = 'center';
      ctx.fillText(xFmt(t), x, h - m.b + 14);
    }
    for (const t of yTicks) {
      const y = m.y(t);
      ctx.beginPath(); ctx.moveTo(m.l, y); ctx.lineTo(w - m.r, y); ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText(yFmt(t), m.l - 6, y + 4);
    }
    ctx.strokeStyle = C.axis;
    ctx.strokeRect(m.l, m.t, w - m.l - m.r, h - m.t - m.b);
    if (xLabel) {
      ctx.textAlign = 'center';
      ctx.fillText(xLabel, m.l + (w - m.l - m.r) / 2, h - 4);
    }
  }

  // Einheitenkontext: Faktoren/Labels für Anzeige (Default: metrisch)
  const defU = { spdF: 1, spdLbl: 'm/s', altF: 1, altLbl: 'm', altTick: 1000 };

  // Geschwindigkeitsprofil: x = Windgeschwindigkeit, y = Höhe AGL (Anzeigeeinheit)
  function speedProfile(canvas, d, u = defU) {
    const { ctx, w, h } = setup(canvas);
    const ml = { l: 52, r: 14, t: 10, b: 34 };
    const grid = d.grid.map(g => g * u.altF);
    const xMax = niceMax(Math.max(...d.lines.flat()) * u.spdF * 1.05);
    const yMax = grid[grid.length - 1];
    ml.x = v => ml.l + v / xMax * (w - ml.l - ml.r);
    ml.y = v => h - ml.b - v / yMax * (h - ml.t - ml.b);

    const xTicks = [];
    for (let v = 0; v <= xMax; v += xMax <= 12 ? 2 : xMax <= 30 ? 5 : 10) xTicks.push(v);
    const yTicks = [];
    for (let v = 0; v <= yMax; v += u.altTick) yTicks.push(v);
    frame(ctx, ml, w, h, xTicks, yTicks, v => v, v => v, `Windgeschwindigkeit (${u.spdLbl})`);

    // 10–90-%-Band
    ctx.fillStyle = C.band;
    ctx.beginPath();
    grid.forEach((g, i) => i ? ctx.lineTo(ml.x(d.p10[i] * u.spdF), ml.y(g)) : ctx.moveTo(ml.x(d.p10[i] * u.spdF), ml.y(g)));
    for (let i = grid.length - 1; i >= 0; i--) ctx.lineTo(ml.x(d.p90[i] * u.spdF), ml.y(grid[i]));
    ctx.closePath(); ctx.fill();

    const models = d.lineModels ? [...new Set(d.lineModels)] : [];
    // Farbindex über die ungefilterte Modellliste → stabil bei Abwahl
    const all = d.allModels || models;
    const multi = models.length > 1;
    // wenige Member (Hauptläufe) kräftig zeichnen, große Ensembles transparent
    const few = d.lines.length <= 20;
    ctx.lineWidth = few ? 1.6 : 1;
    d.lines.forEach((line, li) => {
      ctx.strokeStyle = multi
        ? modelColor(all.indexOf(d.lineModels[li]), few ? 0.85 : 0.14)
        : C.member;
      ctx.beginPath();
      grid.forEach((g, i) => i ? ctx.lineTo(ml.x(line[i] * u.spdF), ml.y(g)) : ctx.moveTo(ml.x(line[i] * u.spdF), ml.y(g)));
      ctx.stroke();
    });

    ctx.strokeStyle = C.mean;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    grid.forEach((g, i) => i ? ctx.lineTo(ml.x(d.mean[i] * u.spdF), ml.y(g)) : ctx.moveTo(ml.x(d.mean[i] * u.spdF), ml.y(g)));
    ctx.stroke();

    // Mini-Legende der Modelle (nur Multi-Modell)
    if (multi && d.modelLabels) {
      let ly = ml.t + 14;
      ctx.textAlign = 'left';
      models.forEach((mo, k) => {
        const x0 = w - ml.r - 130;
        ctx.strokeStyle = modelColor(all.indexOf(mo), 1);
        ctx.lineWidth = 2.5;
        ctx.beginPath(); ctx.moveTo(x0, ly - 4); ctx.lineTo(x0 + 18, ly - 4); ctx.stroke();
        ctx.fillStyle = C.text;
        ctx.fillText(d.modelLabels[mo] || mo, x0 + 24, ly);
        ly += 15;
      });
    }
  }

  // Richtungsprofil: x = 0–360°, y = Höhe AGL, Member als Punkte
  function dirProfile(canvas, d, u = defU) {
    const { ctx, w, h } = setup(canvas);
    const ml = { l: 52, r: 14, t: 10, b: 34 };
    const grid = d.grid.map(g => g * u.altF);
    const yMax = grid[grid.length - 1];
    ml.x = v => ml.l + v / 360 * (w - ml.l - ml.r);
    ml.y = v => h - ml.b - v / yMax * (h - ml.t - ml.b);

    const yTicks = [];
    for (let v = 0; v <= yMax; v += u.altTick) yTicks.push(v);
    frame(ctx, ml, w, h, [0, 90, 180, 270, 360], yTicks,
      v => `${v}°`, v => v, 'Windrichtung');

    const models = d.lineModels ? [...new Set(d.lineModels)] : [];
    const all = d.allModels || models;
    const multi = models.length > 1;
    const few = d.dirLines.length <= 20;
    d.dirLines.forEach((line, li) => {
      ctx.fillStyle = multi
        ? modelColor(all.indexOf(d.lineModels[li]), few ? 0.9 : 0.26)
        : C.memberDot;
      for (let i = 0; i < grid.length; i++) {
        ctx.beginPath();
        ctx.arc(ml.x(line[i]), ml.y(grid[i]), few ? 2.2 : 1.6, 0, 2 * Math.PI);
        ctx.fill();
      }
    });

    // Zirkulares Mittel, mit Pfadbruch beim 0°/360°-Übergang
    ctx.strokeStyle = C.mean;
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    let started = false;
    for (let i = 0; i < grid.length; i++) {
      if (i > 0 && Math.abs(d.meanDir[i] - d.meanDir[i - 1]) > 180) started = false;
      const x = ml.x(d.meanDir[i]), y = ml.y(grid[i]);
      started ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      started = true;
    }
    ctx.stroke();
  }

  // Zeitreihe des Mittelwinds mit 10–90-%-Band; gibt x→Stundenindex zurück
  function timeSeries(canvas, times, stats, selIdx, u = defU) {
    const { ctx, w, h } = setup(canvas);
    const ml = { l: 46, r: 12, t: 8, b: 30 };
    const n = times.length;
    const valid = stats.filter(s => s);
    const yMax = niceMax(Math.max(1, ...valid.map(s => s.p90)) * u.spdF * 1.1);
    ml.x = i => ml.l + i / (n - 1) * (w - ml.l - ml.r);
    ml.y = v => h - ml.b - v / yMax * (h - ml.t - ml.b);

    const yTicks = [];
    for (let v = 0; v <= yMax; v += yMax <= 12 ? 2 : yMax <= 30 ? 5 : 10) yTicks.push(v);
    frame(ctx, ml, w, h, [], yTicks, v => v, v => v, null);

    // Tagesgrenzen + Datumslabel
    ctx.fillStyle = C.text;
    ctx.textAlign = 'left';
    for (let i = 0; i < n; i++) {
      if (times[i].endsWith('T00:00') || i === 0) {
        const x = ml.x(i);
        ctx.strokeStyle = C.axis;
        ctx.beginPath(); ctx.moveTo(x, ml.t); ctx.lineTo(x, h - ml.b); ctx.stroke();
        const [, mo, day] = times[i].slice(0, 10).split('-');
        ctx.fillText(`${day}.${mo}.`, x + 3, h - ml.b + 14);
      }
    }

    const segments = [];
    let seg = null;
    for (let i = 0; i < n; i++) {
      if (stats[i]) { (seg = seg || []).push(i); }
      else if (seg) { segments.push(seg); seg = null; }
    }
    if (seg) segments.push(seg);

    for (const s of segments) {
      ctx.fillStyle = C.band;
      ctx.beginPath();
      s.forEach((i, k) => k ? ctx.lineTo(ml.x(i), ml.y(stats[i].p10 * u.spdF)) : ctx.moveTo(ml.x(i), ml.y(stats[i].p10 * u.spdF)));
      for (let k = s.length - 1; k >= 0; k--) ctx.lineTo(ml.x(s[k]), ml.y(stats[s[k]].p90 * u.spdF));
      ctx.closePath(); ctx.fill();

      ctx.strokeStyle = C.mean;
      ctx.lineWidth = 2;
      ctx.beginPath();
      s.forEach((i, k) => k ? ctx.lineTo(ml.x(i), ml.y(stats[i].meanSpd * u.spdF)) : ctx.moveTo(ml.x(i), ml.y(stats[i].meanSpd * u.spdF)));
      ctx.stroke();
    }

    // Marker für gewählten Termin
    ctx.strokeStyle = C.marker;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(ml.x(selIdx), ml.t);
    ctx.lineTo(ml.x(selIdx), h - ml.b);
    ctx.stroke();

    ctx.fillStyle = C.text;
    ctx.textAlign = 'left';
    ctx.fillText(u.spdLbl, 6, ml.t + 8);

    return x => Math.max(0, Math.min(n - 1, Math.round((x - ml.l) / (w - ml.l - ml.r) * (n - 1))));
  }

  // Ampelstreifen: eine Zelle je Stunde, kontinuierlich gefärbt nach
  // Reserve-Verbrauch (0 = grün, ≥ 1 = rot)
  function qualityStrip(canvas, stats, selIdx) {
    const { ctx, w, h } = setup(canvas);
    const n = stats.length;
    const cw = w / n;
    for (let i = 0; i < n; i++) {
      const s = stats[i];
      if (!s) {
        ctx.fillStyle = C.invalid;
      } else {
        const u = Math.max(0, Math.min(1, s.reserveUse));
        ctx.fillStyle = `hsl(${Math.round(120 * (1 - u))}, 62%, 44%)`;
      }
      ctx.fillRect(i * cw, 0, Math.ceil(cw), h);
    }
    ctx.strokeStyle = '#1c2733';
    ctx.lineWidth = 2;
    ctx.strokeRect(selIdx * cw, 1, Math.max(2, cw), h - 2);
    return x => Math.max(0, Math.min(n - 1, Math.floor(x / cw)));
  }

  // Erklärgrafik fürs Springer-Briefing: passive Drift-Landepunkte der Member
  // um den DIP, darübergelegt der Schirmkreis (Korrekturbudget R)
  function driftExplain(canvas, s, p, u = defU) {
    const { ctx, w, h } = setup(canvas);
    const R = p.tolerance;
    const maxOff = Math.max(1, ...s.offsets.map(o => Math.hypot(o.x, o.y)));
    const extent = Math.max(R, maxOff) * 1.2;
    const cx = w / 2, cy = h / 2;
    const sc = (Math.min(w, h) / 2 - 26) / extent;   // px pro Meter

    // Schirmkreis (das kann der Schirm ausgleichen)
    if (R > 0) {
      ctx.fillStyle = 'rgba(46, 158, 68, 0.10)';
      ctx.strokeStyle = C.green;
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(cx, cy, R * sc, 0, 2 * Math.PI);
      ctx.fill(); ctx.stroke();
    }

    // Landepunkte je Member (reine Winddrift, Exit am Ensemble-Mittel-HARP)
    for (const o of s.offsets) {
      const inside = Math.hypot(o.x, o.y) <= R;
      ctx.fillStyle = inside ? 'rgba(29, 111, 184, 0.8)' : 'rgba(209, 64, 58, 0.85)';
      ctx.beginPath(); ctx.arc(cx + o.x * sc, cy - o.y * sc, 4, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Ziel (DIP) im Zentrum
    ctx.fillStyle = '#fff';
    ctx.strokeStyle = '#1c2733';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(cx, cy, 5.5, 0, 2 * Math.PI);
    ctx.fill(); ctx.stroke();

    ctx.font = '12px sans-serif';
    ctx.fillStyle = C.text;
    ctx.textAlign = 'center';
    ctx.fillText('Ziel (DIP)', cx, cy + 22);
    if (R * sc > 50) {
      ctx.fillStyle = C.green;
      ctx.fillText(`Schirmreserve R = ${Math.round(R * u.altF)} ${u.altLbl}`, cx, cy - R * sc - 8);
    }

    // Maßstabsbalken unten links (in der Anzeigeeinheit)
    const nice = [100, 200, 500, 1000, 2000, 5000, 10000, 20000]
      .find(v => v / u.altF * sc > 70) || 20000;   // nice in Anzeigeeinheit
    const px = nice / u.altF * sc;
    const y0 = h - 16, x0 = 16;
    ctx.strokeStyle = C.text;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 4); ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + px, y0); ctx.lineTo(x0 + px, y0 - 4);
    ctx.stroke();
    ctx.fillStyle = C.text;
    ctx.textAlign = 'left';
    ctx.fillText(u.altLbl === 'm' && nice >= 1000 ? `${nice / 1000} km` : `${nice} ${u.altLbl}`,
      x0 + px + 6, y0 + 1);
  }

  return { speedProfile, dirProfile, timeSeries, qualityStrip, modelColor, driftExplain };
})();
