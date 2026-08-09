import { describe, it, expect, afterEach } from 'vitest'
import { ImageValidationError } from '@/src/lib/images/process'
import { decideIngest, toIngestFailure, isStagedBlobUrl, stagedBlobHost, IngestError } from './repo'

describe('decideIngest', () => {
  it('adds an image whose hash is unseen', () => {
    expect(decideIngest('aaa', new Set(['bbb']))).toEqual({ status: 'added' })
  })

  it('rejects an image whose hash is already stored', () => {
    expect(decideIngest('aaa', new Set(['aaa']))).toEqual({ status: 'duplicate' })
  })

  it('adds when the known-hash set is empty', () => {
    expect(decideIngest('aaa', new Set())).toEqual({ status: 'added' })
  })

  it('adds when the hash differs from a known hash by a single character', () => {
    expect(decideIngest('aaaa', new Set(['aaab']))).toEqual({ status: 'added' })
  })
})

// The route shows an IngestError's message to the owner verbatim and masks
// everything else as 'yüklenemedi'. What becomes an IngestError therefore
// decides exactly what an uploader can make the server echo back.
describe('toIngestFailure', () => {
  it('promotes a deliberate validation failure to IngestError, message intact', () => {
    const out = toIngestFailure(new ImageValidationError('görsel çok küçük — en az 320px olmalı'))
    expect(out).toBeInstanceOf(IngestError)
    expect((out as Error).message).toBe('görsel çok küçük — en az 320px olmalı')
  })

  it('passes a libvips decode failure through unchanged', () => {
    const raw = new Error('VipsJpeg: Premature end of input file /var/task/node_modules/.pnpm/sharp')
    const out = toIngestFailure(raw)
    expect(out).not.toBeInstanceOf(IngestError)
    expect(out).toBe(raw)
  })

  it('passes an error carrying a connection string through unchanged', () => {
    const raw = new Error('connect ECONNREFUSED postgres://user:pw@host/db')
    expect(toIngestFailure(raw)).not.toBeInstanceOf(IngestError)
  })

  it('does not promote a subclass-lookalike that merely has the same message shape', () => {
    // instanceof, not duck-typing: an error from anywhere else carrying a
    // Turkish-looking message must still be masked.
    expect(toIngestFailure(new Error('görsel çok küçük — en az 320px olmalı'))).not.toBeInstanceOf(
      IngestError,
    )
  })

  it('passes non-Error throwables through unchanged', () => {
    expect(toIngestFailure('a string')).toBe('a string')
    expect(toIngestFailure(undefined)).toBe(undefined)
  })
})

