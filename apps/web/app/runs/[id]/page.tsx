import type { Metadata } from "next"
import { RunView } from "./run-view.tsx"
import { requirePageSession } from "../../../lib/session.ts"

export const metadata: Metadata = {
  title: "Run · AgentDesk",
  description: "Live view of an AgentDesk Run: the Price Lock, every Call, and every payment.",
}

/**
 * Story 2.1: a Run belongs to an Account, so a signed-out visitor is sent to
 * `/sign-in` and comes back here afterwards. The live view itself is a client
 * component; the route only unwraps the id.
 */
export const dynamic = "force-dynamic"

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requirePageSession(`/runs/${id}`)
  return <RunView runId={id} />
}
