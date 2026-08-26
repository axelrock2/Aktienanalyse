"use strict";
/* =====================================================================
   Elliott-Wellen-Modul

   Rechnet ausschliesslich auf Klick. Die Rechenfunktionen sind rein - sie
   nehmen Zahlen entgegen und geben Zahlen zurueck, ohne das Dokument zu
   beruehren. Die DOM-Logik steht weiter unten, sauber getrennt.

   Klassisches Script, kein ES-Modul: Das Projekt bindet app.js, depot.js und
   valuation.js als gewoehnliche Skripte ein und teilt sich einen globalen
   Namensraum. Ein Modul kaeme an loadChart, analyse oder chartObj nicht heran.

   Wichtig zur Einordnung: Elliott-Wellen sind Auslegung, keine Messung. Zwei
   Betrachter zaehlen dieselbe Bewegung oft verschieden. Dieses Modul legt
   deshalb offen, WELCHE Regel eine Zaehlung traegt und welche Richtlinie sie
   verletzt - und liefert lieber kein Ergebnis als ein erfundenes.
   ===================================================================== */

/* ---------- Schwellen und Verhaeltnisse ---------- */

/** Mindestbewegung in Prozent, damit ein Umkehrpunkt als Pivot zaehlt. */
const EL_ZIGZAG_PCT = 0.03;
/** Alternativ adaptiv: ATR(14) mal diesem Faktor, sofern ATR verfuegbar. */
const EL_ATR_FACTOR = 2;
const EL_ATR_PERIOD = 14;
/** Ueber so viele der juengsten Pivots wird nach Zaehlungen gesucht. */
const EL_MAX_PIVOTS = 20;
/** Unter so vielen Kerzen wird gar nicht erst gerechnet. */
const EL_MIN_CANDLES = 60;

/** Uebliche Retracement-Verhaeltnisse. */
const EL_RETRACE = [0.382, 0.5, 0.618, 0.786];
/** Welle 3 aus Welle 1. */
const EL_EXT_W3 = [1.618, 2.618, 4.236];
/** Welle 5 aus Welle 1. */
const EL_EXT_W5_VON_W1 = [0.618, 1.0, 1.618];
/** Welle 5 aus der Strecke Welle 1 bis Welle 3. */
const EL_EXT_W5_VON_W13 = [0.382, 0.618];
/** Welle C aus Welle A. */
const EL_EXT_WC = [1.0, 1.618];

/** Zwei Level bilden eine Zone, wenn ihr Abstand unter diesem Anteil des Kurses liegt. */
const EL_CLUSTER_TOL = 0.01;
const EL_MIN_LEVEL_JE_ZONE = 2;
const EL_MAX_ZONEN = 4;

/** Gewicht je Verhaeltnis - je verbreiteter, desto schwerer. */
const EL_GEWICHT = { 1.618: 1.0, 0.618: 1.0, 1.0: 0.8, 0.5: 0.8, 0.382: 0.6, 2.618: 0.6 };
const EL_GEWICHT_REST = 0.4;

/** Ab welchem Unterschied der Retracement-Tiefen Alternation als erfuellt gilt. */
const EL_ALTERNATION_MIN = 0.15;
/** Wie nah ein Retracement an einem Fibonacci-Wert liegen muss, um zu zaehlen. */
const EL_FIB_NAEHE = 0.05;

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

function elArgMax(a, von, bis) { let k = von; for (let i = von; i <= bis; i++) if (a[i] > a[k]) k = i; return k; }
function elArgMin(a, von, bis) { let k = von; for (let i = von; i <= bis; i++) if (a[i] < a[k]) k = i; return k; }

/**
 * Prueft ein Fenster aus sechs Pivots (P0…P5, also fuenf Wellen) auf die
 * harten Regeln und bewertet die Richtlinien.
 *
 * Wellen:  W1 = P0→P1, W2 = P1→P2, W3 = P2→P3, W4 = P3→P4, W5 = P4→P5
 *
 * Harte Regeln (Verstoss verwirft den Kandidaten):
 *   R1  |W2| < |W1|            Welle 2 holt Welle 1 nicht vollstaendig zurueck
 *   R2  |W3| ist nicht die kuerzeste von |W1|, |W3|, |W5|
 *   R3  Welle 4 dringt nicht in das Gebiet von Welle 1 ein
 *
 * @returns {object|null} Kandidat oder null bei Regelverstoss
 */
