import { describe, it, expect } from 'vitest'
import { createDryRunClient } from './dryrun'

const client = createDryRunClient()

describe('dry-run client', () => {
  it('publishes a feed post and returns a placeholder permalink', async () => {
    const r = await client.publish({ kind: 'feed', imageUrls: ['https://x/1.jpg'], caption: 'hi' })
    expect(r.igMediaId).toMatch(/^dryrun-/)
    expect(r.permalink).toContain('dryrun')
  })

  it('rejects an empty caption on a feed post', async () => {
    await expect(client.publish({ kind: 'feed', imageUrls: ['https://x/1.jpg'], caption: '  ' }))
      .rejects.toThrow('caption is empty')
  })

  it('rejects a single-image carousel', async () => {
    await expect(client.publish({ kind: 'carousel', imageUrls: ['https://x/1.jpg'], caption: 'hi' }))
      .rejects.toThrow('between 2 and 10')
  })

  it('rejects an 11-image carousel', async () => {
    const urls = Array.from({ length: 11 }, (_, i) => `https://x/${i}.jpg`)
    await expect(client.publish({ kind: 'carousel', imageUrls: urls, caption: 'hi' }))
      .rejects.toThrow('between 2 and 10')
  })

  it('allows a story with no caption', async () => {
    const r = await client.publish({ kind: 'story', imageUrls: ['https://x/1.jpg'], caption: '' })
    expect(r.igMediaId).toMatch(/^dryrun-/)
  })

  it('returns zeroed insights', async () => {
    expect(await client.insights('dryrun-1')).toEqual({ likes: 0, comments: 0, reach: 0, saved: 0 })
  })
})