// ingestFromUrl makes the server fetch a URL the client supplied. This guard is
// the only thing standing between that and a server-side request forgery, so it
// is tested against the standard bypass repertoire.
describe('isStagedBlobUrl', () => {
  const HOST = 'br8lst74pmncgcsn.public.blob.vercel-storage.com'
  const good = `https://${HOST}/tmp/abc-123.jpg`

  it('accepts a staged object in our own blob store', () => {
    expect(isStagedBlobUrl(good, HOST)).toBe(true)
  })

  it('fails closed when the store host is unknown', () => {
    expect(isStagedBlobUrl(good, null)).toBe(false)
  })

  it.each([
    ['plain http', `http://${HOST}/tmp/a.jpg`],
    ['file scheme', 'file:///etc/passwd'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['localhost', 'https://localhost/tmp/a.jpg'],
    ['unrelated host', 'https://evil.example.com/tmp/a.jpg'],
    // Another Vercel customer's store. The store id is recoverable from any
    // read-write token, so a suffix match trusts every tenant on the platform.
    ['a different blob store', 'https://someoneelse.public.blob.vercel-storage.com/tmp/a.jpg'],
    ['suffix as a prefix', 'https://public.blob.vercel-storage.com.evil.com/tmp/a.jpg'],
    ['bare suffix host', 'https://public.blob.vercel-storage.com/tmp/a.jpg'],
    // Attacker-controlled domain that merely CONTAINS the store host — the
    // case that survives any substring match on the hostname or href.
    ['our host as a subdomain of theirs', `https://${HOST}.evil.com/tmp/a.jpg`],
    // Ends with our host exactly, so only an equality check rejects it.
    ['an extra label in front of our host', `https://other.${HOST}/tmp/a.jpg`],
    ['suffix in path only', 'https://evil.com/.public.blob.vercel-storage.com/tmp/a.jpg'],
    ['suffix in the query string', 'https://evil.com/tmp/a.jpg?x=.public.blob.vercel-storage.com'],
    ['suffix in a fragment', 'https://evil.com/tmp/a.jpg#.public.blob.vercel-storage.com'],
    ['leading-dot host', 'https://.public.blob.vercel-storage.com/tmp/a.jpg'],
    ['userinfo trick', `https://${HOST}@evil.com/tmp/a.jpg`],
    ['credentials on the real host', `https://user:pw@${HOST}/tmp/a.jpg`],
    ['a username only', `https://user@${HOST}/tmp/a.jpg`],
    ['a password only', `https://:pw@${HOST}/tmp/a.jpg`],
    ['explicit port', `https://${HOST}:22/tmp/a.jpg`],
    ['outside tmp/', `https://${HOST}/queue/a.jpg`],
    ['tmp without slash', `https://${HOST}/tmpfoo/a.jpg`],
    // /tmp/ appears in the path but not at the start — the case that survives
    // a substring match on the pathname.
    ['tmp/ nested under another prefix', `https://${HOST}/queue/tmp/a.jpg`],
    // new URL() leaves %2f encoded, so this passes a startsWith('/tmp/') test
    // while the CDN may resolve it to /queue/a.jpg — which ingestFromUrl deletes.
    ['encoded traversal', `https://${HOST}/tmp/..%2fqueue/a.jpg`],
    ['semicolon traversal', `https://${HOST}/tmp/..;/queue/a.jpg`],
    ['literal traversal', `https://${HOST}/tmp/../queue/a.jpg`],
    ['query string', `https://${HOST}/tmp/a.jpg?download=1`],
    ['fragment', `https://${HOST}/tmp/a.jpg#x`],
    ['nested path under tmp', `https://${HOST}/tmp/sub/a.jpg`],
    ['overlong name', `https://${HOST}/tmp/${'a'.repeat(201)}.jpg`],
    ['not a url', 'tmp/a.jpg'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isStagedBlobUrl(url, HOST)).toBe(false)
  })
})

describe('stagedBlobHost', () => {
  const saved = process.env.BLOB_READ_WRITE_TOKEN
  afterEach(() => {
    if (saved === undefined) delete process.env.BLOB_READ_WRITE_TOKEN
    else process.env.BLOB_READ_WRITE_TOKEN = saved
  })

  it('derives the store host from the read-write token', () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_storeid123_secretpart'
    expect(stagedBlobHost()).toBe('storeid123.public.blob.vercel-storage.com')
  })

  // URL.hostname is always lowercased, so an uppercase store id would derive a
  // host that could never compare equal to a parsed one.
  it('lowercases the store id so it can match a parsed hostname', () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'vercel_blob_rw_STOREID123_secretpart'
    const host = stagedBlobHost()
    expect(host).toBe('storeid123.public.blob.vercel-storage.com')
    expect(isStagedBlobUrl(`https://STOREID123.public.blob.vercel-storage.com/tmp/a.jpg`, host)).toBe(
      true,
    )
  })

  it('returns null when the token is unset, so the guard fails closed', () => {
    delete process.env.BLOB_READ_WRITE_TOKEN
    expect(stagedBlobHost()).toBeNull()
  })

  it('returns null for a token without a store id field', () => {
    process.env.BLOB_READ_WRITE_TOKEN = 'garbage'
    expect(stagedBlobHost()).toBeNull()
  })
})
