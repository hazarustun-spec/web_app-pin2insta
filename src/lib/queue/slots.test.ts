// src/lib/queue/slots.test.ts
import { describe, it, expect } from 'vitest'
import {
  slotAt, dueSlots, upcomingSlots, slotIndexFor, slotTimeFor,
  localTime, startOfMinute, scheduledRef, dueState, DUE_GRACE_MINUTES,
} from './slots'

const TZ = 'Europe/Istanbul'
const SLOTS = ['10:00', '14:00', '20:00']

describe('slotAt', () => {
  it('resolves a local wall-clock time to the correct UTC instant', () => {
    // Istanbul is UTC+3 year-round
    expect(slotAt('2026-08-08', '14:00', TZ).toISOString()).toBe('2026-08-08T11:00:00.000Z')
  })

  it('handles a zone that observes DST', () => {
    // Berlin is UTC+2 in August, UTC+1 in January
    expect(slotAt('2026-08-08', '14:00', 'Europe/Berlin').toISOString()).toBe('2026-08-08T12:00:00.000Z')
    expect(slotAt('2026-01-08', '14:00', 'Europe/Berlin').toISOString()).toBe('2026-01-08T13:00:00.000Z')
  })
})

describe('dueSlots', () => {
  it('returns slots whose time has passed within the grace window', () => {
    const now = new Date('2026-08-08T11:05:00Z') // 14:05 Istanbul
    const due = dueSlots(now, SLOTS, TZ)
    expect(due.map((s) => s.index)).toEqual([slotIndexFor('14:00')])
  })

  it('excludes slots older than the grace window', () => {
    const now = new Date('2026-08-08T13:00:00Z') // 16:00 Istanbul, 2h after the 14:00 slot
    expect(dueSlots(now, SLOTS, TZ, 90)).toEqual([])
  })

  it('excludes slots that have not arrived yet', () => {
    const now = new Date('2026-08-08T06:00:00Z') // 09:00 Istanbul
    expect(dueSlots(now, SLOTS, TZ)).toEqual([])
  })

  it('includes a slot from the previous local day still inside the grace window', () => {
    const now = new Date('2026-08-08T17:30:00Z') // 20:30 Istanbul, same day
    expect(dueSlots(now, SLOTS, TZ).map((s) => s.date)).toEqual(['2026-08-08'])
  })
})

describe('upcomingSlots', () => {
  it('fills the next free slots in order, skipping used ones', () => {
    const now = new Date('2026-08-08T06:00:00Z') // 09:00 Istanbul
    const used = [
      { date: '2026-08-08', time: '10:00', index: slotIndexFor('10:00'), at: slotAt('2026-08-08', '10:00', TZ) },
    ]
    const next = upcomingSlots(now, SLOTS, TZ, 3, used)
    expect(next.map((s) => `${s.date}#${s.time}`)).toEqual([
      '2026-08-08#14:00', '2026-08-08#20:00', '2026-08-09#10:00',
    ])
  })

  it('returns slots in chronological order even with unsorted input', () => {
    const now = new Date('2026-08-08T06:00:00Z') // 09:00 Istanbul
    const unsortedSlots = ['20:00', '10:00', '14:00'] // Intentionally out of order
    const next = upcomingSlots(now, unsortedSlots, TZ, 3)
    // Verify the returned slots are in chronological order by their `at` times
    expect(next[0].at.getTime()).toBeLessThan(next[1].at.getTime())
    expect(next[1].at.getTime()).toBeLessThan(next[2].at.getTime())
    // Also verify they are the correct slots in chronological order
    expect(next.map((s) => `${s.date}#${s.time}`)).toEqual([
      '2026-08-08#10:00', '2026-08-08#14:00', '2026-08-08#20:00',
    ])
  })
})

