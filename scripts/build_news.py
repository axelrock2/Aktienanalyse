#!/usr/bin/env python3
"""Sammelt Wirtschafts- und Marktnachrichten aus RSS/Atom-Feeds.

Laeuft in der GitHub Action (serverseitig, daher kein CORS und kein Proxy noetig)
und schreibt das Ergebnis nach data/news.json. Nur Standardbibliothek.

Ausfallsichere Bauweise:
  * jeder Feed wird einzeln versucht; Fehler ueberspringen nur diesen Feed
  * das Ergebnis enthaelt einen Statusbericht je Quelle (sichtbar im Frontend)
  * schlaegt ALLES fehl, bleibt eine vorhandene news.json unangetastet

Lokal testen:  python3 scripts/build_news.py
"""

from __future__ import annotations

import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

TARGET = os.path.join(os.path.dirname(__file__), "..", "data", "news.json")
MAX_ITEMS = 140
MAX_PER_SOURCE = 18
MAX_AGE_DAYS = 5
TIMEOUT = 20
UA = "Mozilla/5.0 (compatible; AktienCockpitNewsBot/1.0; +https://github.com)"

# Kandidatenliste. Nicht erreichbare Feeds werden uebersprungen und im
# Statusbericht als "fehlt" markiert - die Liste darf also grosszuegig sein.
FEEDS = [
    # --- Deutsch ---
    ("Tagesschau Wirtschaft", "de", "https://www.tagesschau.de/wirtschaft/index~rss2.xml"),
    ("Tagesschau Finanzen", "de", "https://www.tagesschau.de/wirtschaft/finanzen/index~rss2.xml"),
    ("Tagesschau Konjunktur", "de", "https://www.tagesschau.de/wirtschaft/konjunktur/index~rss2.xml"),
    ("Tagesschau Unternehmen", "de", "https://www.tagesschau.de/wirtschaft/unternehmen/index~rss2.xml"),
    ("ZEIT Wirtschaft", "de", "https://newsfeed.zeit.de/wirtschaft/index"),
    ("Spiegel Wirtschaft", "de", "https://www.spiegel.de/wirtschaft/index.rss"),
    ("FAZ Wirtschaft", "de", "https://www.faz.net/rss/aktuell/wirtschaft/"),
    ("n-tv Wirtschaft", "de", "https://www.n-tv.de/wirtschaft/rss"),
    ("Deutsche Bundesbank", "de", "https://www.bundesbank.de/service/rss/de/633286/feed.xml"),
    # --- Englisch / international ---
    ("Yahoo Finance", "en", "https://finance.yahoo.com/news/rssindex"),
    ("CNBC Markets", "en", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258"),
    ("CNBC Economy", "en", "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258"),
    ("MarketWatch Top", "en", "https://feeds.content.dowjones.io/public/rss/mw_topstories"),
    ("Investing.com", "en", "https://www.investing.com/rss/news_25.rss"),
    ("EZB Pressemitteilungen", "en", "https://www.ecb.europa.eu/rss/press.html"),
    ("Federal Reserve", "en", "https://www.federalreserve.gov/feeds/press_all.xml"),
]

# Kategorien nach Stichworten (erste Uebereinstimmung gewinnt)
CATEGORIES = [
    ("zentralbank", [
        "ezb", "fed ", "federal reserve", "notenbank", "zentralbank", "leitzins", "zinsentscheid",
        "geldpolitik", "bundesbank", "lagarde", "powell", "interest rate", "rate cut", "rate hike",
        "monetary policy", "central bank", "boj", "bank of england", "inflation", "verbraucherpreise",
        "cpi", "ppi",
    ]),
    ("rohstoffe", [
        "oel", "öl", "oil", "gas", "gold", "silber", "silver", "kupfer", "copper", "opec", "brent",
        "wti", "strompreis", "energiepreis", "commodity", "commodities", "rohstoff", "weizen", "lithium",
    ]),
    ("konjunktur", [
        "bip", "gdp", "konjunktur", "rezession", "recession", "arbeitsmarkt", "arbeitslos",
        "unemployment", "jobs report", "ifo", "zew", "einkaufsmanager", "pmi", "wachstum", "growth",
        "handelsbilanz", "export", "import", "zoll", "tariff", "haushalt", "schulden", "budget",
    ]),
    ("maerkte", [
        "dax", "s&p", "nasdaq", "dow jones", "euro stoxx", "nikkei", "boerse", "börse", "aktienmarkt",
        "stock market", "stocks", "anleihen", "bond", "rendite", "yield", "wall street", "index",
        "kurs", "rally", "sell-off", "volatil", "bitcoin", "krypto", "crypto", "euro", "dollar",
        "wechselkurs", "currency",
    ]),
    ("unternehmen", [
        "quartalszahlen", "quartal", "earnings", "bilanz", "umsatz", "gewinn", "profit", "revenue",
        "uebernahme", "übernahme", "merger", "acquisition", "ipo", "boersengang", "börsengang",
        "dividende", "dividend", "aktienrueckkauf", "buyback", "ceo", "vorstand", "stellenabbau",
        "layoff", "insolvenz", "guidance", "prognose",
    ]),
]

TAG_RE = re.compile(r"<[^>]+>")
WS_RE = re.compile(r"\s+")


def clean_text(s: str) -> str:
    """HTML-Reste entfernen, Entities aufloesen, Leerraum normalisieren."""
    if not s:
        return ""
    s = TAG_RE.sub(" ", s)
    s = html.unescape(s)
    s = s.replace("\u00a0", " ")
    return WS_RE.sub(" ", s).strip()


def parse_date(raw: str) -> int | None:
    """RFC-822 oder ISO-8601 in Unix-Sekunden umwandeln."""
    if not raw:
        return None
    raw = raw.strip()
    try:
        dt = parsedate_to_datetime(raw)
        if dt is not None:
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
    except (TypeError, ValueError, IndexError):
        pass
    iso = raw.replace("Z", "+00:00")
    for candidate in (iso, iso[:19] + "+00:00"):
        try:
            dt = datetime.fromisoformat(candidate)
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return int(dt.timestamp())
        except ValueError:
            continue
    return None


def categorize(title: str) -> str:
    low = title.lower()
    for name, words in CATEGORIES:
        for w in words:
            if w in low:
                return name
    return "maerkte"


def strip_ns(tag: str) -> str:
    return tag.split("}", 1)[1] if "}" in tag else tag


def find_text(node, names) -> str:
    for child in node:
        if strip_ns(child.tag) in names and (child.text or "").strip():
            return child.text
    return ""


def extract_link(node) -> str:
    """RSS: <link>text</link>; Atom: <link href="..." rel="alternate">."""
    fallback = ""
    for child in node:
        if strip_ns(child.tag) != "link":
            continue
        href = child.get("href")
        if href:
            rel = (child.get("rel") or "alternate").lower()
            if rel == "alternate":
                return href.strip()
            fallback = fallback or href.strip()
        elif (child.text or "").strip():
            return child.text.strip()
    return fallback


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
    })
    with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
        return resp.read()


