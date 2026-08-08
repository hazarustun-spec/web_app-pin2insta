import { describe, it, expect, beforeAll } from 'vitest'
import { signSession, verifySession } from './auth'

beforeAll(() => { process.env.ADMIN_PASSWORD = 'correct-horse' })

describe('session token', () => {
  it('accepts a token it signed', () => {
    expect(verifySession(signSession('correct-horse'))).toBe(true)
  })

  it('rejects a tampered token', () => {
    expect(verifySession(signSession('correct-horse') + 'x')).toBe(false)
  })

  it('rejects an empty token', () => {
    expect(verifySession('')).toBe(false)
  })

  it('rejects a token signed with the wrong password', () => {
    expect(signSession('wrong')).not.toBe(signSession('correct-horse'))
  })
})
