'use client'

import { CaptionField } from './CaptionField'
import { ScheduleField } from './ScheduleField'
import { needsCaption, isUnrecorded, type CardTime, type ViewItem } from '@/src/lib/queue/view'

/**
 * A private drag type, so a card drag and a file drop can never be mistaken for
 * one another: the dropzone ignores anything carrying this, and the cards
 * ignore anything that does not.
 */
export const CARD_MIME = 'application/x-p2i-item'

export function Card({
  item,
  time,
  timezone,
  takenKeysFor,
  selected,
  dragging,
  dropTarget,
  onSelect,
  onCaptionSaved,
  onScheduled,
  onAdvance,
  onDragStart,
  onDragOver,
  onDragEnd,
  onDrop,
}: {
  item: ViewItem
  /** When this item goes out, or null for one no publish will ever reach. */
  time: CardTime | null
  /** The zone the schedule runs in, for the date-and-time control. */
  timezone: string
  takenKeysFor: (id: string) => Set<string>
  selected: boolean
  dragging: boolean
  dropTarget: boolean
  onSelect: (id: string, on: boolean) => void
  onCaptionSaved: (id: string, caption: string) => void
  onScheduled: (id: string, scheduledAt: string | null) => void
  onAdvance: (id: string) => void
  onDragStart: (id: string) => void
  onDragOver: (id: string) => void
  onDragEnd: () => void
  onDrop: (id: string) => void
}) {
  const missing = needsCaption(item)
  const stuck = isUnrecorded(item)
  const cover = item.images[0]?.url

  return (
    <div
      className={`relative border border-neutral-200 bg-white transition-opacity ${
        dragging ? 'opacity-40' : ''
      } ${dropTarget ? 'p2i-drop-target' : ''}`}
      onDragOver={(e) => {
        // A file drop is the dropzone's business; only a card drag is ours.
        if (!e.dataTransfer.types.includes(CARD_MIME)) return
        e.preventDefault()
        onDragOver(item.id)
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes(CARD_MIME)) return
        e.preventDefault()
        onDrop(item.id)
      }}
    >
      <label className="absolute top-2 left-2 z-10 cursor-pointer p-1">
        <input
          type="checkbox"
          checked={selected}
          aria-label="seç"
          onChange={(e) => onSelect(item.id, e.target.checked)}
          className="h-3.5 w-3.5 accent-neutral-900"
        />
      </label>

      {/* The picture is the drag handle. Making the whole card draggable would
          fight the textarea: in several browsers a draggable ancestor stops
          you selecting text inside it. */}
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.effectAllowed = 'move'
          e.dataTransfer.setData(CARD_MIME, item.id)
          onDragStart(item.id)
        }}
        onDragEnd={onDragEnd}
        className="relative aspect-[4/5] cursor-grab overflow-hidden bg-neutral-50 active:cursor-grabbing"
      >
        {cover ? (
          /* next/image would need a `remotePatterns` entry for the Blob host in
             next.config.ts, which this task must not touch. These objects are
             already cropped to 4:5 and served from a CDN, so the optimiser has
             little left to do. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={cover} alt="" draggable={false} className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full place-items-center text-[10px] text-neutral-400">görsel yok</span>
        )}
        {item.kind === 'carousel' && (
          <span className="absolute top-2 right-2 bg-white/90 px-1 text-[10px] tracking-wider">
            {item.images.length}
          </span>
        )}
        {item.kind === 'story' && (
          <span className="absolute top-2 right-2 bg-white/90 px-1 text-[10px] tracking-wider">
            STORY
          </span>
        )}
      </div>

      <CaptionField
        itemId={item.id}
        initial={item.caption}
        onSaved={onCaptionSaved}
        onAdvance={onAdvance}
      />

      <ScheduleField
        itemId={item.id}
        value={item.scheduledAt}
        timezone={timezone}
        takenKeysFor={takenKeysFor}
        onSaved={onScheduled}
      />

      <div className="flex items-center justify-between gap-2 px-2 py-1.5 text-[11px] text-neutral-500">
        {/* Says WHICH kind of time this is — one the owner chose, or the slot
            the queue computed — and turns red for a time that will produce no
            post at all: one that has gone by, or one whose caption the
            publisher refuses. */}
        <span className={`truncate ${time?.warn ? 'text-red-600' : ''}`} title={time?.text ?? ''}>
          {time?.text ?? '—'}
        </span>
        <span className="shrink-0">
          {stuck ? (
            <span className="text-red-600" title="Instagram'a gitti ama kaydedilemedi">
              kaydedilmedi
            </span>
          ) : item.status === 'failed' ? (
            <span className="text-red-600" title={item.error ?? ''}>
              hata
            </span>
          ) : missing ? (
            <span className="text-red-600">açıklama yok</span>
          ) : null}
        </span>
      </div>
    </div>
  )
}
