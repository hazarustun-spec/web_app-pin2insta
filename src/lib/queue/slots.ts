import { TZDate } from '@date-fns/tz'

/**
 * One slot on one local date.
 *
 * `index` is the value stored in `items.slot_index` and is HALF OF THE UNIQUE
 * KEY that stops a day publishing twice — see `slotIndexFor` for why it is
 * minutes-since-midnight rather than a position in the settings array.
 */
export type SlotRef = { date: string; time: string; index: number; at: Date }

const DAY_MS = 86_400_000

/**
 * A slot's identity within its date: minutes since local midnight.
 *
 * THIS IS THE FIX FOR A DOUBLE POST, and it is worth spelling out. The unique
 * index `items_slot_unique_idx` is on (posted_date, slot_index), so slot_index
 * is what "this slot has already published" means. Deriving it from the slot's
 * POSITION in the settings array — as the plan did — makes that identity depend
 * on a value the owner can edit at any moment:
 *
 *   today's slots are ['10:00','14:00','20:00'] and the 10:00 post has gone out
 *   as index 0. The owner adds an earlier time. The array is now
 *   ['09:00','10:00','14:00','20:00'], so index 0 means 09:00 and 10:00 has
 *   become index 1. The "is this slot filled?" read looks for (today, 1),
 *   finds nothing, and the queue posts again minutes after the real post.
 *
 * Removing or reordering a slot has the same shape. Minutes-since-midnight is
 * intrinsic to the slot: 10:00 is 600 whatever else is in the array, so adding,
 * removing and reordering slots cannot renumber a slot that has already
 * published. The range is 0-1439, which fits the existing integer column, so
 * this needs no schema change.
 *
 * Callers pass a time that `resolveSettings`/`resolveViewSettings` has already
 * validated as `HH:MM`; anything else yields NaN rather than a wrong number.
 */
export function slotIndexFor(time: string): number {
  const [hh, mm] = time.split(':').map(Number)
  return hh * 60 + mm
}

/** The calendar date in `timeZone` at instant `now`, as `YYYY-MM-DD`. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/** The UTC instant of local wall-clock `time` on `dateISO` in `timeZone`. */
export function slotAt(dateISO: string, time: string, timeZone: string): Date {
  const [y, m, d] = dateISO.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  return new Date(TZDate.tz(timeZone, y, m - 1, d, hh, mm, 0, 0).getTime())
}

function refsForDate(dateISO: string, slots: string[], timeZone: string): SlotRef[] {
  return slots.map((time) => ({
    date: dateISO,
    time,
    index: slotIndexFor(time),
    at: slotAt(dateISO, time, timeZone),
  }))
}

/**
 * Slots that have arrived but are not yet stale. A slot older than
 * `graceMinutes` is missed for good — catching up would post twice in an hour.
 */
export function dueSlots(now: Date, slots: string[], timeZone: string, graceMinutes = 90): SlotRef[] {
  const today = localDate(now, timeZone)
  const yesterday = localDate(new Date(now.getTime() - DAY_MS), timeZone)
  const grace = graceMinutes * 60_000
  return [...refsForDate(yesterday, slots, timeZone), ...refsForDate(today, slots, timeZone)]
    .filter((s) => now >= s.at && now.getTime() - s.at.getTime() <= grace)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
}

/** The next `count` slots strictly after `now`, excluding any in `used`. */
export function upcomingSlots(
  now: Date, slots: string[], timeZone: string, count: number, used: SlotRef[] = [],
): SlotRef[] {
  const taken = new Set(used.map((s) => `${s.date}#${s.index}`))
  const out: SlotRef[] = []
  let cursor = now
  for (let day = 0; day < 400 && out.length < count; day++) {
    const dateISO = localDate(cursor, timeZone)
    const daySlots = refsForDate(dateISO, slots, timeZone).sort((a, b) => a.at.getTime() - b.at.getTime())
    for (const s of daySlots) {
      if (out.length >= count) break
      if (s.at <= now) continue
      if (taken.has(`${s.date}#${s.index}`)) continue
      out.push(s)
    }
    cursor = new Date(cursor.getTime() + DAY_MS)
  }
  return out
}
