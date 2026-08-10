import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  InstagramError,
  type InstagramClient, type PublishInput, type PublishResult,
} from '@/src/lib/instagram/types'
import { state, resetDb, type Row } from './__fixtures__/fake-db'

/**
 * `runPublish` against a database fake that evaluates `where` clauses and
 * enforces `items_slot_unique_idx` — see __fixtures__/fake-db.ts. Blob storage,
 * sharp and the network are mocked; the Instagram client defaults to the REAL
 * dry-run client, which is the only client this project has until an account
 * exists, so the happy path here is a genuine end-to-end dry run.
 */

vi.mock('@/src/db', () => import('./__fixtures__/fake-db'))

const uploadImage = vi.hoisted(() => vi.fn())
const deleteImage = vi.hoisted(() => vi.fn())
const makeThumb = vi.hoisted(() => vi.fn())
/** null → the module's own getInstagramClient(), i.e. the dry-run client. */
const clientOverride = vi.hoisted(() => ({ value: null as InstagramClient | null }))

vi.mock('@/src/lib/images/storage', () => ({ uploadImage, deleteImage }))
vi.mock('@/src/lib/images/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/images/process')>()),
  makeThumb,
}))
vi.mock('@/src/lib/instagram', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/src/lib/instagram')>()
  return { ...actual, getInstagramClient: () => clientOverride.value ?? actual.getInstagramClient() }
})

const { runPublish, MAX_ATTEMPTS } = await import('./publish')
// The settings screen's own normaliser: the slot arrays below are exactly what
// `saveSettings` would have written to the row.
const { validateSlots } = await import('@/src/lib/settings')

// 10:05 in Europe/Istanbul (UTC+3, no DST) on 2026-08-10 — five minutes into
// the first default slot, which is where a 15-minute cron tick lands.
const AT_10_05 = new Date('2026-08-10T07:05:00Z')
const TODAY = '2026-08-10'

function seedItem(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: 'a', kind: 'feed', caption: 'a caption', position: 1, status: 'pending',
    attempts: 0, error: null, postedDate: null, slotIndex: null, scheduledAt: null,
    igMediaId: null, permalink: null, postedAt: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  }
  state.items.push(row)
  return row
}

function seedImage(over: Partial<Row> = {}): Row {
  const row: Row = {
    id: `img-${state.images.length + 1}`, itemId: 'a', hash: `hash${state.images.length + 1}`,
    url: `https://blob.example/queue/hash${state.images.length + 1}.jpg`,
    pathname: `queue/hash${state.images.length + 1}.jpg`, position: 0,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    ...over,
  }
  state.images.push(row)
  return row
}

const okPublish = () =>
  vi.fn<(input: PublishInput) => Promise<PublishResult>>(
    async () => ({ igMediaId: 'ig-1', permalink: 'https://p/1' }),
  )

/** A client that records its calls; `publish` defaults to a successful post. */
function spyClient(publish = okPublish()) {
  const client: InstagramClient = {
    isDryRun: true, publish, insights: vi.fn(), permalink: vi.fn(async () => ''),
  }
  clientOverride.value = client
  return publish
}

const itemRow = (id = 'a') => state.items.find((r) => r.id === id)!
const savedIgEnv = { token: process.env.IG_ACCESS_TOKEN, user: process.env.IG_USER_ID }

let fetchSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  resetDb()
  clientOverride.value = null
  // Guarantees getInstagramClient() returns the dry-run client: a live token in
  // the environment would make these tests post to a real account.
  delete process.env.IG_ACCESS_TOKEN
  delete process.env.IG_USER_ID
  // These tests are exactly the case the opt-in exists for: exercising the
  // publish path against the dry-run client, deliberately.
  process.env.ALLOW_DRYRUN_PUBLISH = '1'
  uploadImage.mockReset().mockResolvedValue({ url: 'https://blob.example/thumb/t.jpg', pathname: 'thumb/t.jpg' })
  deleteImage.mockReset().mockResolvedValue(undefined)
  makeThumb.mockReset().mockResolvedValue(Buffer.from('thumb-bytes'))
  // Fail closed on the network; the thumbnail fetch is opted into per test.
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (savedIgEnv.token === undefined) delete process.env.IG_ACCESS_TOKEN
  else process.env.IG_ACCESS_TOKEN = savedIgEnv.token
  if (savedIgEnv.user === undefined) delete process.env.IG_USER_ID
  else process.env.IG_USER_ID = savedIgEnv.user
  delete process.env.ALLOW_DRYRUN_PUBLISH
})

// A fresh Response per call: a body can only be read once, so a shared
// instance would make the second image of a carousel fail for the wrong reason.
const okFetch = () => fetchSpy.mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])))

