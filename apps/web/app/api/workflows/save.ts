import type { Database } from '@agent-desk/db'
import {
  newId,
  symbolSchema,
  type ChainViolation,
  type SaveWorkflowRequest,
  type WorkflowResponse,
} from '@agent-desk/schemas'
import { validateChain } from '@agent-desk/core/workflow'
import { saveWorkflow, selectListingsByIds, selectWorkflowById } from './query.ts'
import { toChainListing, toWorkflowResponse } from './workflows-view.ts'

/**
 * The one thing `POST /api/workflows` and `PUT /api/workflows/<id>` do, so the
 * two routes differ only in where the id comes from and what status they answer.
 *
 * FR-19: the chain is validated with `validateChain` from `packages/core`, the
 * same function the builder page runs on every keystroke, against the Listings
 * as they stand at this moment. An invalid chain is 400 `validation_failed`
 * carrying every violation, and nothing is written.
 */

export type SaveOutcome =
  | { ok: true; body: WorkflowResponse }
  | { ok: false; violations: ChainViolation[] }

export interface SaveInput {
  accountId: string
  /** The id of the Workflow being replaced, or null to mint a new one. */
  workflowId: string | null
  request: SaveWorkflowRequest
}

export async function saveWorkflowChain(db: Database, input: SaveInput): Promise<SaveOutcome> {
  const symbol = normaliseSymbol(input.request.symbol)
  if (symbol === null) {
    return {
      ok: false,
      violations: [
        {
          node_index: null,
          rule: 'symbol_invalid',
          message: 'the symbol must be an upper-case trading pair such as BNBUSDT',
        },
      ],
    }
  }

  const listings = await selectListingsByIds(
    db,
    input.request.nodes.map((node) => node.listing_id),
  )

  const violations = validateChain(input.request.nodes, listings.map(toChainListing), {
    order_cap_usdt: input.request.order_cap_usdt,
  })
  if (violations.length > 0) return { ok: false, violations }

  const workflowId = input.workflowId ?? newId('workflow')
  await saveWorkflow(db, {
    workflowId,
    accountId: input.accountId,
    name: input.request.name.trim(),
    symbol,
    // AD-13: the column carries the Order Cap as a decimal USDT string, which is
    // how the engine reads it; the response converts it to base units.
    orderCapUsdt: input.request.order_cap_usdt,
    nodes: input.request.nodes,
  })

  const saved = await selectWorkflowById(db, workflowId)
  if (!saved) throw new Error(`the Workflow ${workflowId} was saved but cannot be read`)
  return { ok: true, body: toWorkflowResponse(saved) }
}

/**
 * The builder fixes the symbol to `BNBUSDT`, but the route is the boundary: an
 * agent parses `symbol` with `symbolSchema`, so anything that would not survive
 * that parse is refused here rather than at the far end of a paid Call.
 */
export function normaliseSymbol(value: string): string | null {
  const upper = value.trim().toUpperCase()
  return symbolSchema.safeParse(upper).success ? upper : null
}
