import { describe, it, expect } from 'vitest'
import {
  DEFAULT_VIEW_SETTINGS,
  resolveViewSettings,
  slugForStaging,
  stagingPathname,
  needsCaption,
  isUnrecorded,
  awaitsSlot,
  labelForSlot,
  slotLabels,
  queueStatus,
  composedCaption,
  captionTooLong,
  nextCaptionlessId,
  moveId,
  describeUploadResults,
  screenFile,
  chunk,
  MAX_UPLOAD_BYTES,
  MAX_INGEST_BATCH,
  type ViewItem,
  type ViewSettings,
} from './view'
import { upcomingSlots } from './slots'

/** The exact regex `app/api/blob/upload/route.ts` answers 400 for. */
const STAGING_PATH = /^tmp\/[A-Za-z0-9._-]{1,160}$/

const SETTINGS: ViewSettings = {
  slots: ['10:00', '14:00', '20:00'], timezone: 'Europe/Istanbul', hashtags: '',
}

function item(over: Partial<ViewItem> & { id: string }): ViewItem {
  return {
    kind: 'feed',
    caption: 'bir açıklama',
    status: 'pending',
    attempts: 0,
    error: null,
    postedDate: null,
    slotIndex: null,
    images: [{ url: 'https://example.invalid/a.jpg' }],
    ...over,
  }
}

describe('resolveViewSettings', () => {
  it('falls back to the schema defaults when /api/settings answers nothing usable', () => {
    // A failed fetch, or a database whose settings row has never been written:
    // this is what the page has to render on.
    expect(resolveViewSettings(undefined)).toEqual(DEFAULT_VIEW_SETTINGS)
    expect(resolveViewSettings(null)).toEqual(DEFAULT_VIEW_SETTINGS)
    expect(resolveViewSettings({ error: 'not found' })).toEqual(DEFAULT_VIEW_SETTINGS)
  })

  it('keeps a valid row', () => {
    expect(resolveViewSettings({ slots: ['08:30', '21:45'], timezone: 'Europe/Berlin', hashtags: '#a' }))
      .toEqual({ slots: ['08:30', '21:45'], timezone: 'Europe/Berlin', hashtags: '#a' })
  })

  it('rejects each bad field on its own', () => {
    expect(resolveViewSettings({ slots: ['25:00'], timezone: 'Europe/Berlin' }))
      .toEqual({ slots: DEFAULT_VIEW_SETTINGS.slots, timezone: 'Europe/Berlin', hashtags: '' })
    expect(resolveViewSettings({ slots: [], timezone: 'Mars/Olympus' }))
      .toEqual(DEFAULT_VIEW_SETTINGS)
    expect(resolveViewSettings({ slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: 7 }).hashtags)
      .toBe('')
    expect(resolveViewSettings({ slots: ['10:00', 7], timezone: 'Europe/Istanbul' }).slots)
      .toEqual(DEFAULT_VIEW_SETTINGS.slots)
  })
})

describe('stagingPathname', () => {
  const NASTY = [
    'tatil fotoğrafı (1).jpg',
    'ışıklı İstanbul.JPEG',
    'çöp şiş & mangal.png',
    'a b\tc\nd.webp',
    '../../etc/passwd',
    'C:\\Users\\hazar\\Desktop\\resim.jpg',
    '🌊🌊🌊.jpg',
    '',
    '.',
    '%2f%2e%2e.jpg',
    'ünlü'.repeat(80) + '.jpg',
    'x'.repeat(400) + '.jpeg',
  ]

  it('produces a pathname the upload route accepts, for every filename we could be handed', () => {
    for (const name of NASTY) {
      const path = stagingPathname(name, 'a1b2c3d4e5f6')
      expect(STAGING_PATH.test(path), `${JSON.stringify(name)} -> ${path}`).toBe(true)
    }
  })

  it('keeps the readable part of a Turkish filename', () => {
    expect(stagingPathname('tatil fotoğrafı (1).jpg', 'abc123'))
      .toBe('tmp/abc123-tatil-fotografi-1-.jpg')
    expect(stagingPathname('ışıklı İstanbul.JPEG', 'abc123'))
      .toBe('tmp/abc123-isikli-Istanbul.JPEG')
  })

  it('never exceeds the route\'s 160-character budget, and keeps the extension', () => {
    const path = stagingPathname('ü'.repeat(500) + '.jpeg', 'f'.repeat(64))
    expect(STAGING_PATH.test(path)).toBe(true)
    expect(path.length - 'tmp/'.length).toBeLessThanOrEqual(160)
    expect(path.endsWith('.jpeg')).toBe(true)
    // Leaves room for the ~31 characters Blob's addRandomSuffix adds, inside
    // the 200 that repo.ts's STAGED_PATH allows.
    expect(path.length - 'tmp/'.length + 31).toBeLessThanOrEqual(200)
  })

  it('separates two drops of the same file by token', () => {
    expect(stagingPathname('a.jpg', 'one')).not.toBe(stagingPathname('a.jpg', 'two'))
  })

  it('never returns an empty name segment', () => {
    expect(slugForStaging('...')).toBe('image')
    expect(slugForStaging('🌊')).toBe('image')
    expect(stagingPathname('🌊', '🌊')).toBe('tmp/image-image')
  })
})

