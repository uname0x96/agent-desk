"use client"

import { createContext, useContext, type ReactNode } from "react"
import { DEFAULT_EXPLORER_URL, explorerLink, type ExplorerTarget } from "./explorer.ts"

/**
 * `EXPLORER_URL` is server-side configuration. The root layout reads it and
 * seeds this context so client components link through the same base.
 */
const ExplorerContext = createContext(DEFAULT_EXPLORER_URL)

export function ExplorerProvider({ value, children }: { value: string; children: ReactNode }) {
  return <ExplorerContext value={value}>{children}</ExplorerContext>
}

export function useExplorerUrl(): string {
  return useContext(ExplorerContext)
}

/** `explorerLink()` already bound to the configured base. */
export function useExplorerLink(): (target: ExplorerTarget, value: string) => string {
  const baseUrl = useContext(ExplorerContext)
  return (target, value) => explorerLink(target, value, baseUrl)
}
