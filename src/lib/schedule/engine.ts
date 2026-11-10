import type { CareEvent, BabyProfile, NowState, CopyRef } from '../types'
import { formatEventLabel } from '../feed'
import { resolveZone, zonedDate, zonedHour, zonedLocal } from '../clock'
import { getAge, resolveSchedule, type AgeInfo, type SchedulePlan, type WakeWindow } from './profile'

const MIN = 60_000
const mins = (a: Date, b: Date) => Math.round((b.getTime() - a.getTime()) / MIN)
const add = (d: Date, m: number) => new Date(d.getTime() + m * MIN)

function ww(plan: SchedulePlan, period: number, shortBias: boolean): WakeWindow {
  const finalStretch = plan.napCount !== null && period >= plan.napCount
  const w = { ...(finalStretch && plan.finalWindow ? plan.finalWindow : plan.window) }
  if (shortBias) {
    // Recovery stays inside this age band's range, never the old 13-week floor.
    w.target = Math.max(w.short, w.target - 5)
  }
  return w
}

function finalWindow(plan: SchedulePlan): WakeWindow {
  return plan.finalWindow ?? plan.window
}

function plannedWindow(plan: SchedulePlan, period: number, shortBias: boolean, cursor: Date, bedtime: Date): WakeWindow {
  const w = ww(plan, period, shortBias)
  if (plan.napCount !== null && period < plan.napCount) {
    const remainingNaps = plan.napCount - period
    // Use the flexible range to make room for the selected pattern. If even the
    // shortest window will not fit, prediction stops below instead of crowding bed.
    const available = mins(cursor, bedtime) - remainingNaps * 60 - finalWindow(plan).short
    w.target = Math.max(w.short, Math.min(w.target, Math.floor(available / remainingNaps)))
  }
  return w
}

export type ScheduleItem = {
  time: Date
  label: string
  predicted: boolean
  by?: string
  eventId?: string
  kind?: string
  copy?: CopyRef
}

