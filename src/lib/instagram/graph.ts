import { validate, isAuthError, InstagramError, type InstagramClient, type PublishInput } from './types'

const DEFAULT_GRAPH_BASE = 'https://graph.facebook.com/v25.0'

/**
 * The Graph API root.
 *
 * Read per call, and trimmed rather than tested with `??`: .env.example tells
 * the owner to leave GRAPH_BASE empty for the default, and neither an empty
 * string nor a stray space is nullish. `${''}/123/media` is an invalid URL, and
 * the TypeError it raises is not an InstagramError — so every post would fail
 * with a generic message and burn all three retries.
 */
export function graphBase(): string {
  return process.env.GRAPH_BASE?.trim() || DEFAULT_GRAPH_BASE
}

/**
 * Parses a Graph API response defensively. A non-JSON body (e.g. an HTML error page from an
 * edge proxy) must not escape as a raw `SyntaxError` — every failure surfaces as `InstagramError`.
 */
/** Whatever Graph sent back. Every field is optional because a failure can arrive in any shape. */
type GraphBody = {
  error?: { message?: string; type?: string; code?: number }
  [key: string]: unknown
}

/**
 * A string field of a Graph response, or ''.
 *
 * Graph sends ids, permalinks and status codes as strings, but a 200 can carry
 * any shape — parseGraphResponse returns {} for an empty body. Returning ''
 * rather than undefined keeps a missing id out of the database as an empty
 * string, which every consumer already treats as "not recorded".
 */
function str(body: GraphBody, key: string): string {
  const v = body[key]
  return typeof v === 'string' ? v : ''
}

/** The `data` array of an insights response, narrowed from the untyped body. */
type InsightRow = { name?: string; values?: { value?: number }[] }

/** A numeric field of a Graph response, or 0 — a count Graph omits is a count of nothing. */
function num(body: GraphBody, key: string): number {
  const v = body[key]
  return typeof v === 'number' ? v : 0
}

function insightRows(body: GraphBody): InsightRow[] {
  const data = body.data
  return Array.isArray(data) ? (data as InsightRow[]) : []
}

async function parseGraphResponse(res: Response): Promise<GraphBody> {
  let json: GraphBody | null = null
  try {
    json = await res.json()
  } catch {
    // fall through to the status-based error below
  }
  if (!res.ok) {
    // Never include the token, or any other part of the request, in the surfaced message.
    throw new InstagramError(
      json?.error?.message ?? res.statusText ?? `graph ${res.status}`,
      res.status,
      json?.error?.type,
      json?.error?.code,
    )
  }
  return json ?? {}
}

/**
 * No Graph request may hang.
 *
 * The publish path makes up to six status polls plus the container, publish and
 * permalink calls, all inside one cron invocation with a 300s ceiling. A single
 * socket that accepts and then goes quiet would spend that ceiling and take
 * every other due slot down with it.
 */
const GRAPH_TIMEOUT_MS = 20_000

async function call(path: string, params: Record<string, string>, method: 'GET' | 'POST') {
  const token = process.env.IG_ACCESS_TOKEN!
  // The token travels only in the Authorization header, never in a URL or POST body — a URL is
  // exactly the kind of thing generic instrumentation (Sentry breadcrumbs, OTel auto-instrumentation,
  // verbose fetch logging) captures by default.
  const headers = { Authorization: `Bearer ${token}` }
  const url = new URL(`${graphBase()}${path}`)
  const body = new URLSearchParams(params)
  const signal = AbortSignal.timeout(GRAPH_TIMEOUT_MS)
  const res = method === 'GET'
    ? await fetch(`${url}?${body}`, { headers, signal })
    : await fetch(url, { method, headers, body, signal })
  return parseGraphResponse(res)
}

async function container(igUserId: string, params: Record<string, string>): Promise<string> {
  return str(await call(`/${igUserId}/media`, params, 'POST'), 'id')
}

/** How long to wait for a container to finish before giving up and letting the tick retry. */
const READY_ATTEMPTS = 6
const READY_DELAY_MS = 2000

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Waits for a container to reach FINISHED.
 *
 * Meta's publishing guide asks for this, and it is not ceremony: publishing an
 * IN_PROGRESS container fails, `runSlot` correctly reads that as "nothing was
 * posted", and three such failures fifteen minutes apart retire the item for
 * good. Image containers are usually ready at once — a carousel of ten is the
 * case that will not be.
 *
 * A container that never finishes throws, which is the right outcome: the slot
 * is released and the next tick tries again.
 */
