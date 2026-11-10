/**
 * Writes a fictional demo day for screenshots: `npm run seed:demo`.
 * Uses DATA_DIR (default ./data). Refuses to overwrite a day that already has events.
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { loadConfig } from '../server/loadConfig.ts'
import type { CareEvent, DayState } from '../src/lib/types.ts'

const config = loadConfig()
const dataDir = process.env.DATA_DIR || path.join(process.cwd(), 'data')
const file = path.join(dataDir, 'day.json')
const now = Date.now()
const ago = (min: number) => new Date(now - min * 60_000).toISOString()
const [a, b] = config.caregivers
const ev = (type: CareEvent['type'], min: number, by: string, meta?: CareEvent['meta']): CareEvent =>
  ({ id: randomUUID(), type, at: ago(min), by, meta })

const date = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(now))

if (fs.existsSync(file)) {
  const existing = JSON.parse(fs.readFileSync(file, 'utf8')) as DayState
  if (existing.date === date && existing.events?.length) {
    console.error(`Refusing to overwrite ${file}: it already has events for ${date}.`)
    process.exit(1)
  }
}

const events: CareEvent[] = [
  ev('wake', 300, a.name),
  ev('feed', 295, a.name, { side: 'both', durationMin: 18, leftMin: 10, rightMin: 8 }),
  ev('diaper', 270, b?.name ?? a.name),
  ev('nap_start', 210, b?.name ?? a.name),
  ev('nap_end', 150, b?.name ?? a.name),
  ev('feed', 145, a.name, { side: 'bottle', ounces: 4 }),
  ev('tummy', 120, a.name, { durationMin: 10 }),
  ev('note', 100, b?.name ?? a.name, { note: 'Demo note: happy after the park.' }),
]

fs.mkdirSync(dataDir, { recursive: true })
fs.writeFileSync(file, JSON.stringify({ date, events, updatedAt: new Date().toISOString() }, null, 2))
console.log(`Wrote ${events.length} fictional events for ${date} to ${file}`)
