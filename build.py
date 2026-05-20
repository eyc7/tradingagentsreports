#!/usr/bin/env python3
"""Generate static-web data from every available source of past TradingAgents runs.

Scans three locations and merges them into a single manifest:

1. `<repo>/reports/<TICKER>_<YYYYMMDD>_<HHMMSS>/`
   - The "promoted" CLI format with subfolders 1_analysts/, 2_research/, etc.
   - Has a bundled `complete_report.md`.

2. `~/.tradingagents/logs/<TICKER>/<YYYY-MM-DD>/reports/<flat-files>`
   - The raw graph-output format with per-role markdown files.
   - No `complete_report.md`; we synthesize one.

3. `~/.tradingagents/web/runs/<run_id>/{run.json,events.jsonl}`
   - The live web-app's persisted event log. We parse `report` events out of
     events.jsonl and use run.json for metadata. Only `completed` runs are
     included; running/queued/error runs are skipped.

Output:
    static-web/data/manifest.json          — list of run summaries
    static-web/data/runs/<run_id>.json     — full run detail incl. report bodies

Run with: `python3 build.py` from the static-web directory.
"""

from __future__ import annotations

import json
import re
import shutil
import sys
from dataclasses import dataclass, asdict, field
from datetime import datetime
from pathlib import Path

# Layout: <static-web>/build.py and <static-web>/../reports/<run_id>/
HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
REPO_REPORTS_DIR = REPO_ROOT / "reports"
USER_LOGS_DIR = Path.home() / ".tradingagents" / "logs"
USER_WEB_RUNS_DIR = Path.home() / ".tradingagents" / "web" / "runs"
OUT_DIR = HERE / "data"

# Canonical agent metadata. Each entry: (agent_key, team, label, report_key).
# - agent_key matches the `key` field in web/frontend/src/types.ts ALL_AGENTS.
# - report_key matches the canonical state slot in the live web backend.
AGENT_INFO: dict[str, tuple[str, str, str]] = {
    # agent_key:       (team,       label,                     report_key)
    "market":         ("analysts", "Market Analyst",          "market_report"),
    "social":         ("analysts", "Social Analyst",          "sentiment_report"),
    "news":           ("analysts", "News Analyst",            "news_report"),
    "fundamentals":   ("analysts", "Fundamentals Analyst",    "fundamentals_report"),
    "competitor":     ("analysts", "Competitor Analyst",      "competitor_report"),
    "bull":           ("research", "Bull Researcher",         "bull_history"),
    "bear":           ("research", "Bear Researcher",         "bear_history"),
    "research_mgr":   ("research", "Research Manager",        "investment_plan"),
    "trader":         ("trading",  "Trader",                  "trader_investment_plan"),
    "aggressive":     ("risk",     "Aggressive Analyst",      "risk__aggressive_history"),
    "conservative":   ("risk",     "Conservative Analyst",    "risk__conservative_history"),
    "neutral":        ("risk",     "Neutral Analyst",         "risk__neutral_history"),
    "portfolio_mgr":  ("risk",     "Portfolio Manager",       "final_trade_decision"),
}

# Source 1: repo `reports/<ID>/<subdir>/<filename>` -> agent_key
REPO_FILES: list[tuple[str, str, str]] = [
    # (subdir,       filename,           agent_key)
    ("1_analysts",   "market.md",        "market"),
    ("1_analysts",   "sentiment.md",     "social"),
    ("1_analysts",   "news.md",          "news"),
    ("1_analysts",   "fundamentals.md",  "fundamentals"),
    ("1_analysts",   "competitor.md",    "competitor"),
    ("2_research",   "bull.md",          "bull"),
    ("2_research",   "bear.md",          "bear"),
    ("2_research",   "manager.md",       "research_mgr"),
    ("3_trading",    "trader.md",        "trader"),
    ("4_risk",       "aggressive.md",    "aggressive"),
    ("4_risk",       "conservative.md",  "conservative"),
    ("4_risk",       "neutral.md",       "neutral"),
    ("5_portfolio",  "decision.md",      "portfolio_mgr"),
]

