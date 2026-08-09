import { and, asc, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { getDb } from '@/src/db'
import { items, images, metrics } from '@/src/db/schema'
import { getInstagramClient, isAuthError } from '@/src/lib/instagram'
import { slotTimeFor } from '@/src/lib/queue/slots'
import { MONTHS_TR } from '@/src/lib/queue/view'

/**
 * What the free Graph metrics can and cannot tell the owner.
 *
 * The question this module answers is the one the owner actually asked: "which
 * of my posting times is doing worse, and should I move it?" Everything here
 * is built around that being a QUESTION ABOUT A SMALL, NOISY SAMPLE — three
 * posts a day against averages that a single lucky picture can move by half.
 * The thresholds below exist to stop this app stating a finding it does not
 * have, and the wording exists to stop the owner reading one.
 */

// ---------------------------------------------------------------------------
// The measure
// ---------------------------------------------------------------------------

/**
 * Total interactions on one post: likes + comments + saves.
 *
 * DECISION: interactions, NOT engagement rate (interactions ÷ reach). The
 * usual argument for the rate is that it controls for how many people saw the
 * post — but here that is precisely the wrong thing to control for:
 *
 * - REACH IS THE MECHANISM. Posting time acts on a post almost entirely
 *   through distribution: how many people are on the app, and how the ranking
 *   treats a post that gets early traction. Dividing by reach divides out the
 *   very effect the owner is asking about. A 03:00 slot reaching 40 people
 *   with 4 likes has a 10% rate — better than a 20:00 slot reaching 4000 with
 *   300 likes — and "keep posting at 03:00" is the opposite of the truth.
 * - THE CONFOUND THE RATE WOULD FIX IS NOT PRESENT. A rate is the honest
 *   measure when the thing being compared also changes what is being posted.
 *   Here it does not: `selectForSlot` takes the head of the queue, so which
 *   slot a picture lands in is decided by queue order, not by the picture.
 *   Content quality is therefore spread across slots by something very close
 *   to a shuffle, and averaging over enough posts cancels it out. That is what
 *   MIN_SLOT_SAMPLES is for.
 * - REACH IS OFTEN MISSING. `insights()` returns reach 0 both for an account
 *   too new to have insights and whenever the `/insights` edge errors for a
 *   non-auth reason, and the dry-run client returns 0 for everything. A rate
 *   would be 0/0 for entire stretches of history, and dropping those posts
 *   from a 15-post sample is worse than the confound it avoids.
 *
 * `reach` is still fetched, stored and shown per post — it is the number that
 * explains a surprising slot — it is just not what slots are ranked by.
 */
function engagementOf(r: MetricRow): number {
  return r.likes + r.comments + r.saved
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * Measured posts needed in total before this module will compare slots at all.
 * Five days of posting at the default three slots a day.
 */
export const MIN_SAMPLES = 15

/**
 * Measured posts needed IN A SLOT before that slot may be named.
 *
 * THE PLAN CHECKED MIN_SAMPLES AGAINST THE TOTAL ONLY, which is not a sample
 * size for the comparison being made. Fourteen posts at 10:00 and one unlucky
 * post at 20:00 clears a total of 15, and the plan would then tell the owner
 * to move 20:00 — on the strength of a single number. A mean of n=1 has no
 * error bar at all; at n=5 one post three times the others still moves the
 * mean by 40%, which is why the gap threshold is 30% and not 10%.
 *
 * Five is also exactly MIN_SAMPLES ÷ 3, the default slot count, so on a
 * default configuration both floors are reached on the same day and the owner
 * does not sit at "15/15" waiting for a second rule they were never told
 * about. Slots below the floor are ignored rather than silencing the whole
 * comparison, so adding a fourth posting time does not blind the other three.
 */
export const MIN_SLOT_SAMPLES = 5

/**
 * How far a slot must trail the best one before it is worth mentioning, as a
 * share of the best slot's average. Below this, the difference is well inside
 * what this sample size can produce by chance.
 */
export const MIN_GAP = 0.3

/** Posts one refresh run asks Instagram about, newest first. */
export const REFRESH_LIMIT = 30

/**
 * Posts the history page shows, and the window the averages are computed over.
 * Bounded because published history only ever grows; recent-weighted on
 * purpose, since advice about posting times should reflect the account as it
 * is now rather than as it was two years ago.
 */
export const HISTORY_LIMIT = 200

// ---------------------------------------------------------------------------
// Per-slot performance
// ---------------------------------------------------------------------------

export type MetricRow = { slotIndex: number; likes: number; comments: number; saved: number; reach: number }

export type SlotStat = {
  /** `items.slot_index`: minutes since local midnight since Task 10. */
  slotIndex: number
  /** The same thing as the owner wrote it — "14:00" — or null if it is not a minute of the day. */
  time: string | null
  samples: number
  avgEngagement: number
}

/** A slot that can be named in a sentence. */
export type NamedSlotStat = SlotStat & { time: string }

/** Mean interactions per post, per posting time, oldest time of day first. */
export function slotPerformance(rows: MetricRow[]): SlotStat[] {
  const buckets = new Map<number, number[]>()
  for (const r of rows) {
    const bucket = buckets.get(r.slotIndex)
    if (bucket) bucket.push(engagementOf(r))
    else buckets.set(r.slotIndex, [engagementOf(r)])
  }
  return [...buckets.entries()]
    .map(([slotIndex, scores]) => ({
      slotIndex,
      time: slotTimeFor(slotIndex),
      samples: scores.length,
      avgEngagement: scores.reduce((a, b) => a + b, 0) / scores.length,
    }))
    .sort((a, b) => a.slotIndex - b.slotIndex)
}

// ---------------------------------------------------------------------------
// The suggestion
// ---------------------------------------------------------------------------

export type SlotAdvice =
  /** Not enough measured posts yet. `measured` is exactly what the gate tests. */
  | { state: 'collecting'; measured: number; required: number }
  /** Enough posts overall, but fewer than two slots have enough of their own. */
  | { state: 'thin'; measured: number; perSlotRequired: number }
  /** Comparable, and nothing worth saying. */
  | { state: 'even' }
  /** One slot trails the best by MIN_GAP or more. */
  | { state: 'weak-slot'; worst: NamedSlotStat; best: NamedSlotStat; gap: number }

/**
 * What, if anything, the metrics support saying about posting times.
 *
 * Returned as a state rather than a string-or-null so the page can tell "not
 * enough data yet" from "enough data, no difference" — the plan's `string |
 * null` collapsed those two into one blank space, and they mean opposite
 * things to someone deciding whether to keep waiting.
 */
export function slotAdvice(
  stats: SlotStat[],
  minSamples = MIN_SAMPLES,
  minSlotSamples = MIN_SLOT_SAMPLES,
): SlotAdvice {
  const measured = stats.reduce((n, s) => n + s.samples, 0)
  if (measured < minSamples) return { state: 'collecting', measured, required: minSamples }

  // A slot with no name cannot be advised about, and a slot below the floor is
  // not evidence — both are excluded from the comparison rather than from the
  // count above, which is the honest denominator for "how far along am I".
  const comparable = stats.filter(
    (s): s is NamedSlotStat => s.time !== null && s.samples >= minSlotSamples,
  )
  if (comparable.length < 2) {
    return { state: 'thin', measured, perSlotRequired: minSlotSamples }
  }

  const best = comparable.reduce((a, b) => (b.avgEngagement > a.avgEngagement ? b : a))
  const worst = comparable.reduce((a, b) => (b.avgEngagement < a.avgEngagement ? b : a))
  // Every post scored zero: a fresh account, or the dry-run client, which
  // answers every insights call with zeros. There is no ratio here, and
  // "100% weaker" would be a sentence about nothing.
  if (best.avgEngagement <= 0) return { state: 'even' }

  const gap = 1 - worst.avgEngagement / best.avgEngagement
  if (gap < MIN_GAP) return { state: 'even' }
  return { state: 'weak-slot', worst, best, gap }
}

/**
 * The one Turkish sentence for a piece of advice.
 *
 * The 'weak-slot' wording is deliberately not a finding. It gives the numbers
 * it is based on, including how few posts they came from, says out loud that
 * this is not conclusive, and suggests trying a change rather than announcing
 * a cause. An app that says "20:00 performs worse" from 5 posts is inventing
 * confidence it has not got.
 */
export function describeAdvice(advice: SlotAdvice): string {
  switch (advice.state) {
    case 'collecting':
      return `veri toplanıyor · ${advice.measured}/${advice.required} ölçülmüş gönderi`
    case 'thin':
      return `saatleri karşılaştırmak için her saatte en az ${advice.perSlotRequired} ölçülmüş gönderi gerekiyor`
    case 'even':
      return 'saatler arasında dikkate değer bir fark yok'
    case 'weak-slot': {
      const pct = Math.round(advice.gap * 100)
      return (
        `En az etkileşimi ${advice.worst.time} alıyor: ortalama ${Math.round(advice.worst.avgEngagement)} `
        + `(${advice.worst.samples} gönderi). En çoğunu ${advice.best.time}: ortalama `
        + `${Math.round(advice.best.avgEngagement)} (${advice.best.samples} gönderi) — aradaki fark %${pct}. `
        + `Bu kadar az gönderiyle kesin bir sonuç değil; merak ediyorsan ${advice.worst.time} yerine `
        + 'başka bir saat deneyip birkaç hafta sonra buraya tekrar bak.'
      )
    }
  }
}

/**
 * The plan's interface: the sentence, or null when there is nothing to say.
 * The page uses `slotAdvice` + `describeAdvice` instead, because it needs to
 * say something in the other three states too.
 */
export function suggestSlotChange(stats: SlotStat[], minSamples = MIN_SAMPLES): string | null {
  const advice = slotAdvice(stats, minSamples)
  return advice.state === 'weak-slot' ? describeAdvice(advice) : null
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * "12 Ağu 2026 · 14:00", in the owner's configured timezone.
 *
 * Formatted explicitly rather than with `toLocaleString`, for two reasons the
 * plan's `new Date(p.postedAt).toLocaleString('tr-TR')` had wrong:
 * - it ran in the browser, so the time shown was the VIEWER's timezone. On a
 *   phone abroad, the 14:00 slot would read 12:00 and the whole page would
 *   disagree with the settings screen;
 * - `postedAt` is nullable, and `new Date(null)` is the epoch while
 *   `new Date(undefined)` renders the string "Invalid Date". Null in, null
 *   out, and the caller decides what to print.
 */
export function formatPostedAt(at: Date | null, timeZone: string): string | null {
  // Checked here rather than left to the formatter: `formatToParts` throws a
  // RangeError on an invalid date, and the catch below is narrowed to the ONE
  // thing it is there for — an unusable timezone.
  if (at === null || Number.isNaN(at.getTime())) return null
  const parts = Object.fromEntries(
    (formatterFor(timeZone) ?? formatterFor(UTC)!).formatToParts(at).map((p) => [p.type, p.value]),
  )
  const month = MONTHS_TR[Number(parts.month) - 1]
  return `${Number(parts.day)} ${month} ${parts.year} · ${parts.hour}:${parts.minute}`
}

const UTC = 'UTC'

/**
 * A formatter for `timeZone`, or null if the zone is unusable.
 *
 * An unknown timezone throws a RangeError from the constructor. The settings
 * screen validates the zone, but a row written before that validation existed
 * would otherwise take the whole page down over a formatting detail.
 */
function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  try {
    // en-CA with these options is numeric in every ICU build; formatToParts
    // means nothing depends on how it punctuates them.
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    })
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Refreshing the metrics
// ---------------------------------------------------------------------------

export type RefreshReport = {
  /** Posted items with an Instagram id that this run looked at. */
  scanned: number
  /** Metrics rows written. */
  refreshed: number
  /** Items whose metrics could not be read or stored this time round. */
  skipped: number
  dryRun: boolean
}

/**
 * Re-reads the free Graph metrics for the most recent posts and stores them.
 *
 * `metrics.itemId` is the primary key with a cascade to `items`, so this is an
 * upsert: the numbers keep moving for days after a post and every run must
 * overwrite, not accumulate or collide.
 *
 * ERROR POLICY — the whole reason this function is not four lines:
 * - a failure for ONE item (a deleted media, a 500 from the edge, a failed
 *   write) is skipped and reported. The next run tries again;
 * - an AUTH failure stops the run and is rethrown. Task 4 goes out of its way
 *   to distinguish a dead or unscoped token from a genuinely empty insights
 *   response, because a dead token means the metrics are UNKNOWABLE, not zero.
 *   The plan's bare `catch {}` threw that distinction away and would have
 *   written a table full of zeros — into the exact averages the suggestion is
 *   computed from, where they would look like real, terrible engagement.
 */
export async function refreshInsights(limit = REFRESH_LIMIT): Promise<RefreshReport> {
  const db = getDb()
  const client = getInstagramClient()
  const posted = await db.select().from(items)
    // Stories carry no interaction metrics, so a refresh would only ever write
    // zeros over them and spend one of the 30 Graph calls doing it.
    .where(and(eq(items.status, 'posted'), isNotNull(items.igMediaId), ne(items.kind, 'story')))
    .orderBy(desc(items.postedAt))
    .limit(limit)

  let refreshed = 0
  for (const item of posted) {
    try {
      const m = await client.insights(item.igMediaId!)
      const fetchedAt = new Date()
      await db.insert(metrics)
        .values({ itemId: item.id, ...m, fetchedAt })
        .onConflictDoUpdate({ target: metrics.itemId, set: { ...m, fetchedAt } })
      refreshed++
    } catch (e) {
      if (isAuthError(e)) {
        // Loud, and it stops here: every remaining item would fail the same
        // way, and a cron invocation that ends in an error is the only signal
        // this deployment has that the token needs replacing.
        console.error(
          `insights refresh stopped after ${refreshed} of ${posted.length} items: Instagram rejected the token`,
        )
        throw e
      }
      // The item id, so a row that is stuck forever can be found. Never the
      // error's own message at info level — it can carry hostnames.
      console.error('insights refresh skipped item', item.id, e)
    }
  }
  return { scanned: posted.length, refreshed, skipped: posted.length - refreshed, dryRun: client.isDryRun }
}

// ---------------------------------------------------------------------------
// The history
// ---------------------------------------------------------------------------

export type PublishedMetric = { likes: number; comments: number; reach: number; saved: number }

export type PublishedPost = {
  id: string
  kind: 'feed' | 'carousel' | 'story'
  /** The owner's caption as stored. See the note in `listPublished`. */
  caption: string
  postedAt: Date | null
  slotIndex: number | null
  /** The posting time as the owner wrote it, or null for a row we cannot name. */
  slotTime: string | null
  /** Null, never `''` — see `listPublished`. */
  permalink: string | null
  igMediaId: string | null
  thumb: string | null
  imageCount: number
  metric: PublishedMetric | null
}

export type PublishedHistory = {
  posts: PublishedPost[]
  stats: SlotStat[]
  advice: SlotAdvice
}

/**
 * The published history, newest first, with its metrics and the advice.
 *
 * The metrics row is JOINED rather than looked up per post, and the images are
 * fetched with one `inArray` over the ids on this page. The plan read the
 * whole `images` table and ran `.find()` per row — O(N×M) and unbounded, the
 * same defect Task 6 had to fix in `listQueue`.
 *
 * NOTE ON THE CAPTION: this is `items.caption`, the owner's text. What went to
 * Instagram was that plus the fixed hashtag block from the settings row AT THE
 * TIME OF POSTING, which is not stored anywhere. Appending today's hashtags
 * would show a caption that was never sent, so the block is left off entirely
 * rather than reconstructed wrongly.
 *
 * NULL `postedAt` sorts FIRST under Postgres' `DESC` (NULLS FIRST). The
 * publisher always writes `postedAt` alongside `status: 'posted'`, so such a
 * row is a hand-edit or a repair gone wrong — and the top of the page, where
 * the owner will see it, is the right place for it.
 */
export async function listPublished(limit = HISTORY_LIMIT): Promise<PublishedHistory> {
  const db = getDb()
  const rows = await db.select({ item: items, metric: metrics })
    .from(items)
    .leftJoin(metrics, eq(metrics.itemId, items.id))
    .where(eq(items.status, 'posted'))
    .orderBy(desc(items.postedAt))
    .limit(limit)

  const covers = rows.length === 0 ? new Map() : await coversFor(db, rows.map((r) => r.item.id))

  const posts: PublishedPost[] = rows.map(({ item, metric }) => ({
    id: item.id,
    kind: item.kind,
    caption: item.caption,
    postedAt: item.postedAt,
    slotIndex: item.slotIndex,
    slotTime: item.slotIndex === null ? null : slotTimeFor(item.slotIndex),
    // Task 8 carries an empty permalink forward when `media_publish` succeeded
    // but the permalink lookup failed, deliberately, because a duplicate post
    // is worse. `<a href="">` links to the current page, so the difference
    // between "no link" and "a link that lies" dies here rather than in JSX.
    permalink: item.permalink ? item.permalink : null,
    igMediaId: item.igMediaId,
    thumb: covers.get(item.id)?.url ?? null,
    imageCount: covers.get(item.id)?.count ?? 0,
    metric: metric && {
      likes: metric.likes, comments: metric.comments, reach: metric.reach, saved: metric.saved,
    },
  }))

  const stats = slotPerformance(
    rows
      // Stories are excluded, not merely unmeasured. A story has no likes, no
      // comments and no `saved` metric at all, so it scores zero interactions
      // by construction — and selectForSlot takes the head of the queue, so
      // where stories land is arbitrary. Averaging them in lets three stories
      // that happened to fall on 20:00 manufacture a 40% "difference" between
      // slots whose feed posts performed identically, and the page then advises
      // changing a posting time on the strength of it.
      .filter((r) => r.metric !== null && r.item.slotIndex !== null && r.item.kind !== 'story')
      .map((r) => ({
        slotIndex: r.item.slotIndex!,
        likes: r.metric!.likes,
        comments: r.metric!.comments,
        saved: r.metric!.saved,
        reach: r.metric!.reach,
      })),
  )

  return { posts, stats, advice: slotAdvice(stats) }
}

/**
 * Why a post shows no numbers.
 *
 * `pending` and `unmeasurable` look identical in the database — both are a
 * missing `metrics` row — but they are opposite facts. A post with no
 * `igMediaId` is the rare case where `media_publish` answered 200 without an
 * id: nothing can ever be fetched for it, and showing "ölçüm bekleniyor"
 * beside it would be a wait with no end. The owner is told the row is
 * finished instead.
 */
export function metricState(
  post: Pick<PublishedPost, 'metric' | 'igMediaId' | 'kind'>,
): 'measured' | 'pending' | 'unmeasurable' {
  // A story is unmeasurable whatever is in the row: Instagram reports no
  // likes, comments or saves for one, so printing "0 beğeni · 0 kaydetme"
  // states a measurement that was never taken.
  if (post.kind === 'story') return 'unmeasurable'
  if (post.metric) return 'measured'
  return post.igMediaId ? 'pending' : 'unmeasurable'
}

/** The first image and the image count for each of `ids`, in one statement. */
async function coversFor(db: ReturnType<typeof getDb>, ids: string[]) {
  const rows = await db.select().from(images)
    .where(inArray(images.itemId, ids))
    // A carousel's cover is the image at position 0, not whichever row the
    // database felt like returning first. `id` breaks a tie so the same
    // carousel does not change its cover between reloads.
    .orderBy(asc(images.position), asc(images.id))
  const covers = new Map<string, { url: string; count: number }>()
  for (const img of rows) {
    const seen = covers.get(img.itemId)
    if (seen) seen.count++
    else covers.set(img.itemId, { url: img.url, count: 1 })
  }
  return covers
}
