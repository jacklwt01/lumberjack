import { getMarketTrades, tradePrice, type ActivityTrade } from './polymarket.js'

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr
  const step = Math.ceil(arr.length / maxPoints)
  const out: T[] = []
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]!)
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]!)
  return out
}

/** Implied odds over time from public market trades for one outcome. */
export async function buildMarketOddsTapeSeries(
  conditionId: string,
  outcomeIndex: number,
  maxPoints = 45
): Promise<{ labels: string[]; oddsPct: number[] }> {
  const desc = await getMarketTrades(conditionId, { limit: 400, offset: 0 })
  const chron = [...desc]
    .reverse()
    .filter((t: ActivityTrade) => t.outcomeIndex === outcomeIndex)

  const labels: string[] = []
  const oddsPct: number[] = []
  for (const t of chron) {
    const p = tradePrice(t)
    if (p <= 0) continue
    labels.push(fmtTime(t.timestamp))
    oddsPct.push(p * 100)
  }

  const idxs = downsample(
    labels.map((_, i) => i),
    maxPoints
  )
  return {
    labels: idxs.map((i) => labels[i]!),
    oddsPct: idxs.map((i) => oddsPct[i]!),
  }
}
