'use client'

import type { Note } from '@/src/lib/queue/view'

function Alarm({ children }: { children: React.ReactNode }) {
  return (
    <p className="mb-3 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{children}</p>
  )
}

/**
 * The states that stop the schedule without looking like anything is wrong.
 *
 * The two that matter most are not "some captions are missing":
 *
 * - `headBlocked`: `selectForSlot` only ever looks at the head of the queue and
 *   deliberately never skips past it, so ONE uncaptioned card at position 1
 *   silently stops every slot from now on. This is said plainly, on its own.
 * - `unrecorded`: Instagram accepted the post but the row could not be updated,
 *   so it sits in the queue with `postedDate` set, `status` still pending,
 *   `error` null and `attempts` 0 — indistinguishable from a normal card, and
 *   permanently invisible to the publisher.
 */
export function QueueBanner({
  headBlocked,
  missingCaptions,
  unrecorded,
  failed,
  daysLeft,
  waiting,
  notes,
  onDismissNotes,
}: {
  headBlocked: boolean
  missingCaptions: number
  unrecorded: number
  failed: number
  daysLeft: number
  waiting: number
  notes: Note[]
  onDismissNotes: () => void
}) {
  return (
    <>
      {headBlocked && (
        <Alarm>
          Sıradaki gönderinin açıklaması yok — <strong>kuyruk durdu</strong>. Sıra atlanmaz, bu
          gönderiye açıklama yazılana kadar hiçbir gönderi paylaşılmaz.
        </Alarm>
      )}
      {unrecorded > 0 && (
        <Alarm>
          {unrecorded} gönderi Instagram&apos;a gitti ama kaydedilemedi. Kuyrukta duruyor, bir daha
          paylaşılmayacak — Instagram&apos;da kontrol edip silin.
        </Alarm>
      )}
      {failed > 0 && (
        <Alarm>{failed} gönderi üç denemede de paylaşılamadı.</Alarm>
      )}
      {missingCaptions > 0 && !headBlocked && (
        <Alarm>{missingCaptions} gönderinin açıklaması eksik — sırası gelince atlanacak.</Alarm>
      )}
      {waiting > 0 && daysLeft < 3 && (
        <Alarm>Kuyruk {daysLeft} gün sonra bitiyor. Yeni görsel ekle.</Alarm>
      )}
      {notes.length > 0 && (
        <div className="mb-3 flex items-start justify-between gap-4">
          <ul className="text-xs">
            {notes.map((n, i) => (
              <li key={`${n.tone}-${i}-${n.text}`} className={n.tone === 'error' ? 'text-red-600' : 'text-neutral-500'}>
                {n.text}
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onDismissNotes}
            className="shrink-0 text-[11px] text-neutral-400 underline-offset-4 hover:underline"
          >
            kapat
          </button>
        </div>
      )}
    </>
  )
}
