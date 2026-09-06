import js from '@eslint/js'
import tseslint from 'typescript-eslint'

/**
 * AD-1: dependency direction is inward only. These rules are the enforcement;
 * a deliberate violation must fail `pnpm lint`.
 */
const deny = (patterns) => ({
  'no-restricted-imports': ['error', { patterns }],
})

const AGENT_ALLOWED = [
  {
    group: ['@agent-desk/core*', '@agent-desk/db*', '@agent-desk/adapters*'],
    message:
      'AD-1: apps/agents/* may import only @agent-desk/schemas, @agent-desk/agent-kit and their own vendor SDK.',
  },
]

const SIGNER_ONLY_IN_WORKER = [
  {
    group: ['@agent-desk/adapters/signer', '@agent-desk/adapters/signer/*'],
    message: 'AD-1: the signer is wired only in apps/worker and scripts.',
  },
]

const NO_APPS = [
  {
    group: ['**/apps/*', '@agent-desk/web*', '@agent-desk/worker*'],
    message: 'AD-1: nothing imports from an apps/* directory.',
  },
]

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/.next/**', '**/dist/**', 'contracts/**', '_bmad/**', '_bmad-output/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      ...deny(NO_APPS),
    },
  },
  {
    files: ['apps/agents/**/*.ts'],
    rules: deny([...AGENT_ALLOWED, ...SIGNER_ONLY_IN_WORKER, ...NO_APPS]),
  },
  {
    files: ['packages/agent-kit/**/*.ts'],
    rules: deny([...AGENT_ALLOWED, ...SIGNER_ONLY_IN_WORKER, ...NO_APPS]),
  },
  {
    files: ['packages/core/**/*.ts'],
    rules: deny([
      {
        group: ['@agent-desk/db*', '@agent-desk/adapters*', '@agent-desk/agent-kit*', 'viem', 'viem/*', 'drizzle-orm', 'drizzle-orm/*'],
        message: 'AD-1: packages/core imports only @agent-desk/schemas. Vendor SDKs live behind a port in adapters.',
      },
      ...NO_APPS,
    ]),
  },
  {
    files: ['packages/db/**/*.ts'],
    rules: deny([
      {
        group: ['@agent-desk/adapters*', '@agent-desk/agent-kit*'],
        message: 'AD-1: packages/db imports @agent-desk/schemas and core types only.',
      },
      ...NO_APPS,
    ]),
  },
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    rules: deny([...SIGNER_ONLY_IN_WORKER, ...NO_APPS]),
  },
  {
    files: ['packages/schemas/**/*.ts'],
    rules: deny([
      {
        group: ['@agent-desk/*'],
        message: 'AD-1: packages/schemas imports nothing from the monorepo.',
      },
    ]),
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-unused-vars': 'off' },
  },
)
