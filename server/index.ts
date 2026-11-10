import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { tallyDay } from '../src/lib/dayStats.ts'
import { type BabyProfile, type CareEvent, type DayState, type HistoryResponse, type DaySummary, type ParentId } from '../src/lib/types.ts'
import { validateProfile } from '../src/lib/schedule/profile.ts'
import { allowedEmails, caregiverFromEmail, profileFromConfig, type AppConfig } from '../src/lib/config.ts'
import { loadConfig } from './loadConfig.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(__dirname, '..')
const DIST = path.join(ROOT, 'dist')
const isProd = process.env.NODE_ENV === 'production'
const COOKIE = 'care_session'
const SESSION_MS = 30 * 24 * 60 * 60 * 1000
const VOLUME_CANDIDATES = ['/data', '/app/data']

type SessionInfo = { email: string; name: string; parentId: ParentId; exp: number }
type AuthedRequest = Request & { parent?: SessionInfo }

export type AppOptions = {
  dataDir?: string
  familyPin?: string
  sessionSecret?: string
  isProd?: boolean
  config?: AppConfig
  /** Comma-separated origins allowed for cross-origin API calls. Unset = same-origin only. */
  corsOrigins?: string
  /** Express "trust proxy" value. Defaults to 1 in production (one platform proxy), off locally. */
  trustProxy?: boolean | number | string
}

const EVENT_TYPES = new Set(['wake', 'feed', 'nap_start', 'nap_end', 'tummy', 'diaper', 'note', 'bedtime'])
const MAX_EVENTS_PER_DAY = 500
const MAX_META_BYTES = 2048

function validAt(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 40) return null
  const t = Date.parse(value)
  if (Number.isNaN(t)) return null
  return new Date(t).toISOString()
}

function validMeta(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value !== 'object' || Array.isArray(value)) return false
  return JSON.stringify(value).length <= MAX_META_BYTES
}

/** Baseline security headers without an extra dependency. CSP applies to the built app in production. */
function securityHeaders(prod: boolean) {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data:",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
  return (_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Referrer-Policy', 'no-referrer')
    res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()')
    if (prod) {
      res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains')
      res.setHeader('Content-Security-Policy', csp)
    }
    next()
  }
}

