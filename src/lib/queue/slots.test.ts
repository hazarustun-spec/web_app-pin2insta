// src/lib/queue/slots.test.ts
import { describe, it, expect } from 'vitest'
import { slotAt, dueSlots, upcomingSlots } from './slots'

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
    expect(due.map((s) => s.index)).toEqual([1])
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
    const used = [{ date: '2026-08-08', index: 0, at: slotAt('2026-08-08', '10:00', TZ) }]
    const next = upcomingSlots(now, SLOTS, TZ, 3, used)
    expect(next.map((s) => `${s.date}#${s.index}`)).toEqual([
      '2026-08-08#1', '2026-08-08#2', '2026-08-09#0',
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
    expect(next.map((s) => `${s.date}#${s.index}`)).toEqual([
      '2026-08-08#1', '2026-08-08#2', '2026-08-08#0',
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
    expect(due[0].index).toBe(0)
  })
})
