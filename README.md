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
