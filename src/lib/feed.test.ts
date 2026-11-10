import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_FEED_DRAFT,
  draftFromMeta,
  formatEventLabel,
  formatFeedDetail,
  formatOz,
  metaFromDraft,
  dayHasProbiotic,
} from './feed.ts'
import type { CareEvent } from './types.ts'

test('formatOz drops trailing .0', () => {
  assert.equal(formatOz(2), '2')
  assert.equal(formatOz(2.5), '2.5')
  assert.equal(formatOz(4), '4')
})

test('breast draft stores side + minutes, bottle stores ounces', () => {
  const breast = metaFromDraft({ ...DEFAULT_FEED_DRAFT, side: 'R', minutes: 20, probiotic: true })
  assert.equal(breast.side, 'R')
  assert.equal(breast.durationMin, 20)
  assert.equal(breast.probiotic, true)
  assert.equal(breast.ounces, undefined)

  const bottle = metaFromDraft({ ...DEFAULT_FEED_DRAFT, mode: 'bottle', ounces: 2.5 })
  assert.equal(bottle.side, 'bottle')
  assert.equal(bottle.ounces, 2.5)
  assert.equal(bottle.durationMin, undefined)
  assert.equal(bottle.probiotic, undefined)
})

test('draftFromMeta restores bottle vs breast and probiotic', () => {
  const breast = draftFromMeta({ side: 'both', durationMin: 18, probiotic: true })
  assert.equal(breast.mode, 'breast')
  assert.equal(breast.side, 'both')
  assert.equal(breast.minutes, 18)
  assert.equal(breast.probiotic, true)

  const bottle = draftFromMeta({ side: 'bottle', ounces: 4 })
  assert.equal(bottle.mode, 'bottle')
  assert.equal(bottle.ounces, 4)
  assert.equal(bottle.probiotic, false)
})

test('formatFeedDetail is one-handed readable', () => {
  assert.equal(formatFeedDetail({ side: 'L', durationMin: 15 }), 'Left · 15m')
  assert.equal(formatFeedDetail({ side: 'bottle', ounces: 2.5, probiotic: true }), '2.5 oz bottle · probiotic')
  assert.equal(formatEventLabel({ type: 'feed', meta: { side: 'R', durationMin: 20 } }), 'Feed · Right · 20m')
  assert.equal(formatEventLabel({ type: 'wake' }), 'Wake')
})

test('dayHasProbiotic only counts a checked morning dose', () => {
  const events: CareEvent[] = [
    { id: '1', type: 'feed', at: '2026-08-16T15:00:00.000Z', by: 'David', meta: { side: 'bottle', ounces: 3 } },
    { id: '2', type: 'feed', at: '2026-08-16T18:00:00.000Z', by: 'Jordan', meta: { side: 'L', durationMin: 12, probiotic: true } },
  ]
  assert.equal(dayHasProbiotic(events), true)
  assert.equal(dayHasProbiotic(events.slice(0, 1)), false)
})
