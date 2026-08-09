import { NextResponse } from 'next/server'
import { describeAdvice, listPublished } from '@/src/lib/insights'

/**
 * Read-only history. Session-fenced by `proxy.ts` like every other `/api/`
 * route; only `/api/cron/` is excluded from that fence.
 */
export const dynamic = 'force-dynamic'

const noStore = { 'cache-control': 'no-store' }

export async function GET() {
  try {
    const { posts, stats, advice } = await listPublished()
    // The sentence is composed here rather than in the client so there is one
    // place that decides what the numbers are allowed to claim.
    return NextResponse.json(
      { posts, stats, advice, message: describeAdvice(advice) },
      { headers: noStore },
    )
  } catch (e) {
    // Same contract as every other route: a Drizzle or Neon failure can carry
    // a hostname or a connection string, so it is logged and answered
    // generically.
    console.error('published history read failed:', e)
    return NextResponse.json({ error: 'geçmiş okunamadı' }, { status: 500, headers: noStore })
  }
}