function todayKey(d = new Date(), timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC') {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

export function shiftDateKey(dateKey: string, days: number) {
  // Pure calendar arithmetic in UTC, so it is correct for any configured timezone.
  const utc = new Date(`${dateKey}T12:00:00.000Z`)
  utc.setUTCDate(utc.getUTCDate() + days)
  return utc.toISOString().slice(0, 10)
}

function dirHasDayData(dir: string) {
  try {
    if (!fs.existsSync(dir)) return false
    if (fs.existsSync(path.join(dir, 'day.json'))) return true
    return fs.readdirSync(dir).some((f) => /^day-\d{4}-\d{2}-\d{2}\.json$/.test(f))
  } catch {
    return false
  }
}

/** DATA_DIR always wins. Else the Railway volume. Else a volume that already has days, then /data, then /app/data. */
export function resolveDataDir(env: NodeJS.ProcessEnv = process.env, root = ROOT) {
  if (env.DATA_DIR) return env.DATA_DIR
  if (env.RAILWAY_VOLUME_MOUNT_PATH) return env.RAILWAY_VOLUME_MOUNT_PATH
  const local = path.join(root, 'data')
  const withData = [...VOLUME_CANDIDATES, local].find(dirHasDayData)
  if (withData) return withData
  for (const candidate of VOLUME_CANDIDATES) {
    if (fs.existsSync(candidate)) return candidate
  }
  return local
}

/** True only when Railway has actually mounted a volume at the data dir. */
export function isPersistentStorage(dataDir: string, env: NodeJS.ProcessEnv = process.env) {
  const vol = (env.RAILWAY_VOLUME_MOUNT_PATH || '').replace(/\/$/, '')
  if (!vol) return false
  const dir = dataDir.replace(/\/$/, '')
  return dir === vol || dir.startsWith(vol + '/')
}

function familyPinFromEnv() {
  return process.env.FAMILY_PIN || process.env.FAMILY_PASSWORD || ''
}

function pinsEqual(provided: string, expected: string) {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function parseCookies(req: Request) {
  const out: Record<string, string> = {}
  const raw = req.headers.cookie
  if (!raw) return out
  for (const part of raw.split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    try { out[k] = decodeURIComponent(v) } catch { out[k] = v }
  }
  return out
}

function signSession(info: Omit<SessionInfo, 'exp'>, secret: string) {
  const payload: SessionInfo = { ...info, exp: Date.now() + SESSION_MS }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  const sig = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${sig}`
}

export function readSession(token: string, secret: string, allowed?: Iterable<string>): SessionInfo | null {
  const [body, sig] = token.split('.')
  if (!body || !sig || !secret) return null
  const expected = createHmac('sha256', secret).update(body).digest('base64url')
  const sigBuf = Buffer.from(sig)
  const expBuf = Buffer.from(expected)
  if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as SessionInfo
    const allow = allowed ? new Set([...allowed].map((e) => e.toLowerCase())) : null
    if (!payload?.email || (allow && !allow.has(payload.email)) || typeof payload.exp !== 'number' || payload.exp < Date.now()) {
      return null
    }
    return payload
  } catch {
    return null
  }
}

function cookieHeader(token: string, prod: boolean, clear = false) {
  const parts = [
    `${COOKIE}=${clear ? '' : encodeURIComponent(token)}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    clear ? 'Max-Age=0' : `Max-Age=${Math.floor(SESSION_MS / 1000)}`,
  ]
  if (prod) parts.push('Secure')
  return parts.join('; ')
}

function archivePath(dataDir: string, date: string) {
  return path.join(dataDir, `day-${date}.json`)
}

function readJsonDay(file: string): DayState | null {
  try {
    if (!fs.existsSync(file)) return null
    return JSON.parse(fs.readFileSync(file, 'utf8')) as DayState
  } catch (e) {
    console.error('read day failed')
    return null
  }
}

export function createApp(opts: AppOptions = {}) {
  const prod = opts.isProd ?? isProd
  const config = opts.config ?? loadConfig()
  const allowlist = new Set(allowedEmails(config))
  const defaultProfile = profileFromConfig(config)
  const DATA_DIR = opts.dataDir || resolveDataDir()
  const configuredPin = opts.familyPin ?? familyPinFromEnv()
  if (prod && !configuredPin) throw new Error('FAMILY_PIN must be set in production')
  let sessionSecret = opts.sessionSecret ?? process.env.SESSION_SECRET ?? ''
  if (!sessionSecret) {
    if (prod) throw new Error('SESSION_SECRET must be set in production')
    sessionSecret = randomBytes(32).toString('hex')
    console.log('SESSION_SECRET is unset; using an ephemeral secret for local dev')
  }

  const DAY_FILE = path.join(DATA_DIR, 'day.json')
  const PROFILE_FILE = path.join(DATA_DIR, 'profile.json')
  const persistentStorage = !prod || isPersistentStorage(DATA_DIR)

  function ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
  }

  function readArchive(date: string): DayState | null {
    return readJsonDay(archivePath(DATA_DIR, date))
  }

  function backfillPreviousSleep(day: DayState): DayState {
    if (typeof day.previousDaySleepMin === 'number') return day
    const prev = readArchive(shiftDateKey(day.date, -1))
    if (!prev?.events?.length) return day
    day.previousDaySleepMin = tallyDay(prev.events).sleepMin
    return day
  }

  function loadDay(): DayState {
    const date = todayKey(new Date(), config.timezone)
    try {
      if (fs.existsSync(DAY_FILE)) {
        const raw = readJsonDay(DAY_FILE)
        if (raw && raw.date === date) return backfillPreviousSleep(raw)
        if (raw) {
          ensureDataDir()
          if (raw.events?.length || raw.previousDaySleepMin != null) {
            fs.writeFileSync(archivePath(DATA_DIR, raw.date), JSON.stringify(raw, null, 2))
          }
          const previousDaySleepMin = raw.events?.length ? tallyDay(raw.events).sleepMin : undefined
          return { date, events: [], previousDaySleepMin, updatedAt: new Date().toISOString() }
        }
      }
    } catch (e) {
      console.error('loadDay error')
    }
    return { date, events: [], updatedAt: new Date().toISOString() }
  }

  function saveDay(day: DayState) {
    ensureDataDir()
    day.updatedAt = new Date().toISOString()
    fs.writeFileSync(DAY_FILE, JSON.stringify(day, null, 2))
  }

  function loadDated(date: string): DayState | null {
    if (date === todayKey(new Date(), config.timezone)) return loadDay()
    return readArchive(date)
  }

  function summarize(date: string): DaySummary {
    const day = loadDated(date)
    if (!day) return { date, sleepMin: 0, feedCount: 0, napCount: 0, poopCount: 0, eventCount: 0, hasData: false }
    const t = tallyDay(day.events)
    return { date, ...t, hasData: true }
  }

  // In-memory limiter: per client IP and per email, 8 attempts per 10 minutes.
  // Fine for a single small instance; use a shared store if you scale out.
  const loginAttempts = new Map<string, { n: number; reset: number }>()
  const WINDOW_MS = 10 * 60 * 1000
  const MAX_ATTEMPTS = 8

  function bump(key: string, now: number) {
    const row = loginAttempts.get(key)
    if (!row || now > row.reset) {
      loginAttempts.set(key, { n: 1, reset: now + WINDOW_MS })
      return 1
    }
    return ++row.n
  }

  function tooManyAttempts(ip: string, email: string) {
    const now = Date.now()
    if (loginAttempts.size > 10_000) {
      for (const [k, row] of loginAttempts) if (now > row.reset) loginAttempts.delete(k)
    }
    const byIp = bump(`ip:${ip}`, now)
    const byEmail = email ? bump(`email:${email}`, now) : 0
    return byIp > MAX_ATTEMPTS || byEmail > MAX_ATTEMPTS
  }

  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', opts.trustProxy ?? process.env.TRUST_PROXY ?? (prod ? 1 : false))
  app.use(securityHeaders(prod))
  const corsOrigins = (opts.corsOrigins ?? process.env.CORS_ORIGINS ?? '')
    .split(',').map((o) => o.trim()).filter(Boolean)
  if (corsOrigins.length) app.use('/api', cors({ origin: corsOrigins, credentials: true }))
  app.use(express.json({ limit: '32kb' }))
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    next()
  })

  function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
    const token = parseCookies(req)[COOKIE]
    const session = token ? readSession(token, sessionSecret, allowlist) : null
    if (!session) return res.status(401).json({ error: 'Sign in required' })
    req.parent = session
    next()
  }

  app.post('/api/auth', (req, res) => {
    if (!configuredPin) {
      return res.status(503).json({ error: 'Family PIN is not configured on the server.' })
    }
    const ip = req.ip || 'unknown'
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 254)
    const pin = String(req.body?.pin ?? req.body?.password ?? '').slice(0, 256)
    if (tooManyAttempts(ip, email)) {
      return res.status(429).json({ error: 'Too many attempts. Try again in a few minutes.' })
    }
    // Check the PIN first so callers without it cannot probe which emails are allowlisted.
    if (!pinsEqual(pin, configuredPin)) {
      return res.status(401).json({ error: 'Wrong PIN' })
    }
    if (!allowlist.has(email)) {
      return res.status(403).json({ error: 'This app is private to invited caregivers.' })
    }
    const caregiver = caregiverFromEmail(email, config)
    if (!caregiver) {
      return res.status(403).json({ error: 'This app is private to invited caregivers.' })
    }
    loginAttempts.delete(`ip:${ip}`)
    loginAttempts.delete(`email:${email}`)
    const { parentId, name } = caregiver
    res.setHeader('Set-Cookie', cookieHeader(signSession({ email, name, parentId }, sessionSecret), prod))
    res.json({ ok: true, email, name, parentId, persistentStorage })
  })

  app.post('/api/logout', (_req, res) => {
    res.setHeader('Set-Cookie', cookieHeader('', prod, true))
    res.json({ ok: true })
  })

  app.get('/api/me', requireAuth, (req: AuthedRequest, res) => {
    const p = req.parent!
    res.json({ ok: true, email: p.email, name: p.name, parentId: p.parentId, persistentStorage })
  })

  function profileFields(raw: BabyProfile): BabyProfile {
    return {
      name: raw.name, dateOfBirth: raw.dateOfBirth, ageBasis: raw.ageBasis,
      dueDate: raw.dueDate, napPattern: raw.napPattern,
      timezone: raw.timezone, morningTarget: raw.morningTarget, bedtimeTarget: raw.bedtimeTarget,
    }
  }

  app.get('/api/profile', requireAuth, (_req, res) => {
    try {
      const profile = fs.existsSync(PROFILE_FILE)
        ? profileFields(JSON.parse(fs.readFileSync(PROFILE_FILE, 'utf8')))
        : { ...defaultProfile }
      res.json(profile)
    } catch {
      res.status(503).json({ error: 'Profile unavailable' })
    }
  })

  app.put('/api/profile', requireAuth, (req, res) => {
    const error = validateProfile(req.body, todayKey(new Date(), config.timezone))
    if (error) return res.status(400).json({ error: 'Invalid profile' })
    const profile = profileFields(req.body)
    try {
      ensureDataDir()
      const temporary = PROFILE_FILE + '.tmp'
      fs.writeFileSync(temporary, JSON.stringify(profile, null, 2))
      fs.renameSync(temporary, PROFILE_FILE)
      res.json(profile)
    } catch {
      res.status(503).json({ error: 'Profile unavailable' })
    }
  })

  app.get('/api/day', requireAuth, (_req, res) => {
    res.json(loadDay())
  })

  app.get('/api/history', requireAuth, (_req, res) => {
    const today = todayKey(new Date(), config.timezone)
    const days: DaySummary[] = []
    for (let i = 6; i >= 0; i--) days.push(summarize(shiftDateKey(today, -i)))
    const yDate = shiftDateKey(today, -1)
    const yDay = loadDated(yDate)
    const body: HistoryResponse = {
      days,
      yesterday: yDay
        ? { date: yDate, summary: summarize(yDate), events: yDay.events || [] }
        : { date: yDate, summary: summarize(yDate), events: [] },
    }
    res.json(body)
  })

  app.get('/api/history/:date', requireAuth, (req, res) => {
    const date = String(req.params.date || '')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'Invalid date' })
    const day = loadDated(date)
    if (!day) return res.status(404).json({ error: 'No log for that day' })
    res.json(day)
  })

  app.post('/api/event', requireAuth, (req: AuthedRequest, res) => {
    const { type, at, meta } = req.body || {}
    if (!type) return res.status(400).json({ error: 'type required' })
    if (!EVENT_TYPES.has(type)) return res.status(400).json({ error: 'Invalid event type' })
    const when = at === undefined || at === null || at === '' ? new Date().toISOString() : validAt(at)
    if (!when) return res.status(400).json({ error: 'Invalid time' })
    if (!validMeta(meta)) return res.status(400).json({ error: 'Invalid details' })
    const day = loadDay()
    if (day.events.length >= MAX_EVENTS_PER_DAY) return res.status(413).json({ error: 'Too many events today' })
    const event: CareEvent = {
      id: randomUUID(), type, at: when,
      by: req.parent!.name, meta,
    }
    day.events.push(event)
    day.events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    saveDay(day)
    res.json({ ok: true, event, day })
  })

  app.patch('/api/event/:id', requireAuth, (req: AuthedRequest, res) => {
    const day = loadDay()
    const idx = day.events.findIndex((e) => e.id === req.params.id)
    if (idx < 0) return res.status(404).json({ error: 'Event not found' })
    const { at, meta, type } = req.body || {}
    if (type && !EVENT_TYPES.has(type)) return res.status(400).json({ error: 'Invalid event type' })
    const when = at ? validAt(at) : null
    if (at && !when) return res.status(400).json({ error: 'Invalid time' })
    if (!validMeta(meta)) return res.status(400).json({ error: 'Invalid details' })
    if (when) day.events[idx].at = when
    if (meta !== undefined) day.events[idx].meta = meta
    if (type) day.events[idx].type = type
    day.events.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
    saveDay(day)
    res.json({ ok: true, event: day.events[idx], day })
  })

  app.delete('/api/event/:id', requireAuth, (req, res) => {
    const day = loadDay()
    const before = day.events.length
    day.events = day.events.filter((e) => e.id !== req.params.id)
    if (day.events.length === before) return res.status(404).json({ error: 'Event not found' })
    saveDay(day)
    res.json({ ok: true, day })
  })

  function asDayState(raw: unknown): DayState | null {
    if (!raw || typeof raw !== 'object') return null
    const d = raw as DayState
    if (typeof d.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) return null
    if (!Array.isArray(d.events)) return null
    return {
      date: d.date,
      events: d.events
        .filter((e) => e && typeof e === 'object' && typeof e.id === 'string' && EVENT_TYPES.has(e.type) && !!validAt(e.at) && validMeta(e.meta))
        .slice(0, MAX_EVENTS_PER_DAY),
      previousDaySleepMin: typeof d.previousDaySleepMin === 'number' ? d.previousDaySleepMin : undefined,
      updatedAt: d.updatedAt,
    }
  }

  function restoreOne(incoming: DayState): 'restored' | 'skipped' {
    if (!incoming.events.length) return 'skipped'
    const today = todayKey(new Date(), config.timezone)
    if (incoming.date === today) {
      const current = loadDay()
      if (current.events.length > 0) return 'skipped'
      saveDay({
        date: today,
        events: incoming.events,
        previousDaySleepMin: incoming.previousDaySleepMin ?? current.previousDaySleepMin,
      })
      return 'restored'
    }
    const existing = readArchive(incoming.date)
    if (existing?.events?.length) return 'skipped'
    ensureDataDir()
    fs.writeFileSync(archivePath(DATA_DIR, incoming.date), JSON.stringify({
      date: incoming.date,
      events: incoming.events,
      previousDaySleepMin: incoming.previousDaySleepMin,
      updatedAt: incoming.updatedAt || new Date().toISOString(),
    }, null, 2))
    return 'restored'
  }

  app.put('/api/restore', requireAuth, (req, res) => {
    const incoming: DayState[] = []
    const one = asDayState(req.body?.day)
    if (one) incoming.push(one)
    if (Array.isArray(req.body?.days)) {
      for (const row of req.body.days) {
        const parsed = asDayState(row)
        if (parsed) incoming.push(parsed)
      }
    }
    if (!incoming.length) return res.status(400).json({ error: 'day required' })
    let restored = 0
    let skipped = 0
    for (const day of incoming) {
      if (restoreOne(day) === 'restored') restored++
      else skipped++
    }
    res.json({ ok: true, restored, skipped, day: loadDay() })
  })

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      time: new Date().toISOString(),
      date: todayKey(new Date(), config.timezone),
      persistentStorage,
    })
  })

  if (prod && fs.existsSync(DIST)) {
    app.get('/sw.js', (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache, max-age=0, must-revalidate')
      res.type('application/javascript').sendFile(path.join(DIST, 'sw.js'))
    })
    app.use(express.static(DIST))
    app.get('*', (_req, res) => res.sendFile(path.join(DIST, 'index.html')))
  }

  return app
}


