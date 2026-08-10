import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eq, ne, and, inArray, isNull } from 'drizzle-orm'
import { items, images } from '@/src/db/schema'
// Type-only: erased at compile time, so it never evaluates the mocked module.
import type { ItemKind } from './repo'

/**
 * A recording fake for the db.
 *
 * Statements are inert descriptors carrying their own `desc`. A descriptor only
 * lands in `executed` when something awaits it or calls `.returning()` — handing
 * it to `batch` does not — which is what makes "did this go out atomically?" an
 * assertable question rather than a hopeful comment.
 *
 * `deleteImage` records into the same `executed` list, so the ordering of the
 * row delete against the blob deletes is observable too.
 */
type Rec = { op: string; table?: string; values?: unknown; where?: unknown; url?: string }

const batch = vi.hoisted(() => vi.fn())
const deleteImage = vi.hoisted(() => vi.fn())
const executed = vi.hoisted(() => [] as Rec[])
const selectWheres = vi.hoisted(() => [] as { table: string; where: unknown }[])
const state = vi.hoisted(() => ({
  items: [] as Record<string, unknown>[],
  images: [] as Record<string, unknown>[],
  settings: [] as Record<string, unknown>[],
  updateReturning: [] as Record<string, unknown>[],
  deleteReturning: [] as Record<string, unknown>[],
}))

vi.mock('@/src/lib/images/storage', () => ({ uploadImage: vi.fn(), deleteImage }))

vi.mock('@/src/db', async () => {
  const { getTableName } = await import('drizzle-orm')
  const rowsOf = (table: string) =>
    table === 'items' ? state.items : table === 'settings' ? state.settings : state.images
  const resultOf = (desc: Rec) =>
    desc.op === 'delete' ? state.deleteReturning : state.updateReturning
  const stmt = (desc: Rec) => ({
    desc,
    returning: () => {
      executed.push(desc)
      return Promise.resolve(resultOf(desc))
    },
    then: (
      onFulfilled?: (v: unknown) => unknown,
      onRejected?: (e: unknown) => unknown,
    ) => {
      executed.push(desc)
      return Promise.resolve(resultOf(desc)).then(onFulfilled, onRejected)
    },
  })
  return {
    getDb: () => ({
      select: () => ({
        from: (table: unknown) => {
          const name = getTableName(table as never)
          const p = Promise.resolve(rowsOf(name)) as Promise<unknown[]> & {
            where: (w: unknown) => Promise<unknown[]>
          }
          p.where = (w: unknown) => {
            selectWheres.push({ table: name, where: w })
            return Promise.resolve(rowsOf(name))
          }
          return p
        },
      }),
      update: (table: unknown) => ({
        set: (values: unknown) => ({
          where: (where: unknown) =>
            stmt({ op: 'update', table: getTableName(table as never), values, where }),
        }),
      }),
      delete: (table: unknown) => ({
        where: (where: unknown) =>
          stmt({ op: 'delete', table: getTableName(table as never), where }),
      }),
      batch,
    }),
  }
})

const {
  QueueError,
  MAX_CAPTION_CHARS,
  isItemKind,
  kindShapeError,
  orderCarouselImages,
  setCaption,
  setKind,
  setScheduledAt,
  deleteItem,
  groupIntoCarousel,
} = await import('./repo')

async function caught(p: Promise<unknown>): Promise<Error> {
  try {
    await p
  } catch (e) {
    return e as Error
  }
  throw new Error('expected a rejection')
}

/** The plain payload of a statement handed to batch(), with the thenable machinery stripped. */
const descOf = (s: unknown) => (s as { desc: Rec }).desc
const batched = () => (batch.mock.calls[0][0] as unknown[]).map(descOf)

beforeEach(() => {
  batch.mockReset()
  batch.mockResolvedValue([])
  deleteImage.mockReset()
  deleteImage.mockImplementation(async (url: string) => {
    executed.push({ op: 'blob', url })
  })
  executed.length = 0
  selectWheres.length = 0
  state.items = []
  state.images = []
  state.settings = []
  state.updateReturning = [{ id: 'a' }]
  state.deleteReturning = [{ id: 'a' }]
})

