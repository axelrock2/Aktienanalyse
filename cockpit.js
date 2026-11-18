"use strict";
/* =====================================================================
   Analyse-Cockpit - Rechenteil

   Vier Module aus vier Arbeiten, jede Kennzahl auf ihre Quelle zurueckfuehrbar:

     1  Markowitz (1952)          Risiko: Volatilitaet, Drawdown, Korrelation
     2  Sharpe (1964)             CAPM: Beta, Eigenkapitalkosten, Alpha, Sharpe
     4  Jegadeesh & Titman (1993) Momentum 12-1, 6-1, 3-0
     8  Kahneman & Tversky (1979) Verhaltens-Hinweise

   Die Rechenfunktionen sind rein: Zahlen rein, Zahlen raus, kein Dokument.
   Alle Einstellungen stehen in config.js, nicht hier.

   Was dieses Modul NICHT tut: Es gibt keine Kauf- oder Verkaufsempfehlung und
   keinen Punktestand, der Titel in eine Rangfolge bringt. Faktor- und
   Momentumeffekte sind Durchschnitte ueber viele Aktien; auf einen einzelnen
   Titel angewandt sind sie eine Einordnung, keine Prognose. Das steht an
   jeder Kennzahl dabei.

   Klassisches Script, kein ES-Modul - wie app.js, depot.js und elliott.js.
   ===================================================================== */

/* =====================================================================
   Grundrechnen
   ===================================================================== */

const cpMittel = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
function cpStd(a) {
  if (a.length < 2) return null;
  const m = cpMittel(a);
  return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1));
}

/** Log-Renditen. Fuer Streuungsmasse: sie addieren sich ueber die Zeit, und
    das Doppelte und die Haelfte sind gleich weit vom Ausgang entfernt. */
function cpLogRenditen(c) {
  const r = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i] > 0 && c[i - 1] > 0) r.push(Math.log(c[i] / c[i - 1]));
  }
  return r;
}

/** Einfache Renditen. Fuer die CAPM-Regression: Das Modell
    E(R) = Rf + beta * (E(Rm) − Rf) ist in einfachen Renditen formuliert. */
function cpEinfachRenditen(c) {
  const r = [];
  for (let i = 1; i < c.length; i++) {
    if (c[i] > 0 && c[i - 1] > 0) r.push(c[i] / c[i - 1] - 1);
  }
  return r;
}

/**
 * Monatsschlusskurse, nach Kalendermonat geschluesselt.
 *
 * Der Schluessel ist der Grund fuer diese Funktion: Zwei Boersen haben
 * verschiedene Feiertage. Wer zwei Tagesreihen nur auf gleiche LAENGE
 * zuschneidet, legt Dienstag auf Mittwoch und misst am Ende die
 * Zeitverschiebung mit. Ueber Monatsenden passiert das nicht.
 *
 * @returns {Map<string, number>} "2026-03" -> Schlusskurs
 */
function cpMonatsende(t, c) {
  const m = new Map();
  for (let i = 0; i < c.length; i++) {
    const d = new Date(t[i]);
    const key = d.getUTCFullYear() + "-" + String(d.getUTCMonth() + 1).padStart(2, "0");
    m.set(key, c[i]);            // spaeterer Tag ueberschreibt - am Ende der Monatsschluss
  }
  return m;
}

/** Zwei Monatsreihen auf gemeinsame Monate bringen und Renditen bilden. */
function cpPaare(reiheA, reiheB) {
  const keysA = [...reiheA.keys()].sort();
  const keysB = new Set(reiheB.keys());
  const gemeinsam = keysA.filter(k => keysB.has(k));
  const a = [], b = [], monate = [];
  for (let i = 1; i < gemeinsam.length; i++) {
    const k0 = gemeinsam[i - 1], k1 = gemeinsam[i];
    const pa0 = reiheA.get(k0), pa1 = reiheA.get(k1);
    const pb0 = reiheB.get(k0), pb1 = reiheB.get(k1);
    if (!(pa0 > 0 && pa1 > 0 && pb0 > 0 && pb1 > 0)) continue;
    a.push(pa1 / pa0 - 1); b.push(pb1 / pb0 - 1); monate.push(k1);
  }
  return { a, b, monate };
}

/**
 * Lineare Regression y = alpha + beta * x.
 * Liefert zusaetzlich das Bestimmtheitsmass und die t-Statistik des
 * Achsenabschnitts - ohne sie ist ein Alpha nicht einzuordnen.
 */
function cpRegression(y, x) {
  const n = Math.min(y.length, x.length);
  if (n < 3) return null;
  const my = cpMittel(y.slice(0, n)), mx = cpMittel(x.slice(0, n));
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (x[i] - mx) * (y[i] - my);
    sxx += (x[i] - mx) * (x[i] - mx);
    syy += (y[i] - my) * (y[i] - my);
  }
  if (!(sxx > 0)) return null;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  let rss = 0;
  for (let i = 0; i < n; i++) { const e = y[i] - alpha - beta * x[i]; rss += e * e; }
  const r2 = syy > 0 ? 1 - rss / syy : null;
  const s2 = n > 2 ? rss / (n - 2) : null;
  const seAlpha = s2 != null ? Math.sqrt(s2 * (1 / n + (mx * mx) / sxx)) : null;
  const seBeta = s2 != null ? Math.sqrt(s2 / sxx) : null;
  return {
    beta, alpha, r2, n,
    tAlpha: seAlpha > 0 ? alpha / seAlpha : null,
    tBeta: seBeta > 0 ? beta / seBeta : null,
    korr: (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null,
  };
}

