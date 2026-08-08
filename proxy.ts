import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/src/lib/auth'

export const config = {
  // NOTE: only `api/cron/` (with a trailing segment) is excluded, not bare
  // `api/cron`. `/api/cron` itself IS guarded by this proxy. Task 13's cron
  // handler must therefore live at app/api/cron/<segment>/route.ts, never at
  // app/api/cron/route.ts, or the cron trigger will get a 401 from here
  // instead of reaching CRON_SECRET auth in the route handler.
  matcher: [
    '/((?!login$|api/login$|api/cron/|_next/|favicon\\.ico$).*)',
  ],
}

export default function proxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value ?? ''
  if (verifySession(token)) return NextResponse.next()
  if (req.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }
  return NextResponse.redirect(new URL('/login', req.url))
}
