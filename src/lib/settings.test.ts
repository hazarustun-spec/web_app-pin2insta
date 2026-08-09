import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MAX_SLOTS,
  MAX_HASHTAGS,
  MAX_HASHTAG_CHARS,
  SettingsError,
  validateSlots,
  validateTimezone,
  validateHashtags,
  getSettings,
  saveSettings,
} from './settings'
import { DEFAULT_SETTINGS } from './queue/publish'

/**
 * A recording fake for the one row this module owns.
 *
 * It is the `mutations.test.ts` pattern — statements are recorded so "what
 * actually went to the database?" is assertable — with one addition: the upsert
 * really updates `state.rows`, because the defect being tested is a write that
 * silently persists NOTHING on a fresh database. A recorder that only remembers
 * the call would pass just as happily against the plan's broken UPDATE.
 */
type Row = Record<string, unknown>
type Call = { op: 'select' | 'upsert'; values?: Row; set?: Row }

const state = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], calls: [] as unknown[] }))

vi.mock('@/src/db', () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => {
          state.calls.push({ op: 'select' })
          return Promise.resolve(state.rows.map((r) => ({ ...r })))
        },
      }),
    }),
    // Only the upsert shape saveSettings emits. A plain `update(...)` is not
    // implemented at all, so the plan's version would throw here rather than
    // quietly do nothing.
    insert: () => ({
      values: (values: Row) => ({
        onConflictDoUpdate: ({ set }: { set: Row }) => ({
          returning: () => {
            state.calls.push({ op: 'upsert', values, set })
            const existing = state.rows[0]
            if (!existing) {
              state.rows.push({ ...values })
              return Promise.resolve([{ ...values }])
            }
            Object.assign(existing, set)
            return Promise.resolve([{ ...existing }])
          },
        }),
      }),
    }),
  }),
}))

const calls = () => state.calls as Call[]
const upserts = () => calls().filter((c) => c.op === 'upsert')

beforeEach(() => {
  state.rows = []
  state.calls = []
})

describe('validateSlots', () => {
  it('sorts times and keeps them zero-padded', () => {
    expect(validateSlots(['20:00', '9:30', '14:00'])).toEqual(['09:30', '14:00', '20:00'])
  })

  it('rejects a malformed time', () => {
    expect(() => validateSlots(['25:00'])).toThrow('geçersiz saat')
  })

  it('rejects duplicate times', () => {
    expect(() => validateSlots(['10:00', '10:00'])).toThrow('tekrar eden saat')
  })

  it('rejects an empty list', () => {
    expect(() => validateSlots([])).toThrow('en az bir saat')
  })
})

describe('validateSlots — the cases the plan left open', () => {
  it('orders by clock time, not by the order the times were typed in', () => {
    // Every one of these would come back in the wrong order if the list were
    // sorted BEFORE the hours were padded: '9:30' > '14:00' > '10:00' as
    // strings. The zero-padding is what the ordering depends on, so it is
    // asserted rather than assumed.
    expect(validateSlots(['9:30', '14:00', '10:00'])).toEqual(['09:30', '10:00', '14:00'])
    expect(validateSlots(['9:00', '8:00'])).toEqual(['08:00', '09:00'])
  })

  it('rejects 24:00 — midnight is 00:00 and 24:00 is a different day', () => {
    expect(() => validateSlots(['24:00'])).toThrow('geçersiz saat')
  })

  it('rejects a minute over 59', () => {
    expect(() => validateSlots(['09:60'])).toThrow('geçersiz saat')
  })

  it('accepts the two boundary times', () => {
    expect(validateSlots(['23:59', '00:00'])).toEqual(['00:00', '23:59'])
  })

  it('treats 9:00 and 09:00 as the same time', () => {
    expect(() => validateSlots(['9:00', '09:00'])).toThrow('tekrar eden saat')
  })

  it('rejects more slots than a queue can feed', () => {
    const many = Array.from({ length: MAX_SLOTS + 1 }, (_, i) => `${String(i).padStart(2, '0')}:00`)
    expect(() => validateSlots(many)).toThrow(`en fazla ${MAX_SLOTS} saat`)
    expect(validateSlots(many.slice(0, MAX_SLOTS))).toHaveLength(MAX_SLOTS)
  })

  it('rejects a value that is not a string at all', () => {
    expect(() => validateSlots([10 as unknown as string])).toThrow('geçersiz saat')
  })

  it('trims surrounding whitespace', () => {
    expect(validateSlots([' 10:00 '])).toEqual(['10:00'])
  })

  it('throws SettingsError, the only type a route may echo back', () => {
    expect(() => validateSlots([])).toThrow(SettingsError)
  })
})

