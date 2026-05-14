# TradingAgents — Static Reports Viewer

A read-only HTML/CSS/JS port of the [`web/`](../web) UI, intended for GitHub
Pages or any plain static-file host. It serves every Markdown report under
[`../reports/`](../reports) inside the same three-pane layout (agent sidebar +
report viewer + decision panel) you get in the live web app, but with no
backend, no API calls, and no streaming.

> If you want token-level streaming and the ability to launch new runs, use
> [`web/`](../web) instead. This directory exists so finished runs can be
> published as a browsable archive.

## Layout

```
static-web/
├── index.html        # SPA shell + hash router
├── app.js            # Vanilla JS — home page + run viewer
├── styles.css        # Ported theme (matches web/ frontend)
├── build.py          # Scans ../reports/ → data/manifest.json + data/runs/<id>.json
└── data/             # Generated; git-ignored by default
    ├── manifest.json
    └── runs/<run_id>.json
```

`marked@12` is loaded from a public CDN at runtime to render Markdown +
GitHub-flavored tables. Everything else is self-contained.

## Build the data

From the repo root, with any Python 3.10+:

```bash
python3 static-web/build.py
```

The script walks `reports/<TICKER>_<YYYYMMDD>_<HHMMSS>/`, extracts each
agent's markdown, parses the BUY/SELL/HOLD ratings out of the trader /
portfolio decisions, and writes:

- `static-web/data/manifest.json` — one summary entry per run (powers the home page)
- `static-web/data/runs/<id>.json` — full per-run payload with every report inlined

Re-run it whenever new reports show up in `../reports/`. The output is fully
self-contained — no relative links back to `../reports/` are needed.

## Run locally

The page must be served over HTTP for `fetch()` to load the JSON files
(opening `index.html` directly via `file://` will be blocked by CORS):

```bash
python3 -m http.server --directory . 4173
# open http://localhost:4173/
```

(Or any other free port — the live `web/` dev server uses 5173, so pick
something else if you're running both side by side.)

## Deploy to GitHub Pages

You have two options.

**Option A — commit the generated `data/` (current setup).**
Simplest path; everything lives in the repo and Pages serves it directly.

1. Run `python3 build.py` from `static-web/`.
2. Commit the `data/` directory along with the rest of `static-web/`.
3. Push to the [`tradingagentsreports`](https://github.com/eyc7/tradingagentsreports)
   repo's `main` branch.
4. In that repo's **Settings → Pages**, pick **Deploy from a branch**, choose
   `main`, and set the folder to `/` (root).

**Option B — build on CI.**
Keep `data/` git-ignored and regenerate it on every push. Drop the workflow
below into `.github/workflows/static-web.yml`:

```yaml
name: Publish static-web to Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-python@v5
        with: { python-version: "3.12" }
      - run: python3 static-web/build.py
      - uses: actions/upload-pages-artifact@v3
        with: { path: static-web }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deploy.outputs.page_url }}
    steps:
      - id: deploy
        uses: actions/deploy-pages@v4
```

Then in **Settings → Pages**, set the source to **GitHub Actions**.

## What gets parsed

For each `reports/<ticker>_<date>_<time>/` directory the build script reads:

| File                              | Surfaced as              |
|---                                |---                       |
| `1_analysts/{market,sentiment,news,fundamentals}.md` | sidebar entries under "Analysts"   |
| `2_research/{bull,bear,manager}.md`                  | "Research" team                    |
| `3_trading/trader.md`                                | "Trading" team                     |
| `4_risk/{aggressive,conservative,neutral}.md`        | "Risk Mgmt" team                   |
| `5_portfolio/decision.md`                            | "Risk Mgmt" → Portfolio Manager, also drives the final BUY/SELL/HOLD pill |
| `complete_report.md`                                 | "Complete Report" view in the main pane                                   |

The home-page card chain (`Research → Trader → Portfolio`) is built by
scanning each stage's markdown for the first `BUY`/`SELL`/`HOLD` keyword —
the same rule the live web UI uses.

## Differences from the live `web/` UI

- No "New Run" form — the form is replaced with a small intro panel + ticker
  filter.
- No token streaming or agent status dots. Every agent in the sidebar is
  either reachable (had a report) or greyed out.
- The viewer pane has three tabs: **Reports** (decision banner +
  `complete_report.md` or a single agent's report), **Charts** (price
  candlestick with indicator overlays, fundamentals, and quarterly + annual
  YoY bar graphs for income / balance / cash flow), and **Tools** (raw
  agent tool calls + arguments + results).
- Charts and Tools are populated only for runs sourced from
  `~/.tradingagents/web/runs/` — the `reports/` and `~/.tradingagents/logs/`
  sources don't carry tool-call data.

## Layout (additional files)

`charts.js` is the vanilla-JS port of `web/frontend/src/lib/parseTools.ts`
and the React chart components, using Plotly loaded from a CDN.
