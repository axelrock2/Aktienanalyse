#!/usr/bin/env node
"use strict";
/* =====================================================================
   Erzeugt data/elliott.json - die taeglich vorgerechnete Wellen-Abdeckung.

   Fuer jeden Titel des Korbs werden Kurse geholt und die Wellenzaehlung
   samt Signifikanztest gerechnet. In die Datei kommen nur die Titel, deren
   Zaehlung traegt (gruen oder gelb, also p <= 0,20). Rote und zaehlungslose
   Titel sind die Mehrheit; sie wuerden das Band auf der Startseite fuellen,
   ohne etwas zu sagen. Ihre Zahl steht als Summe im Kopf der Datei - das
   ist die ehrlichere Angabe.

   WARUM NODE UND NICHT PYTHON, wie bei den anderen Erzeugern:
   Der Rechenkern steht in elliott.js, weil die Seite ihn beim Klick auf
   einen Titel selbst ausfuehrt. Ihn fuer diesen Lauf nach Python zu
   portieren hiesse, dieselbe Statistik zweimal zu pflegen - und zwei
   Implementierungen laufen frueher oder spaeter auseinander. Hier wird
   deshalb derselbe Code geladen, den auch der Browser benutzt.

   Der Korb ist scripts/chancen_watchlist.txt - bewusst derselbe wie beim
   Chancenraum, damit die Startseite ueber dieselbe Menge spricht.

   SPEICHERPLATZ: Je Titel eine Zeile mit sechs kurzen Feldern. Selbst wenn
   der ganze Korb traegt, bleibt die Datei im Bereich weniger Kilobyte.

   Aufruf:
       node scripts/build_elliott.js
   ===================================================================== */

const fs = require("fs");
const path = require("path");

const WURZEL = path.resolve(__dirname, "..");
const KORB = path.join(WURZEL, "scripts", "chancen_watchlist.txt");
const ZIEL = path.join(WURZEL, "data", "elliott.json");

/** Ab diesem p-Wert traegt eine Zaehlung nicht mehr - sie kommt nicht ins Band. */
const P_GRENZE = 0.20;
/** Pause zwischen zwei Abrufen. Wir sind Gast bei einer fremden Schnittstelle. */
const PAUSE_MS = 220;
/** So oft wird ein Titel bei einem Fehlschlag erneut versucht. */
const VERSUCHE = 3;

/* ---------- Rechenkern laden ----------
   elliott.js ist ein klassisches Browser-Skript. Auf oberster Ebene stehen
   nur Deklarationen; die einzige Anweisung ist die Chart-Registrierung, und
   die ist mit typeof abgesichert. Damit laesst sich die Datei hier
   unveraendert auswerten - genau das ist der Punkt. */
function ladeKern() {
  const quelle = fs.readFileSync(path.join(WURZEL, "elliott.js"), "utf8");
  const hole = new Function(quelle + "\nreturn { elAnalysiere, elSaat };");
  return hole();
}

/* ---------- Kursreihe holen ---------- */
async function holeKurse(symbol) {
  const url = "https://query1.finance.yahoo.com/v8/finance/chart/"
    + encodeURIComponent(symbol) + "?range=2y&interval=1d";
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) throw new Error("HTTP " + res.status);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !r.timestamp) throw new Error("keine Kursdaten");
  const q = r.indicators.quote[0] || {};
  const reihe = { t: [], c: [], h: [], l: [] };
  r.timestamp.forEach((ts, i) => {
    const c = q.close && q.close[i], h = q.high && q.high[i], l = q.low && q.low[i];
    // Luecken werden ausgelassen, nicht interpoliert - erfundene Kerzen
    // erzeugen erfundene Umkehrpunkte.
    if (c == null || h == null || l == null) return;
    reihe.t.push(ts * 1000); reihe.c.push(c); reihe.h.push(h); reihe.l.push(l);
  });
  const name = (r.meta && (r.meta.longName || r.meta.shortName)) || symbol;
  return { reihe, name };
}

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

const schlaf = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const { elAnalysiere, elSaat } = ladeKern();
  const symbole = liesKorb();
  console.error(`Korb: ${symbole.length} Titel`);

  const treffer = [];
  let rot = 0, ohneZaehlung = 0, fehler = 0, geprueft = 0;

  for (const { sym, name: korbName } of symbole) {
    let daten = null;
    for (let v = 1; v <= VERSUCHE; v++) {
      try { daten = await holeKurse(sym); break; }
      catch (e) {
        if (v === VERSUCHE) console.error(`  ${sym}: ${e.message}`);
        else await schlaf(PAUSE_MS * v * 2);
      }
    }
    await schlaf(PAUSE_MS);
    if (!daten) { fehler++; continue; }

    let erg;
    try { erg = elAnalysiere(daten.reihe, elSaat(sym)); }
    catch (e) { console.error(`  ${sym}: Rechnung fehlgeschlagen - ${e.message}`); fehler++; continue; }

    geprueft++;
    if (!erg.ok) { ohneZaehlung++; continue; }
    if (erg.sig.p > P_GRENZE) { rot++; continue; }

    treffer.push({
      sym,
      // Der Name aus dem Korb hat Vorrang - er ist gepflegt, Yahoo liefert
      // fuer manche Boersenplaetze sperrige Firmierungen.
      name: korbName || daten.name,
      stufe: erg.ampel.stufe,
      p: Math.round(erg.sig.p * 1000) / 1000,
      lage: erg.beste.vollstaendig ? "fünf Wellen" : "Welle 5 läuft",
      aktuell: !!erg.aktuell,
    });
    process.stderr.write(`  ${sym} ${erg.ampel.stufe} p=${erg.sig.p.toFixed(3)}\n`);
  }

  // Die stärkste Zählung zuerst - kleinster p-Wert ist die belegteste.
  treffer.sort((a, b) => a.p - b.p);

  const aus = {
    stand: new Date().toISOString().slice(0, 10),
    geprueft,
    ohne_zaehlung: ohneZaehlung,
    rot,
    titel: treffer,
  };
  fs.mkdirSync(path.dirname(ZIEL), { recursive: true });
  fs.writeFileSync(ZIEL, JSON.stringify(aus, null, 2) + "\n", "utf8");

  console.error(`\n${treffer.length} tragende Zaehlungen `
    + `(${treffer.filter(t => t.stufe === "gruen").length} gruen), `
    + `${rot} rot, ${ohneZaehlung} ohne Zaehlung, ${fehler} nicht erreichbar.`);
  console.error(`Geschrieben: ${path.relative(WURZEL, ZIEL)} `
    + `(${fs.statSync(ZIEL).size} Bytes)`);
}

main().catch(e => { console.error("Abbruch:", e); process.exit(1); });
