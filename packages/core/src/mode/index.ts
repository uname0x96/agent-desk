import { toBaseUnits, type PlatformMode } from '@agent-desk/schemas'
import type { KlineInterval } from '../ports/index.ts'

/**
 * AD-10: "the per-mode values of PRD addendum §6 are a constant table in
 * `packages/core` keyed by `mode`". This file is that table and nothing else —
 * no reads, no clock, no database — so the worker loop, the settlement job, and
 * the API all resolve the same number from the same row.
 *
 * Every field below is transcribed from the addendum §6 table:
 *
 * | Setting                       | Production default | Demo mode              |
 * |-------------------------------|--------------------|------------------------|
 * | Settlement Window             | 60 minutes         | 20 seconds             |
 * | Settlement poll interval      | 60 seconds         | 2 seconds              |
 * | Research Settlement rule      | window price move  | 24h trend              |
 * | Kline granularity for drawdown| 1 minute           | 1 second               |
 * | Daily Fee Budget default      | 1 USDT             | 100 USDT               |
 * | Run timeout                   | 120 seconds        | 120 seconds            |
 * | Emergency Stop                | off                | off                    |
 *
 * Emergency Stop is not here: §6 says "off" in both columns because it is
 * runtime state, and AD-10 puts runtime switches in `platform_settings`, not in
 * a constant. Reading it from this table would make it un-flippable, which is
 * the one thing the Operator page exists to prevent.
 */

const SECOND_MS = 1_000
const MINUTE_MS = 60 * SECOND_MS

/** §6 "Research Settlement rule", verbatim. Addendum §4 defines each rule. */
export const RESEARCH_RULES = ['window price move', '24h trend'] as const
export type ResearchRule = (typeof RESEARCH_RULES)[number]

export interface ModeConstants {
  /** §6 "Settlement Window": how long after a Call the window closes. */
  settlementWindowMs: number
  /** §6 "Settlement poll interval": how often the settlement loop ticks. */
  settlementPollMs: number
  /** §6 "Research Settlement rule". Addendum §4 gives the comparison itself. */
  researchRule: ResearchRule
  /**
   * What `settlements.rule_label` records and the Settlement view prints.
   * Addendum §4 fixes the demo wording verbatim: "demo settlement rule:
   * 24h trend".
   */
  researchRuleLabel: string
  /** §6 "Kline granularity for drawdown", as a `MarketData.klines` interval. */
  klineInterval: KlineInterval
  /**
   * §6 "Daily Fee Budget default", in base units (AD-13). Used when
   * `accounts.daily_fee_budget` is null; it is also the value the migration and
   * the seed put in `platform_settings.default_daily_fee_budget`.
   */
  defaultDailyFeeBudget: string
  /** §6 "Run timeout": the same 120 s in both modes, measured from `started_at`. */
  runTimeoutMs: number
}

export const MODE_CONSTANTS: Readonly<Record<PlatformMode, ModeConstants>> = {
  production: {
    settlementWindowMs: 60 * MINUTE_MS,
    settlementPollMs: 60 * SECOND_MS,
    researchRule: 'window price move',
    researchRuleLabel: 'production settlement rule: window price move',
    klineInterval: '1m',
    defaultDailyFeeBudget: toBaseUnits('1').toString(),
    runTimeoutMs: 120 * SECOND_MS,
  },
  demo: {
    settlementWindowMs: 20 * SECOND_MS,
    settlementPollMs: 2 * SECOND_MS,
    researchRule: '24h trend',
    researchRuleLabel: 'demo settlement rule: 24h trend',
    klineInterval: '1s',
    defaultDailyFeeBudget: toBaseUnits('100').toString(),
    runTimeoutMs: 120 * SECOND_MS,
  },
}

/** The §6 row for `mode`. Callers read the row fresh from `platform_settings`. */
export function modeConstants(mode: PlatformMode): ModeConstants {
  return MODE_CONSTANTS[mode]
}
