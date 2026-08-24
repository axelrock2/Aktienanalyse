# Aktien-Cockpit

Persönliches Analyse-Dashboard für Einzelaktien weltweit (USA, Europa, Asien) –
gehostet kostenlos über GitHub Pages, ohne Server und ohne Konto.

**Funktionen**

- Blitzschnelle Suche über ~19.500 Titel (lokale Datenbank) + Online-Fallback für exotische Werte
- Favoriten per Klick, gespeichert nur im eigenen Browser (kein fest verdrahtetes Depot, keine Ladefehler durch defekte Ticker)
- Zwei Scores je Aktie: **Qualität/Bewertung** (Margen, Wachstum, Verschuldung, Cashflow, KGV) und **Timing/Momentum** (Trend, RSI, relative Stärke vs. Welt-Index, Volumen)
- Automatisch berechnete **Einstiegszone, Stop-Idee, Kursziele und Chance/Risiko-Verhältnis** aus Unterstützungen, Widerständen und gleitenden Durchschnitten
- Chart mit GD 50/200, Kennzahlenübersicht, Ampellogik
- Robuste Datenladung: mehrere Datenwege mit automatischem Failover, Wiederholversuchen und Zwischenspeicher
- **Analyse-Dossier** je Titel: 16-Phasen-Bericht mit echten Risikometriken (Sharpe, Sortino, VaR/CVaR, Beta, Max Drawdown), Faktor-Scores, Analystenkonsens, Katalysatoren und Schlagzeilen – jede Sektion transparent als *berechnet*, *abgerufen* oder *selbst zu beurteilen* gekennzeichnet, druckbar als PDF
- **Newsfeed „Markt & Wirtschaft"**: stündlich per GitHub Action serverseitig aus RSS-Feeds gesammelt (keine CORS-Proxys, unabhängig von der Kursquelle), mit Kategoriefiltern und automatischem Abgleich gegen die eigene Watchlist
- **Depot** auf Positionsbasis (Anteile + Ø-Einstandskurs, mit Live-Vorschau, Plausibilitätswarnung und Bearbeiten-Funktion) mit Wertkurve gegen den Welt-Index (gleiche Zahlungsströme), Ringdiagramm nach Position/Sektor/Land/Währung, Zonenstatus je Position sowie Export und Import als Sicherungsdatei – rein lokal, nie im Repository
- **Zonenband auf jeder Übersichtskarte**: Stop, Einstiegszone, Kurs und Zielbereich auf einen Blick, plus Abstand zur Zonenbasis und bis Ziel 1 – ohne zusätzlichen Ladevorgang
- **Aktualisieren-Knopf, Altersanzeige und optionaler Auto-Takt** (5/15/30 Min, nur bei sichtbarem Tab)
- **Anzeigewährung** umschaltbar (Original / EUR / USD) – reine Darstellungs-Umrechnung, alle Scores, Renditen und Risikomaße bleiben nachweislich unverändert; Pence-Notierung (GBp) wird korrekt behandelt
- Ticker-Datenbank aktualisiert sich wöchentlich per GitHub Action

**Einrichtung:** siehe [ANLEITUNG.md](ANLEITUNG.md)

**Hinweis:** Reines Informationswerkzeug, keine Anlageberatung. Kursdaten i. d. R. 15 Minuten verzögert, ohne Gewähr.

- **ETFs** in der Suche (rund 3.300 handelbare Fonds, u. a. MSCI China, Core MSCI World, S&P 500), erkennbar am ETF-Kennzeichen
- **Euro-Kursanzeige** im Depot: Kurse direkt in der Anzeigewährung, Originalkurs als Zusatz

- **Bilanz-Scores im Dossier** (Piotroski, Altman-Z, DCF-Näherung) aus SEC EDGAR, optional Alpha Vantage – via täglicher GitHub Action, schlüsselfrei
- **Fundamentaldaten** (KGV, PEG, Margen, ROE, Verschuldung, Beta, Analystenkursziel) täglich serverseitig geholt und als `data/fundamentals.json` ausgeliefert – im Browser ohne Netzwerkweg sofort verfügbar

- **Bewertungsmodell als .xlsx** je Titel (DCF, WACC, Multiplikatoren, Sensitivität) mit echten Formeln, öffnet in Numbers

## Aufbau

`index.html` (Grundgerüst) · `styles.css` (Aussehen) · `app.js` (Analyse, Suche, Dossier, Nachrichten) · `depot.js` (Depot)

