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
  headBlockedReason,
  missingCaptions,
  captionsTooLong,
  unrecorded,
  failed,
  missed,
  scheduledBlocked,
  daysLeft,
  waiting,
  scheduledWaiting,
  notes,
  onDismissNotes,
}: {
  headBlockedReason: 'missing-caption' | 'caption-too-long' | null
  missingCaptions: number
  captionsTooLong: number
  unrecorded: number
  failed: number
  /** Items whose chosen time went by with nothing posted. */
  missed: number
  /** Items whose chosen time is still ahead but which cannot publish when it arrives. */
  scheduledBlocked: number
  daysLeft: number
  waiting: number
  scheduledWaiting: number
  notes: Note[]
  onDismissNotes: () => void
}) {
  const headBlocked = headBlockedReason !== null
  return (
    <>
      {headBlockedReason === 'missing-caption' && (
        <Alarm>
          Sıradaki gönderinin açıklaması yok — <strong>kuyruk durdu</strong>. Sıra atlanmaz, bu
          gönderiye açıklama yazılana kadar hiçbir gönderi paylaşılmaz.
        </Alarm>
      )}
      {headBlockedReason === 'caption-too-long' && (
        // The characters that broke it may not be in the caption at all: the
        // fixed hashtag block from the settings screen is appended to every
        // post and counts towards the same 2200.
        <Alarm>
          Sıradaki gönderinin açıklaması, sabit hashtag&apos;lerle birlikte 2200 karakteri aşıyor —{' '}
          <strong>kuyruk durdu</strong>. Açıklamayı kısaltın veya{' '}
          <a href="/settings" className="underline underline-offset-4">ayarlardan</a>{' '}
          hashtag&apos;leri azaltın.
        </Alarm>
      )}
      {unrecorded > 0 && (
        <Alarm>
          {unrecorded} gönderi Instagram&apos;a gitti ama kaydedilemedi. Kuyrukta duruyor ve
          slotunu tuttuğu için tekrar paylaşılmaz. Instagram&apos;da kontrol edin — silecekseniz
          o slotun saati geçtikten sonra silin, yoksa aynı slota yeni bir gönderi girer.
        </Alarm>
      )}
      {failed > 0 && (
        <Alarm>{failed} gönderi üç denemede de paylaşılamadı.</Alarm>
      )}
      {missed > 0 && (
        // A missed time is invisible otherwise: nothing was attempted, so the
        // item is not `failed`, and it looks exactly like an ordinary pending
        // card — except no slot will ever be spent on it either, because it
        // carries a time of its own. It waits forever until someone acts.
        <Alarm>
          {missed} gönderinin seçilen saati geçti — paylaşılmadı. Geçmiş bir saat ileri
          taşınmaz: yeni bir saat seçin ya da saati kaldırın, sıradaki boş slota girsin.
        </Alarm>
      )}
      {scheduledBlocked > 0 && (
        // Its time is coming and it will pass with nothing posted — and no slot
        // is spent instead, so this costs a post outright.
        <Alarm>
          {scheduledBlocked} gönderinin saati seçilmiş ama açıklaması yayına uygun değil —
          o saat boş geçecek.
        </Alarm>
      )}
      {missingCaptions > 0 && !headBlocked && (
        // NOT "skipped". selectForSlot only looks at the head and never steps
        // past it, so an uncaptioned item stops the queue there — the slot goes
        // empty and everything behind it waits indefinitely. Saying "skipped"
        // told the owner the one thing that would make them leave it alone.
        <Alarm>
          {missingCaptions} gönderinin açıklaması eksik — sırası gelince kuyruk orada duracak,
          sonrakiler paylaşılmayacak.
        </Alarm>
      )}
      {captionsTooLong > 0 && headBlockedReason !== 'caption-too-long' && (
        <Alarm>
          {captionsTooLong} gönderinin açıklaması sabit hashtag&apos;lerle birlikte 2200 karakteri
          aşıyor — sırası gelince kuyruk orada duracak.
        </Alarm>
      )}
      {waiting > 0 && daysLeft < 3 && (
        // daysLeft counts only the items the slots will spend. A queue of
        // nothing but scheduled posts therefore reads 0 — "the queue runs out
        // in 0 days" beside a screen full of future posts — so the scheduled
        // ones are named rather than silently excluded.
        <Alarm>
          Slotlara verilecek gönderi {daysLeft} gün sonra bitiyor.
          {scheduledWaiting > 0 && ` Ayrıca saati seçilmiş ${scheduledWaiting} gönderi bekliyor.`}
          {' '}Yeni görsel ekle.
        </Alarm>
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
