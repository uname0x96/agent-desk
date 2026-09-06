import { timingSafeEqual } from 'node:crypto'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import express, { Router } from 'express'
import type { Express, NextFunction, Request, Response } from 'express'
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from '@x402/core/server'
import type { FacilitatorClient, RouteConfig, RoutesConfig } from '@x402/core/server'
import type { Network } from '@x402/core/types'
import { paymentMiddlewareFromHTTPServer } from '@x402/express'
import { ExactEvmScheme } from '@x402/evm/exact/server'
import {
  apiError,
  baseUnitsToString,
  buildX402Config,
  samples,
  sampleOutputs,
  toBaseUnits,
  typeSchemas,
  validateInput,
  validateOutput,
  X402_HEADERS,
  X402_PAID_TIMEOUT_MS,
  X402_SCHEME,
  X402_VERSION,
  type AgentType,
  type TypeInput,
  type TypeOutput,
  type X402Config,
} from '@agent-desk/schemas'
import { createLogger, type Logger } from '@agent-desk/schemas/logger'
import { HandlerTimeoutError, InvalidOutputError } from './errors.ts'
import { toRootJsonSchema, type JsonSchema } from './json-schema.ts'
import { ReplayCache, REPLAY_TTL_MS } from './replay-cache.ts'

/**
 * AD-7: every platform-built agent uses this. `createAgent()` mounts `POST /`
 * behind the x402 middleware, `GET /health`, `GET /schema`, and any
 * `internalRoutes` under `/internal/*` behind `Authorization: Bearer
 * INTERNAL_TOKEN`.
 *
 * The paid request runs in exactly this order:
 *
 *   1. `@x402/express` verifies `PAYMENT-SIGNATURE` through `FACILITATOR_URL`
 *   2. the body is validated against the Type input schema (400 on failure)
 *   3. the handler runs under a 10 s budget (500 on expiry)
 *   4. `validateOutput` runs (500 on an invalid output, never 200)
 *   5. the middleware settles and answers 200 with `PAYMENT-RESPONSE`
 *
 * Steps 3 and 4 happen inside the single-flight replay cache, so one
 * `PAYMENT-SIGNATURE` runs the handler once no matter how often it arrives.
 * Any 5xx from steps 2 to 4 leaves the payment unsettled: the middleware only
 * settles a response below 400.
 */

/** AD-7: the kit enforces a 10 s handler budget and answers 500 on expiry. */
export const HANDLER_BUDGET_MS = 10_000

export interface AgentHandlerContext {
  /** Aborted when the handler budget expires; pass it to every outbound call. */
  signal: AbortSignal
  logger: Logger
  /** The `PAYMENT-SIGNATURE` header of the paying request, when there is one. */
  paymentSignature: string | null
}

export type AgentHandler<T extends AgentType> = (
  input: TypeInput<T>,
  context: AgentHandlerContext,
) => Promise<TypeOutput<T>> | TypeOutput<T>

export type InternalRouter = ReturnType<typeof Router>
export type InternalRoutes = InternalRouter | ((router: InternalRouter) => void)

export interface CreateAgentOptions<T extends AgentType> {
  /** One of the five standard Types (FR-15). */
  type: T
  /** Decimal USDT string, e.g. "0.01" (AD-13). */
  price: string
  /** The address every 402 for this agent pays to. */
  payTo: string
  handler: AgentHandler<T>
  /** Mounted under `/internal/*`, behind the bearer guard. */
  internalRoutes?: InternalRoutes

  // Everything below has an env or spec default; agents rarely pass them.
  /** Defaults to `FACILITATOR_URL`. */
  facilitatorUrl?: string
  /** Defaults to `INTERNAL_TOKEN`. Absent means `/internal/*` always answers 401. */
  internalToken?: string
  /** Defaults to `CHAIN_ID` or 97. */
  chainId?: number
  logger?: Logger
  serviceName?: string
  /** Swapped for a stub in the unit tests; production uses the HTTP client. */
  facilitatorClient?: FacilitatorClient
  facilitatorTimeoutMs?: number
  handlerBudgetMs?: number
  replayTtlMs?: number
  /** Fetch the facilitator's supported kinds at boot. Off in the unit tests. */
  syncFacilitatorOnStart?: boolean
}

