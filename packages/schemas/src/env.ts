import type { z } from 'zod'

/**
 * Conventions: every process validates its env with Zod at boot and exits on
 * failure, naming the keys that failed. Pure Zod, no runtime dependency, so
 * every package may import it under AD-1.
 */
export function defineEnv<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const parsed = schema.safeParse(source)
  if (parsed.success) return parsed.data
  const lines = parsed.error.issues.map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
  process.stderr.write(`Invalid environment:\n${lines.join('\n')}\n`)
  process.exit(1)
}

/** Comma-separated list, e.g. RPC_URLS. */
export function csv(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}
