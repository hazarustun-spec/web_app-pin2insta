'use client'

import { upload } from '@vercel/blob/client'
import {
  chunk,
  screenFile,
  stagingPathname,
  MAX_INGEST_BATCH,
  type UploadResult,
} from '@/src/lib/queue/view'

/**
 * A drop, from the browser to the queue.
 *
 * NOT a multipart POST to /api/items. Vercel Functions hard-cap a request body
 * at 4.5MB and answer anything larger with 413 before our code runs, so that
 * route handles about one phone photo per drop. Task 6 built the path this uses
 * instead:
 *
 *   1. PUT each file straight into Blob storage with a short-lived client token
 *      minted by /api/blob/upload. The bytes never touch a function body.
 *   2. POST the resulting URLs to /api/items as JSON, which is a few hundred
 *      bytes per file however large the picture is.
 *
 * The staging pathname is generated rather than taken from `file.name`: the
 * token route validates it against /^tmp\/[A-Za-z0-9._-]{1,160}$/ and 400s
 * anything else, which is every filename containing a space, a parenthesis or a
 * Turkish diacritic. The readable name travels in the JSON body instead, where
 * nothing constrains it.
 */

/** Uploads in flight at once. Enough to keep the link busy, few enough to keep the browser responsive. */
const CONCURRENCY = 3

type Staged = { url: string; name: string }

function randomToken(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

/** Runs `worker` over `items` with at most `limit` in flight, preserving input order in the output. */
async function pool<T, R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await worker(items[i], i)
    }
  })
  await Promise.all(runners)
  return out
}

export async function uploadFiles(
  files: File[],
  onProgress: (done: number, total: number) => void,
): Promise<UploadResult[]> {
  const results: UploadResult[] = []
  const accepted: File[] = []
  for (const file of files) {
    const problem = screenFile(file)
    if (problem) results.push({ status: 'error', name: file.name, message: problem })
    else accepted.push(file)
  }

  let done = 0
  onProgress(done, accepted.length)

  const staged = await pool(accepted, CONCURRENCY, async (file) => {
    try {
      const blob = await upload(stagingPathname(file.name, randomToken()), file, {
        access: 'public',
        handleUploadUrl: '/api/blob/upload',
        // Without this the content type is guessed from the pathname, and our
        // generated pathname may not carry the original extension.
        contentType: file.type,
      })
      return { ok: true as const, staged: { url: blob.url, name: file.name } }
    } catch (e) {
      console.error('client upload failed:', file.name, e)
      return { ok: false as const, name: file.name }
    } finally {
      onProgress(++done, accepted.length)
    }
  })

  for (const s of staged) {
    if (!s.ok) results.push({ status: 'error', name: s.name, message: 'yüklenemedi' })
  }

  // Order is preserved all the way through: /api/items ingests in body order
  // and each ingest takes the next queue position, so the cards land in the
  // order the files were dropped.
  const ready: Staged[] = staged
    .filter((s): s is { ok: true; staged: Staged } => s.ok)
    .map((s) => s.staged)

  for (const batch of chunk(ready, MAX_INGEST_BATCH)) {
    try {
      const res = await fetch('/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ uploads: batch }),
      })
      const body = (await res.json().catch(() => null)) as
        | { results?: UploadResult[]; error?: string }
        | null
      if (!res.ok || !Array.isArray(body?.results)) {
        // The staged objects survive in tmp/ when this happens. They are never
        // fetched and never deleted — wasted storage, not a correctness
        // problem, and the browser holds no token that could remove them.
        const message = typeof body?.error === 'string' ? body.error : 'kuyruğa eklenemedi'
        for (const b of batch) results.push({ status: 'error', name: b.name, message })
        continue
      }
      results.push(...body.results)
    } catch (e) {
      console.error('ingest request failed:', e)
      for (const b of batch) results.push({ status: 'error', name: b.name, message: 'kuyruğa eklenemedi' })
    }
  }

  return results
}
