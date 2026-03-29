import express from 'express'
import cors from 'cors'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(__dirname, '..')
const dataDir = path.join(repoRoot, 'data')
const configPath = process.env.ALERT_CONFIG_PATH ?? path.join(dataDir, 'alert-subscription.json')

const app = express()
const PORT = Number(process.env.ALERTS_API_PORT ?? '3847')

app.use(
  cors({
    origin: [/localhost:\d+$/, /127\.0\.0\.1:\d+$/],
    methods: ['GET', 'PUT', 'OPTIONS'],
  })
)
app.use(express.json({ limit: '512kb' }))

app.get('/api/alerts/config', async (_req, res) => {
  try {
    const raw = await fs.readFile(configPath, 'utf8')
    const j = JSON.parse(raw)
    res.json({
      email: typeof j.email === 'string' ? j.email : '',
      markets: Array.isArray(j.markets) ? j.markets : [],
      updatedAt: j.updatedAt,
    })
  } catch {
    res.json({ email: '', markets: [], updatedAt: undefined })
  }
})

app.put('/api/alerts/config', async (req, res) => {
  const { email, markets } = req.body ?? {}
  if (typeof email !== 'string' || !email.trim()) {
    return res.status(400).json({ error: 'A valid email address is required.' })
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    return res.status(400).json({ error: 'Invalid email format.' })
  }
  if (!Array.isArray(markets)) {
    return res.status(400).json({ error: 'markets must be an array.' })
  }
  const cleaned = []
  for (const m of markets) {
    if (!m || typeof m.conditionId !== 'string' || !m.conditionId.trim()) continue
    cleaned.push({
      conditionId: m.conditionId.trim(),
      question: typeof m.question === 'string' ? m.question : '',
      slug: typeof m.slug === 'string' ? m.slug : '',
      eventTitle: typeof m.eventTitle === 'string' ? m.eventTitle : '',
      outcomes: typeof m.outcomes === 'string' ? m.outcomes : '[]',
    })
  }
  const payload = {
    email: email.trim(),
    markets: cleaned,
    updatedAt: new Date().toISOString(),
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true })
  await fs.writeFile(configPath, JSON.stringify(payload, null, 2), 'utf8')
  res.json({ ok: true, ...payload })
})

app.listen(PORT, () => {
  console.log(`[alerts-api] http://127.0.0.1:${PORT}  config → ${configPath}`)
})
