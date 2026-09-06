"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMutation, useQuery } from "@tanstack/react-query"
import { baseUnitsToString, sumBaseUnits, type WorkflowResponse } from "@agent-desk/schemas"
import { RunStatusBadge } from "../../components/status-badge.tsx"
import { Button } from "../../components/ui/button.tsx"
import { errorMessage } from "../../lib/api.ts"
import { formatUsdt, TOKEN_LABEL } from "../../lib/format.ts"
import { describeRefusal } from "./workflow-builder.tsx"
import { startRun, workflowsQueryOptions } from "./queries.ts"

/**
 * FR-22: the Builder's Workflows, each with its chain, its max cost and the
 * status of its last Run, and a run action that calls `POST /api/runs` and
 * navigates to the live view.
 *
 * A 409 `run_in_progress` is the one refusal that must not navigate: the row
 * says "A Run of this Workflow is still running." and the page stays where it
 * is, so nobody watches a second Run that was never started.
 */
export function WorkflowList() {
  const { data, isPending, error } = useQuery(workflowsQueryOptions())

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-8 px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-4xl font-bold tracking-tight">Workflows</h1>
          <p className="text-muted-foreground">
            A Workflow is a linear chain of typed Nodes, each bound to a Provider from the
            marketplace.
          </p>
        </div>
        <Button size="lg" className="h-12 text-base" render={<Link href="/workflows/new" />}>
          New Workflow
        </Button>
      </header>

      {isPending ? <p className="text-lg text-muted-foreground">Loading…</p> : null}

      {error ? (
        <p role="alert" className="text-lg font-semibold text-status-bad">
          {errorMessage(error)}
        </p>
      ) : null}

      {data && data.items.length === 0 ? (
        <p className="rounded-xl border-2 border-dashed border-border px-6 py-12 text-center text-lg text-muted-foreground">
          No Workflows yet. Build the first one.
        </p>
      ) : null}

      <ul className="flex flex-col gap-4">
        {data?.items.map((workflow) => (
          <WorkflowRow key={workflow.id} workflow={workflow} />
        ))}
      </ul>
    </div>
  )
}

function WorkflowRow({ workflow }: { workflow: WorkflowResponse }) {
  const router = useRouter()
  const [refusal, setRefusal] = useState<string | null>(null)

  const run = useMutation({
    mutationFn: () => startRun(workflow.id),
    onSuccess: (started) => router.push(`/runs/${started.id}`),
    onError: (error) => setRefusal(describeRefusal(error)),
  })

  const total = baseUnitsToString(sumBaseUnits(workflow.nodes.map((node) => node.price)))

  return (
    <li className="flex flex-col gap-4 rounded-xl bg-card px-6 py-5 ring-1 ring-border ring-inset">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-2">
          <Link
            href={`/workflows/${workflow.id}`}
            className="text-2xl font-bold tracking-tight hover:underline"
          >
            {workflow.name}
          </Link>
          <p className="text-sm text-muted-foreground">
            {workflow.symbol} · {workflow.nodes.length}{" "}
            {workflow.nodes.length === 1 ? "Node" : "Nodes"}
            {workflow.order_cap_usdt === null
              ? ""
              : ` · Order Cap ${formatUsdt(workflow.order_cap_usdt)} USDT`}
          </p>
          <ol className="flex flex-wrap items-center gap-2">
            {workflow.nodes.map((node) => (
              <li
                key={node.node_index}
                data-node-type={node.type}
                className="flex items-baseline gap-2 rounded-lg bg-muted px-3 py-1"
              >
                <span className="text-xs font-bold tracking-widest uppercase">{node.type}</span>
                <span className="text-sm">{node.provider}</span>
                <span className="text-sm font-semibold tabular-nums">
                  {formatUsdt(node.price)}
                </span>
              </li>
            ))}
          </ol>
        </div>

        <div className="flex flex-col items-end gap-3">
          <div className="flex flex-col items-end gap-1">
            <span className="text-xs font-semibold tracking-widest text-muted-foreground uppercase">
              Max cost
            </span>
            <span className="text-2xl font-bold tabular-nums">
              {formatUsdt(total)}
              <span className="ml-1 text-base font-semibold text-muted-foreground">
                {TOKEN_LABEL}
              </span>
            </span>
          </div>
          {workflow.last_run_status === null ? (
            <span className="text-sm text-muted-foreground">never run</span>
          ) : (
            <RunStatusBadge status={workflow.last_run_status} />
          )}
          <div className="flex gap-2">
            <Button variant="outline" render={<Link href={`/workflows/${workflow.id}`} />}>
              Edit
            </Button>
            <Button
              size="lg"
              className="h-11 text-base"
              disabled={run.isPending}
              onClick={() => {
                setRefusal(null)
                run.mutate()
              }}
            >
              {run.isPending ? "Starting…" : "Run"}
            </Button>
          </div>
        </div>
      </div>

      {refusal ? (
        <p
          role="alert"
          className="rounded-lg bg-status-bad/10 px-4 py-3 text-base font-semibold text-status-bad ring-1 ring-status-bad/40 ring-inset"
        >
          {refusal}
        </p>
      ) : null}
    </li>
  )
}
