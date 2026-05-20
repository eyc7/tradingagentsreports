"use strict";

/* ---------------------------------------------------------------------------
 * TradingAgents static reports viewer.
 *
 * Hash routes:
 *   #/                -> home page (list of runs from data/manifest.json)
 *   #/runs/<run_id>   -> run viewer (loads data/runs/<id>.json)
 *
 * The data layer is generated offline by build.py; this script is read-only.
 * ------------------------------------------------------------------------- */

const DATA_BASE = "./data";

// Mirrors web/frontend/src/types.ts ALL_AGENTS so the sidebar is identical.
const ALL_AGENTS = [
  { key: "market",        label: "Market Analyst",        team: "analysts" },
  { key: "social",        label: "Social Analyst",        team: "analysts" },
  { key: "news",          label: "News Analyst",          team: "analysts" },
  { key: "fundamentals",  label: "Fundamentals Analyst",  team: "analysts" },
  { key: "competitor",    label: "Competitor Analyst",    team: "analysts" },
  { key: "bull",          label: "Bull Researcher",       team: "research" },
  { key: "bear",          label: "Bear Researcher",       team: "research" },
  { key: "research_mgr",  label: "Research Manager",      team: "research" },
  { key: "trader",        label: "Trader",                team: "trading"  },
  { key: "aggressive",    label: "Aggressive Analyst",    team: "risk"     },
  { key: "conservative",  label: "Conservative Analyst",  team: "risk"     },
  { key: "neutral",       label: "Neutral Analyst",       team: "risk"     },
  { key: "portfolio_mgr", label: "Portfolio Manager",     team: "risk"     },
];

const TEAMS = [
  { key: "analysts", label: "Analysts" },
  { key: "research", label: "Research" },
  { key: "trading",  label: "Trading"  },
  { key: "risk",     label: "Risk Mgmt"},
];

// Map report_key -> display label, mirrors ToolPanel.tsx REPORT_LABELS.
const REPORT_LABELS = {
  market_report:               "Market Analysis",
  sentiment_report:            "Social Sentiment",
  news_report:                 "News Analysis",
  fundamentals_report:         "Fundamentals",
  competitor_report:           "Competitor Analysis",
  bull_history:                "Bull Researcher",
  bear_history:                "Bear Researcher",
  investment_plan:             "Research Manager",
  trader_investment_plan:      "Trader Plan",
  risk__aggressive_history:    "Aggressive Analyst",
  risk__conservative_history:  "Conservative Analyst",
  risk__neutral_history:       "Neutral Analyst",
  final_trade_decision:        "Portfolio Manager (final)",
};

const RATING_RE = /\b(BUY|SELL|HOLD)\b/g;

/* ------------------------------- helpers --------------------------------- */

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "className") node.className = v;
      else if (k === "style" && typeof v === "object") Object.assign(node.style, v);
      else if (k === "html") node.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === "dataset" && typeof v === "object") {
        for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = dv;
      } else {
        node.setAttribute(k, v);
      }
    }
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function ratingOf(text) {
  if (!text) return null;
  const upper = String(text).toUpperCase();
  if (/\bBUY\b/.test(upper))  return "buy";
  if (/\bSELL\b/.test(upper)) return "sell";
  if (/\bHOLD\b/.test(upper)) return "hold";
  return null;
}

/**
 * Strip LaTeX text-styling commands that LLMs frequently produce — e.g.
 * `$\text{Bullish}$` → `Bullish`, `$\textbf{BUY}$` → `**BUY**`. Genuine math
 * and dollar amounts (`$50/share`) are left alone since the regexes require
 * `\<command>{` immediately after the leading `$`.
 */
function stripLatexStyling(md) {
  if (!md) return md;
  const patterns = [
    ["text",        "%s"],
    ["mathrm",      "%s"],
    ["textbf",      "**%s**"],
    ["mathbf",      "**%s**"],
    ["boldsymbol",  "**%s**"],
    ["textit",      "*%s*"],
    ["mathit",      "*%s*"],
    ["emph",        "*%s*"],
    ["boxed",       "**%s**"],
  ];
  let out = md;
  for (const [cmd, tmpl] of patterns) {
    out = out.replace(new RegExp("\\$\\$\\s*\\\\" + cmd + "\\{([^}]*)\\}\\s*\\$\\$", "g"),
                      tmpl.replace("%s", "$1"));
    out = out.replace(new RegExp("\\$\\s*\\\\" + cmd + "\\{([^}]*)\\}\\s*\\$", "g"),
                      tmpl.replace("%s", "$1"));
    out = out.replace(new RegExp("\\\\" + cmd + "\\{([^}]*)\\}", "g"),
                      tmpl.replace("%s", "$1"));
  }
  return out;
}