describe('item predicates', () => {
  it('only a non-story with a blank caption needs one', () => {
    expect(needsCaption({ kind: 'feed', caption: '   ' })).toBe(true)
    expect(needsCaption({ kind: 'carousel', caption: '' })).toBe(true)
    expect(needsCaption({ kind: 'story', caption: '' })).toBe(false)
    expect(needsCaption({ kind: 'feed', caption: 'x' })).toBe(false)
  })

  it('recognises a posted-unrecorded row, which looks exactly like a pending one', () => {
    const stuck = { status: 'pending' as const, postedDate: '2026-08-09' }
    expect(isUnrecorded(stuck)).toBe(true)
    expect(awaitsSlot(stuck)).toBe(false)
    const ordinary = { status: 'pending' as const, postedDate: null }
    expect(isUnrecorded(ordinary)).toBe(false)
    expect(awaitsSlot(ordinary)).toBe(true)
    expect(awaitsSlot({ status: 'failed', postedDate: null })).toBe(false)
  })
})

describe('slot labels', () => {
  // 2026-08-09 08:00 Europe/Istanbul — before every slot of the day.
  const now = new Date('2026-08-09T05:00:00Z')

  it('names today, tomorrow, and a further date', () => {
    const slots = upcomingSlots(now, SETTINGS.slots, SETTINGS.timezone, 8)
    expect(labelForSlot(slots[0], SETTINGS, now)).toBe('Bugün 10:00')
    expect(labelForSlot(slots[2], SETTINGS, now)).toBe('Bugün 20:00')
    expect(labelForSlot(slots[3], SETTINGS, now)).toBe('Yarın 10:00')
    expect(labelForSlot(slots[6], SETTINGS, now)).toBe('11 Ağu 10:00')
  })

  it('hands consecutive slots to the queue in order', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' }), item({ id: 'd' })]
    const labels = slotLabels(items, SETTINGS, now)
    expect([...labels.values()]).toEqual(['Bugün 10:00', 'Bugün 14:00', 'Bugün 20:00', 'Yarın 10:00'])
  })

  it('spends no slot on a failed or posted-unrecorded item', () => {
    const items = [
      item({ id: 'stuck', postedDate: '2026-08-08', slotIndex: 1 }),
      item({ id: 'dead', status: 'failed' }),
      item({ id: 'live' }),
    ]
    const labels = slotLabels(items, SETTINGS, now)
    expect(labels.has('stuck')).toBe(false)
    expect(labels.has('dead')).toBe(false)
    // The first real slot goes to the first item that can actually use it.
    expect(labels.get('live')).toBe('Bugün 10:00')
  })

  // The whole point of the label is telling the owner when a post goes out.
  // An uncaptioned item does not yield its turn — selectForSlot leaves the slot
  // empty and meets the same item at the head next tick — so everything behind
  // it is waiting on an edit, not on a clock. Promising a time would be a lie
  // the owner acts on by leaving the caption blank.
  it('labels nothing at or below an uncaptioned item', () => {
    const items = [
      item({ id: 'a' }),
      item({ id: 'blocker', caption: '' }),
      item({ id: 'c' }),
      item({ id: 'd' }),
    ]
    const labels = slotLabels(items, SETTINGS, now)
    expect(labels.get('a')).toBe('Bugün 10:00')
    expect(labels.has('blocker')).toBe(false)
    expect(labels.has('c')).toBe(false)
    expect(labels.has('d')).toBe(false)
  })

  it('labels the whole queue again once the blocker is captioned', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]
    expect([...slotLabels(items, SETTINGS, now).keys()]).toEqual(['a', 'b', 'c'])
  })

  it('labels nothing at all when the head itself is uncaptioned', () => {
    const items = [item({ id: 'head', caption: '' }), item({ id: 'b' })]
    expect(slotLabels(items, SETTINGS, now).size).toBe(0)
  })

  // A story publishes without a caption, so it does not block anything.
  it('does not treat an uncaptioned story as a blockage', () => {
    const items = [item({ id: 'a', kind: 'story', caption: '' }), item({ id: 'b' })]
    const labels = slotLabels(items, SETTINGS, now)
    expect(labels.get('a')).toBe('Bugün 10:00')
    expect(labels.get('b')).toBe('Bugün 14:00')
  })
})

