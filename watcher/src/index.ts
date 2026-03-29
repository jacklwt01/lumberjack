import 'dotenv/config'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { diffSnapshots } from './diff.js'
import { estimateImpactAroundWallet, marketMidPrice, roughNotionalUsd } from './impact.js'
import {
  canSendEmail,
  sendAlertEmail,
  sendSnapshotSummaryEmail,
  type MarketAlertBlock,
} from './email.js'
import { getMarketQuestion, getTopHolders, getWalletMarketTrades } from './polymarket.js'
import { buildSnapshot, loadSnapshot, saveSnapshot } from './snapshot.js'
import { buildSnapshotMarketSection } from './snapshotSummary.js'
import { buildSeriesForOutcome } from './seriesFromTrades.js'

function envList(key: string): string[] {
  const raw = process.env[key] ?? ''
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

type SubscribedMarket = {
  conditionId: string
  question?: string
  outcomes?: string
}

type FileSubscription = {
  email?: string
  markets?: Record<string, unknown>[]
}

function envPathOr(key: string, fallback: string): string {
  const v = process.env[key]?.trim()
  return v && v.length > 0 ? v : fallback
}

function parseSubscribedMarkets(raw: unknown[]): SubscribedMarket[] {
  const out: SubscribedMarket[] = []
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue
    const o = m as Record<string, unknown>
    const id = typeof o.conditionId === 'string' ? o.conditionId.trim() : ''
    if (!id) continue
    out.push({
      conditionId: id,
      question: typeof o.question === 'string' ? o.question : undefined,
      outcomes: typeof o.outcomes === 'string' ? o.outcomes : undefined,
    })
  }
  return out
}

/** Reads dashboard subscription file; falls back to env market IDs only. */
async function resolveWatchlist(): Promise<{
  email: string | undefined
  markets: SubscribedMarket[]
}> {
  const p = envPathOr(
    'ALERT_CONFIG_PATH',
    join(process.cwd(), '..', 'data', 'alert-subscription.json')
  )
  try {
    const raw = await readFile(p, 'utf8')
    const j = JSON.parse(raw) as FileSubscription
    const email =
      typeof j.email === 'string' && j.email.includes('@') ? j.email.trim() : undefined
    const markets = Array.isArray(j.markets) ? parseSubscribedMarkets(j.markets) : []
    if (markets.length > 0) return { email, markets }
  } catch {
    /* no file */
  }
  const envIds = envList('POLYMARKET_MARKETS')
  return {
    email: process.env.EMAIL_TO?.trim() || undefined,
    markets: envIds.map((conditionId) => ({ conditionId })),
  }
}

