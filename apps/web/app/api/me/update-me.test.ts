import { describe, expect, it } from 'vitest'
import { patchMeRequest, toBaseUnits } from '@agent-desk/schemas'
import { isEmptyPatch, parseMePatch } from './update-me.ts'

/**
 * Story 3.2, `PATCH /api/me`. The shapes belong to `patchMeRequest` in
 * `packages/schemas`, so they are asserted through it here rather than
 * duplicated: what a route answers 400 for has to be what the schema refuses,
 * or the two definitions drift.
 */

describe('patchMeRequest (AD-14)', () => {
  it('accepts a decimal budget, a chat id, both, and neither', () => {
    expect(patchMeRequest.safeParse({ daily_fee_budget: '2.5' }).success).toBe(true)
    expect(patchMeRequest.safeParse({ telegram_chat_id: '123456789' }).success).toBe(true)
    expect(
      patchMeRequest.safeParse({ daily_fee_budget: '2.5', telegram_chat_id: '1' }).success,
    ).toBe(true)
    expect(patchMeRequest.safeParse({}).success).toBe(true)
  })

  it('accepts null for either field, which is how a setting is cleared', () => {
    expect(patchMeRequest.safeParse({ daily_fee_budget: null }).success).toBe(true)
    expect(patchMeRequest.safeParse({ telegram_chat_id: null }).success).toBe(true)
  })

  it('refuses a budget that is not a decimal amount', () => {
    for (const value of ['', '-1', '1.', 'abc', '1e3', ' 1']) {
      expect(patchMeRequest.safeParse({ daily_fee_budget: value }).success).toBe(false)
    }
  })

  it('refuses a chat id that is not digits', () => {
    for (const value of ['', 'abc', '12 34', '1.5', '12a']) {
      expect(patchMeRequest.safeParse({ telegram_chat_id: value }).success).toBe(false)
    }
  })

  it('accepts the negative chat id Telegram gives a group', () => {
    expect(patchMeRequest.safeParse({ telegram_chat_id: '-1001234567890' }).success).toBe(true)
  })
})

describe('parseMePatch', () => {
  it('stores the budget in base units (AD-13)', () => {
    const parsed = parseMePatch({ daily_fee_budget: '2.5' })
    expect(parsed).toEqual({ ok: true, patch: { dailyFeeBudget: toBaseUnits('2.5').toString() } })
  })

  it('keeps a whole number exact', () => {
    const parsed = parseMePatch({ daily_fee_budget: '1000' })
    expect(parsed).toMatchObject({ ok: true, patch: { dailyFeeBudget: '1000000000' } })
  })

  it('allows a zero budget, which stops this Account paying anything today', () => {
    expect(parseMePatch({ daily_fee_budget: '0' })).toMatchObject({
      ok: true,
      patch: { dailyFeeBudget: '0' },
    })
  })

  it('refuses more decimal places than tUSD has', () => {
    const parsed = parseMePatch({ daily_fee_budget: '0.0000001' })
    expect(parsed.ok).toBe(false)
  })

  it('carries a null budget through, so the platform default applies again', () => {
    expect(parseMePatch({ daily_fee_budget: null })).toEqual({
      ok: true,
      patch: { dailyFeeBudget: null },
    })
  })

  it('carries the chat id and a null that unlinks it', () => {
    expect(parseMePatch({ telegram_chat_id: '123' })).toEqual({
      ok: true,
      patch: { telegramChatId: '123' },
    })
    expect(parseMePatch({ telegram_chat_id: null })).toEqual({
      ok: true,
      patch: { telegramChatId: null },
    })
  })

  it('writes only the fields the body carried', () => {
    const parsed = parseMePatch({ telegram_chat_id: '123' })
    expect(parsed.ok && Object.hasOwn(parsed.patch, 'dailyFeeBudget')).toBe(false)
  })

  it('an empty body is an empty patch, so the route writes nothing', () => {
    const parsed = parseMePatch({})
    expect(parsed.ok && isEmptyPatch(parsed.patch)).toBe(true)
  })

  it('a null field is not an empty patch', () => {
    const parsed = parseMePatch({ daily_fee_budget: null })
    expect(parsed.ok && isEmptyPatch(parsed.patch)).toBe(false)
  })
})
