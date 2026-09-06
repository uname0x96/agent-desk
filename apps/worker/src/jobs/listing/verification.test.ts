import { describe, expect, it } from 'vitest'
import { createContractCalls } from '@agent-desk/adapters/chain'
import { createListingVerifyJob } from '@agent-desk/core/listing'
import { samples, toDecimalUsdt } from '@agent-desk/schemas'
import { createListingReceiptSource } from './receipts.ts'
import { createVerificationCall, VERIFICATION_CAP_REACHED } from './verification.ts'
import {
  FakeAgent,
  FakeAuthorizations,
  FakeCallTable,
  FakeSigning,
  PAYOUT_WALLET,
  PLATFORM_WALLET_ID,
  PRICE,
  RESEARCH_OUTPUT,
  SETTLEMENT_TX,
  X402,
  conforming402,
  listingRow,
  settled200,
} from './verification-harness.ts'
import { createHarness, seedRegistryEntry, type Harness } from './test-harness.ts'

/**
 * Story 3.4 / FR-11 / FR-12: the paid verification Call.
 *
 * The claims under test are the ones a Creator and an auditor care about:
 *
 *   - a Call is inserted with `kind = 'verification'`, `run_id = null` and the
 *     declared terms, and it is paid by the Platform Wallet;
 *   - every way an endpoint can be wrong produces the sentence FR-12 promises,
 *     the Call ends terminal, and nothing is minted and no Stake moves;
 *   - a verification Call is **never scored and never reserves Stake** — it is
 *     `kind = 'verification'` at the signing boundary, which is where both of
 *     those rules are decided (AD-3, AD-9);
 *   - the exhausted cap is refused before the endpoint is touched at all.
 *
 * `verification-harness.ts` fakes only the `calls` table, the socket and the
 * wallet lock; the comparison, the retry rule and the wording are real.
 */

const NOW = new Date('2026-09-06T10:00:00Z')
const clock = { now: () => NOW }

interface Built {
  table: FakeCallTable
  agent: FakeAgent
  signing: FakeSigning
  authorizations: FakeAuthorizations
  verification: ReturnType<typeof createVerificationCall>
}

function build(): Built {
  const table = new FakeCallTable()
  const agent = new FakeAgent()
  const signing = new FakeSigning(table)
  const authorizations = new FakeAuthorizations()
  const verification = createVerificationCall({
    store: table,
    signing,
    chain: authorizations,
    agent,
    x402: X402,
    clock,
  })
  return { table, agent, signing, authorizations, verification }
}

describe('the verification Call is a real paid Call from the Platform Wallet', () => {
  it('opens the Call with the declared terms, pays, validates, and succeeds', async () => {
    const { table, agent, signing, verification } = build()
    agent.expectUnpaid(conforming402()).expectPaid(settled200())
    const listing = listingRow()

    const outcome = await verification.run(listing)

    expect(outcome).toEqual({ ok: true, callId: table.only().id })

    // AD-3: a verification Call belongs to a Listing, not to a Run, and the
    // terms on the row are the declared ones — nothing is read back later.
    expect(table.inserted).toHaveLength(1)
    expect(table.inserted[0]).toMatchObject({
      listingId: listing.id,
      nodeType: 'research',
      lockedPrice: PRICE,
      lockedPayTo: PAYOUT_WALLET,
      lockedAsset: X402.asset,
      lockedNetwork: X402.network,
      request: samples.research,
      startedAt: NOW,
    })

    // AD-5 / FR-11: the Platform Wallet signs, as `kind = 'verification'`.
    expect(signing.requests).toHaveLength(1)
    const [walletId, requirements] = signing.requests[0]!
    expect(walletId).toBe(PLATFORM_WALLET_ID)
    expect(requirements.amount).toBe(PRICE)
    expect(requirements.call).toEqual({
      callId: table.only().id,
      kind: 'verification',
      accountId: null,
      listingId: listing.id,
      nodeType: 'research',
    })

    const row = table.only()
    expect(row.status).toBe('succeeded')
    expect(row.paymentTxHash).toBe(SETTLEMENT_TX)
    expect(agent.unpaid).toEqual([{ endpoint: listing.endpoint, input: samples.research }])
    expect(agent.paid).toHaveLength(1)
  })

  it('is never scored and never reserves Stake', async () => {
    const { table, agent, signing, verification } = build()
    agent.expectUnpaid(conforming402()).expectPaid(settled200())

    await verification.run(listingRow())

    // Both rules are decided at the signing boundary from these two fields:
    // AD-3's Stake reservation counts `kind = 'run'` Calls only, and AD-9
    // settles `kind = 'run'` `research` and `risk` Calls only. The Call this
    // job signs is `verification` with no account, so neither query can ever
    // see it — which is what stops a brand-new Listing being slashed for its
    // own verification.
    const [, requirements] = signing.requests[0]!
    expect(requirements.call.kind).toBe('verification')
    expect(requirements.call.accountId).toBeNull()
    expect(table.inserted[0]).not.toHaveProperty('runId')
    expect(table.only().status).toBe('succeeded')
  })

  it('sends the notify sample with the Platform chat id and a null run_id', async () => {
    const table = new FakeCallTable()
    const agent = new FakeAgent()
    agent
      .expectUnpaid(conforming402())
      .expectPaid(settled200({ delivered: true, channel: 'telegram', message_ref: '4521' }))
    const verification = createVerificationCall({
      store: table,
      signing: new FakeSigning(table),
      chain: new FakeAuthorizations(),
      agent,
      x402: X402,
      platformChatId: '987654321',
      clock,
    })

    const outcome = await verification.run(listingRow({ type: 'notify' }))

    expect(outcome.ok).toBe(true)
    expect(agent.unpaid[0]?.input).toEqual({
      ...samples.notify,
      run_id: null,
      recipient: { channel: 'telegram', address: '987654321' },
    })
  })
})

