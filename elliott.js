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
   Was hier gemessen wurde, und was daraus folgt
   ---------------------------------------------------------------------
   Die fruehere Fassung hat jede Zaehlung gegen Zufallsreihen geprueft und das
   Ergebnis als Ampel gezeigt. Der Gedanke war richtig, die Kennzahl nicht:
   Geprueft wurde die Passung der Wellenverhaeltnisse zu den Fibonacci-Werten.
   Genau die traegt nichts. Gemessen an 107 Titeln ueber zehn Jahre:

   - Die Verteilung der Wellenverhaeltnisse auf echten Kursen ist von der auf
     Surrogatreihen nicht zu unterscheiden. Kolmogorov-Smirnov ueber alle
     fuenf Beziehungen: hoechstens 1,19 gegen einen kritischen Wert von 1,36.
   - Der Grund ist strukturell: Wer Abwechslung, R1, R2 und R3 verlangt,
     erzwingt Verhaeltnisse nahe der Fibonacci-Werte - im Rauschen genauso.
     Der Median von Welle 2 / Welle 1 liegt auf Zufallsreihen bei 0,60, der
     von Welle 3 / Welle 1 bei 1,72. Ein "perfektes" Retracement ist der
     Normalfall des Zufalls, kein Befund.
   - Keine Formkennzahl trennt echt von Zufall: Passung, Alternation,
     Regelabstaende, Wellendauern, Wegwirkungsgrad - alle bei AUC 0,5, auf
     beiden Haelften der Titel getrennt geprueft. Ein Klassifikator ueber alle
     Verhaeltnisse gemeinsam erreicht 0,64 auf den Lerndaten und 0,50 auf den
     Pruefdaten - der Unterschied ist reine Anpassung.
   - Auf Wochenkerzen dasselbe Bild (AUC 0,52).

   Eine Ampel, die auf einer Kennzahl ohne Trennschaerfe beruht, zeigt in
   fuenf Prozent der Faelle "gruen" - allein weil der p-Wert dann gleich-
   verteilt ist. Ein Test ohne Trennschaerfe, der trotzdem Urteile faellt, ist
   schaedlicher als kein Test. Deshalb ist er entfernt.

   Was geblieben ist, ist das, was ohne Statistik gilt: Die Zaehlung ist eine
   nachvollziehbare Konstruktion aus Wendepunkten und drei harten Regeln, und
   sie definiert einen Preis, ab dem sie widerlegt ist. Bewertet wird nur noch,
   wie EINDEUTIG die Lesart ist - nicht, wie wahrscheinlich sie zutrifft.
   ===================================================================== */

/* =====================================================================
   Der gemessene Befund - wird in der Oberflaeche gezeigt
   Nachrechenbar mit scripts/elliott_befund.js
   ===================================================================== */
const EL_BEFUND = {
  /* Stand 07.09.2026, gerechnet mit scripts/elliott_befund.js auf demselben
     Korb, den der Chancenraum benutzt. */
  titel: 107, jahre: 10, kerzen: 500, zeitpunkte: 41874,
  /* Groesster Kolmogorov-Smirnov-Wert ueber die fuenf Wellenbeziehungen,
     echte Kurse gegen Surrogatreihen. Ab 1,36 waere ein Unterschied belegt. */
  ksMax: 1.17, ksKritisch: 1.36,
  /* Logistische Regression ueber alle Verhaeltnisse, an der einen Haelfte der
     Titel gelernt, an der anderen geprueft. Der Abstand zwischen beiden ist
     reine Anpassung. */
  aucInnen: 0.588, aucAussen: 0.466,
  /* Anteil der Handelstage, an denen ein Titel ueberhaupt eine aktuelle
     Zaehlung hat. */
  anteilAktuell: 0.262,
  /* Rendite der folgenden 20 Handelstage, in Standardabweichungen, verglichen
     nur mit Zeitpunkten GLEICHER Vorbewegung (60 Tage, zehn Klassen). Ohne
     diese Kontrolle sieht man den Rueckschlag auf den Anstieg und haelt ihn
     fuer Wellenwissen. */
  vw: {
    tage: 20, n: 10980,
    lagen: [
      { name: "Impuls aufwärts vollendet",  n: 3637, d: -0.092, lo: -0.153, hi: -0.034 },
      { name: "Impuls abwärts vollendet",   n: 1297, d: -0.041, lo: -0.130, hi:  0.051 },
      { name: "Welle 5 läuft aufwärts",     n: 4628, d: -0.009, lo: -0.053, hi:  0.029 },
      { name: "Welle 5 läuft abwärts",      n: 1418, d: -0.004, lo: -0.089, hi:  0.085 },
    ],
    /* Ohne die Kontrolle sahen dieselben vier Lagen so aus: −0,123 / +0,039 /
       −0,044 / +0,106 - ein sauberes Richtungsmuster (auf, ab, auf, ab), das
       verschwindet, sobald man mit vergleichbaren Zeitpunkten vergleicht. */
    ohneKontrolle: [-0.123, 0.039, -0.044, 0.106],
  },
};
/* =====================================================================
   Schwellen und Ebenen
   ===================================================================== */

