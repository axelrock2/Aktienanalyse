"use strict";
/* =====================================================================
   AKTIEN-COCKPIT  ·  Kernanwendung
   ---------------------------------------------------------------------
   Enthält: Hilfsfunktionen, Zwischenspeicher, Datenabruf, Indikatoren,
   Analyse, Suche, Favoriten, Detailansicht, Dossier, Anzeigewährung,
   Aktualisierung und Newsfeed.
   Das Depot liegt in depot.js und wird danach geladen.
   ===================================================================== */

/* =====================================================================
   Aktien-Cockpit – Suche, Favoriten, Scoring, Zonen
   ===================================================================== */

/* ---------- Hilfsfunktionen ---------- */
const $ = s => document.querySelector(s);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lin = (x, x0, x1) => x == null || !isFinite(x) ? null : clamp((x - x0) / (x1 - x0) * 100, 0, 100);
const fmtNum = (v, cur, dig) => v == null || !isFinite(v) ? "–" :
  new Intl.NumberFormat("de-DE", cur ? {style:"currency",currency:cur,maximumFractionDigits:dig??2,minimumFractionDigits:dig??2} : {maximumFractionDigits:dig??2}).format(v);
const fmtPct = (v, signed=true) => v == null || !isFinite(v) ? "–" :
  (signed && v > 0 ? "+" : "") + new Intl.NumberFormat("de-DE",{maximumFractionDigits:1,minimumFractionDigits:1}).format(v*100) + " %";
const fmtBig = v => {
  if (v == null || !isFinite(v)) return "–";
  const a = Math.abs(v);
  if (a >= 1e12) return (v/1e12).toFixed(2).replace(".",",") + " Bio.";
  if (a >= 1e9)  return (v/1e9).toFixed(2).replace(".",",") + " Mrd.";
  if (a >= 1e6)  return (v/1e6).toFixed(1).replace(".",",") + " Mio.";
  return fmtNum(v);
};
const raw = v => (v && typeof v === "object") ? (isFinite(v.raw) ? v.raw : null) : (isFinite(v) ? v : null);
const chgCls = v => v == null ? "neu" : v > 0.0001 ? "pos" : v < -0.0001 ? "neg" : "neu";

/* ---------- Lokaler Cache (localStorage, mit Ablauf) ---------- */
/* Wie lange ein Zwischenspeicher-Eintrag hoechstens liegen bleiben darf, egal
   wofuer er gedacht war. Ohne diese Grenze sammeln sich Kurse und Kennzahlen
   von Titeln an, die man einmal angesehen und danach nie wieder geoeffnet hat -
   geloescht wurde bisher erst, wenn der Speicher voll lief. */
const CACHE_MAX_ALTER = 7 * 24 * 60 * 60 * 1000;      // sieben Tage

const Cache = {
  /* Abgelaufenes aufraeumen. Laeuft einmal beim Start, nicht bei jedem Zugriff:
     Es geht um Speicherplatz, nicht um Genauigkeit - die Frische pruefen die
     Aufrufer ohnehin einzeln ueber ihre eigene Haltbarkeit. */
  prune() {
    let weg = 0;
    try {
      const jetzt = Date.now();
      for (const k of Object.keys(localStorage)) {
        if (!k.startsWith("ak.cache.")) continue;
        try {
          const it = JSON.parse(localStorage.getItem(k));
          if (!it || typeof it.t !== "number" || jetzt - it.t > CACHE_MAX_ALTER) {
            localStorage.removeItem(k); weg++;
          }
        } catch (e) { localStorage.removeItem(k); weg++; }
      }
    } catch (e) {}
    return weg;
  },

  /* wie get(), liefert zusätzlich den Speicherzeitpunkt */
  getEntry(key, ttlMs) {
    try {
      const it = JSON.parse(localStorage.getItem("ak.cache." + key));
      if (it && Date.now() - it.t < ttlMs) return it;
    } catch (e) {}
    return null;
  },
  /* zwischengespeicherte Daten verwerfen (optional nur ein Präfix) */
  clear(prefix) {
    try {
      const p = "ak.cache." + (prefix || "");
      Object.keys(localStorage).filter(k => k.startsWith(p)).forEach(k => localStorage.removeItem(k));
    } catch (e) {}
  },
  get(key, ttlMs) {
    try {
      const it = JSON.parse(localStorage.getItem("ak.cache." + key));
      if (it && Date.now() - it.t < ttlMs) return it.v;
    } catch (e) {}
    return null;
  },
  set(key, v) {
    try { localStorage.setItem("ak.cache." + key, JSON.stringify({ t: Date.now(), v })); }
    catch (e) { // Speicher voll -> Cache leeren und erneut versuchen
      try {
        Object.keys(localStorage).filter(k => k.startsWith("ak.cache.")).forEach(k => localStorage.removeItem(k));
        localStorage.setItem("ak.cache." + key, JSON.stringify({ t: Date.now(), v }));
      } catch (e2) {}
    }
  }
};

/* ---------- Netzwerkschicht: mehrere Wege mit automatischem Failover ----------
   Yahoo sendet selbst keine CORS-Kopfzeilen; ein Zwischenweg ist deshalb Pflicht,
   nicht Komfort. Stand der Pruefung (siehe README): corsproxy.io verlangt
   inzwischen einen bezahlten Tarif (HTTP 403), allorigins und codetabs
   antworteten mit 502/522. Der Textleser r.jina.ai lieferte stabil und spiegelt
   die eigene Herkunft in Access-Control-Allow-Origin - er steht daher zuerst.
   Die uebrigen Wege bleiben als Reserve stehen: sie kosten nichts, wenn sie
   schnell scheitern, und waren zeitweise wieder erreichbar. */
const PROXIES = [
  { name: "jina",
    url: u => "https://r.jina.ai/" + u,
    kopf: { "x-respond-with": "text" },
    text: true },   // kann auch ganze Seiten als Klartext liefern
  { name: "codetabs",
    url: u => "https://api.codetabs.com/v1/proxy?quest=" + encodeURIComponent(u) },
  { name: "allorigins-get",
    url: u => "https://api.allorigins.win/get?url=" + encodeURIComponent(u),
    schale: d => (typeof d.contents === "string" ? JSON.parse(d.contents) : d) },
  { name: "allorigins-raw",
    url: u => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u) },
  { name: "corsproxy",
    url: u => "https://corsproxy.io/?url=" + encodeURIComponent(u) },
];

/* Antwort als Text lesen und das JSON herausschneiden. Der Textleser stellt der
   Antwort je nach Betriebsart ein paar Zeilen Klartext voran ("URL Source: ...");
   ohne dieses Zurechtschneiden scheitert JSON.parse daran. */
function jsonAusText(txt) {
  const i = txt.indexOf("{");
  if (i < 0) throw new Error("Kein JSON in der Antwort");
  return JSON.parse(i === 0 ? txt : txt.slice(i));
}