describe('setCaption', () => {
  it('writes the caption to the given item', async () => {
    await setCaption('a', 'merhaba')
    expect(executed).toEqual([
      { op: 'update', table: 'items', values: { caption: 'merhaba' }, where: eq(items.id, 'a') },
    ])
  })

  // An item may be captioned later; the publisher already refuses to post an
  // empty-caption non-story, so there is nothing to protect against here.
  it('accepts an empty caption', async () => {
    await setCaption('a', '')
    expect(executed[0].values).toEqual({ caption: '' })
  })

  it('accepts a caption of exactly 2200 characters', async () => {
    await setCaption('a', 'x'.repeat(MAX_CAPTION_CHARS))
    expect(executed).toHaveLength(1)
  })

  // Instagram's ceiling. Storing a longer caption would turn into a publish
  // failure at 14:00 in a cron run instead of an error the owner can see.
  it('refuses a caption over 2200 characters without writing anything', async () => {
    const e = await caught(setCaption('a', 'x'.repeat(MAX_CAPTION_CHARS + 1)))
    expect(e).toBeInstanceOf(QueueError)
    expect(executed).toEqual([])
  })

  it('reports an item that does not exist', async () => {
    state.updateReturning = []
    const e = await caught(setCaption('nope', 'hi'))
    expect(e).toBeInstanceOf(QueueError)
    expect(e.message).toBe('öğe bulunamadı')
  })
})

describe('isItemKind', () => {
  it.each(['feed', 'carousel', 'story'])('accepts %s', (k) => {
    expect(isItemKind(k)).toBe(true)
  })

  it.each([
    ['a kind that does not exist', 'reel'],
    ['the empty string', ''],
    ['different casing', 'Feed'],
    ['whitespace padding', ' feed'],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
    ['an object', { kind: 'feed' }],
    ['an inherited property name', 'toString'],
  ])('rejects %s', (_label, v) => {
    expect(isItemKind(v)).toBe(false)
  })
})

// Mirrors validate() in src/lib/instagram/types.ts: a carousel takes 2-10
// images, anything else takes exactly one. A pair this rejects is an item that
// could never publish.
describe('kindShapeError', () => {
  it.each([
    ['carousel', 2],
    ['carousel', 10],
    ['feed', 1],
    ['story', 1],
  ] as [ItemKind, number][])('allows %s with %i image(s)', (kind, count) => {
    expect(kindShapeError(kind, count)).toBeNull()
  })

  it.each([
    ['carousel', 0],
    ['carousel', 1],
    ['carousel', 11],
    ['feed', 0],
    ['feed', 2],
    ['story', 0],
    ['story', 3],
  ] as [ItemKind, number][])('refuses %s with %i image(s)', (kind, count) => {
    expect(kindShapeError(kind, count)).toEqual(expect.any(String))
  })
})

describe('setKind', () => {
  it('changes the kind of a single-image item', async () => {
    state.items = [{ id: 'a' }]
    state.images = [{ id: 'i1' }]
    await setKind('a', 'story')
    expect(executed).toEqual([
      { op: 'update', table: 'items', values: { kind: 'story' }, where: eq(items.id, 'a') },
    ])
  })

  // Grouping is the only way into `carousel`: validate() demands 2-10 images,
  // so a one-image carousel is an item that can never publish.
  it('refuses to make a single-image item a carousel', async () => {
    state.items = [{ id: 'a' }]
    state.images = [{ id: 'i1' }]
    const e = await caught(setKind('a', 'carousel'))
    expect(e).toBeInstanceOf(QueueError)
    expect(executed).toEqual([])
  })

  it('allows carousel on an item that already holds two images', async () => {
    state.items = [{ id: 'a' }]
    state.images = [{ id: 'i1' }, { id: 'i2' }]
    await setKind('a', 'carousel')
    expect(executed[0].values).toEqual({ kind: 'carousel' })
  })

  // The mirror problem. DECISION: rejected, not silently ungrouped — ungrouping
  // would have to discard images or invent queue rows, and losing an upload to a
  // dropdown change is worse than an error message.
  it('refuses to turn a multi-image item into a feed post', async () => {
    state.items = [{ id: 'a' }]
    state.images = [{ id: 'i1' }, { id: 'i2' }, { id: 'i3' }]
    const e = await caught(setKind('a', 'feed'))
    expect(e).toBeInstanceOf(QueueError)
    expect(executed).toEqual([])
  })

  it('refuses a string that is not one of the three kinds', async () => {
    state.items = [{ id: 'a' }]
    state.images = [{ id: 'i1' }]
    const e = await caught(setKind('a', 'reel' as ItemKind))
    expect(e).toBeInstanceOf(QueueError)
    expect(executed).toEqual([])
  })

  it('reports an item that does not exist', async () => {
    state.items = []
    const e = await caught(setKind('nope', 'story'))
    expect(e).toBeInstanceOf(QueueError)
    expect(e.message).toBe('öğe bulunamadı')
    expect(executed).toEqual([])
  })

  // Counting somebody else's images would let a one-image item become a
  // carousel because the queue happens to hold three pictures.
  it('counts the images of the item it is changing, not every image', async () => {
    state.items = [{ id: 'a' }]
    state.images = [{ id: 'i1' }]
    await setKind('a', 'feed')
    expect(selectWheres).toContainEqual({ table: 'images', where: eq(images.itemId, 'a') })
  })
})