async function main(): Promise<void> {
  const { email: subscriptionEmail, markets: marketEntries } = await resolveWatchlist()

  if (marketEntries.length === 0) {
    console.error(
      'No markets to watch. Add them in the dashboard Whale alerts tab (saves data/alert-subscription.json) or set POLYMARKET_MARKETS in watcher/.env.'
    )
    process.exit(1)
  }

  const topLimit = Math.max(5, Math.min(50, Number(process.env.TOP_HOLDERS_LIMIT ?? '15')))
  const minUsd = Math.max(0, Number(process.env.MIN_CHANGE_USD ?? '500'))
  const baselineOnly = process.env.BASELINE_ONLY === 'true'
  const sendSnapshot = process.env.SEND_SNAPSHOT_EMAIL !== 'false'
  const snapshotDir = envPathOr('SNAPSHOT_DIR', join(process.cwd(), 'data', 'snapshots'))

  await mkdir(snapshotDir, { recursive: true })

  const alertBlocks: MarketAlertBlock[] = []
  const snapshotSections: Awaited<ReturnType<typeof buildSnapshotMarketSection>>[] = []
  let anyFirstRun = false

  for (const entry of marketEntries) {
    const conditionId = entry.conditionId
    const meta = await getTopHolders(conditionId, topLimit)
    const question = (await getMarketQuestion(conditionId)) || entry.question
    const nextSnap = buildSnapshot(conditionId, meta, topLimit, question)
    const prev = await loadSnapshot(snapshotDir, conditionId)

    if (!prev) {
      anyFirstRun = true
      await saveSnapshot(snapshotDir, nextSnap)
      console.log(`[baseline] Saved snapshot for ${conditionId}`)
      if (sendSnapshot && !baselineOnly) {
        try {
          const section = await buildSnapshotMarketSection(nextSnap, entry.outcomes)
          snapshotSections.push(section)
        } catch (e) {
          console.warn(`[snapshot email] Could not build section for ${conditionId}:`, e)
        }
      }
      continue
    }

    const events = diffSnapshots(prev, nextSnap)
    await saveSnapshot(snapshotDir, nextSnap)

    if (events.length === 0) continue

    const mid = await marketMidPrice(conditionId, events[0]!.outcomeIndex)
    const filtered = events.filter((e) => roughNotionalUsd(e.deltaShares, mid) >= minUsd)
    if (filtered.length === 0) continue

    const impactMap = new Map<string, import('./impact.js').PriceImpactEstimate>()
    for (const e of filtered) {
      const k = `${e.wallet.toLowerCase()}\0${e.outcomeIndex}`
      if (impactMap.has(k)) continue
      const est = await estimateImpactAroundWallet(conditionId, e, e.outcomeIndex)
      impactMap.set(k, est)
    }

    let primary = filtered[0]!
    let bestN = roughNotionalUsd(primary.deltaShares, mid)
    for (const e of filtered) {
      const n = roughNotionalUsd(e.deltaShares, mid)
      if (n > bestN) {
        bestN = n
        primary = e
      }
    }
    const walletTrades = await getWalletMarketTrades(primary.wallet, conditionId)
    const series = buildSeriesForOutcome(walletTrades, primary.outcomeIndex)
    const seriesPack = series.labels.length > 0 ? series : null
    const who = primary.name || primary.wallet.slice(0, 8)

    alertBlocks.push({
      conditionId,
      question: nextSnap.question,
      events: filtered,
      impacts: impactMap,
      series: seriesPack,
      seriesTitle: who,
    })
  }

  if (baselineOnly) {
    console.log('BASELINE_ONLY=true — no email sent.')
    return
  }

  if (snapshotSections.length > 0) {
    if (canSendEmail()) {
      const subject = `Polymarket watchlist snapshot — ${snapshotSections.length} market(s) — ${new Date().toISOString().slice(0, 16)}`
      await sendSnapshotSummaryEmail({
        sections: snapshotSections,
        subject,
        to: subscriptionEmail,
      })
      console.log(
        `Snapshot summary email sent to ${subscriptionEmail ?? process.env.EMAIL_TO ?? 'default'} (${snapshotSections.length} market(s)).`
      )
    } else {
      console.warn(
        '[snapshot email] SMTP_HOST / EMAIL_FROM not set — skipping snapshot email (snapshots still saved).'
      )
    }
  } else if (anyFirstRun) {
    console.log('First run: baseline snapshots saved. Configure SMTP to receive snapshot emails.')
  }

  if (alertBlocks.length === 0) {
    if (!anyFirstRun && snapshotSections.length === 0) console.log('No qualifying whale events.')
    return
  }

  if (!canSendEmail()) {
    console.warn('[whale alert] SMTP not configured — skipping whale alert email.')
    return
  }

  const subject = `Polymarket whale alert — ${alertBlocks.length} market(s) — ${new Date().toISOString().slice(0, 16)}`
  await sendAlertEmail({ blocks: alertBlocks, subject, to: subscriptionEmail })
  console.log(
    `Whale alert email sent to ${subscriptionEmail ?? process.env.EMAIL_TO ?? 'jack.li@jlico.co (default)'}`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
