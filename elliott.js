"use strict";
/* =====================================================================
   Elliott-Wellen-Modul

   Rechnet ausschliesslich auf Klick. Die Rechenfunktionen sind rein - sie
   nehmen Zahlen entgegen und geben Zahlen zurueck, ohne das Dokument zu
   beruehren. Die DOM-Logik steht weiter unten, sauber getrennt.

   Klassisches Script, kein ES-Modul: Das Projekt bindet app.js, depot.js und
   valuation.js als gewoehnliche Skripte ein und teilt sich einen globalen
   Namensraum. Ein Modul kaeme an loadChart, analyse oder chartObj nicht heran.

   ---------------------------------------------------------------------
   Warum dieses Modul anders rechnet als ueblich
   ---------------------------------------------------------------------
   Die drei harten Elliott-Regeln sind schwach: Fast jede Zickzackfolge
   erfuellt sie irgendwo. Wer genug Fenster durchprobiert, findet immer eine
   "gueltige" Zaehlung - auch in reinem Rauschen. Gemessen an 70 Titeln und
   Surrogatreihen fand die fruehere Fassung auf Zufallsdaten genauso oft eine
   Zaehlung wie auf echten Kursen (78 % gegen 80 %) und bewertete sie im
   Median sogar hoeher.

   Deshalb entscheidet hier nicht die Zaehlung selbst, sondern ihr Vergleich
   mit dem Zufall: Dieselbe Suche laeuft ueber hunderte Surrogatreihen, die
   aus den echten Renditen dieses Titels gebaut sind. Erst der Anteil der
   Surrogate, die mindestens so gut abschneiden, entscheidet - der p-Wert.
   Weil auf jedem Surrogat dieselbe Bestenauswahl laeuft, ist die
   Mehrfachauswahl ueber alle Fenster und Ebenen automatisch mitkorrigiert.

   Elliott-Wellen bleiben Auslegung, keine Messung. Dieses Modul macht die
   Auslegung nur pruefbar - und liefert lieber kein Ergebnis als ein
   erfundenes.
   ===================================================================== */

/* ---------- Schwellen und Verhaeltnisse ---------- */

/** Untergrenze der Pivot-Schwelle in Prozent - darunter wird Rauschen gezaehlt. */
const EL_MIN_PCT = 0.02;
/** Mehrere Betrachtungsebenen: ATR(14) mal diesen Faktoren. */
const EL_SKALEN = [1.0, 1.5, 2.25, 3.5];
const EL_ATR_PERIOD = 14;
/** Ueber so viele der juengsten Pivots wird je Ebene gesucht. */
const EL_MAX_PIVOTS = 24;
/** Unter so vielen Kerzen wird gar nicht erst gerechnet. */
const EL_MIN_CANDLES = 120;
/** Mindestdauer je Welle in Kerzen.
    Die ZigZag-Schwelle steuert nur die Amplitude, nicht die Dauer. Ohne diese
    Grenze entstehen Zaehlungen, die amplitudenmaessig sauber sind und dennoch
    Unsinn: gemessen wurde eine ueber neun Kalendertage, bei der Welle 3 und
    Welle 4 am selben Tag endeten. Eine Welle, die auf Tagesdaten in ein oder
    zwei Kerzen entsteht, liegt unterhalb der Aufloesung der Daten. */
const EL_MIN_WELLE_KERZEN = 3;

/** Zielverhaeltnisse je Beziehung. */
const Z_RET2  = [0.382, 0.5, 0.618, 0.786];
const Z_RET4  = [0.236, 0.382, 0.5];
const Z_W3    = [1.618, 2.618, 4.236];
const Z_W5_1  = [0.618, 1.0, 1.618];
const Z_W5_13 = [0.382, 0.618];
/** Vollstaendige Retracement-Leiter, wie sie beim Einzeichnen ueblich ist.
    0 liegt am Ende der Bewegung, 1 an ihrem Anfang - dieselbe Ausrichtung wie
    beim Fibonacci-Werkzeug gaengiger Chartprogramme. */
const EL_FIB_LEITER = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
/** Die beiden Stufen, zwischen denen die meisten Korrekturen enden. */
const EL_GOLD_VON = 0.382, EL_GOLD_BIS = 0.618;

/** Streuung im Log-Verhaeltnisraum - rund 13 % Toleranz. */
const EL_SIGMA = 0.13;
/** Ab dieser Differenz der Retracement-Tiefen gilt Alternation als voll erfuellt. */
const EL_ALTERNATION_VOLL = 0.30;

/** Anzahl Surrogatreihen fuer den Signifikanztest. */
const EL_N_SURROGATE = 999;
/** Blocklaenge des Bootstraps in Handelstagen. */
const EL_BLOCK = 20;

/** Ampelgrenzen nach p-Wert. */
const EL_P_GRUEN = 0.05;
const EL_P_GELB  = 0.20;

/** Zwei Level bilden eine Zone, wenn ihr Abstand unter diesem Anteil des Kurses liegt. */
const EL_CLUSTER_TOL = 0.01;

const EL_SPEICHER = "ak.elliott";

/* =====================================================================
   Rechenteil - reine Funktionen
   ===================================================================== */

/**
 * Mittlere Tagesspanne (Average True Range).
 * TR = max(hoch − tief, |hoch − schluss₋₁|, |tief − schluss₋₁|)
 * ATR = Mittel der letzten n TR
 * @returns {number|null}
 */
function elAtr(hochs, tiefs, schluss, n = EL_ATR_PERIOD) {
  if (!hochs || schluss.length < n + 1) return null;
  const tr = [];
  for (let i = 1; i < schluss.length; i++) {
    tr.push(Math.max(hochs[i] - tiefs[i],
                     Math.abs(hochs[i] - schluss[i - 1]),
                     Math.abs(tiefs[i] - schluss[i - 1])));
  }
  const teil = tr.slice(-n);
  return teil.reduce((a, b) => a + b, 0) / teil.length;
}

function elArgMax(a, von, bis) { let k = von; for (let i = von; i <= bis; i++) if (a[i] > a[k]) k = i; return k; }
function elArgMin(a, von, bis) { let k = von; for (let i = von; i <= bis; i++) if (a[i] < a[k]) k = i; return k; }

/**
 * ZigZag-Pivots: alternierende Hoch- und Tiefpunkte.
 *
 * Ein neuer Pivot entsteht, sobald der Kurs vom laufenden Extrem um mehr als
 * die Schwelle zurueckkommt:  |extrem − gegenwert| / extrem ≥ schwelle
 *
 * Die Schwelle ist relativ, nicht absolut - sonst waere sie fuer einen Titel
 * bei 15 Euro und einen bei 1500 voellig verschieden streng.
 *
 * @param {{t:number[],c:number[],h:number[],l:number[]}} reihe
 * @param {number} schwelle Anteil, z. B. 0.03 fuer drei Prozent
 * @returns {{index:number,date:number,price:number,type:string}[]}
 */
function elDetectSwings(reihe, schwelle) {
  const { t, h, l } = reihe;
  const n = t.length;
  if (n < 3 || !(schwelle > 0)) return [];

  const pivots = [];
  // Startrichtung offen: erst der erste Ausschlag entscheidet.
  let richtung = 0;
  let extIdx = 0;
  let extHoch = h[0], extTief = l[0];

  for (let i = 1; i < n; i++) {
    if (richtung >= 0 && h[i] >= extHoch) { extHoch = h[i]; if (richtung > 0) extIdx = i; }
    if (richtung <= 0 && l[i] <= extTief) { extTief = l[i]; if (richtung < 0) extIdx = i; }

    if (richtung === 0) {
      // Noch unentschieden - welche Seite reisst zuerst die Schwelle?
      if (extHoch > 0 && (extHoch - l[i]) / extHoch >= schwelle) {
        const idx = elArgMax(h, 0, i);
        pivots.push({ index: idx, date: t[idx], price: h[idx], type: "high" });
        richtung = -1; extTief = l[i]; extIdx = i;
      } else if (extTief > 0 && (h[i] - extTief) / extTief >= schwelle) {
        const idx = elArgMin(l, 0, i);
        pivots.push({ index: idx, date: t[idx], price: l[idx], type: "low" });
        richtung = 1; extHoch = h[i]; extIdx = i;
      }
      continue;
    }

    if (richtung > 0) {
      if (h[i] > extHoch) { extHoch = h[i]; extIdx = i; }
      else if (extHoch > 0 && (extHoch - l[i]) / extHoch >= schwelle) {
        pivots.push({ index: extIdx, date: t[extIdx], price: extHoch, type: "high" });
        richtung = -1; extTief = l[i]; extIdx = i;
      }
    } else {
      if (l[i] < extTief) { extTief = l[i]; extIdx = i; }
      else if (extTief > 0 && (h[i] - extTief) / extTief >= schwelle) {
        pivots.push({ index: extIdx, date: t[extIdx], price: extTief, type: "low" });
        richtung = 1; extHoch = h[i]; extIdx = i;
      }
    }
  }
  // Das laufende Extrem als vorlaeufigen letzten Pivot mitgeben - die aktuelle
  // Bewegung ist noch nicht abgeschlossen, gehoert aber zur Zaehlung.
  if (richtung > 0) pivots.push({ index: extIdx, date: t[extIdx], price: extHoch, type: "high", offen: true });
  if (richtung < 0) pivots.push({ index: extIdx, date: t[extIdx], price: extTief, type: "low", offen: true });
  return pivots;
}

/**
 * Passgenauigkeit eines Verhaeltnisses zum naechstgelegenen Zielwert.
 *
 *   fit = exp( −ln(r / ziel)² / (2σ²) )        ∈ (0, 1]
 *
 * Bewusst im Logarithmus: ln(r/ziel) ist symmetrisch, das Doppelte und die
 * Haelfte eines Zielwerts sind gleich weit entfernt. Der frueher benutzte
 * absolute Abstand |r − ziel| war das nicht - er war bei 0,382 rund doppelt
 * so nachsichtig wie bei 0,786 und hat flache Korrekturen bevorzugt.
 *
 * @returns {{fit:number, ziel:number|null}}
 */
