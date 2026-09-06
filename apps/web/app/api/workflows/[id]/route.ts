import { db } from '@agent-desk/db'
import { saveWorkflowRequest } from '@agent-desk/schemas'
import { jsonError, jsonOk, readBody } from '../../../../lib/route.ts'
import { requireWorkflowOwner } from '../../../../lib/session.ts'
import { selectWorkflowById } from '../query.ts'
import { saveWorkflowChain } from '../save.ts'
import { toWorkflowResponse } from '../workflows-view.ts'

/**
 * `GET /api/workflows/<id>` and `PUT /api/workflows/<id>` (FR-20).
 *
 * `requireWorkflowOwner` answers 404 `not_found` — never 403 — for a Workflow
 * the session does not own, so neither route ever confirms that an id it
 * refuses to serve exists (Story 2.1, `lib/session-policy.ts`).
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const guard = await requireWorkflowOwner(id)
  if (!guard.ok) return guard.response

  const row = await selectWorkflowById(db(), id)
  if (!row) return jsonError('not_found', 'no such Workflow')
  return jsonOk(toWorkflowResponse(row), 200)
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const guard = await requireWorkflowOwner(id)
  if (!guard.ok) return guard.response

  const parsed = await readBody(request, saveWorkflowRequest)
  if (!parsed.ok) return parsed.response

  const result = await saveWorkflowChain(db(), {
    accountId: guard.session.account_id,
    workflowId: id,
    request: parsed.data,
  })
  if (!result.ok) {
    return jsonError('validation_failed', 'the chain is not valid', {
      violations: result.violations,
    })
  }
  return jsonOk(result.body, 200)
}
