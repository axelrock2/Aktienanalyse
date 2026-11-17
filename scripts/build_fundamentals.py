#!/usr/bin/env python3
"""Erzeugt data/fundamentals.json mit Bilanzkennzahlen fuer das Dossier.

Quellen:
  1. SEC EDGAR (schluesselfrei) – deckt US-Unternehmen und grosse auslaendische
     Konzerne ab, die ein Form 20-F einreichen (SAP, Toyota, ASML, AstraZeneca ...).
     Die Bilanzdaten kommen von data.sec.gov; die Ticker-Tabelle liegt auf
     www.sec.gov und wird von dort teilweise blockiert (HTTP 403) – deshalb die
     Fallback-Kette in build_ticker_cik().
  2. stockanalysis.com (schluesselfrei) – liefert die Marktkennzahlen, die in
     der XBRL-Bilanz nicht stehen: KGV, PEG, Beta, Analystenkursziel,
     Dividendenrendite. Ersetzt den Yahoo-quoteSummary-Aufruf, der seit der
     Crumb-Pflicht serverseitig nicht mehr nutzbar ist.
  3. Alpha Vantage (optional, via Umgebungsvariable ALPHAVANTAGE_KEY als
     GitHub-Secret) – ergaenzt normalisierte US-Kennzahlen. Ohne Schluessel
     wird dieser Schritt stillschweigend uebersprungen.

Die Titel-Liste kommt aus scripts/fundamentals_watchlist.txt (ein Ticker je
Zeile). Diese Liste liegt bewusst getrennt, damit sie KEINE Depotdaten enthaelt –
sie darf ins oeffentliche Repository, ein Depot darf es nicht.

Aufruf:
    python3 scripts/build_fundamentals.py
"""
import gzip
import datetime
import json
import os
import re
import time
import urllib.request
import urllib.error

import dcf_core
import market_source

HERE = os.path.dirname(__file__)
WATCHLIST = os.path.join(HERE, "fundamentals_watchlist.txt")
TARGET = os.path.join(HERE, "..", "data", "fundamentals.json")
CIKCACHE = os.path.join(HERE, "..", "data", "cik_map.json")

# Die SEC verlangt laut eigener Richtlinie einen aussagekraeftigen User-Agent mit
# Kontaktangabe - deshalb steht dieser zuerst. Ihr Edge-Server weist ihn aber je
# nach Herkunftsnetz mit HTTP 403 ab; dann wird UA_ERSATZ nachgeschoben.
# gzip ist kein Beiwerk: companyfacts ist je Titel 3,8 MB gross, gepackt 0,3 MB.
UA = {
    "User-Agent": "AktienCockpit axelrock2@users.noreply.github.com",
    "Accept": "application/json",
    "Accept-Encoding": "gzip",
}
UA_ERSATZ = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "application/json",
    "Accept-Encoding": "gzip",
    "Accept-Language": "en-US,en;q=0.9",
}
AV_KEY = os.environ.get("ALPHAVANTAGE_KEY", "").strip()

TICKERMAP = "https://www.sec.gov/files/company_tickers.json"
FACTS = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"
# Traegt den SIC-Schluessel; daraus ergibt sich, ob eine Cashflow-DCF ueberhaupt passt.
SUBMISSIONS = "https://data.sec.gov/submissions/CIK{cik}.json"
# www.sec.gov beantwortet Anfragen aus Rechenzentren oft mit HTTP 403, waehrend
# data.sec.gov normal antwortet. Dieser oeffentliche Textleser holt die Datei
# stellvertretend; er ist nur fuer die Ticker-Tabelle noetig, nicht fuer die Daten.
TICKERMAP_LESER = "https://r.jina.ai/" + TICKERMAP


def _lies(antwort):
    """Antwort auspacken - bei Accept-Encoding: gzip kommt sie gepackt."""
    roh = antwort.read()
    if antwort.headers.get("Content-Encoding") == "gzip":
        roh = gzip.decompress(roh)
    return roh.decode("utf-8", "replace")


def http_json(url, headers=None, tries=3):
    """JSON holen. Bei HTTP 403 einmal mit dem Ersatz-User-Agent nachfassen:
       data.sec.gov beantwortet denselben Aufruf je nach Kopfzeile 403 oder 200."""
    koepfe = [headers or UA]
    if headers is None:
        koepfe.append(UA_ERSATZ)

    for kopf in koepfe:
        for i in range(tries):
            try:
                req = urllib.request.Request(url, headers=kopf)
                with urllib.request.urlopen(req, timeout=45) as r:
                    return json.loads(_lies(r))
            except urllib.error.HTTPError as e:
                if e.code == 429:            # zu schnell -> warten
                    time.sleep(2 + i * 2)
                    continue
                if e.code == 404:
                    return None
                if e.code == 403:            # Kopfzeile abgelehnt -> naechster UA
                    break
                if i == tries - 1:
                    print(f"    HTTP {e.code} bei {url[:70]}")
                    return None
                time.sleep(1 + i)
            except Exception as e:
                if i == tries - 1:
                    print(f"    Fehler: {e}")
                    return None
                time.sleep(1 + i)
    print(f"    HTTP 403 (auch mit Ersatz-Kopfzeile) bei {url[:70]}")
    return None


