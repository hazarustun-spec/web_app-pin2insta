import { describe, it, expect, vi, beforeEach } from 'vitest'

const ingestBuffer = vi.hoisted(() => vi.fn())
vi.mock('@/src/lib/queue/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/queue/repo')>()),
  ingestBuffer,
}))

const fetchPinImage = vi.hoisted(() => vi.fn())
vi.mock('@/src/lib/pinterest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/pinterest')>()),
  fetchPinImage,
}))

const { POST } = await import('./route')
const { IngestError } = await import('@/src/lib/queue/repo')
const { PinError } = await import('@/src/lib/pinterest')

const PIN = 'https://tr.pinterest.com/pin/12345/'
const BYTES = new Uint8Array([1, 2, 3, 4])

function req(body: string, contentType = 'application/json') {
  return new Request('http://localhost/api/items/pin', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body,
  })
}

describe('POST /api/items/pin', () => {
  beforeEach(() => {
    ingestBuffer.mockReset()
    fetchPinImage.mockReset()
    fetchPinImage.mockResolvedValue(BYTES)
    ingestBuffer.mockImplementation(async (_buf: Buffer, name: string) => ({
      status: 'added' as const,
      itemId: 'id-1',
      name,
    }))
  })

  it('ingests the image the pin advertises', async () => {
    const res = await POST(req(JSON.stringify({ url: PIN })))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'added',
      itemId: 'id-1',
      name: 'tr.pinterest.com/pin/12345/',
    })
    expect(fetchPinImage).toHaveBeenCalledWith(PIN)
  })

  it('hands ingestBuffer a Buffer of exactly the bytes it fetched', async () => {
    await POST(req(JSON.stringify({ url: PIN })))
    const [buf] = ingestBuffer.mock.calls[0]
    expect(Buffer.isBuffer(buf)).toBe(true)
    expect([...(buf as Buffer)]).toEqual([...BYTES])
  })

  it('reports a duplicate as a duplicate', async () => {
    ingestBuffer.mockResolvedValue({ status: 'duplicate', name: 'x' })
    const res = await POST(req(JSON.stringify({ url: PIN })))
    expect(res.status).toBe(200)
    expect((await res.json()).status).toBe('duplicate')
  })

  // The plan's route did `await req.json()` uncaught, which is a 500 on any
  // body that is not JSON.
  it('answers 400, not 500, for a body that is not JSON', async () => {
    const res = await POST(req('not json'))
    expect(res.status).toBe(400)
    expect(fetchPinImage).not.toHaveBeenCalled()
  })

  it.each([
    ['no body at all', '{}'],
    ['a null url', JSON.stringify({ url: null })],
    ['a non-string url', JSON.stringify({ url: 42 })],
    ['an object url', JSON.stringify({ url: { href: PIN } })],
    ['an empty url', JSON.stringify({ url: '   ' })],
    ['a top-level array', JSON.stringify([PIN])],
    ['a top-level string', JSON.stringify(PIN)],
    ['a top-level null', 'null'],
  ])('answers 400 for %s without fetching anything', async (_label, body) => {
    const res = await POST(req(body))
    expect(res.status).toBe(400)
    expect(fetchPinImage).not.toHaveBeenCalled()
  })

  it('refuses an oversized url before it reaches the fetcher', async () => {
    const res = await POST(req(JSON.stringify({ url: `https://pinterest.com/${'a'.repeat(5000)}` })))
    expect(res.status).toBe(400)
    expect(fetchPinImage).not.toHaveBeenCalled()
  })

  it('trims the pasted url', async () => {
    await POST(req(JSON.stringify({ url: `  ${PIN}\n` })))
    expect(fetchPinImage).toHaveBeenCalledWith(PIN)
  })

  // PinError and IngestError are the ONLY messages written for the owner, and
  // the download-and-drop guidance lives in them.
  it('shows a PinError message verbatim', async () => {
    fetchPinImage.mockRejectedValue(new PinError('Pinterest sayfası açılamadı — görseli indirip sürükle'))
    const res = await POST(req(JSON.stringify({ url: PIN })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Pinterest sayfası açılamadı — görseli indirip sürükle')
  })

  it('shows an IngestError message verbatim', async () => {
    ingestBuffer.mockRejectedValue(new IngestError('görsel çok küçük — en az 320px olmalı'))
    const res = await POST(req(JSON.stringify({ url: PIN })))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('görsel çok küçük — en az 320px olmalı')
  })

  it.each([
    ['the fetcher', () => fetchPinImage.mockRejectedValue(new Error('connect ECONNREFUSED postgres://user:pw@10.0.0.1/db'))],
    ['the ingest', () => ingestBuffer.mockRejectedValue(new Error('connect ECONNREFUSED postgres://user:pw@10.0.0.1/db'))],
  ])('masks an unexpected failure in %s', async (_label, arrange) => {
    arrange()
    const res = await POST(req(JSON.stringify({ url: PIN })))
    expect(res.status).toBe(500)
    const body = JSON.stringify(await res.json())
    expect(body).not.toMatch(/ECONNREFUSED|postgres|10\.0\.0\.1/)
  })

  // The name is echoed straight back to the client that supplied the URL.
  it('bounds the name it echoes back', async () => {
    const long = `https://www.pinterest.com/pin/${'a'.repeat(1500)}`
    await POST(req(JSON.stringify({ url: long })))
    const [, name] = ingestBuffer.mock.calls[0]
    expect((name as string).length).toBe(200)
    expect(name).not.toContain('https://')
  })
})
