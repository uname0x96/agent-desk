"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { useRouter } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { meResponse, type MeResponse } from "@agent-desk/schemas"
import { AddressLink } from "../../components/chain-link.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { Separator } from "../../components/ui/separator.tsx"
import { apiFetch, errorMessage } from "../../lib/api.ts"
import { formatUsdt, formatUsdtLabelled } from "../../lib/format.ts"
import { meQueryKey } from "../../lib/session-query.ts"
import { formatBnbLabelled } from "./format-bnb.ts"
import { walletMeQueryOptions, walletStage, type WalletStage } from "./wallet-poll.ts"
import type { WalletBalances } from "./wallet-balances.ts"

/**
 * `/settings`: the System Wallet (Story 3.1) and the two settings a Builder
 * owns (Story 3.2), on one page, because sign-up lands here and the wallet is
 * still being provisioned when it does.
 *
 * AD-12: the wallet state polls `GET /api/me` every 2 s and stops the moment
 * `ready_at` is set. The balances are server-rendered, so the one refresh this
 * page asks for is the one that happens when the wallet becomes ready and there
 * are finally balances worth reading.
 */
export function SettingsView({
  initialMe,
  initialBalances,
}: {
  initialMe: MeResponse
  initialBalances: WalletBalances | null
}) {
  const { data: me = initialMe } = useQuery({
    ...walletMeQueryOptions(),
    initialData: initialMe,
  })

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Settings</h1>
        <p className="text-muted-foreground">
          Signed in as <span className="hash">{me.email}</span>.
        </p>
      </header>

      <WalletSection me={me} serverKnewReady={initialMe.wallet_ready_at !== null} balances={initialBalances} />

      <Separator />

      <BudgetSection me={me} />

      <Separator />

      <TelegramSection me={me} />
    </div>
  )
}

// ------------------------------------------------------------- system wallet

const STAGE_LABEL: Record<WalletStage, string> = {
  creating: "wallet preparing",
  provisioning: "wallet preparing",
  ready: "wallet ready",
}

const STAGE_DETAIL: Record<WalletStage, string> = {
  creating: "Generating the key and writing the wallet row. The address appears in about a second.",
  provisioning: "Funding it with BNB for gas and approving the registry to move tUSD.",
  ready: "The approval landed. This wallet can pay Agents and stake Listings.",
}

/**
 * The 30-second beat of the demo. The stage is spelled out rather than left to
 * a spinner: an address with no balances is a wallet that exists and cannot pay
 * yet, and that is worth saying out loud while a room watches it happen.
 */
