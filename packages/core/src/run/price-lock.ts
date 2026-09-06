import { X402_MAX_TIMEOUT_SECONDS, X402_SCHEME, type PriceLockNode } from '@agent-desk/schemas'

/**
 * AD-6 / FR-23 / FR-26: the one comparison rule between a 402 and the Price
 * Lock. There is deliberately a single implementation, and it is pure, so the
 * engine and its tests can never disagree about what "the same price" means.
 *
 * The rule, in order:
 *
 *   1. select the *first* `accepts` entry whose `scheme`, `network` (compared as
 *      an exact CAIP-2 string) and `asset` match the lock;
 *   2. compare `payTo` as an address and `amount` as a `bigint`;
 *   3. refuse a `maxTimeoutSeconds` above 15;
 *   4. refuse a 402 with no EIP-712 domain in `extra` — there is no default
 *      asset for eip155:97, so an authorization could not be signed for it and
 *      the facilitator would reject it anyway.
 *
 * Any of 1 to 4 failing is a `price_mismatch`: nothing is signed and nothing is
 * paid. {@link describeMismatch} renders both values for `calls.failure_reason`.
 *
 * Address equality is a parameter because AD-13 fixes the comparison to viem's
 * `isAddressEqual` and AD-1 forbids core from importing viem. The worker passes
 * `isAddressEqual`; the default here is the case-insensitive comparison that
 * agrees with it for every address AD-13 lets into the database.
 */

export type AddressEquals = (left: string, right: string) => boolean

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/

/** Agrees with `isAddressEqual` for well-formed addresses and never throws. */
export const caseInsensitiveAddressEquals: AddressEquals = (left, right) => {
  if (!HEX_ADDRESS.test(left) || !HEX_ADDRESS.test(right)) return false
  return left.toLowerCase() === right.toLowerCase()
}

/** The lock terms of one Node, as a 402 must state them. */
export interface LockTerms {
  scheme: string
  /** CAIP-2, compared as an exact string. */
  network: string
  asset: string
  /** Base units, AD-13. */
  amount: string
  payTo: string
  maxTimeoutSeconds: number
}

/** One entry of the 402's `accepts` array, as far as this comparison cares. */
export interface AcceptsEntry {
  scheme: string
  network: string
  asset: string
  amount: string
  payTo: string
  maxTimeoutSeconds: number
  extra?: unknown
}

export const MISMATCH_FIELDS = [
  'accepts',
  'pay_to',
  'amount',
  'max_timeout_seconds',
  'extra',
] as const
export type MismatchField = (typeof MISMATCH_FIELDS)[number]

export interface PriceLockMismatch {
  field: MismatchField
  /** What the Price Lock says, rendered for `calls.failure_reason`. */
  expected: string
  /** What the 402 said. */
  actual: string
}

export interface Eip712Domain {
  name: string
  version: string
}

export type PriceLockComparison =
  | { ok: true; entry: AcceptsEntry; extra: Eip712Domain }
  | { ok: false; mismatch: PriceLockMismatch }

/** AD-13: the Price Lock node is exactly the terms a 402 has to restate. */
export function lockTermsFor(
  node: Pick<PriceLockNode, 'price' | 'asset' | 'network' | 'pay_to'>,
  maxTimeoutSeconds: number = X402_MAX_TIMEOUT_SECONDS,
): LockTerms {
  return {
    scheme: X402_SCHEME,
    network: node.network,
    asset: node.asset,
    amount: node.price,
    payTo: node.pay_to,
    maxTimeoutSeconds,
  }
}

const BASE_UNITS = /^(?:0|[1-9]\d*)$/

function sameAmount(left: string, right: string): boolean {
  if (!BASE_UNITS.test(left) || !BASE_UNITS.test(right)) return false
  return BigInt(left) === BigInt(right)
}

/** The `extra` an EIP-3009 authorization is signed against, or null. */
function domainOf(extra: unknown): Eip712Domain | null {
  if (!extra || typeof extra !== 'object') return null
  const record = extra as Record<string, unknown>
  const { name, version } = record
  if (typeof name !== 'string' || name === '') return null
  if (typeof version !== 'string' && typeof version !== 'number') return null
  return { name, version: String(version) }
}

function renderEntry(entry: AcceptsEntry): string {
  return `scheme=${entry.scheme} network=${entry.network} asset=${entry.asset}`
}

export function comparePriceLock(
  lock: LockTerms,
  accepts: readonly AcceptsEntry[],
  equals: AddressEquals = caseInsensitiveAddressEquals,
): PriceLockComparison {
  const entry = accepts.find(
    (candidate) =>
      candidate.scheme === lock.scheme &&
      candidate.network === lock.network &&
      equals(candidate.asset, lock.asset),
  )

  if (!entry) {
    return {
      ok: false,
      mismatch: {
        field: 'accepts',
        expected: renderEntry({ ...lock, extra: undefined }),
        actual:
          accepts.length === 0
            ? 'no accepts entry'
            : accepts.map(renderEntry).join(' | '),
      },
    }
  }

  if (!equals(entry.payTo, lock.payTo)) {
    return { ok: false, mismatch: { field: 'pay_to', expected: lock.payTo, actual: entry.payTo } }
  }

  if (!sameAmount(entry.amount, lock.amount)) {
    return { ok: false, mismatch: { field: 'amount', expected: lock.amount, actual: entry.amount } }
  }

  if (
    !Number.isFinite(entry.maxTimeoutSeconds) ||
    entry.maxTimeoutSeconds > lock.maxTimeoutSeconds
  ) {
    return {
      ok: false,
      mismatch: {
        field: 'max_timeout_seconds',
        expected: `at most ${lock.maxTimeoutSeconds}`,
        actual: String(entry.maxTimeoutSeconds),
      },
    }
  }

  const extra = domainOf(entry.extra)
  if (!extra) {
    return {
      ok: false,
      mismatch: {
        field: 'extra',
        expected: 'an EIP-712 domain { name, version }',
        actual: entry.extra === undefined ? 'absent' : JSON.stringify(entry.extra),
      },
    }
  }

  return { ok: true, entry, extra }
}

/** FR-26: both values on the Call, so the Run view can show what differed. */
export function describeMismatch(mismatch: PriceLockMismatch): string {
  return `price lock mismatch on ${mismatch.field}: expected ${mismatch.expected}, got ${mismatch.actual}`
}