/** Schiefe der Verteilung - dritter standardisierter Moment. */
function cpSchiefe(a) {
  if (a.length < 10) return null;
  const m = cpMittel(a), s = cpStd(a);
  if (!(s > 0)) return null;
  const n = a.length;
  return a.reduce((x, y) => x + Math.pow((y - m) / s, 3), 0) * n / ((n - 1) * (n - 2));
}

/* =====================================================================
   Modul 1 - Risiko (Markowitz 1952)
   ===================================================================== */

/**
 * Groesster Rueckgang vom Hoechststand und die Erholung daraus.
 *
 * Die Erholungsdauer gehoert dazu: Ein Rueckgang von 30 Prozent, der nach
 * zwei Monaten aufgeholt ist, ist etwas anderes als derselbe Rueckgang, der
 * vier Jahre braucht - die Zahl allein sagt das nicht.
 */
function cpDrawdown(t, c) {
  if (!c || c.length < 20) return null;
  let gipfel = c[0], gipfelIdx = 0;
  let tiefe = 0, vonIdx = 0, bisIdx = 0;
  for (let i = 0; i < c.length; i++) {
    if (c[i] > gipfel) { gipfel = c[i]; gipfelIdx = i; }
    const d = c[i] / gipfel - 1;
    if (d < tiefe) { tiefe = d; vonIdx = gipfelIdx; bisIdx = i; }
  }
  if (tiefe === 0) return { tiefe: 0, erholt: true };
  let erholtIdx = null;
  for (let i = bisIdx; i < c.length; i++) { if (c[i] >= c[vonIdx]) { erholtIdx = i; break; } }
  const tage = i => Math.round((t[i] - t[vonIdx]) / 86400000);
  return {
    tiefe, von: t[vonIdx], bis: t[bisIdx],
    fallTage: Math.round((t[bisIdx] - t[vonIdx]) / 86400000),
    erholt: erholtIdx != null,
    erholtAm: erholtIdx != null ? t[erholtIdx] : null,
    erholungTage: erholtIdx != null ? Math.round((t[erholtIdx] - t[bisIdx]) / 86400000) : null,
    gesamtTage: erholtIdx != null ? tage(erholtIdx) : null,
  };
}

/** Annualisierte Volatilitaet ueber die letzten n Handelstage. */
function cpVola(c, fenster) {
  const teil = c.slice(-(fenster + 1));
  const r = cpLogRenditen(teil);
  if (r.length < Math.min(60, fenster / 4)) return null;
  const s = cpStd(r);
  return s != null ? s * Math.sqrt(AK_CONFIG.risiko.handelstage) : null;
}

/**
 * Modul 1: Was traegt dieser Titel an Risiko bei?
 *
 * Markowitz' eigentlicher Punkt ist nicht die Schwankung eines Titels,
 * sondern sein Zusammenspiel mit dem Rest. Deshalb steht die Korrelation
 * gleichberechtigt neben der Volatilitaet: Zwei schwankungsreiche Titel mit
 * niedriger Korrelation ergeben zusammen ein ruhigeres Depot als ein
 * einzelner ruhiger Titel vermuten laesst.
 */
function cpRisiko(chart, bench) {
  const K = AK_CONFIG.risiko;
  const out = {
    volaKurz: cpVola(chart.c, K.fensterKurz),
    volaLang: cpVola(chart.c, K.fensterLang),
    drawdown: cpDrawdown(chart.t, chart.c),
    korr: null, korrN: null, einordnung: null,
  };
  if (bench && bench.c && bench.c.length > 60) {
    /* Korrelation auf Monatsbasis, aus demselben Grund wie beim Beta:
       Tagesrenditen verschiedener Boersen sind nicht gleichzeitig. */
    const p = cpPaare(cpMonatsende(chart.t, chart.c), cpMonatsende(bench.t, bench.c));
    if (p.a.length >= 12) {
      const reg = cpRegression(p.a, p.b);
      out.korr = reg ? reg.korr : null;
      out.korrN = p.a.length;
    }
  }
  if (out.korr != null) {
    out.einordnung = out.korr >= K.korrelationHoch ? "läuft weitgehend mit dem Markt"
      : out.korr <= K.korrelationNiedrig ? "läuft weitgehend eigenständig"
      : "teils eigenständig";
  }
  return out;
}

/* =====================================================================
   Modul 2 - CAPM (Sharpe 1964)
   ===================================================================== */

