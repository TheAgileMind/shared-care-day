import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { createHmac } from 'node:crypto'
import { createApp, readSession, resolveDataDir, shiftDateKey, isPersistentStorage } from './index.ts'
import { tallyDay } from '../src/lib/dayStats.ts'
import type { CareEvent } from '../src/lib/types.ts'
import { EXAMPLE_CONFIG, allowedEmails, profileFromConfig } from '../src/lib/config.ts'

const ALLOWED = allowedEmails(EXAMPLE_CONFIG)

const PIN = 'test-family-pin'
const SECRET = 'test-session-secret-at-least-32-chars'
const ALEX = 'alex@example.com'
const RILEY = 'riley@example.com'
const CASEY = 'casey@example.com'
const TAYLOR = 'taylor@example.com'
const MORGAN = 'morgan@example.com'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'shared-care-day-test-'))
}

function app(dataDir: string) {
  return createApp({ dataDir, familyPin: PIN, sessionSecret: SECRET, isProd: false, config: EXAMPLE_CONFIG })
}

async function listen(dataDir: string) {
  const server = app(dataDir).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve())),
  }
}

function cookieFrom(res: Response) {
  const raw = res.headers.getSetCookie?.() || []
  const line = raw.find((c) => c.startsWith('care_session='))
  assert.ok(line, 'expected session cookie')
  return line.split(';')[0]
}

async function login(url: string, email = ALEX, pin = PIN) {
  const res = await fetch(url + '/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, pin }),
  })
  return res
}

test('tallyDay counts naps (true-wake), feeds, and poops', () => {
  const events: CareEvent[] = [
    { id: '1', type: 'nap_start', at: '2026-08-14T17:00:00.000Z', by: 'Alex' },
    { id: '2', type: 'nap_end', at: '2026-08-14T18:10:00.000Z', by: 'Alex', meta: { trueWake: '2026-08-14T18:00:00.000Z' } },
    { id: '3', type: 'feed', at: '2026-08-14T18:05:00.000Z', by: 'Jordan' },
    { id: '4', type: 'diaper', at: '2026-08-14T18:15:00.000Z', by: 'Alex' },
  ]
  const t = tallyDay(events)
  assert.equal(t.sleepMin, 60)
  assert.equal(t.napCount, 1)
  assert.equal(t.feedCount, 1)
  assert.equal(t.poopCount, 1)
})

test('shiftDateKey moves a calendar day', () => {
  assert.equal(shiftDateKey('2026-08-15', -1), '2026-08-14')
  assert.equal(shiftDateKey('2026-08-01', -1), '2026-07-31')
})

test('resolveDataDir honors DATA_DIR first', () => {
  assert.equal(resolveDataDir({ DATA_DIR: '/custom/volume' }, '/tmp/root'), '/custom/volume')
})

test('resolveDataDir uses the Railway volume when DATA_DIR is unset', () => {
  assert.equal(resolveDataDir({ RAILWAY_VOLUME_MOUNT_PATH: '/data' }, '/tmp/root'), '/data')
})

test('isPersistentStorage is true only with a Railway volume', () => {
  assert.equal(isPersistentStorage('/data', {}), false)
  assert.equal(isPersistentStorage('/data', { RAILWAY_VOLUME_MOUNT_PATH: '/data' }), true)
  assert.equal(isPersistentStorage('/app/data', { RAILWAY_VOLUME_MOUNT_PATH: '/data' }), false)
})