async function fetchDurch(url, { alsText = false, validate, timeout = 12000 } = {}) {
  const start = +(sessionStorage.getItem("ak.proxy") || 0);
  let lastErr = null;
  for (let i = 0; i < PROXIES.length; i++) {
    const idx = (start + i) % PROXIES.length;
    const weg = PROXIES[idx];
    /* Seiten in Textform koennen nur Wege liefern, die das ausdruecklich
       anbieten - die uebrigen reichen HTML durch, das hier niemand braucht. */
    if (alsText && !weg.text) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(weg.url(url), {
        signal: ctrl.signal,
        headers: weg.kopf || undefined,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const roh = await res.text();
      let data;
      if (alsText) {
        data = roh;
      } else {
        data = jsonAusText(roh);
        if (weg.schale) data = weg.schale(data);
      }
      if (validate && !validate(data)) throw new Error("Unerwartetes Format");
      sessionStorage.setItem("ak.proxy", String(idx));   // erfolgreichen Weg merken
      return data;
    } catch (e) { clearTimeout(timer); lastErr = e; }
  }
  throw lastErr || new Error("Keine Datenquelle erreichbar");
}

function fetchJson(url, validate, timeout = 12000) {
  return fetchDurch(url, { validate, timeout });
}

/* ---------- Kursdaten (Yahoo Chart-API) ---------- */
async function loadChart(symbol, range = "2y") {
  const key = "chart." + symbol + "." + range;
  const entry = Cache.getEntry(key, 10 * 60 * 1000);
  if (entry) { Fresh.note(entry.t); return entry.v; }
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=1d&events=div`;
  const data = await fetchJson(url, d => d && d.chart && d.chart.result && d.chart.result[0]);
  const r = data.chart.result[0];
  const q = r.indicators.quote[0] || {};
  const out = { meta: r.meta || {}, t: [], c: [], o: [], h: [], l: [], v: [] };
  (r.timestamp || []).forEach((ts, i) => {
    const c = q.close ? q.close[i] : null;
    if (c == null || !isFinite(c)) return;
    out.t.push(ts * 1000); out.c.push(c);
    /* Eröffnung: echte, sonst Schluss des Vortags (reale Marktmechanik,
       keine Erfindung). Der erste Tag nimmt seinen eigenen Schluss. */
    const openReal = q.open && isFinite(q.open[i]) ? q.open[i] : null;
    out.o.push(openReal != null ? openReal : (out.c.length > 1 ? out.c[out.c.length - 2] : c));
    out.h.push(q.high && isFinite(q.high[i]) ? q.high[i] : c);
    out.l.push(q.low  && isFinite(q.low[i])  ? q.low[i]  : c);
    out.v.push(q.volume && isFinite(q.volume[i]) ? q.volume[i] : 0);
  });
  if (out.c.length < 30) throw new Error("Zu wenige Kursdaten");
  Cache.set(key, out);
  Fresh.note(Date.now());
  return out;
}

/* ---------- Fundamentaldaten (bestmöglich, mit sanftem Scheitern) ---------- */
/* ---------- Bilanzkennzahlen aus data/fundamentals.json ----------
   Wird von der GitHub Action taeglich befuellt (SEC EDGAR + optional
   Alpha Vantage). Fehlt die Datei oder der Titel, bleiben die Felder leer –
   wie bisher, nur eben oft gefuellt. */
const Fundamentals = {
  data: null,
  prom: null,
  /* Das laufende Versprechen merken, nicht ein Ja/Nein-Kennzeichen.
     Zuvor wurde "geladen" gesetzt, BEVOR der Abruf zurueck war. Rufen mehrere
     Karten gleichzeitig auf - und genau das tun sie -, bekamen alle ausser der
     ersten sofort data = null zurueck, fielen auf Yahoo zurueck und schrieben
     dort ein "none" in den Zwischenspeicher. Ergebnis waren Karten, denen die
     Kennzahlen scheinbar zufaellig fehlten. Gleiches Muster wie bei
     loadBenchmark() weiter unten. */
  load() {
    if (!this.prom) {
      this.prom = fetch("data/fundamentals.json?v=" + Date.now())
        .then(r => r.ok ? r.json() : null)
        .then(j => { this.data = (j && j.data) || {}; return this.data; })
        .catch(() => { this.data = null; return null; });
    }
    return this.prom;
  },
  /* Rohdaten fuer ein Symbol; probiert das Basissymbol ohne Boersenkuerzel */
  get(symbol) {
    if (!this.data) return null;
    const base = String(symbol).split(".")[0].toUpperCase();
    return this.data[base] || null;
  },

  /* Marktkennzahlen in der Form, die loadFundamentals liefert.
     Zwei Einheiten muessen dabei umgerechnet werden, sonst rechnen die Scores
     mit falschen Groessenordnungen:
       - debtToEquity kommt als Verhaeltnis (0,78), die Bewertung erwartet
         Yahoos Prozentskala (78) - siehe lin(...,20,250) weiter unten.
       - recommendation kommt als "Strong Buy", der Rest des Programms liest
         Yahoos Schluessel "strong_buy". */
  async marktKennzahlen(symbol, kursWaehrung) {
    await this.load();
    const e = this.get(symbol);
    const m = e && e.markt;
    if (!m) return null;
    const z = v => (typeof v === "number" && isFinite(v)) ? v : null;

    /* Verhaeltniszahlen (KGV, ROE, Margen, Beta) sind waehrungsneutral und
       gelten fuer jede Notierung desselben Unternehmens. Betragsgroessen sind
       es nicht: die Watchlist fuehrt "SAP", das ist der US-Hinterlegungsschein
       in USD; wer SAP.DE ansieht, sieht EUR. Ein USD-Kursziel neben einem
       EUR-Kurs waere stillschweigend falsch - deshalb hier weglassen, statt
       eine Zahl zu zeigen, der man glauben koennte. */
    const gleicheWaehrung = !kursWaehrung || !m.kursWaehrung
      || String(kursWaehrung).toUpperCase() === String(m.kursWaehrung).toUpperCase();
    const betrag = v => (gleicheWaehrung ? z(v) : null);

    const out = {
      opMargin: z(m.opMargin), profitMargin: z(m.profitMargin),
      roe: z(m.roe), revGrowth: z(m.revGrowth),
      debtToEquity: z(m.debtToEquity) != null ? m.debtToEquity * 100 : null,
      fcf: betrag(m.fcf),
      trailingPE: z(m.trailingPE), forwardPE: z(m.forwardPE),
      divYield: z(m.divYield), marketCap: betrag(m.marketCap),
      peg: z(m.peg), beta: z(m.beta),
      targetMean: betrag(m.targetMean),
      recommendation: m.recommendation
        ? String(m.recommendation).toLowerCase().replace(/\s+/g, "_") : null,
      quelle: m.source || "data/fundamentals.json",
      kursWaehrung: m.kursWaehrung || null,
    };
    return Object.values(out).some(v => v != null && v !== out.quelle) ? out : null;
  },
};

/* Aus SEC-Rohdaten die Dossier-Scores rechnen. Gibt nur zurueck, was die
   Datenlage hergibt; fehlende Bausteine fuehren zu null, nicht zu Schaetzwerten. */
function computeScores(entry, live) {
  if (!entry) return null;
  const s = entry.sec || {};
  const av = entry.av || {};
  const ser = s._series || {};
  const out = { source: entry.sec ? "SEC EDGAR" : (entry.av ? "Alpha Vantage" : null) };
  const num = v => (typeof v === "number" && isFinite(v)) ? v : null;

  /* --- Altman Z-Score (Produktionsunternehmen) ---
     Z = 1,2·A + 1,4·B + 3,3·C + 0,6·D + 1,0·E */
  const ta = num(s.totalAssets), tl = num(s.totalLiabilities);
  const wc = (num(s.currentAssets) != null && num(s.currentLiabilities) != null)
    ? s.currentAssets - s.currentLiabilities : null;
  const re = num(s.retainedEarnings), ebit = num(s.ebit ?? s.operatingIncome);
  const rev = num(s.revenue);
  const mktCap = num(live && live.marketCap);
  if (ta && ta > 0) {
    const A = wc != null ? wc / ta : null;
    const B = re != null ? re / ta : null;
    const C = ebit != null ? ebit / ta : null;
    /* Der Marktwert/Schulden-Term kann bei sehr niedrig verschuldeten, hoch
       bewerteten Titeln (z. B. Tech) die Skala sprengen. In der Praxis wird er
       gedeckelt, damit die 2,99-Schwelle interpretierbar bleibt. */
    let D = (mktCap != null && tl && tl > 0) ? mktCap / tl : null;
    let dCapped = false;
    if (D != null && D > 20) { D = 20; dCapped = true; }
    const E = rev != null ? rev / ta : null;
    if ([A, B, C, E].every(x => x != null)) {
      let z = 1.2 * A + 1.4 * B + 3.3 * C + 1.0 * E;
      if (D != null) z += 0.6 * D;
      out.altmanZ = z;
      out.altmanZone = z > 2.99 ? "sicher" : z > 1.81 ? "grau" : "kritisch";
      out.altmanPartial = D == null;   // ohne Marktwert unvollständig
      out.altmanCapped = dCapped;      // Marktwert-Term gedeckelt (sehr hohe Bewertung)
    }
  }

  /* --- Piotroski F-Score (0–9) --- braucht zwei Jahre ---
     Nur die Kriterien, die die Datenlage erlaubt; sonst maxPossible < 9. */
  const yrs = k => {
    const m = ser[k] || {};
    const keys = Object.keys(m).sort().reverse();
    return { cur: keys[0] ? m[keys[0]] : null, prev: keys[1] ? m[keys[1]] : null };
  };
  const ni = yrs("netIncome"), cfo = yrs("cashFlowOps"), asset = yrs("totalAssets");
  const rvn = yrs("revenue"), gp = yrs("grossProfit"), ltd = yrs("longTermDebt");
  let f = 0, fmax = 0;
  const crit = (cond) => { if (cond != null) { fmax++; if (cond) f++; } };
  crit(ni.cur != null ? ni.cur > 0 : null);                                   // Rentabilität
  crit(cfo.cur != null ? cfo.cur > 0 : null);                                 // operativer CF
  crit((ni.cur != null && ni.prev != null) ? ni.cur > ni.prev : null);        // steigende Rendite
  crit((cfo.cur != null && ni.cur != null) ? cfo.cur > ni.cur : null);        // CF > Gewinn (Qualität)
  crit((ltd.cur != null && ltd.prev != null && asset.cur && asset.prev)
        ? (ltd.cur / asset.cur) < (ltd.prev / asset.prev) : null);            // sinkende Verschuldung
  crit((rvn.cur != null && asset.cur && rvn.prev != null && asset.prev)
        ? (rvn.cur / asset.cur) > (rvn.prev / asset.prev) : null);            // Kapitalumschlag
  crit((gp.cur != null && rvn.cur && gp.prev != null && rvn.prev)
        ? (gp.cur / rvn.cur) > (gp.prev / rvn.prev) : null);                  // steigende Marge
  if (fmax >= 4) { out.piotroski = f; out.piotroskiMax = fmax; }

  /* --- DCF-Näherung ---
     Sehr konservativ: FCF (oder operativer CF) als Basis, feste Annahmen,
     klar als Näherung markiert. Nur wenn operativer CF vorliegt. */
  const cf = num(s.cashFlowOps) ?? num(live && live.fcf);
  const shares = num(s.sharesOutstanding);
  if (cf && cf > 0 && shares && shares > 0) {
    const growth = 0.04, discount = 0.09, years = 10, terminal = 0.025;
    let pv = 0, c = cf;
    for (let y = 1; y <= years; y++) { c *= (1 + growth); pv += c / Math.pow(1 + discount, y); }
    const tv = (c * (1 + terminal)) / (discount - terminal);
    pv += tv / Math.pow(1 + discount, years);
    out.dcfPerShare = pv / shares;
    out.dcfAssumptions = { growth, discount, terminal, years };
  }

  /* Alpha-Vantage-Kennzahlen durchreichen */
  if (av.PriceToBookRatio != null) out.priceToBook = av.PriceToBookRatio;
  if (av.EVToEBITDA != null) out.evEbitda = av.EVToEBITDA;
  if (av.PriceToSalesRatioTTM != null) out.priceToSales = av.PriceToSalesRatioTTM;
  if (av.ReturnOnEquityTTM != null) out.roe = av.ReturnOnEquityTTM;
  if (av.PEGRatio != null) out.peg = av.PEGRatio;

  return out;
}

/* ---------- Marktkennzahlen live, fuer Titel ausserhalb der Watchlist ----------
   Die taegliche Datei deckt nur die Watchlist ab - fuer alles andere gaebe es
   sonst keinen Qualitaets-Score, weil Yahoos quoteSummary seit der Crumb-Pflicht
   ausfaellt. Dieselbe Quelle wie serverseitig, nur ueber den Textleser: der
   liefert die Seite als "Beschriftung<Tab>Wert" je Zeile, rund 6 KB statt 200 KB
   HTML, und spart damit das Zerlegen von Markup im Browser. */
const SA_BOERSEN = {
  DE:"etr", F:"etr", BE:"etr", MU:"etr", SG:"etr", HM:"etr", DU:"etr",
  L:"lon", PA:"epa", AS:"ams", BR:"ebr", LS:"els", MI:"bit", MC:"bme",
  SW:"swx", VI:"vie", ST:"sto", CO:"cph", OL:"osl", HE:"hel", IC:"ice",
  WA:"wse", PR:"pse", AT:"ath", IS:"ist", TO:"tsx", V:"cve", MX:"bmv",
  SA:"bvmf", BA:"bcba", SN:"bcs", T:"tyo", HK:"hkg", SS:"sha", SZ:"she",
  TW:"tpe", KS:"krx", KQ:"krx", SI:"sgx", NS:"nse", BO:"bom", AX:"asx",
  NZ:"nzx", JO:"jse", TA:"tase",
};
const SA_WAEHRUNG = {
  etr:"EUR", epa:"EUR", ams:"EUR", ebr:"EUR", els:"EUR", bit:"EUR", bme:"EUR",
  vie:"EUR", hel:"EUR", ath:"EUR", lon:"GBp", swx:"CHF", sto:"SEK", cph:"DKK",
  osl:"NOK", ice:"ISK", wse:"PLN", pse:"CZK", ist:"TRY", tsx:"CAD", cve:"CAD",
  bmv:"MXN", bvmf:"BRL", bcba:"ARS", bcs:"CLP", tyo:"JPY", hkg:"HKD",
  sha:"CNY", she:"CNY", tpe:"TWD", krx:"KRW", sgx:"SGD", nse:"INR",
  bom:"INR", asx:"AUD", nzx:"NZD", jse:"ZAR", tase:"ILS",
};

function saAdresse(symbol) {
  const sym = String(symbol).trim().toUpperCase();
  if (!sym) return null;
  if (!sym.includes(".")) return { url: `https://stockanalysis.com/stocks/${sym.toLowerCase()}/`, waehrung: "USD" };
  const i = sym.lastIndexOf(".");
  const boerse = SA_BOERSEN[sym.slice(i + 1)];
  if (!boerse) return null;
  return { url: `https://stockanalysis.com/quote/${boerse}/${sym.slice(0, i)}/`,
           waehrung: SA_WAEHRUNG[boerse] || null };
}

/* "27.62%" -> 0.2762 | "136.68B" -> 1.3668e11 | "1,482.93" -> 1482.93 */
function saZahl(t) {
  if (!t) return null;
  const s = String(t).trim();
  if (!s || ["-","--","n/a","N/A","Upgrade"].includes(s)) return null;
  const m = s.match(/^\$?\s*(-?[\d,]+\.?\d*)\s*([KMBT])?\s*(%)?/);
  if (!m) return null;
  let v = parseFloat(m[1].replace(/,/g, ""));
  if (!isFinite(v)) return null;
  if (m[2]) v *= { K:1e3, M:1e6, B:1e9, T:1e12 }[m[2]];
  if (m[3]) v /= 100;
  return v;
}

/* Klartextseite -> { Beschriftung: Wert }. Navigationszeilen haben keinen
   Tabulator und fallen dabei von selbst heraus. */
function saPaare(text) {
  const out = {};
  for (const zeile of String(text).split("\n")) {
    const i = zeile.indexOf("\t");
    if (i <= 0) continue;
    const k = zeile.slice(0, i).trim(), v = zeile.slice(i + 1).trim();
    if (k && v && !(k in out)) out[k] = v;
  }
  return out;
}

async function loadMarktLive(symbol) {
  const ziel = saAdresse(symbol);
  if (!ziel) return null;
  /* Beide Seiten gleichzeitig: die Kennzahlen stehen unter "statistics",
     Kursziel und Analystenurteil nur auf der Uebersicht. */
  const [statText, uebText] = await Promise.all([
    fetchDurch(ziel.url + "statistics/", { alsText: true, timeout: 9000 }).catch(() => null),
    fetchDurch(ziel.url, { alsText: true, timeout: 9000 }).catch(() => null),
  ]);
  if (!statText) return null;
  const st = saPaare(statText);
  if (Object.keys(st).length < 5) return null;      // Fehlerseite statt Titel

  const out = {
    opMargin: saZahl(st["Operating Margin"]),
    profitMargin: saZahl(st["Profit Margin"]),
    roe: saZahl(st["Return on Equity (ROE)"]),
    debtToEquity: saZahl(st["Debt / Equity"]) != null ? saZahl(st["Debt / Equity"]) * 100 : null,
    fcf: saZahl(st["Free Cash Flow"]),
    trailingPE: saZahl(st["PE Ratio"]),
    forwardPE: saZahl(st["Forward PE"]),
    divYield: saZahl(st["Dividend Yield"]),
    marketCap: saZahl(st["Market Cap"]),
    peg: saZahl(st["PEG Ratio"]),
    beta: saZahl(st["Beta (5Y)"]),
    /* zusaetzlich fuer das Dossier */
    pbRatio: saZahl(st["PB Ratio"]),
    psRatio: saZahl(st["PS Ratio"]),
    evEbitda: saZahl(st["EV / EBITDA"]),
    evSales: saZahl(st["EV / Sales"]),
    insiderHold: saZahl(st["Owned by Insiders (%)"]),
    instHold: saZahl(st["Owned by Institutions (%)"]),
    /* Anzahl Anteile: fuer das Bewertungsmodell unverzichtbar und der
       verlaesslichere Wert als der XBRL-Posten, der bei Auslandseinreichern
       oft nur eine Aktiengattung erfasst. */
    sharesOut: saZahl(st["Shares Outstanding"]),
    revGrowth: null, targetMean: null, recommendation: null,
    quelle: "stockanalysis.com (live)",
    kursWaehrung: ziel.waehrung,
  };

  if (uebText) {
    const ue = saPaare(uebText);
    out.targetMean = saZahl(ue["Price Target"]);
    const urteil = (ue["Analysts"] || "").trim();
    if (["Strong Buy","Buy","Hold","Sell","Strong Sell"].includes(urteil))
      out.recommendation = urteil.toLowerCase().replace(/\s+/g, "_");
    /* "466.82B +14.2%" - Betrag und Veraenderung in einer Zelle */
    const m = String(ue["Revenue (ttm)"] || "").match(/([+-][\d.,]+)\s*%/);
    if (m) out.revGrowth = parseFloat(m[1].replace(/,/g, "")) / 100;
  }
  return Object.values(out).some(v => typeof v === "number" && isFinite(v)) ? out : null;
}

async function loadFundamentals(symbol, kursWaehrung) {
  const key = "fund." + symbol + (kursWaehrung ? "." + kursWaehrung : "");
  const cached = Cache.get(key, 12 * 60 * 60 * 1000);
  if (cached) return cached === "none" ? null : cached;

  /* Zuerst die taeglich per GitHub Action gefuellte Datei: kein Netzweg, sofort
     verfuegbar. Der Yahoo-Baustein quoteSummary verlangt seit 2024 ein
     Cookie-und-Crumb-Paar; ueber einen CORS-Zwischenweg ist das grundsaetzlich
     nicht zu erfuellen und endet mit "Invalid Crumb". Ihn zuerst zu versuchen
     hiesse, bei jedem Titel alle Zwischenwege leerlaufen zu lassen. */
  try {
    const lokal = await Fundamentals.marktKennzahlen(symbol, kursWaehrung);
    if (lokal) { Cache.set(key, lokal); return lokal; }
  } catch (e) { /* Datei fehlt oder ist unlesbar -> Yahoo versuchen */ }

  /* Zweitens live nachladen. Das deckt die Titel ab, die nicht auf der
     Watchlist stehen - also den weit groesseren Teil der Datenbank. Ohne
     diesen Schritt bliebe der Qualitaets-Score dort dauerhaft leer, weil
     der Yahoo-Weg darunter seit der Crumb-Pflicht nicht mehr traegt. */
  try {
    const live = await loadMarktLive(symbol);
    if (live) {
      /* Betragsgroessen nur uebernehmen, wenn die Waehrung zur Notierung
         passt - dieselbe Regel wie bei den Daten aus der Datei. */
      if (kursWaehrung && live.kursWaehrung &&
          String(kursWaehrung).toUpperCase() !== String(live.kursWaehrung).toUpperCase()) {
        live.targetMean = null; live.marketCap = null; live.fcf = null;
      }
      Cache.set(key, live);
      return live;
    }
  } catch (e) { /* weiter zu Yahoo */ }

  /* Frueher folgte hier ein Rueckfall auf Yahoos quoteSummary. Der ist ersatzlos
     entfallen: Der Baustein verlangt ein Cookie-und-Crumb-Paar, das ein
     CORS-Zwischenweg prinzipiell nicht mitliefern kann - die Antwort lautet
     ausnahmslos {"error":{"code":"Unauthorized","description":"Invalid Crumb"}}.
     Er konnte also nie etwas beitragen, kostete aber bei jedem nicht
     auffindbaren Titel zwei Hosts mal fuenf Zwischenwege an Wartezeit, bevor
     die Karte aufgab. Jetzt steht das Ergebnis sofort fest. */
  Cache.set(key, "none");
  return null;
}

/* ---------- Benchmark (MSCI-ACWI-ETF) für Relative Stärke ---------- */
/* Verfolgt, wie alt die ältesten angezeigten Kursdaten sind */
const Fresh = {
  oldest: null,
  note(ts) { if (ts && (this.oldest == null || ts < this.oldest)) this.oldest = ts; },
  reset() { this.oldest = null; },
};

let benchProm = null;
function loadBenchmark() {
  if (!benchProm) benchProm = loadChart("ACWI", "1y").catch(() => null);
  return benchProm;
}

/* ---------- Indikatoren ---------- */
function sma(arr, n) { if (arr.length < n) return null; let s = 0; for (let i = arr.length - n; i < arr.length; i++) s += arr[i]; return s / n; }
function rsi14(closes) {
  const n = 14;
  if (closes.length < n + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= n; i++) { const d = closes[i] - closes[i-1]; if (d > 0) g += d; else l -= d; }
  let ag = g / n, al = l / n;
  for (let i = n + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (n-1) + Math.max(d,0)) / n;
    al = (al * (n-1) + Math.max(-d,0)) / n;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function retOver(closes, days) {
  if (closes.length <= days) return null;
  const a = closes[closes.length - 1 - days], b = closes[closes.length - 1];
  return a > 0 ? b / a - 1 : null;
}
function pivots(chart, lookback = 140, w = 4) {
  const n = chart.c.length, from = Math.max(w, n - lookback);
  const highs = [], lows = [];
  for (let i = from; i < n - w; i++) {
    let isH = true, isL = true;
    for (let j = i - w; j <= i + w; j++) {
      if (chart.h[j] > chart.h[i]) isH = false;
      if (chart.l[j] < chart.l[i]) isL = false;
    }
    if (isH) highs.push(chart.h[i]);
    if (isL) lows.push(chart.l[i]);
  }
  return { highs, lows };
}

/* ---------- Analyse: Scores + Zonen ---------- */
function analyse(chart, fund, bench) {
  const c = chart.c, price = c[c.length - 1];
  const s50 = sma(c, 50), s200 = sma(c, 200);
  const rsi = rsi14(c.slice(-260));
  const r63 = retOver(c, 63), r126 = retOver(c, 126);
  const prevClose = chart.meta.chartPreviousClose ?? c[c.length - 2];
  const dayChg = prevClose ? price / prevClose - 1 : null;
  const wk = c.slice(-252);
  const hi52 = Math.max(...wk, ...chart.h.slice(-252));
  const lo52 = Math.min(...wk, ...chart.l.slice(-252));
  const vol20 = sma(chart.v, 20), vol60 = sma(chart.v, 60);

  let rel = null;
  if (bench && r63 != null) {
    const br = retOver(bench.c, 63);
    if (br != null) rel = r63 - br;
  }

  /* --- Timing-Score --- */
  const trendUp = s200 != null && price > s200 && (s50 == null || s50 > s200 * 0.985);
  let trendComp = 0;
  if (s200 != null) { if (price > s200) trendComp += 40; if (s50 != null && price > s50) trendComp += 30; if (s50 != null && s50 > s200) trendComp += 30; }
  else trendComp = price > (s50 ?? price) ? 60 : 30;
  const comps = {
    "Trend (GD 50/200)":            { v: trendComp, w: .30 },
    "Momentum (6 Mon.)":            { v: lin(r126, -0.30, 0.40), w: .25 },
    "RSI-Lage":                     { v: rsi == null ? null : clamp(100 - Math.abs(rsi - 55) * 2.4, 0, 100), w: .15 },
    "Relative Stärke vs. Welt-Index": { v: rel == null ? null : lin(rel, -0.15, 0.15), w: .20 },
    "Volumen-Trend":                { v: vol60 ? lin(vol20 / vol60, 0.7, 1.4) : null, w: .10 },
  };
  let tw = 0, ts = 0;
  for (const k in comps) { const x = comps[k]; if (x.v != null) { ts += x.v * x.w; tw += x.w; } }
  const timing = tw > 0 ? Math.round(ts / tw) : null;

  /* --- Qualitäts-Score --- */
  let quality = null, qcomps = null;
  if (fund) {
    qcomps = {
      "Operative Marge":   fund.opMargin  != null ? lin(fund.opMargin, 0, 0.30) : null,
      "Eigenkapitalrendite": fund.roe     != null ? lin(fund.roe, 0, 0.30) : null,
      "Umsatzwachstum":    fund.revGrowth != null ? lin(fund.revGrowth, -0.05, 0.25) : null,
      "Verschuldung":      fund.debtToEquity != null ? 100 - lin(fund.debtToEquity, 20, 250) : null,
      "FCF-Rendite":       (fund.fcf != null && fund.marketCap) ? lin(fund.fcf / fund.marketCap, 0, 0.08) : null,
      "Bewertung (KGVe)":  fund.forwardPE != null ? (fund.forwardPE <= 0 ? 20 : 100 - lin(fund.forwardPE, 9, 48)) : null,
    };
    const vals = Object.values(qcomps).filter(v => v != null);
    if (vals.length >= 3) quality = Math.round(vals.reduce((a,b) => a+b, 0) / vals.length);
  }

  /* --- Ampel --- */
  let ampel = "y";
  if (timing != null) {
    if (timing >= 65 && (quality == null ? trendUp : quality >= 55)) ampel = "g";
    else if (timing < 40 || (quality != null && quality < 35)) ampel = "r";
  } else ampel = "n";

  /* --- Zonen --- */
  const pv = pivots(chart);
  const support = Math.max(...pv.lows.filter(x => x < price * 0.995), -Infinity);
  const resistance = Math.min(...pv.highs.filter(x => x > price * 1.005), Infinity);
  const belowCands = [support, s50, s200].filter(x => x != null && isFinite(x) && x < price * 0.995);
  const zoneFloor = belowCands.length ? Math.max(...belowCands) : lo52;
  const entryLow = zoneFloor, entryHigh = Math.min(price, zoneFloor * 1.035);
  const stop = zoneFloor * 0.955;
  const t1 = isFinite(resistance) ? resistance : hi52;
  const t2 = Math.max(hi52, t1 * 1.06);
  const mid = (entryLow + entryHigh) / 2;
  const crv = (mid > stop && t1 > mid) ? (t1 - mid) / (mid - stop) : null;

  return { price, dayChg, s50, s200, rsi, r63, r126, rel, hi52, lo52,
           timing, comps, quality, qcomps, ampel, trendUp,
           zones: { stop, entryLow, entryHigh, t1, t2, support: isFinite(support) ? support : null,
                    resistance: isFinite(resistance) ? resistance : null, crv } };
}

/* ---------- Newsfeed --------------------------------------------------------
   Daten stammen aus data/news.json, das eine GitHub Action stuendlich
   serverseitig aus RSS-Feeds erzeugt. Dadurch keine CORS-Proxys noetig und
   unabhaengig von der Kursdatenquelle. Angezeigt werden ausschliesslich
   Ueberschrift, Quelle, Zeitpunkt und Link - keine Artikeltexte.
--------------------------------------------------------------------------- */
/* ---------- Aktualisieren, Frische-Anzeige, Auto-Takt --------------------- */
const AUTO_STEPS = [0, 5, 15, 30];   // Minuten; 0 = aus
const Refresh = { busy: false, autoMin: 0, timer: null, lastRun: Date.now() };

function freshText() {
  const box = $("#freshness");
  if (!box) return;
  if (!Favs.list().length) { box.textContent = ""; return; }
  if (Fresh.oldest == null) { box.innerHTML = "Kursdaten <b>werden geladen</b>"; box.classList.remove("stale"); return; }
  const min = Math.floor((Date.now() - Fresh.oldest) / 60000);
  const txt = min < 1 ? "gerade eben" : min < 60 ? "vor " + min + " Min" : "vor " + Math.floor(min / 60) + " Std";
  box.innerHTML = "Kursdaten <b>" + txt + "</b>";
  box.classList.toggle("stale", min >= 15);
}

/* Erneuerung: Zwischenspeicher leeren und alles neu holen */
async function doRefresh(full) {
  if (Refresh.busy) return;
  Refresh.busy = true;
  const btn = $("#refreshbtn");
  if (btn) { btn.classList.add("busy"); btn.disabled = true; }
  try {
    if (full) Cache.clear();                       // alles, inkl. Kennzahlen
    else { Cache.clear("chart."); Cache.clear("fx."); }
    analysisCache.clear();
    benchProm = null;
    if (full) FX.rates = {};
    Fresh.reset();
    freshText();
    renderFavs();
    if (typeof renderDepot === "function") renderDepot();
    await loadNews();
    Refresh.lastRun = Date.now();
  } finally {
    Refresh.busy = false;
    if (btn) { btn.classList.remove("busy"); btn.disabled = false; }
    setTimeout(freshText, 1200);
  }
}

function autoLabel() {
  const b = $("#autoref");
  if (!b) return;
  b.textContent = Refresh.autoMin ? "Auto: " + Refresh.autoMin + " Min" : "Auto: aus";
  b.classList.toggle("on", Refresh.autoMin > 0);
  b.title = Refresh.autoMin
    ? "Aktualisiert automatisch alle " + Refresh.autoMin + " Minuten, solange dieser Tab sichtbar ist"
    : "Automatische Aktualisierung ist ausgeschaltet";
}

function autoArm() {
  clearInterval(Refresh.timer);
  if (!Refresh.autoMin) return;
  Refresh.timer = setInterval(() => {
    if (document.visibilityState !== "visible") return;   // im Hintergrund keine Last erzeugen
    doRefresh(false);
  }, Refresh.autoMin * 60000);
}

function initRefresh() {
  try { Refresh.autoMin = parseInt(localStorage.getItem("ak.auto") || "0", 10) || 0; } catch (e) {}
  autoLabel(); autoArm();
  const btn = $("#refreshbtn");
  if (btn) btn.onclick = () => doRefresh(true);
  const auto = $("#autoref");
  if (auto) auto.onclick = () => {
    const i = AUTO_STEPS.indexOf(Refresh.autoMin);
    Refresh.autoMin = AUTO_STEPS[(i + 1) % AUTO_STEPS.length];
    try { localStorage.setItem("ak.auto", String(Refresh.autoMin)); } catch (e) {}
    autoLabel(); autoArm();
  };
  /* Bei Rückkehr auf den Tab nachziehen, wenn der Takt überfällig ist */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible" || !Refresh.autoMin) return;
    if (Date.now() - Refresh.lastRun >= Refresh.autoMin * 60000) doRefresh(false);
  });
  setInterval(freshText, 30000);
  freshText();
}

const News = {
  data: null, cat: "alle", favOnly: false, shown: 12, loaded: false,
  CATS: [["alle","Alle"],["zentralbank","Zentralbanken"],["konjunktur","Konjunktur"],
         ["maerkte","Märkte"],["unternehmen","Unternehmen"],["rohstoffe","Rohstoffe"]],
};

/* Suchbegriffe aus den Favoriten ableiten (zu kurze/generische werden verworfen) */
const NEWS_STOP = new Set(["the","inc","corp","corporation","company","group","holding","holdings",
  "plc","ag","se","sa","nv","co","ltd","limited","international","technologies","technology"]);
function newsFavTerms() {
  const terms = [];
  for (const f of Favs.list()) {
    const base = (f.s || "").split(".")[0].replace(/[^A-Za-z0-9]/g, "");
    if (base.length >= 3 && /[A-Za-z]/.test(base)) terms.push({ q: base.toLowerCase(), sym: f.s });
    for (const w of String(f.n || "").split(/[\s,\.]+/)) {
      const c = w.replace(/[^A-Za-zÀ-ÿ0-9&]/g, "").toLowerCase();
      if (c.length >= 4 && !NEWS_STOP.has(c)) { terms.push({ q: c, sym: f.s }); break; }
    }
  }
  return terms;
}
function newsHit(title, terms) {
  const low = " " + title.toLowerCase().replace(/[^\wÀ-ÿ&]+/g, " ") + " ";
  for (const t of terms) if (low.includes(" " + t.q + " ")) return t.sym;
  return null;
}