/**
 * Beta, Eigenkapitalkosten, Jensens Alpha, Sharpe-Verhaeltnis.
 *
 *   beta        = Cov(Ri, Rm) / Var(Rm)          Steigung der Regression
 *   beta_adj    = 0,67 * beta + 0,33             Blume (1971)
 *   E(Ri)       = Rf + beta * Marktpraemie       Eigenkapitalkosten
 *   alpha       = Achsenabschnitt der Regression auf Ueberschussrenditen
 *   Sharpe      = (Rendite p. a. − Rf) / Volatilitaet
 *
 * Gerechnet auf Monatsrenditen ueber fuenf Jahre und nur auf Monaten, die
 * beide Reihen haben. Das ist der Unterschied zur verbreiteten Praxis,
 * Tagesreihen auf gleiche Laenge zu schneiden: Bei einer Hongkonger Aktie
 * gegen einen US-Index verschiebt das die Tage gegeneinander und misst
 * Zeitverschiebung als Marktrisiko mit.
 */
function cpCapm(chart, bench, rf, volaKurz) {
  const K = AK_CONFIG.capm;
  if (!bench || !bench.c || bench.c.length < 60) {
    return { grund: "Keine Vergleichsreihe für die Benchmark." };
  }
  const p = cpPaare(cpMonatsende(chart.t, chart.c), cpMonatsende(bench.t, bench.c));
  if (p.a.length < K.minPunkte) {
    return { grund: `Nur ${p.a.length} gemeinsame Monate, mindestens ${K.minPunkte} nötig.` };
  }
  const rfM = rf / 12;
  const ye = p.a.map(v => v - rfM);
  const xe = p.b.map(v => v - rfM);
  const reg = cpRegression(ye, xe);
  if (!reg) return { grund: "Die Regression ließ sich nicht rechnen." };

  const betaAdj = K.blumeA * reg.beta + K.blumeB;
  const ekKosten = rf + reg.beta * K.marktpraemie;
  const alphaJahr = reg.alpha * 12;

  /* Sharpe aus der tatsaechlichen Wertentwicklung des Fensters, nicht aus
     dem Mittel der Monatsrenditen: Letzteres ueberschaetzt, was ein Anleger
     erhalten haette, weil es die Streuung nicht ausgleicht. */
  const jahre = p.a.length / 12;
  let wachstum = 1;
  for (const r of p.a) wachstum *= (1 + r);
  const cagr = jahre > 0 ? Math.pow(wachstum, 1 / jahre) - 1 : null;
  const sharpe = (volaKurz > 0 && cagr != null) ? (cagr - rf) / volaKurz : null;

  return {
    beta: reg.beta, betaAdj, tBeta: reg.tBeta, r2: reg.r2, n: reg.n,
    monatVon: p.monate[0], monatBis: p.monate[p.monate.length - 1],
    ekKosten, alphaJahr, tAlpha: reg.tAlpha,
    alphaSignifikant: reg.tAlpha != null && Math.abs(reg.tAlpha) > 2,
    cagr, sharpe, rf,
    stufe: reg.beta < K.defensiv ? "defensiv" : reg.beta > K.offensiv ? "offensiv" : "marktnah",
  };
}

/* =====================================================================
   Modul 4 - Momentum (Jegadeesh & Titman 1993)
   ===================================================================== */

/**
 * Rendite ueber [monate] Monate, ohne die letzten [aus] Monate.
 * Das Auslassen ist nicht Geschmack, sondern Teil des Befunds: Auf
 * Monatssicht wirkt ein Umkehreffekt, der das Signal sonst verwaessert.
 */
function cpFensterRendite(c, monate, aus) {
  const d = AK_CONFIG.momentum.handelstageMonat;
  const ende = c.length - 1 - aus * d;
  const start = ende - (monate - aus) * d;
  if (start < 0 || ende <= start) return null;
  return c[start] > 0 ? c[ende] / c[start] - 1 : null;
}

function cpMomentum(chart, bench) {
  const K = AK_CONFIG.momentum;
  const c = chart.c;
  const out = { fenster: [], relativ: null, umkehr: null, abstandHoch: null };
  for (const [monate, aus] of K.fenster) {
    const r = cpFensterRendite(c, monate, aus);
    out.fenster.push({
      name: aus ? `${monate}-${aus}` : `${monate} Monate`,
      monate, aus, rendite: r,
    });
  }
  /* Risikoadjustiert: dieselbe Rendite bei halber Schwankung ist das
     staerkere Signal. */
  const vola = cpVola(c, AK_CONFIG.risiko.fensterKurz);
  const haupt = out.fenster[0];
  out.proRisiko = (haupt && haupt.rendite != null && vola > 0) ? haupt.rendite / vola : null;

  if (bench && bench.c && bench.c.length > 60) {
    const rb = cpFensterRendite(bench.c, K.fenster[0][0], K.fenster[0][1]);
    if (haupt && haupt.rendite != null && rb != null) out.relativ = haupt.rendite - rb;
  }

  const lang = cpFensterRendite(c, K.umkehrMonate, 0);
  if (lang != null) {
    out.umkehr = { rendite: lang, warnung: lang >= K.umkehrSchwelle };
  }

  const fenster = c.slice(-AK_CONFIG.risiko.fensterKurz);
  const hoch = Math.max(...fenster, ...chart.h.slice(-AK_CONFIG.risiko.fensterKurz));
  out.abstandHoch = hoch > 0 ? c[c.length - 1] / hoch - 1 : null;
  out.hoch52 = hoch;
  return out;
}

/* =====================================================================
   Modul 8 - Verhalten (Kahneman & Tversky 1979)
   ===================================================================== */

