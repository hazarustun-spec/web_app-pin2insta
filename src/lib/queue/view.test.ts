import { describe, it, expect } from 'vitest'
import {
  chooseSchedule,
  chosenTimeFor,
  scheduleInputValue,
  parseScheduleInput,
  scheduleKeyFor,
  takenScheduleKeys,
  scheduleProblem,
  DEFAULT_VIEW_SETTINGS,
  resolveViewSettings,
  slugForStaging,
  stagingPathname,
  needsCaption,
  isUnrecorded,
  awaitsSlot,
  labelForSlot,
  cardTimes,
  queueStatus,
  composedCaption,
  captionTooLong,
  nextCaptionlessId,
  moveId,
  describeUploadResults,
  screenFile,
  chunk,
  isTypingTarget,
  pastedPinUrl,
  MAX_UPLOAD_BYTES,
  MAX_INGEST_BATCH,
  type ViewItem,
  type ViewSettings,
} from './view'
import { upcomingSlots } from './slots'

/** The exact regex `app/api/blob/upload/route.ts` answers 400 for. */
const STAGING_PATH = /^tmp\/[A-Za-z0-9._-]{1,160}$/

/** 2026-08-09 08:00 Europe/Istanbul — before every slot of the test day. */
const NOW = new Date('2026-08-09T05:00:00Z')

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
    scheduledAt: null,
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
    const labels = cardTimes(items, SETTINGS, now)
    expect([...labels.values()].map((t) => t.text))
      .toEqual(['Bugün 10:00', 'Bugün 14:00', 'Bugün 20:00', 'Yarın 10:00'])
    expect([...labels.values()].every((t) => t.kind === 'slot' && !t.warn)).toBe(true)
  })

  it('spends no slot on a failed or posted-unrecorded item', () => {
    const items = [
      item({ id: 'stuck', postedDate: '2026-08-08', slotIndex: 1 }),
      item({ id: 'dead', status: 'failed' }),
      item({ id: 'live' }),
    ]
    const labels = cardTimes(items, SETTINGS, now)
    expect(labels.has('stuck')).toBe(false)
    expect(labels.has('dead')).toBe(false)
    // The first real slot goes to the first item that can actually use it.
    expect(labels.get('live')?.text).toBe('Bugün 10:00')
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
    const labels = cardTimes(items, SETTINGS, now)
    expect(labels.get('a')?.text).toBe('Bugün 10:00')
    expect(labels.has('blocker')).toBe(false)
    expect(labels.has('c')).toBe(false)
    expect(labels.has('d')).toBe(false)
  })

  it('labels the whole queue again once the blocker is captioned', () => {
    const items = [item({ id: 'a' }), item({ id: 'b' }), item({ id: 'c' })]
    expect([...cardTimes(items, SETTINGS, now).keys()]).toEqual(['a', 'b', 'c'])
  })

  it('labels nothing at all when the head itself is uncaptioned', () => {
    const items = [item({ id: 'head', caption: '' }), item({ id: 'b' })]
    expect(cardTimes(items, SETTINGS, now).size).toBe(0)
  })

  // A story publishes without a caption, so it does not block anything.
  it('does not treat an uncaptioned story as a blockage', () => {
    const items = [item({ id: 'a', kind: 'story', caption: '' }), item({ id: 'b' })]
    const labels = cardTimes(items, SETTINGS, now)
    expect(labels.get('a')?.text).toBe('Bugün 10:00')
    expect(labels.get('b')?.text).toBe('Bugün 14:00')
  })
})

