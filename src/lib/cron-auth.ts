import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'

/**
 * The ONLY thing standing in front of every `/api/cron/*` handler.
 *
 * `proxy.ts` excludes `api/cron/` from the session fence precisely so the
 * Vercel scheduler can reach these routes unauthenticated; this module is the
 * entire replacement for that fence. It lives here, in one place, rather than
 * being pasted into each cron route: the plan gave the insights route its own
 * copy of the check, and that copy was the pre-Task-8 version with all three
 * of the bugs below still in it. Two copies of an auth check is how one of
 * them drifts, and the one that drifts is the one nobody is reading.
 *
 * Never logs, echoes, or returns any part of the secret.
 */

/**
 * An authorization header is not a secret prefix, so the length cap only bounds
 * the work done on a hostile request. 8KB is above any real header.
 */
const MAX_HEADER_CHARS = 8192

const PREFIX = 'Bearer '

/**
 * Printable ASCII, space included, newline and everything above 0x7e excluded.
 *
 * Node decodes header values from the wire as latin-1 while `Buffer.from(s,
 * 'utf8')` re-encodes above 0x7f, so a non-ASCII secret would compare unequal
 * to the very header the cron sends and 401 forever with no explanation. An
 * ASCII secret makes both encodings identical and the question moot. A secret
 * that fails this is a misconfiguration, and it is reported as one (503)
 * rather than silently locking the scheduler out. A trailing newline from a
 * copy-paste lands here too, which is exactly the point.
 *
 * Leading and trailing spaces are rejected for the same reason: HTTP strips
 * optional whitespace from header values, so a secret with an edge space can
 * never be matched by any header a client is able to send — the permanent,
 * unexplained 401 this rule exists to prevent.
 */
const ASCII_SECRET = /^[\x21-\x7e](?:[\x20-\x7e]*[\x21-\x7e])?$/

/**
 * Constant-time check of `Authorization: Bearer <CRON_SECRET>`.
 *
 * Three things the plan's version got wrong, in both routes:
 * - it built `Bearer ${process.env.CRON_SECRET}` unconditionally, so with the
 *   variable unset the secret became the literal string "Bearer undefined".
 *   Configuration is resolved by the caller before anything is compared;
 * - it compared `given.length` (UTF-16 code units) to decide whether
 *   `timingSafeEqual` was safe to call. It is not: that function compares
 *   BYTES, and "Bearer şş…" is shorter in code units than in bytes, so a
 *   multibyte header reached it with mismatched buffers and threw — a 500 from
 *   an unauthenticated request. Both lengths here are byte lengths;
 * - it had no shape gate at all. The scheme prefix is not secret, so checking
 *   it before building buffers leaks nothing.
 */
function authorised(given: string | null, secret: string): boolean {
  if (given === null) return false
  if (given.length > MAX_HEADER_CHARS) return false
  if (!given.startsWith(PREFIX)) return false

  const expected = Buffer.from(`${PREFIX}${secret}`, 'utf8')
  const candidate = Buffer.from(given, 'utf8')
  if (candidate.length !== expected.length) return false
  return timingSafeEqual(candidate, expected)
}

/** Every cron answer is a one-off; nothing about it may sit in a cache. */
export const noStore = { 'cache-control': 'no-store' }

/**
 * The response to send INSTEAD of running the job, or null when the caller
 * proved it holds CRON_SECRET.
 *
 * Fails closed, and decides the unconfigured case BEFORE looking at the
 * request, so a deployment with no secret answers identically no matter what
 * was sent.
 */
export function guardCron(req: Request): NextResponse | null {
  const secret = process.env.CRON_SECRET
  if (!secret || !ASCII_SECRET.test(secret)) {
    if (secret) console.error('CRON_SECRET must be printable ASCII with no leading or trailing space; the cron routes are disabled')
    return NextResponse.json({ error: 'not configured' }, { status: 503, headers: noStore })
  }
  if (!authorised(req.headers.get('authorization'), secret)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401, headers: noStore })
  }
  return null
}
