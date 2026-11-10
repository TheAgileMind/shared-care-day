import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getAge, resolveSchedule, validateProfile } from './profile.ts'
import type { BabyProfile } from '../types.ts'
import { EXAMPLE_CONFIG, allowedEmails, caregiverFromEmail, profileFromConfig } from '../config.ts'

const PROFILE = { ...profileFromConfig(EXAMPLE_CONFIG), dateOfBirth: undefined }

const fixture: BabyProfile = { ...PROFILE, name: 'Test baby', dateOfBirth: '2026-01-31' }

test('bundled example uses fictional demo values and omits a live family record', () => {
  assert.equal(EXAMPLE_CONFIG.childName, 'Sam')
  assert.equal(EXAMPLE_CONFIG.dateOfBirth, '2025-01-15')
  assert.ok(EXAMPLE_CONFIG.caregivers.every((c) => c.email.endsWith('@example.com')))
  assert.equal(PROFILE.dateOfBirth, undefined)
  assert.equal('weeksOld' in PROFILE, false)
  assert.equal(resolveSchedule(PROFILE, '2026-05-31'), null)
})

test('age uses exact date-only days and completed weeks', () => {
  assert.deepEqual(getAge(fixture, '2026-02-07'), { days: 7, weeks: 1, months: 0, basis: 'actual' })
  assert.deepEqual(getAge(fixture, '2026-02-28'), { days: 28, weeks: 4, months: 1, basis: 'actual' })
  assert.equal(getAge(fixture, '2026-03-30')?.months, 1)
  assert.equal(getAge(fixture, '2026-03-31')?.months, 2)
})

test('calendar anniversaries clamp month ends and leap-day birthdays', () => {
  const leap = { ...fixture, dateOfBirth: '2024-02-29' }
  assert.equal(getAge(leap, '2025-02-27')?.months, 11)
  assert.deepEqual(getAge(leap, '2025-02-28'), { days: 365, weeks: 52, months: 12, basis: 'actual' })
  assert.equal(getAge({ ...fixture, dateOfBirth: '2023-12-31' }, '2024-02-29')?.months, 2)
})

test('adjusted age uses the due date and remains unavailable before that date', () => {
  const adjusted: BabyProfile = { ...fixture, ageBasis: 'adjusted', dueDate: '2026-02-07' }
  assert.equal(getAge(adjusted, '2026-02-06'), null)
  assert.equal(resolveSchedule(adjusted, '2026-02-06'), null)
  assert.equal(validateProfile(adjusted, '2026-02-06'), null)
  assert.deepEqual(getAge(adjusted, '2026-02-14'), { days: 7, weeks: 1, months: 0, basis: 'adjusted' })
  assert.equal(getAge({ ...adjusted, ageBasis: 'actual' }, '2026-02-14')?.days, 14)
})

test('invalid or future birth dates never produce an age or a plan', () => {
  for (const dateOfBirth of [undefined, '', '2026-2-01', '2026-02-29', '2026-04-31', '0000-01-01', '2026-08-01']) {
    const profile = { ...fixture, dateOfBirth }
    assert.equal(getAge(profile, '2026-07-01'), null)
    assert.equal(resolveSchedule(profile, '2026-07-01'), null)
    assert.ok(validateProfile(profile, '2026-07-01'))
  }
  assert.equal(getAge(fixture, '2026-02-30'), null)
  assert.ok(validateProfile(fixture, 'not-a-date'))
})

test('correcting the birth date recomputes age without mutating the profile', () => {
  const corrected = { ...fixture, dateOfBirth: '2026-02-28' }
  assert.equal(getAge(fixture, '2026-05-31')?.months, 4)
  assert.equal(getAge(corrected, '2026-05-31')?.months, 3)
  assert.equal(resolveSchedule(fixture, '2026-05-31')?.window.short, 90)
  assert.equal(resolveSchedule(corrected, '2026-05-31')?.window.short, 75)
  assert.equal(fixture.dateOfBirth, '2026-01-31')
})

test('week bands use days 0–27, 28–55, 56–83 before calendar-month bands', () => {
  const profile = { ...fixture, dateOfBirth: '2026-01-01' }
  const cases = [
    ['2026-01-01', 35, 60, null], ['2026-01-28', 35, 60, null],
    ['2026-01-29', 50, 90, null], ['2026-02-25', 50, 90, null],
    ['2026-02-26', 60, 90, null], ['2026-03-25', 60, 90, null],
    ['2026-03-26', 75, 110, 4], ['2026-04-30', 75, 110, 4],
    ['2026-05-01', 90, 120, 4], ['2026-06-01', 120, 180, 3],
  ] as const
  for (const [date, short, long, napCount] of cases) {
    const plan = resolveSchedule(profile, date)
    assert.ok(plan, date)
    assert.equal(plan.window.short, short, date)
    assert.equal(plan.window.long, long, date)
    assert.equal(plan.napCount, napCount, date)
    assert.equal(plan.sourceUrl, '')
    assert.doesNotMatch(JSON.stringify(plan), /takingcarababies|cara/i)
  }
})

