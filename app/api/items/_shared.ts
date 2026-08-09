import { NextResponse } from 'next/server'
import { QueueError } from '@/src/lib/queue/repo'

// Not a route: only `route.ts` is a routable file in this directory, so this
// module is plain colocated code shared by the three queue-mutation handlers.

/** A shape the owner's client sent wrong, or a value we refuse to store. The message is written for a human. */
export function badRequest(message: string) {
  return NextResponse.json({ error: message }, { status: 400 })
}

/**
 * The IngestError convention from `app/api/items/route.ts`, applied to queue
 * mutations: ONLY a QueueError carries a message written for the owner, and it
 * is the only thing echoed back. Everything else — Drizzle, Neon and Blob
 * failures, which can carry hostnames, connection strings and token fragments —
 * is logged server-side and answered generically.
 *
 * The plan's group route did `{ error: (e as Error).message }`, which hands the
 * client whatever the driver happened to say.
 */
export function failed(where: string, e: unknown) {
  if (e instanceof QueueError) return NextResponse.json({ error: e.message }, { status: 400 })
  console.error(`${where} failed:`, e)
  return NextResponse.json({ error: 'işlem tamamlanamadı' }, { status: 500 })
}

/**
 * Bounds the id list. Both consumers turn it into one db.batch(), so an
 * unbounded list is an unbounded statement count; and a queue this app is meant
 * for never approaches it.
 */
const MAX_IDS = 1000
/** A uuid is 36 characters. Anything much longer is not an id we issued. */
const MAX_ID_CHARS = 64

/**
 * `{ ids: string[] }` or null. Nothing here trusts the body to be the shape it
 * claims. A top-level array needs no test of its own: JSON arrays cannot carry
 * a named property, so `ids` is undefined and the array check below rejects it.
 */
export function parseIds(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null
  const ids = (body as { ids?: unknown }).ids
  if (!Array.isArray(ids)) return null
  if (ids.length > MAX_IDS) return null
  if (!ids.every((v) => typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS)) {
    return null
  }
  return ids as string[]
}

/** req.json() throws on a malformed body; uncaught that is a 500, so every caller goes through here. */
export async function readJson(req: Request): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    return { ok: true, body: await req.json() }
  } catch {
    return { ok: false }
  }
}