describe('runPublish — the happy path on a fresh database', () => {
  it('posts the head of the queue into the due slot with no settings row at all', async () => {
    // The settings row has never been written: `settings` is EMPTY here.
    seedItem()
    seedImage()
    okFetch()

    const report = await runPublish(AT_10_05)

    expect(report.dryRun).toBe(true)
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'posted', itemId: 'a' }])
    expect(itemRow()).toMatchObject({
      status: 'posted',
      postedDate: TODAY,
      slotIndex: 600,
      postedAt: AT_10_05,
      error: null,
      attempts: 0,
    })
    expect(String(itemRow().igMediaId)).toMatch(/^dryrun-\d+$/)
    expect(String(itemRow().permalink)).toContain('dryrun=1')
  })

  it('appends the configured hashtags to the caption it publishes', async () => {
    state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '#one #two' })
    seedItem({ caption: 'a caption' })
    seedImage()
    okFetch()
    const publish = spyClient()

    await runPublish(AT_10_05)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(publish.mock.calls[0][0].caption).toBe('a caption\n\n#one #two')
  })

  it('honours the settings row rather than the defaults', async () => {
    // 09:05 in Europe/London (BST) — a time that is NOT a default slot, in a
    // timezone that is not the default either.
    state.settings.push({ id: 1, slots: ['09:00'], timezone: 'Europe/London', hashtags: '' })
    seedItem()
    seedImage()
    okFetch()

    const report = await runPublish(new Date('2026-08-10T08:05:00Z'))

    expect(report.slots).toEqual([{ date: TODAY, index: 540, outcome: 'posted', itemId: 'a' }])
  })

  it('swaps the full-size blob for a thumbnail and deletes the original', async () => {
    seedItem()
    // Captured now: the row object is the store's own, and the publisher is
    // about to rewrite its url.
    const originalUrl = String(seedImage().url)
    okFetch()

    await runPublish(AT_10_05)

    expect(makeThumb).toHaveBeenCalledTimes(1)
    expect(uploadImage).toHaveBeenCalledWith(Buffer.from('thumb-bytes'), 'thumb/hash1.jpg')
    expect(state.images[0]).toMatchObject({ url: 'https://blob.example/thumb/t.jpg', pathname: 'thumb/t.jpg' })
    expect(deleteImage).toHaveBeenCalledWith(originalUrl)
  })

  it('fills each due slot with a different item, oldest slot first', async () => {
    state.settings.push({ id: 1, slots: ['10:00', '10:30'], timezone: 'Europe/Istanbul', hashtags: '' })
    seedItem({ id: 'a', position: 1 })
    seedItem({ id: 'b', position: 2 })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    okFetch()

    // 10:35 Istanbul: both slots are inside dueSlots' 90-minute grace window.
    const report = await runPublish(new Date('2026-08-10T07:35:00Z'))

    expect(report.slots).toEqual([
      { date: TODAY, index: 600, outcome: 'posted', itemId: 'a' },
      { date: TODAY, index: 630, outcome: 'posted', itemId: 'b' },
    ])
    expect(itemRow('a')).toMatchObject({ slotIndex: 600 })
    expect(itemRow('b')).toMatchObject({ slotIndex: 630 })
  })
})

describe('runPublish — idempotence', () => {
  it('does not post again when the slot is already filled', async () => {
    seedItem()
    seedImage()
    okFetch()
    await runPublish(AT_10_05)

    const publish = spyClient()
    const second = await runPublish(new Date('2026-08-10T07:20:00Z'))

    expect(publish).not.toHaveBeenCalled()
    expect(second.slots).toEqual([{ date: TODAY, index: 600, outcome: 'already-filled' }])
  })

  it('does not backfill a slot that went by more than the grace window ago', async () => {
    seedItem()
    seedImage()
    const publish = spyClient()

    // 12:00 Istanbul: two hours after 10:00 and two before 14:00.
    const report = await runPublish(new Date('2026-08-10T09:00:00Z'))

    expect(report.slots).toEqual([])
    expect(publish).not.toHaveBeenCalled()
    expect(itemRow()).toMatchObject({ status: 'pending', postedDate: null })
  })

  it('treats a claim that matches no rows as a lost race, not as permission to post', async () => {
    // THE defect the plan shipped: `UPDATE ... WHERE posted_date IS NULL` that
    // matches zero rows throws nothing. Here another cron run commits its claim
    // in exactly that window.
    seedItem()
    seedImage()
    const publish = spyClient()
    state.beforeUpdate = (values) => {
      if (values.postedDate) {
        state.beforeUpdate = null
        itemRow().postedDate = TODAY
        itemRow().slotIndex = 0
      }
    }

    const report = await runPublish(AT_10_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'race-lost', itemId: 'a' }])
    expect(itemRow()).toMatchObject({ status: 'pending', attempts: 0, error: null })
  })

  it('treats the unique-index violation on the slot as a lost race', async () => {
    seedItem()
    seedImage()
    const publish = spyClient()
    // A second item took (date, index) between the "already filled?" read and
    // this claim, so the index — not our own read — is what stops us.
    state.beforeUpdate = (values) => {
      if (values.postedDate) {
        state.beforeUpdate = null
        state.items.push({ id: 'z', status: 'posted', postedDate: TODAY, slotIndex: 600, position: 9 })
      }
    }

    const report = await runPublish(AT_10_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'race-lost', itemId: 'a' }])
    expect(itemRow()).toMatchObject({ status: 'pending', attempts: 0, postedDate: null })
  })
})