function elPruefeImpuls(p) {
  if (p.length < 6) return null;
  const [P0, P1, P2, P3, P4, P5] = p;
  const auf = P1.price > P0.price;             // Aufwaertsimpuls?

  // Die Punkte muessen sauber alternieren, sonst ist es kein Impuls.
  const folge = [P0, P1, P2, P3, P4, P5];
  for (let i = 1; i < folge.length; i++) {
    const steigt = folge[i].price > folge[i - 1].price;
    if (steigt !== (auf ? i % 2 === 1 : i % 2 === 0)) return null;
  }

  const w1 = Math.abs(P1.price - P0.price);
  const w2 = Math.abs(P2.price - P1.price);
  const w3 = Math.abs(P3.price - P2.price);
  const w4 = Math.abs(P4.price - P3.price);
  const w5 = Math.abs(P5.price - P4.price);
  if (!(w1 > 0 && w3 > 0 && w5 > 0)) return null;

  const verstoesse = [];
  if (!(w2 < w1)) verstoesse.push("R1: Welle 2 holt Welle 1 vollständig zurück");
  if (w3 <= Math.min(w1, w5)) verstoesse.push("R2: Welle 3 ist die kürzeste der Antriebswellen");
  // R3: Bei Aufwaerts darf das Tief von Welle 4 nicht unter das Hoch von Welle 1.
  const ueberlappt = auf ? P4.price <= P1.price : P4.price >= P1.price;
  if (ueberlappt) verstoesse.push("R3: Welle 4 überlappt das Gebiet von Welle 1");
  if (verstoesse.length) return { verworfen: true, verstoesse, pivots: folge };

  /* --- Richtlinien: sie verwerfen nicht, sie gewichten --- */
  const ret2 = w2 / w1;
  const ret4 = w4 / w3;
  const erfuellt = [], verfehlt = [];
  let punkte = 0;

  if (w3 >= 1.618 * w1) { punkte += 30; erfuellt.push("Welle 3 erreicht mindestens das 1,618-fache von Welle 1"); }
  else verfehlt.push("Welle 3 bleibt unter dem 1,618-fachen von Welle 1");

  // Alternation: eine Korrektur flach, die andere scharf.
  if (Math.abs(ret2 - ret4) >= EL_ALTERNATION_MIN) {
    punkte += 25;
    erfuellt.push(`Alternation vorhanden (Welle 2 ${Math.round(ret2 * 100)} %, Welle 4 ${Math.round(ret4 * 100)} %)`);
  } else verfehlt.push("Welle 2 und Welle 4 korrigieren ähnlich tief – keine Alternation");

  const nah2 = elNaechstesFib(ret2), nah4 = elNaechstesFib(ret4);
  if (nah2) { punkte += 15; erfuellt.push(`Welle 2 nahe ${nah2.toString().replace(".", ",")}`); }
  else verfehlt.push("Welle 2 trifft kein übliches Verhältnis");
  if (nah4) { punkte += 15; erfuellt.push(`Welle 4 nahe ${nah4.toString().replace(".", ",")}`); }
  else verfehlt.push("Welle 4 trifft kein übliches Verhältnis");

  // Ein Impuls, dessen Wellen zeitlich sehr ungleich sind, ist unwahrscheinlich.
  const dauern = [P1.index - P0.index, P3.index - P2.index, P5.index - P4.index].filter(x => x > 0);
  if (dauern.length === 3 && Math.max(...dauern) / Math.min(...dauern) <= 5) {
    punkte += 15; erfuellt.push("Antriebswellen zeitlich ausgewogen");
  } else verfehlt.push("Antriebswellen zeitlich stark ungleich");

  return {
    verworfen: false, auf, pivots: folge,
    laengen: { w1, w2, w3, w4, w5 }, ret2, ret4,
    konfidenz: Math.max(0, Math.min(100, punkte)),
    erfuellt, verfehlt, vollstaendig: true,
  };
}

/**
 * Laufender Impuls: nur drei oder vier Wellen sind abgeschlossen.
 * Geprueft werden die Regeln, soweit die vorhandenen Wellen sie beruehren.
 */
