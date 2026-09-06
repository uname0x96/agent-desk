import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.ts'

/**
 * One connection pool per process. Web, worker, and scripts all reach Postgres
 * through this module; nothing else opens a connection (AD-3).
 */

export type Database = ReturnType<typeof createDb>

export interface DbOptions {
  /** Defaults to `DATABASE_URL`. */
  url?: string
  max?: number
}

export function createDb(options: DbOptions = {}) {
  const url = options.url ?? process.env.DATABASE_URL
  if (!url) throw new Error('DATABASE_URL is not set')
  const sql = postgres(url, { max: options.max ?? 10 })
  return drizzle(sql, { schema })
}

let shared: Database | undefined

/** The process-wide connection. Lazy so importing the schema never dials out. */
export function db(): Database {
  shared ??= createDb()
  return shared
}
