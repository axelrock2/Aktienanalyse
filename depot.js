"use strict";
/* =====================================================================
   DEPOT  ·  Positionsbasiert, rein lokal im Browser
   ---------------------------------------------------------------------
   Je Position werden Stückzahl und durchschnittlicher Einstandskurs
   eingetragen – keine Einzeltransaktionen. Das Feld „gehalten seit" ist
   optional und verbessert nur die Wertkurve.

   Depotdaten verlassen den Browser nie und werden bewusst NICHT im
   (öffentlichen) Repository gespeichert. Sicherung über Export.
   ===================================================================== */

const DEPOT_KEY = "ak.depot.v2";
const DEPOT_OLD_KEY = "ak.depot";

const Depot = {
  items: null,

  list() {
    if (this.items) return this.items;
    try { this.items = JSON.parse(localStorage.getItem(DEPOT_KEY)) || null; }
    catch (e) { this.items = null; }
    if (!Array.isArray(this.items)) this.items = this.migrate();
    return this.items;
  },

  /* Frühere Transaktionsliste einmalig in Positionen überführen.
     Die alten Daten bleiben als Sicherheitsnetz erhalten. */
  migrate() {
    let old = null;
    try { old = JSON.parse(localStorage.getItem(DEPOT_OLD_KEY)); } catch (e) {}
    if (!Array.isArray(old) || !old.length) return [];
    const map = new Map();
    const sorted = [...old].sort((a, b) => String(a.date).localeCompare(String(b.date)));
    for (const t of sorted) {
      let p = map.get(t.sym);
      if (!p) {
        p = { sym: t.sym, n: t.n || t.sym, cur: t.cur || "", sec: t.sec || "",
              country: t.country || "", shares: 0, cost: 0, since: t.date || "" };
        map.set(t.sym, p);
      }
      const qty = Math.abs(Number(t.shares) || 0), px = Number(t.price) || 0;
      if (t.type === "sell") {
        const avg = p.shares > 0 ? p.cost / p.shares : 0;
        const sold = Math.min(qty, p.shares);
        p.cost -= sold * avg; p.shares -= sold;
      } else { p.shares += qty; p.cost += qty * px; }
    }
    const out = [];
    for (const p of map.values()) {
      if (p.shares <= 1e-9) continue;
      out.push({ id: "p" + Math.random().toString(36).slice(2, 10), sym: p.sym, n: p.n,
                 cur: p.cur, sec: p.sec, country: p.country,
                 shares: p.shares, avg: p.cost / p.shares, since: p.since });
    }
    if (out.length) { this.items = out; this.save(); }
    return out;
  },

  save() {
    try { localStorage.setItem(DEPOT_KEY, JSON.stringify(this.items || [])); return true; }
    catch (e) { return false; }
  },
  add(p) {
    this.list();
    p.id = "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    this.items.push(p);
    return this.save();
  },
  update(id, patch) {
    this.list();
    const i = this.items.findIndex(x => x.id === id);
    if (i < 0) return false;
    this.items[i] = { ...this.items[i], ...patch };
    return this.save();
  },
  remove(id) { this.list(); this.items = this.items.filter(x => x.id !== id); return this.save(); },
  replaceAll(arr) { this.items = arr; return this.save(); },
};

/* ---------- Währung ---------- */
function depotCur() { return FX.mode === "native" ? "EUR" : FX.mode; }

function depotRate(cur) {
  const target = depotCur(), base = fxBase(cur), scale = fxScale(cur);
  if (!base || base === target) return scale;
  const r = FX.rates[base + target];
  return r ? scale * r : null;
}

async function depotEnsureFx(currencies) {
  const target = depotCur();
  const jobs = [];
  /* EUR immer mitbeschaffen: Einstaende sind in Euro gespeichert und muessen
     bei Anzeige in USD umgerechnet werden. */
  for (const cur of new Set([...currencies, "EUR"])) {
    const base = fxBase(cur);
    if (!base || base === target || FX.rates[base + target] != null) continue;
    jobs.push((async () => {
      let r = await fxFetchPair(base, target);
      if (r == null) {
        const a = base === "USD" ? 1 : await fxFetchPair(base, "USD");
        const b = target === "USD" ? 1 : await fxFetchPair("USD", target);
        if (a != null && b != null) { r = a * b; FX.rates[base + target] = r; }
      }
    })());
  }
  await Promise.all(jobs);
}

/* ---------- Kurs zu einem Zeitpunkt ---------- */
function priceAtFactory(chart) {
  let i = 0;
  return ts => {
    if (!chart || !chart.t.length) return null;
    while (i + 1 < chart.t.length && chart.t[i + 1] <= ts) i++;
    if (chart.t[i] > ts) return null;
    return chart.c[i];
  };
}