function elFit(r, ziele, sigma = EL_SIGMA) {
  if (!(r > 0) || !isFinite(r)) return { fit: 0, ziel: null };
  let best = 0, bestZiel = null;
  for (const z of ziele) {
    const d = Math.log(r / z);
    const f = Math.exp(-(d * d) / (2 * sigma * sigma));
    if (f > best) { best = f; bestZiel = z; }
  }
  return { fit: best, ziel: bestZiel };
}

/**
 * Prueft ein Fenster aus fuenf oder sechs Pivots auf die harten Regeln und
 * bewertet die Passung stetig.
 *
 *   sechs Pivots (P0…P5) = fuenf abgeschlossene Wellen
 *   fuenf  Pivots (P0…P4) = vier abgeschlossene Wellen, Welle 5 laeuft
 *
 * Kuerzere Fenster sind bewusst nicht zugelassen: Bei nur drei Wellen ist
 * einzig Regel R1 pruefbar, die Zaehlung waere praktisch unwiderlegbar. In
 * der Messung stammte ein knappes Viertel aller Zufallstreffer aus genau
 * diesen Drei-Wellen-Faellen.
 *
 * Harte Regeln (Verstoss verwirft den Kandidaten):
 *   R1  |W2| < |W1|            Welle 2 holt Welle 1 nicht vollstaendig zurueck
 *   R2  |W3| ist nicht die kuerzeste von |W1|, |W3|, |W5|
 *   R3  Welle 4 dringt nicht in das Gebiet von Welle 1 ein
 *
 * @returns {object|null} Kandidat, Verwurf oder null wenn kein Impulsmuster
 */
function elBewerte(p) {
  const n = p.length;
  if (n !== 5 && n !== 6) return null;
  const auf = p[1].price > p[0].price;

  // Die Punkte muessen sauber alternieren, sonst ist es kein Impuls.
  for (let i = 1; i < n; i++) {
    const steigt = p[i].price > p[i - 1].price;
    if (steigt !== (auf ? i % 2 === 1 : i % 2 === 0)) return null;
  }

  // Jede Welle braucht Zeit, nicht nur Ausschlag.
  for (let i = 1; i < n; i++) {
    if (p[i].index - p[i - 1].index < EL_MIN_WELLE_KERZEN) return null;
  }

  const w = [];
  for (let i = 1; i < n; i++) w.push(Math.abs(p[i].price - p[i - 1].price));
  const w1 = w[0], w2 = w[1], w3 = w[2], w4 = w[3], w5 = w[4];
  if (!(w1 > 0 && w2 > 0 && w3 > 0 && w4 > 0)) return null;

  const verstoesse = [];
  if (!(w2 < w1)) verstoesse.push("R1: Welle 2 holt Welle 1 vollständig zurück");
  // R3: Bei Aufwaerts darf das Tief von Welle 4 nicht unter das Hoch von Welle 1.
  if (auf ? p[4].price <= p[1].price : p[4].price >= p[1].price) {
    verstoesse.push("R3: Welle 4 überlappt das Gebiet von Welle 1");
  }
  if (n === 6) {
    if (!(w5 > 0)) return null;
    if (w3 <= Math.min(w1, w5)) verstoesse.push("R2: Welle 3 ist die kürzeste der Antriebswellen");
  }
  if (verstoesse.length) return { verworfen: true, verstoesse, pivots: p };

  /* --- Passung: stetig, kein Punktesystem --- */
  const rel = [];
  const nimm = (name, r, ziele) => { const f = elFit(r, ziele); rel.push({ name, r, fit: f.fit, ziel: f.ziel }); };
  nimm("Welle 2 / Welle 1", w2 / w1, Z_RET2);
  nimm("Welle 3 / Welle 1", w3 / w1, Z_W3);
  nimm("Welle 4 / Welle 3", w4 / w3, Z_RET4);
  if (n === 6) {
    const w13 = Math.abs(p[3].price - p[0].price);
    nimm("Welle 5 / Welle 1", w5 / w1, Z_W5_1);
    if (w13 > 0) nimm("Welle 5 / Welle 1–3", w5 / w13, Z_W5_13);
  }
  const passung = rel.reduce((s, x) => s + x.fit, 0) / rel.length;

  // Alternation: eine Korrektur flach, die andere scharf.
  const ret2 = w2 / w1, ret4 = w4 / w3;
  const altern = Math.min(1, Math.abs(ret2 - ret4) / EL_ALTERNATION_VOLL);

  return {
    verworfen: false, auf, pivots: p,
    laengen: { w1, w2, w3, w4, w5 }, ret2, ret4,
    relationen: rel, passung, altern,
    guete: 0.75 * passung + 0.25 * altern,
    vollstaendig: n === 6,
    abgeschlosseneWellen: n - 1,
  };
}

/**
 * Sucht ueber alle Betrachtungsebenen und alle Fenster die beste Zaehlung.
 *
 * Mehrere Ebenen, weil Elliott-Wellen fraktal sind: Eine einzige Schwelle
 * greift willkuerlich eine Ebene heraus. Welche Ebene die Zaehlung traegt,
 * wird mit ausgewiesen.
 *
 * @returns {{ok:boolean, guete:number, beste?:object, ...}}
 */
function elSuche(reihe) {
  const kurs = reihe.c[reihe.c.length - 1];
  const atr = elAtr(reihe.h, reihe.l, reihe.c);
  const alle = [];
  const proSkala = new Map();
  let verworfen = 0, gepruefte = 0;

  for (const k of EL_SKALEN) {
    const schwelle = Math.max(EL_MIN_PCT, atr && kurs > 0 ? (atr * k) / kurs : EL_MIN_PCT);
    const pivots = elDetectSwings(reihe, schwelle).slice(-EL_MAX_PIVOTS);
    proSkala.set(k, { schwelle, pivots });
    if (pivots.length < 5) continue;

    // Abgeschlossene Impulse: jedes Fenster aus sechs aufeinanderfolgenden Pivots
    for (let i = 0; i + 5 < pivots.length; i++) {
      gepruefte++;
      const b = elBewerte(pivots.slice(i, i + 6));
      if (!b) continue;
      if (b.verworfen) { verworfen++; continue; }
      alle.push({ ...b, skala: k, schwelle, letzterDerSkala: i + 5 === pivots.length - 1 });
    }
    // Laufender Impuls: die juengsten fuenf Pivots
    gepruefte++;
    const b = elBewerte(pivots.slice(-5));
    if (b && !b.verworfen) alle.push({ ...b, skala: k, schwelle, letzterDerSkala: true });
    else if (b) verworfen++;
  }

  if (!alle.length) return { ok: false, guete: 0, gepruefte, verworfen, kurs, proSkala };
  alle.sort((a, b) => b.guete - a.guete);
  return { ok: true, guete: alle[0].guete, beste: alle[0], kandidaten: alle,
           gepruefte, verworfen, kurs, atr, proSkala };
}

/* =====================================================================
   Signifikanz - schlaegt die Zaehlung den Zufall?
   ===================================================================== */

/**
 * Surrogatreihe per Block-Bootstrap der Log-Renditen.
 *
 * Bloecke von EL_BLOCK Handelstagen erhalten Volatilitaetscluster und
 * kurzfristige Autokorrelation - beides gibt es in echten Kursen und beides
 * erzeugt fuer sich genommen schon Zickzackmuster. Zerstoert wird nur die
 * uebergeordnete Abfolge, also genau das, was eine Wellenzaehlung behauptet.
 *
 * Bewusst nicht i.i.d. gezogen: Das waere ein zu leicht zu schlagender
 * Gegner und wuerde die Signifikanz schoenrechnen.
 */
function elSurrogat(reihe, rnd, L = EL_BLOCK) {
  const n = reihe.c.length;
  const ret = [], spanne = [];
  for (let i = 1; i < n; i++) ret.push(Math.log(reihe.c[i] / reihe.c[i - 1]));
  for (let i = 0; i < n; i++) {
    spanne.push([(reihe.h[i] - reihe.c[i]) / reihe.c[i], (reihe.c[i] - reihe.l[i]) / reihe.c[i]]);
  }
  const m = ret.length;
  if (m < L) return null;
  const neu = [];
  while (neu.length < m) {
    const s = Math.floor(rnd() * m);
    for (let j = 0; j < L && neu.length < m; j++) neu.push(ret[(s + j) % m]);
  }
  const c = [reihe.c[0]], h = [reihe.h[0]], l = [reihe.l[0]];
  for (let i = 1; i < n; i++) {
    const preis = c[i - 1] * Math.exp(neu[i - 1]);
    c.push(preis);
    const sp = spanne[Math.floor(rnd() * spanne.length)];
    h.push(preis * (1 + Math.abs(sp[0])));
    l.push(preis * (1 - Math.abs(sp[1])));
  }
  return { t: reihe.t, c, h, l };
}

/** Einfacher, reproduzierbarer Zufallsgenerator - gleicher Titel, gleiches Ergebnis. */
function elZufall(saat) {
  let s = saat >>> 0 || 1;
  return () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
}

/**
 * Empirischer p-Wert der beobachteten Guete.
 *
 *   p = (1 + #{Surrogate mit Guete ≥ beobachtet}) / (N + 1)
 *
 * Die Eins im Zaehler ist kein Schoenheitsfehler, sondern korrekt: Sie
 * verhindert p = 0, das bei endlich vielen Ziehungen nie belegbar waere.
 *
 * Weil auf jedem Surrogat dieselbe Suche mit derselben Bestenauswahl laeuft,
 * ist die Mehrfachauswahl ueber Fenster und Ebenen bereits eingerechnet.
 */
