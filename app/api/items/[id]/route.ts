import { NextResponse } from 'next/server'
import {
  setCaption,
  setKind,
  setScheduledAt,
  deleteItem,
  isItemKind,
  MAX_CAPTION_CHARS,
  type ItemKind,
} from '@/src/lib/queue/repo'
import { badRequest, failed, readJson } from '../_shared'

type Ctx = { params: Promise<{ id: string }> }

export async function PATCH(req: Request, { params }: Ctx) {
  const { id } = await params

  const parsed = await readJson(req)
  if (!parsed.ok) return badRequest('geçersiz istek')
  const body = parsed.body
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return badRequest('geçersiz istek')
  }

  const { caption, kind, scheduledAt } = body as {
    caption?: unknown
    kind?: unknown
    scheduledAt?: unknown
  }
  if (caption === undefined && kind === undefined && scheduledAt === undefined) {
    return badRequest('güncellenecek bir alan yok')
  }

  // Narrowed into locals rather than used through the guards: a type predicate
  // inside a compound condition does not carry its narrowing past the `if`.
  let nextCaption: string | undefined
  if (caption !== undefined) {
    if (typeof caption !== 'string') return badRequest('geçersiz açıklama')
    // The repo enforces this too and is the authority; checking here as well
    // means an over-long caption never reaches the database, and both sites
    // read the same constant.
    if (caption.length > MAX_CAPTION_CHARS) {
      return badRequest(`açıklama çok uzun — en fazla ${MAX_CAPTION_CHARS} karakter olabilir`)
    }
    nextCaption = caption
  }

  let nextKind: ItemKind | undefined
  if (kind !== undefined) {
    if (!isItemKind(kind)) return badRequest('geçersiz gönderi türü')
    nextKind = kind
  }

  // `undefined` means "not part of this request"; `null` means "clear the time
  // and go back to the next free slot", which is the field's whole point. The
  // instant is parsed here so a body that is not a time never reaches the
  // repo — but WHICH minute it lands on, and whether that minute is free, is
  // decided against the server's clock and the settings row, not here.
  let nextScheduledAt: Date | null | undefined
  if (scheduledAt !== undefined) {
    if (scheduledAt === null) {
      nextScheduledAt = null
    } else {
      if (typeof scheduledAt !== 'string') return badRequest('geçersiz tarih veya saat')
      const at = new Date(scheduledAt)
      if (Number.isNaN(at.getTime())) return badRequest('geçersiz tarih veya saat')
      nextScheduledAt = at
    }
  }

  try {
    // Kind first, then the time. Those are the halves that can be refused on
    // database state (image count, a missing row, a minute another item already
    // holds), and the caption's own validation already happened above — so a
    // refusal leaves nothing at all applied, rather than a caption saved
    // against a change that was rejected.
    if (nextKind !== undefined) await setKind(id, nextKind)
    if (nextScheduledAt !== undefined) await setScheduledAt(id, nextScheduledAt)
    if (nextCaption !== undefined) await setCaption(id, nextCaption)
  } catch (e) {
    return failed('item update', e)
  }
  return NextResponse.json({ ok: true })
}

export async function DELETE(_req: Request, { params }: Ctx) {
  const { id } = await params
  try {
    await deleteItem(id)
  } catch (e) {
    return failed('item delete', e)
  }
  return NextResponse.json({ ok: true })
}
