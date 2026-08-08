import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { sha256, cropTo45, makeThumb } from './process'

async function solid(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 200, b: 200 } },
  }).jpeg().toBuffer()
}

describe('sha256', () => {
  it('is stable and distinguishes different bytes', () => {
    expect(sha256(Buffer.from('a'))).toBe(sha256(Buffer.from('a')))
    expect(sha256(Buffer.from('a'))).not.toBe(sha256(Buffer.from('b')))
    expect(sha256(Buffer.from('a'))).toHaveLength(64)
  })
})

describe('cropTo45', () => {
  it('crops a wide image to 4:5', async () => {
    const { width, height } = await sharp(await cropTo45(await solid(2000, 1000))).metadata()
    expect(width! / height!).toBeCloseTo(0.8, 2)
  })

  it('crops a tall image to 4:5', async () => {
    const { width, height } = await sharp(await cropTo45(await solid(1000, 3000))).metadata()
    expect(width! / height!).toBeCloseTo(0.8, 2)
  })

  it('caps the long edge at 1350px', async () => {
    const { height } = await sharp(await cropTo45(await solid(4000, 6000))).metadata()
    expect(height).toBeLessThanOrEqual(1350)
  })
})

describe('makeThumb', () => {
  it('produces a 320px-wide image', async () => {
    const { width } = await sharp(await makeThumb(await solid(2000, 2500))).metadata()
    expect(width).toBe(320)
  })
})
