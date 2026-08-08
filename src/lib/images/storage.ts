import { put, del } from '@vercel/blob'

export async function uploadImage(buf: Buffer, key: string) {
  const blob = await put(key, buf, {
    access: 'public',
    contentType: 'image/jpeg',
    addRandomSuffix: false,
    allowOverwrite: true, // Safe because keys are content-addressed — identical bytes always for identical key.
  })
  return { url: blob.url, pathname: blob.pathname }
}

export async function deleteImage(url: string): Promise<void> {
  await del(url)
}