async function awaitContainer(creationId: string): Promise<void> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt++) {
    const status = str(await call(`/${creationId}`, { fields: 'status_code' }, 'GET'), 'status_code')
    // '' means the body carried no status_code: degrade to the pre-poll
    // behaviour, where media_publish itself rejects an unready container.
    if (status === 'FINISHED' || status === '') return
    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new InstagramError(`container ${String(status).toLowerCase()}`)
    }
    await sleep(READY_DELAY_MS)
  }
  throw new InstagramError('container did not finish in time')
}

export function createGraphClient(): InstagramClient {
  const igUserId = process.env.IG_USER_ID!
  return {
    isDryRun: false,
    async publish(input: PublishInput) {
      validate(input)
      let creationId: string

      if (input.kind === 'carousel') {
        const settled = await Promise.allSettled(
          input.imageUrls.map((image_url) =>
            container(igUserId, { image_url, is_carousel_item: 'true' })),
        )
        const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')
        if (failure) {
          const created = settled.filter((r) => r.status === 'fulfilled').length
          const reason = failure.reason instanceof Error ? failure.reason.message : String(failure.reason)
          // Already-created child containers are not cleaned up here — they expire on Meta's
          // side in ~24h — but a retrying caller needs to know they exist so more aren't piled on.
          throw new InstagramError(
            `carousel child container failed after creating ${created} of ${input.imageUrls.length}: ${reason}`,
            failure.reason instanceof InstagramError ? failure.reason.status : undefined,
          )
        }
        const children = (settled as PromiseFulfilledResult<string>[]).map((r) => r.value)
        creationId = await container(igUserId, {
          media_type: 'CAROUSEL',
          children: children.join(','),
          caption: input.caption,
        })
      } else if (input.kind === 'story') {
        // The Graph API has no caption field for STORIES; input.caption is intentionally
        // discarded here (validate() already exempts stories from the empty-caption check).
        creationId = await container(igUserId, {
          image_url: input.imageUrls[0],
          media_type: 'STORIES',
        })
      } else {
        creationId = await container(igUserId, {
          image_url: input.imageUrls[0],
          caption: input.caption,
        })
      }

      await awaitContainer(creationId)

      const id = str(await call(`/${igUserId}/media_publish`, { creation_id: creationId }, 'POST'), 'id')

      // NOTHING BELOW THIS LINE MAY THROW. media_publish is the irreversible
      // step — the post is on the account the moment it returns. The scheduler
      // treats a throw from publish() as proof that nothing was posted and
      // retries, so letting this separate GET fail (a 500, a 429, a socket
      // reset) would post the same picture again on the next tick.
      // items.permalink is nullable and Task 12 re-reads media by id, so an
      // empty permalink is recoverable. A duplicate post is not.
      let permalink = ''
      try {
        // parseGraphResponse returns `json ?? {}` on a 200, so a well-formed
        // but empty body must not put `undefined` into a non-null column.
        permalink = str(await call(`/${id}`, { fields: 'permalink' }, 'GET'), 'permalink')
      } catch (e) {
        console.error('permalink lookup failed after publishing', id, e)
      }
      return { igMediaId: id, permalink }
    },

    async permalink(mediaId: string) {
      return str(await call(`/${mediaId}`, { fields: 'permalink' }, 'GET'), 'permalink')
    },

    async insights(mediaId: string) {
      const [counts, insight] = await Promise.all([
        call(`/${mediaId}`, { fields: 'like_count,comments_count' }, 'GET'),
        call(`/${mediaId}/insights`, { metric: 'reach,saved' }, 'GET').catch((err) => {
          // A brand-new account genuinely has no insights yet and this call errors — treat that
          // as zero engagement. An auth/permission failure means the metrics are unknowable, not
          // zero, so it must propagate instead of being silently masked the same way.
          if (isAuthError(err)) throw err
          return { data: [] }
        }),
      ])
      const byName = Object.fromEntries(
        insightRows(insight).map((m) => [m.name, m.values?.[0]?.value ?? 0]),
      )
      return {
        likes: num(counts, 'like_count'),
        comments: num(counts, 'comments_count'),
        reach: byName.reach ?? 0,
        saved: byName.saved ?? 0,
      }
    },
  }
}
