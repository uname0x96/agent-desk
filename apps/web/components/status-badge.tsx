import { cn } from "cn"
import type { CallStatus } from "@agent-desk/schemas"

/**
 * One colour per status, shared by every view. The vocabulary is the PRD's
 * (packages/schemas/status.ts); nothing here invents a status.
 */

type Tone = "running" | "ok" | "warn" | "bad" | "idle"

const TONE_CLASS: Record<Tone, string> = {
  running: "bg-status-running/15 text-status-running ring-status-running/40",
  ok: "bg-status-ok/15 text-status-ok ring-status-ok/40",
  warn: "bg-status-warn/20 text-status-warn ring-status-warn/45",
  bad: "bg-status-bad/15 text-status-bad ring-status-bad/40",
  idle: "bg-muted text-muted-foreground ring-border",
}

const CALL_TONE: Record<CallStatus, Tone> = {
  pending: "idle",
  price_mismatch: "warn",
  payment_failed: "bad",
  paid_awaiting_result: "running",
  succeeded: "ok",
  failed_after_payment: "bad",
  skipped: "idle",
}

export function callStatusTone(status: CallStatus): Tone {
  return CALL_TONE[status] ?? "idle"
}

/** `failed at <Node>` is a template, so the Run status is matched, not looked up. */
export function runStatusTone(status: string): Tone {
  if (status === "running") return "running"
  if (status === "completed") return "ok"
  if (status === "completed, no order") return "warn"
  if (status === "timed out") return "bad"
  if (status.startsWith("failed at ")) return "bad"
  return "idle"
}

export function StatusBadge({
  status,
  tone,
  size = "default",
  className,
}: {
  status: string
  tone: Tone
  size?: "default" | "lg"
  className?: string
}) {
  return (
    <span
      data-status={status}
      className={cn(
        "inline-flex w-fit items-center gap-2 rounded-full font-semibold whitespace-nowrap ring-1 ring-inset",
        size === "lg" ? "px-4 py-1.5 text-base" : "px-2.5 py-0.5 text-sm",
        TONE_CLASS[tone],
        className,
      )}
    >
      {tone === "running" ? (
        <span className="size-2 animate-pulse rounded-full bg-current" aria-hidden />
      ) : null}
      {status}
    </span>
  )
}

export function CallStatusBadge({ status }: { status: CallStatus }) {
  return <StatusBadge status={status} tone={callStatusTone(status)} />
}

export function RunStatusBadge({ status, size }: { status: string; size?: "default" | "lg" }) {
  return <StatusBadge status={status} tone={runStatusTone(status)} {...(size ? { size } : {})} />
}
