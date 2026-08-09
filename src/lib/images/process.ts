import { createHash } from 'node:crypto'
import sharp from 'sharp'

/** Instagram's tallest accepted ratio. */
const TARGET_W = 1080
const TARGET_H = 1350

/**
 * Decode ceiling, ~8000x8000. A 25MB upload cap does not bound decode memory:
 * a 2MB flat-colour 40000x4000 PNG expands to a ~458MB bitmap. Pixel count is
 * what costs RAM, so that is what we cap. Every real phone/camera photo is
 * well under this.
 */
const MAX_PIXELS = 64_000_000

/**
 * Formats we decode. `file.type` on an upload is client-supplied and never
 * checked against the bytes, so this — not the route's Content-Type allowlist —
 * is what actually keeps SVG away from librsvg (SVGs can embed scripts and
 * external references).
 *
 * AVIF is absent on purpose: sharp reports it as `heif`, never `avif`, so
 * listing 'avif' here would reject every AVIF while matching nothing. It is
 * accepted via the heif/av1 pair below.
 */
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp'])

/**
 * `heif` covers both AVIF and HEIC. Instagram takes neither directly, but we
 * re-encode to JPEG anyway, and AVIF is what browsers hand you on "Copy image"
 * — so accept AVIF and exclude HEIC by discriminating on the codec.
 */
function isAcceptedFormat(probe: { format?: string; compression?: string }): boolean {
  if (probe.format && ALLOWED_FORMATS.has(probe.format)) return true
  return probe.format === 'heif' && probe.compression === 'av1'
}

/**
 * Thrown only for the deliberate, user-facing validation failures below.
 * A decode failure inside libvips is NOT one of these — its message is raw
 * internal text ("VipsJpeg: Premature end of input file /var/task/...") and
 * must never reach the client.
 */
export class ImageValidationError extends Error {}

/** Hash the image bytes. Callers must hash the output of cropTo45, not the raw upload — product-wide duplicate detection depends on the exact bytes hashed. */
export function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

/** Center-crop to 4:5 and cap at 1080x1350. Content at the edges is lost by design. */
export async function cropTo45(buf: Buffer): Promise<Buffer> {
  // Probe the header before decoding anything. metadata() parses the container
  // only, so format and dimensions are known without ever materializing a
  // bitmap — both bombs and disguised SVGs are rejected before they cost RAM.
  let probe
  try {
    probe = await sharp(buf).metadata()
  } catch {
    throw new ImageValidationError('görsel okunamadı')
  }

  if (!isAcceptedFormat(probe)) {
    throw new ImageValidationError('desteklenmeyen görsel biçimi')
  }
  if (!probe.width || !probe.height) {
    throw new ImageValidationError('Görsel yüklenemedi')
  }
  // Rotation swaps the axes but not the product, so this holds pre-rotation.
  // width*height is total decoded pixels only because sharp defaults to
  // pages: 1 — an animated file decodes its first frame and nothing more.
  // Setting { animated: true } or pages: -1 anywhere below would invalidate this.
  if (probe.width * probe.height > MAX_PIXELS) {
    throw new ImageValidationError('görsel çok büyük — en fazla 64 megapiksel olmalı')
  }

  // Materialize rotation before measuring—metadata() returns raw dimensions without pending transforms.
  const rotated = await sharp(buf, { limitInputPixels: MAX_PIXELS }).rotate().toBuffer()
  const metadata = await sharp(rotated, { limitInputPixels: MAX_PIXELS }).metadata()

  if (!metadata.width || !metadata.height) {
    throw new ImageValidationError('Görsel yüklenemedi')
  }

  // Instagram's floor is 320px on the OUTPUT. Guarding the source short edge is
  // not enough: the output width is derived from the output height at 4:5, so a
  // 1920x360 source passes a 320 check and produces a 288px-wide image that
  // Instagram then refuses at container creation — three ticks later, as a
  // failed card, instead of here where the owner can pick another picture.
  // 4:5 means the height must be at least 400 for the width to reach 320.
  const shortEdge = Math.min(metadata.width, metadata.height)
  if (shortEdge < 320 || metadata.height < 400) {
    throw new ImageValidationError('görsel çok küçük — en az 320x400px olmalı')
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

  return sharp(rotated, { limitInputPixels: MAX_PIXELS })
    .resize(targetW, targetH, { fit: 'cover', position: 'centre' })
    .jpeg({ quality: 88, mozjpeg: true })
    .toBuffer()
}

export async function makeThumb(buf: Buffer): Promise<Buffer> {
  // Same decode ceiling as cropTo45. Today this only ever sees cropTo45's own
  // output, but it is a decode path and must not be the one that skips the cap.
  return sharp(buf, { limitInputPixels: MAX_PIXELS }).resize(320).jpeg({ quality: 70 }).toBuffer()
}