function elPruefeLaufend(p) {
  if (p.length < 4 || p.length > 5) return null;
  const auf = p[1].price > p[0].price;
  for (let i = 1; i < p.length; i++) {
    const steigt = p[i].price > p[i - 1].price;
    if (steigt !== (auf ? i % 2 === 1 : i % 2 === 0)) return null;
  }
  const w1 = Math.abs(p[1].price - p[0].price);
  const w2 = Math.abs(p[2].price - p[1].price);
  const w3 = Math.abs(p[3].price - p[2].price);
  if (!(w1 > 0 && w3 > 0)) return null;

  const verstoesse = [];
  if (!(w2 < w1)) verstoesse.push("R1: Welle 2 holt Welle 1 vollständig zurück");
  if (p.length === 5) {
    const ueberlappt = auf ? p[4].price <= p[1].price : p[4].price >= p[1].price;
    if (ueberlappt) verstoesse.push("R3: Welle 4 überlappt das Gebiet von Welle 1");
  }
  if (verstoesse.length) return { verworfen: true, verstoesse, pivots: p };

  const erfuellt = [], verfehlt = [];
  let punkte = 0;
  if (w3 >= 1.618 * w1) { punkte += 35; erfuellt.push("Welle 3 erreicht mindestens das 1,618-fache von Welle 1"); }
  else verfehlt.push("Welle 3 bleibt unter dem 1,618-fachen von Welle 1");
  const nah2 = elNaechstesFib(w2 / w1);
  if (nah2) { punkte += 25; erfuellt.push(`Welle 2 nahe ${nah2.toString().replace(".", ",")}`); }
  else verfehlt.push("Welle 2 trifft kein übliches Verhältnis");
  // Eine laufende Zaehlung ist per se unsicherer als eine abgeschlossene.
  punkte += 10;

  return {
    verworfen: false, auf, pivots: p,
    laengen: { w1, w2, w3 },
    konfidenz: Math.max(0, Math.min(100, punkte)),
    erfuellt, verfehlt, vollstaendig: false,
    abgeschlosseneWellen: p.length - 1,
  };
}

/** Naechstes uebliches Retracement-Verhaeltnis, falls nah genug - sonst null. */
function elNaechstesFib(r) {
  let best = null, dist = Infinity;
  for (const f of EL_RETRACE) {
    const d = Math.abs(r - f);
    if (d < dist) { dist = d; best = f; }
  }
  return dist <= EL_FIB_NAEHE ? best : null;
}

/**
 * Retracement-Level einer Welle.
 * level = ende − (ende − start) × r
 * Richtungsunabhaengig: Bei einer Abwaertswelle ist (ende − start) negativ,
 * das Level liegt dann oberhalb des Endes.
 */
