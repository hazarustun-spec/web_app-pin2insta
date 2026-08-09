/**
 * Ingest an image from a pasted Pinterest link.
 *
 * The owner pastes a pin URL, the server fetches that page, reads its
 * `og:image`, and downloads the image. That is TWO server-side fetches of
 * client-influenced URLs — the second one taken out of HTML the server does not
 * control — which makes this module the most exposed server-side request
 * forgery surface in the app. It is written to the same rules as
 * `isStagedBlobUrl` in `src/lib/queue/repo.ts`:
 *
 *   - exact host matching, never a suffix pattern with a trailing wildcard;
 *   - https only, no credentials, no explicit port;
 *   - redirects followed manually, with EVERY hop re-validated before it is
 *     fetched, not after;
 *   - every body read through a counting cap, every fetch under a timeout;
 *   - one designated error type whose message may be shown to the owner.
 *
 * Nothing here defeats an access control. Pinterest answering a server-side
 * request with a JavaScript shell and no Open Graph tags is the EXPECTED case
 * (verified against a live pin while writing this), so every failure path ends
 * in the same instruction: download the image and drop it instead.
 *
 * Deliberately free of Node-only APIs — the queue page imports `isPinUrl` to
 * decide whether a pasted string is worth POSTing, so this module has to be
 * safe to bundle for the browser. That is why the image comes back as a
 * Uint8Array and the route, not this module, turns it into a Buffer.
 */

/**
 * Thrown for a condition the owner should read verbatim. Same contract as
 * IngestError and QueueError: the route echoes THIS message and masks
 * everything else, so a fetch failure carrying an internal address can never
 * reach the client.
 */
export class PinError extends Error {}

/** Every message ends in the same instruction, because a blocked fetch is the expected outcome, not an exception. */
const DROP_IT = 'görseli indirip sürükle'
const NOT_A_PIN = 'Pinterest linki değil'
const PAGE_BLOCKED = `Pinterest sayfası açılamadı — ${DROP_IT}`
const NO_IMAGE = `Görsel bulunamadı — ${DROP_IT}`
const IMAGE_FAILED = `Görsel indirilemedi — ${DROP_IT}`
const IMAGE_TOO_BIG = `Görsel çok büyük — ${DROP_IT}`

/**
 * Registrable domains Pinterest serves pin pages on, matched EXACTLY or as a
 * parent of the hostname — never as a substring or a suffix pattern.
 *
 * The plan used `/(^|\.)pinterest\.[a-z.]+$/`, which accepts
 * `pinterest.com.evil.com` and `pinterest.co.uk.attacker.net`: `[a-z.]+`
 * happily eats the attacker's own domain. Anything with a trailing wildcard on
 * the public-suffix side is not a host check.
 *
 * Each entry was verified to 30x-redirect to a `*.pinterest.com` host before it
 * was added. `pin.it` is Pinterest's own shortener and is why redirects have to
 * be followed at all.
 */
export const PIN_PAGE_DOMAINS: ReadonlySet<string> = new Set([
  'pinterest.com',
  'pin.it',
  'pinterest.at',
  'pinterest.be',
  'pinterest.ca',
  'pinterest.ch',
  'pinterest.cl',
  'pinterest.co.kr',
  'pinterest.co.uk',
  'pinterest.com.au',
  'pinterest.com.mx',
  'pinterest.de',
  'pinterest.dk',
  'pinterest.es',
  'pinterest.fr',
  'pinterest.ie',
  'pinterest.it',
  'pinterest.jp',
  'pinterest.mx',
  'pinterest.nl',
  'pinterest.nz',
  'pinterest.ph',
  'pinterest.pt',
  'pinterest.ru',
  'pinterest.se',
])

/**
 * Hosts an `og:image` may point at, matched exactly — `evil.i.pinimg.com` and
 * `i.pinimg.com.evil.com` are both somebody else's.
 *
 * Confirmed against a live pin page: pin images are served from `i.pinimg.com`
 * (`/originals/…`, `/564x/…`); `s`, `s1` and `s2` carry Pinterest's own static
 * assets and appear in the page's own Content-Security-Policy. `v.pinimg.com`
 * is video and is deliberately absent — this queue only publishes stills.
 *
 * The page domains are NOT in here: an og:image pointing back at pinterest.com
 * would make the server fetch another HTML page and hand it to the image
 * decoder.
 */