describe('runPublish — the owner edits the slot times after a post has gone out', () => {
  /**
   * The hazard Task 10 exists to close.
   *
   * A slot is identified in the database by (posted_date, slot_index), and the
   * plan identified it by its POSITION in the settings array. Adding an earlier
   * time renumbers every slot after it, so the slot that has already published
   * today answers to a different number than the one it was claimed under — and
   * the "is this slot filled?" read finds nothing.
   *
   * `validateSlots` is used to build the new array rather than a literal,
   * because that is exactly what `saveSettings` writes to the row.
   */
  function seedDay() {
    state.settings.push({
      id: 1, slots: ['10:00', '14:00', '20:00'], timezone: 'Europe/Istanbul', hashtags: '',
    })
    seedItem({ id: 'a', position: 1 })
    seedItem({ id: 'b', position: 2 })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    okFetch()
  }

  it('does not post again when an EARLIER slot is added minutes after the 10:00 post', async () => {
    seedDay()
    const first = await runPublish(AT_10_05)
    expect(first.slots.map((s) => s.outcome)).toEqual(['posted'])
    expect(itemRow('a').status).toBe('posted')

    // 10:05: the owner adds a 09:00 slot. Under the plan's numbering, index 0
    // is now 09:00 and index 1 is 10:00 — and nothing holds (today, 1).
    state.settings[0].slots = validateSlots(['09:00', '10:00', '14:00', '20:00'])

    const publish = spyClient()
    const second = await runPublish(new Date('2026-08-10T07:06:00Z')) // 10:06 Istanbul

    expect(publish).not.toHaveBeenCalled()
    expect(itemRow('b')).toMatchObject({ status: 'pending', postedDate: null, attempts: 0 })
    expect(state.items.filter((r) => r.status === 'posted')).toHaveLength(1)
    // 10:00 is still recognised as the slot that published; 09:00 is refused
    // because the day has already had every post the schedule allows by 09:00.
    expect(second.slots).toEqual([
      { date: TODAY, index: 540, outcome: 'over-quota' },
      { date: TODAY, index: 600, outcome: 'already-filled' },
    ])
  })

  it('gives the day the NEW number of posts when the slot that published is removed', async () => {
    seedDay()
    await runPublish(AT_10_05)

    // Removing 10:00 renumbers 14:00 to index 0 — the number today's post
    // holds — so under the plan's numbering the 14:00 slot reads as filled and
    // stays empty for good.
    state.settings[0].slots = validateSlots(['14:00', '20:00'])

    // The day is now scheduled for two posts and has already had one, so the
    // next one is 20:00, not 14:00. This is the direction the guard errs in:
    // one post later than the owner might expect on the day they edit the
    // schedule, never one post more.
    const atTwo = await runPublish(new Date('2026-08-10T11:05:00Z'))
    expect(atTwo.slots).toEqual([{ date: TODAY, index: 840, outcome: 'over-quota' }])

    const atEight = await runPublish(new Date('2026-08-10T17:05:00Z'))
    expect(atEight.slots).toEqual([{ date: TODAY, index: 1200, outcome: 'posted', itemId: 'b' }])
    expect(state.items.filter((r) => r.status === 'posted')).toHaveLength(2)
  })

  it('still publishes into a later slot the same day after the times change', async () => {
    seedDay()
    await runPublish(AT_10_05)
    state.settings[0].slots = validateSlots(['09:00', '10:00', '14:00', '20:00'])

    // 14:05 Istanbul: a slot that has NOT been used, and the day is allowed a
    // second post by then. The guard must not turn into "one post per day".
    const report = await runPublish(new Date('2026-08-10T11:05:00Z'))

    expect(report.slots).toEqual([{ date: TODAY, index: 840, outcome: 'posted', itemId: 'b' }])
    expect(itemRow('b')).toMatchObject({ status: 'posted', slotIndex: 840 })
  })

  it('does not post again when the slot that published is MOVED later the same day', async () => {
    seedDay()
    await runPublish(AT_10_05)

    // "10:00 was too early" — moved to 10:30, five minutes after it published.
    state.settings[0].slots = validateSlots(['10:30', '14:00', '20:00'])

    const publish = spyClient()
    const report = await runPublish(new Date('2026-08-10T07:35:00Z')) // 10:35

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([{ date: TODAY, index: 630, outcome: 'over-quota' }])
    expect(state.items.filter((r) => r.status === 'posted')).toHaveLength(1)
  })
})

describe('runPublish — a post that has already happened is never undone', () => {
  it('records the post before doing any thumbnail work', async () => {
    seedItem()
    seedImage()
    okFetch()

    await runPublish(AT_10_05)

    const postedAt = state.trace.findIndex((t) => t.table === 'items' && t.values?.status === 'posted')
    const thumbAt = state.trace.findIndex((t) => t.table === 'images')
    expect(postedAt).toBeGreaterThanOrEqual(0)
    expect(thumbAt).toBeGreaterThan(postedAt)
  })

  it('keeps the item posted when the thumbnail fetch throws afterwards', async () => {
    // The plan ran this inside the publish try/catch, so a failed fetch cleared
    // the slot claim and left the item pending — the next tick posted the same
    // picture again.
    seedItem()
    seedImage()
    fetchSpy.mockRejectedValue(new Error('blob store unreachable'))

    const report = await runPublish(AT_10_05)

    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'posted', itemId: 'a' }])
    expect(itemRow()).toMatchObject({
      status: 'posted', postedDate: TODAY, slotIndex: 600, attempts: 0, error: null,
    })
    expect(deleteImage).not.toHaveBeenCalled()
  })

  it('keeps the item posted when the thumbnail upload throws afterwards', async () => {
    seedItem()
    seedImage()
    okFetch()
    uploadImage.mockRejectedValue(new Error('blob quota exceeded'))

    await runPublish(AT_10_05)

    expect(itemRow()).toMatchObject({ status: 'posted', attempts: 0, error: null })
    expect(state.images[0].url).toBe('https://blob.example/queue/hash1.jpg')
    expect(deleteImage).not.toHaveBeenCalled()
  })

  it('keeps the surviving images when one image of a carousel fails to thumbnail', async () => {
    seedItem({ kind: 'carousel' })
    seedImage({ id: 'img-1', position: 0 })
    seedImage({ id: 'img-2', position: 1 })
    okFetch()
    makeThumb.mockRejectedValueOnce(new Error('decode failed'))

    await runPublish(AT_10_05)

    expect(itemRow()).toMatchObject({ status: 'posted' })
    expect(state.images[0].url).toBe('https://blob.example/queue/hash1.jpg')
    expect(state.images[1].url).toBe('https://blob.example/thumb/t.jpg')
  })

  it('leaves the slot claim in place when the "posted" write itself fails', async () => {
    // Instagram has the post. The row cannot say so, but the claim it already
    // holds is what keeps the next tick from selecting it again.
    seedItem()
    seedImage()
    okFetch()
    const publish = spyClient()
    state.failUpdate = (t) => (t.values?.status === 'posted' ? new Error('connection reset') : null)

    const report = await runPublish(AT_10_05)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'posted-unrecorded', itemId: 'a' }])
    expect(itemRow()).toMatchObject({ postedDate: TODAY, slotIndex: 600, attempts: 0 })

    // The next tick must not republish it: the claim excludes it from the
    // pending query and fills the slot.
    state.failUpdate = null
    const publish2 = spyClient()
    const second = await runPublish(new Date('2026-08-10T07:20:00Z'))
    expect(publish2).not.toHaveBeenCalled()
    expect(second.slots).toEqual([{ date: TODAY, index: 600, outcome: 'already-filled' }])
  })
})

