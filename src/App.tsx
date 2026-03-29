import { useState } from 'react'
import './App.css'
import MainDashboard from './MainDashboard'
import AlertsTab from './AlertsTab'
import PayoffPlannerTab from './PayoffPlannerTab'

type Tab = 'main' | 'alerts' | 'payoff'

export default function App() {
  const [tab, setTab] = useState<Tab>('main')

  return (
    <div className="app">
      <nav className="tabs" aria-label="Primary">
        <button type="button" className={`tab ${tab === 'main' ? 'active' : ''}`} onClick={() => setTab('main')}>
          Dashboard
        </button>
        <button
          type="button"
          className={`tab ${tab === 'alerts' ? 'active' : ''}`}
          onClick={() => setTab('alerts')}
        >
          Whale alerts
        </button>
        <button
          type="button"
          className={`tab ${tab === 'payoff' ? 'active' : ''}`}
          onClick={() => setTab('payoff')}
        >
          Payoff planner
        </button>
      </nav>
      {tab === 'main' ? <MainDashboard /> : tab === 'alerts' ? <AlertsTab /> : <PayoffPlannerTab />}
    </div>
  )
}
