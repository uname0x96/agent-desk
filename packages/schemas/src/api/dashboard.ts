import { z } from 'zod'
import { callStatusSchema } from '../status.ts'
import { agentTypeSchema } from '../types/index.ts'

/**
 * Story 5.1 — the dashboard Run feed.
 *
 * Its own file so the five Epic 5 surfaces do not share one module. The barrel
 * re-exports it, so callers still import from `@agent-desk/schemas`.
 *
 * The feed's page and item bodies are `runsResponse` and `runSummary` in
 * `api/index.ts`, where they were declared beside `runResponse` they are
 * derived from; re-declaring them here would give the same shape two names and
 * let the Run view and the feed drift apart. What lives here is what only the
 * feed has: the Node item its rows carry, and the `?limit=&cursor=` contract
 * the route parses and the client builds, so the two agree on the bounds
 * (AD-14: both sides of every boundary parse with these schemas).
 */

/**
 * One Node of a feed row: its Type and the status of the Call that ran it.
 * Structurally the element of `runSummary.nodes`, named so the route's read
 * model and the dashboard's row can share one type.
 */
export const runNodeView = z.object({
  node_type: agentTypeSchema,
  status: callStatusSchema,
})

export type RunNodeView = z.infer<typeof runNodeView>

/** Enough Runs for a demo day on one screen, without a second request. */
export const RUN_FEED_DEFAULT_LIMIT = 20

/** The ceiling the route clamps to, so no caller can ask for the whole table. */
export const RUN_FEED_MAX_LIMIT = 100

/**
 * `GET /api/runs?limit=&cursor=`.
 *
 * AD-13: Run ids are ULIDs, whose first ten characters are the creation time in
 * base 32, so the cursor is simply the id of the last row of the previous page
 * and needs no encoding of its own.
 */
export const runFeedQuery = z.object({
  limit: z.number().int().min(1).max(RUN_FEED_MAX_LIMIT).default(RUN_FEED_DEFAULT_LIMIT),
  cursor: z.string().min(1).nullable().default(null),
})

export type RunFeedQuery = z.infer<typeof runFeedQuery>
