import { db } from '@agent-desk/db'
import { signInRequest } from '@agent-desk/schemas'
import { readMe, verifyCredentials } from '../../../../lib/accounts.ts'
import { jsonError, jsonOk, readBody } from '../../../../lib/route.ts'
import { writeSession } from '../../../../lib/session.ts'

/**
 * `POST /api/auth/sign-in { email, password }` (FR-1, Story 2.1).
 *
 * A valid pair sets the iron-session cookie holding `account_id` and
 * `is_operator`. A wrong pair answers 401 `unauthorized` with one message for
 * both failures: the body never says whether it was the email or the password,
 * and `verifyCredentials` spends the same bcrypt comparison either way so the
 * response time does not say it either.
 *
 * The answer is the `meResponse` body — AD-14 keeps every response shape in
 * `packages/schemas`, and this one saves the client an immediate `GET /api/me`.
 * Sign-up is Story 3.1; this route only signs an existing Account in.
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: Request) {
  const body = await readBody(request, signInRequest)
  if (!body.ok) return body.response

  const identity = await verifyCredentials(db(), body.data.email, body.data.password)
  if (!identity) return jsonError('unauthorized', 'wrong email or password')

  await writeSession(identity)

  const me = await readMe(db(), identity.account_id)
  if (!me) return jsonError('internal_error', 'the Account signed in but cannot be read')
  return jsonOk(me, 200)
}