# Source 2: logs/<TICKER>/<DATE>/reports/<filename> -> agent_key
# Both `research_manager.md` and `investment_plan.md` appear; they're identical,
# so we list both forms with a fallback chain (first hit wins).
LOG_FILE_CANDIDATES: list[tuple[list[str], str]] = [
    # (filename candidates,                     agent_key)
    (["market_report.md", "market_analyst.md"],         "market"),
    (["sentiment_report.md", "social_analyst.md"],      "social"),
    (["news_report.md", "news_analyst.md"],             "news"),
    (["fundamentals_report.md", "fundamentals_analyst.md"], "fundamentals"),
    (["competitor_report.md", "competitor_analyst.md"], "competitor"),
    (["bull_researcher.md"],                            "bull"),
    (["bear_researcher.md"],                            "bear"),
    (["research_manager.md", "investment_plan.md"],     "research_mgr"),
    (["trader_investment_plan.md", "trader.md"],        "trader"),
    (["aggressive_analyst.md"],                         "aggressive"),
    (["conservative_analyst.md"],                       "conservative"),
    (["neutral_analyst.md"],                            "neutral"),
    (["final_trade_decision.md", "portfolio_manager.md"], "portfolio_mgr"),
]

RUN_ID_RE = re.compile(r"^(?P<ticker>[A-Z0-9.\-]+)_(?P<date>\d{8})_(?P<time>\d{6})$")
DATE_DIR_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


@dataclass
class Report:
    key: str          # report_key (canonical state slot)
    agent_key: str
    team: str
    label: str
    content: str


@dataclass
class ToolCall:
    tool: str
    agent: str | None
    agent_label: str | None
    args: object            # parsed dict if we could parse, else raw string
    result: str | None      # may be None if the run crashed before the tool returned
    ts: float


@dataclass
class Run:
    id: str
    ticker: str
    trade_date: str          # YYYY-MM-DD
    created_at: float        # unix timestamp
    created_at_iso: str
    source: str              # "repo" | "logs" | "web"
    decision: str | None             # text of portfolio manager's decision
    rating: str | None               # "buy" | "sell" | "hold" | null
    research_decision: str | None
    trader_decision: str | None
    portfolio_decision: str | None
    # Majority of the 4 analyst-team reports' BUY/SELL/HOLD signals.
    analysis_decision: str | None = None
    llm_provider: str | None = None
    deep_think_llm: str | None = None
    reports: list[Report] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    complete_report: str | None = None


# ---------- helpers ---------------------------------------------------------


_RATING_PATTERNS = (
    # Portfolio Manager: "**Rating**: Sell"
    re.compile(r"\*{0,2}\s*Rating\s*\*{0,2}\s*[:\-—]\s*\*{0,2}\s*(BUY|SELL|HOLD)\b",
               re.IGNORECASE),
    # Trader: "FINAL TRANSACTION PROPOSAL: **SELL**"
    re.compile(r"FINAL\s+TRANSACTION\s+PROPOSAL\s*[:\-—]?\s*\*{0,2}\s*(BUY|SELL|HOLD)\b",
               re.IGNORECASE),
    re.compile(r"FINAL\s+(?:TRADE\s+)?DECISION\s*[:\-—]?\s*\*{0,2}\s*(BUY|SELL|HOLD)\b",
               re.IGNORECASE),
    # Action-verb phrasings: "issuing a Buy", "aligning with the bull on Sell".
    re.compile(r"\b(?:issuing|recommending|calling\s+for|going\s+with|aligning\s+with|"
               r"placing|making)\s+(?:a|an|the)?\s*\*{0,2}\s*(BUY|SELL|HOLD)\b",
               re.IGNORECASE),
    # Reverse-syntax: "Buy recommendation", "Sell decision".
    re.compile(r"\b(BUY|SELL|HOLD)\b\s*\*{0,2}\s+"
               r"(?:recommendation|decision|rating|call|verdict|conclusion|signal|stance)\b",
               re.IGNORECASE),
    # Forward-syntax: "recommendation is a Buy", "verdict — Hold".
    re.compile(r"\b(?:recommendation|decision|rating|call|verdict|conclusion|stance)"
               r"[^.]{0,80}?\b(BUY|SELL|HOLD)\b",
               re.IGNORECASE),
)
_BOLD_RATING_RE = re.compile(r"\*\*\s*(BUY|SELL|HOLD)\s*\*\*", re.IGNORECASE)
_BARE_RATING_RE = re.compile(r"\b(BUY|SELL|HOLD)\b", re.IGNORECASE)


