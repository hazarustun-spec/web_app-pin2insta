import { NextResponse } from 'next/server'
import { guardCron, noStore } from '@/src/lib/cron-auth'
import { runPublish } from '@/src/lib/queue/publish'

// A carousel publish is several sequential Graph calls plus a thumbnail pass
// per image, and the run may cover more than one due slot.
export const maxDuration = 300
// Never prerendered, never cached: the answer depends on a header and on the
// clock, and the side effect is a post on Instagram.
export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  // `proxy.ts` excludes `/api/cron/` from the session fence, so this call is
  // the whole of this route's authentication. It lives in one shared module
  // used by every cron route — see the comment at the top of cron-auth.ts for
  // why a second copy is not acceptable.
  const refusal = guardCron(req)
  if (refusal) return refusal

  try {
    return NextResponse.json(await runPublish(new Date()), { headers: noStore })
  } catch (e) {
    // Driver and Graph failures carry hostnames and connection details; the
    // caller gets a status code and the details go to the function log.
    console.error('cron publish run failed:', e)
    return NextResponse.json({ error: 'publish run failed' }, { status: 500, headers: noStore })
  }
}
