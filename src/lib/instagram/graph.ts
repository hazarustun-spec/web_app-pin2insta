import { validate, InstagramError, type InstagramClient, type PublishInput } from './types'

const BASE = process.env.GRAPH_BASE ?? 'https://graph.facebook.com/v25.0'

/**
 * Parses a Graph API response defensively. A non-JSON body (e.g. an HTML error page from an
 * edge proxy) must not escape as a raw `SyntaxError` — every failure surfaces as `InstagramError`.
 */
async function parseGraphResponse(res: Response) {
  let json: any = null
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

async function call(path: string, params: Record<string, string>, method: 'GET' | 'POST') {
  const token = process.env.IG_ACCESS_TOKEN!
  // The token travels only in the Authorization header, never in a URL or POST body — a URL is
  // exactly the kind of thing generic instrumentation (Sentry breadcrumbs, OTel auto-instrumentation,
  // verbose fetch logging) captures by default.
  const headers = { Authorization: `Bearer ${token}` }
  const url = new URL(`${BASE}${path}`)
  const body = new URLSearchParams(params)
  const res = method === 'GET'
    ? await fetch(`${url}?${body}`, { headers })
    : await fetch(url, { method, headers, body })
  return parseGraphResponse(res)
}

async function container(igUserId: string, params: Record<string, string>): Promise<string> {
  const { id } = await call(`/${igUserId}/media`, params, 'POST')
  return id
}

/** True for a dead or insufficiently-scoped token — must never be masked as "zero engagement". */
function isAuthError(err: unknown): boolean {
  return err instanceof InstagramError && (err.status === 401 || err.status === 403 || err.type === 'OAuthException')
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

      const { id } = await call(`/${igUserId}/media_publish`, { creation_id: creationId }, 'POST')

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
        permalink = (await call(`/${id}`, { fields: 'permalink' }, 'GET')).permalink ?? ''
      } catch (e) {
        console.error('permalink lookup failed after publishing', id, e)
      }
      return { igMediaId: id, permalink }
    },

    async insights(mediaId: string) {
      const [{ like_count = 0, comments_count = 0 }, insight] = await Promise.all([
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
        (insight.data ?? []).map((m: any) => [m.name, m.values?.[0]?.value ?? 0]),
      )
      return {
        likes: like_count,
        comments: comments_count,
        reach: byName.reach ?? 0,
        saved: byName.saved ?? 0,
      }
    },
  }
}