describe('queueStatus', () => {
  it('names the head when the head is what is blocking', () => {
    const blocked = queueStatus(
      [item({ id: 'a', caption: '' }), item({ id: 'b' }), item({ id: 'c', caption: '' })],
      SETTINGS, NOW,
    )
    expect(blocked.headBlockedId).toBe('a')
    expect(blocked.missingCaptions).toBe(2)

    // Same number of uncaptioned items, but the head can publish — the
    // scheduler keeps running, so this is not the same emergency.
    const running = queueStatus(
      [item({ id: 'a' }), item({ id: 'b', caption: '' })],
      SETTINGS, NOW,
    )
    expect(running.headBlockedId).toBe(null)
    expect(running.missingCaptions).toBe(1)
  })

  it('does not treat a stuck head as the blocking head', () => {
    // A posted-unrecorded row is not a candidate at all, so the item behind it
    // is the real head.
    const s = queueStatus(
      [item({ id: 'stuck', caption: '', postedDate: '2026-08-08' }), item({ id: 'b' })],
      SETTINGS, NOW,
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
      SETTINGS, NOW,
    )
    expect(s.missingCaptions).toBe(1)
  })

  it('counts days left at the configured rate', () => {
    const seven = Array.from({ length: 7 }, (_, i) => item({ id: `i${i}` }))
    expect(queueStatus(seven, SETTINGS, NOW).daysLeft).toBe(2)
    expect(queueStatus(seven, { ...SETTINGS, slots: ['09:00'] }, NOW).daysLeft).toBe(7)
    expect(queueStatus([], SETTINGS, NOW).daysLeft).toBe(0)
  })

  it('lists failed items separately', () => {
    const s = queueStatus([item({ id: 'x', status: 'failed', error: 'boom' })], SETTINGS, NOW)
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
    const s = queueStatus([item({ id: 'head', caption: `${exact}x` }), item({ id: 'b' })], withTags, NOW)
    expect(s.headBlockedId).toBe('head')
    expect(s.headBlockedReason).toBe('caption-too-long')
    expect(s.missingCaptions).toBe(0)
    expect(s.captionsTooLong).toBe(1)
  })

  it('still calls a missing caption a missing caption', () => {
    const s = queueStatus([item({ id: 'head', caption: '' })], withTags, NOW)
    expect(s.headBlockedReason).toBe('missing-caption')
  })

  it('reports no blockage when nothing is wrong', () => {
    const s = queueStatus([item({ id: 'a' })], withTags, NOW)
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
    const labels = cardTimes(items, withTags, now)
    expect(labels.get('a')?.text).toBe('Bugün 10:00')
    expect(labels.has('blocker')).toBe(false)
    expect(labels.has('c')).toBe(false)
    // The same queue with no hashtags configured runs to the end.
    expect([...cardTimes(items, SETTINGS, now).keys()]).toEqual(['a', 'blocker', 'c'])
  })
})

// ---------------------------------------------------------------------------
// Paste-to-ingest. The listener is on `window`, so it sees every paste on the
// page — including the ones meant for a caption box.
// ---------------------------------------------------------------------------

describe('isTypingTarget', () => {
  it.each([
    ['a caption textarea', { tagName: 'TEXTAREA' }],
    ['a text input', { tagName: 'INPUT' }],
    ['a select', { tagName: 'SELECT' }],
    ['a lowercase tagName', { tagName: 'textarea' }],
    ['a contenteditable element', { tagName: 'DIV', isContentEditable: true }],
    ['a node inside a contenteditable', { tagName: 'SPAN', closest: () => ({}) }],
  ])('claims %s', (_label, target) => {
    expect(isTypingTarget(target)).toBe(true)
  })

  it.each([
    ['a plain div', { tagName: 'DIV', closest: () => null }],
    ['the body', { tagName: 'BODY' }],
    ['a node with no editable ancestor', { tagName: 'SPAN', closest: () => null }],
    ['null', null],
    ['undefined', undefined],
    ['a string', 'TEXTAREA'],
  ])('does not claim %s', (_label, target) => {
    expect(isTypingTarget(target)).toBe(false)
  })
})

