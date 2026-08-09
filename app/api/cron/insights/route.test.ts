import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * The same fence as `/api/cron/publish`, and the same reason for testing it
 * here in full: `proxy.ts` excludes `/api/cron/` from the session check on the
 * promise that each handler checks CRON_SECRET itself.
 *
 * The auth logic now lives in `src/lib/cron-auth.ts` and is shared by both
 * routes. These cases are deliberately the publish route's cases repeated
 * against this handler: what is being proved is that this route is WIRED to
 * the hardened check, not that the check works — the plan shipped this route
 * with its own copy of the pre-Task-8 version, in which an unset CRON_SECRET
 * made the literal string "Bearer undefined" the password.
 */

const refreshInsights = vi.hoisted(() => vi.fn())
vi.mock('@/src/lib/insights', () => ({ refreshInsights }))

const { POST } = await import('./route')

const SECRET = 'a-long-random-cron-secret'
const REPORT = { scanned: 3, refreshed: 3, skipped: 0, dryRun: true }

function request(authorization?: string) {
  const headers = new Headers()
  if (authorization !== undefined) headers.set('authorization', authorization)
  return new Request('http://localhost/api/cron/insights', { method: 'POST', headers })
}

const saved = process.env.CRON_SECRET

beforeEach(() => {
  process.env.CRON_SECRET = SECRET
  refreshInsights.mockReset().mockResolvedValue(REPORT)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (saved === undefined) delete process.env.CRON_SECRET
  else process.env.CRON_SECRET = saved
})

describe('POST /api/cron/insights — authorisation', () => {
  it('refreshes the metrics for the correct secret', async () => {
    const res = await POST(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(REPORT)
    expect(refreshInsights).toHaveBeenCalledTimes(1)
  })

  it('refuses a wrong secret', async () => {
    expect((await POST(request(`Bearer ${'b'.repeat(SECRET.length)}`))).status).toBe(401)
    expect(refreshInsights).not.toHaveBeenCalled()
  })

  it('refuses a missing authorization header', async () => {
    expect((await POST(request())).status).toBe(401)
    expect(refreshInsights).not.toHaveBeenCalled()
  })

  it('refuses the bare secret without the Bearer scheme', async () => {
    expect((await POST(request(SECRET))).status).toBe(401)
    expect(refreshInsights).not.toHaveBeenCalled()
  })

  it('refuses a prefix and a suffix of the correct header', async () => {
    expect((await POST(request(`Bearer ${SECRET.slice(0, -1)}`))).status).toBe(401)
    expect((await POST(request(`Bearer ${SECRET}x`))).status).toBe(401)
    expect(refreshInsights).not.toHaveBeenCalled()
  })

  it('answers a multibyte header with 401 rather than crashing', async () => {
    // The plan's copy compared String#length (UTF-16 code units) and then
    // handed timingSafeEqual two differently-sized BYTE buffers, which throws:
    // a 500 from an unauthenticated request.
    const sameLengthDifferentBytes = `Bearer ${'é'.repeat(SECRET.length)}`
    expect(sameLengthDifferentBytes.length).toBe(`Bearer ${SECRET}`.length)
    expect(Buffer.byteLength(sameLengthDifferentBytes)).not.toBe(Buffer.byteLength(`Bearer ${SECRET}`))

    for (const value of [sameLengthDifferentBytes, 'Bearer é', `Bearer ${'é'.repeat(200)}`]) {
      expect((await POST(request(value))).status).toBe(401)
    }
    expect(refreshInsights).not.toHaveBeenCalled()
  })

  it('survives an enormous header', async () => {
    expect((await POST(request(`Bearer ${'x'.repeat(100_000)}`))).status).toBe(401)
    expect(refreshInsights).not.toHaveBeenCalled()
  })

  it('disables itself rather than 401ing forever on a secret it cannot compare', async () => {
    // A Headers object cannot even carry a code point above 0xff, which is the
    // same wall the byte comparison hits — so the header stays ASCII and it is
    // the SECRET that is unusable.
    for (const bad of ['gizli-şifre', `${SECRET}\n`]) {
      process.env.CRON_SECRET = bad
      expect((await POST(request(`Bearer ${SECRET}`))).status).toBe(503)
    }
    // HTTP strips optional whitespace from a header value, so a secret with an
    // edge space can never be matched by anything a client can send.
    for (const bad of [' leading', 'trailing ', ' both ', ' ']) {
      process.env.CRON_SECRET = bad
      expect((await POST(request(`Bearer ${bad.trim()}`))).status).toBe(503)
    }
    expect(refreshInsights).not.toHaveBeenCalled()
  })

  it('still accepts a secret with an interior space', async () => {
    process.env.CRON_SECRET = 'two words'
    expect((await POST(request('Bearer two words'))).status).toBe(200)
  })
})

describe('POST /api/cron/insights — unconfigured', () => {
  it('fails closed with 503 when CRON_SECRET is unset', async () => {
    // THE BUG IN THE PLAN, in one test. `Bearer ${undefined}` makes "Bearer
    // undefined" the expected header, and anyone who has read a Next.js
    // tutorial can send it.
    delete process.env.CRON_SECRET
    for (const value of [undefined, 'Bearer undefined', 'Bearer ', 'Bearer null']) {
      expect((await POST(request(value))).status).toBe(503)
    }
    expect(refreshInsights).not.toHaveBeenCalled()
  })

  it('fails closed when CRON_SECRET is empty', async () => {
    process.env.CRON_SECRET = ''
    expect((await POST(request('Bearer '))).status).toBe(503)
    expect(refreshInsights).not.toHaveBeenCalled()
  })
})

describe('POST /api/cron/insights — hygiene', () => {
  it('never echoes or logs the secret', async () => {
    const logged: unknown[] = []
    vi.spyOn(console, 'log').mockImplementation((...a) => void logged.push(...a))
    vi.spyOn(console, 'error').mockImplementation((...a) => void logged.push(...a))
    refreshInsights.mockRejectedValue(new Error('neon: connection to ep-secret.aws.neon.tech failed'))

    const bodies = await Promise.all([
      POST(request(`Bearer ${SECRET}`)).then((r) => r.text()),
      POST(request('Bearer wrong')).then((r) => r.text()),
    ])
    for (const body of bodies) expect(body).not.toContain(SECRET)
    expect(JSON.stringify(logged.map(String))).not.toContain(SECRET)
  })

  it('answers a failed refresh with a generic 500, not the driver message', async () => {
    refreshInsights.mockRejectedValue(new Error('neon: connection to ep-secret.aws.neon.tech failed'))
    const res = await POST(request(`Bearer ${SECRET}`))
    expect(res.status).toBe(500)
    expect(await res.text()).not.toContain('neon.tech')
  })

  it('surfaces a dead instagram token as a failed invocation', async () => {
    // `refreshInsights` rethrows on 401/403/OAuthException instead of writing
    // zeros. A 200 here would hide a token that has stopped working behind a
    // green cron history.
    const { InstagramError } = await import('@/src/lib/instagram')
    refreshInsights.mockRejectedValue(new InstagramError('Invalid OAuth access token', 401, 'OAuthException'))
    expect((await POST(request(`Bearer ${SECRET}`))).status).toBe(500)
  })

  it('is never cached', async () => {
    const res = await POST(request(`Bearer ${SECRET}`))
    expect(res.headers.get('cache-control')).toContain('no-store')
  })
})
