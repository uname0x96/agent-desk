import type { Metadata } from "next"
import { DashboardView } from "./dashboard-view.tsx"
import { requirePageSession } from "../../lib/session.ts"

export const metadata: Metadata = {
  title: "Dashboard · AgentDesk",
  description:
    "Every Run of this Account, newest first, with its Nodes, its status and what it has paid so far.",
}

/**
 * FR-39 / Story 5.1. A Run belongs to an Account, so a signed-out visitor is
 * sent to `/sign-in` and comes back here afterwards. The feed itself is a
 * client component; `GET /api/runs` scopes every row to the session's Account.
 *
 * `is_operator` is read here rather than in the browser: AD-10 puts that check
 * server-side, and the cookie is the only thing that carries it.
 */
export const dynamic = "force-dynamic"

export default async function DashboardPage() {
  const session = await requirePageSession("/dashboard")
  return <DashboardView isOperator={session.is_operator} />
}