/* ---------- Wertkurve + Index-Äquivalent ----------------------------------
   Positionen ohne Datum gelten über den ganzen Zeitraum als gehalten.
   Positionen mit Datum kommen an diesem Tag hinzu – der Einstandsbetrag
   fließt dann auch der Vergleichskurve zu, damit beide fair bleiben.
--------------------------------------------------------------------------- */
/* Wertkurve des Depots samt fairer Vergleichslinie im Welt-Index.

   Zwei Betriebsarten, je nachdem ob Haltedaten vorliegen:

   A) MIT Datum (für alle Positionen): exakter Verlauf. Jede Position kommt
      an ihrem Kaufdatum hinzu; der Einstandsbetrag fließt zum selben Zeitpunkt
      auch der Vergleichslinie zu. Beide Linien tragen dieselben Beträge zu
      denselben Zeitpunkten – ein fairer Vergleich über die Zeit.

   B) OHNE Datum (Normalfall hier): Näherung. Der Startpunkt ist der von dir
      eingetragene Einstand (Anteile × Ø-Kurs), NICHT der Marktwert vor Jahren.
      Die Kurve verläuft von diesem Einstand zum heutigen Wert, gestützt auf die
      Kursentwicklung der Titel über ein Standardfenster. Die Vergleichslinie
      erhält denselben Einstandsbetrag zum selben Startzeitpunkt.
      Grenze: ohne echtes Kaufdatum lässt sich der Gewinn nicht sauber über die
      Zeit verteilen – Endpunkt und Gesamtrendite stimmen, der Weg dorthin ist
      eine Näherung. Das Feld `approx` kennzeichnet diesen Fall.
*/
function depotSeries(positions, charts, bench, rateOf) {
  if (!bench || !bench.t || bench.t.length < 5) return null;
  const usable = positions.filter(p => charts.get(p.sym) && p.shares > 0 &&
    ((p.avgEur != null && isFinite(p.avgEur)) || Number(p.avg) > 0));
  if (!usable.length) return null;

  const benchAt = priceAtFactory(bench);
  const px = new Map();
  for (const p of usable) px.set(p.sym, priceAtFactory(charts.get(p.sym)));
  const curOf = p => (charts.get(p.sym).meta.currency || p.cur || "");
  /* Einstand je Anteil in der Zielwaehrung (rateOf bestimmt das Ziel).
     Euro-basierte Positionen nutzen avgEur, Altbestand den Originalkurs. */
  const costPS = p => {
    if (p.avgEur != null && isFinite(p.avgEur)) {
      const rEur = rateOf("EUR");
      return rEur != null ? p.avgEur * rEur : null;
    }
    const r = rateOf(curOf(p));
    return (Number(p.avg) > 0 && r != null) ? Number(p.avg) * r : null;
  };

  const sinceList = usable.map(p => p.since ? Date.parse(p.since + "T00:00:00Z") : null);
  const allDated = sinceList.every(x => x != null && isFinite(x));

  /* frühestmöglicher gemeinsamer Datenbeginn */
  let dataStart = bench.t[0];
  for (const p of usable) {
    const ch = charts.get(p.sym);
    if (ch && ch.t.length) dataStart = Math.max(dataStart, ch.t[0]);
  }

  /* ---------- A) exakter Verlauf mit Kaufdaten ---------- */
  if (allDated) {
    const startTs = Math.max(dataStart, Math.min(...sinceList));
    const grid = bench.t.filter(t => t >= startTs);
    if (grid.length < 3) return null;

    const events = usable.map((p, i) => ({
      ts: sinceList[i], sym: p.sym, cur: curOf(p),
      qty: p.shares, costPerShare: costPS(p),
    })).sort((a, b) => a.ts - b.ts);

    const held = new Map();
    let ei = 0, units = null, seeded = false;
    const outT = [], outV = [], outB = [];

    for (const d of grid) {
      let flow = 0;
      while (ei < events.length && events[ei].ts <= d) {
        const e = events[ei++];
        held.set(e.sym, (held.get(e.sym) || 0) + e.qty);
        if (e.costPerShare != null) flow += e.qty * e.costPerShare;
      }
      let value = 0;
      for (const [sym, sh] of held) {
        if (Math.abs(sh) < 1e-9) continue;
        const f = px.get(sym), ch = charts.get(sym);
        const pr = f ? f(d) : null, r = rateOf(ch ? (ch.meta.currency || "") : "");
        if (pr == null || r == null) continue;
        value += sh * pr * r;
      }
      const bp = benchAt(d);
      if (bp == null || !isFinite(value) || value <= 0) continue;
      if (!seeded) { units = value / bp; seeded = true; }
      else if (flow !== 0) units += flow / bp;
      outT.push(d); outV.push(value); outB.push(units * bp);
    }
    if (outT.length < 3) return null;
    /* Vergleich ueber den tatsaechlichen Haltezeitraum. Weil die Vergleichslinie
       dieselben Betraege zu denselben Zeitpunkten in den Index legt, sind die
       beiden Endwerte direkt vergleichbar - anders als zwei Renditen ueber
       verschieden lange Zeitraeume. */
    const tage = Math.round((outT[outT.length - 1] - outT[0]) / 86400000);
    return { t: outT, value: outV, bench: outB, startTs: outT[0], approx: false,
             compare: { modus: "exakt", depotEnd: outV[outV.length - 1],
                        benchEnd: outB[outB.length - 1], windowDays: tage } };
  }

  /* ---------- B) Näherung ohne Kaufdaten ----------
     Startpunkt = eingetragener Einstand. Wir bilden den Verlauf über ein
     Standardfenster (bis 2 Jahre, begrenzt durch die Datenlage) so ab, dass
     die Kurve heute exakt beim aktuellen Depotwert endet und am Anfang beim
     Einstand beginnt – skaliert über die tatsächliche Kursentwicklung der
     gehaltenen Titel. */
  const WINDOW = 730 * 86400000;   // zwei Jahre
  const startTs = Math.max(dataStart, bench.t[bench.t.length - 1] - WINDOW);
  const grid = bench.t.filter(t => t >= startTs);
  if (grid.length < 3) return null;

  /* Einstand und aktueller Wert in Anzeigewährung */
  let cost = 0, valueNow = 0;
  const parts = [];
  for (const p of usable) {
    const cur = curOf(p), r = rateOf(cur);
    const f = px.get(p.sym);
    const now = f ? f(grid[grid.length - 1]) : null;
    const cps = costPS(p);
    if (r == null || now == null || cps == null) continue;
    const c = p.shares * cps;
    cost += c;
    valueNow += p.shares * now * r;
    parts.push({ sym: p.sym, shares: p.shares, r });
  }
  if (!(cost > 0) || !(valueNow > 0) || !parts.length) return null;

  /* Roh-Marktwert der heutigen Zusammensetzung je Tag (nur zur Formgebung) */
  const raw = [];
  for (const d of grid) {
    let v = 0, ok = true;
    for (const pt of parts) {
      const f = px.get(pt.sym);
      const pr = f ? f(d) : null;
      if (pr == null) { ok = false; break; }
      v += pt.shares * pr * pt.r;
    }
    raw.push(ok ? v : null);
  }
  /* Lücken am Anfang mit dem ersten gültigen Wert füllen */
  let firstOk = raw.find(v => v != null);
  if (firstOk == null) return null;
  for (let i = 0; i < raw.length; i++) if (raw[i] == null) raw[i] = firstOk; else break;
  for (let i = 1; i < raw.length; i++) if (raw[i] == null) raw[i] = raw[i - 1];

  /* Zustandsfreier Zugriff auf die Benchmark-Kurve (siehe Hinweis unten):
     der Iterator aus priceAtFactory darf hier nicht mehrfach genutzt werden. */
  const benchValueAt = ts => {
    const T = bench.t, C = bench.c;
    if (!T.length || ts < T[0]) return null;
    let lo = 0, hi = T.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (T[mid] <= ts) lo = mid; else hi = mid - 1; }
    return C[lo];
  };

  /* Form der Rohkurve beibehalten, aber so verschieben, dass sie beim Einstand
     beginnt und beim aktuellen Wert endet. Das entspricht deiner realen
     Rendite (Einstand -> heute), ohne einen erfundenen Vorlauf. */
  const rawStart = raw[0], rawEnd = raw[raw.length - 1];
  const outT = [], outV = [], outB = [];
  const denom = (rawEnd - rawStart);
  for (let i = 0; i < grid.length; i++) {
    const shape = denom !== 0 ? (raw[i] - rawStart) / denom : i / (grid.length - 1);
    const v = cost + (valueNow - cost) * shape;
    const bp = benchValueAt(grid[i]);
    if (bp == null || !isFinite(v)) continue;
    outT.push(grid[i]); outV.push(v);
  }
  if (outT.length < 3) return null;

  /* Vergleichslinie: derselbe Einstand, zum Startzeitpunkt in den Index gelegt. */
  let bp0 = null;
  for (const t of outT) { const bp = benchValueAt(t); if (bp != null && bp > 0) { bp0 = bp; break; } }
  const units = bp0 ? cost / bp0 : 0;
  let lastB = cost;
  for (const t of outT) {
    const bp = benchValueAt(t);
    const v = (bp != null && bp > 0) ? units * bp : lastB;
    lastB = v;
    outB.push(v);
  }
  /* Bewusst OHNE Vergleichszahl. Hier fehlen die Kaufdaten, also ist der
     Haltezeitraum unbekannt: Die eigene Rendite laeuft "seit Einstand", die
     Indexrendite ueber ein festes Fenster von zwei Jahren. Frueher wurden genau
     diese beiden voneinander abgezogen und als "Vorsprung" unter der
     Ueberschrift "Rendite ueber die letzten 2 Jahre" ausgewiesen. Wer acht Jahre
     haelt, bekam so einen Vorsprung ausgewiesen, den es nie gab. Eine Zahl, der
     man nicht glauben darf, ist schlechter als keine - deshalb steht hier
     stattdessen der Hinweis auf "gehalten seit". */
  const windowDays = Math.round((outT[outT.length - 1] - outT[0]) / 86400000);
  return { t: outT, value: outV, bench: outB, startTs: outT[0], approx: true,
           compare: null, windowDays };
}

/* ---------- Gruppierung ---------- */
function depotGroups(rows, mode) {
  const key = r => mode === "sector" ? (r.sec || "Ohne Angabe")
              : mode === "country" ? (r.country || "Ohne Angabe")
              : mode === "currency" ? (fxBase(r.cur) || "?")
              : r.n;
  const map = new Map();
  for (const r of rows) {
    if (!(r.value > 0)) continue;
    const k = key(r);
    map.set(k, (map.get(k) || 0) + r.value);
  }
  const sortiert = [...map.entries()].sort((a, b) => b[1] - a[1]);
  /* Ab dem neunten Eintrag reicht die Palette nicht mehr; weitere Toene waeren
     von den vorhandenen nicht sicher zu unterscheiden. Der Rest wird zu einer
     Sammelgruppe - die Anteile bleiben damit korrekt, ohne Scheinpraezision. */
  if (sortiert.length <= DP_MAX_GRUPPEN) return sortiert;
  const kopf = sortiert.slice(0, DP_MAX_GRUPPEN - 1);
  const rest = sortiert.slice(DP_MAX_GRUPPEN - 1);
  const summe = rest.reduce((a, b) => a + b[1], 0);
  kopf.push([`Andere (${rest.length})`, summe]);
  return kopf;
}

/* ---------- Kennzahlen ---------- */
function depotStats(rows) {
  let value = 0, cost = 0, unknown = 0;
  for (const r of rows) {
    if (r.value == null || r.costConv == null) { unknown++; continue; }
    value += r.value; cost += r.costConv;
  }
  const pl = value - cost;
  return { value, cost, pl, plPct: cost > 0 ? pl / cost : null, unknown, count: rows.length };
}

