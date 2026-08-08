export type PublishKind = 'feed' | 'carousel' | 'story'

export type PublishInput = {
  kind: PublishKind
  imageUrls: string[]
  caption: string
}

export type PublishResult = { igMediaId: string; permalink: string }

export type Insights = { likes: number; comments: number; reach: number; saved: number }

export interface InstagramClient {
  publish(input: PublishInput): Promise<PublishResult>
  insights(mediaId: string): Promise<Insights>
  isDryRun: boolean
}

export class InstagramError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** Graph API `error.type`, e.g. `OAuthException` — used to tell a dead token from a genuine data-not-found response. */
    readonly type?: string,
    /** Graph API `error.code`. */
    readonly code?: number,
  ) {
    super(message)
    this.name = 'InstagramError'
  }
}

/**
 * Rejects payloads Instagram would reject, so dry-run and live behave identically.
 * A caption on a `story` input passes validation but is intentionally discarded at publish
 * time — the Graph API has no caption field for `media_type=STORIES`.
 */
export function validate(input: PublishInput): void {
  if (!input.caption.trim() && input.kind !== 'story') {
    throw new InstagramError('caption is empty')
  }
  if (input.imageUrls.length === 0) throw new InstagramError('no images')
  if (input.kind === 'carousel' && (input.imageUrls.length < 2 || input.imageUrls.length > 10)) {
    throw new InstagramError('carousel needs between 2 and 10 images')
  }
  if (input.kind !== 'carousel' && input.imageUrls.length !== 1) {
    throw new InstagramError(`${input.kind} takes exactly one image`)
  }
  if (input.caption.length > 2200) throw new InstagramError('caption exceeds 2200 characters')
}
