import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const root = new URL('../../', import.meta.url)
const publicFile = (path: string) => new URL(`public/${path}`, root)
const origin = 'https://shared-day.example'
const expectedAssets = ['/offline.html', '/icons/app-192.png', '/icons/app-512.png', '/icons/apple-touch-icon.png']

async function workerHarness() {
  const listeners = new Map<string, (event: any) => void>()
  const stored = new Map<string, Response>()
  const fetched: Request[] = []
  const fetchOptions: (RequestInit | undefined)[] = []
  const deleted: string[] = []
  let network: (request: Request) => Promise<Response> = async request => new Response(
    request.url.endsWith('.png') ? 'icon' : 'generic offline page',
    { headers: { 'Content-Type': request.url.endsWith('.png') ? 'image/png' : 'text/html' } },
  )
  let cacheName = ''
  const cache = {
    put: async (path: string, response: Response) => { stored.set(path, response) },
    match: async (path: string) => stored.get(path)?.clone(),
  }
  class SameOriginRequest extends Request {
    constructor(input: string | Request, options?: RequestInit) {
      super(typeof input === 'string' ? new URL(input, origin) : input, options)
    }
  }
  runInNewContext(await readFile(publicFile('sw.js'), 'utf8'), {
    self: {
      location: { origin },
      addEventListener: (name: string, listener: (event: any) => void) => listeners.set(name, listener),
      clients: { claim: async () => {} },
    },
    URL,
    Request: SameOriginRequest,
    Response,
    fetch: async (request: Request, options?: RequestInit) => {
      fetched.push(request)
      fetchOptions.push(options)
      return network(request)
    },
    caches: {
      open: async (name: string) => { cacheName = name; return cache },
      keys: async () => ['unrelated-app-v1', 'shared-care-day-pwa-static-old', cacheName],
      delete: async (name: string) => { deleted.push(name); return true },
    },
  })
  async function lifecycle(name: string) {
    let completion: Promise<unknown> | undefined
    listeners.get(name)!({ waitUntil: (promise: Promise<unknown>) => { completion = promise } })
    await completion
  }
  function dispatch(request: { url: string; method?: string; mode?: string }) {
    let response: Promise<Response> | undefined
    const eventRequest = { method: 'GET', mode: 'navigate', ...request }
    listeners.get('fetch')!({
      request: eventRequest,
      respondWith: (promise: Promise<Response>) => { response = promise },
    })
    return response
  }
  return { stored, fetched, fetchOptions, deleted, lifecycle, dispatch, setNetwork: (next: typeof network) => { network = next } }
}

test('install assets are generic, credential-free, and limited to the explicit public allowlist', async () => {
  const worker = await workerHarness()
  await worker.lifecycle('install')
  assert.deepEqual([...worker.stored.keys()].sort(), [...expectedAssets].sort())
  assert.equal(worker.fetched.length, expectedAssets.length)
  for (const request of worker.fetched) {
    assert.equal(request.credentials, 'omit')
    assert.equal(request.redirect, 'error')
    assert.equal(new URL(request.url).origin, origin)
  }
})

test('activation removes only old caches owned by this app', async () => {
  const worker = await workerHarness()
  await worker.lifecycle('install')
  await worker.lifecycle('activate')
  assert.deepEqual(worker.deleted, ['shared-care-day-pwa-static-old'])
})

test('API, auth, history, non-GET, cross-origin, and subresource requests stay outside the worker', async () => {
  const worker = await workerHarness()
  for (const path of ['/api/day', '/api/history', '/api/me', '/api/auth', '/api/event', '/auth', '/history', '/session']) {
    assert.equal(worker.dispatch({ url: origin + path }), undefined, path)
  }
  assert.equal(worker.dispatch({ url: origin + '/', method: 'POST' }), undefined)
  assert.equal(worker.dispatch({ url: 'https://other.example/' }), undefined)
  assert.equal(worker.dispatch({ url: origin + '/', mode: 'cors' }), undefined)
  assert.equal(worker.dispatch({ url: origin + '/icons/app-192.png', mode: 'no-cors' }), undefined)
  assert.equal(worker.fetched.length, 0)
  assert.equal(worker.stored.size, 0)
})

