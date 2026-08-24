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

Gelesen wird ueber Scrapling: nicht mit Textsuche, sondern entlang der
Tabellenstruktur (<tr> mit mindestens zwei <td>). Das ist der Grund fuer die
Bibliothek - Begriffe wie "Market Cap" oder "Revenue" stehen auch in der
Navigation und im Sprungmenue der Seite. Eine Textsuche trifft die zuerst und
holt sich stillschweigend den falschen Wert; ueber die Tabellenstruktur kann das
nicht passieren.

Geholt wird bewusst mit der Standardbibliothek statt mit Scraplings Fetchern:
Die Seite antwortet auf gewoehnliche Anfragen, es braucht keine Browser-Engine.
Das haelt die taegliche GitHub Action leicht - `scrapling[fetchers]` zoege
curl_cffi und einen kompletten Browser nach.

Verwendung:
    import market_source
    d = market_source.hole("SAP.DE")     # -> dict oder None
"""
import gzip
import re
import time
import urllib.error
import urllib.request

try:
    from scrapling import Selector
except ImportError as e:                 # pragma: no cover
    raise SystemExit(
        "Scrapling fehlt. Installieren mit:  pip install -r requirements.txt\n"
        "(Absichtlich keine Notloesung per Textsuche: die liefert bei dieser "
        "Seite still falsche Werte, statt sichtbar zu scheitern.)"
    ) from e

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


def _tabelle(html):
    """Alle Kennzahlenzeilen in einem Durchgang: {Label: [Zelle, ...]}.

    Nur Zeilen mit mindestens zwei Datenzellen zaehlen. Die erste Zelle traegt
    das Label, die uebrigen die Werte - bei "Revenue (ttm)" etwa Betrag und
    Veraenderung. Beim ersten Vorkommen bleibt es: die Uebersichtsseite
    wiederholt einzelne Groessen weiter unten in Merktafeln.
    """
    out = {}
    for tr in Selector(html).css("tr"):
        tds = tr.css("td")
        if len(tds) < 2:
            continue
        label = tds[0].get_all_text(strip=True)
        if label and label not in out:
            out[label] = [t.get_all_text(strip=True) for t in tds[1:]]
    return out


def _zahl(s):
    """'35.49' -> 35.49 | '27.62%' -> 0.2762 | '136.68B' -> 1.3668e11
       '$1.08 (0.35%)' -> 1.08 | '1,482.93' -> 1482.93 | '-' -> None"""
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


def _feld(tab, label):
    """Ersten Wert zu einem Label als Zahl."""
    zellen = tab.get(label)
    return _zahl(zellen[0]) if zellen else None


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
    # Erst durch das strukturierte Lesen zugaenglich geworden
    "pFcf": "P/FCF Ratio",
    "evEbit": "EV / EBIT",
    "debtEbitda": "Debt / EBITDA",
    "insiderAnteil": "Owned by Insiders (%)",
    "institutionenAnteil": "Owned by Institutions (%)",
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


def _uebersicht(tab):
    """Kursziel, Analystenurteil, Umsatzwachstum und 52-Wochen-Spanne."""
    out = {}
    v = _feld(tab, "Price Target")           # '326.34 (+5.49%)'
    if v is not None:
        out["targetMean"] = v

    urteil = (tab.get("Analysts") or [""])[0].strip()
    if urteil in NOTEN:
        out["recommendation"] = urteil

    # 'Revenue (ttm)' -> ['466.82B\n+14.2%'] - Betrag und Veraenderung in einer Zelle
    zelle = (tab.get("Revenue (ttm)") or [""])[0]
    m = re.search(r"([+-][\d.,]+)\s*%", zelle)
    if m:
        w = _zahl(m.group(1).lstrip("+"))
        if w is not None:
            out["revGrowth"] = (-w if m.group(1).startswith("-") else w) / 100.0

    spanne = (tab.get("52-Week Range") or [""])[0]     # '223.78 - 344.57'
    m = re.match(r"\s*([\d.,]+)\s*-\s*([\d.,]+)", spanne)
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
    tab = _tabelle(html)
    out = {}
    for schluessel, label in STATISTIK.items():
        v = _feld(tab, label)
        if v is not None:
            out[schluessel] = v
    if not out:
        return None

    time.sleep(pause)                       # hoeflich bleiben
    html2 = _lade(url)
    if html2:
        out.update(_uebersicht(_tabelle(html2)))

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
                print(f"      {k:20s} {d[k]}")
