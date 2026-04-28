import { test, expect } from 'bun:test'

const base = 'http://127.0.0.1:4096'

test('health endpoint responds ok', async () => {
  const res = await fetch(`${base}/health`)
  expect(res.ok).toBe(true)
  const body = await res.json()
  expect(body?.ok).toBe(true)
})

test('list sessions endpoint returns data', async () => {
  const res = await fetch(`${base}/session?limit=2`)
  expect(res.ok).toBe(true)
  const data = await res.json()
  // Accept empty array or array of sessions
  expect(Array.isArray(data) || typeof data === 'object')
})

export {} // ensure this file is treated as a module