def load_watchlist():
    if not os.path.exists(WATCHLIST):
        print(f"Keine Watchlist unter {WATCHLIST} – nichts zu tun.")
        return []
    out = []
    for line in open(WATCHLIST, encoding="utf-8"):
        t = line.strip().upper()
        if t and not t.startswith("#"):
            # Nur das Basissymbol vor einem etwaigen Boersenkuerzel (SAP.DE -> SAP)
            out.append(t.split(".")[0])
    # Duplikate entfernen, Reihenfolge wahren
    seen, uniq = set(), []
    for t in out:
        if t not in seen:
            seen.add(t)
            uniq.append(t)
    return uniq


def http_text(url, headers=None, tries=2):
    """Rohtext holen (fuer den Textleser-Umweg, der Markdown drumherum legt)."""
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers or UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            if i == tries - 1:
                print(f"    Fehler: {e}")
                return None
            time.sleep(2)
    return None


def _mapping_aus_rohdaten(data):
    """SEC-Format {'0': {'cik_str': 320193, 'ticker': 'AAPL', ...}} -> flache Karte."""
    m = {}
    for row in (data or {}).values():
        try:
            m[str(row["ticker"]).upper()] = str(row["cik_str"]).zfill(10)
        except (KeyError, TypeError):
            continue
    return m


def build_ticker_cik():
    """Ticker->CIK in drei Stufen: direkt, ueber Textleser, aus der Sicherung.

    Stufe 1 ist der offizielle Weg. Wird sie mit HTTP 403 abgewiesen - das
    passiert bei www.sec.gov regelmaessig aus Rechenzentren -, greift Stufe 2.
    Stufe 3 ist die letzte Sicherung: CIK-Nummern aendern sich nie, eine einmal
    geholte Karte bleibt also gueltig. Jede erfolgreiche Stufe schreibt die
    Sicherung neu, damit der Lauf sich selbst heilt.
    """
    print("Lade SEC Ticker->CIK-Mapping ...")

    # Stufe 1: direkt bei der SEC
    m = _mapping_aus_rohdaten(http_json(TICKERMAP, tries=2))
    if m:
        print(f"  {len(m)} Ticker (direkt von der SEC)")
        _sicherung_schreiben(m)
        return m

    # Stufe 2: derselbe Inhalt ueber einen oeffentlichen Textleser
    print("  Direktzugriff abgewiesen - versuche Textleser ...")
    roh = http_text(TICKERMAP_LESER, headers={**UA, "x-respond-with": "text"})
    if roh:
        i = roh.find("{")
        if i >= 0:
            try:
                m = _mapping_aus_rohdaten(json.loads(roh[i:]))
            except ValueError:
                m = {}
        if m:
            print(f"  {len(m)} Ticker (ueber Textleser)")
            _sicherung_schreiben(m)
            return m

    # Stufe 3: mitgelieferte Sicherung im Repository
    pfad = os.path.abspath(CIKCACHE)
    if os.path.exists(pfad):
        try:
            with open(pfad, encoding="utf-8") as fh:
                m = json.load(fh)
            if isinstance(m, dict) and m:
                print(f"  {len(m)} Ticker (aus Sicherung {os.path.basename(pfad)})")
                return m
        except Exception as e:
            print(f"  Sicherung unlesbar: {e}")

    print("  Mapping auf keinem Weg erreichbar.")
    return {}


def _sicherung_schreiben(m):
    """Karte fuer kuenftige Laeufe ablegen - naechstes Mal genuegt Stufe 3."""
    try:
        pfad = os.path.abspath(CIKCACHE)
        os.makedirs(os.path.dirname(pfad), exist_ok=True)
        with open(pfad, "w", encoding="utf-8") as fh:
            json.dump(m, fh, separators=(",", ":"), sort_keys=True)
    except Exception as e:
        print(f"    Sicherung nicht geschrieben: {e}")


def _reihen(facts, tags, waehrung=None):
    """Alle Zahlenreihen sammeln, die zu einem der Tags passen.

    Wichtig: NICHT beim ersten gefundenen Tag stehenbleiben. Unternehmen wechseln
    ihre XBRL-Tags - Apple etwa meldet seit 2018 unter
    RevenueFromContractWithCustomerExcludingAssessedTax statt unter "Revenues".
    Der alte Tag bleibt mit den alten Zahlen in der Datenbank stehen. Wer den
    ersten Treffer nimmt, bekommt dadurch stillschweigend Zahlen von 2018.
    Deshalb: alles einsammeln und spaeter das Jahr entscheiden lassen.

    Gibt [(einheit, [fakten...]), ...] zurueck.
    """
    out = []
    for taxonomy in ("us-gaap", "ifrs-full"):
        block = facts.get("facts", {}).get(taxonomy, {})
        for tag in tags:
            node = block.get(tag)
            if not node:
                continue
            for einheit, serie in (node.get("units") or {}).items():
                if waehrung and einheit != waehrung:
                    continue
                if serie:
                    out.append((einheit, serie))
    return out


