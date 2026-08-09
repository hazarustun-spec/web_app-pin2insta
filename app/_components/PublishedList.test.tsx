import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { PublishedList } from './PublishedList'
import type { PublishedPost } from '@/src/lib/insights'

/**
 * These four sentences are the whole point of the metric states. Each one is a
 * claim about why a post shows no numbers, and getting them crossed tells the
 * owner something untrue — a story once carried "Instagram kimliği
 * kaydedilmedi" beside a working link built from that very id.
 */
function post(over: Partial<PublishedPost> = {}): PublishedPost {
  return {
    id: 'a',
    kind: 'feed',
    caption: 'merhaba',
    postedAt: new Date('2026-08-12T11:00:00Z'),
    slotTime: '14:00',
    igMediaId: 'ig-a',
    permalink: 'https://instagram.com/p/ig-a',
    thumb: 'https://blob.example/thumb/a.jpg',
    imageCount: 1,
    metric: null,
    ...over,
  } as PublishedPost
}

function render(p: PublishedPost): string {
  return renderToStaticMarkup(
    <PublishedList posts={[p]} stats={[]} message={null} timezone="Europe/Istanbul" loadError={null} />,
  )
}

const MISSING_ID = 'Instagram kimliği kaydedilmedi'

describe('PublishedList metric states', () => {
  const measured = { likes: 9, comments: 1, saved: 2, reach: 90 }

  it('prints the numbers once they exist', () => {
    expect(render(post({ metric: measured }))).toContain('9 beğeni')
  })

  it('says a measurement is coming for a post the refresh will reach', () => {
    expect(render(post())).toContain('ölçüm bekleniyor')
  })

  it('names the missing id only for a post that really has none', () => {
    expect(render(post({ igMediaId: null }))).toContain(MISSING_ID)
  })

  // The regression: routing stories into the missing-id branch accused every
  // story of a fault it did not have.
  it.each([
    ['with a metrics row', { metric: measured }],
    ['without one', {}],
    ['with no instagram id either', { igMediaId: null }],
  ])('explains a story %s without accusing it of a lost id', (_label, over) => {
    const html = render(post({ kind: 'story', ...over }))
    expect(html).toContain('hikâyelerde beğeni, yorum ve kaydetme sayısı yok')
    expect(html).not.toContain(MISSING_ID)
    expect(html).not.toContain('ölçüm bekleniyor')
    // A story's zeros are not a measurement and must never be printed as one.
    expect(html).not.toContain('beğeni ·')
  })
})
