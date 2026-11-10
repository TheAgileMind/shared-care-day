import type { BabyProfile } from '../types'

export interface AgeInfo {
  days: number
  weeks: number
  months: number
  basis: 'actual' | 'adjusted'
}

export interface WakeWindow { short: number; target: number; long: number }
export interface SchedulePlan {
  id: string
  sourceUrl: string
  // Newborn guidance is flexible and does not prescribe a daily nap count.
  minNaps: number | null
  maxNaps: number | null
  napCount: number | null
  window: WakeWindow
  finalWindow?: WakeWindow
}

const DAY = 86_400_000
// Wake-window ranges are generic, commonly published approximations kept as
// plain numbers. They are not taken from any branded program. Point SOURCE at a
// reference you trust (for example your pediatrician's handout) to show a link.
const SOURCE = ''
const window = (short: number, long: number): WakeWindow => ({ short, target: Math.round((short + long) / 2), long })

function dateOnly(value: unknown): Date | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1) return null
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  date.setUTCHours(0, 0, 0, 0)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? date : null
}

// An anniversary on the 29th–31st is the final day of a shorter month.
// Days/weeks remain exact elapsed calendar days; a month never means four weeks.
function calendarMonths(from: Date, to: Date): number {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + to.getUTCMonth() - from.getUTCMonth()
  const lastDay = new Date(0)
  lastDay.setUTCFullYear(to.getUTCFullYear(), to.getUTCMonth() + 1, 0)
  const anniversary = Math.min(from.getUTCDate(), lastDay.getUTCDate())
  if (to.getUTCDate() < anniversary) months--
  return months
}

export function getAge(profile: BabyProfile, dateKey: string): AgeInfo | null {
  const date = dateOnly(dateKey)
  const birth = dateOnly(profile.dateOfBirth)
  if (!date || !birth || birth > date || !['actual', 'adjusted'].includes(profile.ageBasis)) return null
  const basis = profile.ageBasis
  const start = basis === 'adjusted' ? dateOnly(profile.dueDate) : birth
  if (!start || start < birth || start > date) return null
  const days = Math.round((date.getTime() - start.getTime()) / DAY)
  return { days, weeks: Math.floor(days / 7), months: calendarMonths(start, date), basis }
}

function planForAge(age: AgeInfo, napPattern?: number): SchedulePlan | null {
  const flexible = (id: string, article: string, short: number, long: number): SchedulePlan => ({
    id, sourceUrl: SOURCE && SOURCE + article, minNaps: null, maxNaps: null, napCount: null, window: window(short, long),
  })
  const fixed = (id: string, article: string, minNaps: number, maxNaps: number, defaultNaps: number, short: number, long: number): SchedulePlan => ({
    id, sourceUrl: SOURCE && SOURCE + article, minNaps, maxNaps, napCount: napPattern ?? defaultNaps, window: window(short, long),
  })
  // Weeks 0–3, 4–7 and 8–11 are mapped to exact day ranges. Thereafter the
  // official month bands use calendar anniversaries, not 28-day approximations.
  if (age.days < 28) return flexible('newborn', 'newborn-sleep-schedule', 35, 60)
  if (age.days < 56) return flexible('weeks-4-7', '1-month-old-sleep-schedule', 50, 90)
  if (age.days < 84) return flexible('weeks-8-11', '2-month-old-sleep-schedule', 60, 90)
  if (age.months < 4) return fixed('3-months', '3-month-old-sleep-schedule', 4, 5, 4, 75, 110)
  if (age.months < 5) return fixed('4-months', '4-month-old-sleep-schedule', 3, 5, 4, 90, 120)
  const article = 'nap-schedules-5-months-to-24-months'
  // At seven and fourteen months both patterns are supported. Keep the prior
  // higher nap count by default, and honor a caregiver's explicit selection.
  if (age.months < 7) return fixed('3-naps', article, 3, 3, 3, 120, 180)
  if (age.months < 8 && napPattern !== 2) return fixed('3-naps-transition', article, 2, 3, 3, 120, 180)
  if (age.months < 11) return fixed('2-naps', article, 2, age.months < 8 ? 3 : 2, 2, 150, 210)
  if (age.months < 14) return fixed('2-naps-older', article, 2, 2, 2, 180, 240)
  if (age.months < 15 && napPattern !== 1) return fixed('2-naps-transition', article, 1, 2, 2, 180, 240)
  if (age.months < 25) return {
    ...fixed('1-nap', article, 1, age.months < 15 ? 2 : 1, 1, 300, 360),
    finalWindow: window(240, 300),
  }
  return null
}

function validateProfileFields(input: unknown, asOfDate: string, requireNapPattern: boolean): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return 'A baby profile is required.'
  const profile = input as BabyProfile
  const asOf = dateOnly(asOfDate)
  if (!asOf) return 'A valid reference date is required.'
  if (typeof profile.name !== 'string' || !profile.name.trim() || profile.name.length > 80 || /[\u0000-\u001f\u007f]/.test(profile.name)) return 'Enter a valid name (1–80 characters).'
  const birth = dateOnly(profile.dateOfBirth)
  if (!birth) return 'Enter a valid date of birth (YYYY-MM-DD).'
  if (birth > asOf) return 'Date of birth cannot be in the future.'
  if (profile.ageBasis !== 'actual' && profile.ageBasis !== 'adjusted') return 'Choose actual or adjusted age.'
  if (profile.dueDate !== undefined || profile.ageBasis === 'adjusted') {
    const due = dateOnly(profile.dueDate)
    if (!due) return 'Adjusted age requires a valid due date (YYYY-MM-DD).'
    if (due < birth) return 'Due date cannot be before date of birth.'
  }
  if (typeof profile.timezone !== 'string' || !/^[A-Za-z_]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(profile.timezone)) return 'Enter a valid IANA timezone.'
  const clock = /^([01]\d|2[0-3]):[0-5]\d$/
  if (typeof profile.morningTarget !== 'string' || !clock.test(profile.morningTarget)) return 'Enter a valid morning time (HH:mm).'
  if (typeof profile.bedtimeTarget !== 'string' || !clock.test(profile.bedtimeTarget)) return 'Enter a valid bedtime (HH:mm).'
  if (profile.bedtimeTarget <= profile.morningTarget) return 'Bedtime must be after the morning target.'
  const age = getAge(profile, asOfDate)
  const plan = age ? planForAge(age, profile.napPattern) : null
  if (profile.napPattern === undefined) {
    if (requireNapPattern && plan?.napCount != null) return 'Choose a nap pattern for this age before saving the schedule.'
  } else {
    if (!Number.isInteger(profile.napPattern) || profile.napPattern < 1 || profile.napPattern > 5) return 'Choose a whole nap count from 1 to 5.'
    if (!plan || plan.minNaps === null || plan.maxNaps === null || profile.napPattern < plan.minNaps || profile.napPattern > plan.maxNaps) return 'This nap pattern is not supported for the selected age.'
  }
  return null
}

export function validateProfile(input: unknown, asOfDate: string): string | null {
  return validateProfileFields(input, asOfDate, true)
}

// Defaults describe available guidance for configuration UI; the engine requires
// an explicit caregiver nap choice before making fixed-count predictions.
export function resolveSchedule(profile: BabyProfile, dateKey: string): SchedulePlan | null {
  if (validateProfileFields(profile, dateKey, false)) return null
  const age = getAge(profile, dateKey)
  return age ? planForAge(age, profile.napPattern) : null
}
