import { neon } from '@neondatabase/serverless'
import { drizzle } from 'drizzle-orm/neon-http'
import * as schema from './schema'

let _db: ReturnType<typeof create> | null = null

function create() {
  return drizzle(neon(process.env.DATABASE_URL!), { schema })
}

export function getDb() {
  if (!_db) _db = create()
  return _db
}