function renderMarkdown(md) {
  if (!md) return "";
  // marked has GFM enabled by default in v12.
  const html = window.marked.parse(stripLatexStyling(md), { gfm: true, breaks: false });
  // Sanitize: marked output is HTML; we trust our own report files but still
  // strip <script> as a belt-and-braces measure.
  return html.replace(/<script[\s\S]*?<\/script>/gi, "");
}

/**
 * Walk text nodes inside `root` and wrap BUY/SELL/HOLD in styled pills.
 * Skips text inside CODE/PRE so command snippets aren't rewritten.
 */
function highlightRatings(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      let p = node.parentNode;
      while (p && p !== root) {
        const tag = p.tagName;
        if (tag === "CODE" || tag === "PRE" || tag === "SCRIPT" || tag === "STYLE") {
          return NodeFilter.FILTER_REJECT;
        }
        p = p.parentNode;
      }
      return RATING_RE.test(node.nodeValue)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const targets = [];
  let n;
  while ((n = walker.nextNode())) targets.push(n);

  for (const node of targets) {
    RATING_RE.lastIndex = 0;
    const text = node.nodeValue;
    const frag = document.createDocumentFragment();
    let last = 0;
    let m;
    while ((m = RATING_RE.exec(text)) !== null) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      const word = m[1];
      frag.append(el("span", { className: `rating-pill ${word.toLowerCase()} inline` }, word));
      last = m.index + m[1].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    node.parentNode.replaceChild(frag, node);
  }
}

function setBackLinkVisible(visible) {
  const back = document.getElementById("back-link");
  if (back) back.style.display = visible ? "" : "none";
}

async function fetchJson(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} loading ${path}`);
  return res.json();
}

/* --------------------------- routing -------------------------------------- */

function parseRoute() {
  const hash = window.location.hash.replace(/^#/, "");
  const m = hash.match(/^\/runs\/([^/]+)/);
  if (m) return { name: "run", id: decodeURIComponent(m[1]) };
  return { name: "home" };
}

async function render() {
  const route = parseRoute();
  const page = document.getElementById("page");
  page.replaceChildren();
  setBackLinkVisible(route.name === "run");

  if (route.name === "home") {
    await renderHome(page);
  } else {
    await renderRun(page, route.id);
  }
}

window.addEventListener("hashchange", () => { render().catch(showError); });
window.addEventListener("DOMContentLoaded", () => {
  // marked is loaded as `defer`, so it may still be loading; wait for it.
  const start = () => render().catch(showError);
  if (window.marked) start();
  else {
    const ready = setInterval(() => {
      if (window.marked) { clearInterval(ready); start(); }
    }, 30);
  }
});

function showError(err) {
  const page = document.getElementById("page");
  page.replaceChildren(el("div", { className: "error" }, String(err && err.message || err)));
}

/* --------------------------- home page ----------------------------------- */

async function renderHome(root) {
  root.append(el("div", { className: "loading" }, "Loading reports…"));
  let manifest;
  try {
    manifest = await fetchJson(`${DATA_BASE}/manifest.json`);
  } catch (err) {
    root.replaceChildren(el("div", { className: "error" },
      `Could not load ${DATA_BASE}/manifest.json — run \`python3 build.py\` from the static-web directory to generate it. (${err.message})`));
    return;
  }
  root.replaceChildren(buildHomeView(manifest));
}