def haupt_waehrung(facts):
    """Berichtswaehrung bestimmen. Toyota meldet in JPY, SAP in EUR.

    Ohne diese Pruefung landen JPY-Umsaetze neben USD-Kurszielen im gleichen
    Datensatz - die DCF-Rechnung liefert dann sinnlose (teils negative) Werte.
    """
    zaehler = {}
    for tag in ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
                "Assets", "NetIncomeLoss", "ProfitLoss"):
        for taxonomy in ("us-gaap", "ifrs-full"):
            node = facts.get("facts", {}).get(taxonomy, {}).get(tag)
            if not node:
                continue
            for einheit, serie in (node.get("units") or {}).items():
                if len(einheit) == 3:          # Waehrungen sind dreibuchstabig
                    zaehler[einheit] = zaehler.get(einheit, 0) + len(serie)
    if not zaehler:
        return None
    return max(zaehler, key=zaehler.get)


# Ein Geschaeftsjahr darf zwischen diesen Tagen lang sein. 52/53-Wochen-Jahre
# und verschobene Stichtage fallen in die Spanne, ein Quartal nicht.
JAHR_MIN_TAGE, JAHR_MAX_TAGE = 300, 400


def _periodentage(x):
    """Laenge der Berichtsperiode in Tagen, oder None bei Stichtagswerten.

    Bestandsgroessen wie die Bilanzsumme haben nur 'end' - sie gelten zum
    Stichtag und haben keine Dauer. Stromgroessen wie Gewinn oder Cashflow
    haben 'start' und 'end'.
    """
    start, ende = x.get("start"), x.get("end")
    if not start or not ende:
        return None
    try:
        return (datetime.date.fromisoformat(ende) - datetime.date.fromisoformat(start)).days
    except ValueError:
        return None


def _jahresfakten(serie):
    """Nur Jahresabschluesse, je Geschaeftsjahr der zuletzt eingereichte Wert.

    Zwei Faelle, die hier frueher falsch liefen:

    1. Ein 10-K enthaelt fuer Stromgroessen nicht nur das Jahr, sondern auch
       das vierte Quartal. Beide enden am selben Bilanzstichtag. Die Regel
       "spaetestes Enddatum gewinnt" griff dann je nach Reihenfolge das
       Quartal ab. Bei Microsoft stand so fuer 2017 ein Gewinn von minus
       6,3 Milliarden statt der tatsaechlichen 21,2 - und dieser Wert ging in
       den Piotroski-Vergleich und in den Zehnjahresschnitt ein. Deshalb
       zaehlt bei Stromgroessen jetzt die Periodenlaenge.

    2. Wird ein Jahr spaeter neu ausgewiesen, stehen zwei Fakten mit demselben
       Stichtag in der Datei. Massgeblich ist der zuletzt EINGEREICHTE - das
       ist die Korrektur, nicht die urspruengliche Meldung.
    """
    proJahr = {}
    for x in serie:
        if x.get("form") not in ("10-K", "20-F", "40-F"):
            continue
        ende = x.get("end")
        if not ende or x.get("val") is None:
            continue
        tage = _periodentage(x)
        if tage is not None and not (JAHR_MIN_TAGE <= tage <= JAHR_MAX_TAGE):
            continue                   # Quartal oder Halbjahr - kein Jahreswert
        jahr = ende[:4]
        schluessel = (x.get("filed") or "", ende)
        vorher = proJahr.get(jahr)
        if vorher is None or schluessel > vorher[0]:
            proJahr[jahr] = (schluessel, ende, x["val"])
    return {j: (v[1], v[2]) for j, v in proJahr.items()}


def latest_val(facts, tags, unit_hint="USD"):
    """Neuesten Wert ueber ALLE passenden Tags hinweg holen.

    unit_hint ist die Berichtswaehrung des Unternehmens (nicht pauschal USD),
    damit nicht zwei Waehrungen im selben Datensatz landen.
    """
    bester = None                      # (stichtag, wert)
    for einheit, serie in _reihen(facts, tags, unit_hint):
        for jahr, (ende, val) in _jahresfakten(serie).items():
            if bester is None or ende > bester[0]:
                bester = (ende, val)
    if bester:
        return bester[1]
    # Kein Jahresabschluss vorhanden: neuesten Zwischenwert nehmen
    bester = None
    for einheit, serie in _reihen(facts, tags, unit_hint):
        for x in serie:
            if x.get("end") and x.get("val") is not None:
                if bester is None or x["end"] > bester[0]:
                    bester = (x["end"], x["val"])
    return bester[1] if bester else None