export const PIN_IMAGE_HOSTS: ReadonlySet<string> = new Set([
  'i.pinimg.com',
  's.pinimg.com',
  's1.pinimg.com',
  's2.pinimg.com',
])

/** A pasted link longer than this is not a pin URL; refusing early keeps it out of the regexes and the logs. */
export const MAX_PIN_URL_CHARS = 2048
/**
 * Cap on the pin page. A real logged-out pin page is about 1MB of JavaScript
 * shell, so this is roughly 4x the real thing — enough headroom for a heavier
 * page, far short of letting `text()` buffer whatever the sender feels like.
 */
export const MAX_HTML_BYTES = 4 * 1024 * 1024
/** Cap on the image, matching the 25MB ceiling a dropped file gets. A pin is not held to a stricter standard than a drop. */
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
/** pin.it → www.pinterest.com → a locale host is three; a loop stops here rather than running to maxDuration. */
const MAX_REDIRECTS = 3
const PAGE_TIMEOUT_MS = 8_000
const IMAGE_TIMEOUT_MS = 15_000
/**
 * Ceiling on the whole operation, shared by every request it makes.
 *
 * Per-request timeouts alone do not bound it: four hops at 8s plus a 15s image
 * is 47s, and the route's maxDuration is 60 — leaving too little for the crop,
 * the hash and the Blob upload that follow. Past this the function would be
 * killed mid-flight and the owner would see a platform error instead of the
 * sentence telling them to drop the image themselves.
 */
const TOTAL_FETCH_BUDGET_MS = 35_000
/** Mirrors MAX_NAME_CHARS in `app/api/items/route.ts`. The name is only ever echoed back to label a result row. */
const MAX_NAME_CHARS = 200

/**
 * A hostname made of non-empty labels. Rejects `.pinterest.com` (whose
 * `endsWith('.pinterest.com')` is true), `www.pinterest.com.` (the trailing-dot
 * FQDN, which resolves the same but compares differently) and `[::1]`.
 * `new URL()` has already lowercased and punycoded the host by the time this
 * sees it, so a Cyrillic homoglyph arrives as `xn--…` and cannot match.
 */
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/

/**
 * Parses a URL and applies the checks every allowed URL shares.
 *
 * Credentials and an explicit port are refused for the reason isStagedBlobUrl
 * refuses them: `https://www.pinterest.com@evil.com/` and
 * `https://www.pinterest.com:22/` mean something different to `fetch` than a
 * hostname check suggests, and the disagreement is the whole exploit.
 */
function parseGuarded(raw: unknown): URL | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_PIN_URL_CHARS) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return null
  }
  if (u.protocol !== 'https:') return null
  if (u.username || u.password || u.port) return null
  if (!HOSTNAME.test(u.hostname)) return null
  return u
}

