import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { getPayloadFromClientToken } from '@vercel/blob/client'

const cookieValue = vi.hoisted(() => ({ current: '' }))
vi.mock('next/headers', () => ({
  cookies: async () => ({ get: () => ({ value: cookieValue.current }) }),
}))

const { POST } = await import('./route')
const { signSession } = await import('@/src/lib/auth')

// Throwaway values. The real ones live in .env.local and are never read here.
const ENV = {
  ADMIN_PASSWORD: 'probe-password',
  SESSION_SECRET: 'probe-secret-probe-secret-probe-secret',
  BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_PROBESTORE_probesecretvalue',
}

function tokenRequest(pathname: string) {
  return new Request('http://localhost/api/blob/upload', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'blob.generate-client-token',
      payload: { pathname, callbackUrl: 'http://localhost/api/blob/upload', multipart: false },
    }),
  })
}

describe('POST /api/blob/upload', () => {
  const saved = { ...process.env }

  beforeEach(() => {
    Object.assign(process.env, ENV)
    cookieValue.current = signSession()
  })

  afterEach(() => {
    for (const k of Object.keys(ENV)) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('mints a token for a valid staging pathname', async () => {
    const res = await POST(tokenRequest('tmp/photo-1.jpg'))
    expect(res.status).toBe(200)
    const { clientToken } = (await res.json()) as { clientToken: string }
    const payload = getPayloadFromClientToken(clientToken)
    expect(payload.pathname).toBe('tmp/photo-1.jpg')
    expect(payload.maximumSizeInBytes).toBe(25 * 1024 * 1024)
    expect(payload.allowedContentTypes).toContain('image/jpeg')
  })

  // The pathname is client-chosen and signed verbatim. Unvalidated, a caller
  // stages into a namespace ingestFromUrl refuses to touch, so the object is
  // never fetched, never deleted, and bills forever.
  it.each([
    ['the permanent queue namespace', 'queue/deadbeef.jpg'],
    ['a traversal', '../../etc/passwd'],
    ['an arbitrary namespace', 'anything/at/all.exe'],
    ['an empty pathname', ''],
    ['a nested path under tmp', 'tmp/sub/a.jpg'],
    ['a name with a slash escape', 'tmp/..%2fqueue/a.jpg'],
  ])('refuses to mint a token for %s', async (_label, pathname) => {
    const res = await POST(tokenRequest(pathname))
    expect(res.status).toBe(400)
  })

  it('rejects an unauthenticated request before minting anything', async () => {
    cookieValue.current = ''
    const res = await POST(tokenRequest('tmp/a.jpg'))
    expect(res.status).toBe(401)
  })

  it('rejects a forged session cookie', async () => {
    cookieValue.current = `${Date.now()}.deadbeef.deadbeef`
    const res = await POST(tokenRequest('tmp/a.jpg'))
    expect(res.status).toBe(401)
  })

  it('fails closed when auth is not configured', async () => {
    delete process.env.SESSION_SECRET
    const res = await POST(tokenRequest('tmp/a.jpg'))
    expect(res.status).toBe(503)
  })

  it('answers 400, not 500, for a body that is not JSON', async () => {
    const res = await POST(
      new Request('http://localhost/api/blob/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'not json',
      }),
    )
    expect(res.status).toBe(400)
  })

  // Passing even an empty onUploadCompleted makes handleUpload sign a
  // callbackUrl into the token. Blob then calls this route server-to-server
  // with no session cookie, which the auth gate 401s — every upload failing in
  // production while working perfectly on localhost.
  it('does not sign a completion callback into the token', async () => {
    process.env.VERCEL = '1'
    process.env.VERCEL_ENV = 'production'
    process.env.VERCEL_PROJECT_PRODUCTION_URL = 'pin2insta.example.vercel.app'
    try {
      const res = await POST(tokenRequest('tmp/a.jpg'))
      const { clientToken } = (await res.json()) as { clientToken: string }
      const payload = getPayloadFromClientToken(clientToken) as { onUploadCompleted?: unknown }
      expect(payload.onUploadCompleted).toBeUndefined()
    } finally {
      delete process.env.VERCEL
      delete process.env.VERCEL_ENV
      delete process.env.VERCEL_PROJECT_PRODUCTION_URL
    }
  })
})
