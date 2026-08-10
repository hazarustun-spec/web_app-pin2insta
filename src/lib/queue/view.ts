import {
  dueState, localDate, localTime, scheduledRef, slotAt, startOfMinute, upcomingSlots,
  type SlotRef,
} from './slots'
import { isPinUrl } from '../pinterest'

/**
 * Pure view logic for the queue page.
 *
 * Everything the page decides — what a card's slot label says, which banner
 * fires, where focus goes next, what a dropped file is called in staging, what
 * the reorder payload is — lives here so it can be unit-tested in the node
 * environment without a DOM stack.
 *
 * IMPORTANT: this module is imported by client components, so it may only
 * import browser-safe code. `./slots` (which pulls `@date-fns/tz`) and `../pinterest`
 * (deliberately free of Node APIs) qualify;
 * `./repo` and `./publish` do not — they reach for the database, `sharp` and
 * the Blob SDK.
 */

export type ViewSettings = { slots: string[]; timezone: string; hashtags: string }

/**
 * The `settings` table's own column defaults. Repeated here rather than
 * imported from `publish.ts` because that module pulls the database and sharp
 * into whatever imports it, and this one runs in the browser.
 */
export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  slots: ['10:00', '14:00', '20:00'],
  timezone: 'Europe/Istanbul',
  hashtags: '',
}

/**
 * Mirrors `MAX_CAPTION_CHARS` in repo.ts and the limit `validate()` enforces —
 * repeated for the same reason as the defaults above.
 */
export const MAX_CAPTION_CHARS = 2200

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Settings the page can render on, from whatever `/api/settings` returned.
 *
 * The realistic inputs are a real row, `undefined` (the fetch failed), and an
 * error body. A malformed slot time makes `slotAt` produce an Invalid Date and
 * a bad timezone makes it throw, either of which would take the whole page
 * down, so each field falls back independently.
 */
export function resolveViewSettings(raw: unknown): ViewSettings {
  const row = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    slots?: unknown
    timezone?: unknown
    hashtags?: unknown
  }
  const slots = row.slots
  const timezone = row.timezone
  const hashtags = row.hashtags
  return {
    hashtags: typeof hashtags === 'string' ? hashtags : DEFAULT_VIEW_SETTINGS.hashtags,
    slots:
      Array.isArray(slots) &&
      slots.length > 0 &&
      slots.every((s) => typeof s === 'string' && TIME_RE.test(s))
        ? (slots as string[])
        : DEFAULT_VIEW_SETTINGS.slots,
    timezone:
      typeof timezone === 'string' && timezone !== '' && isKnownTimeZone(timezone)
        ? timezone
        : DEFAULT_VIEW_SETTINGS.timezone,
  }
}

// ---------------------------------------------------------------------------
// Staging pathnames
// ---------------------------------------------------------------------------

/**
 * `app/api/blob/upload/route.ts` signs the caller's pathname into the client
 * token verbatim and answers 400 for anything outside
 * `/^tmp\/[A-Za-z0-9._-]{1,160}$/`. A real filename almost never matches:
 * spaces, parentheses and every Turkish diacritic are outside the class, and
 * percent-encoding does not help because `%` is outside it too. So the staging
 * name is generated, and the human-readable label travels separately in the
 * `name` field of the `/api/items` body, which has no such constraint.
 */
const MAX_STAGING_NAME = 160
/** Long enough to stay readable in the Blob dashboard, short enough to leave room for the name. */
const MAX_STAGING_TOKEN = 32
/** `.jpeg` is the longest we expect; anything longer is treated as part of the name, not an extension. */
const MAX_EXT_CHARS = 5

/**
 * Turkish letters that Unicode decomposition does not fold to ASCII.
 * `ç ö ü ş ğ` decompose to a base letter plus a combining mark and are handled
 * by NFKD below; the dotless/dotted i pair does not decompose at all.
 */
const TR_FOLD: Record<string, string> = { ı: 'i', İ: 'I' }

