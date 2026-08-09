'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'

export default function Login() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) {
      router.push('/')
      return
    }
    // 503 is not a wrong password: it is ADMIN_PASSWORD or SESSION_SECRET
    // missing from the environment, which is the state every deployment starts
    // in. Saying "wrong password" there tells the owner their brand-new random
    // password is wrong, on the very first screen of the app.
    setError(
      res.status === 503
        ? 'Sunucu yapılandırılmamış — ADMIN_PASSWORD ve SESSION_SECRET ayarlanmalı.'
        : 'Yanlış şifre',
    )
  }

  return (
    <main className="grid min-h-dvh place-items-center bg-white">
      <form onSubmit={submit} className="w-72">
        <h1 className="mb-6 text-sm tracking-widest text-neutral-900">PIN2INSTA</h1>
        <input
          type="password" value={password} onChange={(e) => setPassword(e.target.value)}
          autoFocus
          className="w-full border-b border-neutral-300 bg-transparent py-2 text-sm outline-none focus:border-neutral-900"
        />
        {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
      </form>
    </main>
  )
}
