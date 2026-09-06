"use client"

import { ExternalLinkIcon } from "lucide-react"
import { cn } from "cn"
import { useExplorerLink } from "../lib/explorer-context.tsx"
import { formatAddress, formatTxHash, truncateMiddle } from "../lib/format.ts"

/**
 * AD-13: addresses and hashes are stored lower-case and rendered checksummed
 * as explorer links through one helper. These two components are that helper's
 * only rendering path in the UI.
 */

function ChainLink({
  href,
  text,
  title,
  className,
}: {
  href: string
  text: string
  title: string
  className?: string
}) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      title={title}
      className={cn(
        "hash inline-flex items-center gap-1 text-status-running underline-offset-4 hover:underline",
        className,
      )}
    >
      {text}
      <ExternalLinkIcon className="size-3.5 shrink-0" aria-hidden />
    </a>
  )
}

export function AddressLink({
  address,
  truncate = true,
  className,
}: {
  address: string | null | undefined
  truncate?: boolean
  className?: string
}) {
  const link = useExplorerLink()
  if (!address) return <span className="text-muted-foreground">—</span>

  const checksummed = formatAddress(address)
  return (
    <ChainLink
      href={link("address", checksummed)}
      text={truncate ? truncateMiddle(checksummed) : checksummed}
      title={checksummed}
      {...(className ? { className } : {})}
    />
  )
}

export function TxHashLink({
  hash,
  truncate = true,
  className,
}: {
  hash: string | null | undefined
  truncate?: boolean
  className?: string
}) {
  const link = useExplorerLink()
  if (!hash) return <span className="text-muted-foreground">not yet</span>

  const normalised = formatTxHash(hash)
  return (
    <ChainLink
      href={link("tx", normalised)}
      text={truncate ? truncateMiddle(normalised) : normalised}
      title={normalised}
      {...(className ? { className } : {})}
    />
  )
}
