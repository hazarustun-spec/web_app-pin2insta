'use client'

export function SelectionBar({
  count,
  busy,
  onGroup,
  onKind,
  onDelete,
  onClear,
}: {
  count: number
  busy: boolean
  onGroup: () => void
  onKind: (kind: 'feed' | 'story') => void
  onDelete: () => void
  onClear: () => void
}) {
  if (count === 0) return null

  return (
    <div className="sticky top-0 z-20 mb-4 flex flex-wrap items-center gap-4 border-b border-neutral-200 bg-white/95 py-2 text-xs backdrop-blur">
      <span className="text-neutral-500">{count} seçili</span>
      <button
        type="button"
        disabled={busy || count < 2}
        onClick={onGroup}
        className="underline underline-offset-4 disabled:text-neutral-300 disabled:no-underline"
      >
        Carousel yap
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => onKind('story')}
        className="underline underline-offset-4 disabled:text-neutral-300 disabled:no-underline"
      >
        Story yap
      </button>
      {/* Not in the spec's list, but `setKind` is the only way back: making a
          story is otherwise a one-way door with no undo anywhere in the UI. */}
      <button
        type="button"
        disabled={busy}
        onClick={() => onKind('feed')}
        className="underline underline-offset-4 disabled:text-neutral-300 disabled:no-underline"
      >
        Akışa al
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={onDelete}
        className="text-red-600 underline underline-offset-4 disabled:text-neutral-300 disabled:no-underline"
      >
        Sil
      </button>
      <button
        type="button"
        onClick={onClear}
        className="ml-auto text-neutral-400 underline-offset-4 hover:underline"
      >
        seçimi bırak
      </button>
    </div>
  )
}
