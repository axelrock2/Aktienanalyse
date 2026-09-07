#!/usr/bin/env node
"use strict";
/* =====================================================================
   Misst nach, was in elliott.js als EL_BEFUND steht.

   Das Modul behauptet in der Oberflaeche, eine Wellenzaehlung sage nichts
   ueber die folgenden Kurse. Eine solche Behauptung darf nicht nur
   dastehen - sie muss nachrechenbar sein. Dieses Skript rechnet sie nach.

   Geprueft wird der AUSGELIEFERTE Code: elliott.js wird bis zum
   Darstellungsteil geladen und ausgefuehrt. Eine Nacherzaehlung des
   Verfahrens im Pruefskript wuerde am Ende sich selbst bestaetigen.

   Drei Fragen, drei Messungen:

   1. Unterscheiden sich die Wellenverhaeltnisse echter Kurse von denen auf
      Surrogatreihen?  -> Kolmogorov-Smirnov je Beziehung.
      Die Surrogate entstehen im stationaeren Bootstrap (Politis & Romano
      1994) aus den Log-Renditen desselben Titels: Randverteilung und
      Volatilitaetscluster bleiben, nur die Abfolge faellt weg. Die mittlere
      Blocklaenge schaetzt die Regel von Politis & White (2004).

   2. Trennt das Zusammenspiel aller Verhaeltnisse, wenn ein einzelnes es
      nicht tut?  -> Logistische Regression, auf der einen Haelfte der Titel
      gelernt, auf der anderen geprueft.

   3. Sagt eine aktuelle Zaehlung etwas ueber die naechsten Wochen?
      -> Bedingte gegen unbedingte Renditeverteilung nach Lo, Mamaysky &
      Wang (2000), streng ohne Blick nach vorn, mit einem Bootstrap ueber
      Titel gegen die Abhaengigkeit ueberlappender Fenster.

   Aufruf (dauert einige Minuten, laedt beim ersten Mal die Kurse):
       node scripts/elliott_befund.js
   ===================================================================== */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const WURZEL = path.resolve(__dirname, "..");
const KORB = path.join(WURZEL, "scripts", "chancen_watchlist.txt");
const CACHE = path.join(os.tmpdir(), "ak-elliott-kurse");

/** Fenster, mit dem die Seite arbeitet: zwei Jahre Tagesdaten. */
const FENSTER = 500;
/** Surrogate je Titel fuer die Verteilungsvergleiche. */
const SURROGATE = 30;
/** Abstand der Pruefzeitpunkte im Vorwaertstest, in Handelstagen. */
const SCHRITT = 5;
const HORIZONT = 20;
/** Rueckblick fuer die Kontrollgroesse "juengste Bewegung", in Handelstagen. */
const RUECK = 60;
/** So viele Klassen der juengsten Bewegung werden getrennt verglichen. */
const KLASSEN = 10;

/* ---------------------------------------------------------------------
   Den ausgelieferten Rechenteil laden
   --------------------------------------------------------------------- */
function ladeModul() {
  const quelle = fs.readFileSync(path.join(WURZEL, "elliott.js"), "utf8");
  const marke = "/* =====================================================================\n   Darstellung";
  const schnitt = quelle.indexOf(marke);
  const ctx = { console, Math, Date, JSON, isFinite, Array, Number, String, Map, Set, Infinity };
  vm.createContext(ctx);
  vm.runInContext((schnitt > 0 ? quelle.slice(0, schnitt) : quelle)
    + "\nglobalThis.__ex = { elSuche, elAnalysiere, elSigma, elFrist, EL_EBENEN };", ctx);
  return ctx.__ex;
}

/* ---------------------------------------------------------------------
   Kurse
   --------------------------------------------------------------------- */
const schlaf = ms => new Promise(r => setTimeout(r, ms));

function korb() {
  return fs.readFileSync(KORB, "utf8").split("\n").map(z => z.trim())
    .filter(z => z && !z.startsWith("#")).map(z => z.split(/\s+/)[0]);
}