/** A filename reduced to the characters the staging path regex accepts. Never empty. */
export function slugForStaging(name: string): string {
  // Windows and POSIX separators both, because `file.name` can carry a path
  // when a directory is dropped.
  const base = name.split(/[\\/]/).pop() ?? ''
  const folded = base
    .replace(/[ıİ]/g, (c) => TR_FOLD[c])
    .normalize('NFKD')
    // Strip the combining marks NFKD just separated out (ğ → g + U+0306).
    .replace(/[\u0300-\u036f]/g, '')
  const slug = folded
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|-+$/g, '')
  return slug === '' ? 'image' : slug
}

/** Trims `slug` to `room` characters, keeping its extension so the Blob dashboard stays readable. */
function trimKeepingExtension(slug: string, room: number): string {
  if (slug.length <= room) return slug
  const dot = slug.lastIndexOf('.')
  const ext = dot > 0 && slug.length - dot - 1 <= MAX_EXT_CHARS ? slug.slice(dot) : ''
  // `|| 'image'` covers a room so small that nothing but the extension fits.
  return (slug.slice(0, Math.max(room - ext.length, 0)).replace(/-+$/, '') || 'image').slice(0, room) + ext
}

/**
 * The `tmp/` pathname for one staged upload.
 *
 * `token` is a per-file random string supplied by the caller: two drops of the
 * same picture must not collide, and the caller owns randomness so this stays
 * pure and testable.
 *
 * The result is at most 164 characters. The Blob API then lengthens the stored
 * pathname by roughly 31 more (`addRandomSuffix: true`), and `STAGED_PATH` in
 * repo.ts allows 200 after `tmp/` — so 160 + 31 stays inside the ingest guard.
 */
export function stagingPathname(name: string, token: string): string {
  const t = slugForStaging(token).slice(0, MAX_STAGING_TOKEN)
  const room = MAX_STAGING_NAME - t.length - 1
  return `tmp/${t}-${trimKeepingExtension(slugForStaging(name), room)}`
}

// ---------------------------------------------------------------------------
// The queue as the page sees it
// ---------------------------------------------------------------------------

/**
 * The fields of a `listQueue` row this page actually reads. Structural, not
 * imported from repo.ts, because that module cannot be loaded in the browser
 * and because the row arrives here as JSON (dates already strings).
 */
export type ViewItem = {
  id: string
  kind: 'feed' | 'carousel' | 'story'
  caption: string
  status: 'pending' | 'posted' | 'failed'
  attempts: number
  error: string | null
  postedDate: string | null
  slotIndex: number | null
  /**
   * The owner's own time for this post as an ISO string, or null for "use the
   * next free slot".
   *
   * A STRING, not a Date, because this row reaches the page two ways — the
   * server component reads it from Drizzle and `load()` refetches it as JSON —
   * and only one of those can carry a Date. `app/page.tsx` converts on the way
   * in so the two agree; `chosenTimeFor` is the only thing that reads it.
   */
  scheduledAt: string | null
  images: { url: string }[]
}

/** A story publishes without a caption; everything else is refused by `selectForSlot`. */
export function needsCaption(item: Pick<ViewItem, 'kind' | 'caption'>): boolean {
  return item.kind !== 'story' && item.caption.trim() === ''
}

/**
 * The caption as Instagram will see it. Mirrors `withHashtags` in publish.ts,
 * which composes the string that is actually posted; that module cannot be
 * imported here because it pulls the database and sharp into the browser bundle.
 */
export function composedCaption(caption: string, hashtags: string): string {
  const tags = hashtags.trim()
  const base = caption.trim()
  if (!tags) return base
  if (!base) return tags
  return `${base}\n\n${tags}`
}

/**
 * True when the fixed hashtag block pushes this caption past Instagram's 2200
 * characters.
 *
 * `selectForSlot` stops the queue dead at such an item — exactly like a missing
 * caption, and for the same reason: it never steps past the head. Until this
 * existed the page could not see it, because `ViewSettings` carried no
 * `hashtags` field, so the owner saw a caption comfortably under the limit in
 * the editor and a queue that had silently stopped.
 */
export function captionTooLong(
  item: Pick<ViewItem, 'caption'>, hashtags: string,
): boolean {
  return composedCaption(item.caption, hashtags).length > MAX_CAPTION_CHARS
}

/** Every reason `selectForSlot` refuses an item and leaves the slot empty. */
export function blocksQueue(
  item: Pick<ViewItem, 'kind' | 'caption'>, settings: ViewSettings,
): boolean {
  return needsCaption(item) || captionTooLong(item, settings.hashtags)
}

