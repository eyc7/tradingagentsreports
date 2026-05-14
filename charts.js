"use strict";

/* ---------------------------------------------------------------------------
 * charts.js — vanilla-JS port of web/frontend/src/lib/parseTools.ts and the
 * React chart components, for the static-web archive.
 *
 * Exports the global `TAcharts` object with:
 *   - renderChartsTab(container, toolCalls)
 *   - renderToolsTab(container, toolCalls)
 *
 * Depends on:
 *   - window.Plotly (loaded via CDN in index.html)
 *   - window.el / a generic createElement helper, but we use document.createElement
 *     directly so this file has no app.js dependency.
 * ------------------------------------------------------------------------- */

(function () {

// ---------------- Currency conversion ----------------

const CURRENCIES = {
  // Taiwan — TSMC, UMC.
  TSM: { code: "TWD", rate: 32.5, asOf: "2026-05" },
  UMC: { code: "TWD", rate: 32.5, asOf: "2026-05" },
};

function reportingCurrency(ticker) {
  if (!ticker) return null;
  return CURRENCIES[String(ticker).toUpperCase()] || null;
}

function toUsd(value, info) {
  if (value == null || !Number.isFinite(value)) return value;
  if (!info || !info.rate) return value;
  return value / info.rate;
}

function seriesToUsd(values, info) {
  if (!info) return values;
  return values.map((v) => toUsd(v, info));
}

// ---------------- Number formatting ----------------

function formatMoney(n) {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1e12) return `${sign}${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9)  return `${sign}${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6)  return `${sign}${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3)  return `${sign}${(abs / 1e3).toFixed(2)}K`;
  return `${sign}${abs.toFixed(2)}`;
}

function formatPct(p) {
  if (p == null || !Number.isFinite(p)) return "—";
  const sign = p > 0 ? "+" : "";
  return `${sign}${(p * 100).toFixed(1)}%`;
}

// ---------------- CSV utils ----------------

function splitCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else cur += ch;
    } else {
      if (ch === '"') inQuote = true;
      else if (ch === ",") { out.push(cur); cur = ""; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function stripCsvHeader(text) {
  const lines = String(text).split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].startsWith("#") || lines[i].trim() === "")) i++;
  return lines.slice(i).filter((l) => l.trim() !== "");
}

function toNum(s) {
  if (s == null) return null;
  const t = String(s).trim();
  if (t === "" || t === "N/A" || t.toLowerCase() === "nan") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

// ---------------- Parsers ----------------

function parseOhlcv(text) {
  if (!text || typeof text !== "string") return null;
  const tickerMatch = text.match(/Stock data for ([A-Z][A-Z0-9.-]*)/i);
  const lines = stripCsvHeader(text);
  if (lines.length < 2) return null;
  const header = splitCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const idx = {
    date: header.indexOf("date"),
    open: header.indexOf("open"),
    high: header.indexOf("high"),
    low: header.indexOf("low"),
    close: header.indexOf("close"),
    volume: header.indexOf("volume"),
  };
  if (idx.date < 0 || idx.close < 0) return null;
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    const date = (cells[idx.date] || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}/.test(date)) continue;
    rows.push({
      date: date.slice(0, 10),
      open: idx.open >= 0 ? toNum(cells[idx.open]) : null,
      high: idx.high >= 0 ? toNum(cells[idx.high]) : null,
      low:  idx.low  >= 0 ? toNum(cells[idx.low])  : null,
      close: toNum(cells[idx.close]),
      volume: idx.volume >= 0 ? toNum(cells[idx.volume]) : null,
    });
  }
  if (rows.length === 0) return null;
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return { ticker: tickerMatch ? tickerMatch[1] : null, rows };
}

function parseIndicatorWindow(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/##\s*([a-z0-9_]+)\s+values/i);
  if (!m) return null;
  const name = m[1];
  const points = [];
  let description = "";
  let pastValues = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("##")) continue;
    const dm = line.match(/^(\d{4}-\d{2}-\d{2}):\s*(.*)$/);
    if (dm) {
      const v = toNum(dm[2]);
      if (v != null) points.push({ date: dm[1], value: v });
      pastValues = true;
    } else if (pastValues) {
      description += (description ? " " : "") + line;
    }
  }
  if (points.length === 0) return null;
  points.sort((a, b) => a.date.localeCompare(b.date));
  return { name, description, points };
}

function parseFundamentals(text) {
  if (!text || typeof text !== "string") return null;
  const m = text.match(/Fundamentals for ([A-Z][A-Z0-9.-]*)/i);
  const fields = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const kv = line.match(/^([^:]+):\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1].trim();
    const val = kv[2].trim();
    const num = Number(val);
    fields[key] = Number.isFinite(num) && val !== "" ? num : val;
  }
  if (Object.keys(fields).length === 0) return null;
  return { ticker: m ? m[1] : null, fields };
}

function parseFinancialStatement(text, hint) {
  if (!text || typeof text !== "string") return null;
  const head = text.split(/\r?\n/).find((l) => l.startsWith("#")) || "";
  const kind =
    (hint && hint.kind) ||
    (/income/i.test(head) ? "income"
      : /balance/i.test(head) ? "balance"
      : /cash/i.test(head) ? "cashflow"
      : "income");
  const freq = (hint && hint.freq) || (/annual/i.test(head) ? "annual" : "quarterly");
  const tickerMatch = head.match(/for ([A-Z][A-Z0-9.-]*)/);

  const lines = stripCsvHeader(text);
  if (lines.length < 2) return null;
  const headerCells = splitCsvLine(lines[0]);
  const rawPeriods = headerCells.slice(1).map((p) => p.trim()).filter(Boolean);
  if (rawPeriods.length === 0) return null;
  const periodsAsc = [...rawPeriods].reverse();
  const reverseValues = (vals) => [...vals].reverse();

  const rows = {};
  for (let i = 1; i < lines.length; i++) {
    const cells = splitCsvLine(lines[i]);
    if (cells.length < 2) continue;
    const metric = cells[0].trim();
    if (!metric) continue;
    const values = [];
    for (let j = 1; j <= rawPeriods.length; j++) values.push(toNum(cells[j] || ""));
    rows[metric] = reverseValues(values);
  }
  if (Object.keys(rows).length === 0) return null;
  return {
    ticker: tickerMatch ? tickerMatch[1] : null,
    kind, freq,
    periods: periodsAsc,
    rows,
  };
}

function pickRow(rows, aliases) {
  const lower = {};
  for (const k of Object.keys(rows)) lower[k.toLowerCase()] = k;
  for (const a of aliases) {
    const key = lower[a.toLowerCase()];
    if (key) return { key, values: rows[key] };
  }
  return null;
}

function qoqYoy(values) {
  const last = values[values.length - 1];
  const prev = values[values.length - 2];
  const yearBack = values[values.length - 5];
  const pct = (curr, base) =>
    curr == null || base == null || base === 0 ? null : (curr - base) / Math.abs(base);
  return { qoq: pct(last, prev), yoy: pct(last, yearBack) };
}

function lastPctChange(values) {
  const last = values[values.length - 1];
  const prev = values[values.length - 2];
  if (last == null || prev == null || prev === 0) return null;
  return (last - prev) / Math.abs(prev);
}

function toAnnualFromQuarterly(stmt) {
  if (stmt.freq !== "quarterly") return null;
  const isFlow = stmt.kind === "income" || stmt.kind === "cashflow";
  const yearOf = (p) => {
    const m = String(p).match(/(\d{4})/);
    return m ? m[1] : null;
  };
  const years = [];
  const indicesByYear = {};
  stmt.periods.forEach((p, i) => {
    const y = yearOf(p);
    if (!y) return;
    if (!(y in indicesByYear)) { indicesByYear[y] = []; years.push(y); }
    indicesByYear[y].push(i);
  });
  if (years.length === 0) return null;

  // For flow statements, only keep fiscal years where we have all 4 quarters.
  // This prevents partial leading/trailing years (typical from yfinance's
  // ~5-quarter window) from rendering as misleadingly tiny bars.
  const keptYears = isFlow ? years.filter((y) => indicesByYear[y].length >= 4) : years;
  if (keptYears.length === 0) return null;

  const annualRows = {};
  for (const metric of Object.keys(stmt.rows)) {
    const vals = stmt.rows[metric];
    annualRows[metric] = keptYears.map((y) => {
      const idxs = indicesByYear[y];
      if (isFlow) {
        let sum = 0;
        let allPresent = true;
        for (const i of idxs) {
          const v = vals[i];
          if (v == null) { allPresent = false; break; }
          sum += v;
        }
        return allPresent ? sum : null;
      }
      return vals[idxs[idxs.length - 1]] != null ? vals[idxs[idxs.length - 1]] : null;
    });
  }
  return { ticker: stmt.ticker, kind: stmt.kind, freq: "annual", periods: keptYears, rows: annualRows };
}

function classifyTool(call) {
  if (!call.result) return null;
  const tool = String(call.tool || "").toLowerCase();
  const body = call.result;

  if (tool.includes("stock_data") || tool.includes("yfin")) {
    const d = parseOhlcv(body);
    return d ? { kind: "ohlcv", data: d, call } : null;
  }
  if (tool.includes("indicator")) {
    const d = parseIndicatorWindow(body);
    return d ? { kind: "indicator", data: d, call } : null;
  }
  if (tool === "get_fundamentals" || tool.endsWith("fundamentals")) {
    const d = parseFundamentals(body);
    return d ? { kind: "fundamentals", data: d, call } : null;
  }
  if (tool.includes("income"))  { const d = parseFinancialStatement(body, { kind: "income"  }); return d ? { kind: "income",   data: d, call } : null; }
  if (tool.includes("balance")) { const d = parseFinancialStatement(body, { kind: "balance" }); return d ? { kind: "balance",  data: d, call } : null; }
  if (tool.includes("cashflow") || tool.includes("cash_flow")) {
    const d = parseFinancialStatement(body, { kind: "cashflow" });
    return d ? { kind: "cashflow", data: d, call } : null;
  }
  return null;
}

function countChartable(toolCalls) {
  let n = 0;
  for (const c of toolCalls || []) if (classifyTool(c)) n++;
  return n;
}

// ---------------- DOM helpers (local, mirrors app.js's `el`) ----------------

function el(tag, attrs) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const k of Object.keys(attrs)) {
      const v = attrs[k];
      if (v == null || v === false) continue;
      if (k === "className") node.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v);
    }
  }
  for (let i = 2; i < arguments.length; i++) {
    const child = arguments[i];
    if (child == null || child === false) continue;
    if (Array.isArray(child)) {
      for (const c of child) {
        if (c == null || c === false) continue;
        node.append(c.nodeType ? c : document.createTextNode(String(c)));
      }
    } else {
      node.append(child.nodeType ? child : document.createTextNode(String(child)));
    }
  }
  return node;
}

// ---------------- Plotly layout helpers ----------------

const DARK_LAYOUT = {
  paper_bgcolor: "transparent",
  plot_bgcolor: "#0e1116",
  font: { color: "#e6edf3", family: "-apple-system, BlinkMacSystemFont, sans-serif", size: 11 },
  margin: { l: 50, r: 16, t: 28, b: 36 },
  xaxis: { gridcolor: "#2d333b", linecolor: "#2d333b", zerolinecolor: "#2d333b" },
  yaxis: { gridcolor: "#2d333b", linecolor: "#2d333b", zerolinecolor: "#2d333b" },
  legend: { orientation: "h", x: 0, y: 1.08, bgcolor: "transparent" },
};

const PLOT_CONFIG = {
  displaylogo: false,
  responsive: true,
  modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"],
};

function newPlot(node, data, layout, config) {
  if (!window.Plotly) {
    node.textContent = "Plotly failed to load from CDN.";
    return;
  }
  window.Plotly.newPlot(node, data, layout, Object.assign({}, PLOT_CONFIG, config || {}));
}

// ---------------- Price chart with indicator overlays ----------------

const IND_STYLE = {
  close_50_sma:  { label: "50 SMA",        color: "#58a6ff" },
  close_200_sma: { label: "200 SMA",       color: "#bc8cff" },
  close_10_ema:  { label: "10 EMA",        color: "#d29922" },
  macd:          { label: "MACD",          color: "#56d4dd" },
  macds:         { label: "MACD Signal",   color: "#f85149", dash: "dot" },
  macdh:         { label: "MACD Hist",     color: "#3fb950" },
  rsi:           { label: "RSI",           color: "#f0883e" },
  boll:          { label: "Bollinger Mid", color: "#8b949e", dash: "dash" },
  boll_ub:       { label: "Bollinger Up",  color: "#3fb950", dash: "dash" },
  boll_lb:       { label: "Bollinger Lo",  color: "#f85149", dash: "dash" },
  atr:           { label: "ATR",           color: "#d29922" },
  vwma:          { label: "VWMA",          color: "#58a6ff", dash: "dot" },
  mfi:           { label: "MFI",           color: "#bc8cff" },
};

const PRICE_SCALE_INDICATORS = new Set([
  "close_50_sma", "close_200_sma", "close_10_ema",
  "boll", "boll_ub", "boll_lb", "vwma",
]);

function buildPriceChart(container, series, indicators) {
  const head = el("div", { className: "chart-card-head" },
    el("h4", null,
      `${series.ticker || "Price"} `,
      el("span", { className: "muted" }, "— price & overlays"),
    ),
  );
  const plotNode = el("div");
  container.append(el("div", { className: "chart-card" }, head, plotNode,
    ...buildSubIndicators(indicators)));

  const dates  = series.rows.map((r) => r.date);
  const opens  = series.rows.map((r) => r.open);
  const highs  = series.rows.map((r) => r.high);
  const lows   = series.rows.map((r) => r.low);
  const closes = series.rows.map((r) => r.close);
  const volumes = series.rows.map((r) => r.volume);

  const candle = {
    type: "candlestick",
    name: series.ticker || "Price",
    x: dates, open: opens, high: highs, low: lows, close: closes,
    increasing: { line: { color: "#3fb950" }, fillcolor: "#3fb950" },
    decreasing: { line: { color: "#f85149" }, fillcolor: "#f85149" },
    yaxis: "y",
  };

  const overlays = (indicators || [])
    .filter((i) => PRICE_SCALE_INDICATORS.has(i.name) && i.points.length > 0)
    .map((ind) => {
      const style = IND_STYLE[ind.name];
      const line = { color: (style && style.color) || "#56d4dd", width: 1.5 };
      if (style && style.dash) line.dash = style.dash;
      return {
        type: "scatter", mode: "lines",
        name: (style && style.label) || ind.name,
        x: ind.points.map((p) => p.date),
        y: ind.points.map((p) => p.value),
        line,
        hovertemplate: `${(style && style.label) || ind.name}: %{y:.2f}<extra></extra>`,
        yaxis: "y",
      };
    });

  const volColors = closes.map((c, i) => {
    const o = opens[i];
    if (c == null || o == null) return "#444";
    return c >= o ? "rgba(63,185,80,0.55)" : "rgba(248,81,73,0.55)";
  });
  const volume = {
    type: "bar", name: "Volume",
    x: dates, y: volumes,
    marker: { color: volColors },
    yaxis: "y2",
    hovertemplate: "Vol: %{y:,.0f}<extra></extra>",
    showlegend: false,
  };

  const layout = Object.assign({}, DARK_LAYOUT, {
    height: 420,
    dragmode: "pan",
    xaxis: Object.assign({}, DARK_LAYOUT.xaxis, {
      type: "date",
      rangeslider: { visible: false },
      rangeselector: {
        bgcolor: "#1f2630",
        activecolor: "#0c2d4a",
        font: { color: "#e6edf3" },
        buttons: [
          { count: 1, label: "1M", step: "month", stepmode: "backward" },
          { count: 3, label: "3M", step: "month", stepmode: "backward" },
          { count: 6, label: "6M", step: "month", stepmode: "backward" },
          { count: 1, label: "1Y", step: "year",  stepmode: "backward" },
          { step: "all", label: "All" },
        ],
      },
    }),
    yaxis:  Object.assign({}, DARK_LAYOUT.yaxis, { domain: [0.25, 1], title: { text: "Price" } }),
    yaxis2: Object.assign({}, DARK_LAYOUT.yaxis, { domain: [0, 0.18], title: { text: "Vol" }, showgrid: false }),
    showlegend: true,
  });

  newPlot(plotNode, [candle, ...overlays, volume], layout);
}

function buildSubIndicators(indicators) {
  // Off-scale indicators (RSI, MACD, ATR, MFI) get their own mini chart.
  const subs = (indicators || []).filter((i) => !PRICE_SCALE_INDICATORS.has(i.name) && i.points.length > 0);
  return subs.map((ind) => {
    const style = IND_STYLE[ind.name];
    const wrap = el("div", { className: "sub-indicator" },
      el("div", { className: "sub-indicator-label" }, (style && style.label) || ind.name),
    );
    const plot = el("div");
    wrap.append(plot);
    setTimeout(() => {
      const shapes = [];
      if (ind.name === "rsi") {
        shapes.push(
          { type: "line", xref: "paper", x0: 0, x1: 1, y0: 70, y1: 70, line: { color: "#f85149", dash: "dot", width: 1 } },
          { type: "line", xref: "paper", x0: 0, x1: 1, y0: 30, y1: 30, line: { color: "#3fb950", dash: "dot", width: 1 } },
        );
      } else if (ind.name === "mfi") {
        shapes.push(
          { type: "line", xref: "paper", x0: 0, x1: 1, y0: 80, y1: 80, line: { color: "#f85149", dash: "dot", width: 1 } },
          { type: "line", xref: "paper", x0: 0, x1: 1, y0: 20, y1: 20, line: { color: "#3fb950", dash: "dot", width: 1 } },
        );
      }
      newPlot(plot, [{
        type: "scatter", mode: "lines",
        x: ind.points.map((p) => p.date),
        y: ind.points.map((p) => p.value),
        line: { color: (style && style.color) || "#56d4dd", width: 1.5 },
        hovertemplate: `${(style && style.label) || ind.name}: %{y:.2f}<extra></extra>`,
      }], Object.assign({}, DARK_LAYOUT, {
        height: 110,
        margin: { l: 40, r: 16, t: 8, b: 24 },
        showlegend: false,
        xaxis: Object.assign({}, DARK_LAYOUT.xaxis, { type: "date" }),
        shapes,
      }), { displayModeBar: false });
    }, 0);
    return wrap;
  });
}

// ---------------- Financial statements ----------------

const INCOME_METRICS = [
  { title: "Total Revenue",     aliases: ["Total Revenue", "Operating Revenue", "Revenue"] },
  { title: "Gross Profit",      aliases: ["Gross Profit"] },
  { title: "Operating Income",  aliases: ["Operating Income", "Total Operating Income As Reported"] },
  { title: "Net Income",        aliases: ["Net Income", "Net Income Common Stockholders", "Net Income Continuous Operations"] },
  { title: "EBITDA",            aliases: ["EBITDA", "Normalized EBITDA"] },
  { title: "Diluted EPS",       aliases: ["Diluted EPS", "Basic EPS"] },
  { title: "R&D",               aliases: ["Research And Development", "Research & Development"] },
  { title: "SG&A",              aliases: ["Selling General And Administration", "Selling General & Administration"] },
];

const BALANCE_METRICS = [
  { title: "Total Assets",         aliases: ["Total Assets"] },
  { title: "Total Liabilities",    aliases: ["Total Liabilities Net Minority Interest", "Total Liabilities"] },
  { title: "Stockholders' Equity", aliases: ["Stockholders Equity", "Total Equity Gross Minority Interest", "Common Stock Equity"] },
  { title: "Cash & Equivalents",   aliases: ["Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"] },
  { title: "Total Debt",           aliases: ["Total Debt", "Net Debt"] },
  { title: "Working Capital",      aliases: ["Working Capital"] },
  { title: "Inventory",            aliases: ["Inventory"] },
  { title: "Long Term Debt",       aliases: ["Long Term Debt"] },
];

const CASHFLOW_METRICS = [
  { title: "Operating Cash Flow", aliases: ["Operating Cash Flow", "Cash Flow From Continuing Operating Activities"] },
  { title: "Free Cash Flow",      aliases: ["Free Cash Flow"] },
  { title: "Capital Expenditure", aliases: ["Capital Expenditure"] },
  { title: "Investing Cash Flow", aliases: ["Investing Cash Flow", "Cash Flow From Continuing Investing Activities"] },
  { title: "Financing Cash Flow", aliases: ["Financing Cash Flow", "Cash Flow From Continuing Financing Activities"] },
  { title: "Dividends Paid",      aliases: ["Cash Dividends Paid", "Common Stock Dividend Paid"] },
  { title: "Stock Buybacks",      aliases: ["Repurchase Of Capital Stock"] },
  { title: "Net Income",          aliases: ["Net Income From Continuing Operations", "Net Income"] },
];

const KIND_TITLES = { income: "Income Statement", balance: "Balance Sheet", cashflow: "Cash Flow" };

function deltaClass(p) {
  if (p == null) return "delta neutral";
  if (p > 0) return "delta up";
  if (p < 0) return "delta down";
  return "delta neutral";
}

function buildFinancialStatementCard(container, stmt) {
  const metrics =
    stmt.kind === "income" ? INCOME_METRICS
    : stmt.kind === "balance" ? BALANCE_METRICS
    : CASHFLOW_METRICS;
  const freqLabel = stmt.freq === "quarterly" ? "Quarterly" : "Annual";
  const fx = reportingCurrency(stmt.ticker);
  const note = fx ? `  ·  Converted ${fx.code} → USD @ ${fx.rate.toFixed(2)} (${fx.asOf})` : "";

  const grid = el("div", { className: "fin-grid" });
  for (const m of metrics) {
    const row = pickRow(stmt.rows, m.aliases);
    if (!row) continue;
    const isPerShare = /eps/i.test(m.title);
    const values = isPerShare ? row.values : seriesToUsd(row.values, fx);
    grid.append(buildMetricCard(m.title, stmt.periods, values, stmt.freq));
  }

  container.append(el("div", { className: "chart-card" },
    el("div", { className: "chart-card-head" },
      el("h4", null,
        `${KIND_TITLES[stmt.kind]} `,
        el("span", { className: "muted" }, `— ${freqLabel}${stmt.ticker ? " · " + stmt.ticker : ""}${note}`),
      ),
    ),
    grid,
  ));
}

function buildMetricCard(title, periods, values, freq) {
  const last = values[values.length - 1];
  const { qoq, yoy } = qoqYoy(values);

  const card = el("div", { className: "fin-card" },
    el("div", { className: "fin-card-title" }, title),
    el("div", { className: "fin-card-value" }, formatMoney(last == null ? null : last)),
    el("div", { className: "fin-card-deltas" },
      el("span", { className: deltaClass(qoq) }, `${freq === "quarterly" ? "QoQ " : "Δ "}${formatPct(qoq)}`),
      freq === "quarterly"
        ? el("span", { className: deltaClass(yoy) }, `YoY ${formatPct(yoy)}`)
        : null,
    ),
  );
  card.append(buildBarRow(periods, values));
  return card;
}

function buildBarRow(periods, values) {
  const colors = values.map((v) => (v != null && v < 0 ? "#f85149" : "#58a6ff"));
  const plot = el("div");
  const wrap = el("div", { className: "fin-card-bar" },
    el("div", { className: "fin-card-bar-label" }, label),
    plot,
  );
  setTimeout(() => {
    newPlot(plot, [{
      type: "bar",
      x: periods, y: values,
      marker: { color: colors },
      hovertemplate: "%{x}<br>%{y:,.0f}<extra></extra>",
    }], Object.assign({}, DARK_LAYOUT, {
      height: 80,
      margin: { l: 0, r: 0, t: 4, b: 16 },
      showlegend: false,
      xaxis: Object.assign({}, DARK_LAYOUT.xaxis, { type: "category", showgrid: false, tickfont: { size: 9 } }),
      yaxis: Object.assign({}, DARK_LAYOUT.yaxis, { showgrid: false, showticklabels: false, zeroline: true, zerolinecolor: "#444" }),
      bargap: 0.25,
    }), { displayModeBar: false });
  }, 0);
  return wrap;
}

// ---------------- Fundamentals card ----------------

const FUND_GROUPS = [
  { title: "Valuation", metrics: [
    { key: "Market Cap", fmt: "money" },
    { key: "PE Ratio (TTM)", label: "P/E (TTM)", fmt: "num" },
    { key: "Forward PE", label: "Forward P/E", fmt: "num" },
    { key: "PEG Ratio", fmt: "num" },
    { key: "Price to Book", label: "P/B", fmt: "num" },
    { key: "Beta", fmt: "num" },
  ]},
  { title: "Profitability", metrics: [
    { key: "Profit Margin", fmt: "pct" },
    { key: "Operating Margin", fmt: "pct" },
    { key: "Return on Equity", label: "ROE", fmt: "pct" },
    { key: "Return on Assets", label: "ROA", fmt: "pct" },
  ]},
  { title: "Income", metrics: [
    { key: "Revenue (TTM)", fmt: "money" },
    { key: "Gross Profit", fmt: "money" },
    { key: "EBITDA", fmt: "money" },
    { key: "Net Income", fmt: "money" },
    { key: "EPS (TTM)", fmt: "num" },
    { key: "Forward EPS", fmt: "num" },
  ]},
  { title: "Balance & Cash", metrics: [
    { key: "Book Value", fmt: "num" },
    { key: "Free Cash Flow", fmt: "money" },
    { key: "Debt to Equity", fmt: "num" },
    { key: "Current Ratio", fmt: "num" },
    { key: "Dividend Yield", fmt: "pct" },
  ]},
  { title: "Price Levels", metrics: [
    { key: "52 Week High", fmt: "num" },
    { key: "52 Week Low", fmt: "num" },
    { key: "50 Day Average", label: "50D Avg", fmt: "num" },
    { key: "200 Day Average", label: "200D Avg", fmt: "num" },
  ]},
];

const FOREIGN_REPORTED_KEYS = new Set([
  "Revenue (TTM)", "Gross Profit", "EBITDA", "Net Income", "Free Cash Flow",
]);
const FOREIGN_REPORTED_PER_SHARE = new Set([
  "EPS (TTM)", "Forward EPS", "Book Value",
]);

function fmtField(v, kind) {
  if (v == null) return "—";
  if (typeof v === "string") return v;
  if (kind === "money") return formatMoney(v);
  if (kind === "pct") {
    const pct = Math.abs(v) < 5 ? v * 100 : v;
    return `${pct.toFixed(2)}%`;
  }
  return Number.isInteger(v) ? v.toLocaleString() : v.toFixed(2);
}

function buildFundamentalsCard(container, fund) {
  const fx = reportingCurrency(fund.ticker);
  const headSuffix = []
    .concat(fund.fields["Name"] || fund.ticker || "")
    .concat(fund.fields["Sector"] ? [` · ${fund.fields["Sector"]}`] : [])
    .concat(fund.fields["Industry"] ? [` · ${fund.fields["Industry"]}`] : [])
    .concat(fx ? [`  ·  Money fields converted ${fx.code} → USD @ ${fx.rate.toFixed(2)}`] : [])
    .join("");

  const groups = el("div", { className: "fund-groups" });
  for (const g of FUND_GROUPS) {
    const kvs = el("div", { className: "fund-kvs" });
    for (const m of g.metrics) {
      const raw = fund.fields[m.key];
      if (raw == null) continue;
      let value = raw;
      if (fx && typeof raw === "number") {
        if (FOREIGN_REPORTED_KEYS.has(m.key) || FOREIGN_REPORTED_PER_SHARE.has(m.key)) {
          value = toUsd(raw, fx);
        }
      }
      kvs.append(el("div", { className: "fund-kv" },
        el("div", { className: "fund-kv-label" }, m.label || m.key),
        el("div", { className: "fund-kv-value" }, fmtField(value, m.fmt || "num")),
      ));
    }
    groups.append(el("div", { className: "fund-group" },
      el("div", { className: "fund-group-title" }, g.title),
      kvs,
    ));
  }

  container.append(el("div", { className: "chart-card" },
    el("div", { className: "chart-card-head" },
      el("h4", null, "Fundamentals ", el("span", { className: "muted" }, `— ${headSuffix}`)),
    ),
    groups,
  ));
}

// ---------------- Public renderers ----------------

function classifyAll(toolCalls) {
  const out = [];
  for (const c of (toolCalls || [])) {
    const p = classifyTool(c);
    if (p) out.push(p);
  }
  return out;
}

function lastOfKind(parsed, kind) {
  for (let i = parsed.length - 1; i >= 0; i--) if (parsed[i].kind === kind) return parsed[i];
  return null;
}

function renderChartsTab(container, toolCalls) {
  container.replaceChildren();
  if (!window.Plotly) {
    container.append(el("div", { className: "empty-state" }, "Plotly is still loading…"));
    setTimeout(() => renderChartsTab(container, toolCalls), 120);
    return;
  }
  const parsed = classifyAll(toolCalls);
  const ohlc = parsed.find((p) => p.kind === "ohlcv");
  const indicators = parsed.filter((p) => p.kind === "indicator").map((p) => p.data);
  const indByName = new Map();
  for (const ind of indicators) indByName.set(ind.name, ind);
  const fund = lastOfKind(parsed, "fundamentals");
  const income = lastOfKind(parsed, "income");
  const balance = lastOfKind(parsed, "balance");
  const cashflow = lastOfKind(parsed, "cashflow");

  const hasAny = ohlc || fund || income || balance || cashflow || indByName.size > 0;
  if (!hasAny) {
    container.append(el("div", { className: "empty-state" },
      "No chartable tool data on this run."));
    return;
  }

  const wrap = el("div", { className: "charts-tab" });
  container.append(wrap);

  if (ohlc) buildPriceChart(wrap, ohlc.data, Array.from(indByName.values()));
  else if (indByName.size > 0) {
    wrap.append(el("div", { className: "chart-card" },
      el("div", { className: "chart-card-head" },
        el("h4", null, "Indicators ", el("span", { className: "muted" }, "— price data not available")),
      ),
      el("p", { className: "meta" }, Array.from(indByName.keys()).join(", ")),
    ));
  }
  if (fund) buildFundamentalsCard(wrap, fund.data);
  if (income) buildFinancialStatementCard(wrap, income.data);
  if (balance) buildFinancialStatementCard(wrap, balance.data);
  if (cashflow) buildFinancialStatementCard(wrap, cashflow.data);
}

function formatArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try { return JSON.stringify(args, null, 2); } catch (e) { return String(args); }
}

function renderToolsTab(container, toolCalls) {
  container.replaceChildren();
  if (!toolCalls || toolCalls.length === 0) {
    container.append(el("div", { className: "empty-state" }, "No tool calls recorded on this run."));
    return;
  }
  const list = el("div", { className: "tools-list" });
  for (const t of toolCalls) {
    list.append(el("div", { className: "tool-call" },
      el("div", { className: "head" },
        el("span", null, t.tool || "(unknown)"),
        el("span", { className: "meta" }, t.agent_label || t.agent || ""),
      ),
      el("div", { className: "args" }, formatArgs(t.args)),
      t.result ? el("div", { className: "result" }, t.result) : null,
    ));
  }
  container.append(list);
}

// ---------------- Export ----------------

window.TAcharts = {
  classifyTool,
  countChartable,
  renderChartsTab,
  renderToolsTab,
};

})();
