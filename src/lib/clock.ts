/**
 * Timezone-aware wall-clock helpers. Every function takes an IANA zone; when
 * none is given, the browser's (or Node's) Intl zone is used.
 */

export function defaultZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** A usable zone: the given one if Intl accepts it, else the runtime default. */
export function resolveZone(zone?: string | null): string {
  if (zone) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: zone })
      return zone
    } catch { /* fall through */ }
  }
  return defaultZone()
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

function partsIn(d: Date, zone: string): Parts {
  const out: Record<string, number> = {}
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d)) {
    if (p.type !== 'literal') out[p.type] = Number(p.value)
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second }
}

/** Offset of `zone` from UTC at instant `d`, in ms (e.g. UTC−7 → −25_200_000). */
export function zoneOffsetMs(d: Date, zone: string): number {
  const p = partsIn(d, zone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(d.getTime() / 1000) * 1000
}

export function zonedHour(d: Date, zone = defaultZone()): number {
  return partsIn(d, resolveZone(zone)).hour
}

/** YYYY-MM-DD for instant `d` in `zone`. */
export function zonedDate(d: Date, zone = defaultZone()): string {
  const p = partsIn(d, resolveZone(zone))
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`
}

/**
 * The instant at which the wall clock in `zone` reads `hhmm` on `dateStr`.
 * For a time skipped by a DST jump, returns the instant just after the gap.
 */
export function zonedLocal(dateStr: string, hhmm: string, zone = defaultZone()): Date {
  const tz = resolveZone(zone)
  const [y, mo, d] = dateStr.split('-').map(Number)
  const [h, m] = hhmm.split(':').map(Number)
  const wall = Date.UTC(y, mo - 1, d, h, m)
  let t = wall - zoneOffsetMs(new Date(wall), tz)
  const second = wall - zoneOffsetMs(new Date(t), tz)
  if (second !== t) {
    const p = partsIn(new Date(second), tz)
    t = p.hour === h && p.minute === m ? second : Math.max(t, second)
  }
  return new Date(t)
}

export function applyClock(now: Date, hour: number, minute: number, ampm?: 'am' | 'pm', zone = defaultZone()): Date {
  const tz = resolveZone(zone)
  const dateStr = zonedDate(now, tz)
  const pad = (n: number) => String(n).padStart(2, '0')
  const at = (h: number, m: number) => zonedLocal(dateStr, `${pad(h)}:${pad(m)}`, tz)

  if (ampm === 'am') return at(hour === 12 ? 0 : hour, minute)
  if (ampm === 'pm') return at(hour === 12 ? 12 : hour + 12, minute)
  if (hour > 12) return at(hour, minute)

  const am = at(hour === 12 ? 0 : hour, minute)
  const pm = at(hour === 12 ? 12 : hour + 12, minute)
  const slack = 5 * 60_000
  const candidates = [am, pm].filter((d) => d.getTime() <= now.getTime() + slack)
  if (candidates.length === 0) return am.getTime() <= now.getTime() + slack ? am : pm
  return candidates.sort((a, b) => b.getTime() - a.getTime())[0]
}
