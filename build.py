#!/usr/bin/env python3
"""Generate static-web data from the repository's `reports/` directory.

Scans `<repo>/reports/<TICKER>_<YYYYMMDD>_<HHMMSS>/` directories, parses out
final/judge decisions, and emits:

    static-web/data/manifest.json          — list of run summaries
    static-web/data/runs/<run_id>.json     — full run detail incl. report bodies

The generated JSON is consumed by `static-web/app.js`. Running this script is
idempotent; the `data/` directory is wiped and rebuilt on every invocation.
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
REPORTS_DIR = REPO_ROOT / "reports"
OUT_DIR = HERE / "data"

# Map (subdir, filename-stem) -> (agent_key, team, label, report_key)
# - agent_key matches the `key` field in web/frontend/src/types.ts ALL_AGENTS
# - team is one of: analysts, research, trading, risk
# - report_key matches the canonical state slot in the running web UI
AGENT_FILES: list[tuple[str, str, str, str, str, str]] = [
    # (subdir,        filename,           agent_key,      team,       label,                 report_key)
    ("1_analysts",    "market.md",        "market",       "analysts", "Market Analyst",      "market_report"),
    ("1_analysts",    "sentiment.md",     "social",       "analysts", "Social Analyst",      "sentiment_report"),
    ("1_analysts",    "news.md",          "news",         "analysts", "News Analyst",        "news_report"),
    ("1_analysts",    "fundamentals.md",  "fundamentals", "analysts", "Fundamentals Analyst","fundamentals_report"),
    ("2_research",    "bull.md",          "bull",         "research", "Bull Researcher",     "bull_history"),
    ("2_research",    "bear.md",          "bear",         "research", "Bear Researcher",     "bear_history"),
    ("2_research",    "manager.md",       "research_mgr", "research", "Research Manager",    "investment_plan"),
    ("3_trading",     "trader.md",        "trader",       "trading",  "Trader",              "trader_investment_plan"),
    ("4_risk",        "aggressive.md",    "aggressive",   "risk",     "Aggressive Analyst",  "risk__aggressive_history"),
    ("4_risk",        "conservative.md",  "conservative", "risk",     "Conservative Analyst","risk__conservative_history"),
    ("4_risk",        "neutral.md",       "neutral",      "risk",     "Neutral Analyst",     "risk__neutral_history"),
    ("5_portfolio",   "decision.md",      "portfolio_mgr","risk",     "Portfolio Manager",   "final_trade_decision"),
]

RUN_ID_RE = re.compile(r"^(?P<ticker>[A-Z0-9.\-]+)_(?P<date>\d{8})_(?P<time>\d{6})$")
RATING_RE = re.compile(r"\b(BUY|SELL|HOLD)\b", re.IGNORECASE)


@dataclass
class Report:
    key: str          # report_key (canonical state slot)
    agent_key: str    # for sidebar mapping
    team: str
    label: str
    content: str


@dataclass
class Run:
    id: str
    ticker: str
    trade_date: str          # YYYY-MM-DD
    created_at: float        # unix timestamp
    created_at_iso: str
    decision: str | None             # full text of portfolio decision (or final summary)
    rating: str | None               # "buy" | "sell" | "hold" | null
    research_decision: str | None
    trader_decision: str | None
    portfolio_decision: str | None
    reports: list[Report] = field(default_factory=list)
    complete_report: str | None = None


def parse_rating(text: str | None) -> str | None:
    """Return 'buy' | 'sell' | 'hold' | None. BUY wins ties (mirrors web UI)."""
    if not text:
        return None
    upper = text.upper()
    if re.search(r"\bBUY\b", upper):
        return "buy"
    if re.search(r"\bSELL\b", upper):
        return "sell"
    if re.search(r"\bHOLD\b", upper):
        return "hold"
    return None


def parse_run_id(run_id: str) -> tuple[str, str, float, str] | None:
    """Decompose `TICKER_YYYYMMDD_HHMMSS` -> (ticker, trade_date, ts, iso)."""
    m = RUN_ID_RE.match(run_id)
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
    return ticker, trade_date, dt.timestamp(), dt.isoformat()


def load_text(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, OSError):
        return None


def scan_run(run_dir: Path) -> Run | None:
    parsed = parse_run_id(run_dir.name)
    if parsed is None:
        return None
    ticker, trade_date, ts, iso = parsed

    reports: list[Report] = []
    research_text: str | None = None
    trader_text: str | None = None
    portfolio_text: str | None = None

    for subdir, fname, agent_key, team, label, report_key in AGENT_FILES:
        fpath = run_dir / subdir / fname
        body = load_text(fpath)
        if body is None:
            continue
        reports.append(Report(
            key=report_key,
            agent_key=agent_key,
            team=team,
            label=label,
            content=body,
        ))
        if report_key == "investment_plan":
            research_text = body
        elif report_key == "trader_investment_plan":
            trader_text = body
        elif report_key == "final_trade_decision":
            portfolio_text = body

    complete_report = load_text(run_dir / "complete_report.md")

    # Final decision: prefer the portfolio manager's text, fall back to trader.
    decision_text = portfolio_text or trader_text
    rating = parse_rating(decision_text)

    return Run(
        id=run_dir.name,
        ticker=ticker,
        trade_date=trade_date,
        created_at=ts,
        created_at_iso=iso,
        decision=decision_text,
        rating=rating,
        research_decision=parse_rating(research_text),
        trader_decision=parse_rating(trader_text),
        portfolio_decision=parse_rating(portfolio_text),
        reports=reports,
        complete_report=complete_report,
    )


def serialize_run_summary(run: Run) -> dict:
    """Trimmed view used in the home-page manifest (no report bodies)."""
    return {
        "id": run.id,
        "ticker": run.ticker,
        "trade_date": run.trade_date,
        "created_at": run.created_at,
        "created_at_iso": run.created_at_iso,
        "rating": run.rating,
        "decision_preview": (run.decision or "").strip().split("\n", 1)[0][:240] or None,
        "research_decision": run.research_decision,
        "trader_decision": run.trader_decision,
        "portfolio_decision": run.portfolio_decision,
        "report_count": len(run.reports),
    }


def serialize_run_detail(run: Run) -> dict:
    d = asdict(run)
    return d


def main() -> int:
    if not REPORTS_DIR.is_dir():
        print(f"error: reports directory not found at {REPORTS_DIR}", file=sys.stderr)
        return 1

    if OUT_DIR.exists():
        shutil.rmtree(OUT_DIR)
    (OUT_DIR / "runs").mkdir(parents=True)

    runs: list[Run] = []
    for child in sorted(REPORTS_DIR.iterdir()):
        if not child.is_dir():
            continue
        run = scan_run(child)
        if run is None:
            print(f"skip: {child.name} (unrecognized layout)", file=sys.stderr)
            continue
        runs.append(run)

    # Newest first — matches the web UI's ordering.
    runs.sort(key=lambda r: r.created_at, reverse=True)

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
            json.dumps(serialize_run_detail(run), indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

    print(f"wrote {len(runs)} run(s) -> {OUT_DIR.relative_to(REPO_ROOT)}/")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
