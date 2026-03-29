import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCorners,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import { arrayMove, SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  formatUsd,
  getMarketLiveQuote,
  type MarketLiveQuote,
  searchMarkets,
  type SearchMarketRow,
} from './polymarketApi'
import {
  emptyPlannerState,
  entryFromSearch,
  loadPlannerState,
  newList,
  savePlannerState,
  type PayoffList,
  type PayoffMarketEntry,
  type PayoffPlannerState,
} from './payoffPlannerModel'
import {
  buildUserBookScenarios,
  effectiveEntryPrice,
  ladderConditionalProbs,
  ladderOrderIndices,
  naiveMarginalEV,
  scenarioSummaryPnL,
  totalPrincipalAtRisk,
  winTotalIfWin,
  type ScenarioResult,
} from './payoffPlannerScenarios'

function listDragId(id: string) {
  return `pl-list:${id}`
}
function marketDragId(listId: string, marketId: string) {
  return `pl-mkt:${listId}:${marketId}`
}
function listDropId(listId: string) {
  return `pl-list-drop:${listId}`
}

function parseListId(dragId: string): string | null {
  if (!dragId.startsWith('pl-list:')) return null
  return dragId.slice('pl-list:'.length) || null
}
function parseMarketId(dragId: string): { listId: string; marketId: string } | null {
  if (!dragId.startsWith('pl-mkt:')) return null
  const rest = dragId.slice('pl-mkt:'.length)
  const parts = rest.split(':')
  if (parts.length !== 2) return null
  return { listId: parts[0], marketId: parts[1] }
}
function parseListDropId(dragId: string): string | null {
  if (!dragId.startsWith('pl-list-drop:')) return null
  return dragId.slice('pl-list-drop:'.length) || null
}

function reorderListOrder(state: PayoffPlannerState, activeList: string, overList: string): PayoffPlannerState {
  const oldIndex = state.listOrder.indexOf(activeList)
  const newIndex = state.listOrder.indexOf(overList)
  if (oldIndex < 0 || newIndex < 0) return state
  return { ...state, listOrder: arrayMove(state.listOrder, oldIndex, newIndex) }
}

function moveMarketToList(
  state: PayoffPlannerState,
  fromListId: string,
  marketId: string,
  toListId: string,
  insertBeforeId: string | null
): PayoffPlannerState {
  const src = state.lists[fromListId]
  const dst = state.lists[toListId]
  if (!src || !dst) return state
  const idx = src.markets.findIndex((m) => m.id === marketId)
  if (idx < 0) return state
  const market = src.markets[idx]

  if (fromListId === toListId) {
    const cur = [...src.markets]
    const [item] = cur.splice(idx, 1)
    let insertAt = cur.length
    if (insertBeforeId) {
      const j = cur.findIndex((m) => m.id === insertBeforeId)
      if (j >= 0) insertAt = j
    }
    cur.splice(insertAt, 0, item)
    return {
      ...state,
      lists: { ...state.lists, [fromListId]: { ...src, markets: cur } },
    }
  }

  const srcMarkets = src.markets.filter((_, i) => i !== idx)
  let insertAt = dst.markets.length
  if (insertBeforeId) {
    const j = dst.markets.findIndex((m) => m.id === insertBeforeId)
    if (j >= 0) insertAt = j
  }
  const dstMarkets = [...dst.markets]
  dstMarkets.splice(insertAt, 0, market)
  return {
    ...state,
    lists: {
      ...state.lists,
      [fromListId]: { ...src, markets: srcMarkets },
      [toListId]: { ...dst, markets: dstMarkets },
    },
  }
}

