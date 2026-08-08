import { describe, it, expect, beforeEach } from 'vitest'
import { POST } from './route'

function loginRequest(body: unknown) {
  return new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('POST /api/login — fails closed with no oracle when unconfigured', () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = 'correct-horse'
    delete process.env.SESSION_SECRET
  })

  it('returns byte-identical responses for the correct password and a wrong one', async () => {
    const correct = await POST(loginRequest({ password: 'correct-horse' }))
    const wrong = await POST(loginRequest({ password: 'definitely-not-it' }))

    expect(correct.status).toBe(503)
    expect(wrong.status).toBe(503)
    expect(correct.status).toBe(wrong.status)

    const correctBody = await correct.text()
    const wrongBody = await wrong.text()
    expect(correctBody).toBe(wrongBody)

    // Headers must match too — no Set-Cookie leaking on either path, and no
    // stray header that would let a client distinguish the two cases.
    const correctHeaders = [...correct.headers.entries()].sort()
    const wrongHeaders = [...wrong.headers.entries()].sort()
    expect(correctHeaders).toEqual(wrongHeaders)
    expect(correct.headers.get('set-cookie')).toBeNull()
    expect(wrong.headers.get('set-cookie')).toBeNull()
  })

  it('returns the same 503 even for a malformed body — never reaches password comparison', async () => {
    const malformed = new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{{{',
    })
    const res = await POST(malformed)
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'not configured' })
  })
})

describe('POST /api/login — configured', () => {
  beforeEach(() => {
    process.env.ADMIN_PASSWORD = 'correct-horse'
    process.env.SESSION_SECRET = 'a-server-only-session-secret'
  })

  it('still distinguishes right from wrong once fully configured', async () => {
    const correct = await POST(loginRequest({ password: 'correct-horse' }))
    const wrong = await POST(loginRequest({ password: 'nope' }))
    expect(correct.status).toBe(200)
    expect(wrong.status).toBe(401)
    expect(correct.headers.get('set-cookie')).toMatch(/^p2i_session=/)
  })
})