function newsAgo(ts) {
  if (!ts) return "–";
  const m = Math.round((Date.now() / 1000 - ts) / 60);
  if (m < 1) return "jetzt";
  if (m < 60) return m + " Min";
  const hrs = Math.round(m / 60);
  if (hrs < 24) return hrs + " Std";
  return Math.round(hrs / 24) + " Tg";
}

async function loadNews() {
  const list = $("#newslist"), meta = $("#newsmeta");
  try {
    const bust = Math.floor(Date.now() / (5 * 60 * 1000));
    const res = await fetch("data/news.json?v=" + bust, { cache: "no-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const d = await res.json();
    if (!d || !Array.isArray(d.items)) throw new Error("Format");
    News.data = d; News.loaded = true;
    renderNews();
  } catch (e) {
    meta.textContent = "";
    list.innerHTML = `<div class="nb-note"><b>Noch keine Nachrichten vorhanden.</b><br>
      Die Datei <code>data/news.json</code> wird von der GitHub Action „Nachrichten aktualisieren“ erzeugt.
      Starte sie einmalig im Reiter <b>Actions</b> über <b>Run workflow</b> – danach läuft sie stündlich von allein.</div>`;
    $("#newsmore").hidden = true;
  }
}

function renderNews() {
  const d = News.data;
  if (!d) return;
  const terms = newsFavTerms();
  const chips = $("#newschips"), list = $("#newslist"), meta = $("#newsmeta");

  /* Meldungen filtern */
  let items = d.items.map(i => ({ ...i, hit: newsHit(i.t, terms) }));
  const favCount = items.filter(i => i.hit).length;
  if (News.favOnly) items = items.filter(i => i.hit);
  if (News.cat !== "alle") items = items.filter(i => i.c === News.cat);

  /* Filterleiste */
  chips.innerHTML = "";
  for (const [key, label] of News.CATS) {
    const n = key === "alle" ? d.items.length : d.items.filter(i => i.c === key).length;
    if (n === 0 && key !== "alle") continue;
    const b = el("button", "nb-chip" + (News.cat === key && !News.favOnly ? " on" : ""),
                 `${label}<small>${n}</small>`);
    b.onclick = () => { News.cat = key; News.favOnly = false; News.shown = 12; renderNews(); };
    chips.append(b);
  }
  if (terms.length) {
    const b = el("button", "nb-chip fav" + (News.favOnly ? " on" : ""), `Meine Favoriten<small>${favCount}</small>`);
    b.onclick = () => { News.favOnly = !News.favOnly; News.cat = "alle"; News.shown = 12; renderNews(); };
    chips.append(b);
  }

  /* Liste */
  const slice = items.slice(0, News.shown);
  if (!slice.length) {
    list.innerHTML = `<div class="nb-note">${News.favOnly
      ? "Zu deinen Favoriten gibt es in den aktuellen Meldungen gerade nichts. Der Abgleich läuft über Firmenname und Ticker in der Überschrift."
      : "Keine Meldungen in dieser Kategorie."}</div>`;
  } else {
    list.innerHTML = slice.map(i => `<a class="nb-item${i.hit ? " hit" : ""}" href="${esc(i.u)}" target="_blank" rel="noopener noreferrer">
        <span class="nb-t">${esc(i.t)}</span>
        <span class="nb-badge">${esc(i.s)}</span>
        <span class="nb-time">${newsAgo(i.d)}</span></a>`).join("");
  }
  const more = $("#newsmore");
  more.hidden = items.length <= News.shown;
  more.textContent = `Weitere Meldungen (${Math.max(0, items.length - News.shown)})`;

  /* Kopfzeile und Quellenstatus */
  const ok = (d.sources || []).filter(s => s.ok);
  meta.innerHTML = `Stand <b>vor ${newsAgo(d.generated)}</b> · ${d.items.length} Meldungen aus ${ok.length} Quellen`;
  const failed = (d.sources || []).filter(s => !s.ok).map(s => s.n);
  $("#newssrc").innerHTML = ok.length
    ? `Quellen: ${ok.map(s => esc(s.n)).join(" · ")}${failed.length ? `<br>Nicht erreichbar: ${failed.map(esc).join(" · ")}` : ""}`
    : "";
}

function initNews() {
  const body = $("#newsbody"), tgl = $("#newstoggle");
  let open = true;
  try { open = localStorage.getItem("ak.news.open") !== "0"; } catch (e) {}
  const paint = () => { body.style.display = open ? "" : "none"; tgl.textContent = open ? "Einklappen" : "Ausklappen"; };
  paint();
  tgl.onclick = () => { open = !open; try { localStorage.setItem("ak.news.open", open ? "1" : "0"); } catch (e) {} paint(); };
  $("#newsmore").onclick = () => { News.shown += 15; renderNews(); };
  loadNews();
}

/* ---------- Kennzahl-Erklaerungen ------------------------------------------
   Ein kleines i neben schwer verstaendlichen Groessen. Beim Ueberfahren mit der
   Maus erscheint ein Kaestchen, beim Wegbewegen verschwindet es wieder; ein
   Klick haelt es fest, damit es auf Tastatur und Fingerbedienung ebenfalls
   funktioniert - dort gibt es kein "Ueberfahren".

   Die Texte erklaeren, WAS die Zahl misst und WIE man sie liest, nicht was man
   kaufen soll. Wo eine uebliche Spanne hilft, steht sie dabei - immer als
   Anhaltspunkt, nie als Regel. */
const INFO = {
  crv: ["Chance/Risiko-Verhältnis (C/R)",
    "Wie viel Kursgewinn bis Ziel 1 auf einen Euro Risiko bis zum Stop kommt. 3,0 heißt: drei Euro mögliche Bewegung nach oben je Euro, den du bei Erreichen des Stops verlierst.\n\nGerechnet ab der Mitte der Einstiegszone, nicht ab dem aktuellen Kurs. Viele Anleger sehen etwa 2,0 als Untergrenze. Die Zahl sagt nichts über die Wahrscheinlichkeit – ein hohes Verhältnis mit sehr unwahrscheinlichem Ziel bleibt eine schlechte Idee."],
  rsi: ["RSI (14)",
    "Relative-Stärke-Index über 14 Tage, Skala 0 bis 100. Er setzt die Aufwärts- gegen die Abwärtsbewegungen der letzten Tage.\n\nÜber 70 gilt herkömmlich als überkauft, unter 30 als überverkauft. Vorsicht: In starken Trends bleibt der RSI wochenlang im Extrem – „überkauft“ heißt nicht „fällt gleich“."],
  gd: ["Gleitende Durchschnitte (GD 50 / GD 200)",
    "Der Mittelwert der Schlusskurse der letzten 50 bzw. 200 Handelstage. Sie glätten das Rauschen und zeigen die Richtung.\n\nKurs über dem GD 200 gilt weithin als Aufwärtstrend, darunter als Abwärtstrend. Der GD 50 reagiert schneller, dreht aber auch öfter falsch."],
  relstaerke: ["Relative Stärke",
    "Die eigene Kursentwicklung im Vergleich zum Welt-Index über denselben Zeitraum. +8 % bedeutet: acht Prozentpunkte besser als der Index.\n\nMisst nicht, ob der Titel gestiegen ist, sondern ob er sich besser gehalten hat als der Markt – in fallenden Märkten kann das auch ein kleineres Minus sein."],
  beta: ["Beta",
    "Wie stark der Kurs auf Marktbewegungen ausschlägt. 1,0 heißt: bewegt sich im Gleichschritt mit dem Markt. 1,5 heißt: schwankt rund 50 % stärker, in beide Richtungen. Unter 1,0 ruhiger als der Markt.\n\nBeta misst Schwankung, nicht Qualität – ein niedriges Beta macht ein schlechtes Unternehmen nicht sicher."],
  sharpe: ["Sharpe Ratio",
    "Rendite je Einheit Schwankung: Wie viel Ertrag hat das eingegangene Auf und Ab gebracht?\n\nÜber 1,0 gilt als ordentlich, über 2,0 als sehr gut, negativ heißt: die Schwankung hat sich nicht ausgezahlt. Der Haken: Sharpe bestraft Ausschläge nach oben genauso wie nach unten – dafür gibt es Sortino."],
  sortino: ["Sortino Ratio",
    "Wie Sharpe, aber es zählen nur die Ausschläge nach unten. Aufwärtsschwankungen stören einen Anleger schließlich nicht.\n\nDeshalb meist höher als Sharpe. Ein großer Abstand zwischen beiden heißt: Die Schwankung entstand überwiegend nach oben."],
  var: ["Value at Risk 95 % (1 Tag)",
    "Der Verlust, der an 19 von 20 Handelstagen nicht überschritten wird. −2,4 % heißt: An etwa einem Tag im Monat war das Minus größer.\n\nWichtig: Die Kennzahl sagt nichts darüber, WIE viel größer. Genau das beantwortet der CVaR."],
  cvar: ["CVaR 95 % (1 Tag)",
    "Der durchschnittliche Verlust an genau den schlechten Tagen, die der Value at Risk nicht mehr abdeckt – also das Mittel der schlimmsten fünf Prozent.\n\nAussagekräftiger als der VaR, weil er die Ausreißer nicht abschneidet, sondern misst."],
  drawdown: ["Maximaler Drawdown",
    "Der größte Rückgang vom Höchststand bis zum darauffolgenden Tief im betrachteten Zeitraum.\n\nBeantwortet die Frage: Wie schmerzhaft war es im schlimmsten Fall, dabeizubleiben? −55 % heißt, aus 10.000 € wurden zwischenzeitlich 4.500 €."],
  kgv: ["KGV – Kurs-Gewinn-Verhältnis",
    "Der Kurs geteilt durch den Gewinn je Aktie. 20 heißt: Du zahlst das Zwanzigfache eines Jahresgewinns.\n\nNur innerhalb derselben Branche vergleichbar. Wachstumswerte tragen dauerhaft höhere KGV, zyklische Werte zeigen ausgerechnet am Hochpunkt niedrige – dort ist ein tiefes KGV eher Warnung als Schnäppchen."],
  kgve: ["KGV erwartet (Forward-KGV)",
    "Wie das KGV, aber mit dem für das kommende Jahr GESCHÄTZTEN Gewinn.\n\nDeshalb meist niedriger als das aktuelle KGV – es beruht auf Analystenschätzungen, die sich irren können und in Abschwüngen typischerweise zu optimistisch sind."],
  peg: ["PEG-Ratio",
    "Das KGV geteilt durch das erwartete Gewinnwachstum in Prozent. Setzt den Preis ins Verhältnis zum Wachstum.\n\nUnter 1,0 gilt herkömmlich als günstig bewertet. Steht und fällt mit der Wachstumsschätzung – bei schwankendem Gewinn ist die Zahl kaum brauchbar."],
  kbv: ["KBV – Kurs-Buchwert-Verhältnis",
    "Der Kurs geteilt durch das bilanzielle Eigenkapital je Aktie. Unter 1,0 heißt: Die Börse bewertet das Unternehmen unter seinem Buchwert.\n\nAussagekräftig bei Banken und Industrie. Bei Software oder Marken kaum – deren Wert steht gar nicht in der Bilanz."],
  kuv: ["KUV – Kurs-Umsatz-Verhältnis",
    "Der Kurs geteilt durch den Umsatz je Aktie. Nützlich, wenn ein Unternehmen noch keinen Gewinn schreibt.\n\nBlendet aus, ob vom Umsatz etwas übrig bleibt – ein niedriges KUV bei dauerhaften Verlusten ist kein Argument."],
  evebitda: ["EV/EBITDA",
    "Unternehmenswert (Börsenwert plus Nettoschulden) geteilt durch den operativen Gewinn vor Abschreibungen.\n\nFairer als das KGV, weil Schulden mitzählen und Steuer- sowie Abschreibungsunterschiede herausfallen. Deshalb bei Übernahmen die übliche Größe."],
  roe: ["Eigenkapitalrendite (ROE)",
    "Gewinn im Verhältnis zum eingesetzten Eigenkapital. 20 % heißt: Je 100 € Eigenkapital entstehen 20 € Gewinn im Jahr.\n\nHoch ist gut – aber Vorsicht: Viele Schulden treiben die Kennzahl nach oben, ohne dass das Geschäft besser wird. Immer zusammen mit der Verschuldung lesen."],
  opmarge: ["Operative Marge",
    "Wie viel vom Umsatz nach den laufenden Kosten übrig bleibt, vor Zinsen und Steuern. 25 % heißt: 25 Cent je Euro Umsatz.\n\nEin guter Hinweis auf Preissetzungsmacht. Nur innerhalb einer Branche vergleichbar – Handel arbeitet naturgemäß mit dünnen Margen."],
  de: ["Verschuldung (Debt/Equity)",
    "Schulden im Verhältnis zum Eigenkapital. 50 heißt: 50 € Schulden je 100 € Eigenkapital.\n\nUnter 100 gilt breit als solide, über 200 als hoch. Versorger und Immobilien tragen üblicherweise mehr, Softwarehäuser fast nichts."],
  fcfrendite: ["FCF-Rendite",
    "Freier Cashflow im Verhältnis zum Börsenwert – die Verzinsung, die das Unternehmen aus eigener Kraft erwirtschaftet.\n\nSchwerer zu beschönigen als der Gewinn, weil tatsächlich geflossenes Geld gemessen wird. 5 % und mehr gelten als ordentlich."],
  altman: ["Altman Z-Score",
    "Ein Frühwarnwert für Zahlungsschwierigkeiten, aus fünf Bilanzkennzahlen.\n\nÜber 2,99 gilt als sicher, unter 1,81 als gefährdet, dazwischen als Graubereich. Entwickelt für Industriebetriebe – bei Banken und Softwarehäusern kaum aussagekräftig."],
  piotroski: ["Piotroski F-Score",
    "Neun Ja/Nein-Prüfungen zu Ertragskraft, Verschuldung und Effizienz, je ein Punkt.\n\n8 bis 9 heißt: Die Bilanz hat sich auf breiter Front verbessert. Unter 3 ist ein Warnsignal. Misst die Veränderung zum Vorjahr, nicht die absolute Qualität."],
  timing: ["Timing-Score",
    "Fasst Trend, RSI, relative Stärke und Volumen zu einem Wert von 0 bis 100 zusammen – die Frage lautet: Läuft es gerade?\n\nSagt nichts über die Qualität des Unternehmens. Ein hoher Timing-Score bei schwacher Bilanz ist ein Momentum-Trade, keine Beteiligung."],
  qualitaet: ["Qualitäts-Score",
    "Fasst Margen, Eigenkapitalrendite, Wachstum, Verschuldung, Cashflow und Bewertung zu einem Wert von 0 bis 100 zusammen – die Frage lautet: gutes Unternehmen zu vernünftigem Preis?\n\nBraucht mindestens drei der sechs Bausteine, sonst bleibt er leer."],
  zonenbasis: ["Zonenbasis",
    "Die nächste Unterstützung UNTERHALB des Kurses – je nachdem welche am höchsten liegt: ein vorheriges Kurstief, der GD 50 oder der GD 200.\n\nSie wandert mit dem Kurs mit. Ein Titel kann deshalb nie unter seiner eigenen Einstiegszone stehen; aussagekräftig ist der Abstand dorthin."],
  einstiegszone: ["Einstiegszone",
    "Der Bereich zwischen der Zonenbasis und rund 3,5 % darüber – dort, wo ein Rücklauf auf Unterstützung trifft.\n\nKeine Kaufempfehlung, sondern eine Beobachtungsspanne. Ob die Unterstützung hält, weiß man erst danach."],
  stop: ["Stop-Idee",
    "Ein Kurs knapp unter der Zonenbasis (rund 4,5 %), an dem die Annahme als widerlegt gälte.\n\nEin Vorschlag zur Orientierung, kein gesetzter Auftrag. Zu eng gesetzt wird man vom normalen Rauschen ausgestoppt."],
  ziel: ["Ziel 1 und Ziel 2",
    "Ziel 1 ist der nächste nennenswerte Widerstand über dem Kurs – dort stockte die Bewegung zuletzt. Ziel 2 liegt darüber, meist am 52-Wochen-Hoch.\n\nMarken aus dem Kursverlauf, keine Prognose."],
  atr: ["ATR (14)",
    "Durchschnittliche Tagesspanne der letzten 14 Tage – wie weit sich der Kurs an einem gewöhnlichen Tag bewegt.\n\nNützlich für den Abstand des Stops: Wer enger setzt als eine ATR, wird mit hoher Wahrscheinlichkeit vom normalen Rauschen erwischt."],
  macd: ["MACD",
    "Der Abstand zweier gleitender Durchschnitte plus eine Signallinie. Kreuzt der MACD die Signallinie nach oben, gilt das als Hinweis auf drehendes Momentum.\n\nWie alle gleitenden Verfahren reagiert er verzögert und liefert in Seitwärtsphasen viele Fehlsignale."],
  bollinger: ["Bollinger %B",
    "Wo der Kurs innerhalb des Bollinger-Bandes steht: 0 heißt am unteren Band, 1 am oberen, 0,5 in der Mitte.\n\nÜber 1 oder unter 0 heißt: außerhalb des Bandes – in Trends durchaus normal, kein Signal für sich."],
  korrelation: ["Korrelation zum Welt-Index",
    "Wie im Gleichschritt sich der Titel mit dem Weltmarkt bewegt. 1,0 heißt völlig gleichläufig, 0 kein Zusammenhang, negativ gegenläufig.\n\nEntscheidend für Streuung: Zehn Titel mit Korrelation 0,9 sind kaum breiter aufgestellt als einer."],
  pos52: ["52-Wochen-Position",
    "Wo der Kurs zwischen dem Tief und dem Hoch der letzten 52 Wochen steht. 0 % heißt am Jahrestief, 100 % am Jahreshoch.\n\nEinordnung, kein Signal – nahe am Hoch heißt sowohl „starker Trend“ als auch „wenig Luft nach oben“, je nach Lesart."],
  analystenziel: ["Analysten-Kursziel Ø",
    "Der Mittelwert der Kursziele der beobachtenden Analysten, meist auf zwölf Monate.\n\nMit Abstand zu lesen: Kursziele werden oft dem Kurs nachgezogen statt ihm voraus, und Verkaufsempfehlungen sind selten."],
  dividendenrendite: ["Dividendenrendite",
    "Die Dividende der letzten zwölf Monate im Verhältnis zum aktuellen Kurs.\n\nEine hohe Rendite entsteht auch dadurch, dass der Kurs gefallen ist – prüfe, ob die Ausschüttung aus dem freien Cashflow gedeckt ist."],
  chancenpunkte: ["Bewertung im Chancenraum",
    "Ein Wert von 0 bis 100 aus zwei Teilen: Nähe des Kurses zur Zonenbasis (60 %) und Luft bis Ziel 1 (40 %).\n\nDie Nähe wiegt schwerer, weil sie das eigentliche Kriterium ist – ein weit entferntes Ziel kann jeder gefallene Titel vorweisen."],
  nettomarge: ["Nettomarge",
    "Was vom Umsatz ganz unten übrig bleibt – nach Kosten, Zinsen und Steuern. 15 % heißt: 15 Cent Gewinn je Euro Umsatz.\n\nEmpfindlicher als die operative Marge, weil Sondereffekte und Steuerthemen durchschlagen. Für den Vergleich über Jahre deshalb beide ansehen."],
  bruttomarge: ["Bruttomarge",
    "Umsatz abzüglich der direkten Herstellungskosten, in Prozent vom Umsatz.\n\nZeigt, wie viel Spielraum für Forschung, Vertrieb und Verwaltung bleibt. Softwarehäuser erreichen oft über 70 %, Handel und Industrie deutlich weniger – ein Vergleich lohnt nur innerhalb einer Branche."],
  umsatzwachstum: ["Umsatzwachstum",
    "Veränderung des Umsatzes gegenüber dem Vorjahreszeitraum.\n\nWachstum aus eigener Kraft ist mehr wert als zugekauftes – die Kennzahl unterscheidet das nicht. Bei Auslandsumsätzen steckt außerdem der Wechselkurs mit drin."],
  fcf: ["Freier Cashflow",
    "Das Geld, das nach laufendem Betrieb und Investitionen tatsächlich übrig bleibt – für Dividenden, Schuldentilgung oder Rückkäufe.\n\nSchwerer zu beschönigen als der Gewinn, weil es um geflossenes Geld geht und nicht um Buchungen. Dauerhaft negativ bei einem reifen Unternehmen ist ein Warnsignal."],
  marktkap: ["Marktkapitalisierung",
    "Der Börsenwert des Unternehmens: Kurs mal Anzahl aller Aktien.\n\nNicht mit dem Unternehmenswert verwechseln – der zählt die Schulden hinzu und die Barmittel ab. Bei hoch verschuldeten Firmen klaffen beide weit auseinander."],
  dcfwert: ["DCF fairer Wert (Näherung)",
    "Der Barwert der geschätzten künftigen Cashflows, geteilt durch die Anzahl der Aktien – was das Unternehmen wert wäre, wenn die Annahmen zuträfen.\n\nEine Modellrechnung, keine Messung: Diskontsatz und ewiges Wachstum bestimmen das Ergebnis maßgeblich. Ein halber Prozentpunkt mehr Zins verschiebt den Wert erheblich. Als Bandbreite lesen, nie als Zahl."],
  instbesitz: ["Institutioneller Besitz",
    "Anteil der Aktien in der Hand von Fonds, Versicherern und Pensionskassen.\n\nHoch heißt: breit analysiert und beobachtet – Überraschungen sind seltener, aber auch der Informationsvorsprung. Bei Verkaufswellen verstärkt ein hoher Anteil die Bewegung."],
  insiderbesitz: ["Insider-Besitz",
    "Anteil der Aktien, den Vorstand, Aufsichtsrat und Gründer selbst halten.\n\nEin nennenswerter Eigenanteil gilt als Hinweis auf gleichgerichtete Interessen. Sehr hohe Anteile können umgekehrt bedeuten, dass Minderheitsaktionäre wenig Einfluss haben."],
  volatilitaet: ["Volatilität (annualisiert)",
    "Wie stark der Kurs schwankt, hochgerechnet auf ein Jahr. 30 % heißt grob: In zwei von drei Jahren bleibt die Jahresrendite innerhalb von plus/minus 30 Prozentpunkten um ihren Mittelwert.\n\nMisst Schwankung in beide Richtungen – nicht dasselbe wie Verlustrisiko."],
  empfehlung: ["Analystenempfehlung",
    "Das zusammengefasste Urteil der beobachtenden Analysten, von „Strong Buy“ bis „Strong Sell“.\n\nMit Abstand zu lesen: Verkaufsempfehlungen sind selten, und das Urteil folgt dem Kurs oft mehr, als es ihm vorausgeht."],
  vergleichsindex: ["Vergleich mit dem Welt-Index",
    "Deine Beträge zu deinen Kaufzeitpunkten, angelegt im Welt-Index statt in deinen Titeln – verglichen werden die beiden Endwerte.\n\nDadurch unabhängig davon, wie lange und wie gestaffelt du gekauft hast. Braucht ein „gehalten seit“ bei jeder Position."],
};

/* Beschriftung -> Glossareintrag. Damit haengt sich das Symbol von selbst an,
   wo immer eine dieser Kennzahlen ausgegeben wird - statt an dutzenden
   Aufrufstellen einzeln. Der Abgleich laeuft ueber den auf Kleinschreibung
   normierten Text ohne Klammerzusaetze. */
const INFO_LABELS = {
  "chance/risiko": "crv", "c/r": "crv", "chance/risiko-verhältnis": "crv",
  "rsi": "rsi", "rsi 14": "rsi",
  "gd 50 / 200": "gd", "gd 50/200": "gd", "trend gd 50/200": "gd",
  "rel. stärke 3 m vs. welt": "relstaerke", "relative stärke vs. welt-index": "relstaerke",
  "relative stärke": "relstaerke",
  "beta": "beta", "beta 5y": "beta",
  "sharpe ratio": "sharpe", "sharpe 2 j": "sharpe", "sharpe": "sharpe",
  "sortino ratio": "sortino", "sortino": "sortino",
  "value at risk 95% 1 t": "var", "value at risk": "var",
  "cvar 95% 1 t": "cvar", "cvar": "cvar",
  "max. drawdown": "drawdown", "maximaler drawdown": "drawdown",
  "kgv aktuell": "kgv", "kgv": "kgv",
  "kgv erwartet": "kgve",
  "peg": "peg", "kbv": "kbv", "kuv": "kuv",
  "ev/ebitda": "evebitda",
  "eigenkapitalrendite": "roe", "operative marge": "opmarge",
  "verschuldung d/e": "de", "verschuldung": "de",
  "fcf-rendite": "fcfrendite",
  "altman z-score": "altman", "piotroski f-score": "piotroski",
  "timing-score": "timing", "timing": "timing",
  "qualitäts-score": "qualitaet", "qualität": "qualitaet",
  "atr 14": "atr", "macd": "macd", "bollinger %b": "bollinger",
  "korrelation z. welt-index": "korrelation",
  "52-w-position": "pos52", "52-wochen-position": "pos52",
  "analysten-kursziel ø": "analystenziel",
  "dividendenrendite": "dividendenrendite",
  "einstiegszone": "einstiegszone", "stop-idee": "stop", "zonenbasis": "zonenbasis",
  "nettomarge": "nettomarge", "bruttomarge": "bruttomarge",
  "umsatzwachstum": "umsatzwachstum", "free cash flow": "fcf",
  "marktkapitalisierung": "marktkap",
  "dcf fairer wert näherung": "dcfwert",
  "institutioneller besitz": "instbesitz", "insider-besitz": "insiderbesitz",
  "volatilität annual.": "volatilitaet", "volatilität": "volatilitaet",
  "empfehlung": "empfehlung", "analystenkonsens": "empfehlung",
};

/* Passenden Eintrag zu einer Beschriftung finden; "" wenn es keinen gibt. */
function infoFuer(label) {
  const k = String(label)
    .replace(/<[^>]*>/g, "")
    .replace(/[()]/g, "")
    .replace(/\s+/g, " ")
    .trim().toLowerCase();
  return INFO_LABELS[k] ? infoIcon(INFO_LABELS[k]) : "";
}

/* Das kleine i. Bewusst ein <button>, damit es mit der Tastatur erreichbar ist. */
function infoIcon(key) {
  return INFO[key] ? `<button type="button" class="ii" data-info="${key}" aria-label="Erklärung">i</button>` : "";
}

/* Ein einziges Kaestchen fuer die ganze Seite, statt eines je Kennzahl.

   Zur Groesse: Sie ist in der Formatvorlage fest gesetzt und haengt bewusst
   NICHT vom Sichtfenster ab. Der erste Anlauf bemass sie mit
   calc(100vw - 24px); meldet der Browser waehrend eines Umbruchs
   voruebergehend 0 als Fensterbreite, ergibt das einen negativen Wert, und der
   Kasten faellt zu einem senkrechten Streifen zusammen. Eine Untergrenze per
   clamp haette das nur abgefangen - eine feste Breite laesst es gar nicht erst
   entstehen. Ins Bild geholt wird ueber die POSITION, nicht ueber die Groesse.

   Zur Verankerung: position:fixed statt absolute. Damit entfaellt das Rechnen
   mit der Scrollposition, und der Kasten kann beim Scrollen einfach mitwandern,
   statt zu schliessen. */
const INFO_ABSTAND = 10;        // Abstand zwischen Symbol und Kasten
const INFO_RAND = 8;            // Mindestabstand zum Fensterrand
const INFO_AUF_MS = 120;        // Verzoegerung vor dem Einblenden
const INFO_ZU_MS = 140;         // Nachlauf, damit man in den Kasten fahren kann

const InfoBox = {
  el: null, pfeil: null, fest: false, aktiv: null,
  aufTimer: null, zuTimer: null, folge: null,

  hole() {
    if (!this.el) {
      this.el = document.createElement("div");
      this.el.className = "iibox";
      this.el.id = "iibox";
      this.el.setAttribute("role", "tooltip");
      this.el.hidden = true;
      this.pfeil = document.createElement("i");
      this.pfeil.className = "iibox-pfeil";
      document.body.appendChild(this.el);
      /* In den Kasten fahren haelt ihn offen - sonst waeren laengere
         Erklaerungen weder in Ruhe lesbar noch markierbar. */
      this.el.addEventListener("mouseenter", () => clearTimeout(this.zuTimer));
      this.el.addEventListener("mouseleave", () => this.spaeterVerstecken());
    }
    return this.el;
  },

  /* Verzoegert oeffnen: Beim Ueberstreichen einer Reihe von Symbolen soll nicht
     jedes kurz aufblitzen. */
  spaeterZeigen(knopf) {
    clearTimeout(this.zuTimer);
    if (this.aktiv === knopf && !this.el.hidden) return;
    clearTimeout(this.aufTimer);
    this.aufTimer = setTimeout(() => this.zeige(knopf, false), INFO_AUF_MS);
  },
  spaeterVerstecken() {
    if (this.fest) return;
    clearTimeout(this.aufTimer);
    clearTimeout(this.zuTimer);
    this.zuTimer = setTimeout(() => this.verstecke(), INFO_ZU_MS);
  },

  zeige(knopf, fest) {
    const eintrag = INFO[knopf.dataset.info];
    if (!eintrag) return;
    clearTimeout(this.aufTimer); clearTimeout(this.zuTimer);

    const b = this.hole();
    b.innerHTML = `<b>${esc(eintrag[0])}</b>`
      + eintrag[1].split("\n\n").map(a => `<p>${esc(a)}</p>`).join("");
    b.appendChild(this.pfeil);
    b.hidden = false;
    this.fest = !!fest;
    if (this.aktiv && this.aktiv !== knopf) {
      this.aktiv.classList.remove("on");
      this.aktiv.removeAttribute("aria-describedby");
    }
    this.aktiv = knopf;
    knopf.classList.add("on");
    knopf.setAttribute("aria-describedby", "iibox");

    this.platziere();
    this.folgeStarten();
  },

  /* Ausrichten. Bevorzugt oberhalb des Symbols, sonst darunter; waagerecht
     mittig, aber in den Fensterrand hineingezogen. Der Pfeil bleibt dabei am
     Symbol stehen, auch wenn der Kasten verschoben wurde - sonst zeigte er bei
     Kennzahlen am Rand ins Leere. */
  platziere() {
    const b = this.el, k = this.aktiv;
    if (!b || !k) return;
    const fb = window.innerWidth, fh = window.innerHeight;
    /* Bei entarteter Fenstergroesse gar nicht erst rechnen - das Ergebnis waere
       Unsinn. Kommt beim Umbruch und in eingebetteten Ansichten vor. */
    if (fb < 60 || fh < 60) { b.hidden = true; return; }

    const a = k.getBoundingClientRect();
    const m = b.getBoundingClientRect();

    let x = a.left + a.width / 2 - m.width / 2;
    x = Math.max(INFO_RAND, Math.min(x, fb - m.width - INFO_RAND));

    let oben = true;
    let y = a.top - m.height - INFO_ABSTAND;
    if (y < INFO_RAND) { y = a.bottom + INFO_ABSTAND; oben = false; }
    /* Reicht es auch darunter nicht, ins Bild ziehen. */
    y = Math.max(INFO_RAND, Math.min(y, fh - m.height - INFO_RAND));

    b.style.left = Math.round(x) + "px";
    b.style.top = Math.round(y) + "px";
    b.classList.toggle("unten", !oben);

    const pfeilX = a.left + a.width / 2 - x;
    this.pfeil.style.left = Math.round(Math.max(12, Math.min(pfeilX, m.width - 12))) + "px";
  },

  /* Beim Scrollen mitwandern statt schliessen. Verlaesst das Symbol das Bild,
     wird geschlossen - ein Kasten ohne sichtbaren Bezug hilft niemandem.

     Ueber Ereignisse statt einer Dauerschleife: Eine Schleife mit
     requestAnimationFrame liefe sechzig Mal je Sekunde, obwohl sich nur beim
     Scrollen etwas aendert - und sie pausiert, sobald der Tab in den
     Hintergrund geht. scroll mit capture faengt auch Scrollen in inneren
     Behaeltern, nicht nur am Fenster. */
  folgeStarten() {
    if (this.folge) return;
    this.folge = () => {
      if (!this.aktiv || !this.el || this.el.hidden) return;
      const a = this.aktiv.getBoundingClientRect();
      if (a.bottom < 0 || a.top > window.innerHeight) { this.verstecke(true); return; }
      this.platziere();
    };
    window.addEventListener("scroll", this.folge, { passive: true, capture: true });
    window.addEventListener("resize", this.folge);
  },
  folgeBeenden() {
    if (!this.folge) return;
    window.removeEventListener("scroll", this.folge, { capture: true });
    window.removeEventListener("resize", this.folge);
    this.folge = null;
  },

  verstecke(erzwingen) {
    if (this.fest && !erzwingen) return;
    clearTimeout(this.aufTimer); clearTimeout(this.zuTimer);
    this.folgeBeenden();
    if (this.el) this.el.hidden = true;
    if (this.aktiv) {
      this.aktiv.classList.remove("on");
      this.aktiv.removeAttribute("aria-describedby");
    }
    this.aktiv = null; this.fest = false;
  },
};

/* Ein Satz Zuhoerer fuer die ganze Seite - die Symbole entstehen laufend neu,
   einzelne Bindungen muessten dabei jedes Mal erneuert werden. */
function initInfo() {
  document.addEventListener("mouseover", e => {
    const k = e.target.closest(".ii");
    if (k && !InfoBox.fest) InfoBox.spaeterZeigen(k);
  });
  document.addEventListener("mouseout", e => {
    const k = e.target.closest(".ii");
    /* Nur schliessen, wenn der Zeiger das Symbol wirklich verlaesst und nicht
       in den Kasten hinueberwechselt. */
    if (k && !InfoBox.fest && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(".iibox")))
      InfoBox.spaeterVerstecken();
  });
  /* Tastaturbedienung: Beim Anspringen zeigen, beim Verlassen schliessen. */
  document.addEventListener("focusin", e => {
    const k = e.target.closest(".ii");
    if (k) InfoBox.zeige(k, true);
  });
  document.addEventListener("focusout", e => {
    const k = e.target.closest(".ii");
    if (k && InfoBox.aktiv === k) InfoBox.verstecke(true);
  });
  /* Klick haelt fest - fuer Finger und Tastatur, wo es kein Ueberfahren gibt. */
  document.addEventListener("click", e => {
    const k = e.target.closest(".ii");
    if (k) {
      e.preventDefault(); e.stopPropagation();
      if (InfoBox.fest && InfoBox.aktiv === k) InfoBox.verstecke(true);
      else InfoBox.zeige(k, true);
      return;
    }
    if (!e.target.closest(".iibox")) InfoBox.verstecke(true);
  });
  document.addEventListener("keydown", e => { if (e.key === "Escape") InfoBox.verstecke(true); });
  /* Kein Schliessen mehr beim Scrollen: folgeStarten() haengt sich waehrend der
     Anzeige an scroll und resize und schliesst erst, wenn das Symbol das Bild
     verlaesst. */
}

/* ---------- Chancenraum -----------------------------------------------------
   Zeigt Titel, deren Kurs nahe an der Zonenbasis steht und die noch Luft bis
   Ziel 1 haben. Die Liste wird taeglich serverseitig gerechnet
   (scripts/build_chancen.py) und liegt als data/chancen.json bereit - im
   Browser ist damit kein einziger Kursabruf noetig, der Raum steht sofort.

   Zur Zonenlogik: Die Zonenbasis ist die naechste Unterstuetzung UNTERHALB des
   Kurses. Sie wandert mit dem Kurs mit, ein Titel kann also nie unter seiner
   eigenen Einstiegszone stehen. Gemessen wird deshalb der ABSTAND zur Basis:
   je kleiner, desto naeher ist der Kurs zurueckgekommen.

   Drei Lagen, vom Server vergeben:
     in_zone  - bis 3,5 Prozent ueber der Basis (die Zonenbreite selbst)
     nahe     - bis 8 Prozent darueber
     umfeld   - bis 20 Prozent darueber; weiter entfernt kommt nichts hinein   */
const Chancen = {
  daten: null, prom: null, lage: "alle", sortier: "punkte",
  load() {
    if (!this.prom) {
      this.prom = fetch("data/chancen.json?v=" + Date.now())
        .then(r => r.ok ? r.json() : null)
        .then(j => { this.daten = j; return j; })
        .catch(() => { this.daten = null; return null; });
    }
    return this.prom;
  },
};

const CH_LAGEN = { in_zone: "In der Zone", nahe: "Nahe", umfeld: "Umfeld" };

/* Stammdaten. Bevorzugt aus der Datei selbst - der Server legt Name, Land und
   Sektor bei, damit die Anzeige nicht auf die 1,8 MB grosse Tickerdatenbank
   warten muss. Nur wenn dort nichts steht, wird sie befragt. */
function chStamm(sym) {
  const t = (Chancen.daten && Chancen.daten.titel || []).find(x => x.sym === sym);
  if (t && t.name && t.name !== sym) {
    return { s: sym, n: t.name, c: t.land || "", e: "", sec: t.sektor || "" };
  }
  const r = (typeof DB !== "undefined" && DB.rows && DB.rows.length)
    ? DB.rows.find(x => x[0] === sym) : null;
  return r ? { s: sym, n: r[1], c: r[2] || "", e: r[3] || "", sec: r[4] || "" }
           : { s: sym, n: (t && t.name) || sym, c: "", e: "", sec: "" };
}
const chNameFuer = sym => chStamm(sym).n;

function renderChancen() {
  const body = $("#chancenbody"), meta = $("#chancenmeta");
  if (!body) return;
  const d = Chancen.daten;

  if (!d || !Array.isArray(d.titel)) {
    meta.textContent = "nicht verfügbar";
    body.innerHTML = `<div class="ch-leer">Die Liste <code>data/chancen.json</code> fehlt oder ist
      unlesbar. Sie entsteht täglich über die Aktion „Chancenraum aktualisieren“.</div>`;
    return;
  }
  if (!d.titel.length) {
    meta.textContent = "0 Treffer";
    body.innerHTML = `<div class="ch-leer">Zurzeit steht kein Titel des Korbs nahe genug an seiner
      Zonenbasis. Das ist ein Ergebnis, kein Fehler – in steigenden Märkten bleibt der Raum oft leer.</div>`;
    return;
  }

  const alter = d.generated ? Math.round((Date.now() / 1000 - d.generated) / 3600) : null;
  meta.textContent = `${d.titel.length} von ${d.geprueft} Titeln`
    + (alter != null ? ` · Stand vor ${alter < 24 ? alter + " Std" : Math.round(alter / 24) + " Tg"}` : "");

  const gefiltert = d.titel.filter(t => Chancen.lage === "alle" || t.lage === Chancen.lage);
  gefiltert.sort((a, b) => Chancen.sortier === "naehe"
    ? a.naehe_prozent - b.naehe_prozent
    : Chancen.sortier === "chance" ? b.chance_prozent - a.chance_prozent
    : b.punkte - a.punkte);

  const zaehl = k => d.titel.filter(t => t.lage === k).length;
  const chips = ["alle", "in_zone", "nahe", "umfeld"].map(k => {
    const n = k === "alle" ? d.titel.length : zaehl(k);
    const txt = k === "alle" ? "Alle" : CH_LAGEN[k];
    return `<button class="nb-chip${Chancen.lage === k ? " on" : ""}" data-lage="${k}">${txt}<i>${n}</i></button>`;
  }).join("");

  const sortChips = [["punkte", "Bewertung"], ["naehe", "Nähe zur Basis"], ["chance", "Luft bis Ziel"]]
    .map(([k, l]) => `<button class="ch-sort${Chancen.sortier === k ? " on" : ""}" data-sort="${k}">${l}</button>`).join("");

  const zeilen = gefiltert.map(t => {
    const gemerkt = Favs.has(t.sym);
    const w = t.waehrung || "";
    return `<div class="ch-row" data-sym="${esc(t.sym)}">
      <div class="ch-pkt">${t.punkte}${infoIcon("chancenpunkte")}</div>
      <div class="ch-titel">
        <b>${esc(chNameFuer(t.sym))}</b>
        <i>${esc(t.sym)} · <span class="ch-lage ch-${t.lage}">${CH_LAGEN[t.lage] || t.lage}</span>${
          t.trend_auf ? "" : ' · <span class="ch-warn">unter GD 200</span>'}</i>
      </div>
      <div class="ch-zahl"><span>Kurs</span><b>${moneyNum(t.kurs, w, t.kurs < 10 ? 2 : 1)}</b></div>
      <div class="ch-zahl"><span>zur Basis${infoIcon("zonenbasis")}</span><b class="up">+${fmtNum(t.naehe_prozent, "", 1)} %</b></div>
      <div class="ch-zahl"><span>bis Ziel 1${infoIcon("ziel")}</span><b class="up">+${fmtNum(t.chance_prozent, "", 1)} %</b></div>
      <div class="ch-zahl"><span>C/R${infoIcon("crv")}</span><b>${t.crv != null ? fmtNum(t.crv, "", 1) : "–"}</b></div>
      <div class="ch-akt">
        <button class="ch-btn ch-merk${gemerkt ? " on" : ""}" data-merk="${esc(t.sym)}"
          title="${gemerkt ? "Aus der Merkliste entfernen" : "Zur Merkliste hinzufügen"}">${gemerkt ? "Gemerkt" : "+ Merken"}</button>
        <button class="ch-btn" data-oeffnen="${esc(t.sym)}" title="Analyse öffnen">Ansehen</button>
      </div>
    </div>`;
  }).join("");

  body.innerHTML = `
    <div class="nb-chips">${chips}</div>
    <div class="ch-sortzeile"><span>Sortieren:</span>${sortChips}</div>
    <div class="ch-list">${zeilen || '<div class="ch-leer">Kein Titel in dieser Lage.</div>'}</div>
    <p class="ch-fuss">Die Zonenbasis ist die nächste Unterstützung unterhalb des Kurses – sie wandert
      mit. Gemessen wird der Abstand dorthin, nicht „über oder unter“. Täglich gerechnet, Kurse also bis
      zu einen Tag alt. Kein Kaufsignal: ein Titel steht hier, weil er zurückgekommen ist, nicht weil er
      steigen wird.</p>`;

  body.querySelectorAll("[data-lage]").forEach(b => {
    b.onclick = () => { Chancen.lage = b.dataset.lage; renderChancen(); };
  });
  body.querySelectorAll("[data-sort]").forEach(b => {
    b.onclick = () => { Chancen.sortier = b.dataset.sort; renderChancen(); };
  });
  body.querySelectorAll("[data-merk]").forEach(b => {
    b.onclick = e => {
      e.stopPropagation();
      const sym = b.dataset.merk;
      if (Favs.has(sym)) Favs.remove(sym);
      else Favs.add(chStamm(sym));
      renderChancen();
    };
  });
  body.querySelectorAll("[data-oeffnen]").forEach(b => {
    b.onclick = e => {
      e.stopPropagation();
      const sym = b.dataset.oeffnen;
      openDetail(chStamm(sym));
    };
  });
}

async function initChancen() {
  const body = $("#chancenbody"), tgl = $("#chancentoggle");
  if (!body || !tgl) return;
  let offen = true;
  try { offen = localStorage.getItem("ak.chancen.open") !== "0"; } catch (e) {}
  const male = () => { body.style.display = offen ? "" : "none"; tgl.textContent = offen ? "Einklappen" : "Ausklappen"; };
  male();
  tgl.onclick = () => { offen = !offen; try { localStorage.setItem("ak.chancen.open", offen ? "1" : "0"); } catch (e) {} male(); };
  await Chancen.load();
  renderChancen();
}

/* ---------- Anzeigewährung (reine Darstellungs-Umrechnung) -----------------
   WICHTIG: Sämtliche Analysen (Renditen, RSI, Momentum, Scores, Risikomaße,
   Zonen) rechnen ausschließlich mit den Originalkursen. Hier wird nur die
   *Anzeige* mit einem einzigen aktuellen Kurs skaliert. Eine gleichmäßige
   Skalierung verändert keine Verhältnisse – die Ergebnisse bleiben identisch.
--------------------------------------------------------------------------- */
const FX = { mode: "native", rates: {} };
try { FX.mode = localStorage.getItem("ak.fx") || "native"; } catch (e) {}

/* Pence-Notierung (London) sauber behandeln */
function fxBase(cur) { return (cur === "GBp" || cur === "GBX") ? "GBP" : (cur || ""); }
function fxScale(cur) { return (cur === "GBp" || cur === "GBX") ? 0.01 : 1; }

async function fxFetchPair(from, to) {
  const key = from + to;
  if (FX.rates[key] != null) return FX.rates[key];
  const cached = Cache.get("fx." + key, 6 * 60 * 60 * 1000);
  if (cached != null) { FX.rates[key] = cached; return cached; }
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${from}${to}=X?range=5d&interval=1d`;
    const d = await fetchJson(url, x => x && x.chart && x.chart.result && x.chart.result[0], 8000);
    const meta = d.chart.result[0].meta || {};
    const r = meta.regularMarketPrice ?? meta.previousClose;
    if (isFinite(r) && r > 0) { FX.rates[key] = r; Cache.set("fx." + key, r); return r; }
  } catch (e) {}
  return null;
}

/* Kurs beschaffen; bei Bedarf Umweg über USD */
async function fxEnsure(cur) {
  if (FX.mode === "native") return;
  const base = fxBase(cur);
  if (!base || base === FX.mode) return;
  const key = base + FX.mode;
  if (FX.rates[key] != null) return;
  let r = await fxFetchPair(base, FX.mode);
  if (r == null) {
    const a = base === "USD" ? 1 : await fxFetchPair(base, "USD");
    const b = FX.mode === "USD" ? 1 : await fxFetchPair("USD", FX.mode);
    if (a != null && b != null) { r = a * b; FX.rates[key] = r; Cache.set("fx." + key, r); }
  }
}

/* Anzeige-Währungscode */
function dispCur(cur) { return FX.mode === "native" ? cur : FX.mode; }

/* Betrag mit Währungssymbol */
function money(v, cur, dig) {
  if (v == null || !isFinite(v)) return "–";
  if (FX.mode === "native") return fmtNum(v, cur, dig);
  const base = fxBase(cur), x = v * fxScale(cur);
  if (base === FX.mode) return fmtNum(x, base, dig);
  const r = FX.rates[base + FX.mode];
  if (!r) return fmtNum(v, cur, dig) + ' <span class="fx-approx">(nicht umrechenbar)</span>';
  return fmtNum(x * r, FX.mode, dig);
}
/* Blanke Zahl (für kompakte Beschriftungen) */
function moneyNum(v, cur, dig) {
  if (v == null || !isFinite(v)) return "–";
  if (FX.mode === "native") return fmtNum(v, null, dig);
  const base = fxBase(cur), x = v * fxScale(cur);
  if (base === FX.mode) return fmtNum(x, null, dig);
  const r = FX.rates[base + FX.mode];
  return r ? fmtNum(x * r, null, dig) : fmtNum(v, null, dig);
}
/* Große Beträge (Marktkapitalisierung) */
function moneyBig(v, cur) {
  if (v == null || !isFinite(v)) return "–";
  if (FX.mode === "native") return fmtBig(v) + (cur ? " " + cur : "");
  const base = fxBase(cur), x = v * fxScale(cur);
  if (base === FX.mode) return fmtBig(x) + " " + FX.mode;
  const r = FX.rates[base + FX.mode];
  return r ? fmtBig(x * r) + " " + FX.mode : fmtBig(v) + (cur ? " " + cur : "");
}
/* Hinweiszeile für die Detailansicht */
function fxBanner(cur) {
  if (FX.mode === "native") return "";
  const base = fxBase(cur);
  if (base === FX.mode) return "";
  const r = FX.rates[base + FX.mode];
  if (!r) return `<div class="fx-banner">Umrechnung nach ${FX.mode} für <b>${esc(cur)}</b> gerade nicht verfügbar – Beträge werden in der Originalwährung angezeigt.</div>`;
  return `<div class="fx-banner">Beträge umgerechnet mit <b>1 ${base} = ${fmtNum(r, null, 4)} ${FX.mode}</b> (aktueller Kurs, näherungsweise). <b>Nur die Anzeige</b> ist umgerechnet – alle Scores, Renditen, Risikomaße und Zonenverhältnisse basieren unverändert auf den Originalkursen.</div>`;
}

/* Umschalter verdrahten */
function initFx() {
  const seg = $("#fxseg");
  if (!seg) return;
  const paint = () => seg.querySelectorAll("button").forEach(b => b.classList.toggle("on", b.dataset.fx === FX.mode));
  paint();
  seg.querySelectorAll("button").forEach(b => b.onclick = async () => {
    if (FX.mode === b.dataset.fx) return;
    FX.mode = b.dataset.fx;
    try { localStorage.setItem("ak.fx", FX.mode); } catch (e) {}
    paint();
    renderFavs();
    if (typeof renderDepot === "function") renderDepot();
    if (panel.classList.contains("open") && currentItem) openDetail(currentItem);
  });
}

/* ---------- Ticker-Datenbank + Suche ---------- */
const DB = { rows: [], norm: [], ready: false };
async function initDB() {
  const state = $("#dbstate");
  try {
    const res = await fetch("data/tickers.json", { cache: "force-cache" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    DB.rows = await res.json();
    DB.norm = DB.rows.map(r => (r[0] + " " + r[1]).toLowerCase());
    DB.ready = true;
    /* Der Chancenraum steht oft schon, bevor die Namen da sind - dann traegt er
       nur Symbole. Einmal nachziehen. */
    if (typeof Chancen !== "undefined" && Chancen.daten) renderChancen();
    state.innerHTML = "<b>" + DB.rows.length.toLocaleString("de-DE") + "</b> Titel · sofort durchsuchbar";
  } catch (e) {
    state.innerHTML = "Lokale Datenbank nicht geladen – Online-Suche aktiv";
  }
}
/* Börsen-Priorität: Heimat-/Hauptbörsen vor Zweitnotierungen */
const EXCH_MAIN = new Set(["", "DE", "T", "HK", "L", "PA", "AS", "MI", "MC", "SW", "VX", "TO", "AX", "KS", "KQ", "NS", "BO", "SA", "ST", "OL", "CO", "HE", "SS", "SZ", "TW", "SI", "JK", "BK", "NZ", "IR", "WA", "AT", "LS", "BR", "IS", "MX", "JO", "TA"]);
const EXCH_MINOR = new Set(["F", "SG", "BE", "DU", "MU", "HA", "HM", "BA", "BD", "PR", "TI", "IL", "NE", "CN", "V", "VI"]);
const SUF_HOME = { "": "United States", DE: "Germany", T: "Japan", HK: "China", L: "United Kingdom", PA: "France",
  AS: "Netherlands", MI: "Italy", MC: "Spain", SW: "Switzerland", VX: "Switzerland", TO: "Canada", AX: "Australia",
  KS: "South Korea", KQ: "South Korea", NS: "India", BO: "India", SA: "Brazil", ST: "Sweden", OL: "Norway",
  CO: "Denmark", HE: "Finland", SS: "China", SZ: "China", TW: "Taiwan", SI: "Singapore", JK: "Indonesia",
  BK: "Thailand", NZ: "New Zealand", IR: "Ireland", WA: "Poland", AT: "Greece", LS: "Portugal", BR: "Belgium",
  VI: "Austria", IS: "Turkey", MX: "Mexico", JO: "South Africa", TA: "Israel" };
function symPrio(sym, country) {
  const dot = sym.lastIndexOf(".");
  const suf = dot < 0 ? "" : sym.slice(dot + 1).toUpperCase();
  let p;
  if (dot < 0) p = /^[A-Z]{5}$/.test(sym) && /[FY]$/.test(sym) ? 1 : 0; // 5-Buchstaben-OTC (…F/…Y) nach hinten
  else if (EXCH_MINOR.has(suf)) p = 2;
  else if (EXCH_MAIN.has(suf)) p = 0;
  else p = 1;
  if (country && SUF_HOME[suf] === country) p -= 0.5;  // Heimatbörsen-Bonus
  return p;
}
function localSearch(q, limit = 9) {
  if (!DB.ready) return [];
  const needle = q.toLowerCase().trim();
  if (!needle) return [];
  const scored = [];
  for (let i = 0; i < DB.rows.length && scored.length < 600; i++) {
    const [sym, name] = DB.rows[i];
    const ls = sym.toLowerCase(), ln = DB.norm[i];
    let sc = -1;
    if (ls === needle) sc = 0;
    else if (ls.startsWith(needle)) sc = 1;
    else if (name.toLowerCase().startsWith(needle)) sc = 2;
    else if (ln.includes(needle)) sc = 4;
    if (sc >= 0) scored.push({ i, sc, p: symPrio(sym, DB.rows[i][2]) });
  }
  scored.sort((a, b) => a.sc - b.sc || a.p - b.p || a.i - b.i);
  const out = [], perName = new Map();
  for (const x of scored) {
    const r = DB.rows[x.i];
    const nkey = r[1].toLowerCase();
    const cnt = perName.get(nkey) || 0;
    if (cnt >= 2) continue;              // max. 2 Listings je Unternehmen
    perName.set(nkey, cnt + 1);
    out.push({ s: r[0], n: r[1], c: r[2], e: r[3], sec: r[4], etf: r[5] === "ETF" });
    if (out.length >= limit) break;
  }
  return out;
}
async function remoteSearch(q) {
  const key = "search." + q.toLowerCase();
  const cached = Cache.get(key, 60 * 60 * 1000);
  if (cached) return cached;
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=8&newsCount=0&listsCount=0`;
  const data = await fetchJson(url, d => d && Array.isArray(d.quotes));
  const out = data.quotes
    .filter(x => x.symbol && (x.quoteType === "EQUITY" || x.quoteType === "ETF"))
    .map(x => ({ s: x.symbol, n: x.longname || x.shortname || x.symbol, c: "", e: x.exchDisp || x.exchange || "", sec: x.quoteType === "ETF" ? "ETF" : "", etf: x.quoteType === "ETF", remote: true }));
  Cache.set(key, out);
  return out;
}

/* ---------- Favoriten ---------- */
const Favs = {
  list() { try { return JSON.parse(localStorage.getItem("ak.favs")) || []; } catch (e) { return []; } },
  has(sym) { return this.list().some(f => f.s === sym); },
  add(item) { const l = this.list(); if (!l.some(f => f.s === item.s)) { l.push({ s: item.s, n: item.n, c: item.c || "", e: item.e || "", sec: item.sec || "" }); localStorage.setItem("ak.favs", JSON.stringify(l)); } renderFavs(); },
  remove(sym) { localStorage.setItem("ak.favs", JSON.stringify(this.list().filter(f => f.s !== sym))); renderFavs(); },
};

/* ---------- Lade-Warteschlange (max. 2 parallel, schont die Datenquelle) ---------- */
const Queue = (() => {
  let active = 0; const q = [];
  const next = () => { if (active >= 2 || !q.length) return; active++; const job = q.shift();
    job().finally(() => { active--; next(); }); };
  return { push(job) { q.push(job); next(); } };
})();

/* ---------- Dashboard ---------- */
const analysisCache = new Map();
function renderFavs() {
  if (News.loaded) renderNews();
  const area = $("#favarea"), favs = Favs.list();
  $("#favcount").textContent = favs.length ? favs.length + (favs.length === 1 ? " Titel" : " Titel") : "";
  area.innerHTML = "";
  if (!favs.length) {
    area.append(el("div", "empty",
      `<h3>Noch keine Favoriten</h3>
       <p>Nutze die Suche oben – tippe einen Namen wie <kbd>Toyota</kbd>, <kbd>SAP</kbd> oder einen Ticker wie <kbd>NVDA</kbd> und füge Titel mit <b>+</b> zu deinen Favoriten hinzu. Sie erscheinen dann hier mit Kurs, Scores und Ampel.</p>`));
    return;
  }
  const grid = el("div", "grid");
  area.append(grid);
  favs.forEach(f => {
    const card = el("article", "card");
    card.dataset.sym = f.s;
    card.innerHTML = cardSkeleton(f);
    card.addEventListener("click", ev => { if (ev.target.closest(".rm") || ev.target.closest(".retry")) return; openDetail(f); });
    grid.append(card);
    Queue.push(() => fillCard(card, f));
  });
}
/* Kompaktes Zonenband für die Übersichtskarte.
   Nutzt ausschließlich bereits berechnete Werte aus analyse() – kein Nachladen.
   Alle Angaben in Prozent, daher unabhängig von der eingestellten Anzeigewährung. */
function cardZone(a) {
  const z = a.zones, p = a.price;
  if (!z || !isFinite(p) || !isFinite(z.stop) || !isFinite(z.entryLow) || !isFinite(z.t1))
    return `<div class="cz-na">Zonen für diesen Titel nicht berechenbar</div>`;

  const lo = Math.min(z.stop, p) * 0.99;
  const hi = Math.max(z.t2, z.t1, p) * 1.01;
  const span = hi - lo;
  if (!(span > 0)) return `<div class="cz-na">Zonen für diesen Titel nicht berechenbar</div>`;
  const pos = v => clamp((v - lo) / span * 100, 0, 100);

  /* Zustand gegenüber der Einstiegszone */
  const inZone = p <= z.entryHigh * 1.0005;
  const overZone = inZone ? 0 : (p / z.entryHigh - 1);
  const reached = z.t1 <= p * 1.0005;
  const upside = reached ? 0 : (z.t1 / p - 1);

  /* Abstand zur Zonenbasis (Unterstützung bzw. gleitender Durchschnitt).
     Innerhalb der Zone differenziert dieser Wert weiter, statt bei allen
     Titeln dasselbe „in der Zone" anzuzeigen. */
  const cushion = z.entryLow > 0 ? (p / z.entryLow - 1) : null;
  const left = inZone
    ? `<span class="cz-in">In Zone · ${cushion == null ? "–" : fmtPct(cushion, false)}</span>`
    : `<span>${fmtPct(overZone, false)} über Zone</span>`;
  const right = reached
    ? `<b class="cz-up">Ziel erreicht</b>`
    : `<b>${fmtPct(upside)} bis Ziel</b>`;

  const segStop = `<span class="cz-seg cz-stop" style="left:0;width:${pos(z.stop)}%"></span>`;
  const segEntry = `<span class="cz-seg cz-entry" style="left:${pos(z.entryLow)}%;width:${Math.max(1.5, pos(z.entryHigh) - pos(z.entryLow))}%"></span>`;
  const segTarget = `<span class="cz-seg cz-target" style="left:${pos(z.t1)}%;width:${100 - pos(z.t1)}%"></span>`;

  return `<div class="cz" title="Band: Stop · Einstiegszone · aktueller Kurs · Zielbereich. Links: Abstand des Kurses zur Zonenbasis (Unterstützung bzw. gleitender Durchschnitt) bzw. zur Zonenobergrenze. Rechts: Abstand bis Ziel 1.">
      <div class="cz-track">${segStop}${segEntry}${segTarget}
        <i class="cz-price" style="left:calc(${pos(p)}% - 1px)"></i></div>
      <div class="cz-lab">${left}${right}</div>
    </div>`;
}

function cardSkeleton(f) {
  return `<button class="rm" title="Aus Favoriten entfernen" aria-label="Entfernen">✕</button>
    <div class="c-name">${esc(f.n)}</div><div class="c-sym">${esc(f.s)}${f.e ? " · " + esc(f.e) : ""}</div>
    <div class="c-priceline"><span class="c-price skel">0000,00</span><span class="c-chg skel">+0,0 %</span></div>
    <div class="c-scores">
      <div class="scr"><span>Timing</span><div class="bar"><i style="width:0"></i></div><b class="skel">00</b></div>
      <div class="scr"><span>Qualität</span><div class="bar"><i style="width:0"></i></div><b class="skel">00</b></div>
    </div>
    <div class="cz"><div class="cz-track"></div><div class="cz-lab"><span class="skel">Zone</span><b class="skel">Ziel</b></div></div>
    <div class="c-foot">lädt …</div><span class="ampel a-n"></span>`;
}
async function fillCard(card, f) {
  card.querySelector(".rm").onclick = () => Favs.remove(f.s);
  try {
    const [chart, bench] = await Promise.all([loadChart(f.s), loadBenchmark()]);
    const fund = await loadFundamentals(f.s, chart.meta && chart.meta.currency).catch(() => null);
    const a = analyse(chart, fund, bench);
    analysisCache.set(f.s, { chart, fund, a, t: Date.now() });
    const cur = chart.meta.currency || "";
    await fxEnsure(cur);
    card.innerHTML = `<button class="rm" title="Aus Favoriten entfernen" aria-label="Entfernen">✕</button>
      <div class="c-name">${esc(f.n)}</div><div class="c-sym">${esc(f.s)}${f.e ? " · " + esc(f.e) : ""}</div>
      <div class="c-priceline"><span class="c-price">${money(a.price, cur)}</span>
        <span class="c-chg ${chgCls(a.dayChg)}">${fmtPct(a.dayChg)}</span></div>
      <div class="c-scores">
        <div class="scr"><span>Timing</span><div class="bar"><i style="width:${a.timing ?? 0}%"></i></div><b>${a.timing ?? "–"}</b></div>
        <div class="scr"><span>Qualität</span><div class="bar"><i style="width:${a.quality ?? 0}%;${a.quality==null?"background:var(--faint)":""}"></i></div><b>${a.quality ?? "–"}</b></div>
      </div>
      ${cardZone(a)}
      <div class="c-foot">${a.trendUp ? "Aufwärtstrend" : "Kein Aufwärtstrend"}</div>
      <span class="ampel a-${a.ampel}" title="Gesamteinschätzung"></span>`;
    card.querySelector(".rm").onclick = () => Favs.remove(f.s);
    freshText();
  } catch (e) {
    card.classList.add("err");
    card.innerHTML = `<button class="rm" title="Entfernen" aria-label="Entfernen">✕</button>
      <div class="c-name">${esc(f.n)}</div><div class="c-sym">${esc(f.s)}</div>
      <div class="c-priceline">Kursdaten gerade nicht erreichbar.</div>
      <button class="retry">Erneut versuchen</button><span class="ampel a-n"></span>`;
    card.querySelector(".rm").onclick = () => Favs.remove(f.s);
    card.querySelector(".retry").onclick = ev => { ev.stopPropagation(); card.classList.remove("err"); card.innerHTML = cardSkeleton(f); Queue.push(() => fillCard(card, f)); };
  }
}

/* ---------- Suche: UI ---------- */
const qInput = $("#q"), sugg = $("#sugg");
let activeIdx = -1, currentRows = [], remoteTimer = null, remoteSeq = 0;

qInput.addEventListener("input", () => {
  const q = qInput.value.trim();
  activeIdx = -1;
  clearTimeout(remoteTimer);
  if (q.length < 1) { closeSugg(); return; }
  currentRows = localSearch(q);
  drawSugg(q, currentRows, DB.ready ? null : "lädt");
  const seq = ++remoteSeq;
  remoteTimer = setTimeout(async () => {
    drawSugg(q, currentRows, "lädt");
    try {
      const remote = await remoteSearch(q);
      if (seq !== remoteSeq) return;
      const have = new Set(currentRows.map(r => r.s));
      const extra = remote.filter(r => !have.has(r.s));
      currentRows = currentRows.concat(extra);
      drawSugg(q, currentRows, extra.length ? "ok" : "leer");
    } catch (e) { if (seq === remoteSeq) drawSugg(q, currentRows, "fehler"); }
  }, 480);
});
qInput.addEventListener("keydown", ev => {
  const rows = sugg.querySelectorAll(".sg-row");
  if (ev.key === "Escape") { closeSugg(); qInput.blur(); return; }
  if (!rows.length) return;
  if (ev.key === "ArrowDown") { ev.preventDefault(); activeIdx = Math.min(activeIdx + 1, rows.length - 1); markActive(rows); }
  else if (ev.key === "ArrowUp") { ev.preventDefault(); activeIdx = Math.max(activeIdx - 1, 0); markActive(rows); }
  else if (ev.key === "Enter" && activeIdx >= 0) { ev.preventDefault(); rows[activeIdx].click(); }
});
function markActive(rows) { rows.forEach((r, i) => r.classList.toggle("active", i === activeIdx)); if (rows[activeIdx]) rows[activeIdx].scrollIntoView({ block: "nearest" }); }
document.addEventListener("click", ev => { if (!ev.target.closest(".searchwrap")) closeSugg(); });
function closeSugg() { sugg.classList.remove("open"); sugg.innerHTML = ""; }

function drawSugg(q, rows, remoteState) {
  sugg.innerHTML = "";
  const localRows = rows.filter(r => !r.remote), remoteRows = rows.filter(r => r.remote);
  if (localRows.length) {
    sugg.append(el("div", "sg-head", "Schnellsuche · lokale Datenbank"));
    localRows.forEach(r => sugg.append(suggRow(r)));
  }
  if (remoteRows.length) {
    sugg.append(el("div", "sg-head", "Online-Suche"));
    remoteRows.forEach(r => sugg.append(suggRow(r)));
  }
  if (!rows.length && remoteState !== "lädt")
    sugg.append(el("div", "sg-note", remoteState === "fehler"
      ? "Online-Suche gerade nicht erreichbar – bitte kurz erneut versuchen."
      : `Kein Treffer für „${esc(q)}«. Tipp: Ticker direkt eingeben (z. B. <b>7203.T</b> für Tokio, <b>SAP.DE</b> für Xetra).`));
  if (remoteState === "lädt")
    sugg.append(el("div", "sg-note", `<span class="spin"></span>Online-Suche läuft …`));
  if (remoteState === "fehler" && rows.length)
    sugg.append(el("div", "sg-note", "Online-Ergänzung nicht erreichbar – lokale Treffer werden angezeigt."));
  sugg.classList.add("open");
}
function suggRow(r) {
  const row = el("div", "sg-row");
  row.setAttribute("role", "option");
  const on = Favs.has(r.s);
  row.innerHTML = `<div class="sg-main">
      <div class="sg-name">${esc(r.n)}</div>
      <div class="sg-meta"><span class="sg-sym">${esc(r.s)}</span>
        ${r.etf ? `<span class="tag tag-etf">ETF</span>` : ""}${r.e ? `<span class="tag">${esc(r.e)}</span>` : ""}${r.c ? `<span class="tag">${esc(r.c)}</span>` : ""}${r.sec && r.sec !== "ETF" ? `<span class="tag">${esc(r.sec)}</span>` : ""}</div></div>
    <button class="sg-add${on ? " on" : ""}" title="${on ? "In Favoriten" : "Zu Favoriten hinzufügen"}" aria-label="Favorit umschalten">${on ? "✓" : "+"}</button>`;
  row.querySelector(".sg-add").addEventListener("click", ev => {
    ev.stopPropagation();
    const btn = ev.currentTarget;
    if (Favs.has(r.s)) { Favs.remove(r.s); btn.classList.remove("on"); btn.textContent = "+"; }
    else { Favs.add(r); btn.classList.add("on"); btn.textContent = "✓"; }
  });
  row.addEventListener("click", () => { closeSugg(); openDetail(r); });
  return row;
}

/* ---------- Detailansicht ---------- */
const ovl = $("#ovl"), panel = $("#panel");
let chartObj = null;
let currentItem = null;
ovl.addEventListener("click", closeDetail);
document.addEventListener("keydown", ev => { if (ev.key === "Escape" && panel.classList.contains("open")) closeDetail(); });
function closeDetail() { panel.classList.remove("open"); ovl.classList.remove("open"); setTimeout(() => { panel.style.display = "none"; }, 220); if (chartObj) { chartObj.destroy(); chartObj = null; } }

async function openDetail(item) {
  currentItem = item;
  panel.style.display = "block";
  requestAnimationFrame(() => { panel.classList.add("open"); ovl.classList.add("open"); });
  panel.innerHTML = `<div class="p-in">
    <div class="p-top"><button class="p-close" aria-label="Schließen">✕</button>
      <div class="p-title"><h2>${esc(item.n)}</h2>
        <div class="p-sub"><span class="sg-sym">${esc(item.s)}</span>${item.e ? `<span class="tag">${esc(item.e)}</span>` : ""}${item.c ? `<span class="tag">${esc(item.c)}</span>` : ""}</div></div></div>
    <p style="margin-top:26px;color:var(--muted)"><span class="spin"></span>&nbsp; Kursdaten und Kennzahlen werden geladen …</p></div>`;
  panel.querySelector(".p-close").onclick = closeDetail;
  try {
    const cached = analysisCache.get(item.s);
    let chart, fund, a;
    if (cached && Date.now() - cached.t < 10 * 60 * 1000) ({ chart, fund, a } = cached);
    else {
      const bench = await loadBenchmark();
      chart = await loadChart(item.s);
      fund = await loadFundamentals(item.s, chart.meta && chart.meta.currency).catch(() => null);
      a = analyse(chart, fund, bench);
      analysisCache.set(item.s, { chart, fund, a, t: Date.now() });
    }
    await fxEnsure(chart.meta.currency);
    renderDetail(item, chart, fund, a);
  } catch (e) {
    panel.querySelector(".p-in").innerHTML += `<div class="notice">Daten für <b>${esc(item.s)}</b> sind gerade nicht erreichbar. Das passiert gelegentlich bei den kostenlosen Datenwegen – bitte in ein paar Sekunden erneut öffnen.</div>`;
  }
}

function renderDetail(item, chart, fund, a) {
  const cur = chart.meta.currency || "";
  const fav = Favs.has(item.s);
  const z = a.zones;
  const zoneHtml = buildZoneBand(a, cur);
  const asof = new Date(chart.t[chart.t.length - 1]).toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });

  const compRows = obj => Object.entries(obj).map(([k, v]) => {
    const val = v && typeof v === "object" ? v.v : v;
    return `<div class="cmp"><span>${k}</span><div class="bar"><i style="width:${val ?? 0}%;${val==null?"background:var(--faint)":""}"></i></div><b>${val == null ? "–" : Math.round(val)}</b></div>`;
  }).join("");

  panel.innerHTML = `<div class="p-in">
    <div class="p-top">
      <button class="p-close" aria-label="Schließen">✕</button>
      <div class="p-title"><h2>${esc(item.n)}</h2>
        <div class="p-sub"><span class="sg-sym">${esc(item.s)}</span>
          ${item.e ? `<span class="tag">${esc(item.e)}</span>` : ""}${item.c ? `<span class="tag">${esc(item.c)}</span>` : ""}
          <span class="tag">${esc(cur || "?")}</span></div></div>
      <button class="p-fav${fav ? " on" : ""}">${fav ? "✓ Favorit" : "+ Favorit"}</button>
    </div>

    <div class="p-priceline">
      <span class="p-price">${money(a.price, cur)}</span>
      <span class="p-chg ${chgCls(a.dayChg)}">${fmtPct(a.dayChg)}</span>
      <span class="p-asof">Stand ${asof} · i. d. R. 15 Min. verzögert</span>
    </div>
    ${fxBanner(cur)}

    <button class="p-dossier">Analyse-Dossier erstellen
      <small>16-Phasen-Bericht: Risikometriken, Faktoren, Konsens &amp; Katalysatoren – mit klarer Kennzeichnung, was berechnet, abgerufen und selbst zu beurteilen ist</small>
    </button>

    <button class="p-xlsx">Bewertungsmodell als Tabelle (.xlsx)
      <small>DCF, WACC, Multiplikatoren und Sensitivitätsmatrix mit echten Formeln – Annahmen änderbar, öffnet in Numbers und Excel</small>
    </button>

    <div class="blk">
      <h3>Einstiegs- &amp; Ausstiegszonen</h3>
      <span class="zb-status ${a.trendUp ? "up" : "wait"}">${a.trendUp
        ? "Aufwärtstrend intakt – Zonen aktiv"
        : "Kein bestätigter Aufwärtstrend – beobachten statt einsteigen"}</span>
      ${zoneHtml}
      <div class="crv">
        <div class="pill">Stop-Idee<b>${money(z.stop, cur)}</b></div>
        <div class="pill">Einstiegszone${infoIcon("einstiegszone")}<b>${moneyNum(z.entryLow, cur, z.entryLow < 10 ? 2 : 1)} – ${money(z.entryHigh, cur, z.entryHigh < 10 ? 2 : 1)}</b></div>
        <div class="pill">Ziel 1 (Widerstand)<b>${money(z.t1, cur)}</b></div>
        <div class="pill">Ziel 2<b>${money(z.t2, cur)}</b></div>
        <div class="pill">Chance/Risiko<b>${z.crv ? z.crv.toFixed(1).replace(".", ",") + " : 1" : "–"}</b></div>
      </div>
      ${!a.trendUp ? `<div class="notice">Profis kaufen selten gegen den Trend: Erst wenn der Kurs die 200-Tage-Linie (${money(a.s200, cur)}) nachhaltig zurückerobert, gewinnen Einstiegszonen an Aussagekraft.</div>` : ""}
      ${z.crv != null && z.crv < 2 && a.trendUp ? `<div class="notice">Chance/Risiko liegt unter 2:1 – viele Profis warten in so einem Fall auf einen Rücklauf in die Einstiegszone, statt zum aktuellen Kurs zu kaufen.</div>` : ""}
    </div>

    <div class="blk">
      <h3>Bewertung in zwei Dimensionen</h3>
      <div class="sc-grid">
        <div class="sc-card">
          <div class="sc-head"><h4>Timing / Momentum${infoIcon("timing")}</h4><b>${a.timing ?? "–"}</b></div>
          ${compRows(a.comps)}
        </div>
        <div class="sc-card">
          <div class="sc-head"><h4>Qualität / Bewertung${infoIcon("qualitaet")}</h4><b class="${a.quality == null ? "na" : ""}">${a.quality ?? "n. v."}</b></div>
          ${a.qcomps ? compRows(a.qcomps) : `<p style="font-size:12.5px;color:var(--muted)">Fundamentaldaten sind für diesen Titel über die freien Datenwege gerade nicht abrufbar. Der Timing-Score bleibt davon unberührt.</p>`}
        </div>
      </div>
    </div>

    <div class="blk">
      <h3>Kursverlauf</h3>
      <div class="chart-tools">
        <button class="rbtn" data-d="126">6 M</button>
        <button class="rbtn on" data-d="252">1 J</button>
        <button class="rbtn" data-d="504">2 J</button>
        <span class="chart-tools-sep"></span>
        <button class="mbtn on" data-m="candle">Kerzen</button>
        <button class="mbtn" data-m="line">Linie</button>
      </div>
      <div class="chartbox"><canvas id="cv"></canvas></div>
    </div>

    <div class="blk">
      <h3>Kennzahlen</h3>
      <div class="kv">
        <div class="k"><span>52-Wochen-Spanne</span><b>${moneyNum(a.lo52, cur, 1)} – ${moneyNum(a.hi52, cur, 1)}</b></div>
        <div class="k"><span>Abstand 52-W-Hoch${infoFuer("Abstand 52-W-Hoch")}</span><b class="${chgCls(a.price / a.hi52 - 1)}">${fmtPct(a.price / a.hi52 - 1)}</b></div>
        <div class="k"><span>RSI (14)${infoFuer("RSI (14)")}</span><b>${a.rsi != null ? Math.round(a.rsi) : "–"}</b></div>
        <div class="k"><span>Rendite 3 Mon.</span><b class="${chgCls(a.r63)}">${fmtPct(a.r63)}</b></div>
        <div class="k"><span>Rendite 6 Mon.</span><b class="${chgCls(a.r126)}">${fmtPct(a.r126)}</b></div>
        <div class="k"><span>Rel. Stärke 3 M vs. Welt${infoFuer("Rel. Stärke 3 M vs. Welt")}</span><b class="${chgCls(a.rel)}">${fmtPct(a.rel)}</b></div>
        ${fund ? `
        <div class="k"><span>Marktkapitalisierung${infoFuer("Marktkapitalisierung")}</span><b>${moneyBig(fund.marketCap, cur)}</b></div>
        <div class="k"><span>KGV (erwartet)${infoFuer("KGV (erwartet)")}</span><b>${fund.forwardPE ? fmtNum(fund.forwardPE, null, 1) : "–"}</b></div>
        <div class="k"><span>Operative Marge${infoFuer("Operative Marge")}</span><b>${fmtPct(fund.opMargin, false)}</b></div>
        <div class="k"><span>Umsatzwachstum${infoFuer("Umsatzwachstum")}</span><b class="${chgCls(fund.revGrowth)}">${fmtPct(fund.revGrowth)}</b></div>
        <div class="k"><span>Eigenkapitalrendite${infoFuer("Eigenkapitalrendite")}</span><b>${fmtPct(fund.roe, false)}</b></div>
        <div class="k"><span>Dividendenrendite${infoFuer("Dividendenrendite")}</span><b>${fmtPct(fund.divYield, false)}</b></div>
        <div class="k"><span>Analysten-Kursziel Ø${infoFuer("Analysten-Kursziel Ø")}</span><b>${fund.targetMean ? money(fund.targetMean, cur) : "–"}</b></div>
        <div class="k"><span>Beta${infoFuer("Beta")}</span><b>${fund.beta ? fmtNum(fund.beta, null, 2) : "–"}</b></div>` : ""}
      </div>
    </div>

    <div class="blk">
      <h3>So liest du diese Seite</h3>
      <div class="hintlist">
        <p><b>Qualität</b> beantwortet „Ist das ein gutes Unternehmen zu vernünftigem Preis?" – aus Margen, Wachstum, Verschuldung, Cashflow und Bewertung.</p>
        <p><b>Timing</b> beantwortet „Ist jetzt ein sinnvoller Zeitpunkt?" – aus Trend (gleitende Durchschnitte), Momentum, RSI, relativer Stärke und Volumen.</p>
        <p>Die <b>Einstiegszone</b> liegt zwischen der nächsten Unterstützung bzw. dem gleitenden Durchschnitt und dem aktuellen Kurs; der <b>Stop</b> knapp darunter. Ziel 1 ist der nächste Widerstand. Profis handeln bevorzugt Konstellationen mit Chance/Risiko ab etwa 2:1.</p>
        <p>Automatisch berechnete Zonen sind Orientierung, kein Ersatz für eigenes Urteil – Termine wie Quartalszahlen können jede Zone über Nacht entwerten.</p>
      </div>
    </div>
  </div>`;

  panel.querySelector(".p-close").onclick = closeDetail;
  const favBtn = panel.querySelector(".p-fav");
  favBtn.onclick = () => {
    if (Favs.has(item.s)) { Favs.remove(item.s); favBtn.classList.remove("on"); favBtn.textContent = "+ Favorit"; }
    else { Favs.add(item); favBtn.classList.add("on"); favBtn.textContent = "✓ Favorit"; }
  };
  const xlsxBtn = panel.querySelector(".p-xlsx");
  if (xlsxBtn) xlsxBtn.onclick = () => vxExport(item, chart, fund, a, xlsxBtn);
  const dossierBtn = panel.querySelector(".p-dossier");
  if(dossierBtn) dossierBtn.onclick = () => openDossier(item);
  let curDays = 252, curMode = "candle";
  const draw = () => drawChart(chart, a, curDays, curMode);
  panel.querySelectorAll(".rbtn").forEach(b => b.onclick = () => {
    panel.querySelectorAll(".rbtn").forEach(x => x.classList.remove("on"));
    b.classList.add("on"); curDays = +b.dataset.d; draw();
  });
  panel.querySelectorAll(".mbtn").forEach(b => b.onclick = () => {
    panel.querySelectorAll(".mbtn").forEach(x => x.classList.remove("on"));
    b.classList.add("on"); curMode = b.dataset.m; draw();
  });
  draw();
}

