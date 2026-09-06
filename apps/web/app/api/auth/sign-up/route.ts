import { signUpRequest } from '@agent-desk/schemas'
import { readMe } from '../../../../lib/accounts.ts'
import { jsonError, jsonOk, readBody } from '../../../../lib/route.ts'
import { writeSession } from '../../../../lib/session.ts'
import { createAccountDeps, database } from './context.ts'
import { createAccount } from './create-account.ts'

/**
 * `POST /api/auth/sign-up { email, password }` (FR-1, FR-2, Story 3.1).
 *
 * One `accounts` row and one `wallet.create` job, in one transaction, then the
 * iron-session cookie — the same cookie `POST /api/auth/sign-in` writes, so
 * every guard downstream sees an ordinary session. A password shorter than
 * eight characters or an address that is not an email is 400
 * `validation_failed` from `signUpRequest`; an address that is already taken is
 * 409 `conflict`, and the page turns that into "email already registered".
 *
 * The answer is the `meResponse` body, exactly as sign-in answers it, so the
 * page can show the wallet's provisioning state without an extra round trip.
 * `wallet_address` is null in it and fills in within about a second: the worker
 * inserts the `wallets` row before the gas, mint, and approve transactions, and
 * `/settings` polls `GET /api/me` every 2 s until `wallet_ready_at` is set
 * (AD-12).
 */
export const dynamic = 'force-dynamic'
export const revalidate = 0

export async function POST(request: Request) {
  const body = await readBody(request, signUpRequest)
  if (!body.ok) return body.response

  const result = await createAccount(createAccountDeps(), {
    email: body.data.email,
    password: body.data.password,
  })
  if (!result.ok) return jsonError(result.refusal.code, result.refusal.message)

  // A new Account is never an Operator; `is_operator` is written false above and
  // read back from the row rather than assumed here.
  await writeSession({ account_id: result.accountId, is_operator: false })

  const me = await readMe(database(), result.accountId)
  if (!me) return jsonError('internal_error', 'the Account was created but cannot be read')
  return jsonOk(me, 201)
}
