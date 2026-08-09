import { NextResponse } from 'next/server'
import { groupIntoCarousel } from '@/src/lib/queue/repo'
import { badRequest, failed, parseIds, readJson } from '../_shared'

export async function POST(req: Request) {
  const parsed = await readJson(req)
  if (!parsed.ok) return badRequest('geçersiz istek')

  const ids = parseIds(parsed.body)
  if (!ids) return badRequest('geçersiz seçim')

  try {
    // The id order is the carousel order — groupIntoCarousel arranges the
    // images by it, so the array is passed through untouched.
    await groupIntoCarousel(ids)
  } catch (e) {
    return failed('group', e)
  }
  return NextResponse.json({ ok: true })
}
