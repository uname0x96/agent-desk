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
      <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
        <ExplorerProvider value={explorerUrl}>
          {children}
          <Toaster position="top-right" richColors />
        </ExplorerProvider>
      </ThemeProvider>
    </QueryClientProvider>
  )
}
