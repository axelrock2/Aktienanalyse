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


def _jahresfakten(serie):
    """Nur Jahresabschluesse, je Geschaeftsjahr der zuletzt gemeldete Wert."""
    proJahr = {}
    for x in serie:
        if x.get("form") not in ("10-K", "20-F", "40-F"):
            continue
        ende = x.get("end")
        if not ende or x.get("val") is None:
            continue
        # fy/fp kennzeichnen das Geschaeftsjahr; 'end' ist der Bilanzstichtag
        jahr = ende[:4]
        vorher = proJahr.get(jahr)
        if vorher is None or ende > vorher[0]:
            proJahr[jahr] = (ende, x["val"])
    return proJahr


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


def from_sec(cik):
    facts = http_json(FACTS.format(cik=cik))
    if not facts:
        return None
    waehrung = haupt_waehrung(facts) or "USD"
    out = {"source": "SEC EDGAR", "waehrung": waehrung,
           "entityName": facts.get("entityName")}
    for key, tags in TAGS.items():
        v = latest_val(facts, tags, unit_hint=waehrung)
        if v is not None:
            out[key] = v
    # Anteile werden in Stueck gemeldet, nicht in Waehrung
    anteile = latest_val(facts, TAGS["sharesOutstanding"], unit_hint="shares")
    if anteile is not None:
        out["sharesOutstanding"] = anteile
    # Trendreihen fuer Piotroski/Beneish
    out["_series"] = {
        "netIncome": series_vals(facts, TAGS["netIncome"], waehrung),
        "revenue": series_vals(facts, TAGS["revenue"], waehrung),
        "cashFlowOps": series_vals(facts, TAGS["cashFlowOps"], waehrung),
        "totalAssets": series_vals(facts, TAGS["totalAssets"], waehrung),
        "longTermDebt": series_vals(facts, TAGS["longTermDebt"], waehrung),
        "grossProfit": series_vals(facts, TAGS["grossProfit"], waehrung),
    }
    # Bilanzjahr mitschreiben, damit im Dossier sichtbar ist, wie alt die Zahlen sind
    jahre = [j for j in (out["_series"].get("revenue") or {})]
    if jahre:
        out["geschaeftsjahr"] = max(jahre)
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


def dcf_block(sec, av=None):
    """Berechnet die DCF-Matrix aus den SEC-Daten eines Titels.

    Bewusst ohne Kurs: gespeichert wird die Matrix ueber ein festes
    WACC-Raster. Die Zuordnung zum aktuellen Kurs macht das Dashboard.
    """
    if not sec:
        return None

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

    anteile = mio(sec.get("sharesOutstanding"))
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

    beta = (av or {}).get("Beta")
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

    # Plausibilitaetsschranke: bei Konzernen mit eigener Bank (Toyota, VW) ist die
    # gemeldete Nettoverschuldung so gross, dass das Modell negative Kurswerte
    # ausspuckt. Solche Ergebnisse sind keine Bewertung, sondern ein Artefakt -
    # dann lieber nichts liefern als eine Zahl, der man glauben koennte.
    werte = [v["je_anteil"] for v in felder.values() if v.get("je_anteil") is not None]
    if not werte or min(werte) <= 0:
        return None

    return {
        "basis_fcf_mio": round(fcf0, 1),
        "fcf_quelle": fcf_quelle,
        "nettoverschuldung_mio": round(netto, 1),
        "netto_quelle": netto_quelle,
        "anteile_mio": round(anteile, 1),
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
    ok_sec = ok_markt = ok_av = 0

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
                d = dcf_block(entry["sec"], entry.get("av") or entry.get("markt"))
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
          f"({ok_sec} mit SEC, {ok_markt} mit Marktkennzahlen, {ok_av} mit Alpha Vantage)")
    print(f"        -> {target}")


if __name__ == "__main__":
    main()