function elPWert(reihe, beobachtet, N, rnd) {
  let mindestensSoGut = 0, gerechnet = 0, mitZaehlung = 0;
  let summe = 0, max = 0;
  for (let i = 0; i < N; i++) {
    const s = elSurrogat(reihe, rnd);
    if (!s) break;
    const erg = elSuche(s);
    gerechnet++;
    /* Surrogate ohne jede regelkonforme Zaehlung zaehlen mit Guete null in
       den Test ein - sie schlagen die Beobachtung nicht. In den Mittelwert
       gehoeren sie aber nicht: Der wuerde sonst "keine Zaehlung gefunden" und
       "schlechte Zaehlung gefunden" zu einer Zahl verruehren. Beides wird
       getrennt ausgewiesen. */
    if (erg.ok) {
      mitZaehlung++;
      summe += erg.guete;
      if (erg.guete > max) max = erg.guete;
    }
    if (erg.guete >= beobachtet) mindestensSoGut++;
  }
  if (!gerechnet) return null;
  return {
    p: (1 + mindestensSoGut) / (gerechnet + 1),
    n: gerechnet,
    mitZaehlung,
    soGut: mindestensSoGut,
    mittelZufall: mitZaehlung ? summe / mitZaehlung : null,
    maxZufall: mitZaehlung ? max : null,
  };
}

/** Ampelstufe aus dem p-Wert. */
function elAmpel(p) {
  if (p <= EL_P_GRUEN) return { stufe: "gruen", text: "tragfähig",
    erklaerung: `Nur ${(p * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} % der Zufallsreihen erreichen diese Passung.` };
  if (p <= EL_P_GELB) return { stufe: "gelb", text: "grenzwertig",
    erklaerung: `${(p * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} % der Zufallsreihen erreichen diese Passung – die Zählung ist möglich, aber nicht belegt.` };
  return { stufe: "rot", text: "nicht vom Zufall zu unterscheiden",
    erklaerung: `${(p * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} % der Zufallsreihen erreichen diese Passung ebenfalls. Aus dieser Zählung lässt sich nichts ableiten.` };
}

/* =====================================================================
   Ableitungen - Ziel, Einstieg, Invalidierung
   ===================================================================== */

/**
 * Retracement-Level einer Welle.
 * level = ende − (ende − start) × r
 * Richtungsunabhaengig: Bei einer Abwaertswelle ist (ende − start) negativ,
 * das Level liegt dann oberhalb des Endes.
 */
function elRetracement(start, ende, ratios) {
  return ratios.map(r => ({ level: ende - (ende - start) * r, ratio: r }));
}

/**
 * Extension: eine Strecke vom Bezugspunkt aus verlaengern.
 * level = basis + laenge × r × richtung
 */
function elExtension(basis, laenge, richtung, ratios) {
  return ratios.map(r => ({ level: basis + laenge * r * richtung, ratio: r }));
}

/**
 * Zielzonen, Einstiegsbereich, Invalidierung und Chance-Risiko-Verhaeltnis.
 *
 * Anders als frueher werden NICHT alle denkbaren Beziehungen aufgespannt.
 * Das erzeugte zwar zuverlaessig Zonen, aber durch die schiere Menge an
 * Leveln - Zusammenfall aus Ueberfuellung ist kein Beleg. Hier stehen nur
 * die Projektionen der Welle, die tatsaechlich aussteht.
 *
 * Die Invalidierung ist der eigentliche Gewinn: Elliott definiert je Zaehlung
 * einen exakten Preis, ab dem sie widerlegt ist. Erst damit wird aus einer
 * Auslegung eine rechenbare Position.
 *
 * @param {object} kand   Kandidat aus elBewerte
 * @param {number} kurs   aktueller Kurs
 * @param {boolean} aktuell  reicht die Zaehlung bis an den Rand der Reihe?
 * @param {number} atr    mittlere Tagesspanne, zur Einordnung des Stop-Abstands
 */
function elAbleitungen(kand, kurs, aktuell, atr) {
  const p = kand.pivots;
  const richtung = kand.auf ? 1 : -1;
  const ziele = [];
  let einstieg = null, invalid = null, erstesZiel = null, lage = "";

  if (kand.vollstaendig) {
    /* Fuenf Wellen stehen - es folgt eine Korrektur gegen die Impulsrichtung.
       Deren Ziel ist zugleich der Bereich, in dem ein Wiedereinstieg IN
       Impulsrichtung liegt. */
    /* Die Korrektur-Level 0,382 / 0,5 / 0,618 des Gesamtimpulses stehen hier
       bewusst NICHT mehr als eigene Zielzonen: Die Fibonacci-Leiter zeigt
       genau diese Verhaeltnisse, nur vollstaendig und im Zusammenhang.
       Zweimal dasselbe unter zwei Ueberschriften waere keine zusaetzliche
       Information, sondern doppelte Buchfuehrung. */

    // Klassischer Einstiegsbereich: 0,5 bis 0,618 des Gesamtimpulses.
    const a = p[5].price - (p[5].price - p[0].price) * 0.5;
    const b = p[5].price - (p[5].price - p[0].price) * 0.618;
    einstieg = { low: Math.min(a, b), high: Math.max(a, b),
      herleitung: "0,5 bis 0,618 des Gesamtimpulses (Welle 0 → 5)" };
    // Haerteste Regel: Eine Korrektur ueber den Startpunkt hinaus verwirft die Zaehlung.
    invalid = { level: p[0].price, regel: "Korrektur läuft über den Ausgangspunkt von Welle 1 hinaus" };
    erstesZiel = { level: p[5].price, herleitung: "Rücklauf an das Ende von Welle 5" };
    lage = "Impuls abgeschlossen – eine Korrektur steht an.";
  } else {
    /* Vier Wellen stehen, Welle 5 laeuft. Der Einstieg lag im Gebiet von
       Welle 4; ob er noch offen ist, sagt der aktuelle Kurs. */
    const w1 = kand.laengen.w1;
    const w13 = Math.abs(p[3].price - p[0].price);
    elExtension(p[4].price, w1, richtung, Z_W5_1)
      .forEach(x => ziele.push({ ...x, herkunft: "Welle 5 aus Welle 1" }));
    if (w13 > 0) elExtension(p[4].price, w13, richtung, Z_W5_13)
      .forEach(x => ziele.push({ ...x, herkunft: "Welle 5 aus Welle 1–3" }));

    /* Einstiegsbereich am BEOBACHTETEN Ende der Welle 4, nicht an einem
       theoretischen Retracement. Wo Welle 4 haette enden koennen, ist eine
       Projektion; wo sie geendet hat, ist eine Tatsache - P4 steht fest.
       Das Band reicht von P4 bis 38,2 % in die Welle 4 zurueck: So weit darf
       ein Ruecksetzer in Welle 5 laufen und bleibt mit der Zaehlung vereinbar.

       Frueher war das Band an die Invalidierung geklemmt. Dort wird der
       Abstand zum Stop null und das Chance-Risiko-Verhaeltnis strebt gegen
       unendlich - eine Zahl, die gross aussieht und nichts bedeutet. */
    const tiefe = 0.382 * kand.laengen.w4;
    einstieg = kand.auf
      ? { low: p[4].price, high: p[4].price + tiefe,
          herleitung: "Ende von Welle 4 bis 38,2 % zurück in Welle 4" }
      : { low: p[4].price - tiefe, high: p[4].price,
          herleitung: "Ende von Welle 4 bis 38,2 % zurück in Welle 4" };
    invalid = { level: p[1].price, regel: "Welle 4 dringt in das Gebiet von Welle 1 ein (Regel R3)" };
    const konservativ = ziele.find(z => z.ratio === 0.618 && z.herkunft === "Welle 5 aus Welle 1");
    erstesZiel = konservativ ? { level: konservativ.level, herleitung: "Welle 5 erreicht 0,618 von Welle 1" } : null;
    lage = "Vier Wellen abgeschlossen – Welle 5 läuft.";
  }

  // Liegt der Kurs noch im Einstiegsbereich?
  if (einstieg) {
    einstieg.mitte = (einstieg.low + einstieg.high) / 2;
    einstieg.aktiv = kurs >= einstieg.low && kurs <= einstieg.high;
    einstieg.verlassen = kand.auf ? kurs > einstieg.high : kurs < einstieg.low;
  }

  /* Chance-Risiko-Verhaeltnis.
        CRV = |Ziel − Einstieg| / |Einstieg − Invalidierung|

     Bezugspunkt ist die Mitte des Einstiegsbereichs - ein definierter Punkt.
     Eine Spanne ueber das ganze Band waere irrefuehrend: Am Rand, der dicht
     an der Invalidierung liegt, geht das Risiko gegen null und das
     Verhaeltnis gegen unendlich. Bei einer Zaehlung, die Regel R3 nur knapp
     erfuellt, entstand so ein CRV von 22 - eine Zahl, die allein die Naehe
     zweier Linien spiegelt, nicht die Qualitaet des Aufbaus.

     Entscheidend ist deshalb der Stop-Abstand im Verhaeltnis zur mittleren
     Tagesspanne: Liegt die Invalidierung naeher als eine ATR, wird sie schon
     vom normalen Tagesrauschen ausgeloest. Das Verhaeltnis waere dann
     rechnerisch gross und praktisch wertlos. */
  let crv = null;
  if (einstieg && invalid && erstesZiel) {
    const risiko = Math.abs(einstieg.mitte - invalid.level);
    const chance = Math.abs(erstesZiel.level - einstieg.mitte);
    if (risiko > 0) {
      const inAtr = atr > 0 ? risiko / atr : null;
      crv = {
        wert: chance / risiko,
        risiko, chance,
        stopProzent: (risiko / kurs) * 100,
        stopInAtr: inAtr,
        // Unter einer ATR liegt der Stop im Tagesrauschen.
        imRauschen: inAtr != null && inAtr < 1,
        /* Beim abgeschlossenen Impuls folgt das Verhaeltnis allein aus den
           festen Verhaeltnissen 0,5 und 0,618 des Einstiegsbands und ist
           damit fuer JEDEN Titel gleich (rund 1,27). Es beschreibt die
           Methode, nicht diesen Titel - das gehoert dazugesagt. */
        strukturell: kand.vollstaendig,
      };
    }
  }

  return { ziele, einstieg: aktuell ? einstieg : null, invalid,
           erstesZiel, crv: aktuell ? crv : null, lage };
}

