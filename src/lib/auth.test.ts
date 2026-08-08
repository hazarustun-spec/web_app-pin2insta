import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { signSession, verifySession, checkPassword, SESSION_COOKIE } from './auth'

const PASSWORD = 'correct-horse'
const SECRET = 'a-server-only-session-secret'

beforeEach(() => {
  process.env.ADMIN_PASSWORD = PASSWORD
  process.env.SESSION_SECRET = SECRET
})

afterEach(() => {
  vi.useRealTimers()
})

describe('SESSION_COOKIE', () => {
  it('is the fixed cookie name the proxy matcher depends on', () => {
    expect(SESSION_COOKIE).toBe('p2i_session')
  })
})

describe('signSession', () => {
  it('produces a token shaped issuedAtMs.nonceHex(32).hmacHex(64)', () => {
    expect(signSession()).toMatch(/^[0-9]+\.[0-9a-f]{32}\.[0-9a-f]{64}$/)
  })

  it('produces a different token on every call (random nonce)', () => {
    expect(signSession()).not.toBe(signSession())
  })

  it('throws rather than minting a token when ADMIN_PASSWORD is unset', () => {
    delete process.env.ADMIN_PASSWORD
    expect(() => signSession()).toThrow()
  })

  it('throws rather than minting a token when SESSION_SECRET is unset', () => {
    delete process.env.SESSION_SECRET
    expect(() => signSession()).toThrow()
  })
})

describe('verifySession — accepts a token it signed', () => {
  it('accepts a freshly signed token', () => {
    expect(verifySession(signSession())).toBe(true)
  })
})

describe('verifySession — rejects malformed input without throwing', () => {
  it('rejects an empty token', () => {
    expect(verifySession('')).toBe(false)
  })

  it('rejects a lengthened (tampered) token', () => {
    expect(verifySession(signSession() + 'x')).toBe(false)
  })

  it('rejects a token with a tampered HMAC of otherwise-correct shape', () => {
    const [issuedAt, nonce, hmac] = signSession().split('.')
    const flippedFirstChar = hmac[0] === 'a' ? 'b' : 'a'
    const tampered = `${issuedAt}.${nonce}.${flippedFirstChar}${hmac.slice(1)}`
    expect(verifySession(tampered)).toBe(false)
  })

  it('rejects a percent-encoded multibyte cookie value without throwing', () => {
    const trap = '%C3%A9'.repeat(11) // arbitrary junk, never matches the token shape
    expect(() => verifySession(trap)).not.toThrow()
    expect(verifySession(trap)).toBe(false)
  })

  it('rejects a 64-char multibyte string without throwing (the old length-only bug)', () => {
    // UTF-16 .length (64) would have equaled the old hex digest's .length (64)
    // while the UTF-8 byte length differs — exactly the input that crashed
    // timingSafeEqual under the previous implementation.
    const trap = 'é'.repeat(64)
    expect(() => verifySession(trap)).not.toThrow()
    expect(verifySession(trap)).toBe(false)
  })
})

describe('verifySession — key binding', () => {
  it('rejects a token minted under a different password', () => {
    const token = signSession()
    process.env.ADMIN_PASSWORD = 'a-different-password'
    expect(verifySession(token)).toBe(false)
  })

  it('rejects a token minted under a different session secret', () => {
    const token = signSession()
    process.env.SESSION_SECRET = 'a-different-secret'
    expect(verifySession(token)).toBe(false)
  })
})

describe('verifySession — server-side expiry', () => {
  it('rejects a token older than 30 days', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const token = signSession()
    vi.setSystemTime(new Date('2026-02-01T00:00:01.000Z')) // 31 days + 1s later
    expect(verifySession(token)).toBe(false)
  })

  it('accepts a token still within the 30-day window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
    const token = signSession()
    vi.setSystemTime(new Date('2026-01-29T00:00:00.000Z')) // 28 days later
    expect(verifySession(token)).toBe(true)
  })

  it('rejects a token whose timestamp is in the future beyond clock skew', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:10:00.000Z'))
    const token = signSession()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')) // issuedAt is 10 min ahead of "now"
    expect(verifySession(token)).toBe(false)
  })

  it('tolerates a small clock skew (30s, within the 60s budget)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:30.000Z'))
    const token = signSession()
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z')) // issuedAt is 30s ahead of "now"
    expect(verifySession(token)).toBe(true)
  })
})

describe('verifySession — fails closed when unconfigured', () => {
  it('returns false when ADMIN_PASSWORD is unset, even for an otherwise well-formed token', () => {
    const token = signSession()
    delete process.env.ADMIN_PASSWORD
    expect(verifySession(token)).toBe(false)
  })

  it('returns false when SESSION_SECRET is unset, even for an otherwise well-formed token', () => {
    const token = signSession()
    delete process.env.SESSION_SECRET
    expect(verifySession(token)).toBe(false)
  })
})

describe('checkPassword', () => {
  it('accepts the correct password', () => {
    expect(checkPassword(PASSWORD)).toBe(true)
  })

  it('rejects a wrong password of the same length', () => {
    const sameLengthWrong = PASSWORD.slice(0, -1) + (PASSWORD.at(-1) === 'x' ? 'y' : 'x')
    expect(sameLengthWrong.length).toBe(PASSWORD.length)
    expect(checkPassword(sameLengthWrong)).toBe(false)
  })

  it('rejects a wrong password of a different length', () => {
    expect(checkPassword(PASSWORD + 'x')).toBe(false)
  })

  it('returns false when ADMIN_PASSWORD is unset', () => {
    delete process.env.ADMIN_PASSWORD
    expect(checkPassword(PASSWORD)).toBe(false)
  })
})
