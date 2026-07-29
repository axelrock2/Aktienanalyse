#!/usr/bin/env python3
"""Erzeugt data/tickers.json aus der FinanceDatabase.

Enthaelt Aktien (Mega/Large/Mid Cap) und boersengehandelte Fonds (ETFs).
Wird woechentlich von der GitHub Action ausgefuehrt, laeuft aber auch lokal:
    python3 scripts/build_tickers.py

Zeilenformat: [symbol, name, country, exchange, sector_oder_kategorie, klasse]
Klassen: XL/L/M fuer Aktien nach Marktkapitalisierung, ETF fuer Fonds.
"""
import bz2
import csv
import io
import json
import os
import urllib.request

EQUITIES = "https://raw.githubusercontent.com/JerBouma/FinanceDatabase/main/compression/equities.bz2"
ETFS = "https://raw.githubusercontent.com/JerBouma/FinanceDatabase/main/compression/etfs.bz2"
TARGET = os.path.join(os.path.dirname(__file__), "..", "data", "tickers.json")
CAPS = {"Mega Cap": "XL", "Large Cap": "L", "Mid Cap": "M"}
ORDER = {"XL": 0, "L": 1, "M": 2, "ETF": 3}

# ETFs sind an vielen Regionalboersen mehrfach gelistet (Berlin, Muenchen,
# Duesseldorf ... fuehren oft denselben Fonds). Wir behalten je Fonds (ISIN)
# nur EINE Notierung und bevorzugen dabei eine Hauptboerse.
ETF_PREFER = ["GER", "XETRA", "LSE", "AMS", "PAR", "MIL", "EBS", "SWX",
              "NMS", "NGM", "NYQ", "PCX", "ASE", "FRA", "STU", "TOR", "HKG"]
ETF_PRIO = {code: i for i, code in enumerate(ETF_PREFER)}


def fix_text(s: str) -> str:
    """Repariert doppelt kodierte Sonderzeichen (z. B. 'Mo√´t' -> 'Moët')."""
    if not any(ord(ch) > 127 for ch in s):
        return s
    try:
        fixed = s.encode("mac_roman").decode("utf-8")
        if fixed and "\ufffd" not in fixed:
            return fixed
    except (UnicodeEncodeError, UnicodeDecodeError):
        pass
    return s


def load(url: str):
    with urllib.request.urlopen(url, timeout=120) as resp:
        raw = resp.read()
    text = bz2.decompress(raw).decode("utf-8", errors="replace")
    return list(csv.DictReader(io.StringIO(text))), len(raw)


def main() -> None:
    rows = []

    print("Lade Aktien ...")
    equities, size = load(EQUITIES)
    print(f"  {size / 1e6:.1f} MB, {len(equities)} Zeilen")
    for row in equities:
        cap = CAPS.get(row.get("market_cap", ""))
        if not cap:
            continue
        if row.get("delisted", "").strip().lower() == "true":
            continue
        sym = row.get("symbol", "").strip()
        name = fix_text(row.get("name", "").strip())
        if not sym or not name:
            continue
        rows.append([
            sym, name,
            row.get("country", "").strip(),
            row.get("exchange", "").strip(),
            row.get("sector", "").strip(),
            cap,
        ])
    n_equ = len(rows)
    print(f"  -> {n_equ} Aktien uebernommen")

    print("Lade ETFs ...")
    etfs, size = load(ETFS)
    print(f"  {size / 1e6:.1f} MB, {len(etfs)} Zeilen")

    # Je ISIN die beste Notierung waehlen. Nur Fonds mit ISIN an einer
    # Hauptboerse – das ergibt die bekannten, handelbaren Standard-ETFs und
    # haelt die Datei schlank.
    best = {}
    for row in etfs:
        sym = row.get("symbol", "").strip()
        name = fix_text(row.get("name", "").strip())
        if not sym or not name:
            continue
        isin = row.get("isin", "").strip().upper()
        exch = row.get("exchange", "").strip()
        if not isin or exch not in ETF_PRIO:
            continue
        prio = ETF_PRIO[exch]
        prev = best.get(isin)
        if prev is None or prio < prev[0]:
            kat = (row.get("category") or row.get("category_group") or "").strip()
            fam = (row.get("family") or "").strip()
            best[isin] = (prio, [sym, name, fam, exch, kat or "ETF", "ETF"])

    n_etf = 0
    for _, (_, entry) in best.items():
        rows.append(entry)
        n_etf += 1
    print(f"  -> {n_etf} ETFs uebernommen (je Fonds eine Notierung)")

    rows.sort(key=lambda x: (ORDER.get(x[5], 9), x[1].lower()))

    target = os.path.abspath(TARGET)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"Fertig: {len(rows)} Eintraege ({n_equ} Aktien + {n_etf} ETFs) -> {target}")


if __name__ == "__main__":
    main()