async function hole(sym) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(sym) + "?range=10y&interval=1d";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error("leer");
  const q = r.indicators.quote[0] || {};
  const t = [], c = [], h = [], l = [];
  r.timestamp.forEach((ts, i) => {
    const cc = q.close[i], hh = q.high[i], ll = q.low[i];
    if (cc == null || hh == null || ll == null) return;
    if (!isFinite(cc) || !isFinite(hh) || !isFinite(ll) || cc <= 0) return;
    t.push(ts * 1000); c.push(cc); h.push(hh); l.push(ll);
  });
  return { sym, t, c, h, l };
}

async function reihen() {
  fs.mkdirSync(CACHE, { recursive: true });
  const aus = [];
  for (const sym of korb()) {
    const datei = path.join(CACHE, sym.replace(/[^A-Za-z0-9._-]/g, "_") + ".json");
    if (fs.existsSync(datei)) { aus.push(JSON.parse(fs.readFileSync(datei, "utf8"))); continue; }
    try {
      const d = await hole(sym);
      if (d.c.length >= FENSTER + 200) { fs.writeFileSync(datei, JSON.stringify(d)); aus.push(d); }
    } catch (e) { console.error(`  ${sym}: ${e.message}`); }
    await schlaf(180);
  }
  return aus.filter(r => r.c.length >= FENSTER + 200);
}

/* ---------------------------------------------------------------------
   Werkzeug
   --------------------------------------------------------------------- */
const fenster = (r, ende, n) => ({
  sym: r.sym, t: r.t.slice(Math.max(0, ende - n), ende), c: r.c.slice(Math.max(0, ende - n), ende),
  h: r.h.slice(Math.max(0, ende - n), ende), l: r.l.slice(Math.max(0, ende - n), ende) });