function buildHomeView(manifest) {
  const runs = manifest.runs || [];
  const runListEl = el("div", { className: "run-list" });
  const categoryOf = (window.TAcategories && window.TAcategories.categoryOf) || (() => null);
  const CATEGORIES = (window.TAcategories && window.TAcategories.CATEGORIES) || [];

  const tickerInput = el("input", {
    type: "search",
    placeholder: "filter by ticker…",
    oninput: () => applyFilters(),
    style: { flex: "1", minWidth: "0" },
  });

  const categorySelect = el("select", { onchange: () => applyFilters() },
    el("option", { value: "" }, "All categories"),
    ...CATEGORIES.map((c) => el("option", { value: c.name }, c.name)),
  );

  const fromInput = el("input", { type: "date", title: "From (created on or after)",
    onchange: () => applyFilters() });
  const toInput   = el("input", { type: "date", title: "To (created on or before)",
    onchange: () => applyFilters() });

  const groupSelect = el("select", { onchange: () => applyFilters(),
    title: "Group runs in the list" },
    el("option", { value: "none" }, "Group: none"),
    el("option", { value: "category" }, "Group: category"),
    el("option", { value: "date" }, "Group: trade date"),
  );

  const clearBtn = el("button", {
    type: "button", className: "secondary",
    onclick: () => {
      tickerInput.value = ""; categorySelect.value = "";
      fromInput.value = "";   toInput.value = "";
      applyFilters();
    },
  }, "Clear");

  function applyFilters() {
    const needle = tickerInput.value.trim().toUpperCase();
    const cat = categorySelect.value;
    const fromTs = fromInput.value ? new Date(fromInput.value + "T00:00:00").getTime() / 1000 : null;
    const toTs   = toInput.value   ? new Date(toInput.value   + "T23:59:59.999").getTime() / 1000 : null;
    const filtered = runs.filter((r) => {
      if (needle && !r.ticker.toUpperCase().includes(needle)) return false;
      if (cat && categoryOf(r.ticker) !== cat) return false;
      if (fromTs != null && (r.created_at || 0) < fromTs) return false;
      if (toTs   != null && (r.created_at || 0) > toTs)   return false;
      return true;
    });
    runListEl.replaceChildren();
    if (filtered.length === 0) {
      const anyFilter = needle || cat || fromInput.value || toInput.value;
      runListEl.append(el("p", { className: "meta" },
        anyFilter ? "No runs match the current filter." : "No runs found."));
      return;
    }
    const mode = groupSelect.value;
    if (mode === "none") {
      for (const r of filtered) runListEl.append(buildRunCard(r));
      return;
    }
    for (const group of groupRuns(filtered, mode)) {
      const header = el("div", { className: "run-group-header" },
        el("span", { className: "run-group-label" }, `${group.label} (${group.runs.length})`),
      );
      const wrap = el("div", { className: "run-group" }, header);
      for (const r of group.runs) wrap.append(buildRunCard(r));
      runListEl.append(wrap);
    }
  }
  applyFilters();

  return el("div", { className: "home" },
    el("aside", { className: "intro" },
      el("h2", null, "Read-only archive"),
      el("p", null,
        "Browse historical TradingAgents reports below. This site is statically " +
        "generated — pick a run to inspect each agent's report and the final decision."),
      el("p", null,
        `${runs.length} run${runs.length === 1 ? "" : "s"} indexed`,
        runs[0] && manifest.generated_at
          ? ` · last built ${new Date(manifest.generated_at).toLocaleString()}`
          : ""),
      buildUpstreamCitation(),
    ),
    el("section", { className: "runs" },
      el("h2", null, "Recent runs"),
      el("div", { className: "runs-filter" },
        tickerInput, categorySelect, fromInput, toInput, groupSelect, clearBtn),
      runListEl),
  );
}

/** Credit to the upstream TradingAgents paper / project. Goes at the
    bottom of the intro panel on the home page. */
function buildUpstreamCitation() {
  return el("div", { className: "upstream-citation" },
    el("div", { className: "upstream-citation-head" }, "Based on"),
    el("p", null,
      el("a", { href: "https://tradingagents-ai.github.io/", target: "_blank", rel: "noreferrer" },
        "TradingAgents: Multi-Agents LLM Financial Trading Framework"),
    ),
    el("pre", { className: "bibtex" },
      "@article{xiao2024tradingagents,\n" +
      "  title={TradingAgents: Multi-Agents LLM Financial Trading Framework},\n" +
      "  author={Xiao, Yijia and Sun, Edward and Luo, Di and Wang, Wei},\n" +
      "  journal={arXiv preprint arXiv:2412.20138},\n" +
      "  year={2024}\n" +
      "}"),
  );
}

/** Bucket the filtered runs by category or trade_date. Category groups
    follow portfolio order; date groups sort newest-first. */
function groupRuns(runs, mode) {
  if (mode === "category") {
    const CATEGORIES = (window.TAcategories && window.TAcategories.CATEGORIES) || [];
    const categoryOf = (window.TAcategories && window.TAcategories.categoryOf) || (() => null);
    const byCat = new Map();
    for (const r of runs) {
      const c = categoryOf(r.ticker) || "Uncategorized";
      if (!byCat.has(c)) byCat.set(c, []);
      byCat.get(c).push(r);
    }
    const out = [];
    for (const cat of CATEGORIES) {
      if (byCat.has(cat.name)) {
        out.push({ key: cat.name, label: cat.name, runs: byCat.get(cat.name) });
        byCat.delete(cat.name);
      }
    }
    for (const [name, group] of byCat) out.push({ key: name, label: name, runs: group });
    return out;
  }
  // mode === "date"
  const byDate = new Map();
  for (const r of runs) {
    if (!byDate.has(r.trade_date)) byDate.set(r.trade_date, []);
    byDate.get(r.trade_date).push(r);
  }
  return [...byDate.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([d, group]) => ({ key: d, label: d, runs: group }));
}

