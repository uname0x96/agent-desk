import type { Metadata } from "next"
import { WorkflowBuilder } from "../workflow-builder.tsx"
import { requirePageSession } from "../../../lib/session.ts"

export const metadata: Metadata = {
  title: "New Workflow · AgentDesk",
  description: "Compose a chain of typed Nodes, see it validated and priced live, and run it.",
}

export const dynamic = "force-dynamic"

export default async function NewWorkflowPage() {
  await requirePageSession("/workflows/new")
  return <WorkflowBuilder workflowId={null} />
}