describe('dueSlots - yesterday branch', () => {
  it('exercises the yesterday branch with a near-midnight slot', () => {
    // Slot is at 23:30 Istanbul on 2026-08-08, which is 20:30 UTC
    const slotTime = slotAt('2026-08-08', '23:30', TZ)
    expect(slotTime.toISOString()).toBe('2026-08-08T20:30:00.000Z')

    // Now is 00:15 Istanbul on 2026-08-09 (21:15 UTC on 2026-08-08)
    // This is 45 minutes after the slot, within the 90-minute grace window
    const now = new Date('2026-08-08T21:15:00Z')

    const due = dueSlots(now, ['23:30'], TZ)

    // Should return the slot from the previous calendar day
    expect(due).toHaveLength(1)
    expect(due[0].date).toBe('2026-08-08')
    expect(due[0].index).toBe(slotIndexFor('23:30'))
  })
})

describe('slotIndexFor — a slot is identified by its time, not by its place in the list', () => {
  it('is the number of minutes since local midnight', () => {
    expect(slotIndexFor('00:00')).toBe(0)
    expect(slotIndexFor('10:00')).toBe(600)
    expect(slotIndexFor('23:59')).toBe(1439)
  })

  it('gives two different times two different indices', () => {
    const indices = SLOTS.map(slotIndexFor)
    expect(new Set(indices).size).toBe(SLOTS.length)
  })

  it('does not renumber 10:00 when the owner adds, removes or reorders slots', () => {
    // The whole double-post fix in one assertion. `items_slot_unique_idx` is on
    // (posted_date, slot_index), so if this number moved when the settings
    // array changed, a day that had already published under the old numbering
    // would publish again under the new one.
    const now = new Date('2026-08-08T05:00:00Z') // 08:00 Istanbul, before every slot
    const indexOfTen = (slots: string[]) =>
      upcomingSlots(now, slots, TZ, slots.length).find((s) => s.time === '10:00')!.index

    expect(indexOfTen(['10:00', '14:00', '20:00'])).toBe(600)
    expect(indexOfTen(['09:00', '10:00', '14:00', '20:00'])).toBe(600)
    expect(indexOfTen(['10:00', '20:00'])).toBe(600)
    expect(indexOfTen(['20:00', '14:00', '10:00'])).toBe(600)
  })
})

