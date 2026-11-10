import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildDay } from './engine.ts'
import type { CareEvent } from '../types.ts'
import { EXAMPLE_CONFIG, profileFromConfig } from '../config.ts'

const PROFILE = { ...profileFromConfig(EXAMPLE_CONFIG), dateOfBirth: undefined }

const at = (time: string) => new Date(`2026-09-03T${time}:00-05:00`)
const fixture = { ...PROFILE, name: 'Test baby', dateOfBirth: '2026-06-01', napPattern: 4 }

test('does not invent sleep recommendations when the date of birth is missing', () => {
  const state = buildDay(at('08:15'), [], PROFILE)

  assert.equal(state.nextAction.copy?.key, 'action.setupSchedule')
  assert.equal(state.schedule.filter((item) => item.predicted).length, 0)
})

test('uses the selected day age rather than a fixed thirteen-week schedule', () => {
  const state = buildDay(at('08:15'), [], {
    ...PROFILE, dateOfBirth: '2026-04-03', ageBasis: 'actual', napPattern: 3,
  })

  assert.equal(state.wakeWindowMin.short, 120)
  assert.equal(state.wakeWindowMin.long, 180)
  assert.ok(state.schedule.filter((item) => item.predicted && item.kind === 'nap_start').length <= 3)
})

test('starts a three-month-old morning inside its flexible wake window', () => {
  const state = buildDay(at('08:15'), [], fixture)

  assert.equal(state.wakeWindowMin.short, 75)
  assert.equal(state.wakeWindowMin.long, 110)
  assert.ok(state.wakeWindowMin.target >= 75 && state.wakeWindowMin.target <= 110)
})

test('uses the age band after the final nap and recommends bedtime', () => {
  const events: CareEvent[] = [
    { id: 'w0', type: 'wake', at: at('08:00').toISOString(), by: 'David' },
    { id: 'n1s', type: 'nap_start', at: at('09:20').toISOString(), by: 'David' },
    { id: 'n1e', type: 'nap_end', at: at('10:20').toISOString(), by: 'David' },
    { id: 'n2s', type: 'nap_start', at: at('11:45').toISOString(), by: 'David' },
    { id: 'n2e', type: 'nap_end', at: at('12:45').toISOString(), by: 'David' },
    { id: 'n3s', type: 'nap_start', at: at('14:15').toISOString(), by: 'David' },
    { id: 'n3e', type: 'nap_end', at: at('15:15').toISOString(), by: 'David' },
    { id: 'n4s', type: 'nap_start', at: at('16:45').toISOString(), by: 'David' },
    { id: 'n4e', type: 'nap_end', at: at('17:45').toISOString(), by: 'David' },
  ]

  const state = buildDay(at('19:15'), events, fixture)

  assert.equal(state.wakeWindowMin.short, 75)
  assert.equal(state.wakeWindowMin.long, 110)
  assert.equal(state.nextAction.kind, 'bedtime')
})

test('predicts four to five naps without placing one inside the bedtime wake window', () => {
  const state = buildDay(at('08:00'), [], fixture)
  const predictedNaps = state.schedule.filter((item) => item.predicted && item.kind === 'nap_start')
  const bedtime = state.schedule.find((item) => item.kind === 'bedtime')

  assert.ok(predictedNaps.length >= 4 && predictedNaps.length <= 5)
  assert.ok(bedtime)
  for (const nap of predictedNaps) {
    const wake = state.schedule.find(
      (item) => item.predicted && item.kind === 'wake' && item.time.getTime() > nap.time.getTime()
    )
    assert.ok(wake)
    const minutesBeforeBed: number = (bedtime.time.getTime() - wake.time.getTime()) / 60_000
    assert.ok(minutesBeforeBed >= 75)
  }
})

test('keeps short-nap recovery inside the three-month wake-window floors', () => {
  const events: CareEvent[] = [
    { id: 'w0', type: 'wake', at: at('08:00').toISOString(), by: 'David' },
    { id: 'n1s', type: 'nap_start', at: at('09:20').toISOString(), by: 'David' },
    { id: 'n1e', type: 'nap_end', at: at('09:50').toISOString(), by: 'David' },
  ]

  const state = buildDay(at('10:00'), events, fixture)

  assert.equal(state.wakeWindowMin.short, 75)
  assert.ok(state.wakeWindowMin.target >= 75 && state.wakeWindowMin.target <= 110)
  assert.equal(state.wakeWindowMin.long, 110)
})

