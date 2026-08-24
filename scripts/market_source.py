#!/usr/bin/env python3
"""Marktkennzahlen von stockanalysis.com holen (schluesselfrei).

Warum diese Quelle: Yahoo verlangt fuer den quoteSummary-Baustein inzwischen ein
Cookie-und-Crumb-Paar. Das kann eine GitHub Action nicht verlaesslich halten und
ein CORS-Proxy grundsaetzlich nicht weitergeben - der Aufruf endet mit
"Invalid Crumb". Damit fehlen genau die Kennzahlen, die die SEC-Bilanzdaten nicht
hergeben: KGV, PEG, Beta, Analystenkursziel, Dividendenrendite.

stockanalysis.com liefert dieselben Groessen als normale HTML-Seite, ohne
Schluessel, ohne Anmeldung und - wichtig fuer dieses Projekt - auch fuer
europaeische und asiatische Notierungen, die kein SEC-Formular einreichen.

Verwendung:
    import market_source
    d = market_source.hole("SAP.DE")     # -> dict oder None
"""
import gzip
import re
import time
import urllib.error
import urllib.request

BASIS = "https://stockanalysis.com"

KOPF = {
    "User-Agent": ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                   "AppleWebKit/537.36 (KHTML, like Gecko) "
                   "Chrome/126.0.0.0 Safari/537.36"),
    "Accept": "text/html,application/xhtml+xml",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip",
}

# Yahoo-Boersenkuerzel -> Boersenpfad bei stockanalysis.com.
# Ohne Kuerzel (z. B. "AAPL") ist es eine US-Notierung unter /stocks/.
BOERSEN = {
    "DE": "etr", "F": "etr", "BE": "etr", "MU": "etr", "SG": "etr", "HM": "etr",
    "DU": "etr", "L": "lon", "PA": "epa", "AS": "ams", "BR": "ebr", "LS": "els",
    "MI": "bit", "MC": "bme", "SW": "swx", "VI": "vie", "ST": "sto", "CO": "cph",
    "OL": "osl", "HE": "hel", "IC": "ice", "WA": "wse", "PR": "pse", "AT": "ath",
    "IS": "ist", "TO": "tsx", "V": "cve", "MX": "bmv", "SA": "bvmf",
    "BA": "bcba", "SN": "bcs", "T": "tyo", "HK": "hkg", "SS": "sha", "SZ": "she",
    "TW": "tpe", "KS": "krx", "KQ": "krx", "SI": "sgx", "NS": "nse", "BO": "bom",
    "AX": "asx", "NZ": "nzx", "JO": "jse", "TA": "tase",
}

# Kurswaehrung je Boerse. Wichtig fuer das Analystenkursziel: es ist ein Kurs,
# also waehrungsbehaftet. Die US-Hinterlegungsscheine (ADR) von SAP notieren in
# USD, die Stammaktie in Frankfurt in EUR - dasselbe Unternehmen, zwei Zahlen.
# Ohne diese Angabe landete das USD-Ziel neben einem EUR-Kurs.
KURSWAEHRUNG = {
    "etr": "EUR", "epa": "EUR", "ams": "EUR", "ebr": "EUR", "els": "EUR",
    "bit": "EUR", "bme": "EUR", "vie": "EUR", "hel": "EUR", "ath": "EUR",
    "lon": "GBp", "swx": "CHF", "sto": "SEK", "cph": "DKK", "osl": "NOK",
    "ice": "ISK", "wse": "PLN", "pse": "CZK", "ist": "TRY", "tsx": "CAD",
    "cve": "CAD", "bmv": "MXN", "bvmf": "BRL", "bcba": "ARS", "bcs": "CLP",
    "tyo": "JPY", "hkg": "HKD", "sha": "CNY", "she": "CNY", "tpe": "TWD",
    "krx": "KRW", "sgx": "SGD", "nse": "INR", "bom": "INR", "asx": "AUD",
    "nzx": "NZD", "jse": "ZAR", "tase": "ILS",
}

MULTI = {"K": 1e3, "M": 1e6, "B": 1e9, "T": 1e12}
NOTEN = ("Strong Buy", "Buy", "Hold", "Sell", "Strong Sell")


def _lade(url, versuche=3):
    """HTML holen. Gibt None zurueck, statt zu werfen."""
    for i in range(versuche):
        try:
            req = urllib.request.Request(url, headers=KOPF)
            with urllib.request.urlopen(req, timeout=30) as r:
                roh = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    roh = gzip.decompress(roh)
                return roh.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (404, 403):        # Titel gibt es dort nicht
                return None
            if i == versuche - 1:
                return None
            time.sleep(1.5 * (i + 1))
        except Exception:
            if i == versuche - 1:
                return None
            time.sleep(1.5 * (i + 1))
    return None


def _flach(html):
    """HTML zu '|Label|Wert|'-Kette machen - robuster als CSS-Pfade,
       die sich bei jedem Seiten-Umbau aendern."""
    t = re.sub(r"<script.*?</script>", " ", html, flags=re.S)
    t = re.sub(r"<style.*?</style>", " ", t, flags=re.S)
    t = re.sub(r"<[^>]+>", "|", t)
    t = (t.replace("&amp;", "&").replace("&nbsp;", " ")
          .replace("&#36;", "$").replace("&quot;", '"'))
    t = re.sub(r"[ \t\r\n]+", " ", t)
    return re.sub(r"(\|\s*)+", "|", t)


