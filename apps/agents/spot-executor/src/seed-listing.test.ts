import { describe, expect, it } from 'vitest'
import { createListingRequest, toBaseUnits } from '@agent-desk/schemas'
import { seedListing, seedListingAt, SPOT_EXECUTOR_COMPOSE_URL } from './seed-listing.ts'

/**
 * The descriptor `scripts/src/seed.ts` imports. It has to satisfy the same
 * `createListingRequest` the API validates, or the seed would fail at the
 * moment the demo needs it.
 */

describe('seedListing', () => {
  it('is a valid createListingRequest body', () => {
    const parsed = createListingRequest.safeParse({
      name: seedListing.name,
      type: seedListing.type,
      endpoint: seedListing.endpoint,
      price: seedListing.price,
      stake: seedListing.stake,
      description: seedListing.description,
    })
    expect(parsed.success).toBe(true)
  })

  it('lists the execution Type at the compose price of Story 2.5', () => {
    expect(seedListing.type).toBe('execution')
    expect(seedListing.price).toBe('0.01')
    expect(seedListing.endpoint).toBe(SPOT_EXECUTOR_COMPOSE_URL)
    expect(seedListing.owner).toBe('platform')
    expect(seedListing.skip_verification).toBe(true)
  })

  it('stakes ten times the price, which is the platform minimum', () => {
    expect(toBaseUnits(seedListing.stake)).toBe(toBaseUnits(seedListing.price) * 10n)
  })

  it('can be pointed at a host outside compose', () => {
    const local = seedListingAt('http://localhost:4105')
    expect(local.endpoint).toBe('http://localhost:4105')
    expect(local.price).toBe(seedListing.price)
  })
})
