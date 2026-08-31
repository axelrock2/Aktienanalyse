#!/usr/bin/env node
"use strict";
/* =====================================================================
   Erzeugt data/mover.json - die staerksten Bewegungen des Korbs.

   Zwei Listen: der letzte abgeschlossene Handelstag und die letzten fuenf
   Handelstage. Beide enthalten Gewinner UND Verlierer, sortiert nach dem
   Betrag der Bewegung - "Top Mover" meint die groessten Ausschlaege, nicht
   nur die nach oben. Die Richtung traegt auf der Seite die Farbe.

   ZUM ZEITBEZUG: Gerechnet wird auf Schlusskursen, nicht auf dem laufenden
   Handel. "Handelstag" ist deshalb immer die letzte abgeschlossene Sitzung,
   und ihr Datum steht in der Datei - eine Momentaufnahme als "heute" zu
   bezeichnen, waere die haeufigste Luege solcher Anzeigen.

   Bei gemischten Boersenplaetzen faellt der letzte Handelstag nicht
   ueberall auf dasselbe Datum. Jeder Titel bringt deshalb sein eigenes
   Stichdatum mit; als Stand der Liste gilt das haeufigste davon.

   Der Korb ist scripts/chancen_watchlist.txt - derselbe wie beim
   Chancenraum, damit die Startseite ueber dieselbe Menge spricht.

   Aufruf:
       node scripts/build_mover.js
   ===================================================================== */

const fs = require("fs");
const path = require("path");

const WURZEL = path.resolve(__dirname, "..");
const KORB = path.join(WURZEL, "scripts", "chancen_watchlist.txt");
const ZIEL = path.join(WURZEL, "data", "mover.json");

/** So viele Titel je Reihe. Mehr passt nicht sinnvoll ins Laufband. */
const JE_REIHE = 12;
/** Handelstage fuer die Wochenbetrachtung. */
const WOCHE_TAGE = 5;
/** Pause zwischen zwei Abrufen. Wir sind Gast bei einer fremden Schnittstelle. */
const PAUSE_MS = 220;
const VERSUCHE = 3;

/* Eine Zeile ist "TICKER" oder "TICKER  Anzeigename" - dasselbe Format, das
   build_chancen.py liest. Wer nur bis zum Zeilenende liest, verliert jeden
   Titel, hinter dem ein Name steht. */
function liesKorb() {
  return fs.readFileSync(KORB, "utf8")
    .split("\n")
    .map(z => z.trim())
    .filter(z => z && !z.startsWith("#"))
    .map(z => {
      const teile = z.split(/\s+/);
      return { sym: teile[0], name: teile.slice(1).join(" ") || null };
    })
    .filter(x => x.sym);
}

async function holeReihe(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(symbol) + "?range=1mo&interval=1d";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error("keine Kursdaten");
  const q = r.indicators.quote[0] || {};
  const t = [], c = [];
  r.timestamp.forEach((ts, i) => {
    const s = q.close && q.close[i];
    // Luecken werden ausgelassen, nicht gefuellt - ein erfundener Schlusskurs
    // erzeugt eine erfundene Bewegung.
    if (s == null || !isFinite(s)) return;
    t.push(ts * 1000); c.push(s);
  });
  return {
    t, c,
    name: (r.meta && (r.meta.longName || r.meta.shortName)) || symbol,
    cur: (r.meta && r.meta.currency) || "",
  };
}

const schlaf = ms => new Promise(r => setTimeout(r, ms));
const proz = (neu, alt) => (alt > 0 ? (neu / alt - 1) * 100 : null);
const runde = v => Math.round(v * 100) / 100;

async function main() {
  const korb = liesKorb();
  console.error(`Korb: ${korb.length} Titel`);

  const alle = [];
  let fehler = 0, zuKurz = 0;

  for (const { sym, name: korbName } of korb) {
    let d = null;
    for (let v = 1; v <= VERSUCHE; v++) {
      try { d = await holeReihe(sym); break; }
      catch (e) {
        if (v === VERSUCHE) console.error(`  ${sym}: ${e.message}`);
        else await schlaf(PAUSE_MS * v * 2);
      }
    }
    await schlaf(PAUSE_MS);
    if (!d) { fehler++; continue; }

    const n = d.c.length;
    if (n < WOCHE_TAGE + 2) { zuKurz++; continue; }

    const tag = proz(d.c[n - 1], d.c[n - 2]);
    const woche = proz(d.c[n - 1], d.c[n - 1 - WOCHE_TAGE]);
    if (tag == null || woche == null) { zuKurz++; continue; }

    alle.push({
      sym,
      // Der Name aus dem Korb hat Vorrang - er ist gepflegt, Yahoo liefert
      // fuer manche Boersenplaetze sperrige Firmierungen.
      name: korbName || d.name,
      kurs: runde(d.c[n - 1]),
      cur: d.cur,
      tag: runde(tag),
      woche: runde(woche),
      stichtag: new Date(d.t[n - 1]).toISOString().slice(0, 10),
    });
  }

  // Groesster Ausschlag zuerst, Richtung egal.
  const stark = (feld) => alle.slice()
    .sort((a, b) => Math.abs(b[feld]) - Math.abs(a[feld]))
    .slice(0, JE_REIHE)
    .map(x => ({ sym: x.sym, name: x.name, kurs: x.kurs, cur: x.cur,
                 wert: x[feld], stichtag: x.stichtag }));

  // Haeufigstes Stichdatum als Stand - Boersenplaetze schliessen verschieden.
  const zaehler = {};
  alle.forEach(x => { zaehler[x.stichtag] = (zaehler[x.stichtag] || 0) + 1; });
  const stand = Object.keys(zaehler).sort((a, b) => zaehler[b] - zaehler[a])[0]
    || new Date().toISOString().slice(0, 10);

  const aus = {
    stand,
    erzeugt: new Date().toISOString(),
    grundmenge: alle.length,
    woche_tage: WOCHE_TAGE,
    tag: stark("tag"),
    woche: stark("woche"),
  };
  fs.mkdirSync(path.dirname(ZIEL), { recursive: true });
  fs.writeFileSync(ZIEL, JSON.stringify(aus, null, 2) + "\n", "utf8");

  console.error(`\nGrundmenge ${alle.length} Titel, Stand ${stand}`
    + `, ${zuKurz} zu kurze Reihen, ${fehler} nicht erreichbar.`);
  console.error(`Tag  staerkster: ${aus.tag[0].sym} ${aus.tag[0].wert > 0 ? "+" : ""}${aus.tag[0].wert} %`);
  console.error(`Woche staerkster: ${aus.woche[0].sym} ${aus.woche[0].wert > 0 ? "+" : ""}${aus.woche[0].wert} %`);
  console.error(`Geschrieben: ${path.relative(WURZEL, ZIEL)} (${fs.statSync(ZIEL).size} Bytes)`);
}

main().catch(e => { console.error("Abbruch:", e); process.exit(1); });
