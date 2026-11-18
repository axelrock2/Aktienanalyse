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
   Modul 1b - Das Portfolio (Markowitz 1952)
   ===================================================================== */

/**
 * Risiko eines Portfolios und der Beitrag jeder einzelnen Position.
 *
 * Markowitz' eigentlicher Satz ist nicht, dass Schwankung Risiko ist - das
 * ist nur die Messvorschrift. Sein Satz ist, dass sich das Risiko eines
 * Portfolios NICHT aus den Einzelrisiken addiert:
 *
 *   sigma_p^2 = Summe_i Summe_j  w_i * w_j * sigma_i * sigma_j * rho_ij
 *
 * Weil rho meist unter eins liegt, ist das Ganze ruhiger als die Summe seiner
 * Teile. Wie viel ruhiger, steht unten als Diversifikationsgewinn.
 *
 * Der Risikobeitrag einer Position ist nicht ihr Gewicht und auch nicht ihre
 * Volatilitaet, sondern:
 *
 *   MRC_i = w_i * (Sigma w)_i / sigma_p
 *
 * Diese Beitraege addieren sich exakt zu sigma_p auf - deshalb lassen sie sich
 * als Anteile lesen. Eine Position mit zehn Prozent Gewicht und dreissig
 * Prozent Risikoanteil ist das, was ein Depot kippen laesst.
 *
 * @param {{sym:string,value:number}[]} positionen
 * @param {Map<string,object>} charts  Kursreihen je Symbol
 */
function cpPortfolio(positionen, charts) {
  const K = AK_CONFIG.portfolio;
  const brauchbar = positionen.filter(p => p.value > 0 && charts.get(p.sym));
  if (brauchbar.length < 2) {
    return { grund: "Für eine Portfoliosicht braucht es mindestens zwei Positionen mit Kursen." };
  }

  /* Monatsreihen, dann auf die GEMEINSAMEN Monate schneiden. Positionen aus
     verschiedenen Zeitzonen haben verschiedene Handelstage; nur ueber
     Monatsenden lassen sie sich ohne Verschiebung nebeneinanderlegen. */
  const reihen = brauchbar.map(p => ({ p, m: cpMonatsende(charts.get(p.sym).t, charts.get(p.sym).c) }));
  let monate = [...reihen[0].m.keys()];
  for (const r of reihen.slice(1)) monate = monate.filter(k => r.m.has(k));
  monate.sort();
  monate = monate.slice(-K.monate);
  if (monate.length < K.minMonate) {
    return { grund: `Nur ${monate.length} gemeinsame Monate über alle Positionen, mindestens ${K.minMonate} nötig.` };
  }

  const renditen = reihen.map(r => {
    const out = [];
    for (let i = 1; i < monate.length; i++) {
      const a = r.m.get(monate[i - 1]), b = r.m.get(monate[i]);
      out.push(a > 0 && b > 0 ? b / a - 1 : 0);
    }
    return out;
  });

  const n = brauchbar.length, T = renditen[0].length;
  const summe = brauchbar.reduce((a, p) => a + p.value, 0);
  const w = brauchbar.map(p => p.value / summe);
  const A = AK_CONFIG.risiko.handelstage / 21;        // Monate je Jahr, rund 12

  // Kovarianzmatrix, auf Jahresmass gebracht
  const mittel = renditen.map(r => cpMittel(r));
  const S = Array.from({ length: n }, () => new Array(n).fill(0));
  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      let c = 0;
      for (let t = 0; t < T; t++) c += (renditen[i][t] - mittel[i]) * (renditen[j][t] - mittel[j]);
      c = c / (T - 1) * A;
      S[i][j] = c; S[j][i] = c;
    }
  }
  const sigma = S.map((z, i) => Math.sqrt(Math.max(0, z[i])));

  // Sigma*w, daraus Portfoliovarianz und Risikobeitraege
  const Sw = S.map(z => z.reduce((a, v, j) => a + v * w[j], 0));
  const varP = Sw.reduce((a, v, i) => a + w[i] * v, 0);
  const volP = Math.sqrt(Math.max(0, varP));
  if (!(volP > 0)) return { grund: "Die Portfoliovarianz ließ sich nicht bestimmen." };

  const gewichtetesMittel = w.reduce((a, v, i) => a + v * sigma[i], 0);

  const eintraege = brauchbar.map((p, i) => {
    const beitrag = w[i] * Sw[i] / volP;              // addiert sich zu volP
    return {
      sym: p.sym, name: p.n || p.sym,
      gewicht: w[i], vola: sigma[i],
      beitrag, anteil: beitrag / volP,
      /* Die Differenz ist die eigentliche Auskunft: Traegt die Position mehr
         Risiko bei, als ihr Gewicht vermuten laesst? */
      ueberhang: beitrag / volP - w[i],
      korrRest: null,
    };
  });

  // Korrelationsmatrix
  const korr = Array.from({ length: n }, (_, i) =>
    Array.from({ length: n }, (_, j) =>
      (sigma[i] > 0 && sigma[j] > 0) ? S[i][j] / (sigma[i] * sigma[j]) : null));

  /* Korrelation jeder Position zum Rest des Depots - das ist die Zahl, die
     "diversifiziert dieser Titel?" beantwortet, nicht die Korrelation zu
     einem einzelnen anderen Titel. */
  for (let i = 0; i < n; i++) {
    const restGewicht = 1 - w[i];
    if (restGewicht <= 1e-9) continue;
    let cov = 0, varRest = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      cov += w[j] * S[i][j];
      for (let k = 0; k < n; k++) if (k !== i) varRest += w[j] * w[k] * S[j][k];
    }
    cov /= restGewicht;
    varRest /= restGewicht * restGewicht;
    const sdRest = Math.sqrt(Math.max(0, varRest));
    if (sigma[i] > 0 && sdRest > 0) eintraege[i].korrRest = cov / (sigma[i] * sdRest);
  }

  eintraege.sort((a, b) => b.anteil - a.anteil);
  return {
    volP, gewichtetesMittel,
    /* Wie viel Schwankung die Streuung spart. 0,25 heisst: ein Viertel
       weniger als die gewichtete Summe der Einzelrisiken. */
    gewinn: gewichtetesMittel > 0 ? 1 - volP / gewichtetesMittel : null,
    eintraege, korr, symbole: brauchbar.map(p => p.sym),
    monate: T, von: monate[0], bis: monate[monate.length - 1],
  };
}

/* =====================================================================
   Modul 7 - Zyklusbereinigtes KGV (Shiller 1981, Campbell/Shiller)
   ===================================================================== */

/**
 * CAPE = Marktwert / Zehnjahresmittel des inflationsbereinigten Gewinns.
 *
 * Shillers Befund: Kurse schwanken weit staerker, als die spaeteren Gewinne
 * rechtfertigen. Ein KGV auf dem letzten Jahresgewinn misst deshalb vor allem,
 * wo im Konjunkturzyklus dieser Gewinn stand - am Zyklushoch sieht alles
 * guenstig aus, am Tief alles teuer. Der Zehnjahresschnitt nimmt das heraus.
 *
 * Auf Aggregatgroessen gerechnet, nicht je Aktie: Ein Aktiensplit veraendert
 * den Gewinn je Aktie, ohne dass sich am Unternehmen etwas aendert. Die
 * Gewinnseite entsteht in scripts/build_fundamentals.py, den Marktwert legt
 * diese Funktion an - er aendert sich taeglich.
 *
 * @param {object} cape  Block aus data/fundamentals.json
 * @param {number} marktwert  aktuelle Marktkapitalisierung
 * @param {number|null} kgv  laufendes KGV zum Vergleich
 */
