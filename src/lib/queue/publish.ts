import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'
import { getDb } from '@/src/db'
import { items, images, settings } from '@/src/db/schema'
import { getInstagramClient } from '@/src/lib/instagram'
import {
  InstagramError, validate,
  type InstagramClient, type PublishInput, type PublishResult,
} from '@/src/lib/instagram/types'
import { makeThumb } from '@/src/lib/images/process'
import { uploadImage, deleteImage } from '@/src/lib/images/storage'
import { dueSlots, dueState, scheduledRef, slotIndexFor, type SlotRef } from './slots'
import { MAX_CAPTION_CHARS } from './repo'

/** Retries per item before it is marked `failed` and stops blocking the queue. */
export const MAX_ATTEMPTS = 3

/** Ceiling on what we store in `items.error`, which the queue page displays. */
export const MAX_ERROR_CHARS = 300

export type SkipReason = 'empty-queue' | 'missing-caption' | 'exhausted' | 'caption-too-long'

export type Selection =
  | { action: 'publish'; itemId: string }
  | { action: 'skip'; reason: 'empty-queue' }
  | { action: 'skip'; reason: Exclude<SkipReason, 'empty-queue'>; itemId: string }

/**
 * The subset of an `items` row the decision needs. Selecting exactly these
 * columns is what lets `runPublish` hand real rows to `selectForSlot` without
 * casting — the plan's `pending as never` laundered a type mismatch instead.
 */
export type Candidate = {
  id: string
  caption: string
  kind: 'feed' | 'carousel' | 'story'
  attempts: number
  position: number
}

/**
 * The caption as Instagram will see it: the owner's text, then a blank line,
 * then the global hashtag block.
 */
export function withHashtags(caption: string, hashtags: string): string {
  const tags = hashtags.trim()
  const base = caption.trim()
  if (!tags) return base
  if (!base) return tags
  return `${base}\n\n${tags}`
}

/**
 * Pure decision: given the pending queue, what should this slot do?
 *
 * DECISIONS:
 * - Only the HEAD of the queue is ever considered. Skipping past an item that
 *   cannot publish to one that can would silently reorder the queue, and queue
 *   order is the owner's stated intent. A blocked head means the slot goes
 *   empty and the report names the item — a product decision, not a bug.
 * - `hashtags` is part of the caption length test because `validate()` measures
 *   the composed caption. A caption that only breaks 2200 characters once the
 *   hashtags are appended is not retryable, so it must never reach a claim:
 *   three cron ticks would burn all three attempts and mark the item failed.
 */
export function selectForSlot(pending: Candidate[], hashtags = ''): Selection {
  // Stable sort, so rows that tie on position keep the order the query gave.
  const next = [...pending].sort((a, b) => a.position - b.position)[0]
  if (!next) return { action: 'skip', reason: 'empty-queue' }
  const blocker = itemBlocker(next, hashtags)
  return blocker
    ? { action: 'skip', reason: blocker, itemId: next.id }
    : { action: 'publish', itemId: next.id }
}

/**
 * Why this item cannot publish right now, or null.
 *
 * Extracted from `selectForSlot` because an item that carries its own time is
 * not selected from a queue — it IS the candidate — and the three reasons a
 * post is refused must be the same for both kinds. A second copy would drift,
 * and the drift would show up as a scheduled post that burned three attempts on
 * a caption the slot path refuses for free.
 */
export function itemBlocker(
  item: Candidate, hashtags: string,
): Exclude<SkipReason, 'empty-queue'> | null {
  if (item.attempts >= MAX_ATTEMPTS) return 'exhausted'
  if (item.kind !== 'story' && !item.caption.trim()) return 'missing-caption'
  if (withHashtags(item.caption, hashtags).length > MAX_CAPTION_CHARS) return 'caption-too-long'
  return null
}

export type SchedulerSettings = { slots: string[]; timezone: string; hashtags: string }

/** The `settings` table's own column defaults, repeated here for the case where the row does not exist yet. */
export const DEFAULT_SETTINGS: SchedulerSettings = {
  slots: ['10:00', '14:00', '20:00'],
  timezone: 'Europe/Istanbul',
  hashtags: '',
}

