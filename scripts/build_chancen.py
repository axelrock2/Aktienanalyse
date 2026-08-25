#!/usr/bin/env python3
"""Erzeugt data/chancen.json - den taeglich vorgerechneten Chancenraum.

Fuer jeden Titel des Korbs werden Kurse geholt, die Zonen berechnet und eine
Chancen-Bewertung vergeben. Uebrig bleiben die Titel, deren Kurs nahe an der
Zonenbasis steht UND die noch Luft bis Ziel 1 haben.

Der Korb steht in scripts/chancen_watchlist.txt (ein Ticker je Zeile). Die
Liste ist oeffentlich und bewusst getrennt vom Depot - ein Depot gehoert nie
ins Repository.

SPEICHERPLATZ: Die Datei traegt die aktuelle Liste plus einen kurzen Verlauf
(nur Datum und Trefferzahl je Tag, keine Titeldaten). Der Verlauf wird bei
jedem Lauf auf AUFBEWAHRUNG_TAGE gekuerzt, damit die Datei nicht mitwaechst.
Sie bleibt dadurch dauerhaft im Bereich weniger Kilobyte.

Aufruf:
    python3 scripts/build_chancen.py
"""
import datetime
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request

import chancen_core

HIER = os.path.dirname(__file__)
KORB = os.path.join(HIER, "chancen_watchlist.txt")
ZIEL = os.path.join(HIER, "..", "data", "chancen.json")
TICKER = os.path.join(HIER, "..", "data", "tickers.json")

# Wie lange der Tagesverlauf aufbewahrt wird, bevor er geloescht wird.
AUFBEWAHRUNG_TAGE = 30
# Wie viele Titel hoechstens in die Datei kommen - deckelt sie nach oben.
MAX_TITEL = 60

# BEWUSST OHNE User-Agent: Der Textleser antwortet mit 403, sobald sich die
# Anfrage als Browser ausgibt, und mit 200, wenn sie es laesst. Nachgemessen -
# derselbe Aufruf, einziger Unterschied ist die Kennung.
KOPF = {"x-respond-with": "text"}
# Yahoo sperrt Rechenzentrums-Adressen zeitweise mit 429; ueber den Textleser
# kommen die Kurse zuverlaessig an - derselbe Weg, den auch die Seite im
# Browser nutzt.
QUELLE = ("https://r.jina.ai/https://query1.finance.yahoo.com"
          "/v8/finance/chart/{sym}?range=2y&interval=1d")


def hole_kurse(symbol, versuche=3):
    """Tageskurse als (schluss, hoch, tief). None, wenn nichts zu holen ist."""
    url = QUELLE.format(sym=urllib.parse.quote(symbol, safe=""))
    for i in range(versuche):
        try:
            req = urllib.request.Request(url, headers=KOPF)
            with urllib.request.urlopen(req, timeout=45) as r:
                roh = r.read().decode("utf-8", "replace")
            start = roh.find("{")
            if start < 0:
                raise ValueError("keine Daten in der Antwort")
            d = json.loads(roh[start:])
            ergebnisse = (d.get("chart") or {}).get("result")
            if not ergebnisse:
                # Yahoo meldet unbekannte oder eingestellte Symbole so - das ist
                # kein Netzfehler und darf nicht wiederholt werden.
                fehler = ((d.get("chart") or {}).get("error") or {}).get("description")
                print("    %s: %s" % (symbol, fehler or "keine Kursreihe geliefert"))
                return None
            erg = ergebnisse[0]
            q = erg["indicators"]["quote"][0]
            schluss, hoch, tief = [], [], []
            for j, c in enumerate(q.get("close") or []):
                if c is None:
                    continue
                schluss.append(c)
                h = (q.get("high") or [None] * (j + 1))[j]
                t = (q.get("low") or [None] * (j + 1))[j]
                hoch.append(h if h is not None else c)
                tief.append(t if t is not None else c)
            if len(schluss) < 60:
                return None
            return schluss, hoch, tief, (erg.get("meta") or {}).get("currency")
        except Exception as e:
            if i == versuche - 1:
                print("    %s: keine Kurse (%s)" % (symbol, e))
                return None
            time.sleep(2 + i * 2)
    return None


def lade_stammdaten():
    """Symbol -> (Name, Land, Sektor) aus der Tickerdatenbank.

    Der Name wandert mit in die Ausgabedatei, damit die Anzeige nicht auf das
    Laden der 1,8-MB-Datenbank warten muss - und damit Titel, die dort fehlen,
    trotzdem einen Klarnamen bekommen koennen. "HON" etwa steht nicht darin,
    obwohl Yahoo Kurse dazu liefert.
    """
    pfad = os.path.abspath(TICKER)
    if not os.path.exists(pfad):
        return {}
    try:
        rows = json.load(open(pfad, encoding="utf-8"))
    except Exception:
        return {}
    m = {}
    for r in rows:
        if r and r[0] not in m:
            m[r[0]] = (r[1], r[2] if len(r) > 2 else "", r[4] if len(r) > 4 else "")
    return m


