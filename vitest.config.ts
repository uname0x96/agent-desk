import { defineConfig } from 'vitest/config'

const ALL = ['packages/**/*.test.ts', 'apps/**/*.test.ts', 'scripts/**/*.test.ts']
const INTEGRATION = [
  'packages/**/*.integration.test.ts',
  'apps/**/*.integration.test.ts',
  'scripts/**/*.integration.test.ts',
]
const EXCLUDE = ['**/node_modules/**', '**/.next/**', '**/dist/**']

/**
 * Two projects, because the integration tests share one Postgres database and
 * one Anvil chain. Run in parallel they truncate each other's fixtures
 * mid-test, which shows up as hook timeouts and lost compare-and-set writes
 * that have nothing to do with the code under test. `fileParallelism: false`
 * makes the integration project deterministic; the unit project keeps the
 * parallelism, which is where almost all of the wall-clock time lives anyway.
 */
export default defineConfig({
  test: {
    environment: 'node',
    projects: [
      {
        test: {
          name: 'unit',
          include: ALL,
          exclude: [...EXCLUDE, ...INTEGRATION],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: INTEGRATION,
          exclude: EXCLUDE,
          environment: 'node',
          fileParallelism: false,
          hookTimeout: 60_000,
          testTimeout: 120_000,
        },
      },
    ],
  },
})