const TIME_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

/**
 * Exported so the settings screen refuses a zone with the SAME test the
 * scheduler runs on. A second implementation would be free to drift, and the
 * cost of the drift is a schedule that silently shifts (or a cron run that
 * throws) hours after the owner typed it.
 */
export function isKnownTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

/**
 * Settings the scheduler can actually run on.
 *
 * `db.select()` returns an EMPTY ARRAY when the settings row has never been
 * written, which is every deployment until the settings UI (Task 10) is used —
 * the plan's `cfg.slots` throws there and the cron run dies before it looks at
 * a single slot. Field-level fallbacks matter for the same reason: a bad
 * timezone makes `slotAt` throw and a malformed time makes it produce an
 * Invalid Date, either of which takes down the whole run rather than one slot.
 */
export function resolveSettings(row: Partial<SchedulerSettings> | undefined | null): SchedulerSettings {
  const slots = row?.slots
  const timezone = row?.timezone
  const hashtags = row?.hashtags
  return {
    slots:
      Array.isArray(slots) && slots.length > 0 && slots.every((s) => typeof s === 'string' && TIME_RE.test(s))
        ? slots
        : DEFAULT_SETTINGS.slots,
    timezone:
      typeof timezone === 'string' && timezone !== '' && isKnownTimeZone(timezone)
        ? timezone
        : DEFAULT_SETTINGS.timezone,
    hashtags: typeof hashtags === 'string' ? hashtags : DEFAULT_SETTINGS.hashtags,
  }
}

/**
 * What goes into `items.error`, which the queue page shows the owner.
 *
 * Same contract as `QueueError`/`IngestError` in repo.ts: exactly one error
 * type carries a message written about the post, and it is the only one stored
 * verbatim. A Drizzle, Neon, Blob or DNS failure can carry a connection string,
 * a hostname or a token fragment; those are logged server-side and stored as a
 * fixed sentence. The plan wrote `(e as Error).message` into this column.
 */
