import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createGraphClient } from './graph'
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
