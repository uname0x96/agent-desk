import { CopyButton } from "./copy-button.tsx"
import { cn } from "cn"

/**
 * A JSON payload as it went over the wire. Copyable, because the schema page
 * is meant to be pasted straight into an Agent.
 */
export function JsonBlock({
  value,
  title,
  emptyLabel = "—",
  className,
}: {
  value: unknown
  title?: string
  emptyLabel?: string
  className?: string
}) {
  const isEmpty = value === null || value === undefined
  const text = isEmpty ? emptyLabel : JSON.stringify(value, null, 2)

  return (
    <div className={cn("flex flex-col gap-2", className)}>
      {title || !isEmpty ? (
        <div className="flex items-center justify-between gap-4">
          {title ? (
            <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {title}
            </span>
          ) : (
            <span />
          )}
          {isEmpty ? null : <CopyButton value={text} />}
        </div>
      ) : null}
      <pre
        className={cn(
          "max-h-96 overflow-auto rounded-lg bg-muted p-4 font-mono text-[13px] leading-6 whitespace-pre",
          isEmpty && "text-muted-foreground",
        )}
      >
        {text}
      </pre>
    </div>
  )
}
