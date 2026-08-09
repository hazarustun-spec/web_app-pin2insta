import { eq } from 'drizzle-orm'
import { getDb } from '@/src/db'
import { settings } from '@/src/db/schema'
import {
  DEFAULT_SETTINGS,
  isKnownTimeZone,
  resolveSettings,
  type SchedulerSettings,
} from '@/src/lib/queue/publish'
import { MAX_CAPTION_CHARS } from '@/src/lib/queue/repo'
import { slotIndexFor } from '@/src/lib/queue/slots'

/**
 * The three things the owner can change: when the queue publishes, in which
 * timezone, and the hashtag block appended to every caption.
 *
 * Everything here is validated in ONE place — the route, the page and any
 * future caller all go through `saveSettings`, because every value on this
 * screen is consumed by an unattended cron run hours later. A typo in a
 * timezone or a stray character in a hashtag does not fail where the owner can
 * see it; it fails at 14:00 with nobody watching.
 */

/**
 * Thrown for a value the owner asked for and cannot have. Same contract as
 * `QueueError` and `IngestError`: its message is written for a human and is the
 * ONLY thing a route may echo back verbatim. Everything else — Drizzle and Neon
 * failures, which carry hostnames and connection strings — is logged
 * server-side and answered generically.
 */
export class SettingsError extends Error {}

// ---------------------------------------------------------------------------
// Slot times
// ---------------------------------------------------------------------------

/**
 * The ceiling on slot times per day.
 *
 * Instagram permits about 100 posts per 24 hours, so its own limit is no guide
 * here: this product posts three times a day from a queue a human fills by
 * hand. Twelve is already one post every two hours — past that the number is a
 * typo or a misunderstanding, not a preference, and the cost of accepting it is
 * a queue drained in a day and an account that reads as automated.
 */
export const MAX_SLOTS = 12

/** `H:MM` or `HH:MM`. The range check below is what rejects `24:00` and `09:60`. */
const TIME_RE = /^(\d{1,2}):(\d{2})$/

/**
 * The owner's slot times, normalised to zero-padded `HH:MM` and ordered by the
 * clock.
 *
 * ORDERING: the sort is numeric, on minutes since midnight, NOT
 * `Array.prototype.sort()`. Lexicographic ordering happens to be right for
 * zero-padded `HH:MM` and silently wrong for anything else, which makes the
 * correctness of the schedule depend on a detail of the normaliser three lines
 * above it. The comparator is `slotIndexFor` — the very number the database
 * uses to identify a slot — so the order and the identity cannot drift apart.
 */
