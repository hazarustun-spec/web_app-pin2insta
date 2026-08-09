import { randomUUID } from 'node:crypto'
import { eq, ne, and, sql, inArray, asc } from 'drizzle-orm'
import type { BatchItem } from 'drizzle-orm/batch'
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
  // URL.hostname is always lowercased, so an uppercase store id would produce a
  // host that could never compare equal.
  return storeId ? `${storeId.toLowerCase()}.public.blob.vercel-storage.com` : null
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

// ---------------------------------------------------------------------------
// Queue mutations: caption, kind, order, grouping, deletion.
// ---------------------------------------------------------------------------

/**
 * Thrown for a mutation the owner asked for and cannot have — a caption that is
 * too long, a shape Instagram would refuse, a stale reorder. Same contract as
 * IngestError: its message is written for a human and is the ONLY thing a route
 * may echo back verbatim. Every other failure is logged and masked.
 */
export class QueueError extends Error {}

/**
 * neon-http has no transaction support — db.transaction() throws — so every
 * multi-statement mutation goes through db.batch(), which sends the lot in one
 * atomic round-trip. Its signature demands a non-empty tuple, which a mapped
 * array cannot prove it is; this is the cast that bridges that.
 */
type BatchStatements = [BatchItem<'pg'>, ...BatchItem<'pg'>[]]

export const KINDS = ['feed', 'carousel', 'story'] as const
export type ItemKind = (typeof KINDS)[number]

export function isItemKind(v: unknown): v is ItemKind {
  return typeof v === 'string' && (KINDS as readonly string[]).includes(v)
}

/** Instagram's caption ceiling, enforced here so a too-long caption fails where the owner sees it instead of at 14:00 in a cron run. Counted in UTF-16 code units, exactly as `validate()` counts it. */
export const MAX_CAPTION_CHARS = 2200

const MIN_CAROUSEL = 2
const MAX_CAROUSEL = 10

export function reindex(ids: string[]) {
  return ids.map((id, i) => ({ id, position: i + 1 }))
}

/**
 * Renumbers the queue to the given order.
 *
 * DECISIONS:
 * - `ids` must be the WHOLE queue (every non-posted item, exactly once).
 *   reindex hands out 1..n densely, so renumbering 3 of 10 items would collide
 *   with the positions of the other 7. A short, long, or duplicated list is a
 *   stale client and is refused outright.
 * - An id that is not in the queue is REJECTED, not ignored: applying the
 *   surviving order silently would leave the owner's screen disagreeing with
 *   the database.
 * - Posted items are excluded from the comparison because listQueue hides them,
 *   so the client could not have sent them.
 * - The writes go out as one db.batch(): a partially applied reorder leaves the
 *   queue in an order nobody asked for.
 */
export async function applyOrder(ids: string[]) {
  if (new Set(ids).size !== ids.length) {
    throw new QueueError('sıralamada aynı öğe birden fazla kez var')
  }
  const db = getDb()
  const rows = await db.select({ id: items.id }).from(items).where(ne(items.status, 'posted'))
  const known = new Set(rows.map((r) => r.id))
  if (rows.length !== ids.length || ids.some((id) => !known.has(id))) {
    throw new QueueError('sıralama kuyrukla eşleşmiyor — sayfayı yenileyip tekrar deneyin')
  }
  const ordered = reindex(ids)
  // drizzle's batch() takes a non-empty tuple; an empty queue has nothing to do.
  if (ordered.length === 0) return
  await db.batch(
    ordered.map(({ id, position }) =>
      db.update(items).set({ position }).where(eq(items.id, id)),
    ) as unknown as BatchStatements,
  )
}

/** An empty caption is fine — an item may be captioned later, and the publisher already refuses to post an empty-caption non-story. */
export async function setCaption(id: string, caption: string) {
  if (caption.length > MAX_CAPTION_CHARS) {
    throw new QueueError(`açıklama çok uzun — en fazla ${MAX_CAPTION_CHARS} karakter olabilir`)
  }
  const updated = await getDb()
    .update(items)
    .set({ caption })
    .where(eq(items.id, id))
    .returning({ id: items.id })
  if (updated.length === 0) throw new QueueError('öğe bulunamadı')
}

/**
 * Why `kind` cannot hold `imageCount` images, in Turkish, or null when the pair
 * is one `validate()` (src/lib/instagram/types.ts) accepts.
 *
 * This is the whole point of validating kind changes here: an item whose kind
 * and image count disagree can never publish, and the failure would surface in
 * a cron run rather than in front of the owner.
 */
export function kindShapeError(kind: ItemKind, imageCount: number): string | null {
  if (kind === 'carousel') {
    return imageCount >= MIN_CAROUSEL && imageCount <= MAX_CAROUSEL
      ? null
      : 'karusel 2 ile 10 görsel içermelidir — görselleri gruplayın'
  }
  return imageCount === 1
    ? null
    : 'akış veya hikaye tam olarak bir görsel alır — önce grubu çözün'
}

/**
 * DECISIONS:
 * - A single-image item cannot become `carousel`. Grouping is the only way in,
 *   because `validate()` demands 2-10 images for a carousel.
 * - A multi-image item cannot become `feed`/`story` either: it is REJECTED
 *   rather than silently ungrouped, because ungrouping would have to either
 *   discard the extra images or invent new queue items, and destroying the
 *   owner's uploads on a dropdown change is worse than an error message.
 */
