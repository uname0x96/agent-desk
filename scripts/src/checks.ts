import { bnbToWei, weiToBnb } from '@agent-desk/core/signing'

/**
 * The checks `pnpm doctor` prints and `pnpm seed` refuses on.
 *
 * They live in one module because the two scripts must agree: the seed's "every
 * gas-paying key is funded" refusal and the doctor's BNB floor lines are the
 * same three comparisons, and a demo that passes the doctor but is refused by
 * the seed would be worse than either failing alone.
 *
 * Everything here is a pure function of values the caller fetched, or a probe
 * that returns a `Check` instead of throwing. A check never crashes the script;
 * an unreachable host is a failed check with the reason in `detail`, which is
 * what makes `pnpm doctor` useful precisely when something is broken.
 */

export interface Check {
  name: string
  ok: boolean
  /** One line, printed after the name. Says the number, not just "failed". */
  detail: string
}

export const PASS = 'PASS'
export const FAIL = 'FAIL'

export function formatCheck(check: Check): string {
  return `${check.ok ? PASS : FAIL}  ${check.name.padEnd(34)} ${check.detail}`
}

export function formatChecks(checks: readonly Check[]): string {
  return checks.map(formatCheck).join('\n')
}

export function failures(checks: readonly Check[]): Check[] {
  return checks.filter((check) => !check.ok)
}

// ------------------------------------------------------------- BNB floors

export interface FloorTarget {
  /** What the line calls it: "Platform Wallet", "relayer", "Creator <address>". */
  label: string
  address: string
  /** Decimal BNB, from the env. */
  floorBnb: string
}

/**
 * FR-2 / AD-5: a key that cannot pay for gas cannot do its job, and the failure
 * would surface as a reverted intent halfway through a demo. Both scripts check
 * the floor up front instead.
 */
export async function checkFloors(
  targets: readonly FloorTarget[],
  nativeBalance: (address: string) => Promise<bigint>,
): Promise<Check[]> {
  const checks: Check[] = []
  for (const target of targets) {
    const name = `BNB floor: ${target.label}`
    try {
      const balance = await nativeBalance(target.address)
      const floor = bnbToWei(target.floorBnb)
      checks.push({
        name,
        ok: balance >= floor,
        detail:
          `${target.address} holds ${weiToBnb(balance)} BNB against a floor of ${target.floorBnb} BNB` +
          (balance >= floor ? '' : ` (short ${weiToBnb(floor - balance)} BNB)`),
      })
    } catch (error) {
      checks.push({ name, ok: false, detail: `could not read ${target.address}: ${message(error)}` })
    }
  }
  return checks
}

// ------------------------------------------------------------------- RPC

/** One `eth_chainId` per `RPC_URLS` entry: reachable, and serving our chain. */
export async function probeRpc(url: string, chainId: number, timeoutMs = 5_000): Promise<Check> {
  const name = `RPC: ${url}`
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return { name, ok: false, detail: `HTTP ${response.status}` }
    const body = (await response.json()) as { result?: string; error?: { message?: string } }
    if (body.error) return { name, ok: false, detail: `eth_chainId: ${body.error.message ?? 'error'}` }
    if (typeof body.result !== 'string') return { name, ok: false, detail: 'no chain id in the answer' }
    const served = Number(BigInt(body.result))
    return {
      name,
      ok: served === chainId,
      detail: served === chainId ? `chain ${served}` : `serves chain ${served}, expected ${chainId}`,
    }
  } catch (error) {
    return { name, ok: false, detail: message(error) }
  }
}

// ----------------------------------------------------------- facilitator

export interface FacilitatorHealth {
  checks: Check[]
  /** AD-5: read from `/health` so the relayer *key* stays in `apps/facilitator`. */
  relayerAddress: string | null
  relayerBalanceWei: bigint | null
}

/**
 * `GET /health` answers 200 with the relayer address, its balance and the
 * number of transactions still in the mempool. A pending nonce count above zero
 * is not a failure — a settlement in flight is normal — but it is the number to
 * look at when settlements stop landing, so it is printed either way.
 */
