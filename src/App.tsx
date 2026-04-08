import { useState } from 'react'
import './App.css'
import MainDashboard from './MainDashboard'
import AlertsTab from './AlertsTab'
import PayoffPlannerTab from './PayoffPlannerTab'

/** Set to `true` to show the Whale alerts tab again. */
const SHOW_WHALE_ALERTS_TAB = false

type Tab = 'main' | 'alerts' | 'payoff'

export default function App() {
  const [tab, setTab] = useState<Tab>('main')
  const activeTab = !SHOW_WHALE_ALERTS_TAB && tab === 'alerts' ? 'main' : tab

  return (
    <div className="app">
      <nav className="tabs" aria-label="Primary">
        <button
          type="button"
          className={`tab ${activeTab === 'main' ? 'active' : ''}`}
          onClick={() => setTab('main')}
        >
          Dashboard
        </button>
        {SHOW_WHALE_ALERTS_TAB && (
          <button
            type="button"
            className={`tab ${tab === 'alerts' ? 'active' : ''}`}
            onClick={() => setTab('alerts')}
          >
            Whale alerts
          </button>
        )}
        <button
          type="button"
          className={`tab ${activeTab === 'payoff' ? 'active' : ''}`}
          onClick={() => setTab('payoff')}
        >
          Payoff planner
        </button>
      </nav>
      {activeTab === 'main' ? (
        <MainDashboard />
      ) : activeTab === 'alerts' ? (
        <AlertsTab />
      ) : (
        <PayoffPlannerTab />
      )}
    </div>
  )
}