/**
 * Fibonacci-Retracement-Leiter zwischen zwei Punkten.
 *
 *   level(r) = bis − (bis − von) × r
 *
 * Bei r = 0 steht das Ende der Bewegung, bei r = 1 ihr Anfang. Richtungs-
 * unabhaengig: Bei einer Abwaertsbewegung ist (bis − von) negativ, die Leiter
 * laeuft dann nach oben.
 *
 * @param {number} von  Anfang der Bewegung
 * @param {number} bis  Ende der Bewegung
 * @param {number} kurs aktueller Kurs, um das Band darunter zu markieren
 */
function elFibLeiter(von, bis, kurs) {
  const stufen = EL_FIB_LEITER.map(r => ({
    ratio: r,
    level: bis - (bis - von) * r,
    // Die Zone, in der Korrekturen erfahrungsgemaess am haeufigsten enden.
    gold: r >= EL_GOLD_VON && r <= EL_GOLD_BIS,
  }));
  /* Baender zwischen benachbarten Stufen - sie tragen die Uebersicht, nicht
     die einzelnen Linien. Nach Preis sortiert, damit low immer unter high
     liegt, gleich in welche Richtung die Bewegung lief. */
  const sortiert = [...stufen].sort((a, b) => a.level - b.level);
  const baender = [];
  for (let i = 0; i + 1 < sortiert.length; i++) {
    const u = sortiert[i], o = sortiert[i + 1];
    baender.push({
      low: u.level, high: o.level,
      /* Nach Preis sortiert liegt bei einer Aufwaertsbewegung das groessere
         Verhaeltnis unten. Fuer die Beschriftung aufsteigend drehen - "0,382
         bis 0,5" liest sich, "0,5 bis 0,382" stolpert. */
      von: Math.min(u.ratio, o.ratio), bis: Math.max(u.ratio, o.ratio),
      // Goldenes Band nur, wenn BEIDE Raender dazugehoeren.
      gold: u.gold && o.gold,
      enthaeltKurs: kurs >= u.level && kurs <= o.level,
    });
  }
  return { stufen, baender, spanne: Math.abs(bis - von) };
}

/**
 * Welche Strecken der Zaehlung lassen sich sinnvoll als Anker verwenden?
 *
 * Bewusst nur abgeschlossene Wellen: Eine Leiter an eine noch laufende
 * Bewegung zu haengen hiesse, ihren Endpunkt zu erfinden. Der erste Eintrag
 * ist die Vorauswahl.
 */
function elFibAnker(kand) {
  const p = kand.pivots;
  const anker = [];
  if (kand.vollstaendig) {
    // Nach fuenf Wellen ist die Korrektur des Gesamtimpulses die Frage.
    anker.push({ id: "gesamt", name: "Gesamtimpuls 0 → 5", von: p[0].price, bis: p[5].price,
      hinweis: "Wohin eine Korrektur des gesamten Impulses laufen kann." });
    anker.push({ id: "w3", name: "Welle 3", von: p[2].price, bis: p[3].price,
      hinweis: "Zeigt, wie tief Welle 4 die stärkste Antriebswelle zurückgeholt hat." });
    anker.push({ id: "w5", name: "Welle 5", von: p[4].price, bis: p[5].price,
      hinweis: "Die letzte Antriebswelle – oft die erste Auffanglinie." });
  } else {
    /* Welle 5 laeuft, ihr Ende steht nicht fest. Anker deshalb auf die
       abgeschlossenen Strecken. */
    anker.push({ id: "w3", name: "Welle 3", von: p[2].price, bis: p[3].price,
      hinweis: "Welle 4 ist bereits gelaufen – hier steht, auf welcher Stufe sie endete." });
    anker.push({ id: "impuls13", name: "Welle 1 bis 3", von: p[0].price, bis: p[3].price,
      hinweis: "Die gesamte bisher abgeschlossene Impulsstrecke." });
    anker.push({ id: "w1", name: "Welle 1", von: p[0].price, bis: p[1].price,
      hinweis: "Die erste Antriebswelle als Massstab." });
  }
  return anker.filter(a => isFinite(a.von) && isFinite(a.bis) && a.von !== a.bis);
}

/**
 * Level zu Zonen buendeln, wo sie wirklich zusammenfallen.
 * Zwei Level gehoeren zusammen, wenn |lᵢ − lⱼ| / kurs < EL_CLUSTER_TOL.
 * Einzelne Level werden nicht unterschlagen - sie stehen als Zone mit einem
 * Level da. Frueher galt eine Mindestzahl von zwei, was Level verschwinden
 * liess, obwohl sie hergeleitet waren.
 */
function elZonen(level, kurs) {
  const gueltig = level.filter(x => isFinite(x.level) && x.level > 0)
                       .sort((a, b) => a.level - b.level);
  if (!gueltig.length || !(kurs > 0)) return [];
  const gruppen = [];
  let aktuell = [gueltig[0]];
  for (let i = 1; i < gueltig.length; i++) {
    if (Math.abs(gueltig[i].level - aktuell[aktuell.length - 1].level) / kurs < EL_CLUSTER_TOL) {
      aktuell.push(gueltig[i]);
    } else { gruppen.push(aktuell); aktuell = [gueltig[i]]; }
  }
  gruppen.push(aktuell);
  return gruppen.map(g => {
    const werte = g.map(x => x.level);
    return {
      low: Math.min(...werte), high: Math.max(...werte),
      mid: werte.reduce((a, b) => a + b, 0) / werte.length,
      hits: g.map(x => ({ ratio: x.ratio, herkunft: x.herkunft, level: x.level })),
    };
  }).sort((a, b) => Math.abs(a.mid - kurs) - Math.abs(b.mid - kurs));
}

/**
 * Wurde eine Zone seit dem Ende der Zaehlung bereits angelaufen?
 *
 * Wichtig bei historischen Zaehlungen: Ein "Ziel", das der Kurs vor Wochen
 * durchlaufen hat, ist kein Ziel mehr. Statt die Zone nur als "historisch" zu
 * beschriften, wird nachgesehen, ob eine Kerze seither in ihr gehandelt hat.
 */
function elBereitsErreicht(reihe, vonIndex, low, high) {
  for (let i = Math.max(0, vonIndex); i < reihe.c.length; i++) {
    if (reihe.l[i] <= high && reihe.h[i] >= low) return true;
  }
  return false;
}

/* =====================================================================
   Gesamtanalyse
   ===================================================================== */

/**
 * Gibt immer ein Objekt zurueck - im Zweifel mit grund, nie mit erfundenen
 * Zonen. Ziel- und Einstiegszonen entstehen nur, wenn der Signifikanztest
 * die Zaehlung traegt.
 */
function elAnalysiere(reihe, saat = 1) {
  if (!reihe || !Array.isArray(reihe.c) || reihe.c.length < EL_MIN_CANDLES) {
    return { ok: false, grund: `Zu wenige Kursdaten (${reihe && reihe.c ? reihe.c.length : 0} Kerzen, mindestens ${EL_MIN_CANDLES} nötig – der Signifikanztest braucht genug Renditen für den Bootstrap).` };
  }
  const kurs = reihe.c[reihe.c.length - 1];
  const suche = elSuche(reihe);

  if (!suche.ok) {
    const ebenen = [...suche.proSkala.values()].map(x => x.pivots.length).join(", ");
    return { ok: false, kurs, verworfen: suche.verworfen, gepruefte: suche.gepruefte,
      grund: suche.verworfen
        ? `Auf keiner der ${EL_SKALEN.length} Betrachtungsebenen bildet die Kursbewegung einen regelkonformen Impuls. ${suche.verworfen} von ${suche.gepruefte} geprüften Fenstern verletzen eine harte Regel.`
        : `Die Umkehrpunkte bilden auf keiner Betrachtungsebene eine impulsähnliche Abfolge (Umkehrpunkte je Ebene: ${ebenen}).` };
  }

  const beste = suche.beste;

  /* Reicht die Zaehlung bis an den Rand? Nur dann ist ein Einstiegsbereich
     ueberhaupt sinnvoll - eine Zaehlung, die vor achtzig Kerzen endete,
     beschreibt eine Bewegung, die laengst weitergelaufen ist. */
  const letzterPivot = beste.pivots[beste.pivots.length - 1];
  const letzterIdx = letzterPivot.index;
  const abstand = reihe.c.length - 1 - letzterIdx;
  const aktuell = !!beste.letzterDerSkala;
  /* Der letzte Punkt kann das laufende Extrem sein - dann ist die Welle, die
     dort endet, noch nicht bestaetigt abgeschlossen. Das aendert die Aussage
     erheblich und muss dabeistehen. */
  const letzterOffen = !!letzterPivot.offen;

  // Signifikanz gegen Surrogatreihen desselben Titels.
  const rnd = elZufall(saat);
  const sig = elPWert(reihe, beste.guete, EL_N_SURROGATE, rnd);
  if (!sig) {
    return { ok: false, kurs, grund: "Der Signifikanztest ließ sich nicht rechnen – die Reihe ist für den Bootstrap zu kurz." };
  }
  const ampel = elAmpel(sig.p);

  /* Bei Rot werden bewusst keine Ziele und kein Einstieg gezeigt. Die
     Zaehlung selbst bleibt sichtbar, damit nachvollziehbar ist, was geprueft
     wurde - aber sie traegt nichts. */
  const traegt = ampel.stufe !== "rot";
  const abl = traegt ? elAbleitungen(beste, kurs, aktuell, suche.atr) : null;
  const zielZonen = abl ? elZonen(abl.ziele, kurs) : [];
  /* Fibonacci-Leiter. Alle Anker werden mitgegeben, damit die Oberflaeche
     ohne Neurechnung umschalten kann - die Leiter ist eine reine Funktion
     zweier Preise. */
  const fibAnker = traegt ? elFibAnker(beste) : [];
  const fib = fibAnker.length
    ? { ...fibAnker[0], leiter: elFibLeiter(fibAnker[0].von, fibAnker[0].bis, kurs) }
    : null;
  // Seit dem letzten Punkt der Zaehlung: schon angelaufen oder noch offen?
  zielZonen.forEach(z => { z.erreicht = elBereitsErreicht(reihe, letzterIdx, z.low, z.high); });
  if (abl && abl.einstieg) {
    abl.einstieg.erreicht = elBereitsErreicht(reihe, letzterIdx, abl.einstieg.low, abl.einstieg.high);
  }

  return {
    ok: true, kurs, beste, ampel, sig, aktuell, abstand, traegt, letzterOffen,
    zielZonen, fibAnker, fib,
    einstieg: abl ? abl.einstieg : null,
    invalid: abl ? abl.invalid : null,
    erstesZiel: abl ? abl.erstesZiel : null,
    crv: abl ? abl.crv : null,
    lage: abl ? abl.lage : "",
    alternativen: suche.kandidaten.slice(1, 4),
    gepruefte: suche.gepruefte, verworfen: suche.verworfen,
    skala: beste.skala, schwelle: beste.schwelle,
    pivots: suche.proSkala.get(beste.skala).pivots,
  };
}

