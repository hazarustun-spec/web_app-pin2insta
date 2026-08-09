'use client'

import { useCallback, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Dropzone, type UploadProgress } from './Dropzone'
import { QueueGrid } from './QueueGrid'
import { QueueBanner } from './QueueBanner'
import { SelectionBar } from './SelectionBar'
import { uploadFiles } from '../_lib/upload'
import {
  describeUploadResults,
  moveId,
  nextCaptionlessId,
  queueStatus,
  resolveViewSettings,
  slotLabels,
  type Note,
  type ViewItem,
  type ViewSettings,
} from '@/src/lib/queue/view'

/**
 * Reads a route's Turkish error message, falling back when the body is not ours.
 *
 * The queue routes answer a refusal the owner can act on — "karusel 2 ile 10
 * görsel içermelidir", "paylaşılmış gönderi silinemez" — as `{ error }`, and
 * swallowing that in favour of a generic sentence would hide the one thing that
 * says what to do next.
 */
async function reason(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null
  return typeof body?.error === 'string' && body.error ? body.error : fallback
}

/**
 * The queue page's behaviour. Everything interactive lives here; `app/page.tsx`
 * reads the first copy of the queue on the server and hands it over as props,
 * so the page paints with cards already in it and there is no fetch-on-mount
 * effect to cascade renders.
 */
