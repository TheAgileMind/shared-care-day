import { test } from 'node:test'
import assert from 'node:assert/strict'
import { displayTranscript, parseCareSpeech } from './voiceParse.ts'
import { messages } from './i18n.ts'
import { formatEventLabel } from './feed.ts'

const ZONE = 'America/Chicago'
const NOW = new Date('2026-08-16T19:38:00.000Z') // 2:38 PM in America/Chicago (CDT, UTC−5)
const LATE = new Date('2026-08-17T20:34:00.000Z') // 3:34 PM Chicago — after a 3:25 nap

test('nap started at 2:35 PM', () => {
  const ev = parseCareSpeech('nap started at 2:35 PM', NOW, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), '2026-08-16T19:35:00.000Z')
})

test('nap at 3:25 without the word started', () => {
  const ev = parseCareSpeech('nap at 3:25', LATE, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), '2026-08-17T20:25:00.000Z')
})

test('digit time 325 means 3:25', () => {
  const ev = parseCareSpeech('nap 325', LATE, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), '2026-08-17T20:25:00.000Z')
})

test('phone stutter nap nap nap 325 still logs one nap', () => {
  const ev = parseCareSpeech('nap nap nap nap nap 325 nap 325', LATE, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), '2026-08-17T20:25:00.000Z')
})

test('spoken three twenty five is 3:25', () => {
  const ev = parseCareSpeech('nap three twenty five', LATE, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), '2026-08-17T20:25:00.000Z')
})

test('bare nap with no time uses now', () => {
  const ev = parseCareSpeech('nap', LATE, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), LATE.toISOString())
})

test('Spanish siesta 325', () => {
  const ev = parseCareSpeech('siesta 325', LATE, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), '2026-08-17T20:25:00.000Z')
})

test('Spanish a dormir a las 3:25', () => {
  const ev = parseCareSpeech('a dormir a las 3:25', LATE, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), '2026-08-17T20:25:00.000Z')
})

test('displayTranscript collapses ASR stutter', () => {
  assert.equal(displayTranscript('nap nap nap nap nap 325 nap 325'), 'nap 3:25')
})

test('breastfeeding left 15 minutes right 10 minutes is one feed', () => {
  const ev = parseCareSpeech('Breastfeeding. Left breast, roughly 15 minutes. Right breast, roughly ten minutes.', NOW, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'feed')
  assert.equal(ev[0].meta?.side, 'both')
  assert.equal(ev[0].meta?.leftMin, 15)
  assert.equal(ev[0].meta?.rightMin, 10)
  assert.equal(ev[0].meta?.durationMin, 25)
})

test('two events in one utterance keep their own times', () => {
  const ev = parseCareSpeech('nap started at 2:35 PM. breastfeeding left 15 minutes right 10 minutes', NOW, ZONE)
  assert.equal(ev.length, 2)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), '2026-08-16T19:35:00.000Z')
  assert.equal(ev[1].type, 'feed')
  assert.equal(ev[1].meta?.leftMin, 15)
  assert.equal(ev[1].meta?.rightMin, 10)
})

test('Spanish siesta and dual pecho', () => {
  const ev = parseCareSpeech('La siesta empezó a las 2:35. Pecho izquierdo 15 minutos, derecho 10.', NOW, ZONE)
  assert.equal(ev.length, 2)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), '2026-08-16T19:35:00.000Z')
  assert.equal(ev[1].type, 'feed')
  assert.equal(ev[1].meta?.leftMin, 15)
  assert.equal(ev[1].meta?.rightMin, 10)
})

test('bottle ounces and probiotic', () => {
  const ev = parseCareSpeech('bottle 3 ounces and I gave her the probiotic', NOW, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'feed')
  assert.equal(ev[0].meta?.side, 'bottle')
  assert.equal(ev[0].meta?.ounces, 3)
  assert.equal(ev[0].meta?.probiotic, true)
})

test('Spanish biberon and probiotico', () => {
  const ev = parseCareSpeech('Biberón de 2 y medio onzas y le di el probiótico', NOW, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].meta?.side, 'bottle')
  assert.equal(ev[0].meta?.ounces, 2.5)
  assert.equal(ev[0].meta?.probiotic, true)
})

