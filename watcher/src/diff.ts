import type { MarketSnapshot, HolderSnapshot } from './snapshot.js'

export type WhaleEventType = 'NEW_WHALE' | 'BUILD' | 'REDUCE' | 'EXIT_TOP'

export type WhaleEvent = {
  type: WhaleEventType
  wallet: string
  outcomeIndex: number
  name?: string
  prevAmount: number
  nextAmount: number
  deltaShares: number
  prevRank: number | null
  nextRank: number | null
}

const key = (w: string, o: number) => `${w.toLowerCase()}\0${o}`

function mapByKey(holders: HolderSnapshot[]): Map<string, HolderSnapshot> {
  const m = new Map<string, HolderSnapshot>()
  for (const h of holders) m.set(key(h.wallet, h.outcomeIndex), h)
  return m
}

export function diffSnapshots(prev: MarketSnapshot | null, next: MarketSnapshot): WhaleEvent[] {
  if (!prev) return []

  const prevM = mapByKey(prev.holders)
  const nextM = mapByKey(next.holders)
  const events: WhaleEvent[] = []

  for (const [k, n] of nextM) {
    const p = prevM.get(k)
    if (!p) {
      events.push({
        type: 'NEW_WHALE',
        wallet: n.wallet,
        outcomeIndex: n.outcomeIndex,
        name: n.name,
        prevAmount: 0,
        nextAmount: n.amount,
        deltaShares: n.amount,
        prevRank: null,
        nextRank: n.rank,
      })
      continue
    }
    const delta = n.amount - p.amount
    if (Math.abs(delta) < 1e-6) continue

    if (delta > 0) {
      events.push({
        type: 'BUILD',
        wallet: n.wallet,
        outcomeIndex: n.outcomeIndex,
        name: n.name,
        prevAmount: p.amount,
        nextAmount: n.amount,
        deltaShares: delta,
        prevRank: p.rank,
        nextRank: n.rank,
      })
    } else {
      const leftTop = n.amount <= 0.01
      events.push({
        type: leftTop ? 'EXIT_TOP' : 'REDUCE',
        wallet: n.wallet,
        outcomeIndex: n.outcomeIndex,
        name: n.name,
        prevAmount: p.amount,
        nextAmount: n.amount,
        deltaShares: delta,
        prevRank: p.rank,
        nextRank: n.rank,
      })
    }
  }

  for (const [k, p] of prevM) {
    if (nextM.has(k)) continue
    events.push({
      type: 'EXIT_TOP',
      wallet: p.wallet,
      outcomeIndex: p.outcomeIndex,
      name: p.name,
      prevAmount: p.amount,
      nextAmount: 0,
      deltaShares: -p.amount,
      prevRank: p.rank,
      nextRank: null,
    })
  }

  return events
}
