import { chartUrlLine, chartUrlOddsPct, chartUrlUsd } from './charts.js'
import { getWalletMarketTrades } from './polymarket.js'
import type { MarketSnapshot, HolderSnapshot } from './snapshot.js'
import { buildSeriesForOutcome } from './seriesFromTrades.js'
import { buildMarketOddsTapeSeries } from './tapeSeries.js'

export type SnapshotTableRow = {
  rank: number
  name?: string
  wallet: string
  shares: number
}

export type SnapshotOutcomeBlock = {
  outcomeIndex: number
  label: string
  rows: SnapshotTableRow[]
}

export type SnapshotChartImg = { title: string; src: string }

export type SnapshotMarketSection = {
  conditionId: string
  question?: string
  outcomes: SnapshotOutcomeBlock[]
  charts: SnapshotChartImg[]
}

export function parseOutcomesJson(raw: string | undefined): string[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

function fmtWallet(w: string): string {
  if (w.length < 12) return w
  return `${w.slice(0, 6)}…${w.slice(-4)}`
}

function topByOutcome(
  holders: HolderSnapshot[],
  outcomeIndex: number,
  n: number
): SnapshotTableRow[] {
  const rows = holders
    .filter((h) => h.outcomeIndex === outcomeIndex)
    .sort((a, b) => b.amount - a.amount)
    .slice(0, n)
  return rows.map((h, i) => ({
    rank: i + 1,
    name: h.name,
    wallet: h.wallet,
    shares: h.amount,
  }))
}

/** Largest holder for an outcome (by amount in snapshot). */
function leaderWallet(holders: HolderSnapshot[], outcomeIndex: number): HolderSnapshot | null {
  const rows = holders.filter((h) => h.outcomeIndex === outcomeIndex)
  if (rows.length === 0) return null
  return rows.reduce((a, b) => (b.amount > a.amount ? b : a))
}

const TOP_TABLE = 8
const MAX_OUTCOME_CHARTS = 3

export async function buildSnapshotMarketSection(
  snap: MarketSnapshot,
  subscriptionOutcomesJson?: string
): Promise<SnapshotMarketSection> {
  const names = parseOutcomesJson(subscriptionOutcomesJson)
  const idxSet = new Set(snap.holders.map((h) => h.outcomeIndex))
  const indices = [...idxSet].sort((a, b) => a - b)

  if (indices.length === 0) {
    const charts: SnapshotChartImg[] = []
    const tape = await buildMarketOddsTapeSeries(snap.conditionId, 0)
    if (tape.labels.length > 0) {
      charts.push({
        title: 'Outcome 0 — market implied odds (from tape)',
        src: chartUrlOddsPct(tape.labels, tape.oddsPct, snap.question ?? snap.conditionId.slice(0, 24)),
      })
    }
    return {
      conditionId: snap.conditionId,
      question: snap.question,
      outcomes: [],
      charts,
    }
  }

  const outcomes: SnapshotOutcomeBlock[] = []
  for (const outcomeIndex of indices) {
    const label = names[outcomeIndex] ?? (indices.length === 2 && outcomeIndex === 0 ? 'Yes' : indices.length === 2 && outcomeIndex === 1 ? 'No' : `Outcome ${outcomeIndex}`)
    outcomes.push({
      outcomeIndex,
      label,
      rows: topByOutcome(snap.holders, outcomeIndex, TOP_TABLE),
    })
  }

  const charts: SnapshotChartImg[] = []

  for (const outcomeIndex of indices.slice(0, MAX_OUTCOME_CHARTS)) {
    const label = names[outcomeIndex] ?? `Outcome ${outcomeIndex}`
    const tape = await buildMarketOddsTapeSeries(snap.conditionId, outcomeIndex)
    if (tape.labels.length > 0) {
      charts.push({
        title: `${label} — market implied odds (from tape)`,
        src: chartUrlOddsPct(tape.labels, tape.oddsPct, `${snap.question ?? snap.conditionId.slice(0, 24)} · ${label}`),
      })
    }
  }

  const leaderOutcomes = indices.length >= 2 ? [0, 1].filter((i) => idxSet.has(i)) : indices.slice(0, 2)
  for (const outcomeIndex of leaderOutcomes) {
    const label = names[outcomeIndex] ?? `Outcome ${outcomeIndex}`
    const leader = leaderWallet(snap.holders, outcomeIndex)
    if (!leader) continue
    const trades = await getWalletMarketTrades(leader.wallet, snap.conditionId)
    const series = buildSeriesForOutcome(trades, outcomeIndex)
    if (series.labels.length === 0) continue
    const who = leader.name || fmtWallet(leader.wallet)
    charts.push({
      title: `${label} leader (${who}) — position (shares)`,
      src: chartUrlLine(series.labels, series.position, `${label} · cumulative shares`),
    })
    charts.push({
      title: `${label} leader (${who}) — notional USD`,
      src: chartUrlUsd(series.labels, series.usd, `${label} · approx USD`),
    })
  }

  return {
    conditionId: snap.conditionId,
    question: snap.question,
    outcomes,
    charts,
  }
}
