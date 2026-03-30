# Polymarket holder dashboard

React + Vite UI to search Polymarket markets and inspect top holders. Includes a **Whale alerts** tab to save a **watch list** and **email** to `data/alert-subscription.json` (via a small local API).

## Run the dashboard

```bash
npm install
npm run dev
```

Opens Vite (usually `http://localhost:5173`) and starts the **alerts API** on port **3847** (needed for the Whale alerts tab).

- **Dashboard** — search markets, load top holders.
- **Whale alerts** — add/remove watched markets (same search UX), set the inbox for alerts, **Save**.

## Whale email watcher

The watcher reads `data/alert-subscription.json` when present (otherwise `POLYMARKET_MARKETS` in `watcher/.env`). See `watcher/README.md`.

```bash
cd watcher
npm install
npm run start
```

Schedule `watcher` with Task Scheduler or cron. SMTP credentials stay in `watcher/.env` only.

## Production note

`npm run build` produces static files in `dist/`. The alerts API is Node-only; host it beside the static site or run both locally.

## Whale flagging (holder table)

The dashboard flags some wallets as **suspicious whales** in the holder table and chart sidebar. This is a **heuristic**, not a claim of wrongdoing or skill; it is meant to surface addresses worth a second look.

### Data behind the stats

Per-wallet aggregates come from `getTraderClosedStats` in `src/polymarketApi.ts`:

1. **`/closed-positions`** — paginated (50 per page, up to 30 pages), sorted by timestamp descending.
2. **`/positions`** — paginated (500 per page, up to 4 pages) with **`sizeThreshold=0`** so tiny or zero-size rows are included.

Rows from both feeds are combined into **one leg per market outcome**: key = `conditionId` + `outcomeIndex`. If a leg already exists from **closed** positions, the open row is skipped (closed realized PnL stays authoritative for that outcome).

**Open-only** legs (no closed row yet) split into two paths:

- **Dust** (often resolved-but-still-listed): absolute size below **0.5** shares and **current value** at most **~$2**. PnL uses **`realizedPnl`** when non-negligible, else **`cashPnl`**. These count toward **lifetime** and **win rate** like closed legs. For the **30d** column, they count only when a time is known (closed-style `timestamp` does not apply here; **`endDate`** on the open row when parseable).
- **Active** (everything else on the open book): **lifetime** and **win / loss / breakeven** use **`cashPnl`**, i.e. Polymarket’s mark-to-market style PnL on that leg (includes unrealized). The **30d** column adds the **full current `cashPnl`** for each such leg as a **snapshot** (it is *not* strictly “realized inside the last 30 days” for long-held open positions).

**Capital** for return-on-capital is the sum of `totalBought × avgPrice` per leg when both exist; else **`initialValue`** on open rows when provided; otherwise **0**. **`truncated`** is true if either feed hits its page cap.

### Book vs Polymarket (holder table)

The holder table shows **two numbers per period** (stacked in one cell):

| Line | Source | Meaning |
|------|--------|--------|
| **Book** (top) | `getTraderClosedStats` | Merged **`/closed-positions`** + **`/positions`** as documented above (rolling ~30d logic for the first column; lifetime for the second). |
| **PM** (bottom) | `getPolymarketOfficialPnl` → **`GET /v1/leaderboard`** on `data-api.polymarket.com` | Polymarket’s own **`pnl`** for that **proxy wallet**: **`timePeriod=MONTH`** (calendar month, not the same as rolling 30 days) and **`timePeriod=ALL`** (profile-style all-time). |

Whale **flags**, **win rate**, and **return vs capital** still use **book** stats only so heuristics stay on one consistent definition. The PM line is for **comparison** against what the site emphasizes.

### When the flag turns on

Logic lives in `whaleFlagForRow` in `src/MainDashboard.tsx`. It collects **reason strings** from several independent checks (high lifetime or 30d **book** PnL, high win rate on merged legs including MTM open positions, strong return on estimated capital vs win rate, concentrated market count, etc.). The wallet is **flagged only if at least two distinct reasons** apply (`reasons.length >= 2` after deduplication).

Return-on-capital and some combos require enough sampled legs and estimated capital (see `CLOSED_CAPITAL_MIN_FOR_RETURN_PCT` and the thresholds in code). **Current position size in the market you are viewing is not** a whale signal; the copy in the UI calls that out as context only.

### Limitations

API semantics can change; dust heuristics can mis-classify edge cases; caps truncate very large histories; merged stats can still diverge from Polymarket’s own profile UI. Treat flags as **starting points for review**, not verdicts.

**Profile vs Data API (e.g. @arbguy):** The dashboard’s **lifetime** number is a direct aggregate of public **`/closed-positions`** (plus open-only legs as documented). That sum can **differ materially** from the **all-time PnL** shown on polymarket.com (different definitions, netting, or internal adjustments). For a high-volume account checked in development, **`/closed-positions` alone summed to a large positive net** while the site showed roughly flat — so the gap is **upstream of this repo**, not a merge/dedupe bug in the holder table.

**Why “30d book” can exceed “lifetime PnL”:** The 30d column sums **realized PnL only for legs whose close `timestamp` falls in the last 30 days**, **plus** full **MTM `cashPnl`** on open-only active legs. That is **not** “net portfolio change over 30 days.” If many large **wins** settled in the window but large **losses** settled **outside** the window, the **30d sum can be far above** the **lifetime** sum over **all** closed legs (same API) — both are internally consistent but measure different subsets.
