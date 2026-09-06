import { createDb, startBoss } from '@agent-desk/db'
import { loadScriptsEnv } from './env.ts'
import { formatChecks } from './checks.ts'
import { parseSeedArgs, USAGE } from './seed/args.ts'
import { loadSeedEnv } from './seed/env.ts'
import { SeedRefused } from './seed/refusal.ts'
import { formatSeedSummary, runSeed } from './seed/run.ts'
import { confirmReset, resetDatabase } from './seed/reset.ts'
import { formatWarmSummary, runWarmUp } from './seed/warm.ts'

/**
 * `pnpm seed` — Story 1.10, with Story 2.10's `--activate-spare` and Story 4.6's
 * `--warm`.
 *
 * The CLI is deliberately thin: read the environment, honour the flags, and turn
 * a `SeedRefused` into an exit code. Everything the stories are about is in
 * `./seed/run.ts` and `./seed/warm.ts`, which take their database, their queue
 * and their environment as arguments so they can be driven without a process.
 *
 * `--warm` seeds first and warms afterwards. The warm-up needs the good chain,
 * demo mode and a funded Builder, which is exactly what the seed leaves behind,
 * and the seed is idempotent, so running it again costs a few queries and no
 * transactions.
 */
async function main(): Promise<number> {
  const args = parseSeedArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return 0
  }
  if (args.unknown.length > 0) {
    process.stderr.write(`unknown argument(s): ${args.unknown.join(', ')}\n\n${USAGE}`)
    return 2
  }

  const env = loadScriptsEnv()
  const seedEnv = loadSeedEnv()
  const log = (line: string) => process.stdout.write(`${line}\n`)
  const db = createDb({ url: env.DATABASE_URL })
  const boss = await startBoss(env.DATABASE_URL)

  try {
    if (args.reset) {
      const confirmed = args.yes || (await confirmReset(env.DATABASE_URL))
      if (!confirmed) {
        process.stderr.write(
          process.stdin.isTTY
            ? 'not confirmed; nothing was truncated.\n'
            : 'refusing --reset without a terminal to confirm on; pass --yes if you mean it.\n',
        )
        return 1
      }
      await resetDatabase(db, log)
      log('')
    }

    const result = await runSeed({
      db,
      boss,
      env,
      seedEnv,
      log,
      activateSpare: args.activateSpare,
    })
    process.stdout.write(formatSeedSummary(result, env.EXPLORER_URL))

    if (!args.warm) return 0

    const warm = await runWarmUp({
      db,
      env: seedEnv,
      explorerUrl: env.EXPLORER_URL,
      builder: result.pair.builder,
      log,
    })
    process.stdout.write(formatWarmSummary(warm, env.EXPLORER_URL))
    // Story 4.6: exit 0 *only* when the warm-up reached its exit condition.
    return warm.verdict.ok ? 0 : 1
  } catch (error) {
    if (error instanceof SeedRefused) {
      process.stderr.write(`\n${error.message}\n`)
      if (error.checks.length > 0) process.stderr.write(`${formatChecks(error.checks)}\n`)
      return 1
    }
    throw error
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined)
  }
}

process.exit(await main())
