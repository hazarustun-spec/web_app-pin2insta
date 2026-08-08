import { NextResponse } from 'next/server'
import { authConfigured, checkPassword, signSession, SESSION_COOKIE } from '@/src/lib/auth'

export async function POST(req: Request) {
  // Resolve configuration BEFORE touching the submitted body or comparing
  // anything to a secret. If ADMIN_PASSWORD/SESSION_SECRET aren't both set,
  // every request gets this exact response — same status, body, and
  // headers, regardless of what password (if any) was submitted. Checking
  // checkPassword() first would let a correct password 500 (signSession
  // throws) while a wrong password 401s: a free, unlimited-rate oracle that
  // discloses whether a guessed password is right the instant SESSION_SECRET
  // is missing — which every deployment is, until it's explicitly set.
  if (!authConfigured()) {
    return NextResponse.json({ error: 'not configured' }, { status: 503 })
  }

  let password: unknown
  try {
    const body: unknown = await req.json()
    password = (body as { password?: unknown } | null)?.password
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 })
  }

  if (typeof password !== 'string' || !checkPassword(password)) {
    return NextResponse.json({ error: 'wrong password' }, { status: 401 })
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, signSession(), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  })
  return res
}
