import type { CareEvent } from './types'
import { t, type Locale } from './i18n'

export type BreastSide = 'L' | 'R' | 'both'
export type FeedMode = 'breast' | 'bottle'

export type FeedDraft = {
  mode: FeedMode
  side: BreastSide
  minutes: number
  ounces: number
  probiotic: boolean
}

export const FEED_MIN_MINUTES = 5
export const FEED_MAX_MINUTES = 40
export const FEED_MIN_OZ = 0.5
export const FEED_MAX_OZ = 8
export const FEED_OZ_STEP = 0.5

export const BREAST_CHIPS = [10, 15, 20, 25, 30]
export const BOTTLE_CHIPS = [2, 2.5, 3, 3.5, 4, 5, 6]

export const DEFAULT_FEED_DRAFT: FeedDraft = {
  mode: 'breast',
  side: 'L',
  minutes: 15,
  ounces: 3,
  probiotic: false,
}

export function formatOz(n: number) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1)
}

export function draftFromMeta(meta?: CareEvent['meta']): FeedDraft {
  const bottle = meta?.side === 'bottle'
  const minutes = typeof meta?.durationMin === 'number'
    ? meta.durationMin
    : (meta?.leftMin || 0) + (meta?.rightMin || 0) || 15
  return {
    mode: bottle ? 'bottle' : 'breast',
    side: meta?.side === 'R' || meta?.side === 'both' ? meta.side : 'L',
    minutes: clamp(minutes, FEED_MIN_MINUTES, FEED_MAX_MINUTES),
    ounces: typeof meta?.ounces === 'number' ? clamp(meta.ounces, FEED_MIN_OZ, FEED_MAX_OZ) : 3,
    probiotic: !!meta?.probiotic,
  }
}

export function metaFromDraft(d: FeedDraft): NonNullable<CareEvent['meta']> {
  if (d.mode === 'bottle') {
    return {
      side: 'bottle',
      ounces: d.ounces,
      ...(d.probiotic ? { probiotic: true } : {}),
    }
  }
  return {
    side: d.side,
    durationMin: d.minutes,
    ...(d.probiotic ? { probiotic: true } : {}),
  }
}

export function formatFeedDetail(meta?: CareEvent['meta'], locale: Locale = 'en'): string {
  if (!meta) return ''
  const parts: string[] = []
  if (meta.leftMin != null || meta.rightMin != null) {
    if (meta.leftMin != null) parts.push(t(locale, 'event.leftDur', { n: meta.leftMin }))
    if (meta.rightMin != null) parts.push(t(locale, 'event.rightDur', { n: meta.rightMin }))
  } else if (meta.side === 'bottle') {
    parts.push(meta.ounces != null ? t(locale, 'event.bottleOz', { n: formatOz(meta.ounces) }) : t(locale, 'event.bottle'))
  } else if (meta.side === 'L') {
    parts.push(meta.durationMin != null ? t(locale, 'event.leftDur', { n: meta.durationMin }) : t(locale, 'event.left'))
  } else if (meta.side === 'R') {
    parts.push(meta.durationMin != null ? t(locale, 'event.rightDur', { n: meta.durationMin }) : t(locale, 'event.right'))
  } else if (meta.side === 'both') {
    parts.push(meta.durationMin != null ? t(locale, 'event.bothDur', { n: meta.durationMin }) : t(locale, 'event.both'))
  } else if (meta.durationMin != null) {
    parts.push(t(locale, 'event.mins', { n: meta.durationMin }))
  } else if (meta.ounces != null) {
    parts.push(t(locale, 'event.oz', { n: formatOz(meta.ounces) }))
  }
  if (meta.probiotic) parts.push(t(locale, 'event.probiotic'))
  return parts.join(' · ')
}

export function formatEventLabel(ev: Pick<CareEvent, 'type' | 'meta'>, locale: Locale = 'en'): string {
  const key = `event.${ev.type}`
  const base = t(locale, key)
  if (ev.type !== 'feed') return base === key ? ev.type.replace('_', ' ') : base
  const detail = formatFeedDetail(ev.meta, locale)
  return detail ? `${base} · ${detail}` : base
}

export function dayHasProbiotic(events: CareEvent[]): boolean {
  return events.some((e) => e.type === 'feed' && !!e.meta?.probiotic)
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}