function cpCape(cape, marktwert, kgv) {
  if (!cape || !(cape.gewinnRealMittel > 0) || !(marktwert > 0)) return null;
  const wert = marktwert / cape.gewinnRealMittel;
  /* Das Verhaeltnis der beiden KGV sagt, wo der laufende Gewinn gegenueber
     dem Zehnjahresschnitt steht. Deutlich unter eins heisst: Der aktuelle
     Gewinn liegt weit ueber dem Schnitt - entweder ist das Unternehmen
     gewachsen, oder es steht am Zyklushoch. Welches davon, sagt die Zahl nicht. */
  const verhaeltnis = (kgv > 0) ? kgv / wert : null;
  return {
    wert, kgv, verhaeltnis,
    jahre: cape.jahre, vollstaendig: cape.vollstaendig,
    verlustjahre: cape.verlustjahre, reihe: cape.reihe,
    basisjahr: cape.basisjahr, waehrung: cape.waehrung,
    lage: verhaeltnis == null ? null
      : verhaeltnis < 0.6 ? "laufender Gewinn weit über dem Zehnjahresschnitt"
      : verhaeltnis > 1.6 ? "laufender Gewinn weit unter dem Zehnjahresschnitt"
      : "laufender Gewinn nahe am Zehnjahresschnitt",
  };
}

/* =====================================================================
   Module 3 und 5 - Faktormodelle
   (Fama & French 1993/2015, Carhart 1997)
   ===================================================================== */

/**
 * Mehrfachregression y = b0 + b1*x1 + … + bk*xk nach der Methode der
 * kleinsten Quadrate.
 *
 * Geloest ueber die Normalgleichungen (X'X)b = X'y mit Gauss-Jordan und
 * Spaltenpivotisierung. Bei vier bis sechs Regressoren und sechzig Monaten
 * ist das numerisch unbedenklich und braucht keine Zerlegung.
 *
 * Zurueck kommen nicht nur die Koeffizienten, sondern auch ihre
 * t-Statistiken. Ohne sie ist eine Faktorladung nicht einzuordnen: 0,3 bei
 * t = 0,4 heisst "wir wissen es nicht", 0,3 bei t = 3 heisst etwas.
 *
 * @param {number[]} y
 * @param {number[][]} X  je Zeile eine Beobachtung, ohne Achsenabschnitt
 */
function cpOls(y, X) {
  const n = y.length, k = X[0].length + 1;
  if (n <= k + 2) return null;
  // Entwurfsmatrix mit Einserspalte
  const A = X.map(z => [1, ...z]);
  const XtX = Array.from({ length: k }, () => new Array(k).fill(0));
  const Xty = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      Xty[a] += A[i][a] * y[i];
      for (let b = a; b < k; b++) XtX[a][b] += A[i][a] * A[i][b];
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) XtX[a][b] = XtX[b][a];

  /* Inverse mitrechnen: Die Diagonale von (X'X)^-1 traegt die
     Standardfehler, ohne sie gaebe es keine t-Statistik. */
  const M = XtX.map((zeile, i) => [...zeile, ...Array.from({ length: k }, (_, j) => i === j ? 1 : 0)]);
  for (let sp = 0; sp < k; sp++) {
    let pivot = sp;
    for (let z = sp + 1; z < k; z++) if (Math.abs(M[z][sp]) > Math.abs(M[pivot][sp])) pivot = z;
    if (Math.abs(M[pivot][sp]) < 1e-12) return null;   // singulaer
    [M[sp], M[pivot]] = [M[pivot], M[sp]];
    const d = M[sp][sp];
    for (let j = 0; j < 2 * k; j++) M[sp][j] /= d;
    for (let z = 0; z < k; z++) {
      if (z === sp) continue;
      const f = M[z][sp];
      if (!f) continue;
      for (let j = 0; j < 2 * k; j++) M[z][j] -= f * M[sp][j];
    }
  }
  const inv = M.map(z => z.slice(k));
  const b = new Array(k).fill(0);
  for (let a = 0; a < k; a++) for (let c = 0; c < k; c++) b[a] += inv[a][c] * Xty[c];

  const my = cpMittel(y);
  let rss = 0, tss = 0;
  for (let i = 0; i < n; i++) {
    let hut = 0;
    for (let a = 0; a < k; a++) hut += b[a] * A[i][a];
    rss += (y[i] - hut) ** 2;
    tss += (y[i] - my) ** 2;
  }
  const s2 = rss / (n - k);
  const t = b.map((wert, a) => {
    const se = Math.sqrt(Math.max(0, s2 * inv[a][a]));
    return se > 0 ? wert / se : null;
  });
  const r2 = tss > 0 ? 1 - rss / tss : null;
  return {
    b, t, r2, n, k,
    r2adj: (r2 != null && n > k) ? 1 - (1 - r2) * (n - 1) / (n - k) : null,
  };
}

/** Faktorregion zur Heimatboerse. */
function cpRegionWahl(symbol) {
  const teile = String(symbol || "").split(".");
  const k = teile.length > 1 ? teile[teile.length - 1].toUpperCase() : null;
  if (!k) return "US";
  const eu = ["DE", "F", "BE", "MU", "SG", "HM", "DU", "PA", "AS", "BR", "MI",
              "MC", "LS", "VI", "HE", "ST", "CO", "OL", "IC", "AT", "L", "SW",
              "WA", "PR", "IS"];
  if (eu.includes(k)) return "EU";
  if (k === "T") return "JP";
  if (["HK", "AX", "NZ", "SI", "KS", "KQ", "TW", "SS", "SZ", "NS", "BO"].includes(k)) return "AP";
  return null;      // Kanada, Lateinamerika, Afrika - keine passende Reihe
}

/**
 * Faktorregression: Wie viel der Kursbewegung erklaeren bekannte Faktoren?
 *
 *   Carhart (1997), vier Faktoren:
 *     Ri − Rf = a + b·MKT + s·SMB + h·HML + m·MOM + e
 *   Fama & French (2015), fuenf Faktoren plus Momentum:
 *     zusaetzlich r·RMW + c·CMA
 *
 * Carharts Befund war, dass die scheinbare Treffsicherheit erfolgreicher
 * Fondsmanager fast vollstaendig aus Faktor-Exposure und Kosten stammte und
 * nicht aus Koennen. Dasselbe laesst sich fuer einen einzelnen Titel fragen:
 * Bleibt nach Abzug der Faktoren noch etwas uebrig?
 *
 * Gerechnet auf gemeinsamen Monaten - die Faktorreihen enden rund zwei Monate
 * vor heute, weil Kenneth French sie erst dann veroeffentlicht.
 */
