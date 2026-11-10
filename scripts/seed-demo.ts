/**
 * Writes a fictional demo day for screenshots: `npm run seed:demo`.
 * Uses DATA_DIR (default ./data). Refuses to overwrite a day that already has events.
 * Also seeds a week of fictional archives so the History tab has something to show.
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { loadConfig } from '../server/loadConfig.ts'
import { shiftDateKey } from '../server/index.ts'
import { zonedDate, zonedLocal } from '../src/lib/clock.ts'
import { profileFromConfig } from '../src/lib/config.ts'
import type { CareEvent, DayState } from '../src/lib/types.ts'

const config = loadConfig()
const zone = config.timezone
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const todayFile = path.join(dataDir, 'day.json')
const now = new Date()
const today = zonedDate(now, zone)
const [alex, jordan] = config.caregivers
const a = alex.name
const b = (jordan ?? alex).name

function at(date: string, hm: string) {
  return zonedLocal(date, hm, zone)
}

function ev(date: string, type: CareEvent['type'], hm: string, by: string, meta?: CareEvent['meta']): CareEvent {
  const when = at(date, hm)
  if (date === today && when.getTime() > now.getTime()) {
    throw new Error(`Refusing to seed a future event ${hm} on ${date}; run the demo after mid-afternoon in ${zone}.`)
  }
  return { id: randomUUID(), type, at: when.toISOString(), by, meta }
}

function day(date: string, events: CareEvent[]): DayState {
  return { date, events, updatedAt: now.toISOString() }
}

if (fs.existsSync(todayFile)) {
  const existing = JSON.parse(fs.readFileSync(todayFile, 'utf8')) as DayState
  if (existing.date === today && existing.events?.length) {
    console.error(`Refusing to overwrite ${todayFile}: it already has events for ${today}.`)
    process.exit(1)
  }
}

// Mid-morning through early afternoon on a 6-month, 3-nap day.
const todayEvents: CareEvent[] = [
  ev(today, 'wake', '07:52', a),
  ev(today, 'feed', '08:05', a, { side: 'both', durationMin: 18, leftMin: 10, rightMin: 8, probiotic: true }),
  ev(today, 'diaper', '09:10', b),
  ev(today, 'nap_start', '10:05', b),
  ev(today, 'nap_end', '11:00', b),
  ev(today, 'feed', '11:10', a, { side: 'bottle', ounces: 4 }),
  ev(today, 'tummy', '11:35', a, { durationMin: 10 }),
  ev(today, 'note', '11:50', b, { note: 'Demo note: happy after a walk around the block.' }),
]

function fullDay(date: string): CareEvent[] {
  return [
    ev(date, 'wake', '07:48', a),
    ev(date, 'feed', '08:00', a, { side: 'both', durationMin: 16, leftMin: 9, rightMin: 7, probiotic: true }),
    ev(date, 'diaper', '08:40', b),
    ev(date, 'nap_start', '09:35', b),
    ev(date, 'nap_end', '10:25', a),
    ev(date, 'feed', '10:35', b, { side: 'bottle', ounces: 4 }),
    ev(date, 'feed', '12:20', a, { side: 'both', durationMin: 14, leftMin: 8, rightMin: 6 }),
    ev(date, 'nap_start', '13:05', a),
    ev(date, 'nap_end', '14:20', b),
    ev(date, 'feed', '14:35', a, { side: 'bottle', ounces: 3.5 }),
    ev(date, 'diaper', '16:10', b),
    ev(date, 'nap_start', '16:40', a),
    ev(date, 'nap_end', '17:25', b),
    ev(date, 'feed', '18:05', a, { side: 'both', durationMin: 12, leftMin: 7, rightMin: 5 }),
    ev(date, 'note', '19:15', b, { note: 'Demo: early bedtime after a busy day.' }),
  ]
}

function lightDay(date: string, variant: number): CareEvent[] {
  const wake = variant % 2 === 0 ? '08:00' : '07:40'
  const byFirst = variant % 2 === 0 ? a : b
  const bySecond = variant % 2 === 0 ? b : a
  return [
    ev(date, 'wake', wake, byFirst),
    ev(date, 'feed', '08:12', byFirst, { side: 'bottle', ounces: 4, probiotic: variant !== 2 }),
    ev(date, 'nap_start', '10:00', bySecond),
    ev(date, 'nap_end', '10:50', bySecond),
    ev(date, 'feed', '11:05', byFirst, { side: 'both', durationMin: 15, leftMin: 8, rightMin: 7 }),
    ev(date, 'diaper', '12:30', bySecond),
    ev(date, 'nap_start', '13:20', byFirst),
    ev(date, 'nap_end', '14:25', bySecond),
    ev(date, 'feed', '14:40', byFirst, { side: 'bottle', ounces: 4 }),
    ev(date, 'nap_start', '16:50', bySecond),
    ev(date, 'nap_end', '17:30', byFirst),
    ev(date, 'feed', '18:15', bySecond, { side: 'both', durationMin: 12, leftMin: 6, rightMin: 6 }),
  ]
}

fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(todayFile, JSON.stringify(day(today, todayEvents), null, 2))

const yesterday = shiftDateKey(today, -1)
fs.writeFileSync(path.join(dataDir, `day-${yesterday}.json`), JSON.stringify(day(yesterday, fullDay(yesterday)), null, 2))

for (let i = 2; i <= 6; i++) {
  const date = shiftDateKey(today, -i)
  fs.writeFileSync(path.join(dataDir, `day-${date}.json`), JSON.stringify(day(date, lightDay(date, i)), null, 2))
}

const profileFile = path.join(dataDir, 'profile.json')
// 6-month demo uses a fixed 3-nap plan; the engine needs an explicit choice.
const profile = { ...profileFromConfig(config), napPattern: 3 }
fs.writeFileSync(profileFile, JSON.stringify(profile, null, 2))

console.log(`Wrote ${todayEvents.length} fictional events for ${today} to ${todayFile}`)
console.log(`Wrote fictional history for ${yesterday} through ${shiftDateKey(today, -6)} in ${dataDir}`)
