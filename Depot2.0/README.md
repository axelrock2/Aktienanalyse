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

## Aufbau

`index.html` (Grundgerüst) · `styles.css` (Aussehen) · `app.js` (Analyse, Suche, Dossier, Nachrichten) · `depot.js` (Depot)
