import { describe, it, expect } from 'vitest'
import { ImageValidationError } from '@/src/lib/images/process'
import { decideIngest, toIngestFailure, IngestError } from './repo'

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
