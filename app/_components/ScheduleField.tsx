'use client'

import { useState } from 'react'
import { chooseSchedule, scheduleInputValue } from '@/src/lib/queue/view'

/** The message shown when the request itself fails, as opposed to being refused. */
const FAILED_MESSAGE = 'kaydedilemedi, tekrar dene'

/**
 * The date and time this one post goes out at. Empty means "use the next free
 * slot", which is what every item did before this control existed.
 *
 * TWO THINGS ARE EASY TO GET WRONG HERE, and both are handled in
 * `src/lib/queue/view.ts` so the server can apply exactly the same rule:
 *
 * - a `datetime-local` value is a wall-clock string with NO zone. Reading it
 *   with `new Date(value)` uses the BROWSER's zone, so the owner on holiday
 *   would schedule posts that go out at the wrong hour. `parseScheduleInput`
 *   resolves it in the zone the schedule actually runs in.
 * - a minute is a claim. Two items on the same minute of the same day are one
 *   row in `items_slot_unique_idx`, so the second one silently does not
 *   publish. `scheduleProblem` refuses that here, before it is saved.
 *
 * The server re-applies both — this page cannot see a minute another tab took
 * a second ago — and its refusal is shown verbatim.
 */
export function ScheduleField({
  itemId,
  value,
  timezone,
  takenKeysFor,
  onSaved,
}: {
  itemId: string
  /** The stored instant as an ISO string, or null. */
  value: string | null
  /** The zone the schedule runs in — NOT the browser's. */
  timezone: string
  /** The minutes other cards already hold, computed at commit time. */
  takenKeysFor: (id: string) => Set<string>
  onSaved: (id: string, scheduledAt: string | null) => void
}) {
  const stored = scheduleInputValue(value, timezone)
  const [draft, setDraft] = useState(stored)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function send(next: string | null) {
    setBusy(true)
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scheduledAt: next }),
      })
      if (!res.ok) {
        // The route answers a refusal the owner can act on — "bu dakika dolu",
        // "geçmiş bir saat seçilemez" — as { error }. That sentence is the only
        // thing that says what to do next, so it wins over the generic one.
        const body = (await res.json().catch(() => null)) as { error?: unknown } | null
        const reason = typeof body?.error === 'string' && body.error ? body.error : FAILED_MESSAGE
        setError(reason)
        // Put the control back to what the server actually holds, so the card
        // never shows a time that was not saved.
        setDraft(stored)
        return
      }
      setError(null)
      onSaved(itemId, next)
    } catch {
      setError(FAILED_MESSAGE)
      setDraft(stored)
    } finally {
      setBusy(false)
    }
  }

  function commit(next: string) {
    if (next === stored) {
      setError(null)
      return
    }
    // The same rule the server applies, so the owner is told before the round
    // trip and told the same thing either way. The server stays the authority:
    // this page cannot see a minute another tab took a second ago.
    const choice = chooseSchedule(next, timezone, new Date(), takenKeysFor(itemId))
    if ('error' in choice) {
      setError(choice.error)
      return
    }
    void send(choice.scheduledAt)
  }

  return (
    <div className="px-2 pb-1.5">
      <div className="flex items-center gap-1">
        <input
          type="datetime-local"
          id={`schedule-${itemId}`}
          aria-label="yayın saati"
          value={draft}
          disabled={busy}
          onChange={(e) => {
            setDraft(e.target.value)
            if (error) setError(null)
          }}
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit(draft)
            }
          }}
          className="w-full bg-transparent text-[10px] text-neutral-500 outline-none"
        />
        {draft !== '' && (
          <button
            type="button"
            // "Clear" is not decoration: it is how an item goes back to the
            // ordinary queue, and how a missed time is taken off a card.
            title="saati kaldır — sıradaki boş slota gitsin"
            aria-label="saati kaldır"
            disabled={busy}
            onClick={() => {
              setDraft('')
              commit('')
            }}
            className="shrink-0 px-1 text-[10px] text-neutral-400 hover:text-neutral-900"
          >
            ×
          </button>
        )}
      </div>
      {error && (
        <p className="truncate text-[10px] text-red-600" title={error}>
          {error}
        </p>
      )}
    </div>
  )
}
