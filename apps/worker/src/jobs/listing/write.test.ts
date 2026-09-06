import { describe, expect, it } from 'vitest'
import { decodeFunctionData, parseEther } from 'viem'
import { createContractCalls, registryAbi } from '@agent-desk/adapters/chain'
import { intentKeys, type ListingWriteJob } from '@agent-desk/schemas'
import { createListingWriteJob, intentOf, listingStatusFor, REFUSAL } from './write.ts'
import {
  CREATOR_ADDRESS,
  createHarness,
  seedRegistryEntry,
  type FakeListingRow,
  type Harness,
} from './test-harness.ts'

/**
 * FR-7, FR-8, FR-9 / AD-2, AD-5, AD-8: the three changes a Creator can make to
 * a Listing that is already on the Registry.
 *
 * The property under test is what reaches the chain and what is written back.
 * A refusal must cost nothing — no signature, no `chain_tx` row — and must land
 * on `listings.last_error` in the words the manage page is built around. A
 * confirmed transaction must move the terms only through
 * `refreshListingFromChain`, never through a write of this job's own, which is
 * why every happy path asserts the refreshed columns rather than the ones the
 * payload carried.
 *
 * `chainWrite` and the signing policy are real (see `test-harness.ts`); the RPC
 * under them is not. So these prove the job and AD-8's idempotence, not the
 * contracts: whether `setPrice` reverts on `StakeBelowMinimum` for this
 * calldata is proven by `contracts/`, and by the story's live rehearsal.
 */

const LISTING_ID = 'lst_MANAGE'
const REGISTRY_LISTING_ID = 4n
const PRICE = '10000'
const STAKE = '100000'

interface ManageOptions {
  harness?: Harness
  row?: Partial<FakeListingRow>
  /** What `getListing` answers after the write, i.e. what the refresh reads. */
  onChain?: Partial<Parameters<typeof seedRegistryEntry>[2]>
}

function manage(options: ManageOptions = {}) {
  const harness = options.harness ?? createHarness()
  const listing = harness.table.seed({
    id: LISTING_ID,
    status: 'active',
    registryListingId: REGISTRY_LISTING_ID.toString(),
    agentId: '7',
    price: PRICE,
    stake: STAKE,
    ...options.row,
  })
  seedRegistryEntry(harness.reader, REGISTRY_LISTING_ID.toString(), {
    price: BigInt(PRICE),
    stake: BigInt(STAKE),
    ...options.onChain,
  })

  const run = createListingWriteJob({
    listings: harness.table.writeStore(),
    // Exactly what `buildListingWrite` hands over in the worker.
    chain: harness.engine.chain,
    calls: createContractCalls(harness.engine.addresses),
    reader: harness.reader,
  })
  return { harness, listing, run }
}

// -------------------------------------------------------------------- jobs

const before = { price: PRICE, stake: STAKE, paused: false }

function priceJob(price: string, n = 1, overrides: Partial<typeof before> = {}): ListingWriteJob {
  return job(intentKeys.price(LISTING_ID, n), { price }, overrides)
}

function stakeJob(stake: string, n = 1, overrides: Partial<typeof before> = {}): ListingWriteJob {
  return job(intentKeys.stake(LISTING_ID, n), { stake }, overrides)
}

function pauseJob(paused: boolean, n = 1, overrides: Partial<typeof before> = {}): ListingWriteJob {
  return job(intentKeys.pause(LISTING_ID, n), { paused }, overrides)
}

function job(
  intentKey: string,
  after: ListingWriteJob['payload']['after'],
  overrides: Partial<typeof before>,
): ListingWriteJob {
  return {
    listing_id: LISTING_ID,
    intent_key: intentKey,
    payload: { listing_id: LISTING_ID, before: { ...before, ...overrides }, after },
  }
}

/** The one transaction this job sent, decoded from the calldata the signer got. */
function sentCall(harness: Harness, index = 0) {
  const sent = harness.signer.sentTransactions[index]
  if (!sent) throw new Error(`no transaction at index ${index}`)
  return decodeFunctionData({ abi: registryAbi, data: sent.data })
}

// ------------------------------------------------------------------- price

