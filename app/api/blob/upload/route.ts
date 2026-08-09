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

  const body = (await req.json()) as HandleUploadBody

  try {
    const result = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: ALLOWED_CONTENT_TYPES,
        maximumSizeInBytes: MAX_UPLOAD_BYTES,
        // Two drops of the same file must not collide, and these are temporary
        // staging objects — the content-addressed key is assigned later, by
        // ingestFromUrl, once the bytes have actually been cropped.
        addRandomSuffix: true,
      }),
      // Deliberately no onUploadCompleted: it does not fire on localhost, and
      // the client posts the URLs to /api/items itself. Nothing is enqueued
      // until that authenticated call arrives.
      onUploadCompleted: async () => {},
    })
    return NextResponse.json(result)
  } catch (e) {
    console.error('blob upload token failed:', e)
    return NextResponse.json({ error: 'yükleme başlatılamadı' }, { status: 400 })
  }
}
