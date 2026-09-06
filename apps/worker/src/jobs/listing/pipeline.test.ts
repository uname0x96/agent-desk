import { describe, expect, it } from 'vitest'
import { decodeFunctionData } from 'viem'
import { createContractCalls, registryAbi } from '@agent-desk/adapters/chain'
import {
  VERIFICATION_NOT_IMPLEMENTED,
  buildAgentCard,
  createListingVerifyJob,
  createUnimplementedVerificationCall,
  decodeDataUri,
  type ListingPipelineRow,
  type ListingVerifyResult,
  type VerificationCall,
} from '@agent-desk/core/listing'
import type { Hex } from '@agent-desk/core/ports'
import { createListingReceiptSource } from './receipts.ts'
import {
  CREATOR_ADDRESS,
  PAYOUT_WALLET,
  TEST_ADDRESSES,
  createHarness,
  seedRegistryEntry,
  type FakeListingRow,
  type Harness,
} from './test-harness.ts'

/**
 * AD-2 / FR-5..FR-7, FR-12: the listing pipeline.
 *
 * The order of the three steps is the property under test. Everything below is
 * a way that order could be broken — a verification that fails, a Stake the
 * Registry would refuse, a crash between two steps, a second delivery of the
 * same job — and the assertion in every case is about what did or did not reach
 * the chain.
 *
 * `chainWrite` is real (see `test-harness.ts`); the RPC underneath it is not.
 * So these prove the pipeline, not the contracts: whether
 * `AgentDeskRegistry.list` accepts this calldata on BSC testnet is unproven
 * until the contracts are deployed and funded.
 */

const AGENT_ID = 7n
const REGISTRY_LISTING_ID = 1n
const PUBLIC_BASE_URL = 'https://agentdesk.example'

interface PipelineOptions {
  harness?: Harness
  publicBaseUrl?: string | undefined
  verification?: VerificationCall
}

function pipeline(options: PipelineOptions = {}) {
  const harness = options.harness ?? createHarness()
  const run = createListingVerifyJob({
    listings: harness.table.pipelineStore(),
    // Exactly what `registerListingJobs` hands over in the worker.
    chain: harness.engine.chain,
    calls: createContractCalls(harness.engine.addresses),
    receipts: createListingReceiptSource(harness.receipts, harness.engine.addresses),
    reader: harness.reader,
    verification: options.verification ?? createUnimplementedVerificationCall(),
    config: { publicBaseUrl: options.publicBaseUrl },
  })
  return { harness, run }
}

/** The receipts of a pipeline that goes all the way through. */
function expectHappyReceipts(harness: Harness, listing: FakeListingRow, agentUri: string): void {
  harness.receipts.expect(
    { registered: { agentId: AGENT_ID, agentURI: agentUri, owner: CREATOR_ADDRESS } },
    {
      listed: {
        listingId: REGISTRY_LISTING_ID,
        creator: CREATOR_ADDRESS,
        agentId: AGENT_ID,
        agentType: listing.type,
        price: BigInt(listing.declaredPrice),
        endpoint: listing.endpoint,
        payTo: listing.payoutWallet,
        stake: BigInt(listing.declaredStake),
      },
    },
  )
  seedRegistryEntry(harness.reader, REGISTRY_LISTING_ID.toString())
}

const hostedUri = (listingId: string) => `${PUBLIC_BASE_URL}/api/listings/${listingId}/agent.json`

