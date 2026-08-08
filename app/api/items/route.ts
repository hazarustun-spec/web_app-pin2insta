import { NextResponse } from 'next/server'
import { ingestBuffer, listQueue } from '@/src/lib/queue/repo'

export const maxDuration = 300

export async function GET() {
  return NextResponse.json(await listQueue())
}

export async function POST(req: Request) {
  const form = await req.formData()
  const files = form.getAll('files').filter((f): f is File => f instanceof File)
  if (files.length === 0) return NextResponse.json({ error: 'no files' }, { status: 400 })

  const results = []
  for (const file of files) {
    const buf = Buffer.from(await file.arrayBuffer())
    try {
      results.push(await ingestBuffer(buf, file.name))
    } catch (e) {
      results.push({ status: 'error' as const, name: file.name, message: (e as Error).message })
    }
  }
  return NextResponse.json({ results })
}
