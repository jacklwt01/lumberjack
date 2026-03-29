# Polymarket whale email alerts

Node script that periodically compares **top holders** for markets you care about, detects **new whales**, **builds**, and **exits/reductions**, estimates a **rough price-impact proxy** from the public trade tape, and emails an **HTML report** (tables + chart images) to your inbox.

Default recipient in code examples: `jack.li@jlico.co` (override with `EMAIL_TO`).

## Setup

```bash
cd watcher
npm install
copy .env.example .env
```

Edit `.env`:

- **Preferred:** add markets and email in the dashboard **Whale alerts** tab (saves `../data/alert-subscription.json`). The watcher uses that file automatically when it exists.
- `POLYMARKET_MARKETS` — optional fallback: comma-separated **condition IDs** if no subscription file.
- `EMAIL_TO` — optional fallback if the subscription file has no email.
- `EMAIL_FROM` — must be allowed by your SMTP provider.
- `SMTP_*` — your mail server credentials.

## First run (baseline + snapshot email)

The first time each market appears in your watchlist, the tool **saves a baseline snapshot** and, if **SMTP is configured**, sends a **“watchlist snapshot”** email with:

- Top holders **per outcome** (Yes / No labels when the subscription has outcome metadata from the dashboard)
- **Charts**: implied odds from the public tape per outcome, plus **position + USD** charts for the **largest holder** on each of the first two outcomes (when present)

Later runs **only email whale alerts** when top-holder positions change enough (`MIN_CHANGE_USD`).

Set `SEND_SNAPSHOT_EMAIL=false` to skip snapshot emails but still save baselines.

Optional: `BASELINE_ONLY=true` to only refresh snapshots without sending **any** mail.

## Run manually

```bash
npm run start
```

## Schedule (Windows Task Scheduler)

Create a task that runs every 10–15 minutes:

- Program: `node` or full path to `node.exe`
- Arguments: `C:\path\to\polymarket-holder-dashboard\watcher\node_modules\tsx\dist\cli.mjs C:\path\to\watcher\src\index.ts`
- Start in: `C:\path\to\polymarket-holder-dashboard\watcher`

Or use `npm run start` with “Start in” set to the `watcher` folder.

## What the email contains

- **Table** of events: new top holder, building, reducing, dropped from top.
- **Price impact (proxy)**: median trade price for the **same outcome** before vs after activity anchored to the wallet’s latest trade (heuristic, not causal).
- **Charts** (embedded images via [QuickChart](https://quickchart.io/)): implied odds %, cumulative shares, approximate USD notional — built from the **wallet’s** trade history for the **largest** qualifying event in that market (to keep email size reasonable).

## Tunables

| Variable | Meaning |
|----------|---------|
| `TOP_HOLDERS_LIMIT` | How many top holders to flatten per run (default 15). |
| `MIN_CHANGE_USD` | Ignore events smaller than this **approximate** USD notional (default 500). |
| `POLYMARKET_DATA_BASE` | Override Data API URL (default `https://data-api.polymarket.com`). |
| `POLYMARKET_GAMMA_BASE` | Override Gamma URL for market titles (default `https://gamma-api.polymarket.com`). |
| `SNAPSHOT_DIR` | Where JSON snapshots are stored (default `watcher/data/snapshots`). |

## Limitations & ideas

- **Email needs SMTP** — GitHub-hosted frontends cannot send mail without a backend; this watcher is that small backend.
- **Snapshots are local** unless you commit them or use shared storage — for a VPS/cron job, keep `data/` on the server.
- **Improvements**: persist state in Redis; per-wallet chart attachments; Slack/webhook; stricter “whale” rules; websocket feeds if Polymarket exposes them.
