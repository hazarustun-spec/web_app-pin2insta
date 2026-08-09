import { describeAdvice, listPublished, type PublishedHistory } from '@/src/lib/insights'
import { getSettings } from '@/src/lib/settings'
import { DEFAULT_VIEW_SETTINGS } from '@/src/lib/queue/view'
import { PublishedList } from '../_components/PublishedList'

/**
 * Published history plus whatever the free Graph metrics support saying about
 * posting times. Rows and one mutable settings row per request, so this can
 * never be prerendered — without this it is a candidate for static generation
 * and `npm run build` would try to reach Neon from the build machine.
 */
export const dynamic = 'force-dynamic'

const EMPTY: PublishedHistory = {
  posts: [],
  stats: [],
  advice: { state: 'collecting', measured: 0, required: 0 },
}

/**
 * Reads on the server and hands props down, exactly as `app/page.tsx` and
 * `app/settings/page.tsx` do. The plan fetched `/api/published` in a mount
 * effect into `useState<any>`, which paints an empty page first, adds two
 * `no-explicit-any` lint errors to a baseline of two, and formats every
 * timestamp in the VIEWER's timezone.
 *
 * The two reads are settled independently: an unreadable settings row must not
 * cost the owner the history, and vice versa.
 */
export default async function PublishedPage() {
  const [history, settings] = await Promise.allSettled([listPublished(), getSettings()])

  let loadError: string | null = null
  if (history.status === 'rejected') {
    // Never surfaced verbatim: a Drizzle or Neon failure can carry a hostname
    // or a connection string. Same contract as the route handlers.
    console.error('published page load failed:', history.reason)
    loadError = 'Yayınlananlar okunamadı.'
  }
  if (settings.status === 'rejected') {
    console.error('published page settings read failed:', settings.reason)
  }

  const { posts, stats, advice } = history.status === 'fulfilled' ? history.value : EMPTY
  const timezone =
    settings.status === 'fulfilled' ? settings.value.timezone : DEFAULT_VIEW_SETTINGS.timezone

  return (
    <PublishedList
      posts={posts}
      stats={stats}
      // One place decides what the numbers are allowed to claim, and the page
      // only prints it.
      message={history.status === 'fulfilled' ? describeAdvice(advice) : null}
      timezone={timezone}
      loadError={loadError}
    />
  )
}
