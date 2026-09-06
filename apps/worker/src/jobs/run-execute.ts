import type { JobDeps } from './listing-verify.ts'

/**
 * Registers `run.execute`.
 *
 * Story 1.8 implements the body: walk the Run's Calls in node order, do the
 * x402 handshake against the Price Lock, sign through `core/signing`, and drive
 * the Run state machine with compare-and-set writes from `running`.
 */
export async function registerRunJobs(deps: JobDeps): Promise<void> {
  deps.logger.warn('run.execute is not registered yet (Story 1.8)')
  await Promise.resolve()
}
