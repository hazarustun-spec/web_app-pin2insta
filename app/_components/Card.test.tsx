import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { Card } from './Card'
import { cardTimes, type ViewItem, type ViewSettings } from '@/src/lib/queue/view'

/**
 * What one card SAYS about when it goes out.
 *
 * The label is the only place the two kinds of time are distinguishable, and it
 * is also the only warning that a chosen time is going to pass with nothing
 * posted. A card that shows a bare time for an item the publisher will refuse
 * is a promise the app does not keep, so the exact sentences are pinned here —
 * and they are produced by `cardTimes`, not hand-written into the test, so this
 * covers the whole path from the row to the screen.
 */

const SETTINGS: ViewSettings = {
  slots: ['10:00', '14:00', '20:00'], timezone: 'Europe/Istanbul', hashtags: '',
}
/** 2026-08-09 08:00 Europe/Istanbul. */
const NOW = new Date('2026-08-09T05:00:00Z')

function item(over: Partial<ViewItem> & { id: string }): ViewItem {
  return {
    kind: 'feed',
    caption: 'bir açıklama',
    status: 'pending',
    attempts: 0,
    error: null,
    postedDate: null,
    slotIndex: null,
    scheduledAt: null,
    images: [{ url: 'https://example.invalid/a.jpg' }],
    ...over,
  }
}

function render(rows: ViewItem[], id = rows[0].id, settings = SETTINGS): string {
  const times = cardTimes(rows, settings, NOW)
  const row = rows.find((r) => r.id === id)!
  return renderToStaticMarkup(
    <Card
      item={row}
      time={times.get(row.id) ?? null}
      timezone={settings.timezone}
      takenKeysFor={() => new Set()}
      selected={false}
      dragging={false}
      dropTarget={false}
      onSelect={() => {}}
      onCaptionSaved={() => {}}
      onScheduled={() => {}}
      onAdvance={() => {}}
      onDragStart={() => {}}
      onDragOver={() => {}}
      onDragEnd={() => {}}
      onDrop={() => {}}
    />,
  )
}

describe('the time on a card', () => {
  it('names the slot the queue computed, with no claim that anyone chose it', () => {
    const html = render([item({ id: 'a' })])
    // Anchored to the TEXT of the label, not its title attribute: both carry
    // the sentence, and only one of them is what the owner reads.
    expect(html).toContain('>Bugün 10:00<')
    expect(html).not.toContain('seçilen saat')
    expect(html).not.toContain('text-red-600')
  })

  it('says an explicit future time is one the owner chose', () => {
    const html = render([item({ id: 'a', scheduledAt: '2026-08-09T11:35:00.000Z' })])
    expect(html).toContain('>Bugün 14:35 · seçilen saat<')
    expect(html).not.toContain('text-red-600')
  })

  it('says in red that a time went by with nothing posted', () => {
    const html = render([item({ id: 'a', scheduledAt: '2026-08-09T03:00:00.000Z' })])
    expect(html).toContain('>Bugün 06:00 · saati geçti, paylaşılmadı<')
    expect(html).toContain('text-red-600')
  })

  it('warns that an uncaptioned chosen time will pass unused', () => {
    // The publisher refuses a non-story with no caption, so this minute is
    // spent on nothing at all — and no slot is spent instead.
    const html = render([item({ id: 'a', caption: '', scheduledAt: '2026-08-09T11:35:00.000Z' })])
    expect(html).toContain('>Bugün 14:35 · açıklama yok, boş geçecek<')
    expect(html).toContain('text-red-600')
  })

  it('offers the control filled in with the CONFIGURED zone\'s wall clock', () => {
    // 11:35 UTC is 14:35 in Istanbul and 13:35 in Berlin. The owner types the
    // time their account posts at, whatever machine they are sitting at.
    const rows = [item({ id: 'a', scheduledAt: '2026-08-09T11:35:00.000Z' })]
    expect(render(rows)).toContain('value="2026-08-09T14:35"')
    expect(render(rows, 'a', { ...SETTINGS, timezone: 'Europe/Berlin' }))
      .toContain('value="2026-08-09T13:35"')
  })

  it('leaves the control empty for an item that uses the next free slot', () => {
    expect(render([item({ id: 'a' })])).toContain('value=""')
  })

  it('shows a dash, not a time, for a card no publish will reach', () => {
    const html = render([item({ id: 'a', status: 'failed', error: 'boom' })])
    expect(html).toContain('>—<')
  })
})
