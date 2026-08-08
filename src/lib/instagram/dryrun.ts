import { validate, type InstagramClient, type PublishInput } from './types'

let counter = 0

export function createDryRunClient(): InstagramClient {
  return {
    isDryRun: true,
    async publish(input: PublishInput) {
      validate(input)
      const id = `dryrun-${++counter}`
      console.log('[dry-run] would publish', {
        kind: input.kind, images: input.imageUrls.length, captionLength: input.caption.length,
      })
      return { igMediaId: id, permalink: `https://instagram.com/p/${id}?dryrun=1` }
    },
    async insights() {
      return { likes: 0, comments: 0, reach: 0, saved: 0 }
    },
  }
}
