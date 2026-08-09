import { NextResponse } from 'next/server'
import {
  setCaption,
  setKind,
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

  const { caption, kind } = body as { caption?: unknown; kind?: unknown }
  if (caption === undefined && kind === undefined) return badRequest('güncellenecek bir alan yok')

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

  try {
    // Kind first. It is the only half that can be refused on database state
    // (image count, missing row), and the caption's own validation already
    // happened above — so a refusal leaves nothing at all applied, rather than
    // a caption saved against a kind that was rejected.
    if (nextKind !== undefined) await setKind(id, nextKind)
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