/* =====================================================================
   Oberfläche
   ===================================================================== */
const DepotUI = { pie: "position", rows: [], series: null, busy: false, editId: null };
let dpLineChart = null, dpPieChart = null;
/* Kategoriefarben des Ringdiagramms, auf dunklem Grund geprueft.
   Die vorherige Reihe war nicht trennscharf: Gruen (#8FBF6B) und Orange
   (#D89A6A) lagen fuer Rotgruenblindheit bei einem Farbabstand von 1,1 - also
   praktisch gleich - und selbst fuer Normalsichtige trennten sich die beiden
   ERSTEN Slots nur um 11,8 (unter dem Richtwert 15). Das traf den haeufigsten
   Fall: ein Depot mit zwei Positionen.
   Diese acht Toene halten auf #202833 alle Pruefungen ein: schlechtester
   Nachbarabstand 8,4 unter Farbsehschwaeche, 19,3 bei Normalsicht.
   Acht ist auch die Obergrenze - ein neunter Ton waere von einem der
   vorhandenen nicht mehr sicher zu unterscheiden. Der Rest wird gebuendelt. */
const DP_COLORS = ["#3987e5", "#d95926", "#199e70", "#c98500",
                   "#d55181", "#008300", "#9085e9", "#e66767"];
const DP_MAX_GRUPPEN = 8;

function dpMoney(v, dig) {
  if (v == null || !isFinite(v)) return "–";
  return fmtNum(v, depotCur(), dig ?? 2);
}
function dpMoneyBig(v) {
  if (v == null || !isFinite(v)) return "–";
  return Math.abs(v) >= 1e6 ? fmtBig(v) + " " + depotCur() : fmtNum(v, depotCur(), 0);
}

/* Umrechnungsfaktor Originalwaehrung -> Euro (inkl. Pence-Behandlung) */
function curToEur(cur) {
  const base = fxBase(cur), scale = fxScale(cur);
  if (!base || base === "EUR") return scale;
  const r = FX.rates[base + "EUR"];
  return r ? scale * r : null;
}

/* Einstand je Anteil in der aktuellen Anzeigewaehrung.
   Neue Positionen speichern den Einstand direkt in Euro (avgEur) – der Wert
   haengt damit NICHT vom Wechselkurs ab, genau wie bei Trade Republic.
   Aeltere Positionen haben nur avg (Kurs in Originalwaehrung) und werden
   ueber den Wechselkurs umgerechnet. */
function costPerShare(p, cur) {
  const target = depotCur();
  if (p.avgEur != null && isFinite(p.avgEur)) {
    if (target === "EUR") return p.avgEur;
    const r = FX.rates["EUR" + target];
    return r ? p.avgEur * r : null;      // Euro -> andere Anzeigewaehrung
  }
  const r = depotRate(cur || p.cur || "");
  return (Number(p.avg) > 0 && r != null) ? Number(p.avg) * r : null;
}

/* Positionen mit aktuellen Kursen anreichern */
async function depotBuildRows() {
  const items = Depot.list();
  if (!items.length) return { rows: [], charts: new Map() };
  await depotEnsureFx(items.map(p => p.cur));

  /* Kursspanne am aeltesten Kaufdatum ausrichten. Mit der Standardspanne von
     zwei Jahren wurde ein laengerer Haltezeitraum stillschweigend abgeschnitten:
     Wer seit fuenf Jahren haelt, bekam "Nach 2,0 Jahren" zu sehen. */
  const seitListe = items.map(p => p.since ? Date.parse(p.since + "T00:00:00Z") : null)
                         .filter(x => x && isFinite(x));
  const jahreZurueck = seitListe.length
    ? (Date.now() - Math.min(...seitListe)) / (365 * 86400000) : 0;
  const spanne = jahreZurueck > 9 ? "max" : jahreZurueck > 4 ? "10y"
               : jahreZurueck > 1.8 ? "5y" : "2y";

  const charts = new Map(), rows = [];
  await Promise.all(items.map(p => new Promise(resolve => {
    Queue.push(async () => {
      let chart = null, a = null;
      try {
        chart = await loadChart(p.sym, spanne);
        charts.set(p.sym, chart);
        const bench = await loadBenchmark();
        /* Fundamentaldaten mitgeben. Zuvor stand hier fest null - dadurch blieb
           der Qualitaets-Score im Depot grundsaetzlich leer, auch fuer Titel,
           deren Kennzahlen laengst vorlagen. */
        const fund = await loadFundamentals(p.sym, chart.meta && chart.meta.currency)
                             .catch(() => null);
        a = analyse(chart, fund, bench);
      } catch (e) { /* Kurs nicht verfügbar */ }
      const cur = (chart && chart.meta.currency) || p.cur || "";
      const rate = depotRate(cur);
      const price = chart ? chart.c[chart.c.length - 1] : null;
      const avgConv = costPerShare(p, cur);                 // Einstand je Anteil in Anzeigewaehrung
      const priceConv = (price != null && rate != null) ? price * rate : null;
      rows.push({
        ...p, cur, price, a,
        avg: Number(p.avg) || 0,
        value: (price != null && rate != null) ? p.shares * price * rate : null,
        costConv: avgConv != null ? p.shares * avgConv : null,
        priceConv,
        avgConv,
        /* Rendite: heutiger Kurs gegen Einstand, beide in Anzeigewaehrung –
           enthaelt damit den Waehrungseffekt, wie bei Trade Republic. */
        plPct: (priceConv != null && avgConv > 0) ? priceConv / avgConv - 1 : null,
        ok: !!chart,
      });
      resolve();
    });
  })));
  rows.sort((x, y) => (y.value ?? -1) - (x.value ?? -1));
  return { rows, charts, spanne };
}