/**
 * Bezugshorizonte in Handelstagen: Monat, zwei Monate, Quartal, Halbjahr.
 *
 * Eine Schwingung zaehlt auf Ebene h, wenn ihre Amplitude im Logarithmus
 * sigma * sqrt(h) uebersteigt - also so gross ist wie eine Standardabweichung
 * der Zufallsbewegung ueber h Tage. Damit hat jede Ebene eine Bedeutung
 * ("Bewegungen von Monatsgroesse") statt nur eine Zahl zu sein, und die
 * Schwelle passt sich von selbst an ruhige wie an wilde Titel an.
 *
 * Keine groesseren Ebenen: Die Seite laedt zwei Jahre Tagesdaten. Auf Ebene
 * 126 braucht ein vollstaendiger Impuls schon rund 250 Handelstage; ein
 * Jahresgrad passte nicht mehr ins Fenster. Lo, Mamaysky und Wang (2000)
 * machen denselben Schnitt: In einem festen Fenster sind nur Muster
 * auffindbar, die darin auch abgeschlossen werden.
 */
const EL_EBENEN = [21, 42, 63, 126];
/** Unter so vielen Kerzen wird gar nicht gerechnet. */
const EL_MIN_KERZEN = 250;
/** Ueber so viele der juengsten Umkehrpunkte wird je Ebene gesucht. */
const EL_MAX_PIVOTS = 24;
/**
 * Ab wann eine Zaehlung nicht mehr aktuell ist - gemessen am Grad, nicht in
 * absoluten Tagen. Auf Ebene 21 ist eine Bewegung nach zehn Tagen eine andere
 * Lage; auf Ebene 126 nicht. Eine feste Frist waere fuer die kleine Ebene zu
 * lasch und fuer die grosse zu streng.
 *
 *   Frist(h) = max(5, h / 2)
 *
 * Die Haelfte des Bezugshorizonts, weil eine Welle dieses Grades typisch
 * mehrere Wochen braucht: Wer laenger als eine halbe Horizontlaenge nichts
 * mehr gesehen hat, sieht eine Bewegung, die inzwischen weitergelaufen ist.
 */
const elFrist = h => Math.max(5, Math.round(h / 2));
const EL_ATR_PERIOD = 14;

/** Zielverhaeltnisse je Beziehung - das ist die Theorie, unveraendert. */
const Z_RET2  = [0.382, 0.5, 0.618, 0.786];
const Z_RET4  = [0.236, 0.382, 0.5];
const Z_W3    = [1.618, 2.618, 4.236];
const Z_W5_1  = [0.618, 1.0, 1.618];
const Z_W5_13 = [0.382, 0.618];
/** Vollstaendige Retracement-Leiter, wie beim Einzeichnen ueblich.
    0 liegt am Ende der Bewegung, 1 an ihrem Anfang - dieselbe Ausrichtung wie
    beim Fibonacci-Werkzeug gaengiger Chartprogramme. */
const EL_FIB_LEITER = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
/** Die beiden Stufen, zwischen denen die meisten Korrekturen enden. */
const EL_GOLD_VON = 0.382, EL_GOLD_BIS = 0.618;
/** Zwei Level bilden eine Zone, wenn ihr Abstand unter diesem Anteil des Kurses liegt. */
const EL_CLUSTER_TOL = 0.01;

const EL_SPEICHER = "ak.elliott";

/* =====================================================================
   Rechenteil - reine Funktionen
   ===================================================================== */

/**
 * Mittlere Tagesspanne (Average True Range).
 * TR = max(hoch − tief, |hoch − schluss₋₁|, |tief − schluss₋₁|)
 * Nur noch fuer die Einordnung des Stop-Abstands gebraucht, nicht mehr fuer
 * die Schwellen - die stehen jetzt in Einheiten der Zufallsbewegung.
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

/** Tagesstreuung der Log-Renditen - der Massstab aller Schwellen. */
function elSigma(c) {
  if (!c || c.length < 30) return null;
  const r = [];
  for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) * (b - m), 0) / (r.length - 1);
  return v > 0 ? Math.sqrt(v) : null;
}

/** Erzwingt abwechselnde Hoch- und Tiefpunkte: Von zwei gleichartigen
    Punkten in Folge bleibt der extremere. */
function elAbwechselnd(liste) {
  const out = [];
  for (const x of liste) {
    const letzte = out[out.length - 1];
    if (!letzte || letzte.type !== x.type) { out.push(x); continue; }
    const behalten = x.type === "high" ? x.price > letzte.price : x.price < letzte.price;
    if (behalten) out[out.length - 1] = x;
  }
  return out;
}

/**
 * Umkehrpunkte nach Bry & Boschan (1971) in der Fassung von Pagan &
 * Sossounov (2003), auf Tagesdaten uebertragen.
 *
 *   1. Kandidaten: Punkt ist Hoechst- bzw. Tiefstwert im Fenster ±w
 *   2. Abwechslung erzwingen
 *   3. Phasen unter minPhase Tagen streichen - ausser die Amplitude ist
 *      aussergewoehnlich gross (Ausnahmeregel von Pagan/Sossounov, damit ein
 *      Absturz nicht wegzensiert wird, nur weil er schnell ging)
 *   4. Amplituden unter der Schwelle streichen
 *   5. Zyklen unter minZyklus Tagen streichen
 *
 * Der Unterschied zum bisherigen ZigZag: Der kannte nur Amplitude. Dauer und
 * Zykluslaenge sind eigene Bedingungen. Ohne sie entstehen Zaehlungen, die in
 * der Amplitude sauber sind und in der Zeit Unsinn - gemessen wurde eine ueber
 * neun Kalendertage, bei der Welle 3 und Welle 4 am selben Tag endeten. Die
 * fruehere Fassung hat das mit einer Mindestkerzenzahl je Welle nachtraeglich
 * geflickt; hier faellt es strukturell weg, weil der Punkt gar nicht erst
 * entsteht.
 *
 * Gestrichen wird immer der Punkt mit der geringeren Auspraegung - dem
 * kleineren der beiden Abstaende zu seinen Nachbarn. Das ist symmetrisch und
 * bevorzugt weder frueh noch spaet.
 *
 * @param {{t:number[],h:number[],l:number[]}} reihe
 * @param {number} h Bezugshorizont in Handelstagen
 * @param {number} sigma Tagesstreuung der Log-Renditen
 */
