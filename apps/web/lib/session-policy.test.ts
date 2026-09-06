import { describe, expect, it } from 'vitest'
import {
  FORBIDDEN,
  UNAUTHORIZED,
  WORKFLOW_NOT_FOUND,
  bearerTokenMatches,
  checkSession,
  checkWorkflowAccess,
  type AccountSession,
} from './session-policy.ts'

/**
 * Story 2.1's three access rules, and the internal bearer guard of AD-10.
 * Every case here is a clause of an acceptance criterion.
 */

const BUILDER: AccountSession = { account_id: 'acc_BUILDER', is_operator: false }
const OPERATOR: AccountSession = { account_id: 'acc_OPERATOR', is_operator: true }

describe('checkSession', () => {
  it('answers 401 unauthorized without a cookie', () => {
    expect(checkSession(null)).toEqual(UNAUTHORIZED)
    expect(checkSession(null, { operator: true })).toEqual(UNAUTHORIZED)
  })

  it('lets any signed-in Account through a session route', () => {
    expect(checkSession(BUILDER)).toBeNull()
    expect(checkSession(OPERATOR)).toBeNull()
  })

  it('answers 403 forbidden for a non-operator under /api/operator/*', () => {
    expect(checkSession(BUILDER, { operator: true })).toEqual(FORBIDDEN)
    expect(FORBIDDEN.code).toBe('forbidden')
  })

  it('lets an Operator through an operator route', () => {
    expect(checkSession(OPERATOR, { operator: true })).toBeNull()
  })
})

describe('checkWorkflowAccess', () => {
  it('answers 404 not_found — never 403 — for a Workflow the session does not own', () => {
    expect(checkWorkflowAccess(BUILDER, 'acc_SOMEONE_ELSE')).toEqual(WORKFLOW_NOT_FOUND)
    expect(WORKFLOW_NOT_FOUND.code).toBe('not_found')
  })

  it('answers the same 404 for a Workflow that does not exist', () => {
    // The two must be indistinguishable, or the route confirms an id exists
    // while refusing to serve it.
    expect(checkWorkflowAccess(BUILDER, null)).toEqual(checkWorkflowAccess(BUILDER, 'acc_OTHER'))
  })

  it('answers 401 without a cookie, before it looks at ownership', () => {
    expect(checkWorkflowAccess(null, BUILDER.account_id)).toEqual(UNAUTHORIZED)
  })

  it('lets the owner through', () => {
    expect(checkWorkflowAccess(BUILDER, BUILDER.account_id)).toBeNull()
  })

  it('gives an Operator no extra reach: /api/workflows is a Builder route', () => {
    expect(checkWorkflowAccess(OPERATOR, BUILDER.account_id)).toEqual(WORKFLOW_NOT_FOUND)
  })
})

describe('bearerTokenMatches', () => {
  const TOKEN = 'internal-token-value'

  it('accepts the exact token, however the scheme is cased', () => {
    expect(bearerTokenMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true)
    expect(bearerTokenMatches(`bearer ${TOKEN}`, TOKEN)).toBe(true)
  })

  it('refuses a missing, malformed, or wrong token', () => {
    expect(bearerTokenMatches(null, TOKEN)).toBe(false)
    expect(bearerTokenMatches('', TOKEN)).toBe(false)
    expect(bearerTokenMatches(TOKEN, TOKEN)).toBe(false)
    expect(bearerTokenMatches(`Basic ${TOKEN}`, TOKEN)).toBe(false)
    expect(bearerTokenMatches(`Bearer ${TOKEN}x`, TOKEN)).toBe(false)
    expect(bearerTokenMatches(`Bearer ${TOKEN.toUpperCase()}`, TOKEN)).toBe(false)
  })

  it('refuses everything when no token is configured', () => {
    // An unset INTERNAL_TOKEN must close the route, not open it.
    expect(bearerTokenMatches('Bearer ', '')).toBe(false)
    expect(bearerTokenMatches('Bearer anything', '')).toBe(false)
  })
})
