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
  for (const cur of new Set(currencies)) {
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
function depotSeries(positions, charts, bench, rateOf) {
  if (!bench || !bench.t || bench.t.length < 5) return null;
  const usable = positions.filter(p => charts.get(p.sym) && p.shares > 0);
  if (!usable.length) return null;

  let dataStart = bench.t[0];
  for (const p of usable) {
    const ch = charts.get(p.sym);
    if (ch && ch.t.length) dataStart = Math.max(dataStart, ch.t[0]);
  }
  const sinceList = usable.map(p => p.since ? Date.parse(p.since + "T00:00:00Z") : null);
  const allDated = sinceList.every(x => x != null && isFinite(x));
  const startTs = allDated ? Math.max(dataStart, Math.min(...sinceList)) : dataStart;

  const grid = bench.t.filter(t => t >= startTs);
  if (grid.length < 3) return null;

  const px = new Map();
  for (const p of usable) px.set(p.sym, priceAtFactory(charts.get(p.sym)));
  const benchAt = priceAtFactory(bench);

  const events = usable.map((p, i) => ({
    ts: (sinceList[i] != null && isFinite(sinceList[i])) ? sinceList[i] : 0,
    sym: p.sym, cur: (charts.get(p.sym).meta.currency || p.cur || ""),
    qty: p.shares, price: Number(p.avg) || 0,
  })).sort((a, b) => a.ts - b.ts);

  const held = new Map();
  let ei = 0, units = null, seeded = false;
  const outT = [], outV = [], outB = [];

  for (const d of grid) {
    let flow = 0;
    while (ei < events.length && events[ei].ts <= d) {
      const e = events[ei++];
      held.set(e.sym, (held.get(e.sym) || 0) + e.qty);
      const r = rateOf(e.cur);
      if (r != null) flow += e.qty * e.price * r;
    }

    let value = 0;
    for (const [sym, sh] of held) {
      if (Math.abs(sh) < 1e-9) continue;
      const f = px.get(sym);
      const ch = charts.get(sym);
      const p = f ? f(d) : null;
      const r = rateOf(ch ? (ch.meta.currency || "") : "");
      if (p == null || r == null) continue;
      value += sh * p * r;
    }

    const bp = benchAt(d);
    if (bp == null || !isFinite(value) || value <= 0) continue;

    if (!seeded) { units = value / bp; seeded = true; }
    else if (flow !== 0) { units += flow / bp; }

    outT.push(d); outV.push(value); outB.push(units * bp);
  }
  if (outT.length < 3) return null;
  return { t: outT, value: outV, bench: outB, startTs: outT[0], dated: allDated };
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
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
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
const DP_COLORS = ["#4FB8AC", "#7FA9E6", "#E0B45C", "#54B183", "#E06A72", "#B48CD6",
                   "#5FC2C9", "#D89A6A", "#8FBF6B", "#C97FA8", "#6E8FB8", "#A9B37E"];

function dpMoney(v, dig) {
  if (v == null || !isFinite(v)) return "–";
  return fmtNum(v, depotCur(), dig ?? 2);
}
function dpMoneyBig(v) {
  if (v == null || !isFinite(v)) return "–";
  return Math.abs(v) >= 1e6 ? fmtBig(v) + " " + depotCur() : fmtNum(v, depotCur(), 0);
}

/* Positionen mit aktuellen Kursen anreichern */
async function depotBuildRows() {
  const items = Depot.list();
  if (!items.length) return { rows: [], charts: new Map() };
  await depotEnsureFx(items.map(p => p.cur));

  const charts = new Map(), rows = [];
  await Promise.all(items.map(p => new Promise(resolve => {
    Queue.push(async () => {
      let chart = null, a = null;
      try {
        chart = await loadChart(p.sym);
        charts.set(p.sym, chart);
        const bench = await loadBenchmark();
        a = analyse(chart, null, bench);
      } catch (e) { /* Kurs nicht verfügbar */ }
      const cur = (chart && chart.meta.currency) || p.cur || "";
      const rate = depotRate(cur);
      const price = chart ? chart.c[chart.c.length - 1] : null;
      const avg = Number(p.avg) || 0;
      rows.push({
        ...p, cur, price, avg, a,
        value: (price != null && rate != null) ? p.shares * price * rate : null,
        costConv: rate != null ? p.shares * avg * rate : null,
        plPct: (price != null && avg > 0) ? price / avg - 1 : null,
        ok: !!chart,
      });
      resolve();
    });
  })));
  rows.sort((x, y) => (y.value ?? -1) - (x.value ?? -1));
  return { rows, charts };
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

  let rows = [], charts = new Map(), series = null;
  try {
    ({ rows, charts } = await depotBuildRows());
    const bench = await loadChart("ACWI", "5y").catch(() => loadBenchmark());
    series = depotSeries(Depot.list(), charts, bench, depotRate);
  } catch (e) { /* unten abgefangen */ }
  DepotUI.rows = rows; DepotUI.series = series;
  DepotUI.busy = false;

  const st = depotStats(rows);
  const cur = depotCur();
  const missing = rows.filter(r => !r.ok || r.value == null);

  const perf = series
    ? `<div class="dp-c"><span>gegenüber Welt-Index</span><b class="${chgCls(series.value.at(-1) - series.bench.at(-1))}">${
        series.bench.at(-1) > 0 ? fmtPct(series.value.at(-1) / series.bench.at(-1) - 1) : "–"}</b></div>`
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
        <div class="dp-panel-h"><h4>Wertentwicklung</h4>
          <span class="dp-legend"><i style="background:var(--accent)"></i>Depot
            <i style="background:var(--warn);margin-left:10px"></i>Welt-Index</span></div>
        <div class="dp-canvas">${series
          ? `<canvas id="dpline"></canvas>`
          : `<div class="dp-note" style="margin:0">Für die Wertkurve fehlen noch ausreichende Kursdaten.</div>`}</div>
        ${series ? `<p class="dp-curvenote">${series.dated
          ? "Verlauf ab dem frühesten Haltedatum. Die Vergleichslinie erhält dieselben Beträge zu denselben Zeitpunkten."
          : "Ohne Haltedaten zeigt die Kurve, wie sich deine <b>heutige</b> Zusammensetzung entwickelt hätte. Trage bei den Positionen ein \u201egehalten seit\u201c ein, um den tatsächlichen Aufbau abzubilden."}</p>` : ""}
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

function dpRow(r) {
  let zone = "–";
  if (r.a && r.a.zones && r.price != null) {
    const z = r.a.zones;
    if (r.price <= z.stop) zone = `<span class="dp-z bad">unter Stop</span>`;
    else if (r.price >= z.t1) zone = `<span class="dp-z good">Ziel erreicht</span>`;
    else zone = `<span class="dp-z">${fmtPct(z.t1 / r.price - 1)} bis Ziel</span>`;
  }
  return `<tr data-sym="${esc(r.sym)}">
    <td><span class="dp-name">${esc(r.n)}</span><span class="dp-sym">${esc(r.sym)}${r.sec ? " · " + esc(r.sec) : ""}</span></td>
    <td class="r">${fmtNum(r.shares, null, r.shares % 1 ? 3 : 0)}</td>
    <td class="r">${r.avg > 0 ? fmtNum(r.avg, null, 2) : "–"}</td>
    <td class="r">${r.price != null ? fmtNum(r.price, null, 2) : "–"}<small>${esc(r.cur)}</small></td>
    <td class="r"><b>${dpMoney(r.value)}</b></td>
    <td class="r ${chgCls(r.plPct)}">${fmtPct(r.plPct)}</td>
    <td>${zone}</td>
    <td class="r nowrap">
      <button class="dp-mini" data-edit="${esc(r.id)}" title="Bearbeiten">✎</button>
      <button class="dp-mini" data-open="${esc(r.sym)}" title="Analyse öffnen">↗</button>
    </td>
  </tr>`;
}

/* ---------- Diagramme ---------- */
function dpDrawLine(s) {
  const cv = $("#dpline");
  if (!cv || typeof Chart === "undefined") return;
  if (dpLineChart) dpLineChart.destroy();
  const labels = s.t.map(t => new Date(t).toLocaleDateString("de-DE", { month: "short", year: "2-digit" }));
  dpLineChart = new Chart(cv, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Depot", data: s.value, borderColor: "#4FB8AC", backgroundColor: "rgba(79,184,172,.10)",
          borderWidth: 1.9, pointRadius: 0, fill: true, tension: .15 },
        { label: "Welt-Index", data: s.bench, borderColor: "#E0B45C", borderWidth: 1.3,
          pointRadius: 0, borderDash: [4, 4], tension: .15 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#202833", borderColor: "#313B49", borderWidth: 1,
          titleColor: "#E9EDF3", bodyColor: "#93A0B0",
          callbacks: { label: c => c.dataset.label + ": " + dpMoney(c.parsed.y, 0) },
        },
      },
      scales: {
        x: { ticks: { color: "#6B7787", maxTicksLimit: 7, font: { family: "IBM Plex Mono", size: 10 } }, grid: { display: false } },
        y: { ticks: { color: "#6B7787", font: { family: "IBM Plex Mono", size: 10 },
             callback: v => dpMoneyBig(v) }, grid: { color: "rgba(49,59,73,.5)" } },
      },
    },
  });
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
      datasets: [{ data: g.map(x => x[1]), backgroundColor: g.map((_, i) => DP_COLORS[i % DP_COLORS.length]),
                   borderColor: "#1B212B", borderWidth: 2 }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false, cutout: "58%",
      plugins: {
        legend: { position: "right", labels: { color: "#93A0B0", boxWidth: 11, padding: 8,
                  font: { family: "Inter", size: 11 } } },
        tooltip: {
          backgroundColor: "#202833", borderColor: "#313B49", borderWidth: 1,
          titleColor: "#E9EDF3", bodyColor: "#93A0B0",
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
        <div><label>Ø Einstandskurs <small>je Anteil <span id="dpcur">${existing && existing.cur ? "in " + esc(existing.cur) : ""}</span></small></label>
          <input id="dpprice" type="number" step="any" min="0" placeholder="z. B. 198,00"
                 value="${existing ? existing.avg : ""}"></div>
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

  /* Live-Vorschau: macht Zahlendreher sofort sichtbar */
  const preview = () => {
    const sh = parseFloat(String($("#dpshares").value).replace(",", "."));
    const av = parseFloat(String($("#dpprice").value).replace(",", "."));
    if (!(sh > 0) || !(av > 0)) { calc.innerHTML = ""; calc.classList.remove("warn"); return; }
    const cur = (picked && picked.cur) || "";
    const cost = sh * av;
    let html = `<b>${fmtNum(sh, null, sh % 1 ? 3 : 0)}</b> Anteile × <b>${fmtNum(av, cur, 2)}</b>
                = Einstand <b>${fmtNum(cost, cur, 2)}</b>`;
    let warn = false;
    if (market != null) {
      const val = sh * market, pl = val / cost - 1;
      html += `<br>aktueller Wert <b>${fmtNum(val, cur, 2)}</b>
               <span class="${chgCls(pl)}">${fmtPct(pl)}</span>`;
      if (av > market * 10 || av < market / 10) {
        warn = true;
        html += `<br><span class="dp-alert">Der eingetragene Kurs weicht stark vom Marktkurs
                 (${fmtNum(market, cur, 2)}) ab. Bitte prüfen: Hier gehört der Kurs <b>je Anteil</b>
                 hinein, nicht der investierte Gesamtbetrag.</span>`;
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
      $("#dpcur").textContent = picked.cur ? "in " + picked.cur : "";
      note.textContent = `${sym} · aktueller Kurs ${fmtNum(market, picked.cur, 2)}`;
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
    const avg = parseFloat(String($("#dpprice").value).replace(",", "."));
    const since = $("#dpdate").value || "";
    if (!picked) { note.textContent = "Bitte einen Titel aus der Liste wählen."; return; }
    if (!(shares > 0)) { note.textContent = "Bitte eine Anzahl größer null eintragen."; return; }
    if (!(avg > 0)) { note.textContent = "Bitte einen Einstandskurs größer null eintragen."; return; }
    if (since && Date.parse(since) > Date.now() + 864e5) { note.textContent = "Das Datum liegt in der Zukunft."; return; }

    const data = { sym: picked.s, n: picked.n, cur: picked.cur || "",
                   sec: picked.sec || "", country: picked.c || "", shares, avg, since };
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
          .filter(p => p && p.sym && isFinite(p.shares) && Number(p.shares) > 0 && isFinite(p.avg))
          .map(p => ({ id: p.id || ("p" + Math.random().toString(36).slice(2, 10)),
                       sym: String(p.sym), n: String(p.n || p.sym), cur: String(p.cur || ""),
                       sec: String(p.sec || ""), country: String(p.country || ""),
                       shares: Math.abs(Number(p.shares)), avg: Math.abs(Number(p.avg)),
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
