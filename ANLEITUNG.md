# Einrichtung des Aktien-Cockpits – Schritt für Schritt

Dauer: ca. 10–15 Minuten. Du brauchst nur deinen Browser und deinen GitHub-Account.
Es muss nichts installiert und keine Zeile Code geschrieben werden.

---

## Schritt 1 – Neues Repository anlegen

1. Melde dich auf **github.com** an.
2. Klicke oben rechts auf **+** → **New repository**.
3. Bei **Repository name** eingeben: `aktien-cockpit` (oder ein Name deiner Wahl).
4. Sichtbarkeit: **Public** auswählen (nötig für kostenloses GitHub Pages).
5. Alle Häkchen (README, .gitignore, license) **leer lassen**.
6. Klicke **Create repository**.

## Schritt 2 – Dateien hochladen

1. Auf der Seite des neuen Repositories: Link **„uploading an existing file"** anklicken
   (alternativ: Button **Add file** → **Upload files**).
2. Entpacke die gelieferte ZIP-Datei auf deinem Rechner.
3. Ziehe **den kompletten Inhalt** des entpackten Ordners in das Upload-Feld:
   - `index.html`
   - den Ordner `data` (enthält `tickers.json`)
   - den Ordner `scripts` (enthält `build_tickers.py`)
   - `README.md` und diese `ANLEITUNG.md`
   - Wichtig: Ordner als Ganzes hineinziehen, dann bleibt die Struktur erhalten.
4. Unten bei „Commit changes" einfach auf **Commit changes** klicken.

> Hinweis: Der versteckte Ordner `.github` lässt sich per Drag & Drop oft nicht
> mitziehen (Betriebssysteme blenden ihn aus). Deshalb legen wir ihn in
> Schritt 4 direkt auf GitHub an – das ist reines Kopieren und Einfügen.

## Schritt 3 – GitHub Pages aktivieren (die Website einschalten)

1. Im Repository oben auf **Settings** klicken.
2. Links im Menü auf **Pages**.
3. Unter **Build and deployment** → **Source**: „Deploy from a branch" wählen.
4. Bei **Branch**: `main` und Ordner `/ (root)` auswählen → **Save**.
5. Nach 1–2 Minuten erscheint oben die Adresse deiner Seite:
   `https://DEIN-BENUTZERNAME.github.io/aktien-cockpit/`
   Diese Adresse kannst du als Lesezeichen speichern – das ist dein Cockpit.

## Schritt 4 – Wöchentliche Aktualisierung der Ticker-Datenbank einrichten

Die Suche funktioniert bereits mit der mitgelieferten Datenbank. Damit sie
automatisch aktuell bleibt, richten wir eine kleine Automatik ein:

1. Im Repository: **Add file** → **Create new file**.
2. In das Feld für den Dateinamen exakt eintippen:
   `.github/workflows/tickers.yml`
   (GitHub legt die Ordner beim Tippen der Schrägstriche automatisch an.)
3. Öffne aus dem gelieferten Paket die Datei `WORKFLOW-INHALT.txt`,
   kopiere den **gesamten Inhalt** und füge ihn in das große Textfeld ein.
4. **Commit changes** klicken.
5. Oben auf den Reiter **Actions** klicken. Falls ein grüner Button
   „I understand my workflows, go ahead and enable them" erscheint: anklicken.
6. Test: Links „Ticker-Datenbank aktualisieren" anklicken → rechts
   **Run workflow** → **Run workflow**. Nach ca. 1–2 Minuten sollte ein
   grüner Haken erscheinen. Ab jetzt läuft das jeden Montag automatisch.

## Schritt 5 – Benutzung

- **Suchen:** Oben in das Suchfeld tippen – Name („Toyota"), Ticker („NVDA")
  oder Ticker mit Börsenkürzel („SAP.DE", „7203.T"). Vorschläge erscheinen
  sofort aus der lokalen Datenbank; nach einem kurzen Moment ergänzt die
  Online-Suche seltene Titel.
- **Favorit hinzufügen:** In der Vorschlagsliste auf **+** klicken – der Titel
  erscheint sofort auf dem Dashboard. Entfernen über das **✕** auf der Karte.
- **Details:** Klick auf eine Karte öffnet die Analyse: Einstiegs-/Ausstiegs­zonen,
  Timing- und Qualitäts-Score mit Einzelkomponenten, Chart mit gleitenden
  Durchschnitten (50/200 Tage) und Kennzahlen.
- Favoriten werden **nur in deinem Browser** gespeichert (kein Konto nötig).
  Auf einem anderen Gerät oder nach dem Löschen der Browserdaten beginnt die
  Liste leer.

## Newsfeed einrichten (zweite GitHub Action)

Der Bereich **„Markt & Wirtschaft"** über deinen Favoriten wird von einer eigenen
Action gefüllt. Sie holt die Schlagzeilen stündlich **auf GitHubs Servern** ab –
dadurch braucht der Browser keine Umwege über fremde Zwischendienste, und der
Newsfeed funktioniert auch dann, wenn die Kursquelle gerade hakt.

1. Im Repository: **Add file** → **Create new file**
2. Dateiname exakt: `.github/workflows/news.yml`
3. Inhalt der beigelegten Datei `WORKFLOW-NEWS-INHALT.txt` vollständig einfügen
4. **Commit changes**
5. Reiter **Actions** → links „Nachrichten aktualisieren" → rechts **Run workflow**

Nach ein bis zwei Minuten entsteht `data/news.json`, und der Feed erscheint beim
nächsten Neuladen. Danach läuft er stündlich von allein. Solange die Datei fehlt,
zeigt das Cockpit an dieser Stelle einen entsprechenden Hinweis – das ist kein Fehler.