/** True when `host` IS `domain` or a subdomain of it. `pinterest.com.evil.com` is neither. */
function under(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/** True for a URL the owner could have pasted: a Pinterest page, on a Pinterest-owned registrable domain. */
export function isPinUrl(raw: unknown): boolean {
  const u = parseGuarded(raw)
  if (!u) return false
  for (const domain of PIN_PAGE_DOMAINS) {
    if (under(u.hostname, domain)) return true
  }
  return false
}

/**
 * True for a URL the server may download an image from.
 *
 * Stricter than isPinUrl on purpose: this string comes out of a page's HTML, so
 * whoever controls that page controls it. Exact host match only — no subdomains.
 */
export function isPinImageUrl(raw: unknown): boolean {
  const u = parseGuarded(raw)
  return u !== null && PIN_IMAGE_HOSTS.has(u.hostname)
}

const ENTITIES: Record<string, string> = {
  '&quot;': '"',
  '&apos;': "'",
  '&lt;': '<',
  '&gt;': '>',
  '&#39;': "'",
  '&#x27;': "'",
  '&#x2F;': '/',
  '&#47;': '/',
}

/** Attribute values arrive entity-encoded; `?a=1&amp;b=2` is one query string, not a broken one. `&amp;` goes last so nothing is decoded twice. */
function decodeEntities(value: string): string {
  let out = value
  for (const [entity, char] of Object.entries(ENTITIES)) out = out.split(entity).join(char)
  return out.split('&amp;').join('&')
}

/** Escapes the characters a meta key could carry into a RegExp. The keys are constants today; this keeps that from becoming load-bearing. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The `content` of the first `<meta>` carrying `property="<key>"` or
 * `name="<key>"`, in either attribute order.
 *
 * Every character class excludes `>`, so a match cannot span two tags — that is
 * what stops `<meta property="og:title" content="x">` next to a bare
 * `<meta property="og:image">` from yielding "x".
 */
function metaContent(html: string, key: string): string | null {
  const k = escapeRe(key)
  const patterns = [
    `<meta[^>]+(?:property|name)\\s*=\\s*["']${k}["'][^>]*content\\s*=\\s*["']([^"']*)["']`,
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name)\\s*=\\s*["']${k}["']`,
  ]
  for (const pattern of patterns) {
    const m = new RegExp(pattern, 'i').exec(html)
    if (m && m[1]) return m[1]
  }
  return null
}

/**
 * The image URL a page advertises, or null.
 *
 * A regex over text, not a parser: it reads a quoted attribute and nothing
 * else, so an unquoted `content=…` is missed and a meta tag quoted inside a
 * `<script>` is read as if it were real. Both are fine for what this is — a
 * best-effort scrape of ONE site whose output still has to pass
 * isPinImageUrl before anything is fetched. A miss costs the owner the
 * download-and-drop message, which is the designed failure for this feature.
 *
 * The value is bounded here as well as in parseGuarded, so a page cannot make
 * the server carry a megabyte-long "URL" around before rejecting it.
 */
export function extractOgImage(html: string): string | null {
  for (const key of ['og:image', 'og:image:secure_url', 'twitter:image']) {
    const raw = metaContent(html, key)
    if (!raw) continue
    const decoded = decodeEntities(raw).trim()
    if (decoded && decoded.length <= MAX_PIN_URL_CHARS) return decoded
  }
  return null
}

/**
 * Resolves what the page advertised against the page's FINAL URL, then
 * validates the result. Extracted values are routinely relative (`/a.jpg`) or
 * protocol-relative (`//i.pinimg.com/a.jpg`), and both have to become an
 * absolute URL before the allowlist means anything.
 *
 * Resolution happens BEFORE validation for the reason isStagedBlobUrl matches
 * whole paths: `https://i.pinimg.com/x/../a.jpg` and `https://i.pinimg.com/a.jpg`
 * are the same request, and the guard should judge the one that will be sent.
 */
export function resolvePinImage(pageUrl: string, extracted: string): string | null {
  let resolved: string
  try {
    resolved = new URL(extracted, pageUrl).toString()
  } catch {
    return null
  }
  return isPinImageUrl(resolved) ? resolved : null
}

/** A label for the queue row. Query and fragment are dropped (a pasted link is mostly campaign junk) and the result is bounded, because it is echoed back to the client. */
export function pinName(url: string): string {
  try {
    const u = new URL(url)
    return `${u.hostname}${u.pathname}`.slice(0, MAX_NAME_CHARS)
  } catch {
    return url.slice(0, MAX_NAME_CHARS)
  }
}

/**
 * Reads a body, stopping as soon as it exceeds `limit`.
 *
 * The twin of readCapped in `src/lib/queue/repo.ts`, kept separate because the
 * two throw different designated error types with different owner-facing
 * messages, and that difference is the point of both. The reasoning is the
 * same: `arrayBuffer()` buffers first and measures second, and Content-Length
 * is advisory and absent on a chunked response, so counting as we read is the
 * only bound that holds when the sender is not cooperating.
 */
async function readCapped(res: Response, limit: number, tooLarge: string, failed: string) {
  if (!res.body) throw new PinError(failed)
  const chunks: Uint8Array[] = []
  let total = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > limit) throw new PinError(tooLarge)
      chunks.push(value)
    }
  } catch (e) {
    if (e instanceof PinError) throw e
    // A socket that dies mid-body can carry an internal address in its message.
    console.error('pin body read failed:', e)
    throw new PinError(failed)
  } finally {
    // Releases the socket when we bailed out early — without this an endless
    // sender keeps sending.
    await reader.cancel().catch(() => {})
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const REDIRECTS = new Set([301, 302, 303, 307, 308])

/**
 * Fetches `start`, following redirects BY HAND so that every hop is validated
 * against `allowed` before it is requested.
 *
 * `redirect: 'follow'` cannot do this. By the time `res.url` can be checked the
 * request has already been made, and a pin page that 302s to
 * `http://169.254.169.254/` has already had the function's network position
 * pointed at the metadata service. Checking after the fact catches the leak,
 * not the request.
 */
async function follow(
  start: string,
  allowed: (u: string) => boolean,
  timeoutMs: number,
  deadline: AbortSignal,
  fetchImpl: typeof fetch,
  failed: string,
): Promise<{ res: Response; url: string }> {
  let current = start
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!allowed(current)) throw new PinError(failed)
    let res: Response
    try {
      res = await fetchImpl(current, {
        // Not 'follow': see above. Not 'error' either — pin.it is a shortener,
        // so a redirect is the normal case and has to be walked.
        redirect: 'manual',
        // Whichever comes first: this request's own timeout, or the budget for
        // the whole operation, which every hop shares.
        signal: AbortSignal.any([deadline, AbortSignal.timeout(timeoutMs)]),
        headers: {
          'user-agent': 'Mozilla/5.0 (compatible; pin2insta/1.0)',
          accept: 'text/html,image/*;q=0.9,*/*;q=0.8',
        },
      })
    } catch (e) {
      // A DNS or TLS failure names the host it failed on; a timeout names the
      // timeout. Neither goes to the client.
      console.error('pin fetch failed:', e)
      throw new PinError(failed)
    }
    // A browser-like fetch answers redirect: 'manual' with an opaque response —
    // status 0, no headers — and Location cannot be read off it. Node's does
    // not, but on a runtime that does, fail closed rather than treat an
    // unreadable redirect as a 200.
    if (res.status === 0 || res.type === 'opaqueredirect') throw new PinError(failed)
    if (!REDIRECTS.has(res.status)) return { res, url: current }

    const location = res.headers.get('location')
    await res.body?.cancel().catch(() => {})
    if (!location) throw new PinError(failed)
    try {
      // Relative Locations are legal and common; resolve against the URL that
      // sent it, then round the loop so the result is validated like any other.
      current = new URL(location, current).toString()
    } catch {
      throw new PinError(failed)
    }
  }
  throw new PinError(failed)
}