function elWendepunkte(reihe, h, sigma) {
  const { t, h: hoch, l: tief } = reihe;
  const n = t.length;
  const schwelle = sigma * Math.sqrt(h);
  const w = Math.max(2, Math.round(h / 6));
  const minPhase = Math.max(3, Math.round(h / 5));
  const minZyklus = Math.max(8, Math.round(h * 0.8));
  const AUSNAHME = 3;
  if (n < 3 * w + 6) return [];

  /* 1. Kandidaten */
  let p = [];
  for (let i = w; i < n - w; i++) {
    let maxi = true, mini = true;
    for (let j = i - w; j <= i + w; j++) {
      if (j === i) continue;
      if (hoch[j] >= hoch[i]) maxi = false;
      if (tief[j] <= tief[i]) mini = false;
      if (!maxi && !mini) break;
    }
    if (maxi) p.push({ index: i, price: hoch[i], type: "high" });
    else if (mini) p.push({ index: i, price: tief[i], type: "low" });
  }
  if (p.length < 2) return [];
  p = elAbwechselnd(p);

  /* 3.-5. Zensur nach Dauer, Amplitude und Zykluslaenge.
     In EINER Schleife bis zum Stillstand, nicht in getrennten Durchlaeufen mit
     fester Rundenzahl: Jede Streichung kann zwei gleichartige Punkte benachbart
     machen und dadurch neue Verstoesse erzeugen - eine gestrichene Phase kann
     einen zu kurzen Zyklus schaffen und umgekehrt. Mit festen Runden blieben
     gemessen 491 Amplitudenverstoesse stehen; die Punkte erfuellten die Regeln
     dann gar nicht, die hier beschrieben sind.

     Die Schranke ist reine Vorsicht: Jeder Durchlauf entfernt genau einen
     Punkt, mehr als p.length Durchlaeufe kann es nicht geben. */
  const auspraegung = (arr, i) => {
    const a = i > 0 ? Math.abs(Math.log(arr[i].price / arr[i - 1].price)) : Infinity;
    const b = i < arr.length - 1 ? Math.abs(Math.log(arr[i + 1].price / arr[i].price)) : Infinity;
    return Math.min(a, b);
  };
  for (let schutz = p.length + 2; schutz > 0 && p.length >= 3; schutz--) {
    /* Zuerst die schwaechste Phase: zu kurz (und nicht aussergewoehnlich gross)
       oder unter der Amplitudenschwelle. Von ihren beiden Punkten faellt der
       mit der geringeren Auspraegung - dem kleineren der beiden Abstaende zu
       seinen Nachbarn. Symmetrisch, bevorzugt weder frueh noch spaet. */
    let schwaechste = -1, kleinste = Infinity;
    for (let i = 1; i < p.length; i++) {
      const dauer = p[i].index - p[i - 1].index;
      const amp = Math.abs(Math.log(p[i].price / p[i - 1].price));
      const zuKurz = dauer < minPhase && amp < AUSNAHME * schwelle;
      if (!zuKurz && amp >= schwelle) continue;
      if (amp < kleinste) { kleinste = amp; schwaechste = i; }
    }
    if (schwaechste >= 0) {
      const raus = auspraegung(p, schwaechste) <= auspraegung(p, schwaechste - 1)
        ? schwaechste : schwaechste - 1;
      p.splice(raus, 1);
      p = elAbwechselnd(p);
      continue;
    }
    /* Dann zu kurze Zyklen. Gestrichen wird der mittlere Punkt; die beiden
       gleichartigen Aussenpunkte werden danach benachbart, und die Abwechslung
       behaelt den extremeren - genau die Regel von Bry & Boschan. */
    let mitte = -1;
    for (let i = 2; i < p.length; i++) {
      if (p[i].index - p[i - 2].index < minZyklus) { mitte = i - 1; break; }
    }
    if (mitte < 0) break;
    p.splice(mitte, 1);
    p = elAbwechselnd(p);
  }

  /* Das laufende Extrem als vorlaeufigen letzten Punkt: Die aktuelle Bewegung
     gehoert zur Zaehlung, ist aber nicht bestaetigt - dafuer fehlen rechts die
     w Tage, die ein Kandidat braucht. Das wird mitgegeben, nicht verschwiegen. */
  const letzte = p[p.length - 1];
  if (letzte && letzte.index < n - 1) {
    let idx = letzte.index + 1, best = letzte.type === "high" ? Infinity : -Infinity;
    for (let i = letzte.index + 1; i < n; i++) {
      if (letzte.type === "high") { if (tief[i] < best) { best = tief[i]; idx = i; } }
      else if (hoch[i] > best) { best = hoch[i]; idx = i; }
    }
    if (Math.abs(Math.log(best / letzte.price)) >= schwelle * 0.5) {
      p.push({ index: idx, price: best, type: letzte.type === "high" ? "low" : "high", offen: true });
    }
  }
  return p.map(x => ({ ...x, date: t[x.index] })).slice(-EL_MAX_PIVOTS);
}

