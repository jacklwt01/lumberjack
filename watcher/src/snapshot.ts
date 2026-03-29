import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HolderRow, MetaHolder } from './polymarket.js'

export type HolderSnapshot = {
  wallet: string
  outcomeIndex: number
  amount: number
  rank: number
  name?: string
}

export type MarketSnapshot = {
  conditionId: string
  question?: string
  savedAt: string
  topLimit: number
  holders: HolderSnapshot[]
}

function flattenHolders(meta: MetaHolder[], topLimit: number): HolderSnapshot[] {
  const rows: { holder: HolderRow; outcomeIndex: number; blockIdx: number; idx: number }[] = []
  for (let bi = 0; bi < meta.length; bi++) {
    const block = meta[bi]
    const list = block.holders ?? []
    for (let i = 0; i < list.length; i++) {
      const h = list[i]
      rows.push({ holder: h, outcomeIndex: h.outcomeIndex, blockIdx: bi, idx: i })
    }
  }
  rows.sort((a, b) => b.holder.amount - a.holder.amount)
  const top = rows.slice(0, topLimit)
  return top.map((r, rank) => ({
    wallet: r.holder.proxyWallet,
    outcomeIndex: r.outcomeIndex,
    amount: r.holder.amount,
    rank: rank + 1,
    name: r.holder.name || r.holder.pseudonym,
  }))
}

export function buildSnapshot(
  conditionId: string,
  meta: MetaHolder[],
  topLimit: number,
  question?: string
): MarketSnapshot {
  return {
    conditionId,
    question,
    savedAt: new Date().toISOString(),
    topLimit,
    holders: flattenHolders(meta, topLimit),
  }
}

export function snapshotPath(dir: string, conditionId: string): string {
  const safe = conditionId.replace(/[^a-zA-Z0-9_-]/g, '_')
  return join(dir, `${safe}.json`)
}

export async function loadSnapshot(dir: string, conditionId: string): Promise<MarketSnapshot | null> {
  const p = snapshotPath(dir, conditionId)
  try {
    const raw = await readFile(p, 'utf8')
    return JSON.parse(raw) as MarketSnapshot
  } catch {
    return null
  }
}

export async function saveSnapshot(dir: string, snap: MarketSnapshot): Promise<void> {
  const p = snapshotPath(dir, snap.conditionId)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(snap, null, 2), 'utf8')
}
