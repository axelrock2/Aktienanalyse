#!/usr/bin/env node
"use strict";
/* =====================================================================
   Misst, ob der Gesamt-Score des Cockpits etwas vorhersagt.

   Ein Score, der Kennzahlen zu einer Zahl verruehrt, sieht nach Auskunft aus,
   auch wenn keine darin steckt. Dieses Projekt hat das zweimal gemessen: Die
   Elliott-Passung trennte echte Kurse nicht von Zufallsreihen, und elf von
   dreizehn Alphas waren nicht von null zu unterscheiden. Ein neuer Score ohne
   Messung waere derselbe Fehler ein drittes Mal.

   GEPRUEFT WIRD DER TEIL, DER SICH PRUEFEN LAESST. Momentum und Schwankung
   lassen sich zu jedem historischen Zeitpunkt aus den Kursen rechnen, die
   damals vorlagen - sie sind echt vergangenheitsfest. Die fundamentalen
   Bausteine (Piotroski, CAPE, Faktorprofil) nicht: data/fundamentals.json
   kennt nur den heutigen Stand. Sie auf die Vergangenheit anzuwenden hiesse,
   mit Wissen zu rechnen, das damals niemand hatte. Was dabei herauskaeme,
   waere kein Befund, sondern ein Blick in die eigenen Karten.

   Verfahren nach Jegadeesh & Titman (1993): Monat fuer Monat alle Titel nach
   Score sortieren, oberstes gegen unterstes Fuenftel, die Differenz der
   Rendite des Folgemonats. Gemittelt ueber alle Monate, mit einem Bootstrap
   ueber MONATE - nicht ueber Titel: Innerhalb eines Monats sind die Renditen
   durch den Gesamtmarkt gekoppelt, die Spanne zwischen den Fuenfteln ist die
   unabhaengige Beobachtung.

   Aufruf (laedt beim ersten Mal die Kurse):
       node scripts/score_befund.js
   ===================================================================== */

const fs = require("fs");
const os = require("os");
const path = require("path");
const vm = require("vm");

const WURZEL = path.resolve(__dirname, "..");
const KORB = path.join(WURZEL, "scripts", "chancen_watchlist.txt");
const CACHE = path.join(os.tmpdir(), "ak-score-kurse");

const MONAT = 21;               // Handelstage
const HORIZONTE = [21, 63];     // Haltedauer in Handelstagen
const FUENFTEL = 5;
const MIN_TITEL = 40;           // weniger ergeben keine Fuenftel
const ZIEHUNGEN = 4000;

/* ---------- Kurse ---------- */
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
  if (!r || !r.timestamp) throw new Error("keine Kursdaten");
  const q = r.indicators.quote[0] || {};
  const t = [], c = [];
  r.timestamp.forEach((ts, i) => {
    const v = q.close ? q.close[i] : null;
    if (v == null || !isFinite(v) || v <= 0) return;
    t.push(ts * 1000); c.push(v);
  });
  return { sym, t, c };
}

async function reihen() {
  fs.mkdirSync(CACHE, { recursive: true });
  const aus = [];
  for (const sym of korb()) {
    const datei = path.join(CACHE, sym.replace(/[^A-Za-z0-9.^_-]/g, "_") + ".json");
    if (fs.existsSync(datei)) { aus.push(JSON.parse(fs.readFileSync(datei, "utf8"))); continue; }
    try {
      const d = await hole(sym);
      if (d.c.length > 600) { fs.writeFileSync(datei, JSON.stringify(d)); aus.push(d); }
    } catch (e) { console.error(`  ${sym}: ${e.message}`); }
    await schlaf(180);
  }
  return aus.filter(r => r.c.length > 600);
}

/* ---------- Den ausgelieferten Score laden ---------- */
function ladeModul() {
  const ctx = { console, Math, Date, JSON, isFinite, Array, Number, String, Map, Set, Infinity, Object };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(WURZEL, "config.js"), "utf8"), ctx);
  const quelle = fs.readFileSync(path.join(WURZEL, "cockpit.js"), "utf8");
  const marke = "/* =====================================================================\n   Oberflaeche";
  const schnitt = quelle.indexOf(marke);
  vm.runInContext(`function dsMean(a){return a.reduce((x,y)=>x+y,0)/a.length;}
    function dsAtr(){return null;}`, ctx);
  vm.runInContext((schnitt > 0 ? quelle.slice(0, schnitt) : quelle)
    + "\nglobalThis.__ex = { cpRang, cpScoreAusTeilen, AK_CONFIG };", ctx);
  return ctx.__ex;
}

