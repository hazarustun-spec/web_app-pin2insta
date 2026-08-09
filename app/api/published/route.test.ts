import { describe, it, expect, vi, beforeEach } from 'vitest'

const listPublished = vi.hoisted(() => vi.fn())
const describeAdvice = vi.hoisted(() => vi.fn())
vi.mock('@/src/lib/insights', () => ({ listPublished, describeAdvice }))

const { GET } = await import('./route')

const history = {
  posts: [{ id: 'a', slotTime: '14:00', permalink: null, metric: null }],
  stats: [{ slotIndex: 840, time: '14:00', samples: 1, avgEngagement: 3 }],
  advice: { state: 'collecting', measured: 1, required: 15 },
}

beforeEach(() => {
  listPublished.mockReset().mockResolvedValue(history)
  describeAdvice.mockReset().mockReturnValue('veri toplanıyor · 1/15')
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/published', () => {
  it('answers with the history, the stats and the sentence', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ...history, message: 'veri toplanıyor · 1/15' })
    expect(describeAdvice).toHaveBeenCalledWith(history.advice)
  })

  it('is never cached — it is one mutable read', async () => {
    expect((await GET()).headers.get('cache-control')).toContain('no-store')
  })

  it('answers a database failure generically, without the driver message', async () => {
    listPublished.mockRejectedValue(new Error('neon: connection to ep-secret.aws.neon.tech failed'))
    const res = await GET()
    expect(res.status).toBe(500)
    const body = await res.text()
    expect(body).not.toContain('neon.tech')
    expect(body).toContain('geçmiş okunamadı')
  })
})
