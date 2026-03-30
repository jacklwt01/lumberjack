/** Polymarket public HTTP APIs. Dev server proxies to avoid CORS. */

const GAMMA_BASE = import.meta.env.DEV ? '/api/gamma' : 'https://gamma-api.polymarket.com'
const DATA_BASE = import.meta.env.DEV ? '/api/data' : 'https://data-api.polymarket.com'

export type GammaMarket = {
  id: string
  question: string
  conditionId: string
  slug: string
  outcomes: string
  outcomePrices?: string
  volume?: string
  active?: boolean
  closed?: boolean
  archived?: boolean
  umaResolutionStatus?: string
}

export type SearchMarketRow = {
  conditionId: string
  question: string
  slug: string
  eventTitle: string
  outcomes: string
  volumeNum?: number
}

export type HolderRow = {
  proxyWallet: string
  amount: number
  outcomeIndex: number
  name?: string
  pseudonym?: string
}

export type MetaHolder = { token: string; holders: HolderRow[] }

export type PublicProfile = {
  createdAt: string | null
  proxyWallet: string | null
  name?: string | null
  pseudonym?: string | null
}

export type ActivityTrade = {
  timestamp: number
  size: number
  usdcSize?: number
  side: string
  price: number
  outcome: string
}

/** See Data API ClosedPosition schema; totalBought × avgPrice ≈ USDC deployed on that closed leg. */
export type ClosedPosition = {
  realizedPnl: number
  timestamp: number
  title: string
  conditionId: string
  outcomeIndex?: number
  totalBought?: number
  avgPrice?: number
}

export type PositionRow = {
  outcome: string
  outcomeIndex: number
  size: number
  avgPrice: number
  cashPnl: number
  realizedPnl: number
  currentValue: number
}

/** Full `/positions` row for a user (Data API Position schema). */
export type PortfolioPosition = {
  conditionId: string
  outcomeIndex: number
  size: number
  avgPrice: number
  cashPnl: number
  realizedPnl: number
  currentValue: number
  totalBought?: number
  initialValue?: number
  curPrice?: number
  redeemable?: boolean
  endDate?: string
  title?: string
}

export type TraderStats = {
  /** Sum of per-leg PnL: closed realized + dust open legs + **cashPnl** (MTM) on open-only active legs. */
  lifetimeRealizedPnl: number
  /**
   * Closed/dust legs: PnL only when leg timestamp/endDate falls in the last 30d.
   * Open-only active legs: **full current cashPnl** counted (MTM snapshot, not strictly gains inside 30d).
   */
  recentRealizedPnl: number
  /** Distinct book legs after merging closed + qualifying open (deduped by conditionId + outcomeIndex). */
  closedPositionsSampled: number
  uniqueMarketsSampled: number
  wins: number
  losses: number
  breakevens: number
  truncated: boolean
  /** Sum of totalBought × avgPrice over sampled closes when both fields exist. */
  closedCapitalContributed: number
  /** 100 × lifetimeRealizedPnl / closedCapitalContributed when capital ≥ min; else null. */
  closedReturnPct: number | null
}

export type MarketMetrics = {
  openInterest?: number
  volume?: number
}

export type ActivityRecord = {
  timestamp: number
  type: string
  side?: string
  size: number
  outcomeIndex: number
  price?: number
  usdcSize?: number
}

export type PositionSeriesPoint = {
  timestamp: number
  position: number
}

export type WalletPositionValuePoint = {
  timestamp: number
  position: number
  price: number
  usdValue: number
}

function parseJsonArray<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[]
  if (raw && typeof raw === 'object' && 'value' in raw && Array.isArray((raw as { value: unknown }).value)) {
    return (raw as { value: T[] }).value
  }
  return []
}

export function isOpenTradeableMarket(m: GammaMarket): boolean {
  if (m.archived === true) return false
  if (m.active === false) return false
  if (m.closed === true) return false
  const st = m.umaResolutionStatus
  if (st != null && String(st).toLowerCase() === 'resolved') return false
  return true
}

