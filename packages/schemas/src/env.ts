import type { z } from 'zod'

/**
 * Conventions: every process validates its env with Zod at boot and exits on
 * failure, naming the keys that failed. Pure Zod, no runtime dependency, so
 * every package may import it under AD-1.
 *
 * An empty value is dropped rather than passed through. `FOO=` in a `.env` file
 * or a compose `environment:` block means "not set" to everyone who writes one,
 * but it reaches the process as a present empty string, which turns an
 * `.optional()` field into a parse failure. `PUBLIC_BASE_URL=` is exactly that
 * case: empty is how AD-2 asks for a `data:` agentURI, and it used to stop the
 * worker from booting at all.
 */
export function defineEnv<T extends z.ZodType>(schema: T, source: NodeJS.ProcessEnv = process.env): z.infer<T> {
  const present: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && value.trim() !== '') present[key] = value
  }
  const parsed = schema.safeParse(present)
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
