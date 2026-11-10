import type { CareEvent, EventType } from './types'
import { applyClock, defaultZone } from './clock'

export type DraftEvent = {
  type: EventType
  at: Date
  meta?: CareEvent['meta']
}

function fold(s: string) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
}

const ONES: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
  cero: 0, un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7,
  ocho: 8, nueve: 9, diez: 10, once: 11, doce: 12, trece: 13, catorce: 14, quince: 15,
  dieciseis: 16, diecisiete: 17, dieciocho: 18, diecinueve: 19,
  veinticinco: 25, treintaicinco: 35, treintaycinco: 35,
}

const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50,
  veinte: 20, treinta: 30, cuarenta: 40, cincuenta: 50,
}

const HOUR_WORDS = 'one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce'
const TENS_WORDS = 'twenty|thirty|forty|fifty|veinte|treinta|cuarenta|cincuenta'
const ONES_WORDS = 'one|two|three|four|five|six|seven|eight|nine|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve'

const UNIT_AFTER = /^(?:\s*(?:minutes?|mins?|minutos?|min\b|ounces?|onzas?|oz\b))/i

function wordsToNumbers(s: string) {
  let out = s
  out = out.replace(/\b(two|dos)\s+(and\s+a\s+half|y\s+media|y\s+medio)\b/g, '2.5')
  out = out.replace(/\b(one|un|una)\s+(and\s+a\s+half|y\s+media|y\s+medio)\b/g, '1.5')
  out = out.replace(/\b(three|tres)\s+(and\s+a\s+half|y\s+media|y\s+medio)\b/g, '3.5')
  out = out.replace(/\b(four|cuatro)\s+(and\s+a\s+half|y\s+media|y\s+medio)\b/g, '4.5')
  out = out.replace(/\b(\d+)\s+and\s+a\s+half\b/g, '$1.5')
  out = out.replace(/\b(\d+)\s+y\s+medi[oa]\b/g, '$1.5')
  out = out.replace(new RegExp(`\\b(${TENS_WORDS})\\s+(${ONES_WORDS})\\b`, 'g'),
    (_, ten, one) => String((TENS[ten] || 0) + (ONES[one] || 0)))
  out = out.replace(new RegExp(`\\b(${TENS_WORDS})\\b`, 'g'), (m) => String(TENS[m]))
  out = out.replace(/\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|cero|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinticinco|treintaicinco|treintaycinco)\b/g,
    (m) => ONES[m] != null ? String(ONES[m]) : m)
  return out
}

/** "three twenty five" / "tres y veinticinco" → 3:25 before generic number swap. */
function spokenClocks(s: string) {
  let out = s
  out = out.replace(new RegExp(`\\b(${HOUR_WORDS})\\s+(?:y\\s+)?(${TENS_WORDS})\\s+(${ONES_WORDS})\\b`, 'g'),
    (_, h, ten, one) => `${ONES[h]}:${String((TENS[ten] || 0) + (ONES[one] || 0)).padStart(2, '0')}`)
  out = out.replace(new RegExp(`\\b(${HOUR_WORDS})\\s+(?:y\\s+)?(${TENS_WORDS})\\b`, 'g'),
    (_, h, ten) => `${ONES[h]}:${String(TENS[ten] || 0).padStart(2, '0')}`)
  return out
}

/** Phone ASR often drops the colon: "325" → "3:25", "1025" → "10:25". Skip durations/ounces. */
function expandDigitTimes(s: string) {
  return s.replace(/\b(\d{3,4})\b/g, (raw, digits: string, offset: number) => {
    const after = s.slice(offset + raw.length)
    if (UNIT_AFTER.test(after)) return raw
    if (digits.length === 3) {
      const h = Number(digits[0])
      const min = Number(digits.slice(1))
      if (h >= 1 && h <= 9 && min <= 59) return `${h}:${digits.slice(1)}`
    }
    if (digits.length === 4) {
      const h = Number(digits.slice(0, 2))
      const min = Number(digits.slice(2))
      if (h >= 1 && h <= 23 && min <= 59) return `${h}:${digits.slice(2)}`
    }
    return raw
  })
}

