import type { Metadata } from "next"
import { ManageView } from "./manage-view.tsx"
import { requirePageSession } from "../../../../lib/session.ts"

export const metadata: Metadata = {
  title: "Manage listing · AgentDesk",
  description:
    "Change the price, top up the Stake, and pause a listed Agent. Every change is one transaction on the Registry.",
}

/**
 * `/listings/<id>/manage` (Story 3.6, FR-7, FR-8, FR-9).
 *
 * Only the Creator may act here, and the three routes behind the page check
 * that themselves — this page checks the session so a signed-out Creator lands
 * on `/sign-in` and comes back here rather than seeing an empty page.
 */
export const dynamic = "force-dynamic"

export default async function ManageListingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requirePageSession(`/listings/${id}/manage`)
  return <ManageView listingId={id} />
}
