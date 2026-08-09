import { NextResponse } from 'next/server'
import { guardCron, noStore } from '@/src/lib/cron-auth'
import { refreshInsights } from '@/src/lib/insights'

// Up to REFRESH_LIMIT sequential Graph round-trips, each one two calls.
export const maxDuration = 300
// Never prerendered, never cached: the answer depends on a header, and the
// side effect is a table of numbers the suggestion is computed from.
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // `proxy.ts` excludes `/api/cron/` from the session fence, so this call is
  // the whole of this route's authentication. It is the SAME function the
  // publish route uses — the plan gave this route its own copy, which was the
  // pre-Task-8 version and treated an unset CRON_SECRET as the guessable
  // literal "Bearer undefined", authorising anyone who tried it.
  const refusal = guardCron(req)
  if (refusal) return refusal

  try {
    return NextResponse.json(await refreshInsights(), { headers: noStore })
  } catch (e) {
    // A dead Instagram token arrives here, deliberately: `refreshInsights`
    // rethrows an auth failure rather than writing zeros, and a cron
    // invocation that ends in a 500 is the only channel this deployment has
    // for saying "the token needs replacing". The message stays in the log —
    // Graph and driver errors carry hostnames.
    console.error('cron insights refresh failed:', e)
    return NextResponse.json({ error: 'insights refresh failed' }, { status: 500, headers: noStore })
  }
}
