#!/usr/bin/env python3
"""Gemeinsamer Rechenkern fuer die DCF-Bewertung.

Ohne Netzzugriff und ohne externe Bibliotheken: reine Funktionen, die
Zahlen entgegennehmen und Zahlen zurueckgeben. Dadurch kann dieselbe
Logik in der GitHub Action und im MCP-Server laufen.

Selbsttest:
    python3 scripts/dcf_core.py
"""

RISIKOFREIER_ZINS = 2.5
MARKTRISIKOPRAEMIE = 5.5
FREMDKAPITALKOSTEN = 4.0
STEUERSATZ = 25.0
TERMINAL_WACHSTUM = 2.0

WACHSTUM_DECKEL = 15.0
WACHSTUM_FALLBACK = 5.0
BETA_FALLBACK = 1.0

UNGEEIGNETE_BRANCHEN = {"Financial Services", "Real Estate"}


def wachstum_ableiten(umsatzwachstum=None):
    """Phase-1- und Phase-2-Wachstum wie in vxCollect.

    umsatzwachstum als Anteil (0.12 fuer 12 Prozent) oder None.
    Rueckgabe: (g1, g2, quelle) mit g1/g2 in Prozent.
    """
    if umsatzwachstum is None:
        g1 = WACHSTUM_FALLBACK
        quelle = "Kein Umsatzwachstum verfuegbar - Fallback %s Prozent." % g1
    else:
        roh = umsatzwachstum * 100
        g1 = max(0.0, min(WACHSTUM_DECKEL, roh))
        gedeckelt = " (gedeckelt)" if roh > WACHSTUM_DECKEL else ""
        quelle = "Umsatzwachstum %.1f Prozent%s." % (roh, gedeckelt)
    return round(g1, 2), round(max(2.0, g1 / 2), 2), quelle


def kapitalkosten(beta=None, marktkap_mio=None, fremdkapital_mio=None,
                  risikofreier_zins=RISIKOFREIER_ZINS,
                  marktrisikopraemie=MARKTRISIKOPRAEMIE,
                  fremdkapitalkosten=FREMDKAPITALKOSTEN,
                  steuersatz=STEUERSATZ):
    """WACC nach CAPM, gewichtet mit der Kapitalstruktur."""
    hinweise = []
    beta_fallback = beta is None
    if beta_fallback:
        beta = BETA_FALLBACK
        hinweise.append("Kein Beta - Marktdurchschnitt 1.0 angesetzt.")
    elif beta > 2 or beta < 0.2:
        hinweise.append("Beta %s ist ungewoehnlich - Herkunft pruefen." % beta)

    ke = risikofreier_zins + beta * marktrisikopraemie
    kd_netto = fremdkapitalkosten * (1 - steuersatz / 100)

    fk = fremdkapital_mio or 0.0
    if fremdkapital_mio is None:
        hinweise.append("Kein Fremdkapital - WACC entspricht den EK-Kosten.")

    wacc = None
    anteil_e = None
    if marktkap_mio:
        gesamt = marktkap_mio + fk
        anteil_e = marktkap_mio / gesamt * 100
        wacc = ke * (marktkap_mio / gesamt) + kd_netto * (fk / gesamt)
    else:
        hinweise.append("Keine Marktkapitalisierung - WACC nicht gewichtbar.")

    return {
        "beta": beta,
        "beta_ist_fallback": beta_fallback,
        "eigenkapitalkosten_prozent": round(ke, 2),
        "fremdkapitalkosten_nach_steuern_prozent": round(kd_netto, 2),
        "anteil_eigenkapital_prozent": round(anteil_e, 1) if anteil_e else None,
        "wacc_prozent": round(wacc, 2) if wacc else None,
        "hinweise": hinweise,
    }


def rechne_dcf(fcf0, wacc, terminal_wachstum, g1, g2, jahre=10):
    """Zweiphasige DCF. Gibt (Barwert Prognose, Barwert Terminal Value).

    Gibt None zurueck, wenn der WACC nicht ueber dem ewigen Wachstum liegt -
    dann divergiert der Terminal Value.
    """
    if wacc <= terminal_wachstum:
        return None

    w = wacc / 100
    gt = terminal_wachstum / 100
    barwert = 0.0
    fcf = fcf0

    for jahr in range(1, jahre + 1):
        fcf *= 1 + (g1 / 100 if jahr <= jahre / 2 else g2 / 100)
        barwert += fcf / (1 + w) ** jahr

    tv = fcf * (1 + gt) / (w - gt)
    return barwert, tv / (1 + w) ** jahre


