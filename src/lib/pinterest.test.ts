import { describe, it, expect } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import {
  isPinUrl,
  isPinImageUrl,
  extractOgImage,
  resolvePinImage,
  pinName,
  fetchPinImage,
  PinError,
  MAX_HTML_BYTES,
  MAX_IMAGE_BYTES,
} from './pinterest'

// ---------------------------------------------------------------------------
// isPinUrl — the guard on the URL the OWNER pastes.
//
// fetchPinImage makes the server fetch a URL the client supplied, so this is
// the same class of guard as isStagedBlobUrl (src/lib/queue/repo.ts) and gets
// the same adversarial table. The plan's `(^|\.)pinterest\.[a-z.]+$` matched
// `pinterest.com.evil.com` — a trailing wildcard on a suffix is not a host
// check, so this matches a fixed set of registrable domains instead.
// ---------------------------------------------------------------------------

describe('isPinUrl', () => {
  it.each([
    ['a pin on the main site', 'https://www.pinterest.com/pin/12345/'],
    ['the Turkish subdomain', 'https://tr.pinterest.com/pin/12345/'],
    ['the pin.it shortener', 'https://pin.it/abc'],
    ['the bare registrable domain', 'https://pinterest.com/pin/12345/'],
    // Every ccTLD below 308-redirects to a *.pinterest.com host; verified by
    // probing each one while writing this.
    ['a ccTLD front door', 'https://pinterest.co.uk/pin/12345/'],
    ['a two-label ccTLD', 'https://pinterest.com.au/pin/12345/'],
    ['a country subdomain', 'https://uk.pinterest.com/pin/12345/'],
    ['an uppercase host', 'https://WWW.PINTEREST.COM/pin/12345/'],
    // A pasted link carries campaign junk far more often than not.
    ['tracking query and fragment', 'https://tr.pinterest.com/pin/1/?utm_source=x#s'],
  ])('accepts %s', (_label, url) => {
    expect(isPinUrl(url)).toBe(true)
  })

  it.each([
    // The two bypasses the plan's regex let through.
    ['pinterest.com as a prefix of an attacker domain', 'https://pinterest.com.evil.com/pin/1'],
    ['a ccTLD as a prefix of an attacker domain', 'https://pinterest.co.uk.attacker.net/pin/1'],
    ['pin.it as a prefix of an attacker domain', 'https://pin.it.evil.com/abc'],
    ['a host merely ending in the word', 'https://notpinterest.com/pin/1'],
    ['a host merely containing the word', 'https://evil-pinterest.com.br/pin/1'],
    ['a lookalike without the dot', 'https://pinterestcom/pin/1'],
    // Cyrillic е. new URL() punycodes it to xn--pintert-jmd..., which is a
    // different registrable domain and must not match.
    ['a homoglyph domain', 'https://pinterеst.com/pin/1'],
    ['a hostname that is only a dot label', 'https://.pinterest.com/pin/1'],
    ['a trailing-dot FQDN', 'https://www.pinterest.com./pin/1'],
    ['userinfo pointing elsewhere', 'https://www.pinterest.com@evil.com/pin/1'],
    ['credentials on the real host', 'https://user:pw@www.pinterest.com/pin/1'],
    ['a username only', 'https://user@www.pinterest.com/pin/1'],
    ['a password only', 'https://:pw@www.pinterest.com/pin/1'],
    ['an explicit port', 'https://www.pinterest.com:22/pin/1'],
    ['plain http', 'http://www.pinterest.com/pin/1'],
    ['the file scheme', 'file:///etc/passwd'],
    ['the data scheme', 'data:text/html,<meta property="og:image" content="x">'],
    ['a javascript url', 'javascript:alert(1)//pinterest.com'],
    ['ftp', 'ftp://www.pinterest.com/pin/1'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['metadata over https', 'https://169.254.169.254/latest/meta-data/'],
    ['loopback by name', 'https://localhost/pin/1'],
    ['loopback by address', 'https://127.0.0.1/pin/1'],
    ['ipv6 loopback', 'https://[::1]/pin/1'],
    ['a private address', 'https://10.0.0.1/pin/1'],
    ['the domain in the path', 'https://evil.com/https://www.pinterest.com/pin/1'],
    ['the domain in the query', 'https://evil.com/?u=https://www.pinterest.com/pin/1'],
    ['the domain in the fragment', 'https://evil.com/#www.pinterest.com'],
    ['a protocol-relative url', '//www.pinterest.com/pin/1'],
    ['a bare host', 'www.pinterest.com/pin/1'],
    ['not a url at all', 'not a url'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isPinUrl(url)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isPinImageUrl — the guard on the URL taken OUT of the fetched page.
//
// Whoever controls the page controls this string, so it is strictly more
// hostile than the pasted URL and gets an exact-host allowlist.
// ---------------------------------------------------------------------------

describe('isPinImageUrl', () => {
  it.each([
    ['an original', 'https://i.pinimg.com/originals/d5/3b/01/d53b014d86a6b6761bf649a0ed813c2b.png'],
    ['a resized copy', 'https://i.pinimg.com/564x/aa/bb/cc.jpg'],
    ['a static asset host', 'https://s.pinimg.com/webapp/x.png'],
    ['a numbered static host', 'https://s1.pinimg.com/webapp/x.png'],
    ['a query string', 'https://i.pinimg.com/originals/a.jpg?fit=cover'],
  ])('accepts %s', (_label, url) => {
    expect(isPinImageUrl(url)).toBe(true)
  })

  it.each([
    ['the image host as a prefix of an attacker domain', 'https://i.pinimg.com.evil.com/a.jpg'],
    ['an extra label in front of the image host', 'https://evil.i.pinimg.com/a.jpg'],
    ['a sibling that is not on the list', 'https://v.pinimg.com/a.mp4'],
    ['the bare registrable domain', 'https://pinimg.com/a.jpg'],
    ['a leading-dot host', 'https://.pinimg.com/a.jpg'],
    // The page host is not an image host: a pin page pointing og:image back at
    // pinterest.com would make the server fetch pages in a loop.
    ['a pinterest page host', 'https://www.pinterest.com/pin/1'],
    ['plain http', 'http://i.pinimg.com/a.jpg'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['metadata over https', 'https://169.254.169.254/latest/meta-data/'],
    ['ipv4-mapped ipv6 metadata', 'https://[::ffff:169.254.169.254]/latest/meta-data/'],
    ['loopback', 'https://127.0.0.1/a.jpg'],
    ['a private address', 'https://192.168.0.1/a.jpg'],
    ['the file scheme', 'file:///etc/passwd'],
    ['a data url', 'data:image/png;base64,iVBORw0KGgo='],
    ['a javascript url', 'javascript:alert(1)'],
    ['userinfo pointing elsewhere', 'https://i.pinimg.com@evil.com/a.jpg'],
    ['credentials on the real host', 'https://user:pw@i.pinimg.com/a.jpg'],
    ['an explicit port', 'https://i.pinimg.com:22/a.jpg'],
    ['a protocol-relative url', '//i.pinimg.com/a.jpg'],
    ['a relative path', '/originals/a.jpg'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isPinImageUrl(url)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// extractOgImage — a best-effort scrape of one site's HTML with two regexes.
// These tests record exactly what it does and does not parse.
// ---------------------------------------------------------------------------

describe('extractOgImage', () => {
  it('reads the og:image meta tag', () => {
    const html = '<meta property="og:image" content="https://i.pinimg.com/originals/a.jpg">'
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/originals/a.jpg')
  })

  it('handles reversed attribute order', () => {
    const html = '<meta content="https://i.pinimg.com/b.jpg" property="og:image"/>'
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/b.jpg')
  })

  it('returns null when absent', () => {
    expect(extractOgImage('<html></html>')).toBe(null)
  })

  it('accepts single quotes and odd spacing', () => {
    const html = "<meta   property = 'og:image'   content = 'https://i.pinimg.com/c.jpg' >"
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/c.jpg')
  })

  it('accepts name= as well as property=', () => {
    const html = '<meta name="og:image" content="https://i.pinimg.com/d.jpg">'
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/d.jpg')
  })

  it('is not confused by og:image:width appearing first', () => {
    const html =
      '<meta property="og:image:width" content="600">' +
      '<meta property="og:image" content="https://i.pinimg.com/e.jpg">'
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/e.jpg')
  })

  it('does not read content from a neighbouring tag', () => {
    const html =
      '<meta property="og:title" content="a title">' + '<meta property="og:image">'
    expect(extractOgImage(html)).toBe(null)
  })

  it('takes the first of several og:image tags', () => {
    const html =
      '<meta property="og:image" content="https://i.pinimg.com/first.jpg">' +
      '<meta property="og:image" content="https://i.pinimg.com/second.jpg">'
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/first.jpg')
  })

  it('decodes the entities an HTML attribute can carry', () => {
    const html = '<meta property="og:image" content="https://i.pinimg.com/a.jpg?x=1&amp;y=2">'
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/a.jpg?x=1&y=2')
  })

  it('falls back to og:image:secure_url', () => {
    const html = '<meta property="og:image:secure_url" content="https://i.pinimg.com/f.jpg">'
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/f.jpg')
  })

  it('falls back to twitter:image', () => {
    const html = '<meta name="twitter:image" content="https://i.pinimg.com/g.jpg">'
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/g.jpg')
  })

  it('prefers og:image over the fallbacks wherever it appears', () => {
    const html =
      '<meta name="twitter:image" content="https://i.pinimg.com/twitter.jpg">' +
      '<meta property="og:image" content="https://i.pinimg.com/og.jpg">'
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/og.jpg')
  })

  it('ignores an empty content attribute', () => {
    expect(extractOgImage('<meta property="og:image" content="">')).toBe(null)
  })

  // Documented limitation, not an accident: an unquoted attribute value is
  // legal HTML and this scraper does not read it. The owner gets the
  // download-and-drop message, which is the designed failure for this feature.
  it('does not read an unquoted content attribute', () => {
    expect(extractOgImage('<meta property=og:image content=https://i.pinimg.com/h.jpg>')).toBe(null)
  })

  // The other documented limitation: this is a regex over text, so a tag
  // quoted inside a script is indistinguishable from a real one. Harmless —
  // whatever it yields still has to pass isPinImageUrl.
  it('will read a meta tag quoted inside a script', () => {
    const html = `<script>var s = '<meta property="og:image" content="https://i.pinimg.com/j.jpg">'</script>`
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/j.jpg')
  })

  it('bounds the value it will return', () => {
    const html = `<meta property="og:image" content="https://i.pinimg.com/${'a'.repeat(5000)}.jpg">`
    expect(extractOgImage(html)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// resolvePinImage — resolve against the FINAL page URL, then validate.
// ---------------------------------------------------------------------------

describe('resolvePinImage', () => {
  const page = 'https://www.pinterest.com/pin/12345/'

  it('accepts an absolute image url', () => {
    expect(resolvePinImage(page, 'https://i.pinimg.com/a.jpg')).toBe('https://i.pinimg.com/a.jpg')
  })

  it('resolves a protocol-relative url against the page scheme', () => {
    expect(resolvePinImage(page, '//i.pinimg.com/a.jpg')).toBe('https://i.pinimg.com/a.jpg')
  })

  it('rejects a relative url, which resolves to the page host', () => {
    // Resolves to https://www.pinterest.com/a.jpg — a page host, not an image
    // host, so the second fetch would be another HTML page.
    expect(resolvePinImage(page, '/a.jpg')).toBe(null)
  })

  it('rejects an absolute url on an attacker host', () => {
    expect(resolvePinImage(page, 'https://evil.com/a.jpg')).toBe(null)
  })

  it('rejects a data url', () => {
    expect(resolvePinImage(page, 'data:image/png;base64,iVBORw0KGgo=')).toBe(null)
  })

  it('rejects garbage', () => {
    expect(resolvePinImage(page, '%%%')).toBe(null)
  })

  it('normalises traversal before validating', () => {
    expect(resolvePinImage(page, 'https://i.pinimg.com/x/../a.jpg')).toBe(
      'https://i.pinimg.com/a.jpg',
    )
  })
})

describe('pinName', () => {
  it('keeps the host and path so the owner recognises the row', () => {
    expect(pinName('https://tr.pinterest.com/pin/12345/?utm_source=x')).toBe(
      'tr.pinterest.com/pin/12345/',
    )
  })

  it('bounds a long url, because the name is echoed back to the client', () => {
    expect(pinName(`https://www.pinterest.com/pin/${'a'.repeat(1000)}`).length).toBe(200)
  })

  it('falls back to the raw string when the url will not parse', () => {
    expect(pinName('not a url')).toBe('not a url')
  })
})

// ---------------------------------------------------------------------------
// fetchPinImage — the two fetches, with a stubbed fetch so the suite never
// touches the network. The guards under test are the real ones.
// ---------------------------------------------------------------------------

type Call = { url: string; init?: RequestInit }

function stub(handlers: Record<string, () => Response>) {
  const calls: Call[] = []
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init })
    const handler = handlers[url]
    if (!handler) throw new Error(`unexpected fetch: ${url}`)
    return handler()
  }) as unknown as typeof fetch
  return { impl, calls }
}

const PAGE = 'https://www.pinterest.com/pin/12345/'
const IMAGE = 'https://i.pinimg.com/originals/a.jpg'
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])

/**
 * The rejection, or a short description of the value it resolved with.
 *
 * Used by the cap tests: `.rejects.toThrow()` on a call that wrongly succeeded
 * hands vitest a 25MB Uint8Array to pretty-print, and the reporter dies of a
 * heap overflow before it can say which assertion failed.
 */
async function outcome(p: Promise<Uint8Array>): Promise<unknown> {
  return p.then((v) => `resolved with ${v.byteLength} bytes`, (e) => e)
}

function html(body: string) {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/html' } })
}

function ogPage(image = IMAGE) {
  return html(`<html><head><meta property="og:image" content="${image}"></head></html>`)
}

describe('fetchPinImage', () => {
  it('downloads the image the page advertises', async () => {
    const { impl, calls } = stub({
      [PAGE]: () => ogPage(),
      [IMAGE]: () => new Response(JPEG, { status: 200 }),
    })
    expect(await fetchPinImage(PAGE, impl)).toEqual(JPEG)
    expect(calls.map((c) => c.url)).toEqual([PAGE, IMAGE])
  })

  it('never fetches anything when the pasted url is not a pin url', async () => {
    const { impl, calls } = stub({})
    await expect(fetchPinImage('https://pinterest.com.evil.com/pin/1', impl)).rejects.toThrow(
      PinError,
    )
    expect(calls).toEqual([])
  })

  it('refuses a url that is too long to be a pin link', async () => {
    const { impl, calls } = stub({})
    await expect(
      fetchPinImage(`https://www.pinterest.com/pin/${'1'.repeat(4000)}`, impl),
    ).rejects.toThrow(PinError)
    expect(calls).toEqual([])
  })

  it('sends every request with a timeout and manual redirect handling', async () => {
    const { impl, calls } = stub({
      [PAGE]: () => ogPage(),
      [IMAGE]: () => new Response(JPEG, { status: 200 }),
    })
    await fetchPinImage(PAGE, impl)
    for (const call of calls) {
      expect(call.init?.signal).toBeInstanceOf(AbortSignal)
      expect(call.init?.redirect).toBe('manual')
    }
  })

  it('bounds the whole operation, not just each request', async () => {
    // A server that accepts the connection and then says nothing. Per-request
    // timeouts alone would let a redirect chain of them outlive the function.
    const hang = (async (_input: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init!.signal!
        signal.addEventListener('abort', () => reject(signal.reason))
      })
    }) as unknown as typeof fetch
    const started = Date.now()
    await expect(fetchPinImage(PAGE, hang, 30)).rejects.toThrow(PinError)
    // Not the 8s a single page request is allowed on its own.
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('tells the owner to drop the image when Pinterest blocks the page', async () => {
    const { impl } = stub({ [PAGE]: () => new Response('nope', { status: 403 }) })
    await expect(fetchPinImage(PAGE, impl)).rejects.toThrow(/indirip/)
  })

  it('tells the owner to drop the image when the page has no og:image', async () => {
    // Exactly what pinterest.com serves a logged-out server-side request: 200,
    // a megabyte of JavaScript shell, and no Open Graph tags at all.
    const { impl, calls } = stub({ [PAGE]: () => html('<html><head><title>Pinterest</title></head></html>') })
    await expect(fetchPinImage(PAGE, impl)).rejects.toThrow(/indirip/)
    expect(calls).toHaveLength(1)
  })

  it.each([
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['an internal host', 'http://10.0.0.5/admin'],
    ['a file url', 'file:///etc/passwd'],
    ['a data url', 'data:image/png;base64,iVBORw0KGgo='],
    ['an attacker host', 'https://evil.com/a.jpg'],
    ['a lookalike image host', 'https://i.pinimg.com.evil.com/a.jpg'],
    ['a page url, which would loop', 'https://www.pinterest.com/pin/999/'],
  ])('refuses an og:image pointing at %s without fetching it', async (_label, target) => {
    const { impl, calls } = stub({ [PAGE]: () => ogPage(target) })
    await expect(fetchPinImage(PAGE, impl)).rejects.toThrow(PinError)
    expect(calls.map((c) => c.url)).toEqual([PAGE])
  })

  it('follows a shortener redirect and resolves og:image against the final url', async () => {
    const short = 'https://pin.it/abc'
    const { impl, calls } = stub({
      [short]: () => new Response(null, { status: 302, headers: { location: PAGE } }),
      [PAGE]: () => ogPage(),
      [IMAGE]: () => new Response(JPEG, { status: 200 }),
    })
    expect(await fetchPinImage(short, impl)).toEqual(JPEG)
    expect(calls.map((c) => c.url)).toEqual([short, PAGE, IMAGE])
  })

  it('resolves a relative Location against the url that sent it', async () => {
    const short = 'https://pin.it/abc'
    const { impl, calls } = stub({
      [short]: () => new Response(null, { status: 301, headers: { location: '/pin/9/' } }),
      'https://pin.it/pin/9/': () => ogPage(),
      [IMAGE]: () => new Response(JPEG, { status: 200 }),
    })
    expect(await fetchPinImage(short, impl)).toEqual(JPEG)
    expect(calls.map((c) => c.url)).toEqual([short, 'https://pin.it/pin/9/', IMAGE])
  })

  it.each([
    ['an off-list host', 'https://evil.com/pin/1'],
    ['a lookalike host', 'https://pinterest.com.evil.com/pin/1'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['a scheme downgrade', 'http://www.pinterest.com/pin/1'],
    ['a file url', 'file:///etc/passwd'],
  ])('refuses a redirect to %s without fetching it', async (_label, target) => {
    const { impl, calls } = stub({
      [PAGE]: () => new Response(null, { status: 302, headers: { location: target } }),
    })
    await expect(fetchPinImage(PAGE, impl)).rejects.toThrow(PinError)
    expect(calls.map((c) => c.url)).toEqual([PAGE])
  })

  it('gives up on a redirect loop instead of following it forever', async () => {
    const other = 'https://tr.pinterest.com/pin/12345/'
    const { impl, calls } = stub({
      [PAGE]: () => new Response(null, { status: 302, headers: { location: other } }),
      [other]: () => new Response(null, { status: 302, headers: { location: PAGE } }),
    })
    await expect(fetchPinImage(PAGE, impl)).rejects.toThrow(PinError)
    expect(calls.length).toBeLessThanOrEqual(8)
  })

  it('refuses a redirect with no Location header', async () => {
    const { impl } = stub({ [PAGE]: () => new Response(null, { status: 302 }) })
    await expect(fetchPinImage(PAGE, impl)).rejects.toThrow(PinError)
  })

  it('fails closed on a runtime that opaque-filters a manual redirect', async () => {
    // A browser-like fetch answers redirect: 'manual' with an opaque response:
    // status 0, no headers, and a Location that cannot be read. Node's does
    // not, but on a runtime that does, an unreadable redirect must be refused
    // as a blocked PAGE, not mistaken for a 200 that simply carried no
    // og:image — the difference is the message the owner reads.
    const opaque = new Response(new Uint8Array(0), { status: 200 })
    Object.defineProperty(opaque, 'status', { value: 0 })
    Object.defineProperty(opaque, 'type', { value: 'opaqueredirect' })
    const { impl } = stub({ [PAGE]: () => opaque })
    await expect(fetchPinImage(PAGE, impl)).rejects.toThrow(/sayfası açılamadı/)
  })

  it('reports a failed image download as a download-and-drop', async () => {
    const { impl } = stub({
      [PAGE]: () => ogPage(),
      [IMAGE]: () => new Response('nope', { status: 404 }),
    })
    await expect(fetchPinImage(PAGE, impl)).rejects.toThrow(/indirip/)
  })

  it('rejects an image response with no body', async () => {
    const { impl } = stub({
      [PAGE]: () => ogPage(),
      [IMAGE]: () => new Response(null, { status: 200 }),
    })
    await expect(fetchPinImage(PAGE, impl)).rejects.toThrow(PinError)
  })

  it('stops reading HTML at the cap instead of buffering the whole response', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(64 * 1024))
      },
    })
    const { impl } = stub({ [PAGE]: () => new Response(endless, { status: 200 }) })
    expect(await outcome(fetchPinImage(PAGE, impl))).toBeInstanceOf(PinError)
    // Bounded by the cap, not by how much the sender was willing to send.
    expect(pulled).toBeLessThanOrEqual(MAX_HTML_BYTES / (64 * 1024) + 2)
  })

  it('stops reading the image at the cap', async () => {
    let pulled = 0
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled++
        controller.enqueue(new Uint8Array(1024 * 1024))
      },
    })
    const { impl } = stub({
      [PAGE]: () => ogPage(),
      [IMAGE]: () => new Response(endless, { status: 200 }),
    })
    expect(await outcome(fetchPinImage(PAGE, impl))).toBeInstanceOf(PinError)
    expect(pulled).toBeLessThanOrEqual(MAX_IMAGE_BYTES / (1024 * 1024) + 2)
  })

  it('ignores a lying Content-Length and counts the bytes it actually read', async () => {
    // The header is advisory; a cap that trusts it is not a cap.
    const body = new Uint8Array(MAX_IMAGE_BYTES + 1024)
    const { impl } = stub({
      [PAGE]: () => ogPage(),
      [IMAGE]: () => new Response(body, { status: 200, headers: { 'content-length': '10' } }),
    })
    expect(await outcome(fetchPinImage(PAGE, impl))).toBeInstanceOf(PinError)
  })

  it('throws PinError, never a raw fetch failure, when the network gives out', async () => {
    const impl = (async () => {
      throw new TypeError('fetch failed: connect ECONNREFUSED 10.0.0.1:443')
    }) as unknown as typeof fetch
    const e = await fetchPinImage(PAGE, impl).catch((err) => err)
    expect(e).toBeInstanceOf(PinError)
    expect((e as Error).message).not.toMatch(/ECONNREFUSED/)
  })
})

// ---------------------------------------------------------------------------
// The same guards over a real socket: a local server, reached through a
// fetchImpl that rewrites the validated https URL to 127.0.0.1. The URLs
// fetchPinImage validates are real Pinterest URLs; nothing leaves the machine.
// ---------------------------------------------------------------------------

describe('fetchPinImage over a local server', () => {
  async function withServer(
    handler: http.RequestListener,
    run: (fetchImpl: typeof fetch) => Promise<void>,
  ) {
    const server = http.createServer(handler)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input))
      // Only ever rewrites a URL the guards already accepted.
      return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, init)
    }) as unknown as typeof fetch
    try {
      await run(fetchImpl)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('ingests a real streamed response end to end', async () => {
    await withServer(
      (req, res) => {
        if (req.url?.startsWith('/pin/')) {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end(`<meta property="og:image" content="${IMAGE}">`)
        } else {
          res.writeHead(200, { 'content-type': 'image/jpeg' })
          res.end(Buffer.from(JPEG))
        }
      },
      async (fetchImpl) => {
        expect(await fetchPinImage(PAGE, fetchImpl)).toEqual(JPEG)
      },
    )
  })

  it('follows a real 302 chain and refuses the hop that leaves the allowlist', async () => {
    await withServer(
      (req, res) => {
        if (req.url === '/short') {
          res.writeHead(302, { location: 'https://evil.example.com/pin/1' })
          res.end()
        } else {
          res.writeHead(200, { 'content-type': 'text/html' })
          res.end('<meta property="og:image" content="https://i.pinimg.com/a.jpg">')
        }
      },
      async (fetchImpl) => {
        await expect(fetchPinImage('https://pin.it/short', fetchImpl)).rejects.toThrow(PinError)
      },
    )
  })

  it('drops a real endless response at the cap rather than buffering it', async () => {
    let sent = 0
    await withServer(
      (req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' })
        const chunk = Buffer.alloc(256 * 1024, 'x')
        let open = true
        req.on('close', () => {
          open = false
        })
        const pump = () => {
          while (open && sent < MAX_HTML_BYTES * 4) {
            sent += chunk.length
            if (!res.write(chunk)) {
              res.once('drain', pump)
              return
            }
          }
          res.end()
        }
        pump()
      },
      async (fetchImpl) => {
        expect(await outcome(fetchPinImage(PAGE, fetchImpl))).toBeInstanceOf(PinError)
        // The socket closed near the cap, not near the four times as much the
        // sender was willing to write.
        expect(sent).toBeLessThan(MAX_HTML_BYTES * 2)
      },
    )
  }, 20_000)
})
