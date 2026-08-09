import { NextResponse } from 'next/server'
import { getSettings, saveSettings, SettingsError, type SettingsPatch } from '@/src/lib/settings'

/**
 * The answer depends on one mutable row and the write has a side effect the
 * cron run reads minutes later, so neither method may ever be cached or
 * prerendered — `npm run build` must not try to reach Neon either.
 */
export const dynamic = 'force-dynamic'

const noStore = { 'cache-control': 'no-store' }

/**
 * Bounds on the raw body, checked before any of it is parsed as a setting.
 * `validateSlots` and `validateHashtags` impose the real limits; these only
 * stop us tokenising a megabyte of text to reach the same conclusion.
 */
const MAX_SLOT_ENTRIES = 100
const MAX_SLOT_CHARS = 20
const MAX_TIMEZONE_CHARS = 100
const MAX_HASHTAG_BODY_CHARS = 10_000

/**
 * `{ slots?, timezone?, hashtags? }` or null. Nothing here trusts the body to
 * be the shape it claims: the values reach a jsonb column and an unattended
 * scheduler, and `slots` in particular is stored as-is.
 */
function parsePatch(body: unknown): SettingsPatch | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null
  const { slots, timezone, hashtags } = body as Record<string, unknown>
  const patch: SettingsPatch = {}

  if (slots !== undefined) {
    if (!Array.isArray(slots) || slots.length > MAX_SLOT_ENTRIES) return null
    if (!slots.every((s) => typeof s === 'string' && s.length <= MAX_SLOT_CHARS)) return null
    patch.slots = slots as string[]
  }
  if (timezone !== undefined) {
    if (typeof timezone !== 'string' || timezone.length > MAX_TIMEZONE_CHARS) return null
    patch.timezone = timezone
  }
  if (hashtags !== undefined) {
    if (typeof hashtags !== 'string' || hashtags.length > MAX_HASHTAG_BODY_CHARS) return null
    patch.hashtags = hashtags
  }
  return patch
}

export async function GET() {
  try {
    // Never undefined, even on a database whose settings row has never been
    // written: getSettings resolves the schema defaults the scheduler uses.
    return NextResponse.json(await getSettings(), { headers: noStore })
  } catch (e) {
    console.error('settings read failed:', e)
    return NextResponse.json({ error: 'ayarlar okunamadı' }, { status: 500, headers: noStore })
  }
}

/**
 * Saves the changed fields and answers with the settings AS STORED.
 *
 * The response is the whole resolved row, not `{ ok: true }`, so the form can
 * re-render from what the server actually kept — `9:00` comes back as `09:00`
 * and `moda, stil` as `#moda #stil`. A screen that goes on showing the text the
 * owner typed while the database holds something else is how a schedule ends up
 * being one thing on screen and another at 14:00.
 */
export async function PATCH(req: Request) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'geçersiz istek' }, { status: 400, headers: noStore })
  }
  const patch = parsePatch(body)
  if (!patch) {
    return NextResponse.json({ error: 'geçersiz istek' }, { status: 400, headers: noStore })
  }

  try {
    return NextResponse.json(await saveSettings(patch), { headers: noStore })
  } catch (e) {
    // The convention this project has now settled twice: exactly one error type
    // carries a message written for the owner, and it is the only thing echoed
    // back. A Drizzle or Neon failure can carry a hostname or a connection
    // string, so it is logged and answered generically. The plan returned
    // `(e as Error).message`.
    if (e instanceof SettingsError) {
      return NextResponse.json({ error: e.message }, { status: 400, headers: noStore })
    }
    console.error('settings save failed:', e)
    return NextResponse.json({ error: 'ayarlar kaydedilemedi' }, { status: 500, headers: noStore })
  }
}