/* ---------- Kennzahlen zu einem historischen Zeitpunkt ---------- */
/** Rendite ueber [monate] Monate ohne die letzten [aus], Stand Index i. */
function fenster(c, i, monate, aus) {
  const ende = i - aus * MONAT;
  const start = ende - (monate - aus) * MONAT;
  if (start < 0 || ende <= start || !(c[start] > 0)) return null;
  return c[ende] / c[start] - 1;
}
/** Annualisierte Schwankung der letzten 252 Tage, Stand Index i. */
function vola(c, i) {
  const von = i - 252;
  if (von < 1) return null;
  const r = [];
  for (let k = von; k <= i; k++) if (c[k] > 0 && c[k - 1] > 0) r.push(Math.log(c[k] / c[k - 1]));
  if (r.length < 200) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return Math.sqrt(r.reduce((a, b) => a + (b - m) * (b - m), 0) / (r.length - 1) * 252);
}

const mittel = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

function zufall(saat) {
  let s = (saat >>> 0) || 2463534242;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/* =====================================================================
   Hauptlauf
   ===================================================================== */
(async () => {
  const M = ladeModul();
  console.error("Kurse laden …");
  const rs = await reihen();
  console.error(`${rs.length} Titel mit mindestens 600 Kerzen.\n`);
  if (rs.length < MIN_TITEL) {
    console.error(`Zu wenige Titel (${rs.length}) - ohne Querschnitt kein Test.`);
    return 1;
  }

  /* Gemeinsame Handelstage als KALENDERDATUM, nicht als Zeitstempel.
     Yahoo meldet je Boerse die Eroeffnungszeit in UTC: Hongkong 01:30,
     New York 14:30. Rohe Zeitstempel treffen sich ueber Boersen hinweg
     deshalb nie, und eine Suche nach gemeinsamen Stichtagen findet dann
     praktisch nichts - der erste Lauf meldete "zu wenige Stichtage". */
  const datum = ts => new Date(ts).toISOString().slice(0, 10);
  const index = rs.map(r => {
    const m = new Map();
    r.t.forEach((t, i) => m.set(datum(t), i));
    return m;
  });
  const zaehler = new Map();
  for (const m of index) for (const d of m.keys()) zaehler.set(d, (zaehler.get(d) || 0) + 1);
  const tage = [...zaehler.entries()].filter(([, n]) => n >= rs.length * 0.7)
    .map(([d]) => d).sort();
  console.error(`${tage.length} Handelstage, die mindestens 70 % der Titel teilen.`);

  const gewichte = M.AK_CONFIG.score.gewichteMessbar;
  console.error(`Gewichte im Test: ${Object.entries(gewichte).map(([k, v]) => `${k} ${v}`).join(", ")}\n`);

  const spannen = {};            // horizont -> [{monat, spanne}]
  HORIZONTE.forEach(h => { spannen[h] = []; });
  let stichtage = 0;

  for (let ti = 252 + MONAT; ti < tage.length - Math.max(...HORIZONTE); ti += MONAT) {
    const tag = tage[ti];
    const kandidaten = [];
    for (let k = 0; k < rs.length; k++) {
      const i = index[k].get(tag);
      if (i == null || i < 252 + MONAT) continue;
      const c = rs[k].c;
      const m12 = fenster(c, i, 12, 1);
      const v = vola(c, i);
      if (m12 == null || v == null) continue;
      kandidaten.push({ k, i, m12, v, c });
    }
    if (kandidaten.length < MIN_TITEL) continue;
    stichtage++;

    /* Perzentile im Querschnitt DIESES Stichtags - nicht ueber die ganze
       Historie. Alles andere waere ein Blick nach vorn. */
    const alleM = kandidaten.map(x => x.m12), alleV = kandidaten.map(x => x.v);
    for (const x of kandidaten) {
      const teile = {
        momentum: M.cpRang(x.m12, alleM),
        ruhe: 100 - M.cpRang(x.v, alleV),      // niedrige Schwankung = hoeherer Beitrag
      };
      x.score = M.cpScoreAusTeilen(teile, gewichte);
    }
    const sortiert = kandidaten.filter(x => x.score != null).sort((a, b) => b.score - a.score);
    if (sortiert.length < MIN_TITEL) continue;
    const gr = Math.floor(sortiert.length / FUENFTEL);
    const oben = sortiert.slice(0, gr), unten = sortiert.slice(-gr);

    for (const h of HORIZONTE) {
      const rend = g => mittel(g.map(x => (x.c[x.i + h] > 0 && x.c[x.i] > 0)
        ? x.c[x.i + h] / x.c[x.i] - 1 : null).filter(v => v != null));
      const ro = rend(oben), ru = rend(unten);
      if (ro == null || ru == null) continue;
      spannen[h].push({ tag, spanne: ro - ru, oben: ro, unten: ru });
    }
  }

  console.error(`${stichtage} monatliche Stichtage ausgewertet.\n`);
  console.log("Oberstes gegen unterstes Fünftel nach Score");
  console.log("Haltedauer   Monate   Ø oberstes   Ø unterstes   Spanne    95%-Band          Anteil positiv");
  const ergebnis = {};
  for (const h of HORIZONTE) {
    const s = spannen[h];
    if (s.length < 12) { console.log(`${String(h).padStart(5)} Tage   zu wenige Stichtage`); continue; }
    const werte = s.map(x => x.spanne);
    const rnd = zufall(4711), band = [];
    for (let z = 0; z < ZIEHUNGEN; z++) {
      let summe = 0;
      for (let i = 0; i < werte.length; i++) summe += werte[Math.floor(rnd() * werte.length)];
      band.push(summe / werte.length);
    }
    band.sort((a, b) => a - b);
    const lo = band[Math.floor(0.025 * band.length)], hi = band[Math.floor(0.975 * band.length)];
    const d = mittel(werte);
    const positiv = werte.filter(v => v > 0).length / werte.length;
    ergebnis[h] = { d, lo, hi, n: werte.length, positiv };
    const p = v => ((v < 0 ? "−" : "+") + (Math.abs(v) * 100).toFixed(2) + " %").padStart(10);
    console.log(`${String(h).padStart(5)} Tage ${String(werte.length).padStart(8)} `
      + `${p(mittel(s.map(x => x.oben)))}  ${p(mittel(s.map(x => x.unten)))} ${p(d)}  `
      + `[${(lo * 100).toFixed(2)} %; ${(hi * 100).toFixed(2)} %]`.padEnd(20)
      + `  ${(positiv * 100).toFixed(0)} %`
      + (lo > 0 ? "   BAND ÜBER NULL" : hi < 0 ? "   BAND UNTER NULL" : ""));
  }

  console.log("\nWas dieser Test NICHT sagt:");
  console.log("  - Er prüft nur Momentum und Schwankung. Piotroski, CAPE und das");
  console.log("    Faktorprofil stehen nur als heutiger Stand zur Verfügung; sie auf die");
  console.log("    Vergangenheit anzuwenden wäre ein Blick in die eigenen Karten.");
  console.log("  - Der Korb ist heute zusammengestellt. Titel, die es nicht mehr gibt,");
  console.log("    fehlen darin - das schönt jedes Rückrechnen (Überlebensverzerrung).");
  console.log("  - Gebühren, Spreads und Steuern sind nicht abgezogen. Eine Spanne von");
  console.log("    unter einem Prozent je Monat überlebt sie nicht zwangsläufig.");

  const beste = ergebnis[21];
  if (beste) {
    console.log("\n/* Für EL-Stil-Befund in config.js */");
    console.log("  befund: {");
    console.log(`    titel: ${rs.length}, stichtage: ${beste.n}, tage: 21,`);
    console.log(`    spanne: ${beste.d.toFixed(4)}, lo: ${beste.lo.toFixed(4)}, hi: ${beste.hi.toFixed(4)},`);
    console.log(`    anteilPositiv: ${beste.positiv.toFixed(3)},`);
    console.log("  },");
  }
  return 0;
})();