/* Zonen-Band (Signaturelement) */
function buildZoneBand(a, cur) {
  const z = a.zones;
  const lo = z.stop * 0.985, hi = Math.max(z.t2, a.price) * 1.015;
  const pos = v => clamp((v - lo) / (hi - lo) * 100, 0, 100);
  const f = v => moneyNum(v, cur, v < 20 ? 2 : v < 200 ? 1 : 0);
  const seg = (x1, x2, color, op) => `<div class="zb-seg" style="left:${pos(x1)}%;width:${pos(x2)-pos(x1)}%;background:${color};opacity:${op}"></div>`;
  return `<div class="zb">
    <div class="zb-track">
      ${seg(lo, z.stop, "var(--down)", .55)}
      ${seg(z.entryLow, z.entryHigh, "var(--accent)", .8)}
      ${seg(z.t1, hi, "var(--up)", .45)}
    </div>
    <div class="zb-mark" style="left:${pos(z.stop)}%;background:var(--down)"></div>
    <div class="zb-mark zb-price-mark" style="left:${pos(a.price)}%"></div>
    <div class="zb-mark" style="left:${pos(z.t1)}%;background:var(--up)"></div>
    <div class="zb-lab top" style="left:${pos(z.stop)}%">Stop<b>${f(z.stop)}</b></div>
    <div class="zb-lab bot" style="left:${pos((z.entryLow+z.entryHigh)/2)}%">Einstiegszone<b>${f(z.entryLow)}–${f(z.entryHigh)}</b></div>
    <div class="zb-lab top" style="left:${pos(a.price)}%">Kurs<b>${f(a.price)}</b></div>
    <div class="zb-lab bot" style="left:${pos(z.t1)}%">Ziel 1<b>${f(z.t1)}</b></div>
    <div class="zb-lab top" style="left:${pos(z.t2)}%">Ziel 2<b>${f(z.t2)}</b></div>
  </div>
  <div class="zb-legend">
    <span><i style="background:var(--down);opacity:.55"></i>unter Stop</span>
    <span><i style="background:var(--accent)"></i>Einstiegszone${infoIcon("einstiegszone")}</span>
    <span><i style="background:var(--up);opacity:.45"></i>Zielbereich${infoIcon("ziel")}</span>
  </div>`;
}

