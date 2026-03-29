/** Minimal Polymarket Data API client for the whale watcher. */

const DATA_BASE = process.env.POLYMARKET_DATA_BASE ?? 'https://data-api.polymarket.com'
const GAMMA_BASE = process.env.POLYMARKET_GAMMA_BASE ?? 'https://gamma-api.polymarket.com'

export type HolderRow = {
  proxyWallet: string
  amount: number
  outcomeIndex: number
  name?: string
  pseudonym?: string
}

export type MetaHolder = {
  token: string
  holders: HolderRow[]
}

export type ActivityTrade = {
  timestamp: number
  size: number
  usdcSize?: number
  side: string
  price: number
  outcomeIndex: number
  type?: string
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object' && 'value' in raw && Array.isArray((raw as { value: unknown }).value)) {
    return (raw as { value: T[] }).value
  }
  return []
}

export async function getMarketQuestion(conditionId: string): Promise<string | undefined> {
  const urls = [
    `${GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}`,
    `${GAMMA_BASE}/markets?conditionId=${encodeURIComponent(conditionId)}`,
  ]
  for (const url of urls) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const raw = await res.json()
      const rows = parseJsonArray<Record<string, unknown>>(raw)
      const row = rows.find((m) => String(m.conditionId ?? m.condition_id ?? '') === conditionId) ?? rows[0]
      const q = row?.question
      if (typeof q === 'string' && q.length > 0) return q
    } catch {
      /* try next */
    }
  }
  return undefined
}

export async function getTopHolders(conditionId: string, limit: number): Promise<MetaHolder[]> {
  const url = `${DATA_BASE}/holders?market=${encodeURIComponent(conditionId)}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Holders failed (${res.status}) for ${conditionId}`)
  const raw = await res.json()
  return parseJsonArray<MetaHolder>(raw)
}

/** Recent market-wide trades (for price path / impact). */
export async function getMarketTrades(
  conditionId: string,
  opts: { limit?: number; offset?: number } = {}
): Promise<ActivityTrade[]> {
  const limit = opts.limit ?? 200
  const offset = opts.offset ?? 0
  const url =
    `${DATA_BASE}/activity?market=${encodeURIComponent(conditionId)}` +
    `&limit=${limit}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC&type=TRADE`
  const res = await fetch(url)
  if (!res.ok) return []
  const raw = await res.json()
  return parseJsonArray<ActivityTrade & { type?: string }>(raw).filter(
    (r) => !r.type || r.type === 'TRADE'
  )
}

/** Wallet trades in this market (ascending by time for series). */
export async function getWalletMarketTrades(
  wallet: string,
  conditionId: string,
  maxOffset = 5000
): Promise<ActivityTrade[]> {
  const page = 200
  const all: ActivityTrade[] = []
  for (let offset = 0; offset <= maxOffset; offset += page) {
    const url =
      `${DATA_BASE}/activity?user=${encodeURIComponent(wallet)}` +
      `&market=${encodeURIComponent(conditionId)}` +
      `&limit=${page}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=ASC&type=TRADE`
    const res = await fetch(url)
    if (!res.ok) break
    const raw = await res.json()
    const rows = parseJsonArray<ActivityTrade & { type?: string }>(raw)
    if (rows.length === 0) break
    for (const r of rows) {
      if (r.type && r.type !== 'TRADE') continue
      all.push(r)
    }
    if (rows.length < page) break
  }
  return all
}

export function tradePrice(t: ActivityTrade): number {
  if (typeof t.price === 'number' && Number.isFinite(t.price) && t.price >= 0) {
    return Math.min(1, Math.max(0, t.price))
  }
  if (t.size > 0 && t.usdcSize != null && Number.isFinite(t.usdcSize)) {
    const p = t.usdcSize / t.size
    return Math.min(1, Math.max(0, p))
  }
  return 0
}
