import { db } from '@agent-desk/db'
import { readOperatorAccount, resetBudgetWindow } from '../../../../../../lib/accounts.ts'
import { jsonError, jsonOk } from '../../../../../../lib/route.ts'
import { requireOperator } from '../../../../../../lib/session.ts'

/**
 * `POST /api/operator/accounts/<id>/reset-budget` (FR-45, AD-3). Operator only.
 *
 * Sets `accounts.budget_window_start = now()`. AD-3 defines the Daily Fee
 * Budget window as starting at the later of UTC midnight and that column, and
 * the spend as a query over Calls since then, so moving the column is the whole
 * reset: nothing is zeroed, because nothing is counted.
 *
 * The answer is the Account's `operatorAccountView`, whose `budget_spent` is
 * that query re-run against the new window — which is how the page shows the
 * reset having taken effect.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const guard = await requireOperator()
  if (!guard.ok) return guard.response

  const { id } = await context.params
  if (!(await resetBudgetWindow(db(), id))) {
    return jsonError('not_found', 'no such Account')
  }

  const view = await readOperatorAccount(db(), id)
  if (!view) return jsonError('not_found', 'no such Account')
  return jsonOk(view, 200)
}
