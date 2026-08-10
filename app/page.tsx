import { getDb } from '@/src/db'
import { settings as settingsTable } from '@/src/db/schema'
import { listQueue } from '@/src/lib/queue/repo'
import { resolveViewSettings, type ViewItem, type ViewSettings } from '@/src/lib/queue/view'
import { QueueClient } from './_components/QueueClient'

/**
 * The queue is per-request state that lives in a database, so this page can
 * never be prerendered. Without this it is a candidate for static generation
 * and `npm run build` would try to reach Neon from the build machine.
 */
export const dynamic = 'force-dynamic'

/**
 * The first copy of the queue is read here, on the server, rather than fetched
 * from `/api/items` in a mount effect: the page then paints with cards already
 * in it, and there is no effect calling setState on mount.
 *
 * The settings row is read directly for the same reason and one more — Task 10
 * owns `/api/settings` and it does not exist yet, so the plan's
 * `fetch('/api/settings').then(r => r.json())` would 404, throw on the body,
 * and take the whole page down on exactly the fresh install this has to work
 * on. `resolveViewSettings` falls back field by field, so an empty settings
 * table gives the schema's own defaults.
 */
export default async function QueuePage() {
  let items: ViewItem[] = []
  let settings: ViewSettings = resolveViewSettings(null)
  let loadError: string | null = null

  try {
    const [rows, settingsRows] = await Promise.all([
      listQueue(),
      getDb().select().from(settingsTable),
    ])
    // `scheduled_at` arrives from Drizzle as a Date and from `/api/items` as
    // an ISO string, and the client refetches through the second one. Converted
    // here so the page and its reloads agree on the shape — `ViewItem` declares
    // the string, so TypeScript refuses to let this drift.
    items = rows.map((r) => ({ ...r, scheduledAt: r.scheduledAt?.toISOString() ?? null }))
    settings = resolveViewSettings(settingsRows[0])
  } catch (e) {
    // Never surfaced verbatim: a Drizzle or Neon failure can carry a hostname
    // or a connection string. Same contract as the route handlers.
    console.error('queue page load failed:', e)
    loadError = 'Kuyruk yüklenemedi.'
  }

  return <QueueClient initialItems={items} initialSettings={settings} loadError={loadError} />
}