/* Chart */
function drawChart(chart, a, days, mode = "candle") {
  const n = chart.c.length, from = Math.max(0, n - days);
  const cv = $("#cv");
  if (chartObj) chartObj.destroy();

  const gd = "#93A0B0", grid = "rgba(49,59,73,.5)", axis = "#6B7787";
  const tooltip = { backgroundColor: "#202833", borderColor: "#313B49", borderWidth: 1,
                    titleColor: "#E9EDF3", bodyColor: "#93A0B0" };

  /* Kerzenmodus: echtes OHLC je Handelstag. Financial-Erweiterung + Zeitachse. */
  if (mode === "candle" && chart.o && chart.o.length) {
    const ohlc = [];
    for (let i = from; i < n; i++) {
      ohlc.push({ x: chart.t[i], o: chart.o[i], h: chart.h[i], l: chart.l[i], c: chart.c[i] });
    }
    const smaPoints = w => {
      const pts = [];
      for (let i = from; i < n; i++) {
        pts.push({ x: chart.t[i], y: i + 1 >= w ? sma(chart.c.slice(0, i + 1), w) : null });
      }
      return pts;
    };
    chartObj = new Chart(cv, {
      /* Der Typ MUSS hier stehen, nicht nur am Datensatz. Steht er allein am
         Datensatz, greift die Zerlegung der Financial-Erweiterung nicht: Chart.js
         parst dann nur x und setzt y auf null. Die Y-Skala faellt mangels Werten
         auf 0 bis 1 zurueck, jeder Kurs landet weit ausserhalb - gezeichnet wurde
         auf Position -32768, also unsichtbar. Die Kerzen waren die ganze Zeit da,
         nur nicht im Bild. Zusaetzliche Linien-Datensaetze (GD 50/200) vertragen
         sich damit, sie tragen ihren eigenen Typ. */
      type: "candlestick",
      data: { datasets: [
        { label: "Kurs", data: ohlc,
          color: { up: "#4FB8AC", down: "#D66A6A", unchanged: "#93A0B0" },
          borderColor: { up: "#4FB8AC", down: "#D66A6A", unchanged: "#93A0B0" } },
        { type: "line", label: "GD 50", data: smaPoints(50), borderColor: "#E0B45C",
          borderWidth: 1.2, pointRadius: 0, borderDash: [5, 4], spanGaps: true },
        { type: "line", label: "GD 200", data: smaPoints(200), borderColor: "#8AA0C0",
          borderWidth: 1.2, pointRadius: 0, borderDash: [2, 3], spanGaps: true },
      ]},
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        plugins: { legend: { labels: { color: gd, boxWidth: 18, font: { family: "Inter", size: 11 } } },
          tooltip: { ...tooltip, callbacks: {
            /* Die Erweiterung liefert "O: 215.53 H: ..." im englischen
               Zahlenformat. In einer sonst durchgehend deutschen Oberflaeche
               liest sich das als Tausendertrennung falsch. */
            title: p => p.length
              ? new Date(p[0].parsed.x).toLocaleDateString("de-DE",
                  { day: "2-digit", month: "long", year: "numeric" })
              : "",
            label: p => {
              const d = p.parsed;
              if (d == null || d.o == null) return "";
              const w = (chart.meta && chart.meta.currency) || "";
              const z = v => money(v, w, 2);
              return [`Eröffnung ${z(d.o)}`, `Hoch ${z(d.h)}`,
                      `Tief ${z(d.l)}`, `Schluss ${z(d.c)}`];
            },
          } },
        },
        scales: {
          x: { type: "time", time: { unit: days > 300 ? "month" : "week" },
               ticks: { color: axis, maxTicksLimit: 8, font: { family: "IBM Plex Mono", size: 10 } },
               grid: { display: false } },
          y: { ticks: { color: axis, font: { family: "IBM Plex Mono", size: 10 } },
               grid: { color: grid } },
        },
      },
    });
    return;
  }

  /* Linienmodus (unverändert): Schlusskurs plus gleitende Durchschnitte. */
  const labels = chart.t.slice(from).map(t => new Date(t).toLocaleDateString("de-DE", { month: "short", year: "2-digit" }));
  const smaSeries = w => chart.c.map((_, i) => i + 1 >= w ? sma(chart.c.slice(0, i + 1), w) : null).slice(from);
  chartObj = new Chart(cv, {
    type: "line",
    data: { labels, datasets: [
      { label: "Kurs", data: chart.c.slice(from), borderColor: "#E9EDF3", borderWidth: 1.7, pointRadius: 0, tension: .15 },
      { label: "GD 50", data: smaSeries(50), borderColor: "#4FB8AC", borderWidth: 1.2, pointRadius: 0, borderDash: [5, 4] },
      { label: "GD 200", data: smaSeries(200), borderColor: "#E0B45C", borderWidth: 1.2, pointRadius: 0, borderDash: [2, 3] },
    ]},
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { labels: { color: gd, boxWidth: 18, font: { family: "Inter", size: 11 } } },
        tooltip },
      scales: {
        x: { ticks: { color: axis, maxTicksLimit: 8, font: { family: "IBM Plex Mono", size: 10 } }, grid: { display: false } },
        y: { ticks: { color: axis, font: { family: "IBM Plex Mono", size: 10 } }, grid: { color: grid } },
      },
    },
  });
}


