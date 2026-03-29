export type WatchlistMarket = {
  conditionId: string
  question: string
  slug: string
  eventTitle: string
  outcomes: string
}

export type AlertSubscription = {
  email: string
  markets: WatchlistMarket[]
  updatedAt?: string
}

const BASE = '/api/alerts'

export async function fetchAlertConfig(): Promise<AlertSubscription> {
  const res = await fetch(`${BASE}/config`)
  if (!res.ok) throw new Error(`Failed to load alert config (${res.status})`)
  return res.json() as Promise<AlertSubscription>
}

export async function saveAlertConfig(body: AlertSubscription): Promise<void> {
  const res = await fetch(`${BASE}/config`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: body.email, markets: body.markets }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Save failed (${res.status})`)
  }
}
