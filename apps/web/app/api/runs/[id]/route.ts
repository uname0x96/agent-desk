import { NextResponse } from 'next/server'
import { ERROR_STATUS, apiError } from '@agent-desk/schemas'
import { database } from '../context.ts'
import { readRun } from '../read-run.ts'

/**
 * `GET /api/runs/<id>` (FR-28, AD-12).
 *
 * The Run with its Price Lock and every Call — Node, Provider, status,
 * `locked_price`, `payment_tx_hash`, request, response and timestamps — as one
 * JSON body, parsed against `runResponse` on the way out. The live Run view
 * polls this every two seconds while the Run is `running`.
 *
 * Like `POST`, this route gains its session guard in Story 2.1, which answers
 * 404 for a Run the session does not own; today an unknown id is the only 404.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

const NO_STORE = { 'cache-control': 'no-store' } as const

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const run = await readRun(database(), id)
  if (!run) {
    return NextResponse.json(apiError('not_found', 'no such Run'), {
      status: ERROR_STATUS.not_found,
      headers: NO_STORE,
    })
  }
  return NextResponse.json(run, { status: 200, headers: NO_STORE })
}
