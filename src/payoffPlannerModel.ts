/** Persisted payoff planner state (localStorage). */

export const PAYOFF_PLANNER_STORAGE_KEY = 'polymarket-payoff-planner-v1'

export type BetSide = 'YES' | 'NO' | ''

export type PayoffMarketEntry = {
  id: string
  conditionId: string
  question: string
  slug: string
  eventTitle: string
  eventSlug: string
  outcomesJson: string
  endDateMs: number | null
  side: BetSide
  /** USDC principal at entry */
  principal: number
  /**
   * Average entry price (0–1) for the chosen side — used for payoff math (Excel-style).
   * If unset, live quote for that side is used until you fill this in.
   */
  avgEntryPrice: number | null
  /**
   * Optional manual override for implied P(YES) used in EV calculations.
   * Stored as 0–1 (e.g. 0.6 = 60%). If null, uses live YES price.
   */
  manualYesProb: number | null
}

export type PayoffList = {
  id: string
  name: string
  markets: PayoffMarketEntry[]
}

export type PayoffPlannerState = {
  version: 2
  listOrder: string[]
  lists: Record<string, PayoffList>
}

type LegacyV1State = {
  version: 1
  listOrder: string[]
  lists: Record<
    string,
    {
      id: string
      name: string
      groupOrder: string[]
      groups: Record<
        string,
        {
          markets: PayoffMarketEntry[]
        }
      >
    }
  >
}

export function newId(): string {
  return crypto.randomUUID()
}

export function emptyPlannerState(): PayoffPlannerState {
  return { version: 2, listOrder: [], lists: {} }
}

function migrateV1ToV2(p: LegacyV1State): PayoffPlannerState {
  const lists: Record<string, PayoffList> = {}
  for (const listId of p.listOrder) {
    const L = p.lists[listId]
    if (!L) continue
    const markets: PayoffMarketEntry[] = []
    for (const gid of L.groupOrder ?? []) {
      const g = L.groups?.[gid]
      if (!g?.markets) continue
      for (const m of g.markets) {
        const e = m as PayoffMarketEntry & { avgEntryPrice?: number | null }
        markets.push(
          normalizeEntry({
            ...e,
            avgEntryPrice: e.avgEntryPrice ?? null,
          })
        )
      }
    }
    lists[listId] = { id: L.id, name: L.name, markets }
  }
  return { version: 2, listOrder: [...p.listOrder], lists }
}

function normalizeEntry(m: PayoffMarketEntry): PayoffMarketEntry {
  return {
    ...m,
    avgEntryPrice: m.avgEntryPrice ?? null,
    manualYesProb: m.manualYesProb ?? null,
  }
}

export function loadPlannerState(): PayoffPlannerState {
  try {
    const raw = localStorage.getItem(PAYOFF_PLANNER_STORAGE_KEY)
    if (!raw) return emptyPlannerState()
    const p = JSON.parse(raw) as { version?: number } & Record<string, unknown>
    if (p?.version === 1 && Array.isArray((p as LegacyV1State).listOrder)) {
      return migrateV1ToV2(p as LegacyV1State)
    }
    if (
      p?.version === 2 &&
      typeof p.lists === 'object' &&
      Array.isArray((p as PayoffPlannerState).listOrder)
    ) {
      const s = p as PayoffPlannerState
      return {
        ...s,
        lists: Object.fromEntries(
          Object.entries(s.lists).map(([k, L]) => [
            k,
            {
              ...L,
              markets: L.markets.map((m) => normalizeEntry(m as PayoffMarketEntry)),
            },
          ])
        ) as Record<string, PayoffList>,
      }
    }
    return emptyPlannerState()
  } catch {
    return emptyPlannerState()
  }
}

export function savePlannerState(s: PayoffPlannerState): void {
  try {
    localStorage.setItem(PAYOFF_PLANNER_STORAGE_KEY, JSON.stringify(s))
  } catch {
    /* quota / private mode */
  }
}

export function newList(name = 'New list'): PayoffList {
  const id = newId()
  return { id, name, markets: [] }
}

export function entryFromSearch(row: {
  conditionId: string
  question: string
  slug: string
  eventTitle: string
  outcomes: string
  endDateMs?: number | null
  eventSlug?: string
}): PayoffMarketEntry {
  return {
    id: newId(),
    conditionId: row.conditionId,
    question: row.question,
    slug: row.slug,
    eventTitle: row.eventTitle,
    eventSlug: row.eventSlug ?? row.slug,
    outcomesJson: row.outcomes,
    endDateMs: row.endDateMs ?? null,
    side: '',
    principal: 0,
    avgEntryPrice: null,
    manualYesProb: null,
  }
}
