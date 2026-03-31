import type { MarketLiveQuote } from './polymarketApi'
import type { PayoffMarketEntry } from './payoffPlannerModel'

export type ScenarioBreakdown = { entryId: string; question: string; side: string; pnl: number }

export type ScenarioResult = {
  id: string
  label: string
  /** YES=payout on YES contract / event happened by that deadline, in deadline order (earliest → latest) */
  outcomePath: string
  outcomeYesByEntryId: Record<string, boolean>
  pnl: number
  breakdown: ScenarioBreakdown[]
  /** Win/lose on each staked leg (deadline order), W = you win on that contract */
  userBookPath: string
  /** Human-readable: "Mar 31 YES wins · Jun 30 NO loses" */
  userBookDetail: string
  /** When >1 event timeline maps to the same portfolio payoff */
  mergedTimelineCount?: number
  mergedTimelineLabels?: string[]
}

function clampPrice(p: number): number {
  return Math.min(0.99, Math.max(0.01, p))
}

function yesProb(m: PayoffMarketEntry, q: MarketLiveQuote | undefined): number {
  const ov = m.manualYesProb
  if (ov != null && Number.isFinite(ov) && ov > 0 && ov < 1) return clampPrice(ov)
  return q ? clampPrice(q.yesPrice) : 0.5
}

/** Price used for shares = principal / price (your book, not mark-to-market). */
export function effectiveEntryPrice(
  entry: PayoffMarketEntry,
  quote: MarketLiveQuote | undefined
): number | null {
  if (!entry.side) return null
  if (
    entry.avgEntryPrice != null &&
    Number.isFinite(entry.avgEntryPrice) &&
    entry.avgEntryPrice > 0 &&
    entry.avgEntryPrice < 1
  ) {
    return clampPrice(entry.avgEntryPrice)
  }
  const q = quote
  if (!q) return null
  const raw = entry.side === 'YES' ? q.yesPrice : q.noPrice
  return clampPrice(raw)
}

/**
 * PnL for one leg: bought chosen side at effective entry, $1/share if ITM.
 * YES wins iff event happened by that contract’s deadline; NO wins iff not.
 */
export function legPnL(
  entry: PayoffMarketEntry,
  quote: MarketLiveQuote | undefined,
  outcomeYes: boolean
): number {
  if (!entry.side || entry.principal <= 0) return 0
  const price = effectiveEntryPrice(entry, quote)
  if (price == null) return 0
  const shares = entry.principal / price
  const wins = entry.side === 'YES' ? outcomeYes : !outcomeYes
  return wins ? shares - entry.principal : -entry.principal
}

export function winTotalIfWin(entry: PayoffMarketEntry, quote: MarketLiveQuote | undefined): number | null {
  const p = effectiveEntryPrice(entry, quote)
  if (p == null || !entry.side || entry.principal <= 0) return null
  return entry.principal / p
}

/**
 * Top → bottom in your list = tenor ladder for payouts.
 * We intentionally do **not** sort by API `endDateMs` (it often disagrees with the question text and scrambles order).
 */
export function ladderOrderIndices(markets: PayoffMarketEntry[]): number[] {
  return markets.map((_, i) => i)
}

/** Optional: sort by API deadline (legacy / diagnostics only). */
export function sortedMarketIndices(markets: PayoffMarketEntry[]): number[] {
  return markets
    .map((m, i) => ({ i, t: m.endDateMs }))
    .sort((a, b) => {
      const ta = a.t ?? Number.POSITIVE_INFINITY
      const tb = b.t ?? Number.POSITIVE_INFINITY
      if (ta !== tb) return ta - tb
      return a.i - b.i
    })
    .map((x) => x.i)
}

