import nodemailer from 'nodemailer'
import type { WhaleEvent } from './diff.js'
import type { PriceImpactEstimate } from './impact.js'
import { chartUrlLine, chartUrlOddsPct, chartUrlUsd } from './charts.js'
import type { SeriesPack } from './seriesFromTrades.js'
import type { SnapshotMarketSection, SnapshotOutcomeBlock } from './snapshotSummary.js'

export type MarketAlertBlock = {
  conditionId: string
  question?: string
  events: WhaleEvent[]
  impacts: Map<string, PriceImpactEstimate>
  series: SeriesPack | null
  seriesTitle: string
}

function impactKey(e: WhaleEvent): string {
  return `${e.wallet.toLowerCase()}\0${e.outcomeIndex}`
}

function fmtWallet(w: string): string {
  if (w.length < 12) return w
  return `${w.slice(0, 6)}…${w.slice(-4)}`
}

function eventRowHtml(e: WhaleEvent, impact: PriceImpactEstimate | undefined): string {
  const who = e.name || fmtWallet(e.wallet)
  const typeLabel =
    e.type === 'NEW_WHALE'
      ? 'New top holder'
      : e.type === 'BUILD'
        ? 'Building'
        : e.type === 'REDUCE'
          ? 'Reducing'
          : 'Exited top'
  const rank =
    e.nextRank != null ? `#${e.nextRank}` : e.prevRank != null ? `was #${e.prevRank}` : '—'
  const delta = e.deltaShares >= 0 ? `+${e.deltaShares.toFixed(2)}` : e.deltaShares.toFixed(2)
  let impactHtml = ''
  if (impact?.changePctPoints != null) {
    const sign = impact.changePctPoints >= 0 ? '+' : ''
    impactHtml = `<br/><span style="color:#9fb0c6;font-size:12px">Tape proxy: median price moved ~${sign}${impact.changePctPoints.toFixed(2)}% (same outcome, near wallet activity).</span>`
  } else if (impact?.note) {
    impactHtml = `<br/><span style="color:#9fb0c6;font-size:12px">${escapeHtml(impact.note)}</span>`
  }

  return `
  <tr>
    <td style="padding:8px;border-bottom:1px solid #243044">${escapeHtml(typeLabel)}</td>
    <td style="padding:8px;border-bottom:1px solid #243044">${escapeHtml(who)}</td>
    <td style="padding:8px;border-bottom:1px solid #243044">outcome ${e.outcomeIndex}</td>
    <td style="padding:8px;border-bottom:1px solid #243044">${rank}</td>
    <td style="padding:8px;border-bottom:1px solid #243044">${delta} sh</td>
    <td style="padding:8px;border-bottom:1px solid #243044;text-align:left">${impactHtml}</td>
  </tr>`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function blockHtml(b: MarketAlertBlock): string {
  const rows = b.events
    .map((e) => eventRowHtml(e, b.impacts.get(impactKey(e))))
    .join('')

  let charts = ''
  if (b.series && b.series.labels.length > 0) {
    const oddsUrl = chartUrlOddsPct(b.series.labels, b.series.oddsPct, `${b.seriesTitle} — implied odds`)
    const posUrl = chartUrlLine(b.series.labels, b.series.position, `${b.seriesTitle} — position (shares)`)
    const usdUrl = chartUrlUsd(b.series.labels, b.series.usd, `${b.seriesTitle} — notional USD`)
    charts = `
      <p style="color:#8b98a8;font-size:13px">Charts (from wallet trade tape; same style as dashboard).</p>
      <img src="${oddsUrl}" alt="Odds" width="600" style="max-width:100%;height:auto;display:block;margin:8px 0;border-radius:8px" />
      <img src="${posUrl}" alt="Position" width="600" style="max-width:100%;height:auto;display:block;margin:8px 0;border-radius:8px" />
      <img src="${usdUrl}" alt="USD" width="600" style="max-width:100%;height:auto;display:block;margin:8px 0;border-radius:8px" />
    `
  }

  const title = b.question || b.conditionId.slice(0, 18) + '…'

  return `
  <div style="margin-bottom:28px;padding:16px;background:#0c1018;border:1px solid #243044;border-radius:12px">
    <h2 style="margin:0 0 8px;color:#e8ecf1;font-size:18px">${escapeHtml(title)}</h2>
    <p style="margin:0 0 12px;color:#7d8a99;font-size:12px;font-family:monospace">${escapeHtml(b.conditionId)}</p>
    <table style="width:100%;border-collapse:collapse;color:#e8ecf1;font-size:13px;margin-bottom:16px">
      <thead>
        <tr style="text-align:left;color:#8b98a8;text-transform:uppercase;font-size:11px">
          <th style="padding:8px;border-bottom:1px solid #334760">Event</th>
          <th style="padding:8px;border-bottom:1px solid #334760">Trader</th>
          <th style="padding:8px;border-bottom:1px solid #334760">Outcome</th>
          <th style="padding:8px;border-bottom:1px solid #334760">Rank</th>
          <th style="padding:8px;border-bottom:1px solid #334760">Δ shares</th>
          <th style="padding:8px;border-bottom:1px solid #334760">Price impact (proxy)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${charts}
  </div>`
}

export async function sendAlertEmail(opts: {
  blocks: MarketAlertBlock[]
  subject: string
  /** Dashboard subscription email overrides EMAIL_TO when set */
  to?: string
}): Promise<void> {
  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT ?? '587')
  const secure = process.env.SMTP_SECURE === 'true'
  const user = process.env.SMTP_USER ?? ''
  const pass = process.env.SMTP_PASS ?? ''
  const from = process.env.EMAIL_FROM
  const to = opts.to?.trim() || process.env.EMAIL_TO || 'jack.li@jlico.co'

  if (!host || !from) {
    throw new Error('Missing SMTP_HOST or EMAIL_FROM in environment.')
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  })

  const body = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#06080d;font-family:Segoe UI,system-ui,sans-serif">
  <div style="max-width:640px;margin:0 auto">
    <h1 style="color:#e8ecf1;font-size:22px">Polymarket whale alert</h1>
    <p style="color:#9aa7b6;font-size:14px;line-height:1.5">
      Automated report: changes among top holders vs your last snapshot.
      <strong>Price impact</strong> is a heuristic from public trade tape (median price before/after wallet activity for the same outcome)—not a guaranteed causal measure.
    </p>
    ${opts.blocks.map(blockHtml).join('')}
    <p style="color:#7d8a99;font-size:12px;margin-top:24px">
      Suggestions: manage markets and email in the dashboard Whale alerts tab; run the watcher every 5–15 minutes; or use GitHub Actions;
      tighten MIN_CHANGE_USD to reduce noise; use a dedicated alerts inbox and SMTP from your domain (SPF/DKIM).
    </p>
  </div>