/**
 * Naechstgelegener Zielwert und die Abweichung dorthin.
 *
 * Bewusst KEIN Punktesystem mehr. Die frueher berechnete "Passung"
 * exp(−ln(r/ziel)²/2σ²) war eine Zahl zwischen null und eins, die aussah wie
 * eine Wahrscheinlichkeit und keine war: Auf Zufallsreihen faellt sie
 * genauso hoch aus. Sie steht hier nur noch als Beschreibung - gemessenes
 * Verhaeltnis, naechster Fibonacci-Wert, Abstand in Prozent.
 *
 * Im Logarithmus gemessen, damit das Doppelte und die Haelfte eines
 * Zielwerts gleich weit entfernt sind.
 */
function elNaechstes(r, ziele) {
  if (!(r > 0) || !isFinite(r)) return { ziel: null, abweichung: null };
  let bestZiel = null, bestAbst = Infinity;
  for (const z of ziele) {
    const d = Math.abs(Math.log(r / z));
    if (d < bestAbst) { bestAbst = d; bestZiel = z; }
  }
  return { ziel: bestZiel, abweichung: r / bestZiel - 1 };
}

/**
 * Prueft ein Fenster aus fuenf oder sechs Punkten auf die harten Regeln.
 *
 *   sechs Punkte (P0…P5) = fuenf abgeschlossene Wellen
 *   fuenf  Punkte (P0…P4) = vier abgeschlossene Wellen, Welle 5 laeuft
 *
 * Kuerzere Fenster sind nicht zugelassen: Bei drei Wellen waere nur R1
 * pruefbar, die Zaehlung praktisch unwiderlegbar.
 *
 * Harte Regeln (ein Verstoss verwirft):
 *   R1  |W2| < |W1|            Welle 2 holt Welle 1 nicht vollstaendig zurueck
 *   R2  |W3| ist nicht die kuerzeste von |W1|, |W3|, |W5|
 *   R3  Welle 4 dringt nicht in das Gebiet von Welle 1 ein
 *
 * Neu ist der SPIELRAUM: Wie deutlich haelt jede Regel? Eine Zaehlung, die R3
 * um ein halbes Prozent erfuellt, ist etwas anderes als eine, die sie um
 * dreissig Prozent erfuellt - auch wenn beide "regelkonform" heissen. Der
 * Spielraum ist keine Wahrscheinlichkeit, sondern ein Abstand, und er wird
 * auch so beschriftet.
 */
function elBewerte(p, minWelle) {
  const n = p.length;
  if (n !== 5 && n !== 6) return null;
  const auf = p[1].price > p[0].price;

  for (let i = 1; i < n; i++) {
    const steigt = p[i].price > p[i - 1].price;
    if (steigt !== (auf ? i % 2 === 1 : i % 2 === 0)) return null;
    if (p[i].index - p[i - 1].index < minWelle) return null;
  }

  const w = [];
  for (let i = 1; i < n; i++) w.push(Math.abs(p[i].price - p[i - 1].price));
  const [w1, w2, w3, w4, w5] = w;
  if (!(w1 > 0 && w2 > 0 && w3 > 0 && w4 > 0)) return null;

  const verstoesse = [];
  if (!(w2 < w1)) verstoesse.push("R1: Welle 2 holt Welle 1 vollständig zurück");
  if (auf ? p[4].price <= p[1].price : p[4].price >= p[1].price) {
    verstoesse.push("R3: Welle 4 überlappt das Gebiet von Welle 1");
  }
  if (n === 6) {
    if (!(w5 > 0)) return null;
    if (w3 <= Math.min(w1, w5)) verstoesse.push("R2: Welle 3 ist die kürzeste der Antriebswellen");
  }
  if (verstoesse.length) return { verworfen: true, verstoesse, pivots: p };

  /* Spielraum je Regel, jeweils als Anteil der Bezugsstrecke. */
  const spielraum = {
    r1: 1 - w2 / w1,
    r3: Math.abs(p[4].price - p[1].price) / w1,
    r2: n === 6 ? w3 / Math.min(w1, w5) - 1 : null,
  };
  spielraum.knapp = Math.min(spielraum.r1, spielraum.r3,
                             spielraum.r2 == null ? Infinity : spielraum.r2);

  const rel = [];
  const nimm = (name, r, ziele) => {
    const z = elNaechstes(r, ziele);
    if (z.ziel != null) rel.push({ name, r, ziel: z.ziel, abweichung: z.abweichung });
  };
  nimm("Welle 2 / Welle 1", w2 / w1, Z_RET2);
  nimm("Welle 3 / Welle 1", w3 / w1, Z_W3);
  nimm("Welle 4 / Welle 3", w4 / w3, Z_RET4);
  if (n === 6) {
    const w13 = Math.abs(p[3].price - p[0].price);
    nimm("Welle 5 / Welle 1", w5 / w1, Z_W5_1);
    if (w13 > 0) nimm("Welle 5 / Welle 1–3", w5 / w13, Z_W5_13);
  }

  return {
    verworfen: false, auf, pivots: p,
    laengen: { w1, w2, w3, w4, w5 },
    ret2: w2 / w1, ret4: w4 / w3,
    relationen: rel, spielraum,
    dauer: p[n - 1].index - p[0].index,
    vollstaendig: n === 6,
    abgeschlosseneWellen: n - 1,
  };
}

