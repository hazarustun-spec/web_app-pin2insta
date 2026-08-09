import { describe, it, expect, vi, beforeEach } from 'vitest'

const ingestBuffer = vi.hoisted(() => vi.fn())
const ingestFromUrl = vi.hoisted(() => vi.fn())
vi.mock('@/src/lib/queue/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/queue/repo')>()),
  ingestBuffer,
  ingestFromUrl,
  listQueue: vi.fn(async () => []),
}))

const { POST } = await import('./route')

function jpeg(bytes: number, name = 'a.jpg', type = 'image/jpeg') {
  return new File([new Uint8Array(bytes)], name, { type })
}

function req(files: File[], contentLength?: number) {
  const form = new FormData()
  for (const f of files) form.append('files', f)
  const headers = new Headers()
  if (contentLength !== undefined) headers.set('content-length', String(contentLength))
  return new Request('http://localhost/api/items', { method: 'POST', body: form, headers })
}

describe('POST /api/items validation', () => {
  beforeEach(() => {
    ingestBuffer.mockReset()
    ingestBuffer.mockImplementation(async (_buf: Buffer, name: string) => ({
      status: 'added' as const,
      itemId: `id-${name}`,
      name,
    }))
  })

  it('rejects an oversized body before parsing it', async () => {
    const res = await POST(req([jpeg(10)], 200 * 1024 * 1024))
    expect(res.status).toBe(413)
    // The whole point of the Content-Length gate: formData() never ran, so
    // nothing was buffered and no file was processed.
    expect(ingestBuffer).not.toHaveBeenCalled()
  })

  // Next's proxy truncates rather than rejects a body over its limit, leaving
  // a half-written multipart stream. That used to 500 with no results array.
  it('answers 413 instead of 500 when the multipart body is unparseable', async () => {
    const broken = new Request('http://localhost/api/items', {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=----abc' },
      body: '------abc\r\nContent-Disposition: form-data; name="files"; filename="a.jpg"\r\n\r\ntrunc',
    })
    const res = await POST(broken)
    expect(res.status).toBe(413)
  })

  // The original bug processed 50 files and returned a polite error for the
  // rest — after req.formData() had already buffered all of them. The cap must
  // reject the request outright instead of half-honouring it.
  it('rejects an over-cap batch outright rather than ingesting the first 50', async () => {
    const res = await POST(req(Array.from({ length: 51 }, (_, i) => jpeg(10, `f${i}.jpg`))))
    expect(res.status).toBe(413)
    expect(ingestBuffer).not.toHaveBeenCalled()
  })

  it('accepts a batch of exactly 50', async () => {
    const res = await POST(req(Array.from({ length: 50 }, (_, i) => jpeg(10, `f${i}.jpg`))))
    expect(res.status).toBe(200)
    expect(ingestBuffer).toHaveBeenCalledTimes(50)
  })

  it('rejects a disallowed content type without reading the file', async () => {
    const res = await POST(req([jpeg(10, 'x.svg', 'image/svg+xml')]))
    const body = await res.json()
    expect(body.results[0]).toMatchObject({ status: 'error', message: 'desteklenmeyen dosya türü' })
    expect(ingestBuffer).not.toHaveBeenCalled()
  })

  it('rejects an oversized file rather than ingesting it', async () => {
    const res = await POST(req([jpeg(5 * 1024 * 1024, 'big.jpg')]))
    const body = await res.json()
    expect(body.results[0]).toMatchObject({ status: 'error' })
    expect(body.results[0].message).toContain('dosya çok büyük')
    // file.size is checked before file.arrayBuffer(), so nothing was decoded.
    expect(ingestBuffer).not.toHaveBeenCalled()
  })

  it('lets one bad file fail without aborting its batch-mates', async () => {
    const bad = jpeg(10, 'bad.txt', 'text/plain')
    const res = await POST(req([jpeg(10, 'good1.jpg'), bad, jpeg(10, 'good2.jpg')]))
    const body = await res.json()
    expect(body.results.map((r: { status: string }) => r.status)).toEqual([
      'added',
      'error',
      'added',
    ])
  })
})

