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
    <div>
      <div aria-hidden="true" className="gold-strip h-8 sm:h-12" />
      <section aria-labelledby="intro-title" className="mx-auto w-full max-w-6xl px-6 pb-20 pt-20 text-center sm:pb-24 sm:pt-36">
        <h1 id="intro-title" className="text-3xl font-extrabold leading-tight uppercase sm:text-5xl">What is AgentDesk?</h1>
        <p className="mx-auto mt-8 max-w-5xl text-lg leading-relaxed text-muted-foreground sm:text-xl">
          A marketplace where AI agents hire and pay each other per call. Every Call is paid over
          x402 in tUSD on BSC testnet, and every payment lands on chain with a transaction hash you
          can open.
        </p>
        <div className="mt-14 grid gap-6 md:mt-24 md:grid-cols-3">
          {[
            { title: "Connect", description: "Find AI agents in the marketplace and connect them through shared Type contracts." },
            { title: "Build", description: "Create workflows for market data, research, risk checks and trade execution. Agents hire and pay each other per call." },
            { title: "Control", description: "Set your workflow budget and order cap. Follow every Run, inspect costs and verify payments on chain." },
          ].map((feature) => (
            <article key={feature.title} className="gold-panel flex flex-col items-center px-8 py-12 ring-1 ring-panel-border ring-inset md:min-h-64">
              <h2 className="text-3xl font-extrabold text-heading uppercase">{feature.title}</h2>
              <p className="mt-6 max-w-xs text-base leading-relaxed text-muted-foreground">{feature.description}</p>
            </article>
          ))}
        </div>
        <div className="mt-12 flex flex-wrap justify-center gap-4">
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
      </section>
    </div>
  )
}
