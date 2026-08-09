import { NextResponse } from 'next/server'
import { ingestBuffer, ingestFromUrl, listQueue, IngestError } from '@/src/lib/queue/repo'

export const maxDuration = 300

// A cheap early reject on the declared type. This is NOT a security boundary:
// file.type is client-supplied and never checked against the bytes. Format is
// enforced for real in cropTo45, which reads the actual container header.
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/avif'])
// Caps bytes on the wire for one file. Decoded-bitmap memory is a separate
// concern bounded by MAX_PIXELS in cropTo45 — a 2MB image can decode to 458MB.
const MAX_FILE_BYTES = 4 * 1024 * 1024
// Caps files per request. Enforced BEFORE the ingest loop, because
// req.formData() has already buffered every part by then — rejecting mid-loop
// would let 200 files sit in memory while we politely skip 150 of them.
const MAX_BATCH_FILES = 50
// Ceiling on the whole multipart body, checked from Content-Length before
// formData() reads anything.
//
// 4MB, not a number of our choosing: Vercel Functions hard-cap a request body
// at 4.5MB and answer anything larger with 413 FUNCTION_PAYLOAD_TOO_LARGE
// before our code runs at all. A cap above that would be unreachable and the
// UI would see an opaque platform error instead of our message.
// See https://vercel.com/docs/functions/limitations#request-body-size
//
// This route therefore handles single images and small batches only. Bulk drops
// go through direct-to-Blob client upload, which bypasses the function body
// entirely — see app/api/blob/upload.
const MAX_TOTAL_BYTES = 4 * 1024 * 1024

type Result =
  | { status: 'added'; itemId: string; name: string }
  | { status: 'duplicate'; name: string }
  | { status: 'error'; name: string; message: string }

export async function GET() {
  return NextResponse.json(await listQueue())
}

type StagedUpload = { url: string; name: string }

function parseStaged(body: unknown): StagedUpload[] | null {
  if (typeof body !== 'object' || body === null) return null
  const uploads = (body as { uploads?: unknown }).uploads
  if (!Array.isArray(uploads)) return null
  const out: StagedUpload[] = []
  for (const u of uploads) {
    if (typeof u !== 'object' || u === null) return null
    const { url, name } = u as { url?: unknown; name?: unknown }
    if (typeof url !== 'string' || typeof name !== 'string') return null
    out.push({ url, name })
  }
  return out
}

async function postStaged(req: Request) {
  let parsed: StagedUpload[] | null
  try {
    parsed = parseStaged(await req.json())
  } catch {
    return NextResponse.json({ error: 'geçersiz istek' }, { status: 400 })
  }
  if (!parsed) return NextResponse.json({ error: 'geçersiz istek' }, { status: 400 })
  if (parsed.length === 0) return NextResponse.json({ error: 'no files' }, { status: 400 })
  if (parsed.length > MAX_BATCH_FILES) {
    return NextResponse.json(
      { error: `çok fazla dosya — bir seferde en fazla ${MAX_BATCH_FILES} görsel yükleyin` },
      { status: 413 },
    )
  }

  // Sequential, exactly as the multipart path: each ingest holds a full decoded
  // bitmap, and a parallel map over 50 of them would decode 50 at once.
  const results: Result[] = []
  for (const { url, name } of parsed) {
    results.push(await runIngest(name, () => ingestFromUrl(url, name)))
  }
  return NextResponse.json({ results })
}

/** Runs one ingest, converting a failure into a per-file result so a bad file never aborts its batch-mates. */
async function runIngest(name: string, run: () => Promise<Result>): Promise<Result> {
  try {
    return await run()
  } catch (e) {
    if (e instanceof IngestError) {
      return { status: 'error', name, message: e.message }
    }
    // Never surface raw internal exception text (Drizzle/Neon/Blob errors can
    // carry hostnames, paths, or worse) — log it server-side and return a
    // generic message instead.
    console.error('ingest failed:', name, e)
    return { status: 'error', name, message: 'yüklenemedi' }
  }
}

export async function POST(req: Request) {
  // Two ingest paths. JSON carries URLs the browser already uploaded straight
  // to Blob — the only path that survives a bulk drop, since the multipart one
  // below is capped by the platform at 4.5MB for the entire request.
  if (req.headers.get('content-type')?.includes('application/json')) {
    return postStaged(req)
  }

  // Reject an oversized body before formData() materializes it.
  const declared = Number(req.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_TOTAL_BYTES) {
    return NextResponse.json({ error: 'istek çok büyük' }, { status: 413 })
  }

  // Next's proxy layer truncates a body over proxyClientMaxBodySize rather than
  // rejecting it, which makes formData() throw on a partial multipart stream.
  // Uncaught, that is a 500 with no results array at all.
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json({ error: 'istek çok büyük veya bozuk' }, { status: 413 })
  }
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
      results.push({ status: 'error', name: file.name, message: 'dosya çok büyük — en fazla 4MB olmalı' })
      continue
    }

    // arrayBuffer() is inside runIngest's try: a failure reading one part must
    // not discard the results already collected for its batch-mates.
    results.push(
      await runIngest(file.name, async () =>
        ingestBuffer(Buffer.from(await file.arrayBuffer()), file.name),
      ),
    )
  }
  return NextResponse.json({ results })
}