/* ---------- Zeichnen ---------- */
async function renderDepot() {
  const box = $("#depotbody");
  if (!box) return;
  const items = Depot.list();

  if (!items.length) {
    box.innerHTML = `<div class="dp-empty">
        <h3>Noch keine Positionen</h3>
        <p>Trage je Position nur zwei Werte ein: <b>Anzahl der Anteile</b> und deinen
        <b>durchschnittlichen Einstandskurs je Anteil</b>. Daraus entstehen Depotwert,
        Wertentwicklung und Gewichtung.</p>
        <div class="dp-acts">
          <button class="dp-btn primary" id="dpadd">+ Position anlegen</button>
          <button class="dp-btn" id="dpimport">Sicherung einlesen</button>
        </div>
        <p class="dp-warn">Depotdaten werden ausschließlich in diesem Browser gespeichert und
        niemals ins Repository übertragen. Lege regelmäßig eine Sicherung an.</p>
      </div>`;
    dpWireActions();
    return;
  }

  if (DepotUI.busy) return;
  DepotUI.busy = true;
  box.innerHTML = `<div class="dp-loading"><span class="spin"></span> Depot wird berechnet …</div>`;

  let rows = [], charts = new Map(), series = null, spanne = "5y";
  try {
    ({ rows, charts, spanne } = await depotBuildRows());
    /* Vergleichsindex ueber dieselbe Spanne wie die Positionen holen. */
    const bench = await loadChart("ACWI", spanne || "5y").catch(() => loadBenchmark());
    series = depotSeries(Depot.list(), charts, bench, depotRate);
  } catch (e) { /* unten abgefangen */ }
  DepotUI.rows = rows; DepotUI.series = series;
  DepotUI.busy = false;

  const st = depotStats(rows);
  const cur = depotCur();
  const missing = rows.filter(r => !r.ok || r.value == null);

  /* Nur im exakten Fall aussagekraeftig: dort hat die Vergleichslinie dieselben
     Zahlungen erhalten. In der Naeherung stuenden hier zwei Zahlen aus
     verschieden langen Zeitraeumen nebeneinander. */
  const perf = (series && !series.approx && series.bench.at(-1) > 0)
    ? `<div class="dp-c"><span>gegenüber Welt-Index${typeof infoIcon === "function" ? infoIcon("vergleichsindex") : ""}</span><b class="${chgCls(series.value.at(-1) - series.bench.at(-1))}">${
        fmtPct(series.value.at(-1) / series.bench.at(-1) - 1)}</b></div>`
    : "";

  box.innerHTML = `
    <div class="dp-cards">
      <div class="dp-c wide"><span>Depotwert</span><b>${dpMoney(st.value)}</b></div>
      <div class="dp-c"><span>Einstand</span><b>${dpMoney(st.cost)}</b></div>
      <div class="dp-c"><span>Buchgewinn</span><b class="${chgCls(st.pl)}">${st.pl >= 0 ? "+" : ""}${dpMoney(st.pl)}</b></div>
      <div class="dp-c"><span>Rendite</span><b class="${chgCls(st.plPct)}">${fmtPct(st.plPct)}</b></div>
      ${perf}
    </div>

    ${missing.length ? `<div class="dp-note">Für ${missing.length} Position${missing.length > 1 ? "en" : ""}
      (${missing.map(m => esc(m.sym)).join(", ")}) liegen gerade keine Kurse oder Wechselkurse vor –
      sie fehlen in den Summen.</div>` : ""}

    <div class="dp-charts">
      <div class="dp-panel">
        <div class="dp-panel-h"><h4>Wertentwicklung <span class="dp-unit">in ${esc(cur)}</span></h4>
          <span class="dp-legend"><i style="background:var(--accent)"></i>Depot
            <i style="background:var(--warn);margin-left:10px"></i>Welt-Index</span></div>
        <div class="dp-canvas">${series
          ? `<canvas id="dpline"></canvas>`
          : `<div class="dp-note" style="margin:0">Für die Wertkurve fehlen noch ausreichende Kursdaten.</div>`}</div>
        ${series ? `<p class="dp-curvenote">${series.approx
          ? "N\u00e4herung: Die Kurve beginnt bei deinem <b>Einstand</b> und endet beim heutigen Wert. Der Endwert stimmt, der Weg dorthin ist gesch\u00e4tzt \u2013 und die gesamte Entwicklung wird in das gezeigte Fenster gestaucht, auch wenn du l\u00e4nger h\u00e4ltst. Die Steigung ist deshalb kein Ma\u00df f\u00fcr dein Tempo, und die Vergleichslinie ist nur eine Orientierung. F\u00fcr einen belastbaren Verlauf und Vergleich trage bei den Positionen ein \u201egehalten seit\u201c ein."
          : "Exakter Verlauf ab deinen Kaufdaten. Die Vergleichslinie erh\u00e4lt dieselben Betr\u00e4ge zu denselben Zeitpunkten im Welt-Index."}</p>` : ""}
        ${series ? (series.compare ? dpCompareBar(series.compare) : dpCompareHinweis()) : ""}
      </div>
      <div class="dp-panel">
        <div class="dp-panel-h"><h4>Gewichtung</h4>
          <div class="dp-tabs">
            ${[["position", "Position"], ["sector", "Sektor"], ["country", "Land"], ["currency", "Währung"]]
              .map(([k, l]) => `<button class="dp-tab${DepotUI.pie === k ? " on" : ""}" data-pie="${k}">${l}</button>`).join("")}
          </div></div>
        <div class="dp-canvas pie"><canvas id="dppie"></canvas></div>
      </div>
    </div>

    <div class="dp-tablewrap">
      <table class="dp-table">
        <thead><tr>
          <th>Position</th><th class="r">Anteile</th><th class="r">Ø Einstand</th><th class="r">Kurs</th>
          <th class="r">Wert (${esc(cur)})</th><th class="r">G/V</th><th>Zone</th><th></th>
        </tr></thead>
        <tbody>${rows.map(r => dpRow(r)).join("")}</tbody>
      </table>
    </div>

    <div class="dp-acts">
      <button class="dp-btn primary" id="dpadd">+ Position</button>
      <button class="dp-btn" id="dpexport">Sicherung speichern</button>
      <button class="dp-btn" id="dpimport">Sicherung einlesen</button>
    </div>
    <p class="dp-warn">Nur im Browser gespeichert · Gebühren, Dividenden und Steuern sind nicht
    berücksichtigt, Abweichungen zur Abrechnung deines Brokers sind daher normal · keine Anlageberatung.</p>`;

  if (series) dpDrawLine(series);
  dpDrawPie(rows);
  dpWireActions();
}

/* Zelle mit Kurs in Anzeigewährung; Originalwährung als kleiner Zusatz,
   falls sie abweicht. So entfällt der externe Währungsrechner. */
function dpCell(conv, orig, cur) {
  const target = depotCur();
  if (conv == null) {
    return orig > 0 ? `${fmtNum(orig, null, 2)}<small>${esc(cur)}</small>` : "–";
  }
  const sameCur = !cur || fxBase(cur) === target;
  const main = `${fmtNum(conv, null, 2)}<small>${esc(target)}</small>`;
  if (sameCur) return main;
  return `${main}<span class="dp-orig">${fmtNum(orig, null, 2)} ${esc(cur)}</span>`;
}

function dpRow(r) {
  let zone = "–";
  if (r.a && r.a.zones && r.price != null) {
    const z = r.a.zones;
    if (r.price <= z.stop) zone = `<span class="dp-z bad">unter Stop</span>`;
    /* z.t1 kann fehlen, wenn ueber dem Kurs kein belastbares Niveau liegt.
       Ohne diese Pruefung waere "price >= null" wahr - die Position stuende
       faelschlich auf "Ziel erreicht". */
    else if (z.t1 == null) zone = `<span class="dp-z">kein Ziel</span>`;
    else if (r.price >= z.t1) zone = `<span class="dp-z good">Ziel erreicht</span>`;
    else zone = `<span class="dp-z">${fmtPct(z.t1 / r.price - 1)} bis Ziel</span>`;
  }
  return `<tr data-sym="${esc(r.sym)}">
    <td><span class="dp-name">${esc(r.n)}</span><span class="dp-sym">${esc(r.sym)}${r.sec ? " · " + esc(r.sec) : ""}</span></td>
    <td class="r">${fmtNum(r.shares, null, r.shares % 1 ? 3 : 0)}</td>
    <td class="r">${r.avgEur != null ? `${fmtNum(r.avgConv, null, 2)}<small>${esc(depotCur())}</small>` : dpCell(r.avgConv, r.avg, r.cur)}</td>
    <td class="r">${dpCell(r.priceConv, r.price, r.cur)}</td>
    <td class="r"><b>${dpMoney(r.value)}</b></td>
    <td class="r ${chgCls(r.plPct)}">${fmtPct(r.plPct)}</td>
    <td>${zone}</td>
    <td class="r nowrap">
      <button class="dp-mini" data-edit="${esc(r.id)}" title="Bearbeiten">✎</button>
      <button class="dp-mini" data-open="${esc(r.sym)}" title="Analyse öffnen">↗</button>
    </td>
  </tr>`;
}

/* Vergleich gegen den Welt-Index - nur mit Kaufdaten, sonst gaebe es keinen
   gemeinsamen Zeitraum. Verglichen werden zwei Endbetraege, nicht zwei
   Renditen: Die Vergleichslinie hat dieselben Betraege zu denselben
   Zeitpunkten erhalten, damit ist der Unterschied allein die Anlageentscheidung. */
function dpCompareBar(c) {
  if (!c || c.modus !== "exakt") return "";
  const { depotEnd, benchEnd } = c;
  if (!(depotEnd > 0) || !(benchEnd > 0)) return "";

  const jahre = c.windowDays / 365;
  const zeitraum = jahre >= 1.4 ? (jahre.toFixed(1).replace(".", ",") + " Jahren")
                 : c.windowDays >= 45 ? (Math.round(c.windowDays / 30) + " Monaten")
                 : (c.windowDays + " Tagen");

  const span = Math.max(depotEnd, benchEnd);
  const balken = (wert, cls, text) => `<div class="dp-cmp-row">
      <span class="dp-cmp-lab">${text}</span>
      <div class="dp-cmp-track"><div class="dp-cmp-fill ${cls}" style="width:${Math.min(wert / span * 100, 100)}%"></div></div>
      <b class="dp-cmp-val">${dpMoney(wert)}</b></div>`;

  const diff = depotEnd / benchEnd - 1;
  return `<div class="dp-cmp">
    <div class="dp-cmp-h">Nach ${zeitraum}: dein Depot gegen dieselben K\u00e4ufe im Welt-Index
      ${typeof infoIcon === "function" ? infoIcon("vergleichsindex") : ""}</div>
    ${balken(depotEnd, "you", "Dein Depot")}
    ${balken(benchEnd, "idx", "Welt-Index")}
    <div class="dp-cmp-diff ${chgCls(diff)}">${diff >= 0 ? "Vorsprung" : "R\u00fcckstand"} ${fmtPct(Math.abs(diff), false)}</div>
  </div>`;
}

