/**
 * AD-7: the one runtime every platform-built agent is made of. Agents import
 * this and `@agent-desk/schemas` and nothing else from the monorepo (AD-1).
 */
export {
  createAgent,
  runWithBudget,
  HANDLER_BUDGET_MS,
  type Agent,
  type AgentHandler,
  type AgentHandlerContext,
  type AgentSchemaDocument,
  type CreateAgentOptions,
  type InternalRouter,
  type InternalRoutes,
} from './create-agent.ts'
export { AgentEnvError, HandlerTimeoutError, InvalidOutputError } from './errors.ts'
export {
  loadAgentEnv,
  parseAgentEnv,
  requireEnv,
  type AgentEnv,
  type EnvSource,
  type ParseResult,
} from './env.ts'
export {
  isOptionalSchema,
  toJsonSchema,
  toRootJsonSchema,
  JSON_SCHEMA_DIALECT,
  type JsonSchema,
} from './json-schema.ts'
export {
  ReplayCache,
  REPLAY_TTL_MS,
  type ReplayCacheOptions,
  type ReplayResult,
} from './replay-cache.ts'
