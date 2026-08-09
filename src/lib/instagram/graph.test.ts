import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createGraphClient, graphBase } from './graph'
import { InstagramError } from './types'

// No network calls are made in this file — global.fetch is stubbed per-test below.
const originalFetch = global.fetch

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Error',
    json: async () => body,
  } as unknown as Response
}

function nonJsonResponse(status: number) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: 'Bad Gateway',
    json: async () => {
      throw new SyntaxError('Unexpected token < in JSON at position 0')
    },
  } as unknown as Response
}

describe('graph client', () => {
  beforeEach(() => {
    process.env.IG_ACCESS_TOKEN = 'secret-token-value'
    process.env.IG_USER_ID = 'ig-user-1'
  })

  afterEach(() => {
    global.fetch = originalFetch
    delete process.env.IG_ACCESS_TOKEN
    delete process.env.IG_USER_ID
  })

  it('sends the access token as a Bearer header on every request, never in the URL or body', async () => {
    const seen: { url: string; headers: HeadersInit | undefined }[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: init?.headers })
      return jsonResponse(200, { like_count: 0, comments_count: 0, data: [] })
    }) as unknown as typeof fetch

    const client = createGraphClient()
    await client.insights('123')

    expect(seen.length).toBeGreaterThan(0)
    for (const { url, headers } of seen) {
      expect(url).not.toContain('secret-token-value')
      expect(url).not.toContain('access_token')
      expect(headers).toMatchObject({ Authorization: 'Bearer secret-token-value' })
    }
  })

  it('wraps a non-JSON error body in an InstagramError instead of a raw SyntaxError', async () => {
    global.fetch = vi.fn(async () => nonJsonResponse(502)) as unknown as typeof fetch
    const client = createGraphClient()

    await expect(client.insights('123')).rejects.toBeInstanceOf(InstagramError)
  })

  it('preserves the Graph error type and code on an OAuthException, without leaking the token', async () => {
    global.fetch = vi.fn(async () =>
      jsonResponse(401, {
        error: { message: 'Error validating access token', type: 'OAuthException', code: 190 },
      }),
    ) as unknown as typeof fetch
    const client = createGraphClient()

    try {
      await client.insights('123')
      expect.unreachable('expected insights() to reject')
    } catch (err) {
      expect(err).toBeInstanceOf(InstagramError)
      const igErr = err as InstagramError
      expect(igErr.status).toBe(401)
      expect(igErr.type).toBe('OAuthException')
      expect(igErr.code).toBe(190)
      expect(igErr.message).not.toContain('secret-token-value')
    }
  })

  it('rethrows on an auth failure from the insights sub-call instead of masking it as zero engagement', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/insights')) {
        return jsonResponse(401, {
          error: { message: 'Error validating access token', type: 'OAuthException', code: 190 },
        })
      }
      return jsonResponse(200, { like_count: 5, comments_count: 2 })
    }) as unknown as typeof fetch
    const client = createGraphClient()

    await expect(client.insights('123')).rejects.toThrow('Error validating access token')
  })

  it('returns zeroed reach/saved, not a throw, when the insights sub-call fails for a non-auth reason', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes('/insights')) {
        return jsonResponse(400, {
          error: { message: 'Media not eligible for insights', type: 'GraphMethodException', code: 100 },
        })
      }
      return jsonResponse(200, { like_count: 5, comments_count: 2 })
    }) as unknown as typeof fetch
    const client = createGraphClient()

    await expect(client.insights('123')).resolves.toEqual({ likes: 5, comments: 2, reach: 0, saved: 0 })
  })

  it('reports how many carousel child containers were already created when one fails', async () => {
    let mediaCalls = 0
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/media')) {
        mediaCalls++
        if (mediaCalls === 2) {
          return jsonResponse(400, {
            error: { message: 'Invalid image URL', type: 'GraphMethodException', code: 100 },
          })
        }
        return jsonResponse(200, { id: `child-${mediaCalls}` })
      }
      return jsonResponse(200, {})
    }) as unknown as typeof fetch
    const client = createGraphClient()

    await expect(
      client.publish({
        kind: 'carousel',
        imageUrls: ['https://x/1.jpg', 'https://x/2.jpg', 'https://x/3.jpg'],
        caption: 'hi',
      }),
    ).rejects.toThrow('creating 2 of 3')
  })
})

