#!/usr/bin/env python3
"""Rechenkern des Chancenraums: Zonen und Bewertung je Titel.

Bildet die Zonenlogik aus app.js Zeichen fuer Zeichen nach, damit die
serverseitig erzeugte Liste und die Anzeige im Browser dieselben Zahlen
zeigen. Weicht hier etwas ab, stuenden im Chancenraum andere Werte als auf
der Karte desselben Titels - genau die Art stillen Fehlers, die man erst
bemerkt, wenn man ihm schon geglaubt hat.

Eine Eigenheit der Zonendefinition, die den Chancenraum praegt: Die
Zonenbasis ist die naechste Unterstuetzung UNTERHALB des Kurses (Pivot-Tief,
GD 50 oder GD 200, je nachdem welche am hoechsten liegt). Die Zone wandert
damit mit dem Kurs mit - ein Titel kann strukturell nie unter seiner eigenen
Einstiegszone stehen. Aussagekraeftig ist deshalb nicht "drueber oder
drunter", sondern der ABSTAND zur Basis: je naeher der Kurs an ihr steht,
desto eher ist er zurueckgekommen.

Selbsttest:
    python3 scripts/chancen_core.py
"""

# Ab welchem Abstand zur Zonenbasis ein Titel nicht mehr als Chance gilt.
# 3,5 Prozent ist die Zonenbreite aus app.js; darueber hinaus wird bis zu
# dieser Grenze noch als "nahe" gefuehrt.
ZONENBREITE = 0.035
NAEHE_GRENZE = 0.20        # 20 Prozent ueber der Basis - danach keine Aufnahme
CHANCE_MIN = 0.05          # unter 5 Prozent Luft bis Ziel 1 lohnt die Aufnahme nicht


def sma(werte, n):
    if len(werte) < n:
        return None
    return sum(werte[-n:]) / n


def pivots(hochs, tiefs, lookback=140, w=4):
    """Lokale Hoch- und Tiefpunkte - identisch zu pivots() in app.js."""
    n = len(hochs)
    von = max(w, n - lookback)
    ph, pt = [], []
    for i in range(von, n - w):
        ist_h = ist_t = True
        for j in range(i - w, i + w + 1):
            if hochs[j] > hochs[i]:
                ist_h = False
            if tiefs[j] < tiefs[i]:
                ist_t = False
        if ist_h:
            ph.append(hochs[i])
        if ist_t:
            pt.append(tiefs[i])
    return ph, pt


def zonen(schluss, hochs, tiefs):
    """Stop, Einstiegszone, Ziele und Chance/Risiko - wie analyse() in app.js."""
    if len(schluss) < 60:
        return None
    kurs = schluss[-1]
    s50, s200 = sma(schluss, 50), sma(schluss, 200)
    hoch52 = max(schluss[-252:]) if len(schluss) >= 252 else max(schluss)
    tief52 = min(schluss[-252:]) if len(schluss) >= 252 else min(schluss)

    ph, pt = pivots(hochs, tiefs)
    unterstuetzungen = [x for x in pt if x < kurs * 0.995]
    widerstaende = [x for x in ph if x > kurs * 1.005]
    stuetze = max(unterstuetzungen) if unterstuetzungen else None
    widerstand = min(widerstaende) if widerstaende else None

    kandidaten = [x for x in (stuetze, s50, s200)
                  if x is not None and x < kurs * 0.995]
    basis = max(kandidaten) if kandidaten else tief52
    if not basis or basis <= 0:
        return None

    einstieg_tief = basis
    einstieg_hoch = min(kurs, basis * (1 + ZONENBREITE))
    stop = basis * 0.955
    ziel1 = widerstand if widerstand is not None else hoch52
    ziel2 = max(hoch52, ziel1 * 1.06)
    mitte = (einstieg_tief + einstieg_hoch) / 2
    crv = ((ziel1 - mitte) / (mitte - stop)
           if (mitte > stop and ziel1 > mitte) else None)

    return {
        "kurs": kurs, "stop": stop,
        "einstieg_tief": einstieg_tief, "einstieg_hoch": einstieg_hoch,
        "ziel1": ziel1, "ziel2": ziel2, "crv": crv,
        "s50": s50, "s200": s200, "hoch52": hoch52, "tief52": tief52,
        "trend_auf": bool(s200 and kurs > s200),
    }


