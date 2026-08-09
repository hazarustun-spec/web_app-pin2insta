import { NextResponse } from 'next/server'
import { fetchPinImage, pinName, PinError, MAX_PIN_URL_CHARS } from '@/src/lib/pinterest'
import { ingestBuffer, IngestError } from '@/src/lib/queue/repo'

/**
 * Ingest from a pasted Pinterest link.
 *
 * Guarded by `proxy.ts` like every other route: only the owner's session gets
 * here, so nobody else can aim the two server-side fetches this performs. The
 * guards live in `src/lib/pinterest.ts`; this file's job is to refuse a
 * malformed body and to decide what the client is allowed to read.
 */

// Two fetches with a 10s and a 20s timeout, plus a crop, a hash and an upload.
// Well inside this; the timeouts, not the ceiling, are what bound a slow pin.
export const maxDuration = 60

/** The pasted url, trimmed, or null. Nothing here trusts the body to be the shape it claims. */
function parseUrl(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const url = (body as { url?: unknown }).url
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  // The same bound isPinUrl applies, enforced before the string reaches a
  // regex or a log line.
  if (trimmed.length === 0 || trimmed.length > MAX_PIN_URL_CHARS) return null
  return trimmed
}

export async function POST(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    // The plan left this uncaught, which turns any non-JSON body into a 500.
    return NextResponse.json({ error: 'geçersiz istek' }, { status: 400 })
  }

  const url = parseUrl(body)
  if (!url) return NextResponse.json({ error: 'geçersiz istek' }, { status: 400 })

  try {
    const bytes = await fetchPinImage(url)
    // fetchPinImage is deliberately Node-free so the queue page can import its
    // guards; the Buffer view it needs is made here, without copying.
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    // Bounded, and derived from the URL rather than echoing the raw body back.
    return NextResponse.json(await ingestBuffer(buf, pinName(url)))
  } catch (e) {
    // The plan returned `(e as Error).message`. PinError and IngestError are
    // the only two types carrying a message written for the owner — and the
    // "download it and drop it instead" guidance lives in PinError, so it has
    // to come through verbatim. Everything else (Drizzle, Neon, Blob, undici)
    // can carry hostnames, paths and connection strings and is masked.
    if (e instanceof PinError || e instanceof IngestError) {
      return NextResponse.json({ error: e.message }, { status: 400 })
    }
    console.error('pin ingest failed:', e)
    return NextResponse.json({ error: 'görsel eklenemedi' }, { status: 500 })
  }
}
