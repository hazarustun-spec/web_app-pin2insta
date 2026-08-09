import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq, ne } from 'drizzle-orm'
import { items } from '@/src/db/schema'

// A fake db that records what it was asked to do instead of talking to Neon.
// `select().from()` is awaited directly by some callers and chained with
// `.where()` by others, so the returned promise carries a `.where` property.
// `update().set().where()` returns an inert descriptor rather than a thenable:
// a statement only ever takes effect by being handed to `batch`, which is what
// makes "was this atomic?" an assertable question.
const batch = vi.hoisted(() => vi.fn())
const state = vi.hoisted(() => ({ rows: [] as { id: string; status: string }[] }))
const selectWheres = vi.hoisted(() => [] as unknown[])

vi.mock('@/src/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => {
        const p = Promise.resolve(state.rows) as Promise<unknown[]> & {
          where: (w: unknown) => Promise<unknown[]>
        }
        p.where = (w: unknown) => {
          selectWheres.push(w)
          return Promise.resolve(state.rows)
        }
        return p
      },
    }),
    update: (table: unknown) => ({
      set: (values: unknown) => ({
        where: (where: unknown) => ({ op: 'update', table, values, where }),
      }),
    }),
    batch,
  }),
}))

const { reindex, applyOrder, QueueError } = await import('./repo')

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a rejection')
}

const pending = (...ids: string[]) => ids.map((id) => ({ id, status: 'pending' }))

describe('reindex', () => {
  it('assigns dense 1-based positions in the given order', () => {
    expect(reindex(['c', 'a', 'b'])).toEqual([
      { id: 'c', position: 1 },
      { id: 'a', position: 2 },
      { id: 'b', position: 3 },
    ])
  })

  it('returns an empty list for an empty queue', () => {
    expect(reindex([])).toEqual([])
  })
})

describe('applyOrder', () => {
  beforeEach(() => {
    batch.mockReset()
    batch.mockResolvedValue([])
    state.rows = []
    selectWheres.length = 0
  })

  // The reorder must land as one round-trip. A sequential loop of awaited
  // updates can stop halfway and leave the queue in an order nobody asked for.
  it('writes every new position in a single atomic batch', async () => {
    state.rows = pending('a', 'b', 'c')
    await applyOrder(['c', 'a', 'b'])

    expect(batch).toHaveBeenCalledTimes(1)
    expect(batch.mock.calls[0][0]).toEqual([
      { op: 'update', table: items, values: { position: 1 }, where: eq(items.id, 'c') },
      { op: 'update', table: items, values: { position: 2 }, where: eq(items.id, 'a') },
      { op: 'update', table: items, values: { position: 3 }, where: eq(items.id, 'b') },
    ])
  })

  // DECISION: applyOrder requires the complete queue, because reindex hands out
  // 1..n densely — renumbering 3 of 10 items would collide with the positions
  // of the other 7. A short list is a stale client, not a partial reorder.
  it('refuses a subset of the queue without writing anything', async () => {
    state.rows = pending('a', 'b', 'c')
    const e = await caught(applyOrder(['c', 'a']))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
  })

  // DECISION: an unknown id is rejected, not ignored. Ignoring it would apply
  // the surviving order silently and leave the owner's screen disagreeing with
  // the database.
  it('refuses an id that is not in the queue without writing anything', async () => {
    state.rows = pending('a', 'b', 'c')
    const e = await caught(applyOrder(['a', 'b', 'zzz']))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
  })

  // A repeated id passes a bare length check while leaving one real item
  // unnumbered, so it has to be caught explicitly.
  it('refuses a duplicated id without writing anything', async () => {
    state.rows = pending('a', 'b', 'c')
    const e = await caught(applyOrder(['a', 'b', 'b']))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
  })

  // Posted items are history, not queue: listQueue hides them, so the client
  // cannot include them and the "whole queue" test must not demand them.
  it('measures the whole queue against non-posted rows only', async () => {
    state.rows = pending('a', 'b')
    await applyOrder(['b', 'a'])
    expect(selectWheres).toEqual([ne(items.status, 'posted')])
  })

  it('accepts an empty queue without issuing an empty batch', async () => {
    state.rows = []
    await applyOrder([])
    // drizzle's batch() takes a non-empty tuple; calling it with [] is an error.
    expect(batch).not.toHaveBeenCalled()
  })
})
