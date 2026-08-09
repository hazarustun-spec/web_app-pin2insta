import { describe, it, expect } from 'vitest'
import sharp from 'sharp'
import { sha256, cropTo45, makeThumb, ImageValidationError } from './process'

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
    await expect(cropTo45(await solid(300, 400))).rejects.toThrow('görsel çok küçük — en az 320x400px olmalı')
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

  it('respects EXIF orientation 6: stored 400x1300 displays as 1300x400', async () => {
    // Stored pixels: 400x1300 (portrait). EXIF orientation 6: rotate 90° CW for display.
    // True displayed size: 1300x400 (landscape).
    // Buggy code would read .metadata() = 400x1300 and calculate wrong dimensions.
    const buf = await sharp({
      create: { width: 400, height: 1300, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()

    const result = await cropTo45(buf)
    const { width, height } = await sharp(result).metadata()

    // Output must never exceed true post-rotation dimensions (1300x400)
    expect(width).toBeLessThanOrEqual(1300)
    expect(height).toBeLessThanOrEqual(400)
    // And must maintain exact 4:5 ratio
    expect(width! / height!).toBe(0.8)
  })

  it('respects EXIF orientation 5: stored 1300x400 displays as 400x1300', async () => {
    // Stored pixels: 1300x400 (landscape). EXIF orientation 5: rotate 90° CCW + flip.
    // True displayed size: 400x1300 (portrait).
    const buf = await sharp({
      create: { width: 1300, height: 400, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .withMetadata({ orientation: 5 })
      .jpeg()
      .toBuffer()

    const result = await cropTo45(buf)
    const { width, height } = await sharp(result).metadata()

    // Output must never exceed true post-rotation dimensions (400x1300)
    expect(width).toBeLessThanOrEqual(400)
    expect(height).toBeLessThanOrEqual(1300)
    expect(width! / height!).toBe(0.8)
  })

  it('320px floor is checked on post-rotation dimensions with EXIF orientation 6', async () => {
    // Stored pixels: 1000x319. EXIF orientation 6 (90° CW).
    // Post-rotation: 319x1000. Short edge is 319 (below 320px threshold).
    // Must throw, because the floor check should read post-rotation dimensions.
    const buf = await sharp({
      create: { width: 1000, height: 319, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()

    await expect(cropTo45(buf)).rejects.toThrow('görsel çok küçük — en az 320x400px olmalı')
  })

  it('accepts 320px boundary on post-rotation short edge with EXIF orientation 6', async () => {
    // Stored pixels: 1000x320. EXIF orientation 6 (90° CW).
    // Post-rotation: 320x1000. Short edge is exactly 320px (at boundary).
    const buf = await sharp({
      create: { width: 1000, height: 320, channels: 3, background: { r: 200, g: 200, b: 200 } },
    })
      .withMetadata({ orientation: 6 })
      .jpeg()
      .toBuffer()

    const result = await cropTo45(buf)
    const { width, height } = await sharp(result).metadata()
    expect(width! / height!).toBe(0.8)
  })

  it('rejects sources with 319px short edge', async () => {
    await expect(cropTo45(await solid(319, 5000))).rejects.toThrow('görsel çok küçük — en az 320x400px olmalı')
    await expect(cropTo45(await solid(5000, 319))).rejects.toThrow('görsel çok küçük — en az 320x400px olmalı')
  })

  it('accepts a source at exactly the 320x400 floor', async () => {
    const { width, height } = await sharp(await cropTo45(await solid(320, 5000))).metadata()
    expect(width! / height!).toBe(0.8)
    expect(width).toBeGreaterThanOrEqual(320)

    const { width: w2, height: h2 } = await sharp(await cropTo45(await solid(5000, 400))).metadata()
    expect(w2! / h2!).toBe(0.8)
    expect(w2).toBe(320)
  })

  // The guard is on the OUTPUT, which is why the source short edge alone is not
  // enough: at 4:5 the width comes from the height, so anything under 400 tall
  // produces an image Instagram refuses however wide the source was.
  it.each([
    [1920, 360],
    [400, 320],
    [800, 399],
  ])('refuses %ix%i, which would crop below 320px wide', async (w, h) => {
    await expect(cropTo45(await solid(w, h)))
      .rejects.toThrow('görsel çok küçük — en az 320x400px olmalı')
  })

  // The route's Content-Type allowlist is client-supplied and proves nothing
  // about the bytes. These pin the checks that actually inspect the container.
  it('rejects an SVG even though sharp can render one', async () => {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="1000"><rect width="1000" height="1000" fill="#ccc"/></svg>',
    )
    // Guard against a vacuous test: sharp must actually be willing to render it.
    await expect(sharp(svg).jpeg().toBuffer()).resolves.toBeInstanceOf(Buffer)
    await expect(cropTo45(svg)).rejects.toThrow(ImageValidationError)
    await expect(cropTo45(svg)).rejects.toThrow('desteklenmeyen görsel biçimi')
  })

  // sharp reports AVIF as format 'heif', never 'avif', so an allowlist that
  // names 'avif' silently rejects every AVIF file.
  it('accepts an AVIF, which sharp reports as heif', async () => {
    const avif = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 9, g: 9, b: 9 } },
    }).avif({ quality: 40 }).toBuffer()
    expect((await sharp(avif).metadata()).format).toBe('heif')
    const { width, height } = await sharp(await cropTo45(avif)).metadata()
    expect(width! / height!).toBe(0.8)
  })

  // format 'heif' alone would also let HEIC through. This build cannot encode
  // HEVC, so the exclusion is pinned by rewriting an AVIF's ftyp brand, which
  // makes sharp report compression 'hevc' over the same payload.
  it('rejects HEIC, which shares the heif format string with AVIF', async () => {
    const avif = await sharp({
      create: { width: 1000, height: 1000, channels: 3, background: { r: 9, g: 9, b: 9 } },
    }).avif({ quality: 40 }).toBuffer()
    const heic = Buffer.from(avif)
    heic.write('heic', 8)
    const probe = await sharp(heic).metadata()
    expect(probe.format).toBe('heif')
    expect(probe.compression).toBe('hevc')
    await expect(cropTo45(heic)).rejects.toThrow('desteklenmeyen görsel biçimi')
  })

  it('rejects a decompression bomb whose byte size is small', async () => {
    // ~40000x4000 = 160MP, over the 64MP ceiling, but only a few MB on the wire
    // because it is a single flat colour.
    const bomb = await sharp({
      create: { width: 40000, height: 4000, channels: 3, background: { r: 1, g: 1, b: 1 } },
    }).png({ compressionLevel: 9 }).toBuffer()
    expect(bomb.byteLength).toBeLessThan(25 * 1024 * 1024) // passes the route's byte cap
    await expect(cropTo45(bomb)).rejects.toThrow('görsel çok büyük — en fazla 64 megapiksel olmalı')
    // Explicit timeout: encoding a 160MP PNG and rejecting it genuinely takes
    // seconds, which sits close enough to the 5s default to fail whenever the
    // suite shares a machine with a build.
  }, 30_000)

  it('accepts an image just under the pixel ceiling', async () => {
    const big = await sharp({
      create: { width: 8000, height: 7999, channels: 3, background: { r: 1, g: 1, b: 1 } },
    }).png({ compressionLevel: 9 }).toBuffer()
    await expect(cropTo45(big)).resolves.toBeInstanceOf(Buffer)
    // Same reason: 64 megapixels really is slow to encode and decode.
  }, 30_000)

  // A libvips decode failure is raw internal text on an attacker-controlled
  // path. It must NOT be an ImageValidationError, or the route relabels it as
  // user-facing and echoes it back verbatim.
  it('throws a non-ImageValidationError for a truncated JPEG', async () => {
    // Header intact, pixel data cut off: metadata() succeeds, toBuffer() fails
    // deep inside libvips with text like "VipsJpeg: Premature end of input
    // file /var/task/node_modules/...".
    const truncated = (await solid(1000, 1000)).subarray(0, 400)
    await expect(cropTo45(truncated)).rejects.toThrow()
    await expect(cropTo45(truncated)).rejects.not.toBeInstanceOf(ImageValidationError)
  })

  it('does not leak libvips text when the header itself is unparseable', async () => {
    const garbage = Buffer.from('not an image at all, just ascii')
    await expect(cropTo45(garbage)).rejects.toThrow('görsel okunamadı')
  })
})

describe('makeThumb', () => {
  it('produces a 320px-wide image', async () => {
    const { width } = await sharp(await makeThumb(await solid(2000, 2500))).metadata()
    expect(width).toBe(320)
  })

  // makeThumb is a decode path like cropTo45 and must not be the one that
  // skips the pixel ceiling, even though it currently only ever sees
  // cropTo45's own already-bounded output.
  it('refuses to decode past the pixel ceiling', async () => {
    const bomb = await sharp({
      create: { width: 40000, height: 4000, channels: 3, background: { r: 1, g: 1, b: 1 } },
    }).png({ compressionLevel: 9 }).toBuffer()
    await expect(makeThumb(bomb)).rejects.toThrow(/pixel limit/i)
  })
})
