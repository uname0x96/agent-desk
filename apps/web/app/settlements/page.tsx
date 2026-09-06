import type { Metadata } from "next"
import { SettlementsView } from "./settlements-view.tsx"
import { parseFilter } from "./settlements-query.ts"
import { requirePageSession } from "../../lib/session.ts"

export const metadata: Metadata = {
  title: "Settlements · AgentDesk",
  description:
    "Every scored Call of your Runs, with the rule that judged it, the prices it was judged on, and the Slash that paid your Refund back.",
}

/**
 * Story 2.1: `/settlements` shows an Account's own Runs, so a signed-out
 * visitor is sent to `/sign-in` and comes back here afterwards. The live view
 * itself is a client component; the route guards it and hands it the filter.
 *
 * `?run_id=` and `?listing_id=` are read here rather than with
 * `useSearchParams`, so a filtered list can be linked and reloaded without the
 * page needing a Suspense boundary of its own — and so the view is a plain
 * function of its props, which is what lets a test render it.
 */
export const dynamic = "force-dynamic"

type SearchParams = Record<string, string | string[] | undefined>

export default async function SettlementsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>
}) {
  await requirePageSession("/settlements")
  const params = await searchParams

  return <SettlementsView filter={parseFilter(first(params.run_id), first(params.listing_id))} />
}

/** `?run_id=a&run_id=b` is a caller mistake, not two filters; the first wins. */
function first(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}