/* =====================================================================
   Speicherung - bewusst freiwillig, nichts wird ungefragt behalten
   ===================================================================== */
const ElliottSpeicher = {
  alle() {
    try { return JSON.parse(localStorage.getItem(EL_SPEICHER)) || {}; }
    catch (e) { return {}; }
  },
  lade(sym) { return this.alle()[sym] || null; },
  sichere(sym, eintrag) {
    const a = this.alle();
    a[sym] = { ...eintrag, gespeichert: Date.now() };
    try { localStorage.setItem(EL_SPEICHER, JSON.stringify(a)); return true; }
    catch (e) { return false; }
  },
  entferne(sym) {
    const a = this.alle();
    delete a[sym];
    try { localStorage.setItem(EL_SPEICHER, JSON.stringify(a)); } catch (e) {}
  },
};

/* =====================================================================
   Chart-Overlay

   Drei getrennte Darstellungen, weil es drei verschiedene Aussagen sind:
     Einstiegsbereich  gruen, gefuellt   - wo ein Einstieg zur Zaehlung passt
     Zielzonen         tuerkis, gestreift - wohin die naechste Welle projiziert
     Invalidierung     rot, durchgezogen  - ab wo die Zaehlung widerlegt ist
   ===================================================================== */

/** Kurze Preisangabe fuer Beschriftungen im Chart - dort zaehlt Platz. */
function elKurz(v) {
  const a = Math.abs(v);
  const stellen = a >= 1000 ? 0 : a >= 100 ? 1 : 2;
  return v.toLocaleString("de-DE", { minimumFractionDigits: stellen, maximumFractionDigits: stellen });
}

/**
 * Beschriftung mit dunklem Plaettchen darunter.
 *
 * Ohne Hintergrund verschwindet der Text, sobald er ueber Kerzen oder eine
 * Wellenmarke faellt - und genau das passiert am rechten Rand regelmaessig,
 * weil dort sowohl die Invalidierungslinie als auch der juengste Pivot sitzen.
 */
function elSchild(c, text, x, y, ausrichtung, farbe) {
  c.font = '600 9.5px "IBM Plex Mono", monospace';
  c.textAlign = ausrichtung; c.textBaseline = "bottom";
  const br = c.measureText(text).width;
  const links = ausrichtung === "right" ? x - br : x;
  c.fillStyle = "rgba(21,25,32,.82)";
  c.fillRect(links - 3, y - 10, br + 6, 12);
  c.fillStyle = farbe;
  c.fillText(text, x, y);
}

/* Zustand des gerade angezeigten Charts. Bewusst modulweit und nicht am
   Chart-Objekt: drawChart() zerstoert den Chart bei jedem Wechsel von
   Zeitraum oder Darstellung und baut ihn neu - eine Eigenschaft am Objekt
   waere dabei verloren. Beim Tickerwechsel raeumt elReset() auf. */
let elCurrent = null;

const elOverlay = {
  id: "elliott",
  afterDatasetsDraw(chart) {
    if (!elCurrent || chart.canvas.id !== "cv") return;
    const b = chart.chartArea, sx = chart.scales.x, sy = chart.scales.y;
    if (!b || !sx || !sy) return;
    const c = chart.ctx;

    /* x-Position eines Pivots. Im Kerzenmodus laeuft eine Zeitachse, im
       Linienmodus eine Kategorieachse mit fertigen Beschriftungen - dort
       zaehlt der Index innerhalb des sichtbaren Ausschnitts. */
    const xFuer = (piv) => {
      if (sx.type === "time") return sx.getPixelForValue(piv.date);
      const sichtbar = (chart.data.labels || []).length;
      const von = Math.max(0, elCurrent.total - sichtbar);
      const idx = piv.index - von;
      return idx < 0 || idx >= sichtbar ? null : sx.getPixelForValue(idx);
    };
    const band = (low, high) => {
      const y1 = sy.getPixelForValue(high), y2 = sy.getPixelForValue(low);
      if (!isFinite(y1) || !isFinite(y2)) return null;
      return { oben: Math.min(y1, y2), hoehe: Math.max(2, Math.abs(y2 - y1)) };
    };

    c.save();
    c.beginPath(); c.rect(b.left, b.top, b.width, b.height); c.clip();

    /* --- Fibonacci-Leiter, ganz nach hinten ---
       Die Baender tragen die Uebersicht, nicht die Linien. Bewusst
       zurueckhaltend eingefaerbt statt in sieben bunten Toenen: Der Blick
       soll auf der goldenen Zone landen, nicht auf einem Farbverlauf. */
    const fib = elCurrent.fibAn === false ? null : elCurrent.fib;
    if (fib && fib.leiter) {
      for (const bd of fib.leiter.baender) {
        const g = band(bd.low, bd.high); if (!g) continue;
        c.fillStyle = bd.gold ? "rgba(79,184,172,.09)" : "rgba(147,160,176,.05)";
        c.fillRect(b.left, g.oben, b.width, g.hoehe);
        // Das Band, in dem der Kurs gerade steht, bekommt eine feine Kante.
        if (bd.enthaeltKurs) {
          c.strokeStyle = "rgba(233,237,243,.16)"; c.lineWidth = 1;
          c.strokeRect(b.left + .5, g.oben + .5, b.width - 1, g.hoehe - 1);
        }
      }
      /* Linien und Beschriftungen. Von oben nach unten, damit die
         Kollisionspruefung eine feste Reihenfolge hat - sonst haengt das
         Ergebnis davon ab, in welcher Reihenfolge die Stufen ankommen. */
      const stufen = [...fib.leiter.stufen]
        .map(st => ({ ...st, y: sy.getPixelForValue(st.level) }))
        .filter(st => isFinite(st.y))
        .sort((x, y) => x.y - y.y);
      let letztesY = -Infinity;
      for (const st of stufen) {
        const rand = st.ratio === 0 || st.ratio === 1;
        c.strokeStyle = rand ? "rgba(147,160,176,.55)"
                      : st.gold ? "rgba(79,184,172,.5)" : "rgba(147,160,176,.28)";
        c.lineWidth = rand ? 1.2 : 1;
        c.setLineDash(rand ? [] : [2, 4]);
        c.beginPath(); c.moveTo(b.left, st.y); c.lineTo(b.right, st.y); c.stroke();
        c.setLineDash([]);
        // Beschriftung nur, wenn genug Platz zur vorigen ist.
        if (st.y - letztesY >= 13) {
          const txt = st.ratio.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 3 })
            + "  " + elKurz(st.level);
          elSchild(c, txt, b.right - 6, st.y - 2, "right",
            st.gold ? "rgba(79,184,172,.95)" : "rgba(147,160,176,.9)");
          letztesY = st.y;
        }
      }
    }

    // --- Zielzonen: tuerkis. Bereits angelaufene blasser. ---
    for (const z of elCurrent.zielZonen || []) {
      const g = band(z.low, z.high); if (!g) continue;
      c.fillStyle = z.erreicht ? "rgba(79,184,172,.07)" : "rgba(79,184,172,.20)";
      c.fillRect(b.left, g.oben, b.width, g.hoehe);
      c.strokeStyle = z.erreicht ? "rgba(79,184,172,.28)" : "rgba(79,184,172,.65)";
      c.setLineDash([4, 3]); c.lineWidth = 1;
      c.beginPath(); c.moveTo(b.left, g.oben); c.lineTo(b.right, g.oben);
      c.moveTo(b.left, g.oben + g.hoehe); c.lineTo(b.right, g.oben + g.hoehe); c.stroke();
      c.setLineDash([]);
    }

    // --- Einstiegsbereich: gruen, deutlicher als die Ziele ---
    const e = elCurrent.einstieg;
    if (e) {
      const g = band(e.low, e.high);
      if (g) {
        c.fillStyle = "rgba(84,177,131,.22)";
        c.fillRect(b.left, g.oben, b.width, g.hoehe);
        c.strokeStyle = "rgba(84,177,131,.8)"; c.lineWidth = 1.2;
        c.strokeRect(b.left + .5, g.oben + .5, b.width - 1, g.hoehe - 1);
        elSchild(c, "EINSTIEG", b.left + 6, g.oben - 3, "left", "rgba(84,177,131,.95)");
      }
    }

    // --- Invalidierung: rote Linie, die Zaehlung endet dort ---
    const iv = elCurrent.invalid;
    if (iv) {
      const y = sy.getPixelForValue(iv.level);
      if (isFinite(y)) {
        c.strokeStyle = "rgba(224,106,114,.9)"; c.lineWidth = 1.4;
        c.setLineDash([7, 4]);
        c.beginPath(); c.moveTo(b.left, y); c.lineTo(b.right, y); c.stroke();
        c.setLineDash([]);
        /* Nach links: Die rechte Kante traegt jetzt die Stufenpreise der
           Fibonacci-Leiter, dort waere die Beschriftung eingeklemmt. */
        elSchild(c, "INVALIDIERUNG " + elKurz(iv.level), b.left + 6, y - 3, "left",
                 "rgba(224,106,114,.95)");
      }
    }

    // --- Wellenlabels an den Pivots ---
    c.font = '600 10px "IBM Plex Mono", monospace';
    c.textAlign = "center"; c.textBaseline = "middle";
    const linien = [];
    for (const m of elCurrent.marken || []) {
      const x = xFuer(m), y = sy.getPixelForValue(m.price);
      if (x == null || !isFinite(x) || !isFinite(y)) continue;
      linien.push({ x, y });
      const oben = m.type === "high";
      const my = oben ? y - 13 : y + 13;
      c.beginPath(); c.arc(x, my, 8, 0, Math.PI * 2);
      c.fillStyle = "rgba(27,33,43,.92)"; c.fill();
      c.strokeStyle = "#4FB8AC"; c.lineWidth = 1; c.stroke();
      c.fillStyle = "#E9EDF3"; c.fillText(m.label, x, my);
      // Verbindung zum Kurspunkt
      c.beginPath(); c.moveTo(x, oben ? my + 8 : my - 8); c.lineTo(x, y);
      c.strokeStyle = "rgba(79,184,172,.5)"; c.stroke();
    }
    // Zickzack zwischen den Punkten - macht die Zaehlung als Linienzug lesbar
    if (linien.length > 1) {
      c.beginPath(); c.moveTo(linien[0].x, linien[0].y);
      for (let i = 1; i < linien.length; i++) c.lineTo(linien[i].x, linien[i].y);
      c.strokeStyle = "rgba(79,184,172,.45)"; c.lineWidth = 1.2;
      c.setLineDash([3, 3]); c.stroke(); c.setLineDash([]);
    }
    c.restore();
  },
};
if (typeof Chart !== "undefined") Chart.register(elOverlay);