describe('listing.verify: the seed listing reaches the chain', () => {
  it('runs identity then list, decodes the agentId, and ends active', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_TICKER' })
    expectHappyReceipts(harness, listing, hostedUri(listing.id))

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({
      ok: true,
      outcome: 'listed',
      status: 'active',
      agentId: AGENT_ID.toString(),
      registryListingId: REGISTRY_LISTING_ID.toString(),
      agentUri: hostedUri(listing.id),
      steps: { verification: 'skipped', identity: 'sent', list: 'sent' },
    })

    // AD-8: two intents, in this order, and no third.
    expect(harness.chainTx.inserts).toEqual([`identity:${listing.id}`, `list:${listing.id}`])
    expect(harness.signer.sentTransactions).toHaveLength(2)

    // AD-2: the chain-owned columns came from `refreshListingFromChain`, and
    // `active` is the last thing written.
    expect(harness.table.chainOwnedWrites).toHaveLength(1)
    expect(harness.table.get(listing.id)).toMatchObject({
      status: 'active',
      lastError: null,
      price: '10000',
      stake: '100000',
      agentId: AGENT_ID.toString(),
      registryListingId: REGISTRY_LISTING_ID.toString(),
    })
  })

  it('builds list(agentId, type, price, endpoint, payTo, stake) from the Registered event', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_ARGS' })
    expectHappyReceipts(harness, listing, hostedUri(listing.id))

    await run({ listing_id: listing.id })

    const [, listTx] = harness.signer.sentTransactions
    expect(listTx?.to).toBe(TEST_ADDRESSES.registry)
    const decoded = decodeFunctionData({ abi: registryAbi, data: listTx?.data ?? '0x' })
    expect(decoded.functionName).toBe('list')
    // FR-6 field order, with the agentId the identity receipt minted.
    expect(decoded.args).toEqual([
      AGENT_ID,
      'data',
      10_000n,
      listing.endpoint,
      PAYOUT_WALLET,
      100_000n,
    ])
  })

  it('signs both transactions with the Creator wallet', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_SIGNER' })
    expectHappyReceipts(harness, listing, hostedUri(listing.id))

    await run({ listing_id: listing.id })

    for (const tx of harness.signer.sentTransactions) {
      expect(tx.encryptedKey).toBe(`enc:${CREATOR_ADDRESS}`)
    }
  })
})