def bewerte(fcf0, wacc, terminal_wachstum, g1, g2,
            nettoverschuldung_mio=None, anteile_mio=None, kurs=None):
    """Bewertungsbruecke von Cashflow bis Wert je Anteil."""
    res = rechne_dcf(fcf0, wacc, terminal_wachstum, g1, g2)
    if res is None:
        return None

    pv_prognose, pv_tv = res
    ev = pv_prognose + pv_tv
    ekw = ev - nettoverschuldung_mio if nettoverschuldung_mio is not None else None
    je_anteil = ekw / anteile_mio if (ekw is not None and anteile_mio) else None

    return {
        "barwert_prognose_mio": round(pv_prognose, 1),
        "barwert_terminal_value_mio": round(pv_tv, 1),
        "terminal_value_anteil_prozent": round(pv_tv / ev * 100, 1),
        "unternehmenswert_mio": round(ev, 1),
        "eigenkapitalwert_mio": round(ekw, 1) if ekw is not None else None,
        "modellwert_je_anteil": round(je_anteil, 2) if je_anteil else None,
        "abweichung_prozent": (round((je_anteil / kurs - 1) * 100, 1)
                               if (je_anteil and kurs) else None),
    }


def matrix(fcf0, wacc_mitte, terminal_mitte, g1, g2,
           nettoverschuldung_mio=0.0, anteile_mio=None, kurs=None,
           schritt=0.5, felder=7):
    """Sensitivitaetsmatrix: Zeilen = ewiges Wachstum, Spalten = WACC."""
    if not anteile_mio:
        return None

    rand = felder // 2
    spanne = range(-rand, rand + 1)
    wacc_werte = [round(wacc_mitte + i * schritt, 2) for i in spanne]
    term_werte = [round(terminal_mitte + i * schritt, 2) for i in spanne]

    zeilen = []
    alle = []
    for g in term_werte:
        zeile = []
        for w in wacc_werte:
            res = rechne_dcf(fcf0, w, g, g1, g2)
            if res is None:
                zeile.append(None)
                continue
            wert = (res[0] + res[1] - nettoverschuldung_mio) / anteile_mio
            zeile.append(round(wert, 2))
            alle.append(wert)
        zeilen.append(zeile)

    return {
        "terminal_wachstum_werte_prozent": term_werte,
        "wacc_werte_prozent": wacc_werte,
        "matrix": zeilen,
        "spannweite_je_anteil": ([round(min(alle), 2), round(max(alle), 2)]
                                 if alle else None),
        "anteil_ueber_kurs_prozent": (
            round(sum(1 for v in alle if v > kurs) / len(alle) * 100, 1)
            if (kurs and alle) else None),
    }


def _selbsttest():
    """Prueft die Rechnung gegen von Hand nachvollziehbare Werte."""
    fehler = 0

    r = rechne_dcf(100, 10, 0, 0, 0)
    gesamt = r[0] + r[1]
    if abs(gesamt - 1000) > 1:
        print("  FEHLER ewige Rente: %.1f statt ~1000" % gesamt)
        fehler += 1

    if rechne_dcf(100, 2, 3, 5, 5) is not None:
        print("  FEHLER: WACC <= ewiges Wachstum nicht abgefangen")
        fehler += 1

    a = sum(rechne_dcf(100, 8, 2, 5, 3))
    b = sum(rechne_dcf(100, 9, 2, 5, 3))
    if not b < a:
        print("  FEHLER: hoeherer WACC senkt den Wert nicht")
        fehler += 1

    g1, g2, _ = wachstum_ableiten(0.42)
    if g1 != WACHSTUM_DECKEL or g2 != WACHSTUM_DECKEL / 2:
        print("  FEHLER Deckel: g1=%s, g2=%s" % (g1, g2))
        fehler += 1

    _, g2b, _ = wachstum_ableiten(0.01)
    if g2b != 2.0:
        print("  FEHLER Untergrenze: g2=%s statt 2.0" % g2b)
        fehler += 1

    m = matrix(100, 8, 2, 5, 3, nettoverschuldung_mio=0, anteile_mio=10)
    mitte = m["matrix"][3]
    if len(m["matrix"]) != 7 or len(mitte) != 7:
        print("  FEHLER: Matrix hat nicht 7x7 Felder")
        fehler += 1
    elif not all(mitte[i] > mitte[i + 1] for i in range(6)):
        print("  FEHLER: Matrix faellt nicht monoton mit steigendem WACC")
        fehler += 1

    print("Selbsttest bestanden." if not fehler else "%d Fehler." % fehler)
    return fehler == 0


if __name__ == "__main__":
    _selbsttest()