describe('runPublish — failures', () => {
  it('releases the slot, counts the attempt and stores the reason', async () => {
    seedItem()
    seedImage()
    spyClient(okPublish().mockRejectedValue(new InstagramError('media container failed')))

    const report = await runPublish(AT_10_05)

    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'error', itemId: 'a' }])
    expect(itemRow()).toMatchObject({
      status: 'pending', attempts: 1, postedDate: null, slotIndex: null,
      error: 'media container failed',
    })
  })

  it('marks the item failed on the last attempt so it stops blocking the queue', async () => {
    seedItem({ attempts: MAX_ATTEMPTS - 1 })
    seedImage()
    spyClient(okPublish().mockRejectedValue(new InstagramError('still broken')))

    await runPublish(AT_10_05)

    expect(itemRow()).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
  })

  it('never stores a driver message in the column the queue page displays', async () => {
    seedItem()
    seedImage()
    spyClient(okPublish().mockRejectedValue(new Error('getaddrinfo ENOTFOUND ep-x.eu-central-1.aws.neon.tech')))

    await runPublish(AT_10_05)

    expect(String(itemRow().error)).not.toContain('neon.tech')
    expect(itemRow().attempts).toBe(1)
  })

  it('reports a claim that failed for a reason other than a race, and leaves the item alone', async () => {
    seedItem()
    seedImage()
    const publish = spyClient()
    state.failUpdate = (t) => (t.values?.postedDate ? new Error('connection reset') : null)

    const report = await runPublish(AT_10_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'claim-failed', itemId: 'a' }])
    expect(itemRow()).toMatchObject({ status: 'pending', attempts: 0, postedDate: null })
  })

  it('a released item is picked up again by the next tick', async () => {
    seedItem()
    seedImage()
    spyClient(okPublish().mockRejectedValue(new InstagramError('transient')))
    await runPublish(AT_10_05)

    okFetch()
    clientOverride.value = null
    const second = await runPublish(new Date('2026-08-10T07:20:00Z'))

    expect(second.slots).toEqual([{ date: TODAY, index: 600, outcome: 'posted', itemId: 'a' }])
    expect(itemRow()).toMatchObject({ status: 'posted', attempts: 1, error: null })
  })
})

describe('runPublish — skips that cost no attempt', () => {
  it('reports an empty queue', async () => {
    const report = await runPublish(AT_10_05)
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'empty-queue' }])
  })

  it('reports a caption-less head item without claiming or counting it', async () => {
    seedItem({ caption: '  ' })
    seedImage()
    const publish = spyClient()

    const report = await runPublish(AT_10_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'missing-caption', itemId: 'a' }])
    expect(itemRow()).toMatchObject({ attempts: 0, postedDate: null, status: 'pending' })
  })

  it('reports a caption the hashtags push over the limit without burning an attempt', async () => {
    state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '#tag' })
    seedItem({ caption: 'x'.repeat(2198) })
    seedImage()
    const publish = spyClient()

    const report = await runPublish(AT_10_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'caption-too-long', itemId: 'a' }])
    expect(itemRow()).toMatchObject({ attempts: 0, status: 'pending' })
  })

  it('skips a payload Instagram would reject instead of retrying it three times', async () => {
    // A carousel holding one image can never publish; three ticks would burn
    // all three attempts and mark it failed for a reason no retry addresses.
    seedItem({ kind: 'carousel' })
    seedImage()
    const publish = spyClient()

    const report = await runPublish(AT_10_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'invalid-payload', itemId: 'a' }])
    expect(itemRow()).toMatchObject({ attempts: 0, status: 'pending', postedDate: null })
  })

  it('leaves the slot empty rather than reaching past a blocked head item', async () => {
    seedItem({ id: 'a', position: 1, caption: '' })
    seedItem({ id: 'b', position: 2, caption: 'ready to go' })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    const publish = spyClient()

    const report = await runPublish(AT_10_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'missing-caption', itemId: 'a' }])
  })
})

describe('runPublish — two cron runs racing', () => {
  it('publishes exactly once when two runs start together on one item', async () => {
    seedItem()
    seedImage()
    okFetch()
    const publish = spyClient()

    const [first, second] = await Promise.all([runPublish(AT_10_05), runPublish(AT_10_05)])

    expect(publish).toHaveBeenCalledTimes(1)
    const outcomes = [first.slots[0].outcome, second.slots[0].outcome].sort()
    expect(outcomes).toEqual(['posted', 'race-lost'])
    expect(state.items.filter((r) => r.postedDate !== null)).toHaveLength(1)
    expect(itemRow()).toMatchObject({ status: 'posted', slotIndex: 600, attempts: 0 })
  })

  it('fills the slot once when two runs start together on a two-item queue', async () => {
    seedItem({ id: 'a', position: 1 })
    seedItem({ id: 'b', position: 2 })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    okFetch()
    const publish = spyClient()

    const [first, second] = await Promise.all([runPublish(AT_10_05), runPublish(AT_10_05)])

    expect(publish).toHaveBeenCalledTimes(1)
    expect([first.slots[0].outcome, second.slots[0].outcome].sort()).toEqual(['posted', 'race-lost'])
    // The loser must not have posted `b` into a slot that already holds `a`.
    expect(state.items.filter((r) => r.status === 'posted')).toHaveLength(1)
    expect(itemRow('b')).toMatchObject({ status: 'pending', postedDate: null, attempts: 0 })
  })

  it('publishes exactly once across four simultaneous runs', async () => {
    seedItem()
    seedImage()
    okFetch()
    const publish = spyClient()

    const reports = await Promise.all([
      runPublish(AT_10_05), runPublish(AT_10_05), runPublish(AT_10_05), runPublish(AT_10_05),
    ])

    expect(publish).toHaveBeenCalledTimes(1)
    expect(reports.filter((r) => r.slots[0].outcome === 'posted')).toHaveLength(1)
    expect(state.items.filter((r) => r.postedDate !== null)).toHaveLength(1)
  })
})

