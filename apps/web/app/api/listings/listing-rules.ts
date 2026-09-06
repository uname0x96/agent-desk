import {
  AGENT_TYPES,
  asDecimalUsdt,
  toBaseUnits,
  toDecimalUsdt,
  type AgentType,
  type CreateListingRequest,
} from '@agent-desk/schemas'

/**
 * FR-10 / FR-14: every rule the listing form enforces, and the sentence each one
 * refuses with.
 *
 * These are pure and import nothing but the unit conversions, which is what lets
 * the form in the browser and `POST /api/listings` on the server apply one
 * definition rather than two that drift. The sentences matter as much as the
 * booleans: they are what a stranger reads thirty seconds into using the
 * product, so each one names the single thing to change.
 */

// ------------------------------------------------------------------- rules

/** FR-10: a price a Builder might actually put in a Workflow. */
export const MAX_PRICE_BASE_UNITS = 1_000_000n

/** FR-7: the Registry itself reverts below this, so the form refuses first. */
export const STAKE_MULTIPLE = 10n

/**
 * The conventions' `http://` allow-list. A compose service name has no dot in
 * it (`agent-binance-ticker`), which is exactly what resolves inside the
 * network the worker calls from and nowhere else — the same rule
 * `classifyPublicBaseUrl` applies in `scripts/checks`.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal'])

export type FieldName = 'name' | 'type' | 'endpoint' | 'price' | 'stake' | 'payout_wallet'

export type FieldErrors = Partial<Record<FieldName, string>>

export interface Valid {
  name: string
  type: AgentType
  description: string | null
  endpoint: string
  /** Base units. */
  price: string
  /** Base units. */
  stake: string
  /** Lower-case, or null to mean "the Creator's System Wallet". */
  payoutWallet: string | null
}

export type Validated = { ok: true; value: Valid } | { ok: false; errors: FieldErrors }

/**
 * Every field rule in one pass, so the form can highlight all of its problems
 * at once instead of making the Creator submit six times.
 */
export function validateListing(input: CreateListingRequest): Validated {
  const errors: FieldErrors = {}

  const name = input.name.trim()
  if (name.length === 0) errors.name = 'a name is required'

  if (!AGENT_TYPES.includes(input.type)) {
    errors.type = `type must be one of ${AGENT_TYPES.join(', ')}`
  }

  const endpoint = validateEndpoint(input.endpoint)
  if (!endpoint.ok) errors.endpoint = endpoint.message

  const price = validatePrice(input.price)
  if (!price.ok) errors.price = price.message

  const stake = validateStake(input.stake, price.ok ? price.baseUnits : null)
  if (!stake.ok) errors.stake = stake.message

  const payoutWallet = validatePayoutWallet(input.payout_wallet)
  if (!payoutWallet.ok) errors.payout_wallet = payoutWallet.message

  if (Object.keys(errors).length > 0) return { ok: false, errors }
  if (!endpoint.ok || !price.ok || !stake.ok || !payoutWallet.ok) return { ok: false, errors }

  const description = input.description?.trim() ?? ''
  return {
    ok: true,
    value: {
      name,
      type: input.type,
      description: description.length === 0 ? null : description,
      endpoint: endpoint.endpoint,
      price: price.baseUnits.toString(),
      stake: stake.baseUnits.toString(),
      payoutWallet: payoutWallet.address,
    },
  }
}

export type EndpointResult = { ok: true; endpoint: string } | { ok: false; message: string }

/**
 * FR-10: `https://` is the rule and `http://` is the exception the demo needs.
 * The exception is deliberately narrow — the worker POSTs to this URL from
 * inside a container and the `agentURI` on chain points at the deployment
 * forever, so "it worked in my browser" is not evidence.
 */
export function validateEndpoint(value: string): EndpointResult {
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: false, message: 'an endpoint is required' }
  if (!URL.canParse(trimmed)) return { ok: false, message: `${trimmed} is not a URL` }

  const url = new URL(trimmed)
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (url.protocol === 'https:') return { ok: true, endpoint: normaliseEndpoint(url) }
  if (url.protocol !== 'http:') {
    return { ok: false, message: `${url.protocol}// is not an HTTP endpoint; use https://` }
  }
  if (isLocalHost(host)) return { ok: true, endpoint: normaliseEndpoint(url) }

  return {
    ok: false,
    message:
      'http:// is accepted only for localhost, 127.0.0.1, host.docker.internal and compose ' +
      'service names; every other endpoint must be https://',
  }
}

function isLocalHost(host: string): boolean {
  if (LOCAL_HOSTS.has(host)) return true
  if (host.endsWith('.localhost') || host.endsWith('.internal')) return true
  if (/^127\./.test(host)) return true
  // A single-label host is a compose service name: `web`, `agent-ticker`. The
  // public internet does not resolve one, so it can only mean the local network.
  return !host.includes('.')
}

/** The query and the fragment are noise on a POST target; the path is not. */
function normaliseEndpoint(url: URL): string {
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}${url.search}`
}

export type PriceResult = { ok: true; baseUnits: bigint } | { ok: false; message: string }

/** FR-10: `0 < price ≤ 1` tUSD, in at most the six decimals tUSD has. */
export function validatePrice(value: string): PriceResult {
  let baseUnits: bigint
  try {
    baseUnits = toBaseUnits(asDecimalUsdt(value.trim()))
  } catch {
    return { ok: false, message: `${value} is not an amount in tUSD (at most 6 decimal places)` }
  }
  if (baseUnits <= 0n) return { ok: false, message: 'the price must be more than 0 tUSD' }
  if (baseUnits > MAX_PRICE_BASE_UNITS) {
    return {
      ok: false,
      message: `the price may not be more than ${toDecimalUsdt(MAX_PRICE_BASE_UNITS)} tUSD a call`,
    }
  }
  return { ok: true, baseUnits }
}

export type StakeResult = { ok: true; baseUnits: bigint } | { ok: false; message: string }

/**
 * FR-7: at least ten times the price. `AgentDeskRegistry.list` reverts below it
 * and `listing.verify` refuses before it signs, so saying it here saves the
 * Creator a failed listing rather than inventing a rule.
 */
export function validateStake(value: string, price: bigint | null): StakeResult {
  let baseUnits: bigint
  try {
    baseUnits = toBaseUnits(asDecimalUsdt(value.trim()))
  } catch {
    return { ok: false, message: `${value} is not an amount in tUSD (at most 6 decimal places)` }
  }
  if (price === null) return { ok: true, baseUnits }

  const minimum = price * STAKE_MULTIPLE
  if (baseUnits < minimum) {
    return {
      ok: false,
      message:
        `the Stake must be at least ten times the price, so at least ` +
        `${toDecimalUsdt(minimum)} tUSD for a price of ${toDecimalUsdt(price)} tUSD`,
    }
  }
  return { ok: true, baseUnits }
}

export type PayoutWalletResult = { ok: true; address: string | null } | { ok: false; message: string }

/** Absent means the Creator's own System Wallet, decided once the row is read. */
export function validatePayoutWallet(value: string | undefined): PayoutWalletResult {
  if (value === undefined) return { ok: true, address: null }
  const trimmed = value.trim()
  if (trimmed.length === 0) return { ok: true, address: null }
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) {
    return { ok: false, message: `${trimmed} is not a wallet address` }
  }
  return { ok: true, address: trimmed.toLowerCase() }
}

/** The Stake the form warns about, so the number on screen is this one. */
export function defaultStake(price: bigint): bigint {
  return price * STAKE_MULTIPLE
}
