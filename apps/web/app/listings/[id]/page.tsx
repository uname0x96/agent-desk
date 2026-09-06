import type { Metadata } from "next"
import { ListingView } from "./listing-view.tsx"
import { requirePageSession } from "../../../lib/session.ts"

export const metadata: Metadata = {
  title: "Listing · AgentDesk",
  description:
    "Live view of a Listing going on chain: the paid verification Call, the ERC-8004 identity, and the Stake locked in the Registry.",
}

/**
 * `/listings/<id>` (Story 3.3, FR-12).
 *
 * A Listing that is still `verifying` is answered only to its Creator, so a
 * signed-out visitor is sent to `/sign-in` and comes back here afterwards. The
 * live view itself is a client component; the route only unwraps the id.
 */
export const dynamic = "force-dynamic"

export default async function ListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requirePageSession(`/listings/${id}`)
  return <ListingView listingId={id} />
}
