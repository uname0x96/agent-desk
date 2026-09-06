import type { Logger } from '@agent-desk/schemas/logger'
import type { x402Facilitator } from '@x402/core/facilitator'
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types'
import express, { type Express, type Request, type Response } from 'express'
import type { FacilitatorConfig } from './config.ts'
import { readHealth, type HealthProbe } from './health.ts'
import { payerOf } from './scheme.ts'

/**
 * The x402 v2 facilitator wire contract, as `@x402/core`'s HTTPFacilitatorClient
 * speaks it: `POST /verify` and `POST /settle` take
 * `{ x402Version, paymentPayload, paymentRequirements }` and answer 200 with a
 * VerifyResponse or SettleResponse. A rejected payment is a 200 with
 * `isValid: false` / `success: false` — only a malformed body is a 4xx.
 */

/**
 * `x402Facilitator` throws this when nothing is registered for the scheme and
 * network asked for. That is a payment-level rejection, so it answers 200 with
 * `isValid: false`; anything else that throws is our outage, and answers 502 so
 * the caller raises a VerifyError/SettleError instead of recording a failed
 * payment.
 */
function isUnroutable(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith('No facilitator registered')
}

interface FacilitatorRequestBody {
  x402Version: number
  paymentPayload: PaymentPayload
  paymentRequirements: PaymentRequirements
}

function parseBody(body: unknown): { ok: true; value: FacilitatorRequestBody } | { ok: false; message: string } {
  if (typeof body !== 'object' || body === null) return { ok: false, message: 'expected a JSON object body' }
  const candidate = body as Record<string, unknown>
  if (typeof candidate.x402Version !== 'number') return { ok: false, message: 'x402Version must be a number' }
  const payload = candidate.paymentPayload
  const requirements = candidate.paymentRequirements
  if (typeof payload !== 'object' || payload === null) return { ok: false, message: 'paymentPayload must be an object' }
  if (typeof requirements !== 'object' || requirements === null) {
    return { ok: false, message: 'paymentRequirements must be an object' }
  }
  const accepted = (payload as Record<string, unknown>).accepted
  if (typeof accepted !== 'object' || accepted === null) {
    return { ok: false, message: 'paymentPayload.accepted must be an object' }
  }
  const requirementsRecord = requirements as Record<string, unknown>
  if (typeof requirementsRecord.scheme !== 'string' || typeof requirementsRecord.network !== 'string') {
    return { ok: false, message: 'paymentRequirements.scheme and .network must be strings' }
  }
  return { ok: true, value: body as FacilitatorRequestBody }
}

export interface AppDeps {
  config: FacilitatorConfig
  facilitator: x402Facilitator
  probe: HealthProbe
  logger: Logger
}

export function createApp({ config, facilitator, probe, logger }: AppDeps): Express {
  const app = express()
  app.disable('x-powered-by')
  app.use(express.json({ limit: '256kb' }))

  app.get('/health', async (_req: Request, res: Response) => {
    const health = await readHealth(config, probe)
    res.status(health.status).json(health.body)
  })

  app.get('/supported', (_req: Request, res: Response) => {
    res.json(facilitator.getSupported())
  })

  app.post('/verify', async (req: Request, res: Response) => {
    const parsed = parseBody(req.body)
    if (!parsed.ok) {
      res.status(400).json({ isValid: false, invalidReason: 'invalid_request_body', invalidMessage: parsed.message })
      return
    }
    const { paymentPayload, paymentRequirements } = parsed.value
    try {
      const result = await facilitator.verify(paymentPayload, paymentRequirements)
      if (!result.isValid) {
        logger.info({ reason: result.invalidReason, payer: result.payer }, 'verify rejected')
      }
      res.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const unroutable = isUnroutable(error)
      logger.warn({ err: message, unroutable }, 'verify failed')
      const payer = payerOf(paymentPayload)
      res.status(unroutable ? 200 : 502).json({
        isValid: false,
        invalidReason: unroutable ? 'unsupported_scheme_or_network' : 'facilitator_error',
        invalidMessage: message,
        ...(payer ? { payer } : {}),
      })
    }
  })

  app.post('/settle', async (req: Request, res: Response) => {
    const parsed = parseBody(req.body)
    if (!parsed.ok) {
      res.status(400).json({
        success: false,
        errorReason: 'invalid_request_body',
        errorMessage: parsed.message,
        transaction: '',
        network: config.x402.network,
      })
      return
    }
    const { paymentPayload, paymentRequirements } = parsed.value
    try {
      const result = await facilitator.settle(paymentPayload, paymentRequirements)
      logger.info(
        { tx_hash: result.transaction || null, payer: result.payer, reason: result.errorReason },
        result.success ? 'settled' : 'settle rejected',
      )
      res.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const unroutable = isUnroutable(error)
      logger.warn({ err: message, unroutable }, 'settle failed')
      const payer = payerOf(paymentPayload)
      res.status(unroutable ? 200 : 502).json({
        success: false,
        errorReason: unroutable ? 'unsupported_scheme_or_network' : 'facilitator_error',
        errorMessage: message,
        transaction: '',
        network: paymentRequirements.network ?? config.x402.network,
        ...(payer ? { payer } : {}),
      })
    }
  })

  return app
}
