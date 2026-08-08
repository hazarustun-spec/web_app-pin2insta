import { NextResponse } from 'next/server'
import { checkPassword, signSession, SESSION_COOKIE } from '@/src/lib/auth'

export async function POST(req: Request) {
  const { password } = await req.json()
  if (typeof password !== 'string' || !checkPassword(password)) {
    return NextResponse.json({ error: 'wrong password' }, { status: 401 })
  }
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, signSession(password), {
    httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 60 * 60 * 24 * 365,
  })
  return res
}
