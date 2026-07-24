#!/usr/bin/env python3
"""Erzeugt data/tickers.json aus der FinanceDatabase (global, Mega/Large/Mid Cap).

Wird woechentlich von der GitHub Action ausgefuehrt, kann aber auch lokal laufen:
    python3 scripts/build_tickers.py
"""
import bz2
import csv
import io
import json
import os
import urllib.request

SOURCE = "https://raw.githubusercontent.com/JerBouma/FinanceDatabase/main/compression/equities.bz2"
TARGET = os.path.join(os.path.dirname(__file__), "..", "data", "tickers.json")
CAPS = {"Mega Cap": "XL", "Large Cap": "L", "Mid Cap": "M"}
ORDER = {"XL": 0, "L": 1, "M": 2}


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


def main() -> None:
    print("Lade Quelldatenbank ...")
    with urllib.request.urlopen(SOURCE, timeout=120) as resp:
        raw = resp.read()
    print(f"  {len(raw) / 1e6:.1f} MB geladen, entpacke ...")
    text = bz2.decompress(raw).decode("utf-8", errors="replace")
    reader = csv.DictReader(io.StringIO(text))

    rows = []
    for row in reader:
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
            sym,
            name,
            row.get("country", "").strip(),
            row.get("exchange", "").strip(),
            row.get("sector", "").strip(),
            cap,
        ])

    rows.sort(key=lambda x: (ORDER[x[5]], x[1].lower()))

    target = os.path.abspath(TARGET)
    os.makedirs(os.path.dirname(target), exist_ok=True)
    with open(target, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, ensure_ascii=False, separators=(",", ":"))
    print(f"Fertig: {len(rows)} Titel -> {target}")


if __name__ == "__main__":
    main()