describe('queueStatus', () => {
  it('names the head when the head is what is blocking', () => {
    const blocked = queueStatus(
      [item({ id: 'a', caption: '' }), item({ id: 'b' }), item({ id: 'c', caption: '' })],
      SETTINGS,
    )
    expect(blocked.headBlockedId).toBe('a')
    expect(blocked.missingCaptions).toBe(2)

    // Same number of uncaptioned items, but the head can publish — the
    // scheduler keeps running, so this is not the same emergency.
    const running = queueStatus(
      [item({ id: 'a' }), item({ id: 'b', caption: '' })],
      SETTINGS,
    )
    expect(running.headBlockedId).toBe(null)
    expect(running.missingCaptions).toBe(1)
  })

  it('does not treat a stuck head as the blocking head', () => {
    // A posted-unrecorded row is not a candidate at all, so the item behind it
    // is the real head.
    const s = queueStatus(
      [item({ id: 'stuck', caption: '', postedDate: '2026-08-08' }), item({ id: 'b' })],
      SETTINGS,
    )
    expect(s.headBlockedId).toBe(null)
    expect(s.unrecordedIds).toEqual(['stuck'])
    expect(s.waiting).toBe(1)
  })

  // Counting over every item rather than the ones a slot will be spent on
  // inflates the banner with rows the scheduler will never look at.
  it('counts only items a slot will actually be spent on', () => {
    const s = queueStatus(
      [
        item({ id: 'a' }),
        item({ id: 'stuck', caption: '', postedDate: '2026-08-08', slotIndex: 0 }),
        item({ id: 'dead', caption: '', status: 'failed' }),
        item({ id: 'real', caption: '' }),
      ],
      SETTINGS,
    )
    expect(s.missingCaptions).toBe(1)
  })

  it('counts days left at the configured rate', () => {
    const seven = Array.from({ length: 7 }, (_, i) => item({ id: `i${i}` }))
    expect(queueStatus(seven, SETTINGS).daysLeft).toBe(2)
    expect(queueStatus(seven, { ...SETTINGS, slots: ['09:00'] }).daysLeft).toBe(7)
    expect(queueStatus([], SETTINGS).daysLeft).toBe(0)
  })

  it('lists failed items separately', () => {
    const s = queueStatus([item({ id: 'x', status: 'failed', error: 'boom' })], SETTINGS)
    expect(s.failedIds).toEqual(['x'])
    expect(s.waiting).toBe(0)
  })
})

describe('nextCaptionlessId', () => {
  const items = [
    item({ id: 'a', caption: '' }),
    item({ id: 'b' }),
    item({ id: 'c', caption: '' }),
    item({ id: 'story', kind: 'story', caption: '' }),
    item({ id: 'd', caption: '' }),
  ]

  it('skips captioned cards and stories', () => {
    expect(nextCaptionlessId(items, 'a')).toBe('c')
    expect(nextCaptionlessId(items, 'c')).toBe('d')
  })

  it('never wraps around', () => {
    expect(nextCaptionlessId(items, 'd')).toBe(null)
  })

  it('skips a card no slot will ever reach', () => {
    const withStuck = [
      item({ id: 'a', caption: '' }),
      item({ id: 'stuck', caption: '', postedDate: '2026-08-08' }),
      item({ id: 'b', caption: '' }),
    ]
    expect(nextCaptionlessId(withStuck, 'a')).toBe('b')
  })
})