describe('listing.write price:', () => {
  it('sends setPrice and takes the new terms from the refreshed columns', async () => {
    const { harness, run } = manage({ onChain: { price: 5_000n } })
    harness.receipts.expect({})

    const result = await run(priceJob('5000'))

    expect(result).toMatchObject({ ok: true, intent: 'price', outcome: 'sent', status: 'active' })
    expect(sentCall(harness)).toMatchObject({
      functionName: 'setPrice',
      args: [REGISTRY_LISTING_ID, 5_000n],
    })
    // AD-2: the price on the row is the Registry's answer, not the payload's.
    expect(harness.table.get(LISTING_ID).price).toBe('5000')
    expect(harness.table.chainOwnedWrites).toHaveLength(1)
    expect(harness.table.get(LISTING_ID).lastError).toBeNull()
  })

  it('refuses a price the Stake cannot carry, before anything is signed', async () => {
    const { harness, run } = manage()

    // 0.02 tUSD needs 0.2 in Stake; the Registry holds 0.1.
    const result = await run(priceJob('20000'))

    expect(result).toMatchObject({ ok: false, outcome: 'refused', retryable: false })
    expect(result.ok === false && result.reason).toContain(REFUSAL.stakeMinimum)
    expect(harness.signer.sentTransactions).toHaveLength(0)
    expect(harness.chainTx.rows.size).toBe(0)
    expect(harness.table.get(LISTING_ID).lastError).toContain(REFUSAL.stakeMinimum)
  })

  it('re-checks the minimum against the cache as it stands, not as it was enqueued', async () => {
    // The Creator pressed the button when the Stake was 0.2; a slash took it to
    // 0.1 before the job ran. `before` still says 0.2 and the answer is still no.
    const { harness, run } = manage()

    const result = await run(priceJob('20000', 1, { stake: '200000' }))

    expect(result).toMatchObject({ ok: false, outcome: 'refused' })
    expect(harness.signer.sentTransactions).toHaveLength(0)
  })
})

// ------------------------------------------------------------------- stake

describe('listing.write stake:', () => {
  it('sends the difference to addStake and clears a Stake pause through the refresh', async () => {
    const { harness, run } = manage({
      row: { status: 'paused', pausedByStake: true, stake: '40000' },
      onChain: { stake: 100_000n, pausedByStake: false },
    })
    harness.receipts.expect({})

    const result = await run(stakeJob('100000', 1, { stake: '40000' }))

    expect(result).toMatchObject({ ok: true, intent: 'stake', outcome: 'sent', status: 'active' })
    expect(sentCall(harness)).toMatchObject({
      functionName: 'addStake',
      args: [REGISTRY_LISTING_ID, 60_000n],
    })
    // FR-8: nothing here wrote `paused_by_stake`; `addStake` cleared it on chain
    // and the refresh brought it back.
    const row = harness.table.get(LISTING_ID)
    expect(row.pausedByStake).toBe(false)
    expect(row.status).toBe('active')
  })

  it('refuses a top-up the Creator wallet cannot fund', async () => {
    const harness = createHarness({ tusdBalance: 1_000n })
    const { run } = manage({ harness })

    const result = await run(stakeJob('200000'))

    expect(result).toMatchObject({ ok: false, outcome: 'refused', retryable: false })
    expect(result.ok === false && result.reason).toContain(REFUSAL.topUpBalance)
    expect(harness.signer.sentTransactions).toHaveLength(0)
    expect(harness.table.get(LISTING_ID).lastError).toContain(REFUSAL.topUpBalance)
  })

  it('refuses a top-up the chain already applied rather than charging twice', async () => {
    // `before.stake` is what the cache held at enqueue; a top-up that confirmed
    // in between makes the difference zero or negative.
    const { harness, run } = manage()

    const result = await run(stakeJob('100000', 1, { stake: '100000' }))

    expect(result).toMatchObject({ ok: false, outcome: 'refused' })
    expect(harness.signer.sentTransactions).toHaveLength(0)
  })

  it('asks to be redelivered when the balance read does not answer', async () => {
    const harness = createHarness()
    harness.reader.tokenBalance = async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:8545')
    }
    const { run } = manage({ harness })

    const result = await run(stakeJob('200000'))

    expect(result).toMatchObject({ ok: false, outcome: 'incomplete', retryable: true })
    // Nothing is terminal, so nothing is written on the row.
    expect(harness.table.get(LISTING_ID).lastError).toBeNull()
  })
})

// ------------------------------------------------------------------- pause

describe('listing.write pause:', () => {
  it('sends setPaused and moves the Listing to paused', async () => {
    const { harness, run } = manage({ onChain: { pausedByCreator: true } })
    harness.receipts.expect({})

    const result = await run(pauseJob(true))

    expect(result).toMatchObject({ ok: true, intent: 'pause', outcome: 'sent', status: 'paused' })
    expect(sentCall(harness)).toMatchObject({
      functionName: 'setPaused',
      args: [REGISTRY_LISTING_ID, true],
    })
    expect(harness.table.get(LISTING_ID).status).toBe('paused')
  })

  it('resumes a Listing the Creator paused', async () => {
    const { harness, run } = manage({
      row: { status: 'paused', pausedByCreator: true },
      onChain: { pausedByCreator: false },
    })
    harness.receipts.expect({})

    const result = await run(pauseJob(false, 2, { paused: true }))

    expect(result).toMatchObject({ ok: true, status: 'active' })
    expect(sentCall(harness)).toMatchObject({ args: [REGISTRY_LISTING_ID, false] })
  })
})

// -------------------------------------------------------- policy and chain