def lin(wert, von, bis):
    """Auf 0..100 abbilden; von>bis dreht die Richtung um."""
    if wert is None:
        return None
    if von == bis:
        return 50.0
    x = (wert - von) / (bis - von)
    return max(0.0, min(100.0, x * 100))


def bewerte(z):
    """Chancen-Bewertung. Gibt None, wenn der Titel nicht in den Raum gehoert.

    Zwei Groessen tragen die Bewertung:
      Naehe   - Abstand des Kurses zur Zonenbasis. Null heisst: der Kurs steht
                genau auf der Unterstuetzung.
      Chance  - Luft bis Ziel 1 in Prozent.
    Beide gehen gewichtet ein; die Naehe wiegt schwerer, weil sie das
    eigentliche Kriterium ist - die Chance allein waere nur ein weit entferntes
    Ziel, das jeder gefallene Titel vorweisen kann.
    """
    kurs, basis = z["kurs"], z["einstieg_tief"]
    if not kurs or not basis or basis <= 0:
        return None

    naehe = kurs / basis - 1                     # 0 = auf der Basis
    chance = z["ziel1"] / kurs - 1 if z["ziel1"] and kurs else None

    if naehe > NAEHE_GRENZE:
        return None
    if chance is None or chance < CHANCE_MIN:
        return None

    naehe_punkte = lin(naehe, NAEHE_GRENZE, 0.0)     # naeher = mehr Punkte
    chance_punkte = lin(chance, CHANCE_MIN, 0.40)
    punkte = round(naehe_punkte * 0.6 + chance_punkte * 0.4)

    if naehe <= ZONENBREITE:
        lage = "in_zone"
    elif naehe <= 0.08:
        lage = "nahe"
    else:
        lage = "umfeld"

    return {"punkte": punkte, "lage": lage,
            "naehe_prozent": round(naehe * 100, 2),
            "chance_prozent": round(chance * 100, 2)}


def _selbsttest():
    fehler = 0

    # Aufsteigende Reihe mit klarem Tief: Basis muss unter dem Kurs liegen
    reihe = [100 + i * 0.5 for i in range(300)]
    z = zonen(reihe, [x * 1.01 for x in reihe], [x * 0.99 for x in reihe])
    if not z or z["einstieg_tief"] >= z["kurs"]:
        print("  FEHLER: Zonenbasis liegt nicht unter dem Kurs")
        fehler += 1
    if z and z["stop"] >= z["einstieg_tief"]:
        print("  FEHLER: Stop liegt nicht unter der Zonenbasis")
        fehler += 1

    # Zu kurze Reihe darf nichts liefern statt zu raten
    if zonen([1, 2, 3], [1, 2, 3], [1, 2, 3]) is not None:
        print("  FEHLER: zu kurze Reihe liefert trotzdem Zonen")
        fehler += 1

    # Bewertung: naeher an der Basis muss mehr Punkte geben
    grund = {"kurs": 100, "einstieg_tief": 100, "ziel1": 130,
             "einstieg_hoch": 103, "stop": 95, "ziel2": 140, "crv": 2}
    nah = bewerte(dict(grund))
    fern = bewerte(dict(grund, kurs=118, ziel1=150))
    if not nah or not fern or nah["punkte"] <= fern["punkte"]:
        print("  FEHLER: Naehe zur Basis wird nicht hoeher bewertet")
        fehler += 1
    if nah["lage"] != "in_zone":
        print("  FEHLER: Kurs auf der Basis gilt nicht als in_zone (%s)" % nah["lage"])
        fehler += 1

    # Zu weit ueber der Basis -> gehoert nicht in den Raum
    if bewerte(dict(grund, kurs=140, ziel1=200)) is not None:
        print("  FEHLER: Titel weit ueber der Basis wird aufgenommen")
        fehler += 1

    # Zu wenig Luft bis Ziel -> ebenfalls nicht
    if bewerte(dict(grund, ziel1=102)) is not None:
        print("  FEHLER: Titel ohne Luft bis Ziel wird aufgenommen")
        fehler += 1

    print("Selbsttest bestanden." if not fehler else "%d Fehler." % fehler)
    return fehler == 0


if __name__ == "__main__":
    _selbsttest()
