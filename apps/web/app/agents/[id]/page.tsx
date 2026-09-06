import type { Metadata } from "next"
import { getDeployment } from "@agent-desk/schemas"
import { AgentView } from "./agent-view.tsx"
import { requirePageSession } from "../../../lib/session.ts"

export const metadata: Metadata = {
  title: "Agent · AgentDesk",
  description:
    "An Agent's on-chain record: its ERC-8004 identity, its Registry entry, its price and Reputation history, the Stake behind it, and the paid verification Call that listed it.",
}

/**
 * `/agents/<listing_id>` (Story 5.4, FR-42).
 *
 * The public record of an Agent, as opposed to `/listings/<id>`, which is the
 * Creator's view of the same Listing going on chain. It is behind the session
 * guard like every other Epic 5 page, so a signed-out visitor is sent to
 * `/sign-in` and comes back here afterwards.
 *
 * AD-10: contract addresses come only from `deployments/97.json`, selected by
 * `CHAIN_ID`. They are read here, on the server, and handed to the view, so the
 * client neither reads `process.env` nor spells an address of its own.
 */
export const dynamic = "force-dynamic"

export default async function AgentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  await requirePageSession(`/agents/${id}`)

  const deployment = getDeployment(chainId())
  return (
    <AgentView
      listingId={id}
      registryAddress={deployment.registry.address.toLowerCase()}
      identityRegistryAddress={deployment.identityRegistry.address.toLowerCase()}
    />
  )
}

/** The same default the worker and the other web routes validate `CHAIN_ID` to. */
function chainId(): number {
  const parsed = Number(process.env.CHAIN_ID)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 97
}
