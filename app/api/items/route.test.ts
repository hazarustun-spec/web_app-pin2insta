import { describe, it, expect, vi, beforeEach } from 'vitest'

const ingestBuffer = vi.hoisted(() => vi.fn())
vi.mock('@/src/lib/queue/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/queue/repo')>()),
  ingestBuffer,
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