function normQuery(s: string): string {
  return s.trim().replace(/\s+/g, ' ')
}

export async function searchMarkets(
  query: string,
  limitPerType = 24,
  opts?: { signal?: AbortSignal }
): Promise<SearchMarketRow[]> {
  const normalized = normQuery(query).toLowerCase()
  const q = encodeURIComponent(normalized)
  if (!q) return []
  const url = `${GAMMA_BASE}/public-search?q=${q}&limit_per_type=${limitPerType}&search_profiles=false&search_tags=false`
  const res = await fetch(url, { signal: opts?.signal })
  if (!res.ok) throw new Error(`Search failed (${res.status})`)
  const data = (await res.json()) as { events?: { title: string; markets?: GammaMarket[] }[] }
  const rows: SearchMarketRow[] = []
  for (const ev of data.events ?? []) {
    for (const m of ev.markets ?? []) {
      if (!m.conditionId || !m.question) continue
      if (!isOpenTradeableMarket(m)) continue
      rows.push({
        conditionId: m.conditionId,
        question: m.question,
        slug: m.slug,
        eventTitle: ev.title,
        outcomes: m.outcomes,
        volumeNum: m.volume ? Number(m.volume) : undefined,
      })
    }
  }
  return rows
}

export async function getTopHolders(conditionId: string, limit = 10): Promise<MetaHolder[]> {
  const url = `${DATA_BASE}/holders?market=${encodeURIComponent(conditionId)}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Holders failed (${res.status})`)
  return parseJsonArray<MetaHolder>(await res.json())
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

export type MarketLiveQuote = {
  conditionId: string
  yesPrice: number
  noPrice: number
  endDateMs: number | null
  question: string
  slug: string
  eventTitle: string
  eventSlug: string
}

function toStr(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim()) return v
  return undefined
}

function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x))
}

function parseOutcomePricesFromRow(row: Record<string, unknown>): { yes: number; no: number } {
  const raw = row.outcomePrices ?? row.outcome_prices
  if (typeof raw === 'string') {
    try {
      const arr = JSON.parse(raw) as unknown
      if (Array.isArray(arr) && arr.length >= 2) {
        const yes = Number(arr[0])
        const no = Number(arr[1])
        if (Number.isFinite(yes) && Number.isFinite(no)) return { yes: clamp01(yes), no: clamp01(no) }
      }
    } catch {
      /* ignore */
    }
  }
  return { yes: 0.5, no: 0.5 }
}

function parseEndDateMsFromRow(row: Record<string, unknown>): number | null {
  for (const k of ['endDate', 'end_date', 'endDateIso', 'gameStartTime', 'startDate']) {
    const v = row[k]
    if (typeof v === 'string' && v.trim()) {
      const t = Date.parse(v)
      if (Number.isFinite(t)) return t
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      return v < 1e12 ? v * 1000 : v
    }
  }
  return null
}

/** Live YES/NO prices, deadlines, and event handle for payoff planning. */
export async function getMarketLiveQuote(conditionId: string): Promise<MarketLiveQuote | null> {
  const tries = [
    `${GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}`,
    `${GAMMA_BASE}/markets?conditionId=${encodeURIComponent(conditionId)}`,
    `${GAMMA_BASE}/markets?condition_id=${encodeURIComponent(conditionId)}`,
  ]
  for (const url of tries) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const raw = await res.json()
      const rows = parseJsonArray<Record<string, unknown>>(raw)
      const row =
        rows.find((m) => String(m.conditionId ?? m.condition_id ?? '') === conditionId) ?? rows[0]
      if (!row) continue
      const { yes, no } = parseOutcomePricesFromRow(row)
      const q = String(row.question ?? row.title ?? 'Market')
      const slug = String(row.slug ?? '')
      let eventTitle = toStr(row.eventTitle) ?? toStr(row.event_title) ?? ''
      let eventSlug = toStr(row.eventSlug) ?? toStr(row.event_slug) ?? ''
      const evs = row.events
      if (!eventTitle && Array.isArray(evs) && evs[0] && typeof evs[0] === 'object') {
        const ev = evs[0] as Record<string, unknown>
        eventTitle = toStr(ev.title) ?? eventTitle
        eventSlug = toStr(ev.slug) ?? eventSlug
      }
      return {
        conditionId,
        yesPrice: yes,
        noPrice: no,
        endDateMs: parseEndDateMsFromRow(row),
        question: q,
        slug,
        eventTitle: eventTitle || slug || 'Event',
        eventSlug: eventSlug || slug,
      }
    } catch {
      /* next */
    }
  }
  return null
}

