import { describe, expect, it } from 'vitest'
import { intentKeys } from '@agent-desk/schemas'
import {
  deriveSteps,
  isListingSettled,
  type ChainTxView,
  type ListingStepView,
  type ProgressSource,
  type VerificationCallView,
} from './listing-progress.ts'

/**
 * FR-12 / AD-12: what the Creator sees while their Listing goes on chain.
 *
 * The narration is the feature. A Creator who pasted a URL thirty seconds ago
 * should be able to say which of the three steps is happening, which one
 * refused, and why — so these tests assert the state and the sentence of each
 * step, not that an array has three entries.
 */

const LISTING_ID = 'lst_01JZZZZZZZZZZZZZZZZZZZZZZZ'
const HASH_A = `0x${'a1'.repeat(32)}`
const HASH_B = `0x${'b2'.repeat(32)}`
const HASH_PAYMENT = `0x${'c3'.repeat(32)}`

function source(overrides: Partial<ProgressSource> = {}): ProgressSource {
  return {
    listingId: LISTING_ID,
    status: 'verifying',
    lastError: null,
    skipVerification: false,
    declaredStake: '300000',
    agentId: null,
    registryListingId: null,
    verification: null,
    chainTx: [],
    ...overrides,
  }
}

function call(overrides: Partial<VerificationCallView> = {}): VerificationCallView {
  return {
    id: 'call_01JZZZZZZZZZZZZZZZZZZZZZZZ',
    status: 'pending',
    node_type: 'research',
    locked_price: '30000',
    locked_pay_to: '0xf6e3a69beb0f05ced82c99c4dc4989bef8fa82c4',
    attempt: 1,
    failure_reason: null,
    payment_tx_hash: null,
    started_at: null,
    ended_at: null,
    ...overrides,
  }
}

function chainRow(intentKey: string, overrides: Partial<ChainTxView> = {}): ChainTxView {
  return {
    intent_key: intentKey,
    status: 'confirmed',
    tx_hash: HASH_A,
    payload: { listing_id: LISTING_ID },
    created_at: '2026-09-06T10:00:00.000',
    confirmed_at: '2026-09-06T10:00:02.000',
    ...overrides,
  }
}

function byStep(steps: ListingStepView[], step: string): ListingStepView {
  const found = steps.find((candidate) => candidate.step === step)
  if (!found) throw new Error(`no ${step} step`)
  return found
}

describe('a Listing that has just been submitted', () => {
  it('shows all three steps, in the order the pipeline runs them', () => {
    expect(deriveSteps(source()).map((step) => step.step)).toEqual([
      'verification',
      'identity',
      'list',
    ])
  })

  it('says the verification Call is coming rather than showing nothing', () => {
    const steps = deriveSteps(source())

    expect(byStep(steps, 'verification')).toEqual({
      step: 'verification',
      state: 'running',
      detail: 'queued: the platform is about to call your endpoint and pay for the answer',
      tx_hash: null,
    })
  })

  it('tells the Creator up front what the Stake will cost them', () => {
    const steps = deriveSteps(source())

    expect(byStep(steps, 'list')).toMatchObject({
      state: 'waiting',
      detail: 'the Registry entry locks 0.3 tUSD of Stake',
    })
  })
})

describe('the verification Call while it is happening', () => {
  it('names the unpaid half of the Handshake', () => {
    const steps = deriveSteps(source({ verification: call({ status: 'pending' }) }))

    expect(byStep(steps, 'verification')).toMatchObject({
      state: 'running',
      detail: 'asking your endpoint what it charges',
    })
  })

  it('names the paid half, and shows nothing on chain until it settles', () => {
    const steps = deriveSteps(source({ verification: call({ status: 'paid_awaiting_result' }) }))

    expect(byStep(steps, 'verification')).toMatchObject({
      state: 'running',
      detail: 'paid, waiting for the answer',
      tx_hash: null,
    })
  })
})