export async function setKind(id: string, kind: ItemKind) {
  // Defence in depth: the route validates the shape too, but nothing else stops
  // an arbitrary string reaching the kind column from a future caller.
  if (!isItemKind(kind)) throw new QueueError('geçersiz gönderi türü')
  const db = getDb()
  const [row] = await db.select({ id: items.id }).from(items).where(eq(items.id, id))
  if (!row) throw new QueueError('öğe bulunamadı')
  const imgs = await db.select({ id: images.id }).from(images).where(eq(images.itemId, id))
  const problem = kindShapeError(kind, imgs.length)
  if (problem) throw new QueueError(problem)
  await db.update(items).set({ kind }).where(eq(items.id, id))
}

/**
 * DECISIONS:
 * - A `posted` item is never deleted. `images.itemId` cascades, so removing the
 *   row destroys the SHA-256 hash that stops the same picture being republished
 *   later — duplicate detection would silently stop protecting exactly the case
 *   it exists for. The status is re-checked inside the DELETE predicate as well
 *   as before it, so a cron run that posts the item mid-request cannot slip
 *   through the gap between the two.
 * - ORDER: the row goes first, the blobs second. A failed blob delete then
 *   leaves an orphaned object — wasted storage, invisible to the owner. The
 *   reverse order would leave a queue item pointing at deleted images, which
 *   looks fine on screen and fails at publish time. Blob failures are logged,
 *   never surfaced, and never undo the delete the owner asked for.
 */
export async function deleteItem(id: string) {
  const db = getDb()
  const [row] = await db.select({ status: items.status }).from(items).where(eq(items.id, id))
  if (!row) throw new QueueError('öğe bulunamadı')
  if (row.status === 'posted') throw new QueueError('paylaşılmış gönderi silinemez')

  const imgs = await db.select({ url: images.url }).from(images).where(eq(images.itemId, id))

  const deleted = await db
    .delete(items)
    .where(and(eq(items.id, id), ne(items.status, 'posted')))
    .returning({ id: items.id })
  if (deleted.length === 0) throw new QueueError('paylaşılmış gönderi silinemez')

  await Promise.all(
    imgs.map((i) => deleteImage(i.url).catch((e) => console.error('blob cleanup failed:', e))),
  )
}

/**
 * Flattens the images of `ids` into carousel order: the order the owner listed
 * the items in, then each item's own image position, then id as a tiebreak.
 *
 * The database returns rows in whatever order it likes, so relying on the query
 * order would scramble a carousel the owner arranged deliberately.
 */
export function orderCarouselImages<T extends { id: string; itemId: string; position: number }>(
  ids: string[],
  imgs: T[],
): T[] {
  const byItem = new Map<string, T[]>()
  for (const img of imgs) {
    const bucket = byItem.get(img.itemId)
    if (bucket) bucket.push(img)
    else byItem.set(img.itemId, [img])
  }
  return ids.flatMap((id) =>
    // Sorts a bucket we built ourselves, so `imgs` is left untouched.
    (byItem.get(id) ?? []).sort(
      (a, b) => a.position - b.position || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    ),
  )
}

/**
 * Folds 2-10 pending items into a single carousel. The first id survives and
 * absorbs the others' images; the rest are removed without touching their blobs.
 *
 * The 2-10 ceiling that actually matters is on IMAGES, not items — an item can
 * already hold more than one image, and `validate()` counts images.
 */
export async function groupIntoCarousel(ids: string[]) {
  if (ids.length < MIN_CAROUSEL || ids.length > MAX_CAROUSEL) {
    throw new QueueError('karusel için 2 ile 10 arasında öğe seçin')
  }
  if (new Set(ids).size !== ids.length) throw new QueueError('aynı öğe birden fazla kez seçilemez')

  const db = getDb()
  const rows = await db.select().from(items).where(inArray(items.id, ids))
  // inArray silently returns fewer rows than ids given, so a typo would group
  // whatever happened to match and quietly drop the rest.
  if (rows.length !== ids.length) throw new QueueError('seçilen öğelerden bazıları bulunamadı')
  if (rows.some((r) => r.status !== 'pending')) {
    throw new QueueError('yalnızca bekleyen öğeler gruplanabilir')
  }
  if (rows.some((r) => r.kind === 'carousel')) throw new QueueError('karusel içine karusel eklenemez')

  const imgs = await db.select().from(images).where(inArray(images.itemId, ids))
  const ordered = orderCarouselImages(ids, imgs)
  if (ordered.length < MIN_CAROUSEL || ordered.length > MAX_CAROUSEL) {
    throw new QueueError('karusel 2 ile 10 görsel içermelidir')
  }

  const [head, ...rest] = ids
  // One atomic batch, in this order: the images are reassigned to the head
  // BEFORE the source rows go, or onDelete: 'cascade' takes them with it.
  //
  // `rest` already excludes the head, but the delete still carries the posted
  // guard, because the status check above is a SEPARATE round-trip. The cron
  // publisher can mark one of these items `posted` in the window between that
  // read and this write, and an unguarded delete would then destroy the row of
  // a post that is live on Instagram — taking its permalink, its slot claim and
  // (via metrics' cascade) its insights with it. deleteItem defends the same
  // window for the same reason.
  //
  // Residual: the batch still commits, so an item posted mid-flight survives as
  // a row whose image now belongs to the head carousel. An item showing no
  // image is recoverable; an erased published post is not.
  await db.batch([
    db.update(items).set({ kind: 'carousel' }).where(eq(items.id, head)),
    ...ordered.map((img, i) =>
      db.update(images).set({ itemId: head, position: i }).where(eq(images.id, img.id)),
    ),
    db.delete(items).where(and(inArray(items.id, rest), ne(items.status, 'posted'))),
  ] as unknown as BatchStatements)
}
