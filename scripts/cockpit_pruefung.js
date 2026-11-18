#!/usr/bin/env node
"use strict";
/* =====================================================================
   Prueft die Rechenfunktionen des Analyse-Cockpits an echten Kursen.

   Geladen wird der AUSGELIEFERTE Code: config.js und der Rechenteil von
   cockpit.js werden ausgefuehrt, nicht nachgebaut. Eine Nacherzaehlung im
   Pruefskript wuerde am Ende sich selbst bestaetigen.

   Geprueft wird dreierlei:
     1. Rechnen die Funktionen ueberhaupt, ueber verschiedene Boersen hinweg?
     2. Liegen die Ergebnisse in plausiblen Bereichen?
     3. Stimmen die Schwellen in config.js noch zu dem, was die Daten zeigen?
        Eine Schwelle, die bei keinem Titel ausloest, ist eine tote Zeile;
        eine, die bei jedem ausloest, sagt nichts.

   Aufruf (laedt beim ersten Mal die Kurse):
       node scripts/cockpit_pruefung.js
   ===================================================================== */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const WURZEL = path.resolve(__dirname, "..");
const CACHE = path.join(os.tmpdir(), "ak-cockpit-kurse");

/** Titel quer ueber Boersen, Branchen und Schwankungsbreiten. */
const PROBEN = [
  ["AAPL", "^GSPC"], ["KO", "^GSPC"], ["NVDA", "^GSPC"], ["JPM", "^GSPC"],
  ["XOM", "^GSPC"], ["TSLA", "^GSPC"], ["PLTR", "^GSPC"], ["MSTR", "^GSPC"],
  ["SAP.DE", "^GDAXI"], ["BMW.DE", "^GDAXI"], ["ASML.AS", "^STOXX"],
  ["7203.T", "^N225"], ["0700.HK", "^HSI"],
];

/* ---------------------------------------------------------------------
   Den ausgelieferten Rechenteil laden
   --------------------------------------------------------------------- */
function ladeModul() {
  const ctx = { console, Math, Date, JSON, isFinite, Array, Number, String, Map, Set, Infinity };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(WURZEL, "config.js"), "utf8"), ctx);
  /* dsAtr steht in app.js und wird von cpVerhalten benutzt. Hier dieselbe
     Rechnung, damit das Skript ohne das Dokument auskommt. */
  vm.runInContext(`
    function dsMean(a){return a.reduce((x,y)=>x+y,0)/a.length;}
    function dsAtr(h,l,c,n=14){if(c.length<n+1)return null;const tr=[];
      for(let i=1;i<c.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));
      return dsMean(tr.slice(-n));}
  `, ctx);
  const quelle = fs.readFileSync(path.join(WURZEL, "cockpit.js"), "utf8");
  const marke = "/* =====================================================================\n   Oberflaeche";
  const schnitt = quelle.indexOf(marke);
  vm.runInContext((schnitt > 0 ? quelle.slice(0, schnitt) : quelle)
    + "\nglobalThis.__ex = { cpRisiko, cpCapm, cpMomentum, cpVerhalten, cpVola,"
    + " cpDrawdown, cpSchiefe, cpRegression, cpPaare, cpMonatsende, cpCape, cpOls, cpFaktorRegression, cpProfil, cpRang, cpRegionWahl, cpPortfolio, cpQuerRang, AK_CONFIG };", ctx);
  return ctx.__ex;
}

/* ---------------------------------------------------------------------
   Kurse
   --------------------------------------------------------------------- */
const schlaf = ms => new Promise(r => setTimeout(r, ms));

async function hole(sym) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(sym) + "?range=5y&interval=1d";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  const r = j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error("keine Kursdaten");
  const q = r.indicators.quote[0] || {};
  const o = { meta: r.meta || {}, t: [], c: [], h: [], l: [] };
  r.timestamp.forEach((ts, i) => {
    const c = q.close ? q.close[i] : null;
    if (c == null || !isFinite(c) || c <= 0) return;
    o.t.push(ts * 1000); o.c.push(c);
    o.h.push(q.high && isFinite(q.high[i]) ? q.high[i] : c);
    o.l.push(q.low && isFinite(q.low[i]) ? q.low[i] : c);
  });
  return o;
}