describe('runPublish: retries belong to later ticks', () => {
  // Several slots can be due at once — closely spaced slot times, a late cron
  // tick, or the spring-forward gap. The loop re-reads the pending queue each
  // time, so without a guard the same head item burns its whole retry budget in
  // one second on a single brief outage at Meta.
  it('does not retry the same item across several slots due in one run', async () => {
    state.settings.push({
      id: 1, slots: ['10:00', '10:20', '10:40'], timezone: 'Europe/Istanbul', hashtags: '',
    })
    seedItem()
    seedImage()
    const publish = spyClient(
      vi.fn<(input: PublishInput) => Promise<PublishResult>>(async () => {
        throw new InstagramError('transient', 500)
      }),
    )

    const report = await runPublish(new Date('2026-08-10T07:45:00Z'))

    expect(publish).toHaveBeenCalledTimes(1)
    expect(report.slots.map((s) => s.outcome)).toEqual(['error', 'deferred', 'deferred'])
    // One attempt spent, not three: the item survives to the next tick.
    expect(itemRow().attempts).toBe(1)
    expect(itemRow().status).toBe('pending')
  })

  it('still fills a later due slot from the queue when the head succeeds', async () => {
    state.settings.push({
      id: 1, slots: ['10:00', '10:20'], timezone: 'Europe/Istanbul', hashtags: '',
    })
    seedItem({ id: 'a', position: 1 })
    seedItem({ id: 'b', position: 2 })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    const publish = spyClient()

    const report = await runPublish(new Date('2026-08-10T07:25:00Z'))

    expect(publish).toHaveBeenCalledTimes(2)
    expect(report.slots.map((s) => s.outcome)).toEqual(['posted', 'posted'])
  })
})

describe('runPublish: ordering and boundaries', () => {
  it('sends carousel images in stored position order, not query order', async () => {
    state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '' })
    seedItem({ kind: 'carousel' })
    // Pushed out of order, as a real query may return them.
    seedImage({ id: 'img-c', itemId: 'a', position: 2, url: 'https://blob.example/queue/c.jpg' })
    seedImage({ id: 'img-a', itemId: 'a', position: 0, url: 'https://blob.example/queue/a.jpg' })
    seedImage({ id: 'img-b', itemId: 'a', position: 1, url: 'https://blob.example/queue/b.jpg' })
    const publish = spyClient()

    await runPublish(AT_10_05)

    expect(publish.mock.calls[0][0].imageUrls).toEqual([
      'https://blob.example/queue/a.jpg',
      'https://blob.example/queue/b.jpg',
      'https://blob.example/queue/c.jpg',
    ])
  })

  // Task 7 established that positions are not globally unique after a reorder,
  // so the tiebreak is what makes the head of the queue the same item on every
  // tick rather than whichever row the database felt like returning first.
  it('breaks a position tie deterministically by createdAt then id', async () => {
    state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '' })
    seedItem({ id: 'z', position: 1, createdAt: new Date('2026-08-02T00:00:00Z') })
    seedItem({ id: 'y', position: 1, createdAt: new Date('2026-08-01T00:00:00Z') })
    seedImage({ itemId: 'z' })
    seedImage({ itemId: 'y' })
    const publish = spyClient()

    const report = await runPublish(AT_10_05)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(report.slots[0]).toMatchObject({ outcome: 'posted', itemId: 'y' })
  })

  it('publishes a caption that lands exactly on the 2200 character limit', async () => {
    const hashtags = '#one'
    // withHashtags joins with a blank line, so the caption may use the rest.
    const caption = 'x'.repeat(2200 - hashtags.length - 2)
    state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags })
    seedItem({ caption })
    seedImage()
    const publish = spyClient()

    const report = await runPublish(AT_10_05)

    expect(report.slots[0].outcome).toBe('posted')
    expect(publish.mock.calls[0][0].caption).toHaveLength(2200)
  })

  it('skips a caption one character over the limit without spending an attempt', async () => {
    const hashtags = '#one'
    const caption = 'x'.repeat(2200 - hashtags.length - 2 + 1)
    state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags })
    seedItem({ caption })
    seedImage()
    const publish = spyClient()

    const report = await runPublish(AT_10_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots[0].outcome).toBe('caption-too-long')
    expect(itemRow().attempts).toBe(0)
  })
})

describe('runPublish: thumbnail refresh never undoes a published post', () => {
  // Without the status check, a 404 body would be handed to makeThumb and the
  // image row would be rewritten to point at a thumbnail of an error page.
  it('leaves the stored url alone when the blob fetch answers a non-2xx', async () => {
    state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '' })
    seedItem()
    const original = String(seedImage().url)
    spyClient()
    fetchSpy.mockResolvedValue(new Response('not found', { status: 404 }))

    const report = await runPublish(AT_10_05)

    expect(report.slots[0].outcome).toBe('posted')
    expect(itemRow().status).toBe('posted')
    expect(makeThumb).not.toHaveBeenCalled()
    expect(uploadImage).not.toHaveBeenCalled()
    expect(deleteImage).not.toHaveBeenCalled()
    expect(state.images[0].url).toBe(original)
  })
})

/**
 * A dry run is not a rehearsal. It marks the item posted, swaps the full-size
 * blob for a thumbnail and deletes the original — and deleteItem then refuses
 * to remove a posted row, so the picture can be neither re-queued (the hash
 * answers "zaten var") nor deleted. Left on by default it would quietly eat
 * three real photos a day for however long it takes to get a Meta app approved,
 * which is exactly the window the README's own ordering creates.
 */
