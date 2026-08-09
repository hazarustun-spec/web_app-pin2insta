import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const cropTo45 = vi.hoisted(() => vi.fn())
const uploadImage = vi.hoisted(() => vi.fn())
const deleteImage = vi.hoisted(() => vi.fn())
const batch = vi.hoisted(() => vi.fn())

vi.mock('@/src/lib/images/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/images/process')>()),
  cropTo45,
}))
vi.mock('@/src/lib/images/storage', () => ({ uploadImage, deleteImage }))
// nextPosition awaits .from() directly; the hash lookup chains .where(). A
// promise carrying a .where property satisfies both without a query builder.
function selectChain() {
  const p = Promise.resolve([{ max: 0 }]) as Promise<unknown[]> & { where: () => Promise<unknown[]> }
  p.where = async () => []
  return p
}
vi.mock('@/src/db', () => ({
  getDb: () => ({
    select: () => ({ from: selectChain }),
    insert: () => ({ values: () => ({}) }),
    batch,
  }),
}))

const { ingestFromUrl, IngestError } = await import('./repo')

const HOST = 'teststore.public.blob.vercel-storage.com'
const STAGED = `https://${HOST}/tmp/a-1234.jpg`

/** Minimal Response with a streaming body, so readCapped's reader path is exercised. */
function streamed(chunks: Uint8Array[], init: ResponseInit = {}) {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(c)
      controller.close()
    },
  })
  return new Response(body, { status: 200, ...init })
}

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a rejection')
}

describe('ingestFromUrl', () => {
  const savedToken = process.env.BLOB_READ_WRITE_TOKEN
  let fetchSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_teststore_secret'
    cropTo45.mockReset()
    uploadImage.mockReset()
    deleteImage.mockReset()
    batch.mockReset()
    cropTo45.mockResolvedValue(Buffer.from('cropped-bytes'))
    uploadImage.mockResolvedValue({ url: `https://${HOST}/queue/h.jpg`, pathname: 'queue/h.jpg' })
    deleteImage.mockResolvedValue(undefined)
    batch.mockResolvedValue([])
    fetchSpy = vi.spyOn(globalThis, 'fetch')
  })

  afterEach(() => {
    fetchSpy.mockRestore()
    if (savedToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
    else process.env.BLOB_READ_WRITE_TOKEN = savedToken
  })

  it('ingests a staged object and then deletes it', async () => {
    fetchSpy.mockResolvedValue(streamed([new Uint8Array(1024)]))
    const res = await ingestFromUrl(STAGED, 'a.jpg')
    expect(res).toMatchObject({ status: 'added', name: 'a.jpg' })
    expect(deleteImage).toHaveBeenCalledWith(STAGED)
  })

  it('refuses a URL outside our own staging area without fetching it', async () => {
    const e = await caught(ingestFromUrl('https://evil.example.com/tmp/a.jpg', 'a.jpg'))
    expect(e).toBeInstanceOf(IngestError)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // The guard validates the URL we ask for; nothing re-checks where a 3xx
  // would land us, so redirects must not be followed at all.
  it('asks fetch to refuse redirects and to time out', async () => {
    fetchSpy.mockResolvedValue(streamed([new Uint8Array(8)]))
    await ingestFromUrl(STAGED, 'a.jpg')
    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(init.redirect).toBe('error')
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  // Content-Length is advisory and absent on a chunked response, where
  // Number(null) is 0 and any `declared > limit` test silently passes.
  it('stops reading a body that exceeds the cap even with no Content-Length', async () => {
    const chunk = new Uint8Array(4 * 1024 * 1024)
    const chunks = Array.from({ length: 10 }, () => chunk) // 40MB > 25MB cap
    let delivered = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (delivered >= chunks.length) return controller.close()
        delivered++
        controller.enqueue(chunks[delivered - 1])
      },
    })
    fetchSpy.mockResolvedValue(new Response(body, { status: 200 }))

    const e = await caught(ingestFromUrl(STAGED, 'big.jpg'))
    expect(e).toBeInstanceOf(IngestError)
    expect(e.message).toContain('dosya çok büyük')
    // The point of streaming: it gave up partway instead of buffering all 40MB.
    expect(delivered).toBeLessThan(chunks.length)
    expect(cropTo45).not.toHaveBeenCalled()
  })

  it('reports a missing staged object rather than ingesting nothing', async () => {
    fetchSpy.mockResolvedValue(new Response('nope', { status: 404 }))
    const e = await caught(ingestFromUrl(STAGED, 'a.jpg'))
    expect(e).toBeInstanceOf(IngestError)
    expect(e.message).toBe('yüklenen görsel bulunamadı')
  })

  // A cleanup failure is wasted storage, not a failed ingest.
  it('returns the ingest result even when deleting the staged copy fails', async () => {
    fetchSpy.mockResolvedValue(streamed([new Uint8Array(64)]))
    deleteImage.mockRejectedValue(new Error('blob del failed'))
    const res = await ingestFromUrl(STAGED, 'a.jpg')
    expect(res).toMatchObject({ status: 'added' })
  })

  it('still deletes the staged copy when the ingest itself fails', async () => {
    fetchSpy.mockResolvedValue(streamed([new Uint8Array(64)]))
    cropTo45.mockRejectedValue(new Error('VipsJpeg: broken'))
    await caught(ingestFromUrl(STAGED, 'a.jpg'))
    expect(deleteImage).toHaveBeenCalledWith(STAGED)
  })
})
