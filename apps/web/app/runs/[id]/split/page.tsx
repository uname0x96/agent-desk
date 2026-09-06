import type { Metadata } from "next"
import { SplitView } from "./split-view.tsx"
import { requirePageSession } from "../../../../lib/session.ts"

export const metadata: Metadata = {
  title: "Run · split view · AgentDesk",
  description:
    "The demo split view of an AgentDesk Run: the agent request and response log on the left, the money flow on the right.",
}

/**
 * FR-43, Story 5.5. A second view over the same Run as `/runs/<id>`: the two
 * panes read one `GET /api/runs/<id>` query (AD-12), so they advance together.
 *
 * Like the live Run view, a Run belongs to an Account, so a signed-out visitor
 * is sent to `/sign-in` and comes back here afterwards. The panes themselves
 * are client components; the route only unwraps the id.
 */
export const dynamic = "force-dynamic"

export default async function RunSplitPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requirePageSession(`/runs/${id}/split`)
  return <SplitView runId={id} />
}