describe('deleteItem', () => {
  it('deletes the row and then the blobs of a pending item', async () => {
    state.items = [{ id: 'a', status: 'pending' }]
    state.images = [{ url: 'https://blob/1.jpg' }, { url: 'https://blob/2.jpg' }]
    await deleteItem('a')
    // Row first, blobs second: an orphaned blob is wasted storage, whereas a
    // surviving row pointing at deleted images fails at publish time.
    expect(executed.map((r) => r.op)).toEqual(['delete', 'blob', 'blob'])
    expect(deleteImage.mock.calls.map((c) => c[0])).toEqual([
      'https://blob/1.jpg',
      'https://blob/2.jpg',
    ])
  })

  // Hard carry-forward from Task 6. images.itemId cascades, so deleting a
  // posted item destroys the SHA-256 that stops the same picture being
  // republished later — duplicate detection would stop protecting exactly the
  // case it exists for.
  it('refuses to delete a posted item, touching neither the row nor the blobs', async () => {
    state.items = [{ id: 'a', status: 'posted' }]
    state.images = [{ url: 'https://blob/1.jpg' }]
    const e = await caught(deleteItem('a'))
    expect(e).toBeInstanceOf(QueueError)
    expect(executed).toEqual([])
    expect(deleteImage).not.toHaveBeenCalled()
  })

  it('deletes a failed item', async () => {
    state.items = [{ id: 'a', status: 'failed' }]
    state.images = []
    await deleteItem('a')
    expect(executed.map((r) => r.op)).toEqual(['delete'])
  })

  it('reports an item that does not exist', async () => {
    state.items = []
    const e = await caught(deleteItem('nope'))
    expect(e).toBeInstanceOf(QueueError)
    expect(e.message).toBe('öğe bulunamadı')
    expect(executed).toEqual([])
  })

  // The cron can post an item between the status read and the delete. Repeating
  // the status test inside the DELETE predicate closes that window.
  it('re-checks the posted status inside the delete statement', async () => {
    state.items = [{ id: 'a', status: 'pending' }]
    const del = executed
    await deleteItem('a')
    expect(del[0].where).toEqual(and(eq(items.id, 'a'), ne(items.status, 'posted')))
  })

  it('treats a delete that matched no row as a refusal and spares the blobs', async () => {
    state.items = [{ id: 'a', status: 'pending' }]
    state.images = [{ url: 'https://blob/1.jpg' }]
    state.deleteReturning = []
    const e = await caught(deleteItem('a'))
    expect(e).toBeInstanceOf(QueueError)
    expect(deleteImage).not.toHaveBeenCalled()
  })

  // A blob that will not delete is wasted storage, not a reason to put the item
  // back in the owner's queue.
  it('still removes the item when a blob delete fails', async () => {
    state.items = [{ id: 'a', status: 'pending' }]
    state.images = [{ url: 'https://blob/1.jpg' }]
    deleteImage.mockRejectedValue(new Error('blob 500'))
    const errs = vi.spyOn(console, 'error').mockImplementation(() => {})
    await deleteItem('a')
    expect(executed.map((r) => r.op)).toEqual(['delete'])
    expect(errs).toHaveBeenCalled()
    errs.mockRestore()
  })
})