describe('moveId', () => {
  const ids = ['a', 'b', 'c', 'd']

  it('moves a card down and up', () => {
    expect(moveId(ids, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveId(ids, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('returns the whole queue, because applyOrder refuses a subset', () => {
    expect(moveId(ids, 'a', 'c')).toHaveLength(ids.length)
    expect([...moveId(ids, 'a', 'c')].sort()).toEqual([...ids].sort())
  })

  it('returns the input untouched when nothing moves', () => {
    expect(moveId(ids, 'b', 'b')).toBe(ids)
    expect(moveId(ids, 'b', 'zzz')).toBe(ids)
    expect(moveId(ids, 'zzz', 'b')).toBe(ids)
  })
})

describe('screenFile and chunk', () => {
  it('refuses what the token route would refuse, before the round trip', () => {
    expect(screenFile({ type: 'image/jpeg', size: 1000 })).toBe(null)
    expect(screenFile({ type: 'image/heic', size: 1000 })).toBe('desteklenmeyen dosya türü')
    expect(screenFile({ type: 'image/png', size: MAX_UPLOAD_BYTES + 1 }))
      .toBe('dosya çok büyük — en fazla 25MB olmalı')
    expect(screenFile({ type: 'image/png', size: MAX_UPLOAD_BYTES })).toBe(null)
  })

  it('splits a drop into batches /api/items will accept', () => {
    const files = Array.from({ length: 120 }, (_, i) => i)
    const batches = chunk(files, MAX_INGEST_BATCH)
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20])
    expect(batches.flat()).toEqual(files)
    expect(chunk([], MAX_INGEST_BATCH)).toEqual([])
    expect(batches.every((b) => b.length <= MAX_INGEST_BATCH)).toBe(true)
  })
})

describe('describeUploadResults', () => {
  it('reports errors, not just duplicates', () => {
    const notes = describeUploadResults([
      { status: 'added', name: 'a.jpg' },
      { status: 'duplicate', name: 'b.jpg' },
      { status: 'error', name: 'c.tiff', message: 'desteklenmeyen dosya türü' },
    ])
    expect(notes).toEqual([
      { tone: 'info', text: '1 görsel eklendi' },
      { tone: 'info', text: 'b.jpg zaten var' },
      { tone: 'error', text: 'c.tiff: desteklenmeyen dosya türü' },
    ])
  })

  it('says nothing when nothing happened', () => {
    expect(describeUploadResults([])).toEqual([])
  })

  it('collapses a pile of duplicates but keeps every error reason', () => {
    const dupes = Array.from({ length: 9 }, (_, i) => ({ status: 'duplicate' as const, name: `d${i}.jpg` }))
    expect(describeUploadResults(dupes)).toEqual([{ tone: 'info', text: '9 görsel zaten kuyrukta' }])

    const errors = Array.from({ length: 12 }, (_, i) => ({ status: 'error' as const, name: `e${i}.jpg` }))
    const notes = describeUploadResults(errors)
    expect(notes).toHaveLength(11)
    expect(notes[0]).toEqual({ tone: 'error', text: 'e0.jpg: yüklenemedi' })
    expect(notes[10]).toEqual({ tone: 'error', text: 've 2 dosya daha yüklenemedi' })
  })
})

describe('the fixed hashtag block is part of what the page can see', () => {
  const TAGS = '#moda #stil'
  const withTags: ViewSettings = { ...SETTINGS, hashtags: TAGS }
  // withHashtags joins with a blank line, so this composes to exactly 2200.
  const exact = 'x'.repeat(2200 - TAGS.length - 2)

  it('composes the caption exactly as the publisher does', () => {
    expect(composedCaption('bir açıklama', TAGS)).toBe(`bir açıklama\n\n${TAGS}`)
    expect(composedCaption('  ', TAGS)).toBe(TAGS)
    expect(composedCaption('bir açıklama', '   ')).toBe('bir açıklama')
  })

  it('measures the caption with the hashtags, not without them', () => {
    expect(captionTooLong({ caption: exact }, TAGS)).toBe(false)
    expect(captionTooLong({ caption: `${exact}x` }, TAGS)).toBe(true)
    // The same caption is fine with no hashtag block configured.
    expect(captionTooLong({ caption: `${exact}x` }, '')).toBe(false)
  })

  it('names a too-long head as a blockage of its own kind', () => {
    const s = queueStatus([item({ id: 'head', caption: `${exact}x` }), item({ id: 'b' })], withTags)
    expect(s.headBlockedId).toBe('head')
    expect(s.headBlockedReason).toBe('caption-too-long')
    expect(s.missingCaptions).toBe(0)
    expect(s.captionsTooLong).toBe(1)
  })

  it('still calls a missing caption a missing caption', () => {
    const s = queueStatus([item({ id: 'head', caption: '' })], withTags)
    expect(s.headBlockedReason).toBe('missing-caption')
  })

  it('reports no blockage when nothing is wrong', () => {
    const s = queueStatus([item({ id: 'a' })], withTags)
    expect(s.headBlockedReason).toBe(null)
    expect(s.headBlockedId).toBe(null)
    expect(s.captionsTooLong).toBe(0)
  })

  it('labels nothing at or below an item the hashtags push over the limit', () => {
    // Exactly the state Task 9 could not see: the queue stops here, and the
    // characters that stopped it came from the settings screen.
    const items = [
      item({ id: 'a' }),
      item({ id: 'blocker', caption: `${exact}x` }),
      item({ id: 'c' }),
    ]
    const now = new Date('2026-08-09T05:00:00Z')
    const labels = slotLabels(items, withTags, now)
    expect(labels.get('a')).toBe('Bugün 10:00')
    expect(labels.has('blocker')).toBe(false)
    expect(labels.has('c')).toBe(false)
    // The same queue with no hashtags configured runs to the end.
    expect([...slotLabels(items, SETTINGS, now).keys()]).toEqual(['a', 'blocker', 'c'])
  })
})
