import { describe, it, expect, vi, beforeEach } from 'vitest'
import { and, eq, desc, asc, isNotNull, inArray } from 'drizzle-orm'
import { items, images, metrics } from '@/src/db/schema'
import { InstagramError } from '@/src/lib/instagram'
import {
  slotPerformance,
  slotAdvice,
  describeAdvice,
  suggestSlotChange,
  formatPostedAt,
  refreshInsights,
  listPublished,
  metricState,
  MIN_SAMPLES,
  MIN_SLOT_SAMPLES,
  MIN_GAP,
  REFRESH_LIMIT,
  HISTORY_LIMIT,
  type MetricRow,
} from './insights'

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>
type SelectRec = { table: string; join?: string; where?: unknown; order?: unknown[]; limit?: number }
type InsertRec = { table: string; values: Row; conflict?: unknown }

const selects = vi.hoisted(() => [] as SelectRec[])
const joins = vi.hoisted(() => [] as unknown[])
const inserts = vi.hoisted(() => [] as InsertRec[])
const state = vi.hoisted(() => ({
  items: [] as Row[],
  images: [] as Row[],
  /** Set to make every metrics upsert fail, e.g. a dropped connection. */
  insertError: null as unknown,
}))

vi.mock('@/src/db', async () => {
  const { getTableName, getTableColumns, Column, SQL, StringChunk } = await import('drizzle-orm')

  /**
   * The fake APPLIES the recorded `orderBy`, so "the carousel cover is the
   * image at position 0" is decided by the statement under test rather than by
   * the order a test happened to list its fixtures in.
   */
  const keyOf = (col: InstanceType<typeof Column>): string => {
    const table = (col as unknown as { table: object }).table
    const found = Object.entries(getTableColumns(table as never)).find(([, c]) => c === col)
    if (!found) throw new Error(`unknown column on ${getTableName(table as never)}`)
    return found[0]
  }
  const chunkText = (c: unknown) =>
    c instanceof StringChunk ? (c.value as string[]).join('') : null
  const term = (spec: unknown) => {
    if (!(spec instanceof SQL)) throw new Error('unsupported order term')
    const parts = (spec.queryChunks as unknown[]).filter((c) => chunkText(c) !== '')
    const [col, dir] = parts
    if (!(col instanceof Column)) throw new Error('unsupported order term')
    return { key: keyOf(col), dir: chunkText(dir) === ' desc' ? -1 : 1 }
  }
  const sortRows = (rows: Row[], order: unknown[] | undefined) => {
    const terms = (order ?? []).map(term).filter((t) => rows.some((r) => t.key in r))
    if (terms.length === 0) return rows
    return [...rows].sort((x, y) => {
      for (const t of terms) {
        // Dates are compared by value: two Date objects for the same instant
        // are not `===`, and treating them as unequal makes the comparator
        // inconsistent and the sort a shuffle.
        const val = (v: unknown) => (v instanceof Date ? v.getTime() : v)
        const a = val(x[t.key])
        const b = val(y[t.key])
        if (a === b) continue
        if (a === null || a === undefined) return -1 * t.dir
        if (b === null || b === undefined) return 1 * t.dir
        return ((a as number) < (b as number) ? -1 : 1) * t.dir
      }
      return 0
    })
  }
  type Builder = {
    leftJoin: (t: unknown, on: unknown) => Builder
    where: (w: unknown) => Builder
    orderBy: (...o: unknown[]) => Builder
    limit: (n: number) => Builder
    then: (ok?: (v: Row[]) => unknown, no?: (e: unknown) => unknown) => Promise<unknown>
  }
  const rowsOf = (table: string) => (table === 'images' ? state.images : state.items)
  const select = (rec: SelectRec): Builder => {
    const b: Builder = {
      leftJoin: (t, on) => {
        // The join condition is recorded too, so a test can prove metrics are
        // joined on the item id and not on something that happens to match.
        rec.join = getTableName(t as never)
        joins.push(on)
        return b
      },
      where: (w) => { rec.where = w; return b },
      orderBy: (...o) => { rec.order = o; return b },
      limit: (n) => { rec.limit = n; return b },
      then: (ok, no) => Promise.resolve(sortRows(rowsOf(rec.table), rec.order)).then(ok, no),
    }
    return b
  }
  return {
    getDb: () => ({
      select: () => ({
        from: (table: unknown) => {
          const rec: SelectRec = { table: getTableName(table as never) }
          selects.push(rec)
          return select(rec)
        },
      }),
      insert: (table: unknown) => ({
        values: (values: Row) => {
          const rec: InsertRec = { table: getTableName(table as never), values }
          const run = () =>
            state.insertError ? Promise.reject(state.insertError) : Promise.resolve([])
          return {
            onConflictDoUpdate: (conflict: unknown) => {
              rec.conflict = conflict
              inserts.push(rec)
              return { then: (ok?: (v: unknown) => unknown, no?: (e: unknown) => unknown) => run().then(ok, no) }
            },
            then: (ok?: (v: unknown) => unknown, no?: (e: unknown) => unknown) => {
              inserts.push(rec)
              return run().then(ok, no)
            },
          }
        },
      }),
    }),
  }
})