/**
 * True for the state Task 8 calls `posted-unrecorded`: Instagram accepted the
 * post but the row could not be updated to say so, leaving the slot claim
 * (`postedDate`/`slotIndex`) written while `status` is still `pending`.
 *
 * `runSlot` selects candidates with `isNull(items.postedDate)`, so such a row
 * is invisible to the publisher forever, and `listQueue` still returns it —
 * an ordinary-looking pending card that will never go out. It must be named.
 */
export function isUnrecorded(item: Pick<ViewItem, 'status' | 'postedDate'>): boolean {
  return item.status === 'pending' && item.postedDate !== null
}

/** True for an item some future publish — a slot or its own time — will reach. */
export function awaitsSlot(item: Pick<ViewItem, 'status' | 'postedDate'>): boolean {
  return item.status === 'pending' && item.postedDate === null
}

// ---------------------------------------------------------------------------
// A time the owner chose for one post (Task 14)
// ---------------------------------------------------------------------------

/**
 * The instant this item was scheduled for, or null for "use the next free slot".
 *
 * Returns null rather than an Invalid Date for anything unreadable, exactly as
 * the publisher does: the column is a plain nullable timestamp, and an Invalid
 * Date reaching `localDate` throws RangeError — here that would blank the whole
 * queue page rather than one card's label.
 */
export function chosenTimeFor(item: Pick<ViewItem, 'scheduledAt'>): Date | null {
  if (typeof item.scheduledAt !== 'string' || item.scheduledAt === '') return null
  const at = new Date(item.scheduledAt)
  return Number.isNaN(at.getTime()) ? null : at
}

/** True for an item that publishes at its own time rather than in the next free slot. */
export function hasChosenTime(item: Pick<ViewItem, 'scheduledAt'>): boolean {
  return chosenTimeFor(item) !== null
}

/** True for an item a future SLOT will be spent on — which excludes the ones with their own time. */
export function usesSlot(item: Pick<ViewItem, 'status' | 'postedDate' | 'scheduledAt'>): boolean {
  return awaitsSlot(item) && !hasChosenTime(item)
}

/**
 * The claim a chosen time makes: `${local date}#${minute of that day}`.
 *
 * This is the key of `items_slot_unique_idx` written down. Two items on the
 * same key are ONE claim and only one of them can publish, so the page refuses
 * the second before it is saved rather than letting the publisher discover it
 * at the minute itself and report `race-lost`.
 */
export function scheduleKeyFor(at: Date, timeZone: string): string {
  const ref = scheduledRef(at, timeZone)
  return `${ref.date}#${ref.index}`
}

/**
 * Every minute already spoken for by another card: the times other items carry,
 * plus the claims held by rows that have already taken one (a posted-unrecorded
 * row still holds its slot).
 *
 * `exceptId` is the card being edited — moving it to the minute it already has
 * must not be refused as a collision with itself.
 */
export type ScheduleRow = Pick<ViewItem, 'id' | 'status' | 'postedDate' | 'slotIndex' | 'scheduledAt'>

export function takenScheduleKeys(
  items: ScheduleRow[], timeZone: string, exceptId?: string,
): Set<string> {
  const keys = new Set<string>()
  for (const i of items) {
    if (i.id === exceptId) continue
    if (i.postedDate !== null && i.slotIndex !== null) keys.add(`${i.postedDate}#${i.slotIndex}`)
    if (!awaitsSlot(i)) continue
    const at = chosenTimeFor(i)
    if (at) keys.add(scheduleKeyFor(at, timeZone))
  }
  return keys
}

/**
 * Why this time cannot be saved, in Turkish, or null.
 *
 * Exported so the card and `setScheduledAt` refuse with the SAME test. The
 * server is the authority — a stale page cannot see a minute another tab just
 * took — but the two must agree, or the owner is told one thing by the control
 * and another by the response.
 */