def parse_rating(text: str | None) -> str | None:
    """Return 'buy' | 'sell' | 'hold' | None.

    Tiered extraction (mirrors web/backend/runner.py): structured markers
    first, then action-verb phrasings, then a last-mention fallback. The
    older first-mention / "BUY-anywhere wins" heuristics misclassify any
    judge report that quotes bull/bear positions before stating its call.
    """
    if not text:
        return None
    for pat in _RATING_PATTERNS:
        m = pat.search(text)
        if m:
            return m.group(1).lower()
    bolds = list(_BOLD_RATING_RE.finditer(text))
    if bolds:
        return bolds[-1].group(1).lower()
    bares = list(_BARE_RATING_RE.finditer(text))
    if bares:
        return bares[-1].group(1).lower()
    return None


def load_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return None


def build_report(agent_key: str, content: str) -> Report:
    team, label, report_key = AGENT_INFO[agent_key]
    return Report(key=report_key, agent_key=agent_key, team=team, label=label, content=content)


def synthesize_complete_report(ticker: str, trade_date: str, reports: list[Report]) -> str:
    """Build a `complete_report.md`-style document by concatenating sections."""
    by_team = {"analysts": [], "research": [], "trading": [], "risk": []}
    for rep in reports:
        by_team.get(rep.team, []).append(rep)
    sections = [
        f"# Trading Analysis Report: {ticker}",
        f"\nTrade Date: {trade_date}\n",
    ]
    team_titles = [
        ("analysts", "I. Analyst Team Reports"),
        ("research", "II. Research Team"),
        ("trading",  "III. Trading Team"),
        ("risk",     "IV. Risk Management & Portfolio Decision"),
    ]
    for team_key, heading in team_titles:
        if not by_team[team_key]:
            continue
        sections.append(f"\n## {heading}\n")
        for rep in by_team[team_key]:
            sections.append(f"\n### {rep.label}\n\n{rep.content.strip()}\n")
    return "\n".join(sections)


_ANALYST_REPORT_KEYS = ("market_report", "sentiment_report", "news_report", "fundamentals_report", "competitor_report")


def _majority_rating(ratings: list[str | None]) -> str | None:
    """Most common 'buy'/'sell'/'hold' across analyst signals. Tie-break:
    SELL > BUY > HOLD (when there's a real signal, surface it; conservative
    bias when SELL and BUY tie since this is a risk dashboard)."""
    votes = [r for r in ratings if r]
    if not votes:
        return None
    counts: dict[str, int] = {"buy": 0, "sell": 0, "hold": 0}
    for v in votes:
        counts[v] = counts.get(v, 0) + 1
    top = max(counts.values())
    for choice in ("sell", "buy", "hold"):
        if counts[choice] == top:
            return choice
    return None


def finalize_run(run: Run) -> Run:
    """Fill in rating/decision fields from the run's collected reports."""
    by_key = {r.key: r for r in run.reports}
    research_text = (by_key.get("investment_plan") or Report("", "", "", "", "")).content
    trader_text   = (by_key.get("trader_investment_plan") or Report("", "", "", "", "")).content
    portfolio_text = (by_key.get("final_trade_decision") or Report("", "", "", "", "")).content

    run.decision = portfolio_text or trader_text or None
    run.rating = parse_rating(run.decision)
    run.research_decision = parse_rating(research_text)
    run.trader_decision = parse_rating(trader_text)
    run.portfolio_decision = parse_rating(portfolio_text)
    if run.analysis_decision is None:
        analyst_ratings = [
            parse_rating((by_key.get(k) or Report("", "", "", "", "")).content)
            for k in _ANALYST_REPORT_KEYS
        ]
        run.analysis_decision = _majority_rating(analyst_ratings)
    if run.complete_report is None and run.reports:
        run.complete_report = synthesize_complete_report(run.ticker, run.trade_date, run.reports)
    return run