export default function PayoffPlannerTab() {
  const [state, setState] = useState<PayoffPlannerState>(() => {
    const s = loadPlannerState()
    return s.listOrder.length > 0 ? s : emptyPlannerState()
  })
  const [quotes, setQuotes] = useState<Map<string, MarketLiveQuote>>(() => new Map())
  const [searchQ, setSearchQ] = useState('')
  const [searchHits, setSearchHits] = useState<SearchMarketRow[]>([])
  const [searching, setSearching] = useState(false)
  const [addForListId, setAddForListId] = useState<string | null>(null)

  useEffect(() => {
    const t = window.setTimeout(() => savePlannerState(state), 350)
    return () => window.clearTimeout(t)
  }, [state])

  const conditionIds = useMemo(() => {
    const s = new Set<string>()
    for (const lid of state.listOrder) {
      const list = state.lists[lid]
      if (!list) continue
      for (const m of list.markets) s.add(m.conditionId)
    }
    return [...s]
  }, [state])

  const refreshQuotes = useCallback(async () => {
    if (conditionIds.length === 0) {
      setQuotes(new Map())
      return
    }
    const next = new Map<string, MarketLiveQuote>()
    const chunk = 6
    for (let i = 0; i < conditionIds.length; i += chunk) {
      const part = conditionIds.slice(i, i + chunk)
      const rows = await Promise.all(part.map((id) => getMarketLiveQuote(id)))
      for (let j = 0; j < part.length; j++) {
        const q = rows[j]
        if (q) next.set(part[j], q)
      }
    }
    setQuotes(next)
  }, [conditionIds])

  useEffect(() => {
    void refreshQuotes()
  }, [refreshQuotes])

  useEffect(() => {
    const t = window.setInterval(() => void refreshQuotes(), 60_000)
    return () => window.clearInterval(t)
  }, [refreshQuotes])

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event
    if (!over) return
    const aid = String(active.id)
    const oid = String(over.id)

    if (aid.startsWith('pl-list:')) {
      const a = parseListId(aid)
      const o = parseListId(oid)
      if (a && o && a !== o) setState((s) => reorderListOrder(s, a, o))
      return
    }

    if (aid.startsWith('pl-mkt:')) {
      const am = parseMarketId(aid)
      if (!am) return
      if (oid.startsWith('pl-mkt:')) {
        const om = parseMarketId(oid)
        if (!om) return
        setState((s) => moveMarketToList(s, am.listId, am.marketId, om.listId, om.marketId))
        return
      }
      const dropList = parseListDropId(oid)
      if (dropList) setState((s) => moveMarketToList(s, am.listId, am.marketId, dropList, null))
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor)
  )

  const runSearch = async () => {
    const q = searchQ.trim()
    if (!q) {
      setSearchHits([])
      return
    }
    setSearching(true)
    try {
      setSearchHits(await searchMarkets(q, 20))
    } catch {
      setSearchHits([])
    } finally {
      setSearching(false)
    }
  }

  const addList = () => {
    const L = newList('My list')
    setState((s) => ({
      ...s,
      listOrder: [...s.listOrder, L.id],
      lists: { ...s.lists, [L.id]: L },
    }))
  }

  const removeList = (listId: string) => {
    setState((s) => {
      const { [listId]: _, ...rest } = s.lists
      return { ...s, listOrder: s.listOrder.filter((id) => id !== listId), lists: rest }
    })
    setAddForListId((id) => (id === listId ? null : id))
  }

  const renameList = (listId: string, name: string) => {
    setState((s) => {
      const L = s.lists[listId]
      if (!L) return s
      return { ...s, lists: { ...s.lists, [listId]: { ...L, name } } }
    })
  }

  const patchMarket = (listId: string, marketId: string, patch: Partial<PayoffMarketEntry>) => {
    setState((s) => {
      const L = s.lists[listId]
      if (!L) return s
      const markets = L.markets.map((m) => (m.id === marketId ? { ...m, ...patch } : m))
      return { ...s, lists: { ...s.lists, [listId]: { ...L, markets } } }
    })
  }

  const removeMarket = (listId: string, marketId: string) => {
    setState((s) => {
      const L = s.lists[listId]
      if (!L) return s
      return {
        ...s,
        lists: {
          ...s.lists,
          [listId]: { ...L, markets: L.markets.filter((m) => m.id !== marketId) },
        },
      }
    })
  }

  const addMarketFromSearch = async (listId: string, row: SearchMarketRow) => {
    const q = await getMarketLiveQuote(row.conditionId)
    const entry = entryFromSearch({
      ...row,
      endDateMs: q?.endDateMs ?? null,
      eventSlug: q?.eventSlug,
    })
    setState((s) => {
      const L = s.lists[listId]
      if (!L) return s
      return {
        ...s,
        lists: { ...s.lists, [listId]: { ...L, markets: [...L.markets, entry] } },
      }
    })
    if (q) setQuotes((prev) => new Map(prev).set(row.conditionId, q))
  }

  const mergeQuotesIntoEntries = () => {
    setState((s) => {
      const lists = { ...s.lists }
      for (const lid of s.listOrder) {
        const L = lists[lid]
        if (!L) continue
        const markets = L.markets.map((m) => {
          const q = quotes.get(m.conditionId)
          if (!q || q.endDateMs == null) return m
          if (m.endDateMs != null) return m
          return { ...m, endDateMs: q.endDateMs }
        })
        lists[lid] = { ...L, markets }
      }
      return { ...s, lists }
    })
  }

  return (
    <div className="payoffPlanner">
      <header className="top">
        <h1>Position & payoff planner</h1>
        <p className="lede">
          One underlying event, multiple <strong>“by [date]”</strong> contracts: put them in a list ordered by{' '}
          <strong>tenor ladder</strong> (drag: earliest “by date” at the top). We step through valid{' '}
          <strong>event timelines</strong> for nested contracts in that order, then <strong>merge</strong> timelines
          that pay the same on <em>your</em> YES/NO legs.
          <strong>Live YES/NO</strong> prices
          refresh automatically and drive payoff math until you type a <strong>manual entry</strong> override. YES pays if
          the event happened by that date; NO
          pays if it did not — so a late NO loses if an earlier deadline already resolved YES.
        </p>
      </header>

      <div className="payoffToolbar panel">
        <button type="button" className="btn primary" onClick={addList}>
          + Add list
        </button>
        <button type="button" className="btn" onClick={() => void refreshQuotes()} disabled={conditionIds.length === 0}>
          Refresh odds
        </button>
        <button type="button" className="btn" onClick={mergeQuotesIntoEntries} disabled={quotes.size === 0}>
          Sync deadlines from odds
        </button>
        <span className="payoffHint muted">Saved in this browser. Lists only — no nested groups.</span>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragEnd={handleDragEnd}>
        <SortableContext items={state.listOrder.map(listDragId)} strategy={verticalListSortingStrategy}>
          <div className="payoffListStack">
            {state.listOrder.length === 0 && (
              <div className="panel muted payoffEmpty">No lists yet — add one to start.</div>
            )}
            {state.listOrder.map((listId) => {
              const list = state.lists[listId]
              if (!list) return null
              return (
                <SortableListCard
                  key={listId}
                  list={list}
                  quotes={quotes}
                  onRemove={() => removeList(listId)}
                  onRename={(name) => renameList(listId, name)}
                  onPatchMarket={(mid, p) => patchMarket(listId, mid, p)}
                  onRemoveMarket={(mid) => removeMarket(listId, mid)}
                  addOpen={addForListId === listId}
                  onToggleAdd={() => setAddForListId((id) => (id === listId ? null : listId))}
                  searchQ={searchQ}
                  setSearchQ={setSearchQ}
                  searchHits={searchHits}
                  searching={searching}
                  onSearch={runSearch}
                  onPickMarket={(row) => addMarketFromSearch(listId, row)}
                />
              )
            })}
          </div>
        </SortableContext>
      </DndContext>
    </div>
  )
}

