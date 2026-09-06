import type { Metadata } from "next"
import { Suspense } from "react"
import { PaymentsView } from "./payments-view.tsx"
import { requirePageSession } from "../../lib/session.ts"

export const metadata: Metadata = {
  title: "Payments · AgentDesk",
  description:
    "Every x402 payment an AgentDesk Run made: Run, Node, Provider, amount, from and to addresses, status and tx hash.",
}

/**
 * Story 2.1: `/payments` shows one account's money, so a signed-out visitor is
 * sent to `/sign-in` and comes back here afterwards. The live view itself is a
 * client component; the route only guards it.
 *
 * The Suspense boundary is what `useSearchParams` needs — `?run_id=` narrows
 * the page to one Run.
 */
export const dynamic = "force-dynamic"

export default async function PaymentsPage() {
  await requirePageSession("/payments")

  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-[1400px] px-6 py-8">
          <div className="h-40 animate-pulse rounded-xl bg-muted" aria-hidden />
        </div>
      }
    >
      <PaymentsView />
    </Suspense>
  )
}