export async function getMarketMetrics(conditionId: string): Promise<MarketMetrics> {
  const tries = [
    `${GAMMA_BASE}/markets?condition_ids=${encodeURIComponent(conditionId)}`,
    `${GAMMA_BASE}/markets?conditionId=${encodeURIComponent(conditionId)}`,
    `${GAMMA_BASE}/markets?condition_id=${encodeURIComponent(conditionId)}`,
  ]
  for (const url of tries) {
    try {
      const res = await fetch(url)
      if (!res.ok) continue
      const raw = await res.json()
      const rows = parseJsonArray<Record<string, unknown>>(raw)
      const row =
        rows.find((m) => String(m.conditionId ?? m.condition_id ?? '') === conditionId) ?? rows[0]
      if (!row) continue
      const openInterest =
        toNum(row.openInterest) ??
        toNum(row.open_interest) ??
        toNum(row.liquidity) ??
        toNum(row.liquidityNum)
      const volume = toNum(row.volume) ?? toNum(row.volumeNum) ?? toNum(row.totalVolume)
      return { openInterest, volume }
    } catch {
      /* next */
    }
  }
  return {}
}

export async function getPublicProfile(address: string): Promise<PublicProfile | null> {
  const url = `${GAMMA_BASE}/public-profile?address=${encodeURIComponent(address)}`
  const res = await fetch(url)
  if (res.status === 404) return null
  if (!res.ok) return null
  return (await res.json()) as PublicProfile
}

export async function getFirstMarketTrade(
  address: string,
  conditionId: string
): Promise<ActivityTrade | null> {
  const url =
    `${DATA_BASE}/activity?user=${encodeURIComponent(address)}` +
    `&market=${encodeURIComponent(conditionId)}` +
    `&limit=1&sortBy=TIMESTAMP&sortDirection=ASC&type=TRADE`
  const res = await fetch(url)
  if (!res.ok) return null
  const arr = parseJsonArray<ActivityTrade & { type?: string }>(await res.json())
  return arr[0] ?? null
}

export async function getPositionsForMarketWallet(
  address: string,
  conditionId: string
): Promise<PositionRow[]> {
  const url =
    `${DATA_BASE}/positions?user=${encodeURIComponent(address)}` +
    `&market=${encodeURIComponent(conditionId)}&limit=50`
  const res = await fetch(url)
  if (!res.ok) return []
  return parseJsonArray<PositionRow>(await res.json())
}

const RECENT_MS = 30 * 24 * 60 * 60 * 1000
const PAGE = 50
const MAX_PAGES = 30
const OPEN_LIMIT = 500
const MAX_OPEN_PAGES = 4
/** Shares above this on `/positions` are treated as still active (excluded from merged “book” legs). */
const MIN_ACTIVE_OPEN_SIZE = 0.5
/** Open rows with current value above this are treated as active exposure, not resolved dust. */
const DUST_OPEN_VALUE_USD = 2
/** Minimum estimated deployed capital (USDC) before we show / use return-on-capital %. */
export const CLOSED_CAPITAL_MIN_FOR_RETURN_PCT = 400

/** How this leg’s PnL rolls into the recent window (see `getTraderClosedStats`). */
type RecentPnlMode = 'closed_or_dated' | 'open_mtm_snapshot'

