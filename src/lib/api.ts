export class AuthError extends Error {
  status = 401
  constructor() { super('Sign in required') }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new Error('Offline')
  const headers = new Headers(init?.headers)
  if (init?.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  const response = await fetch(path, { ...init, credentials: 'include', cache: 'no-store', headers })
  if (response.status === 401 && path !== '/api/auth') throw new AuthError()
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Request failed')
  return data as T
}
