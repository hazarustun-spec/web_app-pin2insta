import { TZDate } from '@date-fns/tz'

export type SlotRef = { date: string; index: number; at: Date }

const DAY_MS = 86_400_000

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
  return slots.map((time, index) => ({ date: dateISO, index, at: slotAt(dateISO, time, timeZone) }))
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
    for (const s of refsForDate(dateISO, slots, timeZone)) {
      if (out.length >= count) break
      if (s.at <= now) continue
      if (taken.has(`${s.date}#${s.index}`)) continue
      out.push(s)
    }
    cursor = new Date(cursor.getTime() + DAY_MS)
  }
  return out
}
