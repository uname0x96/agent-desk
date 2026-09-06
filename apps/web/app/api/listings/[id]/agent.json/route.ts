import { NextResponse } from 'next/server'
import { buildAgentCard } from '@agent-desk/core/listing'
import { agentCard, apiError } from '@agent-desk/schemas'
import { publicBaseUrl, toAgentCardSource } from '../../listings-view.ts'
import { selectListingById } from '../../query.ts'

/**
 * `GET /api/listings/<id>/agent.json` — the ERC-8004 agent card (AD-2, FR-12).
 *
 * Signed out, and it has to stay that way: this is the URL the `agentURI` in the
 * `Registered` event points at, so an indexer, a wallet, or another agent reads
 * it with no session and from outside the laptop.
 *
 * The card is built by `buildAgentCard` in `packages/core/listing` — the same
 * function the worker calls to build the `data:` `agentURI` when there is no
 * `PUBLIC_BASE_URL`, which is what makes "the same JSON" true.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

const HEADERS = {
  'cache-control': 'no-store',
  // ERC-8004 registries and indexers fetch this cross-origin.
  'access-control-allow-origin': '*',
} as const

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params

  const row = await selectListingById(id)
  if (!row) {
    return NextResponse.json(apiError('not_found', `no listing ${id}`), {
      status: 404,
      headers: HEADERS,
    })
  }

  const body = agentCard.safeParse(buildAgentCard(toAgentCardSource(row), publicBaseUrl(request.url)))
  if (!body.success) {
    return NextResponse.json(
      apiError('internal_error', 'the agent card did not match its schema', {
        issues: body.error.issues,
      }),
      { status: 500, headers: HEADERS },
    )
  }

  return NextResponse.json(body.data, { status: 200, headers: HEADERS })
}