/**
 * Hinweise, keine Punktzahl.
 *
 * Prospect Theory beschreibt, wie Anleger IM DURCHSCHNITT entscheiden. Daraus
 * ein Handelssignal zu machen, waere derselbe Fehler, den dieses Projekt beim
 * Elliott-Modul schon einmal gemacht hat. Die Flags sollen zum Nachdenken
 * anstossen, nicht zur Entscheidung.
 */
function cpVerhalten(chart) {
  const K = AK_CONFIG.verhalten;
  const c = chart.c, t = chart.t;
  const flags = [];
  const kurs = c[c.length - 1];

  const fenster = c.slice(-AK_CONFIG.risiko.fensterKurz);
  const hoch = Math.max(...fenster, ...chart.h.slice(-AK_CONFIG.risiko.fensterKurz));
  const tief = Math.min(...fenster, ...chart.l.slice(-AK_CONFIG.risiko.fensterKurz));
  const abstand = hoch > 0 ? kurs / hoch - 1 : null;
  if (abstand != null && abstand > -K.hochNaehe) {
    flags.push({
      art: "anker", titel: "Nahe am 52-Wochen-Hoch",
      wert: abstand,
      text: "Das 52-Wochen-Hoch wirkt als Anker: Viele zögern, darüber zu kaufen. "
          + "George & Hwang (2004) finden, dass neue Hochs deshalb verzögert eingepreist werden – "
          + "weder ein Kauf- noch ein Verkaufsgrund, aber eine Stelle, an der Kursbewegungen "
          + "häufiger aus Psychologie als aus Zahlen entstehen.",
    });
  }

  /* Lotterie-Profil: Schiefe UND Schwankung. Die Schwellen stehen in
     config.js und sind dort an Messwerten begruendet, nicht gesetzt. */
  const jahresRenditen = cpEinfachRenditen(c.slice(-(K.schiefeFenster + 1)));
  const schiefe = cpSchiefe(jahresRenditen);
  const vola = cpVola(c, AK_CONFIG.risiko.fensterKurz);
  const maxTag = jahresRenditen.length ? Math.max(...jahresRenditen) : null;
  if (schiefe != null && schiefe >= K.schiefeSchwelle && vola != null && vola >= K.volaSchwelle) {
    flags.push({
      art: "lotterie", titel: "Lotterie-Profil",
      wert: schiefe,
      text: `Die Renditeverteilung ist rechtsschief (${schiefe.toFixed(2).replace(".", ",")}) `
          + `bei ${(vola * 100).toFixed(0)} % Schwankung: viele kleine Verluste, selten ein großer `
          + "Sprung. Genau dieses Profil wird im Durchschnitt überbewertet, weil kleine "
          + "Wahrscheinlichkeiten übergewichtet werden – und rentiert danach schwächer "
          + "(Bali, Cakici & Whitelaw 2011). Ein Durchschnitt über viele Aktien, keine Aussage "
          + "über diesen Titel.",
    });
  }

  /* Auffaellige Kurssprunge: gemessen in Tagesspannen, nicht in Prozent.
     Fuenf Prozent sind bei einem ruhigen Versorger ein Ereignis und bei einem
     Biotechwert ein Dienstag. */
  const atr = (typeof dsAtr === "function") ? dsAtr(chart.h, chart.l, chart.c) : null;
  if (atr > 0) {
    const n = Math.min(K.sprungFenster, c.length - 1);
    let groesster = 0, wann = null;
    for (let i = c.length - n; i < c.length; i++) {
      const sprung = Math.abs(c[i] - c[i - 1]) / atr;
      if (sprung > groesster) { groesster = sprung; wann = t[i]; }
    }
    if (groesster >= K.sprungAtr) {
      flags.push({
        art: "sprung", titel: "Starke Kursreaktion",
        wert: groesster, datum: wann,
        text: `Am ${new Date(wann).toLocaleDateString("de-DE")} bewegte sich der Kurs um das `
            + `${groesster.toFixed(1).replace(".", ",")}-fache einer normalen Tagesspanne. `
            + "Nach solchen Tagen folgt mal eine Fortsetzung, mal eine Gegenbewegung – "
            + "welche davon, ist nicht vorhersagbar. Lohnt den Blick in die Nachrichten.",
      });
    }
  }

  return { flags, abstandHoch: abstand, hoch52: hoch, tief52: tief, schiefe, vola, maxTag };
}

/* =====================================================================
   Oberflaeche
   ===================================================================== */

/** Passende Benchmark zur Heimatboerse. */
function cpBenchmarkWahl(symbol) {
  const B = AK_CONFIG.benchmark;
  const teile = String(symbol || "").split(".");
  const kuerzel = teile.length > 1 ? teile[teile.length - 1].toUpperCase() : null;
  const sym = kuerzel ? (B.nachBoerse[kuerzel] || B.standard) : B.usa;
  return { sym, name: B.namen[sym] || sym };
}

/* Zins und Benchmark aendern sich nicht je Titel - einmal je Sitzung holen.
   Dasselbe Muster wie loadBenchmark() in app.js. */
const cpVorrat = { rf: null, benches: new Map() };