function loadDotEnv(root = ROOT) {
  const file = path.join(root, '.env')
  if (!fs.existsSync(file)) return
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const i = trimmed.indexOf('=')
    if (i < 0) continue
    const key = trimmed.slice(0, i).trim()
    let value = trimmed.slice(i + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (!(key in process.env)) process.env[key] = value
  }
}

function isEntrypoint() {
  const invoked = process.argv[1]
  if (!invoked) return false
  try {
    return path.resolve(invoked) === fileURLToPath(import.meta.url)
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  loadDotEnv()
  if (isProd) {
    if (!familyPinFromEnv()) {
      console.error('Refusing to start: set FAMILY_PIN (or FAMILY_PASSWORD) in production')
      process.exit(1)
    }
    if (!process.env.SESSION_SECRET) {
      console.error('Refusing to start: set SESSION_SECRET in production')
      process.exit(1)
    }
  }
  const dataDir = resolveDataDir()
  const persistent = isPersistentStorage(dataDir)
  if (isProd && !persistent) {
    console.error('WARNING: no Railway volume mounted. Day logs will be erased on every deploy. Add a Volume mounted at /data.')
  }
  const app = createApp({ dataDir })
  const PORT = Number(process.env.PORT) || 3001
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`shared-care-day ${isProd ? 'PROD' : 'API'} on :${PORT}  date=${todayKey()}  storage=${persistent ? 'volume' : 'local'}`)
  })
}
