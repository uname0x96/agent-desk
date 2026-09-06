import type { Metadata } from "next"
import { WorkflowBuilder } from "../workflow-builder.tsx"
import { requirePageSession } from "../../../lib/session.ts"

export const metadata: Metadata = {
  title: "Workflow · AgentDesk",
  description: "Edit a chain of typed Nodes, swap a Provider, and run it.",
}

/**
 * The same builder as `/workflows/new`, seeded from `GET /api/workflows/<id>`.
 * That route answers 404 for a Workflow the session does not own, so the page
 * needs no ownership check of its own beyond the session redirect.
 */
export const dynamic = "force-dynamic"

export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requirePageSession(`/workflows/${id}`)
  return <WorkflowBuilder workflowId={id} />
}