function WalletSection({
  me,
  serverKnewReady,
  balances,
}: {
  me: MeResponse
  serverKnewReady: boolean
  balances: WalletBalances | null
}) {
  const router = useRouter()
  const stage = walletStage(me)
  const refreshed = useRef(false)

  // The balances come from the server render, so the first moment they are
  // worth reading is the moment the poll sees `ready_at`. One refresh, once.
  useEffect(() => {
    if (stage !== "ready" || serverKnewReady || refreshed.current) return
    refreshed.current = true
    router.refresh()
  }, [stage, serverKnewReady, router])

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">System Wallet</h2>
        <Badge variant={stage === "ready" ? "secondary" : "outline"} role="status" aria-live="polite">
          {STAGE_LABEL[stage]}
        </Badge>
      </div>

      <p className="text-sm text-muted-foreground">{STAGE_DETAIL[stage]}</p>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-lg p-4 ring-1 ring-border sm:grid-cols-3">
        <Fact label="Address">
          {me.wallet_address === null ? (
            <span className="text-muted-foreground">not yet</span>
          ) : (
            <AddressLink address={me.wallet_address} />
          )}
        </Fact>
        <Fact label="tUSD">
          {stage === "ready" && balances !== null ? (
            formatUsdtLabelled(balances.tusd)
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Fact>
        <Fact label="BNB (gas)">
          {stage === "ready" && balances !== null ? (
            formatBnbLabelled(balances.bnb)
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </Fact>
      </dl>

      {stage === "ready" && balances === null ? (
        <p role="status" className="text-sm text-muted-foreground">
          Balances are unavailable right now — the chain node did not answer. The wallet itself is
          ready.
        </p>
      ) : null}

      <p className="text-sm text-muted-foreground">
        AgentDesk holds the key for you, encrypted, and signs only inside the worker. It is never
        sent to this page and no endpoint returns it.
      </p>
    </section>
  )
}

// --------------------------------------------------------- daily fee budget

/**
 * FR-3. The budget is a cap per UTC day; the spend beneath it is the AD-3 query
 * over Calls, never a counter, which is why a Run in flight already shows up in
 * "spent" before it finishes.
 */
function BudgetSection({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient()
  const [budget, setBudget] = useState(() => formatUsdt(me.daily_fee_budget))
  const [saved, setSaved] = useState<"own" | "default" | null>(null)

  const save = useMutation({
    mutationFn: (daily_fee_budget: string | null) =>
      apiFetch("/api/me", meResponse, { method: "PATCH", body: { daily_fee_budget } }),
    onSuccess: (updated, variables) => {
      queryClient.setQueryData(meQueryKey, updated)
      setBudget(formatUsdt(updated.daily_fee_budget))
      setSaved(variables === null ? "default" : "own")
    },
  })

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Daily Fee Budget</h2>
      <p className="text-sm text-muted-foreground">
        The most this Account may pay Agents in one UTC day. A Run whose Price Lock costs more than
        what is left is refused before anything is paid.
      </p>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-lg p-4 ring-1 ring-border sm:grid-cols-3">
        <Fact label="Budget">{formatUsdtLabelled(me.daily_fee_budget)}</Fact>
        <Fact label="Spent this window">{formatUsdtLabelled(me.budget_spent)}</Fact>
        <Fact label="Remaining">{formatUsdtLabelled(me.budget_remaining)}</Fact>
      </dl>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          setSaved(null)
          save.mutate(budget.trim())
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="daily-fee-budget">New budget (tUSD)</Label>
          <Input
            id="daily-fee-budget"
            name="daily_fee_budget"
            inputMode="decimal"
            className="w-48"
            placeholder="1.00"
            value={budget}
            onChange={(event) => setBudget(event.target.value)}
            required
          />
        </div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save budget"}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={save.isPending}
          onClick={() => {
            setSaved(null)
            save.mutate(null)
          }}
        >
          Use the platform default
        </Button>
      </form>

      {saved !== null ? (
        <p role="status" className="text-sm text-muted-foreground">
          {saved === "default"
            ? "Cleared. This Account now follows the platform default."
            : "Budget saved."}
        </p>
      ) : null}

      {save.error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errorMessage(save.error)}
        </p>
      ) : null}
    </section>
  )
}

// ------------------------------------------------------------------ telegram

/** FR-32: the chat id the notifier sends this Account's Run summaries to. */
function TelegramSection({ me }: { me: MeResponse }) {
  const queryClient = useQueryClient()
  const [chatId, setChatId] = useState(me.telegram_chat_id ?? "")
  const [saved, setSaved] = useState(false)

  const save = useMutation({
    mutationFn: (telegram_chat_id: string | null) =>
      apiFetch("/api/me", meResponse, { method: "PATCH", body: { telegram_chat_id } }),
    onSuccess: (updated) => {
      queryClient.setQueryData(meQueryKey, updated)
      setChatId(updated.telegram_chat_id ?? "")
      setSaved(true)
    },
  })

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Telegram</h2>
      <p className="text-sm text-muted-foreground">
        Send <code className="mx-1 font-mono">/start</code> to the shared AgentDesk bot. It replies
        with your chat id; paste it here and every Run of yours reports its outcome there.
      </p>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          setSaved(false)
          const trimmed = chatId.trim()
          save.mutate(trimmed === "" ? null : trimmed)
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="telegram-chat-id">Chat id</Label>
          <Input
            id="telegram-chat-id"
            name="telegram_chat_id"
            inputMode="numeric"
            className="w-64"
            placeholder="123456789"
            value={chatId}
            onChange={(event) => setChatId(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save chat id"}
        </Button>
      </form>

      <p className="text-sm text-muted-foreground">
        {me.telegram_chat_id === null
          ? "No chat linked yet. Runs still complete; they just go unannounced."
          : `Linked to chat ${me.telegram_chat_id}.`}
      </p>

      {saved ? (
        <p role="status" className="text-sm text-muted-foreground">
          Saved.
        </p>
      ) : null}

      {save.error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errorMessage(save.error)}
        </p>
      ) : null}
    </section>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs tracking-wide text-muted-foreground uppercase">{label}</dt>
      <dd className="hash break-all">{children}</dd>
    </div>
  )
}