export interface AgentSchemaDocument {
  type: AgentType
  x402Version: number
  input: JsonSchema
  output: JsonSchema
  sample_input: unknown
  sample_output: unknown
  payment: {
    scheme: string
    network: string
    asset: string
    amount: string
    payTo: string
    maxTimeoutSeconds: number
    extra: { name: string; version: string }
    facilitatorUrl: string
  }
}

export interface Agent<T extends AgentType> {
  app: Express
  type: T
  /** Decimal USDT, as configured. */
  price: string
  /** The same price in tUSD base units, exactly what the 402 asks for. */
  amount: string
  payTo: string
  x402: X402Config
  schema: AgentSchemaDocument
  listen(port?: number): Promise<{ server: Server; port: number }>
  close(): Promise<void>
}

/** An express Router is itself callable, so `typeof` cannot tell the two apart. */
function isRouter(value: InternalRoutes): value is InternalRouter {
  return typeof (value as InternalRouter).use === 'function'
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

/**
 * Runs `fn` under a wall-clock budget. The signal is aborted first so an
 * in-flight `fetch` unwinds, then the returned promise rejects.
 */
export async function runWithBudget<R>(
  fn: (signal: AbortSignal) => Promise<R> | R,
  budgetMs: number,
): Promise<R> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new HandlerTimeoutError(budgetMs)
      controller.abort(error)
      reject(error)
    }, budgetMs)
  })
  try {
    return await Promise.race([Promise.resolve(fn(controller.signal)), expiry])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export function createAgent<T extends AgentType>(options: CreateAgentOptions<T>): Agent<T> {
  const { type, price, payTo, handler } = options

  const facilitatorUrl = options.facilitatorUrl ?? process.env.FACILITATOR_URL
  if (!facilitatorUrl) {
    throw new Error('createAgent: FACILITATOR_URL is required (AD-6)')
  }
  const chainId = options.chainId ?? Number(process.env.CHAIN_ID ?? 97)
  // An empty INTERNAL_TOKEN must not make `Authorization: Bearer ` valid, so a
  // blank token counts as absent and every /internal/* request answers 401.
  const configuredToken = (options.internalToken ?? process.env.INTERNAL_TOKEN ?? '').trim()
  const internalToken = configuredToken === '' ? null : configuredToken
  const budgetMs = options.handlerBudgetMs ?? HANDLER_BUDGET_MS
  const serviceName = options.serviceName ?? `agent-${type}`
  const logger = options.logger ?? createLogger(serviceName)

  const x402 = buildX402Config({ facilitatorUrl, chainId })
  // AD-13: the wire amount is an integer base-unit string, converted by the
  // one helper in the repo. AD-6: an explicit AssetAmount, never a default.
  const amount = baseUnitsToString(toBaseUnits(price))

  const routeConfig: RouteConfig = {
    accepts: {
      scheme: X402_SCHEME,
      network: x402.network as Network,
      payTo,
      price: { asset: x402.asset, amount, extra: { ...x402.extra } },
      maxTimeoutSeconds: x402.maxTimeoutSeconds,
    },
    description: `AgentDesk ${type} agent`,
    mimeType: 'application/json',
    serviceName,
  }
  const routes: RoutesConfig = { 'POST /': routeConfig }

  const facilitatorClient =
    options.facilitatorClient ??
    new HTTPFacilitatorClient({
      url: facilitatorUrl,
      timeoutMs: options.facilitatorTimeoutMs ?? X402_PAID_TIMEOUT_MS,
    })

  const resourceServer = new x402ResourceServer(facilitatorClient)
  resourceServer.register(x402.network as Network, new ExactEvmScheme())
  const httpServer = new x402HTTPResourceServer(resourceServer, routes)

  const schema: AgentSchemaDocument = {
    type,
    x402Version: X402_VERSION,
    input: toRootJsonSchema(typeSchemas[type].input),
    output: toRootJsonSchema(typeSchemas[type].output),
    sample_input: samples[type],
    sample_output: sampleOutputs[type],
    payment: {
      scheme: X402_SCHEME,
      network: x402.network,
      asset: x402.asset,
      amount,
      payTo,
      maxTimeoutSeconds: x402.maxTimeoutSeconds,
      extra: x402.extra,
      facilitatorUrl: x402.facilitatorUrl,
    },
  }

  const cache = new ReplayCache<TypeOutput<T>>({ ttlMs: options.replayTtlMs ?? REPLAY_TTL_MS })

  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '1mb' }))

  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'ok',
      type,
      price,
      amount,
      network: x402.network,
      ts: new Date().toISOString(),
    })
  })

  app.get('/schema', (_req: Request, res: Response) => {
    res.status(200).json(schema)
  })

  // Every `/internal/*` path is guarded, whether or not the agent declared a
  // route there, so an unguarded internal route cannot exist by omission.
  const internalRouter: InternalRouter = Router()
  internalRouter.use((req: Request, res: Response, next: NextFunction) => {
    const header = req.get('authorization') ?? ''
    if (internalToken === null || !safeEqual(header, `Bearer ${internalToken}`)) {
      res.status(401).json(apiError('unauthorized', 'internal routes require a bearer token'))
      return
    }
    next()
  })
  const declaredRoutes = options.internalRoutes
  if (declaredRoutes) {
    if (isRouter(declaredRoutes)) internalRouter.use(declaredRoutes)
    else declaredRoutes(internalRouter)
  }
  app.use('/internal', internalRouter)

  app.use(
    paymentMiddlewareFromHTTPServer(
      httpServer,
      undefined,
      undefined,
      options.syncFacilitatorOnStart ?? true,
    ),
  )

  app.post('/', async (req: Request, res: Response) => {
    const paymentSignature = req.get(X402_HEADERS.signature) ?? null

    const parsed = validateInput(type, req.body)
    if (!parsed.ok) {
      logger.warn({ type, reason: parsed.error, path: parsed.path }, 'input validation failed')
      res
        .status(400)
        .json(
          apiError(
            'validation_failed',
            parsed.error,
            parsed.path === undefined ? undefined : { path: parsed.path },
          ),
        )
      return
    }
    const input = parsed.value as TypeInput<T>

    const attempt = async (): Promise<TypeOutput<T>> => {
      const output = await runWithBudget(
        (signal) => handler(input, { signal, logger, paymentSignature }),
        budgetMs,
      )
      const checked = validateOutput(type, input, output)
      if (!checked.ok) throw new InvalidOutputError(checked.error, checked.path)
      return checked.value as TypeOutput<T>
    }

    try {
      const result = paymentSignature
        ? await cache.run(paymentSignature, attempt)
        : { value: await attempt(), cached: false }
      logger.info({ type, replayed: result.cached }, 'agent call answered')
      res.status(200).json(result.value)
    } catch (error) {
      if (error instanceof HandlerTimeoutError) {
        logger.error({ type, budget_ms: budgetMs }, 'handler budget expired')
        res.status(500).json(apiError('internal_error', error.message))
        return
      }
      if (error instanceof InvalidOutputError) {
        logger.error({ type, reason: error.message }, 'handler produced an invalid output')
        res
          .status(500)
          .json(apiError('internal_error', `invalid agent output: ${error.message}`))
        return
      }
      const message = error instanceof Error ? error.message : String(error)
      logger.error({ type, reason: message }, 'handler failed')
      res.status(500).json(apiError('internal_error', `agent handler failed: ${message}`))
    }
  })

  let server: Server | null = null

  return {
    app,
    type,
    price,
    amount,
    payTo,
    x402,
    schema,
    listen(port?: number) {
      return new Promise((resolve, reject) => {
        const listening = app.listen(port ?? 0)
        listening.once('error', reject)
        listening.once('listening', () => {
          server = listening
          const address = listening.address() as AddressInfo
          logger.info({ type, port: address.port, price, amount }, 'agent listening')
          resolve({ server: listening, port: address.port })
        })
      })
    },
    close() {
      return new Promise((resolve, reject) => {
        if (!server) {
          resolve()
          return
        }
        server.close((error) => (error ? reject(error) : resolve()))
        server = null
      })
    },
  }
}
