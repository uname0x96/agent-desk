import { createDb } from '@agent-desk/db'
import { failures, formatChecks } from './checks.ts'
import { collectChecks } from './doctor/collect.ts'
import { loadScriptsEnv } from './env.ts'

/**
 * `pnpm doctor` — Story 1.10.
 *
 * Prints pass or fail for every check in `./doctor/collect.ts` and exits
 * non-zero when any of them failed. Note that pnpm 11 has a built-in `doctor`
 * command that shadows this script: use `pnpm run doctor`.
 */
async function main(): Promise<void> {
  const env = loadScriptsEnv()
  const db = createDb({ url: env.DATABASE_URL, max: 2 })
  const checks = await collectChecks({ env, db })

  process.stdout.write(`${formatChecks(checks)}\n`)
  const failed = failures(checks)
  process.stdout.write(
    failed.length === 0
      ? `\n${checks.length} checks, all passed.\n`
      : `\n${failed.length} of ${checks.length} checks failed.\n`,
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

await main()