/**
 * Risikofreier Zins aus ^TNX ueber dieselbe Kursquelle wie alles andere.
 * Notiert in Prozent, deshalb durch hundert.
 */
async function cpRf() {
  if (cpVorrat.rf) return cpVorrat.rf;
  cpVorrat.rf = (async () => {
    try {
      /* Drei Monate, nicht einer: loadChart verwirft Reihen unter 30 Kerzen,
         und ein Monat hat rund 21 Handelstage. Mit "1mo" fiel der Zins
         stillschweigend immer auf den Rueckfallwert zurueck. */
      const d = await loadChart(AK_CONFIG.capm.rfSymbol, "3mo");
      const v = d.c[d.c.length - 1];
      if (v > 0 && v < 25) return { wert: v / 100, quelle: AK_CONFIG.capm.rfName, stand: d.t[d.t.length - 1] };
    } catch (e) { /* unten der Rueckfall */ }
    return { wert: AK_CONFIG.capm.rfFallback, quelle: "Rückfallwert aus config.js", stand: null };
  })();
  return cpVorrat.rf;
}

async function cpBenchmark(symbol) {
  const wahl = cpBenchmarkWahl(symbol);
  if (!cpVorrat.benches.has(wahl.sym)) {
    cpVorrat.benches.set(wahl.sym, loadChart(wahl.sym, AK_CONFIG.benchmark.jahre)
      .catch(() => loadChart(AK_CONFIG.benchmark.standard, AK_CONFIG.benchmark.jahre).catch(() => null)));
  }
  const reihe = await cpVorrat.benches.get(wahl.sym);
  return { ...wahl, reihe };
}

/** Alles rechnen. Die Daten kommen von aussen - die Funktion holt nichts. */
function cpRechne(chart, bench, rf) {
  const risiko = cpRisiko(chart, bench);
  return {
    risiko,
    capm: cpCapm(chart, bench, rf, risiko.volaKurz),
    momentum: cpMomentum(chart, bench),
    verhalten: cpVerhalten(chart),
  };
}

function cpAbschnitt() {
  return `<div class="blk cp-blk" id="cp-blk">
    <h3>Analyse-Cockpit</h3>
    <div id="cp-out" class="cp-laedt">wird gerechnet …</div>
  </div>`;
}

/* Erklaerungen in das vorhandene Kaestchen-System einhaengen. INFO und
   INFO_LABELS sind Objekte - const verbietet das Neuzuweisen, nicht das
   Ergaenzen. So braucht es keine Aenderung an app.js. */