describe('listing.verify: nothing is minted before verification resolves', () => {
  it('refuses a listing without skip_verification and touches no chain', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_UNVERIFIED', skipVerification: false })

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({ ok: false, outcome: 'failed', failedAt: 'verification' })
    expect(harness.table.get(listing.id)).toMatchObject({
      status: 'failed',
      lastError: VERIFICATION_NOT_IMPLEMENTED,
    })
    // The whole point: no identity, no stake, no transaction of any kind.
    expect(harness.chainTx.inserts).toEqual([])
    expect(harness.signer.sentTransactions).toEqual([])
  })

  it('mints no identity when the verification Call fails', async () => {
    const reason = 'endpoint answered 500 instead of 402'
    const { harness, run } = pipeline({
      publicBaseUrl: PUBLIC_BASE_URL,
      verification: { run: async () => ({ ok: false, reason }) },
    })
    const listing = harness.table.seed({ id: 'lst_BAD_ENDPOINT', skipVerification: false })

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({ ok: false, failedAt: 'verification', reason })
    expect(harness.table.get(listing.id)).toMatchObject({ status: 'failed', lastError: reason })
    expect(harness.chainTx.inserts).toEqual([])
  })

  it('runs the verification Call before the first chain write, not beside it', async () => {
    const harness = createHarness()
    const seen: string[][] = []
    const verification: VerificationCall = {
      run: async (listing: ListingPipelineRow) => {
        // Whatever has reached the chain by the time verification runs.
        seen.push([...harness.chainTx.inserts])
        expect(listing.id).toBe('lst_ORDER')
        return { ok: true, callId: 'call_VERIFY' }
      },
    }
    const { run } = pipeline({ harness, publicBaseUrl: PUBLIC_BASE_URL, verification })
    const listing = harness.table.seed({ id: 'lst_ORDER', skipVerification: false })
    expectHappyReceipts(harness, listing, hostedUri(listing.id))

    const result = await run({ listing_id: listing.id })

    expect(seen).toEqual([[]])
    expect(result).toMatchObject({ ok: true, steps: { verification: 'sent' } })
    expect(harness.chainTx.inserts).toEqual([`identity:${listing.id}`, `list:${listing.id}`])
  })

  it('refuses a Stake below ten times the price before any identity is minted', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_THIN', declaredPrice: '10000', declaredStake: '90000' })

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({ ok: false, outcome: 'failed', failedAt: 'list' })
    expect(harness.table.get(listing.id).lastError).toContain('ten times')
    expect(harness.chainTx.inserts).toEqual([])
  })

  it('refuses a Stake the Creator cannot pay before any identity is minted', async () => {
    const harness = createHarness({ tusdBalance: 99_999n })
    const { run } = pipeline({ harness, publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_POOR' })

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({ ok: false, outcome: 'failed', failedAt: 'list' })
    expect(harness.table.get(listing.id).lastError).toBe(
      'insufficient tUSD for the Stake: the Creator wallet holds 0.099999 tUSD and the Stake is 0.1 tUSD.',
    )
    expect(harness.chainTx.inserts).toEqual([])
  })

  it('refuses before anything is signed when the Creator wallet is not ready', async () => {
    const harness = createHarness()
    harness.table.wallet = { id: 'wal_CREATOR', address: CREATOR_ADDRESS, readyAt: null }
    const { run } = pipeline({ harness, publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_NOT_READY' })

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({ ok: false, failedAt: 'verification' })
    expect(harness.table.get(listing.id).lastError).toContain('not ready')
    expect(harness.chainTx.inserts).toEqual([])
  })
})

describe('listing.verify: the agentURI is decided once', () => {
  it('uses PUBLIC_BASE_URL and writes the decision onto the identity intent', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_HOSTED' })
    expectHappyReceipts(harness, listing, hostedUri(listing.id))

    await run({ listing_id: listing.id })

    const row = await harness.chainTx.find(`identity:${listing.id}`)
    expect(row?.payload).toEqual({ listing_id: listing.id, agent_uri: hostedUri(listing.id) })
  })

  it('falls back to a data: URI carrying the same card', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: undefined })
    const listing = harness.table.seed({ id: 'lst_DATA' })
    const expected = `data:application/json;base64,${Buffer.from(
      JSON.stringify(buildAgentCard({ ...listing, agentId: null, registryListingId: null }, null)),
    ).toString('base64')}`
    expectHappyReceipts(harness, listing, expected)

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({ ok: true, agentUri: expected })
    expect(decodeDataUri(expected)).toEqual({
      name: listing.name,
      description: listing.description,
      type: 'data',
      endpoint: listing.endpoint,
      agent_id: null,
      registry_listing_id: null,
      payout_wallet: PAYOUT_WALLET,
      schema_url: '/schema',
    })
  })

  it('keeps the first URI when a later run is configured with a different host', async () => {
    const harness = createHarness()
    const listing = harness.table.seed({ id: 'lst_REHOST' })

    // Run 1: the transaction is sent, but its receipt does not arrive inside the
    // wait, so the `chain_tx` row stays `pending` with its hash (AD-8).
    const first = pipeline({ harness, publicBaseUrl: PUBLIC_BASE_URL })
    const incomplete = await first.run({ listing_id: listing.id })
    expect(incomplete).toMatchObject({ ok: false, outcome: 'incomplete', failedAt: 'identity' })
    expect(harness.table.get(listing.id).status).toBe('verifying')

    const identity = await harness.chainTx.find(`identity:${listing.id}`)
    expect(identity?.status).toBe('pending')
    const txHash = identity?.txHash as Hex
    harness.receipts.settleLate(txHash, {
      registered: { agentId: AGENT_ID, agentURI: hostedUri(listing.id), owner: CREATOR_ADDRESS },
    })
    harness.receipts.expect({
      listed: {
        listingId: REGISTRY_LISTING_ID,
        creator: CREATOR_ADDRESS,
        agentId: AGENT_ID,
        agentType: listing.type,
        price: BigInt(listing.declaredPrice),
        endpoint: listing.endpoint,
        payTo: listing.payoutWallet,
        stake: BigInt(listing.declaredStake),
      },
    })
    seedRegistryEntry(harness.reader, REGISTRY_LISTING_ID.toString())

    // Run 2 is configured with a different host. `buildTx` is never called for an
    // intent key that already has a row, so the URI cannot change underneath the
    // identity that was already minted.
    const second = pipeline({ harness, publicBaseUrl: 'https://moved.example' })
    const result = await second.run({ listing_id: listing.id })

    expect(result).toMatchObject({ ok: true, outcome: 'listed', agentUri: hostedUri(listing.id) })
    const row = await harness.chainTx.find(`identity:${listing.id}`)
    expect(row?.payload).toEqual({ listing_id: listing.id, agent_uri: hostedUri(listing.id) })
    expect(harness.signer.sentTransactions).toHaveLength(2)
  })
})