type BookLeg = { pnl: number; tsSec: number; capital: number; recentMode: RecentPnlMode }

function bookLegKey(conditionId: string, outcomeIndex: number): string {
  return `${conditionId}:${outcomeIndex}`
}

function positionCapitalUsd(totalBought: number | undefined, avgPrice: number | undefined): number {
  const tb = totalBought
  const ap = avgPrice
  if (typeof tb !== 'number' || typeof ap !== 'number' || !Number.isFinite(tb) || !Number.isFinite(ap)) return 0
  if (tb <= 0 || ap < 0) return 0
  return tb * ap
}

function closedPositionCapitalUsd(p: ClosedPosition): number {
  return positionCapitalUsd(p.totalBought, p.avgPrice)
}

function openPositionCapitalUsd(p: PortfolioPosition): number {
  const fromBuy = positionCapitalUsd(p.totalBought, p.avgPrice)
  if (fromBuy > 0) return fromBuy
  const iv = p.initialValue
  if (typeof iv === 'number' && Number.isFinite(iv) && iv > 0) return iv
  return 0
}

function parsePortfolioPosition(r: Record<string, unknown>): PortfolioPosition | null {
  const conditionId = typeof r.conditionId === 'string' ? r.conditionId : ''
  if (!conditionId) return null
  return {
    conditionId,
    outcomeIndex: toNum(r.outcomeIndex) ?? 0,
    size: toNum(r.size) ?? 0,
    avgPrice: toNum(r.avgPrice) ?? 0,
    cashPnl: toNum(r.cashPnl) ?? 0,
    realizedPnl: toNum(r.realizedPnl) ?? 0,
    currentValue: toNum(r.currentValue) ?? 0,
    totalBought: toNum(r.totalBought),
    initialValue: toNum(r.initialValue),
    curPrice: toNum(r.curPrice),
    redeemable: r.redeemable === true,
    endDate: typeof r.endDate === 'string' ? r.endDate : undefined,
    title: typeof r.title === 'string' ? r.title : undefined,
  }
}

function isMergeableDustOpen(p: PortfolioPosition): boolean {
  const absSize = Math.abs(p.size)
  if (absSize >= MIN_ACTIVE_OPEN_SIZE) return false
  if (p.currentValue > DUST_OPEN_VALUE_USD) return false
  return true
}

/** Prefer realized PnL when API sets it; else cash PnL (common for dust / stuck legs). */
function openDustLegPnl(p: PortfolioPosition): number {
  const r = p.realizedPnl ?? 0
  if (Number.isFinite(r) && Math.abs(r) >= 1e-6) return r
  return p.cashPnl ?? 0
}

function openLegTimestampSec(p: PortfolioPosition): number {
  if (p.endDate) {
    const t = Date.parse(p.endDate)
    if (Number.isFinite(t)) return Math.floor(t / 1000)
  }
  return 0
}

function addBookLeg(map: Map<string, BookLeg>, key: string, leg: BookLeg): void {
  const ex = map.get(key)
  if (ex) {
    ex.pnl += leg.pnl
    ex.capital += leg.capital
    ex.tsSec = Math.max(ex.tsSec, leg.tsSec)
    if (leg.recentMode === 'open_mtm_snapshot') ex.recentMode = 'open_mtm_snapshot'
  } else {
    map.set(key, { ...leg })
  }
}

async function fetchClosedPositionPages(
  address: string
): Promise<{ rows: ClosedPosition[]; truncated: boolean }> {
  const rows: ClosedPosition[] = []
  let truncated = false
  let offset = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const url =
      `${DATA_BASE}/closed-positions?user=${encodeURIComponent(address)}` +
      `&limit=${PAGE}&offset=${offset}&sortBy=TIMESTAMP&sortDirection=DESC`
    const res = await fetch(url)
    if (!res.ok) break
    const batch = parseJsonArray<ClosedPosition>(await res.json())
    if (batch.length === 0) break
    rows.push(...batch)
    offset += PAGE
    if (batch.length < PAGE) break
    if (batch.length === PAGE && page === MAX_PAGES - 1) truncated = true
  }
  return { rows, truncated }
}