describe('every refusal names the one thing to change', () => {
  it('answers "endpoint answered <status> instead of 402"', async () => {
    const { table, agent, signing, verification } = build()
    agent.expectUnpaid({ kind: 'unexpected', status: 500, detail: 'boom' })

    const outcome = await verification.run(listingRow())

    expect(outcome).toEqual({ ok: false, reason: 'endpoint answered 500 instead of 402' })
    expect(table.only().status).toBe('payment_failed')
    // Nothing was signed, so nothing was paid.
    expect(signing.requests).toEqual([])
  })

  it('answers "no response within 15 s" for an unpaid timeout', async () => {
    const { table, agent, verification } = build()
    agent.expectUnpaid({ kind: 'timeout' })

    const outcome = await verification.run(listingRow())

    expect(outcome).toEqual({ ok: false, reason: 'no response within 15 s' })
    expect(table.only().status).toBe('payment_failed')
  })

  it('answers "402 amount <a> differs from declared <b>" and pays nothing', async () => {
    const { table, agent, signing, verification } = build()
    agent.expectUnpaid(conforming402({ amount: '50000' }))

    const outcome = await verification.run(listingRow())

    expect(outcome).toEqual({
      ok: false,
      reason: `402 amount ${toDecimalUsdt('50000')} tUSD differs from declared ${toDecimalUsdt(PRICE)} tUSD`,
    })
    expect(table.only().status).toBe('price_mismatch')
    expect(signing.requests).toEqual([])
  })

  it('answers "402 payTo <x> differs from declared payout wallet <y>"', async () => {
    const other = '0x00000000000000000000000000000000000000c9'
    const { table, agent, verification } = build()
    agent.expectUnpaid(conforming402({ payTo: other }))

    const outcome = await verification.run(listingRow())

    expect(outcome).toEqual({
      ok: false,
      reason: `402 payTo ${other} differs from declared payout wallet ${PAYOUT_WALLET}`,
    })
    expect(table.only().status).toBe('price_mismatch')
  })

  it('answers "402 asset or network differs from the platform binding"', async () => {
    for (const wrong of [{ network: 'eip155:56' }, { asset: `0x${'9'.repeat(40)}` }]) {
      const { table, agent, verification } = build()
      agent.expectUnpaid(conforming402(wrong))

      const outcome = await verification.run(listingRow())

      expect(outcome).toEqual({
        ok: false,
        reason: '402 asset or network differs from the platform binding',
      })
      expect(table.only().status).toBe('price_mismatch')
    }
  })

  it('refuses a 402 with no EIP-712 domain the same way', async () => {
    const { agent, verification } = build()
    agent.expectUnpaid(conforming402({ extra: undefined }))

    const outcome = await verification.run(listingRow())

    expect(outcome).toEqual({
      ok: false,
      reason: '402 asset or network differs from the platform binding',
    })
  })

  it('answers "response failed the <type> output schema at <path>"', async () => {
    const { table, agent, verification } = build()
    agent
      .expectUnpaid(conforming402())
      .expectPaid(settled200({ ...RESEARCH_OUTPUT, confidence: 4 }))

    const outcome = await verification.run(listingRow())

    expect(outcome).toEqual({
      ok: false,
      reason: 'response failed the research output schema at confidence',
    })
    // FR-27: the payment landed, so the hash stays on the row and the status
    // says so. The Listing is refused all the same.
    const row = table.only()
    expect(row.status).toBe('failed_after_payment')
    expect(row.paymentTxHash).toBe(SETTLEMENT_TX)
  })

  it('refuses a signing policy refusal without touching the endpoint again', async () => {
    const { table, agent, signing, verification } = build()
    agent.expectUnpaid(conforming402())
    signing.refusal = {
      code: 'refused_budget',
      check: 'verification_cap',
      message: "refused: budget. The Platform Wallet's 24 h verification cap is exhausted by 1 tUSD.",
      details: { cap: '5', spent: '5' },
    }

    const outcome = await verification.run(listingRow())

    expect(outcome).toMatchObject({ ok: false, reason: signing.refusal.message })
    expect(table.only().status).toBe('payment_failed')
    expect(agent.paid).toEqual([])
  })
})

