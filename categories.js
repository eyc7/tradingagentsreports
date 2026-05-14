"use strict";

/* Portfolio category mapping — mirrors web/frontend/src/lib/categories.ts.
 * Tickers are grouped by sector / theme bucket with target allocation
 * weights. Exposes window.TAcategories with:
 *   CATEGORIES: ordered list of {name, weight, tickers: [{symbol, weight}]}
 *   categoryOf(ticker): "<category name>" or null
 */
(function () {

const CATEGORIES = [
  { name: "Semiconductors Stable", weight: 14,  tickers: [
      { symbol: "TSM",  weight: 8 },
      { symbol: "NVDA", weight: 6 },
  ]},
  { name: "AI Models / Platforms", weight: 13,  tickers: [
      { symbol: "GOOGL", weight: 6 },
      { symbol: "TSLA",  weight: 4 },
      { symbol: "META",  weight: 3 },
  ]},
  { name: "Hyperscalers", weight: 4.5, tickers: [
      { symbol: "MSFT", weight: 2.5 },
      { symbol: "AMZN", weight: 2 },
  ]},
  { name: "Semiconductor Growth", weight: 7,   tickers: [
      { symbol: "AMD",  weight: 3 },
      { symbol: "AVGO", weight: 1.5 },
      { symbol: "MRVL", weight: 1.5 },
      { symbol: "INTC", weight: 1 },
  ]},
  { name: "SaaS / AI Software", weight: 7,   tickers: [
      { symbol: "NOW",  weight: 3 },
      { symbol: "PLTR", weight: 2.5 },
      { symbol: "SNOW", weight: 1.5 },
  ]},
  { name: "Memory", weight: 5,   tickers: [
      { symbol: "MU",   weight: 2 },
      { symbol: "DRAM", weight: 2 },
      { symbol: "SNDK", weight: 1 },
  ]},
  { name: "Energy / AI Power", weight: 4,   tickers: [
      { symbol: "BE",  weight: 2.5 },
      { symbol: "CAT", weight: 1.5 },
  ]},
  { name: "Public Space", weight: 2,   tickers: [
      { symbol: "RKLB", weight: 1.25 },
      { symbol: "ASTS", weight: 0.75 },
  ]},
  { name: "Others / Quality", weight: 3,   tickers: [
      { symbol: "AAPL", weight: 1.5 },
      { symbol: "COST", weight: 1.5 },
  ]},
];

const CATEGORY_OF = {};
for (const cat of CATEGORIES) {
  for (const t of cat.tickers) CATEGORY_OF[t.symbol.toUpperCase()] = cat.name;
}

function categoryOf(ticker) {
  if (!ticker) return null;
  return CATEGORY_OF[String(ticker).toUpperCase()] || null;
}

window.TAcategories = { CATEGORIES, categoryOf };

})();
