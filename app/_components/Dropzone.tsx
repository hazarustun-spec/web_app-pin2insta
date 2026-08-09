'use client'

import { useRef, useState } from 'react'
import { CARD_MIME } from './Card'

export type UploadProgress = { done: number; total: number } | null

export function Dropzone({
  progress,
  onFiles,
}: {
  progress: UploadProgress
  onFiles: (files: File[]) => void
}) {
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement | null>(null)

  function take(list: FileList | null) {
    const files = list ? [...list] : []
    if (files.length > 0) onFiles(files)
  }

  const busy = progress !== null

  return (
    <div
      onDragOver={(e) => {
        // A card being dragged for reordering must not be swallowed here.
        if (e.dataTransfer.types.includes(CARD_MIME)) return
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes(CARD_MIME)) return
        e.preventDefault()
        setOver(false)
        take(e.dataTransfer.files)
      }}
      onClick={() => input.current?.click()}
      className={`mb-8 grid h-40 cursor-pointer place-items-center border border-dashed text-xs transition-colors ${
        over ? 'border-neutral-900 text-neutral-900' : 'border-neutral-300 text-neutral-400'
      }`}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp,image/avif"
        className="hidden"
        onChange={(e) => {
          take(e.target.files)
          // Lets the same file be picked twice in a row.
          e.target.value = ''
        }}
      />
      {busy ? (
        <span>
          yükleniyor… {progress.done}/{progress.total}
        </span>
      ) : (
        <span>Görselleri buraya bırak · veya tıkla</span>
      )}
    </div>
  )
}
