import { test } from 'node:test'
import assert from 'node:assert/strict'
import { messages, t } from './i18n.ts'

test('English and Spanish expose matching messages and interpolation fields', () => {
  assert.deepEqual(Object.keys(messages.en).sort(), Object.keys(messages.es).sort())
  for (const key of Object.keys(messages.en)) {
    const fields = (value: string) => [...value.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort()
    assert.deepEqual(fields(messages.en[key]), fields(messages.es[key]), key)
  }
  assert.match(t('es', 'profile.age', { weeks: 19, days: 0, months: 4 }), /19 semanas/)
  assert.match(t('en', 'app.privateTo'), /invited caregivers/)
  assert.match(t('es', 'app.privateTo'), /cuidadores invitados/)
})
