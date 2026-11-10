import type { CareEvent } from './types'

const MIN = 60_000

/** Nap and feed totals that match the schedule engine (true-wake aware). */
export function tallyDay(events: CareEvent[] | undefined) {
  const sorted = [...(events || [])].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
  const effective = sorted.map((e) =>
    e.type === 'nap_end' && e.meta?.trueWake ? { ...e, at: e.meta.trueWake } : e
  )

  let sleepMin = 0
  let feedCount = 0
  let napCount = 0
  let poopCount = 0
  let napStart: string | undefined

  for (const e of effective) {
    if (e.type === 'wake') napStart = undefined
    else if (e.type === 'nap_start') napStart = e.at
    else if (e.type === 'nap_end') {
      if (napStart) {
        sleepMin += Math.max(0, Math.round((new Date(e.at).getTime() - new Date(napStart).getTime()) / MIN))
        napCount++
      }
      napStart = undefined
    } else if (e.type === 'feed') feedCount++
    else if (e.type === 'diaper') poopCount++
  }

  return { sleepMin, feedCount, napCount, poopCount, eventCount: sorted.length }
}