# ---------- source 1: repo reports/ -----------------------------------------


def scan_repo_run(run_dir: Path) -> Run | None:
    m = RUN_ID_RE.match(run_dir.name)
    if not m:
        return None
    ticker = m.group("ticker")
    date = m.group("date")
    time_ = m.group("time")
    try:
        dt = datetime.strptime(f"{date}{time_}", "%Y%m%d%H%M%S")
    except ValueError:
        return None
    trade_date = f"{date[0:4]}-{date[4:6]}-{date[6:8]}"

    reports: list[Report] = []
    for subdir, fname, agent_key in REPO_FILES:
        body = load_text(run_dir / subdir / fname)
        if body is None:
            continue
        reports.append(build_report(agent_key, body))

    run = Run(
        id=run_dir.name,
        ticker=ticker,
        trade_date=trade_date,
        created_at=dt.timestamp(),
        created_at_iso=dt.isoformat(),
        source="repo",
        decision=None, rating=None,
        research_decision=None, trader_decision=None, portfolio_decision=None,
        reports=reports,
        complete_report=load_text(run_dir / "complete_report.md"),
    )
    return finalize_run(run)


# ---------- source 2: ~/.tradingagents/logs/<TICKER>/<DATE>/reports ---------


def scan_logs_run(ticker: str, date_dir: Path) -> Run | None:
    if not DATE_DIR_RE.match(date_dir.name):
        return None
    reports_dir = date_dir / "reports"
    if not reports_dir.is_dir():
        return None
    trade_date = date_dir.name

    reports: list[Report] = []
    for candidates, agent_key in LOG_FILE_CANDIDATES:
        body: str | None = None
        for fname in candidates:
            body = load_text(reports_dir / fname)
            if body is not None:
                break
        if body is None:
            continue
        reports.append(build_report(agent_key, body))
    if not reports:
        return None

    # Use directory mtime as a proxy for created_at (no metadata file here).
    try:
        ts = reports_dir.stat().st_mtime
    except OSError:
        ts = datetime.strptime(trade_date, "%Y-%m-%d").timestamp()
    dt = datetime.fromtimestamp(ts)

    run = Run(
        id=f"{ticker}_{trade_date.replace('-', '')}_logs",
        ticker=ticker,
        trade_date=trade_date,
        created_at=ts,
        created_at_iso=dt.isoformat(),
        source="logs",
        decision=None, rating=None,
        research_decision=None, trader_decision=None, portfolio_decision=None,
        reports=reports,
        complete_report=None,
    )
    return finalize_run(run)


# ---------- source 3: ~/.tradingagents/web/runs/<id> ------------------------

# Map report_key (canonical state slot) -> agent_key
REPORT_KEY_TO_AGENT: dict[str, str] = {
    info[2]: agent_key for agent_key, info in AGENT_INFO.items()
}


def _handle_tool_call(
    e: dict,
    tool_calls: list[ToolCall],
    unmatched_by_tool: dict[str, list[int]],
) -> None:
    """Mirror the live reducer's chunk-merge: tool_call events arrive as
    streaming fragments; merge consecutive same-tool calls within 0.5s."""
    tool = e.get("tool")
    if not tool:
        return
    args = e.get("args", "")
    ts = float(e.get("ts") or 0.0)

    if tool_calls:
        last = tool_calls[-1]
        if last.tool == tool and last.result is None and abs(ts - last.ts) < 0.5:
            # Continuation chunk — append args (model streams arg JSON as
            # successive string fragments).
            last.args = _merge_args(last.args, args)
            return

    tool_calls.append(ToolCall(
        tool=tool,
        agent=e.get("agent"),
        agent_label=e.get("label"),
        args=args,
        result=None,
        ts=ts,
    ))
    unmatched_by_tool.setdefault(tool, []).append(len(tool_calls) - 1)