if (typeof INFO === "object" && typeof INFO_LABELS === "object") {
  Object.assign(INFO, {
    cpVola: ["Volatilität (annualisiert)",
      "Die Streuung der täglichen Log-Renditen, hochgerechnet auf ein Jahr: σ × √252.\n\n25 % heißt grob: In etwa zwei von drei Jahren liegt die Rendite im Bereich ±25 Prozentpunkte um den Mittelwert.\n\nMarkowitz (1952) hat Risiko erstmals so definiert – als Schwankung, nicht als Verlustwahrscheinlichkeit. Das ist eine Vereinfachung: Aufwärts- und Abwärtsbewegungen zählen gleich."],
    cpDrawdown: ["Maximaler Rückgang",
      "Der größte Verlust vom Höchststand bis zum Tiefpunkt innerhalb des betrachteten Zeitraums – und wie lange es gedauert hat, ihn aufzuholen.\n\nDie Erholungsdauer gehört dazu: Minus 30 Prozent, nach zwei Monaten aufgeholt, ist etwas anderes als dieselben 30 Prozent über vier Jahre."],
    cpKorr: ["Korrelation zur Benchmark",
      "Wie gleichförmig sich Titel und Index bewegen, auf Monatsbasis. 1 heißt im Gleichschritt, 0 heißt unabhängig, −1 heißt gegenläufig.\n\nDas ist Markowitz' eigentlicher Punkt: Nicht die Schwankung eines Titels entscheidet über das Portfoliorisiko, sondern sein Zusammenspiel mit dem Rest. Zwei schwankungsreiche Titel mit niedriger Korrelation ergeben zusammen ein ruhigeres Depot.\n\nVorsicht: In Krisen steigen Korrelationen – genau dann, wenn man die Streuung bräuchte."],
    cpBeta: ["Beta",
      "Wie stark der Titel auf Marktbewegungen reagiert. β = Cov(Ri, Rm) / Var(Rm), die Steigung der Regression gegen den Index.\n\nβ = 1,3 heißt: Bewegt sich der Index um 10 %, bewegt sich der Titel im Schnitt um 13 %.\n\nGerechnet aus Monatsrenditen über fünf Jahre, und nur über Monate, die beide Reihen haben. Tagesrenditen wären verzerrt, weil Börsen nicht gleichzeitig handeln.\n\nDas bereinigte Beta nach Blume (1971) zieht den Wert Richtung 1: β_adj = 0,67 × β + 0,33. Betas wandern über die Zeit zur Eins, und die rohe Schätzung übertreibt die Abweichung.\n\nSharpe (1964), CAPM. Empirisch ist der Zusammenhang zwischen Beta und Rendite flacher als das Modell vorhersagt (Low-Beta-Anomalie)."],
    cpR2: ["Bestimmtheitsmaß (R²)",
      "Welcher Anteil der Kursbewegung sich durch den Index erklären lässt. 0,47 heißt: 47 % durch den Markt, 53 % titelspezifisch.\n\nWichtig für die Einordnung des Betas: Bei niedrigem R² ist das Beta eine schlecht bestimmte Zahl, egal wie präzise es aussieht."],
    cpEk: ["Eigenkapitalkosten",
      "Die Rendite, die ein Anleger für dieses Risiko verlangen sollte: E(R) = Rf + β × Marktrisikoprämie.\n\nRf ist die Rendite der 10-jährigen US-Staatsanleihe, die Marktrisikoprämie eine Annahme (Standard 5,5 %, einstellbar in config.js).\n\nWird später als Abzinsungssatz in der DCF-Bewertung gebraucht. Keine Messung, sondern eine Rechnung aus zwei Annahmen – entsprechend grob."],
    cpAlpha: ["Jensens Alpha",
      "Die Rendite über das hinaus, was das Beta erklärt: α = Ri − [Rf + β × (Rm − Rf)], hier der Achsenabschnitt der Regression, auf ein Jahr hochgerechnet.\n\nEntscheidend ist die t-Statistik daneben: Erst ab etwa |t| > 2 ist das Alpha von null zu unterscheiden. Darunter ist es Zufall, auch wenn die Zahl groß aussieht.\n\nAlpha ist rückblickend. Carhart (1997) hat gezeigt, dass scheinbares Können von Fondsmanagern fast vollständig durch Faktor-Exposure erklärbar war."],
    cpSharpe: ["Sharpe-Verhältnis",
      "Überrendite je Einheit Schwankung: (Rendite p. a. − risikofreier Zins) / Volatilität.\n\nAls Rendite steht hier die tatsächliche Wertentwicklung des Fensters (CAGR), nicht der Mittelwert der Monatsrenditen – letzterer überschätzt, was ein Anleger erhalten hätte.\n\nNegativ heißt: Der Titel hat weniger gebracht als risikoloses Anlegen, bei vollem Risiko."],
    cpMom: ["Momentum (12-1)",
      "Die Rendite der letzten zwölf Monate ohne den jüngsten Monat.\n\nDer letzte Monat bleibt bewusst außen vor: kurzfristig wirkt ein Umkehreffekt, der das Signal sonst verwässert. Das ist Teil des Befunds von Jegadeesh & Titman (1993), nicht Geschmack.\n\nSie fanden rund 1 % Überrendite pro Monat für das obere gegen das untere Dezil. Wichtig: Das ist ein Querschnittseffekt über viele Aktien. Auf einen einzelnen Titel angewandt ist es eine Einordnung, keine Prognose – und Momentum kann abrupt drehen, besonders nach Crashs."],
    cpUmkehr: ["Umkehrrisiko (36 Monate)",
      "Momentum dreht nach etwa zwölf Monaten teilweise: In den Jahren zwei und drei schneiden frühere Gewinner im Durchschnitt schlechter ab (Jegadeesh & Titman 1993, De Bondt & Thaler 1985).\n\nDer Hinweis erscheint ab einer Verdopplung über drei Jahre. Er sagt nicht, dass der Kurs fällt – er sagt, dass die historische Grundlage für „läuft weiter“ an dieser Stelle dünn wird."],
    cpLotterie: ["Lotterie-Profil",
      "Rechtsschiefe Renditeverteilung bei hoher Schwankung: viele kleine Verluste, selten ein großer Sprung.\n\nKahneman & Tversky (1979) zeigen, dass kleine Wahrscheinlichkeiten übergewichtet werden. Titel mit Lotteriecharakter werden deshalb im Durchschnitt zu teuer gehandelt und rentieren danach schwächer (Bali, Cakici & Whitelaw 2011).\n\nEin Durchschnitt über viele Aktien – keine Aussage über diesen Titel."],
    cpAnker: ["Anker 52-Wochen-Hoch",
      "Anleger zögern, über ein früheres Hoch hinaus zu kaufen – das Hoch wirkt als Referenzpunkt. George & Hwang (2004) finden, dass neue Hochs deshalb verzögert eingepreist werden.\n\nDas ist weder Kauf- noch Verkaufsgrund. Es markiert eine Stelle, an der Kursbewegungen häufiger aus Psychologie als aus Zahlen entstehen."],
  });
  Object.assign(INFO_LABELS, {
    "volatilität 1 jahr": "cpVola", "volatilität 3 jahre": "cpVola",
    "maximaler rückgang": "cpDrawdown", "korrelation": "cpKorr",
    /* NICHT "beta": Dieser Schluessel ist in app.js schon vergeben und zeigt
       auf die Zahl von stockanalysis.com im Kennzahlen-Block. Ihn hier zu
       ueberschreiben haette dort eine fremde Zahl mit der Erklaerung dieser
       Regression versehen - zwei verschiedene Betas unter einer Erklaerung. */
    "beta 5 jahre monatlich": "cpBeta", "bestimmtheitsmaß": "cpR2",
    "eigenkapitalkosten": "cpEk", "jensens alpha": "cpAlpha",
    "sharpe-verhältnis": "cpSharpe", "momentum 12-1": "cpMom",
    "umkehrrisiko": "cpUmkehr",
  });
}