export function scheduleProblem(
  at: Date, now: Date, taken: Set<string>, timeZone: string,
): string | null {
  if (Number.isNaN(at.getTime())) return 'geçersiz tarih veya saat'
  // Compared minute to minute: the minute that is running right now is still
  // ahead of the next cron tick, so it is a legitimate choice.
  if (startOfMinute(at).getTime() < startOfMinute(now).getTime()) {
    return 'geçmiş bir saat seçilemez'
  }
  if (taken.has(scheduleKeyFor(at, timeZone))) return 'bu dakika dolu — başka bir saat seçin'
  return null
}

/** `YYYY-MM-DDTHH:MM` in the configured zone — what a `datetime-local` input shows. */
export function scheduleInputValue(iso: string | null, timeZone: string): string {
  const at = chosenTimeFor({ scheduledAt: iso })
  if (!at) return ''
  return `${localDate(at, timeZone)}T${localTime(at, timeZone)}`
}

const INPUT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/**
 * The instant `YYYY-MM-DDTHH:MM` names IN THE CONFIGURED ZONE, or null.
 *
 * Not `new Date(value)`, which reads the string in the BROWSER's zone: the
 * owner types the time their account posts at, and a laptop in another country
 * would silently shift every post they schedule.
 *
 * The range check is a round-trip rather than a set of bounds, because
 * `TZDate` rolls over rather than refusing — month 13 becomes January, and
 * 24:00 becomes midnight the next day. Anything that does not come back
 * unchanged was not the time the caller wrote.
 */
export function parseScheduleInput(value: string, timeZone: string): Date | null {
  if (!INPUT_RE.test(value)) return null
  const [date, time] = value.split('T')
  const at = slotAt(date, time, timeZone)
  if (Number.isNaN(at.getTime())) return null
  return localDate(at, timeZone) === date && localTime(at, timeZone) === time ? at : null
}

/** What to send for a `datetime-local` value, or the sentence to show instead. */
export type ScheduleChoice = { scheduledAt: string | null } | { error: string }

/**
 * The whole decision the date-and-time control makes, as a pure function: what
 * to PATCH, or what to refuse and why.
 *
 * Lives here rather than in the component so it can be tested in the node
 * environment the rest of this module is, and so the three outcomes — clear it,
 * send it, refuse it — are one thing to read.
 */
export function chooseSchedule(
  value: string, timeZone: string, now: Date, taken: Set<string>,
): ScheduleChoice {
  // An empty control means "no time of my own": back to the next free slot.
  if (value === '') return { scheduledAt: null }
  const at = parseScheduleInput(value, timeZone)
  if (!at) return { error: 'geçersiz tarih veya saat' }
  const problem = scheduleProblem(at, now, taken, timeZone)
  return problem ? { error: problem } : { scheduledAt: at.toISOString() }
}

/** Exported so the published-history page names months the same way this one does. */
export const MONTHS_TR = [
  'Oca', 'Şub', 'Mar', 'Nis', 'May', 'Haz',
  'Tem', 'Ağu', 'Eyl', 'Eki', 'Kas', 'Ara',
]

const DAY_MS = 86_400_000

/**
 * "Bugün 14:00" / "Yarın 10:00" / "12 Ağu 20:00".
 *
 * The time comes from the settings row rather than from formatting `slot.at`,
 * because that is the string the owner typed and it needs no ICU data or
 * timezone round-trip to render exactly.
 */
export function labelForSlot(slot: SlotRef, settings: ViewSettings, now: Date): string {
  // From the slot itself, not `settings.slots[slot.index]`: `index` is now
  // minutes-since-midnight (see slotIndexFor), so indexing the array with it
  // would read past the end of a three-element list.
  const time = slot.time
  const today = localDate(now, settings.timezone)
  const tomorrow = localDate(new Date(now.getTime() + DAY_MS), settings.timezone)
  if (slot.date === today) return `Bugün ${time}`.trim()
  if (slot.date === tomorrow) return `Yarın ${time}`.trim()
  const [year, month, day] = slot.date.split('-')
  // The year appears only when it is not the current one. A datetime-local
  // year spinner makes 2260 a plausible slip, and without the year the card
  // reads "20 Ağu 14:00" — indistinguishable from this year. The post would
  // then sit there forever: never due, so never missed, so no banner. Showing
  // the year is what makes that mistake visible.
  const showYear = year !== today.slice(0, 4)
  const date = `${Number(day)} ${MONTHS_TR[Number(month) - 1]}${showYear ? ` ${year}` : ''}`
  return `${date} ${time}`.trim()
}

