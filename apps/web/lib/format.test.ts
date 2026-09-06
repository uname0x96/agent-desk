import { describe, expect, it } from 'vitest'
import { keccak256Hex } from './keccak.ts'
import {
  checksumAddress,
  formatAddress,
  formatDuration,
  formatRelativeTime,
  formatTimestamp,
  formatTxHash,
  formatUsdt,
  formatUsdtLabelled,
  truncateMiddle,
} from './format.ts'

describe('keccak256', () => {
  it('matches the published Keccak-256 vectors', () => {
    expect(keccak256Hex('')).toBe(
      'c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
    )
    expect(keccak256Hex('abc')).toBe(
      '4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45',
    )
  })

  it('hashes an input longer than one 136-byte block', () => {
    // Crosses two absorb blocks, which the single-block path would get wrong.
    expect(keccak256Hex('a'.repeat(200))).toHaveLength(64)
    expect(keccak256Hex('a'.repeat(200))).not.toBe(keccak256Hex('a'.repeat(199)))
  })
})

describe('checksumAddress', () => {
  // The four EIP-55 reference addresses.
  it.each([
    '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed',
    '0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359',
    '0xdbF03B407c01E7cD3CBea99509d93f8DDDC8C6FB',
    '0xD1220A0cf47c7B9Be7A2E6BA89F429762e7b9aDb',
  ])('checksums %s', (expected) => {
    expect(checksumAddress(expected.toLowerCase())).toBe(expected)
    expect(checksumAddress(expected.toUpperCase().replace('0X', '0x'))).toBe(expected)
    expect(checksumAddress(expected)).toBe(expected)
  })

  it('rejects anything that is not 20 bytes of hex', () => {
    expect(() => checksumAddress('0x1234')).toThrow()
  })

  it('renders a dash for a missing address and leaves garbage untouched', () => {
    expect(formatAddress(null)).toBe('—')
    expect(formatAddress(undefined)).toBe('—')
    expect(formatAddress('not-an-address')).toBe('not-an-address')
  })
})

describe('formatUsdt', () => {
  // AD-13: base-unit integer strings in, decimals out, never a float.
  it.each([
    ['0', '0'],
    ['1', '0.000001'],
    ['10000', '0.01'],
    ['1000000', '1'],
    ['45000', '0.045'],
    ['1234567890', '1234.56789'],
  ])('renders %s as %s', (base, decimal) => {
    expect(formatUsdt(base)).toBe(decimal)
  })

  it('labels the amount tUSD', () => {
    expect(formatUsdtLabelled('10000')).toBe('0.01 tUSD')
  })

  it('refuses a value that is not a base-unit integer string', () => {
    expect(() => formatUsdt('0.01')).toThrow()
  })
})

describe('formatTxHash', () => {
  it('normalises a hash to lower case', () => {
    const hash = `0x${'AB'.repeat(32)}`
    expect(formatTxHash(hash)).toBe(`0x${'ab'.repeat(32)}`)
  })

  it('says so when there is no hash yet', () => {
    expect(formatTxHash(null)).toBe('—')
  })
})

describe('truncateMiddle', () => {
  it('keeps the head and the tail', () => {
    expect(truncateMiddle('0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed')).toBe('0x5aAeb605…Ef1BeAed')
  })

  it('leaves a short value alone', () => {
    expect(truncateMiddle('0x1234')).toBe('0x1234')
  })
})

describe('timestamps', () => {
  const now = new Date('2026-09-05T02:00:30Z')

  it('reads an offset-less ISO timestamp as UTC', () => {
    expect(formatTimestamp('2026-09-05T02:00:07')).toBe('2026-09-05 02:00:07 UTC')
    expect(formatTimestamp('2026-09-05T02:00:07Z')).toBe('2026-09-05 02:00:07 UTC')
  })

  it.each([
    ['2026-09-05T02:00:28Z', 'just now'],
    ['2026-09-05T02:00:00Z', '30 seconds ago'],
    ['2026-09-05T01:58:30Z', '2 minutes ago'],
    ['2026-09-04T02:00:30Z', 'yesterday'],
    ['2026-09-05T02:01:30Z', 'in 1 minute'],
  ])('renders %s relative to now as %s', (iso, expected) => {
    expect(formatRelativeTime(iso, now)).toBe(expected)
  })

  it('renders a dash when there is no timestamp', () => {
    expect(formatRelativeTime(null, now)).toBe('—')
    expect(formatTimestamp(null)).toBe('—')
  })

  it('measures how long a Call took', () => {
    expect(formatDuration('2026-09-05T02:00:01Z', '2026-09-05T02:00:04Z')).toBe('3.0 s')
    expect(formatDuration('2026-09-05T02:00:01Z', '2026-09-05T02:00:01.412Z')).toBe('412 ms')
    expect(formatDuration('2026-09-05T02:00:01Z', null)).toBe('—')
  })
})