// media_publish is the point of no return: the post is on the account the
// moment it returns. The scheduler treats a throw from publish() as proof that
// nothing was posted and retries, so anything that throws after this step
// causes the same picture to be posted again on the next tick.
describe('graph client publish irreversibility', () => {
  beforeEach(() => {
    process.env.IG_ACCESS_TOKEN = 'secret-token-value'
    process.env.IG_USER_ID = 'ig-user-1'
  })
  afterEach(() => {
    global.fetch = originalFetch
    delete process.env.IG_ACCESS_TOKEN
    delete process.env.IG_USER_ID
  })

  /** Succeeds through media_publish, then fails the permalink lookup. */
  function publishThenPermalinkFails(permalinkStatus: number) {
    const calls: string[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url.split('v25.0')[1] ?? url}`)
      if (url.includes('fields=permalink')) {
        return jsonResponse(permalinkStatus, { error: { message: 'transient' } })
      }
      if (url.includes('media_publish')) return jsonResponse(200, { id: 'media-1' })
      return jsonResponse(200, { id: 'container-1' })
    }) as unknown as typeof fetch
    return calls
  }

  it.each([[500], [429], [400]])(
    'returns the media id instead of throwing when the permalink lookup answers %i',
    async (status) => {
      const calls = publishThenPermalinkFails(status)
      const client = createGraphClient()

      const result = await client.publish({
        kind: 'feed',
        imageUrls: ['https://example.com/a.jpg'],
        caption: 'hello',
      })

      expect(result.igMediaId).toBe('media-1')
      expect(result.permalink).toBe('')
      expect(calls.filter((c) => c.includes('media_publish'))).toHaveLength(1)
    },
  )

  // parseGraphResponse returns `json ?? {}` on a 200, so a well-formed but
  // empty body must not put `undefined` into the column.
  it('returns an empty permalink when the lookup succeeds with no permalink field', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('fields=permalink')) return jsonResponse(200, {})
      if (url.includes('media_publish')) return jsonResponse(200, { id: 'media-1' })
      return jsonResponse(200, { id: 'container-1' })
    }) as unknown as typeof fetch

    const result = await createGraphClient().publish({
      kind: 'feed',
      imageUrls: ['https://example.com/a.jpg'],
      caption: 'hello',
    })
    expect(result).toEqual({ igMediaId: 'media-1', permalink: '' })
  })

  it('still returns the permalink when the lookup succeeds', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('fields=permalink')) {
        return jsonResponse(200, { permalink: 'https://instagram.com/p/abc' })
      }
      if (url.includes('media_publish')) return jsonResponse(200, { id: 'media-1' })
      return jsonResponse(200, { id: 'container-1' })
    }) as unknown as typeof fetch

    const result = await createGraphClient().publish({
      kind: 'feed',
      imageUrls: ['https://example.com/a.jpg'],
      caption: 'hello',
    })
    expect(result).toEqual({ igMediaId: 'media-1', permalink: 'https://instagram.com/p/abc' })
  })

  it('does throw when media_publish itself fails, since nothing was posted', async () => {
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('media_publish')) return jsonResponse(500, { error: { message: 'boom' } })
      return jsonResponse(200, { id: 'container-1' })
    }) as unknown as typeof fetch

    await expect(
      createGraphClient().publish({
        kind: 'feed',
        imageUrls: ['https://example.com/a.jpg'],
        caption: 'hello',
      }),
    ).rejects.toBeInstanceOf(InstagramError)
  })
})

// Meta's publishing guide asks for a status poll between creating a container
// and publishing it. Publishing an IN_PROGRESS container fails, runSlot reads
// that as "nothing was posted", and three such failures retire the item.
describe('graph client container readiness', () => {
  beforeEach(() => {
    process.env.IG_ACCESS_TOKEN = 'secret-token-value'
    process.env.IG_USER_ID = 'ig-user-1'
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    global.fetch = originalFetch
    delete process.env.IG_ACCESS_TOKEN
    delete process.env.IG_USER_ID
  })

  /** Answers IN_PROGRESS for the first `n` status polls, then FINISHED. */
  function readyAfter(n: number) {
    const calls: string[] = []
    let polls = 0
    global.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url.split('v25.0')[1] ?? url}`)
      if (url.includes('status_code')) {
        return jsonResponse(200, { status_code: polls++ < n ? 'IN_PROGRESS' : 'FINISHED' })
      }
      if (url.includes('fields=permalink')) return jsonResponse(200, { permalink: 'https://p/1' })
      if (url.includes('media_publish')) return jsonResponse(200, { id: 'media-1' })
      return jsonResponse(200, { id: 'container-1' })
    }) as unknown as typeof fetch
    return calls
  }

  const feed = { kind: 'feed' as const, imageUrls: ['https://example.com/a.jpg'], caption: 'hi' }

  it('waits for a container that is not ready yet, then publishes once', async () => {
    const calls = readyAfter(2)
    const promise = createGraphClient().publish(feed)
    await vi.runAllTimersAsync()
    const result = await promise

    expect(result.igMediaId).toBe('media-1')
    expect(calls.filter((c) => c.includes('status_code'))).toHaveLength(3)
    expect(calls.filter((c) => c.includes('media_publish'))).toHaveLength(1)
    // The poll must come before the irreversible step.
    expect(calls.findIndex((c) => c.includes('status_code')))
      .toBeLessThan(calls.findIndex((c) => c.includes('media_publish')))
  })

  it('does not publish a container that never finishes', async () => {
    const calls = readyAfter(Number.POSITIVE_INFINITY)
    const promise = createGraphClient().publish(feed)
    const assertion = expect(promise).rejects.toBeInstanceOf(InstagramError)
    await vi.runAllTimersAsync()
    await assertion

    expect(calls.filter((c) => c.includes('media_publish'))).toHaveLength(0)
  })

  // The pre-existing doubles answer every GET with {id}, so they fall straight
  // through this branch without ever exercising it. Pinned deliberately: an
  // absent status_code degrades to the pre-poll behaviour, where media_publish
  // itself rejects an unready container — a clean retry, never a double post.
  it('publishes without waiting when the body carries no status_code', async () => {
    const calls: string[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('fields=permalink')) return jsonResponse(200, { permalink: 'https://p/1' })
      if (url.includes('media_publish')) return jsonResponse(200, { id: 'media-1' })
      return jsonResponse(200, { id: 'container-1' })
    }) as unknown as typeof fetch

    // No timer advance at all: a wait here would hang the test rather than pass.
    const result = await createGraphClient().publish(feed)

    expect(result.igMediaId).toBe('media-1')
    expect(calls.filter((c) => c.includes('status_code'))).toHaveLength(1)
  })

  it('gives up immediately on a container Meta has already failed', async () => {
    const calls: string[] = []
    global.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      calls.push(url)
      if (url.includes('status_code')) return jsonResponse(200, { status_code: 'ERROR' })
      return jsonResponse(200, { id: 'container-1' })
    }) as unknown as typeof fetch

    await expect(createGraphClient().publish(feed)).rejects.toThrow('container error')
    expect(calls.filter((c) => c.includes('status_code'))).toHaveLength(1)
  })
})

// .env.example tells the owner to leave GRAPH_BASE empty for the default, and
// `??` does not treat an empty string as absent. `${''}/123/media` is an
// invalid URL, and the TypeError it raises is not an InstagramError — so every
// post would fail with a generic message and burn all three retries.
describe('graphBase', () => {
  const saved = process.env.GRAPH_BASE
  afterEach(() => {
    if (saved === undefined) delete process.env.GRAPH_BASE
    else process.env.GRAPH_BASE = saved
  })

  it.each([['unset', undefined], ['empty', ''], ['whitespace', '  ']])(
    'falls back to the default when %s',
    (_label, value) => {
      if (value === undefined) delete process.env.GRAPH_BASE
      else process.env.GRAPH_BASE = value
      expect(graphBase()).toBe('https://graph.facebook.com/v25.0')
    },
  )

  it('honours a real override, so the version can be pinned', () => {
    process.env.GRAPH_BASE = 'https://graph.facebook.com/v23.0'
    expect(graphBase()).toBe('https://graph.facebook.com/v23.0')
  })
})
