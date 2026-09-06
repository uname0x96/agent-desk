import { describe, expect, it } from 'vitest'
import { toBaseUnits, toDecimalUsdt, sumBaseUnits, asDecimalUsdt } from './units.ts'
import { validateOutput, validateInput } from './validate-output.ts'
import { samples, sampleOutputs } from './samples.ts'
import { typeSchemas, AGENT_TYPES } from './types/index.ts'
import { intentKeys, listingIdOfIntent, intentPrefixOf } from './intents.ts'
import { newId, isId } from './ids.ts'
import { buildX402Config } from './x402.ts'
import { ERROR_CODES, ERROR_STATUS, apiError } from './api/errors.ts'

describe('units (AD-13)', () => {
  it('converts decimal USDT to base units', () => {
    expect(toBaseUnits('0.01')).toBe(10000n)
    expect(toBaseUnits('0.05')).toBe(50000n)
    expect(toBaseUnits('0.005')).toBe(5000n)
    expect(toBaseUnits('1')).toBe(1000000n)
    expect(toBaseUnits('1000')).toBe(1000000000n)
    expect(toBaseUnits('0')).toBe(0n)
  })

  it('converts base units back to decimal USDT', () => {
    expect(toDecimalUsdt(10000n)).toBe('0.01')
    expect(toDecimalUsdt('10000')).toBe('0.01')
    expect(toDecimalUsdt(1000000n)).toBe('1')
    expect(toDecimalUsdt(0n)).toBe('0')
    expect(toDecimalUsdt(95000n)).toBe('0.095')
  })

  it('round-trips the full seed price table', () => {
    for (const price of ['0.01', '0.05', '0.03', '0.02', '0.005']) {
      expect(toDecimalUsdt(toBaseUnits(price))).toBe(price)
    }
  })

  it('refuses more precision than tUSD carries', () => {
    expect(() => asDecimalUsdt('0.0000001')).toThrow()
    expect(() => toBaseUnits('not a number')).toThrow()
    expect(() => toBaseUnits('-1')).toThrow()
  })

  it('sums base units without floats', () => {
    // the full good chain: 0.01 + 0.05 + 0.02 + 0.01 + 0.005 = 0.095
    const total = sumBaseUnits(['10000', '50000', '20000', '10000', '5000'])
    expect(toDecimalUsdt(total)).toBe('0.095')
    // the sloppy chain: 0.01 + 0.03 + 0.02 + 0.01 + 0.005 = 0.075
    expect(toDecimalUsdt(sumBaseUnits(['10000', '30000', '20000', '10000', '5000']))).toBe('0.075')
  })
})

