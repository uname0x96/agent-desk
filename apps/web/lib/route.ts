import { NextResponse } from 'next/server'
import type { z } from 'zod'
import { ERROR_STATUS, apiError, type ErrorCode } from '@agent-desk/schemas'

/**
 * The three things every route in this app does with HTTP: answer JSON that is
 * never cached, answer the shared error envelope with the status `ERROR_STATUS`
 * fixes for its code (AD-14), and parse a request body with the schema that
 * defines it.
 */

export const NO_STORE = { 'cache-control': 'no-store' } as const

export function jsonOk(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE })
}

export function jsonError(
  code: ErrorCode,
  message: string,
  details?: Record<string, unknown>,
): NextResponse {
  return NextResponse.json(apiError(code, message, details), {
    status: ERROR_STATUS[code],
    headers: NO_STORE,
  })
}

export type BodyResult<T> = { ok: true; data: T } | { ok: false; response: NextResponse }

/** A body that is not JSON, or not the shape, is 400 `validation_failed`. */
export async function readBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<BodyResult<z.infer<Schema>>> {
  let payload: unknown
  try {
    payload = await request.json()
  } catch {
    return { ok: false, response: jsonError('validation_failed', 'the body is not JSON') }
  }

  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    return {
      ok: false,
      response: jsonError('validation_failed', 'the body did not match its schema', {
        issues: parsed.error.issues,
      }),
    }
  }
  return { ok: true, data: parsed.data }
}
