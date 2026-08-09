import { randomUUID } from 'node:crypto'
import { eq, ne, sql, inArray, asc } from 'drizzle-orm'
import { getDb } from '@/src/db'
import { items, images } from '@/src/db/schema'
import { sha256, cropTo45, ImageValidationError } from '@/src/lib/images/process'
import { uploadImage, deleteImage } from '@/src/lib/images/storage'

export type IngestDecision = { status: 'added' } | { status: 'duplicate' }

/** Thrown only for conditions the caller should show verbatim to the owner (e.g. cropTo45's Turkish validation messages). Anything else is an internal failure and must not leak past the route. */
export class IngestError extends Error {}

export function decideIngest(hash: string, knownHashes: Set<string>): IngestDecision {
  return knownHashes.has(hash) ? { status: 'duplicate' } : { status: 'added' }
}

/**
 * Decides whether a failure from the image layer is safe to show the owner.
 * The route prints an IngestError's message verbatim and masks everything else,
 * so this function alone determines what an uploader can make the server echo
 * back. ONLY ImageValidationError carries a message written for a human;
 * libvips decode failures ("VipsJpeg: Premature end of input file
 * /var/task/...") reach here too and must pass through untouched.
 */
export function toIngestFailure(e: unknown): unknown {
  return e instanceof ImageValidationError ? new IngestError(e.message) : e
}

export async function nextPosition(): Promise<number> {
  const [row] = await getDb()
    .select({ max: sql<number>`coalesce(max(${items.position}), 0)` })
    .from(items)
  return Number(row.max) + 1
}

/** True when `e` is the unique-index violation raised when two ingests race on the same image hash. Postgres error code 23505 = unique_violation. */
function isDuplicateHashViolation(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null
  return err?.code === '23505' && err?.constraint === 'images_hash_unique_idx'
}

/** Mirrors the token route's maximumSizeInBytes — nothing larger can have been staged. */
const MAX_STAGED_BYTES = 25 * 1024 * 1024
/** A staged object never takes this long to fetch; without it 50 slow URLs can hold the function to its full maxDuration. */
const STAGED_FETCH_TIMEOUT_MS = 30_000

/**
 * Hostname of OUR blob store, derived from the read-write token.
 * `vercel_blob_rw_<storeId>_<secret>` — the store id is the fourth field, and
 * public objects live at `https://<storeId>.public.blob.vercel-storage.com/`.
 * Returns null when unset, which makes the guard below fail closed.
 */
export function stagedBlobHost(): string | null {
  const storeId = process.env.BLOB_READ_WRITE_TOKEN?.split('_')[3]
  return storeId ? `${storeId}.public.blob.vercel-storage.com` : null
}

/**
 * True only for a URL that our own client-upload route could have produced.
 *
 * ingestFromUrl makes the server fetch a URL the client chose. Without this the
 * route is a server-side request forgery primitive: an internal address, a
 * cloud metadata endpoint, or a file on the deploy host, fetched with the
 * server's network position and reported back through the ingest result.
 *
 * The host is matched exactly, not by suffix: `*.public.blob.vercel-storage.com`
 * is every Vercel customer's public store, and the store id is recoverable from
 * a token by anyone holding one. The path is matched whole rather than by
 * prefix, because `new URL()` leaves `%2f` encoded — `/tmp/..%2fqueue/x.jpg`
 * starts with `/tmp/` here but may resolve elsewhere at the CDN, and
 * ingestFromUrl deletes whatever it fetched.
 */
const STAGED_PATH = /^\/tmp\/[A-Za-z0-9._-]{1,200}$/

export function isStagedBlobUrl(raw: string, expectedHost: string | null): boolean {
  if (!expectedHost) return false
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.hostname !== expectedHost) return false
  // A credentialed or port-bearing URL passes a hostname check but means
  // something different to fetch() than it does here. Refuse the disagreement.
  if (u.username || u.password || u.port) return false
  if (u.search || u.hash) return false
  return STAGED_PATH.test(u.pathname)
}

