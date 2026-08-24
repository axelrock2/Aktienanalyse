"use strict";
/* =====================================================================
   Bewertungsmodell als Arbeitsmappe (.xlsx)
   Aufbau nach Analystenkonvention: Eingaben strikt getrennt vom Rechenweg.
   Farbkonvention:  blau = Eingabe   schwarz = Formel   gruen = Blattverweis
                    gelbe Fuellung = wichtige Annahme / bitte pruefen
   Alle Formeln sind echte Excel-Formeln – Numbers und Excel rechnen beim
   Aendern der Annahmen automatisch neu.
   ===================================================================== */

function buildValuationWorkbook(ExcelJS, d) {
  const wb = new ExcelJS.Workbook();
  wb.creator = "Aktien-Cockpit";
  wb.title = `Bewertungsmodell ${d.name || d.sym} (${d.sym})`;
  wb.subject = `Bewertung ${d.sym} – Stand ${d.asOf}`;
  wb.created = new Date();

  /* ---------- Stilhelfer ---------- */
  const BASE = { name: "Arial", size: 10 };
  const BLUE = { ...BASE, color: { argb: "FF0000FF" } };            // Eingabe
  const GREEN = { ...BASE, color: { argb: "FF008000" } };           // Verweis auf anderes Blatt
  const BOLD = { ...BASE, bold: true };
  const TITLE = { name: "Arial", size: 13, bold: true };
  const HEAD = { ...BASE, bold: true, color: { argb: "FFFFFFFF" } };
  const YELLOW = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFFF00" } };
  const HEADFILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FF1F3864" } };
  const SUBFILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F1" } };
  const MITTEFILL = { type: "pattern", pattern: "solid", fgColor: { argb: "FFBDD7EE" } };  // Basisfall

  const MONEY = '#,##0.00;(#,##0.00);-';
  const MIO = '#,##0;(#,##0);-';
  const PCT = '0.0%;(0.0%);-';
  const MULT = '0.0"x"';

  /* Zahl nur setzen, wenn sie wirklich vorliegt – sonst bleibt das Feld leer
     und gelb markiert, damit klar ist: hier muss der Nutzer selbst ran. */
  const isNum = v => typeof v === "number" && isFinite(v);
  const put = (ws, addr, value, opts = {}) => {
    const c = ws.getCell(addr);
    if (value === null || value === undefined || (typeof value === "number" && !isFinite(value))) {
      c.value = null;
      c.fill = YELLOW;
      c.font = BLUE;
      c.note = "Wert lag nicht vor – bitte selbst eintragen.";
    } else {
      c.value = value;
      c.font = opts.font || BASE;
      if (opts.fill) c.fill = opts.fill;
    }
    if (opts.numFmt) c.numFmt = opts.numFmt;
    if (opts.align) c.alignment = { horizontal: opts.align };
    return c;
  };
  const label = (ws, addr, text, opts = {}) => {
    const c = ws.getCell(addr);
    c.value = text;
    c.font = opts.font || BASE;
    if (opts.fill) c.fill = opts.fill;
    if (opts.align) c.alignment = { horizontal: opts.align };
    return c;
  };
  const formula = (ws, addr, f, opts = {}) => {
    const c = ws.getCell(addr);
    c.value = { formula: f };
    c.font = opts.font || BASE;
    if (opts.numFmt) c.numFmt = opts.numFmt;
    if (opts.fill) c.fill = opts.fill;
    return c;
  };
  const section = (ws, addr, text) => label(ws, addr, text, { font: BOLD, fill: SUBFILL });

  const cur = d.currency || "";
  const mioCur = "Mio " + cur;

  /* =================================================================
     Blatt 1 – Übersicht
     ================================================================= */
  const ov = wb.addWorksheet("Übersicht");
  ov.columns = [{ width: 38 }, { width: 18 }, { width: 52 }];

  label(ov, "A1", `Bewertungsmodell – ${d.name || d.sym} (${d.sym})`, { font: TITLE });
  label(ov, "A2", `Stand ${d.asOf} · Beträge in ${mioCur}, Kurse in ${cur}`);
  label(ov, "A3", "Blau = Eingabe · Schwarz = Formel · Grün = Verweis auf anderes Blatt · Gelb = bitte prüfen");

  section(ov, "A5", "Ergebnis");
  section(ov, "B5", "Wert");
  section(ov, "C5", "Bedeutung");

  label(ov, "A6", "Aktueller Kurs");
  formula(ov, "B6", "Annahmen!B14", { font: GREEN, numFmt: MONEY });
  label(ov, "C6", "Marktpreis zum Stand oben");

  label(ov, "A7", "Fairer Wert – DCF");
  formula(ov, "B7", "DCF!B20", { font: GREEN, numFmt: MONEY });
  label(ov, "C7", "Barwert der künftigen freien Cashflows je Anteil");

  label(ov, "A8", "Fairer Wert – Multiplikatoren");
  formula(ov, "B8", "Multiplikatoren!D9", { font: GREEN, numFmt: MONEY });
  label(ov, "C8", "Mittel aus KGV-, Umsatz-, Cashflow- und Buchwertansatz");

  label(ov, "A9", "Fairer Wert – Mittel beider Methoden", { font: BOLD });
  formula(ov, "B9", 'IFERROR(AVERAGE(B7:B8),"")', { font: BOLD, numFmt: MONEY });
  label(ov, "C9", "Gleichgewichtetes Mittel – bewusst grob");

  label(ov, "A10", "Auf-/Abschlag zum Kurs", { font: BOLD });
  formula(ov, "B10", 'IFERROR(B9/B6-1,"")', { font: BOLD, numFmt: PCT });
  label(ov, "C10", "Positiv = Modell sieht den Titel günstiger als der Markt");

  label(ov, "A11", "Einschätzung");
  formula(ov, "B11",
    'IF(B10="","",IF(B10>0.2,"deutlich unter Modellwert",IF(B10>0.05,"leicht unter Modellwert",' +
    'IF(B10>-0.05,"nahe Modellwert",IF(B10>-0.2,"leicht über Modellwert","deutlich über Modellwert")))))');

  section(ov, "A13", "So arbeitest du damit");
  label(ov, "A14", "1. Blatt „Annahmen“ öffnen und die blauen Werte anpassen.");
  label(ov, "A15", "2. Blatt „WACC“ bestimmt den Diskontsatz aus Beta, Zins und Kapitalstruktur.");
  label(ov, "A16", "3. Blatt „Sensitivität“ zeigt, wie stark das Ergebnis an den Annahmen hängt.");
  label(ov, "A18", "Wichtig", { font: BOLD });
  label(ov, "A19", "Dies ist ein Rechenmodell zur eigenen Meinungsbildung, keine Anlageempfehlung.");
  label(ov, "A20", "Die Annahmen bestimmen das Ergebnis maßgeblich – ein DCF ist so gut wie seine Eingaben.");
  label(ov, "A21", `Datenquelle: Kurse und Kennzahlen aus dem Aktien-Cockpit; Bilanzposten aus SEC EDGAR, soweit vorhanden.`);
  label(ov, "A22", "Gelb hinterlegte leere Felder lagen nicht vor und müssen von dir gefüllt werden.");
  label(ov, "A24", "Leere Felder? Das Blatt „Suche“ sagt dir für jeden Wert, wo du ihn findest.", { font: BOLD });
  formula(ov, "A25",
    '"Noch offen: "&(COUNTIF(Suche!F29:F42,"→ fehlt")+COUNTIF(Suche!F29:F42,"→ prüfen*"))&" von 14 Werten. Details im Blatt „Suche“."', { font: BOLD });

  /* =================================================================
     Blatt 2 – Suche: wo finde ich welchen Wert, und wie trage ich ihn ein
     ================================================================= */
  const su = wb.addWorksheet("Suche");
  su.columns = [{ width: 20 }, { width: 32 }, { width: 50 }, { width: 34 }, { width: 30 }, { width: 24 }];

  label(su, "A1", `Wo finde ich die Werte? – ${d.name || d.sym} (${d.sym})`, { font: TITLE });
  label(su, "A2", `Alle Beträge in ${cur} und in Millionen eintragen. Werte je Anteil als echte Beträge.`);

  section(su, "A4", "Schritt 1 – Den Titel bei TradingView öffnen");
  label(su, "A5", "Suchfeld");
  label(su, "B5", `tradingview.com öffnen, oben ins Suchfeld „${d.sym}“ oder „${d.name || ""}“ eingeben.`);
  label(su, "A6", "Direktes Adressmuster");
  label(su, "B6", "tradingview.com/symbols/BÖRSE-TICKER/financials-statistics-and-ratios/");
  label(su, "A7", "Beispiel");
  label(su, "B7", "tradingview.com/symbols/NASDAQ-NVDA/financials-statistics-and-ratios/");
  label(su, "C7", "Das Börsenkürzel unterscheidet sich je Titel (NASDAQ, NYSE, XETR, LSE, EURONEXT, TSE …).");
  label(su, "A8", "Einfacher");
  label(su, "B8", "Über das Suchfeld gehen – TradingView wählt die Börse selbst.");

  section(su, "A10", "Schritt 2 – Reiter „Financials“ öffnen");
  label(su, "A11", "Vier Bereiche:", { font: BOLD });
  label(su, "A12", "Overview");
  label(su, "B12", "Grafische Trends zu Gewinn, Cashflow und Marge.");
  label(su, "C12", "Zum Einordnen nützlich, liefert aber keine Zahl für die Tabelle.");
  label(su, "A13", "Statements");
  label(su, "B13", "Income statement · Balance sheet · Cash flow");
  label(su, "C13", "Hier stehen Umsatz, Gewinn, Schulden, Eigenkapital und der freie Cashflow.");
  label(su, "A14", "Statistics");
  label(su, "B14", "Key stats · Valuation ratios");
  label(su, "C14", "Hier stehen Anzahl Anteile, Buchwert je Anteil und die Verhältniszahlen (KGV, KUV, KBV).");
  label(su, "A15", "Dividends / Earnings");
  label(su, "B15", "Für dieses Modell nicht gebraucht.");
  label(su, "A16", "Tipp");
  label(su, "B16", "Zeilen haben Aufklapp-Pfeile – dahinter stecken die Unterposten.");
  label(su, "C16", "Im Bereich Statements gibt es außerdem ein Suchfeld für Zeilennamen.");

  section(su, "A18", "Schritt 3 – Zeitraum und Währung einstellen (der häufigste Fehler)");
  label(su, "A19", "Umschalter");
  label(su, "B19", "FY = Geschäftsjahr · FQ = Quartal · TTM = letzte zwölf Monate");
  label(su, "C19", "TTM ist am aktuellsten, FY am stabilsten.");
  label(su, "A20", "Regel", { font: BOLD });
  label(su, "B20", "Entscheide dich für EINE Einstellung und hole ALLE Werte daraus.");
  label(su, "C20", "Mischst du TTM und Geschäftsjahr, rechnet das Modell Äpfel gegen Birnen.");
  label(su, "A21", "Währung");
  label(su, "B21", `Über der Tabelle steht „Currency: …“. Sie muss ${cur} sein.`);
  label(su, "C21", "Stimmt sie nicht, wird der faire Wert um den Wechselkurs verfälscht.");
  label(su, "A22", "Einheit");
  label(su, "B22", "TradingView zeigt Beträge meist schon in Millionen – dann direkt übernehmen.");
  label(su, "C22", "Steht dort „B“ für Milliarden, mit 1000 multiplizieren.");

  section(su, "A24", "Schritt 4 – Werte eintragen. Diese vier zuerst:");
  label(su, "A25", "1. Freier Cashflow   2. Anzahl Anteile   3. Nettoverschuldung   4. Beta", { font: BOLD });
  label(su, "A26", "Ohne sie bleibt der DCF leer. Alles Weitere ist bereits sinnvoll vorbelegt.");

  section(su, "A28", "Zelle");
  section(su, "B28", "Wert");
  section(su, "C28", "Wo genau bei TradingView");
  section(su, "D28", "So eintragen");
  section(su, "E28", "Hinweis");
  section(su, "F28", "Status");

  const guide = [
    ["Annahmen!B5", "Freier Cashflow Basisjahr",
      "Financials → Statements → Cash flow → „Free cash flow“",
      "Zahl in Mio, z. B. 60000",
      "Herzstück des DCF. TradingView rechnet ihn als operativer Cashflow minus Investitionen.", "Annahmen!B5"],
    ["Annahmen!B13", "Anzahl Anteile",
      "Financials → Statistics → Key stats → „Total common shares outstanding“",
      "Zahl in Mio, z. B. 24600",
      "Wenn vorhanden die verwässerte Anzahl („Diluted shares outstanding“).", "Annahmen!B13"],
    ["Annahmen!B15", "Nettoverschuldung",
      "Financials → Statements → Balance sheet: „Total debt“ minus „Cash & equivalents“",
      "Differenz in Mio; negativ, wenn mehr Barmittel als Schulden",
      "Barmittel abzuziehen wird am häufigsten vergessen.", "Annahmen!B15"],
    ["WACC!B6", "Beta",
      "NICHT im Financials-Reiter. Watchlist → Symbol rechts oben aufklappen (Kreisdiagramm) → Overview → Financials oder Risk. Alternativ Stock Screener, Spalte „Beta“.",
      "Zahl, z. B. 1,15",
      "Ohne Wert ist 1,0 angesetzt (Marktdurchschnitt).", "WACC!B6",
      d.betaIsDefault ? "→ prüfen (Standardwert 1,0)" : null],
    ["WACC!B15", "Marktwert Eigenkapital",
      "Symbolseite oben → „Market capitalization“ (oder Watchlist → Price → Market Cap)",
      "Zahl in Mio",
      "Alternativ Kurs mal Anzahl Anteile.", "WACC!B15"],
    ["WACC!B16", "Marktwert Fremdkapital",
      "Financials → Statements → Balance sheet → „Total debt“",
      "Zahl in Mio",
      "Der Buchwert als Näherung ist üblich und ausreichend.", "WACC!B16"],
    ["Multiplikatoren!B4", "Gewinn je Anteil (EPS)",
      "Financials → Statements → Income statement → „Basic EPS“ / „Diluted EPS“",
      `Betrag je Anteil in ${cur}`,
      "Verwässerten Wert bevorzugen, er ist vorsichtiger.", "Multiplikatoren!B4"],
    ["Multiplikatoren!B5", "Umsatz je Anteil",
      "Income statement → „Total revenue“ geteilt durch Anzahl Anteile",
      `Betrag je Anteil in ${cur}`,
      "Oder: Kurs geteilt durch das Kurs-Umsatz-Verhältnis aus Statistics.", "Multiplikatoren!B5"],
    ["Multiplikatoren!B6", "Freier Cashflow je Anteil",
      "Financials → Statements → Cash flow → „Free cash flow per share“",
      `Betrag je Anteil in ${cur}`,
      "TradingView weist diesen Wert direkt aus.", "Multiplikatoren!B6"],
    ["Multiplikatoren!B7", "Buchwert je Anteil",
      "Financials → Statistics → „Book value per share“",
      `Betrag je Anteil in ${cur}`,
      "Bei Banken und Substanzwerten besonders aussagekräftig.", "Multiplikatoren!B7"],
    ["Multiplikatoren!C4", "Multiplikator KGV",
      "Stock Screener öffnen → Branche filtern → Spalte „P/E“ mehrerer Wettbewerber ansehen, Mittel bilden",
      "Vielfaches, z. B. 22",
      "NICHT das eigene aktuelle KGV stehen lassen – sonst rechnest du im Kreis.", "Multiplikatoren!C4"],
    ["Multiplikatoren!C5", "Multiplikator Kurs/Umsatz",
      "Stock Screener → Spalte „P/S“ der Wettbewerber",
      "Vielfaches, z. B. 4",
      "In Statistics steht auch der eigene Wert zur Einordnung.", "Multiplikatoren!C5"],
    ["Multiplikatoren!C6", "Multiplikator Kurs/Cashflow",
      "Statistics → „Price to cash flow ratio“ der Wettbewerber",
      "Vielfaches, z. B. 18", "", "Multiplikatoren!C6"],
    ["Multiplikatoren!C7", "Multiplikator Kurs/Buchwert",
      "Stock Screener → Spalte „P/B“ der Wettbewerber",
      "Vielfaches, z. B. 3", "", "Multiplikatoren!C7"],
  ];
  guide.forEach((g, i) => {
    const r = 29 + i;
    label(su, "A" + r, g[0], { font: { ...BASE, bold: true, color: { argb: "FF0000FF" } } });
    label(su, "B" + r, g[1]);
    label(su, "C" + r, g[2]);
    label(su, "D" + r, g[3]);
    label(su, "E" + r, g[4]);
    const okText = g[6] || "ok";
    formula(su, "F" + r, `IF(${g[5]}="","→ fehlt","${okText}")`, { font: BOLD });
  });

  const endRow = 29 + guide.length + 1;
  section(su, "A" + endRow, "Annahmen, die du bewusst setzen darfst (bereits vorbelegt)");
  const assum = [
    ["Annahmen!B8", "Wachstum Jahre 1–5", "Aus dem historischen Umsatz- oder Cashflow-Wachstum ableiten (Financials → Overview zeigt die Trends), konservativ deckeln."],
    ["Annahmen!B9", "Wachstum Jahre 6–10", "Deutlich unter Phase 1 – kein Unternehmen wächst dauerhaft zweistellig."],
    ["Annahmen!B10", "Ewiges Wachstum", "2 bis 2,5 % sind üblich. Darf das langfristige Wirtschaftswachstum nicht übersteigen."],
    ["WACC!B4", "Risikofreier Zins", "Rendite zehnjähriger Bundesanleihen (TradingView-Symbol DE10Y) oder US-Treasuries (US10Y)."],
    ["WACC!B5", "Marktrisikoprämie", "4,5 bis 6 % für entwickelte Märkte – Erfahrungswert, nicht abrufbar."],
    ["WACC!B10", "Fremdkapitalzins", "Income statement → „Interest expense“ geteilt durch „Total debt“."],
    ["WACC!B11", "Steuersatz", "Etwa 25 % in Deutschland, rund 21 % in den USA. Oder: Steueraufwand geteilt durch Vorsteuergewinn."],
  ];
  assum.forEach((g, i) => {
    const r = endRow + 1 + i;
    label(su, "A" + r, g[0], { font: { ...BASE, bold: true, color: { argb: "FF0000FF" } } });
    label(su, "B" + r, g[1]);
    label(su, "C" + r, g[2]);
  });

  const noteRow = endRow + assum.length + 2;
  label(su, "A" + noteRow, "Die drei Fehler, die dein Ergebnis am stärksten verzerren", { font: BOLD });
  label(su, "A" + (noteRow + 1), "1. Zeiträume mischen. Alle Werte aus derselben Spalte holen – entweder TTM oder dasselbe Geschäftsjahr.");
  label(su, "A" + (noteRow + 2), "2. Einheiten mischen. Beträge durchgehend in Millionen; Milliarden vorher mal 1000 nehmen.");
  label(su, "A" + (noteRow + 3), "3. Die eigenen Multiplikatoren stehen lassen. Dann bekommst du zwangsläufig den heutigen Kurs zurück.");
  label(su, "A" + (noteRow + 5), "Die Spalte „Status“ oben zeigt jederzeit, welche Felder noch fehlen.");
  label(su, "A" + (noteRow + 6), "Warum TradingView-Zahlen leicht von anderen Quellen abweichen können: unterschiedliche Bereinigungen");
  label(su, "A" + (noteRow + 7), "und Stichtage. Für ein Bewertungsmodell ist das unerheblich, solange du bei einer Quelle bleibst.");

  /* =================================================================
     Blatt 3 – Annahmen
     ================================================================= */
  const an = wb.addWorksheet("Annahmen");
  an.columns = [{ width: 38 }, { width: 16 }, { width: 56 }];

  label(an, "A1", `Annahmen – ${d.name || d.sym} (${d.sym})`, { font: TITLE });
  label(an, "A2", "Blaue Werte sind Eingaben. Änderst du sie, rechnen alle Blätter automatisch neu.");

  section(an, "A4", "Cashflow-Basis");
  section(an, "B4", "Wert");
  section(an, "C4", "Herkunft / Hinweis");

  label(an, "A5", `Freier Cashflow Basisjahr (${mioCur})`);
  put(an, "B5", isNum(d.fcf0) ? d.fcf0 : null, { font: BLUE, fill: YELLOW, numFmt: MIO });
  label(an, "C5", d.fcfSource || "Bitte eintragen: operativer Cashflow abzüglich Investitionen.");

  section(an, "A7", "Wachstumsannahmen");
  label(an, "A8", "Wachstum Jahre 1–5 (p. a.)");
  put(an, "B8", d.g1, { font: BLUE, fill: YELLOW, numFmt: PCT });
  label(an, "C8", d.g1Source || "Startwert aus dem historischen Umsatzwachstum, gedeckelt.");

  label(an, "A9", "Wachstum Jahre 6–10 (p. a.)");
  put(an, "B9", d.g2, { font: BLUE, fill: YELLOW, numFmt: PCT });
  label(an, "C9", "Übergangsphase – üblicherweise deutlich unter Phase 1.");

  label(an, "A10", "Ewiges Wachstum ab Jahr 11");
  put(an, "B10", d.gt, { font: BLUE, fill: YELLOW, numFmt: PCT });
  label(an, "C10", "Darf langfristig das Wirtschaftswachstum nicht übersteigen (Faustregel 2–2,5 %).");

  section(an, "A12", "Bewertungsbasis");
  label(an, "A13", `Anzahl Anteile (Mio)`);
  put(an, "B13", isNum(d.shares) ? d.shares : null, { font: BLUE, fill: YELLOW, numFmt: MIO });
  label(an, "C13", d.sharesSource || "Bitte eintragen (verwässerte Aktienanzahl).");

  label(an, "A14", `Aktueller Kurs (${cur})`);
  put(an, "B14", isNum(d.price) ? d.price : null, { font: BLUE, numFmt: MONEY });
  label(an, "C14", "Kurs zum Stand oben, aus dem Aktien-Cockpit.");

  label(an, "A15", `Nettoverschuldung (${mioCur})`);
  put(an, "B15", isNum(d.netDebt) ? d.netDebt : null, { font: BLUE, fill: YELLOW, numFmt: MIO });
  label(an, "C15", d.netDebtSource || "Zinstragende Schulden abzüglich Barmittel. Negativ = Nettoliquidität.");

  label(an, "A17", "Diskontsatz (WACC)", { font: BOLD });
  formula(an, "B17", "WACC!B17", { font: GREEN, numFmt: PCT });
  label(an, "C17", "Wird im Blatt „WACC“ hergeleitet.");

  /* =================================================================
     Blatt 3 – WACC
     ================================================================= */
  const wa = wb.addWorksheet("WACC");
  wa.columns = [{ width: 38 }, { width: 16 }, { width: 56 }];

  label(wa, "A1", `Kapitalkosten (WACC) – ${d.name || d.sym} (${d.sym})`, { font: TITLE });
  label(wa, "A2", "Der Diskontsatz, mit dem künftige Cashflows auf heute abgezinst werden.");

  section(wa, "A3", "Eigenkapitalkosten");
  section(wa, "B3", "Wert");
  section(wa, "C3", "Hinweis");

  label(wa, "A4", "Risikofreier Zins");
  put(wa, "B4", d.riskFree, { font: BLUE, fill: YELLOW, numFmt: PCT });
  label(wa, "C4", "Rendite langlaufender Staatsanleihen.");

  label(wa, "A5", "Marktrisikoprämie");
  put(wa, "B5", d.mrp, { font: BLUE, fill: YELLOW, numFmt: PCT });
  label(wa, "C5", "Übliche Spanne 4,5–6 % für entwickelte Märkte.");

  label(wa, "A6", "Beta");
  put(wa, "B6", isNum(d.beta) ? d.beta : null, { font: BLUE, fill: YELLOW, numFmt: '0.00' });
  label(wa, "C6", d.betaSource || "Schwankung gegenüber dem Gesamtmarkt.");

  label(wa, "A7", "Eigenkapitalkosten (CAPM)", { font: BOLD });
  formula(wa, "B7", "B4+B6*B5", { font: BOLD, numFmt: PCT });
  label(wa, "C7", "Risikofreier Zins plus Beta mal Marktrisikoprämie.");
  label(wa, "A8", "Prüfe das Beta: Ohne belastbaren Wert wird 1,0 angesetzt (Marktdurchschnitt).");

  section(wa, "A9", "Fremdkapitalkosten");
  label(wa, "A10", "Fremdkapitalzins");
  put(wa, "B10", d.costDebt, { font: BLUE, fill: YELLOW, numFmt: PCT });
  label(wa, "C10", "Effektivzins der Verbindlichkeiten.");

  label(wa, "A11", "Steuersatz");
  put(wa, "B11", d.taxRate, { font: BLUE, fill: YELLOW, numFmt: PCT });
  label(wa, "C11", "Fremdkapitalzinsen mindern die Steuerlast.");

  label(wa, "A12", "Fremdkapitalkosten nach Steuern");
  formula(wa, "B12", "B10*(1-B11)", { numFmt: PCT });

  section(wa, "A14", "Gewichtung");
  label(wa, "A15", `Marktwert Eigenkapital (${mioCur})`);
  put(wa, "B15", isNum(d.marketCapM) ? d.marketCapM : null, { font: BLUE, numFmt: MIO });
  label(wa, "C15", d.mcSource || "Kurs mal Anzahl Anteile.");

  label(wa, "A16", `Marktwert Fremdkapital (${mioCur})`);
  put(wa, "B16", isNum(d.debtM) ? d.debtM : null, { font: BLUE, fill: YELLOW, numFmt: MIO });
  label(wa, "C16", d.debtSource || "Näherung: Buchwert der zinstragenden Schulden.");

  label(wa, "A17", "WACC", { font: BOLD });
  formula(wa, "B17", "IFERROR((B15*B7+B16*B12)/(B15+B16),B7)", { font: BOLD, numFmt: PCT });
  label(wa, "C17", "Gewichtetes Mittel. Ohne Fremdkapitalangaben fällt der Wert auf die Eigenkapitalkosten zurück.");

  /* =================================================================
     Blatt 4 – DCF
     ================================================================= */
  const dcf = wb.addWorksheet("DCF");
  dcf.columns = [{ width: 34 }, ...Array.from({ length: 10 }, () => ({ width: 11 }))];

  label(dcf, "A1", `Discounted-Cashflow-Modell – ${d.name || d.sym} (${d.sym})`, { font: TITLE });
  label(dcf, "A2", `Zweiphasiges Wachstum, anschließend ewige Rente. Beträge in ${mioCur}.`);

  const COL = ["B", "C", "D", "E", "F", "G", "H", "I", "J", "K"];
  label(dcf, "A3", "Jahr", { font: HEAD, fill: HEADFILL });
  label(dcf, "A4", "Kalenderjahr", { font: BOLD, fill: SUBFILL });
  label(dcf, "A5", "Wachstumsrate");
  label(dcf, "A6", "Freier Cashflow");
  label(dcf, "A7", "Diskontfaktor (Jahresmitte)");
  label(dcf, "A8", "Barwert");

  const baseYear = new Date().getFullYear();
  COL.forEach((c, i) => {
    const n = i + 1;
    label(dcf, c + "3", n, { font: HEAD, fill: HEADFILL, align: "center" });
    label(dcf, c + "4", String(baseYear + n), { font: BOLD, fill: SUBFILL, align: "center" });
    formula(dcf, c + "5", `IF(${c}$3<=5,Annahmen!$B$8,Annahmen!$B$9)`, { numFmt: PCT });
    formula(dcf, c + "6",
      i === 0 ? `Annahmen!$B$5*(1+${c}5)` : `${COL[i - 1]}6*(1+${c}5)`, { numFmt: MIO });
    /* Jahresmitte: Cashflows fallen ueber das Jahr verteilt an, nicht gebuendelt
       am 31.12. Abgezinst wird deshalb ueber 0,5 / 1,5 / 2,5 Jahre. Die frueher
       verwendete Abzinsung zum Jahresende unterschaetzte den Wert je nach
       Zinssatz um 3 bis 4 Prozent. */
    formula(dcf, c + "7", `1/(1+Annahmen!$B$17)^(${c}$3-0.5)`, { numFmt: '0.000' });
    formula(dcf, c + "8", `${c}6*${c}7`, { numFmt: MIO });
  });

  section(dcf, "A10", "Bewertungsbrücke");
  label(dcf, "A11", "Summe Barwerte Jahre 1–10");
  formula(dcf, "B11", "SUM(B8:K8)", { numFmt: MIO });

  label(dcf, "A12", "Freier Cashflow Jahr 10");
  formula(dcf, "B12", "K6", { numFmt: MIO });

  label(dcf, "A13", "Ewiges Wachstum");
  formula(dcf, "B13", "Annahmen!$B$10", { font: GREEN, numFmt: PCT });

  label(dcf, "A14", "Terminal Value (Jahr 10)");
  formula(dcf, "B14", 'IF(Annahmen!$B$17<=B13,"",B12*(1+B13)/(Annahmen!$B$17-B13))', { numFmt: MIO });

  label(dcf, "A15", "Barwert Terminal Value");
  formula(dcf, "B15", 'IF(B14="","",B14*K7)', { numFmt: MIO });

  label(dcf, "A16", "Unternehmenswert (Enterprise Value)", { font: BOLD });
  formula(dcf, "B16", 'B11+IF(B15="",0,B15)', { font: BOLD, numFmt: MIO });

  label(dcf, "A17", "abzüglich Nettoverschuldung");
  formula(dcf, "B17", "Annahmen!$B$15", { font: GREEN, numFmt: MIO });

  label(dcf, "A18", "Eigenkapitalwert", { font: BOLD });
  formula(dcf, "B18", "B16-B17", { font: BOLD, numFmt: MIO });

  label(dcf, "A19", "Anzahl Anteile (Mio)");
  formula(dcf, "B19", "Annahmen!$B$13", { font: GREEN, numFmt: MIO });

  label(dcf, "A20", `Fairer Wert je Anteil (${cur})`, { font: BOLD });
  formula(dcf, "B20", 'IFERROR(B18/B19,"")', { font: BOLD, numFmt: MONEY });

  label(dcf, "A21", "Aktueller Kurs");
  formula(dcf, "B21", "Annahmen!$B$14", { font: GREEN, numFmt: MONEY });

  label(dcf, "A22", "Auf-/Abschlag");
  formula(dcf, "B22", 'IFERROR(B20/B21-1,"")', { font: BOLD, numFmt: PCT });

  label(dcf, "A24", "Der Terminal Value macht bei zehn Jahren typischerweise den größten Teil des Werts aus –");
  label(dcf, "A25", "deshalb reagiert das Ergebnis besonders empfindlich auf Diskontsatz und ewiges Wachstum.");

  /* =================================================================
     Blatt 5 – Multiplikatoren
     ================================================================= */
  const mu = wb.addWorksheet("Multiplikatoren");
  mu.columns = [{ width: 34 }, { width: 18 }, { width: 18 }, { width: 18 }, { width: 46 }];

  label(mu, "A1", `Bewertung über Multiplikatoren – ${d.name || d.sym} (${d.sym})`, { font: TITLE });
  label(mu, "A2", "Vergleichsansatz: Kennzahl je Anteil mal einem angesetzten Vielfachen.");

  ["A3", "B3", "C3", "D3", "E3"].forEach((a, i) =>
    label(mu, a, ["Kennzahl", `Wert je Anteil (${cur})`, "Multiplikator", `Fairer Wert (${cur})`, "Hinweis"][i],
      { font: HEAD, fill: HEADFILL }));

  const rows = [
    ["Gewinn je Anteil (EPS)", d.eps, d.peRef, "KGV-Ansatz. Multiplikator aus Branche oder Historie."],
    ["Umsatz je Anteil", d.revPS, d.psRef, "Kurs/Umsatz. Nützlich bei schwankenden Gewinnen."],
    ["Freier Cashflow je Anteil", d.fcfPS, d.pfcfRef, "Kurs/Cashflow. Schwerer zu schönen als der Gewinn."],
    ["Buchwert je Anteil", d.bvPS, d.pbRef, "Kurs/Buchwert. Vor allem bei Banken und Substanzwerten."],
  ];
  rows.forEach(([name, val, mult, hint], i) => {
    const r = 4 + i;
    label(mu, "A" + r, name);
    put(mu, "B" + r, isNum(val) ? val : null, { font: BLUE, numFmt: MONEY });
    put(mu, "C" + r, isNum(mult) ? mult : null, { font: BLUE, fill: YELLOW, numFmt: MULT });
    formula(mu, "D" + r, `IF(OR(B${r}="",C${r}=""),"",B${r}*C${r})`, { numFmt: MONEY });
    label(mu, "E" + r, hint);
  });

  label(mu, "A9", "Fairer Wert – Mittel", { font: BOLD });
  formula(mu, "D9", 'IFERROR(AVERAGE(D4:D7),"")', { font: BOLD, numFmt: MONEY });
  label(mu, "E9", "Leere Zeilen bleiben unberücksichtigt.");

  label(mu, "A10", "Aktueller Kurs");
  formula(mu, "D10", "Annahmen!$B$14", { font: GREEN, numFmt: MONEY });

  label(mu, "A11", "Auf-/Abschlag");
  formula(mu, "D11", 'IFERROR(D9/D10-1,"")', { font: BOLD, numFmt: PCT });

  label(mu, "A13", "Achtung: Die Multiplikatoren sind mit den AKTUELLEN Werten dieses Titels vorbelegt.", { font: BOLD });
  label(mu, "A14", "Lässt du sie so stehen, bekommst du zwangsläufig ungefähr den heutigen Kurs zurück –");
  label(mu, "A15", "der Ansatz sagt dann nichts aus. Setze Werte aus echten Wettbewerbern oder dem");
  label(mu, "A16", "historischen Mittel des Titels ein, damit der Vergleich aussagekräftig wird.");

  /* =================================================================
     Blatt 6 – Sensitivität
     ================================================================= */
  const se = wb.addWorksheet("Sensitivität");
  se.columns = [{ width: 22 }, ...Array.from({ length: 7 }, () => ({ width: 13 }))];

  label(se, "A1", `Sensitivität: fairer Wert je Anteil – ${d.name || d.sym} (${d.sym})`, { font: TITLE });
  label(se, "A2", "Zeilen: ewiges Wachstum · Spalten: Diskontsatz (WACC). Die hervorgehobene Mittelzelle trägt die Annahmen des Modells – ihr Wert muss dem Blatt „DCF“ entsprechen.");

  label(se, "A4", "ewiges W. \\ WACC", { font: HEAD, fill: HEADFILL });
  const SCOL = ["B", "C", "D", "E", "F", "G", "H"];
  SCOL.forEach((c, i) => {
    const off = (i - 3) * 0.005;
    formula(se, c + "4", `Annahmen!$B$17${off >= 0 ? "+" : "-"}${Math.abs(off)}`,
      { font: HEAD, fill: HEADFILL, numFmt: PCT });
  });
  for (let r = 0; r < 7; r++) {
    const row = 5 + r;
    const off = (r - 3) * 0.005;
    formula(se, "A" + row, `Annahmen!$B$10${off >= 0 ? "+" : "-"}${Math.abs(off)}`,
      { font: BOLD, fill: SUBFILL, numFmt: PCT });
    SCOL.forEach(c => {
      /* Geschlossene Form desselben zweiphasigen DCF wie im Blatt „DCF“:
         Barwert Jahre 1–5 + Jahre 6–10 + Terminal Value, je Einheit Basis-Cashflow. */
      const r_ = `${c}$4`, gt = `$A${row}`;
      const g1 = "Annahmen!$B$8", g2 = "Annahmen!$B$9";
      const k1 = `((1+${g1})/(1+${r_}))`, k2 = `((1+${g2})/(1+${r_}))`;
      /* Die geometrische Summe k*(1-k^5)/(1-k) teilt durch Null, sobald das
         Wachstum genau dem Diskontsatz entspricht - dann ist k = 1. Da die
         Achse in Halbprozentschritten um die Annahme laeuft, trifft das
         regelmaessig: in einer 7x7-Tabelle rund 8 Prozent der Felder, die
         dadurch leer blieben. Bei k = 1 ist die Summe schlicht 5. */
      const s1 = `IF(${g1}=${r_},5,${k1}*(1-${k1}^5)/(1-${k1}))`;
      const s2 = `(1+${g1})^5/(1+${r_})^5*IF(${g2}=${r_},5,${k2}*(1-${k2}^5)/(1-${k2}))`;
      const tv = `(1+${g1})^5*(1+${g2})^5*(1+${gt})/((${r_}-${gt})*(1+${r_})^10)`;
      /* (1+r)^0,5 hebt die Summe auf Jahresmitte an - identisch zum Blatt DCF,
         wo jeder Diskontfaktor den Exponenten n-0,5 traegt. */
      const f = `IF(${r_}<=${gt},"",IFERROR((Annahmen!$B$5*(${s1}+${s2}+${tv})*(1+${r_})^0.5-Annahmen!$B$15)/Annahmen!$B$13,""))`;
      /* Mittelzelle hervorheben: Dort stehen genau die Annahmen des Modells,
         ihr Wert muss dem Ergebnis im Blatt DCF entsprechen. Das ist die
         Sichtpruefung, ob die Tabelle richtig aufgebaut ist. */
      const istMitte = (c === "E" && row === 8);
      formula(se, c + row, f, istMitte
        ? { numFmt: MONEY, font: BOLD, fill: MITTEFILL }
        : { numFmt: MONEY });
    });
  }

  label(se, "A13", "Lies die Tabelle so: Schon ein Prozentpunkt mehr Diskontsatz kann den fairen Wert");
  label(se, "A14", "deutlich verschieben. Wenn dein Ergebnis nur in einer Ecke der Tabelle günstig aussieht,");
  label(se, "A15", "trägt die Bewertung nicht.");

  return wb;
}

