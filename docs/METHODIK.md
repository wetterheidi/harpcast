# HARPCast – Methodik

Dieses Dokument beschreibt die vollständige Rechenkette des Tools: von den
Ensemble-Rohdaten bis zu den Zuverlässigkeitsmaßen. Jede Formel entspricht
exakt der Implementierung (Funktionsverweise auf `js/meteo.js` bzw.
`js/app.js`). Alle Annahmen sind nummeriert (A1–A12) und in Abschnitt 9
hinsichtlich ihrer Gültigkeitsgrenzen diskutiert.

**Konventionen und Einheiten:** Längen in Metern, Geschwindigkeiten in m/s,
Richtungen in Grad rechtweisend (Windrichtung = Richtung, *aus* der der Wind
weht). Koordinaten lokal kartesisch: $x$ nach Ost, $y$ nach Nord.
Höhenangaben: MSL = über Meeresspiegel, AGL = über Grund.

---

## 1. Datenbasis

Quelle: [Open-Meteo Ensemble API](https://ensemble-api.open-meteo.com/v1/ensemble)
(`buildUrl`). Abgerufen werden je Ensemble-Member:

| Variable | Druckflächen | Bedeutung |
|---|---|---|
| `wind_speed_{L}hPa`, `wind_direction_{L}hPa` | 1000, 975, 950, 925, 900, 850, 800, 700, 600, 500, 400 hPa | Horizontalwind auf der Druckfläche |
| `geopotential_height_{L}hPa` | dito | Geopotentielle Höhe der Druckfläche (m) |
| `wind_speed_10m`, `wind_direction_10m` | – | Bodenwind in 10 m AGL |

Parameter: `wind_speed_unit=ms`, `forecast_days=5`, `timezone=auto`.

Verfügbare Modelle mit Druckflächen-Ensembledaten (Stand der API-Prüfung):

- **ECMWF IFS ENS 0,25°** (`ecmwf_ifs025`): 51 Member (Kontrolllauf + 50 gestörte Läufe)
- **ECMWF AIFS ENS 0,25°** (`ecmwf_aifs025`): 51 Member (KI-basiertes Ensemble)
- **NOAA GEFS 0,5°** (`gfs05`): 31 Member

Keine Druckflächen-*Werte* liefern: die ICON-EPS-Modelle (D2/EU/Global),
GEM, ACCESS, UKMO sowie **GEFS 0,25°** (`gfs025` deklariert die Variablen,
liefert aber ausschließlich `null` – bei einer Prüfung müssen die Werte
kontrolliert werden, nicht nur das Vorhandensein der Schlüssel).

**Member-Kodierung** (`parse`): Der Variablenname ohne Suffix ist der
Kontrolllauf, die gestörten Member tragen Suffixe `_member01` …
`_memberNN`. Alle Member werden gleichgewichtet behandelt (→ A10).

Die Geländehöhe `elevation` des Gitterpunkts liefert die API mit; sie
definiert den Bodenbezug für alle AGL-Angaben.

---

## 2. Windvektor-Konventionen

Umrechnung meteorologische Richtung ↔ kartesische Komponenten
(`toUV`, `toSpdDir`), mit $u$ = Ostkomponente, $v$ = Nordkomponente,
$s$ = Betrag, $\theta$ = Windrichtung:

$$u = -s \cdot \sin\theta, \qquad v = -s \cdot \cos\theta$$

$$s = \sqrt{u^2 + v^2}, \qquad \theta = \operatorname{atan2}(-u, -v) \bmod 360°$$

Beispielprüfung: Westwind ($\theta = 270°$, Luft strömt nach Ost) ergibt
$u = +s$, $v = 0$. Ein passiv driftendes Objekt bewegt sich nach **Ost** –
in Richtung $+u$, also *mit* dem Vektor $(u, v)$.

---

## 3. Vertikalprofil je Member

Funktion `profile(data, member, t)` baut für einen Member zur Stunde $t$ eine
Stützstellenliste $\{(h_i,\, u_i,\, v_i)\}$:

1. **Bodenpunkt:** 10-m-Wind bei $h = \text{elevation} + 10\,$m MSL.
2. **Druckflächen:** je Level der Wind bei $h = $ geopotentielle Höhe des
   Members. Flächen mit $h < \text{elevation} + 20\,$m werden verworfen
   (Druckfläche liegt im/unter dem Gelände).
3. Sortierung aufsteigend nach $h$. Member mit < 3 gültigen Stützstellen
   werden für diese Stunde ausgeschlossen; Stunden mit < 2 gültigen Membern
   gelten als ungültig (`MIN_MEMBERS`). Bei $2 \le N < 5$ werden alle Maße
   berechnet, aber als **nur orientierend** gekennzeichnet: Quantile
   entsprechen dann faktisch Extremwerten, die Ampeln vergeben kein Grün,
   und die Karte zeigt die einzelnen Exitkreise (Abschn. 7.3) – relevant
   für Regionen, in denen nur wenige Modelle Druckflächendaten liefern.

**Interpolation** (`interp`): $u$ und $v$ werden *komponentenweise linear in
der Höhe* interpoliert; unterhalb der untersten bzw. oberhalb der obersten
Stützstelle wird konstant fortgesetzt (Randklemmung).

> Wichtig: Es werden die Komponenten interpoliert, nicht Betrag und Richtung.
> Das ist die physikalisch konsistente Wahl (der Windvektor ist die
> Grundgröße); bei drehendem Wind unterschätzt die lineare
> Komponenteninterpolation den Betrag zwischen den Stützstellen geringfügig.

Annahmen: **A1** (lineares Windprofil zwischen Druckflächen), **A2**
(geopotentielle Höhe ≈ geometrische Höhe; Fehler < 0,3 % unterhalb 10 km),
**A3** (Randklemmung unter der 10-m-Höhe und über der obersten Fläche).

---

## 4. Mittelwind und Windversatz (Kern des Modells)

Funktion `integrate(pts, elev, p)`. Der Springer wird als **passiv
driftendes Teilchen** modelliert (A4): keine Eigenfahrt, kein Steuern, kein
Vorwärtswurf, kein Öffnungsvorgang – die Schirmleistung wird erst in
Abschnitt 6 als *Korrekturbudget* separat behandelt.

**Sinkratenprofil** (zweiphasig, A5):

$$w(h_{\mathrm{AGL}}) = \begin{cases} v_{\mathrm{free}} & h_{\mathrm{AGL}} > h_{\mathrm{open}} \quad\text{(Freifall)}\\ v_{\mathrm{canopy}} & h_{\mathrm{AGL}} \le h_{\mathrm{open}} \quad\text{(Schirm)} \end{cases}$$

**Windversatz** (Drift-Integral): Der horizontale Versatz vom HARP bis
zum Boden ist

$$\vec D = \int_0^{T} \vec V\!\big(h(t)\big)\, dt \;=\; \int_0^{H_{\mathrm{exit}}} \frac{\vec V(h)}{w(h)}\, dh$$

(Substitution $dt = dh / w(h)$, da $\dot h = -w$). Numerik: Mittelpunktsregel
mit Schrittweite $\Delta h = 50\,$m:

$$\vec D \approx \sum_k \vec V(h_k^{\mathrm{mitte}}) \cdot \frac{\Delta h}{w(h_k^{\mathrm{mitte}})}$$

Die Summe läuft über volle 50-m-Schichten von 0 bis $H_{\mathrm{exit}}$
(eine Restschicht < 50 m entfällt, falls $H_{\mathrm{exit}}$ kein
Vielfaches von 50 m ist).

**Mittelwind Boden–Exit:** arithmetisches Mittel der abgetasteten Vektoren,
d. h. das *höhengemittelte* Windprofil:

$$\vec{\bar V} = \frac{1}{H_{\mathrm{exit}}} \int_0^{H_{\mathrm{exit}}} \vec V(h)\, dh$$

> Abgrenzung: $\vec{\bar V}$ ist **höhengewichtet** (jede Schicht zählt
> gleich) und dient der Anzeige/Kommunikation. Der Versatz $\vec D$ ist
> **zeitgewichtet** ($1/w$-Gewichtung): die Schirmphase trägt pro Höhenmeter
> das $v_{\mathrm{free}}/v_{\mathrm{canopy}}$-fache (Default: 10-fache) bei.
> Beide Größen sind bewusst getrennt implementiert.

Plausibilitätsprüfung: $|\vec D| \approx |\vec{\bar V}_{\mathrm{zeitgew.}}| \cdot T$
mit $T = (H_{\mathrm{exit}}-h_{\mathrm{open}})/v_{\mathrm{free}} + h_{\mathrm{open}}/v_{\mathrm{canopy}}$
(Default: 3000/50 + 1000/5 = 260 s).

Weitere Annahmen: **A6** (Stationarität: das Windprofil der gewählten Stunde
gilt für die gesamte Sinkdauer von ~4–6 min), **A7** (horizontale
Homogenität: eine Gittersäule repräsentiert das Windfeld entlang der
gesamten Driftstrecke von wenigen km), **A8** (konstante Sinkraten, keine
Dichteabhängigkeit der Freifallgeschwindigkeit, kein Vertikalwind).

---

## 5. Vom Versatz zum HARP (Dualität)

Für Member $m$ mit Versatz $\vec D_m$ gilt exakt:

$$\text{Landepunkt} = \text{Exit} + \vec D_m \qquad\Longleftrightarrow\qquad \text{nötiger HARP } \vec E_m = \text{DIP} - \vec D_m$$

Daraus folgen die zwei dualen Darstellungen:

- **Landepunktwolke:** Wird der HARP auf dem Ensemble-Mittel
  $\vec{\bar D} = \frac{1}{N}\sum_m \vec D_m$ geplant, landet der passive
  Springer unter Member $m$ bei $\text{DIP} + \vec O_m$ mit
  $\vec O_m = \vec D_m - \vec{\bar D}$ (Abweichungsvektoren, `offsets`).
- **HARPs:** $\vec E_m = \text{DIP} - \vec D_m$ (`exits`).
  Es gilt $\vec E_m - \vec{\bar E} = -\vec O_m$: dieselbe Punktwolke,
  am DIP gespiegelt.

---

## 6. Korrekturbudget des Schirms: Radius R

Unter dem geöffneten Schirm bewegt sich der Springer mit Eigenfahrt
$\vec v_a(t)$ (Betrag $v_{\mathrm{fwd}}$) **relativ zur Luftmasse**:

$$\vec x_{\mathrm{Boden}} = \text{Exit} + \underbrace{\int \vec V\, dt}_{\text{Drift } \vec D} + \underbrace{\int \vec v_a(t)\, dt}_{\text{Steuerbeitrag}}$$

Da die Drift bereits vollständig in $\vec D$ steckt, ist der maximale
Steuerbeitrag ein **isotroper** Kreis im mitbewegten Luftsystem – der Betrag
des Integrals ist durch $v_{\mathrm{fwd}} \cdot T_{\mathrm{nutz}}$
beschränkt, unabhängig von der Richtung. Mit der Überhöhung
$h_{\mathrm{über}}$ (Höhenreserve über dem DIP für Landevolte, nicht zum
Streckenmachen nutzbar) ist die nutzbare Schirmzeit
$T_{\mathrm{nutz}} = (h_{\mathrm{open}} - h_{\mathrm{über}}) / v_{\mathrm{canopy}}$, also:

$$\boxed{\;R = v_{\mathrm{fwd}} \cdot \frac{h_{\mathrm{open}} - h_{\mathrm{über}}}{v_{\mathrm{canopy}}}\;}$$

(implementiert in `params()`, `js/app.js`; negativ geklemmt auf 0).
Default: $10 \cdot (1000-300)/5 = 1400\,$m.

**Terminologie in der Oberfläche:** $R$ wird als **maximale Schirmfahrt
(bei Windstille)** bezeichnet – die Strecke, die der Schirm aus
Eigenfahrt zurücklegen kann. Die im Briefing ausgewiesene **Reserve** ist
$R$ minus der nötigen Schirmfahrt zum Ziel (mittleres Szenario);
methodisch dient $R$ als Korrekturbudget gegen die Ensemble-Streuung
(Abschn. 8).

**Exitkreis:** Member $m$ erlaubt das Erreichen des DIP genau dann, wenn

$$|\,\text{Exit} + \vec D_m - \text{DIP}\,| \le R \quad\Longleftrightarrow\quad \text{Exit} \in K(\vec E_m,\, R)$$

Annahme **A9**: Die volle Eigenfahrt steht während der gesamten nutzbaren
Schirmzeit für die Kurskorrektur zur Verfügung (geradliniger Zielanflug);
die Isotropie gilt exakt im Luftsystem, d. h. *relativ zum passiven
Driftlandepunkt*, nicht relativ zum Boden.

---

## 7. Ensemble-Statistik

### 7.1 Skalare Streuungsmaße (`hourStats`)

Über die $N$ gültigen Member:

- **distP90** $= P_{90}\big(|\vec O_m|\big)$: 90-%-Quantil der
  Versatzabweichungen vom Ensemble-Mittel – die zentrale Streuungskennzahl
  (Einheit: Meter am Boden). Perzentile durchgängig mit linearer
  Interpolation zwischen Rangplätzen (Positionsindex $p\,(N-1)$).
- **Segmentwinde** (`segWind`) je Windschicht – Freifall (Exit–Öffnung),
  Schirmfahrt (Öffnung–Überhöhung) und gesamt (Boden–Exit): Betragsmittel
  $\bar s$, zirkulares Richtungsmittel (Abschn. 7.2) sowie die
  **P10–P90-Bänder** von Betrag und Richtung über die Member.

### 7.2 Zirkulare Richtungsstatistik (`circStats`)

Richtungen dürfen nicht arithmetisch gemittelt werden (Problem 350°/10°).
Verwendet wird die Resultantenmethode (Mardia): mit Einheitsvektoren der
Member-Richtungen $\theta_m$

$$\bar u = \tfrac{1}{N}\sum \sin\theta_m,\quad \bar v = \tfrac{1}{N}\sum \cos\theta_m,\quad \bar R = \sqrt{\bar u^2 + \bar v^2} \in [0,1]$$

$$\theta_{\mathrm{mittel}} = \operatorname{atan2}(\bar u, \bar v), \qquad \sigma_\theta = \sqrt{-2 \ln \bar R}\; \cdot \tfrac{180°}{\pi} \quad (\text{gekappt bei } 180°)$$

$\bar R \to 1$: alle Member einig, $\sigma_\theta \to 0$. $\bar R \to 0$:
Richtungen gleichverteilt, $\sigma_\theta$ läuft gegen die Kappung. Für
kleine Streuungen stimmt $\sigma_\theta$ mit der linearen
Standardabweichung überein.

Angewandt auf: Richtung des Member-Mittelwinds (Meteo-Ampel) und die
Richtungen je Druckfläche (Tabelle).

In der Oberfläche wird statt $\sigma_\theta$ überall das anschaulichere
zirkulare **P10–P90-Richtungsband** angezeigt (Score-Karte und
Druckflächen-Tabelle, `windBand`): Perzentile der kürzesten
Winkelabweichung vom zirkularen Mittel, zurückgedreht auf absolute
Richtungen. Analog ersetzt das P10–P90-Betragsband die
Standardabweichung der Geschwindigkeit. $\sigma_\theta$ bleibt das
interne Kriterium der Meteo-Ampel (Abschn. 8.2).

### 7.3 Überdeckungsfeld der Exitzonen (`renderZones`)

Für jeden Punkt $\vec x$ (Raster 180 × 180 Zellen um den DIP, Ausdehnung
$\max_m |\vec E_m| + 1{,}1\,R + 200\,$m):

$$P(\vec x) = \frac{1}{N} \sum_m \mathbb{1}\big[\,|\vec x - \vec E_m| \le R\,\big]$$

Farbflächen: $P \ge 0{,}9$ (grün), $0{,}7 \le P < 0{,}9$ (gelb),
$0{,}5 \le P < 0{,}7$ (rot), darunter transparent.

Bei kleinen Ensembles ($N \le 15$, also im Hauptlauf-Modus und generell bei
$N < 5$) werden zusätzlich die **einzelnen Exitkreise** $K(\vec E_m, R)$
als dünne, modellfarbige Umrisse gezeichnet. Bei sehr kleinem $N$ ist das
die belastbarste Darstellung: Die gemeinsame Schnittfläche ist direkt
sichtbar, ohne dass eine fragwürdige Quantilstatistik dazwischenliegt.

**Interpretationsvorbehalt (A10):** $P(\vec x)$ ist der *Member-Anteil*,
keine kalibrierte Wahrscheinlichkeit. Die Gleichsetzung „Anteil =
Eintrittswahrscheinlichkeit“ setzt gleichwahrscheinliche Member und ein
kalibriertes Ensemble voraus – EPS sind besonders bei kurzen Vorlaufzeiten
systematisch **unterdispersiv** (Spread < tatsächlicher Fehler), $P$ ist
also tendenziell zu optimistisch.

### 7.4 Minimax-HARP und sichere Exitzone

Der **kleinste umschließende Kreis** (Welzl-Algorithmus, inkrementell;
`enclosingCircle`) der HARPs liefert Zentrum $\vec c$ und Radius $r$.
Das Zentrum ist der **Minimax-Punkt**: es minimiert den maximalen Abstand zu
allen HARPsn – der im Worst-Case-Sinn optimale HARP.

**Robustheit:** Vor der Kreisberechnung werden die HARPs nach Abstand
vom Schwerpunkt sortiert und nur die nächsten 90 % behalten
(`robustEnclosing`); ein einzelnes Ausreißer-Member kann die Kennzahl so
nicht dominieren. (Hinweis: Dieses Trimmen ist eine Heuristik – es liefert
nicht zwingend den kleinsten Kreis, der *irgendeine* 90-%-Teilmenge
umschließt, sondern den über die zentrumsnächsten 90 %.)

**Sichere Zone** (Dreiecksungleichung): Liegen alle (behaltenen)
$\vec E_m$ in $K(\vec c, r)$, dann gilt für jeden Exit
$\vec x \in K(\vec c,\, R - r)$:

$$|\vec x - \vec E_m| \le |\vec x - \vec c| + |\vec c - \vec E_m| \le (R - r) + r = R$$

Der Kreis $K(\vec c,\, R-r)$ ist also eine **Teilmenge** der echten
Schnittfläche aller Exitkreise (die Schnittfläche selbst ist ein
Linsen-Polygon und etwas größer) – die Garantie ist konservativ. Für
$r \ge R$ existiert kein sicherer HARP → Warnung.

**Geplanter HARP (frei wählbar):** Für einen beliebigen HARP $\vec x$
(per Marker oder Koordinateneingabe, `harpEval`) bewertet das Tool den Plan
mit der Überdeckung $P(\vec x)$ aus Abschn. 7.3 – angezeigt als „$k$ von
$N$ Membern“, wegen A10 bewusst nicht als Wahrscheinlichkeit – sowie der
Worst-Case-Fehlstrecke $\max_m\,(|\vec x - \vec E_m| - R)$ über die nicht
gedeckten Member. Die zugehörige Landepunktwolke (`renderPlanScatter`)
zeigt die passiven Landepunkte $\vec x + \vec D_m$ relativ zum DIP. Der
Knopf „Max. Gleitstrecke“ (`glideHarp`) setzt den HARP auf den DIP-fernsten
Punkt des Strahls vom DIP in Richtung $-\vec{\bar D}$ (20-m-Raster), der
noch $P \ge 0{,}9$ erreicht – den luvseitigen Rand der 90-%-Zone entlang
der Driftachse; existiert kein solcher Punkt, den weitesten Punkt bester
Deckung.

### 7.5 Multi-Modell-Pooling (Option)

Bei Auswahl „Multi-Modell“ werden IFS ENS (51), AIFS ENS (51) und GEFS (31)
in einem API-Request geladen und alle **133 Member gleichberechtigt
gepoolt**; sämtliche Statistiken der Abschnitte 7–8 laufen unverändert über
die Gesamtmenge (`parse` leitet die Member generisch aus den
Antwort-Schlüsseln `…_memberNN_<modell>` ab). Die Profilcharts färben die
Member nach Modell ein, sodass Modell-Uneinigkeit (z. B. Bimodalität)
sichtbar bleibt.

Motivation: Ein einzelnes EPS tastet nur die Anfangswert- und (teilweise)
Physikunsicherheit *innerhalb eines Modellsystems* ab. Das Pooling ergänzt
die **strukturelle Modellunsicherheit** und wirkt damit der Unterdispersion
(A10) entgegen – der gepoolte Spread ist typischerweise größer und
ehrlicher als der eines Einzel-EPS.

Einschränkungen (**A13**):

- **Implizite Gewichtung nach Memberzahl:** die ECMWF-Familie stellt
  102/133 ≈ 77 % der Member. Eine Gleichgewichtung der *Modelle* wäre eine
  vertretbare Alternative und ist bewusst nicht implementiert (Konvention).
- **Keine Unabhängigkeit:** IFS und AIFS teilen Datenassimilation und
  Anfangszustand; ihre Übereinstimmung ist schwächer beweiskräftig als eine
  Übereinstimmung mit GEFS.
- **Heterogene Verteilungen:** unterschiedliche Auflösungen (0,25° vs.
  0,5°) und Modellphysik werden zu einer Verteilung gemischt; σ und distP90
  beschreiben eine ggf. multimodale Verteilung dann nur unvollständig. Ein
  sichtbar bimodales Profil (zwei Modell-Cluster) ist als eigenständiges
  Warnsignal zu lesen.

### 7.6 Hauptlauf-Multimodell (Option „Hauptläufe“)

Alternativ zum EPS kann ein Lagebild aus den **deterministischen
Hauptläufen** gebildet werden. Datenquelle ist die reguläre Forecast-API
(`api.open-meteo.com/v1/forecast`, gleiche Variablen); jeder Hauptlauf wird
als ein „Member“ behandelt, die gesamte Rechenkette (Abschn. 3–8) bleibt
identisch. Kandidatenliste (Verfügbarkeit ortsabhängig – Modelle außerhalb
ihrer Domäne lässt die API stillschweigend weg):

ECMWF IFS 0,25° · GFS · **ICON-D2 (2,2 km)** · **ICON-EU (~7 km)** ·
ICON Global · GEM · ARPEGE Europe · UKMO Global 10 km ·
KNMI HARMONIE-AROME · JMA GSM · CMA – in Mitteleuropa 11 Läufe.

Unterschiedliche Vorhersagelängen (z. B. ICON-D2 ≈ +48 h) führen dazu, dass
$N$ mit der Vorlaufzeit abnimmt; ab $N < 5$ greift die
Orientierend-Kennzeichnung, unter $N = 2$ entfällt die Statistik
(Abschn. 3).

Einordnung (**A14**):

- Es wird ausschließlich die **strukturelle Modellvielfalt** abgetastet –
  keine Anfangswertstörungen. Kleines $N$ (≈ 7–11): distP90 liegt nahe am
  Maximum der Stichprobe, alle Perzentile sind grobkörnig; die Maße sind
  als *Lagebild*, nicht als Wahrscheinlichkeit zu lesen („poor man's
  ensemble“).
- Dafür enthalten die Hauptläufe mit ICON-D2/EU und HARMONIE
  **kilometerskalige Modelle**, die Grenzschicht und Geländeeffekte
  strukturell besser auflösen als alle Modelle der Ensemble-API (~25–50 km)
  – eine teilweise Kompensation von A7.
- Diagnostische Nutzung: Streuen bereits die Hauptläufe stark, ist die Lage
  unsicher, unabhängig davon, wie eng ein einzelnes EPS ist. Umgekehrt ist
  Hauptlauf-Einigkeit **kein** Beleg für Sicherheit (gemeinsame Anfangs­daten,
  ähnliche Physik → Pseudo-Konsens möglich). EPS- und Hauptlauf-Sicht
  ergänzen sich; sie ersetzen einander nicht.

**Modellabwahl:** Einzelne Modelle können in der Oberfläche abgewählt
werden (z. B. wenn sie für die aktuelle Wetterlage als nicht repräsentativ
beurteilt wurden); sämtliche Statistiken laufen dann über die verbleibenden
Member (unter $N = 2$ keine Statistik, bei $N < 5$ nur orientierend,
Abschn. 3). Dasselbe funktioniert
im EPS-Multi-Modell-Betrieb (Abwahl ganzer Teilensembles). Zu beachten:
Eine subjektive Modellabwahl ist eine Analyseentscheidung – sie verengt die
abgetastete Unsicherheit und sollte bei der Weitergabe von Ergebnissen mit
angegeben werden.

---

## 8. Zuverlässigkeitsmaße (Score-Karte)

### 8.1 Operationell: Reserve-Verbrauch

$$\text{reserveUse} = \frac{\text{distP90}}{R}$$

Anteil der Schirm-Korrekturreserve, den die meteorologische Unsicherheit
aufzehrt (für $R = 0$: ∞). Ampel: grün < 0,4 · gelb 0,4–0,8 · rot ≥ 0,8
oder $R \le 0$. Kontinuierlich, saturiert nicht; hängt bewusst von den
Schirmparametern ab („Kann *dieser* Sprung sicher geplant werden?“).
Der Zeitstreifen färbt jede Stunde stufenlos:
Farbton $= 120° \cdot (1 - \min(\text{reserveUse}, 1))$ im HSL-Raum
(120° = grün, 0° = rot).

### 8.2 Meteorologisch: absoluter Spread

Schirmunabhängig („Wie unsicher ist die Vorhersage selbst?“), gegen
einstellbare Schwellen:

| Ampel | Bedingung (Defaults) |
|---|---|
| grün | distP90 ≤ 300 m **und** $\sigma_\theta$ ≤ 15° |
| rot | distP90 > 700 m **oder** $\sigma_\theta$ > 30° |
| gelb | sonst |

Die Schwellen sind bewusst konfigurierbar – sie sind Konvention, keine
Physik.

**Anzeige vs. Ampelkriterium:** Die Score-Karte zeigt statt der σ-Werte
die P10–P90-Bänder von Geschwindigkeit und Richtung („in 80 % der Member
liegt der Wind in diesem Bereich“). Mittelwind und beide Bänder beziehen
sich stets auf **dieselbe wählbare Windschicht** (Auswahl „Windschicht“
auf der Karte): Schirmfahrt (Öffnungshöhe bis Überhöhung, Default),
Freifall (Exit bis Öffnung) oder gesamt (Boden–Exit). Auch der Chart
„Mittelwind im Zeitverlauf“ (Ensemble-Mittel und P10–P90-Band) folgt der
gewählten Schicht. Die Ampel rechnet unverändert mit distP90 und
$\sigma_\theta$ über den Mittelwind Boden–Exit.

**Zusammenhang der beiden Maße:** distP90 ist die gemeinsame Basis; das
operationelle Maß normiert sie auf das Schirmbudget, das meteorologische
vergleicht sie absolut. Bei identischem Wetter kann derselbe Termin
operationell grün (großer Schirm, hohe Öffnung) und meteorologisch gelb
sein – das ist beabsichtigt.

---

## 9. Gültigkeitsgrenzen und bekannte Fehlerquellen

| # | Annahme | Grenze / Fehlergröße |
|---|---|---|
| A1 | Lineare Interpolation zwischen Druckflächen | Unterhalb ~925 hPa nur 10-m-Wind + 1–2 Flächen: Ekman-Drehung und Low-Level-Jets werden geglättet; größte Profilfehler in der Grenzschicht |
| A2 | Geopotentielle ≈ geometrische Höhe | < 0,3 % unter 10 km – vernachlässigbar |
| A3 | Randklemmung über oberster Fläche | Relevant nur, wenn Exithöhe über ~400-hPa-Niveau (≈ 7 km MSL) liegt |
| A4 | Passives Teilchen | Vorwärtswurf, Absetzanflug, Öffnungsstrecke nicht modelliert (bewusst: rein meteorologisch) |
| A5 | Zweiphasig konstante Sinkraten | Öffnungsvorgang (~ Sekunden, Übergangsphase) verschmiert; Fehler klein gegen Windunsicherheit |
| A6 | Stationarität während der Sinkdauer | Sinkdauer ~4–6 min « 1-h-Zeitschritt; bei Frontpassagen/Konvektion verletzt |
| A7 | Horizontale Homogenität | Gitterauflösung 0,25° (~25 km); Tal-/Hangwind, lokale Konvergenzen unsichtbar – in komplexem Gelände dominierende Fehlerquelle |
| A8 | Konstante Freifallgeschwindigkeit | TAS wächst mit der Höhe (Dichte); bei 4000 m ca. 15–20 % – wirkt auf die Zeitgewichtung der oberen Schichten |
| A9 | Volles Steuerbudget, Isotropie im Luftsystem | Realer Zielanflug (Pattern, Verkehr) reduziert das Budget → über Überhöhung konservativ abbildbar |
| A10 | Gleichgewichtete Member = Wahrscheinlichkeit | EPS unterdispersiv (v. a. < 48 h Vorlauf); $P(\vec x)$ und alle Ampeln eher zu optimistisch; Multi-Modell-Vergleich (ECMWF vs. GFS) als Gegenprobe empfohlen |
| A11 | Zeitliche Interpolation der API | ECMWF ENS/GEFS nativ 3-stündlich, Open-Meteo interpoliert auf 1 h – Zwischenstunden tragen keine eigene Information |
| A12 | Diskretisierung | $\Delta h = 50\,$m (Integration), 100 m (Charts), Rasterzellen ~10–40 m (Karte); Fehler « meteorologische Unsicherheit |
| A13 | Multi-Modell-Pooling gleichgewichteter Member | ECMWF-Familie dominiert (77 % der Member); IFS/AIFS nicht unabhängig; gemischte Verteilung ggf. multimodal (Abschn. 7.5) |
| A14 | Hauptlauf-Modus: 1 Lauf = 1 Member | Nur Modellvielfalt, keine Anfangswertunsicherheit; $N \approx 7–11$ → Perzentile grobkörnig; Konsens ≠ Sicherheit (Abschn. 7.6) |

---

## 10. Verifikation

Invarianten, die sich jederzeit (z. B. in der Browser-Konsole oder per
Node-Skript gegen `js/meteo.js`) prüfen lassen:

1. **Dualität:** Überdeckung $P$ am mittleren HARP $\vec{\bar E}$ =
   Anteil der Member mit $|\vec O_m| \le R$ (Feld `pTol`). Getestet: exakt
   gleich.
2. **Umkreis-Eigenschaft:** Alle behaltenen 90-%-HARPs liegen in
   $K(\vec c, r)$; max. Abstand = $r$ (auf Rundungsgenauigkeit).
3. **Minimax-Optimalität (notwendige Bedingung):** $r \le$ Umkreisradius um
   den Schwerpunkt der Punkte. Getestet: 307 m ≤ 319 m.
4. **Versatz-Plausibilität:** $|\vec D| \approx \bar V_{\mathrm{zeitgew.}} \cdot T$
   mit $T = 260$ s (Defaults). Getestet: Größenordnung stimmt
   (~2,1 km bei 8,7 m/s Mittelwind).
5. **Spread-Wachstum:** distP90 bzw. reserveUse müssen im Mittel mit der
   Vorlaufzeit wachsen. Getestet (ECMWF, München): 12 % (h+12) → 40 %
   (h+48) → 50 % (h+96) → 85 % (h+119).
6. **Windkonvention:** Westwind (270°) ⇒ Drift nach Ost ⇒ HARP westlich
   des DIP (der HARP liegt immer *luvseitig*, Peilung DIP→HARP ≈
   Windrichtung des zeitgewichteten Mittelwinds).
7. **Pooling-Effekt:** Der Multi-Modell-Spread muss den Einzelmodell-Spread
   in der Regel übersteigen. Getestet (h+24, München): distP90 = 532 m
   gepoolt vs. 284 m nur IFS – die strukturelle Modellunsicherheit ist
   sichtbar.

---

## 11. Symbolverzeichnis

| Symbol | Code | Bedeutung |
|---|---|---|
| $\vec V(h)$ | `interp` | Horizontalwindvektor in Höhe $h$ |
| $w(h)$ | `integrate` | Sinkrate (zweiphasig) |
| $\vec D_m$ | `dx`, `dy` | Windversatz Member $m$ (Exit → Boden) |
| $\vec{\bar V}_m$ | `mu`, `mv` | höhengemittelter Wind Boden–Exit |
| $\vec O_m$ | `offsets` | $\vec D_m - \vec{\bar D}$ (Landepunktabweichung) |
| $\vec E_m$ | `exits` | nötiger HARP $= \text{DIP} - \vec D_m$ |
| $R$ | `p.tolerance` | maximale Schirmfahrt / Korrekturbudget (Abschn. 6) |
| distP90 | `distP90` | 90-%-Quantil von $\lvert\vec O_m\rvert$ |
| $\vec c,\ r$ | `enc90` | Minimax-HARP und Umkreisradius (90 % Member) |
| $R - r$ | `safeR` | Radius der sicheren Exitzone |
| reserveUse | `reserveUse` | distP90 / R |
| $\sigma_\theta$ | `circStats().sigma` | zirkulare Richtungsstreuung |