describe('validateTimezone', () => {
  it('keeps a zone the runtime knows', () => {
    expect(validateTimezone('Europe/Istanbul')).toBe('Europe/Istanbul')
    expect(validateTimezone(' Europe/Berlin ')).toBe('Europe/Berlin')
  })

  it('rejects a typo before it reaches an unattended cron run', () => {
    expect(() => validateTimezone('Europe/Istanbol')).toThrow('geçersiz saat dilimi')
  })

  it('rejects an empty zone', () => {
    expect(() => validateTimezone('   ')).toThrow('geçersiz saat dilimi')
  })
})

describe('validateHashtags', () => {
  it('keeps an already-correct block unchanged', () => {
    expect(validateHashtags('#moda #stil')).toBe('#moda #stil')
  })

  it('accepts an empty block', () => {
    expect(validateHashtags('')).toBe('')
    expect(validateHashtags('   \n ')).toBe('')
  })

  it('corrects a comma-separated list', () => {
    expect(validateHashtags('#moda, #stil,#tarz')).toBe('#moda #stil #tarz')
  })

  it('adds the missing hash', () => {
    expect(validateHashtags('moda stil')).toBe('#moda #stil')
  })

  it('keeps Turkish letters and digits and underscores', () => {
    expect(validateHashtags('#şık #güzel_ev2')).toBe('#şık #güzel_ev2')
  })

  it('rejects a tag with punctuation instead of silently posting it', () => {
    expect(() => validateHashtags('#moda #stil!')).toThrow('geçersiz hashtag')
  })

  it('rejects a duplicate tag whatever its case', () => {
    expect(() => validateHashtags('#moda #MODA')).toThrow('tekrar eden hashtag')
  })

  it('rejects more than the 30 Instagram allows', () => {
    const tags = Array.from({ length: MAX_HASHTAGS + 1 }, (_, i) => `#t${i}`).join(' ')
    expect(() => validateHashtags(tags)).toThrow(`en fazla ${MAX_HASHTAGS} hashtag`)
  })

  it('accepts exactly 30', () => {
    const tags = Array.from({ length: MAX_HASHTAGS }, (_, i) => `#t${i}`).join(' ')
    expect(validateHashtags(tags).split(' ')).toHaveLength(MAX_HASHTAGS)
  })

  it('caps the block so a caption still fits inside Instagram 2200 characters', () => {
    // Thirty legal tags — the count is allowed, the length is not.
    const long = Array.from(
      { length: MAX_HASHTAGS },
      (_, i) => `#${'a'.repeat(28)}${String(i).padStart(2, '0')}`,
    ).join(' ')
    expect(long.length).toBeGreaterThan(MAX_HASHTAG_CHARS)
    expect(() => validateHashtags(long)).toThrow(`en fazla ${MAX_HASHTAG_CHARS} karakter`)
  })

  it('accepts a block that lands exactly on the character ceiling', () => {
    // The ceiling is inclusive; only the character past it is refused. Without
    // a case sitting on the boundary, > and >= are indistinguishable.
    // Built from legal tags — a single tag long enough to hit the ceiling
    // would trip the per-tag limit first and test nothing.
    const tags = Array.from({ length: 7 }, (_, i) => `#${'a'.repeat(80)}${i}`)
    const joined = tags.join(' ')
    const exact = `${joined} #${'b'.repeat(MAX_HASHTAG_CHARS - joined.length - 2)}`
    expect(exact).toHaveLength(MAX_HASHTAG_CHARS)
    expect(validateHashtags(exact)).toBe(exact)
    expect(() => validateHashtags(`${exact}a`)).toThrow(`en fazla ${MAX_HASHTAG_CHARS} karakter`)
  })

  it('drops a bare hash left behind by deleting a tag body', () => {
    expect(validateHashtags('#one # #two')).toBe('#one #two')
    expect(validateHashtags('#')).toBe('')
  })

  it('rejects one absurdly long tag', () => {
    expect(() => validateHashtags(`#${'a'.repeat(101)}`)).toThrow('geçersiz hashtag')
    expect(validateHashtags(`#${'a'.repeat(100)}`)).toBe(`#${'a'.repeat(100)}`)
  })

  it('strips a repeated hash rather than treating it as a character', () => {
    expect(validateHashtags('##moda')).toBe('#moda')
  })

  it('throws SettingsError', () => {
    expect(() => validateHashtags('#a!')).toThrow(SettingsError)
  })
})

