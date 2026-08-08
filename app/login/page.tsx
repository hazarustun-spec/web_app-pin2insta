'use client'
import { useState } from 'react'

export default function Login() {
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password }),
    })
    if (res.ok) location.href = '/'
    else setError('Yanlış şifre')
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
