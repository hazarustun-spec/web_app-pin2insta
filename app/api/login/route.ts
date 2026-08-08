import { NextResponse } from 'next/server'
import { checkPassword, signSession, SESSION_COOKIE } from '@/src/lib/auth'

export async function POST(req: Request) {
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