## Woher die Daten kommen

Die Seite läuft ohne eigenen Server. Das schränkt ein, welche Quellen überhaupt
in Frage kommen – die folgende Aufteilung ist die Antwort darauf.

| Daten | Weg | Warum so |
|---|---|---|
| Kurse, Charts, Suche | Yahoo, im Browser über einen Zwischenweg | Yahoo sendet keine CORS-Kopfzeilen. Ein direkter Aufruf aus der Seite wird vom Browser verworfen, ein Zwischenweg ist deshalb Pflicht. |
| Bilanzdaten (Umsatz, Eigenkapital, Cashflow) | `data.sec.gov`, täglich per GitHub Action | Amtliche XBRL-Daten, schlüsselfrei, auch für 20-F-Einreicher wie SAP oder Toyota. |
| Marktkennzahlen (KGV, PEG, Beta, Kursziel) | stockanalysis.com, täglich per GitHub Action | Yahoos `quoteSummary` verlangt seit 2024 ein Cookie-und-Crumb-Paar. Über einen CORS-Zwischenweg ist das nicht erfüllbar; der Aufruf endet mit „Invalid Crumb". |

Gelesen wird die Seite mit **Scrapling** (`requirements.txt`) – und zwar entlang
der Tabellenstruktur, nicht per Textsuche. Der Unterschied ist nicht kosmetisch:
Begriffe wie „Market Cap" oder „Revenue" stehen bei der Quelle auch in der
Navigation. Eine Textsuche trifft die zuerst und trägt still den falschen Wert
ein, während eine Zeile aus `<tr>` mit zwei `<td>` eindeutig ist. Nebenbei
liefert derselbe Durchgang fünf Kennzahlen mehr (P/FCF, EV/EBIT, Debt/EBITDA,
Insider- und Institutionenanteil).

Bewusst **ohne** das Extra `[fetchers]`: Das zöge curl_cffi und eine komplette
Browser-Engine nach. Beide Quellen antworten auf gewöhnliche Anfragen, der
Abruf läuft über die Standardbibliothek – das hält die tägliche Action leicht.
| Nachrichten | RSS, stündlich per GitHub Action | Unabhängig von der Kursquelle. |

**Zwischenwege für Kursdaten.** Die Liste steht in `app.js` unter `PROXIES`, der
erste erfolgreiche wird für die Sitzung gemerkt. Solche Gratisdienste
verschwinden erfahrungsgemäß ohne Vorwarnung – bei der letzten Prüfung
verlangte corsproxy.io einen bezahlten Tarif (HTTP 403), allorigins und codetabs
antworteten mit 502 bzw. 522. Wenn alle Wege scheitern, ist das der erste Ort
zum Nachsehen: ein weiterer Eintrag in `PROXIES` genügt, es braucht keine
Änderung an der Logik.

**Watchlist der Fundamentaldaten.** Welche Titel täglich geholt werden, steht in
`scripts/fundamentals_watchlist.txt` – eine Zeile je Ticker. Diese Liste liegt
bewusst getrennt vom Depot: sie ist öffentlich, das Depot bleibt lokal.

**Titel außerhalb der Watchlist.** Für sie holt die Seite die Kennzahlen beim
Öffnen live nach – dieselbe Quelle, nur über den Zwischenweg und in Textform
(rund 6 KB statt 200 KB HTML). Damit hat praktisch jeder Titel der Datenbank
einen Qualitäts-Score, nicht nur die sechzehn aus der Watchlist. Ergebnisse
werden zwölf Stunden zwischengespeichert; die Watchlist bleibt trotzdem
sinnvoll, weil ihre Titel ohne jede Wartezeit da sind.

**Kein Rückfall mehr auf Yahoos `quoteSummary`.** Der Baustein verlangt ein
Cookie-und-Crumb-Paar, das ein CORS-Zwischenweg nicht mitliefern kann – die
Antwort lautet ausnahmslos „Invalid Crumb". Er konnte also nie etwas beitragen,
kostete aber bei jedem nicht auffindbaren Titel zwei Hosts mal fünf
Zwischenwege an Wartezeit. Ohne ihn steht ein Fehlschlag nach unter einer
Sekunde fest statt nach einer Minute.