test('seven-month overlap retains 3 naps or allows the caregiver to choose 2', () => {
  const profile = { ...fixture, dateOfBirth: '2026-01-01' }
  assert.equal(resolveSchedule(profile, '2026-08-01')?.napCount, 3)
  assert.equal(resolveSchedule({ ...profile, napPattern: 3 }, '2026-08-31')?.window.short, 120)
  assert.equal(resolveSchedule({ ...profile, napPattern: 2 }, '2026-08-01')?.window.short, 150)
  assert.equal(resolveSchedule(profile, '2026-09-01')?.napCount, 2)
  assert.equal(resolveSchedule({ ...profile, napPattern: 3 }, '2026-09-01'), null)
  assert.ok(validateProfile({ ...profile, napPattern: 3 }, '2026-09-01'))
})

test('older two-nap and fourteen-month overlaps keep distinct windows', () => {
  const profile = { ...fixture, dateOfBirth: '2025-01-01' }
  assert.equal(resolveSchedule(profile, '2025-11-30')?.window.short, 150)
  assert.equal(resolveSchedule(profile, '2025-12-01')?.window.short, 180)
  assert.equal(resolveSchedule(profile, '2026-03-01')?.napCount, 2)
  assert.equal(resolveSchedule({ ...profile, napPattern: 2 }, '2026-03-31')?.window.long, 240)
  const oneNap = resolveSchedule({ ...profile, napPattern: 1 }, '2026-03-01')
  assert.equal(oneNap?.napCount, 1)
  assert.deepEqual(oneNap?.window, { short: 300, target: 330, long: 360 })
  assert.deepEqual(oneNap?.finalWindow, { short: 240, target: 270, long: 300 })
  assert.equal(resolveSchedule(profile, '2026-04-01')?.napCount, 1)
  assert.equal(resolveSchedule({ ...profile, napPattern: 2 }, '2026-04-01'), null)
})

test('supported-age ceiling ends at the 25-month anniversary', () => {
  const profile = { ...fixture, dateOfBirth: '2024-01-31' }
  assert.equal(resolveSchedule(profile, '2026-02-27')?.napCount, 1)
  assert.equal(resolveSchedule(profile, '2026-02-28'), null)
})

test('validation protects the profile contract and age-specific nap selection', () => {
  assert.equal(validateProfile({ ...fixture, napPattern: 4 }, '2026-05-31'), null)
  assert.ok(validateProfile(fixture, '2026-05-31'))
  assert.equal(validateProfile(fixture, '2026-02-01'), null)
  for (const input of [null, [], {}, { ...fixture, name: ' ' }, { ...fixture, name: 'a\n' },
    { ...fixture, ageBasis: 'other' }, { ...fixture, ageBasis: 'adjusted' },
    { ...fixture, dueDate: '2026-01-30' }, { ...fixture, dueDate: 'not-a-date' },
    { ...fixture, timezone: 'UTC' }, { ...fixture, morningTarget: '24:00' },
    { ...fixture, bedtimeTarget: '19:60' }, { ...fixture, bedtimeTarget: '07:00' },
    { ...fixture, napPattern: 0 }, { ...fixture, napPattern: 6 }, { ...fixture, napPattern: 2.5 },
    { ...fixture, napPattern: '4' }, { ...fixture, napPattern: 1 },
  ]) assert.ok(validateProfile(input, '2026-05-31'), JSON.stringify(input))
  assert.ok(validateProfile({ ...fixture, napPattern: 4 }, '2026-02-01'))
  assert.equal(validateProfile({ ...fixture, napPattern: 3 }, '2026-05-31'), null)
})

test('example caregivers are allowlisted and unknown or revoked emails are rejected', () => {
  const emails = allowedEmails(EXAMPLE_CONFIG)
  for (const person of EXAMPLE_CONFIG.caregivers) {
    assert.ok(emails.includes(person.email))
    assert.deepEqual(caregiverFromEmail(` ${person.email.toUpperCase()} `, EXAMPLE_CONFIG), {
      parentId: person.id, name: person.name,
    })
  }
  assert.equal(caregiverFromEmail('unknown@example.test', EXAMPLE_CONFIG), null)
  assert.equal(caregiverFromEmail(' riley@example.com ', EXAMPLE_CONFIG), null)
  assert.equal(emails.includes('riley@example.com'), false)
  assert.equal(caregiverFromEmail('taylor+other@example.com', EXAMPLE_CONFIG), null)
})