/* =====================================================================
   Bewertungsmodell exportieren – Anbindung an das Cockpit
   Die Tabellenbibliothek wird erst beim Klick geladen (rund 1 MB),
   damit der Seitenaufbau schlank bleibt.
   ===================================================================== */

let vxLibProm = null;
function vxLoadLib() {
  if (typeof ExcelJS !== "undefined") return Promise.resolve(ExcelJS);
  if (!vxLibProm) {
    vxLibProm = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js";
      s.onload = () => (typeof ExcelJS !== "undefined") ? res(ExcelJS) : rej(new Error("nicht geladen"));
      s.onerror = () => { vxLibProm = null; rej(new Error("Bibliothek nicht erreichbar")); };
      document.head.appendChild(s);
    });
  }
  return vxLibProm;
}

const VX_STEUERSATZ = 0.25;          // wie scripts/dcf_core.py
const vxNum = v => (typeof v === "number" && isFinite(v)) ? v : null;
const vxClamp = (v, lo, hi) => v == null ? null : Math.min(hi, Math.max(lo, v));

/* Kennzahlen aus Kurs, Yahoo-Fundamentaldaten und SEC-Bilanz zusammenstellen.
   Alles in Mio der Notierungswaehrung; fehlende Groessen bleiben null und
   werden im Blatt als auszufuellendes Feld markiert. */
