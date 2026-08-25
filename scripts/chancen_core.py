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

# --- In ATR gemessene Groessen -----------------------------------------------
# Fruehere Fassung: Stop fest 4,5 Prozent unter der Basis, Ziel 1 der naechste
# Widerstand ueberhaupt. Beides an 32 Titeln nachgemessen, beides untauglich:
#
#   Der feste Stop entsprach je nach Titel 0,69 bis 2,84 ATR - Faktor vier
#   Unterschied im tatsaechlichen Risiko bei gleicher Prozentzahl. Bei zwoelf
#   von 32 Titeln lag er innerhalb von 1,5 ATR, also im normalen Tagesrauschen.
#
#   Und weil Ziel 1 der NAECHSTE Widerstand war (Median 2,8 Prozent entfernt),
#   der Stop aber fest 4,3 Prozent, kam das Chance/Risiko-Verhaeltnis
#   strukturell unter 1 heraus: Median 0,98, nur 25 Prozent erreichten die
#   2:1-Marke, die die App selbst als Richtwert nennt. Zwei unvereinbare
#   Massstaebe - einer aus dem Chart, einer eine Konstante.
#
# Jetzt werden beide Seiten in derselben Einheit gemessen, der Tagesspanne:
STOP_ATR = 1.5             # Stop 1,5 ATR unter der Zonenbasis
RAUSCH_ATR = 1.0           # Widerstaende naeher als 1 ATR sind kein Niveau
#
# Wirkung an denselben 32 Titeln: Median C/R 1,66 statt 0,98, Median Chance
# 10,0 statt 2,8 Prozent. Fuenf von 25 liegen weiterhin unter 1,0 - die
# Kennzahl kann also weiter "schlechtes Setup" sagen. Eine engere Rauschgrenze
# haette alle ueber 1,0 gehoben, das waere eingebaute Schoenfaerberei.

# Skala der Chancen-Punkte, am 10. und 90. Perzentil der gemessenen Verteilung.
# Zuvor 5 bis 40 Prozent - die 40 wurden nie erreicht, der Median lag bei 13
# von 100 Punkten, die Skala nutzte ihr unteres Drittel.
CHANCE_MIN = 0.04
CHANCE_MAX = 0.28


