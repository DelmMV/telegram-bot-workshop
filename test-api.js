const express = require('express')
const app = express()
app.disable('x-powered-by')
app.use(express.json({ limit: '1mb' }))

app.use((req, res, next) => {
  console.log('=== REQUEST ===')
  console.log('Method:', req.method, 'URL:', req.url)
  console.log('Origin:', req.headers.origin)
  console.log('X-Telegram-Init-Data:', req.headers['x-telegram-init-data'])
  console.log('All headers:', req.headers)
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Telegram-Init-Data')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(204).end()
  next()
})

app.get('/api/health', (req, res) => res.json({ ok: true }))
app.get('/api/workshops', (req, res) => {
  console.log('=== /api/workshops handler ===')
  res.json({ ok: true, workshops: [{ name: 'Test Workshop' }] })
})

const server = app.listen(5800, () => console.log('Test API on 5800'))

setTimeout(() => {
  server.close()
  console.log('Server closed')
}, 15000)
