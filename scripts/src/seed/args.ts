import { RESET_CONFIRMATION } from './reset.ts'

/**
 * Argument parsing, kept out of `scripts/src/seed.ts` so a test can import it
 * without importing the boot sequence — the same reason
 * `apps/worker/src/jobs/listing/wiring.ts` is split from its registration.
 */

export interface SeedArgs {
  reset: boolean
  /** Skips the interactive confirmation. For CI and for a non-TTY shell. */
  yes: boolean
  /**
   * Story 2.10: swap the failover pair of addendum §5 into the demo Workflows.
   * The seed still runs in full; this only changes which pair it points at.
   */
  activateSpare: boolean
  /** Story 4.6: after seeding, run the three good-chain Runs and score them. */
  warm: boolean
  help: boolean
  unknown: string[]
}

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const args: SeedArgs = {
    reset: false,
    yes: false,
    activateSpare: false,
    warm: false,
    help: false,
    unknown: [],
  }
  for (const arg of argv) {
    if (arg === '--reset') args.reset = true
    else if (arg === '--yes' || arg === '-y') args.yes = true
    else if (arg === '--activate-spare') args.activateSpare = true
    else if (arg === '--warm') args.warm = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else args.unknown.push(arg)
  }
  return args
}

export const USAGE = `Usage: pnpm seed [--reset] [--yes] [--activate-spare] [--warm]

  --reset            Truncate every table, including chain_tx, before seeding.
                     Asks for the word "${RESET_CONFIRMATION}" unless --yes is given.
  --yes              Answer the reset confirmation without asking.
  --activate-spare   Point the demo Workflows and .env.seed at the spare
                     Builder and Creator pair (PRD addendum §5 failover).
  --warm             After seeding, run the good chain three times and wait for
                     every research and risk Settlement. Exits non-zero unless
                     Alpha Research reads 100 % over 3 scored Calls and every
                     Guardrail Risk Call is passed or not_scored (no_fill).
  --help             This text.
`
