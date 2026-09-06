import type { Database } from '@agent-desk/db'
import type { PaymentsQuery } from '@agent-desk/schemas'
import type { PaymentRow } from './payments-model.ts'

/**
 * The reads behind `GET /api/payments`.
 *
 * `apps/web` depends on `@agent-desk/db` but not on `drizzle-orm`, so these go
 * through the relational query API, whose operators arrive as callback
 * arguments. That is also why the Listing names, the Run wallets and the
 * Settlement ids are three small follow-up reads keyed by ids the first two
 * queries already hold rather than one joined statement: a page is at most
 * fifty Runs of at most five Calls each (AD-4), so it is a few dozen keys.
 *
 * The account filter is on `runs.account_id` and there is no second guard: a
 * `run_id` belonging to somebody else simply matches no Run, so the route can
 * neither serve it nor confirm that it exists.
 */

/**
 * The page of Runs the payment rows will be grouped under, newest first, plus
 * one extra so the caller can tell whether a next page exists. Run ids are
 * ULIDs (AD-13), so descending id order is descending creation order.
 */
export async function selectAccountRunIds(
  database: Database,
  accountId: string,
  query: PaymentsQuery,
): Promise<{ id: string; walletId: string }[]> {
  return database.query.runs.findMany({
    where: (run, { and, eq, lt }) =>
      and(
        eq(run.accountId, accountId),
        query.run_id === null ? undefined : eq(run.id, query.run_id),
        query.cursor === null ? undefined : lt(run.id, query.cursor),
      ),
    orderBy: (run, { desc }) => [desc(run.id)],
    columns: { id: true, walletId: true },
    limit: query.limit + 1,
  })
}

/**
 * AD-3: a payment is a `kind = 'run'` Call whose `payment_payload` is not null.
 * `payment_payload` is written in the same transaction that signs (AD-5), so
 * this is exactly the set of Calls money was authorised for — including the
 * ones where it never landed, which is the whole point of showing status here.
 */
export async function selectPaymentRows(
  database: Database,
  runs: readonly { id: string; walletId: string }[],
): Promise<PaymentRow[]> {
  if (runs.length === 0) return []

  const runIds = runs.map((run) => run.id)
  const callRows = await database.query.calls.findMany({
    where: (call, { and, eq, inArray, isNotNull }) =>
      and(
        inArray(call.runId, runIds),
        eq(call.kind, 'run'),
        isNotNull(call.paymentPayload),
      ),
    orderBy: (call, { asc }) => [asc(call.nodeIndex)],
    columns: {
      id: true,
      runId: true,
      listingId: true,
      nodeIndex: true,
      nodeType: true,
      status: true,
      lockedPrice: true,
      lockedPayTo: true,
      paymentTxHash: true,
      startedAt: true,
      endedAt: true,
    },
  })
  if (callRows.length === 0) return []

  const [providerByListing, addressByWallet, settlementByCall] = await Promise.all([
    providerNames(database, callRows),
    walletAddresses(database, runs),
    settlementIds(database, callRows),
  ])
  const walletByRun = new Map(runs.map((run) => [run.id, run.walletId]))

  return callRows.map((call) => ({
    callId: call.id,
    // `calls_run_id_matches_kind` makes this not null for every `run` Call.
    runId: call.runId ?? '',
    nodeIndex: call.nodeIndex,
    nodeType: call.nodeType,
    status: call.status,
    lockedPrice: call.lockedPrice,
    lockedPayTo: call.lockedPayTo,
    paymentTxHash: call.paymentTxHash,
    startedAt: call.startedAt,
    endedAt: call.endedAt,
    provider: providerByListing.get(call.listingId) ?? '',
    from: addressByWallet.get(walletByRun.get(call.runId ?? '') ?? '') ?? null,
    settlementId: settlementByCall.get(call.id) ?? null,
  }))
}

/** The Listing name each Call was priced against, keyed by `listing_id`. */
async function providerNames(
  database: Database,
  callRows: readonly { listingId: string }[],
): Promise<Map<string, string>> {
  const ids = [...new Set(callRows.map((call) => call.listingId))]
  const rows = await database.query.listings.findMany({
    where: (listing, { inArray }) => inArray(listing.id, ids),
    columns: { id: true, name: true },
  })
  return new Map(rows.map((row) => [row.id, row.name]))
}

/** The `from` of every payment: the System Wallet the Run pays with (AD-3). */
async function walletAddresses(
  database: Database,
  runs: readonly { walletId: string }[],
): Promise<Map<string, string>> {
  const ids = [...new Set(runs.map((run) => run.walletId))]
  const rows = await database.query.wallets.findMany({
    where: (wallet, { inArray }) => inArray(wallet.id, ids),
    columns: { id: true, address: true },
  })
  return new Map(rows.map((row) => [row.id, row.address]))
}

/**
 * AD-9 gives a `research` or `risk` Call exactly one `settlements` row, so the
 * page can tell a row that has been scored from one that is still waiting.
 */
async function settlementIds(
  database: Database,
  callRows: readonly { id: string }[],
): Promise<Map<string, string>> {
  const ids = callRows.map((call) => call.id)
  const rows = await database.query.settlements.findMany({
    where: (settlement, { inArray }) => inArray(settlement.callId, ids),
    columns: { id: true, callId: true },
  })
  return new Map(rows.map((row) => [row.callId, row.id]))
}