describe('orderCarouselImages', () => {
  const img = (id: string, itemId: string, position: number) => ({ id, itemId, position })

  it('follows the given id order, then each item position', async () => {
    const rows = [img('b2', 'b', 1), img('a1', 'a', 0), img('b1', 'b', 0)]
    expect(orderCarouselImages(['b', 'a'], rows).map((i) => i.id)).toEqual(['b1', 'b2', 'a1'])
    expect(orderCarouselImages(['a', 'b'], rows).map((i) => i.id)).toEqual(['a1', 'b1', 'b2'])
  })

  // The database returns rows in whatever order it likes; relying on that would
  // scramble a carousel the owner arranged deliberately.
  it('ignores the order the rows arrived in', async () => {
    const forwards = [img('a1', 'a', 0), img('a2', 'a', 1), img('a3', 'a', 2)]
    const backwards = [...forwards].reverse()
    expect(orderCarouselImages(['a'], backwards).map((i) => i.id)).toEqual(['a1', 'a2', 'a3'])
  })

  it('breaks a position tie by id so the result is deterministic', () => {
    const rows = [img('z', 'a', 0), img('m', 'a', 0)]
    expect(orderCarouselImages(['a'], rows).map((i) => i.id)).toEqual(['m', 'z'])
    expect(orderCarouselImages(['a'], [...rows].reverse()).map((i) => i.id)).toEqual(['m', 'z'])
  })

  it('leaves the caller’s array untouched', () => {
    const rows = [img('a2', 'a', 1), img('a1', 'a', 0)]
    orderCarouselImages(['a'], rows)
    expect(rows.map((i) => i.id)).toEqual(['a2', 'a1'])
  })

  it('skips an id that has no images', () => {
    expect(orderCarouselImages(['a', 'b'], [img('b1', 'b', 0)]).map((i) => i.id)).toEqual(['b1'])
  })
})

describe('groupIntoCarousel', () => {
  const item = (id: string, over: Partial<Record<string, unknown>> = {}) => ({
    id,
    kind: 'feed',
    status: 'pending',
    ...over,
  })
  const img = (id: string, itemId: string, position = 0) => ({ id, itemId, position })

  it('moves every image onto the head in id order and drops the sources, in one batch', async () => {
    state.items = [item('a'), item('b'), item('c')]
    // Deliberately scrambled, as a real query may return them.
    state.images = [img('i2', 'b'), img('i3', 'c'), img('i1', 'a')]

    await groupIntoCarousel(['c', 'a', 'b'])

    expect(batch).toHaveBeenCalledTimes(1)
    expect(batched()).toEqual([
      { op: 'update', table: 'items', values: { kind: 'carousel' }, where: eq(items.id, 'c') },
      { op: 'update', table: 'images', values: { itemId: 'c', position: 0 }, where: eq(images.id, 'i3') },
      { op: 'update', table: 'images', values: { itemId: 'c', position: 1 }, where: eq(images.id, 'i1') },
      { op: 'update', table: 'images', values: { itemId: 'c', position: 2 }, where: eq(images.id, 'i2') },
      // Every image is already reassigned before the cascade could take it.
      // The head is not in `rest`, but the posted guard still rides along —
      // see the dedicated test below for why.
      {
        op: 'delete',
        table: 'items',
        where: and(inArray(items.id, ['a', 'b']), ne(items.status, 'posted')),
      },
    ])
    // Nothing ran outside the batch: a half-grouped carousel is a corrupt queue.
    expect(executed).toEqual([])
  })

  it.each([
    ['fewer than two items', ['a']],
    ['no items at all', []],
    ['more than ten items', Array.from({ length: 11 }, (_, i) => `id${i}`)],
    ['a repeated id', ['a', 'a']],
  ])('refuses %s without reading or writing anything', async (_label, ids) => {
    const e = await caught(groupIntoCarousel(ids))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
    expect(selectWheres).toEqual([])
  })

  // inArray silently returns fewer rows than ids given, so a typo would group
  // whatever matched and quietly drop the rest.
  it('refuses when an id does not exist', async () => {
    state.items = [item('a'), item('b')]
    state.images = [img('i1', 'a'), img('i2', 'b')]
    const e = await caught(groupIntoCarousel(['a', 'b', 'ghost']))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
  })

  it.each([['posted'], ['failed']])('refuses to group a %s item', async (status) => {
    state.items = [item('a'), item('b', { status })]
    state.images = [img('i1', 'a'), img('i2', 'b')]
    const e = await caught(groupIntoCarousel(['a', 'b']))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
  })

  it('refuses to nest a carousel inside a carousel', async () => {
    state.items = [item('a'), item('b', { kind: 'carousel' })]
    state.images = [img('i1', 'a'), img('i2', 'b'), img('i3', 'b', 1)]
    const e = await caught(groupIntoCarousel(['a', 'b']))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
  })

  // The 2-10 ceiling that matters is on IMAGES. Four items can already carry
  // twelve pictures, and validate() counts pictures.
  it('counts images rather than items when applying the ten-image ceiling', async () => {
    const ids = ['a', 'b', 'c']
    state.items = ids.map((id) => item(id))
    state.images = ids.flatMap((id) =>
      Array.from({ length: 4 }, (_, i) => img(`${id}${i}`, id, i)),
    )
    const e = await caught(groupIntoCarousel(ids))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
  })

  it('accepts ten images spread over fewer than ten items', async () => {
    const ids = ['a', 'b']
    state.items = ids.map((id) => item(id))
    state.images = ids.flatMap((id) =>
      Array.from({ length: 5 }, (_, i) => img(`${id}${i}`, id, i)),
    )
    await groupIntoCarousel(ids)
    expect(batch).toHaveBeenCalledTimes(1)
    expect(batched().filter((s) => s.table === 'images')).toHaveLength(10)
  })

  it('refuses a group that would hold fewer than two images', async () => {
    state.items = [item('a'), item('b')]
    state.images = [] // both items lost their images somehow
    const e = await caught(groupIntoCarousel(['a', 'b']))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
  })

  // Both image bounds need a case ON the boundary. Zero images and twelve
  // images are rejected by an off-by-one implementation too, so they prove
  // nothing about where the boundary actually sits.
  it('refuses a group that would hold exactly one image', async () => {
    state.items = [item('a'), item('b')]
    state.images = [img('i1', 'a')]
    const e = await caught(groupIntoCarousel(['a', 'b']))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
  })

  it('refuses a group that would hold exactly eleven images', async () => {
    const ids = ['a', 'b']
    state.items = ids.map((id) => item(id))
    state.images = [
      ...Array.from({ length: 6 }, (_, i) => img(`a${i}`, 'a', i)),
      ...Array.from({ length: 5 }, (_, i) => img(`b${i}`, 'b', i)),
    ]
    const e = await caught(groupIntoCarousel(ids))
    expect(e).toBeInstanceOf(QueueError)
    expect(batch).not.toHaveBeenCalled()
  })

  // The mock returns state.images whatever the predicate, so without this the
  // images could be selected by the wrong column and every test still passes.
  it('selects the images by item, not by image id', async () => {
    state.items = [item('a'), item('b')]
    state.images = [img('i1', 'a'), img('i2', 'b')]
    await groupIntoCarousel(['a', 'b'])
    expect(selectWheres).toContainEqual({
      table: 'images',
      where: inArray(images.itemId, ['a', 'b']),
    })
  })

  // The status check is a separate round-trip, so the publisher can mark a
  // source item posted in the window before the batch lands. An unguarded
  // delete would erase the row of a post that is live on Instagram.
  it('guards the delete against an item posted after the status check', async () => {
    state.items = [item('a'), item('b')]
    state.images = [img('i1', 'a'), img('i2', 'b')]
    await groupIntoCarousel(['a', 'b'])
    expect(batched()).toContainEqual({
      op: 'delete',
      table: 'items',
      where: and(inArray(items.id, ['b']), ne(items.status, 'posted')),
    })
  })
})

