'use strict';

/* Meteorologischer Kern: Parsing der Ensembledaten, Vertikalprofile,
   Mittelwind- und Versatz-Integration, Ensemble-Statistik. */
const Meteo = (() => {

  const LEVELS = [1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400];
  const GRID_STEP = 50;          // m, Integrationsschritt
  const MIN_MEMBERS = 2;         // unterhalb gilt die Stunde als ungültig
  // bei N < LOW_N sind alle Maße nur orientierend (UI kennzeichnet das)
  const LOW_N = 5;

  const toUV = (spd, dir) => {
    const r = dir * Math.PI / 180;
    return [-spd * Math.sin(r), -spd * Math.cos(r)];
  };

  const toSpdDir = (u, v) => [
    Math.hypot(u, v),
    (Math.atan2(-u, -v) * 180 / Math.PI + 360) % 360,
  ];

  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const percentileSorted = (sorted, p) => {
    const i = p * (sorted.length - 1);
    const lo = Math.floor(i), hi = Math.ceil(i);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
  };

  // Mittel und P10–P90-Bänder eines Windkollektivs: Betragsmittel und
  // -perzentile, zirkulares Richtungsmittel samt Streuung; das Richtungsband
  // über Perzentile der kürzesten Abweichung vom zirkularen Mittel,
  // zurückgedreht auf absolute Richtungen
  function windBand(spds, dirs) {
    const cs = circStats(dirs);
    const sorted = [...spds].sort((a, b) => a - b);
    const devs = dirs.map(d => ((d - cs.mean + 540) % 360) - 180).sort((a, b) => a - b);
    return {
      spd: mean(spds),
      dir: cs.mean,
      dirSigma: cs.sigma,
      spdP10: percentileSorted(sorted, 0.1),
      spdP90: percentileSorted(sorted, 0.9),
      dirP10: (cs.mean + percentileSorted(devs, 0.1) + 360) % 360,
      dirP90: (cs.mean + percentileSorted(devs, 0.9) + 360) % 360,
    };
  }

  // Zirkulare Statistik über Richtungen in Grad (Mardia-Standardabweichung)
  function circStats(dirs) {
    let su = 0, sv = 0;
    for (const d of dirs) {
      const r = d * Math.PI / 180;
      su += Math.sin(r); sv += Math.cos(r);
    }
    su /= dirs.length; sv /= dirs.length;
    const R = Math.min(1, Math.hypot(su, sv));
    const m = (Math.atan2(su, sv) * 180 / Math.PI + 360) % 360;
    const sigma = R > 1e-9 ? Math.min(180, Math.sqrt(-2 * Math.log(R)) * 180 / Math.PI) : 180;
    return { mean: m, sigma };
  }

  // Umkreis dreier Punkte; bei Kollinearität das weiteste Paar
  function circum(a, b, c) {
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-9) {
      let best = null;
      for (const [p, q] of [[a, b], [a, c], [b, c]]) {
        const r = Math.hypot(p.x - q.x, p.y - q.y) / 2;
        if (!best || r > best.r) best = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, r };
      }
      return best;
    }
    const a2 = a.x * a.x + a.y * a.y, b2 = b.x * b.x + b.y * b.y, c2 = c.x * c.x + c.y * c.y;
    const ux = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
    const uy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
    return { x: ux, y: uy, r: Math.hypot(a.x - ux, a.y - uy) };
  }

  // Kleinster umschließender Kreis (Welzl, inkrementell); Zentrum = Minimax-Punkt
  function enclosingCircle(pts) {
    const inC = (c, q) => c && Math.hypot(q.x - c.x, q.y - c.y) <= c.r + 1e-7;
    const two = (p, q) => ({ x: (p.x + q.x) / 2, y: (p.y + q.y) / 2, r: Math.hypot(p.x - q.x, p.y - q.y) / 2 });
    let c = null;
    for (let i = 0; i < pts.length; i++) {
      if (inC(c, pts[i])) continue;
      c = { x: pts[i].x, y: pts[i].y, r: 0 };
      for (let j = 0; j < i; j++) {
        if (inC(c, pts[j])) continue;
        c = two(pts[i], pts[j]);
        for (let k = 0; k < j; k++) {
          if (!inC(c, pts[k])) c = circum(pts[i], pts[j], pts[k]);
        }
      }
    }
    return c;
  }

  // Robust gegen Ausreißer-Member: nur der zentrumsnächste Anteil frac wird umschlossen
  function robustEnclosing(pts, frac) {
    const mx = mean(pts.map(p => p.x)), my = mean(pts.map(p => p.y));
    const keep = [...pts]
      .sort((a, b) => Math.hypot(a.x - mx, a.y - my) - Math.hypot(b.x - mx, b.y - my))
      .slice(0, Math.max(3, Math.round(frac * pts.length)));
    return enclosingCircle(keep);
  }

  function buildUrl(lat, lon, model, deterministic = false) {
    const vars = ['wind_speed_10m', 'wind_direction_10m'];
    for (const L of LEVELS) {
      vars.push(`wind_speed_${L}hPa`, `wind_direction_${L}hPa`, `geopotential_height_${L}hPa`);
    }
    const base = deterministic
      ? 'https://api.open-meteo.com/v1/forecast'    // Hauptläufe
      : 'https://ensemble-api.open-meteo.com/v1/ensemble';
    return base +
      `?latitude=${lat}&longitude=${lon}&models=${model}` +
      `&hourly=${vars.join(',')}` +
      '&wind_speed_unit=ms&forecast_days=5&timezone=auto';
  }

  function parse(json) {
    const h = json.hourly;
    // Modelle außerhalb ihrer Domäne lässt die API meist weg, liefert sie
    // vereinzelt aber als reine null-Spalten mit (z. B. icon_d2) – solche
    // Member ohne einen einzigen Wert werden hier verworfen
    const hasAny = a => Array.isArray(a) && a.some(v => v != null);
    const alive = s => hasAny(h['wind_speed_10m' + s]) ||
      LEVELS.some(L => hasAny(h[`wind_speed_${L}hPa` + s]));
    // Suffix je Member aus den Keys ableiten; deckt Einzelmodell ('' bzw.
    // '_memberNN') und Multi-Modell ('_memberNN_<modell>') gleichermaßen ab
    const suffixes = [];
    for (const k of Object.keys(h)) {
      if (!k.startsWith('wind_speed_10m')) continue;
      const s = k.slice('wind_speed_10m'.length);
      if (alive(s)) suffixes.push(s);
    }
    // Modellkennung je Member ('' bei Einzelmodell-Anfrage)
    const memberModel = suffixes.map(s => s.replace(/^_member\d+/, '').replace(/^_/, ''));
    return {
      h,
      suffixes,
      memberModel,
      times: h.time,
      elevation: json.elevation,
      tzAbbr: json.timezone_abbreviation,
    };
  }

  // Vertikalprofil eines Members zur Stunde t: [{h(m MSL), u, v}], aufsteigend
  function profile(data, mi, t) {
    const s = data.suffixes[mi], h = data.h;
    const pts = [];
    const sSpd = h['wind_speed_10m' + s], sDir = h['wind_direction_10m' + s];
    if (sSpd && sSpd[t] != null && sDir && sDir[t] != null) {
      const [u, v] = toUV(sSpd[t], sDir[t]);
      pts.push({ h: data.elevation + 10, u, v });
    }
    for (const L of LEVELS) {
      const spd = h[`wind_speed_${L}hPa` + s];
      const dir = h[`wind_direction_${L}hPa` + s];
      const gh = h[`geopotential_height_${L}hPa` + s];
      if (!spd || !dir || !gh) continue;
      if (spd[t] == null || dir[t] == null || gh[t] == null) continue;
      if (gh[t] < data.elevation + 20) continue;  // Druckfläche liegt unter Grund
      const [u, v] = toUV(spd[t], dir[t]);
      pts.push({ h: gh[t], u, v });
    }
    pts.sort((a, b) => a.h - b.h);
    return pts;
  }

  // Lineare Interpolation von u/v auf Höhe (m MSL), an den Rändern konstant
  function interp(pts, hMSL) {
    if (hMSL <= pts[0].h) return [pts[0].u, pts[0].v];
    const last = pts[pts.length - 1];
    if (hMSL >= last.h) return [last.u, last.v];
    let i = 1;
    while (pts[i].h < hMSL) i++;
    const a = pts[i - 1], b = pts[i];
    const f = (hMSL - a.h) / (b.h - a.h);
    return [a.u + f * (b.u - a.u), a.v + f * (b.v - a.v)];
  }

  // Vektorieller Mittelwind Boden→Exit und Windversatz (Freifall + Schirm);
  // zusätzlich Segment-Mittelwinde für das Briefing (Freifall bzw.
  // Schirmphase zwischen Überhöhung und Öffnungshöhe)
  function integrate(pts, elev, p) {
    let su = 0, sv = 0, n = 0, dx = 0, dy = 0;
    let fu = 0, fv = 0, fn = 0, cu = 0, cv = 0, cn = 0;
    for (let hAGL = 0; hAGL + GRID_STEP <= p.exitAGL; hAGL += GRID_STEP) {
      const hm = hAGL + GRID_STEP / 2;
      const [u, v] = interp(pts, elev + hm);
      su += u; sv += v; n++;
      const free = hm > p.openAGL;
      const dt = GRID_STEP / (free ? p.vFree : p.vCanopy);
      dx += u * dt; dy += v * dt;
      if (free) { fu += u; fv += v; fn++; }
      else if (hm >= p.margin) { cu += u; cv += v; cn++; }
    }
    return {
      mu: su / n, mv: sv / n, dx, dy,
      ffu: fn ? fu / fn : null, ffv: fn ? fv / fn : null,
      cau: cn ? cu / cn : null, cav: cn ? cv / cn : null,
    };
  }

  // Ensemble-Mittel des 10-m-Bodenwinds zur Stunde t
  function groundWind(data, t) {
    const spds = [], dirs = [];
    for (const s of data.suffixes) {
      const sp = data.h['wind_speed_10m' + s], di = data.h['wind_direction_10m' + s];
      if (sp && sp[t] != null && di && di[t] != null) { spds.push(sp[t]); dirs.push(di[t]); }
    }
    return spds.length ? { spd: mean(spds), dir: circStats(dirs).mean } : null;
  }

  // Ensemble-Statistik für eine Stunde: Mittelwind, Streuung, Versatz-Offsets
  function hourStats(data, t, p) {
    const members = [], memModels = [];
    for (let mi = 0; mi < data.suffixes.length; mi++) {
      const pts = profile(data, mi, t);
      if (pts.length < 3) continue;
      members.push(integrate(pts, data.elevation, p));
      memModels.push(data.memberModel ? data.memberModel[mi] : '');
    }
    if (members.length < MIN_MEMBERS) return null;

    const mdx = mean(members.map(m => m.dx));
    const mdy = mean(members.map(m => m.dy));
    const offsets = members.map(m => ({ x: m.dx - mdx, y: m.dy - mdy }));
    const dists = offsets.map(o => Math.hypot(o.x, o.y));

    // HARPs je Member (Offset vom DIP) und deren Minimax-Umkreis
    const exits = members.map(m => ({ x: -m.dx, y: -m.dy }));
    const enc90 = robustEnclosing(exits, 0.9);
    const distP90 = percentileSorted([...dists].sort((a, b) => a - b), 0.9);

    // Segmentwind über die Member (Mittel + P10–P90-Bänder, s. windBand)
    const segWind = (uk, vk) => {
      const sel = members.filter(m => m[uk] != null);
      if (!sel.length) return null;
      return windBand(
        sel.map(m => Math.hypot(m[uk], m[vk])),
        sel.map(m => toSpdDir(m[uk], m[vk])[1]));
    };
    const total = segWind('mu', 'mv');

    return {
      ff: segWind('ffu', 'ffv'),
      canopy: segWind('cau', 'cav'),
      total,
      ground: groundWind(data, t),
      n: members.length,
      // σ_θ des Mittelwinds Boden–Exit → Kriterium der Meteo-Ampel
      sigmaDir: total.dirSigma,
      meanDrift: { x: mdx, y: mdy },
      offsets,
      exits,
      exitModels: memModels,
      lowN: members.length < LOW_N,
      enc90,
      pTol: dists.filter(d => d <= p.tolerance).length / dists.length,
      distP90,
      reserveUse: p.tolerance > 0 ? distP90 / p.tolerance : Infinity,
    };
  }

  // Profildaten für die Höhencharts (Spaghetti + Band) zur Stunde t
  function profileChartData(data, t, p) {
    const grid = [];
    for (let h = 0; h <= p.exitAGL; h += 100) grid.push(h);

    const lines = [], dirLines = [], lineModels = [];
    for (let mi = 0; mi < data.suffixes.length; mi++) {
      const pts = profile(data, mi, t);
      if (pts.length < 3) continue;
      const spd = [], dir = [];
      for (const h of grid) {
        const [u, v] = interp(pts, data.elevation + h);
        const sd = toSpdDir(u, v);
        spd.push(sd[0]); dir.push(sd[1]);
      }
      lines.push(spd); dirLines.push(dir); lineModels.push(data.memberModel[mi]);
    }
    if (lines.length < MIN_MEMBERS) return null;

    const meanL = [], p10 = [], p90 = [], meanDirL = [];
    for (let i = 0; i < grid.length; i++) {
      const col = lines.map(l => l[i]).sort((a, b) => a - b);
      meanL.push(mean(col));
      p10.push(percentileSorted(col, 0.1));
      p90.push(percentileSorted(col, 0.9));
      meanDirL.push(circStats(dirLines.map(l => l[i])).mean);
    }
    return { grid, lines, dirLines, lineModels, mean: meanL, p10, p90, meanDir: meanDirL };
  }

  // Tabellenzeilen je Druckfläche (direkt aus Leveldaten, ohne Interpolation)
  function levelTable(data, t, p) {
    const rows = [];
    const collect = (spdKey, dirKey, ghKey, label) => {
      const spds = [], dirs = [], ghs = [];
      for (const s of data.suffixes) {
        const spd = data.h[spdKey + s], dir = data.h[dirKey + s];
        if (!spd || spd[t] == null || !dir || dir[t] == null) continue;
        if (ghKey) {
          const gh = data.h[ghKey + s];
          if (!gh || gh[t] == null) continue;
          ghs.push(gh[t]);
        }
        spds.push(spd[t]); dirs.push(dir[t]);
      }
      if (spds.length < MIN_MEMBERS) return;
      const hMSL = ghKey ? mean(ghs) : data.elevation + 10;
      const hAGL = hMSL - data.elevation;
      if (ghKey && (hAGL < 20 || hAGL > p.exitAGL + 1500)) return;
      rows.push({
        label,
        hMSL, hAGL,
        ...windBand(spds, dirs),
        spdMin: Math.min(...spds), spdMax: Math.max(...spds),
      });
    };
    for (const L of LEVELS) {
      collect(`wind_speed_${L}hPa`, `wind_direction_${L}hPa`, `geopotential_height_${L}hPa`, `${L} hPa`);
    }
    collect('wind_speed_10m', 'wind_direction_10m', null, 'Boden (10 m)');
    rows.sort((a, b) => b.hMSL - a.hMSL);
    return rows;
  }

  return { LEVELS, buildUrl, parse, hourStats, profileChartData, levelTable, toSpdDir };
})();