def series_vals(facts, tags, unit_hint="USD", years=6):
    """Zeitreihe {Jahr: Wert} fuer Trendkennzahlen wie Piotroski.

    Auch hier werden alle Tag-Varianten zusammengefuehrt; bei Ueberschneidung
    gewinnt der zuletzt gemeldete Stichtag.
    """
    zusammen = {}                      # Jahr -> (stichtag, wert)
    for einheit, serie in _reihen(facts, tags, unit_hint):
        for jahr, (ende, val) in _jahresfakten(serie).items():
            vorher = zusammen.get(jahr)
            if vorher is None or ende > vorher[0]:
                zusammen[jahr] = (ende, val)
    if not zusammen:
        return {}
    jahre = sorted(zusammen.keys(), reverse=True)[:years]
    return {j: zusammen[j][1] for j in jahre}


# XBRL-Tags je Kennzahl (us-gaap und – wo abweichend – ifrs-full deckt latest_val ab)
TAGS = {
    "revenue": ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax",
                "SalesRevenueNet", "Revenue"],
    "netIncome": ["NetIncomeLoss", "ProfitLoss"],
    "totalAssets": ["Assets"],
    "totalLiabilities": ["Liabilities"],
    "currentAssets": ["AssetsCurrent"],
    "currentLiabilities": ["LiabilitiesCurrent"],
    "equity": ["StockholdersEquity", "Equity",
               "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
    "longTermDebt": ["LongTermDebtNoncurrent", "LongTermDebt"],
    "grossProfit": ["GrossProfit"],
    "operatingIncome": ["OperatingIncomeLoss", "ProfitLossFromOperatingActivities"],
    "cashFlowOps": ["NetCashProvidedByUsedInOperatingActivities",
                    "CashFlowsFromUsedInOperatingActivities"],
    "sharesOutstanding": ["CommonStockSharesOutstanding", "CommonStockSharesIssued"],
    "retainedEarnings": ["RetainedEarningsAccumulatedDeficit"],
    "ebit": ["OperatingIncomeLoss"],
    "capex": ["PaymentsToAcquirePropertyPlantAndEquipment",
              "PaymentsToAcquireProductiveAssets"],
    "cash": ["CashAndCashEquivalentsAtCarryingValue",
             "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents"],
    "interestExpense": ["InterestExpense", "InterestAndDebtExpense"],
}


# ---------------------------------------------------------------------------
# Zyklusbereinigtes KGV nach Shiller - die Gewinnseite
# ---------------------------------------------------------------------------
CPI_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=CPIAUCSL"
CAPE_JAHRE = 10
CAPE_MIN = 5


def hole_cpi():
    """Jahresmittel des US-Verbraucherpreisindex von der FRED.

    Serverseitig geholt, weil die FRED keinen CORS-Kopf setzt - aus dem
    Browser waere die Datei nicht erreichbar. Ein Schluessel ist fuer den
    CSV-Weg nicht noetig.

    Rueckgabe {Jahr: Indexstand}. Faellt der Abruf aus, gibt es kein CAPE
    statt eines unbereinigten, das so tut als waere es eines.
    """
    # Bewusst OHNE eigene Kopfzeilen und nicht ueber http_text: Mit einem
    # gesetzten User-Agent - egal ob "AktienCockpit" oder eine Browserkennung -
    # nimmt die FRED die Verbindung an und antwortet nie; der Aufruf laeuft in
    # den Zeitablauf (gemessen: 59 und 69 Sekunden). Ohne Kopfzeile kommen
    # dieselben 17 KB in 0,1 Sekunden. http_text setzt immer einen UA, deshalb
    # hier der direkte Weg.
    try:
        with urllib.request.urlopen(CPI_URL, timeout=30) as r:
            txt = r.read().decode("utf-8", "replace")
    except Exception as e:
        print(f"    CPI nicht erreichbar: {e}")
        return None
    if not txt:
        return None
    summe, zahl = {}, {}
    for zeile in txt.splitlines()[1:]:
        teile = zeile.split(",")
        if len(teile) < 2:
            continue
        try:
            jahr = int(teile[0][:4])
            wert = float(teile[1])
        except ValueError:
            continue
        summe[jahr] = summe.get(jahr, 0.0) + wert
        zahl[jahr] = zahl.get(jahr, 0) + 1
    return {j: summe[j] / zahl[j] for j in summe if zahl[j] >= 6} or None


