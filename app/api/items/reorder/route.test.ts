import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const applyOrder = vi.hoisted(() => vi.fn())

vi.mock('@/src/lib/queue/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/queue/repo')>()),
  applyOrder,
}))

const { POST } = await import('./route')
const { QueueError } = await import('@/src/lib/queue/repo')

function req(body: unknown) {
  return new Request('http://localhost/api/items/reorder', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

let errs: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  applyOrder.mockReset().mockResolvedValue(undefined)
  errs = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errs.mockRestore()
})

describe('POST /api/items/reorder', () => {
  it('applies the given order', async () => {
    const res = await POST(req({ ids: ['c', 'a', 'b'] }))
    expect(res.status).toBe(200)
    expect(applyOrder).toHaveBeenCalledWith(['c', 'a', 'b'])
  })

  it('accepts an empty list for an empty queue', async () => {
    const res = await POST(req({ ids: [] }))
    expect(res.status).toBe(200)
    expect(applyOrder).toHaveBeenCalledWith([])
  })

  it('answers 400 rather than 500 for a body that is not JSON', async () => {
    const res = await POST(req('{'))
    expect(res.status).toBe(400)
    expect(applyOrder).not.toHaveBeenCalled()
  })

  it.each([
    ['ids missing', {}],
    ['ids not an array', { ids: 'a,b' }],
    ['ids null', { ids: null }],
    ['a numeric entry', { ids: ['a', 2] }],
    ['a null entry', { ids: ['a', null] }],
    ['an object entry', { ids: [{ id: 'a' }] }],
    ['a nested array', { ids: [['a']] }],
    ['an empty-string id', { ids: [''] }],
    ['an id far longer than a uuid', { ids: ['x'.repeat(65)] }],
    ['a top-level array', [['a', 'b']]],
    ['null', null],
  ])('rejects %s without touching the database', async (_label, body) => {
    const res = await POST(req(body))
    expect(res.status).toBe(400)
    expect(applyOrder).not.toHaveBeenCalled()
  })

  // Bounds the batch the repo would build out of this list.
  it('rejects an absurdly long id list', async () => {
    const res = await POST(req({ ids: Array.from({ length: 1001 }, (_, i) => `id-${i}`) }))
    expect(res.status).toBe(400)
    expect(applyOrder).not.toHaveBeenCalled()
  })

  it('shows a deliberate refusal to the owner', async () => {
    applyOrder.mockRejectedValue(new QueueError('sıralama kuyrukla eşleşmiyor'))
    const res = await POST(req({ ids: ['a'] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('sıralama kuyrukla eşleşmiyor')
  })

  it('masks an internal failure and logs it instead', async () => {
    applyOrder.mockRejectedValue(new Error('NeonDbError: relation "items" postgres://u:p@h/db'))
    const res = await POST(req({ ids: ['a'] }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain('postgres')
    expect(errs).toHaveBeenCalled()
  })
})
