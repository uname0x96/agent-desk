/**
 * BNB is the gas the System Wallet needs, and it is the one amount in the app
 * that is not tUSD, so `lib/format.ts` — which is tUSD and addresses — has no
 * place for it. Eighteen decimals, integer arithmetic only, and truncated
 * rather than rounded: a balance the page shows must never read higher than the
 * chain's.
 */

export const BNB_DECIMALS = 18
/** Enough to see a gas top-up land, few enough to read on a projector. */
export const BNB_DISPLAY_DECIMALS = 6

export function formatBnb(wei: string | bigint): string {
  const value = typeof wei === 'bigint' ? wei : BigInt(wei)
  if (value < 0n) throw new Error(`negative amount: ${value}`)

  const divisor = 10n ** BigInt(BNB_DECIMALS)
  const whole = value / divisor
  const fraction = (value % divisor)
    .toString()
    .padStart(BNB_DECIMALS, '0')
    .slice(0, BNB_DISPLAY_DECIMALS)
    .replace(/0+$/, '')

  return fraction === '' ? `${whole}` : `${whole}.${fraction}`
}

export function formatBnbLabelled(wei: string | bigint): string {
  return `${formatBnb(wei)} BNB`
}
