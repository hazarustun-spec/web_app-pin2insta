'use client'

import { useCallback, useEffect, useRef, useState } from 'react'

type State = 'idle' | 'saved' | 'error'

/**
 * How long the whole confirmation takes: 180ms in + 900ms hold + 200ms out.
 * The border starts its 400ms walk back to grey when this fires.
 */
const CONFIRM_MS = 1280

/** The message the design spec pins for a failed save. */
const FAILED_MESSAGE = 'kaydedilemedi, tekrar dene'

export function CaptionField({
  itemId,
  initial,
  onSaved,
  onAdvance,
}: {
  itemId: string
  initial: string
  /** Reports the new caption up so banners and the ⌘↵ target stay honest. */
  onSaved: (id: string, caption: string) => void
  /** ⌘↵: move to the next caption-less card. Called whether or not a save happened. */
  onAdvance: (id: string) => void
}) {
  const [value, setValue] = useState(initial)
  const [state, setState] = useState<State>('idle')
  const [message, setMessage] = useState(FAILED_MESSAGE)
  /**
   * Forces React to remount the sweep and the checkmark on every save. Without
   * a changing key the elements are reused, the CSS animations do not restart,
   * and a second save plays nothing at all. A counter rather than the plan's
   * `key={value}` because two saves can legitimately carry the same text (a
   * retry after a failure).
   */
  const [seq, setSeq] = useState(0)

  /** The caption the server has confirmed. */
  const confirmed = useRef(initial)
  /** The caption of the most recent attempt, in flight or done. */
  const attempted = useRef(initial)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])

  const save = useCallback(async () => {
    // Unchanged text saves nothing and plays nothing: the animation means "that
    // went in", so firing it on every blur would make it meaningless.
    if (value === attempted.current) return
    const attempt = value
    attempted.current = attempt

    // Optimistic on purpose. The confirmation plays now, not when the request
    // resolves, so a run of captions never waits on the network.
    if (timer.current) clearTimeout(timer.current)
    setState('saved')
    setSeq((n) => n + 1)
    timer.current = setTimeout(() => setState('idle'), CONFIRM_MS)

    let failure: string | null = null
    try {
      const res = await fetch(`/api/items/${itemId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ caption: attempt }),
      })
      if (!res.ok) {
        // A refusal we can explain (a caption over 2200 characters) is worth
        // more than the generic line, which tells the owner to retry something
        // that will fail again in exactly the same way.
        const body = await res.json().catch(() => null)
        const reason = (body as { error?: unknown } | null)?.error
        failure = typeof reason === 'string' && reason ? reason : FAILED_MESSAGE
      }
    } catch {
      failure = FAILED_MESSAGE
    }

    if (failure) {
      // A later attempt has already superseded this one; its own result decides.
      if (attempted.current !== attempt) return
      // Roll the attempt marker back to what the server actually has, so
      // blurring again — with no edit in between — retries instead of
      // silently deciding there is nothing to save.
      attempted.current = confirmed.current
      if (timer.current) clearTimeout(timer.current)
      setMessage(failure)
      setState('error')
      return
    }

    confirmed.current = attempt
    onSaved(itemId, attempt)
  }, [itemId, value, onSaved])

  return (
    <div className="relative">
      {/* pb-5/pr-6 on the textarea reserve a permanent strip for the checkmark
          and the failure message. Reserved, not made room for on demand — that
          is what keeps the card exactly the same size whether or not something
          is playing. */}
      <textarea
        id={`caption-${itemId}`}
        value={value}
        rows={2}
        placeholder="açıklama…"
        data-saving={state === 'saved'}
        onChange={(e) => {
          setValue(e.target.value)
          if (state === 'error') setState('idle')
        }}
        onBlur={save}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            // Not awaited: focus moves on while this card's confirmation plays,
            // which is the whole point of the trail of checkmarks.
            void save()
            onAdvance(itemId)
          }
        }}
        className="p2i-field w-full resize-none bg-transparent pt-2 pr-6 pb-5 pl-2 text-[13px] leading-snug text-neutral-900 outline-none placeholder:text-neutral-300"
      />
      {state === 'saved' && (
        <>
          <span key={`s${seq}`} className="p2i-sweep" />
          <span key={`c${seq}`} className="p2i-check" aria-hidden="true">✓</span>
        </>
      )}
      {state === 'error' && (
        <>
          <span className="p2i-error-rule" />
          {/* Absolutely positioned like the checkmark, inside the strip the
              textarea's padding reserves: an error must not push the card
              taller and shove the rest of the grid down. */}
          <span className="absolute right-2 bottom-1 left-2 truncate text-right text-[10px] text-red-600" title={message}>
            {message}
          </span>
        </>
      )}
    </div>
  )
}
