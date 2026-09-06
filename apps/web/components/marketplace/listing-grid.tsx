import type { ListingResponse } from "@agent-desk/schemas"
import { ListingCard } from "./listing-card.tsx"

/**
 * The marketplace grid. Three cards across on a wide screen, two on a laptop,
 * one on a phone; every card is the same height so the two big numbers line up
 * across a row and can be compared at a glance.
 */
export function ListingGrid({ listings }: { listings: readonly ListingResponse[] }) {
  return (
    <ul className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
      {listings.map((listing) => (
        <li key={listing.id}>
          <ListingCard listing={listing} />
        </li>
      ))}
    </ul>
  )
}

/** Six placeholders on the first load, so the grid does not jump into place. */
export function ListingGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <ul aria-hidden className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
      {Array.from({ length: count }, (_, index) => (
        <li key={index} className="h-72 animate-pulse rounded-xl bg-muted" />
      ))}
    </ul>
  )
}

export function ListingGridEmpty({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border px-6 py-16 text-center">
      <p className="text-xl font-semibold">{title}</p>
      <p className="text-base text-muted-foreground">{hint}</p>
    </div>
  )
}