async function fetchOpenPositionsForMerge(
  address: string
): Promise<{ rows: PortfolioPosition[]; truncated: boolean }> {
  const rows: PortfolioPosition[] = []
  let truncated = false
  for (let page = 0; page < MAX_OPEN_PAGES; page++) {
    const offset = page * OPEN_LIMIT
    const url =
      `${DATA_BASE}/positions?user=${encodeURIComponent(address)}` +
      `&limit=${OPEN_LIMIT}&offset=${offset}&sizeThreshold=0&sortBy=TOKENS&sortDirection=DESC`
    const res = await fetch(url)
    if (!res.ok) break
    const raw = parseJsonArray<Record<string, unknown>>(await res.json())
    if (raw.length === 0) break
    for (const r of raw) {
      const p = parsePortfolioPosition(r)
      if (p) rows.push(p)
    }
    if (raw.length < OPEN_LIMIT) break
    if (raw.length === OPEN_LIMIT && page === MAX_OPEN_PAGES - 1) truncated = true
  }
  return { rows, truncated }
}

/**
 * Trader “book” stats: paginated `/closed-positions` plus `/positions` (sizeThreshold=0), deduped by conditionId +
 * outcomeIndex. Closed legs use realized PnL. Open-only legs: “dust” (tiny size/value, often resolved-but-stuck) use
 * realized/cash PnL with optional endDate for the recent window; **active** open-only legs use **cashPnl** (MTM) for
 * lifetime + win/loss, and the **full current cashPnl** is also counted toward the recent column (snapshot, not
 * strictly PnL realized inside 30d). Caps: closed up to MAX_PAGES×PAGE; open up to MAX_OPEN_PAGES×OPEN_LIMIT.
 */
export async function getTraderClosedStats(
  address: string,
  recentWindowMs: number = RECENT_MS
): Promise<TraderStats> {
  const [closedPack, openPack] = await Promise.all([
    fetchClosedPositionPages(address),
    fetchOpenPositionsForMerge(address),
  ])

  const byKey = new Map<string, BookLeg>()
  for (const p of closedPack.rows) {
    const cid = String(p.conditionId ?? '')
    if (!cid) continue
    const oi = toNum(p.outcomeIndex) ?? 0
    const tsSec =
      typeof p.timestamp === 'number' && Number.isFinite(p.timestamp)
        ? Math.floor(p.timestamp)
        : Math.floor(Number(p.timestamp) || 0)
    addBookLeg(byKey, bookLegKey(cid, oi), {
      pnl: p.realizedPnl ?? 0,
      tsSec,
      capital: closedPositionCapitalUsd(p),
      recentMode: 'closed_or_dated',
    })
  }

  for (const p of openPack.rows) {
    const k = bookLegKey(p.conditionId, p.outcomeIndex)
    if (byKey.has(k)) continue
    if (isMergeableDustOpen(p)) {
      const pnl = openDustLegPnl(p)
      if (Math.abs(pnl) < 1e-8 && Math.abs(p.currentValue) < 0.01 && Math.abs(p.size) < 0.01) continue
      addBookLeg(byKey, k, {
        pnl,
        tsSec: openLegTimestampSec(p),
        capital: openPositionCapitalUsd(p),
        recentMode: 'closed_or_dated',
      })
    } else {
      const pnl = p.cashPnl ?? 0
      if (!Number.isFinite(pnl)) continue
      if (
        Math.abs(pnl) < 1e-8 &&
        Math.abs(p.currentValue) < 0.01 &&
        Math.abs(p.size) < 1e-6
      ) {
        continue
      }
      addBookLeg(byKey, k, {
        pnl,
        tsSec: openLegTimestampSec(p),
        capital: openPositionCapitalUsd(p),
        recentMode: 'open_mtm_snapshot',
      })
    }
  }

  let lifetimeRealizedPnl = 0
  let recentRealizedPnl = 0
  let closedCapitalContributed = 0
  let wins = 0
  let losses = 0
  let breakevens = 0
  const markets = new Set<string>()
  const cutoff = Date.now() - recentWindowMs

  for (const [key, leg] of byKey) {
    const colon = key.lastIndexOf(':')
    const cid = colon >= 0 ? key.slice(0, colon) : key
    if (cid) markets.add(cid)
    lifetimeRealizedPnl += leg.pnl
    closedCapitalContributed += leg.capital
    if (leg.recentMode === 'open_mtm_snapshot') {
      recentRealizedPnl += leg.pnl
    } else {
      const tsMs = leg.tsSec * 1000
      if (leg.tsSec > 0 && tsMs >= cutoff) recentRealizedPnl += leg.pnl
    }
    if (leg.pnl > 0) wins++
    else if (leg.pnl < 0) losses++
    else breakevens++
  }

  const truncated = closedPack.truncated || openPack.truncated
  const closedReturnPct =
    closedCapitalContributed >= CLOSED_CAPITAL_MIN_FOR_RETURN_PCT
      ? (lifetimeRealizedPnl / closedCapitalContributed) * 100
      : null

  return {
    lifetimeRealizedPnl,
    recentRealizedPnl,
    closedPositionsSampled: byKey.size,
    uniqueMarketsSampled: markets.size,
    wins,
    losses,
    breakevens,
    truncated,
    closedCapitalContributed,
    closedReturnPct,
  }
}