/* ---------- Darstellung ---------- */

const cpP = (v, d = 1) => v == null || !isFinite(v) ? "–"
  : (v < 0 ? "−" : "") + (Math.abs(v) * 100).toLocaleString("de-DE",
      { minimumFractionDigits: d, maximumFractionDigits: d }) + " %";
const cpZ = (v, d = 2) => v == null || !isFinite(v) ? "–"
  : (v < 0 ? "−" : "") + Math.abs(v).toLocaleString("de-DE",
      { minimumFractionDigits: d, maximumFractionDigits: d });
const cpDat = ts => ts ? new Date(ts).toLocaleDateString("de-DE",
  { day: "2-digit", month: "2-digit", year: "numeric" }) : "–";

/** Eine Zeile im Cockpit: Name, Wert, Einordnung. */
function cpZeile(name, wert, note, klasse) {
  return `<div class="cp-z">
    <span class="cp-n">${name}${typeof infoFuer === "function" ? infoFuer(name) : ""}</span>
    <b class="${klasse || ""}">${wert}</b>
    ${note ? `<span class="cp-note">${note}</span>` : ""}
  </div>`;
}

function cpZeige(out, erg, bench, rf, chart, item) {
  const e = typeof esc === "function" ? esc : (s => s);
  const { risiko: r, capm: cm, momentum: m, verhalten: v } = erg;
  const waehrung = (chart.meta && chart.meta.currency) || "";
  const zinsPasst = !waehrung || waehrung.toUpperCase().startsWith(AK_CONFIG.capm.rfWaehrung);

  /* --- 1 Risiko --- */
  const dd = r.drawdown;
  const risikoHtml = `
    ${cpZeile("Volatilität 1 Jahr", cpP(r.volaKurz))}
    ${cpZeile("Volatilität 3 Jahre", cpP(r.volaLang))}
    ${cpZeile("Maximaler Rückgang", cpP(dd && dd.tiefe),
       !dd || !dd.tiefe ? "" : dd.erholt
         ? `${cpDat(dd.bis)}, nach ${dd.erholungTage} Tagen aufgeholt`
         : `seit ${cpDat(dd.bis)} <b class="cp-warn">noch nicht aufgeholt</b>`,
       dd && dd.tiefe < -0.4 ? "down" : "")}
    ${cpZeile("Korrelation", cpZ(r.korr),
       r.korr == null ? "zu wenige gemeinsame Monate"
         : `zu ${e(bench.name)} · ${e(r.einordnung)} · ${r.korrN} Monate`)}`;

  /* --- 2 Marktrisiko --- */
  let capmHtml;
  if (cm.grund) {
    capmHtml = `<p class="cp-leer">${e(cm.grund)}</p>`;
  } else {
    const schwach = cm.r2 != null && cm.r2 < 0.2;
    capmHtml = `
      ${cpZeile("Beta (5 Jahre, monatlich)", cpZ(cm.beta),
         `${e(cm.stufe)} · bereinigt ${cpZ(cm.betaAdj)} (Blume)`)}
      ${cpZeile("Bestimmtheitsmaß", cpZ(cm.r2),
         schwach ? `<b class="cp-warn">unter 0,20 – das Beta ist hier schlecht bestimmt</b>`
                 : `${cpP(cm.r2, 0)} der Bewegung erklärt der Index`)}
      ${cpZeile("Eigenkapitalkosten", cpP(cm.ekKosten),
         `${cpP(rf.wert)} Zins + ${cpZ(cm.beta)} × ${cpP(AK_CONFIG.capm.marktpraemie)} Prämie`)}
      ${cpZeile("Jensens Alpha", cpP(cm.alphaJahr),
         cm.tAlpha == null ? "" : cm.alphaSignifikant
           ? `t = ${cpZ(cm.tAlpha, 1)} – <b class="cp-ok">von null zu unterscheiden</b>`
           : `t = ${cpZ(cm.tAlpha, 1)} – <b>nicht von null zu unterscheiden</b>`,
         cm.alphaJahr >= 0 ? "up" : "down")}
      ${cpZeile("Sharpe-Verhältnis", cpZ(cm.sharpe),
         cm.cagr != null ? `${cpP(cm.cagr)} p. a. über ${cm.n} Monate` : "",
         cm.sharpe == null ? "" : cm.sharpe >= 0.5 ? "up" : cm.sharpe < 0 ? "down" : "")}`;
  }

  /* --- 4 Momentum --- */
  const momHtml = `
    ${m.fenster.map(f => cpZeile(
       f.aus ? `Momentum ${f.monate}-${f.aus}` : `Momentum ${f.monate} Monate`,
       cpP(f.rendite),
       f.aus ? `${f.monate} Monate ohne den letzten` : "",
       f.rendite == null ? "" : f.rendite >= 0 ? "up" : "down")).join("")}
    ${cpZeile("Je Einheit Schwankung", cpZ(m.proRisiko),
       "Momentum 12-1 geteilt durch die Volatilität")}
    ${cpZeile("Relativ zur Benchmark", cpP(m.relativ), `gegen ${e(bench.name)}`,
       m.relativ == null ? "" : m.relativ >= 0 ? "up" : "down")}
    ${m.umkehr ? cpZeile("Umkehrrisiko", cpP(m.umkehr.rendite),
       m.umkehr.warnung
         ? `<b class="cp-warn">über 36 Monate mehr als verdoppelt – in den Jahren zwei und drei drehte Momentum im Durchschnitt</b>`
         : "über 36 Monate – unauffällig") : ""}`;

  /* --- 8 Verhalten --- */
  const verhHtml = v.flags.length
    ? v.flags.map(f => `<div class="cp-flag cp-f-${f.art}">
        <b>${e(f.titel)}${typeof infoFuer === "function" ? infoFuer(f.titel) : ""}</b>
        <p>${f.text}</p>
      </div>`).join("")
    : `<p class="cp-leer">Keine Auffälligkeiten. Das ist der Normalfall – die Hinweise
        erscheinen nur, wenn ein Muster deutlich ausgeprägt ist.</p>`;

  /* --- Depotbezug: der eigene Einstandskurs --- */
  let depotHtml = "";
  try {
    const pos = (typeof Depot === "object" && Depot.list) ? Depot.list() : [];
    const eigen = pos.find(p => p.sym === item.s);
    if (eigen) {
      depotHtml = `<div class="cp-flag cp-f-anker">
        <b>Dein Einstandskurs steht hier bewusst nicht</b>
        <p>Du hältst diesen Titel. Für die Frage, was der Kurs als Nächstes tut, ist dein
        Einstand ohne Bedeutung – der Markt kennt ihn nicht. Kahneman &amp; Tversky (1979)
        zeigen, dass Menschen Ergebnisse trotzdem an diesem Referenzpunkt messen und Verluste
        etwa doppelt so schwer gewichten wie gleich große Gewinne. Daraus folgt der
        Dispositionseffekt: Gewinner zu früh verkaufen, Verlierer zu lange halten.</p>
      </div>`;
    }
  } catch (err) { /* ohne Depot einfach nichts */ }

  out.className = "";
  out.innerHTML = `
    <div class="cp-teil">
      <h4>Risiko <span class="cp-q">Markowitz 1952</span></h4>
      ${risikoHtml}
    </div>
    <div class="cp-teil">
      <h4>Marktrisiko <span class="cp-q">Sharpe 1964</span></h4>
      ${capmHtml}
    </div>
    <div class="cp-teil">
      <h4>Momentum <span class="cp-q">Jegadeesh &amp; Titman 1993</span></h4>
      ${momHtml}
    </div>
    <div class="cp-teil">
      <h4>Verhaltens-Hinweise <span class="cp-q">Kahneman &amp; Tversky 1979</span></h4>
      ${verhHtml}${depotHtml}
    </div>
    <p class="cp-fuss">
      Benchmark ${e(bench.name)} · risikofreier Zins ${cpP(rf.wert)} (${e(rf.quelle)}) ·
      Marktrisikoprämie ${cpP(AK_CONFIG.capm.marktpraemie)} als Annahme ·
      ${cm.grund ? "" : `Beta aus ${cm.n} Monatsrenditen, ${e(cm.monatVon)} bis ${e(cm.monatBis)} ·`}
      Kursdaten bis ${cpDat(chart.t[chart.t.length - 1])}.
      ${zinsPasst ? "" : `<br><b class="cp-warn">Der Titel notiert in ${e(waehrung)}, der Zins
        gilt für den Dollarraum.</b> Eigenkapitalkosten und Sharpe-Verhältnis sind deshalb
        gegen den falschen Massstab gerechnet. Eine Euro-Zinsreihe fehlt bei der
        Kursquelle – sie kommt mit den Faktordaten.`}
      <br>Alle Einstellungen stehen in <code>config.js</code>. Faktorprofil, Bilanzqualität
      und Bewertung folgen in den nächsten Schritten.
      <br><b>Keine Anlageberatung.</b> Momentum- und Faktoreffekte sind Durchschnitte über
      viele Aktien; auf einen einzelnen Titel angewandt sind sie eine Einordnung, keine Prognose.
    </p>`;
}

/** Vom Detailfenster aufgerufen, nachdem der Abschnitt im Dokument steht. */
async function cpVerdrahte(item, chart) {
  const out = document.getElementById("cp-out");
  if (!out) return;
  try {
    const [bench, rf] = await Promise.all([cpBenchmark(item.s), cpRf()]);
    /* Fuenf Jahre statt der zwei des Charts: Beta braucht 36 Monate, die
       Drei-Jahres-Volatilitaet 756 Handelstage. Scheitert der Abruf, wird mit
       der vorhandenen Reihe gerechnet - dann fehlen einzelne Werte, statt
       dass der ganze Abschnitt ausfaellt. */
    let lang = chart;
    try { lang = await loadChart(item.s, AK_CONFIG.benchmark.jahre); } catch (e) {}
    const erg = cpRechne(lang, bench.reihe, rf.wert);
    cpZeige(out, erg, bench, rf, lang, item);
  } catch (e) {
    out.className = "";
    out.innerHTML = `<p class="cp-leer">Das Cockpit ließ sich nicht rechnen:
      ${typeof esc === "function" ? esc(e.message) : e.message}</p>`;
  }
}
