import type { Metadata } from "next"
import { Suspense } from "react"
import { db } from "@agent-desk/db"
import { ListingForm } from "./listing-form.tsx"
import { readPlatformSettings } from "../../../lib/settings.ts"
import { requirePageSession } from "../../../lib/session.ts"

export const metadata: Metadata = {
  title: "List an Agent · AgentDesk",
  description:
    "Put an Agent on the AgentDesk Registry: a name, a Type, an endpoint, a price per call and the Stake it backs itself with.",
}

/**
 * `/listings/new` (Story 3.3, FR-10, FR-14).
 *
 * The Type list is decided here rather than in the browser: FR-14 offers
 * `execution` only to the Platform Account, and that comparison is against
 * `platform_settings.platform_account_id`, which no client may be trusted to
 * make. `POST /api/listings` checks it again — this only keeps the form honest
 * about what it will accept.
 *
 * The Suspense boundary is what `useSearchParams` needs: "fix and resubmit"
 * arrives as `?from=<listing id>`.
 */
export const dynamic = "force-dynamic"

export default async function NewListingPage() {
  const session = await requirePageSession("/listings/new")
  const settings = await readPlatformSettings(db())

  return (
    <Suspense fallback={<div className="mx-auto w-full max-w-3xl px-6 py-8">Loading…</div>}>
      <ListingForm canListExecution={settings.platformAccountId === session.account_id} />
    </Suspense>
  )
}