/* Steht kein Kaufdatum bereit, gibt es keinen gemeinsamen Zeitraum - dann den
   Weg dorthin zeigen, statt eine unvergleichbare Zahl. */
function dpCompareHinweis() {
  return `<div class="dp-cmp dp-cmp-leer">
    <div class="dp-cmp-h">Vergleich mit dem Welt-Index</div>
    <p class="dp-note" style="margin:0">Daf\u00fcr fehlt der Zeitraum: Ohne Kaufdatum ist unbekannt,
    wie lange du h\u00e4ltst - deine Rendite l\u00e4uft seit Einstand, die des Index \u00fcber ein festes Fenster.
    Trage bei den Positionen ein <b>\u201egehalten seit\u201c</b> ein, dann wird hier verglichen,
    was dieselben Betr\u00e4ge zu denselben Zeitpunkten im Index ergeben h\u00e4tten.</p>
  </div>`;
}

/* ---------- Diagramme ---------- */
/* Farben aus dem Stylesheet lesen statt sie im Programm zu wiederholen.
   Die Werte waren zeichengleiche Kopien der CSS-Variablen - eine Themeaenderung
   haette die Diagramme zurueckgelassen. */
function dpFarbe(name, ersatz) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || ersatz;
  } catch (e) { return ersatz; }
}

/* Achsenbeschriftung ohne Waehrungszeichen. Es an jede Marke zu schreiben kostete
   Platz, den die schmale Achse nicht hat: "10.000 €" braucht 48 px, die Achse ist
   51 px breit - fuenf von acht Marken wurden abgeschnitten. Die Waehrung steht
   jetzt einmal ueber dem Diagramm. */
function dpAchsenZahl(v) {
  if (v == null || !isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 1e9) return (v / 1e9).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " Mrd.";
  if (a >= 1e6) return (v / 1e6).toLocaleString("de-DE", { maximumFractionDigits: 1 }) + " Mio.";
  return v.toLocaleString("de-DE", { maximumFractionDigits: 0 });
}

/* ---------- Raeumliche Darstellung ----------
   Die Kurven bleiben unveraendert - Tiefe entsteht ausschliesslich HINTER und
   UNTER ihnen. Das ist keine Kosmetik, sondern die Bedingung dafuer, dass man
   weiter richtig abliest: Wuerde die Extrusion die Linie versetzen, laege der
   Wert mal an der Vorder-, mal an der Oberkante, und der Abgleich mit der Achse
   waere hin. So bleibt die Datenlinie immer die Oberkante des Koerpers.

   Aufgebaut wie ein Band, das auf einer Grundflaeche steht:
     - Seitenflaeche: die Kurve, um (TIEFE_X, TIEFE_Y) nach rechts unten
       versetzt und gegen das Original geschlossen - das ist die "Dicke".
     - Beleuchtung: die Seitenflaeche laeuft nach unten dunkler aus, als fiele
       Licht von oben.
     - Schlagschatten: weich, versetzt, unter der Linie.
   Gezeichnet wird in beforeDatasetsDraw, also unter den echten Kurven. */
const TIEFE_X = 13, TIEFE_Y = 11;

function dpMitAlpha(farbe, alpha) {
  const f = String(farbe).trim();
  const kurz = f.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  const lang = f.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  let r, g, b;
  if (lang) { r = parseInt(lang[1], 16); g = parseInt(lang[2], 16); b = parseInt(lang[3], 16); }
  else if (kurz) { r = parseInt(kurz[1] + kurz[1], 16); g = parseInt(kurz[2] + kurz[2], 16); b = parseInt(kurz[3] + kurz[3], 16); }
  else return f;
  return `rgba(${r},${g},${b},${alpha})`;
}

const dpTiefe = {
  id: "dpTiefe",

  /* Grundflaeche und Sockel liegen unter allem. */
  beforeDatasetsDraw(chart) {
    const c = chart.ctx, b = chart.chartArea;
    if (!b) return;
    const grund = dpFarbe("--bg2", "#1B212B");

    c.save();
    /* Bodenplatte: die Flaeche, auf der die Kurven stehen. Nach hinten rechts
       versetzt, damit eine Kante sichtbar wird. */
    c.beginPath();
    c.moveTo(b.left, b.bottom);
    c.lineTo(b.right, b.bottom);
    c.lineTo(b.right + TIEFE_X, b.bottom + TIEFE_Y);
    c.lineTo(b.left + TIEFE_X, b.bottom + TIEFE_Y);
    c.closePath();
    c.fillStyle = dpMitAlpha(grund, 0.85);
    c.fill();
    c.strokeStyle = dpMitAlpha(dpFarbe("--line", "#313B49"), 0.9);
    c.lineWidth = 1;
    c.stroke();

    /* Jede waagerechte Gitterlinie bekommt eine kurze Fluchtlinie nach hinten
       rechts. Das ist der wirksamste Hinweis auf eine Flaeche im Raum - ohne
       ihn liest man den Versatz an Sockel und Seitenwand nur als Rahmen. */
    const gitter = dpMitAlpha(dpFarbe("--line", "#313B49"), 0.55);
    c.strokeStyle = gitter;
    c.lineWidth = 1;
    for (const t of chart.scales.y.ticks) {
      const y = chart.scales.y.getPixelForValue(t.value);
      if (!isFinite(y) || y < b.top || y > b.bottom) continue;
      c.beginPath();
      c.moveTo(b.right, y);
      c.lineTo(b.right + TIEFE_X, y + TIEFE_Y);
      c.stroke();
    }
    /* Die hintere Kante verbindet die Fluchtlinien zu einer Ebene. */
    c.beginPath();
    c.moveTo(b.right + TIEFE_X, b.top + TIEFE_Y);
    c.lineTo(b.right + TIEFE_X, b.bottom + TIEFE_Y);
    c.stroke();

    /* Schlagschatten je Kurve: eine versetzte, weichgezeichnete Kopie unter der
       spaeter gezeichneten Linie. Sie hebt die Kurve von der Flaeche ab. Der
       Versatz ist bewusst klein - er darf nicht als zweite Kurve missverstanden
       werden. */
    c.beginPath();
    c.rect(b.left, b.top, b.width + TIEFE_X, b.height + TIEFE_Y);
    c.clip();
    for (let i = chart.data.datasets.length - 1; i >= 0; i--) {
      const meta = chart.getDatasetMeta(i);
      if (meta.hidden || !meta.data || meta.data.length < 2) continue;
      const pts = meta.data.filter(p => isFinite(p.x) && isFinite(p.y));
      if (pts.length < 2) continue;
      c.beginPath();
      c.moveTo(pts[0].x, pts[0].y);
      for (const pt of pts) c.lineTo(pt.x, pt.y);
      c.strokeStyle = "rgba(0,0,0,.34)";
      c.lineWidth = chart.data.datasets[i].borderWidth || 1.5;
      c.shadowColor = "rgba(0,0,0,.5)";
      c.shadowBlur = 6;
      c.shadowOffsetX = 3;
      c.shadowOffsetY = 4;
      c.stroke();
      c.shadowColor = "transparent";
    }
    c.restore();
  },

  /* Seitenwand und Vorderkante gehoeren UEBER die Flaechenfuellung, aber unter
     die Linien - dafuer ist afterDatasetsDraw mit erneutem Zeichnen der Linie
     zu spaet. Chart.js bietet keinen Haken dazwischen, deshalb wird der Koerper
     hier gezeichnet und die Linien darueber bleiben unangetastet: sie werden
     von Chart.js ohnehin zuletzt gemalt. */
  afterDatasetsDraw(chart) {
    const c = chart.ctx, b = chart.chartArea;
    if (!b) return;

    const meta = chart.getDatasetMeta(0);          // Depot: die gefuellte Reihe
    if (meta.hidden || !meta.data || meta.data.length < 2) return;
    const punkte = meta.data.filter(p => isFinite(p.x) && isFinite(p.y));
    if (punkte.length < 2) return;
    const grund = chart.data.datasets[0].borderColor;
    const letzter = punkte[punkte.length - 1];

    c.save();

    /* Rechte Schnittflaeche: der Koerper endet heute, hier sieht man in ihn
       hinein. Das traegt den raeumlichen Eindruck, ohne die Kurve zu beruehren. */
    c.beginPath();
    c.moveTo(letzter.x, letzter.y);
    c.lineTo(letzter.x + TIEFE_X, letzter.y + TIEFE_Y);
    c.lineTo(letzter.x + TIEFE_X, b.bottom + TIEFE_Y);
    c.lineTo(letzter.x, b.bottom);
    c.closePath();
    const wand = c.createLinearGradient(0, b.top, 0, b.bottom);
    wand.addColorStop(0, dpMitAlpha(grund, 0.50));
    wand.addColorStop(1, dpMitAlpha(grund, 0.22));
    c.fillStyle = wand;
    c.fill();
    c.strokeStyle = dpMitAlpha(grund, 0.55);
    c.lineWidth = 1;
    c.stroke();

    /* Vorderkante: der Sockel entlang der Grundlinie, gleiche Versetzung.
       Erst dieses Band laesst die Flaeche als Koerper mit Dicke lesen. */
    c.beginPath();
    c.moveTo(punkte[0].x, b.bottom);
    c.lineTo(letzter.x, b.bottom);
    c.lineTo(letzter.x + TIEFE_X, b.bottom + TIEFE_Y);
    c.lineTo(punkte[0].x + TIEFE_X, b.bottom + TIEFE_Y);
    c.closePath();
    c.fillStyle = dpMitAlpha(grund, 0.38);
    c.fill();
    c.strokeStyle = dpMitAlpha(grund, 0.5);
    c.stroke();

    c.restore();
  },
};

