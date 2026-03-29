import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  CLOSED_CAPITAL_MIN_FOR_RETURN_PCT,
  type HolderRow,
  type MarketMetrics,
  type MetaHolder,
  type PositionRow,
  type PositionSeriesPoint,
  type PublicProfile,
  type SearchMarketRow,
  type TraderStats,
  type WalletPositionValuePoint,
  formatAddress,
  formatUsd,
  formatTs,
  getFirstMarketTrade,
  getMarketMetrics,
  getMarketPositionSeries,
  getPositionsForMarketWallet,
  getPublicProfile,
  getTopHolders,
  getTraderClosedStats,
  getWalletPositionValueSeries,
  parseOutcomes,
  searchMarkets,
} from './polymarketApi'

const TOP_HOLDERS = 10

type EnrichedRow = {
  holder: HolderRow
  outcomeIndex: number
  profile: PublicProfile | null
  firstTradeAt: number | null
  position: PositionRow | null
  stats: TraderStats | null
  pctOfMarketOi?: number | null
  pctOfMarketVolume?: number | null
  whaleFlag?: { flagged: boolean; reasons: string[] }
  error?: string
}

type ChartSubject = {
  wallet: string
  outcomeIndex: number
  displayName: string
  outcomeLabel: string
}

async function poolMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) break
      results[i] = await fn(items[i], i)
    }
  }
  const n = Math.min(concurrency, items.length)
  await Promise.all(Array.from({ length: n }, () => worker()))
  return results
}

function winRatePct(stats: TraderStats | null): string | null {
  if (!stats) return null
  const denom = stats.wins + stats.losses
  if (denom === 0) return null
  return `${((100 * stats.wins) / denom).toFixed(1)}%`
}

function formatSignedReturnPct(pct: number): string {
  const sign = pct > 0 ? '+' : ''
  return `${sign}${pct.toFixed(1)}%`
}

function positionUsd(r: { holder: HolderRow; position: PositionRow | null }): number {
  if (r.position?.currentValue != null && Number.isFinite(r.position.currentValue)) return r.position.currentValue
  if (
    r.position?.size != null &&
    r.position.avgPrice != null &&
    Number.isFinite(r.position.size) &&
    Number.isFinite(r.position.avgPrice)
  ) {
    return r.position.size * r.position.avgPrice
  }
  const estPrice = r.position?.avgPrice ?? 0.5
  return Math.max(0, r.holder.amount * estPrice)
}

function whaleFlagForRow(r: EnrichedRow): { flagged: boolean; reasons: string[] } {
  const reasons: string[] = []
  const s = r.stats
  const winDenom = s ? s.wins + s.losses : 0
  const winRate = s && winDenom > 0 ? s.wins / winDenom : null
  const lifetime = s?.lifetimeRealizedPnl ?? null
  const recent = s?.recentRealizedPnl ?? null
  const markets = s?.uniqueMarketsSampled ?? null
  const ret = s?.closedReturnPct
  const cap = s?.closedCapitalContributed ?? 0
  const n = s?.closedPositionsSampled ?? 0

  // Suspicious signals use closed-book return (realized PnL vs est. capital), not current market size / OI share.
  const strongReturnCombo =
    ret != null &&
    cap >= 500 &&
    n >= 12 &&
    winRate != null &&
    winDenom >= 12 &&
    winRate >= 0.74 &&
    ret >= 40
  if (strongReturnCombo) {
    reasons.push(
      `Strong efficiency: ${formatSignedReturnPct(ret!)} on capital with ${(winRate! * 100).toFixed(1)}% win rate (${winDenom} resolved, sampled).`
    )
  } else if (ret != null && cap >= 600 && n >= 10) {
    if (ret >= 130) {
      reasons.push(
        `Extreme lifetime return (${formatSignedReturnPct(ret)}) vs ~${formatUsd(cap)} est. capital in ${n} sampled closes.`
      )
    } else if (ret >= 75) {
      reasons.push(
        `High return (${formatSignedReturnPct(ret)}) vs ~${formatUsd(cap)} est. capital (${n} sampled closes).`
      )
    }
  }
  if (winRate != null && winDenom >= 10 && winRate >= 0.75) {
    reasons.push(`High win rate (${(winRate * 100).toFixed(1)}%) on ${winDenom} resolved positions (sampled).`)
  }
  if (lifetime != null && lifetime >= 25_000) reasons.push(`Large lifetime realized PnL (${formatUsd(lifetime)}).`)
  if (recent != null && recent >= 5_000) reasons.push(`Large 30d realized PnL (${formatUsd(recent)}).`)
  if (markets != null && markets > 0 && markets <= 6) {
    reasons.push(`Concentrated history: only ${markets} unique markets in sampled closed positions.`)
  }

  const uniq = [...new Set(reasons)]
  return { flagged: uniq.length >= 2, reasons: uniq }
}