/**
 * Read a response body, stopping as soon as it exceeds `limit`.
 *
 * res.arrayBuffer() would buffer the whole body first and only then let us
 * measure it, so a Content-Length check is no protection at all: the header is
 * advisory, and absent on a chunked response, where `Number(null)` is 0 and any
 * `declared > limit` test silently passes. Counting as we go is the only bound
 * that holds when the sender is not cooperating.
 */
async function readCapped(res: Response, limit: number): Promise<Buffer> {
  if (!res.body) throw new IngestError('yüklenen görsel bulunamadı')
  const chunks: Buffer[] = []
  let total = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) {
        throw new IngestError('dosya çok büyük — en fazla 25MB olmalı')
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    // Releases the socket when we bailed out early.
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}

/**
 * Ingest an image the browser uploaded straight to Blob storage, then delete
 * the staged copy. Used for drops too large to survive the 4.5MB function
 * request-body cap — which is any drop of more than about one photo.
 */
export async function ingestFromUrl(url: string, name: string) {
  if (!isStagedBlobUrl(url, stagedBlobHost())) throw new IngestError('geçersiz yükleme adresi')

  // redirect: 'error' — the guard above validated the URL we asked for, and
  // nothing re-checks where a 3xx would send us. Following one would hand an
  // arbitrary host the function's network position.
  const res = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(STAGED_FETCH_TIMEOUT_MS),
  })
  if (!res.ok) throw new IngestError('yüklenen görsel bulunamadı')

  const buf = await readCapped(res, MAX_STAGED_BYTES)

  try {
    return await ingestBuffer(buf, name)
  } finally {
    // Best-effort: a surviving tmp/ object is wasted storage, not a correctness
    // problem, and must never mask the ingest result.
    await deleteImage(url).catch((e) => console.error('staged blob cleanup failed:', e))
  }
}

export async function ingestBuffer(buf: Buffer, name: string) {
  const db = getDb()

  let cropped: Buffer
  try {
    cropped = await cropTo45(buf)
  } catch (e) {
    throw toIngestFailure(e)
  }
  const hash = sha256(cropped)

  const existing = await db.select({ hash: images.hash }).from(images).where(eq(images.hash, hash))
  const decision = decideIngest(hash, new Set(existing.map((r) => r.hash)))
  if (decision.status === 'duplicate') return { status: 'duplicate' as const, name }

  const key = `queue/${hash}.jpg`
  const { url, pathname } = await uploadImage(cropped, key)

  // Generate the id in application code and insert the item + its image in
  // one db.batch() round-trip. neon-http has no real transaction support
  // (session.transaction() throws), but batch() sends both statements
  // atomically — either both land or neither does — so a losing race on the
  // hash's unique index can never leave a pending item with zero images.
  const itemId = randomUUID()
  const position = await nextPosition()
  try {
    await db.batch([
      db.insert(items).values({ id: itemId, kind: 'feed', caption: '', position }),
      db.insert(images).values({ itemId, hash, url, pathname, position: 0 }),
    ])
  } catch (e) {
    if (isDuplicateHashViolation(e)) return { status: 'duplicate' as const, name }
    throw e
  }

  return { status: 'added' as const, itemId, name }
}

export async function listQueue() {
  const db = getDb()
  // Posted items belong to Task 12's history page, not the queue — filter
  // them out here so the response doesn't grow without bound.
  const rows = await db.select().from(items)
    .where(ne(items.status, 'posted'))
    // position ties are possible (nextPosition's max+1 isn't atomic across
    // concurrent requests), so createdAt then id make the ordering total and
    // stable instead of letting tied rows sort non-deterministically.
    .orderBy(asc(items.position), asc(items.createdAt), asc(items.id))
  if (rows.length === 0) return []
  const imgs = await db.select().from(images)
    .where(inArray(images.itemId, rows.map((r) => r.id)))
    .orderBy(asc(images.position))
  const imagesByItem = new Map<string, typeof imgs>()
  for (const img of imgs) {
    const bucket = imagesByItem.get(img.itemId)
    if (bucket) bucket.push(img)
    else imagesByItem.set(img.itemId, [img])
  }
  return rows.map((r) => ({ ...r, images: imagesByItem.get(r.id) ?? [] }))
}

export type QueueItem = Awaited<ReturnType<typeof listQueue>>[number]
