import { describe, expect, it } from 'vitest'
import type { MeResponse } from '@agent-desk/schemas'
import { ApiError } from '../../lib/api.ts'
import {
  WALLET_POLL_INTERVAL_MS,
  isWalletReady,
  walletMeQueryOptions,
  walletRefetchInterval,
  walletStage,
} from './wallet-poll.ts'
import { formatBnb, formatBnbLabelled } from './format-bnb.ts'

/**
 * Story 3.1: the wallet poll and the two amounts the page prints. AD-12 fixes
 * the beat at 2 s and fixes when it stops; these are the assertions that keep a
 * later edit from turning `/settings` into a page that polls forever.
 */

function me(overrides: Partial<MeResponse> = {}): MeResponse {
  return {
    account_id: 'acc_01ARZ3NDEKTSV4RRFFQ69G5FAV',
    email: 'new@agentdesk.local',
    is_operator: false,
    wallet_address: null,
    wallet_ready_at: null,
    telegram_chat_id: null,
    daily_fee_budget: '1000000',
    budget_spent: '0',
    budget_remaining: '1000000',
    ...overrides,
  }
}

const ADDRESS = '0xd0ca46c403e54a76d95abcfb90f8e625176cecc0'

describe('walletStage', () => {
  it('is creating while the worker has not written the row', () => {
    expect(walletStage(me())).toBe('creating')
  })

  it('is provisioning once the address exists but nothing is approved', () => {
    expect(walletStage(me({ wallet_address: ADDRESS }))).toBe('provisioning')
  })

  it('is ready once ready_at is set', () => {
    expect(
      walletStage(me({ wallet_address: ADDRESS, wallet_ready_at: '2026-09-06T09:29:52.000' })),
    ).toBe('ready')
  })
})

describe('walletRefetchInterval (AD-12)', () => {
  it('polls every 2 s before the first answer', () => {
    expect(walletRefetchInterval(undefined)).toBe(2_000)
    expect(WALLET_POLL_INTERVAL_MS).toBe(2_000)
  })

  it('keeps polling while the wallet is being created', () => {
    expect(walletRefetchInterval(me())).toBe(WALLET_POLL_INTERVAL_MS)
  })

  it('keeps polling while the address exists but ready_at does not', () => {
    expect(walletRefetchInterval(me({ wallet_address: ADDRESS }))).toBe(WALLET_POLL_INTERVAL_MS)
  })

  it('stops the moment ready_at is set', () => {
    const ready = me({ wallet_address: ADDRESS, wallet_ready_at: '2026-09-06T09:29:52.000' })
    expect(isWalletReady(ready)).toBe(true)
    expect(walletRefetchInterval(ready)).toBe(false)
  })
})

describe('walletMeQueryOptions', () => {
  const options = walletMeQueryOptions()

  it('shares the header query key, so one refetch serves both', () => {
    expect(options.queryKey).toEqual(['me'])
  })

  it('stops polling when the session is gone rather than asking forever', () => {
    const error = new ApiError('unauthorized', 'sign in first', 401)
    const interval = options.refetchInterval({
      state: { error, data: undefined },
    } as never)
    expect(interval).toBe(false)
    expect(options.retry(1, error)).toBe(false)
  })

  it('keeps polling through an error that could still clear', () => {
    const error = new ApiError('network_error', 'could not reach /api/me', 0)
    const interval = options.refetchInterval({
      state: { error, data: undefined },
    } as never)
    expect(interval).toBe(WALLET_POLL_INTERVAL_MS)
  })
})

describe('formatBnb', () => {
  it('prints wei as BNB without a float', () => {
    expect(formatBnb('20000000000000000')).toBe('0.02')
    expect(formatBnb(10n ** 18n)).toBe('1')
    expect(formatBnb('0')).toBe('0')
  })

  it('truncates rather than rounds, so a balance never reads high', () => {
    expect(formatBnb('1999999999999999999')).toBe('1.999999')
    expect(formatBnb('999999999999')).toBe('0')
  })

  it('labels the unit', () => {
    expect(formatBnbLabelled('20000000000000000')).toBe('0.02 BNB')
  })

  it('refuses a negative amount', () => {
    expect(() => formatBnb(-1n)).toThrow()
  })
})
