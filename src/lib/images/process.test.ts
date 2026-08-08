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

  it('does not enlarge a small in-ratio source', async () => {
    const { width, height } = await sharp(await cropTo45(await solid(400, 500))).metadata()
    expect(width).toBeLessThanOrEqual(400)
    expect(height).toBeLessThanOrEqual(500)
  })

  it('crops a small out-of-ratio source to 4:5', async () => {
    const { width, height } = await sharp(await cropTo45(await solid(640, 400))).metadata()
    expect(width! / height!).toBeCloseTo(0.8, 2)
  })

  it('throws when shorter edge is under 320px', async () => {
    await expect(cropTo45(await solid(300, 400))).rejects.toThrow('görsel çok küçük — en az 320px olmalı')
  })

  it('produces exactly 1080x1350 for large sources', async () => {
    const { width, height } = await sharp(await cropTo45(await solid(5000, 6250))).metadata()
    expect(width).toBe(1080)
    expect(height).toBe(1350)
  })

  it('maintains exact 4:5 ratio for odd sizes (999x1001)', async () => {
    const { width, height } = await sharp(await cropTo45(await solid(999, 1001))).metadata()
    expect(width! / height!).toBe(0.8)
  })

  it('maintains exact 4:5 ratio for odd sizes (641x801)', async () => {
    const { width, height } = await sharp(await cropTo45(await solid(641, 801))).metadata()
    expect(width! / height!).toBe(0.8)
  })

  it('maintains exact 4:5 ratio for odd sizes (323x404)', async () => {
    const { width, height } = await sharp(await cropTo45(await solid(323, 404))).metadata()
    expect(width! / height!).toBe(0.8)
  })

  it('never enlarges EXIF orientation-6 source beyond post-rotation dimensions', async () => {
    // Create a 400x1300 JPEG and rotate 90° CW (simulating EXIF orientation 6).
    // Post-rotation true size is 1300x400.
    const buf = await sharp({
      create: { width: 400, height: 1300, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .rotate(90)
      .jpeg()
      .toBuffer()

    const result = await cropTo45(buf)
    const { width, height } = await sharp(result).metadata()

    // Post-rotation true size is 1300x400. Output should never exceed these.
    expect(width).toBeLessThanOrEqual(1300)
    expect(height).toBeLessThanOrEqual(400)
  })

  it('rejects sources with 319px short edge', async () => {
    await expect(cropTo45(await solid(319, 5000))).rejects.toThrow('görsel çok küçük — en az 320px olmalı')
    await expect(cropTo45(await solid(5000, 319))).rejects.toThrow('görsel çok küçük — en az 320px olmalı')
  })

  it('accepts sources with exactly 320px short edge', async () => {
    const { width, height } = await sharp(await cropTo45(await solid(320, 5000))).metadata()
    expect(width! / height!).toBe(0.8)

    const { width: w2, height: h2 } = await sharp(await cropTo45(await solid(5000, 320))).metadata()
    expect(w2! / h2!).toBe(0.8)
  })
})

describe('makeThumb', () => {
  it('produces a 320px-wide image', async () => {
    const { width } = await sharp(await makeThumb(await solid(2000, 2500))).metadata()
    expect(width).toBe(320)
  })
})
