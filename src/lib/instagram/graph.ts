import { validate, InstagramError, type InstagramClient, type PublishInput } from './types'

const BASE = process.env.GRAPH_BASE ?? 'https://graph.facebook.com/v23.0'

async function call(path: string, params: Record<string, string>, method: 'GET' | 'POST') {
  const token = process.env.IG_ACCESS_TOKEN!
  const url = new URL(`${BASE}${path}`)
  const body = new URLSearchParams({ ...params, access_token: token })
  const res = method === 'GET'
    ? await fetch(`${url}?${body}`)
    : await fetch(url, { method, body })
  const json = await res.json()
  if (!res.ok) {
    // Never include the token in the surfaced message.
    throw new InstagramError(json?.error?.message ?? `graph ${res.status}`, res.status)
  }
  return json
}

async function container(igUserId: string, params: Record<string, string>): Promise<string> {
  const { id } = await call(`/${igUserId}/media`, params, 'POST')
  return id
}

export function createGraphClient(): InstagramClient {
  const igUserId = process.env.IG_USER_ID!
  return {
    isDryRun: false,
    async publish(input: PublishInput) {
      validate(input)
      let creationId: string

      if (input.kind === 'carousel') {
        const children = await Promise.all(
          input.imageUrls.map((image_url) =>
            container(igUserId, { image_url, is_carousel_item: 'true' })),
        )
        creationId = await container(igUserId, {
          media_type: 'CAROUSEL',
          children: children.join(','),
          caption: input.caption,
        })
      } else if (input.kind === 'story') {
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
      const { permalink } = await call(`/${id}`, { fields: 'permalink' }, 'GET')
      return { igMediaId: id, permalink }
    },

    async insights(mediaId: string) {
      const [{ like_count = 0, comments_count = 0 }, insight] = await Promise.all([
        call(`/${mediaId}`, { fields: 'like_count,comments_count' }, 'GET'),
        call(`/${mediaId}/insights`, { metric: 'reach,saved' }, 'GET').catch(() => ({ data: [] })),
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
