"use client"

import { useState, type ReactNode } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { z } from "zod"
import {
  operatorAccountView,
  operatorAccountsResponse,
  publicSettings,
  type PlatformMode,
} from "@agent-desk/schemas"
import { AddressLink } from "../../components/chain-link.tsx"
import { Badge } from "../../components/ui/badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { Separator } from "../../components/ui/separator.tsx"
import { apiFetch, errorMessage } from "../../lib/api.ts"
import { formatUsdtLabelled } from "../../lib/format.ts"
import { publicSettingsQueryKey, publicSettingsQueryOptions } from "../../lib/session-query.ts"

/**
 * FR-45. Emergency Stop, the mode switch, and reset-budget-by-email, on one
 * page, so the demo can be steered live without a restart (AD-10).
 *
 * Every control writes through `/api/operator/*`, which checks `is_operator`
 * server-side, and then invalidates the settings query. The page shares the 2 s
 * `GET /api/settings/public` poll with the header, so the new state is on
 * screen within one refetch either way.
 */
export function OperatorControls() {
  const queryClient = useQueryClient()
  const settings = useQuery(publicSettingsQueryOptions(true))

  const patch = useMutation({
    mutationFn: (body: { emergency_stop?: boolean; mode?: PlatformMode }) =>
      apiFetch("/api/operator/settings", publicSettings, { method: "PATCH", body }),
    onSuccess: (updated) => {
      queryClient.setQueryData(publicSettingsQueryKey, updated)
    },
  })

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-10 px-6 py-12">
      <header className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Operator</h1>
        <p className="text-muted-foreground">
          Platform settings are one row in the database, read fresh by the worker every loop
          iteration and by the API on every request. Nothing here needs a restart.
        </p>
      </header>

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Emergency Stop</h2>
        <p className="text-sm text-muted-foreground">
          The execution agent reads this before every order and answers a paid, schema-valid
          <code className="mx-1 font-mono">REJECTED</code>
          while it is on.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Badge variant={settings.data?.emergency_stop ? "destructive" : "outline"} role="status">
            {settings.data === undefined
              ? "…"
              : settings.data.emergency_stop
                ? "Emergency Stop is ON"
                : "Emergency Stop is off"}
          </Badge>
          <Button
            variant={settings.data?.emergency_stop ? "outline" : "destructive"}
            disabled={settings.data === undefined || patch.isPending}
            onClick={() =>
              patch.mutate({ emergency_stop: !(settings.data?.emergency_stop ?? false) })
            }
          >
            {settings.data?.emergency_stop ? "Resume trading" : "Stop all trading"}
          </Button>
        </div>
      </section>

      <Separator />

      <section className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold">Mode</h2>
        <p className="text-sm text-muted-foreground">
          Demo mode shortens the Settlement Window to 20 seconds, polls it every 2 seconds, and
          scores research against the 24h trend (PRD addendum §6).
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <Badge variant={settings.data?.mode === "demo" ? "secondary" : "outline"} role="status">
            {settings.data?.mode ?? "…"} mode
          </Badge>
          <div className="flex gap-2">
            {(["production", "demo"] as const).map((mode) => (
              <Button
                key={mode}
                variant={settings.data?.mode === mode ? "default" : "outline"}
                disabled={settings.data === undefined || patch.isPending}
                onClick={() => patch.mutate({ mode })}
              >
                Switch to {mode}
              </Button>
            ))}
          </div>
        </div>
        {patch.error ? (
          <p role="alert" className="text-sm font-medium text-destructive">
            {errorMessage(patch.error)}
          </p>
        ) : null}
      </section>

      <Separator />

      <ResetBudget />
    </div>
  )
}

// ------------------------------------------------------------ reset budget

/**
 * `GET /api/operator/accounts?email=` resolves the typed email to an id, and
 * only then does `POST /api/operator/accounts/<id>/reset-budget` run. An email
 * with no Account says so and calls nothing.
 */
type OperatorAccountView = z.infer<typeof operatorAccountView>

function ResetBudget() {
  const [email, setEmail] = useState("")
  const [account, setAccount] = useState<OperatorAccountView | null>(null)
  const [notFound, setNotFound] = useState(false)

  const lookup = useMutation({
    mutationFn: (value: string) =>
      apiFetch(
        `/api/operator/accounts?email=${encodeURIComponent(value)}`,
        operatorAccountsResponse,
      ),
    onSuccess: (page) => {
      setAccount(page.items[0] ?? null)
      setNotFound(page.items.length === 0)
    },
  })

  const reset = useMutation({
    mutationFn: (accountId: string) =>
      apiFetch(`/api/operator/accounts/${encodeURIComponent(accountId)}/reset-budget`, operatorAccountView, {
        method: "POST",
      }),
    onSuccess: (updated) => {
      setAccount(updated)
    },
  })

  return (
    <section className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold">Daily Fee Budget</h2>
      <p className="text-sm text-muted-foreground">
        A reset moves the Account&apos;s budget window to now, so the spend query starts again from
        this moment.
      </p>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          setAccount(null)
          setNotFound(false)
          lookup.mutate(email)
        }}
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="account-email">Account email</Label>
          <Input
            id="account-email"
            type="email"
            className="w-80"
            placeholder="builder@agentdesk.local"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            required
          />
        </div>
        <Button type="submit" variant="outline" disabled={lookup.isPending}>
          Find account
        </Button>
      </form>

      {notFound ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          no such account
        </p>
      ) : null}

      {lookup.error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errorMessage(lookup.error)}
        </p>
      ) : null}

      {account ? (
        <div className="flex flex-col gap-3 rounded-lg p-4 ring-1 ring-border">
          <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm md:grid-cols-4">
            <Fact label="Account">{account.account_id}</Fact>
            <Fact label="Email">{account.email}</Fact>
            <Fact label="Wallet">
              {account.wallet_address ? <AddressLink address={account.wallet_address} /> : "—"}
            </Fact>
            <Fact label="Budget">{formatUsdtLabelled(account.daily_fee_budget)}</Fact>
            <Fact label="Spent this window">{formatUsdtLabelled(account.budget_spent)}</Fact>
          </dl>
          <div className="flex items-center gap-3">
            <Button
              onClick={() => reset.mutate(account.account_id)}
              disabled={reset.isPending}
            >
              Reset budget window
            </Button>
            {reset.isSuccess ? (
              <span role="status" className="text-sm text-muted-foreground">
                Window reset.
              </span>
            ) : null}
          </div>
          {reset.error ? (
            <p role="alert" className="text-sm font-medium text-destructive">
              {errorMessage(reset.error)}
            </p>
          ) : null}
        </div>
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
