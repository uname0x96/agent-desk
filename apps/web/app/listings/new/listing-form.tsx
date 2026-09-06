"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useMutation, useQuery } from "@tanstack/react-query"
import { cn } from "cn"
import type { AgentType } from "@agent-desk/schemas"
import type { FieldErrors, FieldName } from "../../api/listings/listing-rules.ts"
import { Button } from "../../../components/ui/button.tsx"
import { Input } from "../../../components/ui/input.tsx"
import { Label } from "../../../components/ui/label.tsx"
import { ApiError, errorMessage } from "../../../lib/api.ts"
import { TOKEN_LABEL } from "../../../lib/format.ts"
import {
  EMPTY_LISTING_FORM,
  formErrors,
  hasErrors,
  listingCost,
  offeredTypes,
  prefillFrom,
  toCreateRequest,
  withPrice,
  type ListingFormValues,
} from "../listing-form-state.ts"
import { listingQueryOptions, submitListing } from "../listing-query.ts"

/**
 * FR-10: the form a Creator fills in to put an Agent on the Registry.
 *
 * The rules are `listing-form-state.ts`, which is `POST /api/listings`' own
 * validator — so a refusal reads the same before and after the request, and the
 * form cannot drift from the route. What is here is the arrangement: the Type
 * before anything else, because it decides which sample the verification Call
 * will send; the price and the Stake next to each other, because one defaults
 * from the other; and the two amounts that leave a wallet stated plainly above
 * the button rather than discovered afterwards.
 *
 * On success this goes straight to `/listings/<id>`, which is where the Creator
 * watches the verification Call, the identity and the Stake land.
 */

const TYPE_HINT: Record<AgentType, string> = {
  data: "a market price, or another fact. Cheap, called first.",
  research: "a view on a symbol. Scored against the market afterwards.",
  risk: "a position size. Scored against the market afterwards.",
  execution: "places a real order. Only the Platform Account may list one.",
  notify: "sends the summary. Called last.",
}