function jsonReq(body: unknown) {
  return new Request('http://localhost/api/items', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

const HOST = 'teststore.public.blob.vercel-storage.com'
const staged = (n: number) => `https://${HOST}/tmp/f${n}-abc.jpg`

describe('POST /api/items staged uploads', () => {
  beforeEach(() => {
    ingestFromUrl.mockReset()
    ingestFromUrl.mockImplementation(async (_url: string, name: string) => ({
      status: 'added' as const,
      itemId: `id-${name}`,
      name,
    }))
  })

  it('ingests staged blob URLs posted as JSON', async () => {
    const res = await POST(jsonReq({ uploads: [{ url: staged(1), name: 'a.jpg' }] }))
    expect(res.status).toBe(200)
    expect((await res.json()).results[0]).toMatchObject({ status: 'added', name: 'a.jpg' })
    expect(ingestFromUrl).toHaveBeenCalledWith(staged(1), 'a.jpg')
  })

  it('routes to the staged branch even when the content type carries a charset', async () => {
    const res = await POST(
      new Request('http://localhost/api/items', {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: JSON.stringify({ uploads: [{ url: staged(1), name: 'a.jpg' }] }),
      }),
    )
    expect(res.status).toBe(200)
    expect(ingestFromUrl).toHaveBeenCalledTimes(1)
  })

  it('caps a staged batch before ingesting any of it', async () => {
    const uploads = Array.from({ length: 51 }, (_, i) => ({ url: staged(i), name: `f${i}.jpg` }))
    const res = await POST(jsonReq({ uploads }))
    expect(res.status).toBe(413)
    expect(ingestFromUrl).not.toHaveBeenCalled()
  })

  // The first ingest deletes the staged object, so a repeated URL would report
  // 'not found' for the second copy rather than being a harmless no-op.
  it('ingests a repeated URL only once', async () => {
    const u = staged(1)
    const res = await POST(
      jsonReq({ uploads: [{ url: u, name: 'a.jpg' }, { url: u, name: 'a.jpg' }] }),
    )
    expect(res.status).toBe(200)
    expect(ingestFromUrl).toHaveBeenCalledTimes(1)
  })

  it('truncates an absurd filename rather than echoing it back', async () => {
    const res = await POST(
      jsonReq({ uploads: [{ url: staged(1), name: 'x'.repeat(5000) }] }),
    )
    expect(res.status).toBe(200)
    expect(ingestFromUrl.mock.calls[0][1].length).toBe(200)
  })

  it.each([
    ['uploads missing', {}],
    ['uploads not an array', { uploads: 'nope' }],
    ['a null entry', { uploads: [null] }],
    ['a non-string url', { uploads: [{ url: 1, name: 'a' }] }],
    ['a missing name', { uploads: [{ url: staged(1) }] }],
    ['a top-level array', [{ url: staged(1), name: 'a' }]],
    ['null', null],
    ['malformed json', '{'],
  ])('rejects %s without ingesting anything', async (_label, body) => {
    const res = await POST(jsonReq(body))
    expect(res.status).toBe(400)
    expect(ingestFromUrl).not.toHaveBeenCalled()
  })

  it('reports an empty upload list as a bad request', async () => {
    const res = await POST(jsonReq({ uploads: [] }))
    expect(res.status).toBe(400)
  })

  it('lets one staged failure stand alone in its batch', async () => {
    ingestFromUrl.mockImplementation(async (_url: string, name: string) => {
      if (name === 'bad.jpg') throw new Error('internal detail: postgres://user:pw@host')
      return { status: 'added' as const, itemId: `id-${name}`, name }
    })
    const res = await POST(
      jsonReq({
        uploads: [
          { url: staged(1), name: 'good1.jpg' },
          { url: staged(2), name: 'bad.jpg' },
          { url: staged(3), name: 'good2.jpg' },
        ],
      }),
    )
    const body = await res.json()
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['added', 'error', 'added'])
    expect(body.results[1].message).toBe('yüklenemedi')
  })
})
