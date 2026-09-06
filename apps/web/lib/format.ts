import { toDecimalUsdt } from '@agent-desk/schemas'
import { keccak256Hex } from './keccak.ts'

/**
 * AD-13: every shared value has one format. Amounts arrive as base-unit
 * strings and are rendered as decimals labelled `tUSD`; addresses and hashes
 * arrive lower-case and are rendered checksummed. This module is the only
 * place the web app formats them.
 */

export const TOKEN_LABEL = 'tUSD'

/** "10000" -> "0.01". Never touches a float. */
export function formatUsdt(base: string): string {
  return toDecimalUsdt(base)
}

/** "10000" -> "0.01 tUSD". */
export function formatUsdtLabelled(base: string): string {
  return `${toDecimalUsdt(base)} ${TOKEN_LABEL}`
}

/** EIP-55. Input may be any case; output is the checksummed form. */
export function checksumAddress(address: string): string {
  const lower = address.toLowerCase().replace(/^0x/, '')
  if (!/^[0-9a-f]{40}$/.test(lower)) throw new Error(`not an address: ${address}`)
  const hash = keccak256Hex(lower)
  let out = '0x'
  for (let index = 0; index < 40; index += 1) {
    const digit = lower[index]!
    out += parseInt(hash[index]!, 16) >= 8 ? digit.toUpperCase() : digit
  }
  return out
}

/** Checksums when the value is an address, otherwise returns it unchanged. */
export function formatAddress(address: string | null | undefined): string {
  if (!address) return '—'
  try {
    return checksumAddress(address)
  } catch {
    return address
  }
}

/**
 * Transaction hashes have no EIP-55 checksum; they are normalised to
 * lower-case `0x` hex so one hash never appears in two spellings.
 */
export function formatTxHash(hash: string | null | undefined): string {
  if (!hash) return '—'
  return hash.toLowerCase()
}

/** `0x5aAeb605…f1BeAed`, for columns too narrow for the full value. */
export function truncateMiddle(value: string, lead = 10, tail = 8): string {
  if (value.length <= lead + tail + 1) return value
  return `${value.slice(0, lead)}…${value.slice(-tail)}`
}

const UNITS: readonly [limitSeconds: number, seconds: number, name: string][] = [
  [60, 1, 'second'],
  [3600, 60, 'minute'],
  [86400, 3600, 'hour'],
  [2592000, 86400, 'day'],
]

/**
 * "just now", "12 seconds ago", "in 3 minutes". `now` is injectable so the
 * result is testable and so a server render can pass its own clock.
 */
export function formatRelativeTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '—'
  const then = Date.parse(normaliseIso(iso))
  if (Number.isNaN(then)) return iso
  const deltaSeconds = Math.round((then - now.getTime()) / 1000)
  const magnitude = Math.abs(deltaSeconds)
  if (magnitude < 5) return 'just now'

  const formatter = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
  for (const [limit, divisor, unit] of UNITS) {
    if (magnitude < limit) {
      return formatter.format(Math.round(deltaSeconds / divisor), unit as Intl.RelativeTimeFormatUnit)
    }
  }
  return formatter.format(Math.round(deltaSeconds / 2592000), 'month')
}

/** ISO 8601 UTC, printed to the second: "2026-09-05 02:00:07 UTC". */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const parsed = new Date(normaliseIso(iso))
  if (Number.isNaN(parsed.getTime())) return iso
  return `${parsed.toISOString().slice(0, 19).replace('T', ' ')} UTC`
}

/** "1.8 s", "412 ms" — how long a Call took. */
export function formatDuration(fromIso: string | null | undefined, toIso: string | null | undefined): string {
  if (!fromIso || !toIso) return '—'
  const from = Date.parse(normaliseIso(fromIso))
  const to = Date.parse(normaliseIso(toIso))
  if (Number.isNaN(from) || Number.isNaN(to)) return '—'
  const ms = to - from
  if (ms < 1000) return `${ms} ms`
  return `${(ms / 1000).toFixed(1)} s`
}

/** AD-14 timestamps are ISO 8601 UTC without an offset; Date.parse needs the Z. */
function normaliseIso(iso: string): string {
  return /(?:Z|[+-]\d{2}:?\d{2})$/.test(iso) ? iso : `${iso}Z`
}

export function formatJson(value: unknown): string {
  if (value === null || value === undefined) return '—'
  return JSON.stringify(value, null, 2)
}
