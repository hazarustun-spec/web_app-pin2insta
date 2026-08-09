import { NextResponse } from 'next/server'
import { handleUpload, type HandleUploadBody } from '@vercel/blob/client'
import { cookies } from 'next/headers'
import { SESSION_COOKIE, verifySession, authConfigured } from '@/src/lib/auth'

/**
 * Mints a short-lived client token so the browser can PUT an image straight
 * into Blob storage.
 *
 * This exists because Vercel Functions hard-cap a request body at 4.5MB
 * (413 FUNCTION_PAYLOAD_TOO_LARGE, raised before our code runs). Routing
 * uploads through /api/items therefore caps a whole drop at roughly one phone
 * photo. Client uploads never touch the function body, so a drop of any size
 * works; the server only ever sees the resulting URLs.
 *
 * Uploads land under `tmp/` and are deleted by ingestFromUrl once the image has
 * been cropped and stored at its content-addressed key.
 */

// Matches cropTo45's real decoders. A token is a write credential, so it is
// scoped as narrowly as the product allows.
const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
// Generous next to any real photo, and far below Blob's own ceiling. Bounds
// what a leaked token could write, and what ingestFromUrl will later download.
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
/**
 * The pathname is chosen by the caller and signed into the token verbatim, so
 * it is the one field that decides where the write lands. Unvalidated, a client
 * can stage into `queue/` — a namespace ingestFromUrl refuses to touch, so the
 * object would never be fetched, never be deleted, and bill forever.
 * Must stay in step with STAGED_PATH in src/lib/queue/repo.ts, which allows 200
 * characters after `tmp/`. The budget here is lower on purpose:
 * `addRandomSuffix: true` makes the Blob API lengthen the stored pathname by
 * roughly 31 characters, so a name accepted here at the full 200 would produce
 * a URL the ingest guard rejects — leaving an object that is never fetched and
 * never deleted, because cleanup runs only after the guard passes.
 */
const STAGING_PATH = /^tmp\/[A-Za-z0-9._-]{1,160}$/

export async function POST(req: Request): Promise<NextResponse> {
  // proxy.ts already guards this path, but a token minted here can write to the
  // Blob store. Re-check rather than let one matcher regex be the only thing
  // between an anonymous request and a write credential.
  if (!authConfigured()) {
    return NextResponse.json({ error: 'sunucu yapılandırılmamış' }, { status: 503 })
  }
  const token = (await cookies()).get(SESSION_COOKIE)?.value ?? ''
  if (!verifySession(token)) {
    return NextResponse.json({ error: 'unauthorised' }, { status: 401 })
  }

  try {
    const body = (await req.json()) as HandleUploadBody

    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // Throwing here is caught below and answered as 400 — no token minted.
        if (!STAGING_PATH.test(pathname)) throw new Error('bad staging pathname')
        return {
          allowedContentTypes: ALLOWED_CONTENT_TYPES,
          maximumSizeInBytes: MAX_UPLOAD_BYTES,
          // Two drops of the same file must not collide, and these are
          // temporary staging objects — the content-addressed key is assigned
          // later, by ingestFromUrl, once the bytes have been cropped.
          addRandomSuffix: true,
        }
      },
      // NOTE: onUploadCompleted is omitted, not stubbed. Passing even an empty
      // function makes handleUpload sign a callbackUrl into the token whenever
      // it can resolve one — which it can on Vercel, though never on localhost.
      // Blob would then call this route server-to-server with no session
      // cookie, and the auth gate above would 401 every single upload: broken
      // in production, perfect in dev. The client posts the URLs to /api/items
      // itself, so no callback is wanted.
    })
    return NextResponse.json(result)
  } catch (e) {
    console.error('blob upload token failed:', e)
    return NextResponse.json({ error: 'yükleme başlatılamadı' }, { status: 400 })
  }
}
