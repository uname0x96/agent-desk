import { sql, type SQL } from 'drizzle-orm'

/**
 * AD-13 is enforced twice: once in TypeScript through the union types of
 * `@agent-desk/schemas`, and once in Postgres through the CHECK constraints
 * built here, so a hand-written UPDATE cannot invent a status, an upper-case
 * address, or a float amount.
 */

/** A base-unit integer amount, AD-13. Never a decimal, never signed. */
export const BASE_UNITS_PATTERN = '^(0|[1-9][0-9]*)$'
/** A non-negative decimal amount in USDT, AD-13 (order sizes, exchange prices). */
export const DECIMAL_PATTERN = '^(0|[1-9][0-9]*)(\\.[0-9]+)?$'
/** Lower-case 0x address, AD-13. */
export const ADDRESS_PATTERN = '^0x[0-9a-f]{40}$'
/** Lower-case 0x transaction hash, AD-13. */
export const TX_HASH_PATTERN = '^0x[0-9a-f]{64}$'

/** `<column> ~ '<pattern>'`, tolerating NULL as Postgres does. */
export function matches(column: SQL | unknown, pattern: string): SQL {
  return sql`${column} ~ ${sql.raw(quote(pattern))}`
}

/** `<column> in ('a', 'b')` over a compile-time constant list. */
export function oneOf(column: SQL | unknown, values: readonly string[]): SQL {
  const list = values.map(quote).join(', ')
  return sql`${column} in (${sql.raw(list)})`
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}