describe('listing.verify: a list revert fails the listing', () => {
  it('writes last_error naming the revert and the two conditions it checks', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_REVERT' })
    harness.receipts.expect(
      { registered: { agentId: AGENT_ID, agentURI: hostedUri(listing.id), owner: CREATOR_ADDRESS } },
      { status: 'reverted' },
    )

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({ ok: false, outcome: 'failed', failedAt: 'list', retryable: false })
    const row = harness.table.get(listing.id)
    expect(row.status).toBe('failed')
    expect(row.lastError).toContain(`list:${listing.id} reverted on chain`)
    expect(row.lastError).toContain('ten times the price')
    expect(row.lastError).toContain('price 0.01 tUSD, Stake 0.1 tUSD')
    // The identity was minted first, which the story allows; the Registry entry
    // was not, so no Stake moved.
    expect(row.registryListingId).toBeNull()
    expect(harness.table.chainOwnedWrites).toEqual([])
  })

  it('fails the listing when the identity transaction itself reverts', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_ID_REVERT' })
    harness.receipts.expect({ status: 'reverted' })

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({ ok: false, failedAt: 'identity' })
    expect(harness.table.get(listing.id).status).toBe('failed')
    expect(harness.chainTx.inserts).toEqual([`identity:${listing.id}`])
  })
})

describe('listing.verify: redelivery is safe at every point', () => {
  it('sends nothing the second time a completed job is delivered', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: PUBLIC_BASE_URL })
    const listing = harness.table.seed({ id: 'lst_TWICE' })
    expectHappyReceipts(harness, listing, hostedUri(listing.id))

    const first = await run({ listing_id: listing.id })
    const second = await run({ listing_id: listing.id })

    expect(first).toMatchObject({ ok: true, outcome: 'listed' })
    expect(second).toMatchObject({
      ok: true,
      outcome: 'already_listed',
      status: 'active',
      agentId: AGENT_ID.toString(),
    })
    expect(harness.signer.sentTransactions).toHaveLength(2)
    expect(harness.chainTx.inserts).toEqual([`identity:${listing.id}`, `list:${listing.id}`])
  })

  it('resumes from a crash between identity and list without minting twice', async () => {
    const harness = createHarness()
    const listing = harness.table.seed({ id: 'lst_RESUME' })

    // Run 1: the identity confirms, the list receipt never arrives.
    harness.receipts.expect({
      registered: { agentId: AGENT_ID, agentURI: hostedUri(listing.id), owner: CREATOR_ADDRESS },
    })
    const first = pipeline({ harness, publicBaseUrl: PUBLIC_BASE_URL })
    const incomplete: ListingVerifyResult = await first.run({ listing_id: listing.id })
    expect(incomplete).toMatchObject({ ok: false, outcome: 'incomplete', failedAt: 'list' })
    expect(harness.table.get(listing.id).status).toBe('verifying')

    // The node had the receipt a moment later.
    const listRow = await harness.chainTx.find(`list:${listing.id}`)
    harness.receipts.settleLate(listRow?.txHash as Hex, {
      listed: {
        listingId: REGISTRY_LISTING_ID,
        creator: CREATOR_ADDRESS,
        agentId: AGENT_ID,
        agentType: listing.type,
        price: BigInt(listing.declaredPrice),
        endpoint: listing.endpoint,
        payTo: listing.payoutWallet,
        stake: BigInt(listing.declaredStake),
      },
    })
    seedRegistryEntry(harness.reader, REGISTRY_LISTING_ID.toString())

    // Run 2 resumes: the agentId comes back out of the identity receipt, because
    // the confirmed row hands back no receipt of its own.
    const second = pipeline({ harness, publicBaseUrl: PUBLIC_BASE_URL })
    const result = await second.run({ listing_id: listing.id })

    expect(result).toMatchObject({
      ok: true,
      outcome: 'listed',
      agentId: AGENT_ID.toString(),
      registryListingId: REGISTRY_LISTING_ID.toString(),
      steps: { identity: 'reused', list: 'reused' },
    })
    expect(harness.signer.sentTransactions).toHaveLength(2)
    expect(harness.table.get(listing.id).status).toBe('active')
  })

  it('reports a missing listing without writing anything', async () => {
    const { harness, run } = pipeline({ publicBaseUrl: PUBLIC_BASE_URL })

    const result = await run({ listing_id: 'lst_GONE' })

    expect(result).toMatchObject({ ok: false, failedAt: 'verification', retryable: false })
    expect(harness.table.statusWrites).toEqual([])
  })
})
