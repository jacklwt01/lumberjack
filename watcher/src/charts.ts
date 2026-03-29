/**
 * Chart images via QuickChart (simple Chart.js config; no functions — must JSON-serialize).
 * https://quickchart.io/documentation/
 */

const BASE = 'https://quickchart.io/chart'

function encodeConfig(c: object): string {
  return encodeURIComponent(JSON.stringify(c))
}

export function chartUrlLine(labels: string[], values: number[], title: string): string {
  const c = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Shares',
          data: values,
          borderColor: 'rgb(110,168,255)',
          borderWidth: 2,
          fill: false,
        },
      ],
    },
    options: {
      plugins: {
        title: { display: true, text: title, color: '#e8ecf1' },
        legend: { display: false },
      },
      scales: {
        x: { ticks: { color: '#8b98a8', maxRotation: 45 }, grid: { color: '#2a3a50' } },
        y: { ticks: { color: '#8b98a8' }, grid: { color: '#2a3a50' } },
      },
    },
  }
  return `${BASE}?c=${encodeConfig(c)}&width=600&height=280&backgroundColor=%23151c28`
}

export function chartUrlOddsPct(labels: string[], oddsPct: number[], title: string): string {
  const c = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Implied %',
          data: oddsPct,
          borderColor: 'rgb(246,195,67)',
          borderWidth: 2,
          fill: false,
        },
      ],
    },
    options: {
      plugins: {
        title: { display: true, text: title, color: '#e8ecf1' },
        legend: { display: false },
      },
      scales: {
        x: { ticks: { color: '#8b98a8', maxRotation: 45 }, grid: { color: '#2a3a50' } },
        y: { min: 0, max: 100, ticks: { color: '#8b98a8' }, grid: { color: '#2a3a50' } },
      },
    },
  }
  return `${BASE}?c=${encodeConfig(c)}&width=600&height=260&backgroundColor=%23151c28`
}

export function chartUrlUsd(labels: string[], usd: number[], title: string): string {
  const c = {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'USD',
          data: usd,
          borderColor: 'rgb(88,211,155)',
          borderWidth: 2,
          fill: false,
        },
      ],
    },
    options: {
      plugins: {
        title: { display: true, text: title, color: '#e8ecf1' },
        legend: { display: false },
      },
      scales: {
        x: { ticks: { color: '#8b98a8', maxRotation: 45 }, grid: { color: '#2a3a50' } },
        y: { ticks: { color: '#8b98a8' }, grid: { color: '#2a3a50' } },
      },
    },
  }
  return `${BASE}?c=${encodeConfig(c)}&width=600&height=260&backgroundColor=%23151c28`
}
