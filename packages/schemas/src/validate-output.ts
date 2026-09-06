import { typeSchemas, type AgentType } from './types/index.ts'

/**
 * FR-15 / AD-7 / AD-14. Shape validation plus every cross-field rule of PRD
 * addendum section 1. Both sides of the boundary call this: the agent runtime
 * before answering 200, and the engine before marking a Call `succeeded`.
 */

export type ValidationResult<T = unknown> =
  | { ok: true; value: T }
  | { ok: false; error: string; path?: string }

function fail(error: string, path?: string): ValidationResult<never> {
  return path === undefined ? { ok: false, error } : { ok: false, error, path }
}

function compare(a: string, b: string): number {
  const [aw = '0', af = ''] = a.split('.')
  const [bw = '0', bf = ''] = b.split('.')
  const width = Math.max(af.length, bf.length)
  const an = BigInt(aw + af.padEnd(width, '0'))
  const bn = BigInt(bw + bf.padEnd(width, '0'))
  return an === bn ? 0 : an < bn ? -1 : 1
}

export function validateInput<T extends AgentType>(type: T, input: unknown): ValidationResult {
  const parsed = typeSchemas[type].input.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return fail(issue?.message ?? 'invalid input', issue?.path.join('.'))
  }
  return { ok: true, value: parsed.data }
}

/**
 * `input` is the request that produced `output`; it carries the values the
 * cross-field rules compare against. Pass `undefined` when the input is not
 * available (the rules that need it are then skipped).
 */
export function validateOutput<T extends AgentType>(
  type: T,
  input: unknown,
  output: unknown,
): ValidationResult {
  const parsed = typeSchemas[type].output.safeParse(output)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return fail(issue?.message ?? 'invalid output', issue?.path.join('.'))
  }
  const value = parsed.data

  if (type === 'risk') {
    const risk = value as { decision: string; size_usdt: string }
    if (risk.decision === 'REJECT' && compare(risk.size_usdt, '0') !== 0) {
      return fail('size_usdt must be "0" for a REJECT decision', 'size_usdt')
    }
    const parsedInput = typeSchemas.risk.input.safeParse(input)
    if (parsedInput.success) {
      if (compare(risk.size_usdt, parsedInput.data.proposed_size_usdt) > 0) {
        return fail('size_usdt exceeds proposed_size_usdt', 'size_usdt')
      }
      if (compare(risk.size_usdt, parsedInput.data.balance_usdt) > 0) {
        return fail('size_usdt exceeds balance_usdt', 'size_usdt')
      }
    }
  }

  if (type === 'execution') {
    const exec = value as {
      status: string
      order_id?: string
      filled_price?: string
      filled_qty?: string
      reason?: string
    }
    if (exec.status === 'FILLED') {
      for (const field of ['order_id', 'filled_price', 'filled_qty'] as const) {
        if (exec[field] === undefined) return fail(`${field} is required when status is FILLED`, field)
      }
    } else if (exec.reason === undefined) {
      return fail('reason is required when status is REJECTED', 'reason')
    }
  }

  return { ok: true, value }
}
