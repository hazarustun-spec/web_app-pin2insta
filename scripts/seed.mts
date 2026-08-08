import { getDb } from '../src/db'
import { settings } from '../src/db/schema'

await getDb().insert(settings).values({ id: 1 }).onConflictDoNothing()
console.log('settings seeded')