/** Matches polymarket.com profile-style PnL for one `proxyWallet` via Data API leaderboard. */
export type PolymarketOfficialPnl = {
  /** `timePeriod=ALL` */
  pnlAll: number | null
  /** `timePeriod=MONTH` (calendar month, not rolling 30 days). */
  pnlMonth: number | null
}

type LeaderboardRow = { pnl?: number }

function parseLeaderboardPnl(json: unknown): number | null {
  const arr = parseJsonArray<LeaderboardRow>(json)
  const p = arr[0]?.pnl
  if (typeof p === 'number' && Number.isFinite(p)) return p
  return null
}

/** Polymarket’s own PnL for this address (`/v1/leaderboard`). Parallel to our merged “book” stats. Never throws. */
export async function getPolymarketOfficialPnl(address: string): Promise<PolymarketOfficialPnl> {
  try {
    const q = (period: 'ALL' | 'MONTH') =>
      `${DATA_BASE}/v1/leaderboard?user=${encodeURIComponent(address)}&timePeriod=${period}&orderBy=PNL&limit=1`
    const [resAll, resMo] = await Promise.all([fetch(q('ALL')), fetch(q('MONTH'))])
    let pnlAll: number | null = null
    let pnlMonth: number | null = null
    if (resAll.ok) {
      try {
        pnlAll = parseLeaderboardPnl(await resAll.json())
      } catch {
        /* ignore */
      }
    }
    if (resMo.ok) {
      try {
        pnlMonth = parseLeaderboardPnl(await resMo.json())
      } catch {
        /* ignore */
      }
    }
    return { pnlAll, pnlMonth }
  } catch {
    return { pnlAll: null, pnlMonth: null }
  }
}