/**
 * Sucht ueber alle Ebenen und Fenster.
 *
 * Sortiert wird NICHT nach Passung. Genau das hat die fruehere Fassung getan,
 * und weil die Passung nichts misst, war die Auswahl beliebig - im Median
 * gewann eine Zaehlung, deren letzter Punkt 775 Handelstage zurueck lag. Sie
 * beschrieb Vergangenes und bekam trotzdem Einstiegsbereich und Ziele.
 *
 * Die Reihenfolge hier ist eine Darstellungsentscheidung und wird auch so
 * benannt:
 *   1. aktuelle Zaehlungen vor historischen - nur eine Zaehlung am rechten
 *      Rand kann ueber die Gegenwart etwas sagen
 *   2. groesserer Grad vor kleinerem - Elliott ist ausdruecklich
 *      hierarchisch, die groesste sichtbare Ebene ist die Hauptlesart
 *   3. laengere Zaehlung vor kuerzerer
 */
function elSuche(reihe) {
  const c = reihe.c;
  const kurs = c[c.length - 1];
  const sigma = elSigma(c);
  const atr = elAtr(reihe.h, reihe.l, c);
  if (!sigma) return { ok: false, kurs, proEbene: new Map(), gepruefte: 0, verworfen: 0 };

  const alle = [];
  const proEbene = new Map();
  let verworfen = 0, gepruefte = 0;
  const rand = c.length - 1;

  for (const h of EL_EBENEN) {
    const p = elWendepunkte(reihe, h, sigma);
    proEbene.set(h, p);
    if (p.length < 5) continue;
    const minWelle = Math.max(3, Math.round(h / 5));
    const nimm = (b, letzter) => {
      if (!b) return;
      if (b.verworfen) { verworfen++; return; }
      const alter = rand - b.pivots[b.pivots.length - 1].index;
      alle.push({ ...b, ebene: h, schwelle: sigma * Math.sqrt(h), alter,
                  frist: elFrist(h), aktuell: alter <= elFrist(h), letzterDerEbene: letzter,
                  letzterOffen: !!b.pivots[b.pivots.length - 1].offen });
    };
    for (let i = 0; i + 5 < p.length; i++) { gepruefte++; nimm(elBewerte(p.slice(i, i + 6), minWelle), i + 5 === p.length - 1); }
    gepruefte++; nimm(elBewerte(p.slice(-5), minWelle), true);
  }

  if (!alle.length) return { ok: false, kurs, sigma, atr, gepruefte, verworfen, proEbene };
  alle.sort((a, b) => (b.aktuell - a.aktuell) || (b.ebene - a.ebene) || (b.dauer - a.dauer));
  const aktuelle = alle.filter(x => x.aktuell);
  return { ok: true, kurs, sigma, atr, beste: alle[0], kandidaten: alle,
           aktuelle, gepruefte, verworfen, proEbene };
}

/**
 * Eindeutigkeit der Lesart - die Ampel.
 *
 * Sie bewertet ausdruecklich NICHT, ob die Zaehlung zutrifft. Das ist nicht
 * messbar, und so zu tun als waere es messbar war der Fehler der frueheren
 * Fassung. Bewertet wird, wie eindeutig die Daten diese Lesart hergeben:
 *
 *   rot   keine aktuelle Zaehlung - es gibt nichts ueber die Gegenwart zu sagen
 *   gelb  eine aktuelle Zaehlung, aber mehrdeutig: mehrere gleichrangige
 *         Lesarten, oder der letzte Punkt ist noch nicht bestaetigt, oder eine
 *         Regel haelt nur knapp
 *   gruen eine aktuelle Zaehlung, hoechstens eine Nebenlesart, letzter Punkt
 *         bestaetigt, alle Regeln mit Abstand erfuellt
 *
 * Widersprechen sich zwei aktuelle Zaehlungen in der Richtung, ist das der
 * schwerste Fall von Mehrdeutigkeit und wird eigens genannt.
 */
function elEindeutigkeit(suche) {
  const akt = suche.aktuelle || [];
  if (!akt.length) {
    const alter = suche.beste ? suche.beste.alter : null;
    return { stufe: "rot", text: "keine aktuelle Lesart", gruende: [],
      erklaerung: alter != null
        ? `Die einzigen regelkonformen Zählungen enden ${alter} Handelstage vor dem rechten Rand – zu lange für ihren Grad. Sie beschreiben eine abgeschlossene Vergangenheit, aus der sich für heute nichts ableiten lässt.`
        : "Die Umkehrpunkte bilden auf keiner Ebene eine impulsähnliche Abfolge." };
  }
  const beste = akt[0];
  const gruende = [];
  const richtungen = new Set(akt.map(x => x.auf));
  if (richtungen.size > 1) gruende.push("Zwei aktuelle Zählungen widersprechen sich in der Richtung");
  if (akt.length > 2) gruende.push(`${akt.length} aktuelle Zählungen auf verschiedenen Ebenen`);
  if (beste.letzterOffen) gruende.push("Der letzte Punkt ist das laufende Extrem, kein bestätigter Umkehrpunkt");
  if (beste.spielraum.knapp < 0.05) gruende.push("Eine harte Regel hält nur knapp");

  if (!gruende.length) {
    return { stufe: "gruen", text: "eindeutige Lesart", gruende,
      erklaerung: "Genau eine aktuelle Zählung, ihr letzter Punkt ist bestätigt und alle drei harten Regeln halten mit Abstand. Das sagt nichts darüber, ob die Zählung zutrifft – nur, dass die Daten sie eindeutig hergeben." };
  }
  return { stufe: "gelb", text: "mehrdeutige Lesart", gruende,
    erklaerung: "Es gibt eine aktuelle Zählung, aber sie ist nicht die einzig mögliche Lesart der Daten." };
}

