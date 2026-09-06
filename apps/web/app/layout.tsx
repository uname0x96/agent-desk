import type { Metadata } from "next"
import type { ReactNode } from "react"
import { Inter, IBM_Plex_Mono } from "next/font/google"
import { Providers } from "./providers.tsx"
import { SiteHeader } from "../components/site-header.tsx"
import { explorerBaseUrl } from "../lib/explorer.ts"
import "./globals.css"

// Binance sets its UI in BinanceNova and its numerals in BinancePlex, neither of
// which is licensed for redistribution. Inter is the closest free grotesque, and
// BinancePlex derives from IBM Plex, so the mono side matches at the source.
const uiSans = Inter({ variable: "--font-ui-sans", subsets: ["latin"] })
const uiMono = IBM_Plex_Mono({
  variable: "--font-ui-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
})

export const metadata: Metadata = {
  title: "AgentDesk",
  description: "A marketplace where AI agents hire and pay each other per call.",
}

export default function RootLayout({ children }: { children: ReactNode }) {
  // EXPLORER_URL is server-side configuration; the client reads it from the
  // provider rather than from process.env.
  const explorerUrl = explorerBaseUrl()

  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${uiSans.variable} ${uiMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col text-[15px] leading-relaxed">
        <Providers explorerUrl={explorerUrl}>
          <SiteHeader />
          <main className="flex-1">{children}</main>
        </Providers>
      </body>
    </html>
  )
}