test('keeps low-previous-sleep recovery inside the three-month wake-window floors', () => {
  const events: CareEvent[] = [
    { id: 'w0', type: 'wake', at: at('08:00').toISOString(), by: 'David' },
    { id: 'n1s', type: 'nap_start', at: at('09:20').toISOString(), by: 'David' },
    { id: 'n1e', type: 'nap_end', at: at('10:20').toISOString(), by: 'David' },
    { id: 'n2s', type: 'nap_start', at: at('11:45').toISOString(), by: 'David' },
    { id: 'n2e', type: 'nap_end', at: at('12:45').toISOString(), by: 'David' },
  ]

  const state = buildDay(at('13:00'), events, fixture, 239)

  assert.equal(state.wakeWindowMin.short, 75)
  assert.ok(state.wakeWindowMin.target >= 75 && state.wakeWindowMin.target <= 110)
  assert.equal(state.wakeWindowMin.long, 110)
})

test('caps an active late-nap prediction at the bedtime wake-window boundary', () => {
  const events: CareEvent[] = [
    { id: 'w0', type: 'wake', at: at('08:00').toISOString(), by: 'David' },
    { id: 'late-nap', type: 'nap_start', at: at('17:45').toISOString(), by: 'David' },
  ]

  const state = buildDay(at('18:00'), events, fixture)
  const predictedWake = state.schedule.find((item) => item.predicted && item.kind === 'wake')
  const bedtime = state.schedule.find((item) => item.kind === 'bedtime')

  assert.ok(predictedWake)
  assert.ok(bedtime)
  assert.equal(predictedWake.time.toISOString(), at('18:15').toISOString())
  assert.equal((bedtime.time.getTime() - predictedWake.time.getTime()) / 60_000, 75)
})

test('allows fewer naps after a delayed start instead of crowding bedtime', () => {
  const events: CareEvent[] = [
    { id: 'late-wake', type: 'wake', at: at('10:00').toISOString(), by: 'David' },
  ]

  const state = buildDay(at('10:05'), events, fixture)
  const predictedNaps = state.schedule.filter((item) => item.predicted && item.kind === 'nap_start')
  const bedtime = state.schedule.find((item) => item.kind === 'bedtime')

  assert.equal(predictedNaps.length, 3)
  assert.ok(bedtime)
  const finalWake = state.schedule
    .filter((item) => item.predicted && item.kind === 'wake')
    .at(-1)
  assert.ok(finalWake)
  assert.ok((bedtime.time.getTime() - finalWake.time.getTime()) / 60_000 >= 75)
})

