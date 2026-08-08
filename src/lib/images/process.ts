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
  const image = sharp(buf).rotate() // honour EXIF orientation before measuring
  const metadata = await image.metadata()

  if (!metadata.width || !metadata.height) {
    throw new Error('Görsel yüklenemedi')
  }

  const shortEdge = Math.min(metadata.width, metadata.height)
  if (shortEdge < 320) {
    throw new Error('görsel çok küçük — en az 320px olmalı')
  }

  // Calculate the maximum dimensions for a 4:5 crop without enlargement.
  // The 4:5 ratio means width / height = 0.8.
  const maxWidth = Math.min(TARGET_W, metadata.width)
  const maxHeight = Math.min(TARGET_H, metadata.height)

  // Adjust to maintain 4:5 ratio without enlargement
  const targetWidth = Math.min(maxWidth, maxHeight * 0.8)
  const targetHeight = targetWidth / 0.8

  return image
    .resize(Math.round(targetWidth), Math.round(targetHeight), { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer()
}

export async function makeThumb(buf: Buffer): Promise<Buffer> {
  return sharp(buf).resize(320).jpeg({ quality: 70 }).toBuffer()
}
