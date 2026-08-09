import { getSettings, MAX_HASHTAGS, MAX_HASHTAG_CHARS, MAX_SLOTS } from '@/src/lib/settings'
import { DEFAULT_SETTINGS } from '@/src/lib/queue/publish'
import { SettingsForm, type FormValues } from '../_components/SettingsForm'

/**
 * One mutable row read per request, so this can never be prerendered — without
 * this it is a candidate for static generation and `npm run build` would try to
 * reach Neon from the build machine.
 */
export const dynamic = 'force-dynamic'

/**
 * The settings row is read here, on the server, rather than fetched in a mount
 * effect: the form paints with the real values in it and there is no effect
 * calling setState on mount. `getSettings` never returns undefined — it
 * resolves the same defaults the scheduler runs on when the row has never been
 * written, which is every deployment until this screen is used for the first
 * time.
 */
export default async function SettingsPage() {
  let row = DEFAULT_SETTINGS
  let loadError: string | null = null

  try {
    row = await getSettings()
  } catch (e) {
    // Never surfaced verbatim: a Drizzle or Neon failure can carry a hostname
    // or a connection string. Same contract as the route handlers.
    console.error('settings page load failed:', e)
    loadError = 'Ayarlar okunamadı — varsayılanlar gösteriliyor. Kaydetmeden önce sayfayı yenileyin.'
  }

  const initial: FormValues = {
    slots: row.slots.join(', '),
    timezone: row.timezone,
    hashtags: row.hashtags,
  }

  return (
    <SettingsForm
      initial={initial}
      limits={{
        maxSlots: MAX_SLOTS,
        maxHashtags: MAX_HASHTAGS,
        maxHashtagChars: MAX_HASHTAG_CHARS,
      }}
      loadError={loadError}
    />
  )
}