test('production health reports missing volume', async () => {
  const dir = tmpDir()
  const server = createApp({ dataDir: dir, familyPin: PIN, sessionSecret: SECRET, isProd: true }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  const url = `http://127.0.0.1:${port}`
  try {
    const body = await (await fetch(url + '/api/health')).json() as { persistentStorage?: boolean }
    assert.equal(body.persistentStorage, false)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('restore fills an empty day and will not overwrite a live log', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const cookie = cookieFrom(await login(url))
    const health = await (await fetch(url + '/api/health')).json() as { date: string }
    const restore = await fetch(url + '/api/restore', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        day: {
          date: health.date,
          events: [{ id: 'e1', type: 'wake', at: '2026-08-20T15:00:00.000Z', by: 'Alex' }],
        },
      }),
    })
    assert.equal(restore.status, 200)
    const restored = await restore.json() as { restored: number; day: { events: { id: string }[] } }
    assert.equal(restored.restored, 1)
    assert.equal(restored.day.events[0].id, 'e1')

    const again = await fetch(url + '/api/restore', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({
        day: {
          date: health.date,
          events: [{ id: 'e2', type: 'feed', at: '2026-08-20T16:00:00.000Z', by: 'Jordan' }],
        },
      }),
    })
    const againBody = await again.json() as { restored: number; day: { events: { id: string }[] } }
    assert.equal(againBody.restored, 0)
    assert.equal(againBody.day.events[0].id, 'e1')
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('unauthenticated GET /api/day is rejected', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const res = await fetch(url + '/api/day')
    assert.equal(res.status, 401)
    const body = await res.json() as { error: string }
    assert.match(body.error, /sign in/i)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('healthcheck does not leak data paths', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const res = await fetch(url + '/api/health')
    assert.equal(res.status, 200)
    const body = await res.json() as Record<string, unknown>
    assert.equal(body.ok, true)
    assert.equal(body.dataDir, undefined)
    assert.ok(!JSON.stringify(body).includes(dir))
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('login requires allowlisted email and PIN, then sets a session', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const stranger = await login(url, 'stranger@example.com', PIN)
    assert.equal(stranger.status, 403)

    const badPin = await login(url, ALEX, 'nope')
    assert.equal(badPin.status, 401)

    const ok = await login(url)
    assert.equal(ok.status, 200)
    const cookie = cookieFrom(ok)
    const token = decodeURIComponent(cookie.split('=')[1])
    const session = readSession(token, SECRET, ALLOWED)
    assert.ok(session)
    assert.equal(session.email, ALEX)
    assert.equal(session.name, 'Alex')

    const day = await fetch(url + '/api/day', { headers: { Cookie: cookie } })
    assert.equal(day.status, 200)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Taylor signs in as a distinct caregiver without changing Riley attribution', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const { date } = await (await fetch(url + '/api/health')).json() as { date: string }
    const previous: CareEvent = {
      id: 'synthetic-riley-event', type: 'note', at: new Date().toISOString(),
      by: 'Riley', meta: { note: 'Synthetic caregiver handoff' },
    }
    fs.writeFileSync(path.join(dir, 'day.json'), JSON.stringify({ date, events: [previous] }))
    const yesterday = shiftDateKey(date, -1)
    const archive = JSON.stringify({ date: yesterday, events: [{ ...previous, id: 'synthetic-archive' }] })
    const archiveFile = path.join(dir, `day-${yesterday}.json`)
    fs.writeFileSync(archiveFile, archive)

    assert.equal((await login(url, TAYLOR, 'wrong-test-pin')).status, 401)
    const signedIn = await login(url, `  ${TAYLOR.toUpperCase()}  `)
    assert.equal(signedIn.status, 200)
    const cookie = cookieFrom(signedIn)
    const cookieHeader = signedIn.headers.get('set-cookie') || ''
    assert.match(cookieHeader, /HttpOnly/)
    assert.match(cookieHeader, /SameSite=Lax/)
    const session = readSession(decodeURIComponent(cookie.split('=')[1]), SECRET, ALLOWED)
    assert.ok(session)
    assert.equal(session.email, TAYLOR)
    assert.equal(session.name, 'Taylor')
    assert.equal(session.parentId, 'taylor')

    const me = await fetch(url + '/api/me', { headers: { Cookie: cookie } })
    assert.equal(me.status, 200)
    assert.deepEqual(await me.json(), {
      ok: true, email: TAYLOR, name: 'Taylor', parentId: 'taylor', persistentStorage: true,
    })
    const posted = await fetch(url + '/api/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'note', by: 'Riley', meta: { note: 'Synthetic new caregiver event' } }),
    })
    assert.equal(posted.status, 200)
    const after = await posted.json() as { event: CareEvent; day: { events: CareEvent[] } }
    assert.equal(after.event.by, 'Taylor')
    assert.deepEqual(after.day.events.find((event) => event.id === previous.id), previous)
    assert.equal(after.day.events.length, 2)
    const history = await fetch(url + '/api/history/' + yesterday, { headers: { Cookie: cookie } })
    assert.equal(history.status, 200)
    assert.deepEqual(await history.json(), JSON.parse(archive))
    assert.equal(fs.readFileSync(archiveFile, 'utf8'), archive)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Morgan signs in with the shared PIN as her own caregiver identity', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const signedIn = await login(url, `  ${MORGAN.toUpperCase()}  `)
    assert.equal(signedIn.status, 200)
    const cookie = cookieFrom(signedIn)
    const session = readSession(decodeURIComponent(cookie.split('=')[1]), SECRET, ALLOWED)
    assert.ok(session)
    assert.equal(session.email, MORGAN)
    assert.equal(session.name, 'Morgan')
    assert.equal(session.parentId, 'morgan')

    const me = await fetch(url + '/api/me', { headers: { Cookie: cookie } })
    assert.equal(me.status, 200)
    assert.deepEqual(await me.json(), {
      ok: true, email: MORGAN, name: 'Morgan', parentId: 'morgan', persistentStorage: true,
    })

    const posted = await fetch(url + '/api/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'note', by: 'Someone else', meta: { note: 'Synthetic Morgan login' } }),
    })
    assert.equal(posted.status, 200)
    const body = await posted.json() as { event: CareEvent }
    assert.equal(body.event.by, 'Morgan')
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('existing caregiver identities remain available and unlisted emails are rejected', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    for (const [email, parentId, name] of [
      [ALEX, 'alex', 'Alex'], ['jordan@example.com', 'jordan', 'Jordan'],
      [CASEY, 'casey', 'Casey'],
    ]) {
      const signedIn = await login(url, ` ${email.toUpperCase()} `)
      assert.equal(signedIn.status, 200)
      const body = await signedIn.json() as { email: string; parentId: string; name: string }
      assert.equal(body.email, email)
      assert.equal(body.parentId, parentId)
      assert.equal(body.name, name)
      assert.ok(readSession(decodeURIComponent(cookieFrom(signedIn).split('=')[1]), SECRET, ALLOWED))
    }
    for (const email of ['stranger@example.test', 'taylor+other@example.com', 'taylor@example.com.example.test']) {
      const rejected = await login(url, email)
      assert.equal(rejected.status, 403)
      assert.equal(rejected.headers.get('set-cookie'), null)
    }
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Riley cannot sign in and a previously valid signed session loses protected API access', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    for (const email of [RILEY, ` ${RILEY.toUpperCase()} `]) {
      const denied = await login(url, email)
      assert.equal(denied.status, 403)
      assert.equal(denied.headers.get('set-cookie'), null)
    }
    // Reproduce an unexpired cookie issued before removal, using only the test secret.
    const payload = Buffer.from(JSON.stringify({
      email: RILEY, name: 'Riley', parentId: 'riley', exp: Date.now() + 60_000,
    })).toString('base64url')
    const token = `${payload}.${createHmac('sha256', SECRET).update(payload).digest('base64url')}`
    assert.equal(readSession(token, SECRET, ALLOWED), null)
    const cookie = `care_session=${encodeURIComponent(token)}`
    for (const [method, route] of [
      ['GET', '/api/me'], ['GET', '/api/day'], ['GET', '/api/history'],
      ['GET', '/api/history/2026-01-01'], ['GET', '/api/profile'],
      ['POST', '/api/event'], ['PATCH', '/api/event/synthetic-id'],
      ['DELETE', '/api/event/synthetic-id'], ['PUT', '/api/profile'], ['PUT', '/api/restore'],
    ]) {
      const denied = await fetch(url + route, { method, headers: { Cookie: cookie } })
      assert.equal(denied.status, 401, `${method} ${route}`)
    }
    assert.deepEqual(fs.readdirSync(dir), [])
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('event writes use the session, not a raw email', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const open = await fetch(url + '/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: ALEX, type: 'wake' }),
    })
    assert.equal(open.status, 401)

    const cookie = cookieFrom(await login(url))
    const posted = await fetch(url + '/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'feed', meta: { side: 'L' } }),
    })
    assert.equal(posted.status, 200)
    const body = await posted.json() as { event: { by: string; type: string }; day: { events: unknown[] } }
    assert.equal(body.event.by, 'Alex')
    assert.equal(body.event.type, 'feed')
    assert.equal(body.day.events.length, 1)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('feed events persist ounces, duration, and probiotic', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const cookie = cookieFrom(await login(url))
    const posted = await fetch(url + '/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'feed', meta: { side: 'bottle', ounces: 2.5, probiotic: true } }),
    })
    assert.equal(posted.status, 200)
    const body = await posted.json() as { event: { meta?: { side?: string; ounces?: number; probiotic?: boolean } } }
    assert.equal(body.event.meta?.side, 'bottle')
    assert.equal(body.event.meta?.ounces, 2.5)
    assert.equal(body.event.meta?.probiotic, true)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('poop events can be logged, edited, and deleted', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const cookie = cookieFrom(await login(url))
    const posted = await fetch(url + '/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'diaper', at: '2026-08-14T18:15:00.000Z' }),
    })
    assert.equal(posted.status, 200)
    const created = await posted.json() as { event: { id: string; type: string; at: string; by: string } }
    assert.equal(created.event.type, 'diaper')
    assert.equal(created.event.by, 'Alex')

    const patched = await fetch(url + '/api/event/' + created.event.id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ at: '2026-08-14T18:20:00.000Z' }),
    })
    assert.equal(patched.status, 200)
    const changed = await patched.json() as { day: { events: { id: string; type: string; at: string }[] } }
    assert.deepEqual(changed.day.events, [{
      id: created.event.id,
      type: 'diaper',
      at: '2026-08-14T18:20:00.000Z',
      by: 'Alex',
    }])

    const removed = await fetch(url + '/api/event/' + created.event.id, {
      method: 'DELETE', headers: { Cookie: cookie },
    })
    assert.equal(removed.status, 200)
    const deleted = await removed.json() as { day: { events: unknown[] } }
    assert.equal(deleted.day.events.length, 0)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('history and dated day require a session', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    assert.equal((await fetch(url + '/api/history')).status, 401)
    assert.equal((await fetch(url + '/api/history/2026-08-14')).status, 401)
    const cookie = cookieFrom(await login(url))
    const hist = await fetch(url + '/api/history', { headers: { Cookie: cookie } })
    assert.equal(hist.status, 200)
    const body = await hist.json() as { days: { date: string; poopCount: number }[]; yesterday: { date: string } }
    assert.equal(body.days.length, 7)
    assert.ok(body.days.every((day) => day.poopCount === 0))
    assert.ok(body.yesterday.date)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('sign-out clears the session cookie', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const cookie = cookieFrom(await login(url))
    const out = await fetch(url + '/api/logout', { method: 'POST', headers: { Cookie: cookie } })
    assert.equal(out.status, 200)
    const cleared = (out.headers.getSetCookie?.() || []).find((c) => c.startsWith('care_session='))
    assert.ok(cleared)
    assert.match(cleared, /Max-Age=0/)
    assert.equal((await fetch(url + '/api/day')).status, 401)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Household-zone rollover archives yesterday and sets previousDaySleepMin', async () => {
  const dir = tmpDir()
  const yesterday = shiftDateKey(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: EXAMPLE_CONFIG.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date()),
    -1
  )
  const older = shiftDateKey(yesterday, -1)
  const yDay = {
    date: yesterday,
    events: [
      { id: 'n1', type: 'nap_start', at: '2026-08-14T17:00:00.000Z', by: 'Alex' },
      { id: 'n2', type: 'nap_end', at: '2026-08-14T18:30:00.000Z', by: 'Jordan' },
      { id: 'f1', type: 'feed', at: '2026-08-14T18:35:00.000Z', by: 'Jordan' },
      { id: 'd1', type: 'diaper', at: '2026-08-14T18:40:00.000Z', by: 'Alex' },
    ],
    updatedAt: '2026-08-14T20:00:00.000Z',
  }
  fs.writeFileSync(path.join(dir, 'day.json'), JSON.stringify(yDay, null, 2))
  fs.writeFileSync(path.join(dir, `day-${older}.json`), JSON.stringify({
    date: older,
    events: [{ id: 'f0', type: 'feed', at: '2026-08-13T18:00:00.000Z', by: 'Jordan' }],
    updatedAt: '2026-08-13T18:00:00.000Z',
  }, null, 2))

  const { url, close } = await listen(dir)
  try {
    const cookie = cookieFrom(await login(url))
    const res = await fetch(url + '/api/day', { headers: { Cookie: cookie } })
    assert.equal(res.status, 200)
    const today = await res.json() as { date: string; events: unknown[]; previousDaySleepMin?: number }
    assert.equal(today.events.length, 0)
    assert.equal(today.previousDaySleepMin, 90)
    assert.ok(fs.existsSync(path.join(dir, `day-${yesterday}.json`)))
    const archived = JSON.parse(fs.readFileSync(path.join(dir, `day-${yesterday}.json`), 'utf8'))
    assert.equal(archived.events.length, 4)

    const hist = await (await fetch(url + '/api/history', { headers: { Cookie: cookie } })).json() as {
      yesterday: { date: string; summary: { sleepMin: number; napCount: number; feedCount: number; poopCount: number; hasData: boolean } }
      days: { date: string; poopCount: number; hasData: boolean }[]
    }
    assert.equal(hist.yesterday.date, yesterday)
    assert.equal(hist.yesterday.summary.hasData, true)
    assert.equal(hist.yesterday.summary.sleepMin, 90)
    assert.equal(hist.yesterday.summary.napCount, 1)
    assert.equal(hist.yesterday.summary.feedCount, 1)
    assert.equal(hist.yesterday.summary.poopCount, 1)
    assert.equal(hist.days.find((day) => day.date === older)?.poopCount, 0)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('production createApp fails closed without SESSION_SECRET or FAMILY_PIN', () => {
  assert.throws(
    () => createApp({ dataDir: tmpDir(), familyPin: PIN, sessionSecret: '', isProd: true }),
    /SESSION_SECRET/
  )
  assert.throws(
    () => createApp({ dataDir: tmpDir(), familyPin: '', sessionSecret: SECRET, isProd: true }),
    /FAMILY_PIN/
  )
})

test('Casey signs in with the family PIN and events retain her identity', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    assert.equal((await login(url, CASEY, 'wrong-pin')).status, 401)
    const signedIn = await login(url, `  ${CASEY.toUpperCase()}  `)
    assert.equal(signedIn.status, 200)
    const cookie = cookieFrom(signedIn)
    const me = await (await fetch(url + '/api/me', { headers: { Cookie: cookie } })).json() as { parentId: string; name: string }
    assert.equal(me.parentId, 'casey')
    assert.equal(me.name, 'Casey')
    const posted = await fetch(url + '/api/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'diaper', by: 'someone else' }),
    })
    const body = await posted.json() as { event: { by: string } }
    assert.equal(posted.status, 200)
    assert.equal(body.event.by, 'Casey')
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

const profileToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: EXAMPLE_CONFIG.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date())
const [profileYear, profileMonth] = profileToday.split('-').map(Number)
// Stay in the supported 9-month / 2-nap band regardless of when this suite runs.
const fictionalBirthDate = new Date(Date.UTC(profileYear, profileMonth - 1 - 9, 1)).toISOString().slice(0, 10)
const fictionalProfile = {
  name: 'Sam', dateOfBirth: fictionalBirthDate, ageBasis: 'actual',
  timezone: EXAMPLE_CONFIG.timezone, morningTarget: '08:00', bedtimeTarget: '19:30', napPattern: 2,
}

test('shared profile is authenticated, private and persists separately from day logs', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    for (const method of ['GET', 'PUT']) {
      const res = await fetch(url + '/api/profile', { method })
      assert.equal(res.status, 401)
      assert.equal(res.headers.get('cache-control'), 'no-store')
    }
    const cookie = cookieFrom(await login(url))
    const empty = await fetch(url + '/api/profile', { headers: { Cookie: cookie } })
    assert.equal(empty.status, 200)
    assert.deepEqual(await empty.json(), profileFromConfig(EXAMPLE_CONFIG))
    assert.equal(fs.existsSync(path.join(dir, 'day.json')), false)
    const posted = await fetch(url + '/api/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ type: 'wake' }),
    })
    assert.equal(posted.status, 200)
    const before = fs.readFileSync(path.join(dir, 'day.json'), 'utf8')
    const saved = await fetch(url + '/api/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ...fictionalProfile, unexpected: 'do not persist' }),
    })
    assert.equal(saved.status, 200)
    assert.equal(saved.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await saved.json(), fictionalProfile)
    assert.equal(fs.readFileSync(path.join(dir, 'day.json'), 'utf8'), before)
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'profile.json'), 'utf8')), fictionalProfile)
    const caregiver = cookieFrom(await login(url, TAYLOR))
    assert.deepEqual(await (await fetch(url + '/api/profile', { headers: { Cookie: caregiver } })).json(), fictionalProfile)
    const second = await listen(dir)
    try {
      const otherCookie = cookieFrom(await login(second.url))
      assert.deepEqual(await (await fetch(second.url + '/api/profile', { headers: { Cookie: otherCookie } })).json(), fictionalProfile)
    } finally { await second.close() }
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('profile rejects invalid changes without replacing saved settings', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const cookie = cookieFrom(await login(url))
    const put = (value: unknown) => fetch(url + '/api/profile', {
      method: 'PUT', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(value),
    })
    assert.equal((await put(fictionalProfile)).status, 200)
    for (const patch of [{ dateOfBirth: '2026-02-30' }, { dateOfBirth: '2999-01-01' }, { ageBasis: 'adjusted' }, { morningTarget: '25:00' }, { napPattern: 1 }]) {
      assert.equal((await put({ ...fictionalProfile, ...patch })).status, 400)
    }
    assert.deepEqual(await (await fetch(url + '/api/profile', { headers: { Cookie: cookie } })).json(), fictionalProfile)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('security headers are set and CSP/HSTS are production-only', async () => {
  const dir = tmpDir()
  const dev = await listen(dir)
  try {
    const res = await fetch(dev.url + '/api/health')
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(res.headers.get('x-frame-options'), 'DENY')
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('x-powered-by'), null)
    assert.equal(res.headers.get('content-security-policy'), null)
  } finally { await dev.close() }
  const server = createApp({ dataDir: dir, familyPin: PIN, sessionSecret: SECRET, isProd: true, config: EXAMPLE_CONFIG }).listen(0, '127.0.0.1')
  await new Promise<void>((resolve) => server.once('listening', () => resolve()))
  try {
    const addr = server.address()
    const port = typeof addr === 'object' && addr ? addr.port : 0
    const res = await fetch(`http://127.0.0.1:${port}/api/health`)
    assert.match(res.headers.get('content-security-policy') || '', /frame-ancestors 'none'/)
    assert.match(res.headers.get('strict-transport-security') || '', /max-age=/)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('CORS does not reflect arbitrary origins by default', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const res = await fetch(url + '/api/health', { headers: { Origin: 'https://evil.example' } })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
    assert.equal(res.headers.get('access-control-allow-credentials'), null)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('wrong PIN gets 401 for any email, so the allowlist cannot be probed without the PIN', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    assert.equal((await login(url, 'stranger@example.com', 'nope')).status, 401)
    assert.equal((await login(url, ALEX, 'nope')).status, 401)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('login attempts are rate limited per email', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const statuses: number[] = []
    for (let i = 0; i < 9; i++) statuses.push((await login(url, ALEX, 'nope')).status)
    assert.deepEqual(statuses.slice(0, 8), Array(8).fill(401))
    assert.equal(statuses[8], 429)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('event writes reject unknown types, bad times, and oversized details', async () => {
  const dir = tmpDir()
  const { url, close } = await listen(dir)
  try {
    const cookie = cookieFrom(await login(url))
    const post = (body: unknown) => fetch(url + '/api/event', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body),
    })
    assert.equal((await post({ type: '<script>' })).status, 400)
    assert.equal((await post({ type: 'feed', at: 'not-a-time' })).status, 400)
    assert.equal((await post({ type: 'note', meta: { note: 'x'.repeat(3000) } })).status, 400)
    assert.equal((await post({ type: 'note', meta: ['array'] })).status, 400)
    const ok = await post({ type: 'note', at: '2026-08-16T21:38:00Z', meta: { note: 'fine' } })
    assert.equal(ok.status, 200)
    const body = await ok.json() as { event: { id: string; at: string } }
    assert.equal(body.event.at, '2026-08-16T21:38:00.000Z')
    const patched = await fetch(url + '/api/event/' + body.event.id, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify({ type: 'bogus' }),
    })
    assert.equal(patched.status, 400)
  } finally { await close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('shiftDateKey is pure calendar math, independent of timezone', () => {
  assert.equal(shiftDateKey('2026-03-08', 1), '2026-03-09')
  assert.equal(shiftDateKey('2026-11-01', -1), '2026-10-31')
  assert.equal(shiftDateKey('2026-01-01', -1), '2025-12-31')
})
