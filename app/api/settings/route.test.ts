import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSettings = vi.hoisted(() => vi.fn())
const saveSettings = vi.hoisted(() => vi.fn())

vi.mock('@/src/lib/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/src/lib/settings')>()),
  getSettings,
  saveSettings,
}))

const { GET, PATCH } = await import('./route')
const { SettingsError } = await import('@/src/lib/settings')

const ROW = { slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '' }

function patch(body: unknown, raw?: string) {
  return new Request('http://localhost/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  })
}

beforeEach(() => {
  getSettings.mockReset().mockResolvedValue(ROW)
  saveSettings.mockReset().mockResolvedValue(ROW)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('GET /api/settings', () => {
  it('answers the resolved row', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual(ROW)
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('never echoes a driver failure', async () => {
    getSettings.mockRejectedValue(new Error('getaddrinfo ENOTFOUND ep-x.eu-central-1.aws.neon.tech'))
    const res = await GET()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('neon.tech')
  })
})

describe('PATCH /api/settings', () => {
  it('saves a patch and answers with the settings as stored', async () => {
    saveSettings.mockResolvedValue({ ...ROW, slots: ['09:00', '21:00'] })

    const res = await PATCH(patch({ slots: ['9:00', '21:00'] }))

    expect(saveSettings).toHaveBeenCalledWith({ slots: ['9:00', '21:00'] })
    // The normalised value comes back, so the form can stop showing '9:00'.
    await expect(res.json()).resolves.toMatchObject({ slots: ['09:00', '21:00'] })
  })

  it('passes an empty hashtag block through instead of dropping the field', async () => {
    await PATCH(patch({ hashtags: '' }))
    expect(saveSettings).toHaveBeenCalledWith({ hashtags: '' })
  })

  it('shows a SettingsError message to the owner', async () => {
    saveSettings.mockRejectedValue(new SettingsError('geçersiz saat: 25:00'))
    const res = await PATCH(patch({ slots: ['25:00'] }))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: 'geçersiz saat: 25:00' })
  })

  it('never echoes anything else', async () => {
    // The plan answered `(e as Error).message` for every failure alike.
    saveSettings.mockRejectedValue(new Error('connect ECONNREFUSED ep-x.aws.neon.tech:5432'))
    const res = await PATCH(patch({ slots: ['10:00'] }))
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('neon.tech')
  })

  it.each([
    ['a malformed body', undefined, '{ not json'],
    ['a top-level array', ['10:00'], undefined],
    ['a null body', null, undefined],
    ['slots that are not an array', { slots: '10:00' }, undefined],
    ['a slot that is not a string', { slots: [600] }, undefined],
    ['an absurd slot string', { slots: ['1'.repeat(21)] }, undefined],
    ['too many slot entries', { slots: Array.from({ length: 101 }, () => '10:00') }, undefined],
    ['a timezone that is not a string', { timezone: 3 }, undefined],
    ['an absurd timezone', { timezone: 'x'.repeat(101) }, undefined],
    ['hashtags that are not a string', { hashtags: ['#a'] }, undefined],
    ['an absurd hashtag body', { hashtags: 'x'.repeat(10_001) }, undefined],
  ])('answers 400 for %s without touching the database', async (_label, body, raw) => {
    const res = await PATCH(patch(body, raw))
    expect(res.status).toBe(400)
    expect(saveSettings).not.toHaveBeenCalled()
  })

  it('ignores fields it does not own', async () => {
    await PATCH(patch({ slots: ['10:00'], id: 2, hashtags: undefined }))
    expect(saveSettings).toHaveBeenCalledWith({ slots: ['10:00'] })
  })
})
