"use client"

import { useState, type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { Toaster } from "../components/ui/sonner.tsx"
import { ExplorerProvider } from "../lib/explorer-context.tsx"

/**
 * The single client boundary for the whole app: React Query, the theme, the
 * explorer base URL, and toasts. Every page below it is free to be a server
 * component. Later stories add pages, not providers.
 */
export function Providers({ explorerUrl, children }: { explorerUrl: string; children: ReactNode }) {
  // One client per browser session; a new one per render would drop the cache.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // AD-12: freshness comes from the 2 s poll, not from refetching on
            // every window focus, which would double the request rate.
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 1_000,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>
      {/* Dark is the product's own look, not a preference: the palette is
          Binance's and Binance Agent OS is dark. `enableSystem` is off because
          following the OS would hand half the audience a theme nobody chose —
          including, on a borrowed laptop, the demo. Light is still defined and
          still reachable, so this is a default rather than a lock. */}
      <ThemeProvider
        attribute="class"
        defaultTheme="dark"
        enableSystem={false}
        disableTransitionOnChange
      >
        <ExplorerProvider value={explorerUrl}>
          {children}
          <Toaster position="top-right" richColors />
        </ExplorerProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