</body>
</html>`

  await transporter.sendMail({
    from,
    to,
    subject: opts.subject,
    html: body,
  })
}

function snapshotOutcomeTable(o: SnapshotOutcomeBlock): string {
  const rows = o.rows
    .map(
      (r) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #243044">${r.rank}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #243044">${escapeHtml(r.name || '—')}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #243044;font-family:monospace;font-size:11px">${escapeHtml(r.wallet)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #243044">${r.shares.toFixed(2)}</td>
    </tr>`
    )
    .join('')
  return `
    <h3 style="margin:16px 0 8px;color:#c7d3e4;font-size:15px">${escapeHtml(o.label)} <span style="color:#7d8a99;font-weight:400">(outcome ${o.outcomeIndex})</span></h3>
    <table style="width:100%;border-collapse:collapse;color:#e8ecf1;font-size:12px;margin-bottom:8px">
      <thead>
        <tr style="text-align:left;color:#8b98a8;text-transform:uppercase;font-size:10px">
          <th style="padding:6px 8px;border-bottom:1px solid #334760">#</th>
          <th style="padding:6px 8px;border-bottom:1px solid #334760">Name</th>
          <th style="padding:6px 8px;border-bottom:1px solid #334760">Wallet</th>
          <th style="padding:6px 8px;border-bottom:1px solid #334760">Shares</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
}

function snapshotSectionHtml(s: SnapshotMarketSection): string {
  const title = s.question || s.conditionId.slice(0, 20) + '…'
  const tables =
    s.outcomes.length > 0
      ? s.outcomes.map(snapshotOutcomeTable).join('')
      : '<p style="color:#8b98a8;font-size:13px">No top holders were returned for this market in the current snapshot.</p>'
  const imgs = s.charts
    .map(
      (c) => `
    <p style="color:#8b98a8;font-size:12px;margin:12px 0 4px">${escapeHtml(c.title)}</p>
    <img src="${c.src}" alt="" width="600" style="max-width:100%;height:auto;display:block;border-radius:8px" />`
    )
    .join('')

  return `
  <div style="margin-bottom:32px;padding:16px;background:#0c1018;border:1px solid #243044;border-radius:12px">
    <h2 style="margin:0 0 8px;color:#e8ecf1;font-size:18px">${escapeHtml(title)}</h2>
    <p style="margin:0 0 12px;color:#7d8a99;font-size:11px;font-family:monospace;word-break:break-all">${escapeHtml(s.conditionId)}</p>
    <p style="color:#9aa7b6;font-size:13px;margin-bottom:8px">Current top holders in your watch scope (snapshot at subscribe / first run).</p>
    ${tables}
    ${imgs || '<p style="color:#8b98a8;font-size:12px">No chart data available yet for this market.</p>'}
  </div>`
}

export function canSendEmail(): boolean {
  return Boolean(process.env.SMTP_HOST?.trim() && process.env.EMAIL_FROM?.trim())
}

/** Sent when a market is first added to the watchlist (no prior snapshot). */
export async function sendSnapshotSummaryEmail(opts: {
  sections: SnapshotMarketSection[]
  subject: string
  to?: string
}): Promise<void> {
  if (opts.sections.length === 0) return

  const host = process.env.SMTP_HOST
  const port = Number(process.env.SMTP_PORT ?? '587')
  const secure = process.env.SMTP_SECURE === 'true'
  const user = process.env.SMTP_USER ?? ''
  const pass = process.env.SMTP_PASS ?? ''
  const from = process.env.EMAIL_FROM
  const to = opts.to?.trim() || process.env.EMAIL_TO || 'jack.li@jlico.co'

  if (!host || !from) {
    throw new Error('Missing SMTP_HOST or EMAIL_FROM in environment.')
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: user ? { user, pass } : undefined,
  })

  const body = `
<!DOCTYPE html>
<html>
<body style="margin:0;padding:24px;background:#06080d;font-family:Segoe UI,system-ui,sans-serif">
  <div style="max-width:640px;margin:0 auto">
    <h1 style="color:#e8ecf1;font-size:22px">Polymarket watchlist snapshot</h1>
    <p style="color:#9aa7b6;font-size:14px;line-height:1.5">
      You subscribed to alerts for the market(s) below. This is a <strong>baseline snapshot</strong> of the largest holders per outcome (Yes/No or multi-outcome labels when available),
      plus charts from the public trade tape (implied odds and the current outcome leader’s position history).
      Later emails will only be sent when positions change meaningfully vs this snapshot.
    </p>
    ${opts.sections.map(snapshotSectionHtml).join('')}
    <p style="color:#7d8a99;font-size:12px;margin-top:24px">
      Manage markets and email in the dashboard <strong>Whale alerts</strong> tab.
    </p>
  </div>
</body>
</html>`

  await transporter.sendMail({
    from,
    to,
    subject: opts.subject,
    html: body,
  })
}
