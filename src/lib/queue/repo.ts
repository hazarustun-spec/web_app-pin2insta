import { randomUUID } from 'node:crypto'
import { eq, ne, sql, inArray, asc } from 'drizzle-orm'
import { getDb } from '@/src/db'
import { items, images } from '@/src/db/schema'
import { sha256, cropTo45 } from '@/src/lib/images/process'
import { uploadImage } from '@/src/lib/images/storage'

export type IngestDecision = { status: 'added' } | { status: 'duplicate' }

/** Thrown only for conditions the caller should show verbatim to the owner (e.g. cropTo45's Turkish validation messages). Anything else is an internal failure and must not leak past the route. */
export class IngestError extends Error {}

export function decideIngest(hash: string, knownHashes: Set<string>): IngestDecision {
  return knownHashes.has(hash) ? { status: 'duplicate' } : { status: 'added' }
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

export async function ingestBuffer(buf: Buffer, name: string) {
  const db = getDb()

  let cropped: Buffer
  try {
    cropped = await cropTo45(buf)
  } catch (e) {
    // cropTo45's thrown messages are the two deliberate, user-facing Turkish
    // validation strings — safe to surface verbatim.
    throw new IngestError((e as Error).message)
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