def _zahl(s):
    """'35.49' -> 35.49 | '27.62%' -> 0.2762 | '136.68B' -> 1.3668e11
       '$1.08 (0.35%)' -> 1.08 | '-' -> None"""
    if not s:
        return None
    s = s.strip()
    if s in ("", "-", "--", "n/a", "N/A", "Upgrade"):
        return None
    m = re.match(r"^\$?\s*(-?[\d,]+\.?\d*)\s*([KMBT])?\s*(%)?", s)
    if not m:
        return None
    try:
        v = float(m.group(1).replace(",", ""))
    except ValueError:
        return None
    if m.group(2):
        v *= MULTI[m.group(2)]
    if m.group(3):
        v /= 100.0
    return v


def _feld(flach, label):
    """Wert nach '|Label|' lesen. Nimmt das erste Vorkommen, das sich als Zahl
       lesen laesst: Labels wie "Market Cap" oder "Revenue" stehen auch in der
       Navigation und im Sprungmenue, dort aber ohne Zahl dahinter."""
    for m in re.finditer(r"\|" + re.escape(label) + r"\|\s*([^|]*)", flach):
        v = _zahl(m.group(1))
        if v is not None:
            return v
    return None


# Kennzahl -> Label auf der Statistics-Seite
STATISTIK = {
    "trailingPE": "PE Ratio",
    "forwardPE": "Forward PE",
    "peg": "PEG Ratio",
    "psRatio": "PS Ratio",
    "pbRatio": "PB Ratio",
    "evEbitda": "EV / EBITDA",
    "profitMargin": "Profit Margin",
    "opMargin": "Operating Margin",
    "grossMargin": "Gross Margin",
    "ebitdaMargin": "EBITDA Margin",
    "fcfMargin": "FCF Margin",
    "roe": "Return on Equity (ROE)",
    "roa": "Return on Assets (ROA)",
    "roic": "Return on Invested Capital (ROIC)",
    "debtToEquity": "Debt / Equity",
    "currentRatio": "Current Ratio",
    "quickRatio": "Quick Ratio",
    "fcf": "Free Cash Flow",
    "fcfPerShare": "FCF Per Share",
    "divYield": "Dividend Yield",
    "payoutRatio": "Payout Ratio",
    "divPerShare": "Dividend Per Share",
    "beta": "Beta (5Y)",
    "marketCap": "Market Cap",
    "enterpriseValue": "Enterprise Value",
    "revenue": "Revenue",
    "netIncome": "Net Income",
    "sharesOut": "Shares Outstanding",
    "totalDebt": "Total Debt",
    "netCash": "Net Cash",
}


def _pfad(symbol):
    """Yahoo-Symbol -> (Adresse, Kurswaehrung). 'SAP.DE' -> /quote/etr/SAP/, EUR
       Ohne Boersenkuerzel ist es die US-Notierung: /stocks/..., USD."""
    sym = str(symbol).strip().upper()
    if "." not in sym:
        return f"{BASIS}/stocks/{sym.lower()}/", "USD"
    basis, _, kuerzel = sym.rpartition(".")
    boerse = BOERSEN.get(kuerzel)
    if not boerse:
        return None, None
    return f"{BASIS}/quote/{boerse}/{basis}/", KURSWAEHRUNG.get(boerse)


def _uebersicht(flach):
    """Kursziel, Analystenurteil und Umsatzwachstum von der Uebersichtsseite."""
    out = {}
    v = _feld(flach, "Price Target")
    if v is not None:
        out["targetMean"] = v

    # '|Analysts|Buy|' - der Navigationspunkt "Analysts" hat kein Urteil dahinter
    for m in re.finditer(r"\|Analysts\|\s*([^|]*)", flach):
        wort = m.group(1).strip()
        if wort in NOTEN:
            out["recommendation"] = wort
            break

    # '|Revenue (ttm)|466.82B |+14.2%|' - die dritte Zelle ist die Veraenderung
    m = re.search(r"\|Revenue \(ttm\)\|[^|]*\|\s*([+-][\d.,]+%)", flach)
    if m:
        w = _zahl(m.group(1).lstrip("+"))
        if w is not None:
            out["revGrowth"] = -w if m.group(1).startswith("-") else w

    m = re.search(r"\|52-Week Range\|\s*([\d.,]+)\s*-\s*([\d.,]+)", flach)
    if m:
        tief, hoch = _zahl(m.group(1)), _zahl(m.group(2))
        if tief is not None and hoch is not None:
            out["low52"], out["high52"] = tief, hoch
    return out


def hole(symbol, pause=0.8):
    """Alle Marktkennzahlen zu einem Symbol. None, wenn der Titel dort fehlt."""
    url, kurswaehrung = _pfad(symbol)
    if not url:
        return None

    html = _lade(url + "statistics/")
    if not html:
        return None
    out = {}
    flach = _flach(html)
    for schluessel, label in STATISTIK.items():
        v = _feld(flach, label)
        if v is not None:
            out[schluessel] = v
    if not out:
        return None

    time.sleep(pause)                       # hoeflich bleiben
    html2 = _lade(url)
    if html2:
        out.update(_uebersicht(_flach(html2)))

    out["source"] = "stockanalysis.com"
    out["url"] = url
    if kurswaehrung:
        out["kursWaehrung"] = kurswaehrung
    return out


if __name__ == "__main__":
    import sys
    for s in sys.argv[1:] or ["AAPL", "SAP.DE", "ASML"]:
        d = hole(s)
        print(f"\n=== {s} -> {_pfad(s)[0]}")
        if not d:
            print("    keine Daten")
            continue
        print(f"    {len(d) - 2} Kennzahlen")
        for k in sorted(d):
            if k not in ("source", "url"):
                print(f"      {k:16s} {d[k]}")
