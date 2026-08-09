import { NextResponse } from 'next/server'
import { applyOrder } from '@/src/lib/queue/repo'
import { badRequest, failed, parseIds, readJson } from '../_shared'

export async function POST(req: Request) {
  const parsed = await readJson(req)
  if (!parsed.ok) return badRequest('geçersiz istek')

  const ids = parseIds(parsed.body)
  if (!ids) return badRequest('geçersiz sıralama')

  try {
    // applyOrder requires the whole queue and refuses anything else, so a stale
    // client gets a refusal rather than a partly renumbered queue.
    await applyOrder(ids)
  } catch (e) {
    return failed('reorder', e)
  }
  return NextResponse.json({ ok: true })
}