test('missing or unsupported setup retains logged events and counts without predictions', () => {
  const events: CareEvent[] = [
    { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' },
    { id: 'feed', type: 'feed', at: at('08:05').toISOString(), by: 'Test caregiver' },
    { id: 'nap', type: 'nap_start', at: at('09:00').toISOString(), by: 'Test caregiver' },
    { id: 'end', type: 'nap_end', at: at('10:00').toISOString(), by: 'Test caregiver' },
    { id: 'legacy-diaper', type: 'diaper', at: at('10:01').toISOString(), by: 'Test caregiver', meta: { note: 'poop' } },
  ]
  const original = JSON.stringify(events)
  for (const profile of [PROFILE, { ...fixture, dateOfBirth: '2023-01-01' }, { ...fixture, napPattern: 1 }]) {
    const state = buildDay(at('10:15'), events, profile)
    assert.equal(state.schedulePlan, null)
    assert.equal(state.schedule.length, events.length)
    assert.equal(state.timeline.length, events.length)
    assert.ok(state.schedule.every((item) => !item.predicted))
    assert.equal(state.feedCount, 1)
    assert.equal(state.napCount, 1)
    assert.equal(state.daySleepMin, 60)
    assert.equal(state.awakeMin, 15)
    assert.equal(state.status, 'awake')
    assert.deepEqual(state.wakeWindowMin, { short: 0, target: 0, long: 0 })
  }
  assert.equal(JSON.stringify(events), original)
})

test('uses the household-zone selected-day age at UTC midnight and day rollover', () => {
  const profile = { ...fixture, dateOfBirth: '2026-05-04', napPattern: 4 }
  const before = buildDay(new Date('2026-09-03T22:30:00Z'), [], profile)
  const after = buildDay(new Date('2026-09-04T05:00:00Z'), [], profile)
  assert.equal(before.age?.months, 3)
  assert.equal(before.schedulePlan?.id, '3-months')
  assert.equal(after.age?.months, 4)
  assert.equal(after.schedulePlan?.id, '4-months')
})

test('fixed-count plans require a caregiver selection instead of automatic nap removal', () => {
  const state = buildDay(at('08:15'), [], { ...fixture, napPattern: undefined })
  assert.equal(state.schedulePlan, null)
  assert.equal(state.nextAction.copy?.key, 'action.setupSchedule')
  assert.equal(state.schedule.length, 0)
  assert.equal(state.age?.months, 3)
})

test('a birthday retains the selected nap count or asks for review without silently dropping it', () => {
  const selectedFour = { ...fixture, dateOfBirth: '2026-04-04', napPattern: 4 }
  const beforeFiveMonths = buildDay(new Date('2026-09-03T08:00:00-05:00'), [], selectedFour)
  const atFiveMonths = buildDay(new Date('2026-09-04T08:00:00-05:00'), [], selectedFour)
  assert.equal(beforeFiveMonths.schedulePlan?.napCount, 4)
  assert.equal(atFiveMonths.schedulePlan, null)
  assert.equal(atFiveMonths.nextAction.copy?.key, 'action.setupSchedule')
  assert.equal(selectedFour.napPattern, 4)

  const selectedThree = { ...fixture, dateOfBirth: '2026-02-04', napPattern: 3 }
  assert.equal(buildDay(new Date('2026-09-04T08:00:00-05:00'), [], selectedThree).schedulePlan?.napCount, 3)
  assert.equal(buildDay(new Date('2026-10-04T08:00:00-05:00'), [], selectedThree).schedulePlan, null)
  assert.equal(selectedThree.napPattern, 3)
})

test('short-nap recovery stays inside each chosen age band', () => {
  const events: CareEvent[] = [
    { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' },
    { id: 'nap', type: 'nap_start', at: at('10:00').toISOString(), by: 'Test caregiver' },
    { id: 'end', type: 'nap_end', at: at('10:25').toISOString(), by: 'Test caregiver' },
  ]
  for (const [dateOfBirth, napPattern, floor, ceiling] of [
    ['2026-08-20', undefined, 35, 60], ['2026-04-03', 3, 120, 180], ['2026-01-03', 2, 150, 210],
  ] as const) {
    const state = buildDay(at('10:35'), events, { ...fixture, dateOfBirth, napPattern }, 200)
    assert.equal(state.wakeWindowMin.short, floor)
    assert.equal(state.wakeWindowMin.long, ceiling)
    assert.ok(state.wakeWindowMin.target >= floor && state.wakeWindowMin.target <= ceiling)
  }
})

test('true wake correction drives sleep totals, awake time and next predictions', () => {
  const events: CareEvent[] = [
    { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' },
    { id: 'nap', type: 'nap_start', at: at('09:20').toISOString(), by: 'Test caregiver' },
    { id: 'feed', type: 'feed', at: at('10:05').toISOString(), by: 'Test caregiver' },
    { id: 'end', type: 'nap_end', at: at('10:20').toISOString(), by: 'Test caregiver', meta: { trueWake: at('10:00').toISOString() } },
  ]
  const state = buildDay(at('10:30'), events, fixture)
  assert.equal(state.daySleepMin, 40)
  assert.equal(state.awakeMin, 30)
  assert.equal(state.lastWake?.toISOString(), at('10:00').toISOString())
  assert.equal(state.timeline[2].time.toISOString(), at('10:00').toISOString())
  assert.equal(state.feedCount, 1)
  assert.equal(state.napCount, 1)
  assert.ok(state.schedule.find((item) => item.predicted && item.kind === 'nap_start')!.time > at('10:30'))
})

test('skipped and delayed naps do not place predictions in the past or crowd bedtime', () => {
  const now = at('17:45')
  const state = buildDay(now, [
    { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' },
  ], { ...fixture, dateOfBirth: '2026-04-03', napPattern: 3 })
  assert.equal(state.schedule.filter((item) => item.predicted && item.kind === 'nap_start').length, 0)
  assert.equal(state.nextAction.kind, 'bedtime')
  assert.ok(state.schedule.filter((item) => item.predicted).every((item) => item.time >= now))
})

test('one-nap pattern uses a different final wake window and never predicts a second nap', () => {
  const events: CareEvent[] = [
    { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' },
    { id: 'nap', type: 'nap_start', at: at('13:00').toISOString(), by: 'Test caregiver' },
    { id: 'end', type: 'nap_end', at: at('14:00').toISOString(), by: 'Test caregiver' },
  ]
  const state = buildDay(at('18:30'), events, { ...fixture, dateOfBirth: '2025-03-03', napPattern: 1 })
  assert.equal(state.wakeWindowMin.short, 240)
  assert.equal(state.wakeWindowMin.long, 300)
  assert.equal(state.schedule.filter((item) => item.predicted && item.kind === 'nap_start').length, 0)
  assert.equal(state.nextAction.kind, 'bedtime')
})

test('a late final nap keeps the primary action aligned with bedtime before the minimum wake window', () => {
  const events: CareEvent[] = [
    { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' },
    { id: 'nap', type: 'nap_start', at: at('16:00').toISOString(), by: 'Test caregiver' },
    { id: 'end', type: 'nap_end', at: at('17:00').toISOString(), by: 'Test caregiver' },
    { id: 'feed', type: 'feed', at: at('17:05').toISOString(), by: 'Test caregiver' },
  ]
  for (const clock of ['18:30', '19:30', '20:00']) {
    const state = buildDay(at(clock), events, { ...fixture, dateOfBirth: '2025-03-03', napPattern: 1 })
    const bedtime = state.schedule.find(item => item.predicted && item.kind === 'bedtime')
    assert.ok(state.awakeMin < state.wakeWindowMin.short)
    assert.equal(state.nextAction.kind, 'bedtime')
    assert.equal(state.nextAction.at?.toISOString(), bedtime?.time.toISOString())
    assert.equal(state.nextAction.at?.toISOString(), at(clock < '19:30' ? '19:30' : clock).toISOString())
    if (clock >= '19:30') assert.equal(state.nextAction.urgency, 'now')
    assert.equal(state.schedule.filter(item => item.predicted && item.kind === 'nap_start').length, 0)
  }
})

test('no-room bedtime guidance does not wait for the minimum wake window when naps were skipped', () => {
  const state = buildDay(at('19:30'), [
    { id: 'wake', type: 'wake', at: at('18:45').toISOString(), by: 'Test caregiver' },
    { id: 'feed', type: 'feed', at: at('18:50').toISOString(), by: 'Test caregiver' },
  ], fixture)
  assert.equal(state.napCount, 0)
  assert.ok(state.awakeMin < state.wakeWindowMin.short)
  assert.equal(state.nextAction.kind, 'bedtime')
  assert.equal(state.nextAction.at?.toISOString(), at('19:30').toISOString())
  assert.equal(state.nextAction.urgency, 'now')
})

test('a late final nap still offers the existing full feed immediately on waking', () => {
  const state = buildDay(at('17:10'), [
    { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' },
    { id: 'nap', type: 'nap_start', at: at('16:00').toISOString(), by: 'Test caregiver' },
    { id: 'end', type: 'nap_end', at: at('17:00').toISOString(), by: 'Test caregiver' },
  ], { ...fixture, dateOfBirth: '2025-03-03', napPattern: 1 })
  assert.equal(state.nextAction.copy?.key, 'action.fullFeed')
})

test('one-nap prediction leaves the final age-band window before bedtime', () => {
  const state = buildDay(at('08:00'), [], { ...fixture, dateOfBirth: '2025-03-03', napPattern: 1 })
  const naps = state.schedule.filter((item) => item.predicted && item.kind === 'nap_start')
  const wake = state.schedule.filter((item) => item.predicted && item.kind === 'wake').at(-1)
  const bedtime = state.schedule.find((item) => item.kind === 'bedtime')
  assert.equal(naps.length, 1)
  assert.ok(wake && bedtime)
  const finalWindow = (bedtime.time.getTime() - wake.time.getTime()) / 60_000
  assert.ok(finalWindow >= 240 && finalWindow <= 300)
})

test('a short final nap suggests earlier bedtime within the age band without changing the target', () => {
  const profile = { ...fixture, dateOfBirth: '2025-03-03', napPattern: 1 }
  const state = buildDay(at('16:50'), [
    { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' },
    { id: 'nap', type: 'nap_start', at: at('12:00').toISOString(), by: 'Test caregiver' },
    { id: 'end', type: 'nap_end', at: at('12:30').toISOString(), by: 'Test caregiver' },
  ], profile)
  const bedtime = state.schedule.find((item) => item.predicted && item.kind === 'bedtime')
  assert.equal(state.nextAction.kind, 'bedtime')
  assert.equal(state.nextAction.copy?.key, 'sched.bedtimeAdjusted')
  assert.equal(state.nextAction.at?.toISOString(), at('17:30').toISOString())
  assert.equal(bedtime?.time.toISOString(), at('17:30').toISOString())
  assert.equal(state.schedule.filter((item) => item.predicted && item.kind === 'nap_start').length, 0)
  assert.equal(profile.bedtimeTarget, '19:30')
})

test('active final naps use the age-based bedtime boundary even before 17:00', () => {
  const state = buildDay(at('15:35'), [
    { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' },
    { id: 'nap', type: 'nap_start', at: at('13:45').toISOString(), by: 'Test caregiver' },
  ], { ...fixture, dateOfBirth: '2025-03-03', napPattern: 1 })
  assert.equal(state.shouldWake?.copy?.key, 'wake.bedtime')
  assert.equal(state.shouldWake?.by.toISOString(), at('15:30').toISOString())
})

test('a late short nap wake action agrees with its predicted bedtime boundary', () => {
  const state = buildDay(at('18:15'), [
    { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' },
    { id: 'nap', type: 'nap_start', at: at('17:45').toISOString(), by: 'Test caregiver' },
  ], fixture)
  const predictedWake = state.schedule.find((item) => item.predicted && item.kind === 'wake')
  assert.equal(state.shouldWake?.copy?.key, 'wake.bedtime')
  assert.equal(state.shouldWake?.by.toISOString(), at('18:15').toISOString())
  assert.equal(predictedWake?.time.toISOString(), state.shouldWake?.by.toISOString())
  assert.equal(state.nextAction.kind, 'wake')
})

test('newborn plans remain flexible without a fixed nap count', () => {
  const state = buildDay(at('08:00'), [], { ...fixture, dateOfBirth: '2026-08-25', napPattern: undefined })
  assert.equal(state.schedulePlan?.napCount, null)
  assert.equal(state.schedulePlan?.minNaps, null)
  assert.ok(state.schedule.filter((item) => item.predicted && item.kind === 'nap_start').length > 5)
})

test('existing full-feed-on-wake and active nap-cap rules remain available', () => {
  const wake: CareEvent = { id: 'wake', type: 'wake', at: at('08:00').toISOString(), by: 'Test caregiver' }
  assert.equal(buildDay(at('08:10'), [wake], fixture).nextAction.copy?.key, 'action.fullFeed')
  const nap: CareEvent = { id: 'nap', type: 'nap_start', at: at('09:00').toISOString(), by: 'Test caregiver' }
  const atCap = buildDay(at('11:00'), [wake, nap], fixture)
  assert.equal(atCap.shouldWake?.copy?.key, 'wake.napCap')
  assert.equal(atCap.schedule.find((item) => item.predicted && item.kind === 'wake')?.time.toISOString(), at('11:00').toISOString())
})