const client = vi.hoisted(() => ({
  isDryRun: false,
  insights: vi.fn(),
  publish: vi.fn(),
}))

/**
 * Set to hand `refreshInsights` the REAL dry-run client instead of the stub —
 * the only client this project has until an Instagram account exists, and so
 * the only end-to-end path there is.
 */
const realClient = vi.hoisted(() => ({ value: null as unknown }))

vi.mock('@/src/lib/instagram', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/instagram')>()),
  getInstagramClient: () => realClient.value ?? client,
}))

beforeEach(() => {
  selects.length = 0
  inserts.length = 0
  joins.length = 0
  state.items = []
  state.images = []
  state.insertError = null
  realClient.value = null
  client.isDryRun = false
  client.insights.mockReset().mockResolvedValue({ likes: 1, comments: 2, reach: 3, saved: 4 })
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

// ---------------------------------------------------------------------------
// slotPerformance
// ---------------------------------------------------------------------------

/** 10:00, 14:00 and 20:00 as `items.slot_index` stores them since Task 10. */
const TEN = 600
const TWO = 840
const EIGHT = 1200

const row = (slotIndex: number, likes: number, extra: Partial<MetricRow> = {}): MetricRow => ({
  slotIndex, likes, comments: 0, saved: 0, reach: 100, ...extra,
})

const many = (n: number, slotIndex: number, likes: number) =>
  Array.from({ length: n }, () => row(slotIndex, likes))

describe('slotPerformance', () => {
  it('averages engagement per slot and labels each bucket with its time', () => {
    expect(slotPerformance([row(TEN, 10), row(TEN, 20), row(TWO, 100)])).toEqual([
      { slotIndex: TEN, time: '10:00', samples: 2, avgEngagement: 15 },
      { slotIndex: TWO, time: '14:00', samples: 1, avgEngagement: 100 },
    ])
  })

  it('counts likes, comments and saves, and ignores reach', () => {
    // Engagement is INTERACTIONS, not a rate: see the comment on
    // `engagementOf`. A row with a huge reach and one interaction must not
    // score higher than a row with three interactions and no reach at all.
    const stats = slotPerformance([
      row(TEN, 1, { comments: 2, saved: 3, reach: 100_000 }),
      row(TWO, 3, { comments: 0, saved: 0, reach: 0 }),
    ])
    expect(stats.map((s) => s.avgEngagement)).toEqual([6, 3])
  })

  it('sorts by time of day, whatever order the rows arrive in', () => {
    const stats = slotPerformance([row(EIGHT, 1), row(TEN, 1), row(TWO, 1)])
    expect(stats.map((s) => s.time)).toEqual(['10:00', '14:00', '20:00'])
  })

  it('keeps a slot index that is not a time of day, but gives it no time', () => {
    // Nothing writes such a row today, but slot_index is a plain integer
    // column. A bucket that cannot be named must not be dropped from the
    // averages silently — it is kept, and `slotAdvice` refuses to name it.
    const stats = slotPerformance([row(5000, 10), row(5000, 20)])
    expect(stats).toEqual([{ slotIndex: 5000, time: null, samples: 2, avgEngagement: 15 }])
  })

  it('returns nothing for no rows', () => {
    expect(slotPerformance([])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// slotAdvice / suggestSlotChange
// ---------------------------------------------------------------------------

describe('suggestSlotChange', () => {
  it('returns null before the sample threshold', () => {
    // Split across two slots that both clear the per-slot floor and differ by
    // 90%, so the TOTAL gate is the only thing that can produce the null. The
    // plan's version put all 14 posts in one slot, where "fewer than two
    // comparable slots" answers first and the total gate is never reached —
    // a test that passes whether or not MIN_SAMPLES is checked at all.
    const few = [...many(7, TEN, 10), ...many(7, EIGHT, 100)]
    expect(few).toHaveLength(MIN_SAMPLES - 1)
    const stats = slotPerformance(few)
    expect(slotAdvice(stats).state).toBe('collecting')
    expect(suggestSlotChange(stats)).toBe(null)
    // One more post and the same numbers do produce a suggestion.
    expect(suggestSlotChange(slotPerformance([...few, row(EIGHT, 100)]))).toContain('10:00')
  })

  it('names the weakest slot BY TIME when it lags the best by 30% or more', () => {
    const rows = [...many(8, TEN, 10), ...many(8, EIGHT, 100)]
    const message = suggestSlotChange(slotPerformance(rows))
    expect(message).toContain('10:00')
    expect(message).toContain('20:00')
    expect(message).toContain('%90')
    // The owner chose "10:00" and has never seen the number 600. If a raw
    // slot_index ever reaches a sentence, this is where it gets caught.
    expect(message).not.toContain('600')
    expect(message).not.toContain('1200')
  })

  it('returns null when slots perform within 30% of each other', () => {
    const rows = [...many(8, TEN, 90), ...many(8, EIGHT, 100)]
    expect(suggestSlotChange(slotPerformance(rows))).toBe(null)
  })

  it('is honest that the sample is small rather than stating a finding', () => {
    const rows = [...many(8, TEN, 10), ...many(8, EIGHT, 100)]
    expect(suggestSlotChange(slotPerformance(rows))).toContain('kesin')
  })
})

describe('slotAdvice — the per-slot sample floor', () => {
  it('will not call a slot weakest on the strength of a single post', () => {
    // MIN_SAMPLES alone is a TOTAL, so 14 posts at 10:00 and one unlucky post
    // at 20:00 clears it — and the plan would then name 20:00 the weakest
    // slot on a sample of one. This is the correction: the comparison needs
    // MIN_SLOT_SAMPLES in each slot it names.
    const rows = [...many(MIN_SAMPLES - 1, TEN, 100), row(EIGHT, 1)]
    const stats = slotPerformance(rows)
    expect(stats.reduce((n, s) => n + s.samples, 0)).toBeGreaterThanOrEqual(MIN_SAMPLES)
    expect(suggestSlotChange(stats)).toBe(null)
    expect(slotAdvice(stats).state).toBe('thin')
  })

  it('speaks once both slots reach the per-slot floor', () => {
    const rows = [
      ...many(MIN_SLOT_SAMPLES, TEN, 10),
      ...many(MIN_SAMPLES - MIN_SLOT_SAMPLES, EIGHT, 100),
    ]
    expect(suggestSlotChange(slotPerformance(rows))).toContain('10:00')
  })

  it('ignores a thin slot instead of silencing the whole comparison', () => {
    // A newly added fourth slot must not suppress advice about the three that
    // have been running for months.
    const rows = [
      ...many(MIN_SLOT_SAMPLES, TEN, 10),
      ...many(MIN_SLOT_SAMPLES, EIGHT, 100),
      ...many(MIN_SLOT_SAMPLES, TWO, 100),
      row(0, 0),
    ]
    const message = suggestSlotChange(slotPerformance(rows))
    expect(message).toContain('10:00')
    expect(message).not.toContain('00:00')
  })

  it('refuses to name a bucket it cannot turn into a time', () => {
    const rows = [...many(MIN_SLOT_SAMPLES + 5, 5000, 10), ...many(MIN_SLOT_SAMPLES + 5, EIGHT, 100)]
    expect(suggestSlotChange(slotPerformance(rows))).toBe(null)
  })
})

describe('slotAdvice — states', () => {
  it('reports progress against the quantity the threshold actually tests', () => {
    const stats = slotPerformance(many(7, TEN, 10))
    expect(slotAdvice(stats)).toEqual({ state: 'collecting', measured: 7, required: MIN_SAMPLES })
    expect(describeAdvice(slotAdvice(stats))).toContain(`7/${MIN_SAMPLES}`)
  })

  it('starts at zero on a database with no metrics at all', () => {
    expect(slotAdvice([])).toEqual({ state: 'collecting', measured: 0, required: MIN_SAMPLES })
  })

  it('says nothing rather than everything when every post scored zero', () => {
    // This is the dry-run client's world: it answers every insights call with
    // zeros. "20:00 is 100% weaker than 10:00" out of a fresh install would be
    // a lie the owner might act on.
    const rows = [...many(8, TEN, 0), ...many(8, EIGHT, 0)]
    expect(slotAdvice(slotPerformance(rows))).toEqual({ state: 'even' })
    expect(suggestSlotChange(slotPerformance(rows))).toBe(null)
  })

  it('measures the gap as a share of the best slot', () => {
    const advice = slotAdvice(slotPerformance([...many(8, TEN, 40), ...many(8, EIGHT, 100)]))
    expect(advice.state).toBe('weak-slot')
    if (advice.state !== 'weak-slot') throw new Error('unreachable')
    expect(advice.gap).toBeCloseTo(0.6)
    expect(advice.worst.time).toBe('10:00')
    expect(advice.best.time).toBe('20:00')
  })

  it('speaks at exactly the threshold and holds its tongue just inside it', () => {
    // "lags the best by 30% OR MORE", so 70 against 100 is the first gap worth
    // a sentence and 71 against 100 is not.
    const at = slotPerformance([...many(8, TEN, 70), ...many(8, EIGHT, 100)])
    const inside = slotPerformance([...many(8, TEN, 71), ...many(8, EIGHT, 100)])
    expect(slotAdvice(at).state).toBe('weak-slot')
    expect(slotAdvice(inside).state).toBe('even')
    expect(MIN_GAP).toBe(0.3)
  })

  it('honours an explicit minSamples, as the plan signature promises', () => {
    const stats = slotPerformance([...many(5, TEN, 10), ...many(5, EIGHT, 100)])
    expect(suggestSlotChange(stats)).toBe(null)
    expect(suggestSlotChange(stats, 10)).toContain('10:00')
  })
})

// ---------------------------------------------------------------------------
// formatPostedAt
// ---------------------------------------------------------------------------

describe('formatPostedAt', () => {
  it('renders the instant in the owner\'s timezone, not the server\'s', () => {
    // 2026-08-12T11:00:00Z is 14:00 in Istanbul and 13:00 in Berlin.
    const at = new Date('2026-08-12T11:00:00Z')
    expect(formatPostedAt(at, 'Europe/Istanbul')).toBe('12 Ağu 2026 · 14:00')
    expect(formatPostedAt(at, 'Europe/Berlin')).toBe('12 Ağu 2026 · 13:00')
  })

  it('returns null instead of "Invalid Date" for a row with no posted_at', () => {
    expect(formatPostedAt(null, 'Europe/Istanbul')).toBe(null)
    expect(formatPostedAt(new Date('nonsense'), 'Europe/Istanbul')).toBe(null)
  })

  it('falls back to UTC rather than throwing on an unusable timezone', () => {
    expect(formatPostedAt(new Date('2026-08-12T11:00:00Z'), 'Mars/Olympus')).toBe('12 Ağu 2026 · 11:00')
  })
})

// ---------------------------------------------------------------------------
// refreshInsights
// ---------------------------------------------------------------------------

const posted = (id: string, igMediaId: string | null = `ig-${id}`) => ({
  id, igMediaId, status: 'posted', postedAt: new Date('2026-08-12T11:00:00Z'),
})

describe('refreshInsights', () => {
  it('reads only posted items that have an instagram id, newest first', async () => {
    state.items = [posted('a')]
    await refreshInsights()
    expect(selects[0]).toEqual({
      table: 'items',
      where: and(eq(items.status, 'posted'), isNotNull(items.igMediaId)),
      order: [desc(items.postedAt)],
      limit: REFRESH_LIMIT,
    })
  })

  it('upserts one metrics row per item', async () => {
    state.items = [posted('a'), posted('b')]
    const report = await refreshInsights()

    expect(client.insights.mock.calls.map((c) => c[0])).toEqual(['ig-a', 'ig-b'])
    expect(inserts).toHaveLength(2)
    expect(inserts[0].table).toBe('metrics')
    expect(inserts[0].values).toMatchObject({ itemId: 'a', likes: 1, comments: 2, reach: 3, saved: 4 })
    // metrics.itemId is the primary key: a second run must overwrite, not fail.
    expect(inserts[0].conflict).toMatchObject({ target: metrics.itemId })
    expect(report).toEqual({ scanned: 2, refreshed: 2, skipped: 0, dryRun: false })
  })

  it('runs end to end against the real dry-run client', async () => {
    // Not the stub: the actual client `getInstagramClient()` returns when
    // IG_ACCESS_TOKEN and IG_USER_ID are unset, which is every environment
    // this app has had so far. It answers every insights call with zeros, so
    // the run must complete, write a row per post, and SAY it was a dry run —
    // otherwise those zeros would look like measured engagement.
    const { createDryRunClient } = await import('@/src/lib/instagram/dryrun')
    realClient.value = createDryRunClient()
    state.items = [posted('a'), posted('b')]

    expect(await refreshInsights()).toEqual({ scanned: 2, refreshed: 2, skipped: 0, dryRun: true })
    expect(inserts.map((i) => i.values)).toMatchObject([
      { itemId: 'a', likes: 0, comments: 0, reach: 0, saved: 0 },
      { itemId: 'b', likes: 0, comments: 0, reach: 0, saved: 0 },
    ])
    // And the zeros it just wrote must not become a suggestion.
    expect(suggestSlotChange(slotPerformance(
      Array.from({ length: 30 }, (_, i) => row(i % 2 ? TEN : EIGHT, 0)),
    ))).toBe(null)
  })

  it('works against a stubbed dry-run client and says so', async () => {
    client.isDryRun = true
    client.insights.mockResolvedValue({ likes: 0, comments: 0, reach: 0, saved: 0 })
    state.items = [posted('a')]
    expect(await refreshInsights()).toEqual({ scanned: 1, refreshed: 1, skipped: 0, dryRun: true })
  })

  it('skips an item whose metrics are not available yet and carries on', async () => {
    // A brand-new account errors on insights until it has activity. That is
    // "not yet", and the next run will pick it up.
    state.items = [posted('a'), posted('b')]
    client.insights.mockRejectedValueOnce(new InstagramError('no data', 400, 'GraphMethodException'))
    const report = await refreshInsights()
    expect(report).toEqual({ scanned: 2, refreshed: 1, skipped: 1, dryRun: false })
    expect(inserts.map((i) => i.values.itemId)).toEqual(['b'])
  })

  it('stops the run and reports a dead token instead of writing zeros', async () => {
    // Task 4 rethrows on 401/403/OAuthException because the metrics are
    // UNKNOWABLE, not zero. The plan's bare `catch {}` would turn a revoked
    // token into a table full of zeros and quietly poison every average this
    // module computes.
    state.items = [posted('a'), posted('b'), posted('c')]
    client.insights
      .mockResolvedValueOnce({ likes: 5, comments: 0, reach: 0, saved: 0 })
      .mockRejectedValueOnce(new InstagramError('Invalid OAuth access token', 401, 'OAuthException'))

    await expect(refreshInsights()).rejects.toThrow(InstagramError)
    // It stopped: the third item was never asked for, and nothing was written
    // for the item whose metrics could not be read.
    expect(client.insights).toHaveBeenCalledTimes(2)
    expect(inserts.map((i) => i.values.itemId)).toEqual(['a'])
  })

  it('treats a permission failure the same way', async () => {
    state.items = [posted('a')]
    client.insights.mockRejectedValue(new InstagramError('(#10) permission', 403, 'OAuthException'))
    await expect(refreshInsights()).rejects.toThrow(InstagramError)
    expect(inserts).toEqual([])
  })

  it('names the item it skipped, so a permanently stuck row can be found', async () => {
    const logged: unknown[] = []
    vi.spyOn(console, 'error').mockImplementation((...a) => void logged.push(...a))
    state.items = [posted('the-stuck-one')]
    client.insights.mockRejectedValue(new InstagramError('graph said no', 500))
    await refreshInsights()
    expect(logged.map(String).join(' ')).toContain('the-stuck-one')
  })

  it('counts a failed write as skipped rather than as refreshed', async () => {
    state.items = [posted('a')]
    state.insertError = new Error('neon: connection to ep-secret.aws.neon.tech failed')
    expect(await refreshInsights()).toEqual({ scanned: 1, refreshed: 0, skipped: 1, dryRun: false })
  })

  it('honours an explicit limit', async () => {
    state.items = []
    await refreshInsights(7)
    expect(selects[0].limit).toBe(7)
  })
})

// ---------------------------------------------------------------------------
// listPublished
// ---------------------------------------------------------------------------

const publishedRow = (over: Row = {}) => ({
  item: {
    id: 'a', kind: 'feed', caption: 'merhaba', status: 'posted',
    postedAt: new Date('2026-08-12T11:00:00Z'), slotIndex: TWO,
    igMediaId: 'ig-a', permalink: 'https://instagram.com/p/ig-a',
    ...over,
  },
  metric: null,
})

describe('listPublished', () => {
  it('joins the metrics row instead of reading the table twice', async () => {
    state.items = [publishedRow()]
    await listPublished()
    expect(selects[0]).toMatchObject({
      table: 'items',
      join: 'metrics',
      where: eq(items.status, 'posted'),
      order: [desc(items.postedAt)],
      limit: HISTORY_LIMIT,
    })
    expect(joins).toEqual([eq(metrics.itemId, items.id)])
  })

  it('fetches only the images of the posts it is showing', async () => {
    // `db.select().from(images)` then `.find()` per row is O(N×M) over the
    // whole table — the defect Task 6 fixed in listQueue.
    state.items = [publishedRow({ id: 'a' }), publishedRow({ id: 'b' })]
    await listPublished()
    expect(selects[1]).toEqual({
      table: 'images',
      where: inArray(images.itemId, ['a', 'b']),
      order: [asc(images.position), asc(images.id)],
    })
  })

  it('does not touch the images table when there is nothing published', async () => {
    state.items = []
    const history = await listPublished()
    expect(selects).toHaveLength(1)
    expect(history.posts).toEqual([])
  })

  it('takes the first image of a carousel, not whichever the database returned', async () => {
    state.items = [publishedRow({ kind: 'carousel' })]
    state.images = [
      { itemId: 'a', position: 2, url: 'third' },
      { itemId: 'a', position: 0, url: 'first' },
      { itemId: 'a', position: 1, url: 'second' },
    ]
    const [post] = (await listPublished()).posts
    expect(post.thumb).toBe('first')
    expect(post.imageCount).toBe(3)
  })

  it('turns the stored slot index into a time', async () => {
    state.items = [publishedRow({ slotIndex: TEN })]
    const [post] = (await listPublished()).posts
    expect(post.slotTime).toBe('10:00')
  })

  it('carries a null slot index and a null posted_at through as null', async () => {
    state.items = [publishedRow({ slotIndex: null, postedAt: null })]
    const [post] = (await listPublished()).posts
    expect(post.slotTime).toBe(null)
    expect(post.postedAt).toBe(null)
  })

  it('normalises the empty permalink Task 8 can leave behind to null', async () => {
    // media_publish succeeded and the permalink lookup failed, so the row has
    // permalink ''. Rendering `<a href="">` would be a link to the current
    // page — a broken link is worse than no link.
    state.items = [publishedRow({ permalink: '' })]
    expect((await listPublished()).posts[0].permalink).toBe(null)
  })

  it('computes the stats only from posts that have both a metric and a slot', async () => {
    state.items = [
      { ...publishedRow({ id: 'a', slotIndex: TEN }), metric: { likes: 10, comments: 0, saved: 0, reach: 5 } },
      // measured but unslotted, and slotted but unmeasured: neither can be
      // attributed to a time of day.
      { ...publishedRow({ id: 'b', slotIndex: null }), metric: { likes: 99, comments: 0, saved: 0, reach: 5 } },
      { ...publishedRow({ id: 'c', slotIndex: EIGHT }), metric: null },
    ]
    const { stats, advice } = await listPublished()
    expect(stats).toEqual([{ slotIndex: TEN, time: '10:00', samples: 1, avgEngagement: 10 }])
    expect(advice).toEqual({ state: 'collecting', measured: 1, required: MIN_SAMPLES })
  })

  it('honours an explicit limit', async () => {
    state.items = []
    await listPublished(9)
    expect(selects[0].limit).toBe(9)
  })
})

describe('metricState', () => {
  it('is measured once a metrics row exists', () => {
    expect(metricState({ metric: { likes: 0, comments: 0, reach: 0, saved: 0 }, igMediaId: 'ig-a' }))
      .toBe('measured')
  })

  it('is pending for a post the next refresh will pick up', () => {
    expect(metricState({ metric: null, igMediaId: 'ig-a' })).toBe('pending')
  })

  it('is unmeasurable for a post with no instagram id, not pending forever', () => {
    // media_publish answered 200 with no id. `refreshInsights` filters this
    // row out with `isNotNull(items.igMediaId)`, so "ölçüm bekleniyor" beside
    // it would be a wait that never ends.
    expect(metricState({ metric: null, igMediaId: null })).toBe('unmeasurable')
  })
})