def atr(hochs, tiefs, schluss, n=14):
    """Mittlere Tagesspanne - das Mass, in dem Stop und Ziel gerechnet werden."""
    if len(schluss) < n + 1:
        return None
    tr = []
    for i in range(1, len(schluss)):
        tr.append(max(hochs[i] - tiefs[i],
                      abs(hochs[i] - schluss[i - 1]),
                      abs(tiefs[i] - schluss[i - 1])))
    return sum(tr[-n:]) / n


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
    """Stop, Einstiegszone, Ziele und Chance/Risiko.

    Alle Abstaende in ATR gemessen, damit beide Seiten des Verhaeltnisses
    denselben Massstab tragen - siehe die Begruendung bei STOP_ATR oben.
    """
    if len(schluss) < 60:
        return None
    kurs = schluss[-1]
    spanne = atr(hochs, tiefs, schluss)
    if not spanne or spanne <= 0:
        return None

    s50, s200 = sma(schluss, 50), sma(schluss, 200)
    # Aus den TAGESHOCHS beziehungsweise -tiefs, nicht aus den Schlusskursen -
    # so ist das 52-Wochen-Hoch ueblicherweise definiert, und so rechnet auch
    # app.js. Zuvor stand hier max(schluss[...]): Bei Adobe ergab das 367,46
    # statt 370,86, und Chancenraum und Karte zeigten fuer denselben Titel
    # verschiedene Ziele.
    hoch52 = max(hochs[-252:]) if len(hochs) >= 252 else max(hochs)
    tief52 = min(tiefs[-252:]) if len(tiefs) >= 252 else min(tiefs)

    ph, pt = pivots(hochs, tiefs)
    unterstuetzungen = [x for x in pt if x < kurs * 0.995]
    stuetze = max(unterstuetzungen) if unterstuetzungen else None

    kandidaten = [x for x in (stuetze, s50, s200)
                  if x is not None and x < kurs * 0.995]
    basis = max(kandidaten) if kandidaten else tief52
    if not basis or basis <= 0:
        return None

    # Ziele. Ein Widerstand naeher als RAUSCH_ATR ist kein Niveau, sondern
    # Tagesrauschen - er wird uebersprungen, nicht zum Ziel erklaert.
    schwelle = kurs + RAUSCH_ATR * spanne
    widerstaende = sorted(x for x in ph if x > schwelle)
    ziel1 = widerstaende[0] if widerstaende else (hoch52 if hoch52 > schwelle else None)
    if ziel1 is None:
        # Kein belastbares Ziel - ehrlicher als eines zu erfinden.
        return None

    # Ziel 2 ist der naechste Widerstand UEBER Ziel 1, sonst das
    # 52-Wochen-Hoch, sonst gar keines. Frueher stand hier
    # max(hoch52, ziel1 * 1.06): Das war mal das eine, mal das andere - der
    # Abstand ueber Ziel 1 reichte von 6 bis 120 Prozent, zwei verschiedene
    # Begriffe unter einem Namen.
    darueber = [x for x in widerstaende if x > ziel1 * 1.01]
    ziel2 = darueber[0] if darueber else (hoch52 if hoch52 > ziel1 * 1.01 else None)

    einstieg_tief = basis
    einstieg_hoch = min(kurs, basis * (1 + ZONENBREITE))
    stop = basis - STOP_ATR * spanne
    mitte = (einstieg_tief + einstieg_hoch) / 2
    if stop <= 0 or mitte <= stop or ziel1 <= mitte:
        return None
    crv = (ziel1 - mitte) / (mitte - stop)

    return {
        "kurs": kurs, "atr": spanne, "stop": stop,
        "einstieg_tief": einstieg_tief, "einstieg_hoch": einstieg_hoch,
        "mitte": mitte,
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
      Chance  - Weg bis Ziel 1, gemessen AB DER ZONENMITTE.

    Der Bezugspunkt ist wichtig: Frueher rechnete die Chance ab dem Kurs,
    das Chance/Risiko-Verhaeltnis aber ab der Zonenmitte - und beide standen
    nebeneinander in derselben Zeile. Bei Apple etwa "+1,9 Prozent bis Ziel 1"
    neben einem C/R, das mit 2,8 Prozent rechnete. Jetzt tragen beide denselben
    Bezug: die Mitte der Einstiegszone, also den Punkt, an dem man kaufen wuerde.
    """
    kurs, basis = z["kurs"], z["einstieg_tief"]
    if not kurs or not basis or basis <= 0:
        return None

    naehe = kurs / basis - 1                     # 0 = auf der Basis
    mitte = z["mitte"]
    chance = z["ziel1"] / mitte - 1 if z["ziel1"] and mitte else None

    if naehe > NAEHE_GRENZE:
        return None
    if chance is None or chance < CHANCE_MIN:
        return None

    naehe_punkte = lin(naehe, NAEHE_GRENZE, 0.0)     # naeher = mehr Punkte
    chance_punkte = lin(chance, CHANCE_MIN, CHANCE_MAX)
    punkte = round(naehe_punkte * 0.6 + chance_punkte * 0.4)

    if naehe <= ZONENBREITE:
        lage = "in_zone"
    elif naehe <= 0.08:
        lage = "nahe"
    else:
        lage = "umfeld"

    return {"punkte": punkte, "lage": lage,
            "naehe_prozent": round(naehe * 100, 2),
            "chance_prozent": round(chance * 100, 2),
            "risiko_prozent": round((mitte - z["stop"]) / mitte * 100, 2)}


def _selbsttest():
    fehler = 0

    def reihe_mit_widerstand():
        """Aufwaerts, mit einem klaren Hoch weit ueber dem Schlusskurs."""
        s = [100 + i * 0.4 for i in range(300)]
        s[250] = s[250] * 1.18            # markantes Zwischenhoch
        for i in range(251, 300):         # danach zurueck darunter
            s[i] = s[250] * 0.86 + (i - 250) * 0.05
        h = [x * 1.012 for x in s]
        t = [x * 0.988 for x in s]
        h[250] = s[250] * 1.02
        return s, h, t

    s, h, t = reihe_mit_widerstand()
    z = zonen(s, h, t)
    if not z:
        print("  FEHLER: keine Zonen fuer eine brauchbare Reihe")
        fehler += 1
    else:
        if z["einstieg_tief"] >= z["kurs"]:
            print("  FEHLER: Zonenbasis liegt nicht unter dem Kurs"); fehler += 1
        if z["stop"] >= z["einstieg_tief"]:
            print("  FEHLER: Stop liegt nicht unter der Zonenbasis"); fehler += 1
        # Stop muss genau STOP_ATR unter der Basis liegen
        soll = z["einstieg_tief"] - STOP_ATR * z["atr"]
        if abs(z["stop"] - soll) > 1e-9:
            print("  FEHLER: Stop nicht %.1f ATR unter der Basis" % STOP_ATR); fehler += 1
        # Ziel 1 muss weiter weg sein als die Rauschgrenze
        if z["ziel1"] <= z["kurs"] + RAUSCH_ATR * z["atr"]:
            print("  FEHLER: Ziel 1 liegt innerhalb der Rauschgrenze"); fehler += 1
        # Ziel 2 liegt entweder ueber Ziel 1 oder gar nicht vor
        if z["ziel2"] is not None and z["ziel2"] <= z["ziel1"]:
            print("  FEHLER: Ziel 2 liegt nicht ueber Ziel 1"); fehler += 1

    # Zu kurze Reihe darf nichts liefern statt zu raten
    if zonen([1, 2, 3], [1, 2, 3], [1, 2, 3]) is not None:
        print("  FEHLER: zu kurze Reihe liefert trotzdem Zonen"); fehler += 1

    # Gleichmaessiger Anstieg ohne Widerstand darueber -> kein Ziel, kein Raten
    glatt = [100 + i * 0.5 for i in range(300)]
    if zonen(glatt, [x * 1.005 for x in glatt], [x * 0.995 for x in glatt]) is not None:
        print("  FEHLER: Reihe ohne Widerstand liefert trotzdem ein Ziel"); fehler += 1

    # Bewertung: naeher an der Basis muss mehr Punkte geben
    grund = {"kurs": 100, "einstieg_tief": 100, "einstieg_hoch": 103,
             "mitte": 101.5, "stop": 95, "ziel1": 130, "ziel2": 140}
    nah = bewerte(dict(grund))
    fern = bewerte(dict(grund, kurs=118, einstieg_tief=100, ziel1=150))
    if not nah or not fern or nah["punkte"] <= fern["punkte"]:
        print("  FEHLER: Naehe zur Basis wird nicht hoeher bewertet"); fehler += 1
    if nah and nah["lage"] != "in_zone":
        print("  FEHLER: Kurs auf der Basis gilt nicht als in_zone (%s)" % nah["lage"]); fehler += 1

    # Chance wird ab der Zonenmitte gerechnet, nicht ab dem Kurs
    if nah and abs(nah["chance_prozent"] - (130 / 101.5 - 1) * 100) > 0.01:
        print("  FEHLER: Chance nicht ab der Zonenmitte gerechnet"); fehler += 1

    # Zu weit ueber der Basis -> gehoert nicht in den Raum
    if bewerte(dict(grund, kurs=140)) is not None:
        print("  FEHLER: Titel weit ueber der Basis wird aufgenommen"); fehler += 1

    # Zu wenig Luft bis Ziel -> ebenfalls nicht
    if bewerte(dict(grund, ziel1=103)) is not None:
        print("  FEHLER: Titel ohne Luft bis Ziel wird aufgenommen"); fehler += 1

    # Die Chancen-Skala muss ihren Bereich ausnutzen
    if abs(lin(CHANCE_MIN, CHANCE_MIN, CHANCE_MAX)) > 1e-9 or \
       abs(lin(CHANCE_MAX, CHANCE_MIN, CHANCE_MAX) - 100) > 1e-9:
        print("  FEHLER: Chancen-Skala trifft ihre Endpunkte nicht"); fehler += 1

    print("Selbsttest bestanden." if not fehler else "%d Fehler." % fehler)
    return fehler == 0


if __name__ == "__main__":
    _selbsttest()
