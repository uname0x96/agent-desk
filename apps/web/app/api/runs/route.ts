import { NextResponse } from 'next/server'
import { ERROR_STATUS, apiError, createRunRequest, runsResponse } from '@agent-desk/schemas'
import { createRunDeps, database } from './context.ts'
import { createRun } from './create-run.ts'
import { parseRunFeedQuery, selectRunsForAccount, toRunFeedPage } from './list-runs.ts'
import { readRun } from './read-run.ts'
import { jsonError, jsonOk } from '../../../lib/route.ts'
import { requireSession } from '../../../lib/session.ts'

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

/**
 * `GET /api/runs?limit=&cursor=` — the dashboard's live Run feed (FR-39,
 * Story 5.1).
 *
 * `{ items, next }` of the signed-in account's Runs, newest first, each with
 * its Workflow name, its status and failure reason, its Node Types with the
 * status of each Call, the AD-3 `total_cost` as a base-unit string, and its
 * three timestamps. The account id comes from the iron-session cookie, never
 * from the request, so this route can only ever answer the caller's own Runs.
 *
 * The body is parsed against `runsResponse` before it is sent, so this route
 * can never ship a shape the client's own parse would reject (AD-14). AD-12:
 * nothing is pushed — the dashboard polls this, every 2 s while any listed Run
 * is `running` and every 10 s otherwise.
 */
export async function GET(request: Request) {
  const guard = await requireSession()
  if (!guard.ok) return guard.response

  const { limit, cursor } = parseRunFeedQuery(new URL(request.url).searchParams)
  const rows = await selectRunsForAccount(database(), guard.session.account_id, limit, cursor)

  const body = runsResponse.safeParse(toRunFeedPage(rows, limit))
  if (!body.success) {
    return jsonError('internal_error', 'the runs body did not match its schema', {
      issues: body.error.issues,
    })
  }
  return jsonOk(body.data, 200)
}

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