function flattenHolders(meta: MetaHolder[]): { holder: HolderRow; outcomeIndex: number }[] {
  const rows: { holder: HolderRow; outcomeIndex: number }[] = []
  for (const block of meta) {
    for (const h of block.holders ?? []) {
      rows.push({ holder: h, outcomeIndex: h.outcomeIndex })
    }
  }
  return rows
}

export default function MainDashboard() {
  const [q, setQ] = useState('')
  const [searching, setSearching] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [results, setResults] = useState<SearchMarketRow[]>([])
  const [selected, setSelected] = useState<SearchMarketRow | null>(null)

  const [suggestions, setSuggestions] = useState<SearchMarketRow[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const [suggestError, setSuggestError] = useState<string | null>(null)
  const [activeSuggestIdx, setActiveSuggestIdx] = useState(-1)
  const inputWrapRef = useRef<HTMLDivElement>(null)
  const suggestionAbortRef = useRef<AbortController | null>(null)

  const [loadingHolders, setLoadingHolders] = useState(false)
  const [holdersError, setHoldersError] = useState<string | null>(null)
  const [marketMetrics, setMarketMetrics] = useState<MarketMetrics>({})
  const [metaHolders, setMetaHolders] = useState<MetaHolder[]>([])
  const [enriched, setEnriched] = useState<EnrichedRow[]>([])

  const [chartSubject, setChartSubject] = useState<ChartSubject | null>(null)
  const [series, setSeries] = useState<PositionSeriesPoint[]>([])
  const [walletValueSeries, setWalletValueSeries] = useState<WalletPositionValuePoint[]>([])
  const [chartVis, setChartVis] = useState({ odds: true, shares: true, usd: true })
  const [seriesLoading, setSeriesLoading] = useState(false)
  const [seriesError, setSeriesError] = useState<string | null>(null)

  const outcomeLabels = useMemo(() => {
    if (!selected) return ['Yes', 'No']
    const o = parseOutcomes(selected.outcomes)
    return o.length > 0 ? o : ['Yes', 'No']
  }, [selected])

  const holderGroups = useMemo(() => {
    const m = new Map<number, EnrichedRow[]>()
    for (const r of enriched) {
      const list = m.get(r.outcomeIndex) ?? []
      list.push(r)
      m.set(r.outcomeIndex, list)
    }
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [enriched])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setChartSubject(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const normalizedQ = useMemo(() => q.trim().replace(/\s+/g, ' '), [q])

  const localFilter = useCallback((query: string, rows: SearchMarketRow[]) => {
    const norm = query.trim().toLowerCase()
    if (!norm) return rows
    const tokens = norm.split(/\s+/g).filter(Boolean)
    const score = (r: SearchMarketRow) => {
      const hay = `${r.question} ${r.eventTitle} ${r.slug}`.toLowerCase()
      let s = 0
      for (const t of tokens) if (hay.includes(t)) s++
      if (hay.startsWith(norm)) s += 2
      if (r.volumeNum != null) s += Math.min(2, Math.log10(Math.max(1, r.volumeNum)) / 3)
      return s
    }
    return rows
      .filter((r) => tokens.every((t) => `${r.question} ${r.eventTitle} ${r.slug}`.toLowerCase().includes(t)))
      .slice()
      .sort((a, b) => score(b) - score(a))
  }, [])

  useEffect(() => {
    const query = normalizedQ
    const trimmed = query.trim()
    setSuggestError(null)
    setActiveSuggestIdx(-1)

    if (trimmed.length < 2) {
      suggestionAbortRef.current?.abort()
      setSuggestions([])
      setSuggestOpen(false)
      setSuggestLoading(false)
      return
    }

    setSuggestOpen(true)
    setSuggestLoading(true)
    const ac = new AbortController()
    suggestionAbortRef.current?.abort()
    suggestionAbortRef.current = ac

    const t = window.setTimeout(() => {
      searchMarkets(trimmed, 12, { signal: ac.signal })
        .then((rows) => {
          if (ac.signal.aborted) return
          setSuggestions(localFilter(trimmed, rows).slice(0, 10))
        })
        .catch((e: unknown) => {
          if (ac.signal.aborted) return
          setSuggestError(e instanceof Error ? e.message : 'Search failed')
          setSuggestions([])
        })
        .finally(() => {
          if (ac.signal.aborted) return
          setSuggestLoading(false)
        })
    }, 200)

    return () => {
      window.clearTimeout(t)
      ac.abort()
    }
  }, [localFilter, normalizedQ])

  useEffect(() => {
    if (!chartSubject || !selected) {
      setSeries([])
      setWalletValueSeries([])
      setSeriesError(null)
      setSeriesLoading(false)
      return
    }
    const ac = new AbortController()
    setSeriesLoading(true)
    setSeriesError(null)
    setSeries([])
    setWalletValueSeries([])
    Promise.all([
      getMarketPositionSeries(chartSubject.wallet, selected.conditionId, chartSubject.outcomeIndex),
      getWalletPositionValueSeries(chartSubject.wallet, selected.conditionId, chartSubject.outcomeIndex),
    ])
      .then(([positionPts, walletPts]) => {
        if (ac.signal.aborted) return
        setSeries(positionPts)
        setWalletValueSeries(walletPts)
      })
      .catch((err: unknown) => {
        if (!ac.signal.aborted)
          setSeriesError(err instanceof Error ? err.message : 'Could not load chart data')
      })
      .finally(() => {
        if (!ac.signal.aborted) setSeriesLoading(false)
      })
    return () => ac.abort()
  }, [chartSubject, selected])

  const runSearch = useCallback(async () => {
    setSearchError(null)
    setSearching(true)
    setResults([])
    setSelected(null)
    setMetaHolders([])
    setEnriched([])
    setMarketMetrics({})
    setChartSubject(null)
    try {
      const rows = localFilter(normalizedQ, await searchMarkets(normalizedQ, 24))
      setResults(rows)
      if (rows.length === 0) {
        setSearchError(
          'No open, tradeable markets matched (archived, closed, or resolved markets are hidden). Try different keywords.'
        )
      }
    } catch (e) {
      setSearchError(e instanceof Error ? e.message : 'Search failed')
    } finally {
      setSearching(false)
    }
  }, [localFilter, normalizedQ])

  const analyzeMarket = useCallback(async (m: SearchMarketRow) => {
    setHoldersError(null)
    setLoadingHolders(true)
    setMetaHolders([])
    setEnriched([])
    setChartSubject(null)
    const mm = await getMarketMetrics(m.conditionId)
    setMarketMetrics({
      openInterest: mm.openInterest,
      volume: mm.volume ?? m.volumeNum,
    })
    try {
      const meta = await getTopHolders(m.conditionId, TOP_HOLDERS)
      setMetaHolders(meta)
      const flat = flattenHolders(meta)
      const profileCache = new Map<string, PublicProfile | null>()
      const statsCache = new Map<string, TraderStats>()

      const enrichedRows = await poolMap(flat, 4, async ({ holder, outcomeIndex }) => {
        const w = holder.proxyWallet
        let err: string | undefined
        try {
          if (!profileCache.has(w)) profileCache.set(w, await getPublicProfile(w))
          if (!statsCache.has(w)) statsCache.set(w, await getTraderClosedStats(w))
          const [first, posList] = await Promise.all([
            getFirstMarketTrade(w, m.conditionId),
            getPositionsForMarketWallet(w, m.conditionId),
          ])
          const position = posList.find((p) => p.outcomeIndex === holder.outcomeIndex) ?? null
          const row: EnrichedRow = {
            holder,
            outcomeIndex,
            profile: profileCache.get(w) ?? null,
            firstTradeAt: first?.timestamp ?? null,
            position,
            stats: statsCache.get(w) ?? null,
          }
          const usd = positionUsd(row)
          row.pctOfMarketOi =
            mm.openInterest != null && mm.openInterest > 0 ? (100 * usd) / mm.openInterest : null
          const volBase = (mm.volume ?? m.volumeNum) ?? null
          row.pctOfMarketVolume = volBase != null && volBase > 0 ? (100 * usd) / volBase : null
          row.whaleFlag = whaleFlagForRow(row)
          return row
        } catch (e) {
          err = e instanceof Error ? e.message : 'Row failed'
          const row: EnrichedRow = {
            holder,
            outcomeIndex,
            profile: profileCache.get(w) ?? null,
            firstTradeAt: null,
            position: null,
            stats: statsCache.get(w) ?? null,
            error: err,
          }
          const usd = positionUsd(row)
          row.pctOfMarketOi =
            mm.openInterest != null && mm.openInterest > 0 ? (100 * usd) / mm.openInterest : null
          const volBase = (mm.volume ?? m.volumeNum) ?? null
          row.pctOfMarketVolume = volBase != null && volBase > 0 ? (100 * usd) / volBase : null
          row.whaleFlag = whaleFlagForRow(row)
          return row
        }
      })
      setEnriched(enrichedRows)
    } catch (e) {
      setHoldersError(e instanceof Error ? e.message : 'Failed to load holders')
    } finally {
      setLoadingHolders(false)
    }
  }, [])

  const selectMarket = useCallback(
    (m: SearchMarketRow) => {
      setQ(m.question)
      setSelected(m)
      setMetaHolders([])
      setEnriched([])
      setMarketMetrics({})
      setHoldersError(null)
      setChartSubject(null)
      setSuggestOpen(false)
      void analyzeMarket(m)
    },
    [analyzeMarket]
  )

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (!inputWrapRef.current) return
      if (!inputWrapRef.current.contains(e.target as Node)) setSuggestOpen(false)
    }
    document.addEventListener('mousedown', onDocMouseDown)
    return () => document.removeEventListener('mousedown', onDocMouseDown)
  }, [])

  const analyze = useCallback(() => {
    if (selected) void analyzeMarket(selected)
  }, [analyzeMarket, selected])

  const chartData = useMemo(
    () => series.map((p) => ({ ...p, t: p.timestamp * 1000 })),
    [series]
  )

  const oddsChartData = useMemo(
    () =>
      walletValueSeries.map((p) => ({
        t: p.timestamp * 1000,
        oddsPct: (p.price ?? 0) * 100,
      })),
    [walletValueSeries]
  )

  const walletValueChartData = useMemo(
    () => walletValueSeries.map((p) => ({ ...p, t: p.timestamp * 1000 })),
    [walletValueSeries]
  )

  const isChartActive = (wallet: string, outcomeIndex: number) =>
    chartSubject?.wallet === wallet && chartSubject.outcomeIndex === outcomeIndex

  const activateRow = (r: EnrichedRow) => {
    const wallet = r.holder.proxyWallet
    const label = outcomeLabels[r.outcomeIndex] ?? `Outcome ${r.outcomeIndex}`
    const name = r.holder.name || r.holder.pseudonym || formatAddress(wallet)
    const next: ChartSubject = {
      wallet,
      outcomeIndex: r.outcomeIndex,
      displayName: name,
      outcomeLabel: label,
    }
    setChartSubject((prev) =>
      prev?.wallet === next.wallet && prev.outcomeIndex === next.outcomeIndex ? null : next
    )
  }

  const activeEnrichedRow = useMemo(() => {
    if (!chartSubject) return null
    return (
      enriched.find(
        (r) => r.holder.proxyWallet === chartSubject.wallet && r.outcomeIndex === chartSubject.outcomeIndex
      ) ?? null
    )
  }, [chartSubject, enriched])

  return (
    <>
      <header className="top">
        <h1>Polymarket holder dashboard</h1>
        <p className="lede">
          Search open markets, pick a contract, then inspect top wallets per outcome: profile age, first trade in
          this market, position size, overall realized PnL from closed positions, and charts on the right.
        </p>
      </header>

      <section className="panel">
        <div className="searchRow" ref={inputWrapRef}>
          <div className="inputWrap">
            <input
              className="input"
              placeholder="e.g. Bitcoin election Fed"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onFocus={() => normalizedQ.trim().length >= 2 && setSuggestOpen(true)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  if (!suggestOpen) setSuggestOpen(true)
                  setActiveSuggestIdx((i) => Math.min((suggestions.length || 0) - 1, i + 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setActiveSuggestIdx((i) => Math.max(-1, i - 1))
                } else if (e.key === 'Escape') {
                  setSuggestOpen(false)
                } else if (e.key === 'Enter') {
                  if (suggestOpen && activeSuggestIdx >= 0 && suggestions[activeSuggestIdx]) {
                    e.preventDefault()
                    selectMarket(suggestions[activeSuggestIdx])
                  } else {
                    runSearch()
                  }
                }
              }}
              aria-label="Search markets by keyword"
              role="combobox"
              aria-expanded={suggestOpen}
              aria-controls="market-suggest-main"
              aria-autocomplete="list"
            />
            {suggestOpen &&
              (suggestLoading || suggestError || suggestions.length > 0 || normalizedQ.trim().length >= 2) && (
                <div className="suggest" id="market-suggest-main" role="listbox">
                  {suggestLoading && <div className="suggestRow muted">Searching…</div>}
                  {suggestError && !suggestLoading && <div className="suggestRow err">{suggestError}</div>}
                  {!suggestLoading && !suggestError && suggestions.length === 0 && (
                    <div className="suggestRow muted">No matches.</div>
                  )}
                  {!suggestLoading &&
                    !suggestError &&
                    suggestions.map((m, idx) => (
                      <button
                        key={m.conditionId}
                        type="button"
                        className={`suggestBtn ${idx === activeSuggestIdx ? 'active' : ''}`}
                        role="option"
                        onMouseEnter={() => setActiveSuggestIdx(idx)}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => selectMarket(m)}
                      >
                        <span className="mq">{m.question}</span>
                        <span className="meta">{m.eventTitle}</span>
                      </button>
                    ))}
                </div>
              )}
          </div>
          <button type="button" className="btn primary" disabled={searching || !normalizedQ.trim()} onClick={runSearch}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        {searchError && <div className="banner err">{searchError}</div>}

        {results.length > 0 && (
          <div className="marketPick">
            <label className="label">Open markets (not resolved)</label>
            <ul className="marketList">
              {results.map((m) => (
                <li key={m.conditionId}>
                  <button
                    type="button"
                    className={`marketBtn ${selected?.conditionId === m.conditionId ? 'active' : ''}`}
                    onClick={() => selectMarket(m)}
                  >
                    <span className="mq">{m.question}</span>
                    <span className="meta">{m.eventTitle}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="btn" disabled={!selected || loadingHolders} onClick={analyze}>
              {loadingHolders ? 'Loading holders…' : 'Reload top holders & stats'}
            </button>
          </div>
        )}
      </section>

      {holdersError && <div className="banner err">{holdersError}</div>}

      {selected && (
        <section className="marketHead">
          <h2>{selected.question}</h2>
          <p className="sub">
            <span className="pill">condition {formatAddress(selected.conditionId)}</span>
            {marketMetrics.openInterest != null && (
              <span className="pill muted">OI {formatUsd(marketMetrics.openInterest)}</span>
            )}
            {(marketMetrics.volume ?? selected.volumeNum) != null && (
              <span className="pill muted">
                Volume {formatUsd((marketMetrics.volume ?? selected.volumeNum) as number)}
              </span>
            )}
            {metaHolders.length > 0 && (
              <span className="pill muted">Top {TOP_HOLDERS} holders per outcome</span>
            )}
          </p>
        </section>
      )}

      {selected && holderGroups.length > 0 && (
        <p className="note">
          Win rate, PnL, and <strong>return on capital</strong> use <strong>sampled closed positions</strong>{' '}
          (capital ≈ sum of totalBought×avgPrice per close when the API provides those fields). Whale flags emphasize
          unusual returns and history, not how large their stake is in <em>this</em> market. Click a row for{' '}
          <strong>cumulative position from trades</strong> (BUY adds, SELL reduces). Press Esc to close the chart
          panel.
        </p>
      )}

      <div className="mainSplit">
        <div className="leftPane">
          <div className="holder-stack">
            {holderGroups.map(([idx, rows]) => (
              <HolderTable
                key={idx}
                title={`${outcomeLabels[idx] ?? `Outcome ${idx}`} holders`}
                rows={rows}
                onActivateRow={activateRow}
                isChartActive={isChartActive}
              />
            ))}
          </div>
        </div>

        <aside className="rightPane" aria-label="Charts">
          <section className="chart-panel sticky" role="region">
            <div className="chart-head">
              <div>
                <h3 className="chart-title">Position over time</h3>
                <p className="chart-sub">
                  {chartSubject
                    ? `${chartSubject.displayName} · ${chartSubject.outcomeLabel} · cumulative shares from trades`
                    : 'Select a wallet row to show charts.'}
                </p>
              </div>
              {chartSubject && (
                <button type="button" className="btn ghost" onClick={() => setChartSubject(null)}>
                  Close
                </button>
              )}
            </div>

            {chartSubject && (
              <div className="chartToggles" role="group" aria-label="Chart visibility">
                <button
                  type="button"
                  className={`chip ${chartVis.odds ? 'on' : ''} ${oddsChartData.length === 0 ? 'disabled' : ''}`}
                  disabled={oddsChartData.length === 0}
                  onClick={() => setChartVis((v) => ({ ...v, odds: !v.odds }))}
                >
                  Odds
                </button>
                <button
                  type="button"
                  className={`chip ${chartVis.shares ? 'on' : ''}`}
                  onClick={() => setChartVis((v) => ({ ...v, shares: !v.shares }))}
                >
                  Shares
                </button>
                <button
                  type="button"
                  className={`chip ${chartVis.usd ? 'on' : ''}`}
                  onClick={() => setChartVis((v) => ({ ...v, usd: !v.usd }))}
                >
                  USD
                </button>
              </div>
            )}

            {chartSubject && activeEnrichedRow?.whaleFlag?.flagged && (
              <div className="flagBox" role="note">
                <div className="flagTitle">Flagged as suspicious whale</div>
                <ul className="flagList">
                  {activeEnrichedRow.whaleFlag.reasons.map((t) => (
                    <li key={t}>{t}</li>
                  ))}
                </ul>
                <div className="flagHint">
                  Heuristic only. Based on sampled closes (may be truncated); large positions here are context only,
                  not a flag signal.
                </div>
              </div>
            )}

            {chartSubject && activeEnrichedRow && (
              <div className="exposureBox" role="note">
                <div className="exposureTitle">Whale alert context</div>
                <div className="exposureRow">
                  <span>Share of market OI</span>
                  <strong>
                    {activeEnrichedRow.pctOfMarketOi != null
                      ? `${activeEnrichedRow.pctOfMarketOi.toFixed(2)}%`
                      : 'N/A'}
                  </strong>
                </div>
                <div className="exposureRow">
                  <span>Share of market volume</span>
                  <strong>
                    {activeEnrichedRow.pctOfMarketVolume != null
                      ? `${activeEnrichedRow.pctOfMarketVolume.toFixed(2)}%`
                      : 'N/A'}
                  </strong>
                </div>
                <div className="flagHint">Based on wallet position notional vs market totals when available.</div>
              </div>
            )}

            {!chartSubject && <p className="chart-muted">Pick a wallet row on the left.</p>}
            {chartSubject && seriesLoading && <p className="chart-muted">Loading trade history…</p>}
            {chartSubject && seriesError && <p className="chart-err">{seriesError}</p>}
            {chartSubject &&
              !seriesLoading &&
              !seriesError &&
              chartData.length === 0 &&
              oddsChartData.length === 0 &&
              walletValueChartData.length === 0 && (
                <p className="chart-muted">No TRADE activity found for this outcome.</p>
              )}

            {chartSubject && chartVis.odds && !seriesLoading && !seriesError && oddsChartData.length > 0 && (
              <div className="chart-box">
                <h4 className="chartMiniTitle">Wallet trade prices (implied %)</h4>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={oddsChartData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(ms) =>
                        new Date(ms).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      }
                      stroke="#5a6a7e"
                      tick={{ fill: '#8b98a8', fontSize: 11 }}
                    />
                    <YAxis
                      stroke="#5a6a7e"
                      tick={{ fill: '#8b98a8', fontSize: 11 }}
                      width={50}
                      domain={[0, 100]}
                      tickFormatter={(v) => `${Number(v).toFixed(0)}%`}
                    />
                    <Tooltip
                      labelFormatter={(ms) =>
                        typeof ms === 'number'
                          ? new Date(ms).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })
                          : ''
                      }
                      formatter={(value) => [
                        `${typeof value === 'number' ? value.toFixed(2) : String(value ?? '')}%`,
                        'Implied',
                      ]}
                      contentStyle={{
                        background: '#151c28',
                        border: '1px solid #2a3a50',
                        borderRadius: 8,
                        color: '#e8ecf1',
                      }}
                    />
                    <Line
                      type="monotone"
                      dataKey="oddsPct"
                      stroke="#f6c343"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {chartSubject && chartVis.shares && !seriesLoading && !seriesError && chartData.length > 0 && (
              <div className="chart-box">
                <h4 className="chartMiniTitle">Wallet position (shares)</h4>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={chartData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(ms) =>
                        new Date(ms).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      }
                      stroke="#5a6a7e"
                      tick={{ fill: '#8b98a8', fontSize: 11 }}
                    />
                    <YAxis
                      stroke="#5a6a7e"
                      tick={{ fill: '#8b98a8', fontSize: 11 }}
                      width={50}
                      tickFormatter={(v) => Number(v).toFixed(0)}
                    />
                    <Tooltip
                      labelFormatter={(ms) =>
                        typeof ms === 'number'
                          ? new Date(ms).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })
                          : ''
                      }
                      formatter={(value) => [
                        typeof value === 'number' ? value.toFixed(2) : String(value ?? ''),
                        'Shares',
                      ]}
                      contentStyle={{
                        background: '#151c28',
                        border: '1px solid #2a3a50',
                        borderRadius: 8,
                        color: '#e8ecf1',
                      }}
                    />
                    <Line
                      type="stepAfter"
                      dataKey="position"
                      stroke="#6ea8ff"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}

            {chartSubject && chartVis.usd && !seriesLoading && !seriesError && walletValueChartData.length > 0 && (
              <div className="chart-box">
                <h4 className="chartMiniTitle">Wallet position value (USD)</h4>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={walletValueChartData} margin={{ top: 8, right: 12, left: 4, bottom: 4 }}>
                    <XAxis
                      dataKey="t"
                      type="number"
                      domain={['dataMin', 'dataMax']}
                      tickFormatter={(ms) =>
                        new Date(ms).toLocaleString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })
                      }
                      stroke="#5a6a7e"
                      tick={{ fill: '#8b98a8', fontSize: 11 }}
                    />
                    <YAxis
                      stroke="#5a6a7e"
                      tick={{ fill: '#8b98a8', fontSize: 11 }}
                      width={64}
                      tickFormatter={(v) => formatUsd(Number(v))}
                    />
                    <Tooltip
                      labelFormatter={(ms) =>
                        typeof ms === 'number'
                          ? new Date(ms).toLocaleString(undefined, {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })
                          : ''
                      }
                      formatter={(value, name) => {
                        if (name === 'usdValue')
                          return [typeof value === 'number' ? formatUsd(value) : String(value ?? ''), 'USD']
                        return [typeof value === 'number' ? value.toFixed(2) : String(value ?? ''), '']
                      }}
                      contentStyle={{
                        background: '#151c28',
                        border: '1px solid #2a3a50',
                        borderRadius: 8,
                        color: '#e8ecf1',
                      }}
                    />
                    <Line
                      type="stepAfter"
                      dataKey="usdValue"
                      stroke="#58d39b"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                      name="usdValue"
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </section>
        </aside>
      </div>

      {loadingHolders && <div className="panel muted">Fetching holder lists and per-wallet stats…</div>}

      {selected &&
        !loadingHolders &&
        !holdersError &&
        metaHolders.length > 0 &&
        enriched.length === 0 && (
          <div className="banner">No top holders were returned for this market.</div>
        )}
    </>
  )
}

function HolderTable({
  title,
  rows,
  onActivateRow,
  isChartActive,
}: {
  title: string
  rows: EnrichedRow[]
  onActivateRow: (r: EnrichedRow) => void
  isChartActive: (wallet: string, outcomeIndex: number) => boolean
}) {
  if (rows.length === 0) {
    return (
      <section className="card">
        <h3>{title}</h3>
        <p className="empty">No data yet. Search, select a market — data loads automatically.</p>
      </section>
    )
  }
  return (
    <section className="card">
      <h3>{title}</h3>
      <p className="table-kicker">Select a row to open charts on the right.</p>
      <div className="tableWrap">
        <table className="table">
          <colgroup>
            <col className="colRank" />
            <col className="colTrader" />
            <col className="colCreated" />
            <col className="colFirst" />
            <col className="colTokens" />
            <col className="colAvg" />
            <col className="colPnl" />
            <col className="colPnl" />
            <col className="colWin" />
            <col className="colReturn" />
            <col className="colAlert" />
          </colgroup>
          <thead>
            <tr>
              <th>#</th>
              <th>Trader</th>
              <th>Created</th>
              <th>First in market</th>
              <th>Tokens</th>
              <th>Avg</th>
              <th>30d realized</th>
              <th>Lifetime realized</th>
              <th>Win rate</th>
              <th
                title={`Lifetime realized PnL ÷ estimated capital deployed on sampled closes (totalBought×avgPrice per position). Shown when est. capital ≥ $${CLOSED_CAPITAL_MIN_FOR_RETURN_PCT}.`}
              >
                Return vs capital
              </th>
              <th>Whale alert</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const w = r.holder.proxyWallet
              const active = isChartActive(w, r.outcomeIndex)
              const name = r.holder.name || r.holder.pseudonym || 'Anonymous'
              const flagged = r.whaleFlag?.flagged === true
              return (
                <tr
                  key={`${w}-${r.holder.outcomeIndex}-${i}`}
                  className={active ? 'row-active' : flagged ? 'row-flagged' : undefined}
                  tabIndex={0}
                  aria-selected={active}
                  onClick={() => onActivateRow(r)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      onActivateRow(r)
                    }
                  }}
                >
                  <td>{i + 1}</td>
                  <td className="who">
                    <div className="name">{name}</div>
                    <a
                      className="addr"
                      href={`https://polymarket.com/profile/${w}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {formatAddress(w)}
                    </a>
                    {r.error && <div className="rowErr">{r.error}</div>}
                  </td>
                  <td>
                    {r.profile?.createdAt
                      ? new Date(r.profile.createdAt).toLocaleString(undefined, {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        })
                      : '—'}
                  </td>
                  <td>{r.firstTradeAt ? formatTs(r.firstTradeAt) : '—'}</td>
                  <td>
                    {r.position?.size != null ? r.position.size.toFixed(2) : r.holder.amount.toFixed(2)}
                  </td>
                  <td>{r.position?.avgPrice != null ? r.position.avgPrice.toFixed(3) : '—'}</td>
                  <td className={pnlClass(r.stats?.recentRealizedPnl)}>
                    {r.stats ? formatUsd(r.stats.recentRealizedPnl) : '—'}
                  </td>
                  <td className={pnlClass(r.stats?.lifetimeRealizedPnl)}>
                    {r.stats ? formatUsd(r.stats.lifetimeRealizedPnl) : '—'}
                    {r.stats?.truncated && <span className="hint"> · sample cap</span>}
                  </td>
                  <td>
                    {winRatePct(r.stats) ?? '—'}
                    {r.stats && r.stats.closedPositionsSampled > 0 && (
                      <span className="hint">
                        {' '}
                        ({r.stats.wins}W/{r.stats.losses}L)
                      </span>
                    )}
                  </td>
                  <td className="returnCell">
                    {r.stats && r.stats.closedReturnPct != null ? (
                      <>
                        <div className={pnlClass(r.stats.closedReturnPct)}>{formatSignedReturnPct(r.stats.closedReturnPct)}</div>
                        <div className="hint">
                          {formatUsd(r.stats.lifetimeRealizedPnl)} / {formatUsd(r.stats.closedCapitalContributed)}
                        </div>
                      </>
                    ) : r.stats && r.stats.closedPositionsSampled > 0 ? (
                      <span className="hint" title={`Need ≥ $${CLOSED_CAPITAL_MIN_FOR_RETURN_PCT} est. capital from API fields`}>
                        N/A
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="alertCell">
                    <div className={`alertTag ${flagged ? 'hot' : ''}`}>{flagged ? 'FLAGGED' : 'watch'}</div>
                    <div className="alertMeta">OI {r.pctOfMarketOi != null ? `${r.pctOfMarketOi.toFixed(2)}%` : '—'}</div>
                    <div className="alertMeta">
                      Vol {r.pctOfMarketVolume != null ? `${r.pctOfMarketVolume.toFixed(2)}%` : '—'}
                    </div>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function pnlClass(n: number | undefined) {
  if (n == null || Number.isNaN(n)) return ''
  if (n > 0) return 'pos'
  if (n < 0) return 'neg'
  return ''
}