describe('a Listing that reached the chain', () => {
  const listed = source({
    status: 'active',
    agentId: '7',
    registryListingId: '3',
    verification: call({
      status: 'succeeded',
      payment_tx_hash: HASH_PAYMENT,
      ended_at: '2026-09-06T10:00:01.000',
    }),
    chainTx: [
      chainRow(intentKeys.identity(LISTING_ID), { tx_hash: HASH_A }),
      chainRow(intentKeys.list(LISTING_ID), { tx_hash: HASH_B }),
    ],
  })

  it('shows the payment that proved the endpoint works', () => {
    expect(byStep(deriveSteps(listed), 'verification')).toEqual({
      step: 'verification',
      state: 'done',
      detail:
        'paid 0.03 tUSD to your payout wallet and the answer matched the research output schema',
      tx_hash: HASH_PAYMENT,
    })
  })

  it('shows the identity and the Registry entry with their transactions', () => {
    const steps = deriveSteps(listed)

    expect(byStep(steps, 'identity')).toMatchObject({
      state: 'done',
      detail: 'identity #7 minted around this Listing’s agentURI',
      tx_hash: HASH_A,
    })
    expect(byStep(steps, 'list')).toMatchObject({
      state: 'done',
      detail: 'listed as Registry entry #3, with 0.3 tUSD of Stake locked',
      tx_hash: HASH_B,
    })
  })
})

describe('a Listing the pipeline refused', () => {
  it('shows the price mismatch verbatim and never claims the identity was tried', () => {
    const reason = '402 amount 0.03 tUSD differs from declared 0.3 tUSD'
    const steps = deriveSteps(
      source({
        status: 'failed',
        lastError: reason,
        verification: call({ status: 'price_mismatch', failure_reason: reason }),
      }),
    )

    expect(byStep(steps, 'verification')).toMatchObject({ state: 'failed', detail: reason })
    // FR-11: no identity was minted and no Stake moved, so neither step is
    // allowed to look like it is still coming.
    expect(byStep(steps, 'identity')).toEqual({
      step: 'identity',
      state: 'waiting',
      detail: 'not reached',
      tx_hash: null,
    })
    expect(byStep(steps, 'list')).toMatchObject({ state: 'waiting', detail: 'not reached' })
  })

  it('shows a refusal that happened before any Call was made', () => {
    // The exhausted 24 h verification cap: the pipeline writes `last_error` and
    // never inserts a `calls` row, because it never touched the endpoint.
    const reason = 'verification cap reached, try again tomorrow'
    const steps = deriveSteps(source({ status: 'failed', lastError: reason, verification: null }))

    expect(byStep(steps, 'verification')).toEqual({
      step: 'verification',
      state: 'failed',
      detail: reason,
      tx_hash: null,
    })
  })

  it('blames the chain step that reverted, not the Call that was paid', () => {
    const reason = 'the identity transaction reverted'
    const steps = deriveSteps(
      source({
        status: 'failed',
        lastError: reason,
        verification: call({ status: 'succeeded', payment_tx_hash: HASH_PAYMENT }),
        chainTx: [chainRow(intentKeys.identity(LISTING_ID), { status: 'reverted' })],
      }),
    )

    expect(byStep(steps, 'verification')).toMatchObject({ state: 'done' })
    expect(byStep(steps, 'identity')).toMatchObject({ state: 'failed', detail: reason })
    expect(byStep(steps, 'list')).toMatchObject({ state: 'waiting', detail: 'not reached' })
  })
})

describe('an execution Agent', () => {
  it('says why no Call was made instead of leaving the step blank', () => {
    const steps = deriveSteps(source({ skipVerification: true }))

    expect(byStep(steps, 'verification')).toEqual({
      step: 'verification',
      state: 'skipped',
      detail:
        'skipped: a sample Call to an execution Agent would place a real order, so the platform does not make one',
      tx_hash: null,
    })
  })
})

describe('when the page stops polling (AD-12)', () => {
  it('polls while the pipeline can still move and stops once it cannot', () => {
    expect(isListingSettled('verifying')).toBe(false)
    expect(isListingSettled('active')).toBe(true)
    expect(isListingSettled('failed')).toBe(true)
    expect(isListingSettled('paused')).toBe(true)
  })
})
