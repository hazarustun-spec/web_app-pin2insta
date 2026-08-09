'use client'

import { useCallback, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'

/** The three fields, as text on screen. */
export type FormValues = { slots: string; timezone: string; hashtags: string }

/**
 * The limits `src/lib/settings.ts` enforces, handed down from the server page.
 *
 * NOT imported from that module: it is a client component, and settings.ts
 * pulls the database — and, through publish.ts, sharp and the Blob SDK — into
 * whatever imports it. Passing the numbers down keeps one source of truth
 * without dragging the server into the browser bundle.
 */
export type Limits = { maxSlots: number; maxHashtags: number; maxHashtagChars: number }

type Field = keyof FormValues
type Status = { field: Field; state: 'saved' | 'error'; message?: string } | null

const FAILED_MESSAGE = 'kaydedilemedi, tekrar dene'

/** A few zones worth suggesting. The input stays free text; the server decides. */
const SUGGESTED_ZONES = [
  'Europe/Istanbul', 'Europe/Berlin', 'Europe/London', 'Europe/Amsterdam',
  'America/New_York', 'America/Los_Angeles', 'Asia/Dubai', 'UTC',
]

const field =
  'mt-1 w-full border-b border-neutral-300 bg-transparent py-2 text-sm text-neutral-900 ' +
  'outline-none transition-colors focus:border-neutral-900 placeholder:text-neutral-300'

function Label({ children }: { children: React.ReactNode }) {
  return <span className="text-[11px] tracking-wide text-neutral-500">{children}</span>
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="mt-2 text-[11px] leading-relaxed text-neutral-400">{children}</p>
}

/**
 * The settings form.
 *
 * SAVING ON BLUR, with one rule the plan did not have: a value the server
 * refuses never stays on screen. The response to a PATCH is the settings AS
 * STORED, so a successful save re-renders the field from the database (`9:00`
 * becomes `09:00`, `moda, stil` becomes `#moda #stil`) and a failed one puts
 * the last accepted value back under the error message. A form that goes on
 * showing rejected text is a schedule the owner believes in and the cron run
 * has never heard of.
 */
export function SettingsForm({
  initial,
  limits,
  loadError,
}: {
  initial: FormValues
  limits: Limits
  /** Set when the server could not read the settings row at all. */
  loadError: string | null
}) {
  const router = useRouter()
  const [values, setValues] = useState<FormValues>(initial)
  const [status, setStatus] = useState<Status>(null)
  /** What the server has confirmed, per field. */
  const confirmed = useRef<FormValues>(initial)

  const save = useCallback(
    async (name: Field) => {
      const text = values[name]
      // Blurring without editing saves nothing: the confirmation means "that
      // went in", so firing it on every focus change would make it meaningless.
      if (text === confirmed.current[name]) return

      const patch =
        name === 'slots'
          ? { slots: text.split(',').map((s) => s.trim()).filter((s) => s !== '') }
          : { [name]: text }

      let res: Response | null = null
      try {
        res = await fetch('/api/settings', {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch),
        })
      } catch {
        res = null
      }

      if (res?.status === 401) {
        router.push('/login')
        return
      }

      if (!res || !res.ok) {
        const body = res ? await res.json().catch(() => null) : null
        const reason = (body as { error?: unknown } | null)?.error
        // Put the refused value back to what the database actually holds, so
        // the screen and the scheduler never disagree.
        setValues((v) => ({ ...v, [name]: confirmed.current[name] }))
        setStatus({
          field: name,
          state: 'error',
          message: typeof reason === 'string' && reason ? reason : FAILED_MESSAGE,
        })
        return
      }

      const saved = (await res.json().catch(() => null)) as {
        slots?: string[]; timezone?: string; hashtags?: string
      } | null
      const next: FormValues = {
        slots: Array.isArray(saved?.slots) ? saved.slots.join(', ') : confirmed.current.slots,
        timezone: typeof saved?.timezone === 'string' ? saved.timezone : confirmed.current.timezone,
        hashtags: typeof saved?.hashtags === 'string' ? saved.hashtags : confirmed.current.hashtags,
      }
      confirmed.current = next
      // Only the field that was saved is rewritten on screen: another field may
      // be half-typed and unblurred, and replacing it would discard that edit.
      setValues((v) => ({ ...v, [name]: next[name] }))
      setStatus({ field: name, state: 'saved' })
      // The queue page reads these settings for its slot labels and its
      // caption-length warning, so its server render is now stale.
      router.refresh()
    },
    [values, router],
  )

  const mark = (name: Field) =>
    status?.field === name ? (
      status.state === 'saved' ? (
        <span className="text-[11px] text-neutral-400">kaydedildi ✓</span>
      ) : (
        <span className="text-[11px] text-red-600">{status.message}</span>
      )
    ) : null

  const slotCount = values.slots.split(',').filter((s) => s.trim() !== '').length
  const tagCount = values.hashtags.split(/[\s,;]+/).filter((t) => t !== '' && t !== '#').length

  return (
    <main className="mx-auto max-w-xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-baseline justify-between gap-3 border-b border-neutral-200 pb-3">
        <h1 className="text-sm tracking-[0.2em] text-neutral-900">AYARLAR</h1>
        <Link href="/" className="text-[11px] text-neutral-500 underline-offset-4 hover:underline">
          ← kuyruk
        </Link>
      </header>

      {loadError && (
        <p className="mb-6 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {loadError}
        </p>
      )}

      <section className="mb-8">
        <label className="block">
          <span className="flex items-baseline justify-between gap-3">
            <Label>Yayın saatleri</Label>
            {mark('slots')}
          </span>
          <input
            value={values.slots}
            inputMode="numeric"
            placeholder="10:00, 14:00, 20:00"
            onChange={(e) => {
              setValues((v) => ({ ...v, slots: e.target.value }))
              if (status?.field === 'slots') setStatus(null)
            }}
            onBlur={() => void save('slots')}
            className={field}
          />
        </label>
        <Hint>
          Virgülle ayır, 24 saat biçiminde. En fazla {limits.maxSlots} saat. Şu an günde {slotCount}{' '}
          gönderi.
        </Hint>
        <Hint>
          Saatleri değiştirmek bugün paylaşılanları etkilemez: bir gün, o saate kadar programın
          izin verdiğinden fazla gönderi paylaşamaz. Saati geçmiş yeni bir slot bugün için
          çalışmaz — yarından itibaren geçerli olur.
        </Hint>
      </section>

      <section className="mb-8">
        <label className="block">
          <span className="flex items-baseline justify-between gap-3">
            <Label>Saat dilimi</Label>
            {mark('timezone')}
          </span>
          <input
            value={values.timezone}
            list="p2i-zones"
            placeholder="Europe/Istanbul"
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setValues((v) => ({ ...v, timezone: e.target.value }))
              if (status?.field === 'timezone') setStatus(null)
            }}
            onBlur={() => void save('timezone')}
            className={field}
          />
        </label>
        <datalist id="p2i-zones">
          {SUGGESTED_ZONES.map((z) => (
            <option key={z} value={z} />
          ))}
        </datalist>
        <Hint>Yayın saatleri bu saat dilimine göre hesaplanır. Yaz saati kendiliğinden uygulanır.</Hint>
      </section>

      <section className="mb-8">
        <label className="block">
          <span className="flex items-baseline justify-between gap-3">
            <Label>Sabit hashtag&apos;ler</Label>
            {mark('hashtags')}
          </span>
          <textarea
            value={values.hashtags}
            rows={3}
            placeholder="#moda #stil"
            onChange={(e) => {
              setValues((v) => ({ ...v, hashtags: e.target.value }))
              if (status?.field === 'hashtags') setStatus(null)
            }}
            onBlur={() => void save('hashtags')}
            className={`${field} resize-none leading-relaxed`}
          />
        </label>
        <Hint>
          Her gönderinin açıklamasının altına eklenir. {tagCount}/{limits.maxHashtags} hashtag ·{' '}
          {values.hashtags.trim().length}/{limits.maxHashtagChars} karakter. Instagram açıklamayı
          hashtag&apos;lerle birlikte 2200 karakterle sınırlar.
        </Hint>
      </section>

      <section className="border-t border-neutral-200 pt-6">
        <Label>Şifre</Label>
        {/*
          The design spec puts the password on this screen. It cannot live here:
          ADMIN_PASSWORD is an environment variable, and src/lib/auth.ts derives
          the session signing key from it — the running app has no way to change
          it, and an input box that silently did nothing would be worse than
          saying where it actually is.
        */}
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
          Giriş şifresi <code className="text-neutral-700">ADMIN_PASSWORD</code> ortam
          değişkeninde tutulur, bu ekranda değil. Değiştirmek için Vercel &rsaquo; Project
          &rsaquo; Settings &rsaquo; Environment Variables altında güncelleyip{' '}
          <strong>yeniden dağıtın (redeploy)</strong>; yeni değer ancak dağıtımdan sonra geçerli
          olur.
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-neutral-500">
          Şifre oturum imzasının anahtarını da belirler: değiştirdiğinizde{' '}
          <strong>açık olan bütün oturumlar kapanır</strong> ve her cihazda yeniden giriş
          gerekir.
        </p>
      </section>
    </main>
  )
}