def _handle_tool_result(
    e: dict,
    tool_calls: list[ToolCall],
    unmatched_by_tool: dict[str, list[int]],
) -> None:
    tool = e.get("tool")
    if not tool:
        return
    result = e.get("result")
    queue = unmatched_by_tool.get(tool)
    if not queue:
        # Tool result without a matching call (rare — possibly a replay artefact).
        # Attach as a synthetic call so the user can still see the result.
        tool_calls.append(ToolCall(
            tool=tool, agent=None, agent_label=None,
            args=None, result=result, ts=float(e.get("ts") or 0.0),
        ))
        return
    idx = queue.pop(0)
    tool_calls[idx].result = result


def _merge_args(prev: object, new: object) -> object:
    """Concatenate args fragments from streaming tool_call events."""
    if isinstance(prev, str) and isinstance(new, str):
        return prev + new
    if prev is None or prev == "":
        return new
    if new is None or new == "":
        return prev
    # Mismatched shapes — take the newer one.
    return new


def _finalize_tool_args(tool_calls: list[ToolCall]) -> None:
    """Parse each tool_call's `args` from streamed JSON string to a real dict
    where possible. Keeps the raw string on failure so the Tools tab still
    has something to show."""
    for tc in tool_calls:
        if isinstance(tc.args, str):
            try:
                tc.args = json.loads(tc.args)
            except (json.JSONDecodeError, ValueError):
                pass  # leave as raw string


def scan_web_run(run_dir: Path) -> Run | None:
    meta_path = run_dir / "run.json"
    events_path = run_dir / "events.jsonl"
    if not meta_path.is_file() or not events_path.is_file():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if meta.get("status") != "completed":
        return None

    ticker = meta.get("ticker")
    trade_date = meta.get("trade_date")
    if not ticker or not trade_date:
        return None

    # Walk events.jsonl once and capture three threads of state:
    #   - latest_report:  most recent body per report_key
    #   - tool_calls:     stitched tool_call chunks paired with their tool_results
    latest_report: dict[str, str] = {}
    tool_calls: list[ToolCall] = []
    # FIFO queues of indices-into-tool_calls per tool name, used to match each
    # incoming `tool_result` with the next unfulfilled call of the same name.
    unmatched_by_tool: dict[str, list[int]] = {}

    with events_path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                e = json.loads(line)
            except json.JSONDecodeError:
                continue
            etype = e.get("type")
            if etype == "report":
                key = e.get("report_key")
                body = e.get("report")
                if key and body:
                    latest_report[key] = body
            elif etype == "tool_call":
                _handle_tool_call(e, tool_calls, unmatched_by_tool)
            elif etype == "tool_result":
                _handle_tool_result(e, tool_calls, unmatched_by_tool)

    reports: list[Report] = []
    for report_key, body in latest_report.items():
        agent_key = REPORT_KEY_TO_AGENT.get(report_key)
        if not agent_key:
            continue
        reports.append(build_report(agent_key, body))
    if not reports:
        return None

    _finalize_tool_args(tool_calls)

    created_at = float(meta.get("created_at") or 0) or run_dir.stat().st_mtime
    dt = datetime.fromtimestamp(created_at)

    # Prefer the actual ratings the web backend persisted in run.json.
    decision_text = (
        latest_report.get("final_trade_decision")
        or latest_report.get("trader_investment_plan")
    )
    run = Run(
        id=f"{ticker}_{trade_date.replace('-', '')}_web_{run_dir.name[:8]}",
        ticker=ticker,
        trade_date=trade_date,
        created_at=created_at,
        created_at_iso=dt.isoformat(),
        source="web",
        decision=decision_text,
        rating=parse_rating(meta.get("decision")) or parse_rating(decision_text),
        # The backend's run.json stores these as raw "BUY"/"SELL"/"HOLD" strings;
        # normalize through parse_rating so the front-end's CSS classes match.
        research_decision=parse_rating(meta.get("research_decision")) or parse_rating(latest_report.get("investment_plan")),
        trader_decision=parse_rating(meta.get("trader_decision")) or parse_rating(latest_report.get("trader_investment_plan")),
        portfolio_decision=parse_rating(meta.get("portfolio_decision")) or parse_rating(latest_report.get("final_trade_decision")),
        analysis_decision=(parse_rating(meta.get("analysis_decision"))
                            or _majority_rating([
                                parse_rating(latest_report.get(k))
                                for k in _ANALYST_REPORT_KEYS
                            ])),
        llm_provider=(meta.get("config") or {}).get("llm_provider"),
        deep_think_llm=(meta.get("config") or {}).get("deep_think_llm"),
        reports=reports,
        tool_calls=tool_calls,
        complete_report=synthesize_complete_report(ticker, trade_date, reports),
    )
    # finalize_run would overwrite the values from meta — only call it if we
    # need to fill in missing fields.
    if run.decision and run.complete_report:
        return run
    return finalize_run(run)