describe('pastedPinUrl', () => {
  it.each([
    ['a pin url', 'https://tr.pinterest.com/pin/12345/'],
    ['a pin url with surrounding whitespace', '  https://www.pinterest.com/pin/1/\n'],
    ['a shortener link', 'https://pin.it/abc'],
  ])('accepts %s', (_label, text) => {
    expect(pastedPinUrl(text)).toBe(text.trim())
  })

  it.each([
    ['plain text', 'merhaba'],
    ['a sentence mentioning pinterest', 'bak şuna https://tr.pinterest.com/pin/1/ güzelmiş'],
    ['some other link', 'https://example.com/pin/1'],
    // The client filter uses the SAME guard as the server, so a lookalike host
    // never even produces a request.
    ['a lookalike host', 'https://pinterest.com.evil.com/pin/1'],
    ['an empty clipboard', ''],
  ])('ignores %s', (_label, text) => {
    expect(pastedPinUrl(text)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Task 14: an item may carry its own date and time. Empty still means "the next
// free slot"; a chosen time is claimed, missed, or blocked — and the card has
// to say which.
// ---------------------------------------------------------------------------

describe('a card that carries its own time', () => {
  // 2026-08-09 08:00 Europe/Istanbul.
  const now = NOW
  /** 2026-08-09 14:35 Istanbul — later today, and not a configured slot. */
  const LATER_TODAY = '2026-08-09T11:35:00.000Z'
  /** 2026-08-09 06:00 Istanbul — two hours ago, well past the grace window. */
  const GONE = '2026-08-09T03:00:00.000Z'

  it('says the time is one the owner chose, not one the schedule computed', () => {
    const labels = cardTimes([item({ id: 'a', scheduledAt: LATER_TODAY })], SETTINGS, now)
    expect(labels.get('a')).toEqual({ text: 'Bugün 14:35 · seçilen saat', kind: 'scheduled', warn: false })
  })

  it('reads the chosen time in the configured zone, not the browser\'s', () => {
    const berlin: ViewSettings = { ...SETTINGS, timezone: 'Europe/Berlin' }
    expect(cardTimes([item({ id: 'a', scheduledAt: LATER_TODAY })], berlin, now).get('a')?.text)
      .toBe('Bugün 13:35 · seçilen saat')
  })

  it('does not spend an upcoming slot on it, and does not let it hold up the queue', () => {
    // 'a' has its own time; the slots belong to the others, in their order.
    const items = [
      item({ id: 'a', scheduledAt: LATER_TODAY }),
      item({ id: 'b' }),
      item({ id: 'c' }),
    ]
    const labels = cardTimes(items, SETTINGS, now)
    expect(labels.get('a')?.text).toBe('Bugün 14:35 · seçilen saat')
    expect(labels.get('b')?.text).toBe('Bugün 10:00')
    expect(labels.get('c')?.text).toBe('Bugün 14:00')
  })

  it('keeps labelling the slot queue past an uncaptioned item that has its own time', () => {
    // An uncaptioned item with its own time costs only ITS time: the publisher
    // never looks at it for a slot, so it is not the blockage an ordinary
    // uncaptioned card is.
    const items = [
      item({ id: 'scheduled', caption: '', scheduledAt: LATER_TODAY }),
      item({ id: 'b' }),
    ]
    const labels = cardTimes(items, SETTINGS, now)
    expect(labels.get('b')?.text).toBe('Bugün 10:00')
  })

  it('warns that an uncaptioned chosen time will pass unused', () => {
    // The publisher refuses a non-story with no caption, so this time comes and
    // goes with nothing posted. Showing a bare "Bugün 14:35" would read as a
    // promise.
    const labels = cardTimes([item({ id: 'a', caption: '', scheduledAt: LATER_TODAY })], SETTINGS, now)
    expect(labels.get('a')).toEqual({
      text: 'Bugün 14:35 · açıklama yok, boş geçecek', kind: 'scheduled', warn: true,
    })
  })

  it('warns the same way when the fixed hashtags push the caption over the limit', () => {
    const TAGS = '#moda #stil'
    const tooLong = 'x'.repeat(2200 - TAGS.length - 2 + 1)
    const labels = cardTimes(
      [item({ id: 'a', caption: tooLong, scheduledAt: LATER_TODAY })],
      { ...SETTINGS, hashtags: TAGS },
      now,
    )
    expect(labels.get('a')?.warn).toBe(true)
    expect(labels.get('a')?.text).toContain('açıklama çok uzun')
  })

  it('says plainly that a time has gone by and nothing was posted', () => {
    const labels = cardTimes([item({ id: 'a', scheduledAt: GONE })], SETTINGS, now)
    expect(labels.get('a')).toEqual({
      text: 'Bugün 06:00 · saati geçti, paylaşılmadı', kind: 'scheduled', warn: true,
    })
  })

  it('still calls a time inside the grace window a time that is about to be used', () => {
    // 89 minutes past 06:00: the next cron tick still publishes it.
    const nowInside = new Date(Date.parse(GONE) + 89 * 60_000)
    expect(cardTimes([item({ id: 'a', scheduledAt: GONE })], SETTINGS, nowInside).get('a'))
      .toMatchObject({ text: 'Bugün 06:00 · seçilen saat', warn: false })
  })

  it('does not promise a slot minute an item has already taken for itself', () => {
    // 10:00 Istanbul today is BOTH a configured slot and this item's chosen
    // time. They are one claim: the publisher fills it from the chosen time and
    // reports the slot `already-filled`, so the next card waits for 14:00.
    const items = [
      item({ id: 'a', scheduledAt: '2026-08-09T07:00:00.000Z' }),
      item({ id: 'b' }),
    ]
    const labels = cardTimes(items, SETTINGS, now)
    expect(labels.get('a')?.text).toBe('Bugün 10:00 · seçilen saat')
    expect(labels.get('b')?.text).toBe('Bugün 14:00')
  })

  it('names tomorrow and a further date exactly as a slot label does', () => {
    const tomorrow = cardTimes(
      [item({ id: 'a', scheduledAt: '2026-08-10T11:35:00.000Z' })], SETTINGS, now,
    )
    expect(tomorrow.get('a')?.text).toBe('Yarın 14:35 · seçilen saat')
    const later = cardTimes(
      [item({ id: 'a', scheduledAt: '2026-08-12T11:35:00.000Z' })], SETTINGS, now,
    )
    expect(later.get('a')?.text).toBe('12 Ağu 14:35 · seçilen saat')
  })

  it('spends no time at all on an item no publish will ever reach', () => {
    const items = [
      item({ id: 'stuck', scheduledAt: LATER_TODAY, postedDate: '2026-08-08', slotIndex: 600 }),
      item({ id: 'dead', status: 'failed', scheduledAt: LATER_TODAY }),
    ]
    expect(cardTimes(items, SETTINGS, now).size).toBe(0)
  })

  it('treats an unreadable scheduled_at as no chosen time rather than crashing', () => {
    const items = [item({ id: 'a', scheduledAt: 'not a date' }), item({ id: 'b' })]
    const labels = cardTimes(items, SETTINGS, now)
    // It falls back to the slot queue, which is what the publisher does too.
    expect(labels.get('a')?.text).toBe('Bugün 10:00')
    expect(labels.get('b')?.text).toBe('Bugün 14:00')
  })
})

describe('queueStatus with chosen times', () => {
  const now = NOW
  const LATER_TODAY = '2026-08-09T11:35:00.000Z'
  const GONE = '2026-08-09T03:00:00.000Z'

  it('counts an item with its own time separately from the slot queue', () => {
    const s = queueStatus(
      [item({ id: 'a', scheduledAt: LATER_TODAY }), item({ id: 'b' }), item({ id: 'c' })],
      SETTINGS,
      now,
    )
    expect(s.waiting).toBe(2)
    expect(s.scheduledWaiting).toBe(1)
    // Three slots a day and two items waiting on them.
    expect(s.daysLeft).toBe(0)
  })

  it('names every time that has gone by', () => {
    const s = queueStatus(
      [item({ id: 'gone', scheduledAt: GONE }), item({ id: 'b', scheduledAt: LATER_TODAY })],
      SETTINGS,
      now,
    )
    expect(s.missedIds).toEqual(['gone'])
  })

  it('does not call a missed time a failure', () => {
    // Nothing was attempted: it is not `failed`, and it is not an ordinary
    // pending card either.
    const s = queueStatus([item({ id: 'gone', scheduledAt: GONE })], SETTINGS, now)
    expect(s.failedIds).toEqual([])
    expect(s.unrecordedIds).toEqual([])
    expect(s.waiting).toBe(0)
  })

  it('does not let an item with its own time be the blocked head', () => {
    // The slot path never looks at it, so an uncaptioned scheduled card does
    // not stop the queue the way an ordinary one does.
    const s = queueStatus(
      [item({ id: 'a', caption: '', scheduledAt: LATER_TODAY }), item({ id: 'b' })],
      SETTINGS,
      now,
    )
    expect(s.headBlockedId).toBe(null)
    expect(s.missingCaptions).toBe(0)
    expect(s.scheduledBlocked).toBe(1)
  })

  it('still names an ordinary uncaptioned head', () => {
    const s = queueStatus(
      [item({ id: 'a', scheduledAt: LATER_TODAY }), item({ id: 'b', caption: '' })],
      SETTINGS,
      now,
    )
    expect(s.headBlockedId).toBe('b')
    expect(s.headBlockedReason).toBe('missing-caption')
  })

  it('does not count a missed time as one that will pass unused', () => {
    // It already did. `scheduledBlocked` is about a time still to come.
    const s = queueStatus([item({ id: 'a', caption: '', scheduledAt: GONE })], SETTINGS, now)
    expect(s.scheduledBlocked).toBe(0)
    expect(s.missedIds).toEqual(['a'])
  })
})

describe('choosing a time: the same refusals on both sides of the wire', () => {
  const now = NOW
  const TZ = 'Europe/Istanbul'

  it('renders an instant as the datetime-local value of the CONFIGURED zone', () => {
    // The control shows the owner the time their posts go out in, not the time
    // on the laptop they happen to be using.
    expect(scheduleInputValue('2026-08-09T11:35:00.000Z', TZ)).toBe('2026-08-09T14:35')
    expect(scheduleInputValue('2026-08-09T11:35:00.000Z', 'Europe/Berlin')).toBe('2026-08-09T13:35')
    expect(scheduleInputValue(null, TZ)).toBe('')
    expect(scheduleInputValue('nonsense', TZ)).toBe('')
  })

  it('parses that value back to the instant it names in the configured zone', () => {
    expect(parseScheduleInput('2026-08-09T14:35', TZ)?.toISOString()).toBe('2026-08-09T11:35:00.000Z')
    expect(parseScheduleInput('2026-08-09T14:35', 'Europe/Berlin')?.toISOString())
      .toBe('2026-08-09T12:35:00.000Z')
  })

  it('round-trips whatever the control produces', () => {
    for (const value of ['2026-01-01T00:00', '2026-08-09T14:35', '2026-12-31T23:59']) {
      expect(scheduleInputValue(parseScheduleInput(value, TZ)!.toISOString(), TZ)).toBe(value)
    }
  })

  it('refuses a value that is not a minute of a real day', () => {
    for (const bad of ['', 'today', '2026-08-09', '2026-08-09T14', '2026-13-40T14:35', '2026-08-09T24:00']) {
      expect(parseScheduleInput(bad, TZ)).toBe(null)
    }
  })

  it('keys a chosen time by the date and minute the publisher will claim', () => {
    // The SAME key the unique index enforces, so the page refuses the collision
    // the publisher would otherwise discover at 14:35.
    expect(scheduleKeyFor(new Date('2026-08-09T11:35:00Z'), TZ)).toBe('2026-08-09#875')
    // Seconds are not part of the identity: two items 30 seconds apart are one
    // claim, and the page must say so.
    expect(scheduleKeyFor(new Date('2026-08-09T11:35:30Z'), TZ)).toBe('2026-08-09#875')
  })

  it('collects the minutes already spoken for, ignoring the card being edited', () => {
    const items = [
      item({ id: 'a', scheduledAt: '2026-08-09T11:35:00.000Z' }),
      item({ id: 'b', scheduledAt: '2026-08-09T12:00:00.000Z' }),
      item({ id: 'plain' }),
      // A posted-unrecorded row holds a real claim on (date, index).
      item({ id: 'stuck', postedDate: '2026-08-09', slotIndex: 600 }),
    ]
    expect(takenScheduleKeys(items, TZ, 'a')).toEqual(new Set(['2026-08-09#900', '2026-08-09#600']))
    expect(takenScheduleKeys(items, TZ)).toEqual(
      new Set(['2026-08-09#875', '2026-08-09#900', '2026-08-09#600']),
    )
  })

  it('refuses a time that has already gone', () => {
    expect(scheduleProblem(new Date(now.getTime() - 60_000), now, new Set(), TZ))
      .toBe('geçmiş bir saat seçilemez')
    // The current minute is still ahead of the next cron tick, so it is allowed.
    expect(scheduleProblem(now, now, new Set(), TZ)).toBe(null)
  })

  it('refuses a minute another item already holds', () => {
    const at = new Date('2026-08-09T11:35:00Z')
    const taken = new Set([scheduleKeyFor(at, TZ)])
    expect(scheduleProblem(at, now, taken, TZ)).toBe('bu dakika dolu — başka bir saat seçin')
    // One minute later is free.
    expect(scheduleProblem(new Date(at.getTime() + 60_000), now, taken, TZ)).toBe(null)
    // And so is the same minute of the next day.
    expect(scheduleProblem(new Date(at.getTime() + 86_400_000), now, taken, TZ)).toBe(null)
  })

  it('refuses a time no clock could produce', () => {
    expect(scheduleProblem(new Date('nonsense'), now, new Set(), TZ)).toBe('geçersiz tarih veya saat')
  })

  it('turns what the control holds into what to send, or what to refuse', () => {
    const taken = new Set([scheduleKeyFor(new Date('2026-08-09T11:35:00Z'), TZ)])
    // Empty: back to the next free slot. This is how a missed time is cleared.
    expect(chooseSchedule('', TZ, now, taken)).toEqual({ scheduledAt: null })
    // A time that is free.
    expect(chooseSchedule('2026-08-09T15:00', TZ, now, taken))
      .toEqual({ scheduledAt: '2026-08-09T12:00:00.000Z' })
    // The minute another card holds — the collision the publisher would
    // otherwise answer with `race-lost` and nothing on screen.
    expect(chooseSchedule('2026-08-09T14:35', TZ, now, taken))
      .toEqual({ error: 'bu dakika dolu — başka bir saat seçin' })
    expect(chooseSchedule('2026-08-09T07:00', TZ, now, taken))
      .toEqual({ error: 'geçmiş bir saat seçilemez' })
    expect(chooseSchedule('yarın', TZ, now, taken))
      .toEqual({ error: 'geçersiz tarih veya saat' })
  })

  it('reads a stored time back out for the control', () => {
    expect(chosenTimeFor(item({ id: 'a', scheduledAt: '2026-08-09T11:35:00.000Z' }))?.toISOString())
      .toBe('2026-08-09T11:35:00.000Z')
    expect(chosenTimeFor(item({ id: 'a' }))).toBe(null)
    expect(chosenTimeFor(item({ id: 'a', scheduledAt: 'nonsense' }))).toBe(null)
  })
})
