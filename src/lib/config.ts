import type { BabyProfile } from './types.ts'

export type Caregiver = { id: string; name: string; email: string }

export type AppConfig = {
  childName: string
  timezone: string
  morningTarget: string
  bedtimeTarget: string
  ageBasis: 'actual' | 'adjusted'
  dateOfBirth?: string
  dueDate?: string
  caregivers: Caregiver[]
}

/** Fictional demo household shipped with the repo. Never put real family data here. */
export const EXAMPLE_CONFIG: AppConfig = {
  childName: 'Sam',
  timezone: 'America/Chicago',
  morningTarget: '08:00',
  bedtimeTarget: '19:30',
  ageBasis: 'actual',
  dateOfBirth: '2026-05-10',
  caregivers: [
    { id: 'alex', name: 'Alex', email: 'alex@example.com' },
    { id: 'jordan', name: 'Jordan', email: 'jordan@example.com' },
    { id: 'casey', name: 'Casey', email: 'casey@example.com' },
    { id: 'taylor', name: 'Taylor', email: 'taylor@example.com' },
    { id: 'morgan', name: 'Morgan', email: 'morgan@example.com' },
  ],
}

function isKnownZone(zone: string) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: zone }); return true } catch { return false }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const TZ = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/
const ID = /^[a-z][a-z0-9_-]{0,31}$/

export function validateConfig(input: unknown): AppConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('App config must be an object')
  }
  const raw = input as Record<string, unknown>
  const childName = String(raw.childName || '').trim()
  if (!childName || childName.length > 80) throw new Error('childName must be 1–80 characters')
  const timezone = String(raw.timezone || '').trim()
  if (!TZ.test(timezone) || !isKnownZone(timezone)) throw new Error('timezone must be an IANA name like America/Chicago')
  const morningTarget = String(raw.morningTarget || '')
  const bedtimeTarget = String(raw.bedtimeTarget || '')
  if (!CLOCK.test(morningTarget) || !CLOCK.test(bedtimeTarget)) {
    throw new Error('morningTarget and bedtimeTarget must be HH:mm')
  }
  const ageBasis = raw.ageBasis === 'adjusted' ? 'adjusted' : 'actual'
  const dateOfBirth = raw.dateOfBirth == null || raw.dateOfBirth === '' ? undefined : String(raw.dateOfBirth)
  const dueDate = raw.dueDate == null || raw.dueDate === '' ? undefined : String(raw.dueDate)
  if (dateOfBirth && !DATE.test(dateOfBirth)) throw new Error('dateOfBirth must be YYYY-MM-DD')
  if (dueDate && !DATE.test(dueDate)) throw new Error('dueDate must be YYYY-MM-DD')
  if (!Array.isArray(raw.caregivers) || raw.caregivers.length === 0) {
    throw new Error('caregivers must be a non-empty array')
  }
  const caregivers: Caregiver[] = raw.caregivers.map((row, i) => {
    if (!row || typeof row !== 'object') throw new Error(`caregivers[${i}] is invalid`)
    const item = row as Record<string, unknown>
    const id = String(item.id || '').trim().toLowerCase()
    const name = String(item.name || '').trim()
    const email = String(item.email || '').trim().toLowerCase()
    if (!ID.test(id)) throw new Error(`caregivers[${i}].id is invalid`)
    if (!name) throw new Error(`caregivers[${i}].name is required`)
    if (!EMAIL.test(email)) throw new Error(`caregivers[${i}].email is invalid`)
    return { id, name, email }
  })
  const ids = new Set(caregivers.map((c) => c.id))
  const emails = new Set(caregivers.map((c) => c.email))
  if (ids.size !== caregivers.length) throw new Error('caregiver ids must be unique')
  if (emails.size !== caregivers.length) throw new Error('caregiver emails must be unique')
  return { childName, timezone, morningTarget, bedtimeTarget, ageBasis, dateOfBirth, dueDate, caregivers }
}

export function allowedEmails(config: AppConfig): string[] {
  return config.caregivers.map((c) => c.email)
}

export function caregiverFromEmail(email: string, config: AppConfig): { parentId: string; name: string } | null {
  const normalized = email.trim().toLowerCase()
  const person = config.caregivers.find((c) => c.email === normalized)
  return person ? { parentId: person.id, name: person.name } : null
}

export function profileFromConfig(config: AppConfig): BabyProfile {
  const profile: BabyProfile = {
    name: config.childName,
    ageBasis: config.ageBasis,
    timezone: config.timezone,
    bedtimeTarget: config.bedtimeTarget,
    morningTarget: config.morningTarget,
  }
  if (config.dateOfBirth) profile.dateOfBirth = config.dateOfBirth
  if (config.dueDate) profile.dueDate = config.dueDate
  return profile
}
