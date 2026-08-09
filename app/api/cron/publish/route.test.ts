import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * This route is the ONLY thing standing in front of the publisher.
 * `proxy.ts` deliberately excludes `/api/cron/` from the session fence on the
 * promise that this handler checks CRON_SECRET itself — so every hole here is
 * a publicly triggerable Instagram account.
 */

const runPublish = vi.hoisted(() => vi.fn())
vi.mock('@/src/lib/queue/publish', () => ({ runPublish }))

const { POST } = await import('./route')

const SECRET = 'a-long-random-cron-secret'

function request(authorization?: string) {
  const headers = new Headers()
  if (authorization !== undefined) headers.set('authorization', authorization)
  return new Request('http://localhost/api/cron/publish', { method: 'POST', headers })
}

const saved = process.env.CRON_SECRET

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
  runPublish.mockReset().mockResolvedValue({ slots: [], dryRun: true })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (saved === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = saved
})

describe('POST /api/cron/publish — authorisation', () => {
  it('runs the publisher for the correct secret', async () => {
    const res = await POST(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ slots: [], dryRun: true })
    expect(runPublish).toHaveBeenCalledTimes(1)
    expect(runPublish.mock.calls[0][0]).toBeInstanceOf(Date)
  })

  it('refuses a wrong secret', async () => {
    const res = await POST(request(`Bearer ${'b'.repeat(SECRET.length)}`))
    expect(res.status).toBe(401)
    expect(runPublish).not.toHaveBeenCalled()
  })

  it('refuses a missing authorization header', async () => {
    expect((await POST(request())).status).toBe(401)
    expect(runPublish).not.toHaveBeenCalled()
  })

  it('refuses the bare secret without the Bearer scheme', async () => {
    expect((await POST(request(SECRET))).status).toBe(401)
    expect(runPublish).not.toHaveBeenCalled()
  })

  it('refuses a prefix and a suffix of the correct header', async () => {
    expect((await POST(request(`Bearer ${SECRET.slice(0, -1)}`))).status).toBe(401)
    expect((await POST(request(`Bearer ${SECRET}x`))).status).toBe(401)
    expect(runPublish).not.toHaveBeenCalled()
  })

  it('answers a multibyte header with 401 rather than crashing', async () => {
    // timingSafeEqual compares BYTES while String#length counts UTF-16 code
    // units. This header is EXACTLY as long as the correct one in code units
    // and nearly twice as long in bytes, so a length pre-check on the strings
    // hands timingSafeEqual two differently-sized buffers and it throws — a
    // 500 from an unauthenticated request, and the exact bug Task 5 had to fix
    // in the session code.
    //
    // 'é' is what a UTF-8 byte looks like after Node's latin-1 header decode,
    // so this is a header a real client can actually send.
    const sameLengthDifferentBytes = `Bearer ${'é'.repeat(SECRET.length)}`
    expect(sameLengthDifferentBytes.length).toBe(`Bearer ${SECRET}`.length)
    expect(Buffer.byteLength(sameLengthDifferentBytes)).not.toBe(Buffer.byteLength(`Bearer ${SECRET}`))

    for (const value of [sameLengthDifferentBytes, 'Bearer é', `Bearer ${'é'.repeat(200)}`]) {
      const res = await POST(request(value))
      expect(res.status).toBe(401)
    }
    expect(runPublish).not.toHaveBeenCalled()
  })

  it('disables itself rather than 401ing forever on a secret it cannot compare', async () => {
    // Node decodes header bytes as latin-1, so a non-ASCII secret would never
    // match the header the cron actually sends. That is a misconfiguration and
    // is reported as one; a trailing newline from a copy-paste lands here too.
    // The header itself stays ASCII — a Headers object cannot even carry a
    // code point above 0xff, which is the same wall the comparison hits.
    for (const bad of ['gizli-şifre', `${SECRET}\n`]) {
      process.env.CRON_SECRET = bad
      const res = await POST(request(`Bearer ${SECRET}`))
      expect(res.status).toBe(503)
    }
    expect(runPublish).not.toHaveBeenCalled()
  })

  // HTTP strips optional whitespace from header values, so a secret with a
  // leading or trailing space can never be matched by any header a client is
  // able to send. Left alone it is a permanent, unexplained 401 — exactly the
  // lockout the ASCII rule exists to prevent, so it is a 503 too.
  it.each([[' leading'], ['trailing '], [' both '], [' '], ['  ']])(
    'refuses a secret with edge whitespace (%j) rather than 401ing forever',
    async (bad) => {
      process.env.CRON_SECRET = bad
      // Send the value a real client would produce: HTTP has already trimmed it.
      const res = await POST(request(`Bearer ${bad.trim()}`))
      expect(res.status).toBe(503)
      expect(runPublish).not.toHaveBeenCalled()
    },
  )

  it('still accepts a secret with an interior space', async () => {
    process.env.CRON_SECRET = 'two words'
    const res = await POST(request('Bearer two words'))
    expect(res.status).toBe(200)
  })

  it('survives an enormous header', async () => {
    const res = await POST(request(`Bearer ${'x'.repeat(100_000)}`))
    expect(res.status).toBe(401)
    expect(runPublish).not.toHaveBeenCalled()
  })
})

describe('POST /api/cron/publish — unconfigured', () => {
  it('fails closed with 503 when CRON_SECRET is unset', async () => {
    // `Bearer ${undefined}` would make "Bearer undefined" the secret, which is
    // guessable by anyone who has read a Next.js tutorial.
    delete process.env.CRON_SECRET
    for (const value of [undefined, 'Bearer undefined', 'Bearer ', 'Bearer null']) {
      const res = await POST(request(value))
      expect(res.status).toBe(503)
    }
    expect(runPublish).not.toHaveBeenCalled()
  })

  it('fails closed when CRON_SECRET is empty', async () => {
    process.env.CRON_SECRET = ''
    expect((await POST(request('Bearer '))).status).toBe(503)
    expect(runPublish).not.toHaveBeenCalled()
  })
})

describe('POST /api/cron/publish — hygiene', () => {
  it('never echoes the secret', async () => {
    const bodies = await Promise.all([
      POST(request(`Bearer ${SECRET}`)).then((r) => r.text()),
      POST(request('Bearer wrong')).then((r) => r.text()),
    ])
    for (const body of bodies) expect(body).not.toContain(SECRET)
  })

  it('never logs the secret', async () => {
    const logged: unknown[] = []
    vi.spyOn(console, 'log').mockImplementation((...a) => void logged.push(...a))
    vi.spyOn(console, 'error').mockImplementation((...a) => void logged.push(...a))
    runPublish.mockRejectedValue(new Error('neon: connection to ep-secret.aws.neon.tech failed'))

    await POST(request(`Bearer ${SECRET}`))
    await POST(request('Bearer wrong'))

    expect(JSON.stringify(logged.map(String))).not.toContain(SECRET)
  })

  it('answers a failed run with a generic 500, not the driver message', async () => {
    runPublish.mockRejectedValue(new Error('neon: connection to ep-secret.aws.neon.tech failed'))
    const res = await POST(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('neon.tech')
  })

  it('is never cached', async () => {
    const res = await POST(request(`Bearer ${SECRET}`))
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})
