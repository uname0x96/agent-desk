/**
 * The domain package. `packages/core` imports `@agent-desk/schemas` and nothing
 * else (AD-1); every vendor SDK reaches it through a port.
 *
 * Sub-paths carry the substance — `@agent-desk/core/ports`,
 * `@agent-desk/core/signing`, `@agent-desk/core/run`,
 * `@agent-desk/core/settlement` — and this entry point re-exports the ports so
 * a host can wire adapters without three imports.
 */
export * from './ports/index.ts'