describe('Type schemas (FR-15, addendum section 1)', () => {
  it('accepts every sample input and sample output', () => {
    for (const type of AGENT_TYPES) {
      expect(validateInput(type, samples[type]).ok, `${type} input`).toBe(true)
      expect(validateOutput(type, samples[type], sampleOutputs[type]).ok, `${type} output`).toBe(true)
    }
  })

  it('ignores unknown fields in a response', () => {
    const result = validateOutput('data', samples.data, {
      ...sampleOutputs.data,
      an_unknown_field: 'ignored',
    })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value).not.toHaveProperty('an_unknown_field')
  })

  it('fails a response missing a required field', () => {
    const { price: _price, ...withoutPrice } = sampleOutputs.data
    const result = validateOutput('data', samples.data, withoutPrice)
    expect(result.ok).toBe(false)
  })

  it('rejects a research confidence outside [0, 1] and an empty reason', () => {
    expect(validateOutput('research', samples.research, { signal: 'LONG', confidence: 1.4, reason: 'x' }).ok).toBe(false)
    expect(validateOutput('research', samples.research, { signal: 'LONG', confidence: 0.5, reason: '' }).ok).toBe(false)
    expect(
      validateOutput('research', samples.research, {
        signal: 'LONG',
        confidence: 0.5,
        reason: 'x'.repeat(501),
      }).ok,
    ).toBe(false)
  })

  it('rejects a risk size above proposed_size_usdt or balance_usdt', () => {
    const input = { ...samples.risk, proposed_size_usdt: '100', balance_usdt: '80' }
    expect(validateOutput('risk', input, { decision: 'APPROVE', size_usdt: '100.5', reason: 'r' }).ok).toBe(false)
    expect(validateOutput('risk', input, { decision: 'APPROVE', size_usdt: '90', reason: 'r' }).ok).toBe(false)
    expect(validateOutput('risk', input, { decision: 'APPROVE', size_usdt: '80', reason: 'r' }).ok).toBe(true)
  })

  it('requires size_usdt "0" on a REJECT decision', () => {
    expect(validateOutput('risk', samples.risk, { decision: 'REJECT', size_usdt: '10', reason: 'r' }).ok).toBe(false)
    expect(validateOutput('risk', samples.risk, { decision: 'REJECT', size_usdt: '0', reason: 'r' }).ok).toBe(true)
  })

  it('requires the fill fields on FILLED and a reason on REJECTED', () => {
    const ts = '2026-09-05T02:00:07Z'
    expect(validateOutput('execution', samples.execution, { status: 'FILLED', ts }).ok).toBe(false)
    expect(validateOutput('execution', samples.execution, { status: 'REJECTED', ts }).ok).toBe(false)
    expect(
      validateOutput('execution', samples.execution, { status: 'REJECTED', reason: 'emergency stop', ts }).ok,
    ).toBe(true)
  })

  it('allows a notify cost table entry without a tx hash', () => {
    const input = {
      ...samples.notify,
      cost_table: [{ node: 'research', provider: 'Alpha Research', amount: '0.05' }],
    }
    expect(typeSchemas.notify.input.safeParse(input).success).toBe(true)
  })
})

describe('intent keys (AD-8)', () => {
  it('builds every shape the spine fixes', () => {
    expect(intentKeys.gas('wal_1')).toBe('gas:wal_1')
    expect(intentKeys.slash('call_1')).toBe('slash:call_1')
    expect(intentKeys.reputation('lst_1', 'stl_1')).toBe('reputation:lst_1:stl_1')
    expect(intentKeys.price('lst_1', 42)).toBe('price:lst_1:42')
  })

  it('names the listing an intent refreshes', () => {
    expect(listingIdOfIntent('list:lst_1')).toBe('lst_1')
    expect(listingIdOfIntent('price:lst_1:42')).toBe('lst_1')
    expect(listingIdOfIntent('gas:wal_1')).toBeNull()
    expect(intentPrefixOf('identity-uri:lst_1:42')).toBe('identity-uri')
  })
})

describe('ids (AD-13)', () => {
  it('mints prefixed ULIDs that are recognisable', () => {
    const id = newId('call')
    expect(id.startsWith('call_')).toBe(true)
    expect(isId('call', id)).toBe(true)
    expect(isId('run', id)).toBe(false)
  })

  it('sorts by time', () => {
    const early = newId('run', 1_000_000)
    const late = newId('run', 2_000_000)
    expect(early < late).toBe(true)
  })
})

describe('x402 config (AD-6)', () => {
  it('always carries an explicit asset and extra', () => {
    const config = buildX402Config({ facilitatorUrl: 'http://facilitator:4020' })
    expect(config.network).toBe('eip155:97')
    expect(config.extra).toEqual({ name: 'tUSD', version: '1' })
    expect(config.maxTimeoutSeconds).toBe(15)
    expect(config.asset).toMatch(/^0x[0-9a-f]{40}$/)
  })
})

describe('error envelope (AD-14)', () => {
  it('gives every code a status', () => {
    for (const code of ERROR_CODES) expect(ERROR_STATUS[code]).toBeGreaterThan(0)
  })

  it('builds the fixed envelope shape', () => {
    expect(apiError('refused_budget', 'over budget', { shortfall: '1000' })).toEqual({
      error: { code: 'refused_budget', message: 'over budget', details: { shortfall: '1000' } },
    })
  })
})
