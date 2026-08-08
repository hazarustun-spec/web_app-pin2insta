import { createHmac, timingSafeEqual } from 'node:crypto'

export const SESSION_COOKIE = 'p2i_session'

/** The password is its own signing key, so a password change invalidates every session. */
export function signSession(password: string): string {
  return createHmac('sha256', password).update('pin2insta-session-v1').digest('hex')
}

export function verifySession(token: string): boolean {
  const expected = signSession(process.env.ADMIN_PASSWORD!)
  if (token.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(token), Buffer.from(expected))
}

export function checkPassword(candidate: string): boolean {
  const expected = Buffer.from(process.env.ADMIN_PASSWORD!)
  const given = Buffer.from(candidate)
  if (given.length !== expected.length) return false
  return timingSafeEqual(given, expected)
}