function cpFaktorRegression(chart, faktoren, region) {
  if (!faktoren || !faktoren.regionen) return { grund: "Keine Faktordaten geladen." };
  if (!region) return { grund: "Für diese Börse gibt es keine passende Faktorreihe." };
  const R = faktoren.regionen[region];
  if (!R) return { grund: `Für die Region ${region} fehlen die Faktordaten.` };

  const kurse = cpMonatsende(chart.t, chart.c);
  const spalte = {}; R.spalten.forEach((n, i) => { spalte[n] = i; });

  /* Monatsrenditen des Titels auf die Faktormonate legen. Die Faktordatei
     nennt den Monat als "JJJJMM", cpMonatsende als "JJJJ-MM". */
  const reihen = [];
  for (let i = 1; i < R.monate.length; i++) {
    const m0 = R.monate[i - 1], m1 = R.monate[i];
    const k = x => x.slice(0, 4) + "-" + x.slice(4);
    const p0 = kurse.get(k(m0)), p1 = kurse.get(k(m1));
    if (!(p0 > 0 && p1 > 0)) continue;
    reihen.push({ monat: m1, r: p1 / p0 - 1, f: R.werte[i], rf: R.rf[i] });
  }
  const K = AK_CONFIG.faktoren;
  const teil = reihen.slice(-K.monate);
  if (teil.length < K.minMonate) {
    return { grund: `Nur ${teil.length} gemeinsame Monate mit der Faktorreihe, mindestens ${K.minMonate} nötig.` };
  }

  const y = teil.map(z => z.r - z.rf);
  const nimm = namen => teil.map(z => namen.map(n => z.f[spalte[n]]));
  const modell = (namen) => {
    const erg = cpOls(y, nimm(namen));
    if (!erg) return null;
    return {
      namen,
      alpha: erg.b[0] * 12, tAlpha: erg.t[0],
      ladungen: namen.map((n, i) => ({ name: n, wert: erg.b[i + 1], t: erg.t[i + 1] })),
      r2: erg.r2, r2adj: erg.r2adj, n: erg.n,
    };
  };

  const carhart = modell(["MktRF", "SMB", "HML", "Mom"]);
  const ff5 = modell(["MktRF", "SMB", "HML", "RMW", "CMA", "Mom"]);
  if (!carhart) return { grund: "Die Regression ließ sich nicht lösen (singuläre Matrix)." };

  return {
    carhart, ff5, region, regionName: R.name, quelle: R.quelle,
    von: teil[0].monat, bis: teil[teil.length - 1].monat, stand: faktoren.stand,
    /* Der Zuwachs an erklaerter Varianz durch Profitabilitaet und Investition.
       Ist er klein, tragen die beiden zusaetzlichen Faktoren bei diesem Titel
       nichts - und das gehoert gesagt, statt sechs Ladungen hinzustellen. */
    zugewinn: (ff5 && carhart && ff5.r2adj != null && carhart.r2adj != null)
      ? ff5.r2adj - carhart.r2adj : null,
  };
}

/* =====================================================================
   Modul 3a - Faktorprofil im Querschnitt
   ===================================================================== */

/**
 * Perzentilrang eines Werts in einer Liste.
 * 0 heisst kleinster, 100 groesster. Gleichstaende teilen sich den Rang.
 */
function cpRang(wert, liste) {
  const gueltig = liste.filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
  if (gueltig.length < AK_CONFIG.faktoren.minUniversum || wert == null || !isFinite(wert)) return null;
  let kleiner = 0, gleich = 0;
  for (const x of gueltig) { if (x < wert) kleiner++; else if (x === wert) gleich++; }
  return Math.round(100 * (kleiner + gleich / 2) / gueltig.length);
}

/** Momentum- und Schwankungsrang im Korb. */
function cpQuerRang(symbol, quer) {
  if (!quer || !Array.isArray(quer.werte)) return null;
  const eigen = quer.werte.find(x => x.s === symbol);
  if (!eigen) return null;
  const rang = (feld) => cpRang(eigen[feld], quer.werte.map(x => x[feld]));
  const n = (feld) => quer.werte.filter(x => x[feld] != null && isFinite(x[feld])).length;
  return {
    stand: quer.stand,
    mom12: { wert: eigen.m12, rang: rang("m12"), n: n("m12") },
    mom6: { wert: eigen.m6, rang: rang("m6"), n: n("m6") },
    vola: { wert: eigen.v, rang: rang("v"), n: n("v") },
  };
}

/**
 * Faktorprofil eines Titels gegenueber dem Vergleichskorb.
 *
 * Die vier Fundamentalfaktoren aus Fama & French (1993, 2015), gerechnet aus
 * data/fundamentals.json - dieselbe Datei, die die Seite ohnehin laedt. Kein
 * zusaetzlicher Abruf, und das Universum ist genau die Menge, ueber die die
 * Startseite spricht.
 *
 * Wichtig fuer die Lesart: Ein hoher Wert-Rang heisst "guenstig bewertet
 * gemessen am Buchwert", nicht "guenstig". Und die Praemien sind Durchschnitte
 * ueber viele Aktien und lange Zeitraeume - die Wertpraemie war von etwa 2007
 * bis 2020 schwach.
 */
function cpProfil(symbol, alle) {
  if (!alle) return null;
  const basis = String(symbol).split(".")[0].toUpperCase();

  const kennzahlen = (e) => {
    const s = (e && e.sec) || {}, m = (e && e.markt) || {};
    const ser = s._series || {};
    const jahr = (k, i = 0) => {
      const o = ser[k] || {};
      const keys = Object.keys(o).sort().reverse();
      return keys[i] != null ? o[keys[i]] : null;
    };
    const mw = m.marketCap;
    const ek = s.equity ?? jahr("equity");
    const ta0 = s.totalAssets ?? jahr("totalAssets"), ta1 = jahr("totalAssets", 1);
    const gp = s.grossProfit ?? jahr("grossProfit");
    return {
      groesse: mw > 0 ? Math.log(mw) : null,
      wert: (ek > 0 && mw > 0) ? ek / mw : null,
      profit: (gp != null && ta0 > 0) ? gp / ta0 : null,
      // Niedriges Bilanzwachstum = "konservativ" = die ertragreichere Seite
      investition: (ta0 > 0 && ta1 > 0) ? ta0 / ta1 - 1 : null,
    };
  };

  /* Nur fuer Titel des Vergleichskorbs. Ein Titel ausserhalb bekaeme sonst
     ein Profil aus lauter Gedankenstrichen - ein leerer Rahmen, der aussieht,
     als waeren die Daten nur gerade nicht da. */
  if (!alle[basis]) return null;
  const eigen = kennzahlen(alle[basis]);
  const universum = Object.values(alle).map(kennzahlen);

  const felder = [
    { id: "groesse", name: "Größe", hoch: "groß", niedrig: "klein",
      note: "Marktkapitalisierung, logarithmiert. Kleine Unternehmen hatten historisch die höhere Rendite (SMB)." },
    { id: "wert", name: "Wert", hoch: "günstig zum Buchwert", niedrig: "teuer zum Buchwert",
      note: "Buchwert geteilt durch Marktwert. Hoch heißt günstig gemessen am Eigenkapital (HML) – nicht günstig schlechthin." },
    { id: "profit", name: "Profitabilität", hoch: "profitabel", niedrig: "wenig profitabel",
      note: "Bruttogewinn je Einheit Bilanzsumme (RMW)." },
    { id: "investition", name: "Investition", hoch: "wächst stark", niedrig: "wächst verhalten",
      note: "Wachstum der Bilanzsumme. Verhalten wachsende Unternehmen schnitten besser ab (CMA) – hier ist der NIEDRIGE Rang die historisch ertragreichere Seite." },
  ];
  /* Je Faktor eine eigene Vergleichszahl: Nicht jeder Titel meldet jede
     Groesse - Banken weisen keinen Bruttogewinn aus, und ohne Marktwert gibt
     es weder Groesse noch Wert. Eine gemeinsame Zahl "n = 74" waere fuer
     einzelne Zeilen schlicht falsch. */
  return {
    werte: felder.map(f => {
      const spalte = universum.map(x => x[f.id]);
      return {
        ...f,
        wert: eigen[f.id],
        rang: cpRang(eigen[f.id], spalte),
        n: spalte.filter(x => x != null && isFinite(x)).length,
      };
    }),
  };
}

/* =====================================================================
   Gesamt-Score
   ===================================================================== */

/**
 * Gewichtetes Mittel vorhandener Bausteine, jeder auf der Skala 0 bis 100.
 *
 * Fehlende Bausteine zaehlen NICHT als null, sondern fallen heraus; ueber den
 * Rest wird neu normiert. Der Unterschied ist nicht akademisch: Ein Titel ohne
 * Bilanzdaten bekaeme sonst allein dafuer eine schlechte Note.
 *
 * @param {Object<string, number|null>} teile
 * @param {Object<string, number>} gewichte
 */