function stripHedges(s: string) {
  return s
    .replace(/\b(um|uh|uhh|erm|hmm|like|you know|i mean|kind of|sort of|este|eh|esteve|bueno)\b/g, ' ')
    .replace(/\b(roughly|about|around|approximately|unos|unas|como|aproximadamente|mas o menos|más o menos|tipo|cerca de)\b/g, ' ')
}

/** Collapse runaway ASR repeats: "wake up wake up … at 3:30 p.m." → "wake up at 3:30 p.m." */
export function collapseRepeatedPhrases(s: string): string {
  let out = s.replace(/\s+/g, ' ').trim()
  if (!out) return out
  for (let pass = 0; pass < 4; pass++) {
    const before = out
    out = out.replace(/\b(\w+(?:\s+\w+){3})(?:\s+\1\b)+/gi, '$1')
    out = out.replace(/\b(\w+(?:\s+\w+){2})(?:\s+\1\b)+/gi, '$1')
    out = out.replace(/\b(\w+\s+\w+)(?:\s+\1\b)+/gi, '$1')
    out = out.replace(/\b(\w+)(?:\s+\1\b)+/gi, '$1')
    if (out === before) break
  }
  out = out.replace(
    /(?:\bwake\s+up\s+at\s+\d{1,2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?\s*){2,}/gi,
    (m) => {
      const parts = m.match(/\bwake\s+up\s+at\s+\d{1,2}(?::\d{2})?(?:\s*[ap]\.?m\.?)?/gi) || []
      return (parts[parts.length - 1] || m).trim() + ' '
    },
  )
  // "nap 3:25 nap 3:25" — colon times are not \w+ so the pass above misses them
  out = out.replace(
    /\b((?:nap|siesta|wake(?:\s+up)?|tummy(?:\s+time)?|feed|toma|pecho|poop(?:ed)?|popo)\s+\d{1,2}:\d{2}(?:\s*[ap]\.?m\.?)?)(?:\s+\1\b)+/gi,
    '$1',
  )
  return out.replace(/\s+/g, ' ').trim()
}

function normalizeTimes(s: string) {
  let out = s
  out = out.replace(/\b(\d{1,2})\s*o'?clock\b/g, '$1:00')
  out = out.replace(/\bhalf\s+past\s+(\d{1,2})\b/g, (_, h) => `${h}:30`)
  out = out.replace(/\b(\d{1,2})\s+y\s+media\b/g, (_, h) => `${h}:30`)
  out = out.replace(/\b(at|a\s+las)\s+(\d{1,2})\s+(\d{2})\b/g, '$1 $2:$3')
  out = out.replace(/\b(\d{1,2})\.(\d{2})\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/g, '$1:$2 $3')
  out = out.replace(/\b(\d{1,2})\s+(\d{2})\s*(a\.?m\.?|p\.?m\.?|am|pm)\b/g, '$1:$2 $3')
  return out
}

export function normalizeSpeech(raw: string) {
  let s = fold(raw)
  s = stripHedges(s)
  s = spokenClocks(s)
  s = wordsToNumbers(s)
  s = s.replace(/[,;!?]/g, ' ')
  s = s.replace(/\b(de la|in the)\s+(manana|morning)\b/g, 'am')
  s = s.replace(/\b(de la|in the)\s+(tarde|afternoon|evening|noche|night)\b/g, 'pm')
  s = expandDigitTimes(s)
  s = normalizeTimes(s)
  s = collapseRepeatedPhrases(s)
  s = s.replace(/\s+/g, ' ').trim()
  return s
}

/** Cleaned line for the review sheet so caregivers do not see ASR stutter. */
export function displayTranscript(raw: string) {
  return normalizeSpeech(raw)
}

type Clock = { hour: number; minute: number; ampm?: 'am' | 'pm'; index: number; length: number }

function findClocks(text: string): Clock[] {
  const out: Clock[] = []
  const re = /\b(?:a\s+las\s+|at\s+)?(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?|am|pm)?\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const hour = Number(m[1])
    const minute = m[2] != null ? Number(m[2]) : 0
    if (hour > 23 || minute > 59) continue
    const rawAmpm = (m[3] || '').replace(/\./g, '')
    const ampm = rawAmpm.startsWith('p') ? 'pm' : rawAmpm.startsWith('a') ? 'am' : undefined
    const prefix = text.slice(Math.max(0, m.index - 8), m.index)
    const explicit = m[2] != null || !!ampm || /(?:a las|at)\s*$/.test(prefix)
    if (!explicit) continue
    out.push({ hour, minute, ampm, index: m.index, length: m[0].length })
  }
  return out
}

function findRelative(text: string, now: Date): Date | null {
  const ago = text.match(/\b(?:hace\s+)?(\d+)\s*(?:minutes?|mins?|minutos?)\s*(?:ago|atras|antes)?\b/)
  const hace = text.match(/\bhace\s+(\d+)\s*(?:minutes?|mins?|minutos?)\b/)
  const n = Number((hace || ago)?.[1] || '')
  if (!n) return null
  if (hace || (ago && /ago|atras|antes/.test(ago[0]))) {
    return new Date(now.getTime() - n * 60_000)
  }
  return null
}

function nearestClock(clocks: Clock[], index: number, now: Date, zone: string): Date | null {
  if (clocks.length === 0) return null
  let best = clocks[0]
  let bestDist = Math.abs(clocks[0].index - index)
  for (const c of clocks) {
    const d = Math.abs(c.index - index)
    if (d < bestDist) { best = c; bestDist = d }
  }
  if (bestDist > 56) return null
  return applyClock(now, best.hour, best.minute, best.ampm, zone)
}

function takeMinutes(chunk: string): number | undefined {
  const m = chunk.match(/(\d+(?:\.\d+)?)\s*(?:minutes?|mins?|minutos?|min\b)/)
  if (m) return Math.round(Number(m[1]))
  return undefined
}

function takeOunces(chunk: string): number | undefined {
  const m = chunk.match(/(\d+(?:\.\d+)?)\s*(?:ounces?|onzas?|oz\b)/)
  if (m) return Number(m[1])
  const m2 = chunk.match(/(?:bottle|biberon)\s+(?:of\s+)?(\d+(?:\.\d+)?)/)
  if (m2) return Number(m2[1])
  return undefined
}

function sideMinutes(text: string, side: 'left' | 'right'): number | undefined {
  const word = side === 'left' ? '(?:left|izquierd[oa])' : '(?:right|derech[oa])'
  const unit = '(?:minutes?|mins?|minutos?|min\\b)?'
  const breast = '(?:breast|pecho|side|lado|boob)'
  const after = new RegExp(word + '(?:\\s+' + breast + ')?\\s+(?:for\\s+)?(\\d+(?:\\.\\d+)?)\\s*' + unit)
  const before = new RegExp('(\\d+(?:\\.\\d+)?)\\s*' + unit + '\\s+(?:(?:on\\s+the|del|de\\s+la|de|for)\\s+)?(?:' + breast + '\\s+)?' + word)
  const forOn = new RegExp('for\\s+(\\d+(?:\\.\\d+)?)\\s*' + unit + '\\s+(?:on\\s+the\\s+)?' + word)
  const m = text.match(after) || text.match(before) || text.match(forOn)
  if (m) return Math.round(Number(m[1]))
  return undefined
}

function has(text: string, re: RegExp) {
  return re.test(text)
}

function feedMeta(text: string): CareEvent['meta'] {
  const leftMin = sideMinutes(text, 'left')
  const rightMin = sideMinutes(text, 'right')
  const oz = takeOunces(text)
  const bottle = has(text, /\b(bottle|biberon|formula|oz|onzas?|ounces?)\b/)
  const both = has(text, /\b(both|ambos|los dos|las dos)\b/)
  const left = has(text, /\b(left|izquierd[oa])\b/)
  const right = has(text, /\b(right|derech[oa])\b/)
  const probiotic = has(text, /\b(probiotic|probiotico)s?\b/)
  const durationMin = takeMinutes(text)

  const meta: NonNullable<CareEvent['meta']> = {}
  if (probiotic) meta.probiotic = true

  if (bottle && !left && !right && !both) {
    meta.side = 'bottle'
    if (oz != null) meta.ounces = oz
    return meta
  }
  if (leftMin != null || rightMin != null) {
    if (leftMin != null) meta.leftMin = leftMin
    if (rightMin != null) meta.rightMin = rightMin
    meta.side = leftMin != null && rightMin != null ? 'both' : leftMin != null ? 'L' : 'R'
    meta.durationMin = (leftMin || 0) + (rightMin || 0)
    return meta
  }
  if (both || (left && right)) {
    meta.side = 'both'
    if (durationMin != null) meta.durationMin = durationMin
    return meta
  }
  if (left) {
    meta.side = 'L'
    if (durationMin != null) meta.durationMin = durationMin
    return meta
  }
  if (right) {
    meta.side = 'R'
    if (durationMin != null) meta.durationMin = durationMin
    return meta
  }
  if (oz != null) {
    meta.side = 'bottle'
    meta.ounces = oz
    return meta
  }
  if (durationMin != null) meta.durationMin = durationMin
  return Object.keys(meta).length ? meta : undefined
}

type Hit = { type: EventType; index: number; length: number }

function findHits(text: string): Hit[] {
  const specs: { type: EventType; re: RegExp }[] = [
    { type: 'nap_end', re: /\b(nap ended|end(?:ed)?(?:\s+the)?\s+nap|woke(?: up)? from (?:the )?nap|finished napp?ing|got (?:her )?up from (?:the )?nap|termino(?:\s+la)?\s+siesta|acabo(?:\s+la)?\s+siesta|se desperto de la siesta|fin de siesta|ya termino la siesta|fin(?:alizo)?(?:\s+la)?\s+siesta)\b/g },
    { type: 'nap_start', re: /\b(nap started|started (?:a |the )?nap|started napp?ing|down for (?:a )?nap|put her down|went down(?: for (?:a )?nap)?|she(?:'s| is) asleep|laid her down|siesta(?:\s+empezo)?|empezo(?:\s+la)?\s+siesta|se durmio|se quedo dormida|a dormir|inicio de siesta|la echos? a dormir|hora de siesta|le toca siesta|ya duerme|napping|nap)\b/g },
    { type: 'tummy', re: /\b(tummy(?: time)?|tiempo boca abajo|boca abajo|pancita)\b/g },
    { type: 'diaper', re: /\b(dirty diaper|poop(?:ed|y)?|bowel movement|hizo popo|popo|panal sucio|hizo del bano)\b/g },
    { type: 'wake', re: /\b(wake\s+up|woke\s+up|morning wake|she(?:'s| is) up|just woke|ya esta despierta|se desperto|ya desperto|despertar(?: de la manana)?|ya desperto|esta despierta)\b/g },
    { type: 'feed', re: /\b(breastfeed(?:ing)?|\bbreast\b|nurs(?:e|ed|ing)|amamant\w*|de mamar|de comer|bottle|biberon|formula|pecho|lactancia|tetada|toma|feed(?:ing)?|fed her|just fed|ounces?|onzas?|leche)\b/g },
  ]
  const hits: Hit[] = []
  for (const spec of specs) {
    spec.re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = spec.re.exec(text))) {
      hits.push({ type: spec.type, index: m.index, length: m[0].length })
    }
  }
  hits.sort((a, b) => a.index - b.index || b.length - a.length)

  const kept: Hit[] = []
  for (const h of hits) {
    const end = h.index + h.length
    const overlapIdx = kept.findIndex((k) => h.index < k.index + k.length && end > k.index)
    if (overlapIdx >= 0) {
      if (h.length > kept[overlapIdx].length) kept[overlapIdx] = h
      continue
    }
    const prev = kept[kept.length - 1]
    if (prev && prev.type === h.type && h.type !== 'diaper' && (h.type === 'feed' || h.index - prev.index < 18)) continue
    kept.push(h)
  }
  return kept
}

/** Last-resort: a lone keyword still means an event (nap / tummy / poop / wake / feed). */
function looseHits(text: string): Hit[] {
  const rows: { type: EventType; re: RegExp }[] = [
    { type: 'nap_end', re: /\b(end(?:ed)?|termino|acabo|fin)\b/ },
    { type: 'nap_start', re: /\b(nap|siesta|napping|dormir|durmio|asleep)\b/ },
    { type: 'tummy', re: /\b(tummy|pancita)\b/ },
    { type: 'diaper', re: /\b(poop\w*|popo|panal)\b/ },
    { type: 'wake', re: /\b(wake|woke|despert\w*)\b/ },
    { type: 'feed', re: /\b(feed|fed|breast|pecho|bottle|biberon|toma|leche)\b/ },
  ]
  // If they said "end" plus nap/siesta, prefer nap_end over a second nap_start.
  const endish = /\b(end(?:ed)?|termino|acabo|fin)\b/.test(text) && /\b(nap|siesta)\b/.test(text)
  const found: Hit[] = []
  for (const row of rows) {
    if (endish && row.type === 'nap_start') continue
    row.re.lastIndex = 0
    const m = row.re.exec(text)
    if (m) found.push({ type: row.type, index: m.index, length: m[0].length })
  }
  return found
}

/**
 * Turn a spoken or typed log into one or more care events.
 * Understands English and Spanish in the same utterance.
 * Tolerant of short phrases ("nap at 3:25"), digit times ("325"), and ASR repeats.
 */
export function parseCareSpeech(transcript: string, now = new Date(), zone = defaultZone()): DraftEvent[] {
  const text = normalizeSpeech(transcript)
  if (!text) return []

  const clocks = findClocks(text)
  const relative = findRelative(text, now)
  let hits = findHits(text)
  if (hits.length === 0) hits = looseHits(text)
  const probioticOnly = has(text, /\b(probiotic|probiotico)s?\b/) && !hits.some((h) => h.type === 'feed')

  const events: DraftEvent[] = []

  function timeFor(index: number): Date {
    return nearestClock(clocks, index, now, zone) || (clocks.length === 1
      ? applyClock(now, clocks[0].hour, clocks[0].minute, clocks[0].ampm, zone)
      : null) || relative || now
  }

  if (hits.length === 0) {
    if (probioticOnly) {
      events.push({ type: 'feed', at: relative || now, meta: { probiotic: true } })
    }
    return events
  }

  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]
    const next = hits[i + 1]
    const chunk = text.slice(h.index, next ? next.index : text.length)
    const at = timeFor(h.index)
    if (h.type === 'feed') {
      const nearby = text.slice(Math.max(0, h.index - 20), next ? next.index : text.length)
      events.push({ type: 'feed', at, meta: feedMeta(nearby + ' ' + chunk) })
    } else {
      events.push({ type: h.type, at })
    }
  }

  if (probioticOnly) {
    const feed = events.find((e) => e.type === 'feed')
    if (feed) feed.meta = { ...feed.meta, probiotic: true }
    else events.push({ type: 'feed', at: relative || now, meta: { probiotic: true } })
  } else if (has(text, /\b(probiotic|probiotico)s?\b/)) {
    const feed = events.find((e) => e.type === 'feed')
    if (feed) feed.meta = { ...feed.meta, probiotic: true }
  }

  // Same type within 90s is almost always ASR stutter, not two real events
  const deduped: DraftEvent[] = []
  for (const e of events) {
    const prev = deduped[deduped.length - 1]
    if (prev && prev.type === e.type && Math.abs(prev.at.getTime() - e.at.getTime()) < 90_000) continue
    deduped.push(e)
  }
  return deduped
}