/* =====================================================================
   Ableitungen - Ziel, Einstieg, Invalidierung
   ===================================================================== */

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
    const low = Math.min(...werte), high = Math.max(...werte);
    return {
      low, high,
      mid: werte.reduce((a, b) => a + b, 0) / werte.length,
      /* Breite der Zone, in Prozent des Kurses. Kumar (2022) zeigt fuer
         Fibonacci-Zonen: Je breiter die Zone, desto haeufiger wird sie
         "getroffen" - und zufaellig gesetzte Zonen gleicher Breite werden
         genauso oft getroffen. Wer eine Trefferquote nennt, ohne die Breite
         zu nennen, nennt die Haelfte. */
      breite: ((high - low) / kurs) * 100,
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
 * Gesamtlauf fuer einen Titel.
 *
 * Ohne Bootstrap: Der frueher hier gerechnete Signifikanztest hat 999
 * Surrogatreihen gebaut, um eine Kennzahl zu pruefen, die - gemessen - nicht
 * trennt. Was dabei herauskam, war ein gleichverteilter p-Wert und in fuenf
 * Prozent der Faelle ein gruenes Licht ohne Inhalt. Die Rechenzeit ist
 * gespart, die Aussage ehrlicher.
 */
function elAnalysiere(reihe) {
  if (!reihe || !Array.isArray(reihe.c) || reihe.c.length < EL_MIN_KERZEN) {
    return { ok: false, grund: `Zu wenige Kursdaten (${reihe && reihe.c ? reihe.c.length : 0} Kerzen, mindestens ${EL_MIN_KERZEN} nötig – darunter reicht das Fenster nicht für einen vollständigen Impuls auf der kleinsten Ebene).` };
  }
  const kurs = reihe.c[reihe.c.length - 1];
  const suche = elSuche(reihe);

  if (!suche.ok) {
    const ebenen = [...suche.proEbene.values()].map(x => x.length).join(", ");
    return { ok: false, kurs, verworfen: suche.verworfen, gepruefte: suche.gepruefte,
      grund: suche.verworfen
        ? `Auf keiner der ${EL_EBENEN.length} Ebenen bildet die Kursbewegung einen regelkonformen Impuls. ${suche.verworfen} von ${suche.gepruefte} geprüften Fenstern verletzen eine harte Regel.`
        : `Die Umkehrpunkte bilden auf keiner Ebene eine impulsähnliche Abfolge (Umkehrpunkte je Ebene: ${ebenen}).` };
  }

  const beste = suche.beste;
  const eindeutig = elEindeutigkeit(suche);

  /* Ziele, Einstieg und Invalidierung nur fuer eine AKTUELLE Zaehlung.
     Das ist die entscheidende Sperre: Eine Zaehlung, die vor Monaten endete,
     beschreibt eine Bewegung, die laengst weitergelaufen ist. Frueher
     entschied darueber der p-Wert - also eine Zahl ohne Trennschaerfe. */
  const traegt = beste.aktuell;
  const abl = traegt ? elAbleitungen(beste, kurs, true, suche.atr) : null;
  const zielZonen = abl ? elZonen(abl.ziele, kurs) : [];
  const fibAnker = traegt ? elFibAnker(beste) : [];
  const fib = fibAnker.length
    ? { ...fibAnker[0], leiter: elFibLeiter(fibAnker[0].von, fibAnker[0].bis, kurs) }
    : null;
  const letzterIdx = beste.pivots[beste.pivots.length - 1].index;
  zielZonen.forEach(z => { z.erreicht = elBereitsErreicht(reihe, letzterIdx, z.low, z.high); });
  if (abl && abl.einstieg) {
    abl.einstieg.erreicht = elBereitsErreicht(reihe, letzterIdx, abl.einstieg.low, abl.einstieg.high);
  }

  return {
    ok: true, kurs, beste, eindeutig, traegt,
    aktuell: beste.aktuell, abstand: beste.alter, letzterOffen: beste.letzterOffen,
    zielZonen, fibAnker, fib,
    einstieg: abl ? abl.einstieg : null,
    invalid: abl ? abl.invalid : null,
    erstesZiel: abl ? abl.erstesZiel : null,
    crv: abl ? abl.crv : null,
    lage: abl ? abl.lage : "",
    /* Weitere aktuelle Lesarten. Nur die aktuellen: Historische gibt es je
       nach Titel dutzendweise, und sie aufzuzaehlen erweckt den Eindruck,
       man haette die Wahl. */
    alternativen: (suche.aktuelle || []).slice(1, 4),
    gepruefte: suche.gepruefte, verworfen: suche.verworfen,
    ebene: beste.ebene, schwelle: beste.schwelle, sigma: suche.sigma,
    pivots: suche.proEbene.get(beste.ebene),
  };
}

/* =====================================================================
   Speicherung - bewusst freiwillig, nichts wird ungefragt behalten
   ===================================================================== */
/** Form der gespeicherten Ergebnisse. Erhoehen, sobald sich das Ergebnis-
    objekt aendert - sonst zeigt ein alter Eintrag Felder an, die es nicht
    mehr gibt, und die Anzeige bricht beim Aufklappen ab. */
const EL_FORM = 2;

const ElliottSpeicher = {
  alle() {
    try { return JSON.parse(localStorage.getItem(EL_SPEICHER)) || {}; }
    catch (e) { return {}; }
  },
  /* Eintraege aus einer aelteren Fassung werden verworfen, nicht angezeigt.
     Sie enthalten einen p-Wert aus einem Test, den es nicht mehr gibt - sie
     zu zeigen hiesse, eine widerlegte Aussage weiterzureichen. */
  lade(sym) {
    const e = this.alle()[sym];
    if (!e) return null;
    if (e.form !== EL_FORM) { this.entferne(sym); return null; }
    return e;
  },
  sichere(sym, eintrag) {
    const a = this.alle();
    a[sym] = { ...eintrag, form: EL_FORM, gespeichert: Date.now() };
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
    <p class="el-hint">Elliott-Wellen sind Auslegung, keine Messung. Gemessen an
      ${EL_BEFUND.titel} Titeln über ${EL_BEFUND.jahre} Jahre unterscheidet sich die Form einer
      Zählung nicht von der auf Zufallsreihen, und sie sagt über die folgenden Kurse nichts,
      was die zurückliegende Bewegung nicht schon sagt. Was dieses Werkzeug leistet, ist die saubere Konstruktion der Zählung und der
      Preis, ab dem sie widerlegt ist – keine Kursprognose und keine Anlageempfehlung.</p>
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
    btn.innerHTML = '<span class="spin"></span> Wendepunkte werden gesucht …';
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
  const zahl = (v, d = 2) => (v < 0 ? "−" : "") + Math.abs(Number(v)).toLocaleString("de-DE",
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

  /* --- Eindeutigkeit: das Erste, was zu sehen ist ---
     Bewusst NICHT als Trefferwahrscheinlichkeit beschriftet. Die Farbe sagt,
     wie eindeutig die Daten diese Lesart hergeben, und der Kasten darunter
     sagt, was eine Zaehlung ueberhaupt wert ist - beides gemessen, nicht
     behauptet. */
  const a = erg.eindeutig;
  const ampelHtml = `<div class="el-ampel el-${a.stufe}">
    <div class="el-ampel-kopf">
      <span class="el-punkt"></span>
      <div><b>${esc(a.text)}</b>
        <span class="el-p">Eindeutigkeit der Lesart</span></div>
    </div>
    <p>${esc(a.erklaerung)}</p>
    ${a.gruende.length ? `<ul class="el-gruende">${a.gruende.map(x => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}
    <p class="el-detail">Diese Stufe bewertet die <b>Eindeutigkeit</b>, nicht die Treffsicherheit.
      Ob eine Zählung eintrifft, ist nicht messbar – der folgende Kasten sagt, was gemessen wurde.</p>
  </div>
  <div class="el-befund">
    <b>Was eine Zählung wert ist – gemessen, nicht behauptet</b>
    <p>An ${EL_BEFUND.titel} Titeln über ${EL_BEFUND.jahre} Jahre Tagesdaten
      (${EL_BEFUND.zeitpunkte.toLocaleString("de-DE")} geprüfte Zeitpunkte):</p>
    <ul>
      <li><b>Die Form trägt nichts.</b> Die Wellenverhältnisse echter Kurse sind von denen auf
        Zufallsreihen nicht zu unterscheiden (Kolmogorov-Smirnov höchstens
        ${zahl(EL_BEFUND.ksMax, 2)}; ab ${zahl(EL_BEFUND.ksKritisch, 2)} wäre der Unterschied
        belegt). Die harten Regeln erzwingen die Fibonacci-Nähe – im Rauschen genauso.
        Ein Klassifikator über alle Verhältnisse erreicht ${zahl(EL_BEFUND.aucInnen, 3)} auf den
        Lerndaten und ${zahl(EL_BEFUND.aucAussen, 3)} auf ungesehenen Titeln; 0,5 ist der Münzwurf.</li>
      <li><b>Die Richtung trägt nichts.</b> Rendite der folgenden ${EL_BEFUND.vw.tage} Handelstage,
        in Standardabweichungen, verglichen nur mit Zeitpunkten gleicher Vorbewegung:
        <table class="el-tab el-befundtab">
          ${EL_BEFUND.vw.lagen.map(l => `<tr><td>${esc(l.name)}</td>
            <td>${zahl(l.d, 3)}</td><td>[${zahl(l.lo, 3)}; ${zahl(l.hi, 3)}]</td>
            <td>${l.n.toLocaleString("de-DE")} Fälle</td></tr>`).join("")}
        </table>
        Alle vier zeigen in dieselbe Richtung – auch die, die sich widersprechen müssten.
        Ohne die Kontrolle auf die Vorbewegung sah es nach einem sauberen Richtungsmuster aus
        (${EL_BEFUND.vw.ohneKontrolle.map(v => zahl(v, 3)).join(" · ")}); das war der Rückschlag
        auf die zurückliegende Bewegung, nicht die Zählung.</li>
      <li>Eine aktuelle Zählung gibt es an ${zahl(EL_BEFUND.anteilAktuell * 100, 0)} % der
        Handelstage. An den übrigen ist die einzige ehrliche Antwort: keine Lesart.</li>
    </ul>
    <p class="el-detail">Deshalb steht hier kein p-Wert mehr. Die frühere Fassung prüfte die
      Passung gegen Zufallsreihen – eine Kennzahl ohne Trennschärfe liefert gleichverteilte
      p-Werte und vergibt in fünf Prozent der Fälle ein grünes Licht ohne Inhalt.
      Nachrechenbar mit <code>scripts/elliott_befund.js</code>.</p>
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

  /* --- Wellenverhaeltnisse, als Beschreibung ---
     Frueher stand hier eine "Passung" zwischen null und eins mit Balken. Sie
     sah aus wie ein Guetesiegel und war keins: Auf Zufallsreihen faellt sie
     genauso hoch aus. Jetzt steht da, was tatsaechlich gemessen wurde - das
     Verhaeltnis, der naechste Fibonacci-Wert und der Abstand dorthin. */
  const relHtml = `<table class="el-tab el-rel">
    <tr><th>Beziehung</th><th>gemessen</th><th>nächster Fibonacci-Wert</th><th>Abweichung</th></tr>
    ${k.relationen.map(r => `<tr>
      <td>${esc(r.name)}</td><td>${zahl(r.r, 3)}</td>
      <td>${r.ziel != null ? zahl(r.ziel, 3) : "–"}</td>
      <td class="${Math.abs(r.abweichung) < 0.1 ? "" : "el-fern"}">${pz(r.abweichung * 100)}</td>
    </tr>`).join("")}
  </table>
  <p class="el-detail">Beschreibung, keine Bewertung: Auf Zufallsreihen liegen dieselben
    Verhältnisse. Der Median von Welle 2 / Welle 1 beträgt dort 0,60 – das Retracement,
    das als „goldener Schnitt“ gilt, ist der Normalfall einer regelkonformen Zickzackfolge.</p>
  <p class="el-detail">Spielraum der harten Regeln – wie deutlich jede hält:
    <b>R1</b> Welle 2 bleibt ${zahl(k.spielraum.r1 * 100, 0)} % unter der Länge von Welle 1.
    <b>R3</b> Welle 4 hält ${zahl(k.spielraum.r3 * 100, 0)} % einer Welle-1-Länge Abstand zum
    Gebiet von Welle 1.${k.spielraum.r2 != null
      ? ` <b>R2</b> Welle 3 übertrifft die kürzere der beiden anderen Antriebswellen um
        ${zahl(k.spielraum.r2 * 100, 0)} %.` : ` <b>R2</b> ist noch nicht prüfbar – dafür muss
        Welle 5 abgeschlossen sein.`}
    Je knapper eine Regel hält, desto eher kippt die Zählung bei der nächsten Kerze.</p>`;

  /* --- Lage, Einstieg, Invalidierung, CRV --- */
  let handel = "";
  if (!erg.traegt) {
    handel = `<div class="el-leer"><b>Keine Ziel- oder Einstiegszonen</b>
      <p>Der letzte Punkt dieser Zählung liegt ${erg.abstand} Handelstage zurück – mehr als die
      ${erg.beste.frist} Tage, bis zu denen eine Zählung dieses Grades als aktuell gilt. Die Bewegung ist seither
      weitergelaufen; Ziele und Einstiegsbereiche daraus abzuleiten hieße, eine abgeschlossene
      Vergangenheit als Gegenwart auszugeben.</p></div>`;
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
        · Breite ${zahl(z.breite, 1)} % des Kurses
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
        Bewegung, 1 an ihrem Anfang. Zeichenhilfe, kein Beleg: Kumar (2022) findet über drei
        Aktienmärkte, dass die Trefferquote einer Fibonacci-Zone allein mit ihrer Breite steigt
        und zufällig gesetzte Zonen gleicher Breite genauso oft getroffen werden.
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

  /* --- Weitere aktuelle Lesarten ---
     Nur die aktuellen. Historische gibt es je nach Titel dutzendweise; sie
     aufzuzaehlen erweckte den Eindruck einer Auswahl, wo keine besteht. */
  const alt = erg.alternativen.length ? `<details class="el-alt">
    <summary>${erg.alternativen.length} weitere aktuelle Lesart${erg.alternativen.length > 1 ? "en" : ""}</summary>
    <p class="el-detail">Gleichrangig. Nichts Messbares unterscheidet sie von der oben gezeigten –
      die Reihenfolge folgt allein dem Grad und der Länge, nicht einer Bewertung.</p>
    ${erg.alternativen.map(x => `<div class="el-alt-e">
      ${x.vollstaendig ? "fünf Wellen" : "Welle 5 läuft"} ·
      ${x.auf ? "aufwärts" : "abwärts"} · Ebene ${x.ebene} Handelstage ·
      ${dat(x.pivots[0].date)} bis ${dat(x.pivots[x.pivots.length - 1].date)}
    </div>`).join("")}
  </details>` : "";

  const fuss = `<p class="el-detail">Richtung ${k.auf ? "aufwärts" : "abwärts"} ·
    Ebene ${erg.ebene} Handelstage (Schwelle ${zahl((Math.exp(erg.schwelle) - 1) * 100, 1)} %
    = σ·√${erg.ebene} bei einer Tagesstreuung von ${zahl(erg.sigma * 100, 2)} %) ·
    ${erg.pivots.length} Umkehrpunkte auf dieser Ebene · Wellen ${erg.beste.dauer} Handelstage lang ·
    ${erg.gepruefte} Fenster über ${EL_EBENEN.length} Ebenen geprüft${erg.verworfen
      ? `, ${erg.verworfen} wegen Regelverstoß verworfen` : ""}.<br>
    Umkehrpunkte nach Bry &amp; Boschan (1971) / Pagan &amp; Sossounov (2003): Kandidat im
    Fenster ±${Math.max(2, Math.round(erg.ebene / 6))} Tage, Mindestdauer je Phase
    ${Math.max(3, Math.round(erg.ebene / 5))} Tage, Mindestzyklus
    ${Math.max(8, Math.round(erg.ebene * 0.8))} Tage.</p>`;

  out.innerHTML = `
    ${ampelHtml}
    <h4 class="el-h">Gefundene Zählung</h4>${zaehlung}
    <h4 class="el-h">Wellenverhältnisse</h4>${relHtml}
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
