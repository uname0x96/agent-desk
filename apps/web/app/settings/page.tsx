import type { Metadata } from "next"
import { redirect } from "next/navigation"
import { db } from "@agent-desk/db"
import { readMe } from "../../lib/accounts.ts"
import { requirePageSession, signInPath } from "../../lib/session.ts"
import { SettingsView } from "./settings-view.tsx"
import { readWalletBalances } from "./wallet-balances.ts"

export const metadata: Metadata = {
  title: "Settings · AgentDesk",
  description: "Your System Wallet, your Daily Fee Budget, and your Telegram chat id.",
}

/**
 * Stories 3.1 and 3.2. A signed-out visitor is sent to `/sign-in` and comes
 * back here; sign-up lands here directly, while the `wallet.create` job is
 * still running.
 *
 * The first paint is server-rendered from the row that was just inserted, so
 * there is no empty page between sign-up and the first poll, and the balances
 * are read on page load through the chain adapter (AD-1: the read half only).
 * From there the view polls `GET /api/me` every 2 s until `ready_at` is set.
 */
export const dynamic = "force-dynamic"

export default async function SettingsPage() {
  const session = await requirePageSession("/settings")

  const me = await readMe(db(), session.account_id)
  // The cookie names an Account that is gone; the next move is the sign-in page.
  if (!me) redirect(signInPath("/settings"))

  const balances = me.wallet_address === null ? null : await readWalletBalances(me.wallet_address)

  return <SettingsView initialMe={me} initialBalances={balances} />
}
