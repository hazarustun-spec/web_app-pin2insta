import { NextResponse } from 'next/server'
import { ingestBuffer, listQueue, IngestError } from '@/src/lib/queue/repo'

export const maxDuration = 300

// sharp's supported raster inputs; SVG is deliberately excluded so it never
// reaches sharp's renderer (SVGs can embed scripts/external references).
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
// Caps memory for a single decoded bitmap so one file can't exhaust the function.
const MAX_FILE_BYTES = 25 * 1024 * 1024
// Caps total files per request — req.formData() buffers every file into
// memory before the sequential ingest loop even starts, so this bounds that
// up-front buffering, not just the per-file crop/hash/upload work.
const MAX_BATCH_FILES = 50

type Result =
  | { status: 'added'; itemId: string; name: string }
  | { status: 'duplicate'; name: string }
  | { status: 'error'; name: string; message: string }

export async function GET() {
  return NextResponse.json(await listQueue())
}

export async function POST(req: Request) {
  const form = await req.formData()
  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) return NextResponse.json({ error: 'no files' }, { status: 400 })

  const results: Result[] = []
  for (const [index, file] of files.entries()) {
    if (index >= MAX_BATCH_FILES) {
      results.push({ status: 'error', name: file.name, message: 'çok fazla dosya — bir seferde en fazla 50 görsel yükleyin' })
      continue
    }
    if (!ALLOWED_TYPES.has(file.type)) {
      results.push({ status: 'error', name: file.name, message: 'desteklenmeyen dosya türü' })
      continue
    }
    if (file.size > MAX_FILE_BYTES) {
      results.push({ status: 'error', name: file.name, message: 'dosya çok büyük — en fazla 25MB olmalı' })
      continue
    }

    const buf = Buffer.from(await file.arrayBuffer())
    try {
      results.push(await ingestBuffer(buf, file.name))
    } catch (e) {
      if (e instanceof IngestError) {
        results.push({ status: 'error', name: file.name, message: e.message })
      } else {
        // Never surface raw internal exception text (Drizzle/Neon/Blob
        // errors can carry hostnames, paths, or worse) — log it server-side
        // and return a generic message instead.
        console.error('ingest failed:', file.name, e)
        results.push({ status: 'error', name: file.name, message: 'yüklenemedi' })
      }
    }
  }
  return NextResponse.json({ results })
}