test('successful navigations always use the network and are never written to Cache Storage', async () => {
  const worker = await workerHarness()
  await worker.lifecycle('install')
  worker.setNetwork(async () => new Response('fictional private session page'))
  assert.equal(await (await worker.dispatch({ url: origin + '/' }))!.text(), 'fictional private session page')
  assert.deepEqual([...worker.stored.keys()].sort(), [...expectedAssets].sort())
  assert.equal(worker.fetchOptions.at(-1)?.cache, 'no-store')
})

test('network navigation failure returns only the generic offline page', async () => {
  const worker = await workerHarness()
  await worker.lifecycle('install')
  worker.setNetwork(async () => { throw new TypeError('network unavailable') })
  const response = await worker.dispatch({ url: origin + '/' })
  assert.equal(await response!.text(), 'generic offline page')
  assert.equal(worker.stored.size, expectedAssets.length)
})

test('HTTP authentication and server errors are preserved instead of masked by offline content', async () => {
  const worker = await workerHarness()
  await worker.lifecycle('install')
  for (const status of [401, 403, 503]) {
    worker.setNetwork(async () => new Response('server response', { status }))
    const response = await worker.dispatch({ url: origin + '/' })
    assert.equal(response!.status, status)
    assert.equal(await response!.text(), 'server response')
  }
})

test('precache rejects wrongly typed resources instead of storing an auth page', async () => {
  const worker = await workerHarness()
  worker.setNetwork(async () => new Response('fictional login page', { headers: { 'Content-Type': 'text/html' } }))
  await assert.rejects(worker.lifecycle('install'))
  assert.equal([...worker.stored.keys()].some(path => path.endsWith('.png')), false)
})

test('a redirect or network rejection prevents installation instead of caching the failed response', async () => {
  const worker = await workerHarness()
  worker.setNetwork(async () => { throw new TypeError('redirect disallowed') })
  await assert.rejects(worker.lifecycle('install'))
  assert.equal(worker.stored.size, 0)
})

test('missing offline content fails closed without returning app or private data', async () => {
  const worker = await workerHarness()
  worker.setNetwork(async () => { throw new TypeError('network unavailable') })
  const response = await worker.dispatch({ url: origin + '/' })
  assert.equal(response!.type, 'error')
  assert.equal(await response!.text(), '')
})

test('manifest and HTML provide mobile install metadata and correctly sized nonphoto icons', async () => {
  const manifest = JSON.parse(await readFile(publicFile('manifest.webmanifest'), 'utf8'))
  assert.equal(manifest.id, '/')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.display, 'standalone')
  assert.equal(manifest.theme_color, '#f7f3ee')
  assert.equal(manifest.background_color, '#f7f3ee')
  assert.deepEqual(manifest.icons.map((icon: { sizes: string }) => icon.sizes).sort(), ['192x192', '512x512'])
  for (const [path, size] of [['icons/app-192.png', 192], ['icons/app-512.png', 512], ['icons/apple-touch-icon.png', 180]] as const) {
    const bytes = await readFile(publicFile(path))
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(bytes.readUInt32BE(16), size)
    assert.equal(bytes.readUInt32BE(20), size)
  }
  const html = await readFile(new URL('index.html', root), 'utf8')
  assert.match(html, /rel="manifest" href="\/manifest\.webmanifest"/)
  assert.match(html, /rel="apple-touch-icon"[^>]+\/icons\/apple-touch-icon\.png/)
  assert.doesNotMatch(JSON.stringify(manifest), /birth|dateOfBirth|\d{4}-\d{2}-\d{2}|avatar|\.jpg|\.jpeg/i)
  const offline = await readFile(publicFile('offline.html'), 'utf8')
  assert.match(offline, /lang="es"/)
  assert.match(offline, /href="\/"/)
  assert.doesNotMatch(offline, /<script|fetch\(|localStorage|indexedDB|avatar/i)
})
