import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  fetchAlertConfig,
  saveAlertConfig,
  type WatchlistMarket,
} from './alertsApi'
import { searchMarkets, type SearchMarketRow } from './polymarketApi'

export default function AlertsTab() {
  const [email, setEmail] = useState('')
  const [markets, setMarkets] = useState<WatchlistMarket[]>([])
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [saveErr, setSaveErr] = useState<string | null>(null)
  const [saveOk, setSaveOk] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)

  const [q, setQ] = useState('')
  const [suggestions, setSuggestions] = useState<SearchMarketRow[]>([])
  const [suggestOpen, setSuggestOpen] = useState(false)
  const [suggestLoading, setSuggestLoading] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  const normQ = useMemo(() => q.trim().replace(/\s+/g, ' '), [q])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setLoadErr(null)
    fetchAlertConfig()
      .then((c) => {
        if (cancelled) return
        setEmail(c.email ?? '')
        setMarkets(Array.isArray(c.markets) ? c.markets : [])
      })
      .catch((e) => {
        if (!cancelled) setLoadErr(e instanceof Error ? e.message : 'Could not load settings')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const t = normQ.trim()
    if (t.length < 2) {
      abortRef.current?.abort()
      setSuggestions([])
      setSuggestOpen(false)
      return
    }
    setSuggestOpen(true)
    setSuggestLoading(true)
    const ac = new AbortController()
    abortRef.current?.abort()
    abortRef.current = ac
    const id = window.setTimeout(() => {
      searchMarkets(t, 12, { signal: ac.signal })
        .then((rows) => {
          if (!ac.signal.aborted) setSuggestions(rows.slice(0, 8))
        })
        .catch(() => {
          if (!ac.signal.aborted) setSuggestions([])
        })
        .finally(() => {
          if (!ac.signal.aborted) setSuggestLoading(false)
        })
    }, 200)
    return () => {
      window.clearTimeout(id)
      ac.abort()
    }
  }, [normQ])

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setSuggestOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [])

  const addMarket = (m: SearchMarketRow) => {
    setMarkets((prev) => {
      if (prev.some((x) => x.conditionId === m.conditionId)) return prev
      const row: WatchlistMarket = {
        conditionId: m.conditionId,
        question: m.question,
        slug: m.slug,
        eventTitle: m.eventTitle,
        outcomes: m.outcomes,
      }
      return [...prev, row]
    })
    setQ(m.question)
    setSuggestOpen(false)
    setSaveOk(null)
  }

  const removeMarket = (conditionId: string) => {
    setMarkets((prev) => prev.filter((m) => m.conditionId !== conditionId))
    setSaveOk(null)
  }

  const clearAll = () => {
    setMarkets([])
    setSaveOk(null)
  }

  const save = useCallback(async () => {
    setSaveErr(null)
    setSaveOk(null)
    setSaving(true)
    try {
      await saveAlertConfig({ email: email.trim(), markets })
      setSaveOk('Saved. Run the whale watcher on a schedule so emails go out when positions change.')
    } catch (e) {
      setSaveErr(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSaving(false)
    }
  }, [email, markets])

  return (
    <>
      <header className="top">
        <h1>Whale alerts</h1>
        <p className="lede">
          Choose markets like on the main tab. Your list and email are stored in{' '}
          <code className="mono">data/alert-subscription.json</code> on the machine running the alerts API. The watcher
          sends email when it runs (e.g. every few minutes)—not a live WebSocket push.
        </p>
      </header>

      {loading && <p className="meta">Loading settings…</p>}
      {loadErr && <div className="banner err">{loadErr}</div>}

      {!loading && !loadErr && (
        <section className="panel">
          <label className="label" htmlFor="alert-email">
            Alert email
          </label>
          <input
            id="alert-email"
            className="input"
            type="email"
            autoComplete="email"
            placeholder="you@company.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setSaveOk(null)
            }}
            style={{ maxWidth: '420px' }}
          />

          <h2 style={{ margin: '1.25rem 0 0.5rem', fontSize: '1rem' }}>Add markets</h2>
          <div className="searchRow" ref={wrapRef}>
            <div className="inputWrap">
              <input
                className="input"
                placeholder="Search like the main dashboard…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onFocus={() => normQ.trim().length >= 2 && setSuggestOpen(true)}
                aria-label="Search markets to watch"
              />
              {suggestOpen && normQ.trim().length >= 2 && (
                <div className="suggest">
                  {suggestLoading && <div className="meta" style={{ padding: '0.6rem' }}>Searching…</div>}
                  {!suggestLoading &&
                    suggestions.map((m) => (
                      <button
                        key={m.conditionId}
                        type="button"
                        className="suggestBtn"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => addMarket(m)}
                      >
                        <span className="mq">{m.question}</span>
                        <span className="meta">{m.eventTitle}</span>
                      </button>
                    ))}
                </div>
              )}
            </div>
          </div>

          <h2 style={{ margin: '1.25rem 0 0.5rem', fontSize: '1rem' }}>Watch list ({markets.length})</h2>
          {markets.length === 0 ? (
            <p className="meta">No markets yet. Search above and pick contracts to monitor.</p>
          ) : (
            <ul className="watchList">
              {markets.map((m) => (
                <li key={m.conditionId} className="watchItem">
                  <div>
                    <div className="mq">{m.question}</div>
                    <div className="meta">{m.eventTitle}</div>
                    <div className="mono" style={{ marginTop: '0.35rem' }}>
                      {m.conditionId}
                    </div>
                  </div>
                  <button type="button" className="btn danger" onClick={() => removeMarket(m.conditionId)}>
                    Remove
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div style={{ marginTop: '1rem', display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            <button type="button" className="btn primary" disabled={saving} onClick={save}>
              {saving ? 'Saving…' : 'Save email & watch list'}
            </button>
            <button type="button" className="btn" disabled={markets.length === 0} onClick={clearAll}>
              Remove all markets
            </button>
          </div>
          {saveErr && <div className="banner err">{saveErr}</div>}
          {saveOk && <div className="banner ok">{saveOk}</div>}
        </section>
      )}
    </>
  )
}