/* Fadenkreuz: eine senkrechte Linie am Mauszeiger. Ohne sie laesst sich bei
   750 Tagespunkten nicht ablesen, welcher Zeitpunkt gerade im Kaestchen steht. */
const dpFadenkreuz = {
  id: "dpFadenkreuz",
  afterDatasetsDraw(chart) {
    const akt = chart.tooltip && chart.tooltip.getActiveElements
      ? chart.tooltip.getActiveElements() : [];
    if (!akt.length) return;
    const x = akt[0].element.x, ya = chart.scales.y;
    const c = chart.ctx;
    c.save();
    c.beginPath();
    c.moveTo(x, ya.top);
    c.lineTo(x, ya.bottom);
    c.lineWidth = 1;
    c.strokeStyle = dpFarbe("--faint", "#6B7787");
    c.setLineDash([3, 3]);
    c.stroke();
    c.restore();
  },
};

function dpDrawLine(s) {
  const cv = $("#dpline");
  if (!cv || typeof Chart === "undefined") return;
  if (dpLineChart) dpLineChart.destroy();

  const akzent = dpFarbe("--accent", "#4FB8AC");
  const warn   = dpFarbe("--warn", "#E0B45C");
  const linie  = dpFarbe("--line", "#313B49");
  const faint  = dpFarbe("--faint", "#6B7787");
  const muted  = dpFarbe("--muted", "#93A0B0");
  const ink    = dpFarbe("--ink", "#E9EDF3");
  const flaeche = dpFarbe("--surface", "#202833");

  /* Zeitachse statt Textmarken: Zuvor waren die Beschriftungen fertige
     Zeichenketten auf einer Kategorieachse - die Punkte lagen damit gleich weit
     auseinander, unabhaengig vom tatsaechlichen Abstand der Tage. Boersenpausen
     und Feiertage erschienen so als regulaerer Handel. */
  const daten = s.t.map((t, i) => ({ x: t, y: s.value[i] }));
  const vergleich = s.t.map((t, i) => ({ x: t, y: s.bench[i] }));

  dpLineChart = new Chart(cv, {
    type: "line",
    data: {
      datasets: [
        { label: "Depot", data: daten, borderColor: akzent,
          /* Verlauf statt flacher Fuellung: oben dichter, nach unten
             auslaufend. Gibt der Flaeche eine Lichtrichtung, ohne an den
             Werten zu ruehren. Faellt auf die bisherige Fuellung zurueck,
             solange die Zeichenflaeche noch keine Hoehe hat. */
          backgroundColor: (ctx) => {
            const b = ctx.chart.chartArea;
            if (!b) return dpMitAlpha(akzent, 0.10);
            const g = ctx.chart.ctx.createLinearGradient(0, b.top, 0, b.bottom);
            g.addColorStop(0, dpMitAlpha(akzent, 0.34));
            g.addColorStop(0.55, dpMitAlpha(akzent, 0.12));
            g.addColorStop(1, dpMitAlpha(akzent, 0.02));
            return g;
          },
          borderWidth: 1.9, pointRadius: 0, pointHoverRadius: 4,
          pointHoverBackgroundColor: akzent, pointHoverBorderColor: flaeche,
          pointHoverBorderWidth: 2, fill: true, tension: .15 },
        { label: "Welt-Index", data: vergleich, borderColor: warn, borderWidth: 1.3,
          pointRadius: 0, pointHoverRadius: 4,
          pointHoverBackgroundColor: warn, pointHoverBorderColor: flaeche,
          pointHoverBorderWidth: 2, borderDash: [4, 4], tension: .15 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      /* Platz unten und rechts, damit der versetzte Koerper nicht an der
         Achse klebt. */
      layout: { padding: { bottom: TIEFE_Y + 2, right: TIEFE_X + 2 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: dpFarbe("--surface", "#202833"),
          borderColor: linie, borderWidth: 1,
          titleColor: ink, bodyColor: muted, padding: 9,
          displayColors: true, boxWidth: 8, boxHeight: 8, usePointStyle: true,
          callbacks: {
            /* Volles Datum statt "Mär 24" - bei Tagesdaten ist der Monat zu grob. */
            title: p => p.length
              ? new Date(p[0].parsed.x).toLocaleDateString("de-DE",
                  { day: "2-digit", month: "long", year: "numeric" })
              : "",
            label: c => c.dataset.label + ": " + dpMoney(c.parsed.y, 0),
            /* Der Abstand ist die eigentliche Frage des Diagramms. */
            afterBody: p => {
              if (p.length < 2) return "";
              const d = p[0].parsed.y - p[1].parsed.y;
              const q = p[1].parsed.y > 0 ? d / p[1].parsed.y : null;
              return (d >= 0 ? "Vorsprung " : "Rückstand ")
                   + dpMoney(Math.abs(d), 0)
                   + (q != null ? "  (" + fmtPct(Math.abs(q), false) + ")" : "");
            },
          },
        },
      },
      scales: {
        x: {
          type: "time",
          time: { unit: "month", tooltipFormat: "dd.MM.yyyy",
                  displayFormats: { month: "MMM yy", year: "yyyy" } },
          ticks: { color: faint, maxTicksLimit: 6, autoSkip: true,
                   maxRotation: 0, font: { family: "IBM Plex Mono", size: 10 } },
          grid: { display: false },
          border: { color: linie },
        },
        y: {
          ticks: { color: faint, maxTicksLimit: 6, padding: 6,
                   font: { family: "IBM Plex Mono", size: 10 },
                   callback: v => dpAchsenZahl(v) },
          grid: { color: linie, drawTicks: false },
          border: { display: false },
          /* Achsenbreite an der breitesten Beschriftung ausrichten. Chart.js
             schaetzt sie selbst, lag hier aber zwei Pixel zu knapp - genug, um
             fuenfstellige Betraege links anzuschneiden. Lieber nachmessen. */
          afterFit(achse) {
            const c = achse.chart.ctx;
            c.save();
            c.font = '10px "IBM Plex Mono"';
            let breit = 0;
            for (const t of achse.ticks) {
              breit = Math.max(breit, c.measureText(dpAchsenZahl(t.value)).width);
            }
            c.restore();
            achse.width = Math.max(achse.width, Math.ceil(breit) + 10);
          },
        },
      },
    },
    plugins: [dpTiefe, dpFadenkreuz],
  });

  /* Noch einmal umbrechen, sobald die Schriften da sind. Die Achsenbreite wird
     durch Ausmessen der Beschriftung bestimmt; laeuft das, bevor "IBM Plex Mono"
     geladen ist, misst der Browser die Ersatzschrift und die Achse faellt zu
     schmal aus - fuenfstellige Betraege wurden dadurch links angeschnitten. */
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => {
      if (dpLineChart) dpLineChart.update("none");
    }).catch(() => {});
  }
}