export function parseOutcomes(outcomesJson: string): string[] {
  try {
    const v = JSON.parse(outcomesJson) as unknown
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

export function formatAddress(a: string): string {
  if (a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

export function formatUsd(n: number): string {
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(2)}k`
  return `${sign}$${abs.toFixed(2)}`
}

export function formatTs(sec: number): string {
  if (!sec) return '—'
  return new Date(sec * 1000).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  })
}

const ACTIVITY_LIMIT = 500
const MAX_ACTIVITY_OFFSET = 10000

function normalizePrice(p: number | undefined, size: number | undefined, usdcSize: number | undefined): number {
  if (typeof p === 'number' && Number.isFinite(p) && p >= 0) return Math.min(1, Math.max(0, p))
  if (typeof size === 'number' && size > 0 && typeof usdcSize === 'number' && Number.isFinite(usdcSize)) {
    const derived = usdcSize / size
    if (Number.isFinite(derived) && derived >= 0) return Math.min(1, Math.max(0, derived))
  }
  return 0
}

export async function getMarketPositionSeries(
  address: string,
  conditionId: string,
  outcomeIndex: number
): Promise<PositionSeriesPoint[]> {
  const all: ActivityRecord[] = []
  for (let offset = 0; offset <= MAX_ACTIVITY_OFFSET; offset += ACTIVITY_LIMIT) {
    const url =
      `${DATA_BASE}/activity?user=${encodeURIComponent(address)}` +
      `&market=${encodeURIComponent(conditionId)}` +
      `&limit=${ACTIVITY_LIMIT}&offset=${offset}` +
      `&sortBy=TIMESTAMP&sortDirection=ASC&type=TRADE`
    const res = await fetch(url)
    if (!res.ok) break
    const rows = parseJsonArray<ActivityRecord & { type?: string }>(await res.json())
    if (rows.length === 0) break
    for (const r of rows) {
      if (r.type && r.type !== 'TRADE') continue
      all.push({
        timestamp: r.timestamp,
        type: 'TRADE',
        side: r.side,
        size: r.size ?? 0,
        outcomeIndex: r.outcomeIndex,
        price: r.price,
        usdcSize: r.usdcSize,
      })
    }
    if (rows.length < ACTIVITY_LIMIT) break
  }

  const forOutcome = all
    .filter((r) => r.outcomeIndex === outcomeIndex)
    .sort((a, b) => a.timestamp - b.timestamp || 0)

  let cum = 0
  const points: PositionSeriesPoint[] = []
  for (const t of forOutcome) {
    const side = (t.side ?? '').toUpperCase()
    const delta = side === 'BUY' ? t.size : side === 'SELL' ? -t.size : 0
    cum += delta
    points.push({ timestamp: t.timestamp, position: cum })
  }
  return points
}

export async function getWalletPositionValueSeries(
  address: string,
  conditionId: string,
  outcomeIndex: number
): Promise<WalletPositionValuePoint[]> {
  const trades: ActivityRecord[] = []
  for (let offset = 0; offset <= MAX_ACTIVITY_OFFSET; offset += ACTIVITY_LIMIT) {
    const url =
      `${DATA_BASE}/activity?user=${encodeURIComponent(address)}` +
      `&market=${encodeURIComponent(conditionId)}` +
      `&limit=${ACTIVITY_LIMIT}&offset=${offset}` +
      `&sortBy=TIMESTAMP&sortDirection=ASC&type=TRADE`
    const res = await fetch(url)
    if (!res.ok) break
    const rows = parseJsonArray<ActivityRecord & { type?: string }>(await res.json())
    if (rows.length === 0) break
    for (const r of rows) {
      if (r.type && r.type !== 'TRADE') continue
      if (r.outcomeIndex !== outcomeIndex) continue
      trades.push({
        timestamp: r.timestamp,
        type: 'TRADE',
        side: r.side,
        size: r.size ?? 0,
        outcomeIndex: r.outcomeIndex,
        price: r.price,
        usdcSize: r.usdcSize,
      })
    }
    if (rows.length < ACTIVITY_LIMIT) break
  }

  trades.sort((a, b) => a.timestamp - b.timestamp || 0)
  let position = 0
  const points: WalletPositionValuePoint[] = []
  for (const t of trades) {
    const side = (t.side ?? '').toUpperCase()
    const delta = side === 'BUY' ? t.size : side === 'SELL' ? -t.size : 0
    position += delta
    const price = normalizePrice(t.price, t.size, t.usdcSize)
    points.push({
      timestamp: t.timestamp,
      position,
      price,
      usdValue: position * price,
    })
  }
  return points
}