function buildRunCard(r) {
  const finalRating = r.rating || ratingOf(r.decision_preview);
  const stages = [
    { label: "Analysis", rating: r.analysis_decision  },
    { label: "Research", rating: r.research_decision  },
    { label: "Trader",   rating: r.trader_decision    },
    { label: "Portfolio",rating: r.portfolio_decision },
  ];
  const hasChain = stages.some((s) => s.rating);
  const created = r.created_at_iso
    ? new Date(r.created_at_iso).toLocaleString()
    : (r.created_at ? new Date(r.created_at * 1000).toLocaleString() : "");

  const chainNode = hasChain
    ? el("div", { className: "decision-chain", title: "Each judge's call along the way" },
        ...stages.map((s) => el("span", { className: "decision-chain-step" },
          el("span", { className: "decision-chain-label" }, s.label),
          s.rating
            ? el("span", { className: `rating-pill ${s.rating} inline` }, s.rating.toUpperCase())
            : el("span", { className: "decision-chain-empty" }, "—")
        )))
    : null;

  return el("div", { className: "run-card-wrap" },
    el("a", { className: "run-card", href: `#/runs/${encodeURIComponent(r.id)}` },
      el("div", { className: "row" },
        el("span", { className: "ticker" }, r.ticker),
        finalRating ? el("span", { className: `rating-pill ${finalRating}` }, finalRating.toUpperCase()) : null,
      ),
      el("div", { className: "row", style: { marginTop: "4px" } },
        el("span", { className: "meta" },
          [r.trade_date, modelLine(r), `${r.report_count || 0} reports`].filter(Boolean).join(" · ")),
        el("span", { className: "meta" }, created),
      ),
      chainNode,
    ),
  );
}

/* --------------------------- run page ------------------------------------ */

async function renderRun(root, runId) {
  root.append(el("div", { className: "loading" }, `Loading run ${runId}…`));
  let run;
  try {
    run = await fetchJson(`${DATA_BASE}/runs/${encodeURIComponent(runId)}.json`);
  } catch (err) {
    root.replaceChildren(el("div", { className: "error" },
      `Could not load run "${runId}". ${err.message}`));
    return;
  }
  root.replaceChildren(buildRunView(run));
}

