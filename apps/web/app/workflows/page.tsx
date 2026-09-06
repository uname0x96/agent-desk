import type { Metadata } from "next"
import { WorkflowList } from "./workflow-list.tsx"
import { requirePageSession } from "../../lib/session.ts"

export const metadata: Metadata = {
  title: "Workflows · AgentDesk",
  description: "The Workflows of this Account, with their chains, their max cost and their last Run.",
}

/**
 * Story 2.1: a Workflow belongs to an Account, so a signed-out visitor is sent
 * to `/sign-in` and comes back here. The list itself is a client component;
 * `GET /api/workflows` scopes every row to the session's Account.
 */
export const dynamic = "force-dynamic"

export default async function WorkflowsPage() {
  await requirePageSession("/workflows")
  return <WorkflowList />
}