**Bedienung:** Über die Chips filterst du nach Zentralbanken, Konjunktur, Märkten,
Unternehmen oder Rohstoffen. Der gestrichelte Chip **„Meine Favoriten"** zeigt nur
Meldungen, in deren Überschrift ein Unternehmen aus deiner Watchlist vorkommt
(Abgleich über Firmenname und Ticker); solche Treffer sind auch in der Gesamtliste
farbig markiert. Über **Einklappen** verschwindet der Bereich, wenn du ihn nicht
brauchst – die Einstellung merkt sich der Browser.

Angezeigt werden ausschließlich Überschrift, Quelle, Zeitpunkt und Link – keine
Artikeltexte, aus urheberrechtlichen Gründen. Der Klick führt zur Originalquelle.

**Wenn eine Quelle nicht erscheint:** Unter der Liste steht, welche Feeds geliefert
haben und welche nicht erreichbar waren. Nicht erreichbare Quellen werden einfach
übersprungen. Du kannst die Liste in `scripts/build_news.py` (Abschnitt `FEEDS`)
jederzeit selbst erweitern oder kürzen – ebenso den Takt in der Workflow-Datei
(`cron`), falls dir stündlich zu häufig oder zu selten ist.

## Anzeigewährung umstellen

Oben rechts im Kopfbereich findest du den Umschalter **Original / EUR / USD**.

- **Original:** Jede Aktie in der Währung ihrer Heimatbörse (Toyota in Yen, SAP in Euro,
  AstraZeneca in Pfund usw.).
- **EUR / USD:** Alle Beträge werden zur besseren Vergleichbarkeit umgerechnet – Kurs,
  Einstiegszone, Stop, Kursziele, 52-Wochen-Spanne, Marktkapitalisierung.

**Wichtig – die Ergebnisse ändern sich dadurch nicht.** Umgerechnet wird ausschließlich
die *Anzeige*, und zwar mit einem einzigen aktuellen Wechselkurs. Sämtliche Berechnungen
(Renditen, RSI, Momentum, relative Stärke, Sharpe, Drawdown, alle Scores und das
Chance-Risiko-Verhältnis) laufen unverändert mit den Originalkursen. In der Detailansicht
wird der verwendete Wechselkurs transparent eingeblendet.

Der Grund für dieses Vorgehen: Würde man die *Kurshistorie* Tag für Tag mit den damaligen
Wechselkursen umrechnen, steckte plötzlich die Euro/Dollar-Bewegung in jeder Rendite und
alle Indikatoren würden sich verändern. Das wäre eine Verfälschung – deshalb bleibt die
Analyse strikt in der Originalwährung.

Bei Londoner Aktien beachtet das Cockpit automatisch, dass Kurse dort in Penny (GBp)
statt in Pfund notieren. Die Einstellung wird im Browser gespeichert.

## Das Analyse-Dossier

In der Detailansicht jedes Titels findest du den Button **„Analyse-Dossier erstellen"**.
Er baut einen strukturierten 16-Phasen-Bericht nach institutionellem Vorbild –
mit einer wichtigen Ehrlichkeit: Jede Sektion ist gekennzeichnet, woher ihr Inhalt stammt.

- **GERECHNET** (grün): aus echten Kurs- und Kennzahlendaten berechnet – z. B. Sharpe,
  Sortino, Maximum Drawdown, Value-at-Risk, Beta, Faktor-Scores, technische Indikatoren.
- **ABGERUFEN** (blau): live von der Datenquelle geholt – Analystenkonsens, Kursziele,
  Eigentümerstruktur, nächster Quartalstermin, aktuelle Schlagzeilen.
- **DEINE EINSCHÄTZUNG** (gelb): bewusst *nicht* automatisch ausgefüllt – Makro, Branche,
  Managementqualität, Investmentthese, Devil's Advocate. Hier liegen die relevanten Fakten
  schon bereit, das Urteil triffst du selbst.

Sektionen, die verlässliche Mehrjahres-Bilanzdaten bräuchten (Piotroski-, Altman-,
Beneish-Score, DCF), bleiben absichtlich offen statt mit Schätzwerten gefüllt zu werden –
so entsteht kein falscher Eindruck von Präzision. Über **„Drucken / als PDF"** lässt sich
das Dossier sauber als PDF sichern.

Das Dossier ist ein Recherche- und Strukturierungswerkzeug, **keine Anlageberatung**.

## Wenn etwas hakt

| Problem | Lösung |
|---|---|
| Karte zeigt „Kursdaten gerade nicht erreichbar" | Auf **Erneut versuchen** klicken. Die freien Datenwege haben gelegentlich kurze Aussetzer; das Cockpit probiert automatisch mehrere Wege durch. |
| Qualitäts-Score zeigt „n. v." | Fundamentaldaten sind für diesen Titel gerade nicht abrufbar. Timing-Score und Zonen funktionieren trotzdem. Später erneut öffnen. |
| Seite zeigt 404 | Schritt 3 prüfen (Branch `main`, Ordner `/ (root)`), 2 Minuten warten, neu laden. |
| Suche findet einen exotischen Titel nicht | Ticker mit Börsenkürzel direkt eingeben (z. B. `.DE` Xetra, `.T` Tokio, `.HK` Hongkong, `.KS` Korea) – die Online-Suche hilft zusätzlich. |
| Newsfeed bleibt leer | Action „Nachrichten aktualisieren" im Reiter **Actions** einmal manuell starten; prüfen, ob `.github/workflows/news.yml` korrekt angelegt wurde. |
| Alte Kurse werden angezeigt | Kurse werden 10 Minuten zwischengespeichert. Seite neu laden genügt. |

Viel Erfolg bei der Analyse!