function buildRunView(run) {
  // Map report by agent_key for sidebar selection.
  const reportsByAgent = {};
  for (const rep of run.reports || []) reportsByAgent[rep.agent_key] = rep;

  // Currently selected sidebar agent (null = show full complete_report).
  let selectedAgent = null;
  // Which tab is showing in the viewer body.
  let activeTab = "reports";  // "reports" | "charts" | "tools"

  const toolCalls = run.tool_calls || [];
  const chartCount = window.TAcharts ? window.TAcharts.countChartable(toolCalls) : 0;

  // Scroll helpers — work for both the desktop layout (viewer .body is the
  // scrollable parent) and mobile (the page itself scrolls).
  function scrollToDecision() {
    document.querySelector(".decision-banner")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function scrollPastBanner() {
    const body = document.querySelector(".viewer .body");
    if (!body) return;
    const target = body.querySelector(".report-card");
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  const sidebar = el("aside", { className: "sidebar" });
  function renderSidebar() {
    sidebar.replaceChildren();
    for (const team of TEAMS) {
      sidebar.append(el("div", { className: "team" }, team.label));
      const agents = ALL_AGENTS.filter((a) => a.team === team.key);
      for (const a of agents) {
        const has = !!reportsByAgent[a.key];
        const active = selectedAgent === a.key;
        const row = el("div", {
          className: [
            "agent-row",
            has ? "has-report" : "disabled",
            active && activeTab === "reports" ? "active" : "",
          ].filter(Boolean).join(" "),
          onclick: has
            ? () => {
                // Sidebar click always implies the Reports tab — switch first.
                const switchedTab = activeTab !== "reports";
                activeTab = "reports";
                selectedAgent = (active && !switchedTab) ? null : a.key;
                renderSidebar();
                renderTabs();
                renderViewer();
                if (selectedAgent) scrollPastBanner();
                else scrollToDecision();
              }
            : null,
          title: has ? a.label : `${a.label} — no report in this run`,
        },
          el("span", { className: "dot" }),
          el("span", null, a.label),
        );
        sidebar.append(row);
      }
    }
    // "Show full report" toggle at the bottom.
    sidebar.append(el("div", { className: "team", style: { marginTop: "10px" } }, "Other"));
    const fullActive = selectedAgent === null && activeTab === "reports";
    sidebar.append(el("div", {
      className: `agent-row has-report ${fullActive ? "active" : ""}`,
      onclick: () => {
        activeTab = "reports";
        selectedAgent = null;
        renderSidebar();
        renderTabs();
        renderViewer();
        scrollPastBanner();
      },
      title: "Show the combined complete_report.md",
    }, el("span", { className: "dot" }), el("span", null, "Complete Report")));
  }

  // The FINAL DECISION banner lives at the top of the viewer (above the
  // selected report). Built once per run since its contents don't depend
  // on the sidebar selection.
  const rating = ratingOf(run.decision) || run.rating || null;
  const decisionBanner = run.decision
    ? el("div", { className: `decision-banner ${rating || ""}` },
        el("div", { className: "label" }, "FINAL DECISION"),
        el("div", { className: "rating-line" },
          rating ? el("span", { className: `rating-pill ${rating}` }, rating.toUpperCase()) : null,
        ),
        renderMarkdownInto(el("div", { className: "md decision-md" }), run.decision),
      )
    : null;

  const tabsBar = el("div", { className: "viewer-tabs" });
  function renderTabs() {
    tabsBar.replaceChildren();
    const make = (key, label, count) => el("button", {
      className: `tab-btn ${activeTab === key ? "active" : ""}`,
      onclick: () => { activeTab = key; renderSidebar(); renderTabs(); renderViewer(); },
    }, count == null ? label : `${label} (${count})`);
    tabsBar.append(make("reports", "Reports", (run.reports || []).length));
    tabsBar.append(make("charts",  "Charts",  chartCount));
    tabsBar.append(make("tools",   "Tools",   toolCalls.length));
  }

  const viewerBody = el("div", { className: "body" });
  function renderViewer() {
    viewerBody.replaceChildren();

    if (activeTab === "charts") {
      if (!window.TAcharts) {
        viewerBody.append(el("div", { className: "empty-state" }, "Chart module not loaded."));
        return;
      }
      window.TAcharts.renderChartsTab(viewerBody, toolCalls);
      return;
    }

    if (activeTab === "tools") {
      if (!window.TAcharts) {
        viewerBody.append(el("div", { className: "empty-state" }, "Tools module not loaded."));
        return;
      }
      window.TAcharts.renderToolsTab(viewerBody, toolCalls);
      return;
    }

    // "reports" tab
    if (decisionBanner) viewerBody.append(decisionBanner);
    if (selectedAgent) {
      const rep = reportsByAgent[selectedAgent];
      if (!rep) {
        viewerBody.append(el("div", { className: "empty-state" }, "No report available for this agent."));
        return;
      }
      viewerBody.append(buildReportCard(rep));
    } else if (run.complete_report) {
      const wrap = el("div", { className: "report-card" },
        el("h4", null, "Complete Report"),
        renderMarkdownInto(el("div", { className: "md" }), run.complete_report),
      );
      viewerBody.append(wrap);
    } else if ((run.reports || []).length) {
      for (const rep of run.reports) viewerBody.append(buildReportCard(rep));
    } else {
      viewerBody.append(el("div", { className: "empty-state" }, "This run has no reports."));
    }
  }

  const viewer = el("div", { className: "viewer" },
    el("div", { className: "topline" },
      el("strong", null, run.ticker),
      el("span", { className: "meta" }, run.trade_date),
      modelLine(run)
        ? el("span", { className: "meta" }, modelLine(run))
        : null,
      el("div", { style: { flex: 1 } }),
      run.decision
        ? el("button", {
            className: "jump-to-decision",
            title: "Jump back to the FINAL DECISION at the top",
            onclick: scrollToDecision,
          }, "↑ Final Decision")
        : null,
    ),
    tabsBar,
    viewerBody,
  );

  renderSidebar();
  renderTabs();
  renderViewer();
  return el("div", { className: "run-page" }, sidebar, viewer);
}

function buildReportCard(rep) {
  const card = el("div", { className: "report-card" },
    el("h4", null, REPORT_LABELS[rep.key] || rep.label || rep.key),
    renderMarkdownInto(el("div", { className: "md" }), rep.content),
  );
  return card;
}

function renderMarkdownInto(node, md) {
  node.innerHTML = renderMarkdown(md);
  highlightRatings(node);
  return node;
}

function modelLine(r) {
  if (!r.llm_provider && !r.deep_think_llm) return "";
  return [r.llm_provider, r.deep_think_llm].filter(Boolean).join("/");
}