/**
 * The pasted pin URL → the image bytes.
 *
 * `fetchImpl` exists so the tests can drive both fetches — including redirect
 * chains, endless bodies and off-allowlist hops — with the REAL guards in play
 * and without a packet leaving the machine.
 */
export async function fetchPinImage(
  url: string,
  fetchImpl: typeof fetch = fetch,
  budgetMs: number = TOTAL_FETCH_BUDGET_MS,
): Promise<Uint8Array> {
  if (!isPinUrl(url)) throw new PinError(NOT_A_PIN)

  // `budgetMs` is overridable for the same reason `fetchImpl` is: a test
  // otherwise has to wait out the real budget to prove it is enforced.
  const deadline = AbortSignal.timeout(budgetMs)
  const page = await follow(url, isPinUrl, PAGE_TIMEOUT_MS, deadline, fetchImpl, PAGE_BLOCKED)
  if (!page.res.ok) {
    await page.res.body?.cancel().catch(() => {})
    throw new PinError(PAGE_BLOCKED)
  }
  const bytes = await readCapped(page.res, MAX_HTML_BYTES, PAGE_BLOCKED, PAGE_BLOCKED)
  const html = new TextDecoder('utf-8').decode(bytes)

  const advertised = extractOgImage(html)
  if (!advertised) throw new PinError(NO_IMAGE)
  // Resolved against the FINAL page URL, not the pasted one: a pin.it link ends
  // up on www.pinterest.com and a relative og:image belongs to where it landed.
  const imageUrl = resolvePinImage(page.url, advertised)
  if (!imageUrl) throw new PinError(NO_IMAGE)

  const image = await follow(
    imageUrl,
    isPinImageUrl,
    IMAGE_TIMEOUT_MS,
    deadline,
    fetchImpl,
    IMAGE_FAILED,
  )
  if (!image.res.ok) {
    await image.res.body?.cancel().catch(() => {})
    throw new PinError(IMAGE_FAILED)
  }
  // No Content-Type check: it is the sender's claim about the bytes, and
  // cropTo45 reads the actual container header. Same reasoning as the
  // ALLOWED_TYPES comment in app/api/items/route.ts.
  return readCapped(image.res, MAX_IMAGE_BYTES, IMAGE_TOO_BIG, IMAGE_FAILED)
}