def parse_feed(raw: bytes, source: str, lang: str) -> list[dict]:
    root = ET.fromstring(raw)
    entries = [n for n in root.iter() if strip_ns(n.tag) in ("item", "entry")]
    out = []
    for node in entries[:MAX_PER_SOURCE * 2]:
        title = clean_text(find_text(node, ("title",)))
        link = extract_link(node)
        if not title or not link or not link.startswith("http"):
            continue
        ts = parse_date(find_text(node, ("pubDate", "published", "updated", "date")))
        out.append({
            "t": title[:180],
            "u": link,
            "s": source,
            "l": lang,
            "d": ts or 0,
            "c": categorize(title),
        })
        if len(out) >= MAX_PER_SOURCE:
            break
    return out


def norm_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", title.lower())[:70]


def main() -> int:
    collected: list[dict] = []
    report: list[dict] = []

    for name, lang, url in FEEDS:
        try:
            items = parse_feed(fetch(url), name, lang)
            if items:
                collected.extend(items)
                report.append({"n": name, "ok": True, "c": len(items)})
                print(f"  OK      {name}: {len(items)} Meldungen")
            else:
                report.append({"n": name, "ok": False, "c": 0})
                print(f"  LEER    {name}")
        except (urllib.error.URLError, urllib.error.HTTPError, ET.ParseError,
                TimeoutError, ValueError, OSError) as exc:
            report.append({"n": name, "ok": False, "c": 0})
            print(f"  FEHLER  {name}: {type(exc).__name__}")

    if not collected:
        print("Keine einzige Quelle erreichbar - bestehende news.json bleibt unveraendert.")
        return 1

    # Duplikate entfernen (gleiche URL oder nahezu gleiche Ueberschrift)
    seen_url, seen_title, unique = set(), set(), []
    for it in sorted(collected, key=lambda x: x["d"], reverse=True):
        k = norm_key(it["t"])
        if it["u"] in seen_url or (k and k in seen_title):
            continue
        seen_url.add(it["u"])
        seen_title.add(k)
        unique.append(it)

    # Zu alte Meldungen verwerfen (Eintraege ohne Datum bleiben erhalten)
    cutoff = time.time() - MAX_AGE_DAYS * 86400
    unique = [i for i in unique if i["d"] == 0 or i["d"] >= cutoff][:MAX_ITEMS]

    payload = {
        "generated": int(time.time()),
        "sources": report,
        "items": unique,
    }

    target = os.path.abspath(TARGET)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, separators=(",", ":"))

    ok = sum(1 for r in report if r["ok"])
    print(f"\nFertig: {len(unique)} Meldungen aus {ok}/{len(FEEDS)} Quellen -> {target}")
    print(f"Dateigroesse: {os.path.getsize(target) / 1024:.1f} KB")
    return 0


if __name__ == "__main__":
    sys.exit(main())