describe('the AD-6 paid attempts', () => {
  it('resends the same header once after a timeout and no more', async () => {
    const { table, agent, verification } = build()
    agent
      .expectUnpaid(conforming402())
      .expectPaid({ kind: 'timeout' }, settled200())

    const outcome = await verification.run(listingRow())

    expect(outcome.ok).toBe(true)
    expect(agent.paid).toHaveLength(2)
    expect(agent.paid[0]?.header).toBe(agent.paid[1]?.header)
    expect(table.only().attempt).toBe(2)
  })

  it('reads the token when both attempts end without a PAYMENT-RESPONSE', async () => {
    const { table, agent, authorizations, verification } = build()
    agent.expectUnpaid(conforming402()).expectPaid({ kind: 'timeout' }, { kind: 'timeout' })

    const outcome = await verification.run(listingRow())

    expect(outcome).toEqual({ ok: false, reason: 'no response within 15 s' })
    expect(authorizations.reads).toBe(1)
    // The authorization is unused, so no payment was made.
    expect(table.only().status).toBe('payment_failed')
  })

  it('records failed_after_payment when the authorization was used', async () => {
    const { table, agent, authorizations, verification } = build()
    authorizations.used = true
    agent.expectUnpaid(conforming402()).expectPaid({ kind: 'timeout' }, { kind: 'timeout' })

    await verification.run(listingRow())

    expect(table.only().status).toBe('failed_after_payment')
    expect(table.only().paymentTxHash).toBeNull()
  })

  it('does not claim a payment when the RPC will not answer', async () => {
    const { table, agent, authorizations, verification } = build()
    authorizations.throws = true
    agent.expectUnpaid(conforming402()).expectPaid({ kind: 'timeout' }, { kind: 'timeout' })

    await verification.run(listingRow())

    expect(table.only().status).toBe('payment_failed')
  })
})

describe('the Platform Wallet verification cap', () => {
  it('refuses before the endpoint is touched and before a Call is opened', async () => {
    const { table, agent, signing, verification } = build()
    table.spent = 5_000_000n
    table.cap = 5_000_000n

    const outcome = await verification.run(listingRow())

    expect(outcome).toEqual({ ok: false, reason: VERIFICATION_CAP_REACHED })
    expect(table.capReads).toBe(1)
    expect(table.rows.size).toBe(0)
    expect(agent.unpaid).toEqual([])
    expect(signing.requests).toEqual([])
  })

  it('lets a price that exactly fills the remaining cap through', async () => {
    const { table, agent, verification } = build()
    table.spent = 5_000_000n - BigInt(PRICE)
    agent.expectUnpaid(conforming402()).expectPaid(settled200())

    const outcome = await verification.run(listingRow())

    expect(outcome.ok).toBe(true)
  })
})