# ---------- aggregator ------------------------------------------------------


def collect() -> list[Run]:
    candidates: list[Run] = []

    if REPO_REPORTS_DIR.is_dir():
        for child in sorted(REPO_REPORTS_DIR.iterdir()):
            if child.is_dir():
                run = scan_repo_run(child)
                if run is not None:
                    candidates.append(run)

    if USER_LOGS_DIR.is_dir():
        for ticker_dir in sorted(USER_LOGS_DIR.iterdir()):
            if not ticker_dir.is_dir():
                continue
            ticker = ticker_dir.name
            for date_dir in sorted(ticker_dir.iterdir()):
                if not date_dir.is_dir():
                    continue
                run = scan_logs_run(ticker, date_dir)
                if run is not None:
                    candidates.append(run)

    if USER_WEB_RUNS_DIR.is_dir():
        for run_dir in sorted(USER_WEB_RUNS_DIR.iterdir()):
            if not run_dir.is_dir():
                continue
            run = scan_web_run(run_dir)
            if run is not None:
                candidates.append(run)

    # Dedup by (ticker, trade_date). Preference order: repo > logs > web,
    # broken by report count. The intent: when the same run has been promoted
    # to reports/, prefer that polished copy; otherwise take whichever source
    # has the most content.
    priority = {"repo": 3, "logs": 2, "web": 1}
    grouped: dict[tuple[str, str], Run] = {}
    for run in candidates:
        key = (run.ticker, run.trade_date)
        existing = grouped.get(key)
        if existing is None:
            grouped[key] = run
            continue
        if (priority[run.source], len(run.reports)) > (priority[existing.source], len(existing.reports)):
            grouped[key] = run

    # Drop runs that never reached a portfolio-manager decision — they're
    # incomplete (often a crashed/killed CLI run) and not useful for the
    # archive view.
    runs = [r for r in grouped.values() if r.portfolio_decision]
    runs.sort(key=lambda r: r.created_at, reverse=True)
    return runs


def serialize_run_summary(run: Run) -> dict:
    return {
        "id": run.id,
        "ticker": run.ticker,
        "trade_date": run.trade_date,
        "created_at": run.created_at,
        "created_at_iso": run.created_at_iso,
        "source": run.source,
        "rating": run.rating,
        "analysis_decision": run.analysis_decision,
        "research_decision": run.research_decision,
        "trader_decision": run.trader_decision,
        "portfolio_decision": run.portfolio_decision,
        "report_count": len(run.reports),
        "tool_count": len(run.tool_calls),
        "llm_provider": run.llm_provider,
        "deep_think_llm": run.deep_think_llm,
    }


def main() -> int:
    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    (OUT_DIR / "runs").mkdir(parents=True)

    runs = collect()
    if not runs:
        print("warn: no runs found in reports/, ~/.tradingagents/logs, or ~/.tradingagents/web/runs",
              file=sys.stderr)

    manifest = {
        "generated_at": datetime.utcnow().isoformat() + "Z",
        "runs": [serialize_run_summary(r) for r in runs],
    }
    (OUT_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )

    for run in runs:
        out_path = OUT_DIR / "runs" / f"{run.id}.json"
        out_path.write_text(
            json.dumps(asdict(run), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    by_source: dict[str, int] = {}
    for r in runs:
        by_source[r.source] = by_source.get(r.source, 0) + 1
    summary = ", ".join(f"{k}={v}" for k, v in sorted(by_source.items()))
    print(f"wrote {len(runs)} run(s) ({summary}) -> {OUT_DIR.relative_to(REPO_ROOT)}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
