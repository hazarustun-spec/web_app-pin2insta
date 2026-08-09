import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const groupIntoCarousel = vi.hoisted(() => vi.fn())

vi.mock('@/src/lib/queue/repo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/queue/repo')>()),
  groupIntoCarousel,
}))

const { POST } = await import('./route')
const { QueueError } = await import('@/src/lib/queue/repo')

function req(body: unknown) {
  return new Request('http://localhost/api/items/group', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

let errs: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  groupIntoCarousel.mockReset().mockResolvedValue(undefined)
  errs = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  errs.mockRestore()
})

describe('POST /api/items/group', () => {
  it('groups the given ids, in the order they were given', async () => {
    const res = await POST(req({ ids: ['b', 'a'] }))
    expect(res.status).toBe(200)
    expect(groupIntoCarousel).toHaveBeenCalledWith(['b', 'a'])
  })

  // The plan's version destructured `ids` from an unawaited-guard req.json();
  // a malformed body threw before the try block and 500'd the route.
  it('answers 400 rather than 500 for a body that is not JSON', async () => {
    const res = await POST(req('not json at all'))
    expect(res.status).toBe(400)
    expect(groupIntoCarousel).not.toHaveBeenCalled()
  })

  it.each([
    ['ids missing', {}],
    ['ids not an array', { ids: 'a,b' }],
    ['a numeric entry', { ids: ['a', 2] }],
    ['a null entry', { ids: [null, 'a'] }],
    ['an object entry', { ids: [{ id: 'a' }] }],
    ['an empty-string id', { ids: ['a', ''] }],
    ['an id far longer than a uuid', { ids: ['x'.repeat(65)] }],
    ['a top-level array', [['a', 'b']]],
    ['null', null],
  ])('rejects %s without touching the database', async (_label, body) => {
    const res = await POST(req(body))
    expect(res.status).toBe(400)
    expect(groupIntoCarousel).not.toHaveBeenCalled()
  })

  it('shows a deliberate refusal to the owner', async () => {
    groupIntoCarousel.mockRejectedValue(new QueueError('karusel içine karusel eklenemez'))
    const res = await POST(req({ ids: ['a', 'b'] }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('karusel içine karusel eklenemez')
  })

  // THE defect the plan shipped: `{ error: (e as Error).message }` handed the
  // client whatever Drizzle, Neon or Blob happened to say.
  it('masks an internal failure instead of echoing its message', async () => {
    groupIntoCarousel.mockRejectedValue(
      new Error('NeonDbError: connect ECONNREFUSED postgres://user:pw@ep-1.neon.tech/db'),
    )
    const res = await POST(req({ ids: ['a', 'b'] }))
    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error).not.toContain('postgres')
    expect(body.error).not.toContain('neon.tech')
    expect(body.error).not.toContain('ECONNREFUSED')
    expect(errs).toHaveBeenCalled()
  })

  it('masks a non-Error throwable too', async () => {
    groupIntoCarousel.mockRejectedValue('postgres://user:pw@host/db')
    const res = await POST(req({ ids: ['a', 'b'] }))
    expect(res.status).toBe(500)
    expect((await res.json()).error).not.toContain('postgres')
  })
})
