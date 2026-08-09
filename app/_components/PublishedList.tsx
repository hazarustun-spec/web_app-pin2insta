import Link from 'next/link'
import {
  formatPostedAt,
  metricState,
  MIN_SLOT_SAMPLES,
  type PublishedPost,
  type SlotStat,
} from '@/src/lib/insights'

/**
 * The published history, as the owner reads it.
 *
 * Rendered on the server, like the data it is given. Task 9's shape is "the
 * page reads on the server and hands props to a component"; this screen has no
 * interactive element at all — no forms, no drag, no fetch — so the component
 * is deliberately NOT marked `'use client'`. That keeps the plan's two real
 * defects fixed (no fetch-on-mount, no `useState<any>`) and adds a third
 * benefit the plan's version could not have: `postedAt` is formatted in the
 * OWNER'S configured timezone rather than the viewer's, so there is nothing
 * for hydration to disagree about and a phone in another country still shows
 * the times the settings screen promised.
 */

const KIND_LABEL: Record<PublishedPost['kind'], string> = {
  feed: 'gönderi',
  carousel: 'karusel',
  story: 'hikâye',
}

function Meta({ children }: { children: React.ReactNode }) {
  return <p className="text-[11px] text-neutral-500">{children}</p>
}

/**
 * One post's numbers, or the reason there are none.
 *
 * A switch with an exhaustiveness check rather than an if-chain: a chain ends
 * in an unguarded return, so the next state added to `metricState` would fall
 * into the missing-id sentence and accuse a perfectly good row of having lost
 * its Instagram id. That is exactly the bug stories hit, in general form —
 * here it is a compile error instead.
 */
function Metrics({ post }: { post: PublishedPost }) {
  const state = metricState(post)
  switch (state) {
    case 'measured':
      return post.metric ? (
        <Meta>
          {post.metric.likes} beğeni · {post.metric.comments} yorum · {post.metric.saved} kaydetme ·{' '}
          {post.metric.reach} erişim
        </Meta>
      ) : null
    case 'pending':
      return <Meta>ölçüm bekleniyor</Meta>
    // Not a fault and not a wait. Named precisely: Instagram does publish story
    // insights (reach, replies, exits), just not these three, and claiming it
    // measures nothing would be saying something untrue about Instagram.
    case 'story':
      return <Meta>hikâyelerde beğeni, yorum ve kaydetme sayısı yok</Meta>
    // media_publish answered 200 without an id, so nothing can ever be fetched
    // for this row. Saying "bekleniyor" here would be a wait with no end.
    case 'unmeasurable':
      return <Meta>Instagram kimliği kaydedilmedi — bu gönderinin ölçümü alınamıyor</Meta>
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

function SlotSummary({ stats }: { stats: SlotStat[] }) {
  if (stats.length === 0) return null
  return (
    <ul className="mb-6 flex flex-wrap gap-x-6 gap-y-1 text-[11px] text-neutral-500">
      {stats.map((s) => (
        <li key={s.slotIndex}>
          {/* Never `s.slotIndex`: since Task 10 that is minutes since midnight,
              and "slot 600" means nothing to the person who typed "10:00". */}
          <span className="text-neutral-900">{s.time ?? 'bilinmeyen slot'}</span>{' '}
          ort. {Math.round(s.avgEngagement)} etkileşim · {s.samples} gönderi
          {s.samples < MIN_SLOT_SAMPLES && <span className="text-neutral-400"> · henüz az</span>}
        </li>
      ))}
    </ul>
  )
}

function Row({ post, timezone }: { post: PublishedPost; timezone: string }) {
  const when = formatPostedAt(post.postedAt, timezone)
  return (
    <li className="flex gap-4 py-4">
      <div className="relative aspect-[4/5] w-16 shrink-0 overflow-hidden bg-neutral-50">
        {post.thumb ? (
          /* Same reasoning as the queue card: next/image would need a
             `remotePatterns` entry for the Blob host in next.config.ts, and
             these objects are already cropped to 4:5 and served from a CDN. */
          // eslint-disable-next-line @next/next/no-img-element
          <img src={post.thumb} alt="" className="h-full w-full object-cover" />
        ) : (
          <span className="grid h-full place-items-center text-[10px] text-neutral-400">
            görsel yok
          </span>
        )}
        {post.kind === 'carousel' && post.imageCount > 1 && (
          <span className="absolute top-1 right-1 bg-white/90 px-1 text-[10px] tracking-wider">
            {post.imageCount}
          </span>
        )}
      </div>

      <div className="min-w-0 flex-1">
        <Meta>
          {/* `postedAt` is nullable, and the plan's `new Date(p.postedAt)`
              rendered "Invalid Date" for such a row. */}
          {when ?? 'yayın tarihi kaydedilmedi'} · {KIND_LABEL[post.kind]}
          {post.slotTime ? ` · ${post.slotTime} slotu` : ''}
        </Meta>

        {post.caption.trim() === '' ? (
          <p className="mt-1 text-[13px] text-neutral-400">açıklamasız</p>
        ) : (
          /* items.caption, the owner's text. The fixed hashtag block that went
             out with it came from the settings row AT THE TIME OF POSTING and
             is not stored, so it is not reconstructed from today's settings. */
          <p className="mt-1 whitespace-pre-wrap text-[13px] text-neutral-900">{post.caption}</p>
        )}

        <div className="mt-2 flex flex-wrap items-baseline gap-x-3">
          <Metrics post={post} />
          {post.permalink ? (
            <a
              href={post.permalink}
              target="_blank"
              rel="noreferrer"
              className="text-[11px] text-neutral-500 underline underline-offset-4"
            >
              Instagram
            </a>
          ) : (
            /* Task 8 records an empty permalink when media_publish succeeded
               but the permalink lookup failed. `<a href="">` points at this
               very page, so the row is rendered without a link at all. */
            <span className="text-[11px] text-neutral-400">bağlantı kaydedilemedi</span>
          )}
        </div>
      </div>
    </li>
  )
}

export function PublishedList({
  posts,
  stats,
  message,
  timezone,
  loadError,
}: {
  posts: PublishedPost[]
  stats: SlotStat[]
  /** The one sentence the metrics support — progress, or the suggestion. Null when the history could not be read at all. */
  message: string | null
  /** The owner's timezone, so every time on this page is the one they chose. */
  timezone: string
  loadError: string | null
}) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-8">
      <header className="mb-6 flex flex-wrap items-baseline justify-between gap-3 border-b border-neutral-200 pb-3">
        <h1 className="text-sm tracking-[0.2em] text-neutral-900">YAYINLANANLAR</h1>
        <div className="flex items-center gap-4 text-[11px] text-neutral-500">
          <span>{posts.length} gönderi</span>
          <Link href="/settings" className="underline-offset-4 hover:underline">
            ayarlar
          </Link>
          <Link href="/" className="underline-offset-4 hover:underline">
            ← kuyruk
          </Link>
        </div>
      </header>

      {loadError && (
        <p className="mb-6 border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {loadError}
        </p>
      )}

      {message && (
        <p className="mb-4 border-l-2 border-neutral-300 pl-3 text-xs text-neutral-600">{message}</p>
      )}

      <SlotSummary stats={stats} />

      {posts.length === 0 ? (
        <p className="text-xs text-neutral-500">Henüz paylaşılan gönderi yok.</p>
      ) : (
        <ul className="divide-y divide-neutral-200">
          {posts.map((p) => (
            <Row key={p.id} post={p} timezone={timezone} />
          ))}
        </ul>
      )}
    </main>
  )
}
