import { db } from '@agent-desk/db'
import { operatorAccountsResponse } from '@agent-desk/schemas'
import { findAccountsForOperator } from '../../../../lib/accounts.ts'
import { jsonError, jsonOk } from '../../../../lib/route.ts'
import { requireOperator } from '../../../../lib/session.ts'

/**
 * `GET /api/operator/accounts?email=` (FR-45). Operator only.
 *
 * Id, email, wallet address, Daily Fee Budget and spend for each match, so the
 * Operator page can resolve a typed email to an id before it calls reset-budget.
 * An unknown email is an empty `items`, not a 404: "no such account" is
 * something the page says, not an error the request failed with.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

const MAX_ITEMS = 50

export async function GET(request: Request) {
  const guard = await requireOperator()
  if (!guard.ok) return guard.response

  const email = new URL(request.url).searchParams.get('email')
  const items = await findAccountsForOperator(db(), email, MAX_ITEMS)

  const body = operatorAccountsResponse.safeParse({ items, next: null })
  if (!body.success) {
    return jsonError('internal_error', 'the accounts body did not match its schema', {
      issues: body.error.issues,
    })
  }
  return jsonOk(body.data, 200)
}
