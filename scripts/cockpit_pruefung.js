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
    + " cpDrawdown, cpSchiefe, cpRegression, cpPaare, cpMonatsende, AK_CONFIG };", ctx);
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

  /* --- Plausibilitaet --- */
  console.log("\nPlausibilität");
  const pruef = [];
  const sage = (txt, gut) => { pruef.push(gut); console.log(`  ${gut ? "ok  " : "FEHL"}  ${txt}`); };
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
