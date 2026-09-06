"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "cn"
import { SessionMenu } from "./session-menu.tsx"

/**
 * The nav every page shares. Routes are added by later stories; the entries
 * are listed here so the shell does not change again when they land.
 *
 * `/operator` is deliberately absent: Story 2.2 requires that it is not linked
 * for a non-operator, so `SessionMenu` renders it from `is_operator` instead.
 */
const NAV = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/workflows", label: "Workflows" },
  { href: "/payments", label: "Payments" },
  { href: "/settlements", label: "Settlements" },
  { href: "/schema", label: "Schema" },
] as const

export function SiteHeader() {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
      <div className="mx-auto flex w-full max-w-[1400px] flex-wrap items-center gap-x-8 gap-y-2 px-6 py-4">
        <Link href="/" className="text-xl font-bold tracking-tight">
          AgentDesk
        </Link>
        <nav aria-label="Main" className="flex flex-wrap items-center gap-x-6 gap-y-1 text-base">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "font-medium transition-colors hover:text-foreground",
                  active ? "text-foreground underline underline-offset-8" : "text-muted-foreground",
                )}
              >
                {item.label}
              </Link>
            )
          })}
        </nav>
        <SessionMenu />
      </div>
    </header>
  )
}
