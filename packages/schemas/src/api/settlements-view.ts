import type { z } from 'zod'
import type { settlementsResponse } from './index.ts'

/**
 * Story 5.3 — the settlement view.
 *
 * Its own file so the five Epic 5 surfaces do not share one module. The barrel
 * re-exports it, so callers still import from `@agent-desk/schemas`.
 *
 * The body itself is not redeclared here. AD-14 keeps one definition per
 * contract, and `settlementsResponse` in `api/index.ts` already is that
 * definition for `GET /api/settlements`: `settlementView` — every column AD-9
 * writes on a `settlements` row — extended with the three fields the join to
 * `calls`, `runs` and `listings` supplies, `run_id`, `node_type` and
 * `provider`. What the route's mapper and the page both needed and neither had
 * is a name for one row of it, so that is what this file adds.
 */

/** The whole body: `{ items, next }`, as every list endpoint answers (AD-14). */
export type SettlementsPage = z.infer<typeof settlementsResponse>

/**
 * One scored Call as `/settlements` reads it. AD-9 puts exactly one of these
 * behind every `research` or `risk` Call of a `kind = 'run'` Call that reached
 * `succeeded` or `failed_after_payment`; a `verification` Call is never scored,
 * so it can never appear in this list.
 */
export type SettlementRow = SettlementsPage['items'][number]
