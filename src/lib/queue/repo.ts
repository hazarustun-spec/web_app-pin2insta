import { eq, sql, inArray, asc } from 'drizzle-orm'
import { getDb } from '@/src/db'
import { items, images } from '@/src/db/schema'
import { sha256, cropTo45 } from '@/src/lib/images/process'
import { uploadImage } from '@/src/lib/images/storage'

export type IngestDecision = { status: 'added' } | { status: 'duplicate' }

export function decideIngest(hash: string, knownHashes: Set<string>): IngestDecision {
  return knownHashes.has(hash) ? { status: 'duplicate' } : { status: 'added' }
}

export async function nextPosition(): Promise<number> {
  const [row] = await getDb()
    .select({ max: sql<number>`coalesce(max(${items.position}), 0)` })
    .from(items)
  return Number(row.max) + 1
}

export async function ingestBuffer(buf: Buffer, name: string) {
  const db = getDb()
  const cropped = await cropTo45(buf)
  const hash = sha256(cropped)

  const existing = await db.select({ hash: images.hash }).from(images).where(eq(images.hash, hash))
  const decision = decideIngest(hash, new Set(existing.map((r) => r.hash)))
  if (decision.status === 'duplicate') return { status: 'duplicate' as const, name }

  const key = `queue/${hash}.jpg`
  const { url, pathname } = await uploadImage(cropped, key)

  const [item] = await db.insert(items)
    .values({ kind: 'feed', caption: '', position: await nextPosition() })
    .returning({ id: items.id })

  await db.insert(images).values({ itemId: item.id, hash, url, pathname, position: 0 })
  return { status: 'added' as const, itemId: item.id, name }
}

export async function listQueue() {
  const db = getDb()
  const rows = await db.select().from(items).orderBy(asc(items.position))
  if (rows.length === 0) return []
  const imgs = await db.select().from(images)
    .where(inArray(images.itemId, rows.map((r) => r.id)))
    .orderBy(asc(images.position))
  return rows.map((r) => ({ ...r, images: imgs.filter((i) => i.itemId === r.id) }))
}

export type QueueItem = Awaited<ReturnType<typeof listQueue>>[number]
