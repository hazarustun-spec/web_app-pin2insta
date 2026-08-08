import { describe, it, expect } from 'vitest'
import { decideIngest } from './repo'

describe('decideIngest', () => {
  it('adds an image whose hash is unseen', () => {
    expect(decideIngest('aaa', new Set(['bbb']))).toEqual({ status: 'added' })
  })

  it('rejects an image whose hash is already stored', () => {
    expect(decideIngest('aaa', new Set(['aaa']))).toEqual({ status: 'duplicate' })
  })

  it('rejects a duplicate even when the original was already published', () => {
    // published rows keep their hash exactly so this stays true
    expect(decideIngest('published-hash', new Set(['published-hash']))).toEqual({ status: 'duplicate' })
  })
})