def lade_korb():
    if not os.path.exists(KORB):
        print("Kein Korb unter %s - nichts zu tun." % KORB)
        return []
    raus, gesehen, namen = [], set(), {}
    for zeile in open(KORB, encoding="utf-8"):
        t = zeile.strip()
        if not t or t.startswith("#"):
            continue
        teile = t.split(None, 1)
        sym = teile[0].upper()
        if sym in gesehen:
            continue
        gesehen.add(sym)
        raus.append(sym)
        # Hinter dem Ticker darf ein Klarname stehen. Gedacht fuer Titel, die
        # in der Tickerdatenbank fehlen - "HON" etwa steht dort nicht, obwohl
        # Yahoo Kurse liefert. Ohne Zusatz bleibt es beim Datenbankeintrag.
        if len(teile) > 1 and teile[1].strip():
            namen[sym] = teile[1].strip()
    return raus, namen


def alter_verlauf():
    """Bisherigen Verlauf einlesen und dabei Altes wegwerfen."""
    pfad = os.path.abspath(ZIEL)
    if not os.path.exists(pfad):
        return {}
    try:
        alt = json.load(open(pfad, encoding="utf-8"))
    except Exception:
        return {}
    verlauf = alt.get("verlauf") or {}
    grenze = (datetime.date.today()
              - datetime.timedelta(days=AUFBEWAHRUNG_TAGE)).isoformat()
    behalten = {k: v for k, v in verlauf.items() if k >= grenze}
    entfernt = len(verlauf) - len(behalten)
    if entfernt:
        print("Verlauf: %d Eintraege aelter als %d Tage geloescht."
              % (entfernt, AUFBEWAHRUNG_TAGE))
    return behalten


def main():
    symbole, eigene_namen = lade_korb()
    if not symbole:
        return
    stamm = lade_stammdaten()
    print("%d Titel im Korb (%d Stammdatensaetze)" % (len(symbole), len(stamm)))

    treffer = []
    for i, sym in enumerate(symbole, 1):
        daten = hole_kurse(sym)
        if not daten:
            print("  [%d/%d] %-10s -" % (i, len(symbole), sym))
            continue
        schluss, hoch, tief, waehrung = daten
        z = chancen_core.zonen(schluss, hoch, tief)
        b = chancen_core.bewerte(z) if z else None
        if not b:
            print("  [%d/%d] %-10s ausserhalb" % (i, len(symbole), sym))
        else:
            st = stamm.get(sym) or stamm.get(sym.split(".")[0]) or ("", "", "")
            klarname = eigene_namen.get(sym) or st[0] or sym
            treffer.append({
                "sym": sym,
                "name": klarname,
                "land": st[1],
                "sektor": st[2],
                "waehrung": waehrung or "",
                "kurs": round(z["kurs"], 4),
                "stop": round(z["stop"], 4),
                "einstieg_tief": round(z["einstieg_tief"], 4),
                "einstieg_hoch": round(z["einstieg_hoch"], 4),
                "mitte": round(z["mitte"], 4),
                "atr": round(z["atr"], 4),
                "ziel1": round(z["ziel1"], 4),
                # Ziel 2 darf fehlen - es wird nicht mehr erfunden, wenn ueber
                # Ziel 1 kein weiterer Widerstand liegt.
                "ziel2": round(z["ziel2"], 4) if z["ziel2"] else None,
                "crv": round(z["crv"], 2) if z["crv"] else None,
                "trend_auf": z["trend_auf"],
                "punkte": b["punkte"],
                "lage": b["lage"],
                "risiko_prozent": b["risiko_prozent"],
                "naehe_prozent": b["naehe_prozent"],
                "chance_prozent": b["chance_prozent"],
            })
            print("  [%d/%d] %-10s %3d Punkte · %-8s · %.1f%% zur Basis · "
                  "Chance %.1f%% / Risiko %.1f%% = C/R %.2f"
                  % (i, len(symbole), sym, b["punkte"], b["lage"],
                     b["naehe_prozent"], b["chance_prozent"],
                     b["risiko_prozent"], z["crv"]))
        time.sleep(0.8)          # hoeflich gegenueber dem Textleser bleiben

    treffer.sort(key=lambda x: -x["punkte"])
    treffer = treffer[:MAX_TITEL]

    heute = datetime.date.today().isoformat()
    verlauf = alter_verlauf()
    verlauf[heute] = len(treffer)

    ziel = os.path.abspath(ZIEL)
    os.makedirs(os.path.dirname(ziel), exist_ok=True)
    nutzlast = {
        "generated": int(time.time()),
        "geprueft": len(symbole),
        "aufbewahrung_tage": AUFBEWAHRUNG_TAGE,
        "titel": treffer,
        "verlauf": dict(sorted(verlauf.items())),
    }
    with open(ziel, "w", encoding="utf-8") as fh:
        json.dump(nutzlast, fh, ensure_ascii=False, separators=(",", ":"))
    groesse = os.path.getsize(ziel)
    print("\nFertig: %d von %d Titeln im Chancenraum (%.1f KB, Verlauf %d Tage)"
          % (len(treffer), len(symbole), groesse / 1024, len(verlauf)))


if __name__ == "__main__":
    main()