export function ListingForm({ canListExecution }: { canListExecution: boolean }) {
  const router = useRouter()
  const params = useSearchParams()
  const resubmitOf = params.get("from")

  const [values, setValues] = useState<ListingFormValues>(EMPTY_LISTING_FORM)
  const [stakeTouched, setStakeTouched] = useState(false)
  const [attempted, setAttempted] = useState(false)

  // FR-12: "fix and resubmit" opens this form on the Listing that failed. The
  // poll stops on arrival, because a failed Listing never changes again.
  const previous = useQuery({ ...listingQueryOptions(resubmitOf ?? ""), enabled: resubmitOf !== null })
  const previousData = previous.data
  useEffect(() => {
    if (previousData === undefined) return
    setValues(prefillFrom(previousData))
    setStakeTouched(true)
  }, [previousData])

  const submit = useMutation({
    mutationFn: () => submitListing(toCreateRequest(values)),
    onSuccess: (listingId) => router.push(`/listings/${listingId}`),
  })

  const local = formErrors(values)
  const errors: FieldErrors = attempted ? { ...serverErrors(submit.error), ...local } : {}
  const cost = listingCost(values)
  const types = offeredTypes(canListExecution)

  return (
    <form
      className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-6 py-8"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        setAttempted(true)
        if (hasErrors(local)) return
        submit.mutate()
      }}
    >
      <header className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">List an Agent</h1>
        <p className="max-w-2xl text-lg text-muted-foreground">
          {resubmitOf === null
            ? "Paste the endpoint. The platform makes one real paid Call to it, mints an ERC-8004 identity, and locks your Stake in the Registry — in that order, and only if the Call conforms."
            : "Fix what the verification Call refused and submit again. This creates a new Listing; the old one stays failed."}
        </p>
      </header>

      <Field
        label="Name"
        htmlFor="name"
        error={errors.name}
        hint="What a Builder sees on the marketplace card."
      >
        <Input
          id="name"
          name="name"
          required
          maxLength={80}
          value={values.name}
          onChange={(event) => setValues({ ...values, name: event.target.value })}
        />
      </Field>

      <fieldset className="flex flex-col gap-3">
        <legend className="text-sm font-medium">Type</legend>
        <p className="text-sm text-muted-foreground">
          The Type decides the request the verification Call sends and the output schema the answer
          has to match.
        </p>
        <div className="flex flex-wrap gap-2">
          {types.map((type) => (
            <button
              key={type}
              type="button"
              aria-pressed={values.type === type}
              onClick={() => setValues({ ...values, type })}
              className={cn(
                "rounded-full px-4 py-1.5 text-sm font-semibold ring-1 ring-inset transition-colors",
                values.type === type
                  ? "bg-foreground text-background ring-foreground"
                  : "bg-transparent text-muted-foreground ring-border hover:text-foreground",
              )}
            >
              {type}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{TYPE_HINT[values.type]}</p>
      </fieldset>

      <Field
        label="Endpoint"
        htmlFor="endpoint"
        error={errors.endpoint}
        hint="https://, or http:// for localhost, 127.0.0.1, host.docker.internal and compose service names. The worker calls this from its own container, so it has to resolve there."
      >
        <Input
          id="endpoint"
          name="endpoint"
          inputMode="url"
          placeholder="http://host.docker.internal:4103"
          required
          value={values.endpoint}
          onChange={(event) => setValues({ ...values, endpoint: event.target.value })}
        />
      </Field>

      <div className="grid gap-6 md:grid-cols-2">
        <Field
          label={`Price per call (${TOKEN_LABEL})`}
          htmlFor="price"
          error={errors.price}
          hint="More than 0, at most 1."
        >
          <Input
            id="price"
            name="price"
            inputMode="decimal"
            placeholder="0.03"
            required
            value={values.price}
            onChange={(event) => setValues(withPrice(values, event.target.value, stakeTouched))}
          />
        </Field>

        <Field
          label={`Stake (${TOKEN_LABEL})`}
          htmlFor="stake"
          error={errors.stake}
          hint="At least ten times the price. Pulled from your System Wallet when the Listing goes on chain, and slashable if your Agent is wrong."
        >
          <Input
            id="stake"
            name="stake"
            inputMode="decimal"
            required
            value={values.stake}
            onChange={(event) => {
              setStakeTouched(true)
              setValues({ ...values, stake: event.target.value })
            }}
          />
        </Field>
      </div>

      <Field
        label="Description"
        htmlFor="description"
        error={undefined}
        hint="Optional. One or two lines on the card."
      >
        <textarea
          id="description"
          name="description"
          rows={2}
          maxLength={500}
          value={values.description}
          onChange={(event) => setValues({ ...values, description: event.target.value })}
          className="w-full rounded-lg border border-input bg-transparent px-3 py-2 text-base outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
      </Field>

      <Field
        label="Payout wallet"
        htmlFor="payout_wallet"
        error={errors.payout_wallet}
        hint="Optional. Defaults to your System Wallet. Every Call to this Agent is paid here, and the verification Call is the first one."
      >
        <Input
          id="payout_wallet"
          name="payout_wallet"
          placeholder="0x…"
          value={values.payoutWallet}
          onChange={(event) => setValues({ ...values, payoutWallet: event.target.value })}
        />
      </Field>

      <CostSummary stake={cost.stake} maxVerification={cost.maxVerification} />

      {attempted && submit.error ? (
        <p
          role="alert"
          className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-medium text-status-bad ring-1 ring-status-bad/40 ring-inset"
        >
          {refusalMessage(submit.error)}
        </p>
      ) : null}

      <div className="flex items-center gap-4">
        <Button type="submit" size="lg" disabled={submit.isPending}>
          {submit.isPending ? "Submitting…" : "List it"}
        </Button>
        <p className="text-sm text-muted-foreground">
          Nothing is signed until the verification Call is paid for and conforms.
        </p>
      </div>
    </form>
  )
}

// -------------------------------------------------------------------- parts

function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
}: {
  label: string
  htmlFor: string
  hint: string
  error: string | undefined
  children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {error}
        </p>
      ) : (
        <p className="text-sm text-muted-foreground">{hint}</p>
      )}
    </div>
  )
}

/**
 * The two amounts a Creator is entitled to know before they press the button:
 * what leaves their wallet, and the ceiling on what the platform spends proving
 * their Agent works (FR-11 — one Call, at the price they declared).
 */
function CostSummary({
  stake,
  maxVerification,
}: {
  stake: string | null
  maxVerification: string | null
}) {
  return (
    <dl className="grid gap-px overflow-hidden rounded-xl bg-border ring-1 ring-border sm:grid-cols-2">
      <div className="flex flex-col gap-1 bg-card px-4 py-3">
        <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Stake pulled from your System Wallet
        </dt>
        <dd className="text-2xl font-semibold tabular-nums">
          {stake === null ? "—" : `${stake} ${TOKEN_LABEL}`}
        </dd>
      </div>
      <div className="flex flex-col gap-1 bg-card px-4 py-3">
        <dt className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          Most the verification Call can cost
        </dt>
        <dd className="text-2xl font-semibold tabular-nums">
          {maxVerification === null ? "—" : `${maxVerification} ${TOKEN_LABEL}`}
        </dd>
        <dd className="text-sm text-muted-foreground">
          Paid by the platform to your payout wallet, at the price you declared.
        </dd>
      </div>
    </dl>
  )
}

// ------------------------------------------------------------------- errors

/** 400 `validation_failed` carries `details.fields`, keyed by form field. */
function serverErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiError) || error.code !== "validation_failed") return {}
  const fields = error.details?.fields
  if (typeof fields !== "object" || fields === null) return {}

  const out: FieldErrors = {}
  for (const [field, message] of Object.entries(fields as Record<string, unknown>)) {
    if (typeof message === "string") out[field as FieldName] = message
  }
  return out
}

function refusalMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "validation_failed") {
    return "Some fields need fixing."
  }
  return errorMessage(error)
}
