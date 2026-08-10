import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const setCaption = vi.hoisted(() => vi.fn())
const setKind = vi.hoisted(() => vi.fn())
const setScheduledAt = vi.hoisted(() => vi.fn())
const deleteItem = vi.hoisted(() => vi.fn())

// Only the three mutations are faked; QueueError, isItemKind and
// MAX_CAPTION_CHARS stay real, because the route's contract is defined against
// the real ones.
vi.mock('@/src/lib/queue/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/queue/repo')>()),
  setCaption,
  setKind,
  setScheduledAt,
  deleteItem,
}))

const { PATCH, DELETE } = await import('./route')
const { QueueError, MAX_CAPTION_CHARS } = await import('@/src/lib/queue/repo')

const params = (id: string) => ({ params: Promise.resolve({ id }) })

function patchReq(body: unknown) {
  return new Request('http://localhost/api/items/abc', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

let errs: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  setCaption.mockReset().mockResolvedValue(undefined)
  setKind.mockReset().mockResolvedValue(undefined)
  setScheduledAt.mockReset().mockResolvedValue(undefined)
  deleteItem.mockReset().mockResolvedValue(undefined)
  errs = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errs.mockRestore()
})

describe('PATCH /api/items/[id]', () => {
  it('saves a caption against the id in the route', async () => {
    const res = await PATCH(patchReq({ caption: 'merhaba' }), params('abc'))
    expect(res.status).toBe(200)
    expect(setCaption).toHaveBeenCalledWith('abc', 'merhaba')
    expect(setKind).not.toHaveBeenCalled()
  })

  it('sets a kind', async () => {
    const res = await PATCH(patchReq({ kind: 'story' }), params('abc'))
    expect(res.status).toBe(200)
    expect(setKind).toHaveBeenCalledWith('abc', 'story')
    expect(setCaption).not.toHaveBeenCalled()
  })

  // The kind change is the one that can be refused on database state; running
  // it first means a refusal leaves nothing at all applied.
  it('applies the kind before the caption', async () => {
    await PATCH(patchReq({ caption: 'x', kind: 'story' }), params('abc'))
    expect(setKind.mock.invocationCallOrder[0]).toBeLessThan(
      setCaption.mock.invocationCallOrder[0],
    )
  })

  it('leaves the caption alone when the kind change is refused', async () => {
    setKind.mockRejectedValue(new QueueError('karusel 2 ile 10 görsel içermelidir'))
    const res = await PATCH(patchReq({ caption: 'x', kind: 'carousel' }), params('abc'))
    expect(res.status).toBe(400)
    expect(setCaption).not.toHaveBeenCalled()
  })

  // req.json() throws on a malformed body. Uncaught, that is a 500.
  it('answers 400 rather than 500 for a body that is not JSON', async () => {
    const res = await PATCH(patchReq('{'), params('abc'))
    expect(res.status).toBe(400)
    expect(setCaption).not.toHaveBeenCalled()
    expect(setKind).not.toHaveBeenCalled()
  })

  // The messages are asserted, not just the status. Every one of these bodies
  // would produce SOME 400 even with the shape guards deleted — a body that is
  // not an object simply has no `caption` and no `kind` — so only pinning which
  // complaint comes back makes the guards observable.
  it.each([
    ['a top-level array', [{ caption: 'x' }], 'geçersiz istek'],
    ['null', null, 'geçersiz istek'],
    ['a number', 42, 'geçersiz istek'],
    ['a string', '"hello"', 'geçersiz istek'],
    ['nothing to change', {}, 'güncellenecek bir alan yok'],
    ['a non-string caption', { caption: 42 }, 'geçersiz açıklama'],
    ['an object caption', { caption: { text: 'x' } }, 'geçersiz açıklama'],
    ['a null caption', { caption: null }, 'geçersiz açıklama'],
    ['a kind that does not exist', { kind: 'reel' }, 'geçersiz gönderi türü'],
    ['a null kind', { kind: null }, 'geçersiz gönderi türü'],
    ['a numeric kind', { kind: 1 }, 'geçersiz gönderi türü'],
    ['a kind with different casing', { kind: 'Story' }, 'geçersiz gönderi türü'],
  ])('rejects %s without touching the database', async (_label, body, message) => {
    const res = await PATCH(patchReq(body), params('abc'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe(message)
    expect(setCaption).not.toHaveBeenCalled()
    expect(setKind).not.toHaveBeenCalled()
  })

  it('rejects an over-long caption before touching the database', async () => {
    const res = await PATCH(patchReq({ caption: 'x'.repeat(MAX_CAPTION_CHARS + 1) }), params('abc'))
    expect(res.status).toBe(400)
    expect(setCaption).not.toHaveBeenCalled()
  })

  it('accepts a caption of exactly the limit', async () => {
    const res = await PATCH(patchReq({ caption: 'x'.repeat(MAX_CAPTION_CHARS) }), params('abc'))
    expect(res.status).toBe(200)
  })

  it('shows a deliberate refusal to the owner', async () => {
    setCaption.mockRejectedValue(new QueueError('öğe bulunamadı'))
    const res = await PATCH(patchReq({ caption: 'x' }), params('abc'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('öğe bulunamadı')
  })

  // Drizzle/Neon errors carry hostnames and connection strings. The plan's
  // group route echoed (e as Error).message straight back; nothing here may.
  it('masks an internal failure and logs it instead', async () => {
    setCaption.mockRejectedValue(new Error('connect ECONNREFUSED postgres://user:pw@host/db'))
    const res = await PATCH(patchReq({ caption: 'x' }), params('abc'))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toContain('postgres')
    expect(body.error).not.toContain('ECONNREFUSED')
    expect(errs).toHaveBeenCalled()
  })
})

describe('DELETE /api/items/[id]', () => {
  it('deletes the item named in the route', async () => {
    const res = await DELETE(new Request('http://localhost/api/items/abc'), params('abc'))
    expect(res.status).toBe(200)
    expect(deleteItem).toHaveBeenCalledWith('abc')
  })

  it('shows the refusal to delete a posted item', async () => {
    deleteItem.mockRejectedValue(new QueueError('paylaşılmış gönderi silinemez'))
    const res = await DELETE(new Request('http://localhost/api/items/abc'), params('abc'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('paylaşılmış gönderi silinemez')
  })

  it('masks an internal delete failure', async () => {
    deleteItem.mockRejectedValue(new Error('BlobAccessError: token vercel_blob_rw_store_secret'))
    const res = await DELETE(new Request('http://localhost/api/items/abc'), params('abc'))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain('vercel_blob_rw')
    expect(errs).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Task 14: the owner's own time for one post.
// ---------------------------------------------------------------------------

describe('PATCH /api/items/[id] — scheduledAt', () => {
  it('saves the instant the body names', async () => {
    const res = await PATCH(patchReq({ scheduledAt: '2026-08-09T11:35:00.000Z' }), params('abc'))
    expect(res.status).toBe(200)
    expect(setScheduledAt).toHaveBeenCalledWith('abc', new Date('2026-08-09T11:35:00.000Z'))
  })

  it('clears the time with an explicit null', async () => {
    // null is the whole point of the field: it puts the item back in the slot
    // queue. `undefined` means "not part of this request" and must not clear it.
    const res = await PATCH(patchReq({ scheduledAt: null }), params('abc'))
    expect(res.status).toBe(200)
    expect(setScheduledAt).toHaveBeenCalledWith('abc', null)
  })

  it('does not touch the time when the field is absent', async () => {
    await PATCH(patchReq({ caption: 'merhaba' }), params('abc'))
    expect(setScheduledAt).not.toHaveBeenCalled()
  })

  it('counts as a field to update on its own', async () => {
    const res = await PATCH(patchReq({ scheduledAt: null }), params('abc'))
    expect(res.status).toBe(200)
  })

  it.each([
    ['a number', 1_775_000_000_000],
    ['a date that is not one', 'yarın öğlen'],
    ['an empty string', ''],
    ['an object', { at: '2026-08-09T11:35:00.000Z' }],
    ['an impossible instant', '2026-13-40T25:99:00.000Z'],
  ])('refuses %s without calling the repo', async (_label, value) => {
    const res = await PATCH(patchReq({ scheduledAt: value }), params('abc'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'geçersiz tarih veya saat' })
    expect(setScheduledAt).not.toHaveBeenCalled()
  })

  it('passes the repo\'s own refusal back to the owner', async () => {
    // "bu dakika dolu" is written for a human and is the one thing that says
    // what to do next; the generic 500 sentence would hide it.
    setScheduledAt.mockRejectedValue(new QueueError('bu dakika dolu — başka bir saat seçin'))
    const res = await PATCH(patchReq({ scheduledAt: '2026-08-09T11:35:00.000Z' }), params('abc'))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'bu dakika dolu — başka bir saat seçin' })
  })

  it('never echoes a driver failure', async () => {
    setScheduledAt.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ep-x.eu-central-1.aws.neon.tech'))
    const res = await PATCH(patchReq({ scheduledAt: '2026-08-09T11:35:00.000Z' }), params('abc'))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('neon.tech')
  })

  it('applies the time before the caption, so a refusal leaves nothing applied', async () => {
    const order: string[] = []
    setScheduledAt.mockImplementation(async () => { order.push('scheduledAt') })
    setCaption.mockImplementation(async () => { order.push('caption') })
    await PATCH(patchReq({ caption: 'merhaba', scheduledAt: null }), params('abc'))
    expect(order).toEqual(['scheduledAt', 'caption'])
  })
})