describe('getSettings', () => {
  it('returns the schema defaults on a database whose settings row was never written', async () => {
    // The plan returned `row` — undefined here — and its page called
    // `s.slots.join(', ')` on it, which is every new install.
    await expect(getSettings()).resolves.toEqual(DEFAULT_SETTINGS)
  })

  it('returns a stored row', async () => {
    state.rows.push({ id: 1, slots: ['08:30'], timezone: 'Europe/Berlin', hashtags: '#a' })
    await expect(getSettings()).resolves.toEqual({
      slots: ['08:30'], timezone: 'Europe/Berlin', hashtags: '#a',
    })
  })

  it('falls back field by field on a row that would break the scheduler', async () => {
    state.rows.push({ id: 1, slots: ['25:00'], timezone: 'Europe/Nowhere', hashtags: '#a' })
    await expect(getSettings()).resolves.toEqual({
      slots: DEFAULT_SETTINGS.slots, timezone: DEFAULT_SETTINGS.timezone, hashtags: '#a',
    })
  })
})

describe('saveSettings', () => {
  it('inserts the row on a fresh database instead of updating nothing', async () => {
    const saved = await saveSettings({ slots: ['9:00', '21:00'] })

    expect(saved.slots).toEqual(['09:00', '21:00'])
    // The write really landed: reading it back returns the new times.
    await expect(getSettings()).resolves.toMatchObject({ slots: ['09:00', '21:00'] })
    expect(upserts()).toHaveLength(1)
  })

  it('writes a complete row on insert so nothing is left null', async () => {
    await saveSettings({ slots: ['09:00'] })
    expect(upserts()[0].values).toEqual({
      id: 1,
      slots: ['09:00'],
      timezone: DEFAULT_SETTINGS.timezone,
      hashtags: DEFAULT_SETTINGS.hashtags,
    })
  })

  it('touches only the fields in the patch when the row already exists', async () => {
    state.rows.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Berlin', hashtags: '#keep' })

    const saved = await saveSettings({ slots: ['11:00'] })

    expect(upserts()[0].set).toEqual({ slots: ['11:00'] })
    expect(saved).toEqual({ slots: ['11:00'], timezone: 'Europe/Berlin', hashtags: '#keep' })
  })

  it('normalises what it stores, not just what it answers', async () => {
    await saveSettings({ timezone: ' Europe/Berlin ', hashtags: 'moda, stil' })
    expect(upserts()[0].set).toEqual({ timezone: 'Europe/Berlin', hashtags: '#moda #stil' })
  })

  it('clears the hashtag block when given an empty string', async () => {
    state.rows.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '#a' })
    const saved = await saveSettings({ hashtags: '' })
    expect(saved.hashtags).toBe('')
  })

  it('validates before writing anything', async () => {
    state.rows.push({ id: 1, slots: ['10:00'], timezone: 'Europe/Istanbul', hashtags: '' })

    await expect(saveSettings({ slots: ['10:00'], timezone: 'Mars/Olympus' }))
      .rejects.toThrow(SettingsError)

    expect(upserts()).toHaveLength(0)
    expect(state.rows[0]).toMatchObject({ slots: ['10:00'] })
  })

  it('refuses an empty patch rather than emitting an upsert with nothing to set', async () => {
    await expect(saveSettings({})).rejects.toThrow(SettingsError)
    expect(upserts()).toHaveLength(0)
  })
})
