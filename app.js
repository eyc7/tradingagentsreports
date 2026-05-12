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

function renderMarkdown(md) {
  if (!md) return "";
  // marked has GFM enabled by default in v12.
  const html = window.marked.parse(md, { gfm: true, breaks: false });
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
  const tickerInput = el("input", {
    type: "search",
    placeholder: "filter by ticker…",
    oninput: () => filterRuns(),
  });

  const runs = manifest.runs || [];
  const runListEl = el("div", { className: "run-list" });

  function filterRuns() {
    const needle = tickerInput.value.trim().toUpperCase();
    runListEl.replaceChildren();
    const filtered = needle
      ? runs.filter((r) => r.ticker.includes(needle))
      : runs;
    if (filtered.length === 0) {
      runListEl.append(el("p", { className: "meta" },
        needle ? `No runs match "${needle}".` : "No runs found."));
      return;
    }
    for (const r of filtered) runListEl.append(buildRunCard(r));
  }
  filterRuns();

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
      el("div", { className: "filter-row" },
        el("label", null, "Filter"),
        tickerInput),
    ),
    el("section", { className: "runs" },
      el("h2", null, "Recent runs"),
      runListEl),
  );
}

function buildRunCard(r) {
  const finalRating = r.rating || ratingOf(r.decision_preview);
  const stages = [
    { label: "Research", rating: r.research_decision },
    { label: "Trader",   rating: r.trader_decision   },
    { label: "Portfolio",rating: r.portfolio_decision},
  ];
  const hasChain = stages.some((s) => s.rating);
  const created = r.created_at_iso
    ? new Date(r.created_at_iso).toLocaleString()
    : (r.created_at ? new Date(r.created_at * 1000).toLocaleString() : "");

  const chainNode = hasChain
    ? el("div", { className: "decision-chain", title: "Each judge's call along the way" },
        ...stages.map((s, i) => el("span", { className: "decision-chain-step" },
          i > 0 ? el("span", { className: "decision-chain-arrow" }, "→") : null,
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
            active ? "active" : "",
          ].filter(Boolean).join(" "),
          onclick: has
            ? () => { selectedAgent = active ? null : a.key; renderSidebar(); renderViewer(); }
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
    const fullActive = selectedAgent === null;
    sidebar.append(el("div", {
      className: `agent-row has-report ${fullActive ? "active" : ""}`,
      onclick: () => { selectedAgent = null; renderSidebar(); renderViewer(); },
      title: "Show the combined complete_report.md",
    }, el("span", { className: "dot" }), el("span", null, "Complete Report")));
  }

  const viewerBody = el("div", { className: "body" });
  function renderViewer() {
    viewerBody.replaceChildren();
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
      // No bundled complete_report — show all reports sequentially as a fallback.
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
      el("span", { className: "meta" },
        `${(run.reports || []).length} reports`),
      el("div", { style: { flex: 1 } }),
    ),
    viewerBody,
  );

  // Right-side panel: decision banner + list of all report cards.
  const right = buildRightPanel(run, reportsByAgent, (agentKey) => {
    selectedAgent = agentKey;
    renderSidebar();
    renderViewer();
    // Reset the internal scroll on desktop, then scroll the viewer back
    // into view (matters on mobile where the right panel sits below).
    document.querySelector(".viewer .body")?.scrollTo({ top: 0, behavior: "smooth" });
    document.querySelector(".viewer")?.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  // Resizer between viewer and right panel.
  const STORAGE_KEY = "ta:rightPanelWidth";
  const MIN_RIGHT = 280;
  const SIDEBAR_WIDTH = 240;
  const RESIZER_WIDTH = 4;
  function maxRightWidth() {
    return Math.max(MIN_RIGHT, window.innerWidth - SIDEBAR_WIDTH - RESIZER_WIDTH - 240);
  }
  function defaultRight() {
    const remaining = window.innerWidth - SIDEBAR_WIDTH - RESIZER_WIDTH;
    return Math.max(MIN_RIGHT, Math.floor(remaining / 2));
  }
  let rightWidth;
  const stored = parseInt(localStorage.getItem(STORAGE_KEY) || "", 10);
  rightWidth = Number.isFinite(stored) && stored >= MIN_RIGHT && stored <= maxRightWidth()
    ? stored : defaultRight();

  const page = el("div", { className: "run-page" }, sidebar, viewer);
  const resizer = el("div", { className: "resizer" });
  page.append(resizer, right);
  page.style.gridTemplateColumns = `${SIDEBAR_WIDTH}px 1fr ${RESIZER_WIDTH}px ${rightWidth}px`;

  let dragging = false;
  let lastX = 0;
  resizer.addEventListener("mousedown", (e) => {
    dragging = true;
    lastX = e.clientX;
    document.body.style.userSelect = "none";
    e.preventDefault();
  });
  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    const dx = e.clientX - lastX;
    lastX = e.clientX;
    rightWidth = Math.max(MIN_RIGHT, Math.min(maxRightWidth(), rightWidth - dx));
    page.style.gridTemplateColumns = `${SIDEBAR_WIDTH}px 1fr ${RESIZER_WIDTH}px ${rightWidth}px`;
  });
  window.addEventListener("mouseup", () => {
    if (!dragging) return;
    dragging = false;
    document.body.style.userSelect = "";
    localStorage.setItem(STORAGE_KEY, String(rightWidth));
  });

  renderSidebar();
  renderViewer();
  return page;
}

function buildRightPanel(run, reportsByAgent, onPick) {
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

  const list = el("div", null);
  for (const rep of run.reports || []) {
    const card = buildReportCard(rep);
    card.style.cursor = "pointer";
    card.title = "Show only this report on the left";
    card.addEventListener("click", () => onPick(rep.agent_key));
    list.append(card);
  }
  if (!(run.reports || []).length) {
    list.append(el("div", { className: "empty-state" }, "No reports."));
  }

  return el("aside", { className: "tool-panel" },
    el("div", { className: "tabs" }, el("button", { className: "active" }, `Reports (${(run.reports || []).length})`)),
    el("div", { className: "body" }, decisionBanner, list),
  );
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

