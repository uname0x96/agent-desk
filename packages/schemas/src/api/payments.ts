import { z } from 'zod'
import type { paymentsResponse } from './index.ts'

/**
 * Story 5.2 — the payments view.
 *
 * Its own file so the five Epic 5 surfaces do not share one module. The barrel
 * re-exports it, so callers still import from `@agent-desk/schemas`.
 *
 * ┌─ AD-3 ─────────────────────────────────────────────────────────────────┐
 * │ There is no `payments` table. A payment *is* a Call row: `from` the    │
 * │ Run's wallet, `to` its `locked_pay_to`, `amount` its `locked_price`,   │
 * │ hash its `payment_tx_hash`. FR-40 is therefore a query over `calls`    │
 * │ joined to `runs`, `listings` and `wallets`, and its row shape is       │
 * │ `paymentView` — which already lives next door in `api/index.ts` beside │
 * │ `callView`, whose columns it is a projection of. It is not restated    │
 * │ here: two Zod objects for one wire shape is exactly what AD-14 exists  │
 * │ to prevent.                                                            │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * What this file owns is the *request* half of the contract, which had no home
 * before: the query string of `GET /api/payments`, and the names for the two
 * bounds a client's `limit` is held to.
 */

/**
 * Keyset page size, counted in **Runs**, not in payment rows.
 *
 * Story 5.2 groups the view by Run and prints a per-Run subtotal, so a page
 * that ended in the middle of a Run would print a subtotal that is not the
 * Run's cost. Paginating by Run is what makes every subtotal on screen a whole
 * one; a Run has at most five Calls (AD-4), so a page is at most `limit × 5`
 * rows.
 */
export const PAYMENTS_PAGE_RUNS_DEFAULT = 20
export const PAYMENTS_PAGE_RUNS_MAX = 50

/**
 * `GET /api/payments?run_id=&cursor=&limit=`, after the route has turned the
 * raw `URLSearchParams` (whose every value is `string | null`) into values.
 * `cursor` is the `run_id` of the last Run on the previous page; Run ids are
 * ULIDs (AD-13), so descending id order is newest-first and one column is
 * enough to resume from.
 */
export const paymentsQuery = z.object({
  /** Narrows the view to one Run, for the "payments of this Run" link. */
  run_id: z.string().min(1).nullable(),
  cursor: z.string().min(1).nullable(),
  limit: z.number().int().min(1).max(PAYMENTS_PAGE_RUNS_MAX),
})

export type PaymentsQuery = z.infer<typeof paymentsQuery>

/** `{ items, next }` of `paymentView`, from `api/index.ts`. */
export type PaymentsResponse = z.infer<typeof paymentsResponse>