function zufall(saat) {
  let s = (saat >>> 0) || 2463534242;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * Mittlere Blocklaenge nach Politis & White (2004) in der von Patton,
 * Politis & White (2009) korrigierten Fassung, gerechnet auf den
 * QUADRIERTEN Renditen: Die Renditen selbst sind praktisch unkorreliert, die
 * Regel gaebe b ~ 1 und der Bootstrap wuerde die Volatilitaetscluster
 * zerstoeren - also genau die Abhaengigkeit, die erhalten bleiben muss.
 */
function blockLaenge(c) {
  const r = []; for (let i = 1; i < c.length; i++) r.push(Math.log(c[i] / c[i - 1]));
  const x = r.map(v => v * v), n = x.length;
  if (n < 60) return 10;
  const m = x.reduce((a, b) => a + b, 0) / n;
  const z = x.map(v => v - m);
  const R = k => { let s = 0; for (let i = 0; i + k < n; i++) s += z[i] * z[i + k]; return s / n; };
  const R0 = R(0); if (!(R0 > 0)) return 10;
  const band = 2 * Math.sqrt(Math.log10(n) / n);
  const K = Math.max(5, Math.round(Math.sqrt(Math.log10(n))));
  const maxLag = Math.min(Math.floor(n / 4), 200);
  const rho = [0]; for (let k = 1; k <= maxLag; k++) rho[k] = R(k) / R0;
  let mHut = 1;
  for (let k = 1; k + K <= maxLag; k++) {
    let klein = true;
    for (let j = 1; j <= K; j++) if (Math.abs(rho[k + j]) >= band) { klein = false; break; }
    mHut = k; if (klein) break;
  }
  const M = Math.min(2 * mHut, maxLag);
  const lam = t => { const a = Math.abs(t); return a <= 0.5 ? 1 : (a <= 1 ? 2 * (1 - a) : 0); };
  let G = 0, g0 = R0;
  for (let k = 1; k <= M; k++) { const w = lam(k / M), Rk = R(k); G += 2 * w * k * Rk; g0 += 2 * w * Rk; }
  const D = 2 * g0 * g0;
  if (!(D > 0) || !(Math.abs(G) > 0)) return 10;
  const b = Math.cbrt(2 * G * G / D) * Math.cbrt(n);
  if (!isFinite(b) || b <= 0) return 10;
  return Math.max(3, Math.min(Math.round(b), Math.round(4 * Math.cbrt(n))));
}

/** Stationaerer Bootstrap: geometrisch verteilte Blocklaengen mit Mittel b. */
function surrogat(reihe, rnd, b) {
  const n = reihe.c.length;
  const ret = [], oben = [], unten = [];
  for (let i = 1; i < n; i++) ret.push(Math.log(reihe.c[i] / reihe.c[i - 1]));
  for (let i = 0; i < n; i++) {
    oben.push((reihe.h[i] - reihe.c[i]) / reihe.c[i]);
    unten.push((reihe.c[i] - reihe.l[i]) / reihe.c[i]);
  }
  const m = ret.length; if (m < 30) return null;
  const p = 1 / Math.max(2, b), neu = new Array(m);
  let i = Math.floor(rnd() * m);
  for (let k = 0; k < m; k++) {
    if (k > 0 && rnd() < p) i = Math.floor(rnd() * m);
    neu[k] = ret[i]; i = (i + 1) % m;
  }
  const c = [reihe.c[0]], h = [reihe.h[0]], l = [reihe.l[0]];
  for (let k = 1; k < n; k++) {
    const preis = c[k - 1] * Math.exp(neu[k - 1]);
    c.push(preis);
    const j = Math.floor(rnd() * n);
    h.push(preis * (1 + Math.abs(oben[j]))); l.push(preis * (1 - Math.abs(unten[j])));
  }
  return { sym: reihe.sym, t: reihe.t, c, h, l };
}

/** Zweistichproben-Kolmogorov-Smirnov. Kritischer Wert bei 5 %: 1,36. */
function ks(a, b) {
  const A = a.slice().sort((x, y) => x - y), B = b.slice().sort((x, y) => x - y);
  let i = 0, j = 0, d = 0;
  while (i < A.length && j < B.length) {
    const v = Math.min(A[i], B[j]);
    while (i < A.length && A[i] <= v) i++;
    while (j < B.length && B[j] <= v) j++;
    d = Math.max(d, Math.abs(i / A.length - j / B.length));
  }
  return d * Math.sqrt(A.length * B.length / (A.length + B.length));
}
function auc(a, b) {
  let g = 0, t = 0;
  for (const x of a) for (const y of b) { if (x > y) g++; else if (x === y) t++; }
  return (g + 0.5 * t) / (a.length * b.length);
}
const mittel = a => a.reduce((x, y) => x + y, 0) / a.length;
const median = a => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };

/* =====================================================================
   Hauptlauf
   ===================================================================== */
