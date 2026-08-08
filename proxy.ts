import { NextResponse, type NextRequest } from 'next/server'
import { SESSION_COOKIE, verifySession } from '@/src/lib/auth'

export const config = {
  matcher: ['/((?!login|api/login|api/cron|_next|favicon.ico).*)'],
}

export default function proxy(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value ?? ''
  if (verifySession(token)) return NextResponse.next()
  return NextResponse.redirect(new URL('/login', req.url))
}
