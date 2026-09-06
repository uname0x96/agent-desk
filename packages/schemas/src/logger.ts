import pino from 'pino'

/**
 * Conventions: pino JSON logs carrying run_id, call_id and tx_hash where known.
 * Server-only entry point; the browser bundle never imports it.
 */
export interface LogContext {
  run_id?: string | null
  call_id?: string | null
  tx_hash?: string | null
  listing_id?: string | null
  intent_key?: string | null
}

export function createLogger(service: string) {
  return pino({
    name: service,
    level: process.env.LOG_LEVEL ?? 'info',
    base: { service },
    formatters: { level: (label) => ({ level: label }) },
    timestamp: pino.stdTimeFunctions.isoTime,
  })
}

export type Logger = ReturnType<typeof createLogger>