(async () => {
  const M = ladeModul();
  console.error("Kurse laden …");
  const rs = await reihen();
  console.error(`${rs.length} Titel, Median ${median(rs.map(r => r.c.length))} Kerzen.\n`);

  /* --- 1. Verteilung der Wellenverhaeltnisse --- */
  console.error("1/3  Wellenverhältnisse echt gegen Zufall …");
  const echt = {}, zuf = {};
  const holeRel = (reihe, topf) => {
    const s = M.elSuche(reihe);
    for (const k of (s.kandidaten || [])) {
      for (const r of k.relationen) (topf[r.name] = topf[r.name] || []).push(Math.log(r.r));
    }
  };
  rs.forEach((r, i) => {
    const f = fenster(r, r.c.length, FENSTER);
    holeRel(f, echt);
    const b = blockLaenge(f.c), rnd = zufall(1000 + i);
    for (let m = 0; m < SURROGATE; m++) { const s = surrogat(f, rnd, b); if (s) holeRel(s, zuf); }
  });
  let ksMax = 0;
  console.error("\n  Beziehung                n echt  n zufall   Median echt / zufall   KS");
  for (const name of Object.keys(echt)) {
    const a = echt[name], b = zuf[name] || [];
    if (a.length < 20 || b.length < 20) continue;
    const w = ks(a, b); ksMax = Math.max(ksMax, w);
    console.error(`  ${name.padEnd(22)} ${String(a.length).padStart(6)} ${String(b.length).padStart(9)}`
      + `   ${Math.exp(median(a)).toFixed(3)} / ${Math.exp(median(b)).toFixed(3)}`
      + `          ${w.toFixed(2)}`);
  }
  console.error(`  groesster KS-Wert ${ksMax.toFixed(2)}, kritisch bei 5 % ist 1,36\n`);

  /* --- 2. Mehrdimensional, mit Trennung von Lernen und Pruefen --- */
  console.error("2/3  Klassifikator über alle Verhältnisse …");
  const vektoren = (liste, saat) => {
    const X = [], y = [];
    liste.forEach((r, i) => {
      const f = fenster(r, r.c.length, FENSTER);
      const nimm = (reihe, label) => {
        for (const k of (M.elSuche(reihe).kandidaten || [])) {
          const m = {}; k.relationen.forEach(x => { m[x.name] = Math.log(x.r); });
          const a = m["Welle 2 / Welle 1"], b = m["Welle 3 / Welle 1"], c = m["Welle 4 / Welle 3"];
          if (a == null || b == null || c == null) continue;
          const d = m["Welle 5 / Welle 1"], e = m["Welle 5 / Welle 1–3"];
          X.push([a, b, c, d ?? 0, e ?? 0, d == null ? 0 : 1, Math.abs(a - c)]); y.push(label);
        }
      };
      nimm(f, 1);
      const bl = blockLaenge(f.c), rnd = zufall(saat + i);
      for (let m = 0; m < 20; m++) { const s = surrogat(f, rnd, bl); if (s) nimm(s, 0); }
    });
    return { X, y };
  };
  const A = vektoren(rs.filter((_, i) => i % 2 === 0), 4242);
  const B = vektoren(rs.filter((_, i) => i % 2 === 1), 8484);
  const lerne = (X, y) => {
    const d = X[0].length, w = new Array(d).fill(0); let b0 = 0;
    const pos = y.filter(v => v === 1).length, gp = (y.length - pos) / Math.max(1, pos);
    for (let s = 0; s < 4000; s++) {
      const gw = new Array(d).fill(0); let gb = 0;
      for (let i = 0; i < X.length; i++) {
        let z = b0; for (let j = 0; j < d; j++) z += w[j] * X[i][j];
        const e = (y[i] === 1 ? gp : 1) * (1 / (1 + Math.exp(-z)) - y[i]);
        for (let j = 0; j < d; j++) gw[j] += e * X[i][j];
        gb += e;
      }
      for (let j = 0; j < d; j++) w[j] -= 0.3 * gw[j] / X.length;
      b0 -= 0.3 * gb / X.length;
    }
    return { w, b0 };
  };
  const punkte = (m, X) => X.map(x => x.reduce((z, v, j) => z + m.w[j] * v, m.b0));
  const modell = lerne(A.X, A.y);
  const sA = punkte(modell, A.X), sB = punkte(modell, B.X);
  const aucInnen = auc(sA.filter((_, i) => A.y[i] === 1), sA.filter((_, i) => A.y[i] === 0));
  const aucAussen = auc(sB.filter((_, i) => B.y[i] === 1), sB.filter((_, i) => B.y[i] === 0));
  console.error(`  auf den Lerndaten ${aucInnen.toFixed(3)}, auf ungesehenen Titeln ${aucAussen.toFixed(3)}\n`);

  /* --- 3. Vorwaertstest --- */
  console.error("3/3  Rendite nach einer aktuellen Zählung …");
  const proTitel = [];
  let stellen = 0, mitZaehlung = 0;
  rs.forEach((r, ri) => {
    const N = r.c.length;
    const v = []; for (let i = 0; i + HORIZONT < N; i++) v.push(Math.log(r.c[i + HORIZONT] / r.c[i]));
    const mu = mittel(v);
    const sd = Math.sqrt(v.reduce((a, b) => a + (b - mu) * (b - mu), 0) / v.length) || 1;
    const e = { bedingt: [], unbedingt: [], vorher: [], lage: {}, lageVor: {} };
    for (let T = Math.max(FENSTER, RUECK + 1); T + HORIZONT < N; T += SCHRITT) {
      const f = fenster(r, T, FENSTER);
      /* Streng ohne Blick nach vorn: Die Zaehlung sieht nur Kerzen bis T-1,
         die Rendite beginnt am Schluss von T-1. */
      const z = (Math.log(r.c[T - 1 + HORIZONT] / r.c[T - 1]) - mu) / sd;
      /* Die juengste Bewegung als Kontrollgroesse: Eine Aufwaertszaehlung
         bedeutet zwangslaeufig, dass der Kurs gestiegen ist. Ohne diese
         Kontrolle misst man den Rueckschlag auf den Anstieg und nennt ihn
         Wellenwissen. */
      const vor = Math.log(r.c[T - 1] / r.c[T - 1 - RUECK]);
      e.unbedingt.push(z); e.vorher.push(vor); stellen++;
      const s = M.elSuche(f);
      if (s.ok && s.aktuelle && s.aktuelle.length) {
        e.bedingt.push(z); mitZaehlung++;
        const k = s.aktuelle[0];
        const key = (k.vollstaendig ? "impuls_fertig_" : "welle5_laeuft_") + (k.auf ? "auf" : "ab");
        (e.lage[key] = e.lage[key] || []).push(z);
        (e.lageVor[key] = e.lageVor[key] || []).push(vor);
      }
    }
    proTitel.push(e);
    if ((ri + 1) % 25 === 0) console.error(`  ${ri + 1}/${rs.length}`);
  });
  const diffVon = liste => {
    const a = [], b = [];
    for (const t of liste) { a.push(...t.bedingt); b.push(...t.unbedingt); }
    return a.length ? mittel(a) - mittel(b) : NaN;
  };
  /* Bootstrap ueber TITEL: Die Fenster eines Titels ueberlappen und beschreiben
     dieselbe Bewegung mehrfach. Wer ueber Einzelbeobachtungen zieht, haelt sie
     faelschlich fuer unabhaengig und bekommt viel zu enge Baender. */
  const rnd = zufall(2024), band = [];
  for (let z = 0; z < 4000; z++) {
    const zieh = [];
    for (let i = 0; i < proTitel.length; i++) zieh.push(proTitel[Math.floor(rnd() * proTitel.length)]);
    const d = diffVon(zieh); if (isFinite(d)) band.push(d);
  }
  band.sort((a, b) => a - b);
  const diff = diffVon(proTitel);
  const lo = band[Math.floor(0.025 * band.length)], hi = band[Math.floor(0.975 * band.length)];
  const n = proTitel.reduce((a, t) => a + t.bedingt.length, 0);
  console.error(`  ${stellen} Zeitpunkte, ${mitZaehlung} mit aktueller Zählung `
    + `(${(100 * mitZaehlung / stellen).toFixed(1)} %)`);
  console.error(`  Differenz ${diff.toFixed(3)} Standardabweichungen, 95 %: [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);

  /* Nach Lage getrennt. Der Gesamtwert wirft Aufwaerts- und Abwaertszaehlungen
     zusammen; faellt er in beiden Richtungen gleich aus, steckt darin kein
     Richtungswissen, sondern nur "es gab kuerzlich eine Wende". Die vier
     Richtungen stehen VORHER fest, aus der Theorie:
       Impuls fertig aufwaerts -> Rendite unter dem Schnitt (Korrektur folgt)
       Impuls fertig abwaerts  -> Rendite ueber dem Schnitt
       Welle 5 laeuft aufwaerts -> Rendite ueber dem Schnitt (Trend haelt)
       Welle 5 laeuft abwaerts  -> Rendite unter dem Schnitt
     Vier einseitige Tests, danach nach Holm korrigiert. */
  const ERWARTUNG = { impuls_fertig_auf: -1, impuls_fertig_ab: +1,
                      welle5_laeuft_auf: +1, welle5_laeuft_ab: -1 };
  const diffLage = (liste, key) => {
    const a = [], b = [];
    for (const t of liste) { if (t.lage[key]) a.push(...t.lage[key]); b.push(...t.unbedingt); }
    return a.length ? mittel(a) - mittel(b) : NaN;
  };
  console.error("\n  Lage                       n    Differenz z   95%-Band            p einseitig");
  const rohP = [], zeilen = [];
  for (const key of Object.keys(ERWARTUNG)) {
    const nn = proTitel.reduce((a, t) => a + (t.lage[key] ? t.lage[key].length : 0), 0);
    if (nn < 50) { zeilen.push({ key, nn, text: "zu wenig Fälle" }); rohP.push(1); continue; }
    const rnd2 = zufall(555), w = [];
    for (let z = 0; z < 4000; z++) {
      const zieh = [];
      for (let i = 0; i < proTitel.length; i++) zieh.push(proTitel[Math.floor(rnd2() * proTitel.length)]);
      const d2 = diffLage(zieh, key); if (isFinite(d2)) w.push(d2);
    }
    w.sort((a, b) => a - b);
    const d2 = diffLage(proTitel, key);
    const gegen = w.filter(v => ERWARTUNG[key] > 0 ? v <= 0 : v >= 0).length;
    const pv = (1 + gegen) / (w.length + 1);
    zeilen.push({ key, nn, d: d2, lo: w[Math.floor(0.025 * w.length)], hi: w[Math.floor(0.975 * w.length)], p: pv });
    rohP.push(pv);
  }
  const holm = ps => {
    const idx = ps.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const out = new Array(ps.length); let max = 0;
    idx.forEach(([v, i], r) => { max = Math.max(max, Math.min(1, (ps.length - r) * v)); out[i] = max; });
    return out;
  };
  const adj = holm(rohP);
  let bestesAdj = 1;
  zeilen.forEach((z, i) => {
    if (z.text) { console.error(`  ${z.key.padEnd(20)} ${String(z.nn).padStart(6)}    ${z.text}`); return; }
    bestesAdj = Math.min(bestesAdj, adj[i]);
    console.error(`  ${z.key.padEnd(20)} ${String(z.nn).padStart(6)}   ${z.d.toFixed(3).padStart(10)}   `
      + `[${z.lo.toFixed(3)}, ${z.hi.toFixed(3)}]${" ".repeat(Math.max(0, 8 - z.lo.toFixed(3).length))}`
      + `   ${z.p.toFixed(3)} -> Holm ${adj[i].toFixed(3)}${adj[i] < 0.05 ? " *" : ""}`);
  });
  console.error(`  kleinster korrigierter p-Wert: ${bestesAdj.toFixed(3)}`);

  /* --- Dieselbe Rechnung, aber gegen VERGLEICHBARE Zeitpunkte ---
     Verglichen wird nur noch innerhalb derselben Klasse der juengsten
     60-Tage-Bewegung. Bleibt der Unterschied bestehen, sagt die Zaehlung
     etwas ueber die Zaehlung. Verschwindet er, sagte sie nur, dass der Kurs
     gestiegen oder gefallen ist - und das steht ohne Wellen im Chart. */
  function klassen(vorher) {
    const s2 = vorher.slice().sort((a, b) => a - b);
    const g = [];
    for (let i = 1; i < KLASSEN; i++) g.push(s2[Math.floor(i * s2.length / KLASSEN)]);
    return g;
  }
  function klasse(g, v) { let i = 0; while (i < g.length && v > g[i]) i++; return i; }
  function diffGepaart(liste, key) {
    const summeZ = new Array(KLASSEN).fill(0), zahlZ = new Array(KLASSEN).fill(0);
    const summeU = new Array(KLASSEN).fill(0), zahlU = new Array(KLASSEN).fill(0);
    for (const t of liste) {
      if (!t.grenzen) continue;
      const a = t.lage[key], av = t.lageVor[key];
      for (let i = 0; i < t.unbedingt.length; i++) {
        const c = klasse(t.grenzen, t.vorher[i]);
        summeU[c] += t.unbedingt[i]; zahlU[c]++;
      }
      if (!a) continue;
      for (let i = 0; i < a.length; i++) {
        const c = klasse(t.grenzen, av[i]);
        summeZ[c] += a[i]; zahlZ[c]++;
      }
    }
    let gewicht = 0, summe = 0;
    for (let c = 0; c < KLASSEN; c++) {
      if (!zahlZ[c] || !zahlU[c]) continue;
      summe += zahlZ[c] * (summeZ[c] / zahlZ[c] - summeU[c] / zahlU[c]);
      gewicht += zahlZ[c];
    }
    return gewicht ? summe / gewicht : NaN;
  }
  proTitel.forEach(t => { t.grenzen = t.vorher.length >= KLASSEN * 3 ? klassen(t.vorher) : null; });
  console.error("\n  Dasselbe, verglichen nur mit Zeitpunkten gleicher Vorbewegung:");
  console.error("  Lage                       n    Differenz z   95%-Band");
  const gepaart = {};
  for (const key of Object.keys(ERWARTUNG)) {
    const nn = proTitel.reduce((a, t) => a + (t.lage[key] ? t.lage[key].length : 0), 0);
    if (nn < 50) continue;
    const rnd3 = zufall(777), w3 = [];
    for (let z = 0; z < 2000; z++) {
      const zieh = [];
      for (let i = 0; i < proTitel.length; i++) zieh.push(proTitel[Math.floor(rnd3() * proTitel.length)]);
      const d3 = diffGepaart(zieh, key); if (isFinite(d3)) w3.push(d3);
    }
    w3.sort((a, b) => a - b);
    const d3 = diffGepaart(proTitel, key);
    gepaart[key] = { d: d3, lo: w3[Math.floor(0.025 * w3.length)], hi: w3[Math.floor(0.975 * w3.length)] };
    console.error(`  ${key.padEnd(20)} ${String(nn).padStart(6)}   ${d3.toFixed(3).padStart(10)}   `
      + `[${gepaart[key].lo.toFixed(3)}, ${gepaart[key].hi.toFixed(3)}]`);
  }
  const groesst = Object.values(gepaart).reduce((a, x) => Math.max(a, Math.abs(x.d)), 0);
  console.error(`  groesster Betrag nach Kontrolle: ${groesst.toFixed(3)}\n`);

  console.log("/* Aus scripts/elliott_befund.js, Stand " + new Date().toISOString().slice(0, 10) + " */");
  console.log("const EL_BEFUND = {");
  console.log(`  titel: ${rs.length}, jahre: 10, kerzen: ${FENSTER}, zeitpunkte: ${stellen},`);
  console.log(`  ksMax: ${ksMax.toFixed(2)}, ksKritisch: 1.36,`);
  console.log(`  aucInnen: ${aucInnen.toFixed(3)}, aucAussen: ${aucAussen.toFixed(3)},`);
  console.log(`  vw: { n: ${n}, diff: ${diff.toFixed(3)}, lo: ${lo.toFixed(3)}, hi: ${hi.toFixed(3)}, tage: ${HORIZONT} },`);
  console.log(`  anteilAktuell: ${(mitZaehlung / stellen).toFixed(3)},`);
  console.log(`  holm: ${bestesAdj.toFixed(3)},`);
  console.log(`  gepaartMax: ${groesst.toFixed(3)},`);
  console.log("};");
})();