describe('runPublish — dry-run publishing is opt-in', () => {
  it('does nothing at all when the opt-in is absent', async () => {
    delete process.env.ALLOW_DRYRUN_PUBLISH
    state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '' })
    seedItem()
    const original = String(seedImage().url)

    const report = await runPublish(AT_10_05)

    expect(report).toEqual({ slots: [], dryRun: true, disabled: true })
    // The queue is untouched: still pending, still holding its full-size image.
    expect(itemRow().status).toBe('pending')
    expect(itemRow().postedDate).toBeNull()
    expect(state.images[0].url).toBe(original)
    expect(deleteImage).not.toHaveBeenCalled()
  })

  it.each([['0'], ['true'], ['yes'], ['']])(
    'treats %j as not opted in',
    async (value) => {
      process.env.ALLOW_DRYRUN_PUBLISH = value
      state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '' })
      seedItem()
      seedImage()

      expect(await runPublish(AT_10_05)).toEqual({ slots: [], dryRun: true, disabled: true })
      expect(itemRow().status).toBe('pending')
    },
  )

  it('publishes normally once the owner opts in', async () => {
    process.env.ALLOW_DRYRUN_PUBLISH = '1'
    state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '' })
    seedItem()
    seedImage()

    const report = await runPublish(AT_10_05)

    expect(report.disabled).toBeUndefined()
    expect(report.slots[0]).toMatchObject({ outcome: 'posted' })
    expect(itemRow().status).toBe('posted')
  })

  it('never blocks a real client, whatever the opt-in says', async () => {
    delete process.env.ALLOW_DRYRUN_PUBLISH
    state.settings.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '' })
    seedItem()
    seedImage()
    // isDryRun: false — a configured account must publish regardless.
    clientOverride.value = {
      isDryRun: false,
      publish: okPublish(),
      insights: vi.fn(),
      permalink: vi.fn(async () => ''),
    }

    const report = await runPublish(AT_10_05)

    expect(report.dryRun).toBe(false)
    expect(report.disabled).toBeUndefined()
    expect(report.slots[0]).toMatchObject({ outcome: 'posted' })
  })
})

// ---------------------------------------------------------------------------
// Task 14: an item may carry its own time. It publishes AT that time, claiming
// the minute exactly as a slot claims one, and it is never spent on a slot.
// ---------------------------------------------------------------------------

/** 09:00 Istanbul on the test day — before every configured slot. */
const NINE = new Date('2026-08-10T06:00:00Z')
/** Five minutes later: the cron tick that finds it due. */
const AT_09_05 = new Date('2026-08-10T06:05:00Z')
const NINE_INDEX = 540