/* ===== Analyse-Dossier – Modul ===== */
/* =====================================================================
   ANALYSE-DOSSIER  ·  16-Phasen-Struktur nach institutionellem Vorbild
   Herkunft jeder Sektion transparent gekennzeichnet:
     [GERECHNET]  aus echter Kurs-/Kennzahlenbasis berechnet
     [ABGERUFEN]  live von der Datenquelle geholt
     [EINSCHÄTZUNG] qualitatives Urteil – bewusst nicht automatisch ausgefüllt
   ===================================================================== */

/* ---------- Rechenkerne (referenzgetestet) ---------- */
function dsReturns(c){const r=[];for(let i=1;i<c.length;i++)r.push(c[i]/c[i-1]-1);return r;}
const dsMean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const dsStd=a=>{if(a.length<2)return 0;const m=dsMean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
function dsEma(arr,n){const k=2/(n+1);let e=arr[0];const out=[e];for(let i=1;i<arr.length;i++){e=arr[i]*k+e*(1-k);out.push(e);}return out;}
function dsMacd(c){if(c.length<35)return null;const e12=dsEma(c,12),e26=dsEma(c,26);const line=c.map((_,i)=>e12[i]-e26[i]);const sig=dsEma(line,9);return{line:line.at(-1),signal:sig.at(-1),hist:line.at(-1)-sig.at(-1)};}
function dsAtr(h,l,c,n=14){if(c.length<n+1)return null;const tr=[];for(let i=1;i<c.length;i++)tr.push(Math.max(h[i]-l[i],Math.abs(h[i]-c[i-1]),Math.abs(l[i]-c[i-1])));return dsMean(tr.slice(-n));}
function dsBoll(c,n=20){if(c.length<n)return null;const s=c.slice(-n);const m=dsMean(s),sd=dsStd(s);const w=4*sd||1;return{mid:m,up:m+2*sd,low:m-2*sd,pctB:(c.at(-1)-(m-2*sd))/w};}

function dsRisk(chart,bench,rf=0.04){
  const rets=dsReturns(chart.c),A=252;
  if(rets.length<20)return null;
  const mu=dsMean(rets)*A, vol=dsStd(rets)*Math.sqrt(A);
  const sharpe=vol>0?(mu-rf)/vol:null;
  const tgt=rf/A;
  const dsd=Math.sqrt(rets.map(r=>Math.min(0,r-tgt)**2).reduce((a,b)=>a+b,0)/rets.length)*Math.sqrt(A);
  const sortino=dsd>0?(mu-rf)/dsd:null;
  let peak=chart.c[0],maxDD=0;for(const p of chart.c){if(p>peak)peak=p;const d=p/peak-1;if(d<maxDD)maxDD=d;}
  const sorted=[...rets].sort((a,b)=>a-b);const qi=Math.max(0,Math.floor(0.05*sorted.length)-1);
  const var95=sorted[qi], cvar95=dsMean(sorted.slice(0,qi+1));
  let beta=null,corr=null;
  if(bench&&bench.c&&bench.c.length>30){
    const n=Math.min(chart.c.length,bench.c.length);
    const rp=dsReturns(chart.c.slice(-n)),rm=dsReturns(bench.c.slice(-n));
    const m=Math.min(rp.length,rm.length),a=rp.slice(-m),b=rm.slice(-m);
    const ma=dsMean(a),mb=dsMean(b);let cov=0,vm=0,va=0;
    for(let i=0;i<m;i++){cov+=(a[i]-ma)*(b[i]-mb);vm+=(b[i]-mb)**2;va+=(a[i]-ma)**2;}
    cov/=(m-1);vm/=(m-1);beta=vm>1e-9?cov/vm:null;
    const sa=Math.sqrt(va/(m-1)),sb=Math.sqrt(vm);corr=(sa*sb)>0?cov/(sa*sb):null;
  }
  return{annReturn:mu,vol,sharpe,sortino,maxDD,var95,cvar95,beta,corr,rf};
}

/* ---------- Faktor-Scores (0..100, relativ) ---------- */
function dsFactors(chart,fund,risk,deep){
  const c=chart.c;
  const r126=c.length>126?c.at(-1)/c[c.length-127]-1:null;
  const r252=c.length>252?c.at(-1)/c[c.length-253]-1:null;
  const f={};
  // Value: je niedriger Bewertung, desto besser
  const valBits=[];
  if(fund){
    if(fund.forwardPE>0)valBits.push(100-lin(fund.forwardPE,9,45));
    if(fund.peg>0)valBits.push(100-lin(fund.peg,0.8,3));
    if(fund.priceToSales>0)valBits.push(100-lin(fund.priceToSales,1,10));
  }
  if(deep){
    const pb=deep.priceToBook, ev=deep.evEbitda, ps=deep.priceToSales;
    if(pb>0)valBits.push(100-lin(pb,1,8));
    if(ev>0)valBits.push(100-lin(ev,6,28));
    if(ps>0&&!(fund&&fund.priceToSales>0))valBits.push(100-lin(ps,1,10));
  }
  f.Value=valBits.length?Math.round(dsMean(valBits)):null;
  // Quality
  const qBits=[];
  if(fund){
    if(fund.roe!=null)qBits.push(lin(fund.roe,0,0.30));
    if(fund.opMargin!=null)qBits.push(lin(fund.opMargin,0,0.30));
    if(fund.debtToEquity!=null)qBits.push(100-lin(fund.debtToEquity,20,220));
  }
  f.Quality=qBits.length?Math.round(dsMean(qBits)):null;
  // Momentum
  const mBits=[];
  if(r126!=null)mBits.push(lin(r126,-0.25,0.35));
  if(r252!=null)mBits.push(lin(r252,-0.35,0.55));
  f.Momentum=mBits.length?Math.round(dsMean(mBits)):null;
  // Growth
  f.Growth=fund&&fund.revGrowth!=null?Math.round(lin(fund.revGrowth,-0.05,0.30)):null;
  // Profitability
  f.Profitabilität=fund&&fund.profitMargin!=null?Math.round(lin(fund.profitMargin,0,0.25)):null;
  // Low Volatility (niedrige Vola = hoher Score)
  f["Low Vola"]=risk&&risk.vol!=null?Math.round(100-lin(risk.vol,0.12,0.55)):null;
  return f;
}

/* ---------- Erweiterte Daten fuers Dossier ----------
   Frueher kamen sie aus Yahoos quoteSummary mit neun Modulen. Der Weg ist seit
   der Crumb-Pflicht tot: Ueber einen CORS-Zwischenweg antwortet er ausnahmslos
   "Invalid Crumb". Er lieferte also nichts, blockierte aber beim Oeffnen eines
   Dossiers zwei Hosts mal fuenf Zwischenwege lang. Die Kennzahlen stehen
   ohnehin in derselben Quelle, aus der auch die Bewertung stammt - von dort
   werden sie jetzt uebernommen. Was es dort nicht gibt (Analystenzahl,
   Empfehlungsverlauf, Insiderkaeufe, Termin der naechsten Zahlen), bleibt leer
   und wird im Dossier als "nicht verfuegbar" gekennzeichnet - so, wie es die
   uebrigen Abschnitte auch handhaben. */
async function dsLoadDeep(symbol){
  const key="deep."+symbol;
  const cached=Cache.get(key,6*60*60*1000);
  if(cached)return cached==="none"?null:cached;

  let m=null;
  try{
    const e=Fundamentals.get(symbol);
    m=(e&&e.markt)||await loadMarktLive(symbol);
  }catch(err){ m=null; }
  if(!m){ Cache.set(key,"none"); return null; }

  const z=v=>(typeof v==="number"&&isFinite(v))?v:null;
  const out={
    priceToBook:z(m.pbRatio), evEbitda:z(m.evEbitda), evSales:z(m.evSales),
    priceToSales:z(m.psRatio), pegForward:z(m.peg),
    targetLow:null, targetMean:z(m.targetMean), targetHigh:null,
    recKey:m.recommendation?String(m.recommendation).toLowerCase().replace(/\s+/g,"_"):null,
    numAnalysts:null, recTrend:null,
    earningsDate:null,
    instHold:z(m.institutionenAnteil)??z(m.instHold),
    insiderHold:z(m.insiderAnteil)??z(m.insiderHold),
    insiderNet:null, epsFwd:null,
    quelle:m.source||m.quelle||"stockanalysis.com",
  };
  Cache.set(key,out);
  return out;
}
async function dsLoadNews(symbol){
  const key="news."+symbol;
  const cached=Cache.get(key,60*60*1000);
  if(cached)return cached;
  try{
    const url=`https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&newsCount=6&quotesCount=0&enableFuzzyQuery=false`;
    const data=await fetchJson(url,d=>d&&Array.isArray(d.news),9000);
    const out=data.news.slice(0,6).map(n=>({title:n.title,pub:n.publisher,link:n.link,ts:n.providerPublishTime}));
    Cache.set(key,out);return out;
  }catch(e){return [];}
}

/* ---------- Herkunfts-Badge ---------- */
function dsBadge(kind){
  const map={calc:["GERECHNET","dsb-calc"],fetch:["ABGERUFEN","dsb-fetch"],judge:["DEINE EINSCHÄTZUNG","dsb-judge"],partial:["TEILWEISE · DATEN FEHLEN","dsb-part"]};
  const[t,cls]=map[kind]||map.judge;return `<span class="dsb ${cls}">${t}</span>`;
}
function dsRow(label,val,note){return `<div class="dsr"><span>${label}${infoFuer(label)}</span><b>${val}</b>${note?`<i>${note}</i>`:""}</div>`;}
function dsInterpret(cond,pos,neg,neutral){return cond==null?(neutral||"–"):cond?pos:neg;}

/* ---------- Dossier zusammenbauen ---------- */
function buildDossier(item,chart,fund,a,deep,news,bench,demo,scores){
  const cur=chart.meta.currency||"";
  const risk=dsRisk(chart,bench);
  const fac=dsFactors(chart,fund,risk,deep);
  const price=a.price;
  const fN=(v,d)=>fmtNum(v,null,d);
  const money2=(v,d)=>money(v,cur,d);
  const P=v=>fmtPct(v);
  const Pu=v=>fmtPct(v,false);

  const naFetch=demo?`<p class="dsna">Live-Abruf im Vorschaumodus deaktiviert – in der echten Version erscheinen hier abgerufene Marktdaten.</p>`
                    :`<p class="dsna">Für diesen Titel über die freien Datenwege gerade nicht abrufbar.</p>`;

  /* Konsens-Balken */
  let consensus="";
  if(deep&&deep.recTrend&&(deep.recTrend.buy+deep.recTrend.hold+deep.recTrend.sell)>0){
    const t=deep.recTrend,sum=t.buy+t.hold+t.sell;
    consensus=`<div class="dscons"><div class="dscons-bar">
      <span style="width:${t.buy/sum*100}%;background:var(--up)"></span>
      <span style="width:${t.hold/sum*100}%;background:var(--warn)"></span>
      <span style="width:${t.sell/sum*100}%;background:var(--down)"></span></div>
      <div class="dscons-lab"><span>${t.buy}× Kaufen</span><span>${t.hold}× Halten</span><span>${t.sell}× Verkaufen</span></div></div>`;
  }

  /* Szenario-Anker aus Analystenspanne */
  let scenario=`${naFetch}`;
  if(deep&&deep.targetMean){
    const up=v=>v?P(v/price-1):"–";
    /* Tiefst- und Hoechstziel liefert die heutige Quelle nicht. Leere Zeilen
       anzuzeigen taeuscht eine Spanne vor, die nicht vorliegt - deshalb nur,
       was wirklich da ist. */
    const zeile=(name,v,basis)=>v?`<tr><td>${name}</td><td>${money2(v)}</td>
      <td class="${chgCls(v/price-1)}">${up(v)}</td><td>${basis}</td></tr>`:"";
    scenario=`<table class="dstab"><tr><th>Szenario</th><th>Ankerkurs</th><th>Abstand</th><th>Basis</th></tr>
      ${zeile("Bear",deep.targetLow,"Analysten-Tiefstziel")}
      ${zeile("Base",deep.targetMean,"Analysten-Durchschnittsziel")}
      ${zeile("Bull",deep.targetHigh,"Analysten-Höchstziel")}</table>
      <p class="dshint">${(deep.targetLow||deep.targetHigh)?"":"Nur das Durchschnittsziel liegt vor; Tiefst- und Höchstziel sind derzeit nicht abrufbar. "}Ankerpunkte aus dem Analystenkonsens ersetzen keine eigene Szenariorechnung – Eintrittswahrscheinlichkeiten und Begründungen trägst du selbst ein.</p>`;
  }

  /* Technik */
  const mac=dsMacd(chart.c),at=dsAtr(chart.h,chart.l,chart.c),bo=dsBoll(chart.c);

  const facRow=(k)=>`<div class="dsf"><span>${k}</span><div class="dsf-bar"><i style="width:${fac[k]??0}%;${fac[k]==null?'background:var(--faint)':''}"></i></div><b>${fac[k]??"n. v."}</b></div>`;

  /* Orientierungs-Score aus datengestützten Dimensionen */
  const dims=[
    ["Wachstum",fac.Growth],["Profitabilität",fac.Profitabilität],["Bewertung",fac.Value],
    ["Qualität",fac.Quality],["Momentum",fac.Momentum],["Risiko (invers Vola)",fac["Low Vola"]],
    ["Timing",a.timing]
  ].filter(d=>d[1]!=null);
  const orient=dims.length?Math.round(dsMean(dims.map(d=>d[1]))):null;

  return `
  <div class="ds-wrap">
    <div class="ds-head">
      <div>
        <div class="ds-kicker">Analyse-Dossier · 16 Phasen</div>
        <h1>${esc(item.n)}</h1>
        <div class="ds-sub"><span class="sg-sym">${esc(item.s)}</span> · ${esc(cur)} · Stand ${new Date(chart.t.at(-1)).toLocaleDateString("de-DE")}</div>
      </div>
      <div class="ds-actions">
        <button class="ds-print" onclick="window.print()">Drucken / als PDF</button>
        <button class="ds-back">Zurück</button>
      </div>
    </div>

    <div class="ds-legend">
      ${dsBadge("calc")} aus echten Daten berechnet &nbsp;·&nbsp;
      ${dsBadge("fetch")} live abgerufen &nbsp;·&nbsp;
      ${dsBadge("judge")} von dir zu beurteilen
    </div>

    <!-- 1 Executive Summary -->
    <section class="ds-sec"><h2>1 · Executive Summary ${dsBadge("calc")}</h2>
      <div class="ds-cards">
        <div class="ds-c"><span>Kurs</span><b>${money2(price)}</b></div>
        <div class="ds-c"><span>Timing-Score${infoFuer("Timing-Score")}</span><b>${a.timing??"–"}</b></div>
        <div class="ds-c"><span>Qualitäts-Score${infoFuer("Qualitäts-Score")}</span><b>${a.quality??"n. v."}</b></div>
        <div class="ds-c"><span>Sharpe (2 J)${infoFuer("Sharpe (2 J)")}</span><b>${risk&&risk.sharpe!=null?fN(risk.sharpe,2):"–"}</b></div>
        <div class="ds-c"><span>Max. Drawdown${infoFuer("Max. Drawdown")}</span><b class="neg">${risk?P(risk.maxDD):"–"}</b></div>
        <div class="ds-c"><span>Beta${infoFuer("Beta")}</span><b>${risk&&risk.beta!=null?fN(risk.beta,2):(fund&&fund.beta?fN(fund.beta,2):"–")}</b></div>
        <div class="ds-c"><span>Orientierungs-Score</span><b>${orient??"–"}<small>/100</small></b></div>
        <div class="ds-c"><span>Analystenkonsens${infoFuer("Analystenkonsens")}</span><b>${deep&&deep.recKey?esc(deep.recKey):"–"}</b></div>
      </div>
      <p class="dshint">Der Orientierungs-Score mittelt nur die datengestützten Dimensionen. Er ist ein Ausgangspunkt für dein Urteil – keine Kauf- oder Verkaufsempfehlung.</p>
    </section>

    <!-- 2 Investmentthese -->
    <section class="ds-sec"><h2>2 · Investmentthese ${dsBadge("judge")}</h2>
      <div class="ds-fill">
        <p><b>Warum könnte der Markt falsch liegen?</b> ${dsInterpret(fund&&fund.forwardPE!=null, `Aktuelle Bewertung (KGVe ${fund?fN(fund.forwardPE,1):'–'}) und Wachstum (${fund?P(fund.revGrowth):'–'}) als Ausgangspunkt – Bewertungslücke selbst begründen.`,"","Bewertungsdaten fehlen – These qualitativ formulieren.")}</p>
        <p><b>Katalysator?</b> ${deep&&deep.earningsDate?`Nächste Quartalszahlen am ${new Date(deep.earningsDate*1000).toLocaleDateString("de-DE")}.`:"Nächsten Auslöser (Zahlen, Produkt, Regulierung) selbst benennen."}</p>
        <p><b>Wann scheitert die These?</b> <span class="dsblank">zu beantworten</span></p>
        <p><b>Entscheidende Annahmen?</b> <span class="dsblank">zu beantworten</span></p>
      </div>
    </section>

    <!-- 3 Makro -->
    <section class="ds-sec"><h2>3 · Makroanalyse ${dsBadge("judge")}</h2>
      <p class="dsna">Makrodaten (Zinsen, Inflation, Zyklus) liegen außerhalb der Kursquelle. Betaewert ${risk&&risk.beta!=null?fN(risk.beta,2):"–"} zeigt die Marktsensitivität: ${dsInterpret(risk&&risk.beta!=null, risk&&risk.beta>1.1?"überdurchschnittlich zyklisch – makroabhängig.":"eher defensiv gegenüber dem Gesamtmarkt.","", "")}</p>
    </section>

    <!-- 4 Branche -->
    <section class="ds-sec"><h2>4 · Branchenanalyse ${dsBadge("partial")}</h2>
      <div class="ds-grid2">${dsRow("Sektor",esc(item.sec||"–"))}</div>
      <p class="dshint">TAM/SAM/SOM, Porter's Five Forces und Wettbewerbsposition erfordern qualitative Recherche – Sektorzuordnung als Startpunkt.</p>
    </section>

    <!-- 5 Unternehmensqualität -->
    <section class="ds-sec"><h2>5 · Unternehmensqualität ${dsBadge("calc")}</h2>
      <div class="ds-grid2">
        ${dsRow("Operative Marge",fund?Pu(fund.opMargin):"n. v.",dsInterpret(fund&&fund.opMargin!=null,fund&&fund.opMargin>0.15?"solide":"dünn","",""))}
        ${dsRow("Eigenkapitalrendite",fund?Pu(fund.roe):"n. v.",dsInterpret(fund&&fund.roe!=null,fund&&fund.roe>0.15?"stark":"schwach","",""))}
        ${dsRow("Nettomarge",fund?Pu(fund.profitMargin):"n. v.")}
        ${dsRow("Verschuldung (D/E)",fund&&fund.debtToEquity!=null?fN(fund.debtToEquity,0):"n. v.",dsInterpret(fund&&fund.debtToEquity!=null,fund&&fund.debtToEquity<100?"moderat":"hoch","",""))}
      </div>
      <p class="dshint">Managementqualität, Moat-Tiefe und Kapitalallokation ${dsBadge("judge")} – aus Geschäftsbericht und Historie selbst beurteilen.</p>
    </section>

    <!-- 6 Finanzanalyse -->
    <section class="ds-sec"><h2>6 · Finanzanalyse ${dsBadge("calc")}</h2>
      <div class="ds-grid2">
        ${dsRow("Umsatzwachstum",fund?P(fund.revGrowth):"n. v.")}
        ${dsRow("Free Cash Flow",fund?fmtBig(fund.fcf):"n. v.")}
        ${dsRow("FCF-Rendite",fund&&fund.fcf&&fund.marketCap?Pu(fund.fcf/fund.marketCap):"n. v.")}
        ${dsRow("Bruttomarge",fund&&fund.grossMargin!=null?Pu(fund.grossMargin):"n. v.")}
        ${dsRow("Dividendenrendite",fund?Pu(fund.divYield):"n. v.")}
        ${dsRow("Marktkapitalisierung",fund?moneyBig(fund.marketCap,cur):"n. v.")}
      </div>
      <p class="dshint">Mehrjahres-Trends (5–10 J), ROIC und Cash Conversion Cycle brauchen Historiendaten, die die freie Quelle nicht liefert ${dsBadge("judge")}.</p>
    </section>

    <!-- 7 Bilanzqualität -->
    <section class="ds-sec"><h2>7 · Bilanzqualität ${scores && (scores.piotroski != null || scores.altmanZ != null) ? dsBadge("calc") : dsBadge("partial")}</h2>
      <div class="ds-grid2">
        ${dsRow("Verschuldung (D/E)", fund && fund.debtToEquity != null ? fN(fund.debtToEquity, 0) : "n. v.")}
        ${scores && scores.piotroski != null
          ? dsRow("Piotroski F-Score", scores.piotroski + " / " + scores.piotroskiMax,
                  scores.piotroski >= 7 ? "stark" : scores.piotroski >= 4 ? "solide" : "schwach")
          : ""}
        ${scores && scores.altmanZ != null
          ? dsRow("Altman Z-Score", fN(scores.altmanZ, 2) + (scores.altmanCapped ? " (gedeckelt)" : ""),
                  scores.altmanZone === "sicher" ? "geringe Insolvenzgefahr"
                  : scores.altmanZone === "grau" ? "Graubereich" : "erhöhtes Risiko")
          : ""}
      </div>
      ${scores && (scores.piotroski != null || scores.altmanZ != null)
        ? `<p class="dshint">Berechnet aus Bilanzdaten (${esc(scores.source)}) ${dsBadge("calc")}.
           ${scores.altmanCapped ? "Der Marktwert-Term des Altman-Z ist gedeckelt, da die Bewertung sehr hoch ist – bei Wachstumswerten ist der Z-Score nur eingeschränkt aussagekräftig. " : ""}
           ${scores.piotroskiMax < 9 ? "Piotroski aus " + scores.piotroskiMax + " von 9 Kriterien, soweit die Datenlage reicht. " : ""}
           Beneish M-Score erfordert weitere Detailposten und bleibt offen ${dsBadge("judge")}.</p>`
        : `<p class="dsna">Piotroski F-Score, Altman Z-Score und Beneish M-Score erfordern Mehrjahres-Bilanzen. Für diesen Titel liegen aktuell keine Bilanzdaten vor – Felder bewusst offen statt mit Schätzwerten gefüllt.</p>`}
    </section>

    <!-- 8 Bewertung -->
    <section class="ds-sec"><h2>8 · Bewertungsanalyse ${dsBadge("calc")} ${dsBadge("fetch")}</h2>
      <div class="ds-grid2">
        ${dsRow("KGV (erwartet)",fund&&fund.forwardPE?fN(fund.forwardPE,1):"n. v.")}
        ${dsRow("KGV (aktuell)",fund&&fund.trailingPE?fN(fund.trailingPE,1):"n. v.")}
        ${dsRow("PEG",fund&&fund.peg?fN(fund.peg,2):(deep&&deep.pegForward?fN(deep.pegForward,2):"n. v."))}
        ${dsRow("EV/EBITDA",deep&&deep.evEbitda?fN(deep.evEbitda,1):"n. v.")}
        ${dsRow("KUV",deep&&deep.priceToSales?fN(deep.priceToSales,1):"n. v.")}
        ${dsRow("KBV",deep&&deep.priceToBook?fN(deep.priceToBook,1):"n. v.")}
        ${dsRow("Analysten-Kursziel Ø",deep&&deep.targetMean?money2(deep.targetMean):"n. v.",deep&&deep.targetMean?P(deep.targetMean/price-1)+" Abstand":"")}
      </div>
      ${scores && scores.dcfPerShare != null
        ? `<div class="ds-grid2">
            ${dsRow("DCF fairer Wert (Näherung)", money2(scores.dcfPerShare),
                    P(scores.dcfPerShare / price - 1) + " Abstand")}
          </div>
          <p class="dshint">Vereinfachte DCF-Näherung aus dem operativen Cashflow (${esc(scores.source)}),
           Annahmen offengelegt: ${Pu(scores.dcfAssumptions.growth)} Wachstum,
           ${Pu(scores.dcfAssumptions.discount)} Diskontsatz, ${Pu(scores.dcfAssumptions.terminal)} ewiges Wachstum,
           ${scores.dcfAssumptions.years} Jahre ${dsBadge("calc")}. Bewusst konservativ und kein Ersatz für eine
           eigene Bewertung – die Annahmen bestimmen das Ergebnis maßgeblich ${dsBadge("judge")}.</p>`
        : `<p class="dshint">DCF und Reverse-DCF verlangen Cashflow-Projektionen und einen WACC – für diesen Titel liegen keine ausreichenden Cashflow-Daten vor ${dsBadge("judge")}. Multiplikatoren dienen dem Peer- und Historienvergleich.</p>`}
    </section>

    <!-- 9 Quant-Faktoren -->
    <section class="ds-sec"><h2>9 · Quantitative Faktoren ${dsBadge("calc")}</h2>
      <div class="ds-factors">
        ${["Value","Quality","Momentum","Growth","Profitabilität","Low Vola"].map(facRow).join("")}
      </div>
      <p class="dshint">Relative Faktor-Ausprägungen (0–100) aus den verfügbaren Kennzahlen und der Kurshistorie.</p>
    </section>

    <!-- 10 Sentiment -->
    <section class="ds-sec"><h2>10 · Markt- &amp; Sentimentanalyse ${dsBadge("fetch")}</h2>
      ${deep?`${consensus}
        <div class="ds-grid2">
          ${dsRow("Analystenzahl",deep.numAnalysts??"–")}
          ${dsRow("Empfehlung",deep.recKey?esc(deep.recKey):"–")}
          ${dsRow("Institutioneller Besitz",deep.instHold!=null?Pu(deep.instHold):"–")}
          ${dsRow("Insider-Besitz",deep.insiderHold!=null?Pu(deep.insiderHold):"–")}
        </div>`:naFetch}
    </section>

    <!-- 11 Technik -->
    <section class="ds-sec"><h2>11 · Technische Analyse ${dsBadge("calc")}</h2>
      <div class="ds-grid2">
        ${dsRow("Trend",a.trendUp?"Aufwärts (über GD 200)":"Kein Aufwärtstrend")}
        ${dsRow("GD 50 / 200",fN(a.s50,1)+" / "+fN(a.s200,1))}
        ${dsRow("RSI (14)",a.rsi!=null?Math.round(a.rsi):"–",dsInterpret(a.rsi!=null,a.rsi>70?"überkauft":a.rsi<30?"überverkauft":"neutral","",""))}
        ${dsRow("MACD",mac?fN(mac.hist,2):"–",dsInterpret(mac,mac&&mac.hist>0?"bullish":"bearish","",""))}
        ${dsRow("ATR (14)",at?fN(at,2):"–","Schwankungsbreite")}
        ${dsRow("Bollinger %B",bo?fN(bo.pctB,2):"–",dsInterpret(bo,bo&&bo.pctB>1?"über oberem Band":bo&&bo.pctB<0?"unter unterem Band":"im Band","",""))}
        ${dsRow("52-W-Position",P(price/a.hi52-1)+" zum Hoch")}
      </div>
    </section>

    <!-- 12 Risiko -->
    <section class="ds-sec"><h2>12 · Risikoanalyse ${dsBadge("calc")}</h2>
      ${risk?`<div class="ds-grid2">
        ${dsRow("Volatilität (annual.)",Pu(risk.vol))}
        ${dsRow("Beta",risk.beta!=null?fN(risk.beta,2):"–")}
        ${dsRow("Korrelation z. Welt-Index",risk.corr!=null?fN(risk.corr,2):"–")}
        ${dsRow("Sharpe Ratio",risk.sharpe!=null?fN(risk.sharpe,2):"–",`bei rf ${Pu(risk.rf)}`)}
        ${dsRow("Sortino Ratio",risk.sortino!=null?fN(risk.sortino,2):"–")}
        ${dsRow("Max. Drawdown",P(risk.maxDD))}
        ${dsRow("Value at Risk 95% (1 T)",P(risk.var95))}
        ${dsRow("CVaR 95% (1 T)",P(risk.cvar95))}
      </div>
      <p class="dshint">Risikomaße aus 2 Jahren Tagesrenditen; risikofreier Zins mit ${Pu(risk.rf)} angenommen (transparent gesetzt).</p>`:`<p class="dsna">Zu wenige Kursdaten für Risikoberechnung.</p>`}
    </section>

    <!-- 13 Szenario -->
    <section class="ds-sec"><h2>13 · Szenarioanalyse ${dsBadge("fetch")} ${dsBadge("judge")}</h2>
      ${scenario}
    </section>

    <!-- 14 Katalysatoren -->
    <section class="ds-sec"><h2>14 · Katalysatoren ${dsBadge("fetch")}</h2>
      <div class="ds-grid2">
        ${dsRow("Nächste Quartalszahlen",deep&&deep.earningsDate?new Date(deep.earningsDate*1000).toLocaleDateString("de-DE"):"–")}
      </div>
      ${news&&news.length?`<div class="ds-news"><div class="ds-news-h">Aktuelle Schlagzeilen</div>
        ${news.map(n=>`<a class="ds-nitem" href="${esc(n.link)}" target="_blank" rel="noopener"><span>${esc(n.title)}</span><i>${esc(n.pub||"")}</i></a>`).join("")}</div>`:
        (demo?`<p class="dsna">Schlagzeilen erscheinen in der Live-Version.</p>`:"")}
      <p class="dshint">Weitere Auslöser (M&amp;A, Rückkäufe, Regulierung) nach Eintrittswahrscheinlichkeit selbst einordnen ${dsBadge("judge")}.</p>
    </section>

    <!-- 15 Devil's Advocate -->
    <section class="ds-sec"><h2>15 · Devil's Advocate ${dsBadge("judge")}</h2>
      <div class="ds-fill">
        <p><b>Warum könnte der Markt recht haben?</b> <span class="dsblank">zu beantworten</span></p>
        <p><b>Was spricht gegen das Investment?</b> ${risk&&risk.maxDD<-0.4?`Historischer Drawdown von ${P(risk.maxDD)} zeigt erhebliches Verlustpotenzial.`:'<span class="dsblank">zu beantworten</span>'}</p>
        <p><b>Fragilste Annahme?</b> <span class="dsblank">zu beantworten</span></p>
      </div>
    </section>

    <!-- 16 Entscheidungsmatrix -->
    <section class="ds-sec"><h2>16 · Entscheidungsmatrix ${dsBadge("calc")}</h2>
      <div class="ds-matrix">
        ${dims.map(d=>`<div class="dsf"><span>${d[0]}</span><div class="dsf-bar"><i style="width:${d[1]}%"></i></div><b>${Math.round(d[1]/10)}<small>/10</small></b></div>`).join("")}
      </div>
      <div class="ds-orient">Orientierungs-Score (Mittel der datengestützten Dimensionen): <b>${orient??"–"}/100</b></div>
      <p class="dshint">Diese Matrix fasst nur messbare Dimensionen zusammen. Die Gewichtung, die qualitativen Phasen (Makro, Branche, Management, These) und die finale Entscheidung liegen bei dir. <b>Dies ist keine Anlageberatung.</b></p>
    </section>

    <div class="ds-foot">Erstellt am ${new Date().toLocaleString("de-DE")} · Datenstand ${new Date(chart.t.at(-1)).toLocaleDateString("de-DE")} · Reines Analysewerkzeug, keine Anlageberatung. Kennzahlen können fehlerhaft oder verzögert sein.</div>
  </div>`;
}


/* Dossier öffnen (nutzt vorhandene Analyse, holt Zusatzdaten) */
async function openDossier(item){
  panel.scrollTop = 0;
  panel.innerHTML = `<div class="p-in"><div class="ds-loading"><span class="spin"></span><br><br>Dossier wird erstellt – Kennzahlen werden berechnet und Marktdaten abgerufen …</div></div>`;
  try{
    const cached = analysisCache.get(item.s);
    let chart, fund, a;
    if(cached && Date.now() - cached.t < 10 * 60 * 1000){ ({chart,fund,a} = cached); }
    else{
      const bench = await loadBenchmark();
      chart = await loadChart(item.s);
      fund = await loadFundamentals(item.s, chart.meta && chart.meta.currency).catch(()=>null);
      a = analyse(chart, fund, bench);
      analysisCache.set(item.s,{chart,fund,a,t:Date.now()});
    }
    const bench = await loadBenchmark();
    const [deep, news] = await Promise.all([
      dsLoadDeep(item.s).catch(()=>null),
      dsLoadNews(item.s).catch(()=>[])
    ]);
    await fxEnsure(chart.meta.currency);
    /* Bilanzkennzahlen aus der taeglich erzeugten Datei; Scores daraus rechnen */
    let scores = null;
    try {
      await Fundamentals.load();
      const raw = Fundamentals.get(item.s);
      if (raw) scores = computeScores(raw, { marketCap: fund && fund.marketCap, fcf: fund && fund.fcf });
    } catch (e) { scores = null; }
    const demo = (typeof IS_PREVIEW !== "undefined") && IS_PREVIEW;
    panel.innerHTML = `<div class="p-in">${buildDossier(item, chart, fund, a, deep, news, bench, demo, scores)}</div>`;
    panel.querySelector(".ds-back").onclick = () => openDetail(item);
  }catch(e){
    panel.innerHTML = `<div class="p-in"><div class="ds-loading">Dossier konnte nicht erstellt werden – Daten für <b>${esc(item.s)}</b> gerade nicht erreichbar.<br><br><button class="ds-back">Zurück</button></div></div>`;
    panel.querySelector(".ds-back").onclick = () => openDetail(item);
  }
}

/* ---------- Start ----------
   Wird erst nach dem Laden aller Skriptdateien ausgeführt, damit auch
   Funktionen aus depot.js sicher zur Verfügung stehen. */
document.addEventListener("DOMContentLoaded", () => {
  Cache.prune();
  initInfo();
  initDB();
  initFx();
  renderFavs();
  initNews();
  initChancen();
  if (typeof initDepot === "function") initDepot();
  initRefresh();
});
loadBenchmark();