export function buildDay(
  now: Date,
  events: CareEvent[],
  profile: BabyProfile,
  prevSleep?: number
): NowState & { schedule: ScheduleItem[]; age: AgeInfo | null; schedulePlan: SchedulePlan | null; napCount: number } {
  const sorted = [...events].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  const effective = sorted.map((e) =>
    e.type === 'nap_end' && e.meta?.trueWake ? { ...e, at: e.meta.trueWake } : e
  ).sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())

  let lastWake: Date | undefined
  let lastNapEnd: Date | undefined
  let lastFeed: Date | undefined
  let currentNapStart: Date | undefined
  let daySleepMin = 0
  let feedCount = 0
  let napCount = 0
  let shortNapToday = false

  for (const e of effective) {
    const t = new Date(e.at)
    if (e.type === 'wake') { lastWake = t; currentNapStart = undefined }
    else if (e.type === 'nap_start') currentNapStart = t
    else if (e.type === 'nap_end') {
      if (currentNapStart) {
        const d = mins(currentNapStart, t)
        daySleepMin += Math.max(0, d)
        if (d < 45) shortNapToday = true
        napCount++
      }
      lastNapEnd = t; lastWake = t; currentNapStart = undefined
    } else if (e.type === 'feed') { lastFeed = t; feedCount++ }
  }

  const isAsleep = !!currentNapStart
  const status: NowState['status'] = isAsleep ? 'asleep' : lastWake ? 'awake' : 'unknown'
  const shortBias = shortNapToday || (typeof prevSleep === 'number' && prevSleep < 240)
  let awakeMin = 0
  if (!isAsleep && lastWake) awakeMin = Math.max(0, mins(lastWake, now))

  const zone = resolveZone(profile.timezone)
  const todayStr = zonedDate(now, zone)
  const age = getAge(profile, todayStr)
  const availablePlan = resolveSchedule(profile, todayStr)
  const schedulePlan = availablePlan?.napCount != null && profile.napPattern === undefined ? null : availablePlan
  const timeline: NowState['timeline'] = effective.map((e) => ({
    time: new Date(e.at), label: formatEventLabel(e), predicted: false, by: e.by,
  }))
  const schedule: ScheduleItem[] = effective.map((e) => ({
    time: new Date(e.at), label: formatEventLabel(e), predicted: false, by: e.by, eventId: e.id, kind: e.type,
  }))
  if (!schedulePlan) return {
    status, lastWake, lastNapEnd, lastFeed, currentNapStart, awakeMin,
    wakeWindowMin: { short: 0, target: 0, long: 0 },
    nextAction: { kind: 'none', label: 'Set up the age-based schedule', urgency: 'later', copy: { key: 'action.setupSchedule' } },
    guidance: [], timeline, schedule, daySleepMin, feedCount, napCount, age, schedulePlan: null,
  }

  const lastStretch = zonedHour(now, zone) >= 17 || (schedulePlan.napCount !== null && napCount + (isAsleep ? 1 : 0) >= schedulePlan.napCount)
  const bedtime = zonedLocal(todayStr, profile.bedtimeTarget, zone)
  const morning = zonedLocal(todayStr, profile.morningTarget, zone)
  // These event times are a wake / nap-start proxy. They do not establish the
  // source's exact out-of-crib / back-in-crib wake-window measurements.
  const band = plannedWindow(schedulePlan, napCount, shortBias, lastWake ?? morning, bedtime)
  const bedtimeWindow = finalWindow(schedulePlan).short
  const suggestBedtime = (wake: Date) => new Date(Math.max(now.getTime(), Math.min(
    bedtime.getTime(), add(wake, finalWindow(schedulePlan).long).getTime(),
  )))
  const describeBedtime = (time: Date): { label: string; copy: CopyRef } => {
    if (time.getTime() === bedtime.getTime()) return {
      label: `Bedtime target (${profile.bedtimeTarget})`, copy: { key: 'sched.bedtime', params: { time: profile.bedtimeTarget } },
    }
    const clock = new Intl.DateTimeFormat('en-GB', {
      timeZone: profile.timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(time)
    return { label: `Bedtime suggestion (${clock})`, copy: { key: 'sched.bedtimeAdjusted', params: { time: clock } } }
  }

  let shouldWake: NowState['shouldWake']
  if (isAsleep && currentNapStart) {
    const napMin = mins(currentNapStart, now)
    if (napMin >= 120) shouldWake = { by: now, reason: 'Nap cap (~2h) - consider waking so the day does not slide.', copy: { key: 'wake.napCap' } }
    if (lastStretch) {
      const wakeForBed = add(bedtime, -bedtimeWindow)
      if (now >= wakeForBed) shouldWake = { by: wakeForBed, reason: 'Wake for bedtime feed and routine - protect the night.', copy: { key: 'wake.bedtime' } }
    }
  } else if (!lastWake) {
    if (now >= morning) shouldWake = { by: morning, reason: `Wake by ${profile.morningTarget} so today's naps do not drift late.`, copy: { key: 'wake.morning', params: { time: profile.morningTarget } } }
  }

  let nextAction: NowState['nextAction'] = { kind: 'none', label: 'Log the morning wake to start the day', urgency: 'later', copy: { key: 'action.startDay' } }
  const guidance: CopyRef[] = []

  if (shouldWake) {
    nextAction = { kind: 'wake', label: shouldWake.reason, at: shouldWake.by, urgency: 'now', copy: shouldWake.copy }
  } else if (isAsleep && currentNapStart) {
    const napMin = mins(currentNapStart, now)
    nextAction = { kind: 'none', label: `Napping - ${napMin} min`, urgency: 'later', copy: { key: 'action.napping', params: { m: napMin } } }
    if (napMin >= 90) guidance.push({ key: 'guide.longNap' })
  } else if (lastWake) {
    const sinceFeed = lastFeed ? mins(lastFeed, now) : 999
    const allNapsTaken = schedulePlan.napCount !== null && napCount >= schedulePlan.napCount
    const noRoomForNap = add(now, 60 + bedtimeWindow) > bedtime
    if ((sinceFeed >= 150 || (!lastFeed && awakeMin < 20)) && awakeMin < 25) {
      nextAction = { kind: 'feed', label: 'Full feed on wake', urgency: 'now', copy: { key: 'action.fullFeed' } }
    } else if (allNapsTaken || noRoomForNap) {
      const suggestion = suggestBedtime(lastWake)
      nextAction = { kind: 'bedtime', ...describeBedtime(suggestion), at: suggestion, urgency: now >= suggestion || awakeMin >= band.target ? 'now' : 'soon' }
    } else if (awakeMin >= band.short) {
      if (awakeMin >= band.long) {
        nextAction = { kind: 'nap', label: 'Past outer edge - start wind-down now', urgency: 'now', copy: { key: 'action.pastEdge' } }
        guidance.push({ key: 'guide.pastLong' })
      } else if (awakeMin >= band.target) {
        nextAction = { kind: 'wind_down', label: 'Target window - start wind-down', at: add(lastWake, band.target), urgency: 'now', copy: { key: 'action.targetWind' } }
      } else {
        const m = Math.max(0, band.target - awakeMin)
        nextAction = { kind: 'wind_down', label: `Wind-down in ~${m} min`, at: add(lastWake, band.target), urgency: 'soon', copy: { key: 'action.windDownIn', params: { m } } }
      }
    } else {
      nextAction = { kind: 'none', label: `Awake ${awakeMin} min - window ${band.short}-${band.long}`, urgency: 'later', copy: { key: 'action.awakeWindow', params: { awake: awakeMin, short: band.short, long: band.long } } }
    }
    if (shortBias) guidance.push(prevSleep && prevSleep < 240 ? { key: 'guide.lowYesterday' } : { key: 'guide.shortNap' })
    if (lastStretch) guidance.push({ key: 'guide.evening' })
  }

  let cursor: Date
  let period: number

  if (isAsleep && currentNapStart) {
    const typical = 60
    const elapsed = mins(currentNapStart, now)
    const remaining = Math.max(15, typical - elapsed)
    const estimatedEnd = add(now, remaining)
    const wakeForBed = add(bedtime, -bedtimeWindow)
    const latestPredictedEnd = now > wakeForBed ? now : wakeForBed
    const predictedEnd = shouldWake ? now : estimatedEnd > latestPredictedEnd ? latestPredictedEnd : estimatedEnd
    const n = napCount + 1
    schedule.push({ time: predictedEnd, label: `Wake from nap ${n} (est.)`, predicted: true, kind: 'wake', copy: { key: 'sched.wakeNapEst', params: { n } } })
    schedule.push({ time: predictedEnd, label: 'Feed on wake', predicted: true, kind: 'feed', copy: { key: 'sched.feedOnWake' } })
    cursor = predictedEnd
    period = napCount + 1
  } else if (lastWake) {
    cursor = lastWake
    period = napCount
  } else {
    schedule.push({ time: morning, label: 'Morning wake (target)', predicted: true, kind: 'wake', copy: { key: 'sched.morningWake' } })
    schedule.push({ time: morning, label: 'Full feed on wake', predicted: true, kind: 'feed', copy: { key: 'sched.fullFeed' } })
    cursor = morning
    period = 0
  }

  for (let i = 0; i < 12; i++) {
    if (schedulePlan.napCount !== null && period >= schedulePlan.napCount) break
    const stretch = zonedHour(cursor, zone) >= 17
    const w = plannedWindow(schedulePlan, period, shortBias, cursor, bedtime)
    // A missed window moves the prediction forward; never offer a nap in the past.
    const napStart = new Date(Math.max(add(cursor, w.target).getTime(), now.getTime()))
    const napLen = stretch ? 45 : 60
    const napEnd = add(napStart, napLen)
    if (napEnd.getTime() > bedtime.getTime() - bedtimeWindow * MIN) break

    const n = period + 1
    schedule.push({ time: napStart, label: `Nap ${n} · ~${w.target}m awake`, predicted: true, kind: 'nap_start', copy: { key: 'sched.napAwake', params: { n, m: w.target } } })
    schedule.push({ time: napEnd, label: `Wake from nap ${n}`, predicted: true, kind: 'wake', copy: { key: 'sched.wakeNap', params: { n } } })
    schedule.push({ time: napEnd, label: 'Feed on wake', predicted: true, kind: 'feed', copy: { key: 'sched.feedOnWake' } })
    cursor = napEnd
    period++
  }

  const predictedBedtime = period > 0 || lastWake ? suggestBedtime(cursor) : bedtime
  schedule.push({
    time: predictedBedtime,
    ...describeBedtime(predictedBedtime),
    predicted: true,
    kind: 'bedtime',
  })

  if (nextAction.at) {
    const already = schedule.some(
      (s) => Math.abs(s.time.getTime() - nextAction.at!.getTime()) < 60000 && s.label === nextAction.label
    )
    if (!already) {
      schedule.push({ time: nextAction.at, label: nextAction.label, predicted: true, kind: nextAction.kind, copy: nextAction.copy })
    }
  }

  schedule.sort((a, b) => a.time.getTime() - b.time.getTime())

  return {
    status, lastWake, lastNapEnd, lastFeed, currentNapStart, awakeMin,
    wakeWindowMin: band, nextAction, guidance, timeline, daySleepMin, feedCount, shouldWake, schedule,
    age, schedulePlan, napCount,
  }
}