describe('runPublish — an item that carries its own time', () => {
  it('publishes it at its own minute, claiming that minute the way a slot does', async () => {
    seedItem({ scheduledAt: NINE })
    seedImage()
    okFetch()
    const publish = spyClient()

    const report = await runPublish(AT_09_05)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(report.slots).toEqual([
      { date: TODAY, index: NINE_INDEX, outcome: 'posted', itemId: 'a', scheduled: true },
    ])
    // The claim is in the SAME space a slot claims, which is what makes
    // items_slot_unique_idx cover both kinds of post.
    expect(itemRow()).toMatchObject({
      status: 'posted', postedDate: TODAY, slotIndex: NINE_INDEX, postedAt: AT_09_05, attempts: 0,
    })
  })

  it('does not publish before the minute arrives', async () => {
    seedItem({ scheduledAt: NINE })
    seedImage()
    const publish = spyClient()

    // 08:59 Istanbul, one minute early — and no slot is due either.
    const report = await runPublish(new Date('2026-08-10T05:59:00Z'))

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([])
    expect(itemRow()).toMatchObject({ status: 'pending', postedDate: null })
  })

  it('does not publish once the grace window has passed, and does not roll it forward', async () => {
    seedItem({ scheduledAt: NINE })
    seedImage()
    const publish = spyClient()

    // 10:31 Istanbul: 91 minutes after 09:00, so the chosen time is missed —
    // and the 10:00 slot that IS due must not quietly post it instead.
    const report = await runPublish(new Date('2026-08-10T07:31:00Z'))

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'empty-queue' }])
    expect(itemRow()).toMatchObject({ status: 'pending', postedDate: null, attempts: 0 })
    // The chosen time is left on the row: the queue page is what tells the
    // owner it went by, and clearing it here would hide that.
    expect(itemRow().scheduledAt).toBe(NINE)
  })

  it('publishes every due scheduled item in one run — there is no daily cap', async () => {
    // Deliberately seeded so queue order, id order and TIME order all disagree:
    // the run must go by the clock, which is the only order the owner sees.
    seedItem({ id: 'c', position: 1, scheduledAt: new Date('2026-08-10T06:20:00Z') })
    seedItem({ id: 'a', position: 2, scheduledAt: new Date('2026-08-10T06:10:00Z') })
    seedItem({ id: 'b', position: 3, scheduledAt: NINE })
    seedImage({ itemId: 'c' })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    okFetch()

    // 09:25 Istanbul: all three are due, none is past its grace window.
    const report = await runPublish(new Date('2026-08-10T06:25:00Z'))

    // Oldest first, and every one of them goes out.
    expect(report.slots.map((s) => [s.itemId, s.index, s.outcome])).toEqual([
      ['b', 540, 'posted'], ['a', 550, 'posted'], ['c', 560, 'posted'],
    ])
    expect(state.items.filter((r) => r.status === 'posted')).toHaveLength(3)
  })

  it('attempts the second due item even when the first one fails', async () => {
    // Two scheduled items are two different posts at two different times, not
    // one queue head being retried — so a failure on one must not cost the
    // other its time.
    seedItem({ id: 'a', position: 1, scheduledAt: NINE })
    seedItem({ id: 'b', position: 2, scheduledAt: new Date('2026-08-10T06:10:00Z') })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    okFetch()
    const publish = spyClient(
      vi.fn<(input: PublishInput) => Promise<PublishResult>>(async (input) => {
        if (input.imageUrls[0].includes('hash1')) throw new InstagramError('media container failed')
        return { igMediaId: 'ig-b', permalink: 'https://p/b' }
      }),
    )

    const report = await runPublish(new Date('2026-08-10T06:15:00Z'))

    expect(publish).toHaveBeenCalledTimes(2)
    expect(report.slots.map((s) => [s.itemId, s.outcome])).toEqual([['a', 'error'], ['b', 'posted']])
    expect(itemRow('a')).toMatchObject({ status: 'pending', attempts: 1, postedDate: null })
    expect(itemRow('b')).toMatchObject({ status: 'posted' })
  })

  it('never spends an automatic slot on an item that carries its own time', async () => {
    // 'a' is at the head of the queue and scheduled for tomorrow. The 10:00
    // slot must reach past it — its time is already chosen.
    seedItem({ id: 'a', position: 1, scheduledAt: new Date('2026-08-11T06:00:00Z') })
    seedItem({ id: 'b', position: 2 })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    okFetch()

    const report = await runPublish(AT_10_05)

    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'posted', itemId: 'b' }])
    expect(itemRow('a')).toMatchObject({ status: 'pending', postedDate: null })
  })

  it('does not let a scheduled post eat the day\'s slot allowance', async () => {
    // The owner scheduled a post for 09:00 and it went out. The 10:00 slot is
    // still owed a post: allowanceBy caps what the SLOTS may publish, and
    // counting an explicitly scheduled post against it would turn "five posts
    // tomorrow if I say so" into "the slots stop for the rest of the day".
    seedItem({
      id: 'done', position: 1, status: 'posted',
      scheduledAt: NINE, postedDate: TODAY, slotIndex: NINE_INDEX,
    })
    seedItem({ id: 'b', position: 2 })
    seedImage({ itemId: 'b' })
    okFetch()

    const report = await runPublish(AT_10_05)

    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'posted', itemId: 'b' }])
  })

  it('still refuses a slot the day has already had its posts by, counting slot posts only', async () => {
    // The other half of the same rule, unchanged: a post that went out THROUGH
    // a slot still counts, so editing the times cannot buy the day an extra one.
    seedItem({
      id: 'done', position: 1, status: 'posted', postedDate: TODAY, slotIndex: 540,
    })
    seedItem({ id: 'b', position: 2 })
    seedImage({ itemId: 'b' })
    const publish = spyClient()

    const report = await runPublish(AT_10_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'over-quota' }])
  })

  it('reports the 10:00 slot as filled when a scheduled post already took 10:00', async () => {
    // Same minute, one claim: the scheduled post IS the 10:00 post.
    seedItem({ id: 'a', position: 1, scheduledAt: new Date('2026-08-10T07:00:00Z') })
    seedItem({ id: 'b', position: 2 })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    okFetch()

    const report = await runPublish(AT_10_05)

    expect(report.slots).toEqual([
      { date: TODAY, index: 600, outcome: 'posted', itemId: 'a', scheduled: true },
      { date: TODAY, index: 600, outcome: 'already-filled' },
    ])
    expect(itemRow('b')).toMatchObject({ status: 'pending', postedDate: null })
  })

  it('leaves a scheduled item with no caption alone, at no cost to its attempts', async () => {
    seedItem({ caption: '   ', scheduledAt: NINE })
    seedImage()
    const publish = spyClient()

    const report = await runPublish(AT_09_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([
      { date: TODAY, index: NINE_INDEX, outcome: 'missing-caption', itemId: 'a', scheduled: true },
    ])
    expect(itemRow()).toMatchObject({ attempts: 0, postedDate: null, status: 'pending' })
  })

  it('publishes a scheduled story that has no caption', async () => {
    seedItem({ kind: 'story', caption: '', scheduledAt: NINE })
    seedImage()
    okFetch()

    const report = await runPublish(AT_09_05)

    expect(report.slots[0]).toMatchObject({ outcome: 'posted', itemId: 'a', scheduled: true })
  })

  it('releases the claim and counts the attempt when the publish fails', async () => {
    seedItem({ scheduledAt: NINE })
    seedImage()
    spyClient(okPublish().mockRejectedValue(new InstagramError('media container failed')))

    const report = await runPublish(AT_09_05)

    expect(report.slots).toEqual([
      { date: TODAY, index: NINE_INDEX, outcome: 'error', itemId: 'a', scheduled: true },
    ])
    expect(itemRow()).toMatchObject({
      status: 'pending', attempts: 1, postedDate: null, slotIndex: null,
      error: 'media container failed',
    })
    // Its time survives, so the next tick inside the grace window retries it.
    expect(itemRow().scheduledAt).toBe(NINE)
  })

  it('is retried by the next tick while the window is still open', async () => {
    seedItem({ scheduledAt: NINE })
    seedImage()
    spyClient(okPublish().mockRejectedValue(new InstagramError('transient')))
    await runPublish(AT_09_05)

    okFetch()
    clientOverride.value = null
    const second = await runPublish(new Date('2026-08-10T06:20:00Z'))

    expect(second.slots).toEqual([
      { date: TODAY, index: NINE_INDEX, outcome: 'posted', itemId: 'a', scheduled: true },
    ])
    expect(itemRow()).toMatchObject({ status: 'posted', attempts: 1, error: null })
  })

  it('never rolls a scheduled post back once Instagram has it', async () => {
    seedItem({ scheduledAt: NINE })
    seedImage()
    okFetch()
    const publish = spyClient()
    state.failUpdate = (t) => (t.values?.status === 'posted' ? new Error('connection reset') : null)

    const report = await runPublish(AT_09_05)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(report.slots).toEqual([
      { date: TODAY, index: NINE_INDEX, outcome: 'posted-unrecorded', itemId: 'a', scheduled: true },
    ])
    expect(itemRow()).toMatchObject({ postedDate: TODAY, slotIndex: NINE_INDEX, attempts: 0 })

    // And the next tick, still inside the window, must not publish it again:
    // the claim it holds excludes it from the due query.
    state.failUpdate = null
    const publish2 = spyClient()
    const second = await runPublish(new Date('2026-08-10T06:20:00Z'))
    expect(publish2).not.toHaveBeenCalled()
    expect(second.slots).toEqual([])
  })

  it('does nothing at all for a scheduled item when the dry-run opt-in is absent', async () => {
    delete process.env.ALLOW_DRYRUN_PUBLISH
    seedItem({ scheduledAt: NINE })
    seedImage()

    expect(await runPublish(AT_09_05)).toEqual({ slots: [], dryRun: true, disabled: true })
    expect(itemRow()).toMatchObject({ status: 'pending', postedDate: null })
  })

  // `scheduled_at` is a plain nullable timestamp column read straight out of
  // the driver. A value that is not a usable instant must cost ONE item, not
  // the whole tick: an unguarded one reaches `at.getTime()` (TypeError) or
  // `localDate` (RangeError) and the run dies before it looks at a single slot.
  it.each([
    ['an invalid date', new Date('nonsense')],
    ['a string the driver did not map', '2026-08-10T06:00:00Z'],
    ['a number of milliseconds', 1_775_000_000_000],
  ])('survives %s in scheduled_at, and still fills the slot', async (_label, value) => {
    seedItem({ id: 'bad', position: 1, scheduledAt: value })
    seedItem({ id: 'b', position: 2 })
    seedImage({ itemId: 'bad' })
    seedImage({ itemId: 'b' })
    okFetch()

    const report = await runPublish(AT_10_05)

    expect(report.slots).toEqual([{ date: TODAY, index: 600, outcome: 'posted', itemId: 'b' }])
    expect(itemRow('bad')).toMatchObject({ status: 'pending', postedDate: null })
  })
})

