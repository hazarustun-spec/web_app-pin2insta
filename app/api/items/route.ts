import { NextResponse } from 'next/server'
import { ingestBuffer, listQueue, IngestError } from '@/src/lib/queue/repo'

export const maxDuration = 300

// A cheap early reject on the declared type. This is NOT a security boundary:
// file.type is client-supplied and never checked against the bytes. Format is
// enforced for real in cropTo45, which reads the actual container header.
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
// Caps bytes on the wire for one file. Decoded-bitmap memory is a separate
// concern bounded by MAX_PIXELS in cropTo45 — a 2MB image can decode to 458MB.
const MAX_FILE_BYTES = 25 * 1024 * 1024
// Caps files per request. Enforced BEFORE the ingest loop, because
// req.formData() has already buffered every part by then — rejecting mid-loop
// would let 200 files sit in memory while we politely skip 150 of them.
const MAX_BATCH_FILES = 50
// Ceiling on the whole multipart body, checked from Content-Length before
// formData() reads anything. Vercel Functions accept up to 100MB; note that
// next.config.ts's proxyClientMaxBodySize governs what actually arrives here,
// since /api/items sits behind proxy.ts.
const MAX_TOTAL_BYTES = 100 * 1024 * 1024

type Result =
  | { status: 'added'; itemId: string; name: string }
  | { status: 'duplicate'; name: string }
  | { status: 'error'; name: string; message: string }

export async function GET() {
  return NextResponse.json(await listQueue())
}

export async function POST(req: Request) {
  // Reject an oversized body before formData() materializes it.
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: 'istek çok büyük' }, { status: 413 })
  }

  const form = await req.formData()
  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) return NextResponse.json({ error: 'no files' }, { status: 400 })
  if (files.length > MAX_BATCH_FILES) {
    return NextResponse.json(
      { error: `çok fazla dosya — bir seferde en fazla ${MAX_BATCH_FILES} görsel yükleyin` },
      { status: 413 },
    )
  }

  const results: Result[] = []
  for (const file of files) {
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
