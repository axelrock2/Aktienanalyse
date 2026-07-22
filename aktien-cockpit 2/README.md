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
- Ticker-Datenbank aktualisiert sich wöchentlich per GitHub Action

**Einrichtung:** siehe [ANLEITUNG.md](ANLEITUNG.md)

**Hinweis:** Reines Informationswerkzeug, keine Anlageberatung. Kursdaten i. d. R. 15 Minuten verzögert, ohne Gewähr.
