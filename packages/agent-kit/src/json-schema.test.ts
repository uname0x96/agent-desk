import { describe, expect, it } from 'vitest'
import { typeSchemas } from '@agent-desk/schemas'
import { JSON_SCHEMA_DIALECT, toJsonSchema, toRootJsonSchema } from './json-schema.ts'

describe('toJsonSchema', () => {
  it('projects the data input', () => {
    expect(toJsonSchema(typeSchemas.data.input)).toEqual({
      type: 'object',
      properties: { symbol: { type: 'string', pattern: '^[A-Z0-9]{5,20}$' } },
      required: ['symbol'],
    })
  })

  it('projects numbers, bounds and the ISO timestamp of the data output', () => {
    const schema = toJsonSchema(typeSchemas.data.output) as Record<string, never>
    const properties = schema.properties as unknown as Record<string, Record<string, unknown>>
    expect(schema.required).toEqual([
      'symbol',
      'price',
      'change_24h_pct',
      'volatility_24h_pct',
      'ts',
    ])
    expect(properties.change_24h_pct).toEqual({ type: 'number' })
    expect(properties.volatility_24h_pct).toEqual({ type: 'number', minimum: 0 })
    expect(properties.ts?.type).toBe('string')
    expect(properties.ts?.format).toBe('date-time')
  })

  it('projects enums, string lengths and inclusive number bounds', () => {
    const schema = toJsonSchema(typeSchemas.research.output) as Record<string, never>
    const properties = schema.properties as unknown as Record<string, Record<string, unknown>>
    expect(properties.signal).toEqual({ type: 'string', enum: ['LONG', 'SHORT', 'HOLD'] })
    expect(properties.confidence).toEqual({ type: 'number', minimum: 0, maximum: 1 })
    expect(properties.reason).toEqual({ type: 'string', minLength: 1, maxLength: 500 })
  })

  it('projects literals, arrays, nullables and optionals of the notify input', () => {
    const schema = toJsonSchema(typeSchemas.notify.input) as Record<string, never>
    const properties = schema.properties as unknown as Record<string, Record<string, never>>
    expect(schema.required).toEqual([
      'run_id',
      'recipient',
      'summary',
      'cost_table',
      'tx_hashes',
    ])
    expect(properties.run_id).toEqual({
      anyOf: [{ type: 'string' }, { type: 'null' }],
    })
    expect(properties.recipient?.properties).toMatchObject({ channel: { const: 'telegram' } })
    expect(properties.tx_hashes?.type).toBe('array')
    const entry = properties.cost_table?.items as unknown as Record<string, unknown>
    expect(entry.required).toEqual(['node', 'provider', 'amount'])
  })

  it('projects booleans on the notify output', () => {
    const schema = toJsonSchema(typeSchemas.notify.output) as Record<string, never>
    const properties = schema.properties as unknown as Record<string, unknown>
    expect(properties.delivered).toEqual({ type: 'boolean' })
  })

  it('declares the dialect at the root and degrades to {} on anything unknown', () => {
    expect(toRootJsonSchema(typeSchemas.data.input).$schema).toBe(JSON_SCHEMA_DIALECT)
    expect(toJsonSchema(undefined)).toEqual({})
    expect(toJsonSchema({ def: { type: 'promise' } })).toEqual({})
  })
})
