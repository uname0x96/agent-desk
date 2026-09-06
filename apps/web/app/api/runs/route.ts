import { NextResponse } from 'next/server'
import { ERROR_STATUS, apiError, createRunRequest } from '@agent-desk/schemas'
import { createRunDeps, database } from './context.ts'
import { createRun } from './create-run.ts'
import { readRun } from './read-run.ts'

/**
 * `POST /api/runs { workflow_id }` (FR-22, AD-4).
 *
 * The whole decision is `createRun`, which runs in one transaction with
 * `SELECT ... FOR UPDATE` on the account row and inserts nothing when it
 * refuses. This handler only translates: a body that is not
 * `createRunRequest` is 400 `validation_failed`, a refusal is the status
 * `ERROR_STATUS` maps its code to, and a Run that was created is answered with
 * the same body `GET /api/runs/<id>` returns, so the client can navigate
 * straight to the live view.
 *
 * There is no session yet: Story 2.1 introduces the iron-session cookie and, in
 * its own words, makes this route "require a session and answer 404 `not_found`
 * for a Workflow the session does not own". The account is resolved from the
 * Workflow row here, which is the same account that guard will check, so the
 * change is one lookup at the top of this handler and nothing below it.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = { 'cache-control': 'no-store' } as const

export async function POST(request: Request) {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return NextResponse.json(apiError('validation_failed', 'the body is not JSON'), {
      status: ERROR_STATUS.validation_failed,
      headers: NO_STORE,
    })
  }

  const parsed = createRunRequest.safeParse(payload)
  if (!parsed.success) {
    return NextResponse.json(
      apiError('validation_failed', 'workflow_id is required', {
        issues: parsed.error.issues,
      }),
      { status: ERROR_STATUS.validation_failed, headers: NO_STORE },
    )
  }

  const result = await createRun(createRunDeps(), { workflowId: parsed.data.workflow_id })
  if (!result.ok) {
    const { code, message, details } = result.refusal
    return NextResponse.json(apiError(code, message, details), {
      status: ERROR_STATUS[code],
      headers: NO_STORE,
    })
  }

  const body = await readRun(database(), result.runId)
  if (!body) {
    return NextResponse.json(apiError('internal_error', 'the Run was inserted but cannot be read'), {
      status: ERROR_STATUS.internal_error,
      headers: NO_STORE,
    })
  }
  return NextResponse.json(body, { status: 201, headers: NO_STORE })
}
