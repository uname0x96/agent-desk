"use client"

import { useEffect, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { AgentType, ListingResponse } from "@agent-desk/schemas"
import { violationsForNode } from "@agent-desk/core/workflow"
import { ChainGraph } from "../../components/workflow/chain-graph.tsx"
import { CostPreview } from "../../components/workflow/cost-preview.tsx"
import { ProviderPicker } from "../../components/workflow/provider-picker.tsx"
import { Button } from "../../components/ui/button.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { ApiError, errorMessage } from "../../lib/api.ts"
import { formatUsdt, TOKEN_LABEL } from "../../lib/format.ts"
import { meQueryOptions } from "../../lib/session-query.ts"
import { orderCapToDecimal } from "../api/workflows/workflows-view.ts"
import {
  FIXED_SYMBOL,
  TYPE_BLURB,
  TYPE_ORDER,
  builderStateFrom,
  emptyBuilderState,
  judgeChain,
  listingsById,
  providersForType,
  toSaveRequest,
  withMovedNode,
  withNode,
  withProvider,
  withoutNode,
  type BuilderState,
} from "./builder-state.ts"
import {
  createWorkflow,
  listingsQueryOptions,
  startRun,
  updateWorkflow,
  workflowQueryOptions,
  workflowsQueryKey,
} from "./queries.ts"

/**
 * Story 2.7, FR-4 and FR-17 to FR-22: compose a linear chain of typed Nodes,
 * see it validated and priced live, swap a Provider, save it, and run it.
 *
 * The chain lives in one `useState`. Every edit produces a new `BuilderState`
 * through the pure helpers in `builder-state.ts`, and the violations and the
 * cost preview are derived from that state on the same render — nothing is
 * fetched between a Provider swap and the new price, which is why the preview
 * cannot be a beat behind the chain.
 */
export function WorkflowBuilder({ workflowId }: { workflowId: string | null }) {
  const router = useRouter()
  const queryClient = useQueryClient()

  const listings = useQuery(listingsQueryOptions())
  const me = useQuery(meQueryOptions())
  const existing = useQuery({ ...workflowQueryOptions(workflowId ?? ""), enabled: workflowId !== null })

  const [state, setState] = useState<BuilderState>(emptyBuilderState)
  const [selected, setSelected] = useState<number | null>(null)
  const [loadedId, setLoadedId] = useState<string | null>(null)
  const [refusal, setRefusal] = useState<string | null>(null)

  // The one place the server's copy becomes the editor's copy, and only once
  // per Workflow: after that the Builder's edits win until they are saved.
  useEffect(() => {
    if (!existing.data || loadedId === existing.data.id) return
    setState(builderStateFrom(existing.data, orderCapToDecimal(existing.data.order_cap_usdt)))
    setLoadedId(existing.data.id)
  }, [existing.data, loadedId])

  const catalogue = useMemo<ListingResponse[]>(() => listings.data?.items ?? [], [listings.data])
  const byId = useMemo(() => listingsById(catalogue), [catalogue])
  const verdict = useMemo(
    () => judgeChain(state, catalogue, me.data?.budget_remaining ?? null),
    [state, catalogue, me.data?.budget_remaining],
  )

  const save = useMutation({
    mutationFn: async () => {
      const body = toSaveRequest(state)
      return workflowId === null ? createWorkflow(body) : updateWorkflow(workflowId, body)
    },
    onSuccess: async (saved) => {
      setRefusal(null)
      await queryClient.invalidateQueries({ queryKey: workflowsQueryKey })
      if (workflowId === null) router.replace(`/workflows/${saved.id}`)
    },
  })

  const saveAndRun = useMutation({
    mutationFn: async () => {
      const saved = await save.mutateAsync()
      return startRun(saved.id)
    },
    onSuccess: (run) => {
      setRefusal(null)
      router.push(`/runs/${run.id}`)
    },
    onError: (error) => setRefusal(describeRefusal(error)),
  })

  const busy = save.isPending || saveAndRun.isPending
  const graphNodes = state.nodes.map((node, index) => ({
    index,
    type: node.type,
    provider: byId.get(node.listing_id)?.name ?? null,
    price: byId.get(node.listing_id)?.price ?? null,
    violations: violationsForNode(verdict.violations, index).map((violation) => violation.message),
  }))

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-8 px-6 py-8">
      <header className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h1 className="text-4xl font-bold tracking-tight">
            {workflowId === null ? "New Workflow" : state.name || "Workflow"}
          </h1>
          <Link
            href="/workflows"
            className="text-base font-medium text-muted-foreground hover:text-foreground"
          >
            All Workflows
          </Link>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <Label htmlFor="workflow-name">Name</Label>
            <Input
              id="workflow-name"
              value={state.name}
              maxLength={80}
              placeholder="BNB momentum desk"
              onChange={(event) => setState({ ...state, name: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="workflow-symbol">Symbol</Label>
            <Input id="workflow-symbol" value={state.symbol} readOnly aria-readonly />
            <p className="text-xs text-muted-foreground">Fixed to {FIXED_SYMBOL} in this release.</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="workflow-order-cap">
              Order Cap (USDT){hasExecution(state) ? " · required" : ""}
            </Label>
            <Input
              id="workflow-order-cap"
              inputMode="decimal"
              value={state.orderCapUsdt}
              required={hasExecution(state)}
              placeholder="10"
              onChange={(event) => setState({ ...state, orderCapUsdt: event.target.value })}
            />
            <p className="text-xs text-muted-foreground">
              The largest order the execution Node may place, per Run.
            </p>
          </div>
        </div>
      </header>

      <ChainGraph nodes={graphNodes} selectedIndex={selected} onSelect={setSelected} />

      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(320px,1fr)]">
        <div className="flex flex-col gap-8">
          <NodeList
            state={state}
            graphNodes={graphNodes}
            selected={selected}
            onSelect={setSelected}
            onChange={setState}
          />
          <AddNode
            state={state}
            onAdd={(type) => {
              setState({ ...state, nodes: withNode(state.nodes, type) })
              setSelected(state.nodes.length)
            }}
          />
          {selected !== null && state.nodes[selected] ? (
            <section className="flex flex-col gap-4" aria-labelledby="provider-picker">
              <h2 id="provider-picker" className="text-xl font-semibold">
                Node {selected + 1} · {state.nodes[selected]!.type} Provider
              </h2>
              <p className="text-sm text-muted-foreground">
                {TYPE_BLURB[state.nodes[selected]!.type]}
              </p>
              {listings.isPending ? (
                <p className="text-base text-muted-foreground">Loading the marketplace…</p>
              ) : (
                <ProviderPicker
                  type={state.nodes[selected]!.type}
                  providers={providersForType(catalogue, state.nodes[selected]!.type)}
                  selectedId={state.nodes[selected]!.listing_id}
                  onPick={(listingId) =>
                    setState({ ...state, nodes: withProvider(state.nodes, selected, listingId) })
                  }
                />
              )}
            </section>
          ) : null}
        </div>

        <div className="flex flex-col gap-6 lg:sticky lg:top-24 lg:self-start">
          <CostPreview preview={verdict.preview} rows={graphNodes} />

          <div className="flex flex-col gap-3">
            <Button
              size="lg"
              className="h-12 text-base"
              disabled={busy || verdict.runBlockers.length > 0}
              onClick={() => saveAndRun.mutate()}
            >
              {saveAndRun.isPending ? "Starting…" : "Save and run"}
            </Button>
            <Button
              variant="outline"
              size="lg"
              className="h-12 text-base"
              disabled={busy || verdict.saveBlockers.length > 0}
              onClick={() => {
                setRefusal(null)
                save.mutate()
              }}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>

            {verdict.runBlockers.length > 0 ? (
              <ul className="flex flex-col gap-1 text-sm font-medium text-muted-foreground">
                {verdict.runBlockers.map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
              </ul>
            ) : null}

            {refusal ?? (save.error && !saveAndRun.isPending ? errorMessage(save.error) : null) ? (
              <p
                role="alert"
                className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-semibold text-status-bad ring-1 ring-status-bad/40 ring-inset"
              >
                {refusal ?? errorMessage(save.error)}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

// ------------------------------------------------------------- the chain

interface GraphNode {
  index: number
  type: AgentType
  provider: string | null
  price: string | null
  violations: string[]
}

function NodeList({
  state,
  graphNodes,
  selected,
  onSelect,
  onChange,
}: {
  state: BuilderState
  graphNodes: readonly GraphNode[]
  selected: number | null
  onSelect: (index: number | null) => void
  onChange: (state: BuilderState) => void
}) {
  if (state.nodes.length === 0) return null

  return (
    <section className="flex flex-col gap-3" aria-labelledby="chain-nodes">
      <h2 id="chain-nodes" className="text-xl font-semibold">
        The chain
      </h2>
      <ol className="flex flex-col gap-2">
        {graphNodes.map((node) => (
          <li
            key={node.index}
            className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3 ring-1 ring-border ring-inset"
          >
            <button
              type="button"
              onClick={() => onSelect(node.index)}
              aria-pressed={selected === node.index}
              className="flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left"
            >
              <span className="text-xs font-bold tracking-widest text-muted-foreground uppercase">
                {node.index + 1} · {node.type}
              </span>
              <span className="text-lg font-semibold">
                {node.provider ?? <span className="text-muted-foreground italic">no Provider</span>}
              </span>
              {node.violations.length > 0 ? (
                <span role="alert" className="text-sm font-semibold text-status-bad">
                  {node.violations.join(" · ")}
                </span>
              ) : null}
            </button>
            <span className="text-base font-semibold tabular-nums">
              {node.price === null ? "—" : `${formatUsdt(node.price)} ${TOKEN_LABEL}`}
            </span>
            <div className="flex gap-1">
              <Button
                variant="outline"
                size="sm"
                aria-label={`Move Node ${node.index + 1} earlier`}
                disabled={node.index === 0}
                onClick={() =>
                  onChange({ ...state, nodes: withMovedNode(state.nodes, node.index, -1) })
                }
              >
                ↑
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label={`Move Node ${node.index + 1} later`}
                disabled={node.index === state.nodes.length - 1}
                onClick={() =>
                  onChange({ ...state, nodes: withMovedNode(state.nodes, node.index, 1) })
                }
              >
                ↓
              </Button>
              <Button
                variant="destructive"
                size="sm"
                aria-label={`Remove Node ${node.index + 1}`}
                onClick={() => {
                  onChange({ ...state, nodes: withoutNode(state.nodes, node.index) })
                  onSelect(null)
                }}
              >
                Remove
              </Button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  )
}

function AddNode({
  state,
  onAdd,
}: {
  state: BuilderState
  onAdd: (type: AgentType) => void
}) {
  const used = new Set(state.nodes.map((node) => node.type))

  return (
    <section className="flex flex-col gap-3" aria-labelledby="add-node">
      <h2 id="add-node" className="text-xl font-semibold">
        Add a Node
      </h2>
      <div className="flex flex-wrap gap-2">
        {TYPE_ORDER.map((type) => (
          <Button
            key={type}
            variant="outline"
            size="lg"
            className="h-11 text-base"
            disabled={used.has(type)}
            onClick={() => onAdd(type)}
          >
            + {type}
          </Button>
        ))}
      </div>
      <p className="text-sm text-muted-foreground">
        A Type may appear once. data feeds research, research feeds risk, risk feeds execution, and
        notify is always last.
      </p>
    </section>
  )
}

function hasExecution(state: BuilderState): boolean {
  return state.nodes.some((node) => node.type === "execution")
}

/**
 * FR-22 and AD-4: the four refusals `POST /api/runs` can answer, in the words
 * the acceptance criteria use. `run_in_progress` in particular must not
 * navigate anywhere — the Builder stays on the builder and reads why.
 */
export function describeRefusal(error: unknown): string {
  if (!(error instanceof ApiError)) return errorMessage(error)
  switch (error.code) {
    case "run_in_progress":
      return "A Run of this Workflow is still running."
    case "refused_budget": {
      const shortfall = error.details?.shortfall
      return typeof shortfall === "string"
        ? `Over the remaining Daily Fee Budget by ${formatUsdt(shortfall)} ${TOKEN_LABEL}.`
        : "The chain does not fit in the remaining Daily Fee Budget."
    }
    case "refused_balance":
      return "The System Wallet does not hold enough tUSD for this chain."
    case "wallet_not_ready":
      return "The System Wallet is not ready to pay yet. Try again in a moment."
    default:
      return errorMessage(error)
  }
}
