import { defineConfig } from 'drizzle-kit'

/**
 * `pnpm --filter @agent-desk/db generate` writes SQL into ./drizzle; the compose
 * service `migrate` runs `drizzle-kit migrate` once against the same folder
 * before web and worker start (spine, Migrations & tests convention).
 */
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
})
