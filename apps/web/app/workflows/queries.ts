import {
  listingsResponse,
  runResponse,
  workflowResponse,
  type ListingResponse,
  type RunResponse,
  type SaveWorkflowRequest,
  type WorkflowResponse,
} from '@agent-desk/schemas'
import { apiFetch, type ApiRequest } from '../../lib/api.ts'
import { workflowsResponse } from '../api/workflows/workflows-view.ts'

/**
 * The reads and writes the Workflow pages make, on the shared `apiFetch` so
 * every response is parsed with the schema that defines it (AD-14).
 *
 * The whole marketplace is fetched once and filtered by Type in the browser
 * rather than once per Type. `GET /api/listings` takes no `type` parameter yet
 * — its own comment reserves that for Story 3.5 — and even when it does, one
 * request for a page that offers five Type pickers beats five, and the builder
 * needs every Listing anyway to price a chain whose Nodes span all five Types.
 */

export const MARKETPLACE_PAGE_SIZE = 100

export const listingsQueryKey = ['listings', 'marketplace'] as const
export const workflowsQueryKey = ['workflows'] as const

export function workflowQueryKey(workflowId: string): readonly unknown[] {
  return ['workflow', workflowId]
}

export function listingsQueryOptions() {
  return {
    queryKey: listingsQueryKey,
    queryFn: ({ signal }: { signal?: AbortSignal }): Promise<{ items: ListingResponse[] }> =>
      apiFetch(`/api/listings?limit=${MARKETPLACE_PAGE_SIZE}`, listingsResponse, { signal }),
    staleTime: 5_000,
  }
}

export function workflowsQueryOptions() {
  return {
    queryKey: workflowsQueryKey,
    queryFn: ({ signal }: { signal?: AbortSignal }) =>
      apiFetch('/api/workflows', workflowsResponse, { signal }),
    staleTime: 0,
  }
}

export function workflowQueryOptions(workflowId: string) {
  return {
    queryKey: workflowQueryKey(workflowId),
    queryFn: ({ signal }: { signal?: AbortSignal }): Promise<WorkflowResponse> =>
      apiFetch(`/api/workflows/${encodeURIComponent(workflowId)}`, workflowResponse, { signal }),
    staleTime: 0,
  }
}

/**
 * `PUT /api/workflows/<id>` (FR-20).
 *
 * `ApiRequest.method` in `lib/api.ts` lists GET, POST, PATCH and DELETE. That
 * module is Story 2.1's and is not this story's to edit, so the method is
 * widened here, once, at the only call site in the app that needs it; the union
 * should grow a `PUT` the next time `lib/api.ts` is opened. Everything else
 * about the request — the envelope, the parse, the `ApiError` — is unchanged.
 */
const PUT = 'PUT' as unknown as NonNullable<ApiRequest['method']>

export function updateWorkflow(
  workflowId: string,
  body: SaveWorkflowRequest,
): Promise<WorkflowResponse> {
  return apiFetch(`/api/workflows/${encodeURIComponent(workflowId)}`, workflowResponse, {
    method: PUT,
    body,
  })
}

export function createWorkflow(body: SaveWorkflowRequest): Promise<WorkflowResponse> {
  return apiFetch('/api/workflows', workflowResponse, { method: 'POST', body })
}

/** FR-22: the run action on both the list and the builder. */
export function startRun(workflowId: string): Promise<RunResponse> {
  return apiFetch('/api/runs', runResponse, {
    method: 'POST',
    body: { workflow_id: workflowId },
  })
}
