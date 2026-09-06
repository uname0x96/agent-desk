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
  help: boolean
  unknown: string[]
}

export function parseSeedArgs(argv: readonly string[]): SeedArgs {
  const args: SeedArgs = { reset: false, yes: false, help: false, unknown: [] }
  for (const arg of argv) {
    if (arg === '--reset') args.reset = true
    else if (arg === '--yes' || arg === '-y') args.yes = true
    else if (arg === '--help' || arg === '-h') args.help = true
    else args.unknown.push(arg)
  }
  return args
}

export const USAGE = `Usage: pnpm seed [--reset] [--yes]

  --reset   Truncate every table, including chain_tx, before seeding.
            Asks for the word "${RESET_CONFIRMATION}" unless --yes is given.
  --yes     Answer the reset confirmation without asking.
  --help    This text.
`