async function reihe(sym) {
  fs.mkdirSync(CACHE, { recursive: true });
  const datei = path.join(CACHE, sym.replace(/[^A-Za-z0-9.^_-]/g, "_") + ".json");
  if (fs.existsSync(datei)) return JSON.parse(fs.readFileSync(datei, "utf8"));
  const d = await hole(sym);
  fs.writeFileSync(datei, JSON.stringify(d));
  await schlaf(200);
  return d;
}

/* ---------------------------------------------------------------------
   Hauptlauf
   --------------------------------------------------------------------- */
const P = (v, d = 1) => v == null || !isFinite(v) ? "   –  "
  : ((v * 100).toFixed(d) + "%").padStart(7);
const Z = (v, d = 2) => v == null || !isFinite(v) ? "  – " : v.toFixed(d).padStart(6);

(async () => {
  const M = ladeModul();
  console.error("Kurse laden …");
  const rfReihe = await reihe(AKsym(M));
  const rf = rfReihe.c[rfReihe.c.length - 1] / 100;
  console.error(`Risikofreier Zins aus ${M.AK_CONFIG.capm.rfSymbol}: ${(rf * 100).toFixed(2)} %\n`);

  /* Eine Sammlung fuer alle Pruefungen, damit der Rueckgabewert des Skripts
     am Ende wirklich "alles bestanden" bedeutet. */
  const pruef = [];
  const sagePruefung = (txt, gut) => { pruef.push(gut); console.log(`  ${gut ? "ok  " : "FEHL"}  ${txt}`); };

  const zeilen = [];
  for (const [sym, bsym] of PROBEN) {
    let ch, be;
    try { ch = await reihe(sym); be = await reihe(bsym); }
    catch (e) { console.error(`  ${sym}: ${e.message}`); continue; }
    const r = M.cpRisiko(ch, be);
    const cm = M.cpCapm(ch, be, rf, r.volaKurz);
    const mo = M.cpMomentum(ch, be);
    const ve = M.cpVerhalten(ch);
    zeilen.push({ sym, bsym, r, cm, mo, ve });
  }

  console.log("Modul 1 – Risiko (Markowitz)");
  console.log("Titel      Bench      Vola1J   Vola3J    MaxDD   erholt   Korr   Monate");
  for (const z of zeilen) {
    const dd = z.r.drawdown;
    console.log(`${z.sym.padEnd(10)} ${z.bsym.padEnd(9)} ${P(z.r.volaKurz)} ${P(z.r.volaLang)}`
      + ` ${P(dd && dd.tiefe)}  ${(dd && dd.erholt ? "ja" : "nein").padStart(5)}  ${Z(z.r.korr)}`
      + `   ${String(z.r.korrN ?? "–").padStart(5)}`);
  }

  console.log("\nModul 2 – CAPM (Sharpe)");
  console.log("Titel        Beta   adj.    R²   EK-Kosten  Alpha p.a.   t(α)  Sharpe   Einordnung");
  for (const z of zeilen) {
    if (z.cm.grund) { console.log(`${z.sym.padEnd(11)} ${z.cm.grund}`); continue; }
    console.log(`${z.sym.padEnd(11)}${Z(z.cm.beta)} ${Z(z.cm.betaAdj)} ${Z(z.cm.r2)}`
      + `   ${P(z.cm.ekKosten)}   ${P(z.cm.alphaJahr)}  ${Z(z.cm.tAlpha, 1)}  ${Z(z.cm.sharpe)}`
      + `   ${z.cm.stufe}${z.cm.alphaSignifikant ? "  ALPHA SIGNIFIKANT" : ""}`);
  }

  console.log("\nModul 4 – Momentum (Jegadeesh & Titman)");
  console.log("Titel       12-1     6-1      3M    je Risiko  relativ   36M    Umkehr");
  for (const z of zeilen) {
    const f = z.mo.fenster;
    console.log(`${z.sym.padEnd(10)}${P(f[0].rendite)} ${P(f[1].rendite)} ${P(f[2].rendite)}`
      + `    ${Z(z.mo.proRisiko)}  ${P(z.mo.relativ)} ${P(z.mo.umkehr && z.mo.umkehr.rendite)}`
      + `  ${z.mo.umkehr && z.mo.umkehr.warnung ? "JA" : "–"}`);
  }

  console.log("\nModul 8 – Verhalten (Kahneman & Tversky)");
  console.log("Titel      Schiefe   Vola    Hinweise");
  for (const z of zeilen) {
    console.log(`${z.sym.padEnd(10)}${Z(z.ve.schiefe)} ${P(z.ve.vola)}    `
      + (z.ve.flags.map(f => f.titel).join(" · ") || "keine"));
  }

  /* --- Schwellenpruefung ---
     Eine Schwelle muss trennen. Loest sie nie aus, ist sie eine tote Zeile;
     loest sie bei allen aus, sagt sie nichts. Beides faellt hier auf. */
  console.log("\nSchwellen aus config.js – trennen sie?");
  const n = zeilen.length;
  const anteil = (name, treffer) => {
    const p = Math.round(100 * treffer / n);
    const urteil = treffer === 0 ? "LÖST NIE AUS" : treffer === n ? "LÖST IMMER AUS" : "trennt";
    console.log(`  ${name.padEnd(34)} ${String(treffer).padStart(2)}/${n}  (${String(p).padStart(3)} %)  ${urteil}`);
    return treffer > 0 && treffer < n;
  };
  let ok = true;
  ok &= anteil("Lotterie-Profil", zeilen.filter(z => z.ve.flags.some(f => f.art === "lotterie")).length);
  ok &= anteil("Nahe am 52-Wochen-Hoch", zeilen.filter(z => z.ve.flags.some(f => f.art === "anker")).length);
  ok &= anteil("Starke Kursreaktion", zeilen.filter(z => z.ve.flags.some(f => f.art === "sprung")).length);
  ok &= anteil("Umkehrrisiko (36 Monate)", zeilen.filter(z => z.mo.umkehr && z.mo.umkehr.warnung).length);
  ok &= anteil("Beta < 0,8 (defensiv)", zeilen.filter(z => !z.cm.grund && z.cm.stufe === "defensiv").length);
  ok &= anteil("Beta > 1,2 (offensiv)", zeilen.filter(z => !z.cm.grund && z.cm.stufe === "offensiv").length);

  /* --- Modul 7: zyklusbereinigtes KGV ---
     Gerechnet gegen data/fundamentals.json, also gegen das, was die GitHub
     Action tatsaechlich schreibt. Fehlt die Datei oder der Block, sagt das
     Skript das, statt die Pruefung still zu ueberspringen. */
  const fundDatei = path.join(WURZEL, "data", "fundamentals.json");
  console.log("\nModul 7 – Zyklusbereinigtes KGV (Shiller)");
  if (!fs.existsSync(fundDatei)) {
    console.log("  data/fundamentals.json fehlt – übersprungen.");
  } else {
    const daten = (JSON.parse(fs.readFileSync(fundDatei, "utf8")) || {}).data || {};
    const mitCape = Object.entries(daten).filter(([, e]) => e && e.cape);
    if (!mitCape.length) {
      console.log("  Kein Titel hat eine CAPE-Gewinnreihe. Lief build_fundamentals.js"
        + " seit der Umstellung schon? Sonst fehlt der Block noch.");
    } else {
      console.log("Titel      Jahre  vollst.  Verlustj.  Gewinn real Ø    CAPE   laufendes KGV");
      for (const [sym, e] of mitCape) {
        const mw = e.markt && e.markt.marketCap;
        const kgv = e.markt && e.markt.trailingPE;
        const c = M.cpCape(e.cape, mw, kgv);
        const mrd = (e.cape.gewinnRealMittel / 1e9).toFixed(2) + " Mrd";
        console.log(`${sym.padEnd(10)}${String(e.cape.jahre).padStart(4)}`
          + `${(e.cape.vollstaendig ? "  ja" : " nein").padStart(8)}`
          + `${String(e.cape.verlustjahre).padStart(9)}  ${mrd.padStart(13)}`
          + `  ${c ? Z(c.wert, 1) : "  – "}  ${c && c.kgv ? Z(c.kgv, 1) : "  – "}`
          + (c && c.lage ? "   " + c.lage : "  (ohne Marktwert kein CAPE)"));
      }
      sagePruefung("CAPE positiv, wo berechenbar",
        mitCape.every(([, e]) => {
          const c = M.cpCape(e.cape, e.markt && e.markt.marketCap, null);
          return c == null || c.wert > 0;
        }));
      sagePruefung("CAPE unter 500 (sonst steckt ein Einheitenfehler darin)",
        mitCape.every(([, e]) => {
          const c = M.cpCape(e.cape, e.markt && e.markt.marketCap, null);
          return c == null || c.wert < 500;
        }));
      sagePruefung("inflationsbereinigte Gewinne weichen von den nominalen ab",
        mitCape.some(([, e]) => e.cape.reihe.some(x => x.gewinn !== x.gewinnReal)));
    }
  }

  /* --- Module 3 und 5: Faktormodelle ---
     Zuerst die Mehrfachregression selbst, gegen eine Aufgabe mit bekannter
     Loesung. Eine Regression, die auf exakten Daten nicht exakt rechnet,
     braucht man auf echten gar nicht erst laufen zu lassen. */
  console.log("\nModul 3 und 5 – Faktormodelle");
  {
    const X = [], y = [];
    for (let i = 0; i < 40; i++) { const a = i % 7, b = (i * 3) % 5; X.push([a, b]); y.push(2 + 3 * a - b); }
    const r = M.cpOls(y, X);
    const genau = r && Math.abs(r.b[0] - 2) < 1e-9 && Math.abs(r.b[1] - 3) < 1e-9
      && Math.abs(r.b[2] + 1) < 1e-9 && Math.abs(r.r2 - 1) < 1e-9;
    sagePruefung("Regression löst y = 2 + 3·x₁ − x₂ exakt", !!genau);
    // Zwei identische Spalten: die Matrix ist singulaer, das muss auffallen
    sagePruefung("singuläre Matrix wird erkannt, nicht geraten",
      M.cpOls(y, X.map(z => [z[0], z[0]])) === null);
  }

  const fDatei = path.join(WURZEL, "data", "faktoren.json");
  if (!fs.existsSync(fDatei)) {
    console.log("  data/faktoren.json fehlt – build_faktoren.py noch nicht gelaufen.");
  } else {
    const F = JSON.parse(fs.readFileSync(fDatei, "utf8"));
    console.log(`  Faktordaten Stand ${F.stand}, Regionen ${Object.keys(F.regionen).join(", ")}`);
    console.log("\nTitel      Reg  Alpha p.a.   t(α)    MKT    SMB    HML    MOM   R²adj    n");
    const laeufe = [];
    for (const [sym] of PROBEN) {
      let ch; try { ch = await reihe(sym); } catch (e) { continue; }
      const region = M.cpRegionWahl(sym);
      const r = M.cpFaktorRegression(ch, F, region);
      if (r.grund) { console.log(`${sym.padEnd(11)}${String(region).padEnd(5)}${r.grund}`); continue; }
      laeufe.push({ sym, r });
      const c = r.carhart;
      console.log(`${sym.padEnd(11)}${r.region.padEnd(4)} ${P(c.alpha)} ${Z(c.tAlpha, 1)}  `
        + c.ladungen.map(l => Z(l.wert)).join(" ") + `  ${Z(c.r2adj)} ${String(c.n).padStart(4)}`
        + (Math.abs(c.tAlpha) > 2 ? "   ALPHA GESICHERT" : ""));
    }
    if (laeufe.length) {
      sagePruefung("alle Marktladungen zwischen −1 und 5",
        laeufe.every(x => { const b = x.r.carhart.ladungen[0].wert; return b > -1 && b < 5; }));
      sagePruefung("alle bereinigten R² zwischen 0 und 1",
        laeufe.every(x => x.r.carhart.r2adj >= 0 && x.r.carhart.r2adj <= 1));
      sagePruefung("jede Regression nutzt mindestens die geforderten Monate",
        laeufe.every(x => x.r.carhart.n >= M.AK_CONFIG.faktoren.minMonate));
      /* Das Fuenffaktorenmodell enthaelt das Vierfaktorenmodell. Sein ROHES R²
         kann deshalb nie kleiner sein - das bereinigte schon, und genau das
         ist der Grund, warum es bereinigt ausgewiesen wird. */
      sagePruefung("rohes R² steigt mit zwei weiteren Faktoren nie",
        laeufe.every(x => !x.r.ff5 || x.r.ff5.r2 >= x.r.carhart.r2 - 1e-9));
      const gesichert = laeufe.filter(x => Math.abs(x.r.carhart.tAlpha) > 2).length;
      console.log(`  ${gesichert} von ${laeufe.length} Titeln mit gesichertem Alpha`
        + " – bei reiner Streuung wären es etwa 5 %.");
    }

    /* Perzentilraenge: Randfaelle, die in echten Daten vorkommen. */
    sagePruefung("Perzentil bei zu kleinem Universum bleibt leer",
      M.cpRang(1, [1, 2, 3]) === null);
    const skala = Array.from({ length: 40 }, (_, i) => i + 1);
    sagePruefung("Perzentil des kleinsten Werts unter 10, des größten über 90",
      M.cpRang(1, skala) < 10 && M.cpRang(40, skala) > 90);
    sagePruefung("Perzentil eines fehlenden Werts bleibt leer",
      M.cpRang(null, skala) === null);
    const fd = path.join(WURZEL, "data", "fundamentals.json");
    if (fs.existsSync(fd)) {
      const daten = (JSON.parse(fs.readFileSync(fd, "utf8")) || {}).data || {};
      const erster = Object.keys(daten)[0];
      const prof = erster ? M.cpProfil(erster, daten) : null;
      console.log(`  Faktorprofil für ${erster}: `
        + (prof ? prof.werte.map(w => `${w.name} ${w.rang ?? "–"} (n=${w.n})`).join(", ")
                : "kein Profil"));
      sagePruefung("Titel außerhalb des Korbs bekommt kein leeres Profil",
        M.cpProfil("GIBTESNICHT", daten) === null);
    }
  }

  /* --- Modul 1b: Portfolio ---
     Geprueft wird gegen Eigenschaften, die mathematisch gelten muessen. Eine
     Kovarianzrechnung, die sie verletzt, ist falsch - unabhaengig davon, wie
     plausibel die Zahlen aussehen. */
  console.log("\nModul 1b – Risikobeitrag im Depot (Markowitz)");
  {
    const monat = (renditen, start = 100) => {
      const t = [], c = []; let p = start;
      const d = new Date(Date.UTC(2015, 0, 28));
      for (const r of renditen) {
        p *= 1 + r; t.push(d.getTime()); c.push(p);
        d.setUTCMonth(d.getUTCMonth() + 1); d.setUTCDate(28);
      }
      return { t, c, h: c.slice(), l: c.slice() };
    };
    const wuerfel = saat => { let s = saat >>> 0 || 1;
      return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 - 0.5; }; };

    // A) Zwei identische Reihen: kein Diversifikationsgewinn, exakt null
    const g = wuerfel(7);
    const basis = Array.from({ length: 80 }, () => g() * 0.1);
    const pA = M.cpPortfolio([{ sym: "X", value: 50 }, { sym: "Y", value: 50 }],
      new Map([["X", monat(basis)], ["Y", monat(basis)]]));
    sagePruefung("perfekt gleichlaufende Positionen ergeben keinen Diversifikationsgewinn",
      !pA.grund && Math.abs(pA.gewinn) < 1e-9);

    // B) Vier wenig korrelierte, gleich gewichtete: Portfolio deutlich ruhiger
    const karte = new Map(), pos = [];
    for (let i = 0; i < 4; i++) {
      const w = wuerfel(100 + i);
      karte.set("T" + i, monat(Array.from({ length: 80 }, () => w() * 0.1)));
      pos.push({ sym: "T" + i, value: 25 });
    }
    const pB = M.cpPortfolio(pos, karte);
    const mittelVola = pB.eintraege.reduce((a, e) => a + e.vola, 0) / 4;
    sagePruefung("vier wenig korrelierte Positionen schwanken deutlich weniger als einzeln",
      !pB.grund && pB.volP < mittelVola * 0.75);

    // C) Euler-Zerlegung: die Beitraege summieren sich exakt zur Portfoliovola
    const summe = pB.eintraege.reduce((a, e) => a + e.beitrag, 0);
    sagePruefung("Risikobeiträge summieren sich exakt zur Depot-Volatilität",
      Math.abs(summe - pB.volP) < 1e-12);
    sagePruefung("Risikoanteile summieren sich auf 100 %",
      Math.abs(pB.eintraege.reduce((a, e) => a + e.anteil, 0) - 1) < 1e-12);

    // D) Korrelationsmatrix
    sagePruefung("Korrelationsmatrix hat Einsen auf der Diagonale und ist symmetrisch",
      pB.korr.every((z, i) => Math.abs(z[i] - 1) < 1e-12
        && z.every((v, j) => Math.abs(v - pB.korr[j][i]) < 1e-12)));
    sagePruefung("eine einzelne Position ergibt keine Portfoliosicht",
      !!M.cpPortfolio([{ sym: "T0", value: 100 }], karte).grund);

    console.log(`  Beispiel: ${pB.eintraege.length} gleich gewichtete Positionen, `
      + `Einzelvola im Mittel ${(mittelVola * 100).toFixed(1)} %, `
      + `Depot ${(pB.volP * 100).toFixed(1)} %, Gewinn ${(pB.gewinn * 100).toFixed(1)} %`);
  }

  /* --- Querschnitt des Korbs --- */
  const qDatei = path.join(WURZEL, "data", "quer.json");
  console.log("\nModul 4b – Momentum im Querschnitt");
  if (!fs.existsSync(qDatei)) {
    console.log("  data/quer.json fehlt – build_mover.js noch nicht gelaufen.");
  } else {
    const q = JSON.parse(fs.readFileSync(qDatei, "utf8"));
    console.log(`  ${q.titel} Titel, Stand ${q.stand}`);
    const mit = q.werte.filter(x => x.m12 != null);
    sagePruefung("mindestens 50 Titel mit Momentum", mit.length >= 50);
    sagePruefung("alle Momentumwerte zwischen −100 % und +2000 %",
      mit.every(x => x.m12 > -100 && x.m12 < 2000));
    sagePruefung("alle Schwankungen zwischen 1 % und 200 %",
      q.werte.filter(x => x.v != null).every(x => x.v > 1 && x.v < 200));
    const erster = q.werte[0] && M.cpQuerRang(q.werte[0].s, q);
    sagePruefung("Perzentil eines vorhandenen Titels liegt zwischen 0 und 100",
      !!erster && erster.mom12.rang >= 0 && erster.mom12.rang <= 100);
    sagePruefung("Titel außerhalb des Korbs bekommt kein Perzentil",
      M.cpQuerRang("GIBTESNICHT", q) === null);
    const sortiert = mit.slice().sort((a, b) => b.m12 - a.m12);
    console.log(`  stärkstes ${sortiert[0].s} ${sortiert[0].m12.toFixed(0)} %, `
      + `schwächstes ${sortiert[sortiert.length - 1].s} ${sortiert[sortiert.length - 1].m12.toFixed(0)} %`);
  }

  /* --- Plausibilitaet --- */
  console.log("\nPlausibilität");
  const sage = sagePruefung;
  sage("alle Titel liefern eine Volatilität", zeilen.every(z => z.r.volaKurz > 0));
  sage("alle Volatilitäten zwischen 5 % und 150 %",
       zeilen.every(z => z.r.volaKurz > 0.05 && z.r.volaKurz < 1.5));
  sage("alle Drawdowns negativ und über −95 %",
       zeilen.every(z => z.r.drawdown.tiefe <= 0 && z.r.drawdown.tiefe > -0.95));
  sage("alle Korrelationen zwischen −1 und 1",
       zeilen.every(z => z.r.korr == null || (z.r.korr >= -1 && z.r.korr <= 1)));
  sage("alle Betas zwischen −1 und 5",
       zeilen.every(z => z.cm.grund || (z.cm.beta > -1 && z.cm.beta < 5)));
  sage("alle R² zwischen 0 und 1",
       zeilen.every(z => z.cm.grund || (z.cm.r2 >= 0 && z.cm.r2 <= 1)));
  sage("jede Regression nutzt mindestens die geforderten Monate",
       zeilen.every(z => z.cm.grund || z.cm.n >= M.AK_CONFIG.capm.minPunkte));
  sage("Eigenkapitalkosten liegen über dem risikofreien Zins (Beta positiv)",
       zeilen.every(z => z.cm.grund || z.cm.beta <= 0 || z.cm.ekKosten > rf));

  const alle = pruef.every(Boolean);
  console.log(`\n${alle ? "Alle Plausibilitätsprüfungen bestanden." : "MINDESTENS EINE PRÜFUNG FEHLGESCHLAGEN."}`);
  console.log(ok ? "Alle Schwellen trennen." : "Mindestens eine Schwelle trennt nicht – siehe oben.");
  process.exit(alle ? 0 : 1);
})();

function AKsym(M) { return M.AK_CONFIG.capm.rfSymbol; }