function SortableListCard({
  list,
  quotes,
  onRemove,
  onRename,
  onPatchMarket,
  onRemoveMarket,
  addOpen,
  onToggleAdd,
  searchQ,
  setSearchQ,
  searchHits,
  searching,
  onSearch,
  onPickMarket,
}: {
  list: PayoffList
  quotes: Map<string, MarketLiveQuote>
  onRemove: () => void
  onRename: (name: string) => void
  onPatchMarket: (marketId: string, p: Partial<PayoffMarketEntry>) => void
  onRemoveMarket: (marketId: string) => void
  addOpen: boolean
  onToggleAdd: () => void
  searchQ: string
  setSearchQ: (q: string) => void
  searchHits: SearchMarketRow[]
  searching: boolean
  onSearch: () => void
  onPickMarket: (row: SearchMarketRow) => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: listDragId(list.id),
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.85 : 1,
  }

  const { scenarios, underlyingTimelineCount, rawTimelines } = buildUserBookScenarios(list.markets, quotes)
  const summaryDistinct = scenarioSummaryPnL(scenarios)
  const summaryTimeline = scenarioSummaryPnL(rawTimelines)
  const principal = totalPrincipalAtRisk(list.markets)
  const naiveEv = naiveMarginalEV(list.markets, quotes)
  const condRows = ladderConditionalProbs(list.markets, quotes)
  const orderIdx = ladderOrderIndices(list.markets)
  const [positionBookOpen, setPositionBookOpen] = useState(true)

  return (
    <section ref={setNodeRef} style={style} className="payoffListCard panel">
      <div className="payoffListHead">
        <button type="button" className="payoffDragHandle" {...attributes} {...listeners} aria-label="Drag list">
          ⋮⋮
        </button>
        <input
          className="input payoffListName"
          value={list.name}
          onChange={(e) => onRename(e.target.value)}
          aria-label="List name"
        />
        <button type="button" className="btn" onClick={onToggleAdd}>
          {addOpen ? 'Close search' : '+ Add market'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => setPositionBookOpen((o) => !o)}
          aria-expanded={positionBookOpen}
        >
          {positionBookOpen ? 'Hide position book' : `Show position book (${list.markets.length})`}
        </button>
        <button type="button" className="btn danger" onClick={onRemove}>
          Delete list
        </button>
      </div>

      {addOpen && (
        <div className="payoffAddPanel">
          <div className="searchRow">
            <input
              className="input"
              placeholder="Search Polymarket…"
              value={searchQ}
              onChange={(e) => setSearchQ(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && onSearch()}
            />
            <button type="button" className="btn primary" disabled={searching} onClick={onSearch}>
              {searching ? '…' : 'Search'}
            </button>
          </div>
          <ul className="payoffSearchHits">
            {searchHits.map((row) => (
              <li key={row.conditionId}>
                <button type="button" className="payoffSearchHit" onClick={() => onPickMarket(row)}>
                  <span className="mq">{row.question}</span>
                  <span className="meta">{row.eventTitle}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {positionBookOpen && (
        <>
          <div className="payoffDeadlineNote muted">
            <strong>Tenor ladder</strong> — top → bottom is the order used for payouts (drag rows). Put the earliest
            “by [date]” contract first; we don’t auto-sort by API dates (they often don’t match the question).
            {orderIdx.length === 0 ? (
              ' Add markets below.'
            ) : (
              <ol className="payoffOrderList">
                {orderIdx.map((i, rank) => {
                  const m = list.markets[i]
                  const q = quotes.get(m.conditionId)
                  const t = m.endDateMs ?? q?.endDateMs
                  return (
                    <li key={m.id}>
                      <span className="payoffRunRank">({rank + 1})</span>{' '}
                      {m.question.slice(0, 56)}
                      {m.question.length > 56 ? '…' : ''}
                      <span className="meta">
                        {' '}
                        · {t ? new Date(t).toLocaleDateString() : 'no API date'}
                      </span>
                    </li>
                  )
                })}
              </ol>
            )}
          </div>

          {condRows.length > 0 && (
            <div className="payoffProbTableWrap">
              <table className="payoffProbTable">
                <caption className="sr-only">Live YES prices and rough conditional probabilities</caption>
                <thead>
                  <tr>
                    <th>Tenor (list order)</th>
                    <th>Live YES</th>
                    <th>Cond. YES*</th>
                  </tr>
                </thead>
                <tbody>
                  {condRows.map((r) => (
                    <tr key={r.label}>
                      <td>{r.label}</td>
                      <td>{(r.uncondYes * 100).toFixed(2)}%</td>
                      <td>{(r.condYes * 100).toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="payoffProbFoot muted">
                *Sketch: from chained market prices; not a model. Payoff cards use ladder scenarios in list order.
              </p>
            </div>
          )}

          <SortableContext
            items={list.markets.map((m) => marketDragId(list.id, m.id))}
            strategy={verticalListSortingStrategy}
          >
            <div className="payoffMarketDrop">
              {list.markets.map((m) => (
                <SortableMarketRow
                  key={m.id}
                  listId={list.id}
                  market={m}
                  quote={quotes.get(m.conditionId)}
                  onPatch={(p) => onPatchMarket(m.id, p)}
                  onRemove={() => onRemoveMarket(m.id)}
                />
              ))}
              <ListDropZone listId={list.id} />
            </div>
          </SortableContext>
        </>
      )}

      <div className="payoffScenarioSection">
        <h4 className="payoffScenarioTitle">
          Payoff for your book: {scenarios.length} distinct outcome
          {scenarios.length === 1 ? '' : 's'}
          {underlyingTimelineCount > 0 && underlyingTimelineCount !== scenarios.length && (
            <span className="muted">
              {' '}
              (from {underlyingTimelineCount} event timeline{underlyingTimelineCount === 1 ? '' : 's'})
            </span>
          )}
        </h4>
        <p className="payoffScenarioMeta muted">
          Cards show <strong>your YES/NO wins and losses</strong> by deadline order. Multiple event paths can collapse
          when they pay the same on your staked legs. Uniform mean over <strong>distinct book outcomes</strong>:{' '}
          <strong>{formatUsd(summaryDistinct.mean)}</strong>
          {underlyingTimelineCount > 1 && (
            <>
              {' '}
              · mean if each raw timeline equally likely: <strong>{formatUsd(summaryTimeline.mean)}</strong>
            </>
          )}
          {principal > 0 && (
            <>
              {' '}
              · total principal <strong>{formatUsd(principal)}</strong>
            </>
          )}
          {naiveEv != null && (
            <>
              {' '}
              · naive marginal EV (sketch): <strong>{formatUsd(naiveEv)}</strong>
            </>
          )}
        </p>
        <div className="payoffScenarioStrip">
          {scenarios.map((sc) => (
            <ScenarioCard key={sc.id} sc={sc} totalPrincipal={principal} />
          ))}
        </div>
      </div>
    </section>
  )
}

function ScenarioCard({ sc, totalPrincipal }: { sc: ScenarioResult; totalPrincipal: number }) {
  const retPct = totalPrincipal > 0 ? (100 * sc.pnl) / totalPrincipal : null
  const merged = (sc.mergedTimelineCount ?? 1) > 1
  return (
    <div
      className={`payoffScenarioCard ${sc.pnl >= 0 ? 'pos' : 'neg'}`}
      title={sc.mergedTimelineLabels?.join('\n') ?? sc.label}
    >
      <div className="payoffScenarioPnL">{formatUsd(sc.pnl)}</div>
      {retPct != null && <div className="payoffScenarioReturn">Return {retPct.toFixed(2)}%</div>}
      <div className="payoffScenarioBook mono">{sc.userBookPath}</div>
      <div className="payoffScenarioBookDetail">{sc.userBookDetail}</div>
      <div className="payoffScenarioEventPath muted mono">
        Contract YES? (rung 1→n): {sc.outcomePath || '—'}
      </div>
      {merged && (
        <div className="payoffScenarioMerged muted">
          {sc.mergedTimelineCount} timelines → same book
        </div>
      )}
    </div>
  )
}

function ListDropZone({ listId }: { listId: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: listDropId(listId) })
  return (
    <div ref={setNodeRef} className={`payoffDropFooter muted ${isOver ? 'payoffDropOver' : ''}`}>
      Drop here to move a market to the end of this list
    </div>
  )
}

function SortableMarketRow({
  listId,
  market,
  quote,
  onPatch,
  onRemove,
}: {
  listId: string
  market: PayoffMarketEntry
  quote: MarketLiveQuote | undefined
  onPatch: (p: Partial<PayoffMarketEntry>) => void
  onRemove: () => void
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: marketDragId(listId, market.id),
  })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  }

  const yesP = quote?.yesPrice
  const noP = quote?.noPrice
  const winTot = winTotalIfWin(market, quote)
  const eff = effectiveEntryPrice(market, quote)
  const hasManualOverride =
    market.avgEntryPrice != null &&
    Number.isFinite(market.avgEntryPrice) &&
    market.avgEntryPrice > 0 &&
    market.avgEntryPrice < 1

  const setSide = (side: PayoffMarketEntry['side']) => {
    if (side === '') {
      onPatch({ side: '', avgEntryPrice: null })
      return
    }
    if (side !== market.side) {
      onPatch({ side, avgEntryPrice: null })
    }
  }

  return (
    <div ref={setNodeRef} style={style} className="payoffMarketRow">
      <button type="button" className="payoffDragHandle" {...attributes} {...listeners} aria-label="Drag market">
        ⋮⋮
      </button>
      <div className="payoffMarketMain">
        <div className="payoffMarketTitle">
          <span className="mq">{market.question}</span>
          <span className="meta payoffHandle">{market.eventTitle}</span>
        </div>
        <div className="payoffLiveStrip">
          <span className="payoffLiveLabel">Live</span>
          <span className="payoffLiveYes">
            YES {yesP != null ? `${(yesP * 100).toFixed(1)}¢` : '—'}
          </span>
          <span className="payoffLiveNo">
            NO {noP != null ? `${(noP * 100).toFixed(1)}¢` : '—'}
          </span>
          {!quote && <span className="payoffLiveStale muted">(refresh odds)</span>}
        </div>
        <div className="payoffMarketFields">
          <label className="payoffField">
            Side
            <select
              className="input"
              value={market.side}
              onChange={(e) => setSide(e.target.value as PayoffMarketEntry['side'])}
            >
              <option value="">—</option>
              <option value="YES">YES</option>
              <option value="NO">NO</option>
            </select>
          </label>
          <label className="payoffField">
            Principal ($)
            <input
              className="input"
              type="number"
              min={0}
              step={1}
              value={market.principal || ''}
              placeholder="0"
              onChange={(e) => onPatch({ principal: Number(e.target.value) || 0 })}
            />
          </label>
          <div className="payoffManualEntry">
            <label className="payoffField">
              Manual entry (0–1)
              <input
                className="input"
                type="number"
                min={0.01}
                max={0.99}
                step={0.001}
                value={market.avgEntryPrice ?? ''}
                placeholder="— follows live —"
                onChange={(e) => {
                  const v = e.target.value
                  onPatch({ avgEntryPrice: v === '' ? null : Number(v) })
                }}
              />
            </label>
            <div className="payoffEntryActions">
              <button
                type="button"
                className="btn ghost payoffTinyBtn"
                disabled={!hasManualOverride}
                onClick={() => onPatch({ avgEntryPrice: null })}
              >
                Use live
              </button>
              <button
                type="button"
                className="btn ghost payoffTinyBtn"
                disabled={!quote || !market.side}
                onClick={() => {
                  if (!quote || !market.side) return
                  const p = market.side === 'YES' ? quote.yesPrice : quote.noPrice
                  onPatch({ avgEntryPrice: p })
                }}
              >
                Snap to live {market.side || '…'}
              </button>
            </div>
          </div>
          <div className="payoffOdds muted">
            {market.side && eff != null && (
              <div className="payoffEffectiveLine">
                Payoff math uses{' '}
                <strong>
                  {hasManualOverride ? 'manual' : 'live'} {(eff * 100).toFixed(2)}¢
                </strong>{' '}
                on {market.side}
              </div>
            )}
            {winTot != null && market.side && (
              <div className="payoffPayoutHint">
                Win total ~{formatUsd(winTot)} · Loss −{formatUsd(market.principal)}
              </div>
            )}
          </div>
        </div>
      </div>
      <button type="button" className="btn danger payoffDelBtn" onClick={onRemove}>
        Delete
      </button>
    </div>
  )
}