describe('slotTimeFor — the inverse, so nothing the owner reads ever says "slot 600"', () => {
  it('turns minutes since midnight back into a zero-padded wall-clock time', () => {
    expect(slotTimeFor(0)).toBe('00:00')
    expect(slotTimeFor(600)).toBe('10:00')
    expect(slotTimeFor(840)).toBe('14:00')
    expect(slotTimeFor(1439)).toBe('23:59')
    expect(slotTimeFor(9)).toBe('00:09')
  })

  it('round-trips every minute of the day', () => {
    for (let i = 0; i < 1440; i++) {
      expect(slotIndexFor(slotTimeFor(i)!)).toBe(i)
    }
  })

  it('returns null for a value that is not a minute of the day', () => {
    // items.slot_index is a plain nullable integer, so a hand-edited or
    // legacy row can hold a position (0-2 is ambiguous but harmless) or
    // anything else. A caller that cannot be given a time must be told so
    // rather than handed "24:00" or "NaN:NaN".
    expect(slotTimeFor(1440)).toBe(null)
    expect(slotTimeFor(-1)).toBe(null)
    expect(slotTimeFor(6.5)).toBe(null)
    expect(slotTimeFor(NaN)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Task 14: a per-post time is claimed in exactly the same space as a slot.
// ---------------------------------------------------------------------------

describe('localTime — the wall-clock time of an instant in the configured zone', () => {
  it('reads an instant in the zone the schedule runs in, not the machine\'s', () => {
    // 11:35 UTC is 14:35 in Istanbul and 13:35 in Berlin.
    expect(localTime(new Date('2026-08-10T11:35:00Z'), TZ)).toBe('14:35')
    expect(localTime(new Date('2026-08-10T11:35:00Z'), 'Europe/Berlin')).toBe('13:35')
  })

  it('zero-pads, and says 00:00 rather than 24:00 at local midnight', () => {
    expect(localTime(new Date('2026-08-09T21:00:00Z'), TZ)).toBe('00:00')
    expect(localTime(new Date('2026-08-10T06:09:00Z'), TZ)).toBe('09:09')
  })

  it('round-trips with slotAt for every minute of a day', () => {
    for (let i = 0; i < 1440; i += 7) {
      const time = slotTimeFor(i)!
      expect(localTime(slotAt('2026-08-10', time, TZ), TZ)).toBe(time)
    }
  })
})

describe('startOfMinute — a scheduled time is stored to the minute', () => {
  it('drops seconds and milliseconds', () => {
    expect(startOfMinute(new Date('2026-08-10T11:35:47.123Z')).toISOString())
      .toBe('2026-08-10T11:35:00.000Z')
  })

  it('leaves an already-truncated instant alone', () => {
    const at = new Date('2026-08-10T11:35:00.000Z')
    expect(startOfMinute(at).toISOString()).toBe(at.toISOString())
  })
})

describe('scheduledRef — the claim a scheduled item makes', () => {
  it('is the local date and the minute of that day, the same key a slot uses', () => {
    const ref = scheduledRef(new Date('2026-08-10T11:35:00Z'), TZ)
    expect(ref).toEqual({
      date: '2026-08-10',
      time: '14:35',
      index: slotIndexFor('14:35'),
      at: new Date('2026-08-10T11:35:00Z'),
    })
  })

  it('gives a time that lands on a configured slot THE SAME index that slot has', () => {
    // This is why two items cannot share a minute, and why a scheduled post at
    // 10:00 fills the 10:00 slot rather than posting beside it.
    const ref = scheduledRef(slotAt('2026-08-10', '10:00', TZ), TZ)
    expect(ref.index).toBe(slotIndexFor('10:00'))
    expect(ref.date).toBe('2026-08-10')
  })

  it('uses the local date, not the UTC one', () => {
    // 22:30 UTC is already 01:30 the NEXT day in Istanbul.
    expect(scheduledRef(new Date('2026-08-10T22:30:00Z'), TZ)).toMatchObject({
      date: '2026-08-11', time: '01:30',
    })
  })

  it('truncates a stray second, so two instants in one minute cannot differ', () => {
    const a = scheduledRef(new Date('2026-08-10T11:35:00Z'), TZ)
    const b = scheduledRef(new Date('2026-08-10T11:35:59.999Z'), TZ)
    expect(b.at.getTime()).toBe(a.at.getTime())
    expect(b.index).toBe(a.index)
  })
})

describe('dueState — a scheduled time is due for exactly as long as a slot is', () => {
  const at = new Date('2026-08-10T11:00:00Z') // 14:00 Istanbul

  it('is early before the minute arrives', () => {
    expect(dueState(at, new Date('2026-08-10T10:59:59Z'))).toBe('early')
  })

  it('is due from the minute itself to the end of the grace window', () => {
    expect(dueState(at, at)).toBe('due')
    expect(dueState(at, new Date(at.getTime() + DUE_GRACE_MINUTES * 60_000))).toBe('due')
  })

  it('is missed one millisecond past the window, and never rolls forward', () => {
    expect(dueState(at, new Date(at.getTime() + DUE_GRACE_MINUTES * 60_000 + 1))).toBe('missed')
    expect(dueState(at, new Date(at.getTime() + 86_400_000))).toBe('missed')
  })

  it('uses the same window dueSlots does', () => {
    // 90 minutes, in one place, so a scheduled time and a slot cannot drift.
    const now = new Date(at.getTime() + DUE_GRACE_MINUTES * 60_000)
    expect(dueSlots(now, ['14:00'], TZ).map((s) => s.time)).toEqual(['14:00'])
    expect(dueState(at, now)).toBe('due')
  })
})
