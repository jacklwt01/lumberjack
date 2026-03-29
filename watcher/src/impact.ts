import {
  getMarketTrades,
  getWalletMarketTrades,
  tradePrice,
  type ActivityTrade,
} from './polymarket.js'
import type { WhaleEvent } from './diff.js'

export type PriceImpactEstimate = {
  beforeMedian: number | null
  afterMedian: number | null
  changePctPoints: number | null
  windowTrades: number
  note: string
}

function median(nums: number[]): number | null {
  const a = nums.filter((n) => Number.isFinite(n)).sort((x, y) => x - y)
  if (a.length === 0) return null
  const mid = Math.floor(a.length / 2)
  return a.length % 2 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2
}

/**
 * Rough impact: median trade price before vs after anchor timestamp (same outcome).
 */
export async function estimateImpactAroundWallet(
  conditionId: string,
  event: WhaleEvent,
  outcomeIndex: number
): Promise<PriceImpactEstimate> {
  const walletTrades = await getWalletMarketTrades(event.wallet, conditionId)
  const relevant = walletTrades.filter((t) => t.outcomeIndex === outcomeIndex)
  if (relevant.length === 0) {
    return {
      beforeMedian: null,
      afterMedian: null,
      changePctPoints: null,
      windowTrades: 0,
      note: 'No recent wallet trades found for this outcome.',
    }
  }
  const anchor = relevant[relevant.length - 1]!.timestamp

  const marketDesc = await getMarketTrades(conditionId, { limit: 500, offset: 0 })
  const chron = [...marketDesc].reverse().filter((t) => t.outcomeIndex === outcomeIndex)

  const idx = chron.findIndex((t) => t.timestamp >= anchor)
  if (idx < 0) {
    return {
      beforeMedian: null,
      afterMedian: null,
      changePctPoints: null,
      windowTrades: chron.length,
      note: 'Could not align anchor trade with market tape.',
    }
  }

  const before = chron.slice(Math.max(0, idx - 20), idx).map(tradePrice)
  const after = chron.slice(idx, Math.min(chron.length, idx + 20)).map(tradePrice)

  const b = median(before)
  const a = median(after)
  let changePctPoints: number | null = null
  if (b != null && a != null && b > 1e-6) {
    changePctPoints = ((a - b) / b) * 100
  }

  return {
    beforeMedian: b,
    afterMedian: a,
    changePctPoints,
    windowTrades: chron.length,
    note:
      changePctPoints != null
        ? `Median price ~${(b! * 100).toFixed(2)}¢ → ~${(a! * 100).toFixed(2)}¢ (same-outcome trades near wallet activity).`
        : 'Insufficient price points around the event.',
  }
}

export function roughNotionalUsd(deltaShares: number, midPrice: number): number {
  const p = Math.min(1, Math.max(0, midPrice))
  return Math.abs(deltaShares) * p
}

export async function marketMidPrice(
  conditionId: string,
  outcomeIndex: number
): Promise<number> {
  const rows = await getMarketTrades(conditionId, { limit: 120, offset: 0 })
  const prices = rows
    .filter((t: ActivityTrade) => t.outcomeIndex === outcomeIndex)
    .map(tradePrice)
    .filter((p) => p > 0)
  const m = median(prices)
  return m ?? 0.5
}