describe('runPublish — two cron runs racing on a scheduled item', () => {
  // The property this whole task turns on: overlapping cron runs must publish a
  // scheduled item EXACTLY ONCE. Proven the same way the slot path is, against
  // a fake that evaluates where clauses and enforces items_slot_unique_idx.
  it('publishes exactly once when two runs start together', async () => {
    seedItem({ scheduledAt: NINE })
    seedImage()
    okFetch()
    const publish = spyClient()

    const [first, second] = await Promise.all([runPublish(AT_09_05), runPublish(AT_09_05)])

    expect(publish).toHaveBeenCalledTimes(1)
    expect([first.slots[0].outcome, second.slots[0].outcome].sort()).toEqual(['posted', 'race-lost'])
    expect(state.items.filter((r) => r.postedDate !== null)).toHaveLength(1)
    expect(itemRow()).toMatchObject({ status: 'posted', slotIndex: NINE_INDEX, attempts: 0 })
  })

  it('publishes exactly once across four simultaneous runs', async () => {
    seedItem({ scheduledAt: NINE })
    seedImage()
    okFetch()
    const publish = spyClient()

    const reports = await Promise.all([
      runPublish(AT_09_05), runPublish(AT_09_05), runPublish(AT_09_05), runPublish(AT_09_05),
    ])

    expect(publish).toHaveBeenCalledTimes(1)
    expect(reports.filter((r) => r.slots[0].outcome === 'posted')).toHaveLength(1)
    expect(state.items.filter((r) => r.postedDate !== null)).toHaveLength(1)
  })

  it('publishes exactly once when two runs race on several scheduled items at once', async () => {
    seedItem({ id: 'a', position: 1, scheduledAt: NINE })
    seedItem({ id: 'b', position: 2, scheduledAt: new Date('2026-08-10T06:10:00Z') })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    okFetch()
    const publish = spyClient()

    await Promise.all([
      runPublish(new Date('2026-08-10T06:15:00Z')),
      runPublish(new Date('2026-08-10T06:15:00Z')),
    ])

    expect(publish).toHaveBeenCalledTimes(2)
    expect(state.items.filter((r) => r.status === 'posted')).toHaveLength(2)
  })

  it('treats a claim that matches no rows as a lost race, not as permission to post', async () => {
    // Another run committed its claim between our read and our write. The
    // UPDATE matches zero rows and throws nothing; only .returning() sees it.
    seedItem({ scheduledAt: NINE })
    seedImage()
    const publish = spyClient()
    state.beforeUpdate = (values) => {
      if (values.postedDate) {
        state.beforeUpdate = null
        itemRow().postedDate = TODAY
        itemRow().slotIndex = 1
      }
    }

    const report = await runPublish(AT_09_05)

    expect(publish).not.toHaveBeenCalled()
    expect(report.slots).toEqual([
      { date: TODAY, index: NINE_INDEX, outcome: 'race-lost', itemId: 'a', scheduled: true },
    ])
    expect(itemRow()).toMatchObject({ status: 'pending', attempts: 0, error: null })
  })

  it('gives the minute to one of two items that want it and refuses the other', async () => {
    // The collision the queue page has to prevent, seen from the publisher's
    // side: two items on the same minute of the same day are ONE claim, and the
    // unique index is what says so.
    seedItem({ id: 'a', position: 1, scheduledAt: NINE })
    seedItem({ id: 'b', position: 2, scheduledAt: NINE })
    seedImage({ itemId: 'a' })
    seedImage({ itemId: 'b' })
    okFetch()
    const publish = spyClient()

    const report = await runPublish(AT_09_05)

    expect(publish).toHaveBeenCalledTimes(1)
    expect(report.slots.map((s) => s.outcome).sort()).toEqual(['posted', 'race-lost'])
    expect(state.items.filter((r) => r.status === 'posted')).toHaveLength(1)
    const loser = state.items.find((r) => r.status === 'pending')!
    expect(loser).toMatchObject({ postedDate: null, attempts: 0, error: null })
  })
})
