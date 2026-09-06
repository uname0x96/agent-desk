/**
 * The failure kinds the agent runtime maps to an HTTP status. Every one of
 * them answers 5xx, so the x402 middleware sees a failed response and never
 * settles the payment (AD-6, AD-7).
 */

/** The handler outlived the AD-7 budget. */
export class HandlerTimeoutError extends Error {
  readonly budgetMs: number

  constructor(budgetMs: number) {
    super(`handler exceeded the ${budgetMs} ms budget`)
    this.name = 'HandlerTimeoutError'
    this.budgetMs = budgetMs
  }
}

/** `validateOutput` refused what the handler produced. Never a 200 (AD-7). */
export class InvalidOutputError extends Error {
  readonly path: string | undefined

  constructor(reason: string, path?: string) {
    super(path === undefined ? reason : `${path}: ${reason}`)
    this.name = 'InvalidOutputError'
    this.path = path
  }
}

/** The process env is missing or malformed; the agent must not boot. */
export class AgentEnvError extends Error {
  readonly issues: readonly string[]

  constructor(issues: readonly string[]) {
    super(`invalid environment:\n${issues.map((issue) => `  ${issue}`).join('\n')}`)
    this.name = 'AgentEnvError'
    this.issues = issues
  }
}
