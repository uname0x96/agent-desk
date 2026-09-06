import type { AgentType } from '@agent-desk/schemas'

/**
 * What `pnpm seed` needs to list this agent under the Platform Account
 * (Story 2.6, last acceptance criterion). It is a plain data module with no
 * side effects, so importing it never starts the server that `src/index.ts`
 * starts.
 *
 * The seed lists it through its own `skip_verification` path and waits for
 * `status = 'active'`; Story 3.4 replaces that with a real verification Call.
 * Neither belongs to this agent, so neither appears here.
 */
export interface SeedListing {
  /** The marketplace name, verbatim (PRD addendum §2). */
  name: string
  type: AgentType
  /** Decimal USDT (AD-13), the same string compose passes as `AGENT_PRICE`. */
  price: string
  /** The compose service's published port. */
  port: number
  /** The env var the seed reads the endpoint from. */
  endpointEnv: string
  /** Used when `endpointEnv` is unset; the compose service name and port. */
  defaultEndpoint: string
}

export const seedListing = {
  name: 'Telegram Notifier',
  type: 'notify',
  price: '0.005',
  port: 4106,
  endpointEnv: 'TELEGRAM_NOTIFIER_URL',
  defaultEndpoint: 'http://agent-telegram-notifier:4106',
} as const satisfies SeedListing
