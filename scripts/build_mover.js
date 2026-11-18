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

   Erzeugt ausserdem data/quer.json mit Momentum und Schwankung aller Titel
   des Korbs - die Vergleichsmenge fuer die Perzentile im Analyse-Cockpit.

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
/* Handelstage je Monat - Grundlage der Momentum-Fenster. */
const MONAT = 21;
/* Zweite Ausgabedatei: die Querschnittswerte des Korbs. Das Momentum eines
   Titels sagt fuer sich wenig; Jegadeesh & Titman (1993) haben den Effekt
   ueber die Rangfolge VIELER Aktien gefunden. Dafuer braucht die Seite die
   Werte aller Titel, und die entstehen hier - der Lauf holt die Kurse des
   ganzen Korbs ohnehin. */
const ZIEL_QUER = path.join(WURZEL, "data", "quer.json");

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
    + encodeURIComponent(symbol) + "?range=2y&interval=1d";
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

/** Rendite ueber [monate] Monate ohne die letzten [aus] Monate, in Prozent.
    Der letzte Monat bleibt aussen vor: kurzfristig wirkt ein Umkehreffekt,
    der das Signal sonst verwaessert (Jegadeesh & Titman 1993). */
function fenster(c, monate, aus) {
  const ende = c.length - 1 - aus * MONAT;
  const start = ende - (monate - aus) * MONAT;
  if (start < 0 || ende <= start || !(c[start] > 0)) return null;
  return runde((c[ende] / c[start] - 1) * 100);
}

/** Annualisierte Schwankung der Tagesrenditen eines Jahres, in Prozent. */
function vola(c) {
  const teil = c.slice(-253);
  if (teil.length < 120) return null;
  const r = [];
  for (let i = 1; i < teil.length; i++) {
    if (teil[i] > 0 && teil[i - 1] > 0) r.push(Math.log(teil[i] / teil[i - 1]));
  }
  if (r.length < 100) return null;
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - m) * (b - m), 0) / (r.length - 1);
  return runde(Math.sqrt(v * 252) * 100);
}
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
      // Querschnittswerte; null, wo die Reihe zu kurz ist.
      mom12_1: fenster(d.c, 12, 1),
      mom6_1: fenster(d.c, 6, 1),
      vola: vola(d.c),
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

  /* Querschnitt: nur Symbol und Kennzahlen, kein Name und kein Kurs - die
     Datei wird beim Oeffnen jeder Detailansicht gelesen und soll klein sein. */
  const quer = alle
    .filter(x => x.mom12_1 != null || x.vola != null)
    .map(x => ({ s: x.sym, m12: x.mom12_1, m6: x.mom6_1, v: x.vola }));
  fs.writeFileSync(ZIEL_QUER, JSON.stringify({
    stand, erzeugt: new Date().toISOString(), titel: quer.length, werte: quer,
  }) + "\n", "utf8");

  console.error(`\nGrundmenge ${alle.length} Titel, Stand ${stand}`
    + `, ${zuKurz} zu kurze Reihen, ${fehler} nicht erreichbar.`);
  console.error(`Tag  staerkster: ${aus.tag[0].sym} ${aus.tag[0].wert > 0 ? "+" : ""}${aus.tag[0].wert} %`);
  console.error(`Woche staerkster: ${aus.woche[0].sym} ${aus.woche[0].wert > 0 ? "+" : ""}${aus.woche[0].wert} %`);
  console.error(`Geschrieben: ${path.relative(WURZEL, ZIEL)} (${fs.statSync(ZIEL).size} Bytes)`);
  console.error(`Geschrieben: ${path.relative(WURZEL, ZIEL_QUER)} (${fs.statSync(ZIEL_QUER).size} Bytes)`);
}

main().catch(e => { console.error("Abbruch:", e); process.exit(1); });
