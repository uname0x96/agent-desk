/** AD-8: one intent key per transaction. Built here so no caller spells one by hand. */

export const INTENT_PREFIXES = [
  'gas',
  'mint',
  'approve',
  'identity',
  'identity-uri',
  'list',
  'stake',
  'price',
  'pause',
  'slash',
  'reputation',
] as const
export type IntentPrefix = (typeof INTENT_PREFIXES)[number]

export const intentKeys = {
  gas: (walletId: string) => `gas:${walletId}`,
  mint: (walletId: string) => `mint:${walletId}`,
  approve: (walletId: string) => `approve:${walletId}`,
  identity: (listingId: string) => `identity:${listingId}`,
  identityUri: (listingId: string, n: number) => `identity-uri:${listingId}:${n}`,
  list: (listingId: string) => `list:${listingId}`,
  stake: (listingId: string, n: number) => `stake:${listingId}:${n}`,
  price: (listingId: string, n: number) => `price:${listingId}:${n}`,
  pause: (listingId: string, n: number) => `pause:${listingId}:${n}`,
  slash: (callId: string) => `slash:${callId}`,
  reputation: (listingId: string, settlementId: string) => `reputation:${listingId}:${settlementId}`,
} as const

export function intentPrefixOf(intentKey: string): IntentPrefix | null {
  const prefix = intentKey.split(':')[0]
  return (INTENT_PREFIXES as readonly string[]).includes(prefix ?? '')
    ? (prefix as IntentPrefix)
    : null
}

/** The listing an intent names, if it names one (AD-2: drives refreshListingFromChain). */
export function listingIdOfIntent(intentKey: string): string | null {
  const [prefix, second] = intentKey.split(':')
  if (!prefix || !second) return null
  if (['identity', 'identity-uri', 'list', 'stake', 'price', 'pause', 'reputation'].includes(prefix)) {
    return second
  }
  return null
}