function fmtDeadline(m: PayoffMarketEntry): string {
  if (m.endDateMs != null && Number.isFinite(m.endDateMs)) {
    return new Date(m.endDateMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
  }
  return m.question.length > 40 ? `${m.question.slice(0, 38)}…` : m.question
}

/** Label for one rung: date (if any) + shortened question so rows don’t collide. */
function ladderRowLabel(m: PayoffMarketEntry): string {
  const d =
    m.endDateMs != null && Number.isFinite(m.endDateMs)
      ? new Date(m.endDateMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
      : null
  const q = m.question.length > 42 ? `${m.question.slice(0, 40)}…` : m.question
  return d ? `${d} — ${q}` : q
}

/**
 * Sequential “event by deadline” markets on one underlying:
 * n contracts → n+1 worlds. For cutoff s, first s deadlines resolve NO (event not yet),
 * remaining resolve YES (event has happened by those later dates).
 * So YES on an early date paying forces all later “by date” YES to pay; a late NO loses if the event already happened.
 */
export function buildLadderScenarios(
  markets: PayoffMarketEntry[],
  quotes: Map<string, MarketLiveQuote>
): ScenarioResult[] {
  if (markets.length === 0) return []
  const order = ladderOrderIndices(markets)
  const ordered = order.map((i) => markets[i])
  const n = order.length
  const results: ScenarioResult[] = []

  for (let s = 0; s <= n; s++) {
    const outcomeYesByEntryId: Record<string, boolean> = {}
    for (let k = 0; k < n; k++) {
      const phys = order[k]
      const m = markets[phys]
      outcomeYesByEntryId[m.id] = k >= s
    }
    const outcomePath = order
      .map((phys) => (outcomeYesByEntryId[markets[phys].id] ? 'Y' : 'N'))
      .join(' · ')

    const breakdown: ScenarioBreakdown[] = []
    let pnl = 0
    for (const m of markets) {
      const q = quotes.get(m.conditionId)
      const oy = outcomeYesByEntryId[m.id] ?? false
      const leg = legPnL(m, q, oy)
      pnl += leg
      if (m.side && m.principal > 0) {
        breakdown.push({
          entryId: m.id,
          question: m.question,
          side: `${m.side} ${oy ? 'ITM' : 'OTM'}`,
          pnl: leg,
        })
      }
    }

    let label: string
    if (s === 0) {
      label = `By ${fmtDeadline(ordered[0])} — event in time for all deadlines (all YES)`
    } else if (s === n) {
      label = `Never by ${fmtDeadline(ordered[n - 1])} — all contracts resolve NO`
    } else {
      label = `After ${fmtDeadline(ordered[s - 1])}, by ${fmtDeadline(ordered[s])} — first ${s} NO, later YES`
    }

    const { userBookPath, userBookDetail } = userBookPathAndDetail(markets, order, outcomeYesByEntryId)

    results.push({
      id: `ladder-${s}`,
      label,
      outcomePath,
      outcomeYesByEntryId,
      pnl,
      breakdown,
      userBookPath,
      userBookDetail,
    })
  }
  return results
}

function userBookPathAndDetail(
  markets: PayoffMarketEntry[],
  order: number[],
  outcomeYesByEntryId: Record<string, boolean>
): { userBookPath: string; userBookDetail: string } {
  const pathParts: string[] = []
  const detailParts: string[] = []
  order.forEach((phys, rank) => {
    const m = markets[phys]
    if (!m.side || m.principal <= 0) return
    const oy = outcomeYesByEntryId[m.id] ?? false
    const win = m.side === 'YES' ? oy : !oy
    pathParts.push(win ? 'W' : 'L')
    detailParts.push(`(${rank + 1}) ${ladderRowLabel(m)} · ${m.side} ${win ? 'wins' : 'loses'}`)
  })
  return {
    userBookPath: pathParts.length ? pathParts.join('·') : '—',
    userBookDetail: detailParts.length ? detailParts.join(' · ') : 'No staked legs',
  }
}

/** Same portfolio result for your YES/NO legs (deadline order). */
function userPortfolioSignature(
  markets: PayoffMarketEntry[],
  order: number[],
  outcomeYesByEntryId: Record<string, boolean>
): string {
  const chunks: string[] = []
  for (const phys of order) {
    const m = markets[phys]
    if (!m.side || m.principal <= 0) continue
    const oy = outcomeYesByEntryId[m.id] ?? false
    const win = m.side === 'YES' ? oy : !oy
    chunks.push(`${m.id}:${win ? 'W' : 'L'}`)
  }
  return chunks.join('|') || 'no-stake'
}

function mergePortfolioGroup(group: ScenarioResult[]): ScenarioResult {
  const first = group[0]
  if (group.length === 1) return first
  return {
    ...first,
    id: `book-${first.id}-m${group.length}`,
    mergedTimelineCount: group.length,
    mergedTimelineLabels: group.map((g) => g.label),
    label: `${first.userBookDetail} (${group.length} event paths → same book result)`,
  }
}

/**
 * Enumerate valid nested event timelines, then **merge** timelines that produce the
 * same win/lose pattern on **your** YES/NO legs (same total PnL). So scenario count
 * follows your book, not “always n+1 cards”.
 */
export function consolidateScenariosForUserBook(
  raw: ScenarioResult[],
  markets: PayoffMarketEntry[],
  order: number[]
): { scenarios: ScenarioResult[]; underlyingTimelineCount: number } {
  const underlyingTimelineCount = raw.length
  if (raw.length === 0) return { scenarios: [], underlyingTimelineCount: 0 }

  const groups = new Map<string, ScenarioResult[]>()
  for (const sc of raw) {
    const sig = userPortfolioSignature(markets, order, sc.outcomeYesByEntryId)
    const arr = groups.get(sig) ?? []
    arr.push(sc)
    groups.set(sig, arr)
  }

  const scenarios = [...groups.values()].map((g) => mergePortfolioGroup(g))
  scenarios.sort((a, b) => a.pnl - b.pnl)

  return { scenarios, underlyingTimelineCount }
}

export function buildUserBookScenarios(
  markets: PayoffMarketEntry[],
  quotes: Map<string, MarketLiveQuote>
): {
  scenarios: ScenarioResult[]
  underlyingTimelineCount: number
  rawTimelines: ScenarioResult[]
} {
  const raw = buildLadderScenarios(markets, quotes)
  const order = ladderOrderIndices(markets)
  const { scenarios, underlyingTimelineCount } = consolidateScenariosForUserBook(raw, markets, order)
  return { scenarios, underlyingTimelineCount, rawTimelines: raw }
}

export function scenarioSummaryPnL(scenarios: ScenarioResult[]): {
  min: number
  max: number
  mean: number
} {
  if (scenarios.length === 0) return { min: 0, max: 0, mean: 0 }
  const pnls = scenarios.map((s) => s.pnl)
  const min = Math.min(...pnls)
  const max = Math.max(...pnls)
  const mean = pnls.reduce((a, b) => a + b, 0) / pnls.length
  return { min, max, mean }
}

export function totalPrincipalAtRisk(markets: PayoffMarketEntry[]): number {
  return markets.reduce((acc, m) => acc + (m.side && m.principal > 0 ? m.principal : 0), 0)
}

/** Rough marginal EV using live prices as win probs (ignores ladder dependence). */
export function naiveMarginalEV(
  markets: PayoffMarketEntry[],
  quotes: Map<string, MarketLiveQuote>
): number | null {
  let ev = 0
  let any = false
  for (const m of markets) {
    if (!m.side || m.principal <= 0) continue
    const q = quotes.get(m.conditionId)
    if (!q) continue
    any = true
    if (m.side === 'YES') {
      const price = yesProb(m, q)
      const entry = effectiveEntryPrice(m, q) ?? price
      const shares = m.principal / entry
      ev += price * (shares - m.principal) + (1 - price) * -m.principal
    } else {
      const price = clampPrice(1 - yesProb(m, q))
      const entry = effectiveEntryPrice(m, q) ?? price
      const shares = m.principal / entry
      ev += price * (shares - m.principal) + (1 - price) * -m.principal
    }
  }
  return any ? ev : null
}

/**
 * Implied unconditional P(YES) from live order; conditional P_k ≈ P(by T_k | not by T_{k-1}) (display sketch).
 */
export function ladderConditionalProbs(
  markets: PayoffMarketEntry[],
  quotes: Map<string, MarketLiveQuote>
): { label: string; uncondYes: number; condYes: number }[] {
  const order = ladderOrderIndices(markets)
  const rows: { label: string; uncondYes: number; condYes: number }[] = []
  let prevPBy = 0
  for (let k = 0; k < order.length; k++) {
    const m = markets[order[k]]
    const q = quotes.get(m.conditionId)
    const pByTk = yesProb(m, q)
    const denom = Math.max(1e-6, 1 - prevPBy)
    const condYes =
      k === 0 ? pByTk : Math.max(0, Math.min(1, (pByTk - prevPBy) / denom))
    rows.push({
      label: `(${k + 1}) ${ladderRowLabel(m)}`,
      uncondYes: pByTk,
      condYes,
    })
    prevPBy = pByTk
  }
  return rows
}

/**
 * Implied ladder timeline probabilities from chained “by date” YES prices.
 *
 * Let p_k = P(event happens by deadline k) ≈ YES_price(k), in your list order (earliest → latest).
 * Then the event timeline has n+1 mutually exclusive buckets:
 * - s=0: by first deadline:            P0 = p0
 * - 0<s<n: between s-1 and s:          Ps = max(0, p_s - p_{s-1})
 * - s=n: after last deadline (never):  Pn = max(0, 1 - p_{n-1})
 *
 * We also enforce monotonicity for p_k by taking p_k := max(p_k, p_{k-1}) so buckets are non-negative.
 * This is a “pricing sketch”, not a calibrated model.
 */
export function ladderTimelineProbs(
  markets: PayoffMarketEntry[],
  quotes: Map<string, MarketLiveQuote>
): { bucketProbs: number[]; pBy: number[] } {
  const order = ladderOrderIndices(markets)
  const n = order.length
  if (n === 0) return { bucketProbs: [], pBy: [] }

  const pBy: number[] = []
  let prev = 0
  for (let k = 0; k < n; k++) {
    const m = markets[order[k]]
    const q = quotes.get(m.conditionId)
    const raw = yesProb(m, q)
    const pk = Math.max(prev, raw)
    pBy.push(pk)
    prev = pk
  }

  const bucketProbs: number[] = []
  for (let s = 0; s <= n; s++) {
    if (s === 0) bucketProbs.push(pBy[0] ?? 0)
    else if (s === n) bucketProbs.push(Math.max(0, 1 - (pBy[n - 1] ?? 0)))
    else bucketProbs.push(Math.max(0, (pBy[s] ?? 0) - (pBy[s - 1] ?? 0)))
  }
  return { bucketProbs, pBy }
}