function dpDrawPie(rows) {
  const cv = $("#dppie");
  if (!cv || typeof Chart === "undefined") return;
  if (dpPieChart) dpPieChart.destroy();
  const g = depotGroups(rows, DepotUI.pie);
  if (!g.length) return;
  const total = g.reduce((a, b) => a + b[1], 0);
  dpPieChart = new Chart(cv, {
    type: "doughnut",
    data: {
      labels: g.map(x => x[0]),
      /* Kein Modulo mehr: die Gruppen sind auf die Palettenlaenge begrenzt,
         eine Farbe kann also nicht zweimal vergeben werden. */
      datasets: [{ data: g.map(x => x[1]), backgroundColor: g.map((_, i) => DP_COLORS[i]),
                   borderColor: dpFarbe("--bg2", "#1B212B"), borderWidth: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "58%",
      plugins: {
        legend: { position: "right", labels: { color: dpFarbe("--muted", "#93A0B0"),
                  boxWidth: 11, padding: 8, font: { family: "Inter", size: 11 } } },
        tooltip: {
          backgroundColor: dpFarbe("--surface", "#202833"),
          borderColor: dpFarbe("--line", "#313B49"), borderWidth: 1,
          titleColor: dpFarbe("--ink", "#E9EDF3"), bodyColor: dpFarbe("--muted", "#93A0B0"),
          callbacks: { label: c => `${c.label}: ${dpMoney(c.parsed, 0)} (${(c.parsed / total * 100).toFixed(1).replace(".", ",")} %)` },
        },
      },
    },
  });
}

/* ---------- Formular ---------- */
function dpOpenForm(existing) {
  const host = $("#depotform");
  host.hidden = false;
  DepotUI.editId = existing ? existing.id : null;
  const today = new Date().toISOString().slice(0, 10);

  host.innerHTML = `
    <div class="dp-form">
      <div class="dp-form-h"><b>${existing ? "Position bearbeiten" : "Position anlegen"}</b>
        <button class="dp-close" id="dpfclose">✕</button></div>

      <div class="dp-f-row">
        <label>Titel</label>
        ${existing
          ? `<div class="dp-fixed">${esc(existing.n)} <i>${esc(existing.sym)}</i></div>`
          : `<div class="dp-search">
               <input id="dpq" type="text" autocomplete="off" placeholder="Name oder Ticker suchen …">
               <div id="dpsugg" class="dp-sugg"></div>
             </div>`}
      </div>

      <div class="dp-f-grid3">
        <div><label>Anzahl Anteile</label>
          <input id="dpshares" type="number" step="any" min="0" placeholder="z. B. 30"
                 value="${existing ? existing.shares : ""}"></div>
        <div><label>Ø Einstand je Anteil <small>in <b>EUR</b></small></label>
          <input id="dpprice" type="number" step="any" min="0" placeholder="z. B. 182,00"
                 value="${existing ? (existing.avgEur != null ? existing.avgEur : "") : ""}">
          <span class="dp-price-eur" id="dppriceeur"></span></div>
        <div><label>Gehalten seit <small>optional</small></label>
          <input id="dpdate" type="date" max="${today}" value="${existing && existing.since ? existing.since : ""}"></div>
      </div>

      <div class="dp-calc" id="dpcalc"></div>

      <div class="dp-f-foot">
        <span class="dp-f-note" id="dpnote">${existing ? "" : "Bitte zuerst einen Titel auswählen."}</span>
        <div class="dp-f-btns">
          ${existing ? `<button class="dp-btn danger" id="dpdel">Löschen</button>` : ""}
          <button class="dp-btn primary" id="dpsave" ${existing ? "" : "disabled"}>Speichern</button>
        </div>
      </div>
    </div>`;

  let picked = existing ? { s: existing.sym, n: existing.n, cur: existing.cur, sec: existing.sec, c: existing.country } : null;
  let market = null;
  const note = $("#dpnote"), save = $("#dpsave"), calc = $("#dpcalc");

  /* Live-Vorschau: macht Zahlendreher sofort sichtbar.
     Eingabe ist der Euro-Einstand je Anteil. */
  const preview = () => {
    const sh = parseFloat(String($("#dpshares").value).replace(",", "."));
    const avEur = parseFloat(String($("#dpprice").value).replace(",", "."));
    const cur = (picked && picked.cur) || "";

    /* Kontrollzeile: entspricht dem eingegebenen Euro-Einstand ungefähr
       welchem Kurs in Originalwährung? Nur zeigen, wenn nicht ohnehin EUR. */
    const eurBox = $("#dppriceeur");
    if (eurBox) {
      const rEur = depotRate("EUR");                 // EUR -> Anzeigewährung
      const rCur = depotRate(cur);                   // Originalwährung -> Anzeigewährung
      if (avEur > 0 && cur && fxBase(cur) !== "EUR" && rEur != null && rCur) {
        const origPrice = avEur * rEur / rCur;        // Euro-Einstand in Originalkurs
        eurBox.textContent = "entspricht ≈ " + fmtNum(origPrice, cur, 2) + " je Anteil";
        eurBox.classList.add("show");
      } else {
        eurBox.textContent = "";
        eurBox.classList.remove("show");
      }
    }

    if (!(sh > 0) || !(avEur > 0)) { calc.innerHTML = ""; calc.classList.remove("warn"); return; }
    const costEur = sh * avEur;
    let html = `<b>${fmtNum(sh, null, sh % 1 ? 3 : 0)}</b> Anteile × <b>${fmtNum(avEur, "EUR", 2)}</b>
                = Einstand <b>${fmtNum(costEur, "EUR", 2)}</b>`;
    let warn = false;
    if (market != null) {
      /* aktueller Wert in Euro: Marktkurs (Originalwährung) -> EUR */
      const rToEur = curToEur(cur);
      if (rToEur != null) {
        const valEur = sh * market * rToEur, pl = valEur / costEur - 1;
        html += `<br>aktueller Wert <b>${fmtNum(valEur, "EUR", 2)}</b>
                 <span class="${chgCls(pl)}">${fmtPct(pl)}</span>`;
        const marketEur = market * rToEur;
        if (avEur > marketEur * 10 || avEur < marketEur / 10) {
          warn = true;
          html += `<br><span class="dp-alert">Der eingetragene Einstand weicht stark vom
                   aktuellen Kurs (${fmtNum(marketEur, "EUR", 2)}) ab. Bitte prüfen: Hier gehört
                   der <b>Kurs je Anteil in Euro</b> hinein, nicht der investierte Gesamtbetrag.</span>`;
        }
      }
    }
    calc.innerHTML = html;
    calc.classList.toggle("warn", warn);
  };

  const loadMarket = async sym => {
    note.innerHTML = `<span class="spin"></span> Kurs wird geladen …`;
    try {
      const ch = await loadChart(sym);
      picked.cur = ch.meta.currency || "";
      market = ch.c[ch.c.length - 1];
      if (picked.cur) await depotEnsureFx([picked.cur]);
      const rToEur = curToEur(picked.cur);
      const inEur = (rToEur != null && fxBase(picked.cur) !== "EUR")
        ? ` (≈ ${fmtNum(market * rToEur, "EUR", 2)})` : "";
      note.textContent = `${sym} · aktueller Kurs ${fmtNum(market, picked.cur, 2)}${inEur}`;
      save.disabled = false;
      preview();
    } catch (e) {
      market = null;
      note.textContent = "Kurs für " + sym + " nicht abrufbar – Eintrag trotzdem möglich.";
      save.disabled = false;
    }
  };
  if (existing) loadMarket(existing.sym);

  ["#dpshares", "#dpprice"].forEach(sel => $(sel).addEventListener("input", preview));

  if (!existing) {
    const q = $("#dpq");
    let tmr = null;
    const pick = item => {
      picked = item; q.value = item.n;
      $("#dpsugg").innerHTML = ""; $("#dpsugg").classList.remove("open");
      loadMarket(item.s);
    };
    q.addEventListener("input", () => {
      picked = null; market = null; save.disabled = true;
      clearTimeout(tmr);
      const v = q.value.trim();
      if (!v) { $("#dpsugg").classList.remove("open"); return; }
      const local = localSearch(v, 6);
      dpPaintSugg(local, pick);
      tmr = setTimeout(async () => {
        try {
          const rem = await remoteSearch(v);
          const have = new Set(local.map(r => r.s));
          dpPaintSugg(local.concat(rem.filter(r => !have.has(r.s))), pick);
        } catch (e) {}
      }, 480);
    });
  }

  $("#dpfclose").onclick = () => { host.hidden = true; host.innerHTML = ""; DepotUI.editId = null; };

  const delBtn = $("#dpdel");
  if (delBtn) delBtn.onclick = () => {
    if (!confirm(`Position „${existing.n}" wirklich löschen?`)) return;
    Depot.remove(existing.id);
    host.hidden = true; host.innerHTML = ""; DepotUI.editId = null;
    renderDepot();
  };

  save.onclick = () => {
    const shares = parseFloat(String($("#dpshares").value).replace(",", "."));
    const avgEur = parseFloat(String($("#dpprice").value).replace(",", "."));
    const since = $("#dpdate").value || "";
    if (!picked) { note.textContent = "Bitte einen Titel aus der Liste wählen."; return; }
    if (!(shares > 0)) { note.textContent = "Bitte eine Anzahl größer null eintragen."; return; }
    if (!(avgEur > 0)) { note.textContent = "Bitte einen Euro-Einstand größer null eintragen."; return; }
    if (since && Date.parse(since) > Date.now() + 864e5) { note.textContent = "Das Datum liegt in der Zukunft."; return; }

    const data = { sym: picked.s, n: picked.n, cur: picked.cur || "",
                   sec: picked.sec || "", country: picked.c || "", shares, avgEur, avg: null, since };
    let okSaved;
    if (DepotUI.editId) okSaved = Depot.update(DepotUI.editId, data);
    else {
      const dup = Depot.list().find(p => p.sym === picked.s);
      if (dup && !confirm(`„${picked.n}" ist bereits im Depot. Trotzdem als zweite Position anlegen?`)) return;
      okSaved = Depot.add(data);
    }
    if (!okSaved) { note.textContent = "Speichern fehlgeschlagen – Browser-Speicher voll?"; return; }
    host.hidden = true; host.innerHTML = ""; DepotUI.editId = null;
    renderDepot();
  };
}

function dpPaintSugg(rows, pick) {
  const sugg = $("#dpsugg");
  if (!sugg) return;
  if (!rows.length) { sugg.classList.remove("open"); sugg.innerHTML = ""; return; }
  sugg.innerHTML = rows.map((r, i) => `<div class="dp-sg" data-i="${i}">
      <span>${esc(r.n)}</span><i>${esc(r.s)}${r.e ? " · " + esc(r.e) : ""}</i></div>`).join("");
  sugg.classList.add("open");
  sugg.querySelectorAll(".dp-sg").forEach(node => { node.onclick = () => pick(rows[+node.dataset.i]); });
}

/* ---------- Sicherung ---------- */
function dpExport() {
  const payload = { app: "aktien-cockpit-depot", version: 2,
                    exported: new Date().toISOString(), positions: Depot.list() };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "depot-" + new Date().toISOString().slice(0, 10) + ".json";
  document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function dpImport() {
  const inp = document.createElement("input");
  inp.type = "file"; inp.accept = "application/json,.json";
  inp.onchange = () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        let arr = Array.isArray(d) ? d : (d.positions || d.tx);
        if (!Array.isArray(arr)) throw new Error("Format");

        /* Ältere Sicherungen enthalten Transaktionen – umrechnen */
        if (arr.length && arr[0] && arr[0].type) {
          const map = new Map();
          for (const t of [...arr].sort((a, b) => String(a.date).localeCompare(String(b.date)))) {
            if (!t.sym || !isFinite(t.shares) || !isFinite(t.price)) continue;
            let p = map.get(t.sym);
            if (!p) { p = { sym: t.sym, n: t.n || t.sym, cur: t.cur || "", sec: t.sec || "",
                            country: t.country || "", shares: 0, cost: 0, since: t.date || "" };
                      map.set(t.sym, p); }
            const qty = Math.abs(Number(t.shares)), px = Number(t.price);
            if (t.type === "sell") {
              const av = p.shares > 0 ? p.cost / p.shares : 0;
              const sold = Math.min(qty, p.shares);
              p.cost -= sold * av; p.shares -= sold;
            } else { p.shares += qty; p.cost += qty * px; }
          }
          arr = [...map.values()].filter(p => p.shares > 1e-9)
                 .map(p => ({ ...p, avg: p.cost / p.shares }));
        }

        const clean = arr
          .filter(p => p && p.sym && isFinite(p.shares) && Number(p.shares) > 0 &&
            ((p.avgEur != null && isFinite(p.avgEur)) || isFinite(p.avg)))
          .map(p => ({ id: p.id || ("p" + Math.random().toString(36).slice(2, 10)),
                       sym: String(p.sym), n: String(p.n || p.sym), cur: String(p.cur || ""),
                       sec: String(p.sec || ""), country: String(p.country || ""),
                       shares: Math.abs(Number(p.shares)),
                       avgEur: (p.avgEur != null && isFinite(p.avgEur)) ? Math.abs(Number(p.avgEur)) : null,
                       avg: isFinite(p.avg) ? Math.abs(Number(p.avg)) : null,
                       since: p.since ? String(p.since).slice(0, 10) : "" }));
        if (!clean.length) throw new Error("leer");
        const cnt = Depot.list().length;
        if (cnt && !confirm(`Die vorhandenen ${cnt} Positionen werden durch ${clean.length} aus der Datei ersetzt. Fortfahren?`)) return;
        Depot.replaceAll(clean);
        renderDepot();
      } catch (e) {
        alert("Die Datei konnte nicht gelesen werden. Erwartet wird eine Sicherung aus diesem Cockpit.");
      }
    };
    fr.readAsText(file);
  };
  inp.click();
}