export function describeFailure(e: unknown): string {
  if (e instanceof InstagramError) {
    // \p{Cc}\p{Cf} rather than a literal control-character class: the same
    // set, plus the bidi overrides that can reorder text on screen.
    const flat = e.message.replace(/[\p{Cc}\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim()
    if (flat) return flat.slice(0, MAX_ERROR_CHARS)
  }
  return 'paylaşılamadı — sunucu günlüklerine bakın'
}

// ---------------------------------------------------------------------------
// The run loop.
// ---------------------------------------------------------------------------

/** What happened to one due slot. */
export type SlotOutcome =
  | 'posted'
  /** Instagram accepted the post but the row could not be updated to say so. */
  | 'posted-unrecorded'
  | 'already-filled'
  /** The day has already had every post the schedule allows by this time — see `allowanceBy`. */
  | 'over-quota'
  | 'race-lost'
  | 'claim-failed'
  | 'invalid-payload'
  | 'error'
  /** The head item already failed earlier in this same run; its retry belongs to a later tick. */
  | 'deferred'
  | SkipReason

export type SlotResult = {
  date: string
  index: number
  outcome: SlotOutcome
  itemId?: string
  /**
   * Present only for an item that carried its own `scheduled_at`. Deliberately
   * absent — not `false` — on an automatic slot, so the shape of every result
   * this report has ever produced is unchanged.
   */
  scheduled?: true
}

export type PublishReport = {
  slots: SlotResult[]
  dryRun: boolean
  /** Set when the run did nothing because dry-run publishing is not enabled. */
  disabled?: true
}

/**
 * Whether a dry run is allowed to actually consume the queue.
 *
 * A dry run is not a rehearsal — it is indistinguishable from a real one
 * everywhere it matters. It marks the item `posted`, replaces the full-size
 * blob with a 320px thumbnail and deletes the original, and `deleteItem` then
 * refuses to remove a posted row because the hash must survive to stop a
 * repost. So the picture cannot be re-queued (the hash answers "zaten var"),
 * cannot be deleted, and no longer exists at full size.
 *
 * That matters because of the order the README asks for: set the secrets, wire
 * the scheduler, THEN spend days converting the Instagram account and getting a
 * Meta app approved. A cron running through those days against the dry-run
 * client would quietly eat three real photos a day, and /published would show
 * them as ordinary posts with a link to instagram.com/p/dryrun-1.
 *
 * So it is opt-in. Setting this is how you say "yes, pretend to post, I know it
 * consumes the queue".
 */
export function dryRunPublishingEnabled(): boolean {
  return process.env.ALLOW_DRYRUN_PUBLISH === '1'
}

type Db = ReturnType<typeof getDb>
type ImageRow = { id: string; url: string; hash: string }

/** Postgres unique_violation on the slot index — the same shape repo.ts reads for the image-hash index. */
function isSlotTaken(e: unknown): boolean {
  const err = e as { code?: string; constraint?: string } | null
  return err?.code === '23505' && err?.constraint === 'items_slot_unique_idx'
}

/**
 * Replaces each full-size blob with a thumbnail once the post is live.
 *
 * BEST EFFORT, ALWAYS. This runs AFTER the item is recorded as posted, and
 * nothing it does can change that record. The plan ran it inside the same
 * try/catch as `client.publish()`, so a failed fetch cleared the slot claim,
 * incremented `attempts` and left the item pending — and the next cron tick
 * published the same picture to the account a second time.
 *
 * The original blob is deleted only after the row points at the thumbnail; the
 * other order leaves `images.url` referencing an object that no longer exists.
 */
async function refreshThumbnails(db: Db, imgs: ImageRow[]): Promise<void> {
  for (const img of imgs) {
    try {
      const res = await fetch(img.url)
      if (!res.ok) throw new Error(`blob fetch failed with ${res.status}`)
      const full = Buffer.from(await res.arrayBuffer())
      const thumb = await uploadImage(await makeThumb(full), `thumb/${img.hash}.jpg`)
      await db.update(images)
        .set({ url: thumb.url, pathname: thumb.pathname })
        .where(eq(images.id, img.id))
      await deleteImage(img.url).catch((e) => console.error('blob cleanup failed:', e))
    } catch (e) {
      // A surviving full-size blob costs storage. Undoing a published post is
      // not on the menu, so this failure is logged and nothing else.
      console.error('thumbnail refresh failed for image', img.id, e)
    }
  }
}

/** Releases the slot claim, counts the attempt, and retires the item once it has used them all. */
async function recordFailure(db: Db, item: Candidate, e: unknown): Promise<void> {
  const attempts = item.attempts + 1
  const status: 'pending' | 'failed' = attempts >= MAX_ATTEMPTS ? 'failed' : 'pending'
  await db.update(items)
    .set({ postedDate: null, slotIndex: null, attempts, error: describeFailure(e), status })
    .where(eq(items.id, item.id))
}

/**
 * How many posts the schedule allows a day to have made by `time`: the number
 * of configured slots at or before it.
 *
 * The second half of the double-post fix, and the half that covers the case
 * minute-of-day identity cannot. Once the times can be edited mid-day, a slot
 * can appear in the PAST: add 09:00 at 10:05 and `dueSlots`' 90-minute grace
 * window reports 09:00 as due right now, so a post goes out six minutes after
 * the 10:00 one. Moving 10:00 to 10:30 after it has published does the same.
 * Neither is a duplicate row, and the unique index has nothing to say about
 * either; both are two posts half an hour apart on an account that is supposed
 * to post three times a day.
 *
 * The rule this expresses is one sentence: A DAY NEVER GETS MORE POSTS THAN THE
 * SCHEDULE ALLOWS BY THAT TIME OF DAY. It is deliberately conservative. On the
 * day the owner edits the schedule it can cost a post — reduce three slots to
 * two after the first has gone out and the day publishes at 10:00 and 20:00
 * rather than at 10:00, 14:00 and 20:00 — and that is the direction to err in:
 * a late post is a nuisance, an unplanned extra post is an account risk and
 * cannot be taken back.
 *
 * It changes nothing about an ordinary day: by the Nth slot exactly N-1 posts
 * have gone out, so the allowance is never binding.
 */
export function allowanceBy(slots: string[], time: string): number {
  const limit = slotIndexFor(time)
  return slots.filter((s) => slotIndexFor(s) <= limit).length
}

/**
 * Publishes ONE item into ONE claim: (date, minute-of-day).
 *
 * This is the only code path that talks to Instagram, and both kinds of due
 * work go through it — an automatic slot and an item carrying its own time.
 * Having one copy is not tidiness: every guarantee below was found the hard
 * way, and a second publish path would have to rediscover each of them.
 *
 *   1. the payload is validated BEFORE anything is claimed;
 *   2. the claim is an UPDATE that reads back `.returning()`, because an UPDATE
 *      matching zero rows throws nothing at all;
 *   3. NOTHING after `client.publish()` returns may release the claim, count an
 *      attempt, or set the item back to pending.
 */
async function publishInto(
  db: Db,
  client: InstagramClient,
  now: Date,
  item: Candidate,
  claim: { date: string; index: number },
  hashtags: string,
): Promise<SlotOutcome> {
  const imgs: ImageRow[] = await db.select({ id: images.id, url: images.url, hash: images.hash })
    .from(images)
    .where(eq(images.itemId, item.id))
    .orderBy(asc(images.position), asc(images.id))

  const input: PublishInput = {
    kind: item.kind,
    imageUrls: imgs.map((i) => i.url),
    caption: withHashtags(item.caption, hashtags),
  }

  // Pre-flight the exact payload BEFORE claiming anything. A shape validate()
  // rejects — a carousel holding one image, an item with no images at all — is
  // not made publishable by retrying, so letting it reach the claim would burn
  // all three attempts and mark the item failed for a reason the owner can fix
  // in one click.
  try {
    validate(input)
  } catch (e) {
    console.error('payload rejected before claiming a slot for item', item.id, e)
    return 'invalid-payload'
  }

  // Claim the slot before calling out, and READ BACK what was claimed.
  //
  // This is the guard the plan did not have. `UPDATE ... WHERE posted_date IS
  // NULL` that matches zero rows throws NOTHING: a try/catch around it sees
  // success, and the run goes on to publish an item another cron tick has
  // already taken. `.returning()` is what turns a lost race into an observable
  // event. The unique index protects the SLOT; only this protects the ITEM.
  let claimed: { id: string }[]
  try {
    claimed = await db.update(items)
      .set({ postedDate: claim.date, slotIndex: claim.index })
      .where(and(eq(items.id, item.id), isNull(items.postedDate), eq(items.status, 'pending')))
      .returning({ id: items.id })
  } catch (e) {
    // The unique index is the backstop for the other order: our read said the
    // slot was free, and another run filled it before this statement landed.
    // It is also what stops two items scheduled to the same minute from both
    // going out — that pair is ONE claim, and only one of them can hold it.
    if (isSlotTaken(e)) return 'race-lost'
    console.error('slot claim failed for item', item.id, e)
    return 'claim-failed'
  }
  if (claimed.length === 0) return 'race-lost'

  let result: PublishResult
  try {
    result = await client.publish(input)
  } catch (e) {
    console.error('publish failed for item', item.id, e)
    try {
      await recordFailure(db, item, e)
    } catch (e2) {
      // The claim survives, so the item is stuck rather than double-posted.
      console.error('could not record the failure for item', item.id, e2)
    }
    return 'error'
  }

  // ── The post now EXISTS on Instagram and cannot be recalled. ──────────────
  // Everything below is recording and cleanup. Nothing here may release the
  // slot claim, increment `attempts`, or set the item back to `pending`.
  try {
    await db.update(items).set({
      status: 'posted',
      igMediaId: result.igMediaId,
      permalink: result.permalink,
      postedAt: now,
      error: null,
    }).where(eq(items.id, item.id))
  } catch (e) {
    // Deliberately NOT rolled back. The claim written above already excludes
    // this item from the pending query and fills the slot, so the next tick
    // will not publish it again; the row simply lacks its permalink until
    // someone fixes it by hand.
    console.error('published but could not record it for item', item.id, e)
    return 'posted-unrecorded'
  }

  await refreshThumbnails(db, imgs)
  return 'posted'
}

async function runSlot(
  db: Db,
  client: InstagramClient,
  now: Date,
  slot: SlotRef,
  cfg: SchedulerSettings,
  failedThisRun: ReadonlySet<string> = new Set(),
): Promise<SlotResult> {
  const at = (outcome: SlotOutcome, itemId?: string): SlotResult =>
    itemId === undefined
      ? { date: slot.date, index: slot.index, outcome }
      : { date: slot.date, index: slot.index, outcome, itemId }

  // One read answers both questions: has THIS slot published, and has the day
  // already had everything the schedule allows by now?
  const claims = await db.select({ slotIndex: items.slotIndex, scheduledAt: items.scheduledAt })
    .from(items)
    .where(eq(items.postedDate, slot.date))
  const used = claims
    .map((r) => r.slotIndex)
    .filter((i): i is number => typeof i === 'number')
  if (used.includes(slot.index)) return at('already-filled')
  // The allowance counts posts that went out THROUGH A SLOT, and only those. A
  // post the owner gave its own time to is not one of the day's slot posts:
  // counting it would make "five posts tomorrow if I schedule five" mean "the
  // slots stop for the rest of the day", which is the opposite of no daily cap.
  const bySlot = claims.filter((r) => r.scheduledAt == null && typeof r.slotIndex === 'number')
  if (bySlot.length >= allowanceBy(cfg.slots, slot.time)) return at('over-quota')

  // Exactly the columns selectForSlot needs, so real rows satisfy `Candidate`
  // without a cast. The ordering is total (position ties are possible, because
  // nextPosition's max+1 is not atomic) so the head of the queue is the same
  // item on every tick.
  //
  // `isNull(items.scheduledAt)`: an item that carries its own time is NOT a
  // candidate for a slot. Spending a slot on it would publish it at a time the
  // owner did not choose, and would also consume the slot that the rest of the
  // queue is waiting for.
  const pending: Candidate[] = await db.select({
    id: items.id,
    caption: items.caption,
    kind: items.kind,
    attempts: items.attempts,
    position: items.position,
  }).from(items)
    .where(and(
      eq(items.status, 'pending'),
      isNull(items.postedDate),
      isNull(items.scheduledAt),
    ))
    .orderBy(asc(items.position), asc(items.createdAt), asc(items.id))

  // A failure earlier in this same run leaves the item at the head of the queue
  // with its attempt already spent. Leave the slot empty rather than spending
  // the rest of the budget on the same outage.
  if (pending.length > 0 && failedThisRun.has(pending[0].id)) {
    return at('deferred', pending[0].id)
  }

  const decision = selectForSlot(pending, cfg.hashtags)
  if (decision.action === 'skip') {
    return decision.reason === 'empty-queue'
      ? at('empty-queue')
      : at(decision.reason, decision.itemId)
  }
  // selectForSlot returns the id of a row it was handed, so this always finds one.
  const item = pending.find((p) => p.id === decision.itemId)!

  return at(await publishInto(db, client, now, item, slot, cfg.hashtags), item.id)
}

/** A pending item the owner gave a time to, plus that time. */
type ScheduledCandidate = Candidate & { scheduledAt: Date }

/**
 * Publishes one item at the time the owner chose for it.
 *
 * The claim is `scheduledRef`: the local date of `scheduled_at` and its minute
 * of the day — the same two columns a slot claims, under the same unique index.
 * So a scheduled post at 10:00 and the 10:00 slot cannot both go out, and two
 * items scheduled to the same minute cannot either.
 */
async function runScheduled(
  db: Db,
  client: InstagramClient,
  now: Date,
  item: ScheduledCandidate,
  cfg: SchedulerSettings,
): Promise<SlotResult> {
  const ref = scheduledRef(item.scheduledAt, cfg.timezone)
  const at = (outcome: SlotOutcome): SlotResult =>
    ({ date: ref.date, index: ref.index, outcome, itemId: item.id, scheduled: true })

  // The same three refusals the slot path applies, from the same function — and
  // like there, none of them costs an attempt or touches the row. The chosen
  // time simply passes unused, which is what the queue page has to say.
  const blocker = itemBlocker(item, cfg.hashtags)
  if (blocker) return at(blocker)

  return at(await publishInto(db, client, now, item, ref, cfg.hashtags))
}

/**
 * Every pending item whose own time has arrived and has not yet gone stale,
 * oldest first.
 *
 * The window is applied here rather than in SQL so that `dueState` is the ONLY
 * definition of "due" in the codebase: the queue page calls the same function
 * to decide whether to call a time missed, and a second rule expressed as a
 * pair of SQL comparisons would be free to disagree with it. The rows this
 * reads are only ever items the owner scheduled and that have not published.
 */
async function dueScheduled(db: Db, now: Date): Promise<ScheduledCandidate[]> {
  const rows = await db.select({
    id: items.id,
    caption: items.caption,
    kind: items.kind,
    attempts: items.attempts,
    position: items.position,
    scheduledAt: items.scheduledAt,
  }).from(items)
    .where(and(
      eq(items.status, 'pending'),
      isNull(items.postedDate),
      isNotNull(items.scheduledAt),
    ))
    .orderBy(asc(items.scheduledAt), asc(items.id))

  const due: ScheduledCandidate[] = []
  for (const row of rows) {
    const scheduledAt = row.scheduledAt
    // `scheduled_at` is a plain nullable timestamp column: a row written by
    // hand can hold something no clock produced, and an Invalid Date makes
    // `localDate` throw RangeError — which would take down the entire cron run,
    // slots included, rather than cost this one item.
    if (!(scheduledAt instanceof Date) || Number.isNaN(scheduledAt.getTime())) {
      console.error('ignoring an unreadable scheduled_at on item', row.id)
      continue
    }
    if (dueState(scheduledAt, now) === 'due') due.push({ ...row, scheduledAt })
  }
  return due
}

/**
 * Publishes the due work of this tick, in two phases.
 *
 * 1. Items that carry their OWN time, oldest first, each into its own minute.
 *    There is no cap: five posts scheduled for tomorrow are five posts.
 * 2. The head of the queue into every slot that is due and unfilled, exactly as
 *    before — minus the items phase 1 owns.
 *
 * Neither missed slots nor missed scheduled times roll forward: anything older
 * than the shared grace window is dropped, because catching up would post
 * several times in an hour at times nobody chose.
 */
export async function runPublish(now: Date): Promise<PublishReport> {
  const db = getDb()
  const client = getInstagramClient()
  if (client.isDryRun && !dryRunPublishingEnabled()) {
    return { slots: [], dryRun: true, disabled: true }
  }
  const [row] = await db.select().from(settings).where(eq(settings.id, 1))
  const cfg = resolveSettings(row)

  const slots: SlotResult[] = []

  // Phase 1. Each of these is a different post at a different time, so unlike
  // the slot loop below there is no failedThisRun guard: a failure on one is
  // not a reason to spend another item's chosen time on the same outage. The
  // two phases cannot collide over an item either — the slot query excludes
  // everything with a `scheduled_at`.
  for (const item of await dueScheduled(db, now)) {
    slots.push(await runScheduled(db, client, now, item, cfg))
  }

  // An item that just failed must not be retried again inside the same run.
  // Several slots can be due at once — closely spaced slot times, a cron tick
  // that arrives late, or the spring-forward gap where two wall-clock times
  // resolve to the same instant — and the loop re-reads the pending queue each
  // time, so the same head item would burn its entire retry budget in one
  // second on a single 60-second outage at Meta. Retries belong to later ticks.
  const failedThisRun = new Set<string>()
  for (const slot of dueSlots(now, cfg.slots, cfg.timezone)) {
    const result = await runSlot(db, client, now, slot, cfg, failedThisRun)
    if (result.outcome === 'error' && result.itemId) failedThisRun.add(result.itemId)
    slots.push(result)
  }
  return { slots, dryRun: client.isDryRun }
}