function cpScoreAusTeilen(teile, gewichte) {
  let summe = 0, gewicht = 0;
  for (const k of Object.keys(gewichte)) {
    const v = teile[k];
    if (v == null || !isFinite(v)) continue;
    summe += v * gewichte[k];
    gewicht += gewichte[k];
  }
  return gewicht > 0 ? summe / gewicht : null;
}

/**
 * Gesamt-Score aus den Ergebnissen der einzelnen Module.
 *
 * Was hier passiert, ist eine Gewichtung von Dingen, die sich nicht von
 * selbst vergleichen lassen: ein Perzentilrang, eine Punktzahl von neun, ein
 * Bewertungsrang. Dass sie sich zu einer Zahl verrechnen lassen, heisst nicht,
 * dass die Zahl etwas bedeutet - deshalb steht in der Anzeige neben dem Score,
 * was eine Rueckmessung dazu ergeben hat, und deshalb sind alle Gewichte
 * sichtbar und veraenderbar.
 *
 * @param {object} erg  Ergebnisse aus cpRechne
 * @param {object} scores  Dossier-Scores (Piotroski), optional
 * @param {object} gewichte
 */
function cpScore(erg, scores, gewichte) {
  const g = gewichte || AK_CONFIG.score.gewichte;
  const rang = (id) => {
    const w = erg.profil && erg.profil.werte.find(x => x.id === id);
    return w ? w.rang : null;
  };
  const teile = {
    momentum: erg.quer ? erg.quer.mom12.rang : null,
    ruhe: (erg.quer && erg.quer.vola.rang != null) ? 100 - erg.quer.vola.rang : null,
    qualitaet: (scores && scores.piotroski != null && scores.piotroskiMax >= 6)
      ? Math.round(100 * scores.piotroski / scores.piotroskiMax) : null,
    bewertung: rang("wert"),
    profitabilitaet: rang("profit"),
  };
  const vorhanden = Object.keys(g).filter(k => teile[k] != null && isFinite(teile[k]));
  if (vorhanden.length < AK_CONFIG.score.minBausteine) {
    return { grund: `Nur ${vorhanden.length} von ${Object.keys(g).length} Bausteinen vorhanden,`
      + ` mindestens ${AK_CONFIG.score.minBausteine} nötig.`, teile };
  }
  const wert = cpScoreAusTeilen(teile, g);
  const gesamtGewicht = vorhanden.reduce((a, k) => a + g[k], 0);
  return {
    wert, teile, gewichte: g, vorhanden,
    /* Was jeder Baustein beitraegt, nach der Neunormierung - das ist die
       Zahl, die in der aufgeklappten Ansicht stehen muss, nicht das
       eingestellte Rohgewicht. */
    beitraege: Object.keys(g).map(k => ({
      id: k,
      gewicht: g[k],
      anteil: teile[k] == null ? null : g[k] / gesamtGewicht,
      wert: teile[k],
      beitrag: teile[k] == null ? null : teile[k] * g[k] / gesamtGewicht,
    })),
    fehlend: Object.keys(g).filter(k => teile[k] == null),
  };
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
const cpVorrat = { rf: null, faktoren: null, quer: null, benches: new Map() };

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

/**
 * Querschnittswerte des Korbs aus data/quer.json.
 *
 * Jegadeesh & Titman (1993) haben den Momentum-Effekt ueber die RANGFOLGE
 * vieler Aktien gefunden, nicht am einzelnen Titel. "+25 % in zwoelf Monaten"
 * sagt ohne die Vergleichsmenge nicht, ob das viel ist. Die Datei entsteht im
 * selben Lauf wie das Laufband der Startseite - die Kurse des Korbs werden
 * dort ohnehin geholt.
 */
async function cpQuer() {
  if (!cpVorrat.quer) {
    cpVorrat.quer = fetch(AK_CONFIG.faktoren.quelleQuer + "?v=" + Date.now())
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  }
  return cpVorrat.quer;
}

/** Faktorreihen und Zinsen aus data/faktoren.json. Einmal je Sitzung. */
async function cpFaktoren() {
  if (!cpVorrat.faktoren) {
    cpVorrat.faktoren = fetch(AK_CONFIG.faktoren.quelle + "?v=" + Date.now())
      .then(r => r.ok ? r.json() : null)
      .catch(() => null);
  }
  return cpVorrat.faktoren;
}

/**
 * Risikofreier Zins in der Waehrung der Notierung.
 *
 * Fuer den Euroraum liefert die EZB die Rendite der Bundesanleihe - bis Phase 3
 * rechnete das Cockpit auch fuer Euro-Titel mit dem US-Zins und sagte das dazu.
 * Fuer alles andere bleibt ^TNX: aktuell, taeglich, aus derselben Kursquelle.
 */
async function cpRfFuer(waehrung) {
  const w = String(waehrung || "").toUpperCase();
  if (w === "EUR") {
    const f = await cpFaktoren();
    const z = f && f.zinsen && f.zinsen.EUR;
    if (z && z.wert > 0) {
      return { wert: z.wert, quelle: z.name, stand: z.stand, passt: true };
    }
  }
  const us = await cpRf();
  return { ...us, passt: !w || w.startsWith(AK_CONFIG.capm.rfWaehrung) };
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
function cpRechne(chart, bench, rf, roh, fund, faktoren, symbol, quer) {
  const risiko = cpRisiko(chart, bench);
  return {
    risiko,
    capm: cpCapm(chart, bench, rf, risiko.volaKurz),
    momentum: cpMomentum(chart, bench),
    verhalten: cpVerhalten(chart),
    cape: cpCape(roh && roh.cape, fund && fund.marketCap, fund && fund.trailingPE),
    regression: cpFaktorRegression(chart, faktoren, cpRegionWahl(symbol)),
    profil: cpProfil(symbol, (typeof Fundamentals === "object" && Fundamentals.data) || null),
    quer: cpQuerRang(symbol, quer),
  };
}

/** Score getrennt, weil er auf den Ergebnissen der anderen Module aufsetzt. */
function cpScoreDazu(erg, roh, fund, gewichte) {
  let scores = null;
  try {
    if (typeof computeScores === "function" && roh) {
      scores = computeScores(roh, { marketCap: fund && fund.marketCap, fcf: fund && fund.fcf });
    }
  } catch (e) { /* ohne Bilanzdaten eben ohne Qualitaetsbaustein */ }
  erg.score = cpScore(erg, scores, gewichte);
  return erg;
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
  Object.assign(INFO, {
    cpGroesse: ["Faktor Größe (SMB)",
      "Perzentilrang der Marktkapitalisierung im eigenen Vergleichskorb, logarithmiert. 100 heißt: der größte Titel des Korbs.\n\nFama & French (1993) fanden, dass kleine Unternehmen systematisch höher rentierten als große – der Faktor heißt SMB für „small minus big“.\n\nEin Durchschnitt über viele Aktien und Jahrzehnte, keine Aussage über diesen Titel. Die Größenprämie war in den Jahren nach 2000 deutlich schwächer als davor."],
    cpWert: ["Faktor Wert (HML)",
      "Buchwert des Eigenkapitals geteilt durch den Marktwert, als Perzentilrang. Hoch heißt: günstig gemessen am Eigenkapital.\n\nFama & French (1993): Aktien mit hohem Buch-zu-Marktwert rentierten höher – HML für „high minus low“.\n\nZwei Vorbehalte. Erstens heißt „günstig zum Buchwert“ nicht „günstig“: Ein niedriger Buchwert kann auch heißen, dass das Geschäft auf immateriellen Werten beruht, die in keiner Bilanz stehen. Zweitens war die Wertprämie von etwa 2007 bis 2020 schwach. Bei Banken und Versicherungen ist der Buchwert ohnehin nur eingeschränkt vergleichbar."],
    cpProfit: ["Faktor Profitabilität (RMW)",
      "Bruttogewinn je Einheit Bilanzsumme, als Perzentilrang.\n\nFama & French (2015) nahmen diesen Faktor neu auf: Profitable Unternehmen rentierten besser als wenig profitable – RMW für „robust minus weak“.\n\nBanken und Versicherungen weisen keinen Bruttogewinn aus; für sie bleibt die Zeile leer, statt eine andere Größe hineinzurechnen."],
    cpInvest: ["Faktor Investition (CMA)",
      "Wachstum der Bilanzsumme gegenüber dem Vorjahr, als Perzentilrang.\n\nFama & French (2015): Unternehmen, die ihre Bilanz verhalten ausweiten, schnitten besser ab als stark investierende – CMA für „conservative minus aggressive“.\n\nAchtung bei der Leserichtung: Hier ist der NIEDRIGE Rang die historisch ertragreichere Seite. Bei allen anderen Faktoren ist es der hohe."],
    cpLadung: ["Faktorladung",
      "Wie stark der Titel auf einen Faktor reagiert – die Steigung in der Mehrfachregression der monatlichen Überschussrenditen.\n\nEine Ladung von 0,8 auf Wert (HML) heißt: Der Titel bewegt sich wie ein Portfolio mit kräftigem Value-Charakter. Negative Ladungen sind die Gegenseite – minus auf HML heißt Wachstumscharakter.\n\nEntscheidend ist die t-Statistik daneben. Unter |t| = 2 ist die Ladung nicht von null zu unterscheiden; die Zahl steht trotzdem da, aber zurückgenommen."],
    cpR2adj: ["Erklärte Varianz (bereinigtes R²)",
      "Welcher Anteil der monatlichen Kursbewegung sich durch die Faktoren erklären lässt, korrigiert um die Zahl der Regressoren.\n\nDie Korrektur ist nötig, weil jedes zusätzliche Merkmal das rohe R² mechanisch anhebt, auch wenn es nichts erklärt. Das bereinigte R² kann deshalb sinken, wenn man Faktoren hinzunimmt – und tut es hier regelmäßig."],
    cpRisikoanteil: ["Risikoanteil einer Position",
      "Wie viel eine Position zur Schwankung des GESAMTEN Depots beiträgt – nicht wie viel sie wiegt und nicht wie stark sie selbst schwankt.\n\nFormel: w·(Σw)/σ, wobei w die Gewichte sind und Σ die Kovarianzmatrix. Diese Beiträge summieren sich exakt zu 100 %, deshalb lassen sie sich als Anteile lesen.\n\nEine Position mit 25 % Gewicht und 52 % Risikoanteil ist das, was ein Depot kippen lässt. Eine mit 12 % Gewicht und 2 % Risikoanteil ist das, was es ruhig hält – sie schwankt wenig UND läuft nicht mit dem Rest."],
    cpKorrRest: ["Korrelation zum Rest des Depots",
      "Wie gleichförmig sich diese Position und der gesamte übrige Depotbestand bewegen, auf Monatsbasis.\n\nDas ist die Zahl, die „diversifiziert dieser Titel?“ beantwortet – nicht die Korrelation zu einem einzelnen anderen Titel. Niedrig heißt: Die Position geht ihren eigenen Weg und senkt dadurch das Gesamtrisiko, selbst wenn sie für sich genommen stark schwankt.\n\nMarkowitz (1952): Genau darum geht es. Zwei schwankungsreiche Titel mit niedriger Korrelation ergeben zusammen ein ruhigeres Depot als ein einzelner ruhiger Titel vermuten lässt."],
    cpAlphaReg: ["Alpha der Faktor-Regression",
      "Was nach Abzug der Faktoren übrig bleibt: der Achsenabschnitt der Regression, auf ein Jahr hochgerechnet.\n\nCarhart (1997) untersuchte damit Investmentfonds und fand, dass ihre scheinbare „Hot Hand“ fast vollständig durch Momentum-Exposure und Kosten erklärbar war – nicht durch Können. Dauerhaft war nur die Underperformance der schlechtesten Fonds.\n\nOhne gesicherte t-Statistik ist ein Alpha kein Können, sondern Streuung. Und es ist rückblickend: Dass etwas übrig blieb, sagt nicht, dass es wieder übrig bleibt."],
  });
  Object.assign(INFO_LABELS, {
    "faktor größe": "cpGroesse", "faktor wert": "cpWert",
    "faktor profitabilität": "cpProfit", "faktor investition": "cpInvest",
    "markt": "cpLadung", "größe smb": "cpLadung", "wert hml": "cpLadung",
    "profitabilität rmw": "cpLadung", "investition cma": "cpLadung",
    "momentum mom": "cpLadung",
    "erklärte varianz": "cpR2adj", "alpha p. a.": "cpAlphaReg",
    "risikoanteil": "cpRisikoanteil", "zum rest": "cpKorrRest",
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

/** Faktorkuerzel in Worte. "SMB" sagt niemandem etwas, der es nicht ohnehin weiss. */
function cpLadungName(k) {
  return ({ MktRF: "Markt", SMB: "Größe (SMB)", HML: "Wert (HML)",
            RMW: "Profitabilität (RMW)", CMA: "Investition (CMA)",
            Mom: "Momentum (MOM)" })[k] || k;
}

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
  const { risiko: r, capm: cm, momentum: m, verhalten: v, cape } = erg;
  const waehrung = (chart.meta && chart.meta.currency) || "";
  const zinsPasst = rf.passt !== false;

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
    ${erg.quer && erg.quer.mom12.rang != null
      ? cpZeile("Perzentil im Vergleichskorb", String(erg.quer.mom12.rang),
          `unter ${erg.quer.mom12.n} Titeln, Stand ${e(erg.quer.stand)} ·
           ${erg.quer.mom12.rang >= 80 ? "oberes Fünftel"
             : erg.quer.mom12.rang <= 20 ? "unteres Fünftel" : "Mittelfeld"}
           · Schwankung Perzentil ${erg.quer.vola.rang ?? "–"}`)
      : ""}
    ${!erg.quer ? `<p class="cp-note">Kein Rang: Der Titel steht nicht im Vergleichskorb
       (<code>scripts/chancen_watchlist.txt</code>). Die absoluten Werte oben gelten trotzdem.</p>` : ""}
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

  /* --- 7 Bewertung --- */
  const capeHtml = !cape ? "" : `
    <div class="cp-teil">
      <h4>Bewertung <span class="cp-q">Shiller 1981</span></h4>
      ${cpZeile("Zyklusbereinigtes KGV", cpZ(cape.wert, 1),
         `Marktwert geteilt durch den Gewinnschnitt von ${cape.jahre} Jahren`
         + (cape.vollstaendig ? "" : " – weniger als zehn, die Glättung ist schwächer"))}
      ${cpZeile("Laufendes KGV", cpZ(cape.kgv, 1),
         cape.verhaeltnis == null ? "" : `${cpZ(cape.verhaeltnis, 2)} × des zyklusbereinigten – ${e(cape.lage)}`)}
      ${cape.verlustjahre ? cpZeile("Verlustjahre im Schnitt", String(cape.verlustjahre),
         "gehen mit negativem Vorzeichen in den Durchschnitt ein") : ""}
      <p class="cp-fuss">Gewinne der SEC-Jahresabschlüsse, mit dem US-Verbraucherpreisindex
        auf die Kaufkraft von ${cape.basisjahr} gebracht. Gerechnet auf dem Gesamtgewinn,
        nicht je Aktie: Ein Aktiensplit ändert den Gewinn je Aktie, ohne dass sich am
        Unternehmen etwas ändert – Nvidias 10:1-Teilung 2024 ließ ihn von 12,08 auf 2,98
        fallen. Marktwert und Gesamtgewinn sind beide Aggregate und dagegen unempfindlich.
        <br><b>Kein Zeitpunktsignal.</b> Ein hohes CAPE ging historisch mit niedrigeren
        Renditen der folgenden zehn Jahre einher und sagt über die nächsten Monate nichts.
        Bei Unternehmen ohne lange Gewinnhistorie oder nach einem Geschäftsmodellwechsel
        vergleicht der Zehnjahresschnitt zwei verschiedene Firmen miteinander.</p>
    </div>`;

  /* --- 3a Faktorprofil im Querschnitt --- */
  const pf = erg.profil;
  const profilHtml = !pf ? "" : `
    <div class="cp-teil">
      <h4>Faktorprofil <span class="cp-q">Fama &amp; French 1993 / 2015</span></h4>
      ${pf.werte.map(w => `<div class="cp-rang${w.rang == null ? " leer" : ""}">
        <span class="cp-n">${e(w.name)}${typeof infoFuer === "function" ? infoFuer("Faktor " + w.name) : ""}</span>
        <span class="cp-balken"><i style="left:${w.rang == null ? 0 : w.rang}%"></i></span>
        <b>${w.rang == null ? "–" : w.rang}</b>
        <span class="cp-note">${w.rang == null
          ? `zu wenige Vergleichstitel (${w.n})`
          : `${e(w.rang >= 50 ? w.hoch : w.niedrig)} · Perzentil unter ${w.n} Titeln`}</span>
      </div>`).join("")}
      <p class="cp-fuss">Perzentilrang im eigenen Vergleichskorb, aus
        <code>data/fundamentals.json</code>. 100 heißt höchster Wert, 0 niedrigster.
        Je Faktor eine eigene Vergleichszahl – nicht jeder Titel meldet jede Größe;
        Banken weisen keinen Bruttogewinn aus, ohne Marktwert gibt es weder Größe noch Wert.
        Was jeder Faktor misst und in welche Richtung er historisch zahlte, steht im
        <b>i</b> neben seinem Namen.
        <br><b>Durchschnitte über viele Aktien, keine Prognose für diesen Titel.</b>
        Die Wertprämie war von etwa 2007 bis 2020 schwach, und bei Banken und
        Versicherungen ist der Buchwert nur eingeschränkt vergleichbar.</p>
    </div>`;

  /* --- 3b + 5 Faktor-Regression --- */
  const rg = erg.regression;
  let regHtml = "";
  if (rg && !rg.grund && rg.carhart) {
    const c = rg.carhart;
    const sig = c.tAlpha != null && Math.abs(c.tAlpha) > 2;
    const lad = (l) => cpZeile(e(cpLadungName(l.name)), cpZ(l.wert),
      l.t == null ? "" : `t = ${cpZ(l.t, 1)}${Math.abs(l.t) > 2 ? "" : " – nicht gesichert"}`,
      Math.abs(l.t || 0) > 2 ? "" : "cp-blass");
    const lohnt = rg.zugewinn != null && rg.zugewinn >= AK_CONFIG.faktoren.zugewinnSichtbar;
    regHtml = `
    <div class="cp-teil">
      <h4>Faktor-Regression <span class="cp-q">Carhart 1997</span></h4>
      ${cpZeile("Erklärte Varianz", cpP(c.r2adj, 0),
         `${cpP(c.r2adj, 0)} der monatlichen Kursbewegung erklären Markt, Größe, Wert und Momentum`)}
      ${cpZeile("Alpha p. a.", cpP(c.alpha),
         c.tAlpha == null ? "" : sig
           ? `t = ${cpZ(c.tAlpha, 1)} – <b class="cp-ok">bleibt nach Abzug der Faktoren übrig</b>`
           : `t = ${cpZ(c.tAlpha, 1)} – <b>nicht von null zu unterscheiden</b>`,
         sig ? (c.alpha >= 0 ? "up" : "down") : "")}
      ${c.ladungen.map(lad).join("")}
      ${lohnt ? cpZeile("Fünf Faktoren statt vier", "+" + cpP(rg.zugewinn, 1),
         `Profitabilität ${cpZ(rg.ff5.ladungen[3].wert)} (t ${cpZ(rg.ff5.ladungen[3].t, 1)}),
          Investition ${cpZ(rg.ff5.ladungen[4].wert)} (t ${cpZ(rg.ff5.ladungen[4].t, 1)})`) : ""}
      <p class="cp-fuss">Monatliche Überschussrenditen über ${c.n} Monate (${e(rg.von)} bis
        ${e(rg.bis)}) auf die Faktorrenditen für ${e(rg.regionName)}. Quelle: ${e(rg.quelle)},
        Stand ${e(rg.stand)} – die Reihen erscheinen rund zwei Monate nach dem Berichtsmonat.
        ${lohnt ? "" : `Profitabilität und Investition bringen bei diesem Titel keinen
          nennenswerten Zugewinn${rg.zugewinn != null ? ` (${cpP(rg.zugewinn, 1)} bereinigtes R²)` : ""} –
          deshalb steht hier das Vierfaktorenmodell.`}
        <br>Carharts Befund: Die scheinbare Treffsicherheit erfolgreicher Fondsmanager
        ließ sich fast vollständig durch Faktor-Exposure und Kosten erklären. Ein Alpha ohne
        gesicherte t-Statistik ist kein Können, sondern Streuung. Rückblickend, nicht prognostisch.</p>
    </div>`;
  } else if (rg && rg.grund) {
    regHtml = `<div class="cp-teil">
      <h4>Faktor-Regression <span class="cp-q">Carhart 1997</span></h4>
      <p class="cp-leer">${e(rg.grund)}</p></div>`;
  }

  const scoreHtml = erg.score ? cpScoreHtml(erg.score, cpOffen) : "";

  out.className = "";
  out.innerHTML = `
    ${scoreHtml}
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
    ${profilHtml}
    ${regHtml}
    ${capeHtml}
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
        gegen den falschen Maßstab gerechnet. Für Euro-Notierungen liefert die EZB die
        Bundesanleihe; für andere Währungen fehlt die Reihe noch.`}
      <br>Alle Einstellungen stehen in <code>config.js</code>.
      ${cape ? "" : "Ein zyklusbereinigtes KGV gibt es nur für Titel mit mehrjährigen SEC-Bilanzen. "}
      Die Bilanzqualität steht im Dossier.
      <br><b>Keine Anlageberatung.</b> Momentum- und Faktoreffekte sind Durchschnitte über
      viele Aktien; auf einen einzelnen Titel angewandt sind sie eine Einordnung, keine Prognose.
    </p>`;
}

/**
 * Portfolioabschnitt fuer die Depotansicht.
 *
 * Steht hier und nicht in depot.js, damit die Rechnung und ihre Darstellung
 * beieinander bleiben - dieselbe Trennung wie beim Rest des Cockpits. depot.js
 * ruft die Funktion nur auf.
 */
function cpPortfolioHtml(positionen, charts) {
  if (typeof cpPortfolio !== "function") return "";
  const e = typeof esc === "function" ? esc : (x => x);
  const p = cpPortfolio(positionen, charts);
  if (p.grund) {
    return `<div class="dp-panel cp-pf">
      <div class="dp-panel-h"><h4>Risikobeitrag <span class="cp-q">Markowitz 1952</span></h4></div>
      <p class="cp-leer">${e(p.grund)}</p></div>`;
  }
  const K = AK_CONFIG.portfolio;
  const pp = v => (v < 0 ? "−" : "+") + (Math.abs(v) * 100).toLocaleString("de-DE",
    { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + " Pp";

  const schwer = p.eintraege.filter(x => x.ueberhang >= K.ueberhangWarnung);
  const traeger = p.eintraege.filter(x => x.korrRest != null && x.korrRest < 0.3);

  const zeilen = p.eintraege.map(x => `<tr>
      <td>${e(x.sym)}</td>
      <td class="r">${cpP(x.gewicht, 1)}</td>
      <td class="r">${cpP(x.vola, 0)}</td>
      <td class="r"><span class="cp-pfbalken"><i style="width:${Math.min(100, x.anteil * 100)}%"></i></span>${cpP(x.anteil, 1)}</td>
      <td class="r ${x.ueberhang >= K.ueberhangWarnung ? "down" : x.ueberhang <= -K.ueberhangWarnung ? "up" : ""}">${pp(x.ueberhang)}</td>
      <td class="r">${x.korrRest == null ? "–" : cpZ(x.korrRest)}</td>
    </tr>`).join("");

  /* Die Korrelationsmatrix als Farbfeld. Zahlen daneben waeren bei zehn
     Positionen hundert Zellen - die Farbe traegt die Uebersicht, der
     Titelzusatz die genaue Zahl. */
  const matrix = p.symbole.length <= 14 ? `
    <div class="cp-matrixwrap">
      <table class="cp-matrix">
        <tr><th></th>${p.symbole.map(s => `<th><span>${e(s)}</span></th>`).join("")}</tr>
        ${p.korr.map((zeile, i) => `<tr><th>${e(p.symbole[i])}</th>${zeile.map((v, j) => {
          if (i === j) return `<td class="selbst">·</td>`;
          const stufe = v == null ? 0 : Math.max(-1, Math.min(1, v));
          const farbe = stufe >= 0
            ? `rgba(224,106,114,${(stufe * 0.55).toFixed(2)})`
            : `rgba(79,184,172,${(-stufe * 0.55).toFixed(2)})`;
          return `<td style="background:${farbe}" title="${e(p.symbole[i])} zu ${e(p.symbole[j])}: ${cpZ(v)}">${
            Math.abs(stufe) >= 0.5 ? cpZ(v, 1).replace("0,", ",") : ""}</td>`;
        }).join("")}</tr>`).join("")}
      </table>
    </div>` : `<p class="cp-note">Die Matrix wird ab 15 Positionen unleserlich und bleibt
      deshalb aus; die Spalte „zum Rest“ in der Tabelle sagt dasselbe je Position.</p>`;

  return `<div class="dp-panel cp-pf">
    <div class="dp-panel-h"><h4>Risikobeitrag <span class="cp-q">Markowitz 1952</span></h4></div>

    <div class="cp-pfkopf">
      <div><span>Depot-Volatilität</span><b>${cpP(p.volP, 1)}</b></div>
      <div><span>Summe der Einzelrisiken</span><b>${cpP(p.gewichtetesMittel, 1)}</b></div>
      <div><span>Diversifikationsgewinn</span><b class="up">${cpP(p.gewinn, 1)}</b></div>
    </div>
    <p class="cp-note">Das Depot schwankt ${cpP(p.gewinn, 0)} weniger als die gewichtete Summe
      seiner Positionen. Das ist Markowitz’ eigentlicher Satz: Risiko addiert sich nicht, weil
      die Titel nicht im Gleichschritt laufen.</p>

    <div class="cp-pftab">
      <table>
        <thead><tr><th>Position</th><th class="r">Gewicht</th><th class="r">Vola</th>
          <th class="r">Risikoanteil${typeof infoFuer === "function" ? infoFuer("Risikoanteil") : ""}</th>
          <th class="r">Überhang</th><th class="r">zum Rest${typeof infoFuer === "function" ? infoFuer("zum Rest") : ""}</th></tr></thead>
        <tbody>${zeilen}</tbody>
      </table>
    </div>

    ${schwer.length ? `<p class="cp-note"><b class="cp-warn">Risikoschwerpunkt:</b>
      ${schwer.map(x => `${e(x.sym)} trägt ${cpP(x.anteil, 0)} des Risikos bei ${cpP(x.gewicht, 0)} Gewicht`).join(" · ")}.
      Das ist keine Warnung vor dem Titel, sondern eine Auskunft über das Depot: Was dieser
      Titel tut, bestimmt überdurchschnittlich, was das Depot tut.</p>` : ""}
    ${traeger.length ? `<p class="cp-note">Am meisten zur Streuung tragen
      ${traeger.map(x => e(x.sym)).join(", ")} bei – sie laufen am wenigsten mit dem Rest.</p>` : ""}

    ${matrix}
    <p class="cp-fuss">Kovarianz aus ${p.monate} gemeinsamen Monatsrenditen (${e(p.von)} bis ${e(p.bis)}),
      auf Jahresmaß gebracht. Nur Monate, die alle Positionen haben – Börsen mit anderen
      Feiertagen ließen sich sonst nicht ohne Verschiebung nebeneinanderlegen.
      Der Risikoanteil ist w·(Σw)/σ und summiert sich exakt auf 100 %.
      <br><b>Korrelationen steigen in Krisen</b> – also genau dann, wenn man die Streuung
      bräuchte. Die Zahlen hier sind ein Durchschnitt über ruhige und unruhige Monate.</p>
  </div>`;
}

/* ---------- Gesamt-Score: Anzeige und Gewichtung ---------- */

const CP_GEW_SPEICHER = "ak.score.gewichte";

/** Eingestellte Gewichte, sonst die aus config.js. */
function cpGewichte() {
  try {
    const roh = JSON.parse(localStorage.getItem(CP_GEW_SPEICHER));
    if (roh && typeof roh === "object") {
      const out = {};
      for (const k of Object.keys(AK_CONFIG.score.gewichte)) {
        const v = Number(roh[k]);
        out[k] = (isFinite(v) && v >= 0) ? v : AK_CONFIG.score.gewichte[k];
      }
      if (Object.values(out).some(v => v > 0)) return out;
    }
  } catch (e) { /* kaputter Eintrag -> Standard */ }
  return { ...AK_CONFIG.score.gewichte };
}
function cpGewichteSetzen(g) {
  try { localStorage.setItem(CP_GEW_SPEICHER, JSON.stringify(g)); } catch (e) {}
}
function cpGewichteZuruecksetzen() {
  try { localStorage.removeItem(CP_GEW_SPEICHER); } catch (e) {}
}

const CP_BAUSTEIN_NAMEN = {
  momentum: "Momentum", ruhe: "Ruhe (wenig Schwankung)", qualitaet: "Bilanzqualität",
  bewertung: "Bewertung", profitabilitaet: "Profitabilität",
};
const CP_BAUSTEIN_HER = {
  momentum: "Perzentil des 12-1-Momentums im Korb",
  ruhe: "umgekehrtes Perzentil der Schwankung im Korb",
  qualitaet: "Piotroski F-Score, auf 100 gerechnet",
  bewertung: "Perzentil Buchwert zu Marktwert im Korb",
  profitabilitaet: "Perzentil Bruttogewinn je Bilanzsumme im Korb",
};

function cpScoreHtml(sc, offen) {
  const e = typeof esc === "function" ? esc : (x => x);
  if (sc.grund) {
    return `<div class="cp-score leer">
      <div class="cp-scorekopf"><span class="cp-scorelabel">Gesamt-Score</span>
        <b>–</b></div>
      <p class="cp-note">${e(sc.grund)} Aus den vorhandenen Bausteinen eine Gesamtnote zu
      bilden hieße, die fehlenden als Zustimmung zu lesen.</p></div>`;
  }
  const B = AK_CONFIG.score.befund;
  const stufe = sc.wert >= 70 ? "hoch" : sc.wert >= 40 ? "mittel" : "tief";
  const zeilen = sc.beitraege.map(b => `<div class="cp-sz${b.wert == null ? " leer" : ""}">
      <span class="cp-n">${e(CP_BAUSTEIN_NAMEN[b.id] || b.id)}</span>
      <input type="range" min="0" max="50" step="1" value="${Math.round(b.gewicht * 100)}"
        data-gew="${b.id}" aria-label="Gewicht ${e(CP_BAUSTEIN_NAMEN[b.id] || b.id)}">
      <span class="cp-gw">${Math.round(b.gewicht * 100)} %</span>
      <b>${b.wert == null ? "–" : Math.round(b.wert)}</b>
      <span class="cp-note">${b.wert == null
        ? "nicht verfügbar – fällt aus der Rechnung"
        : `${e(CP_BAUSTEIN_HER[b.id] || "")} · trägt ${cpZ(b.beitrag, 1)} von ${cpZ(sc.wert, 1)} bei`}</span>
    </div>`).join("");

  return `<div class="cp-score ${stufe}">
    <div class="cp-scorekopf">
      <span class="cp-scorelabel">Gesamt-Score</span>
      <b>${Math.round(sc.wert)}</b>
      <span class="cp-scoreskala"><i style="width:${Math.max(0, Math.min(100, sc.wert))}%"></i></span>
      <button type="button" class="cp-mini" id="cp-gewtoggle" aria-expanded="${offen ? "true" : "false"}">
        ${offen ? "Gewichtung einklappen" : "Gewichtung zeigen"}</button>
    </div>
    <div class="cp-gewbox" ${offen ? "" : "hidden"}>
      ${zeilen}
      <div class="cp-gewfuss">
        <button type="button" class="cp-mini" id="cp-gewreset">Standardgewichte</button>
        <span class="cp-note">Die Gewichte sind eine Entscheidung, keine Messung. Niemand hat
        gemessen, dass Momentum ein Viertel wiegen sollte. Änderungen bleiben in diesem Browser.</span>
      </div>
    </div>
    ${sc.fehlend.length ? `<p class="cp-note">Ohne ${sc.fehlend.map(k =>
       e(CP_BAUSTEIN_NAMEN[k] || k)).join(", ")} – über die übrigen Bausteine neu normiert,
       damit eine Lücke nicht als schlechte Note zählt.</p>` : ""}
    ${B ? `<p class="cp-fuss"><b>Was der Score wert ist – gemessen.</b>
      ${B.titel} Titel über zehn Jahre, ${B.stichtage} monatliche Stichtage: Das oberste
      Fünftel nach Score brachte im Folgemonat ${cpP(B.obenMittel, 2)}, das unterste
      ${cpP(B.untenMittel, 2)} – eine Spanne von ${cpP(B.spanne, 2)}
      (95 %: ${cpP(B.lo, 2)} bis ${cpP(B.hi, 2)}, in ${cpP(B.anteilPositiv, 0)} der Monate positiv).
      ${B.lo > 0 ? "" : `<b class="cp-warn">Das Band schließt die Null ein: Als Rangfolge sagt
        der Score in diesem Korb nichts voraus.</b> Als Zusammenfassung der Bausteine bleibt er
        brauchbar – solange ihn niemand für eine Prognose hält. `}
      Geprüft sind nur Momentum und Ruhe – Bilanzqualität, Bewertung und Profitabilität liegen
      nur als heutiger Stand vor, sie auf die Vergangenheit anzuwenden wäre ein Blick in die
      eigenen Karten. Dazu: Der Korb ist heute zusammengestellt, verschwundene Titel fehlen
      darin, und Gebühren sind nicht abgezogen. Nachrechenbar mit
      <code>scripts/score_befund.js</code>.</p>`
    : `<p class="cp-fuss">Für diesen Score liegt noch keine Rückmessung vor
      (<code>scripts/score_befund.js</code>). Bis dahin ist er eine Zusammenfassung der
      Bausteine – nicht mehr.</p>`}
  </div>`;
}

/** Schieberegler und Knöpfe verdrahten; neu zeichnen ohne neu zu rechnen. */
function cpScoreVerdrahten(wurzel, neuZeichnen) {
  const toggle = wurzel.querySelector("#cp-gewtoggle");
  if (toggle) toggle.onclick = () => neuZeichnen(toggle.getAttribute("aria-expanded") !== "true");
  const reset = wurzel.querySelector("#cp-gewreset");
  if (reset) reset.onclick = () => { cpGewichteZuruecksetzen(); neuZeichnen(true); };
  wurzel.querySelectorAll("input[data-gew]").forEach(el => {
    el.oninput = () => {
      const g = cpGewichte();
      g[el.dataset.gew] = Number(el.value) / 100;
      /* Alles auf null waere kein Score, sondern eine Division durch null -
         dann bleibt der letzte sinnvolle Stand stehen. */
      if (Object.values(g).some(v => v > 0)) { cpGewichteSetzen(g); neuZeichnen(true); }
    };
  });
}

/** Vom Detailfenster aufgerufen, nachdem der Abschnitt im Dokument steht. */
/* Ob die Gewichtung aufgeklappt ist, und woraus zuletzt gezeichnet wurde.
   Eine Gewichtsaenderung soll NICHT neu rechnen und schon gar nicht neu
   laden - nur die Gewichte aendern sich, nicht die Daten. */
let cpOffen = false;
let cpStand = null;

function cpNeuZeichnen(offen) {
  if (!cpStand) return;
  cpOffen = !!offen;
  const out = document.getElementById("cp-out");
  if (!out) return;
  cpScoreDazu(cpStand.erg, cpStand.roh, cpStand.fund, cpGewichte());
  cpZeige(out, cpStand.erg, cpStand.bench, cpStand.rf, cpStand.lang, cpStand.item);
  cpScoreVerdrahten(out, cpNeuZeichnen);
}

async function cpVerdrahte(item, chart, fund) {
  const out = document.getElementById("cp-out");
  if (!out) return;
  cpOffen = false; cpStand = null;
  try {
    const waehrung = (chart.meta && chart.meta.currency) || "";
    const [bench, rf, faktoren, quer] = await Promise.all([
      cpBenchmark(item.s), cpRfFuer(waehrung), cpFaktoren(), cpQuer()]);
    /* Fuenf Jahre statt der zwei des Charts: Beta braucht 36 Monate, die
       Drei-Jahres-Volatilitaet 756 Handelstage. Scheitert der Abruf, wird mit
       der vorhandenen Reihe gerechnet - dann fehlen einzelne Werte, statt
       dass der ganze Abschnitt ausfaellt. */
    let lang = chart;
    try { lang = await loadChart(item.s, AK_CONFIG.benchmark.jahre); } catch (e) {}
    /* Rohdaten fuer die Gewinnreihe des CAPE. Fundamentals.load() ist bis
       hierhin laengst gelaufen - das Detailfenster hat sie schon geholt. */
    let roh = null;
    try { roh = (typeof Fundamentals === "object") ? Fundamentals.get(item.s) : null; }
    catch (err) { /* ohne Datei einfach kein CAPE */ }
    const erg = cpRechne(lang, bench.reihe, rf.wert, roh, fund, faktoren, item.s, quer);
    cpScoreDazu(erg, roh, fund, cpGewichte());
    cpStand = { erg, bench, rf, lang, item, roh, fund };
    cpZeige(out, erg, bench, rf, lang, item);
    cpScoreVerdrahten(out, cpNeuZeichnen);
  } catch (e) {
    out.className = "";
    out.innerHTML = `<p class="cp-leer">Das Cockpit ließ sich nicht rechnen:
      ${typeof esc === "function" ? esc(e.message) : e.message}</p>`;
  }
}
