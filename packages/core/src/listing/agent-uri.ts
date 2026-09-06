import type { AgentCard } from '@agent-desk/schemas'
import { agentCardPath, buildAgentCard, normaliseBaseUrl, type AgentCardSource } from './card.ts'

/**
 * AD-2: `agentURI` is `PUBLIC_BASE_URL/api/listings/<id>/agent.json`, and a
 * `data:application/json;base64,` URI carrying the same JSON when there is no
 * `PUBLIC_BASE_URL`.
 *
 * The choice is made once per Listing and then frozen, because
 * `IdentityRegistry.register` mints an identity around whichever string it was
 * given: a second run that decided differently would mint a second identity for
 * one Listing. The freezing is not done here — it is done by AD-8, which writes
 * this string into the `identity:<listing_id>` `chain_tx` payload before
 * anything is signed and never rebuilds the transaction afterwards. This
 * function is therefore called exactly once per Listing, inside that `buildTx`.
 *
 * `identity-uri:<listing_id>:<n>` (`setAgentURI`, Story 3.7) is the repair path
 * when the host later changes; nothing else may rewrite the URI.
 */

export const DATA_URI_PREFIX = 'data:application/json;base64,'

export function decideAgentUri(listing: AgentCardSource, publicBaseUrl: string | null): string {
  const base = normaliseBaseUrl(publicBaseUrl)
  if (base.length > 0) return `${base}${agentCardPath(listing.id)}`
  return toDataUri(buildAgentCard(listing, null))
}

/** True when the URI is a `data:` card rather than a hosted one. */
export function isDataAgentUri(agentUri: string): boolean {
  return agentUri.startsWith(DATA_URI_PREFIX)
}

export function toDataUri(card: AgentCard): string {
  return `${DATA_URI_PREFIX}${base64Utf8(JSON.stringify(card))}`
}

/** Reads a `data:` card back, for a test or a diagnostic. Null when it is a URL. */
export function decodeDataUri(agentUri: string): unknown {
  if (!isDataAgentUri(agentUri)) return null
  const binary = atob(agentUri.slice(DATA_URI_PREFIX.length))
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown
}

/**
 * `btoa` encodes one byte per code unit, so the JSON is turned into UTF-8 bytes
 * first. An Agent named in Vietnamese or Japanese would otherwise throw here
 * rather than on chain, which is the wrong place to find out.
 */
function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
