#!/usr/bin/env python3
"""Erzeugt data/faktoren.json - Faktorrenditen und Zinsen fuer das Cockpit.

Zwei Dinge, die der Browser nicht selbst holen kann:

1. Die Faktorrenditen von Kenneth French. Die Dateien liegen als ZIP, und der
   Server setzt keinen CORS-Kopf - aus dem Browser sind sie nicht erreichbar.
   Darin stehen die Renditen der Faktorportfolios: Markt, Groesse (SMB), Wert
   (HML), Profitabilitaet (RMW), Investition (CMA) und Momentum. Mit ihnen
   laesst sich die Frage beantworten, die Carhart (1997) gestellt hat: Wie viel
   der Kursbewegung eines Titels erklaeren bekannte Faktoren - und bleibt
   danach noch etwas uebrig?

2. Ein Zinssatz in Euro. Yahoo fuehrt keine Bundesanleihe; das Cockpit rechnet
   deshalb bisher auch fuer Euro-Titel mit dem US-Zins und sagt das dazu. Die
   EZB stellt die Reihe bereit, ebenfalls ohne CORS-Kopf.

Aufruf:
    python3 scripts/build_faktoren.py
"""

import io
import json
import os
import time
import urllib.request
import zipfile

WURZEL = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ZIEL = os.path.join(WURZEL, "data", "faktoren.json")

FF = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"

# Je Region: die Fuenf-Faktoren-Datei und die Momentum-Datei dazu.
# Die Momentum-Spalte heisst in den US-Dateien "Mom", in den europaeischen
# "WML" - dasselbe Portfolio, anderer Name.
REGIONEN = {
    "US": {
        "name": "USA",
        "quelle": "Kenneth R. French Data Library, CRSP",
        "fuenf": "F-F_Research_Data_5_Factors_2x3_CSV.zip",
        "momentum": "F-F_Momentum_Factor_CSV.zip",
    },
    "EU": {
        "name": "Europa",
        "quelle": "Kenneth R. French Data Library, Bloomberg",
        "fuenf": "Europe_5_Factors_CSV.zip",
        "momentum": "Europe_Mom_Factor_CSV.zip",
    },
    "JP": {
        "name": "Japan",
        "quelle": "Kenneth R. French Data Library, Bloomberg",
        "fuenf": "Japan_5_Factors_CSV.zip",
        "momentum": "Japan_Mom_Factor_CSV.zip",
    },
    "AP": {
        "name": "Asien-Pazifik ohne Japan",
        "quelle": "Kenneth R. French Data Library, Bloomberg",
        "fuenf": "Asia_Pacific_ex_Japan_5_Factors_CSV.zip",
        "momentum": "Asia_Pacific_ex_Japan_MOM_Factor_CSV.zip",
    },
}

# So viele Monate werden ausgeliefert. 240 reichen fuer jedes Fenster, das das
# Cockpit anbietet, und kosten gepackt wenige Kilobyte.
MONATE = 240
# In den Dateien steht -99.99 fuer "kein Wert".
FEHLT = -99.0

# Nur der Euro-Zins. Fuer den Dollarraum liefert ^TNX ueber die ohnehin
# genutzte Kursquelle einen aktuellen Tageswert - eine Monatsreihe der EZB
# waere dort ein Rueckschritt. Die EZB fuehrt die US-Reihe unter diesem
# Schluessel ohnehin nicht (geprueft: HTTP 404).
ZINSEN = {
    "EUR": {
        "name": "10-jährige Bundesanleihe",
        "url": "https://data-api.ecb.europa.eu/service/data/IRS/M.DE.L.L40.CI.0000.EUR.N.Z"
               "?format=csvdata&lastNObservations=1",
    },
}


def hole(url, versuche=3):
    """Rohdaten holen.

    Bewusst ohne eigene Kopfzeilen: Dieselbe Erfahrung wie bei der FRED in
    build_fundamentals.py - ein gesetzter User-Agent fuehrt bei manchen dieser
    Server dazu, dass die Verbindung angenommen wird und nie antwortet.
    """
    for i in range(versuche):
        try:
            with urllib.request.urlopen(url, timeout=60) as r:
                return r.read()
        except Exception as e:
            if i == versuche - 1:
                print(f"    Fehler: {e}")
                return None
            time.sleep(2 + 2 * i)
    return None


def monatsblock(text):
    """Die Monatszeilen einer French-Datei einlesen.

    Aufbau der Dateien: einige Zeilen Erlaeuterung, dann die Spaltenkoepfe,
    dann die Monate als JJJJMM, dann eine Leerzeile und danach dieselben Daten
    als JAHRESwerte. Wer nur auf "Zeile beginnt mit Ziffern" prueft, liest die
    Jahreszeilen als Monate mit und verschiebt damit die ganze Reihe.
    """
    kopf, zeilen = None, {}
    for roh in text.splitlines():
        z = roh.strip()
        if not z:
            continue
        teile = [t.strip() for t in z.split(",")]
        if kopf is None:
            # Der Kopf ist die erste Zeile, deren erstes Feld leer ist.
            if teile[0] == "" and len(teile) > 1:
                kopf = teile[1:]
            continue
        if not (teile[0].isdigit() and len(teile[0]) == 6):
            # Keine Monatszeile. Ab der ersten Jahreszeile ist der Monatsblock
            # zu Ende - weiterlesen wuerde nur noch Jahreswerte einsammeln.
            if teile[0].isdigit() and len(teile[0]) == 4 and zeilen:
                break
            continue
        try:
            werte = [float(x) for x in teile[1:len(kopf) + 1]]
        except ValueError:
            continue
        zeilen[teile[0]] = werte
    return kopf, zeilen


