import { z } from 'zod'

/**
 * AD-14: the fixed error codes. snake_case, new codes are added here and
 * nowhere else, so five builders never invent a sixth spelling.
 */
export const ERROR_CODES = [
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'run_in_progress',
  'wallet_not_ready',
  'refused_budget',
  'refused_balance',
  'refused_stake',
  'refused_execution_type',
  'verification_failed',
  'internal_error',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]
export const errorCodeSchema = z.enum(ERROR_CODES)

export const errorEnvelope = z.object({
  error: z.object({
    code: errorCodeSchema,
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  }),
})
export type ErrorEnvelope = z.infer<typeof errorEnvelope>

/** The HTTP status each code answers with, so no route picks its own. */
export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  run_in_progress: 409,
  wallet_not_ready: 409,
  refused_budget: 409,
  refused_balance: 409,
  refused_stake: 409,
  refused_execution_type: 409,
  verification_failed: 409,
  internal_error: 500,
}

export function apiError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ErrorEnvelope {
  return { error: details === undefined ? { code, message } : { code, message, details } }
}