export function QueueClient({
  initialItems,
  initialSettings,
  loadError,
}: {
  initialItems: ViewItem[]
  initialSettings: ViewSettings
  /** Set when the server could not read the queue at all. */
  loadError: string | null
}) {
  const router = useRouter()
  const [items, setItems] = useState<ViewItem[]>(initialItems)
  const [settings, setSettings] = useState<ViewSettings>(initialSettings)
  const [notes, setNotes] = useState<Note[]>(loadError ? [{ tone: 'error', text: loadError }] : [])
  const [progress, setProgress] = useState<UploadProgress>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  const note = useCallback((text: string, tone: Note['tone'] = 'error') => {
    setNotes((prev) => [...prev, { tone, text }])
  }, [])

  /**
   * Re-reads the queue after a mutation. Only ever called from an event
   * handler, never on mount — the first copy came from the server.
   */
  const load = useCallback(async () => {
    try {
      const [itemsRes, settingsRes] = await Promise.all([
        fetch('/api/items'),
        // Swallowed on purpose: an unhandled r.json() here would take down a
        // page that is otherwise working perfectly well on defaults.
        fetch('/api/settings').catch(() => null),
      ])
      if (itemsRes.status === 401) {
        router.push('/login')
        return
      }
      if (!itemsRes.ok) {
        note('Kuyruk yüklenemedi.')
        return
      }
      setItems((await itemsRes.json()) as ViewItem[])
      if (settingsRes?.ok) {
        setSettings(resolveViewSettings(await settingsRes.json().catch(() => null)))
      }
    } catch {
      note('Kuyruk yüklenemedi.')
    }
  }, [note, router])

  // ── Captions ─────────────────────────────────────────────────────────────

  /**
   * A saved caption updates the local row and nothing else. Deliberately NOT a
   * reload: the banners and the ⌘↵ target must follow along immediately, but a
   * refetch mid-run would replace every card while several save animations are
   * still playing.
   */
  const onCaptionSaved = useCallback((id: string, caption: string) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, caption } : i)))
  }, [])

  /**
   * `⌘↵` jumps to the next caption-less card, found by element id.
   *
   * The plan indexed `document.querySelectorAll('textarea')` by a position
   * taken from a differently-filtered array, which lands on the wrong card the
   * moment the two lists disagree — which they do as soon as anything is
   * filtered out of either. An id names the card it belongs to and cannot
   * drift. Not memoised, so it always sees the current queue.
   */
  function onAdvance(fromId: string) {
    const next = nextCaptionlessId(items, fromId)
    if (!next) return
    const el = document.getElementById(`caption-${next}`)
    if (el instanceof HTMLTextAreaElement) {
      el.focus()
      el.setSelectionRange(el.value.length, el.value.length)
    }
  }

  // ── Uploads ──────────────────────────────────────────────────────────────

  const onFiles = useCallback(
    async (files: File[]) => {
      setProgress({ done: 0, total: files.length })
      try {
        const results = await uploadFiles(files, (done, total) => setProgress({ done, total }))
        setNotes(describeUploadResults(results))
      } catch (e) {
        // Nothing in uploadFiles rejects today — every worker and every ingest
        // POST is wrapped. The finally is what guarantees the dropzone can
        // never stick on "yükleniyor…" with no notes, which is the shape of a
        // drop that vanishes without explanation.
        console.error('upload failed', e)
        setNotes([{ tone: 'error', text: 'yükleme tamamlanamadı' }])
      } finally {
        setProgress(null)
      }
      await load()
    },
    [load],
  )

  // ── Mutations ────────────────────────────────────────────────────────────

  const onReorder = useCallback(
    async (dragId: string, overId: string) => {
      const before = items
      const ids = before.map((i) => i.id)
      const next = moveId(ids, dragId, overId)
      if (next === ids) return

      const byId = new Map(before.map((i) => [i.id, i]))
      setItems(next.map((id) => byId.get(id)!))

      const res = await fetch('/api/items/reorder', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // The WHOLE non-posted queue, in the new order. applyOrder refuses a
        // subset outright, because reindex hands out 1..n densely and
        // renumbering part of the queue would collide with the rest.
        body: JSON.stringify({ ids: next }),
      }).catch(() => null)

      if (!res || !res.ok) {
        // Put the queue back rather than leave the screen disagreeing with the
        // database about what publishes next.
        setItems(before)
        note(res ? await reason(res, 'Sıralama kaydedilemedi.') : 'Sıralama kaydedilemedi.')
      }
    },
    [items, note],
  )

  const runOnSelection = useCallback(
    async (
      request: (id: string) => Promise<Response | null>,
      fallback: string,
    ) => {
      setBusy(true)
      const failures: string[] = []
      for (const id of selected) {
        const res = await request(id).catch(() => null)
        if (!res || !res.ok) failures.push(res ? await reason(res, fallback) : fallback)
      }
      setBusy(false)
      setSelected(new Set())
      // Deduplicated: fifty single-image items refused for carousel would
      // otherwise print the same sentence fifty times.
      for (const message of new Set(failures)) note(message)
      await load()
    },
    [selected, note, load],
  )

  const onKind = useCallback(
    (kind: 'feed' | 'story') =>
      runOnSelection(
        (id) =>
          fetch(`/api/items/${id}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ kind }),
          }),
        'Gönderi türü değiştirilemedi.',
      ),
    [runOnSelection],
  )

  const onDelete = useCallback(() => {
    if (!confirm(`${selected.size} gönderi silinecek. Emin misin?`)) return
    return runOnSelection((id) => fetch(`/api/items/${id}`, { method: 'DELETE' }), 'Silinemedi.')
  }, [runOnSelection, selected.size])

  const onGroup = useCallback(async () => {
    // Grouping cannot be undone: there is no ungroup endpoint, and re-uploading
    // the images of a split carousel is refused by hash dedupe until the item
    // is deleted. Say so before doing it.
    if (
      !confirm(
        `${selected.size} görsel tek bir carousel'e dönüşecek.\n\n` +
          'Bu geri alınamaz: grubu çözmenin bir yolu yok ve aynı görselleri tekrar ' +
          'yüklemek, gönderi silinene kadar "zaten var" diye reddedilir.',
      )
    ) {
      return
    }
    setBusy(true)
    const res = await fetch('/api/items/group', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // The id order is the carousel order, and a Set preserves insertion
      // order — which is the order the owner ticked the boxes in.
      body: JSON.stringify({ ids: [...selected] }),
    }).catch(() => null)
    setBusy(false)
    if (!res || !res.ok) note(res ? await reason(res, 'Gruplanamadı.') : 'Gruplanamadı.')
    setSelected(new Set())
    await load()
  }, [selected, note, load])

  const onLogout = useCallback(async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => null)
    router.push('/login')
    router.refresh()
  }, [router])

  // ── Derived ──────────────────────────────────────────────────────────────

  // Plain calls, not memos. A slot label is relative to "now", so a memo keyed
  // on the queue would keep showing "Bugün 20:00" for a slot that passed an
  // hour ago; and both functions are a single pass over a queue of at most a
  // few hundred rows.
  const status = queueStatus(items, settings)
  const labels = slotLabels(items, settings, new Date())

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3 border-b border-neutral-200 pb-3">
        <h1 className="text-sm tracking-[0.2em] text-neutral-900">PIN2INSTA</h1>
        <div className="flex items-center gap-4 text-[11px] text-neutral-500">
          <span>
            {settings.slots.length}/gün · {status.daysLeft} gün
          </span>
          <a href="/published" className="underline-offset-4 hover:underline">
            yayınlananlar
          </a>
          <a href="/settings" className="underline-offset-4 hover:underline">
            ayarlar
          </a>
          <button type="button" onClick={onLogout} className="underline-offset-4 hover:underline">
            çıkış
          </button>
        </div>
      </header>

      <QueueBanner
        headBlockedReason={status.headBlockedReason}
        missingCaptions={status.missingCaptions}
        captionsTooLong={status.captionsTooLong}
        unrecorded={status.unrecordedIds.length}
        failed={status.failedIds.length}
        daysLeft={status.daysLeft}
        waiting={status.waiting}
        notes={notes}
        onDismissNotes={() => setNotes([])}
      />

      <Dropzone progress={progress} onFiles={onFiles} />

      <SelectionBar
        count={selected.size}
        busy={busy}
        onGroup={onGroup}
        onKind={onKind}
        onDelete={onDelete}
        onClear={() => setSelected(new Set())}
      />

      <QueueGrid
          items={items}
          slotLabels={labels}
          selected={selected}
          onSelect={(id, on) =>
            setSelected((prev) => {
              const next = new Set(prev)
              if (on) next.add(id)
              else next.delete(id)
              return next
            })
          }
          onCaptionSaved={onCaptionSaved}
          onAdvance={onAdvance}
        onReorder={onReorder}
      />
    </main>
  )
}
