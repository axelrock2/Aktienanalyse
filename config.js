"use strict";
/* =====================================================================
   Zentrale Einstellungen des Analyse-Cockpits

   Alles, was eine Entscheidung ist und keine Rechnung, steht hier: Zeitraeume,
   Benchmarks, Zinssatz, Schwellen. Wer eine Zahl im Cockpit nicht
   nachvollziehen kann, soll sie hier finden und aendern koennen, ohne die
   Rechenfunktionen anzufassen.

   Klassisches Script, kein ES-Modul - wie app.js, depot.js und elliott.js.
   ===================================================================== */

const AK_CONFIG = {

  /* ---------- Modul 1: Risiko (Markowitz 1952) ---------- */
  risiko: {
    /** Handelstage je Jahr - der Faktor, mit dem annualisiert wird. */
    handelstage: 252,
    /** Fenster der Volatilitaet in Handelstagen. */
    fensterKurz: 252,
    fensterLang: 756,
    /** Ab dieser Korrelation zur Benchmark gilt ein Titel als wenig eigenstaendig. */
    korrelationHoch: 0.75,
    korrelationNiedrig: 0.40,
  },

  /* ---------- Modul 2: CAPM (Sharpe 1964) ---------- */
  capm: {
    /** Beta aus Monatsrenditen. Tagesrenditen sind durch nicht gleichzeitige
        Handelszeiten verzerrt - besonders bei auslaendischen Notierungen gegen
        einen US-Index. Fuenf Jahre Monatsdaten sind 60 Punkte: genug fuer eine
        Schaetzung, kurz genug, um das heutige Unternehmen zu beschreiben. */
    jahre: 5,
    minPunkte: 36,
    /** Blume-Anpassung: beta_adj = a * beta_roh + b.
        Betas wandern ueber die Zeit zur Eins; Blume (1971) korrigiert das. */
    blumeA: 0.67,
    blumeB: 0.33,
    /** Marktrisikopraemie. Keine Messgroesse, sondern eine Annahme -
        deshalb hier und mit Spanne in der Anzeige. */
    marktpraemie: 0.055,
    /** Risikofreier Zins: 10-jaehrige US-Staatsanleihe ueber dieselbe
        Kursquelle wie alles andere. ^TNX notiert in Prozent (4,2 = 4,2 %).

        Gilt fuer USD. Fuer einen Euro-Titel waere die Bundesanleihe der
        richtige Massstab - Yahoo fuehrt sie nicht (geprueft: DE10Y-DE.BD,
        ^GDBR10, DE10YT=RR liefern alle leer). Statt still den falschen Zins
        zu nehmen, steht bei Titeln ausserhalb des Dollarraums ein Hinweis.
        Eine Euro-Reihe kommt mit der Faktoren-Action aus Phase 3. */
    rfSymbol: "^TNX",
    rfWaehrung: "USD",
    rfFallback: 0.04,
    rfName: "10-jährige US-Staatsanleihe",
    /** Grenzen der Einordnung. */
    defensiv: 0.8,
    offensiv: 1.2,
  },

  /* ---------- Benchmark je Heimatboerse ----------
     Beta gegen den falschen Index misst vor allem den Wechselkurs und die
     Zeitverschiebung. Ein DAX-Titel gehoert an den DAX. Faellt eine Boerse
     durch das Raster, bleibt der Welt-Index. */
  benchmark: {
    standard: "ACWI",
    standardName: "MSCI ACWI (Welt)",
    jahre: "5y",
    nachBoerse: {
      DE: "^GDAXI", F: "^GDAXI", BE: "^GDAXI", MU: "^GDAXI", SG: "^GDAXI",
      HM: "^GDAXI", DU: "^GDAXI",
      PA: "^STOXX", AS: "^STOXX", BR: "^STOXX", MI: "^STOXX", MC: "^STOXX",
      LS: "^STOXX", VI: "^STOXX", HE: "^STOXX", ST: "^STOXX", CO: "^STOXX",
      OL: "^STOXX", IC: "^STOXX", AT: "^STOXX",
      L: "^FTSE", SW: "^SSMI",
      T: "^N225", HK: "^HSI", AX: "^AXJO", TO: "^GSPTSE", NZ: "^NZ50",
      SS: "000001.SS", SZ: "399001.SZ", KS: "^KS11", TW: "^TWII",
      NS: "^NSEI", BO: "^BSESN", SA: "^BVSP", MX: "^MXX", JO: "^J203.JO",
    },
    namen: {
      "^GDAXI": "DAX", "^STOXX": "STOXX Europe 600", "^FTSE": "FTSE 100",
      "^SSMI": "SMI", "^N225": "Nikkei 225", "^HSI": "Hang Seng",
      "^AXJO": "ASX 200", "^GSPTSE": "S&P/TSX", "^NZ50": "NZX 50",
      "000001.SS": "SSE Composite", "399001.SZ": "SZSE Component",
      "^KS11": "KOSPI", "^TWII": "TAIEX", "^NSEI": "Nifty 50",
      "^BSESN": "Sensex", "^BVSP": "Bovespa", "^MXX": "IPC",
      "^J203.JO": "FTSE/JSE", "^GSPC": "S&P 500", "ACWI": "MSCI ACWI (Welt)",
    },
    /** US-Notierungen ohne Boersenkuerzel. */
    usa: "^GSPC",
  },

  /* ---------- Modul 4: Momentum (Jegadeesh & Titman 1993) ---------- */
  momentum: {
    /** [Monate gesamt, ausgelassene Monate am Ende].
        Der letzte Monat bleibt bewusst aussen vor: kurzfristig wirkt ein
        Umkehreffekt, der das Signal sonst verwaessert. */
    fenster: [[12, 1], [6, 1], [3, 0]],
    /** Ab dieser Rendite ueber 36 Monate wird auf das Umkehrrisiko der
        Jahre zwei bis drei hingewiesen. */
    umkehrMonate: 36,
    umkehrSchwelle: 1.0,
    handelstageMonat: 21,
  },

  /* ---------- Modul 8: Verhalten (Kahneman & Tversky 1979) ---------- */
  verhalten: {
    /** Naeher als das am 52-Wochen-Hoch: Ankereffekt-Hinweis. */
    hochNaehe: 0.05,
    /** Lotterie-Profil: rechtsschiefe Renditeverteilung UND hohe Schwankung.
        Beides zusammen, nicht eines davon - ein schiefer, aber ruhiger Titel
        ist keine Lotterie, und ein schwankender ohne Schiefe auch nicht.

        Die Schwellen sind an 13 Titeln abgelesen, nicht gesetzt: Die Schiefe
        der Tagesrenditen reicht dort von −0,65 bis 1,76; ab 0,8 liegen genau
        die Titel, die man als Lotterie erkennen wuerde. Die urspruenglich
        eingetragene Schwelle "groesster Tagesgewinn ueber 10 Prozent" hat auf
        keinem einzigen Titel ausgeloest - sie waere eine Zeile gewesen, die nie
        etwas tut. */
    schiefeFenster: 252,
    schiefeSchwelle: 0.8,
    volaSchwelle: 0.35,
    /** Ein Kurssprung ab dieser Groesse in Tagesspannen gilt als auffaellig.
        An denselben 13 Titeln: der groesste Sprung je Titel liegt zwischen
        1,4 und 4,2 Tagesspannen, zwoelf davon unter 2,3. Bei 2,5 bleibt der
        Hinweis selten genug, um etwas zu bedeuten. */
    sprungAtr: 2.5,
    sprungFenster: 21,
  },

  /* ---------- Module 3 und 5: Faktormodelle ---------- */
  faktoren: {
    /** Datei aus scripts/build_faktoren.py. */
    quelle: "data/faktoren.json",
    /** Querschnittswerte des Korbs, aus scripts/build_mover.js. */
    quelleQuer: "data/quer.json",
    /** Fenster der Regression in Monaten. Fuenf Jahre: lang genug fuer sechs
        Regressoren, kurz genug, um das heutige Unternehmen zu beschreiben.
        Carhart rechnete mit 36 bis 60 Monaten. */
    monate: 60,
    minMonate: 36,
    /** Unter so vielen Vergleichstiteln wird kein Perzentil gezeigt - ein Rang
        unter zwanzig Titeln ist eine Zahl ohne Trennschaerfe. */
    minUniversum: 20,
    /** Ab diesem Zuwachs an bereinigtem R² tragen Profitabilitaet und
        Investition beim einzelnen Titel sichtbar etwas bei. */
    zugewinnSichtbar: 0.02,
  },

  /* ---------- Modul 1b: Portfolio ---------- */
  portfolio: {
    /** Fenster der Kovarianzschaetzung in Monaten. */
    monate: 60,
    minMonate: 24,
    /** Ab diesem Ueberhang zwischen Risikoanteil und Gewicht wird eine
        Position als Risikoschwerpunkt benannt. Fuenf Prozentpunkte: darunter
        ist der Unterschied kleiner als die Schaetzunsicherheit. */
    ueberhangWarnung: 0.05,
    /** Ab dieser Korrelation zum Rest des Depots gilt eine Position als
        wenig eigenstaendig. */
    korrHoch: 0.7,
  },

  /* ---------- Gesamt-Score ----------
     Bewusst abschaltbar und bewusst mit sichtbaren Gewichten. Die Zahlen hier
     sind eine ENTSCHEIDUNG, keine Messung - niemand hat gemessen, dass
     Momentum ein Viertel wiegen sollte. Wer sie aendert, aendert das
     Ergebnis, und genau das soll sichtbar sein. */
  score: {
    /** Standardgewichte der Bausteine. Fehlt ein Baustein, wird ueber die
        vorhandenen neu normiert - ein fehlender Wert zaehlt nicht als null. */
    gewichte: {
      momentum: 0.25,
      ruhe: 0.15,
      qualitaet: 0.25,
      bewertung: 0.20,
      profitabilitaet: 0.15,
    },
    /** Dieselbe Rechnung, aber nur mit den Bausteinen, die sich
        vergangenheitsfest pruefen lassen. scripts/score_befund.js benutzt
        diese Gewichte - alles andere liegt nur als heutiger Stand vor. */
    gewichteMessbar: { momentum: 0.6, ruhe: 0.4 },
    /** Unter so vielen vorhandenen Bausteinen wird kein Score gezeigt. Aus
        zwei von fuenf eine Gesamtnote zu bilden hiesse, drei Luecken als
        Zustimmung zu lesen. */
    minBausteine: 3,
    /** Gemessen mit scripts/score_befund.js, Stand 18.11.2026. Steht in der
        Anzeige neben dem Score - eine Zahl ohne ihren gemessenen Wert ist
        genau das, was dieses Projekt beim Elliott-Modul schon einmal
        entfernt hat.

        Das Ergebnis: Ueber 103 monatliche Stichtage brachte das oberste
        Fuenftel nach Score 1,10 % im Folgemonat, das unterste 1,13 %. Die
        Spanne liegt damit bei −0,02 % mit einem Band von −1,31 bis +1,31 -
        also nichts. Ueber drei Monate dasselbe Bild (−0,07 %).

        Das heisst nicht, dass der Score nutzlos ist; es heisst, dass er als
        RANGFOLGE in diesem Korb nichts vorhersagt. Als Zusammenfassung der
        Bausteine bleibt er brauchbar - solange niemand ihn fuer eine
        Prognose haelt. Genau deshalb steht die Zahl in der Anzeige. */
    befund: {
      titel: 108, stichtage: 103, tage: 21,
      spanne: -0.0002, lo: -0.0131, hi: 0.0131,
      anteilPositiv: 0.573,
      obenMittel: 0.0110, untenMittel: 0.0113,
    },
  },

  /* ---------- Darstellung ---------- */
  anzeige: {
    /** Haltbarkeit des Zwischenspeichers fuer Zins und Benchmark. */
    cacheMs: 6 * 60 * 60 * 1000,
  },
};
