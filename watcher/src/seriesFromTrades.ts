import { tradePrice, type ActivityTrade } from './polymarket.js'

export type SeriesPack = {
  labels: string[]
  position: number[]
  oddsPct: number[]
  usd: number[]
}

function fmtTime(ts: number): string {
  const d = new Date(ts * 1000)
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

/** Downsample to maxPoints for email/chart URL size limits. */
function downsample<T>(arr: T[], maxPoints: number): T[] {
  if (arr.length <= maxPoints) return arr
  const step = Math.ceil(arr.length / maxPoints)
  const out: T[] = []
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]!)
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]!)
  return out
}

export function buildSeriesForOutcome(trades: ActivityTrade[], outcomeIndex: number): SeriesPack {
  const rows = trades.filter((t) => t.outcomeIndex === outcomeIndex).sort((a, b) => a.timestamp - b.timestamp)

  let pos = 0
  const labels: string[] = []
  const position: number[] = []
  const oddsPct: number[] = []
  const usd: number[] = []

  for (const t of rows) {
    const side = (t.side ?? '').toUpperCase()
    const delta = side === 'BUY' ? t.size : side === 'SELL' ? -t.size : 0
    pos += delta
    const p = tradePrice(t)
    labels.push(fmtTime(t.timestamp))
    position.push(pos)
    oddsPct.push(p * 100)
    usd.push(pos * p)
  }

  const maxPoints = 40
  const idxs = downsample(
    labels.map((_, i) => i),
    maxPoints
  )
  return {
    labels: idxs.map((i) => labels[i]!),
    position: idxs.map((i) => position[i]!),
    oddsPct: idxs.map((i) => oddsPct[i]!),
    usd: idxs.map((i) => usd[i]!),
  }
}
