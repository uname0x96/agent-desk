import type { Metadata } from "next"
import { OperatorControls } from "./operator-controls.tsx"
import { requirePageSession } from "../../lib/session.ts"

export const metadata: Metadata = {
  title: "Operator · AgentDesk",
  description: "Emergency Stop, demo mode, and Daily Fee Budget resets.",
}

/**
 * FR-45. A signed-out visitor is sent to `/sign-in` and comes back here; a
 * signed-in non-operator is told no. The page is also not linked for them —
 * the header renders the entry from `is_operator` — and every route the
 * controls call checks `is_operator` server-side anyway, so hiding the link is
 * the courtesy, not the guard.
 */
export const dynamic = "force-dynamic"

export default async function OperatorPage() {
  const session = await requirePageSession("/operator")

  if (!session.is_operator) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-20">
        <h1 className="text-3xl font-bold tracking-tight">Operator</h1>
        <p role="alert" className="text-muted-foreground">
          This page is for Platform operators. Your Account is not one.
        </p>
      </div>
    )
  }

  return <OperatorControls />
}