/**
 * What one card says about when it goes out.
 *
 * `kind` distinguishes the two, because they are not the same promise: a slot
 * is computed and moves as the queue in front of it changes, while a chosen
 * time is the owner's and does not. `warn` marks a time that will NOT produce
 * a post — one that has gone by, or one whose caption the publisher refuses.
 */
export type CardTime = { text: string; kind: 'slot' | 'scheduled'; warn: boolean }

/** Why a chosen time will pass unused, in the words the card shows. */
function unusableReason(item: ViewItem, settings: ViewSettings): string | null {
  if (needsCaption(item)) return 'açıklama yok, boş geçecek'
  if (captionTooLong(item, settings.hashtags)) return 'açıklama çok uzun, boş geçecek'
  return null
}

/**
 * When each item goes out, by id.
 *
 * Two kinds of entry, and the card has to be able to tell them apart:
 *
 * - an item carrying its own time gets THAT time, whatever the queue in front
 *   of it is doing. It is not a blockage for anything else, because the
 *   publisher never considers it for a slot;
 * - everything else gets the next free slot, in queue order, exactly as before.
 *   Slots are handed out up to the first item that cannot use one: an
 *   uncaptioned item does not yield its turn — selectForSlot leaves the slot
 *   empty and meets the same item at the head next tick — so nothing behind it
 *   has a knowable time, and promising one would be a lie the owner acts on.
 *
 * Items no publish will ever reach — `failed`, and posted-unrecorded — get no
 * entry at all.
 */
export function cardTimes(
  items: ViewItem[], settings: ViewSettings, now: Date,
): Map<string, CardTime> {
  const waiting = items.filter(awaitsSlot)
  const out = new Map<string, CardTime>()

  // The minutes the chosen times have taken. Passed to upcomingSlots so the
  // page does not promise a slot minute an item has already claimed for
  // itself — the publisher would report that slot `already-filled`.
  const claimed: SlotRef[] = []
  for (const item of waiting) {
    const at = chosenTimeFor(item)
    if (!at) continue
    const ref = scheduledRef(at, settings.timezone)
    claimed.push(ref)
    const when = labelForSlot(ref, settings, now)
    const missed = dueState(ref.at, now) === 'missed'
    const unusable = unusableReason(item, settings)
    out.set(item.id, {
      // A missed time is stated first: it already happened, so what the caption
      // would have done no longer matters.
      text: `${when} · ${missed ? 'saati geçti, paylaşılmadı' : unusable ?? 'seçilen saat'}`,
      kind: 'scheduled',
      warn: missed || unusable !== null,
    })
  }

  const queued = waiting.filter((i) => !hasChosenTime(i))
  const blocked = queued.findIndex((i) => blocksQueue(i, settings))
  const schedulable = blocked === -1 ? queued : queued.slice(0, blocked + 1)
  const slots = upcomingSlots(now, settings.slots, settings.timezone, schedulable.length, claimed)
  schedulable.forEach((item, i) => {
    const slot = slots[i]
    // upcomingSlots looks 400 days ahead and no further, so a queue longer than
    // that leaves the tail unlabelled rather than mislabelled.
    if (slot) out.set(item.id, { text: labelForSlot(slot, settings, now), kind: 'slot', warn: false })
  })
  // The blocking item itself has no time either: its slot is skipped.
  if (blocked !== -1) out.delete(schedulable[blocked].id)
  return out
}