test('bare 2:35 without am/pm uses afternoon when now is afternoon', () => {
  const ev = parseCareSpeech('nap started at 2:35', NOW, ZONE)
  assert.equal(ev[0].at.toISOString(), '2026-08-16T19:35:00.000Z')
})

test('wake and tummy time', () => {
  const ev = parseCareSpeech('she woke up at 8:00 am then tummy time', NOW, ZONE)
  assert.ok(ev.some((e) => e.type === 'wake'))
  assert.ok(ev.some((e) => e.type === 'tummy'))
})

test('English and Spanish poop phrases create diaper events', () => {
  const english = parseCareSpeech('Sam pooped at 2:35 PM', NOW, ZONE)
  assert.equal(english.length, 1)
  assert.equal(english[0].type, 'diaper')
  assert.equal(english[0].at.toISOString(), '2026-08-16T19:35:00.000Z')

  const spanish = parseCareSpeech('Sam hizo popó a las 2:35', NOW, ZONE)
  assert.equal(spanish.length, 1)
  assert.equal(spanish[0].type, 'diaper')
  assert.equal(spanish[0].at.toISOString(), '2026-08-16T19:35:00.000Z')
})

test('repeated poop speech logs one event', () => {
  const ev = parseCareSpeech('poop poop poop 325 poop 325', LATE, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'diaper')
  assert.equal(ev[0].at.toISOString(), '2026-08-17T20:25:00.000Z')
  assert.equal(displayTranscript('poop poop poop 325 poop 325'), 'poop 3:25')
})

test('separately timed poop phrases create separate events', () => {
  const ev = parseCareSpeech('3:25 poop, 4:30 PM poop', LATE, ZONE)
  assert.deepEqual(
    ev.map((event) => ({ type: event.type, at: event.at.toISOString() })),
    [
      { type: 'diaper', at: '2026-08-17T20:25:00.000Z' },
      { type: 'diaper', at: '2026-08-17T21:30:00.000Z' },
    ],
  )
})

test('end nap Spanish is only nap_end, not also a start', () => {
  const ev = parseCareSpeech('se despertó de la siesta a las 3:10 pm', NOW, ZONE)
  assert.equal(ev.length, 1)
  assert.equal(ev[0].type, 'nap_end')
})

test('de la tarde is afternoon even in the morning', () => {
  const morning = new Date('2026-08-16T14:10:00.000Z') // 9:10 AM Chicago
  const ev = parseCareSpeech('La siesta empezó a las 2:35 de la tarde', morning, ZONE)
  assert.equal(ev[0].type, 'nap_start')
  assert.equal(ev[0].at.toISOString(), '2026-08-16T19:35:00.000Z')
})

test('le di de mamar is a feed', () => {
  const ev = parseCareSpeech('Le di de mamar 12 minutos del pecho izquierdo', NOW, ZONE)
  assert.equal(ev[0].type, 'feed')
  assert.equal(ev[0].meta?.side, 'L')
  assert.equal(ev[0].meta?.leftMin, 12)
})

test('empty and nonsense yield nothing', () => {
  assert.deepEqual(parseCareSpeech('hello there', NOW, ZONE), [])
  assert.deepEqual(parseCareSpeech('', NOW, ZONE), [])
})

test('Spanish event labels', () => {
  assert.equal(
    formatEventLabel({ type: 'feed', meta: { leftMin: 15, rightMin: 10, side: 'both' } }, 'es'),
    'Toma · Izquierdo · 15 min · Derecho · 10 min',
  )
})

test('poop event labels are explicit in both languages', () => {
  assert.equal(formatEventLabel({ type: 'diaper' }, 'en'), 'Poop')
  assert.equal(formatEventLabel({ type: 'diaper' }, 'es'), 'Popó')
})

test('every English key has a Spanish string', () => {
  for (const key of Object.keys(messages.en)) {
    assert.ok(messages.es[key], `missing Spanish: ${key}`)
    assert.notEqual(messages.es[key], '')
  }
})