describe('listing.write policy', () => {
  it('refuses when the Creator wallet is below the gas floor', async () => {
    const harness = createHarness()
    harness.reader.balances.set(CREATOR_ADDRESS, parseEther('0.0001'))
    const { run } = manage({ harness })

    const result = await run(pauseJob(true))

    expect(result).toMatchObject({ ok: false, outcome: 'refused' })
    expect(result.ok === false && result.reason).toContain(REFUSAL.gasFloor)
    expect(harness.signer.sentTransactions).toHaveLength(0)
    expect(harness.table.get(LISTING_ID).lastError).toContain(REFUSAL.gasFloor)
  })

  it('writes the revert onto the row and changes no terms', async () => {
    const { harness, run } = manage()
    harness.receipts.expect({ status: 'reverted' })

    const result = await run(pauseJob(true))

    expect(result).toMatchObject({ ok: false, outcome: 'refused', retryable: false })
    expect(result.ok === false && result.reason).toContain('reverted on chain')
    expect(harness.chainTx.rows.get(intentKeys.pause(LISTING_ID, 1))?.status).toBe('reverted')
    // AD-2: a reverted receipt never refreshes the chain-owned columns.
    expect(harness.table.chainOwnedWrites).toHaveLength(0)
    expect(harness.table.get(LISTING_ID).status).toBe('active')
  })

  it('sends nothing on a redelivery of the same intent key (AD-8)', async () => {
    const { harness, run } = manage({ onChain: { price: 5_000n } })
    harness.receipts.expect({})

    const first = await run(priceJob('5000'))
    const second = await run(priceJob('5000'))

    expect(first).toMatchObject({ ok: true, outcome: 'sent' })
    expect(second).toMatchObject({ ok: true, outcome: 'reused' })
    expect(harness.signer.sentTransactions).toHaveLength(1)
    expect(harness.chainTx.inserts).toEqual([intentKeys.price(LISTING_ID, 1)])
  })

  it('leaves the row pending and asks for a retry when no receipt arrives', async () => {
    const { harness, run } = manage()
    // No queued receipt: the 60 s wait ran out.

    const result = await run(priceJob('5000'))

    expect(result).toMatchObject({ ok: false, outcome: 'incomplete', retryable: true })
    expect(harness.chainTx.rows.get(intentKeys.price(LISTING_ID, 1))?.status).toBe('pending')
    expect(harness.table.get(LISTING_ID).lastError).toBeNull()
  })
})

// ------------------------------------------------------------ preconditions

describe('listing.write preconditions', () => {
  it('refuses an intent key that names another Listing', async () => {
    const { harness, run } = manage()

    const result = await run({
      listing_id: LISTING_ID,
      intent_key: intentKeys.price('lst_SOMEONE_ELSE', 1),
      payload: { listing_id: LISTING_ID, before, after: { price: '5000' } },
    })

    expect(result).toMatchObject({ ok: false, outcome: 'refused' })
    expect(harness.signer.sentTransactions).toHaveLength(0)
    // Nothing is written either: the job never established which row to blame.
    expect(harness.table.get(LISTING_ID).lastError).toBeNull()
  })

  it('refuses a Listing with no Registry entry', async () => {
    const { harness, run } = manage({ row: { status: 'verifying', registryListingId: null } })

    const result = await run(pauseJob(true))

    expect(result).toMatchObject({ ok: false, outcome: 'refused' })
    expect(harness.table.get(LISTING_ID).lastError).toContain('no Registry entry')
    expect(harness.signer.sentTransactions).toHaveLength(0)
  })

  it('refuses while the Creator wallet is not ready (AD-5)', async () => {
    const { harness, run } = manage()
    harness.table.wallet = { id: 'wal_CREATOR', address: CREATOR_ADDRESS, readyAt: null }

    const result = await run(pauseJob(true))

    expect(result).toMatchObject({ ok: false, outcome: 'refused' })
    expect(harness.table.get(LISTING_ID).lastError).toContain('not ready')
  })
})

// ----------------------------------------------------------------- helpers

describe('listing.write helpers', () => {
  it('reads the three manage prefixes and nothing else', () => {
    expect(intentOf(intentKeys.price(LISTING_ID, 1))).toBe('price')
    expect(intentOf(intentKeys.stake(LISTING_ID, 1))).toBe('stake')
    expect(intentOf(intentKeys.pause(LISTING_ID, 1))).toBe('pause')
    expect(intentOf(`list:${LISTING_ID}`)).toBeNull()
    expect(intentOf('nonsense')).toBeNull()
  })

  it('is paused when either flag is set (AD-2)', () => {
    expect(listingStatusFor({ pausedByCreator: false, pausedByStake: false })).toBe('active')
    expect(listingStatusFor({ pausedByCreator: true, pausedByStake: false })).toBe('paused')
    expect(listingStatusFor({ pausedByCreator: false, pausedByStake: true })).toBe('paused')
    expect(listingStatusFor({ pausedByCreator: true, pausedByStake: true })).toBe('paused')
  })
})
