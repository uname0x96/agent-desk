import { describe, expect, it } from 'vitest'
import { parseSeedArgs, USAGE } from './args.ts'

/**
 * `parseSeedArgs` is the whole CLI surface of `pnpm seed`, so it is tested
 * without a process, a database or an environment — which is also why
 * `scripts/src/seed.ts` holds nothing but the boot sequence.
 */
describe('parseSeedArgs', () => {
  it('defaults every flag to off', () => {
    expect(parseSeedArgs([])).toEqual({
      reset: false,
      yes: false,
      activateSpare: false,
      warm: false,
      help: false,
      unknown: [],
    })
  })

  it('reads --reset, --yes and -y', () => {
    expect(parseSeedArgs(['--reset', '--yes'])).toMatchObject({ reset: true, yes: true })
    expect(parseSeedArgs(['-y'])).toMatchObject({ yes: true })
  })

  it('reads --activate-spare (Story 2.10) and --warm (Story 4.6)', () => {
    expect(parseSeedArgs(['--activate-spare'])).toMatchObject({ activateSpare: true, warm: false })
    expect(parseSeedArgs(['--warm'])).toMatchObject({ warm: true, activateSpare: false })
  })

  it('accepts the two new flags together and with --reset', () => {
    expect(parseSeedArgs(['--reset', '--yes', '--activate-spare', '--warm'])).toMatchObject({
      reset: true,
      yes: true,
      activateSpare: true,
      warm: true,
      unknown: [],
    })
  })

  it('collects anything it does not know rather than guessing', () => {
    // A typo must not silently seed without the flag the operator meant.
    expect(parseSeedArgs(['--rest']).unknown).toEqual(['--rest'])
    expect(parseSeedArgs(['--warmup']).unknown).toEqual(['--warmup'])
    expect(parseSeedArgs(['--activate_spare']).unknown).toEqual(['--activate_spare'])
    expect(parseSeedArgs(['--warm', '--nope']).warm).toBe(true)
  })

  it('reads --help and -h', () => {
    expect(parseSeedArgs(['--help']).help).toBe(true)
    expect(parseSeedArgs(['-h']).help).toBe(true)
  })
})

describe('USAGE', () => {
  it('documents every flag the parser accepts', () => {
    for (const flag of ['--reset', '--yes', '--activate-spare', '--warm', '--help']) {
      expect(USAGE).toContain(flag)
    }
  })
})