export async function probeFacilitator(url: string, timeoutMs = 5_000): Promise<FacilitatorHealth> {
  const name = 'facilitator /health'
  try {
    const response = await fetch(`${url.replace(/\/+$/, '')}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = (await response.json().catch(() => ({}))) as {
      status?: string
      relayer?: { address?: string; bnbBalance?: string; bnbBalanceWei?: string; pendingNonceCount?: number }
      asset?: { deployed?: boolean }
    }
    const relayer = body.relayer ?? {}
    const pending = relayer.pendingNonceCount ?? null
    const checks: Check[] = [
      {
        name,
        ok: response.status === 200,
        detail:
          response.status === 200
            ? `200, relayer ${relayer.address ?? 'unknown'} at ${relayer.bnbBalance ?? '?'} BNB, asset deployed=${body.asset?.deployed ?? '?'}`
            : `HTTP ${response.status} (${body.status ?? 'no status'})`,
      },
      {
        name: 'facilitator pending nonces',
        // Only a facilitator that could not answer is a failure here; a backlog
        // is a number to read, not a refusal.
        ok: response.status === 200 && pending !== null,
        detail: pending === null ? 'not reported' : `${pending} transaction(s) in flight`,
      },
    ]
    return {
      checks,
      relayerAddress: relayer.address?.toLowerCase() ?? null,
      relayerBalanceWei: relayer.bnbBalanceWei ? BigInt(relayer.bnbBalanceWei) : null,
    }
  } catch (error) {
    return {
      checks: [
        { name, ok: false, detail: message(error) },
        { name: 'facilitator pending nonces', ok: false, detail: 'unknown: /health did not answer' },
      ],
      relayerAddress: null,
      relayerBalanceWei: null,
    }
  }
}

// -------------------------------------------------------- worker heartbeat

export const WORKER_HEARTBEAT_MAX_AGE_MS = 30_000

/**
 * Story 1.10: the worker writes `platform_settings.worker_seen_at` every 10 s
 * from its own interval, so three missed beats is a dead worker.
 */
export function checkWorkerHeartbeat(
  seenAt: Date | null,
  now: Date,
  maxAgeMs = WORKER_HEARTBEAT_MAX_AGE_MS,
): Check {
  const name = 'worker heartbeat'
  if (!seenAt) {
    return { name, ok: false, detail: 'worker_seen_at is null; the worker has never run' }
  }
  const ageMs = now.getTime() - seenAt.getTime()
  return {
    name,
    ok: ageMs <= maxAgeMs,
    detail: `last beat ${(ageMs / 1000).toFixed(1)} s ago (limit ${maxAgeMs / 1000} s)`,
  }
}

// -------------------------------------------------------- PUBLIC_BASE_URL

export type PublicBaseUrlVerdict =
  | 'empty'
  | 'unparsable'
  | 'loopback'
  | 'docker-internal'
  | 'trycloudflare'
  | 'public'

/**
 * AD-2: `agentURI` is `PUBLIC_BASE_URL/api/listings/<id>/agent.json`, frozen
 * into the `identity:` transaction the moment it is sent. A host that only
 * resolves on the demo laptop, only inside the compose network, or only until a
 * quick tunnel closes makes every identity already on chain point at nothing.
 *
 * A single-label hostname is treated as Docker-internal: `web`, `worker` and
 * `agent-binance-ticker` are exactly the names compose resolves and the public
 * internet does not.
 */
export function classifyPublicBaseUrl(publicBaseUrl: string): PublicBaseUrlVerdict {
  const trimmed = publicBaseUrl.trim()
  if (trimmed === '') return 'empty'
  if (!URL.canParse(trimmed)) return 'unparsable'
  const host = new URL(trimmed).hostname.toLowerCase().replace(/^\[|\]$/g, '')

  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback'
  if (host === '::1' || host === '0.0.0.0' || /^127\./.test(host)) return 'loopback'
  if (host === 'trycloudflare.com' || host.endsWith('.trycloudflare.com')) return 'trycloudflare'
  if (host === 'host.docker.internal' || host.endsWith('.internal')) return 'docker-internal'
  if (!host.includes('.')) return 'docker-internal'
  return 'public'
}

/**
 * The rule only bites once an `agentURI` is on chain. Before that a bad host is
 * a warning; after it, it is a Listing nobody can resolve.
 */
export function checkPublicBaseUrl(publicBaseUrl: string, identityRows: number): Check {
  const name = 'PUBLIC_BASE_URL'
  const verdict = classifyPublicBaseUrl(publicBaseUrl)
  const where = `${identityRows} identity: row(s) on chain`

  if (verdict === 'empty') {
    return {
      name,
      ok: true,
      detail: `unset, so every agentURI is a data: URI (AD-2 fallback) — ${where}`,
    }
  }
  if (verdict === 'public') return { name, ok: true, detail: `${publicBaseUrl} — ${where}` }
  if (identityRows === 0) {
    return {
      name,
      ok: true,
      detail: `${publicBaseUrl} is ${verdict}, but no identity is on chain yet — fix it before the first Listing`,
    }
  }
  return {
    name,
    ok: false,
    detail: `${publicBaseUrl} is ${verdict}; ${where} already point at a host nobody else can resolve`,
  }
}

export function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
