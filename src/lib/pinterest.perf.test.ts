import { describe, it, expect } from 'vitest'
import { extractOgImage } from './pinterest'

/**
 * The HTML comes from a host on the page allowlist, so no client of this app
 * can inject these bodies. The reason they are tested anyway: the obvious
 * implementations of this scan are super-linear, and a scan that takes minutes
 * on a 4MB body does not fail — it blocks the isolate for every concurrent
 * request until maxDuration kills it. Linear is the property, not a nicety.
 */
describe('extractOgImage is linear in the size of the document', () => {
  const FOUR_MB = 4 * 1024 * 1024

  function elapsed(html: string): number {
    const t = performance.now()
    extractOgImage(html)
    return performance.now() - t
  }

  it.each([
    ['a run of <meta that never closes', '<meta '],
    ['a run of quoted attributes', "<meta content='a' "],
    ['real meta tags', '<meta property="og:title" content="x">'],
  ])('scans %s at the size cap in well under a second', (_label, unit) => {
    const html = unit.repeat(Math.ceil(FOUR_MB / unit.length))
    expect(html.length).toBeGreaterThanOrEqual(FOUR_MB)
    expect(elapsed(html)).toBeLessThan(1000)
  })

  it('still finds the tag at the end of a large document', () => {
    const html = `${'<meta '.repeat(200_000)}<meta property="og:image" content="https://i.pinimg.com/originals/a.jpg">`
    expect(extractOgImage(html)).toBe('https://i.pinimg.com/originals/a.jpg')
  })
})
