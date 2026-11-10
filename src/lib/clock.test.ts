import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyClock, defaultZone, resolveZone, zonedDate, zonedHour, zonedLocal } from './clock.ts'
import { buildDay } from './schedule/engine.ts'
import { parseCareSpeech } from './voiceParse.ts'
import { EXAMPLE_CONFIG, profileFromConfig, validateConfig } from './config.ts'
import { loadConfig } from '../../server/loadConfig.ts'

test('zonedLocal honors DST in America/New_York', () => {
  assert.equal(zonedLocal('2026-01-15', '08:00', 'America/New_York').toISOString(), '2026-01-15T13:00:00.000Z')
  assert.equal(zonedLocal('2026-07-15', '08:00', 'America/New_York').toISOString(), '2026-07-15T12:00:00.000Z')
  // Spring-forward gap: 02:30 does not exist; land just after the jump.
  assert.equal(zonedLocal('2026-03-08', '02:30', 'America/New_York').toISOString(), '2026-03-08T07:30:00.000Z')
  // Fall-back overlap resolves to a real 01:30 local time.
  const overlap = zonedLocal('2026-11-01', '01:30', 'America/New_York')
  assert.equal(zonedHour(overlap, 'America/New_York'), 1)
})

test('zonedLocal works east of UTC and in half-hour zones', () => {
  assert.equal(zonedLocal('2026-09-03', '19:30', 'Asia/Tokyo').toISOString(), '2026-09-03T10:30:00.000Z')
  assert.equal(zonedLocal('2026-09-03', '07:00', 'Asia/Kolkata').toISOString(), '2026-09-03T01:30:00.000Z')
  assert.equal(zonedLocal('2026-09-03', '12:00', 'Europe/London').toISOString(), '2026-09-03T11:00:00.000Z')
})

test('zonedDate and zonedHour use the given zone, not the host zone', () => {
  const instant = new Date('2026-09-04T02:00:00Z')
  assert.equal(zonedDate(instant, 'America/Los_Angeles'), '2026-09-03')
  assert.equal(zonedDate(instant, 'Asia/Tokyo'), '2026-09-04')
  assert.equal(zonedHour(instant, 'Asia/Tokyo'), 11)
  assert.equal(zonedHour(instant, 'America/Los_Angeles'), 19)
})

test('resolveZone falls back to the runtime Intl zone for missing or invalid zones', () => {
  assert.equal(resolveZone(undefined), defaultZone())
  assert.equal(resolveZone('Not/AZone'), defaultZone())
  assert.equal(resolveZone('Europe/Berlin'), 'Europe/Berlin')
})

test('applyClock picks today in the household zone', () => {
  const now = new Date('2026-09-03T23:30:00Z') // 08:30 next day in Tokyo, 18:30 in Chicago
  assert.equal(applyClock(now, 7, 0, 'am', 'Asia/Tokyo').toISOString(), '2026-09-03T22:00:00.000Z')
  assert.equal(applyClock(now, 5, 0, 'pm', 'America/Chicago').toISOString(), '2026-09-03T22:00:00.000Z')
})

test('voice parser resolves the same words to different instants per zone', () => {
  const now = new Date('2026-09-03T20:00:00Z') // 15:00 Chicago, 21:00 London
  const chicago = parseCareSpeech('nap started at 2:35 PM', now, 'America/Chicago')
  const london = parseCareSpeech('nap started at 2:35 PM', now, 'Europe/London')
  assert.equal(chicago[0].at.toISOString(), '2026-09-03T19:35:00.000Z')
  assert.equal(london[0].at.toISOString(), '2026-09-03T13:35:00.000Z')
})

test('schedule engine places the morning target in the profile timezone', () => {
  const base = { ...profileFromConfig(EXAMPLE_CONFIG), dateOfBirth: '2026-06-01', napPattern: 4 }
  for (const zone of ['America/Chicago', 'Asia/Tokyo', 'Europe/Berlin']) {
    const now = zonedLocal('2026-09-03', '06:00', zone)
    const state = buildDay(now, [], { ...base, timezone: zone })
    const morning = state.schedule.find((s) => s.copy?.key === 'sched.morningWake')
    assert.ok(morning, zone)
    assert.equal(new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit' }).format(morning.time), '08:00')
  }
})

test('example config uses a neutral zone, and APP_TIMEZONE overrides config', () => {
  assert.equal(EXAMPLE_CONFIG.timezone, 'America/Chicago')
  assert.equal(loadConfig({ APP_TIMEZONE: 'Europe/Berlin', CONFIG_PATH: '/nonexistent.json' }).timezone, 'Europe/Berlin')
  assert.throws(() => validateConfig({ ...EXAMPLE_CONFIG, timezone: 'Mars/Olympus' }))
})
