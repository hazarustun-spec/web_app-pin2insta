import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { QueueBanner } from './QueueBanner'
import type { ComponentProps } from 'react'

/**
 * The banners are where this app says "something will not publish". A state
 * that stops a post and is not named here is invisible: the cards all look
 * ordinary, and the owner finds out by noticing nothing went up.
 */

type Props = ComponentProps<typeof QueueBanner>

const NONE: Props = {
  headBlockedReason: null,
  missingCaptions: 0,
  captionsTooLong: 0,
  unrecorded: 0,
  failed: 0,
  missed: 0,
  scheduledWaiting: 0,
  scheduledBlocked: 0,
  daysLeft: 10,
  waiting: 30,
  notes: [],
  onDismissNotes: () => {},
}

const render = (over: Partial<Props> = {}) =>
  renderToStaticMarkup(<QueueBanner {...NONE} {...over} />)

describe('QueueBanner', () => {
  it('says nothing when nothing is wrong', () => {
    expect(render()).toBe('')
  })

  it('names a chosen time that went by, and says how to recover', () => {
    // Nothing was attempted, so it is not `failed`; its time has gone, so it is
    // not an ordinary pending card; and no slot will be spent on it either,
    // because it carries a time of its own. Without this it waits forever.
    const html = render({ missed: 2 })
    expect(html).toContain('2 gönderinin seçilen saati geçti')
    expect(html).toContain('paylaşılmadı')
    // The two ways out, both of which the card offers.
    expect(html).toContain('yeni bir saat seçin')
    expect(html).toContain('saati kaldırın')
  })

  it('names a chosen time that is coming and will pass unused', () => {
    const html = render({ scheduledBlocked: 1 })
    expect(html).toContain('1 gönderinin saati seçilmiş')
    expect(html).toContain('boş geçecek')
  })

  it('does not claim the queue has stopped for either of them', () => {
    // An item with its own time blocks nothing: the slot path never looks at
    // it. Saying "kuyruk durdu" would send the owner after the wrong card.
    const html = render({ missed: 1, scheduledBlocked: 1 })
    expect(html).not.toContain('kuyruk durdu')
  })

  it('still says the queue stopped when the slot queue really is blocked', () => {
    expect(render({ headBlockedReason: 'missing-caption' })).toContain('kuyruk durdu')
  })
})
