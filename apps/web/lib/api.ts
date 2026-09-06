import type { z } from 'zod'
import { errorEnvelope, type ErrorCode } from '@agent-desk/schemas'

/**
 * The one way the web app talks to `/api/*`. Every response is parsed with the
 * schema that defines it in `packages/schemas` (AD-14), and every failure
 * arrives as an `ApiError` carrying the shared envelope's code, so callers
 * never branch on a raw status.
 */

export class ApiError extends Error {
  readonly code: ErrorCode | 'network_error' | 'malformed_response'
  readonly status: number
  readonly details: Record<string, unknown> | undefined

  constructor(
    code: ErrorCode | 'network_error' | 'malformed_response',
    message: string,
    status: number,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.status = status
    this.details = details
  }

  /** True when retrying cannot help, so a poll should stop. */
  get isTerminal(): boolean {
    return this.code === 'not_found' || this.code === 'unauthorized' || this.code === 'forbidden'
  }
}

export interface ApiRequest {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  body?: unknown
  signal?: AbortSignal
}

/** GET/POST `path` and parse the answer with `schema`. */
export async function apiFetch<Schema extends z.ZodType>(
  path: string,
  schema: Schema,
  request: ApiRequest = {},
): Promise<z.infer<Schema>> {
  const { method = 'GET', body, signal } = request

  let response: Response
  try {
    response = await fetch(path, {
      method,
      signal: signal ?? null,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
    })
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') throw cause
    throw new ApiError('network_error', `could not reach ${path}`, 0)
  }

  const payload = await readJson(response)

  if (!response.ok) throw toApiError(payload, response.status)

  const parsed = schema.safeParse(payload)
  if (!parsed.success) {
    throw new ApiError('malformed_response', `${path} did not match its schema`, response.status, {
      issues: parsed.error.issues,
    })
  }
  return parsed.data
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (text.length === 0) return null
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

/** Statuses a route can produce without going through the error envelope. */
const STATUS_FALLBACK: Record<number, ErrorCode> = {
  401: 'unauthorized',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  500: 'internal_error',
}

/** Every error route answers `{ error: { code, message, details? } }`. */
function toApiError(payload: unknown, status: number): ApiError {
  const parsed = errorEnvelope.safeParse(payload)
  if (parsed.success) {
    const { code, message, details } = parsed.data.error
    return new ApiError(code, message, status, details)
  }
  // A framework 404 or a proxy error page has no envelope, so fall back to the
  // status. A poll must still be able to tell "gone" from "try again".
  const fallback = STATUS_FALLBACK[status]
  if (fallback !== undefined) {
    return new ApiError(fallback, `request failed with status ${status}`, status)
  }
  return new ApiError('malformed_response', `request failed with status ${status}`, status)
}

/** Turns an unknown thrown value into something safe to show a human. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message
  if (error instanceof Error) return error.message
  return 'Something went wrong.'
}
