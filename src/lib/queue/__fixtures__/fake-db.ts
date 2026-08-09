import { Column, Param, StringChunk, SQL, getTableColumns, getTableName } from 'drizzle-orm'
import { items, images, settings } from '@/src/db/schema'

/**
 * An in-memory stand-in for the Neon/Drizzle handle, used by the publisher's
 * tests. It is deliberately NOT a recorder that returns canned rows:
 *
 * - it EVALUATES the `where` clause, so `isNull(items.postedDate)` in the slot
 *   claim is the thing that decides whether the claim matches. Delete that
 *   predicate and the fake happily claims an already-claimed item, exactly as
 *   Postgres would;
 * - it ENFORCES `items_slot_unique_idx` on (posted_date, slot_index), throwing
 *   a Postgres-shaped 23505, so the idempotency backstop is real here;
 * - every statement completes on a later macrotask, so two concurrent
 *   `runPublish` calls genuinely interleave instead of running to completion
 *   one after the other.
 *
 * Only the SQL the publisher actually emits is supported: eq / ne / isNull,
 * `and` of those, and `asc`/`desc` ordering. Anything else throws rather than
 * silently matching everything.
 */

export type Row = Record<string, unknown>

export type Trace = { op: string; table?: string; values?: Row; ids?: string[] }

export const state = {
  items: [] as Row[],
  images: [] as Row[],
  settings: [] as Row[],
  /** Ordered trace of every statement that reached the store. */
  trace: [] as Trace[],
  /** Set to make a matching update throw, e.g. to simulate a dropped connection. */
  failUpdate: null as null | ((t: Trace) => unknown),
  /**
   * Runs just before an update evaluates its `where`, so a test can stand in
   * for another cron run that committed in exactly that window.
   */
  beforeUpdate: null as null | ((values: Row, table: string) => void),
}

export function resetDb() {
  state.items = []
  state.images = []
  state.settings = []
  state.trace = []
  state.failUpdate = null
  state.beforeUpdate = null
}

const TABLES: Record<string, { rows: () => Row[] }> = {
  items: { rows: () => state.items },
  images: { rows: () => state.images },
  settings: { rows: () => state.settings },
}

const keyCache = new Map<string, Map<unknown, string>>()

/** Maps a drizzle Column back to the JS property name the rows are keyed by. */
function keyOf(col: Column): string {
  const table = (col as unknown as { table: object }).table
  const name = getTableName(table as never)
  let map = keyCache.get(name)
  if (!map) {
    map = new Map()
    for (const [k, c] of Object.entries(getTableColumns(table as never))) map.set(c, k)
    keyCache.set(name, map)
  }
  const key = map.get(col)
  if (!key) throw new Error(`unknown column on ${name}`)
  return key
}

function chunkText(c: unknown): string | null {
  if (!(c instanceof StringChunk)) return null
  return (c.value as string[]).join('')
}

/** Evaluates the subset of drizzle's SQL tree the publisher builds. */
export function evalWhere(where: unknown, row: Row): boolean {
  if (where === undefined || where === null) return true
  if (!(where instanceof SQL)) throw new Error('unsupported where: not a SQL node')
  const parts = (where.queryChunks as unknown[]).filter((c) => chunkText(c) !== '')

  // `and(...)` wraps its conjunction in literal parentheses.
  if (parts.length === 3 && chunkText(parts[0]) === '(' && chunkText(parts[2]) === ')') {
    return evalWhere(parts[1], row)
  }
  if (parts.some((p) => chunkText(p) === ' and ')) {
    return parts.filter((p) => p instanceof SQL).every((p) => evalWhere(p, row))
  }

  const [col, op, param] = parts
  if (!(col instanceof Column)) throw new Error('unsupported where: expected a column')
  const actual = row[keyOf(col)]
  switch (chunkText(op)) {
    case ' is null':
      return actual === null || actual === undefined
    case ' is not null':
      return actual !== null && actual !== undefined
    case ' = ':
      return actual === (param as Param).value
    case ' <> ':
      return actual !== (param as Param).value
    default:
      throw new Error(`unsupported operator: ${chunkText(op)}`)
  }
}

type OrderTerm = { key: string; dir: 1 | -1 }

