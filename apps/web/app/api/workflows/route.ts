import { db } from '@agent-desk/db'
import { saveWorkflowRequest } from '@agent-desk/schemas'
import { jsonError, jsonOk, readBody } from '../../../lib/route.ts'
import { requireSession } from '../../../lib/session.ts'
import { selectWorkflowsForAccount } from './query.ts'
import { saveWorkflowChain } from './save.ts'
import { parsePageSize, toWorkflowsPage, workflowsResponse } from './workflows-view.ts'

/**
 * `GET /api/workflows` and `POST /api/workflows` (FR-4, FR-19, FR-20).
 *
 * Both are Builder routes: the session's Account owns every Workflow they read
 * or write, and the account id comes from the iron-session cookie, never from
 * the request, so there is no id here anyone could tamper with.
 *
 * The body is parsed against `workflowsResponse` before it is sent, so this
 * route can never ship a shape the client's own parse would reject (AD-14).
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(request: Request) {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const params = new URL(request.url).searchParams
  const limit = parsePageSize(params.get('limit'))
  const rows = await selectWorkflowsForAccount(
    db(),
    guard.session.account_id,
    limit,
    params.get('cursor'),
  )

  const body = workflowsResponse.safeParse(toWorkflowsPage(rows, limit))
  if (!body.success) {
    return jsonError('internal_error', 'the workflows body did not match its schema', {
      issues: body.error.issues,
    })
  }
  return jsonOk(body.data, 200)
}

export async function POST(request: Request) {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const parsed = await readBody(request, saveWorkflowRequest)
  if (!parsed.ok) return parsed.response

  const result = await saveWorkflowChain(db(), {
    accountId: guard.session.account_id,
    workflowId: null,
    request: parsed.data,
  })
  if (!result.ok) {
    return jsonError('validation_failed', 'the chain is not valid', {
      violations: result.violations,
    })
  }
  return jsonOk(result.body, 201)
}