function vxCollect(item, chart, fund, a) {
  const cur = (chart && chart.meta && chart.meta.currency) || "";
  const price = vxNum(a && a.price) ?? vxNum(chart && chart.c[chart.c.length - 1]);
  const sec = (typeof Fundamentals !== "undefined" && Fundamentals.get)
    ? (Fundamentals.get(item.s) || {}).sec || null : null;

  const M = v => v == null ? null : v / 1e6;          // absolut -> Mio
  let marketCapM = M(vxNum(fund && fund.marketCap));

  let shares = M(vxNum(sec && sec.sharesOutstanding));
  let sharesSource = "SEC EDGAR – ausstehende Aktien.";
  if (shares == null && marketCapM != null && price) {
    shares = marketCapM / price;
    sharesSource = "Näherung aus Marktkapitalisierung geteilt durch Kurs.";
  }
  /* Umgekehrter Weg: liegt die Marktkapitalisierung nicht vor, aber Anteile
     und Kurs, laesst sie sich sauber ausrechnen. */
  if (marketCapM == null && shares != null && price) marketCapM = shares * price;

  /* Freier Cashflow: bevorzugt der ausgewiesene, sonst der operative Cashflow.
     Der Unterschied wird offen benannt, statt ihn zu verwischen. */
  let fcf0 = M(vxNum(fund && fund.fcf));
  let fcfSource = "Freier Cashflow aus dem Kennzahlenabruf.";
  if (fcf0 == null) {
    fcf0 = M(vxNum(sec && sec.cashFlowOps));
    fcfSource = "SEC EDGAR – OPERATIVER Cashflow (Investitionen noch nicht abgezogen, bitte prüfen).";
  }
  if (fcf0 == null) fcfSource = "Bitte eintragen: operativer Cashflow abzüglich Investitionen.";

  /* Zinsen nach Steuern zurechnen. Der ausgewiesene freie Cashflow ist nach
     Zinsen; das Modell zinst ihn aber mit dem WACC ab und zieht danach die
     Nettoverschuldung ab. Ohne diese Zurechnung traegt die Schuld zweimal.
     Uebersprungen wird sie, wenn Zinsaufwand und ausgewiesene Schuld nicht
     zusammenpassen – bei Konzernen mit eigener Finanzsparte steckt der
     Grossteil der Schuld in kurzfristigen Posten und fehlt in der Bilanzzeile,
     dann waere die Zurechnung einseitig. */
  const zinsM = M(vxNum(sec && sec.interestExpense));
  const schuldM = M(vxNum(sec && sec.longTermDebt));
  if (fcf0 != null && zinsM) {
    const satz = (schuldM && schuldM > 0) ? Math.abs(zinsM) / schuldM : null;
    const stimmig = satz != null && satz <= 0.12;
    if (stimmig || Math.abs(zinsM) <= 0.15 * Math.abs(fcf0)) {
      fcf0 += Math.abs(zinsM) * (1 - VX_STEUERSATZ);
      fcfSource += ` Zinsaufwand nach Steuern zugerechnet (${Math.round(VX_STEUERSATZ * 100)} % Steuersatz), damit der Cashflow zum WACC passt.`;
    } else {
      fcfSource += " Zinsaufwand NICHT zugerechnet: er passt nicht zur ausgewiesenen Schuld"
                 + (satz != null ? ` (impliziter Zinssatz ${(satz * 100).toFixed(1)} %)` : "")
                 + " – vermutlich eigene Finanzsparte. Bitte selbst prüfen.";
    }
  }

  const debtM = M(vxNum(sec && sec.longTermDebt));
  const netDebt = debtM;
  const netDebtSource = debtM != null
    ? "SEC EDGAR – langfristige Schulden. Barmittel sind NICHT abgezogen: bitte abziehen."
    : "Zinstragende Schulden abzüglich Barmittel. Negativ = Nettoliquidität.";

  const revenueM = M(vxNum(sec && sec.revenue));
  const netIncomeM = M(vxNum(sec && sec.netIncome));
  const equityM = M(vxNum(sec && sec.equity));
  const ps = v => (v != null && shares) ? v / shares : null;

  /* Wachstumsstart aus dem Umsatzwachstum, bewusst gedeckelt – ein DCF mit
     30 % Dauerwachstum waere Unsinn. */
  const g1 = vxClamp(vxNum(fund && fund.revGrowth), 0, 0.15) ?? 0.05;

  let beta = vxNum(fund && fund.beta);
  const betaSource = beta != null
    ? "Aus dem Kennzahlenabruf."
    : "Kein Wert vorhanden – Marktdurchschnitt 1,0 angesetzt, bitte prüfen.";
  const betaIsDefault = beta == null;
  if (beta == null) beta = 1.0;

  return {
    sym: item.s, name: item.n, currency: cur,
    asOf: new Date().toLocaleDateString("de-DE"),
    price, fcf0, fcfSource, shares, sharesSource,
    netDebt, netDebtSource, marketCapM, debtM,
    mcSource: "Kurs mal Anzahl Anteile (Kennzahlenabruf).",
    debtSource: debtM != null ? "SEC EDGAR – langfristige Schulden." : "Buchwert der zinstragenden Schulden.",
    beta, betaSource, betaIsDefault,
    riskFree: 0.025, mrp: 0.055, costDebt: 0.04, taxRate: 0.25,
    g1, g1Source: "Startwert aus dem Umsatzwachstum, auf 15 % gedeckelt.",
    g2: Math.max(0.02, g1 / 2), gt: 0.02,
    eps: ps(netIncomeM), revPS: ps(revenueM), fcfPS: ps(fcf0), bvPS: ps(equityM),
    peRef: vxNum(fund && fund.trailingPE) ?? vxNum(fund && fund.forwardPE),
    psRef: (price != null && ps(revenueM)) ? price / ps(revenueM) : null,
    pfcfRef: (price != null && ps(fcf0)) ? price / ps(fcf0) : null,
    pbRef: (price != null && ps(equityM)) ? price / ps(equityM) : null,
  };
}

/* Klick auf den Knopf: Bibliothek holen, Mappe bauen, herunterladen. */
async function vxExport(item, chart, fund, a, btn) {
  const old = btn ? btn.textContent : "";
  try {
    if (btn) { btn.disabled = true; btn.textContent = "Tabelle wird erstellt …"; }
    const Lib = await vxLoadLib();
    const data = vxCollect(item, chart, fund, a);
    const wb = buildValuationWorkbook(Lib, data);
    const buf = await wb.xlsx.writeBuffer();
    const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Bewertung_${item.s.replace(/[^\w.-]/g, "")}_${new Date().toISOString().slice(0, 10)}.xlsx`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    if (btn) btn.textContent = "Tabelle erstellt ✓";
    setTimeout(() => { if (btn) { btn.textContent = old; btn.disabled = false; } }, 2500);
  } catch (e) {
    if (btn) { btn.textContent = "Nicht möglich – erneut versuchen"; btn.disabled = false; }
    setTimeout(() => { if (btn) btn.textContent = old; }, 3000);
  }
}
