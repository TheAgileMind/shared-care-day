import { test } from 'node:test'
import assert from 'node:assert/strict'
import { api, AuthError } from './api.ts'

test('offline writes fail without sending or replaying a request', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const originalFetch = globalThis.fetch
  let requests = 0
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: false } })
  globalThis.fetch = async () => { requests++; return new Response('{}') }
  try {
    await assert.rejects(api('/api/event', { method: 'POST', body: '{}' }), /Offline/)
    assert.equal(requests, 0)
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } })
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.equal(requests, 0)
  } finally {
    globalThis.fetch = originalFetch
    if (previous) Object.defineProperty(globalThis, 'navigator', previous)
    else Reflect.deleteProperty(globalThis, 'navigator')
  }
})

test('API reads bypass caches and retain session authentication', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.cache, 'no-store')
    assert.equal(init?.credentials, 'include')
    return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
  }
  try { assert.deepEqual(await api('/api/me'), { ok: true }) }
  finally { globalThis.fetch = originalFetch }
})

test('API authentication and failed writes remain failures', async () => {
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response('{}', { status: 401 })
    await assert.rejects(api('/api/day'), AuthError)
    globalThis.fetch = async () => new Response('{"error":"Write failed"}', { status: 503 })
    await assert.rejects(api('/api/event', { method: 'POST', body: '{}' }), /Write failed/)
  } finally { globalThis.fetch = originalFetch }
})

test('a rejected login preserves the PIN error for localized feedback', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('{"error":"Wrong PIN"}', { status: 401 })
  try {
    await assert.rejects(api('/api/auth', { method: 'POST', body: '{}' }), error =>
      error instanceof Error && !(error instanceof AuthError) && error.message === 'Wrong PIN')
  } finally { globalThis.fetch = originalFetch }
})
