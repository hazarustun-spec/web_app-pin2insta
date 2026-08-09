import { describe, it, expect } from 'vitest'
import { ImageValidationError } from '@/src/lib/images/process'
import { decideIngest, toIngestFailure, isStagedBlobUrl, IngestError } from './repo'

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
  const good = 'https://br8lst74pmncgcsn.public.blob.vercel-storage.com/tmp/abc-123.jpg'

  it('accepts a staged object in our own blob store', () => {
    expect(isStagedBlobUrl(good)).toBe(true)
  })

  it.each([
    ['plain http', 'http://x.public.blob.vercel-storage.com/tmp/a.jpg'],
    ['file scheme', 'file:///etc/passwd'],
    ['cloud metadata', 'http://169.254.169.254/latest/meta-data/'],
    ['localhost', 'https://localhost/tmp/a.jpg'],
    ['unrelated host', 'https://evil.example.com/tmp/a.jpg'],
    ['suffix as a prefix', 'https://public.blob.vercel-storage.com.evil.com/tmp/a.jpg'],
    ['bare suffix host', 'https://public.blob.vercel-storage.com/tmp/a.jpg'],
    ['suffix in path only', 'https://evil.com/.public.blob.vercel-storage.com/tmp/a.jpg'],
    // The suffix appears in the URL and the path really does start with /tmp/,
    // so anything matching on the whole href rather than the hostname lets it in.
    ['suffix in the query string', 'https://evil.com/tmp/a.jpg?x=.public.blob.vercel-storage.com'],
    ['suffix in a fragment', 'https://evil.com/tmp/a.jpg#.public.blob.vercel-storage.com'],
    // Long enough to clear the hostname-length guard, so only the endsWith
    // check on the hostname itself can reject it.
    [
      'suffix in query, long host',
      'https://a-deliberately-long-attacker-hostname.example.com/tmp/a.jpg?x=.public.blob.vercel-storage.com',
    ],
    // hostname is exactly the suffix, leading dot and all — endsWith() alone says yes.
    ['leading-dot host', 'https://.public.blob.vercel-storage.com/tmp/a.jpg'],
    ['userinfo trick', 'https://x.public.blob.vercel-storage.com@evil.com/tmp/a.jpg'],
    ['outside tmp/', 'https://x.public.blob.vercel-storage.com/queue/a.jpg'],
    ['tmp without slash', 'https://x.public.blob.vercel-storage.com/tmpfoo/a.jpg'],
    ['not a url', 'tmp/a.jpg'],
    ['empty', ''],
  ])('rejects %s', (_label, url) => {
    expect(isStagedBlobUrl(url)).toBe(false)
  })
})
