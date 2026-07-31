/**
 * how2invest — Einzelaktien-Dashboard  (Cloudflare Worker)
 * ---------------------------------------------------------
 * Liest die beiden im Web veröffentlichten Google-Sheet-CSVs (Value / Zukunft),
 * holt Live-Kurse von Yahoo Finance je Ticker, rechnet Positionen, Returns und
 * Depot-Kennzahlen und liefert alles als JSON für das Frontend.
 *
 * Deploy:  wrangler deploy   (oder via Cloudflare-Dashboard, Modul-Worker)
 * Aufruf:  GET /            -> {generatedAt, depots:{value, zukunft}}
 *
 * Datenquelle Kurse: Yahoo Finance chart-Endpoint (gleiches Muster wie
 * dein Signal-Dashboard). Kurse ~15 Min verzögert.
 *
 * Ausgabe rein prozentual — KEINE Beträge, keine Anlagesumme (jede/r entscheidet
 * individuell). Positions-Return = aktueller Kurs / Kaufkurs − 1 in der
 * Originalwährung des Titels. Der gewichtete Depot-Beitrag summiert diese Returns
 * nach den %-Gewichten aus dem Sheet.
 */

const DEPOTS = {
  value: {
    name: "Value Depot",
    csv: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSm8lyrM7iLKZw4-pBjgmLLk2N6hciFy8UnkDdcdf6-bprjVtV4xsGzIoFNj4MxMXmTdZnK1l2FDVEB/pub?gid=336088195&single=true&output=csv",
  },
  zukunft: {
    name: "Zukunftsdepot",
    csv: "https://docs.google.com/spreadsheets/d/e/2PACX-1vSm8lyrM7iLKZw4-pBjgmLLk2N6hciFy8UnkDdcdf6-bprjVtV4xsGzIoFNj4MxMXmTdZnK1l2FDVEB/pub?gid=966858719&single=true&output=csv",
  },
};

const CSV_TTL = 300;   // Sheet 5 Min cachen
const PRICE_TTL = 300;  // Kurse 5 Min cachen
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Cache-Control": "public, max-age=120",
};

export default {
  async fetch(request) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });
    try {
      const payload = await buildPayload();
      return json(payload);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS },
  });
}

/* ---------- Zahlen im CH/DE-Format robust parsen ---------- */
function parseNum(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === "" || s === "-" || s === "–") return null;
  const isPct = s.includes("%");
  s = s
    .replace(/\u2019/g, "") // Schweizer Apostroph-Tausender
    .replace(/'/g, "")
    .replace(/\s/g, "")
    .replace(/%/g, "")
    .replace(/\./g, (m, i, str) => (str.includes(",") ? "" : ".")) // Punkt = Tausender nur wenn Komma vorhanden
    .replace(",", ".");
  const n = parseFloat(s);
  if (!isFinite(n)) return null;
  return isPct ? n / 100 : n;
}

/* ---------- Minimaler CSV-Parser (mit Quotes) ---------- */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c === "\r") { /* skip */ }
    else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/* ---------- Ein Depot-CSV in Struktur überführen ---------- */