/* =====================================================================
   Oberflaeche
   ===================================================================== */

/** Zwischenspeicher je Ticker. Schluessel enthaelt die Datenlage, damit eine
    veraenderte Kursreihe automatisch neu gerechnet wird. */
const elCache = new Map();
const elSchluessel = (sym, reihe) => `${sym}|${reihe.c.length}|${reihe.t[reihe.t.length - 1]}`;

/** Beim Tickerwechsel aufraeumen: Ergebnis verwerfen, Overlay entfernen. */
function elReset() {
  elCurrent = null;
  document.getElementById("panel")?.classList.remove("weit");
}

function elAbschnitt() {
  return `<div class="blk el-blk" id="el-blk">
    <h3>Elliot Wellen bestimmen</h3>
    <button class="el-run" id="el-run">Elliot Waves berechnen</button>
    <div id="el-out"></div>
    <p class="el-hint">Elliott-Wellen sind Auslegung, keine Messung. Jede Zählung wird hier
      gegen ${EL_N_SURROGATE} Zufallsreihen aus den eigenen Renditen dieses Titels geprüft –
      angezeigt wird, wie oft der Zufall dieselbe Passung erreicht. Die Zählung ist keine
      Kursprognose und keine Anlageempfehlung.</p>
  </div>`;
}

