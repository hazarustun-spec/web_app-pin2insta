import { createDryRunClient } from './dryrun'
import { createGraphClient } from './graph'
import type { InstagramClient } from './types'

export * from './types'

export function getInstagramClient(): InstagramClient {
  if (!process.env.IG_ACCESS_TOKEN || !process.env.IG_USER_ID) return createDryRunClient()
  return createGraphClient()
}
