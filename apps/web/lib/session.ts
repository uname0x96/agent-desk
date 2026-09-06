import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { NextResponse } from 'next/server'
import { getIronSession, type SessionOptions } from 'iron-session'
import { db, type Database } from '@agent-desk/db'
import { ERROR_STATUS, apiError } from '@agent-desk/schemas'
import { findWorkflowOwner } from './session-store.ts'
import {
  UNAUTHORIZED,
  checkSession,
  checkWorkflowAccess,
  type AccountSession,
  type Refusal,
} from './session-policy.ts'

/**
 * Story 2.1: the iron-session 9 cookie, and the three guards every protected
 * route goes through. The cookie holds `account_id` and `is_operator` and
 * nothing else, so a route never has to trust a client-supplied id.
 *
 * The decisions themselves are pure and live in `session-policy.ts`; this
 * module is only the Next.js wiring — cookies, headers, and the error envelope.
 */

export type { AccountSession } from './session-policy.ts'
export { findWorkflowOwner } from './session-store.ts'

export const SESSION_COOKIE_NAME = 'agentdesk_session'

/** Two weeks, iron-session's own default, stated here so it is not a surprise. */
export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14

const NO_STORE = { 'cache-control': 'no-store' } as const

/**
 * Built per request, never at module scope: `next build` imports every route to
 * collect its page data and does that without the runtime environment, so a
 * top-level read of `SESSION_SECRET` would turn a missing variable into a build
 * failure instead of the boot failure it should be.
 */
async function sessionOptions(): Promise<SessionOptions> {
  const password = process.env.SESSION_SECRET ?? ''
  if (password.length < 32) {
    throw new Error('SESSION_SECRET must be set to at least 32 characters')
  }
  return {
    cookieName: SESSION_COOKIE_NAME,
    password,
    ttl: SESSION_TTL_SECONDS,
    cookieOptions: {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      // Derived from the request rather than from NODE_ENV. The demo is driven
      // at http://localhost:3000 while the same production build is also
      // reachable over the https tunnel; a hard-coded `secure: true` would make
      // the browser drop the cookie on the local origin and no one could sign
      // in at the one moment it matters.
      secure: await isHttps(),
    },
  }
}

async function isHttps(): Promise<boolean> {
  const headerList = await headers()
  const forwarded = headerList.get('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase()
  return forwarded === 'https'
}

async function ironSession() {
  return getIronSession<AccountSession>(await cookies(), await sessionOptions())
}

/** The signed-in account, or null. Never throws on a tampered or expired cookie. */
export async function readSession(): Promise<AccountSession | null> {
  const session = await ironSession()
  if (typeof session.account_id !== 'string' || session.account_id.length === 0) return null
  return { account_id: session.account_id, is_operator: session.is_operator === true }
}

/** `POST /api/auth/sign-in`. */
export async function writeSession(identity: AccountSession): Promise<void> {
  const session = await ironSession()
  session.account_id = identity.account_id
  session.is_operator = identity.is_operator
  await session.save()
}

/** `POST /api/auth/sign-out`. */
export async function destroySession(): Promise<void> {
  const session = await ironSession()
  session.destroy()
}

// ------------------------------------------------------------------- guards

/**
 * What a guard hands back. A route reads two lines:
 *
 *   const guard = await requireSession()
 *   if (!guard.ok) return guard.response
 *
 * and everything below it may use `guard.session`.
 */
export type Guard =
  | { ok: true; session: AccountSession }
  | { ok: false; response: NextResponse }

export function refuse(refusal: Refusal): NextResponse {
  return NextResponse.json(apiError(refusal.code, refusal.message), {
    status: ERROR_STATUS[refusal.code],
    headers: NO_STORE,
  })
}

/** 401 `unauthorized` without a cookie. */
export async function requireSession(): Promise<Guard> {
  return guardWith(await readSession(), (session) => checkSession(session))
}

/** 401 without a cookie, 403 `forbidden` for a non-operator (`/api/operator/*`). */
export async function requireOperator(): Promise<Guard> {
  return guardWith(await readSession(), (session) => checkSession(session, { operator: true }))
}

/**
 * Every `/api/workflows` route: a session, and 404 `not_found` — never 403 —
 * for a Workflow the session does not own, so the route never confirms that an
 * id it refuses to serve exists.
 */
export async function requireWorkflowOwner(
  workflowId: string,
  database: Database = db(),
): Promise<Guard> {
  const session = await readSession()
  const owner = session === null ? null : await findWorkflowOwner(database, workflowId)
  return guardWith(session, (current) => checkWorkflowAccess(current, owner))
}

/**
 * Applies a `session-policy` rule and turns its refusal into the shared error
 * envelope. `session` is checked for null here as well so the success branch
 * narrows without an assertion; the rules themselves still own every code.
 */
function guardWith(
  session: AccountSession | null,
  rule: (session: AccountSession | null) => Refusal | null,
): Guard {
  const refusal = rule(session)
  if (refusal !== null) return { ok: false, response: refuse(refusal) }
  if (session === null) return { ok: false, response: refuse(UNAUTHORIZED) }
  return { ok: true, session }
}

// -------------------------------------------------------------- page guards

/**
 * For a server component: the session, or a redirect to `/sign-in` that comes
 * back here afterwards. The builder and the run pages call this.
 */
export async function requirePageSession(returnTo: string): Promise<AccountSession> {
  const session = await readSession()
  if (!session) redirect(signInPath(returnTo))
  return session
}

/** `/sign-in?next=<where the visitor was going>`. */
export function signInPath(returnTo: string): string {
  // Only a same-site path is ever carried, so the parameter cannot become an
  // open redirect on the way back.
  const safe = returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/'
  return `/sign-in?next=${encodeURIComponent(safe)}`
}