def lies_zip(datei):
    roh = hole(FF + datei)
    if not roh:
        return None, None
    try:
        with zipfile.ZipFile(io.BytesIO(roh)) as z:
            name = z.namelist()[0]
            text = z.read(name).decode("utf-8", "replace")
    except Exception as e:
        print(f"    {datei} nicht lesbar: {e}")
        return None, None
    return monatsblock(text)


def region(schluessel, cfg):
    print(f"  {schluessel}: {cfg['fuenf']}")
    kopf5, daten5 = lies_zip(cfg["fuenf"])
    if not daten5:
        return None
    print(f"       {len(daten5)} Monate, Spalten {kopf5}")
    print(f"  {schluessel}: {cfg['momentum']}")
    kopfM, datenM = lies_zip(cfg["momentum"])
    if datenM:
        print(f"       {len(datenM)} Monate, Spalten {kopfM}")

    # Mkt-RF, SMB, HML, RMW, CMA, RF - die Reihenfolge steht im Dateikopf,
    # verlassen wird sich hier nicht darauf.
    idx = {name: i for i, name in enumerate(kopf5)}
    noetig = ["Mkt-RF", "SMB", "HML", "RMW", "CMA", "RF"]
    if any(n not in idx for n in noetig):
        print(f"       erwartete Spalten fehlen: {kopf5}")
        return None

    monate = sorted(daten5.keys())[-MONATE:]
    spalten = ["MktRF", "SMB", "HML", "RMW", "CMA", "Mom"]
    werte, rf, behalten = [], [], []
    for m in monate:
        z = daten5[m]
        reihe = [z[idx[n]] for n in ["Mkt-RF", "SMB", "HML", "RMW", "CMA"]]
        mom = (datenM.get(m) or [None])[0] if datenM else None
        reihe.append(mom)
        zins = z[idx["RF"]]
        # Ein fehlender Wert faelscht jede Regression, in die er eingeht -
        # der Monat faellt heraus, statt mit -99,99 mitzurechnen.
        if any(x is None or x <= FEHLT for x in reihe) or zins <= FEHLT:
            continue
        behalten.append(m)
        werte.append([round(x / 100, 6) for x in reihe])
        rf.append(round(zins / 100, 6))

    if len(behalten) < 36:
        print(f"       nur {len(behalten)} brauchbare Monate - verworfen")
        return None
    print(f"       {len(behalten)} brauchbare Monate, {behalten[0]} bis {behalten[-1]}")
    return {
        "name": cfg["name"], "quelle": cfg["quelle"],
        "spalten": spalten, "monate": behalten, "werte": werte, "rf": rf,
        "von": behalten[0], "bis": behalten[-1],
    }


def zins(cfg):
    roh = hole(cfg["url"], versuche=2)
    if not roh:
        return None
    zeilen = roh.decode("utf-8", "replace").splitlines()
    if len(zeilen) < 2:
        return None
    kopf = [c.strip() for c in zeilen[0].split(",")]
    try:
        iz, iw = kopf.index("TIME_PERIOD"), kopf.index("OBS_VALUE")
    except ValueError:
        return None
    letzte = [c.strip() for c in zeilen[-1].split(",")]
    try:
        wert = float(letzte[iw])
    except (ValueError, IndexError):
        return None
    if not (0 <= wert < 25):
        return None
    return {"name": cfg["name"], "wert": round(wert / 100, 5),
            "stand": letzte[iz], "quelle": "EZB Data Portal"}


def main():
    print("Faktorrenditen holen …")
    regionen = {}
    for k, cfg in REGIONEN.items():
        r = region(k, cfg)
        if r:
            regionen[k] = r

    print("\nZinsen holen …")
    zinsen = {}
    for w, cfg in ZINSEN.items():
        z = zins(cfg)
        if z:
            zinsen[w] = z
            print(f"  {w}: {z['wert'] * 100:.2f} % ({z['name']}, Stand {z['stand']})")
        else:
            print(f"  {w}: nicht erreichbar")

    if not regionen:
        print("\nKeine Faktordaten - bestehende Datei bleibt unveraendert.")
        return 1

    stand = max(r["bis"] for r in regionen.values())
    aus = {"generated": int(time.time()), "stand": stand,
           "regionen": regionen, "zinsen": zinsen}
    os.makedirs(os.path.dirname(ZIEL), exist_ok=True)
    with open(ZIEL, "w", encoding="utf-8") as fh:
        json.dump(aus, fh, ensure_ascii=False, separators=(",", ":"))
    groesse = os.path.getsize(ZIEL)
    print(f"\nFertig: {len(regionen)} Regionen, Stand {stand}, "
          f"{len(zinsen)} Zinsreihen -> {ZIEL} ({groesse / 1024:.0f} KB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
