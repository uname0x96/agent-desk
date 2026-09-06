import { describe, expect, it } from 'vitest'
import { isDecimalUsdt } from '@agent-desk/schemas'
import { seedListing } from './seed-listing.ts'

/**
 * The seed reads this descriptor instead of hard-coding the agent's price and
 * port a second time. These assertions are the ones that would break if the
 * compose service and the descriptor drifted apart.
 */
describe('seedListing', () => {
  it('matches the compose service and PRD addendum §2', () => {
    expect(seedListing).toEqual({
      name: 'Telegram Notifier',
      type: 'notify',
      price: '0.005',
      port: 4106,
      endpointEnv: 'TELEGRAM_NOTIFIER_URL',
      defaultEndpoint: 'http://agent-telegram-notifier:4106',
    })
  })

  it('carries a decimal USDT price (AD-13)', () => {
    expect(isDecimalUsdt(seedListing.price)).toBe(true)
  })
})
