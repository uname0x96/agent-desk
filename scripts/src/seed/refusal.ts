import type { Check } from '../checks.ts'

/**
 * A refusal the Operator has to act on. The CLI prints it and exits 1.
 *
 * It lives in a module of its own because every step of the seed throws it and
 * `run.ts` is no longer the only one of them: `wallets.ts`, `demo.ts` and
 * `warm.ts` all refuse, and importing them from `run.ts` for the class alone
 * would be an import cycle.
 */
export class SeedRefused extends Error {
  readonly checks: readonly Check[]
  constructor(reason: string, checks: readonly Check[] = []) {
    super(reason)
    this.name = 'SeedRefused'
    this.checks = checks
  }
}
