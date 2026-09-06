import type { Metadata } from "next"
import { RunView } from "./run-view.tsx"

export const metadata: Metadata = {
  title: "Run · AgentDesk",
  description: "Live view of an AgentDesk Run: the Price Lock, every Call, and every payment.",
}

/** The live view is a client component; the route only unwraps the id. */
export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <RunView runId={id} />
}