/** Aus dem Tickersymbol eine feste Saat - gleicher Titel, gleiches Ergebnis. */
function elSaat(sym) {
  let h = 2166136261;
  for (let i = 0; i < sym.length; i++) { h ^= sym.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function elVerdrahte(item, reihe, neuZeichnen) {
  const btn = document.getElementById("el-run");
  const out = document.getElementById("el-out");
  if (!btn || !out) return;

  // Bereits gespeicherte Zählung anbieten, aber nicht ungefragt anwenden.
  const gesichert = ElliottSpeicher.lade(item.s);
  if (gesichert) {
    out.innerHTML = `<div class="el-saved">Für diesen Titel ist eine Zählung gespeichert
      (${new Date(gesichert.gespeichert).toLocaleDateString("de-DE")}).
      <button class="el-mini" id="el-load">Anzeigen</button>
      <button class="el-mini" id="el-drop">Verwerfen</button></div>`;
    document.getElementById("el-load").onclick = () => {
      elZeige(out, gesichert.ergebnis, reihe, item, neuZeichnen, true);
    };
    document.getElementById("el-drop").onclick = () => {
      ElliottSpeicher.entferne(item.s); out.innerHTML = "";
    };
  }

  btn.onclick = async () => {
    btn.disabled = true;
    const alt = btn.textContent;
    btn.innerHTML = '<span class="spin"></span> Wellen werden gezählt und gegen Zufall geprüft …';
    out.innerHTML = "";
    /* Kurz zuruecktreten, damit der Ladezustand gezeichnet wird, bevor gerechnet
       wird. Bewusst setTimeout statt requestAnimationFrame: rAF pausiert,
       sobald der Tab in den Hintergrund geht - wer klickt und wegschaltet,
       bekaeme sonst nie ein Ergebnis. */
    await new Promise(r => setTimeout(r, 16));
    try {
      const key = elSchluessel(item.s, reihe);
      let erg = elCache.get(key);
      if (!erg) { erg = elAnalysiere(reihe, elSaat(item.s)); elCache.set(key, erg); }
      elZeige(out, erg, reihe, item, neuZeichnen, false);
    } catch (e) {
      out.innerHTML = `<div class="el-leer">Die Zählung ist fehlgeschlagen: ${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = alt;
    }
  };
}

/** Wellenlabels je Pivot. */
function elMarken(k) {
  const namen = k.vollstaendig ? ["0", "1", "2", "3", "4", "5"] : ["0", "1", "2", "3", "4"];
  return k.pivots.map((p, i) => ({ ...p, label: namen[i] ?? String(i) }));
}

function elZeige(out, erg, reihe, item, neuZeichnen, ausSpeicher) {
  const panel = document.getElementById("panel");
  // Ansicht verbreitern - die Tabellen und das Chart brauchen Platz.
  if (panel) panel.classList.add("weit");

  const cur = (reihe.meta && reihe.meta.currency) || "";
  const g = (v, d) => (typeof moneyNum === "function" ? moneyNum(v, cur, d ?? 2) : Number(v).toFixed(2));
  const dat = ts => new Date(ts).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
  /* Deutsche Schreibweise: Komma als Dezimaltrenner, Minuszeichen statt
     Bindestrich. toFixed liefert beides falsch. */
  const pz = (v, d = 1) => (v >= 0 ? "+" : "−") + Math.abs(v).toLocaleString("de-DE",
    { minimumFractionDigits: d, maximumFractionDigits: d }) + " %";
  const zahl = (v, d = 2) => Number(v).toLocaleString("de-DE",
    { minimumFractionDigits: d, maximumFractionDigits: d });

  if (!erg.ok) {
    elCurrent = null;
    out.innerHTML = `<div class="el-leer"><b>Keine tragfähige Wellenzählung</b>
      <p>${esc(erg.grund)}</p>
      <p class="el-detail">Es werden bewusst keine Zonen gezeigt, wenn keine Zählung trägt.</p></div>`;
    if (typeof neuZeichnen === "function") neuZeichnen();
    return;
  }

  const k = erg.beste;
  const marken = elMarken(k);
  // Bei Rot wird nichts ins Chart gezeichnet ausser der Zaehlung selbst.
  elCurrent = {
    fib: erg.traegt ? erg.fib : null,
    fibAn: true,
    zielZonen: erg.traegt ? erg.zielZonen : [],
    einstieg: erg.traegt ? erg.einstieg : null,
    invalid: erg.traegt ? erg.invalid : null,
    marken, total: reihe.c.length,
  };

  /* --- Ampel: das Erste, was zu sehen ist --- */
  const a = erg.ampel;
  const ampelHtml = `<div class="el-ampel el-${a.stufe}">
    <div class="el-ampel-kopf">
      <span class="el-punkt"></span>
      <div><b>${esc(a.text)}</b>
        <span class="el-p">p = ${zahl(erg.sig.p, 3)}</span></div>
    </div>
    <p>${esc(a.erklaerung)}</p>
    <p class="el-detail">Geprüft gegen ${erg.sig.n} Surrogatreihen aus den Renditen dieses Titels
      (Block-Bootstrap, ${EL_BLOCK} Handelstage). Davon ergaben ${erg.sig.mitZaehlung}
      überhaupt eine regelkonforme Zählung${erg.sig.mittelZufall != null
        ? ` – mittlere Güte ${zahl(erg.sig.mittelZufall, 3)}, beste ${zahl(erg.sig.maxZufall, 3)}` : ""}.
      ${erg.sig.soGut} Surrogate erreichten die Güte dieser Zählung (${zahl(k.guete, 3)}) oder mehr.</p>
  </div>`;

  /* --- Die Zaehlung selbst --- */
  const zaehlung = `<table class="el-tab">
    <tr><th>Welle</th><th>Datum</th><th>Kurs</th><th>Bewegung</th></tr>
    ${marken.map((m, i) => {
      const vor = i > 0 ? marken[i - 1] : null;
      const bew = vor ? (m.price / vor.price - 1) * 100 : null;
      return `<tr><td><b>${m.label}</b></td><td>${dat(m.date)}</td><td>${g(m.price)}</td>
        <td class="${bew == null ? "" : bew >= 0 ? "up" : "down"}">${bew == null ? "–" : pz(bew)}</td></tr>`;
    }).join("")}
  </table>`;

  /* --- Passung je Beziehung, offen ausgewiesen --- */
  const relHtml = `<table class="el-tab el-rel">
    <tr><th>Beziehung</th><th>gemessen</th><th>nächstes Ziel</th><th>Passung</th></tr>
    ${k.relationen.map(r => `<tr>
      <td>${esc(r.name)}</td><td>${zahl(r.r, 3)}</td>
      <td>${r.ziel != null ? zahl(r.ziel, 3) : "–"}</td>
      <td><span class="el-fit"><i style="width:${Math.round(r.fit * 100)}%"></i></span>${zahl(r.fit, 2)}</td>
    </tr>`).join("")}
  </table>
  <p class="el-detail">Passung = exp(−ln(gemessen/Ziel)² / 2σ²) mit σ = ${zahl(EL_SIGMA, 2)}.
    Im Logarithmus gerechnet, damit das Doppelte und die Hälfte eines Zielwerts gleich weit
    entfernt sind. Gesamtpassung ${zahl(k.passung, 3)}, Alternation ${zahl(k.altern, 2)},
    Güte ${zahl(k.guete, 3)} = 0,75 × Passung + 0,25 × Alternation.</p>`;

  /* --- Lage, Einstieg, Invalidierung, CRV --- */
  let handel = "";
  if (!erg.traegt) {
    handel = `<div class="el-leer"><b>Keine Ziel- oder Einstiegszonen</b>
      <p>Diese Zählung ist statistisch nicht von einer Zufallsbewegung zu unterscheiden.
      Zonen daraus abzuleiten hieße, Rauschen als Struktur auszugeben.</p></div>`;
  } else {
    const iv = erg.invalid;
    const c = erg.crv;
    const nichtAktuell = !erg.aktuell;
    handel = `<div class="el-lage">${esc(erg.lage)}
      ${nichtAktuell ? `<span class="el-marke el-alt-marke">historisch – letzter Punkt liegt
        ${erg.abstand} Handelstage zurück</span>` : ""}
      ${erg.letzterOffen ? `<span class="el-marke el-alt-marke">letzter Punkt noch nicht bestätigt</span>` : ""}</div>
      ${erg.letzterOffen ? `<p class="el-detail">Der letzte Punkt der Zählung ist das derzeit
        laufende Extrem, kein abgeschlossener Umkehrpunkt. Die Welle, die dort endet, kann sich
        noch ausdehnen – dann verschieben sich Einstiegsbereich und Ziele mit.</p>` : ""}`;

    if (erg.einstieg) {
      const e = erg.einstieg;
      const zustand = e.aktiv ? `<span class="el-marke el-ok">Kurs liegt im Bereich</span>`
        : e.verlassen ? `<span class="el-marke el-alt-marke">bereits verlassen</span>`
        : `<span class="el-marke">noch nicht erreicht</span>`;
      handel += `<div class="el-box el-einstieg">
        <div class="el-box-k"><b>Einstiegsbereich</b>${zustand}</div>
        <div class="el-preis">${g(e.low)} – ${g(e.high)}</div>
        <div class="el-zone-d">${esc(e.herleitung)}</div>
      </div>`;
    } else if (nichtAktuell) {
      handel += `<div class="el-box"><div class="el-box-k"><b>Kein Einstiegsbereich</b></div>
        <div class="el-zone-d">Die Zählung endet ${erg.abstand} Handelstage vor dem aktuellen Rand.
        Die Bewegung ist seither weitergelaufen – ein Einstieg daraus wäre nicht mehr gedeckt.</div></div>`;
    }

    if (iv) {
      const abst = (iv.level / erg.kurs - 1) * 100;
      handel += `<div class="el-box el-invalid">
        <div class="el-box-k"><b>Invalidierung</b><span class="el-marke el-nein">${pz(abst)} zum Kurs</span></div>
        <div class="el-preis">${g(iv.level)}</div>
        <div class="el-zone-d">${esc(iv.regel)}. Jenseits dieses Preises ist die Zählung
          nicht mehr auslegbar, sondern widerlegt.</div>
      </div>`;
    }

    if (c) {
      handel += `<div class="el-box">
        <div class="el-box-k"><b>Chance-Risiko-Verhältnis</b>
          <span class="el-marke ${c.wert >= 2 ? "el-ok" : c.wert >= 1 ? "" : "el-nein"}">${zahl(c.wert, 2)} : 1</span></div>
        <div class="el-zone-d">
          Chance ${g(c.chance)} gegen Risiko ${g(c.risiko)}, gemessen von der Mitte des
          Einstiegsbereichs zum ersten Ziel ${erg.erstesZiel ? g(erg.erstesZiel.level) : "–"}
          ${erg.erstesZiel ? `(${esc(erg.erstesZiel.herleitung)})` : ""}.<br>
          Stop-Abstand ${zahl(c.stopProzent, 1)} %${c.stopInAtr != null
            ? ` = ${zahl(c.stopInAtr, 1)} × mittlere Tagesspanne` : ""}.
          ${c.imRauschen ? `<b class="el-warnung">Der Stop liegt unter einer Tagesspanne –
            er würde schon vom normalen Rauschen ausgelöst. Das Verhältnis ist rechnerisch
            richtig und praktisch wertlos.</b>` : ""}
          ${c.strukturell ? `<br><i>Bei einem abgeschlossenen Impuls folgt dieser Wert allein
            aus dem Einstiegsband 0,5–0,618 und ist für jeden Titel gleich. Er beschreibt das
            Verfahren, nicht diesen Titel.</i>` : ""}
        </div>
      </div>`;
    }
  }

  /* --- Zielzonen --- */
  const zonenHtml = !erg.traegt ? "" : (erg.zielZonen.length ? erg.zielZonen.map(z => {
    const abst = (z.mid / erg.kurs - 1) * 100;
    const ratios = [...new Set(z.hits.map(h => h.ratio))].sort((x, y) => x - y)
      .map(r => r.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 3 }))
      .join(" · ");
    const herkunft = [...new Set(z.hits.map(h => h.herkunft))].join(", ");
    return `<div class="el-zone${z.erreicht ? " el-erreicht" : ""}">
      <div class="el-zone-k"><b>${g(z.low)}${z.low !== z.high ? " – " + g(z.high) : ""}</b>
        <span class="${abst >= 0 ? "up" : "down"}">${pz(abst)} zum Kurs</span></div>
      <div class="el-zone-d">${z.hits.length} Level · Verhältnisse ${ratios}
        ${z.erreicht ? `<span class="el-marke el-alt-marke">seit Ende der Zählung bereits angelaufen</span>`
                     : `<span class="el-marke el-ok">noch offen</span>`}
        <br><i>${esc(herkunft)}</i></div>
    </div>`;
  }).join("") : `<div class="el-detail">Aus dieser Zählung ergeben sich keine Projektionen.</div>`);

  /* --- Fibonacci-Retracement ---
     Der Anker laesst sich umschalten, ohne neu zu rechnen: Die Leiter ist
     eine reine Funktion zweier Preise, und alle in Frage kommenden Strecken
     der Zaehlung liegen dem Ergebnis bereits bei. */
  /* Verhaeltnisse ueberall gleich schreiben: 0,5 statt 0,500, aber 0,236 mit
     allen Stellen. Dieselbe Regel benutzt die Beschriftung im Chart. */
  const verh = r => r.toLocaleString("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 3 });
  const fibHtml = () => {
    if (!erg.traegt || !erg.fib) return "";
    const f = erg.fib, L = f.leiter;
    const wahl = erg.fibAnker.map(a => `<button class="el-fibbtn${a.id === f.id ? " on" : ""}"
      data-anker="${a.id}">${esc(a.name)}</button>`).join("")
      + `<button class="el-fibbtn el-fibtoggle${elCurrent && elCurrent.fibAn === false ? "" : " on"}"
           id="el-fibtoggle">${elCurrent && elCurrent.fibAn === false
             ? "im Chart einblenden" : "im Chart ausblenden"}</button>`;
    const drin = L.baender.find(x => x.enthaeltKurs);
    const stufen = L.stufen.map(st => {
      const abst = (st.level / erg.kurs - 1) * 100;
      return `<tr class="${st.gold ? "gold" : ""}">
        <td><b>${verh(st.ratio)}</b></td>
        <td>${g(st.level)}</td>
        <td class="${abst >= 0 ? "up" : "down"}">${pz(abst)}</td>
        <td>${st.ratio === 0 ? "Ende der Bewegung" : st.ratio === 1 ? "Anfang der Bewegung"
              : st.gold ? "goldene Zone" : ""}</td>
      </tr>`;
    }).join("");
    return `<div class="el-fibwahl">${wahl}</div>
      <p class="el-detail">${esc(f.hinweis)} Spanne ${g(L.spanne)}.</p>
      <table class="el-tab el-fibtab">
        <tr><th>Stufe</th><th>Preis</th><th>Abstand</th><th></th></tr>${stufen}
      </table>
      <p class="el-detail">Stufe = Ende − (Ende − Anfang) × Verhältnis. 0 liegt am Ende der
        Bewegung, 1 an ihrem Anfang.
        ${drin ? `Der Kurs steht zwischen ${verh(drin.von)} und ${verh(drin.bis)}${
          drin.gold ? " – also in der goldenen Zone" : ""}.`
        : "Der Kurs liegt außerhalb der Leiter."}</p>`;
  };
  const fibVerdrahten = () => {
    const schalter = document.getElementById("el-fibtoggle");
    if (schalter) schalter.onclick = () => {
      if (elCurrent) elCurrent.fibAn = elCurrent.fibAn === false;
      const box = document.getElementById("el-fib");
      if (box) { box.innerHTML = fibHtml(); fibVerdrahten(); }
      if (typeof neuZeichnen === "function") neuZeichnen();
    };
    document.querySelectorAll(".el-fibbtn[data-anker]").forEach(btn => {
      btn.onclick = () => {
        const a = erg.fibAnker.find(x => x.id === btn.dataset.anker);
        if (!a) return;
        erg.fib = { ...a, leiter: elFibLeiter(a.von, a.bis, erg.kurs) };
        if (elCurrent) elCurrent.fib = erg.fib;
        const box = document.getElementById("el-fib");
        if (box) { box.innerHTML = fibHtml(); fibVerdrahten(); }
        if (typeof neuZeichnen === "function") neuZeichnen();
      };
    });
  };

  /* --- Weitere zulaessige Zaehlungen --- */
  const alt = erg.alternativen.length ? `<details class="el-alt">
    <summary>${erg.alternativen.length} weitere regelkonforme Zählung${erg.alternativen.length > 1 ? "en" : ""}</summary>
    <p class="el-detail">Ohne eigenen Signifikanztest. Der p-Wert oben gilt für die beste Zählung
      und schließt die Auswahl unter allen geprüften Fenstern bereits ein – für jede Alternative
      einzeln wäre er nicht in derselben Weise definiert.</p>
    ${erg.alternativen.map(x => `<div class="el-alt-e">
      <b>Güte ${zahl(x.guete, 3)}</b> · ${x.vollstaendig ? "fünf Wellen" : "Welle 5 läuft"} ·
      ${x.auf ? "aufwärts" : "abwärts"} · Ebene ATR × ${zahl(x.skala, 2)} ·
      ${dat(x.pivots[0].date)} bis ${dat(x.pivots[x.pivots.length - 1].date)}
    </div>`).join("")}
  </details>` : "";

  const fuss = `<p class="el-detail">Richtung ${k.auf ? "aufwärts" : "abwärts"} ·
    Betrachtungsebene ATR × ${zahl(erg.skala, 2)} (Schwelle
    ${zahl(erg.schwelle * 100, 1)} %) · ${erg.pivots.length} Umkehrpunkte auf dieser Ebene ·
    ${erg.gepruefte} Fenster über ${EL_SKALEN.length} Ebenen geprüft${erg.verworfen
      ? `, ${erg.verworfen} wegen Regelverstoß verworfen` : ""}.</p>`;

  out.innerHTML = `
    ${ampelHtml}
    <h4 class="el-h">Gefundene Zählung</h4>${zaehlung}
    <h4 class="el-h">Passung der Wellenverhältnisse</h4>${relHtml}
    <h4 class="el-h">Einordnung</h4>${handel}
    ${erg.traegt && erg.fib ? `<h4 class="el-h">Fibonacci-Retracement</h4>
      <div id="el-fib">${fibHtml()}</div>` : ""}
    ${erg.traegt && erg.zielZonen.length ? `<h4 class="el-h">Projektionen der laufenden Welle</h4>${zonenHtml}` : ""}
    ${alt}
    ${fuss}
    <div class="el-acts">
      ${ausSpeicher
        ? `<button class="el-mini" id="el-drop2">Gespeicherte Zählung verwerfen</button>`
        : `<button class="el-mini" id="el-save">Diese Zählung speichern</button>`}
      <span class="el-detail" id="el-savemsg"></span>
    </div>`;

  fibVerdrahten();

  const save = document.getElementById("el-save");
  if (save) save.onclick = () => {
    const ok = ElliottSpeicher.sichere(item.s, { ergebnis: erg });
    document.getElementById("el-savemsg").textContent = ok
      ? "Gespeichert – bleibt in diesem Browser erhalten."
      : "Speichern fehlgeschlagen (Speicher voll?).";
    save.disabled = true;
  };
  const drop2 = document.getElementById("el-drop2");
  if (drop2) drop2.onclick = () => {
    ElliottSpeicher.entferne(item.s);
    document.getElementById("el-savemsg").textContent = "Verworfen.";
    drop2.disabled = true;
  };

  if (typeof neuZeichnen === "function") neuZeichnen();
}

/* =====================================================================
   Wellen-Laufband auf der Startseite

   Zeigt, welche Titel der Abdeckung derzeit eine tragfaehige Zaehlung
   haben. Bewusst nur gruen und gelb: Rote und zaehlungslose Titel sind die
   Mehrheit, sie wuerden das Band fuellen, ohne etwas zu sagen. Ihre Zahl
   steht stattdessen im Kopf der Sektion - das ist die ehrlichere Angabe.

   Die Daten kommen fertig aus data/elliott.json. Die Zaehlung je Titel
   braucht 999 Surrogatlaeufe; das im Browser fuer die ganze Abdeckung zu
   rechnen waere Verschwendung. Erzeugt wird die Datei wie chancen.json
   naechtlich im Repository.
   ===================================================================== */

const EL_BAND_QUELLE = "data/elliott.json";
/** Verschiebung je gescrolltem Pixel. Der Abschnitt steht ganz oben und ist
    beim Scrollen nur kurz im Blick - bei zu kleinem Wert bewegt sich in
    dieser Zeit sichtbar nichts. */
const EL_BAND_TEMPO = 0.30;

const ElliottBand = {
  daten: null,
  async lade() {
    if (this.daten) return this.daten;
    const res = await fetch(EL_BAND_QUELLE + "?v=" + Date.now(), { cache: "no-cache" });
    if (!res.ok) throw new Error("Abdeckung nicht erreichbar");
    this.daten = await res.json();
    return this.daten;
  },
};

/** Eine Kachel. Klickbar - sie fuehrt in die Detailansicht des Titels. */
function elBandKachel(t) {
  const farbe = { gruen: "var(--up)", gelb: "var(--warn)", rot: "var(--down)" }[t.stufe] || "var(--faint)";
  const p = t.p.toLocaleString("de-DE", { minimumFractionDigits: 3, maximumFractionDigits: 3 });
  return `<button class="wb-kachel" data-sym="${esc(t.sym)}"
      title="${esc(t.name)} – p = ${p}, ${esc(t.lage)}">
    <span class="wb-kopf">
      <span class="wb-punkt" style="background:${farbe}"></span>
      <b>${esc(t.sym)}</b>
      <span class="wb-p">p ${p}</span>
    </span>
    <span class="wb-name">${esc(t.name)}</span>
    <span class="wb-lage">${esc(t.lage)}${t.aktuell ? "" : " · historisch"}</span>
  </button>`;
}

/**
 * Baut das Band und haengt es an die Scrollposition.
 *
 * Zwei Reihen, gegenlaeufig - dieselbe Bewegung wie beim Vorbild. Jede Reihe
 * wird verdreifacht, damit an den Raendern nichts ausgeht.
 */
async function elBandZeichne() {
  const kopf = document.getElementById("wellenmeta");
  const koerper = document.getElementById("wellenbody");
  const schalter = document.getElementById("wellentoggle");
  if (!koerper) return;

  /* Ein- und Ausklappen wie bei den anderen Sektionen, mit derselben
     Merkfaehigkeit im Browser. Steht vor dem Laden, damit der Schalter
     auch dann funktioniert, wenn die Datei nicht erreichbar ist. */
  if (schalter) {
    let offen = true;
    try { offen = localStorage.getItem("ak.wellen.open") !== "0"; } catch (e) {}
    const male = () => {
      koerper.style.display = offen ? "" : "none";
      schalter.textContent = offen ? "Einklappen" : "Ausklappen";
    };
    male();
    schalter.onclick = () => {
      offen = !offen;
      try { localStorage.setItem("ak.wellen.open", offen ? "1" : "0"); } catch (e) {}
      male();
    };
  }

  let d;
  try { d = await ElliottBand.lade(); }
  catch (e) {
    koerper.innerHTML = `<div class="wb-leer">Die Abdeckung ist gerade nicht erreichbar.</div>`;
    return;
  }
  const titel = d.titel || [];
  if (!titel.length) {
    koerper.innerHTML = `<div class="wb-leer">Derzeit trägt keine Zählung.</div>`;
    if (kopf) kopf.textContent = "";
    return;
  }

  if (kopf) {
    const gruen = titel.filter(t => t.stufe === "gruen").length;
    kopf.innerHTML = `<b>${titel.length}</b> von ${d.geprueft} geprüften Titeln tragen –
      davon ${gruen} tragfähig (p ≤ 0,05). ${d.ohne_zaehlung + d.rot} ohne belastbare Zählung.
      Stand ${new Date(d.stand).toLocaleDateString("de-DE")}.`;
  }

  const mitte = Math.ceil(titel.length / 2);
  const oben = titel.slice(0, mitte), unten = titel.slice(mitte);
  const reihe = (liste) => liste.concat(liste, liste).map(elBandKachel).join("");
  koerper.innerHTML = `<div class="wb-band">
      <div class="wb-reihe" id="wb-r1">${reihe(oben)}</div>
      <div class="wb-reihe" id="wb-r2">${reihe(unten)}</div>
    </div>`;

  koerper.querySelectorAll(".wb-kachel").forEach(b => {
    b.onclick = () => {
      const sym = b.dataset.sym;
      const t = titel.find(x => x.sym === sym);
      const r = (typeof DB !== "undefined" && DB.rows && DB.rows.length)
        ? DB.rows.find(x => x[0] === sym) : null;
      openDetail(r ? { s: sym, n: r[1], c: r[2] || "", e: r[3] || "", sec: r[4] || "" }
                   : { s: sym, n: (t && t.name) || sym, c: "", e: "", sec: "" });
    };
  });

  elBandBewegung();
}

/** Verschiebt die beiden Reihen gegenlaeufig mit der Scrollposition. */
function elBandBewegung() {
  const r1 = document.getElementById("wb-r1"), r2 = document.getElementById("wb-r2");
  const band = document.getElementById("wellenbody");
  if (!r1 || !r2 || !band) return;
  // Wer Bewegung abbestellt hat, bekommt ein ruhiges Band.
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;

  /* Umlauf = Abstand von der ersten zur ersten wiederholten Kachel. Bewusst
     gemessen und nicht als scrollWidth/3 gerechnet: scrollWidth laesst den
     letzten Zwischenraum weg, der Umlauf waere drei Pixel zu kurz und die
     Reihe wuerde bei jeder Runde ein Stueck verspringen. */
  const umlaufVon = (reihe) => {
    const k = reihe.children;
    const n = k.length / 3;
    return (n >= 1 && k[n]) ? k[n].offsetLeft - k[0].offsetLeft : reihe.scrollWidth / 3 || 1;
  };
  let laeuft = false;
  const schieben = () => {
    laeuft = false;
    const oben = band.getBoundingClientRect().top + window.scrollY;
    const versatz = (window.scrollY - oben + window.innerHeight) * EL_BAND_TEMPO;
    const umlauf = umlaufVon(r1);
    /* Rest immer in [0, umlauf) bringen. Der einfache Modulo liefert bei
       negativem Versatz ein negatives Ergebnis - und negativ wird die erste
       Reihe nach RECHTS geschoben, wodurch links eine Luecke aufreisst.
       Genau das passiert, solange das Band noch unter dem Falz liegt. */
    const rest = ((versatz % umlauf) + umlauf) % umlauf;
    r1.style.transform = `translateX(${-rest}px)`;
    r2.style.transform = `translateX(${rest - umlauf}px)`;
  };
  const anstossen = () => { if (!laeuft) { laeuft = true; requestAnimationFrame(schieben); } };
  window.addEventListener("scroll", anstossen, { passive: true });
  window.addEventListener("resize", anstossen);
  schieben();
}