describe('redelivery pays exactly once', () => {
  it('reuses a Call that already succeeded', async () => {
    const { table, agent, signing, verification } = build()
    agent.expectUnpaid(conforming402()).expectPaid(settled200())
    const listing = listingRow()

    const first = await verification.run(listing)
    const again = await verification.run(listing)

    expect(again).toEqual(first)
    expect(table.rows.size).toBe(1)
    expect(agent.paid).toHaveLength(1)
    expect(signing.requests).toHaveLength(1)
  })

  it('gives back the stored reason for a Call that already failed', async () => {
    const { table, agent, verification } = build()
    agent.expectUnpaid({ kind: 'unexpected', status: 404, detail: 'no route' })
    const listing = listingRow()

    await verification.run(listing)
    const again = await verification.run(listing)

    expect(again).toEqual({ ok: false, reason: 'endpoint answered 404 instead of 402' })
    expect(table.rows.size).toBe(1)
    expect(agent.unpaid).toHaveLength(1)
  })

  it('resends the stored header for a Call left in paid_awaiting_result', async () => {
    const { table, agent, signing, verification } = build()
    // The first delivery signed, sent twice, and both attempts timed out; the
    // row is `paid_awaiting_result` with its authorization on it.
    agent.expectUnpaid(conforming402()).expectPaid({ kind: 'timeout' }, { kind: 'timeout' })
    const listing = listingRow()
    await verification.run(listing)

    // Put it back the way a crash between the signature and the result leaves it.
    const callId = table.only().id
    await table.update(callId, { status: 'paid_awaiting_result', attempt: 1 })
    agent.expectPaid(settled200())

    const outcome = await verification.run(listing)

    expect(outcome).toEqual({ ok: true, callId })
    // AD-5 / FR-25: one signature per Call, ever.
    expect(signing.requests).toHaveLength(1)
    expect(agent.unpaid).toHaveLength(1)
    expect(agent.paid.at(-1)?.header).toBe(agent.paid[0]?.header)
  })
})

describe('the pipeline still refuses to touch the chain when verification fails', () => {
  function pipeline(harness: Harness, verification: ReturnType<typeof createVerificationCall>) {
    return createListingVerifyJob({
      listings: harness.table.pipelineStore(),
      chain: harness.engine.chain,
      calls: createContractCalls(harness.engine.addresses),
      receipts: createListingReceiptSource(harness.receipts, harness.engine.addresses),
      reader: harness.reader,
      verification,
      config: { publicBaseUrl: 'https://agentdesk.example' },
    })
  }

  it('mints no identity and moves no Stake when the endpoint is wrong', async () => {
    const harness = createHarness()
    const { agent, verification } = build()
    agent.expectUnpaid({ kind: 'unexpected', status: 500, detail: 'boom' })
    const run = pipeline(harness, verification)
    const listing = harness.table.seed({ id: 'lst_BAD', skipVerification: false })

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({
      ok: false,
      failedAt: 'verification',
      reason: 'endpoint answered 500 instead of 402',
    })
    expect(harness.table.get(listing.id)).toMatchObject({
      status: 'failed',
      lastError: 'endpoint answered 500 instead of 402',
    })
    expect(harness.chainTx.inserts).toEqual([])
    expect(harness.signer.sentTransactions).toEqual([])
  })

  it('runs identity and list after a verification Call that was really paid', async () => {
    const harness = createHarness()
    const { table, agent, verification } = build()
    agent.expectUnpaid(conforming402()).expectPaid(settled200())
    const run = pipeline(harness, verification)
    const listing = harness.table.seed({
      id: 'lst_LIVE',
      type: 'research',
      skipVerification: false,
      payoutWallet: PAYOUT_WALLET,
    })
    harness.receipts.expect(
      { registered: { agentId: 7n, agentURI: `https://agentdesk.example/api/listings/${listing.id}/agent.json`, owner: harness.table.wallet!.address } },
      {
        listed: {
          listingId: 1n,
          creator: harness.table.wallet!.address,
          agentId: 7n,
          agentType: listing.type,
          price: BigInt(listing.declaredPrice),
          endpoint: listing.endpoint,
          payTo: listing.payoutWallet,
          stake: BigInt(listing.declaredStake),
        },
      },
    )
    seedRegistryEntry(harness.reader, '1', { agentType: 'research' })

    const result = await run({ listing_id: listing.id })

    expect(result).toMatchObject({ ok: true, status: 'active', steps: { verification: 'sent' } })
    expect(table.only().status).toBe('succeeded')
    // FR-12: the Call is paid before the first chain write, never beside it.
    expect(harness.chainTx.inserts).toEqual([`identity:${listing.id}`, `list:${listing.id}`])
  })
})