/* ---------- Verdrahtung ---------- */
function dpWireActions() {
  const box = $("#depotbody");
  const on = (sel, fn) => { const n = box.querySelector(sel); if (n) n.onclick = fn; };
  on("#dpadd", () => dpOpenForm(null));
  on("#dpexport", dpExport);
  on("#dpimport", dpImport);
  box.querySelectorAll(".dp-tab").forEach(b => b.onclick = () => {
    DepotUI.pie = b.dataset.pie;
    box.querySelectorAll(".dp-tab").forEach(x => x.classList.toggle("on", x === b));
    dpDrawPie(DepotUI.rows);
  });
  box.querySelectorAll("[data-edit]").forEach(b => b.onclick = () => {
    const p = Depot.list().find(x => x.id === b.dataset.edit);
    if (p) dpOpenForm(p);
  });
  box.querySelectorAll("[data-open]").forEach(b => b.onclick = () => {
    const r = DepotUI.rows.find(x => x.sym === b.dataset.open);
    if (r) openDetail({ s: r.sym, n: r.n, c: r.country, e: "", sec: r.sec });
  });
}

function initDepot() {
  const body = $("#depotbody"), tgl = $("#depottoggle");
  if (!body || !tgl) return;
  let open = true;
  try { open = localStorage.getItem("ak.depot.open") !== "0"; } catch (e) {}
  const paint = () => {
    body.style.display = open ? "" : "none";
    const f = $("#depotform"); if (f && !open) { f.hidden = true; f.innerHTML = ""; }
    tgl.textContent = open ? "Einklappen" : "Ausklappen";
  };
  paint();
  tgl.onclick = () => { open = !open; try { localStorage.setItem("ak.depot.open", open ? "1" : "0"); } catch (e) {} paint(); };
  renderDepot();
}
