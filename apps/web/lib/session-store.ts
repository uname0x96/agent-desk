import type { Database } from '@agent-desk/db'

/**
 * The one database read the session guards need. It lives apart from
 * `session.ts` because that module reaches for `next/headers`, and the
 * ownership rule has to be testable against Postgres without a request.
 */

/** `workflows.account_id`, or null when there is no such Workflow. */
export async function findWorkflowOwner(
  db: Database,
  workflowId: string,
): Promise<string | null> {
  const workflow = await db.query.workflows.findFirst({
    where: (table, { eq }) => eq(table.id, workflowId),
    columns: { accountId: true },
  })
  return workflow?.accountId ?? null
}
