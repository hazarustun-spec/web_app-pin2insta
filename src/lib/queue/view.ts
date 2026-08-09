import { localDate, upcomingSlots, type SlotRef } from './slots'

/**
 * Pure view logic for the queue page.
 *
 * Everything the page decides — what a card's slot label says, which banner
 * fires, where focus goes next, what a dropped file is called in staging, what
 * the reorder payload is — lives here so it can be unit-tested in the node
 * environment without a DOM stack.
 *
 * IMPORTANT: this module is imported by client components, so it may only
 * import browser-safe code. `./slots` (which pulls `@date-fns/tz`) qualifies;
 * `./repo` and `./publish` do not — they reach for the database, `sharp` and
 * the Blob SDK.
 */

export type ViewSettings = { slots: string[]; timezone: string }

/**
 * The `settings` table's own column defaults. Repeated here rather than
 * imported from `publish.ts` because that module pulls the database and sharp
 * into whatever imports it, and this one runs in the browser.
 */
export const DEFAULT_VIEW_SETTINGS: ViewSettings = {
  slots: ['10:00', '14:00', '20:00'],
  timezone: 'Europe/Istanbul',
}

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
 * That route does not exist yet (Task 10 owns it), so the realistic inputs are
 * a 404 body, `undefined`, and — once it lands — a real row. A malformed slot
 * time makes `slotAt` produce an Invalid Date and a bad timezone makes it
 * throw, either of which would take the whole page down, so each field falls
 * back independently.
 */
export function resolveViewSettings(raw: unknown): ViewSettings {
  const row = (typeof raw === 'object' && raw !== null ? raw : {}) as {
    slots?: unknown
    timezone?: unknown
  }
  const slots = row.slots
  const timezone = row.timezone
  return {
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
  images: { url: string }[]
}

/** A story publishes without a caption; everything else is refused by `selectForSlot`. */
export function needsCaption(item: Pick<ViewItem, 'kind' | 'caption'>): boolean {
  return item.kind !== 'story' && item.caption.trim() === ''
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

/** True for an item a future slot will actually be spent on. */
export function awaitsSlot(item: Pick<ViewItem, 'status' | 'postedDate'>): boolean {
  return item.status === 'pending' && item.postedDate === null
}

const MONTHS_TR = [
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
  const time = settings.slots[slot.index] ?? ''
  const today = localDate(now, settings.timezone)
  const tomorrow = localDate(new Date(now.getTime() + DAY_MS), settings.timezone)
  if (slot.date === today) return `Bugün ${time}`.trim()
  if (slot.date === tomorrow) return `Yarın ${time}`.trim()
  const [, month, day] = slot.date.split('-')
  return `${Number(day)} ${MONTHS_TR[Number(month) - 1]} ${time}`.trim()
}

/**
 * When each item goes out, by id.
 *
 * Slots are handed to items in queue order, up to the first item that cannot
 * use one. An uncaptioned item does not yield its turn — selectForSlot leaves
 * the slot empty and meets the same item at the head next tick — so nothing
 * behind it has a knowable time and this returns no label for it or for
 * anything after it. Items that are `failed` or posted-unrecorded are not
 * blockages: no slot is spent on them either, so labelling continues past.
 *
 * Items that no slot will ever be spent on — `failed`, and `posted-unrecorded`
 * — are skipped entirely and get no entry.
 */
export function slotLabels(
  items: ViewItem[], settings: ViewSettings, now: Date,
): Map<string, string> {
  const waiting = items.filter(awaitsSlot)
  // An uncaptioned item does not yield its turn — selectForSlot leaves the slot
  // empty and finds the same item at the head on the next tick. So nothing
  // below it has a knowable time, and promising one would be a lie the owner
  // acts on. Label up to the blockage and no further.
  const blocked = waiting.findIndex(needsCaption)
  const schedulable = blocked === -1 ? waiting : waiting.slice(0, blocked + 1)
  const slots = upcomingSlots(now, settings.slots, settings.timezone, schedulable.length)
  const out = new Map<string, string>()
  schedulable.forEach((item, i) => {
    const slot = slots[i]
    // upcomingSlots looks 400 days ahead and no further, so a queue longer than
    // that leaves the tail unlabelled rather than mislabelled.
    if (slot) out.set(item.id, labelForSlot(slot, settings, now))
  })
  // The blocking item itself has no time either: its slot is skipped.
  if (blocked !== -1) out.delete(schedulable[blocked].id)
  return out
}

export type QueueStatus = {
  /** Items a future slot will be spent on. */
  waiting: number
  /** Whole days of posting left at the configured rate. */
  daysLeft: number
  /** Uncaptioned items a slot would otherwise be spent on. */
  missingCaptions: number
  /**
   * The head item, when it is uncaptioned. This is the state that matters:
   * `selectForSlot` only ever looks at the head and deliberately never skips
   * past it, so one uncaptioned card at position 1 stops every slot.
   */
  headBlockedId: string | null
  /** Items Instagram already has but the database does not know about. */
  unrecordedIds: string[]
  /** Items that used all three attempts. */
  failedIds: string[]
}

export function queueStatus(items: ViewItem[], settings: ViewSettings): QueueStatus {
  const waiting = items.filter(awaitsSlot)
  const head = waiting[0]
  return {
    waiting: waiting.length,
    daysLeft: Math.floor(waiting.length / Math.max(settings.slots.length, 1)),
    missingCaptions: waiting.filter(needsCaption).length,
    headBlockedId: head && needsCaption(head) ? head.id : null,
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
