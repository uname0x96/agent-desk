import { createDb, startBoss } from '@agent-desk/db'
import { loadScriptsEnv } from './env.ts'
import { formatChecks } from './checks.ts'
import { parseSeedArgs, USAGE } from './seed/args.ts'
import { formatSeedSummary, runSeed, SeedRefused } from './seed/run.ts'
import { confirmReset, resetDatabase } from './seed/reset.ts'

/**
 * `pnpm seed` — Story 1.10.
 *
 * The CLI is deliberately thin: read the environment, honour `--reset`, and
 * turn a `SeedRefused` into an exit code. Everything the story is about is in
 * `./seed/run.ts`, which takes its database, its queue and its environment as
 * arguments so it can be driven without a process.
 */
async function main(): Promise<void> {
  const args = parseSeedArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(USAGE)
    return
  }
  if (args.unknown.length > 0) {
    process.stderr.write(`unknown argument(s): ${args.unknown.join(', ')}\n\n${USAGE}`)
    process.exit(2)
  }

  const env = loadScriptsEnv()
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
        process.exit(1)
      }
      await resetDatabase(db, log)
      log('')
    }

    const result = await runSeed({ db, boss, env, log })
    process.stdout.write(formatSeedSummary(result, env.EXPLORER_URL))
  } catch (error) {
    if (error instanceof SeedRefused) {
      process.stderr.write(`\n${error.message}\n`)
      if (error.checks.length > 0) process.stderr.write(`${formatChecks(error.checks)}\n`)
      process.exit(1)
    }
    throw error
  } finally {
    await boss.stop({ graceful: false }).catch(() => undefined)
  }
}

await main()
process.exit(0)
