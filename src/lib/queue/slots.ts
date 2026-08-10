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

/** Minutes in a day. `slotIndexFor` can only ever produce 0-1439. */
const MINUTES_PER_DAY = 1440

/**
 * The inverse of `slotIndexFor`: the wall-clock time a stored `slot_index` means.
 *
 * Task 12 exists because `items.slot_index` is now a number nobody can read.
 * "slot 600" on the history page and "slot 600 is your weakest" in the
 * suggestion are both meaningless to the owner, who chose "10:00" — so every
 * place a slot is named goes through here and the raw integer never reaches a
 * screen.
 *
 * Returns null rather than a made-up time for a value outside 0-1439 or a
 * non-integer. `slot_index` is a plain nullable integer column, so a row
 * written by hand — or by the pre-Task-10 code, which stored a POSITION —
 * can hold anything; 1440 is not "24:00" and NaN is not "NaN:NaN".
 * (A legacy position of 0/1/2 is indistinguishable from 00:00/00:01/00:02 and
 * is rendered as such: this app has never run against a real account, so no
 * such row exists.)
 */
export function slotTimeFor(index: number): string | null {
  if (!Number.isInteger(index) || index < 0 || index >= MINUTES_PER_DAY) return null
  const hh = Math.floor(index / 60)
  const mm = index % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/** The calendar date in `timeZone` at instant `now`, as `YYYY-MM-DD`. */
export function localDate(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now)
}

/**
 * The wall-clock time in `timeZone` at instant `at`, as `HH:MM`.
 *
 * The inverse of `slotAt` for the minute half, exactly as `localDate` is for
 * the date half. `hourCycle: 'h23'` rather than `hour12: false`, which several
 * ICU versions render as `24:00` at local midnight — and 24*60 is not a
 * `slot_index` the unique key can hold.
 */
export function localTime(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at)
}

/**
 * `at` with its seconds and milliseconds dropped.
 *
 * A per-post time is stored to the minute because the minute is its IDENTITY:
 * `slot_index` is minutes since local midnight, so 14:35:00 and 14:35:30 are
 * the same claim. Truncating on the way in is what lets the queue page refuse
 * the collision before the publisher has to discover it.
 */
export function startOfMinute(at: Date): Date {
  return new Date(Math.floor(at.getTime() / 60_000) * 60_000)
}

/**
 * The claim a per-post scheduled time makes, in the same space a slot claims:
 * (local date, minutes since local midnight).
 *
 * This is deliberately not a second numbering scheme. `items_slot_unique_idx`
 * is on (posted_date, slot_index), so a scheduled post at 10:00 and the 10:00
 * slot are the SAME claim and cannot both publish — which is the property that
 * keeps "no daily cap" from meaning "two posts in the same minute".
 */
export function scheduledRef(at: Date, timeZone: string): SlotRef {
  const minute = startOfMinute(at)
  const time = localTime(minute, timeZone)
  return { date: localDate(minute, timeZone), time, index: slotIndexFor(time), at: minute }
}

/**
 * How long a slot — or a per-post time — stays due after it arrives.
 *
 * One constant, used by `dueSlots` and by `dueState`, because a scheduled time
 * that outlived a slot (or died before one) would be a second rule the owner
 * has to learn, and the report on the queue page would disagree with what the
 * publisher does.
 */
export const DUE_GRACE_MINUTES = 90

/**
 * Whether a per-post time has arrived, is still due, or has been missed.
 *
 * A missed time DOES NOT ROLL FORWARD, for the same reason a missed slot does
 * not: catching up hours late posts at a time the owner did not choose, and
 * several at once if the cron was down for a while.
 */
export function dueState(
  at: Date, now: Date, graceMinutes = DUE_GRACE_MINUTES,
): 'early' | 'due' | 'missed' {
  const delta = now.getTime() - at.getTime()
  if (delta < 0) return 'early'
  return delta <= graceMinutes * 60_000 ? 'due' : 'missed'
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
export function dueSlots(
  now: Date, slots: string[], timeZone: string, graceMinutes = DUE_GRACE_MINUTES,
): SlotRef[] {
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