function parseDepot(text) {
  const rows = parseCSV(text);
  const hIdx = rows.findIndex((r) => (r[0] || "").trim() === "Instrument");
  if (hIdx < 0) throw new Error("Kopfzeile nicht gefunden");
  const head = rows[hIdx].map((h) => (h || "").trim());
  const col = (pred) => head.findIndex(pred);
  const idx = {
    name: 0,
    isin: col((h) => h === "ISIN"),
    kaufdatum: col((h) => h === "Kaufdatum"),
    kaufkurs: col((h) => h === "Kaufkurs"),
    waehrung: col((h) => h === "Währung"),
    gewicht: col((h) => h.startsWith("Gewicht bei Kauf")),
    zielkurs: col((h) => h === "Zielkurs"),
    potenzial: col((h) => h.startsWith("Kurspotenzial")),
    ticker: col((h) => h.startsWith("Ticker")),
    status: col((h) => h === "Status"),
    verkaufskurs: col((h) => h === "Verkaufskurs"),
    realisiert: col((h) => h.startsWith("Realisierter Gewinn")),
    beitrag: col((h) => h.startsWith("Beitrag zum Depot")),
  };

  const positions = [];
  let cashQuote = null, realizedTotal = 0;
  for (let r = hIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    const c0 = (row[0] || "").trim();
    if (c0.startsWith("Liquidität")) { cashQuote = parseNum(row[idx.gewicht]); continue; }
    if (c0.startsWith("TOTAL")) { realizedTotal = parseNum(row[idx.beitrag]) || 0; continue; }
    if (c0.startsWith("Hinweis")) break;
    if (c0 === "") continue;
    positions.push({
      name: c0,
      isin: (row[idx.isin] || "").trim(),
      kaufdatum: (row[idx.kaufdatum] || "").trim(),
      currency: (row[idx.waehrung] || "").trim(),
      buyPrice: parseNum(row[idx.kaufkurs]),
      weight: parseNum(row[idx.gewicht]),        // Anteil (0..1) der Anlagesumme
      targetPrice: parseNum(row[idx.zielkurs]),
      potential: parseNum(row[idx.potenzial]),
      ticker: (row[idx.ticker] || "").trim(),
      status: (row[idx.status] || "").trim() || "Gehalten",
      sellPrice: parseNum(row[idx.verkaufskurs]),
      realizedGain: parseNum(row[idx.realisiert]),
    });
  }
  return { positions, cashQuote, realizedTotal };
}

/* ---------- Yahoo Live-Kurs je Ticker (chart-Endpoint) ---------- */
async function fetchQuote(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    symbol
  )}?range=1d&interval=1d`;
  const res = await fetch(url, {
    cf: { cacheTtl: PRICE_TTL, cacheEverything: true },
    headers: { "User-Agent": "Mozilla/5.0 (how2invest-dashboard)" },
  });
  if (!res.ok) return null;
  const data = await res.json();
  const meta = data?.chart?.result?.[0]?.meta;
  if (!meta || typeof meta.regularMarketPrice !== "number") return null;
  return { price: meta.regularMarketPrice, currency: meta.currency || null };
}

/* ---------- Aggregation eines Depots inkl. Live-Kurse ---------- */
async function enrichDepot(name, def) {
  const res = await fetch(def.csv, { cf: { cacheTtl: CSV_TTL, cacheEverything: true } });
  if (!res.ok) throw new Error(`CSV ${name} HTTP ${res.status}`);
  const parsed = parseDepot(await res.text());

  const held = parsed.positions.filter((p) => p.status !== "Verkauft" && p.ticker);
  const quotes = await Promise.all(held.map((p) => fetchQuote(p.ticker).catch(() => null)));
  const qByTicker = {};
  held.forEach((p, i) => (qByTicker[p.ticker] = quotes[i]));

  // Rein prozentual — keine Beträge, keine Anlagesumme (jede/r entscheidet individuell)
  let unrealizedContribution = 0;
  const positions = parsed.positions.map((p) => {
    const q = qByTicker[p.ticker] || null;
    let currentPrice = null, currentReturn = null;
    if (p.status !== "Verkauft" && q && p.buyPrice) {
      // Yahoo liefert .L in GBp (Pence) — Kaufkurs steht ebenfalls in GBp -> Verhältnis stimmt
      currentPrice = q.price;
      currentReturn = currentPrice / p.buyPrice - 1;
      if (p.weight != null) unrealizedContribution += p.weight * currentReturn;
    }
    return { ...p, currentPrice, currentReturn, priceOk: !!q };
  });

  return {
    name: def.name,
    cashQuote: parsed.cashQuote,
    equityQuote: parsed.cashQuote != null ? 1 - parsed.cashQuote : null,
    heldCount: held.length,
    realizedContribution: parsed.realizedTotal, // aus Sheet (kumuliert)
    unrealizedContribution,                     // gewichteter Beitrag der gehaltenen Titel
    totalReturn: unrealizedContribution + (parsed.realizedTotal || 0),
    positions,
  };
}

async function buildPayload() {
  const [value, zukunft] = await Promise.all([
    enrichDepot("value", DEPOTS.value),
    enrichDepot("zukunft", DEPOTS.zukunft),
  ]);
  return { generatedAt: new Date().toISOString(), depots: { value, zukunft } };
}
