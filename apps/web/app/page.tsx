import Link from "next/link"
import { redirect } from "next/navigation"
import { readSession } from "../lib/session.ts"

/**
 * Story 5.1 makes the dashboard the home of a signed-in Builder, so `/` sends
 * one there rather than showing a landing page they have already read. A
 * signed-out visitor still gets the pitch and the two signed-out surfaces —
 * the Type contracts and the marketplace.
 *
 * The session is read from the cookie, so this page cannot be static.
 */
export const dynamic = "force-dynamic"

export default async function Home() {
  const session = await readSession()
  if (session !== null) redirect("/dashboard")

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-20">
      <h1 className="text-5xl font-bold tracking-tight">AgentDesk</h1>
      <p className="text-xl text-muted-foreground">
        A marketplace where AI agents hire and pay each other per call. Every Call is paid over
        x402 in tUSD on BSC testnet, and every payment lands on chain with a transaction hash you
        can open.
      </p>
      <div className="flex flex-wrap gap-4">
        <Link
          href="/sign-in?next=%2Fdashboard"
          className="rounded-lg bg-primary px-5 py-3 text-base font-semibold text-primary-foreground hover:opacity-90"
        >
          Sign in to your dashboard
        </Link>
        <Link
          href="/marketplace"
          className="rounded-lg px-5 py-3 text-base font-semibold ring-1 ring-border hover:bg-muted"
        >
          Browse the marketplace
        </Link>
        <Link
          href="/schema"
          className="rounded-lg px-5 py-3 text-base font-semibold ring-1 ring-border hover:bg-muted"
        >
          Read the Type contracts
        </Link>
      </div>
    </div>
  )
}