export type QueueStatus = {
  /** Items a future SLOT will be spent on — not the ones carrying their own time. */
  waiting: number
  /** Items that publish at a time the owner chose, and whose time is still ahead. */
  scheduledWaiting: number
  /**
   * Items whose chosen time went by with nothing posted.
   *
   * Not `failed` — nothing was attempted — and not an ordinary pending card
   * either, because its time has gone and a missed time does not roll forward.
   * Invisible unless it is named.
   */
  missedIds: string[]
  /**
   * Items whose chosen time is still ahead but which the publisher will refuse
   * when it arrives: no caption, or a caption the hashtag block pushes over
   * 2200. Their time passes unused and no slot is spent instead.
   */
  scheduledBlocked: number
  /** Whole days of posting left at the configured rate. */
  daysLeft: number
  /** Uncaptioned items a slot would otherwise be spent on. */
  missingCaptions: number
  /**
   * Items whose caption plus the FIXED HASHTAG BLOCK exceeds Instagram's 2200
   * characters. Counted separately because the item looks fine in the editor —
   * the characters that break it come from the settings screen.
   */
  captionsTooLong: number
  /**
   * The head item, when it cannot publish. This is the state that matters:
   * `selectForSlot` only ever looks at the head and deliberately never skips
   * past it, so one bad card at position 1 stops every slot.
   */
  headBlockedId: string | null
  /** Why the head is blocked, so the banner can say the right sentence. */
  headBlockedReason: 'missing-caption' | 'caption-too-long' | null
  /** Items Instagram already has but the database does not know about. */
  unrecordedIds: string[]
  /** Items that used all three attempts. */
  failedIds: string[]
}

export function queueStatus(
  items: ViewItem[], settings: ViewSettings, now: Date,
): QueueStatus {
  // The slot queue and the chosen-time set are counted apart all the way down.
  // An uncaptioned item with its own time is a real problem, but it is NOT the
  // one the head-blocked banner describes: the publisher never looks at it for
  // a slot, so it stops nothing behind it.
  const queued = items.filter(usesSlot)
  const chosen = items.filter((i) => awaitsSlot(i) && hasChosenTime(i))
  const missed = chosen.filter((i) => dueState(chosenTimeFor(i)!, now) === 'missed')
  const upcoming = chosen.filter((i) => dueState(chosenTimeFor(i)!, now) !== 'missed')
  const head = queued[0]
  const headReason: QueueStatus['headBlockedReason'] =
    !head ? null
      : needsCaption(head) ? 'missing-caption'
        : captionTooLong(head, settings.hashtags) ? 'caption-too-long'
          : null
  return {
    waiting: queued.length,
    scheduledWaiting: upcoming.length,
    missedIds: missed.map((i) => i.id),
    scheduledBlocked: upcoming.filter((i) => blocksQueue(i, settings)).length,
    daysLeft: Math.floor(queued.length / Math.max(settings.slots.length, 1)),
    missingCaptions: queued.filter(needsCaption).length,
    captionsTooLong: queued.filter((i) => captionTooLong(i, settings.hashtags)).length,
    headBlockedId: headReason ? head.id : null,
    headBlockedReason: headReason,
    unrecordedIds: items.filter(isUnrecorded).map((i) => i.id),
    failedIds: items.filter((i) => i.status === 'failed').map((i) => i.id),
  }
}

/**
 * The next card `⌘↵` should jump to: the first uncaptioned item AFTER `afterId`.
 *
 * Deliberately does not wrap around. Captioning runs top to bottom, and
 * bouncing back to the top after the last card would silently re-edit a card
 * the owner had already passed.
 */
export function nextCaptionlessId(items: ViewItem[], afterId: string): string | null {
  const from = items.findIndex((i) => i.id === afterId)
  return items.slice(from + 1).find((i) => needsCaption(i) && awaitsSlot(i))?.id ?? null
}

/**
 * The id order after dragging `dragId` onto `overId`.
 *
 * `applyOrder` requires the ENTIRE non-posted queue in the new order and
 * refuses a subset, so this returns the whole list. `listQueue` returns exactly
 * that set, which is why the page can pass its own ids straight through.
 *
 * Returns the input array itself (not a copy) when nothing moves, so the caller
 * can skip the request with `next === ids`.
 */
export function moveId(ids: string[], dragId: string, overId: string): string[] {
  if (dragId === overId) return ids
  const from = ids.indexOf(dragId)
  const to = ids.indexOf(overId)
  if (from < 0 || to < 0) return ids
  const next = [...ids]
  next.splice(from, 1)
  next.splice(to, 0, dragId)
  return next
}

// ---------------------------------------------------------------------------
// Upload feedback
// ---------------------------------------------------------------------------

/**
 * Mirrors `ALLOWED_CONTENT_TYPES` in `app/api/blob/upload/route.ts`. Checked
 * here only so a refused file says why immediately instead of after a round
 * trip; the decoder in `cropTo45` is the authority, since `file.type` is
 * client-supplied and never checked against the bytes.
 */