def cape_block(sec, cpi):
    """Inflationsbereinigter Gewinn der letzten Jahre - die Gewinnseite des CAPE.

    Shiller (1981) und Campbell/Shiller: Kurse schwanken weit staerker, als die
    spaeteren Gewinne rechtfertigen. Das CAPE glaettet den Konjunkturzyklus,
    indem es nicht am letzten Gewinn misst, sondern am Mittel von zehn Jahren -
    jedes auf heutige Kaufkraft gebracht.

    Gerechnet wird auf dem GESAMTGEWINN, nicht auf dem Gewinn je Aktie. Der
    Grund ist ein Aktiensplit: Nvidia teilte 2024 im Verhaeltnis 10:1. Die SEC
    meldet die Aktienzahl eines Geschaeftsjahres so, wie sie damals war - der
    Gewinn je Aktie springt dadurch von 12,08 auf 2,98, ohne dass sich am
    Unternehmen etwas geaendert haette. Ein Mittelwert ueber solche Zahlen ist
    wertlos. Gesamtgewinn und Marktkapitalisierung sind beide Aggregate und
    gegen Splits unempfindlich; solange die Aktienzahl konstant ist, ist
    Marktwert/Gesamtgewinn genau dasselbe wie Kurs/Gewinn je Aktie.

    Hier entsteht nur die Gewinnseite. Den Marktwert legt die Oberflaeche an,
    weil er sich taeglich aendert und diese Datei nur einmal am Tag entsteht.
    """
    if not cpi:
        return None
    ser = (sec or {}).get("_series") or {}
    gewinne = ser.get("netIncome") or {}
    if not gewinne:
        return None

    basis = max(cpi)                       # heutige Kaufkraft als Bezugsjahr
    jahre = []
    for j_str, gewinn in gewinne.items():
        try:
            jahr = int(j_str)
        except (TypeError, ValueError):
            continue
        if gewinn is None:
            continue
        index = cpi.get(jahr) or cpi.get(jahr - 1)
        if not index:
            continue
        jahre.append({
            "jahr": jahr,
            "gewinn": gewinn,
            "gewinnReal": round(gewinn * cpi[basis] / index),
        })

    jahre.sort(key=lambda x: x["jahr"], reverse=True)
    jahre = jahre[:CAPE_JAHRE]
    if len(jahre) < CAPE_MIN:
        return None
    mittel = sum(x["gewinnReal"] for x in jahre) / len(jahre)
    if mittel <= 0:
        # Ein negativer Zehnjahresschnitt ergibt ein negatives CAPE - eine Zahl,
        # die wie eine Bewertung aussieht und keine ist. Dann lieber keine.
        return None
    verlustjahre = sum(1 for x in jahre if x["gewinn"] < 0)
    return {
        "reihe": jahre,
        "gewinnRealMittel": round(mittel),
        "jahre": len(jahre),
        "vollstaendig": len(jahre) >= CAPE_JAHRE,
        "verlustjahre": verlustjahre,
        "basisjahr": basis,
        "waehrung": (sec or {}).get("waehrung") or "USD",
        "quelle": "SEC EDGAR, inflationsbereinigt mit FRED CPIAUCSL",
    }


def from_sec(cik):
    facts = http_json(FACTS.format(cik=cik))
    if not facts:
        return None
    waehrung = haupt_waehrung(facts) or "USD"
    out = {"source": "SEC EDGAR", "waehrung": waehrung,
           "entityName": facts.get("entityName")}

    # Branchenschluessel holen - entscheidet spaeter, ob ein DCF gerechnet wird
    stamm = http_json(SUBMISSIONS.format(cik=cik), tries=2) or {}
    if stamm.get("sic"):
        out["sic"] = stamm.get("sic")
        out["sicText"] = stamm.get("sicDescription")
    for key, tags in TAGS.items():
        v = latest_val(facts, tags, unit_hint=waehrung)
        if v is not None:
            out[key] = v
    # Anteile werden in Stueck gemeldet, nicht in Waehrung
    anteile = latest_val(facts, TAGS["sharesOutstanding"], unit_hint="shares")
    if anteile is not None:
        out["sharesOutstanding"] = anteile
    # Trendreihen fuer Piotroski/Beneish
    # Sechs Jahre reichen fuer Piotroski (Vorjahresvergleich, mit Reserve),
    # aber nicht fuer das zyklusbereinigte KGV: Shiller mittelt ueber zehn
    # Jahre. Die SEC haelt deutlich mehr vor - bei Apple 18 Jahre -, die
    # Grenze war allein das Argument years=6.
    JAHRE_KURZ, JAHRE_LANG = 6, 12
    out["_series"] = {
        "netIncome": series_vals(facts, TAGS["netIncome"], waehrung, JAHRE_LANG),
        "revenue": series_vals(facts, TAGS["revenue"], waehrung, JAHRE_KURZ),
        "cashFlowOps": series_vals(facts, TAGS["cashFlowOps"], waehrung, JAHRE_KURZ),
        "totalAssets": series_vals(facts, TAGS["totalAssets"], waehrung, JAHRE_KURZ),
        "longTermDebt": series_vals(facts, TAGS["longTermDebt"], waehrung, JAHRE_KURZ),
        "grossProfit": series_vals(facts, TAGS["grossProfit"], waehrung, JAHRE_KURZ),
        # Fuer die beiden Piotroski-Kriterien, die bisher fehlten: Current
        # Ratio und Verwaesserung. Beide Tags stehen laengst in TAGS, sie
        # wurden nur nie als Reihe mitgeschrieben - deshalb kam der F-Score
        # ueber sieben von neun Punkten nie hinaus.
        "currentAssets": series_vals(facts, TAGS["currentAssets"], waehrung, JAHRE_KURZ),
        "currentLiabilities": series_vals(facts, TAGS["currentLiabilities"], waehrung, JAHRE_KURZ),
        "equity": series_vals(facts, TAGS["equity"], waehrung, JAHRE_KURZ),
        # Aktienzahl in Stueck, nicht in Waehrung - sonst findet _reihen nichts.
        "sharesOutstanding": series_vals(facts, TAGS["sharesOutstanding"], "shares", JAHRE_LANG),
    }
    # Bilanzjahr mitschreiben, damit im Dossier sichtbar ist, wie alt die Zahlen sind
    jahre = [j for j in (out["_series"].get("revenue") or {})]
    if jahre:
        out["geschaeftsjahr"] = max(jahre)

    # Reicht die Datenlage ueberhaupt? Die Tickerliste der SEC zeigt bei einer
    # Umstrukturierung auf den neuen Registranten, der noch fast nichts
    # eingereicht hat: XOM zeigt auf "ExxonMobil Holdings Corporation" mit vier
    # bis acht Fakten je Kennzahl statt auf die Exxon Mobil Corporation. Ohne
    # diese Pruefung entsteht daraus ein Eintrag, der aussieht wie Daten und
    # keine enthaelt - mit 16 Titeln faellt das auf, mit 67 nicht mehr.
    gewinnjahre = len(out["_series"].get("netIncome") or {})
    if gewinnjahre < 2 or not out.get("totalAssets"):
        print(f"    zu duenne SEC-Daten ({gewinnjahre} Gewinnjahre) - verworfen")
        return None
    return out if len(out) > 4 else None