function elRetracement(start, ende, ratios = EL_RETRACE) {
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
 * Projektionen aus einer Zaehlung.
 *
 * Bewusst alle Beziehungen, die die Zaehlung hergibt - nicht nur die der
 * naechsten Welle. Zonen entstehen durch ZUSAMMENFALL mehrerer Level aus
 * verschiedenen Herleitungen; mit nur einer Handvoll Level ueber eine weite
 * Preisspanne trifft nie etwas zusammen, und das Verfahren liefe leer.
 *
 * Enthalten sind:
 *   Retracements  der letzten abgeschlossenen Welle, des Gesamtimpulses und
 *                 (sofern vorhanden) von Welle 3
 *   Extensions    Welle 3 aus Welle 1, Welle 5 aus Welle 1 und aus Welle 1–3,
 *                 Welle C aus Welle A
 *
 * @param {object} kand Kandidat aus elPruefeImpuls oder elPruefeLaufend
 * @param {Array} folgend Pivots NACH dem Kandidaten (fuer A–B–C nach dem Impuls)
 */
function elProjektionen(kand, folgend = []) {
  const p = kand.pivots;
  const richtung = kand.auf ? 1 : -1;
  const raus = [];
  const nimm = (liste, herkunft) => liste.forEach(x => raus.push({ ...x, herkunft }));

  if (kand.vollstaendig) {
    const w1 = Math.abs(p[1].price - p[0].price);
    const w13 = Math.abs(p[3].price - p[0].price);
    // Nach fuenf Wellen folgt eine Korrektur - Retracements des Gesamtwegs.
    nimm(elRetracement(p[0].price, p[5].price), "Korrektur des Gesamtimpulses");
    // Welle 5 einzeln zurueckgerechnet: haeufige erste Auffanglinie.
    nimm(elRetracement(p[4].price, p[5].price), "Retracement von Welle 5");
    // Welle 3 zurueckgerechnet - deren Ende traegt oft als Marke.
    nimm(elRetracement(p[2].price, p[3].price), "Retracement von Welle 3");
    // Haette der Impuls weiter getragen: die Welle-5-Ziele bleiben als Marken.
    nimm(elExtension(p[4].price, w1, richtung, EL_EXT_W5_VON_W1), "Welle 5 aus Welle 1");
    nimm(elExtension(p[4].price, w13, richtung, EL_EXT_W5_VON_W13), "Welle 5 aus Welle 1–3");

    /* Welle C, sobald A und B vorliegen. Ohne die beiden Punkte waere die
       Formel nicht anwendbar - dann wird sie weggelassen, nicht geraten. */
    if (folgend.length >= 2) {
      const A = folgend[0], B = folgend[1];
      const wa = Math.abs(A.price - p[5].price);
      nimm(elExtension(B.price, wa, -richtung, EL_EXT_WC), "Welle C aus Welle A");
    }
    return raus;
  }

  const fertig = kand.abgeschlosseneWellen;
  const w1 = Math.abs(p[1].price - p[0].price);
  if (fertig >= 2) {
    nimm(elExtension(p[2].price, w1, richtung, EL_EXT_W3), "Welle 3 aus Welle 1");
  }
  if (fertig >= 3) {
    // Welle 4 steht aus oder laeuft: Retracement von Welle 3.
    nimm(elRetracement(p[2].price, p[3].price), "Ziel Welle 4 (Retracement von Welle 3)");
    nimm(elRetracement(p[0].price, p[3].price), "Retracement der Strecke Welle 1–3");
  }
  if (fertig >= 4) {
    const w13 = Math.abs(p[3].price - p[0].price);
    nimm(elExtension(p[4].price, w1, richtung, EL_EXT_W5_VON_W1), "Welle 5 aus Welle 1");
    nimm(elExtension(p[4].price, w13, richtung, EL_EXT_W5_VON_W13), "Welle 5 aus Welle 1–3");
  }
  return raus;
}

/** Gewicht eines Verhaeltnisses. */
function elGewicht(r) {
  const k = Object.keys(EL_GEWICHT).find(x => Math.abs(+x - r) < 1e-9);
  return k ? EL_GEWICHT[k] : EL_GEWICHT_REST;
}

/**
 * Benachbarte Level zu Zonen buendeln.
 * Zwei Level gehoeren zusammen, wenn |lᵢ − lⱼ| / kurs < EL_CLUSTER_TOL.
 * Score = Summe der Gewichte, auf 0–100 normiert.
 */
function elClusterZonen(level, kurs) {
  const gueltig = level.filter(x => isFinite(x.level) && x.level > 0)
                       .sort((a, b) => a.level - b.level);
  if (!gueltig.length || !(kurs > 0)) return [];

  const gruppen = [];
  let aktuell = [gueltig[0]];
  for (let i = 1; i < gueltig.length; i++) {
    const vorher = aktuell[aktuell.length - 1].level;
    if (Math.abs(gueltig[i].level - vorher) / kurs < EL_CLUSTER_TOL) aktuell.push(gueltig[i]);
    else { gruppen.push(aktuell); aktuell = [gueltig[i]]; }
  }
  gruppen.push(aktuell);

  const zonen = gruppen
    .filter(g => g.length >= EL_MIN_LEVEL_JE_ZONE)
    .map(g => {
      const werte = g.map(x => x.level);
      const roh = g.reduce((s, x) => s + elGewicht(x.ratio), 0);
      return {
        low: Math.min(...werte), high: Math.max(...werte),
        mid: werte.reduce((a, b) => a + b, 0) / werte.length,
        hits: g.map(x => ({ ratio: x.ratio, herkunft: x.herkunft, level: x.level })),
        roh,
      };
    });
  if (!zonen.length) return [];
  const maxRoh = Math.max(...zonen.map(z => z.roh));
  zonen.forEach(z => { z.score = Math.round(z.roh / maxRoh * 100); });
  return zonen.sort((a, b) => b.score - a.score).slice(0, EL_MAX_ZONEN);
}

/**
 * Gesamtanalyse. Gibt immer ein Objekt zurueck - im Zweifel mit grund,
 * nie mit erfundenen Zonen.
 */
function elAnalysiere(reihe) {
  if (!reihe || !Array.isArray(reihe.c) || reihe.c.length < EL_MIN_CANDLES) {
    return { ok: false, grund: `Zu wenige Kursdaten (${reihe && reihe.c ? reihe.c.length : 0} Kerzen, mindestens ${EL_MIN_CANDLES} nötig).` };
  }
  const kurs = reihe.c[reihe.c.length - 1];
  const spanne = elAtr(reihe.h, reihe.l, reihe.c);
  // Adaptive Schwelle, wenn die Tagesspanne vorliegt - sonst der feste Wert.
  const schwelle = spanne && kurs > 0
    ? Math.max(EL_ZIGZAG_PCT, (spanne * EL_ATR_FACTOR) / kurs)
    : EL_ZIGZAG_PCT;

  const alle = elDetectSwings(reihe, schwelle);
  const pivots = alle.slice(-EL_MAX_PIVOTS);
  if (pivots.length < 4) {
    return { ok: false, schwelle, pivots,
      grund: `Zu wenige Umkehrpunkte gefunden (${pivots.length} bei einer Schwelle von ${(schwelle * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %). Für eine Zählung braucht es mindestens vier.` };
  }

  const kandidaten = [], verworfen = [];
  // Abgeschlossene Impulse: jedes Fenster aus sechs aufeinanderfolgenden Pivots
  for (let i = 0; i + 5 < pivots.length; i++) {
    const k = elPruefeImpuls(pivots.slice(i, i + 6));
    if (!k) continue;
    if (k.verworfen) verworfen.push(k); else kandidaten.push(k);
  }
  // Laufende Impulse: die juengsten vier oder fuenf Pivots
  for (const laenge of [5, 4]) {
    if (pivots.length >= laenge) {
      const k = elPruefeLaufend(pivots.slice(-laenge));
      if (k && !k.verworfen) kandidaten.push(k);
      else if (k) verworfen.push(k);
    }
  }

  if (!kandidaten.length) {
    const gruende = [...new Set(verworfen.flatMap(v => v.verstoesse))];
    return { ok: false, schwelle, pivots, verworfen: verworfen.length,
      grund: verworfen.length
        ? `Alle ${verworfen.length} geprüften Kandidaten verletzen mindestens eine harte Regel: ${gruende.join("; ")}.`
        : "Die Umkehrpunkte bilden keine impulsähnliche Abfolge." };
  }

  kandidaten.sort((a, b) => b.konfidenz - a.konfidenz);
  const beste = kandidaten[0];
  /* Pivots nach dem Kandidaten heraussuchen - aus ihnen entstehen A und B
     einer folgenden Korrektur und damit die Welle-C-Projektion. */
  const letzterIdx = beste.pivots[beste.pivots.length - 1].index;
  const folgend = pivots.filter(x => x.index > letzterIdx);
  const zonen = elClusterZonen(elProjektionen(beste, folgend), kurs);

  return {
    ok: true, schwelle, kurs, pivots,
    beste, alternativen: kandidaten.slice(1, 4), zonen,
    verworfen: verworfen.length,
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
   Chart-Overlay - Zonen als Baender, Wellenlabels an den Pivots
   ===================================================================== */

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

    c.save();
    c.beginPath(); c.rect(b.left, b.top, b.width, b.height); c.clip();

    // Zonen als halbtransparente Baender
    for (const z of elCurrent.zonen || []) {
      const y1 = sy.getPixelForValue(z.high), y2 = sy.getPixelForValue(z.low);
      if (!isFinite(y1) || !isFinite(y2)) continue;
      const oben = Math.min(y1, y2), hoehe = Math.max(2, Math.abs(y2 - y1));
      const deckung = 0.10 + (z.score / 100) * 0.16;
      c.fillStyle = `rgba(79,184,172,${deckung.toFixed(3)})`;
      c.fillRect(b.left, oben, b.width, hoehe);
      c.strokeStyle = "rgba(79,184,172,.55)";
      c.setLineDash([4, 3]); c.lineWidth = 1;
      c.beginPath(); c.moveTo(b.left, oben); c.lineTo(b.right, oben);
      c.moveTo(b.left, oben + hoehe); c.lineTo(b.right, oben + hoehe); c.stroke();
      c.setLineDash([]);
    }

    // Wellenlabels an den Pivots
    c.font = '600 10px "IBM Plex Mono", monospace';
    c.textAlign = "center"; c.textBaseline = "middle";
    for (const m of elCurrent.marken || []) {
      const x = xFuer(m), y = sy.getPixelForValue(m.price);
      if (x == null || !isFinite(x) || !isFinite(y)) continue;
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
    <p class="el-hint">Elliott-Wellen sind Auslegung, keine Messung – zwei Betrachter zählen
      dieselbe Bewegung oft verschieden. Die Zählung ist keine Kursprognose.</p>
  </div>`;
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
    btn.innerHTML = '<span class="spin"></span> Wellen werden gezählt …';
    out.innerHTML = "";
    /* Kurz zuruecktreten, damit der Ladezustand gezeichnet wird, bevor gerechnet
       wird. Bewusst setTimeout statt requestAnimationFrame: rAF pausiert,
       sobald der Tab in den Hintergrund geht - wer klickt und wegschaltet,
       bekaeme sonst nie ein Ergebnis. */
    await new Promise(r => setTimeout(r, 16));
    try {
      const key = elSchluessel(item.s, reihe);
      let erg = elCache.get(key);
      if (!erg) { erg = elAnalysiere(reihe); elCache.set(key, erg); }
      elZeige(out, erg, reihe, item, neuZeichnen, false);
    } catch (e) {
      out.innerHTML = `<div class="el-leer">Die Zählung ist fehlgeschlagen: ${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false; btn.textContent = alt;
    }
  };
}

function elZeige(out, erg, reihe, item, neuZeichnen, ausSpeicher) {
  const panel = document.getElementById("panel");
  // Ansicht verbreitern - die Tabellen und das Chart brauchen Platz.
  if (panel) panel.classList.add("weit");

  if (!erg.ok) {
    elCurrent = null;
    out.innerHTML = `<div class="el-leer"><b>Keine valide Wellenzählung erkennbar</b>
      <p>${esc(erg.grund)}</p>
      ${erg.pivots ? `<p class="el-detail">Gefundene Umkehrpunkte: ${erg.pivots.length} ·
        verwendete Schwelle: ${(erg.schwelle * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %</p>` : ""}
      <p class="el-detail">Es werden bewusst keine Zonen gezeigt, wenn keine Zählung trägt.</p></div>`;
    if (typeof neuZeichnen === "function") neuZeichnen();
    return;
  }

  const cur = (reihe.meta && reihe.meta.currency) || "";
  const g = (v, d) => (typeof moneyNum === "function" ? moneyNum(v, cur, d ?? 2) : v.toFixed(2));
  const dat = ts => new Date(ts).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "2-digit" });
  /* Deutsche Schreibweise: Komma als Dezimaltrenner, Minuszeichen statt
     Bindestrich. toFixed liefert beides falsch. */
  const pz = (v, d = 1) => (v >= 0 ? "+" : "−") + Math.abs(v).toLocaleString("de-DE",
    { minimumFractionDigits: d, maximumFractionDigits: d }) + " %";

  const marken = elMarken(erg.beste);
  elCurrent = { zonen: erg.zonen, marken, total: reihe.c.length };

  const zaehlung = `<table class="el-tab">
    <tr><th>Welle</th><th>Datum</th><th>Kurs</th><th>Bewegung</th></tr>
    ${marken.map((m, i) => {
      const vor = i > 0 ? marken[i - 1] : null;
      const bew = vor ? (m.price / vor.price - 1) * 100 : null;
      return `<tr><td><b>${m.label}</b></td><td>${dat(m.date)}</td><td>${g(m.price)}</td>
        <td class="${bew == null ? "" : bew >= 0 ? "up" : "down"}">${bew == null ? "–" : pz(bew)}</td></tr>`;
    }).join("")}
  </table>`;

  const zonenHtml = erg.zonen.length ? erg.zonen.map(z => {
    const abst = (z.mid / erg.kurs - 1) * 100;
    const ratios = [...new Set(z.hits.map(h => h.ratio))].sort((a, b) => a - b)
      .map(r => String(r).replace(".", ",")).join(" · ");
    const herkunft = [...new Set(z.hits.map(h => h.herkunft))].join(", ");
    return `<div class="el-zone">
      <div class="el-zone-k"><b>${g(z.low)} – ${g(z.high)}</b>
        <span class="${abst >= 0 ? "up" : "down"}">${pz(abst)} zum Kurs</span></div>
      <div class="el-bar"><i style="width:${z.score}%"></i><span>${z.score}</span></div>
      <div class="el-zone-d">${z.hits.length} Level · Verhältnisse ${ratios}<br><i>${esc(herkunft)}</i></div>
    </div>`;
  }).join("") : `<div class="el-detail">Aus dieser Zählung ergeben sich keine Zonen mit mindestens
      ${EL_MIN_LEVEL_JE_ZONE} zusammenfallenden Leveln.</div>`;

  const k = erg.beste;
  const begruendung = `<div class="el-konf">
    <div class="el-konf-k">Konfidenz der Zählung<b>${k.konfidenz}</b></div>
    <div class="el-bar"><i style="width:${k.konfidenz}%"></i></div>
    <ul class="el-liste">
      ${k.erfuellt.map(x => `<li class="ja">${esc(x)}</li>`).join("")}
      ${k.verfehlt.map(x => `<li class="nein">${esc(x)}</li>`).join("")}
    </ul>
    <p class="el-detail">${k.vollstaendig
      ? "Abgeschlossener Impuls aus fünf Wellen."
      : `Laufender Impuls – ${k.abgeschlosseneWellen} Wellen abgeschlossen, die nächste steht aus.`}
      Richtung: ${k.auf ? "aufwärts" : "abwärts"} · Schwelle ${(erg.schwelle * 100).toLocaleString("de-DE", { maximumFractionDigits: 1 })} %
      · ${erg.pivots.length} Umkehrpunkte${erg.verworfen ? ` · ${erg.verworfen} Kandidaten wegen Regelverstoß verworfen` : ""}.</p>
  </div>`;

  const alt = erg.alternativen.length ? `<details class="el-alt">
    <summary>${erg.alternativen.length} weitere gültige Zählung${erg.alternativen.length > 1 ? "en" : ""}</summary>
    ${erg.alternativen.map(a => `<div class="el-alt-e">
      <b>Konfidenz ${a.konfidenz}</b> · ${a.vollstaendig ? "abgeschlossen" : "laufend"} ·
      ${a.auf ? "aufwärts" : "abwärts"} · ${dat(a.pivots[0].date)} bis ${dat(a.pivots[a.pivots.length - 1].date)}
      <br><span class="el-detail">${esc(a.erfuellt.join("; ") || "keine Richtlinie erfüllt")}</span>
    </div>`).join("")}
  </details>` : "";

  out.innerHTML = `
    <h4 class="el-h">Gefundene Zählung</h4>${zaehlung}
    ${begruendung}
    <h4 class="el-h">Zielzonen</h4>${zonenHtml}
    ${alt}
    <div class="el-acts">
      ${ausSpeicher
        ? `<button class="el-mini" id="el-drop2">Gespeicherte Zählung verwerfen</button>`
        : `<button class="el-mini" id="el-save">Diese Zählung speichern</button>`}
      <span class="el-detail" id="el-savemsg"></span>
    </div>`;

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

/** Wellenlabels je Pivot: 1–5 beim Impuls, A–C bei drei Punkten. */
function elMarken(k) {
  const namen = k.vollstaendig ? ["0", "1", "2", "3", "4", "5"]
    : ["0", "1", "2", "3", "4"].slice(0, k.pivots.length);
  return k.pivots.map((p, i) => ({ ...p, label: namen[i] ?? String(i) }));
}
