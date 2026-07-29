#!/usr/bin/env python3
"""Erzeugt data/fundamentals.json mit Bilanzkennzahlen fuer das Dossier.

Quellen:
  1. SEC EDGAR (schluesselfrei) – deckt US-Unternehmen und grosse auslaendische
     Konzerne ab, die ein Form 20-F einreichen (SAP, Toyota, ASML, AstraZeneca ...).
  2. Alpha Vantage (optional, via Umgebungsvariable ALPHAVANTAGE_KEY als
     GitHub-Secret) – ergaenzt normalisierte US-Kennzahlen.

Die Titel-Liste kommt aus scripts/fundamentals_watchlist.txt (ein Ticker je
Zeile). Diese Liste liegt bewusst getrennt, damit sie KEINE Depotdaten enthaelt –
sie darf ins oeffentliche Repository, ein Depot darf es nicht.

Aufruf:
    python3 scripts/build_fundamentals.py
"""
import json
import os
import re
import time
import urllib.request
import urllib.error

HERE = os.path.dirname(__file__)
WATCHLIST = os.path.join(HERE, "fundamentals_watchlist.txt")
TARGET = os.path.join(HERE, "..", "data", "fundamentals.json")

# Die SEC verlangt einen aussagekraeftigen User-Agent mit Kontaktangabe.
UA = {"User-Agent": "Aktien-Cockpit (persoenliches Analyse-Tool) axelrock2@users.noreply.github.com"}
AV_KEY = os.environ.get("ALPHAVANTAGE_KEY", "").strip()

TICKERMAP = "https://www.sec.gov/files/company_tickers.json"
FACTS = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"


def http_json(url, headers=None, tries=3):
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers=headers or UA)
            with urllib.request.urlopen(req, timeout=45) as r:
                return json.loads(r.read().decode("utf-8", "replace"))
        except urllib.error.HTTPError as e:
            if e.code == 429:            # zu schnell -> warten
                time.sleep(2 + i * 2)
                continue
            if e.code == 404:
                return None
            if i == tries - 1:
                print(f"    HTTP {e.code} bei {url[:70]}")
                return None
            time.sleep(1 + i)
        except Exception as e:
            if i == tries - 1:
                print(f"    Fehler: {e}")
                return None
            time.sleep(1 + i)
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


def build_ticker_cik():
    print("Lade SEC Ticker->CIK-Mapping ...")
    data = http_json(TICKERMAP)
    if not data:
        print("  Mapping nicht erreichbar.")
        return {}
    m = {}
    for row in data.values():
        m[str(row["ticker"]).upper()] = str(row["cik_str"]).zfill(10)
    print(f"  {len(m)} Ticker im Mapping")
    return m


def latest_val(facts, tags, unit_hint="USD"):
    """Neuesten Wert fuer den ersten passenden XBRL-Tag holen.
       Beruecksichtigt us-gaap und ifrs-full (fuer 20-F-Filer)."""
    for taxonomy in ("us-gaap", "ifrs-full"):
        block = facts.get("facts", {}).get(taxonomy, {})
        for tag in tags:
            node = block.get(tag)
            if not node:
                continue
            units = node.get("units", {})
            # bevorzugte Einheit, sonst irgendeine
            series = units.get(unit_hint) or (next(iter(units.values()), None))
            if not series:
                continue
            # jaehrliche Werte (form 10-K / 20-F) bevorzugen, neueste zuerst
            annual = [x for x in series if x.get("form") in ("10-K", "20-F", "40-F")]
            pool = annual or series
            pool = [x for x in pool if x.get("end")]
            if not pool:
                continue
            pool.sort(key=lambda x: x["end"], reverse=True)
            return pool[0].get("val")
    return None


def series_vals(facts, tags, unit_hint="USD", years=6):
    """Zeitreihe (Jahr -> Wert) fuer Trendkennzahlen wie Piotroski."""
    for taxonomy in ("us-gaap", "ifrs-full"):
        block = facts.get("facts", {}).get(taxonomy, {})
        for tag in tags:
            node = block.get(tag)
            if not node:
                continue
            units = node.get("units", {})
            series = units.get(unit_hint) or (next(iter(units.values()), None))
            if not series:
                continue
            annual = {}
            for x in series:
                if x.get("form") in ("10-K", "20-F", "40-F") and x.get("end"):
                    annual[x["end"][:4]] = x.get("val")
            if annual:
                keys = sorted(annual.keys(), reverse=True)[:years]
                return {k: annual[k] for k in keys}
    return {}


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
    "interestExpense": ["InterestExpense", "InterestAndDebtExpense"],
}


def from_sec(cik):
    facts = http_json(FACTS.format(cik=cik))
    if not facts:
        return None
    out = {"source": "SEC EDGAR"}
    for key, tags in TAGS.items():
        v = latest_val(facts, tags)
        if v is not None:
            out[key] = v
    # Trendreihen fuer Piotroski/Beneish
    out["_series"] = {
        "netIncome": series_vals(facts, TAGS["netIncome"]),
        "revenue": series_vals(facts, TAGS["revenue"]),
        "cashFlowOps": series_vals(facts, TAGS["cashFlowOps"]),
        "totalAssets": series_vals(facts, TAGS["totalAssets"]),
        "longTermDebt": series_vals(facts, TAGS["longTermDebt"]),
        "grossProfit": series_vals(facts, TAGS["grossProfit"]),
    }
    return out if len(out) > 2 else None


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


def main():
    tickers = load_watchlist()
    if not tickers:
        return
    print(f"{len(tickers)} Titel auf der Watchlist")

    cikmap = build_ticker_cik()
    result = {}
    ok_sec = ok_av = 0

    for i, t in enumerate(tickers):
        entry = {}
        cik = cikmap.get(t)
        if cik:
            sec = from_sec(cik)
            if sec:
                entry["sec"] = sec
                ok_sec += 1
            time.sleep(0.15)      # SEC-Rate-Limit (10/s) grosszuegig einhalten
        av = from_alphavantage(t)
        if av:
            entry["av"] = av
            ok_av += 1
            time.sleep(13)        # Alpha Vantage Gratis-Limit (~5/min) einhalten
        if entry:
            entry["updated"] = int(time.time())
            result[t] = entry
        status = ("SEC" if cik and "sec" in entry else "–") + "/" + ("AV" if "av" in entry else "–")
        print(f"  [{i+1}/{len(tickers)}] {t:6s} {status}")

    target = os.path.abspath(TARGET)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    payload = {"generated": int(time.time()), "count": len(result), "data": result}
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"\nFertig: {len(result)} Titel ({ok_sec} mit SEC, {ok_av} mit Alpha Vantage)")
    print(f"        -> {target}")


if __name__ == "__main__":
    main()