def from_alphavantage(ticker):
    if not AV_KEY:
        return None
    url = ("https://www.alphavantage.co/query?function=OVERVIEW"
           f"&symbol={ticker}&apikey={AV_KEY}")
    d = http_json(url, headers={"User-Agent": "Aktien-Cockpit"})
    if not d or "Symbol" not in d:
        return None

    def num(k):
        v = d.get(k)
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    keys = ["PERatio", "PEGRatio", "PriceToBookRatio", "EVToEBITDA", "ProfitMargin",
            "OperatingMarginTTM", "ReturnOnAssetsTTM", "ReturnOnEquityTTM",
            "DilutedEPSTTM", "Beta", "PriceToSalesRatioTTM", "EVToRevenue"]
    out = {"source": "Alpha Vantage"}
    for k in keys:
        v = num(k)
        if v is not None:
            out[k] = v
    return out if len(out) > 1 else None


def dcf_block(sec, av=None, markt=None):
    """Berechnet die DCF-Matrix aus den SEC-Daten eines Titels.

    Bewusst ohne Kurs: gespeichert wird die Matrix ueber ein festes
    WACC-Raster. Die Zuordnung zum aktuellen Kurs macht das Dashboard.
    """
    if not sec:
        return None

    # Geschaeftsmodelle, fuer die eine Cashflow-DCF nicht traegt, gar nicht
    # erst rechnen. Frueher stand dafuer eine Konstante UNGEEIGNETE_BRANCHEN
    # im Rechenkern, die nirgends abgefragt wurde - Banken bekamen also doch
    # ein Modell. JPMorgan entging dem nur zufaellig, weil sein operativer
    # Cashflow negativ ist; bei positivem waere eine sinnlose Zahl entstanden.
    ungeeignet, grund = dcf_core.dcf_ungeeignet(sec.get("sic"))
    if ungeeignet:
        return {"nicht_anwendbar": True, "grund": grund,
                "sic": sec.get("sic"), "branche": sec.get("sicText")}

    def mio(v):
        return None if v is None else v / 1e6

    cfo = mio(sec.get("cashFlowOps"))
    if not cfo or cfo <= 0:
        return None

    capex = mio(sec.get("capex"))
    if capex is not None:
        fcf0 = cfo - abs(capex)
        fcf_quelle = "Operativer Cashflow abzueglich Investitionen."
    else:
        fcf0 = cfo
        fcf_quelle = "Nur operativer Cashflow - keine Investitionsdaten."

    # Zinsen nach Steuern zurechnen. Der operative Cashflow ist bereits nach
    # Zinsen ausgewiesen; wer ihn mit dem WACC abzinst UND anschliessend die
    # Nettoverschuldung abzieht, belastet die Schulden zweimal. Die Abzinsung
    # mit dem WACC verlangt den Cashflow VOR Fremdkapitalkosten.
    # Toyota zeigt die Groessenordnung: dessen Zinsaufwand ist rund 45 Prozent
    # des operativen Cashflows (Autobank), der Modellwert lag dadurch etwa
    # 60 Prozent zu niedrig. Bei schuldenarmen Titeln sind es wenige Prozent.
    zins = mio(sec.get("interestExpense"))
    schuld_roh = mio(sec.get("longTermDebt")) or 0.0

    # Gegenprobe, bevor Zinsen zugerechnet werden: Passen Zinsaufwand und
    # ausgewiesene Schuld zusammen? Bei Konzernen mit eigener Bank (Toyota, VW)
    # steckt der groesste Teil der Verbindlichkeiten in kurzfristigen Posten der
    # Finanzsparte und fehlt in LongTermDebtNoncurrent. Der Zinsaufwand gehoert
    # aber zur GESAMTEN Schuld. Wer ihn dann voll zurechnet und nur die
    # langfristige Schuld abzieht, rechnet einseitig schoen - bei Toyota kam so
    # das Zwei- bis Dreifache des Boersenkurses heraus.
    # Erkennbar am impliziten Zinssatz: Toyota 15,5 Prozent auf die erfasste
    # Schuld, Apple 5,0 Prozent. Ueber 12 Prozent ist die Bilanz unvollstaendig.
    if zins and abs(zins) > 0.15 * cfo:
        satz = (abs(zins) / schuld_roh) if schuld_roh > 0 else None
        if satz is None or satz > 0.12:
            return {"nicht_anwendbar": True,
                    "grund": ("Zinsaufwand und ausgewiesene Verbindlichkeiten passen nicht "
                              "zusammen (impliziter Zinssatz %s). Typisch fuer Konzerne mit "
                              "eigener Finanzsparte: Deren Schulden stehen groesstenteils in "
                              "kurzfristigen Posten und fehlen in der Bilanzposition. Eine "
                              "Cashflow-DCF wuerde den Wert dadurch deutlich zu hoch "
                              "ausweisen." % ("nicht berechenbar" if satz is None
                                              else "%.1f Prozent" % (satz * 100))),
                    "sic": sec.get("sic"), "branche": sec.get("sicText")}

    if zins:
        fcf0 += abs(zins) * (1 - dcf_core.STEUERSATZ / 100)
        fcf_quelle += (" Zinsaufwand nach Steuern zugerechnet (%.0f Prozent Steuersatz), "
                       "damit der Cashflow zum WACC passt." % dcf_core.STEUERSATZ)
    else:
        fcf_quelle += " Kein Zinsaufwand ausgewiesen - Cashflow unveraendert uebernommen."

    if fcf0 <= 0:
        return None

    schuld = mio(sec.get("longTermDebt")) or 0.0
    barmittel = mio(sec.get("cash"))
    if barmittel is not None:
        netto = schuld - barmittel
        netto_quelle = "Langfristige Schulden abzueglich Barmittel."
    else:
        netto = schuld
        netto_quelle = "Schulden ohne Barmittelabzug - keine Daten."

    # Anteilszahl: die Marktquelle hat Vorrang. Der XBRL-Wert stimmt bei
    # US-Einreichern gut (Apple und JPMorgan auf ein Prozent genau), geht bei
    # 20-F-Einreichern aber daneben: Toyota meldet dort 2,77 Milliarden, waehrend
    # tatsaechlich rund 11,8 Milliarden Anteile umlaufen - Faktor 4,3. Ein
    # Modellwert je Anteil waere damit um denselben Faktor verkehrt.
    anteile = mio((markt or {}).get("sharesOut"))
    anteile_quelle = "Anteile aus den Marktkennzahlen."
    anteile_sec = mio(sec.get("sharesOutstanding"))
    if not anteile:
        anteile = anteile_sec
        anteile_quelle = "Anteile aus der SEC-Bilanz - keine Marktangabe vorhanden."
    elif anteile_sec and abs(anteile_sec / anteile - 1) > 0.1:
        anteile_quelle += (" Hinweis: die SEC-Bilanz nennt %.0f Millionen, also das "
                           "%.2f-fache; bei Auslandseinreichern erfasst der XBRL-Posten "
                           "oft nur eine Aktiengattung."
                           % (anteile_sec, anteile_sec / anteile))
    if not anteile:
        return None

    # _series liefert {"2025": 4.1e11, "2024": 3.9e11, ...} - ein dict.
    # Frueher stand hier reihe[:2]; auf einem dict ist das ein TypeError und
    # brach den kompletten Lauf ab, sobald SEC-Daten vorlagen.
    reihe = (sec.get("_series") or {}).get("revenue") or {}
    wachstum = None
    if isinstance(reihe, dict):
        jahre = sorted(reihe.keys(), reverse=True)[:2]
        if len(jahre) == 2:
            neuer, alter = reihe[jahre[0]], reihe[jahre[1]]
            if neuer and alter:
                wachstum = neuer / alter - 1

    beta = (av or {}).get("Beta") or (markt or {}).get("beta")
    g1, g2, g_quelle = dcf_core.wachstum_ableiten(wachstum)

    felder = {}
    for wacc in [6.0, 6.5, 7.0, 7.5, 8.0, 8.5, 9.0]:
        res = dcf_core.bewerte(fcf0, wacc, dcf_core.TERMINAL_WACHSTUM, g1, g2,
                               nettoverschuldung_mio=netto, anteile_mio=anteile)
        if res:
            felder[str(wacc)] = {
                "je_anteil": res["modellwert_je_anteil"],
                "tv_anteil": res["terminal_value_anteil_prozent"],
            }

    if not felder:
        return None

    # Letzte Plausibilitaetsschranke. Die eigentliche Ursache negativer Werte -
    # ein nach Zinsen ausgewiesener Cashflow, der mit dem WACC abgezinst und
    # zusaetzlich um die Nettoverschuldung gekuerzt wurde - ist oben behoben.
    # Diese Pruefung bleibt als Netz fuer Faelle mit unvollstaendiger Bilanz:
    # ein negativer Wert je Anteil ist keine Bewertung, sondern ein Artefakt.
    werte = [v["je_anteil"] for v in felder.values() if v.get("je_anteil") is not None]
    if not werte or min(werte) <= 0:
        return None

    return {
        "basis_fcf_mio": round(fcf0, 1),
        "fcf_quelle": fcf_quelle,
        "nettoverschuldung_mio": round(netto, 1),
        "netto_quelle": netto_quelle,
        "anteile_mio": round(anteile, 1),
        "anteile_quelle": anteile_quelle,
        "wachstum_phase1": g1,
        "wachstum_phase2": g2,
        "wachstum_quelle": g_quelle,
        "beta": beta,
        "terminal_wachstum": dcf_core.TERMINAL_WACHSTUM,
        "je_wacc": felder,
        "waehrung": sec.get("waehrung"),
        "hinweis": ("Modellrechnung aus SEC-Daten. Keine Empfehlung. "
                    "WACC und ewiges Wachstum dominieren das Ergebnis. "
                    "Werte in der Berichtswaehrung des Unternehmens."),
    }