// ---------------------------------------------------------------------------
// Task 14: the owner's own time for one post.
// ---------------------------------------------------------------------------

describe('setScheduledAt', () => {
  /** 2026-08-09 08:00 Europe/Istanbul. */
  const NOW = new Date('2026-08-09T05:00:00Z')
  /** 14:35 the same day, in Istanbul. */
  const LATER = new Date('2026-08-09T11:35:00Z')
  const pending = (over: Record<string, unknown> = {}) => ({
    id: 'a', status: 'pending', postedDate: null, slotIndex: null, scheduledAt: null, ...over,
  })

  beforeEach(() => {
    state.items = [pending()]
    state.settings = [{ id: 1, slots: ['10:00', '14:00', '20:00'], timezone: 'Europe/Istanbul', hashtags: '' }]
  })

  it('stores the chosen time, truncated to the minute', async () => {
    // Seconds are not part of the identity: 14:35:30 and 14:35:00 are the same
    // claim, so storing the seconds would let two cards look different and
    // collide anyway.
    await setScheduledAt('a', new Date('2026-08-09T11:35:47.500Z'), NOW)
    expect(executed).toEqual([
      {
        op: 'update',
        table: 'items',
        values: { scheduledAt: new Date('2026-08-09T11:35:00.000Z') },
        where: and(eq(items.id, 'a'), eq(items.status, 'pending'), isNull(items.postedDate)),
      },
    ])
  })

  it('clears the time, putting the item back in the slot queue', async () => {
    state.items = [pending({ scheduledAt: LATER })]
    await setScheduledAt('a', null, NOW)
    expect(executed[0].values).toEqual({ scheduledAt: null })
  })

  it('refuses a time that has already gone, and writes nothing', async () => {
    const e = await caught(setScheduledAt('a', new Date(NOW.getTime() - 60_000), NOW))
    expect(e).toBeInstanceOf(QueueError)
    expect(e.message).toBe('geçmiş bir saat seçilemez')
    expect(executed).toEqual([])
  })

  it('refuses a minute another item already holds', async () => {
    // The publisher would discover this at 14:35 and report `race-lost`; the
    // owner finds out here instead, before saving.
    state.items = [pending(), pending({ id: 'b', scheduledAt: LATER })]
    const e = await caught(setScheduledAt('a', LATER, NOW))
    expect(e).toBeInstanceOf(QueueError)
    expect(e.message).toBe('bu dakika dolu — başka bir saat seçin')
    expect(executed).toEqual([])
  })

  it('refuses a minute a posted-unrecorded row is holding', async () => {
    // 14:00 today is claimed by a row that already went to Instagram.
    state.items = [pending(), pending({ id: 'stuck', postedDate: '2026-08-09', slotIndex: 840 })]
    const e = await caught(setScheduledAt('a', new Date('2026-08-09T11:00:00Z'), NOW))
    expect(e.message).toBe('bu dakika dolu — başka bir saat seçin')
  })

  it('lets an item keep the minute it already has', async () => {
    state.items = [pending({ scheduledAt: LATER })]
    await setScheduledAt('a', LATER, NOW)
    expect(executed).toHaveLength(1)
  })

  it('does not count an item no publish will reach as holding a minute', async () => {
    // A failed item never claims anything, so its time is free to take.
    state.items = [pending(), pending({ id: 'dead', status: 'failed', scheduledAt: LATER })]
    await setScheduledAt('a', LATER, NOW)
    expect(executed).toHaveLength(1)
  })

  it('reads the timezone from the settings row rather than assuming one', async () => {
    // The claim a slot holds is (local date, minute of that day), so which
    // minute an instant collides with depends on the configured zone. 11:00 UTC
    // is 13:00 in Berlin (minute 780) and 14:00 in Istanbul (minute 840): with
    // Berlin configured, the row holding 780 is the one in the way.
    state.settings = [{ id: 1, slots: ['10:00'], timezone: 'Europe/Berlin', hashtags: '' }]
    state.items = [pending(), pending({ id: 'stuck', postedDate: '2026-08-09', slotIndex: 780 })]

    const e = await caught(setScheduledAt('a', new Date('2026-08-09T11:00:00Z'), NOW))

    expect(selectWheres.some((w) => w.table === 'settings')).toBe(true)
    expect(e.message).toBe('bu dakika dolu — başka bir saat seçin')
  })

  it('reports an item that does not exist', async () => {
    state.items = []
    const e = await caught(setScheduledAt('nope', LATER, NOW))
    expect(e).toBeInstanceOf(QueueError)
    expect(e.message).toBe('öğe bulunamadı')
    expect(executed).toEqual([])
  })

  it('refuses an item that has already been published', async () => {
    state.items = [pending({ status: 'posted', postedDate: '2026-08-08', slotIndex: 600 })]
    const e = await caught(setScheduledAt('a', LATER, NOW))
    expect(e.message).toBe('yalnızca bekleyen gönderiye saat verilebilir')
    expect(executed).toEqual([])
  })

  it('refuses an item that is holding a slot claim already', async () => {
    // posted-unrecorded: Instagram has it, the row does not say so. Giving it a
    // time would promise a post that will never happen.
    state.items = [pending({ postedDate: '2026-08-09', slotIndex: 600 })]
    const e = await caught(setScheduledAt('a', LATER, NOW))
    expect(e.message).toBe('yalnızca bekleyen gönderiye saat verilebilir')
    expect(executed).toEqual([])
  })

  it('refuses when the cron run claims the item between the read and the write', async () => {
    // The same window deleteItem defends: the guard is repeated INSIDE the
    // update predicate, and the row count is what reports the loss.
    state.updateReturning = []
    const e = await caught(setScheduledAt('a', LATER, NOW))
    expect(e).toBeInstanceOf(QueueError)
    expect(e.message).toBe('gönderi artık beklemiyor — sayfayı yenileyin')
  })
})