export function validateSlots(slots: string[]): string[] {
  if (slots.length === 0) throw new SettingsError('en az bir saat gerekli')
  if (slots.length > MAX_SLOTS) {
    throw new SettingsError(`en fazla ${MAX_SLOTS} saat girilebilir`)
  }
  const normalised = slots.map((s) => {
    // Not just defensive: the value arrives as JSON from the browser, so a
    // number here is one `JSON.stringify` away and `s.trim()` would throw a
    // TypeError the route would report as a 500.
    if (typeof s !== 'string') throw new SettingsError('geçersiz saat')
    const m = TIME_RE.exec(s.trim())
    if (!m) throw new SettingsError(`geçersiz saat: ${s}`)
    const [h, min] = [Number(m[1]), Number(m[2])]
    if (h > 23 || min > 59) throw new SettingsError(`geçersiz saat: ${s}`)
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`
  })
  // After normalisation, so `9:00` and `09:00` are caught as the same time.
  if (new Set(normalised).size !== normalised.length) {
    throw new SettingsError('tekrar eden saat')
  }
  return normalised.sort((a, b) => slotIndexFor(a) - slotIndexFor(b))
}

// ---------------------------------------------------------------------------
// Timezone
// ---------------------------------------------------------------------------

/**
 * The timezone, checked against the runtime's own tz database.
 *
 * An unrecognised zone reaches `TZDate` inside the cron run, where it either
 * throws (killing the whole run) or shifts every slot by hours. Publishing is
 * unattended: nobody finds out until a day has gone by with nothing posted.
 * `isKnownTimeZone` is the scheduler's own check, imported rather than
 * re-written, so the two can never disagree.
 */
export function validateTimezone(timezone: string): string {
  const tz = typeof timezone === 'string' ? timezone.trim() : ''
  if (!tz || !isKnownTimeZone(tz)) throw new SettingsError('geçersiz saat dilimi')
  return tz
}

// ---------------------------------------------------------------------------
// Hashtags
// ---------------------------------------------------------------------------

/** Instagram's own ceiling: a post carrying more than 30 hashtags is rejected. */
export const MAX_HASHTAGS = 30

/**
 * The ceiling on the whole hashtag block.
 *
 * Instagram counts the hashtags inside the 2200-character caption limit, and
 * `withHashtags` appends the block to every caption. A block of 600 characters
 * — thirty tags averaging nineteen characters — still leaves 1598 for the
 * caption itself. Without a cap here the block alone can consume the entire
 * limit, and the symptom is `selectForSlot` refusing EVERY item in the queue
 * with `caption-too-long` at publish time.
 */
export const MAX_HASHTAG_CHARS = 600

/**
 * One hashtag's body, as Instagram accepts it: letters (Turkish included),
 * digits and underscores. Punctuation, `#` in the middle, and whitespace all
 * end a tag rather than living inside one.
 */
const TAG_RE = /^[\p{L}\p{N}_]{1,100}$/u

/**
 * The fixed hashtag block, normalised to `#tag #tag …`.
 *
 * CORRECTED silently: separators (a comma-separated list is what everyone
 * pastes), a missing `#`, repeated `#`, and any amount of whitespace.
 * REJECTED loudly: a tag Instagram would not accept, a duplicate, more than
 * thirty tags, and a block long enough to crowd out the caption. The
 * difference matters — a tag with a stray character does not fail at the API,
 * it posts as literal text in the caption of every single post.
 */
export function validateHashtags(raw: string): string {
  if (typeof raw !== 'string') throw new SettingsError('geçersiz hashtag')
  const tokens = raw.split(/[\s,;]+/).filter((t) => t !== '' && t !== '#')
  const tags: string[] = []
  const seen = new Set<string>()
  for (const token of tokens) {
    const body = token.replace(/^#+/, '')
    if (!TAG_RE.test(body)) throw new SettingsError(`geçersiz hashtag: ${token}`)
    const key = body.toLowerCase()
    if (seen.has(key)) throw new SettingsError(`tekrar eden hashtag: #${body}`)
    seen.add(key)
    tags.push(`#${body}`)
  }
  if (tags.length > MAX_HASHTAGS) {
    throw new SettingsError(`en fazla ${MAX_HASHTAGS} hashtag kullanılabilir`)
  }
  const block = tags.join(' ')
  if (block.length > MAX_HASHTAG_CHARS) {
    throw new SettingsError(
      `hashtag'ler en fazla ${MAX_HASHTAG_CHARS} karakter olabilir — ` +
        `açıklamayla birlikte ${MAX_CAPTION_CHARS} karakter sınırı var`,
    )
  }
  return block
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

export type SettingsPatch = { slots?: string[]; timezone?: string; hashtags?: string }

/**
 * The settings the app runs on, defaults included.
 *
 * NEVER returns undefined. The `settings` row does not exist until something
 * writes it, which on a new install is never — `db.select()` returns an empty
 * array and the plan's page called `.slots.join()` straight on it.
 * `resolveSettings` is the scheduler's own fallback, imported rather than
 * duplicated: if the two ever disagreed, this screen would show one schedule
 * while the cron ran another.
 */
export async function getSettings(): Promise<SchedulerSettings> {
  const [row] = await getDb().select().from(settings).where(eq(settings.id, 1))
  return resolveSettings(row)
}

/**
 * Writes the changed fields and returns the row as it now stands.
 *
 * UPSERT, not update. The plan ran `UPDATE ... WHERE id = 1` against a row
 * nothing has ever inserted: on a fresh install it matches zero rows, raises
 * nothing, and the screen reports success while the value is discarded. The
 * owner then watches the queue publish at the old times with no way to tell
 * why.
 *
 * The whole row is written on insert — the patch's fields over the resolved
 * defaults — so the row that lands is complete and readable by `resolveSettings`
 * whatever arrives next.
 */
export async function saveSettings(patch: SettingsPatch): Promise<SchedulerSettings> {
  const values: Partial<SchedulerSettings> = {}
  if (patch.slots !== undefined) values.slots = validateSlots(patch.slots)
  if (patch.timezone !== undefined) values.timezone = validateTimezone(patch.timezone)
  if (patch.hashtags !== undefined) values.hashtags = validateHashtags(patch.hashtags)
  if (Object.keys(values).length === 0) throw new SettingsError('değiştirilecek bir şey yok')

  const [row] = await getDb()
    .insert(settings)
    .values({ id: 1, ...DEFAULT_SETTINGS, ...values })
    .onConflictDoUpdate({ target: settings.id, set: values })
    .returning()
  return resolveSettings(row)
}