function orderTerm(spec: unknown): OrderTerm {
  if (!(spec instanceof SQL)) throw new Error('unsupported order term')
  const parts = (spec.queryChunks as unknown[]).filter((c) => chunkText(c) !== '')
  const [col, dir] = parts
  if (!(col instanceof Column)) throw new Error('unsupported order term')
  return { key: keyOf(col), dir: chunkText(dir) === ' desc' ? -1 : 1 }
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0
  if (a === null || a === undefined) return -1
  if (b === null || b === undefined) return 1
  return (a as number) < (b as number) ? -1 : 1
}

function sortRows(rows: Row[], terms: OrderTerm[]): Row[] {
  return [...rows].sort((x, y) => {
    for (const t of terms) {
      const c = compare(x[t.key], y[t.key]) * t.dir
      if (c !== 0) return c
    }
    return 0
  })
}

function project(row: Row, fields: Record<string, Column> | undefined): Row {
  if (!fields) return { ...row }
  return Object.fromEntries(Object.entries(fields).map(([alias, col]) => [alias, row[keyOf(col)]]))
}

/**
 * Yields to the event loop so concurrent callers interleave. Every read and
 * every write pays this cost, which is what makes the race probe a race.
 */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

/** Postgres' unique_violation, in the shape repo.ts's isDuplicateHashViolation reads. */
class UniqueViolation extends Error {
  code = '23505'
  constructor(readonly constraint: string) {
    super(`duplicate key value violates unique constraint "${constraint}"`)
  }
}

/** `uniqueIndex('items_slot_unique_idx').on(postedDate, slotIndex)`; NULLs are distinct in Postgres. */
function assertSlotUnique(rows: Row[]) {
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.postedDate === null || r.postedDate === undefined) continue
    if (r.slotIndex === null || r.slotIndex === undefined) continue
    const key = `${r.postedDate}#${r.slotIndex}`
    if (seen.has(key)) throw new UniqueViolation('items_slot_unique_idx')
    seen.add(key)
  }
}

function selectBuilder(fields: Record<string, Column> | undefined, table: string) {
  const build = (where: unknown, order: OrderTerm[]) => {
    const run = async () => {
      await tick()
      const rows = TABLES[table].rows().filter((r) => evalWhere(where, r))
      return sortRows(rows, order).map((r) => project(r, fields))
    }
    return {
      where: (w: unknown) => build(w, order),
      orderBy: (...specs: unknown[]) => build(where, specs.map(orderTerm)),
      then: (onFulfilled?: (v: Row[]) => unknown, onRejected?: (e: unknown) => unknown) =>
        run().then(onFulfilled, onRejected),
    }
  }
  return build(undefined, [])
}

function updateBuilder(table: string) {
  return {
    set: (values: Row) => ({
      where: (where: unknown) => {
        const run = async () => {
          await tick()
          state.beforeUpdate?.(values, table)
          const trace: Trace = { op: 'update', table, values }
          const rows = TABLES[table].rows()
          const matched = rows.filter((r) => evalWhere(where, r))
          trace.ids = matched.map((r) => String(r.id))
          const failure = state.failUpdate?.(trace)
          if (failure) {
            state.trace.push({ ...trace, op: 'update-failed' })
            throw failure
          }
          const snapshot = rows.map((r) => ({ ...r }))
          for (const r of matched) Object.assign(r, values)
          try {
            if (table === 'items') assertSlotUnique(rows)
          } catch (e) {
            // Postgres rejects the whole statement; so does the fake.
            TABLES[table].rows().splice(0, rows.length, ...snapshot)
            state.trace.push({ ...trace, op: 'update-rejected' })
            throw e
          }
          state.trace.push(trace)
          return matched
        }
        return {
          returning: (fields?: Record<string, Column>) =>
            run().then((matched) => matched.map((r) => project(r, fields))),
          then: (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) =>
            run().then(onFulfilled, onRejected),
        }
      },
    }),
  }
}

export function getDb() {
  return {
    select: (fields?: Record<string, Column>) => ({
      from: (table: unknown) => selectBuilder(fields, getTableName(table as never)),
    }),
    update: (table: unknown) => updateBuilder(getTableName(table as never)),
  }
}

export const tables = { items, images, settings }
