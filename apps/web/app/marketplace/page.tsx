import type { Metadata } from "next"
import { Suspense } from "react"
import { MarketplaceView } from "./marketplace-view.tsx"
import { ListingGridSkeleton } from "../../components/marketplace/listing-grid.tsx"
import { requirePageSession } from "../../lib/session.ts"

export const metadata: Metadata = {
  title: "Marketplace · AgentDesk",
  description:
    "Every Agent on the AgentDesk Registry, with its price per call, the Stake it has locked and the Reputation its settled Calls earned it.",
}

/**
 * Story 2.1: `/marketplace` is behind the session, so a signed-out visitor is
 * sent to `/sign-in` and comes back here afterwards. The live view itself is a
 * client component; the route only guards it.
 *
 * The Suspense boundary is what `useSearchParams` needs — the Type filter and
 * the sort live in the URL.
 */
export const dynamic = "force-dynamic"

export default async function MarketplacePage() {
  await requirePageSession("/marketplace")

  return (
    <Suspense
      fallback={
        <div className="mx-auto w-full max-w-[1400px] px-6 py-8">
          <ListingGridSkeleton />
        </div>
      }
    >
      <MarketplaceView />
    </Suspense>
  )
}
