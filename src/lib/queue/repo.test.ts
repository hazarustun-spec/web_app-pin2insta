import { describe, it, expect } from 'vitest'
import { decideIngest } from './repo'

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
