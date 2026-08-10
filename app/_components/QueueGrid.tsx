'use client'

import { useState } from 'react'
import { Card } from './Card'
import type { CardTime, ViewItem } from '@/src/lib/queue/view'

/**
 * The grid, and the drag state that belongs to it.
 *
 * Plain HTML drag-and-drop, no library: the whole interaction is "pick up a
 * card, drop it on another one", and the page already owns the order.
 */
export function QueueGrid({
  items,
  times,
  timezone,
  takenKeysFor,
  selected,
  onSelect,
  onCaptionSaved,
  onScheduled,
  onAdvance,
  onReorder,
}: {
  items: ViewItem[]
  times: Map<string, CardTime>
  timezone: string
  takenKeysFor: (id: string) => Set<string>
  selected: Set<string>
  onSelect: (id: string, on: boolean) => void
  onCaptionSaved: (id: string, caption: string) => void
  onScheduled: (id: string, scheduledAt: string | null) => void
  onAdvance: (id: string) => void
  onReorder: (dragId: string, overId: string) => void
}) {
  const [dragId, setDragId] = useState<string | null>(null)
  const [overId, setOverId] = useState<string | null>(null)

  if (items.length === 0) {
    return <p className="py-16 text-center text-xs text-neutral-400">Kuyruk boş.</p>
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
      {items.map((item) => (
        <Card
          key={item.id}
          item={item}
          time={times.get(item.id) ?? null}
          timezone={timezone}
          takenKeysFor={takenKeysFor}
          selected={selected.has(item.id)}
          dragging={dragId === item.id}
          dropTarget={overId === item.id && dragId !== null && dragId !== item.id}
          onSelect={onSelect}
          onCaptionSaved={onCaptionSaved}
          onScheduled={onScheduled}
          onAdvance={onAdvance}
          onDragStart={setDragId}
          onDragOver={setOverId}
          onDragEnd={() => {
            setDragId(null)
            setOverId(null)
          }}
          onDrop={(id) => {
            if (dragId && dragId !== id) onReorder(dragId, id)
            setDragId(null)
            setOverId(null)
          }}
        />
      ))}
    </div>
  )
}