def main():
    tickers = load_watchlist()
    if not tickers:
        return
    print(f"{len(tickers)} Titel auf der Watchlist")

    cikmap = build_ticker_cik()
    result = {}
    ok_sec = ok_markt = ok_av = ok_cape = 0

    # Einmal je Lauf, nicht je Titel: Der Preisindex gilt fuer alle.
    cpi = hole_cpi()
    print(f"Verbraucherpreisindex: {'ok, ' + str(len(cpi)) + ' Jahre' if cpi else 'nicht erreichbar - kein CAPE'}")

    for i, t in enumerate(tickers):
        entry = {}

        # 1) Bilanzdaten aus der XBRL-Datenbank der SEC
        cik = cikmap.get(t)
        if cik:
            try:
                sec = from_sec(cik)
            except Exception as e:
                print(f"    SEC-Fehler bei {t}: {e}")
                sec = None
            if sec:
                entry["sec"] = sec
                ok_sec += 1
                try:
                    cape = cape_block(sec, cpi)
                except Exception as e:
                    print(f"    CAPE-Fehler bei {t}: {e}")
                    cape = None
                if cape:
                    entry["cape"] = cape
                    ok_cape += 1
            time.sleep(0.15)      # SEC-Rate-Limit (10/s) grosszuegig einhalten

        # 2) Marktkennzahlen (KGV, Beta, Kursziel ...) - deckt auch Titel ohne
        #    SEC-Filing ab, damit europaeische Notierungen nicht leer bleiben.
        try:
            markt = market_source.hole(t)
        except Exception as e:
            print(f"    Marktdaten-Fehler bei {t}: {e}")
            markt = None
        if markt:
            entry["markt"] = markt
            ok_markt += 1

        # 3) Alpha Vantage nur, wenn ein Schluessel hinterlegt ist
        try:
            av = from_alphavantage(t)
        except Exception as e:
            print(f"    Alpha-Vantage-Fehler bei {t}: {e}")
            av = None
        if av:
            entry["av"] = av
            ok_av += 1
            time.sleep(13)        # Gratis-Limit (~5/min) einhalten

        # 4) DCF-Matrix - ein Rechenfehler darf nie den ganzen Lauf kosten
        if entry.get("sec"):
            try:
                d = dcf_block(entry["sec"], entry.get("av"), entry.get("markt"))
                if d:
                    entry["dcf"] = d
            except Exception as e:
                print(f"    DCF-Fehler bei {t}: {e}")

        if entry:
            entry["updated"] = int(time.time())
            result[t] = entry

        status = "/".join([
            "SEC" if "sec" in entry else "\u2013",
            "Markt" if "markt" in entry else "\u2013",
            "AV" if "av" in entry else "\u2013",
        ])
        print(f"  [{i+1}/{len(tickers)}] {t:6s} {status}")

    if not result:
        print("\nKeine Daten geholt - bestehende Datei bleibt unveraendert.")
        return

    target = os.path.abspath(TARGET)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    payload = {"generated": int(time.time()), "count": len(result), "data": result}
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"\nFertig: {len(result)} Titel "
          f"({ok_sec} mit SEC, {ok_markt} mit Marktkennzahlen, {ok_av} mit Alpha Vantage, "
          f"{ok_cape} mit CAPE-Gewinnreihe)")
    print(f"        -> {target}")


if __name__ == "__main__":
    main()
