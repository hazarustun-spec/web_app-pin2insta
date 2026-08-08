import { createHash } from 'node:crypto'
import sharp from 'sharp'

/** Instagram's tallest accepted ratio. */
const TARGET_W = 1080
const TARGET_H = 1350

export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Center-crop to 4:5 and cap at 1080x1350. Content at the edges is lost by design. */
export async function cropTo45(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .rotate() // honour EXIF orientation before measuring
    .resize(TARGET_W, TARGET_H, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer()
}

export async function makeThumb(buf: Buffer): Promise<Buffer> {
  return sharp(buf).resize(320).jpeg({ quality: 70 }).toBuffer()
}
