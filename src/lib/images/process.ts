import { createHash } from 'node:crypto'
import sharp from 'sharp'

/** Instagram's tallest accepted ratio. */
const TARGET_W = 1080
const TARGET_H = 1350

/** Hash the image bytes. Callers must hash the output of cropTo45, not the raw upload — product-wide duplicate detection depends on the exact bytes hashed. */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Center-crop to 4:5 and cap at 1080x1350. Content at the edges is lost by design. */
export async function cropTo45(buf: Buffer): Promise<Buffer> {
  // Materialize rotation before measuring—metadata() returns raw dimensions without pending transforms.
  const rotated = await sharp(buf).rotate().toBuffer()
  const metadata = await sharp(rotated).metadata()

  if (!metadata.width || !metadata.height) {
    throw new Error('Görsel yüklenemedi')
  }

  const shortEdge = Math.min(metadata.width, metadata.height)
  if (shortEdge < 320) {
    throw new Error('görsel çok küçük — en az 320px olmalı')
  }

  // Calculate exact 4:5 dimensions by choosing height first as a multiple of 5.
  // This guarantees width / height === 0.8 exactly for every input.
  const maxH = Math.min(TARGET_H, metadata.height)
  const maxW = Math.min(TARGET_W, metadata.width)

  // Find the largest h that is a multiple of 5, <= maxH, and whose derived w is <= maxW.
  let targetH = Math.floor(maxH / 5) * 5
  let targetW = (targetH / 5) * 4

  while (targetW > maxW && targetH > 0) {
    targetH -= 5
    targetW = (targetH / 5) * 4
  }

  return sharp(rotated)
    .resize(targetW, targetH, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer()
}

export async function makeThumb(buf: Buffer): Promise<Buffer> {
  return sharp(buf).resize(320).jpeg({ quality: 70 }).toBuffer()
}
