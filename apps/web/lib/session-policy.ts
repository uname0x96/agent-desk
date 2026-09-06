import type { ErrorCode } from '@agent-desk/schemas'

/**
 * Who may call what, as pure functions. The rules live here rather than inline
 * in the route handlers so every route answers the same code for the same
 * situation and so the rules can be tested without a request.
 *
 * Story 2.1 fixes three of them:
 *   - no cookie on a session route            -> 401 `unauthorized`
 *   - a non-operator under `/api/operator/*`  -> 403 `forbidden`
 *   - a Workflow the session does not own     -> 404 `not_found`, never 403,
 *     so the route never confirms that an id it refuses to serve exists.
 */

/** Exactly what the iron-session cookie carries (Story 2.1). */
export interface AccountSession {
  account_id: string
  is_operator: boolean
}

export interface Refusal {
  code: ErrorCode
  message: string
}

export const UNAUTHORIZED: Refusal = { code: 'unauthorized', message: 'sign in first' }
export const FORBIDDEN: Refusal = { code: 'forbidden', message: 'operator only' }
export const WORKFLOW_NOT_FOUND: Refusal = { code: 'not_found', message: 'no such Workflow' }

/** Null means "let the request through". */
export function checkSession(
  session: AccountSession | null,
  options: { operator?: boolean } = {},
): Refusal | null {
  if (!session) return UNAUTHORIZED
  if (options.operator === true && !session.is_operator) return FORBIDDEN
  return null
}

/**
 * A Workflow the session does not own is indistinguishable from one that does
 * not exist, which is why an unknown id and another Builder's id answer the
 * same 404. An Operator gets no extra reach here: `/api/workflows` is a Builder
 * route, and `is_operator` governs `/api/operator/*` only.
 */
export function checkWorkflowAccess(
  session: AccountSession | null,
  ownerAccountId: string | null,
): Refusal | null {
  if (!session) return UNAUTHORIZED
  if (ownerAccountId === null || ownerAccountId !== session.account_id) return WORKFLOW_NOT_FOUND
  return null
}

/**
 * `Authorization: Bearer <INTERNAL_TOKEN>`, the guard on every
 * `/api/internal/*` route (AD-10). No session is involved: the caller is a
 * platform-operated agent, not a browser.
 */
export function bearerTokenMatches(header: string | null, expected: string): boolean {
  if (expected.length === 0) return false
  const prefix = 'bearer '
  if (!header || header.length < prefix.length) return false
  if (header.slice(0, prefix.length).toLowerCase() !== prefix) return false
  return constantTimeEqual(header.slice(prefix.length).trim(), expected)
}

/** Compares in time proportional to the length only, never to the match. */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let difference = 0
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index)
  }
  return difference === 0
}