export const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif']
/** Mirrors `MAX_UPLOAD_BYTES` in the token route — a larger file cannot be staged at all. */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024
/** Mirrors `MAX_BATCH_FILES` in `app/api/items/route.ts`, which answers 413 above it. */
export const MAX_INGEST_BATCH = 50

/** Why this file cannot be uploaded, in Turkish, or null if it can. */
export function screenFile(file: { type: string; size: number }): string | null {
  if (!UPLOAD_TYPES.includes(file.type)) return 'desteklenmeyen dosya türü'
  if (file.size > MAX_UPLOAD_BYTES) return 'dosya çok büyük — en fazla 25MB olmalı'
  return null
}

/** Splits a drop into requests `/api/items` will accept. A 51st file in one body is a 413. */
export function chunk<T>(xs: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size))
  return out
}

export type UploadResult =
  | { status: 'added'; name: string }
  | { status: 'duplicate'; name: string }
  | { status: 'error'; name: string; message?: string }

export type Note = { tone: 'info' | 'error'; text: string }

/** Beyond this many duplicates, naming each one buries everything else. */
const MAX_NAMED_DUPLICATES = 3
/** Errors are named individually because each carries its own reason; past this they are counted. */
const MAX_NAMED_ERRORS = 10

/**
 * What to tell the owner after a drop.
 *
 * Every per-file outcome is reported, not just duplicates: a file that vanishes
 * with no explanation is worse than one that says why it was refused.
 */
export function describeUploadResults(results: UploadResult[]): Note[] {
  const added = results.filter((r) => r.status === 'added').length
  const duplicates = results.filter((r) => r.status === 'duplicate')
  const errors = results.filter((r): r is UploadResult & { status: 'error' } => r.status === 'error')

  const notes: Note[] = []
  if (added > 0) notes.push({ tone: 'info', text: `${added} görsel eklendi` })
  if (duplicates.length > 0) {
    notes.push(
      duplicates.length > MAX_NAMED_DUPLICATES
        ? { tone: 'info', text: `${duplicates.length} görsel zaten kuyrukta` }
        : { tone: 'info', text: `${duplicates.map((d) => d.name).join(', ')} zaten var` },
    )
  }
  for (const e of errors.slice(0, MAX_NAMED_ERRORS)) {
    notes.push({ tone: 'error', text: `${e.name}: ${e.message ?? 'yüklenemedi'}` })
  }
  if (errors.length > MAX_NAMED_ERRORS) {
    notes.push({ tone: 'error', text: `ve ${errors.length - MAX_NAMED_ERRORS} dosya daha yüklenemedi` })
  }
  return notes
}

// ---------------------------------------------------------------------------
// Paste-to-ingest (Task 11)
// ---------------------------------------------------------------------------

/**
 * True when a paste belongs to whatever the owner is typing in.
 *
 * The Pinterest paste listener is on `window`, so it fires for every paste on
 * the page. Without this, pasting a pin link into a caption box would ingest
 * the pin INSTEAD of pasting the text — the caption would silently not receive
 * what the owner pasted.
 *
 * Duck-typed rather than `instanceof HTMLElement` so it can be tested in the
 * node environment the rest of this module is tested in.
 */
export function isTypingTarget(target: unknown): boolean {
  if (typeof target !== 'object' || target === null) return false
  const el = target as {
    tagName?: unknown
    isContentEditable?: unknown
    closest?: (selector: string) => unknown
  }
  if (el.isContentEditable === true) return true
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  // A paste inside a rich-text area can land on a child node whose own
  // isContentEditable is not set.
  if (typeof el.closest === 'function') {
    return el.closest('[contenteditable]:not([contenteditable="false"])') != null
  }
  return false
}

/**
 * The pin URL in a pasted clipboard string, or null.
 *
 * Deliberately the SAME guard the route applies (`isPinUrl`), not a loose
 * `/pinterest\./` test: a lookalike host like `pinterest.com.evil.com` should
 * not even produce a request, and a paste that merely mentions Pinterest in a
 * sentence is text, not a link.
 */
export function pastedPinUrl(text: string): string | null {
  const trimmed = text.trim()
  return isPinUrl(trimmed) ? trimmed : null
}