**Depot-Vergleich braucht ein Kaufdatum.** Der Vergleich gegen den Welt-Index
erscheint nur, wenn bei allen Positionen ein „gehalten seit" eingetragen ist.
Ohne dieses Datum ist der Haltezeitraum unbekannt – die eigene Rendite liefe
seit Einstand, die des Index über ein festes Fenster. Solche Zahlen lassen sich
nicht voneinander abziehen, deshalb steht dort ein Hinweis statt einer
Vergleichszahl. Mit Kaufdatum werden zwei Endbeträge verglichen: dein Depot
gegen dieselben Beträge zu denselben Zeitpunkten im Index.

**Wann kein DCF gerechnet wird.** Für zwei Gruppen trägt eine Cashflow-Bewertung
methodisch nicht, dort erscheint statt einer Zahl eine Begründung:

- **Banken, Versicherer, Immobiliengesellschaften** – erkannt am SIC-Schlüssel der
  SEC (6000–6499, 6500–6599, 6798). Zins- und Kreditgeschäft ist dort operatives
  Geschäft, freier Cashflow sagt nichts. Bewusst nicht nach Sektorname: Visa steht
  in der Ticker-Datenbank unter „Financials", ist aber ein Zahlungsdienstleister
  mit ganz normalem Cashflow – der SIC-Schlüssel trennt sauber (JPMorgan 6021,
  Visa 7389).
- **Konzerne mit eigener Finanzsparte** (Toyota, VW) – erkannt daran, dass
  Zinsaufwand und ausgewiesene Schuld nicht zusammenpassen. Bei Toyota ergäbe sich
  ein impliziter Zinssatz von 15,5 %, weil der Großteil der Autobank-Schulden in
  kurzfristigen Posten steht und in der Bilanzzeile fehlt. Der Zinsaufwand voll
  zurückrechnen, aber nur die langfristige Schuld abziehen – das wäre einseitig.

**Cashflow vor Fremdkapitalkosten.** Der ausgewiesene freie Cashflow ist nach
Zinsen. Das Modell zinst mit dem WACC ab und zieht danach die Nettoverschuldung
ab; ohne Rückrechnung der Zinsen nach Steuern trüge die Schuld zweimal.

**Abzinsung zur Jahresmitte.** Cashflows fallen über das Jahr verteilt an, nicht
gebündelt am 31.12. Abgezinst wird deshalb über 0,5 / 1,5 / 2,5 Jahre.

**Woher die Zahlen im Bewertungsmodell kommen – und wie du sie prüfst.**
Die Mappe trennt Eingaben strikt vom Rechenweg: **blau** = Eingabe, **schwarz** =
Formel, **grün** = Verweis auf ein anderes Blatt, **gelb hinterlegt** = Annahme,
die du prüfen solltest. Jede abgeleitete Zelle ist eine echte Excel-Formel –
änderst du eine Annahme, rechnet alles neu.

Zwei eingebaute Kontrollen:

- Das Blatt **„Suche"** listet für jeden Eingabewert die Zielzelle, den genauen
  Fundort (Navigationspfad bei TradingView), das erwartete Format und einen
  Hinweis auf die häufigste Falle. Die letzte Spalte prüft sich selbst:
  `=IF(Annahmen!B5="";"→ fehlt";"ok")`.
- Die **Übersicht** zählt daraus zusammen: „Noch offen: N von 14 Werten."

**Währungsprobe.** Die SEC-Bilanz steht in der Berichtswährung des Konzerns, die
Kursdaten in der Währung der Notierung. Bei US-Unternehmen ist das dasselbe, bei
Auslandseinreichern nicht – Toyota berichtet in JPY, der Hinterlegungsschein
notiert in USD. Passt beides nicht zusammen, bleiben die Bilanzposten leer und
gelb statt in falscher Währung gefüllt zu werden.

**Zwei Grenzen, die man kennen sollte.**
Erstens deckt stockanalysis.com nicht jede Notierung ab; wo eine US-Notierung
existiert (z. B. `NVO` statt `NOVO-B.CO`), ist sie der zuverlässigere Eintrag.
Zweitens sind Kursziele währungsbehaftet: die Watchlist führt `SAP`, das ist der
US-Hinterlegungsschein in USD. Wer `SAP.DE` in Euro ansieht, bekommt deshalb
kein Kursziel angezeigt – lieber keine Zahl als eine aus der falschen Währung.
Verhältniszahlen wie KGV oder ROE sind davon nicht betroffen und gelten für
beide Notierungen.
