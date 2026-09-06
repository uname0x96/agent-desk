/**
 * A JSON Schema projection of the Zod 4 Type schemas, for `GET /schema`.
 *
 * `z.toJSONSchema()` is the canonical converter and the public schema page
 * (AD-6) uses it, but `zod` is not a declared dependency of this package and
 * AD-1 forbids borrowing it from another workspace package. This walks the
 * public `def` surface of the schema objects `packages/schemas` exports, so
 * the contract is still derived from `packages/schemas` and never restated
 * here (AD-14). Replace it with `z.toJSONSchema()` once `zod` is declared.
 *
 * It covers exactly the constructs the five Type schemas use: object, string
 * (regex, length, ISO datetime), number (bounds), boolean, enum, literal,
 * array, optional and nullable. Anything else degrades to `{}`.
 */

export interface JsonSchema {
  [key: string]: unknown
}

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema'

interface CheckDef {
  check?: string
  format?: string
  pattern?: RegExp | string
  minimum?: number
  maximum?: number
  value?: number
  inclusive?: boolean
}

interface ZodDefLike {
  type?: string
  shape?: Record<string, unknown>
  innerType?: unknown
  element?: unknown
  values?: readonly unknown[]
  entries?: Record<string, string | number>
  format?: string
  pattern?: RegExp | string
  checks?: readonly unknown[]
}

function defOf(schema: unknown): ZodDefLike | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined
  const def = (schema as { def?: unknown }).def
  if (typeof def !== 'object' || def === null) return undefined
  return def as ZodDefLike
}

function checkDefOf(check: unknown): CheckDef | undefined {
  if (typeof check !== 'object' || check === null) return undefined
  const inner = (check as { _zod?: { def?: unknown } })._zod?.def
  if (typeof inner !== 'object' || inner === null) return undefined
  return inner as CheckDef
}

function patternSource(pattern: RegExp | string | undefined): string | undefined {
  if (pattern === undefined) return undefined
  return pattern instanceof RegExp ? pattern.source : pattern
}

function applyStringChecks(target: JsonSchema, def: ZodDefLike): void {
  for (const raw of def.checks ?? []) {
    const check = checkDefOf(raw)
    if (!check) continue
    if (check.check === 'string_format' && check.format === 'regex') {
      const source = patternSource(check.pattern)
      if (source !== undefined) target.pattern = source
    } else if (check.check === 'min_length' && typeof check.minimum === 'number') {
      target.minLength = check.minimum
    } else if (check.check === 'max_length' && typeof check.maximum === 'number') {
      target.maxLength = check.maximum
    }
  }
}

function applyNumberChecks(target: JsonSchema, def: ZodDefLike): void {
  for (const raw of def.checks ?? []) {
    const check = checkDefOf(raw)
    if (!check || typeof check.value !== 'number') continue
    if (check.check === 'greater_than') {
      if (check.inclusive === true) target.minimum = check.value
      else target.exclusiveMinimum = check.value
    } else if (check.check === 'less_than') {
      if (check.inclusive === true) target.maximum = check.value
      else target.exclusiveMaximum = check.value
    }
  }
}

/** True when the schema is `.optional()`, so the key stays out of `required`. */
export function isOptionalSchema(schema: unknown): boolean {
  return defOf(schema)?.type === 'optional'
}

export function toJsonSchema(schema: unknown): JsonSchema {
  const def = defOf(schema)
  if (!def) return {}

  switch (def.type) {
    case 'object': {
      const properties: JsonSchema = {}
      const required: string[] = []
      for (const [key, value] of Object.entries(def.shape ?? {})) {
        properties[key] = toJsonSchema(value)
        if (!isOptionalSchema(value)) required.push(key)
      }
      // Zod strips unknown keys rather than rejecting them, so the projection
      // stays silent on `additionalProperties`.
      const out: JsonSchema = { type: 'object', properties }
      if (required.length > 0) out.required = required
      return out
    }
    case 'string': {
      const out: JsonSchema = { type: 'string' }
      if (def.format === 'datetime') {
        out.format = 'date-time'
        const source = patternSource(def.pattern)
        if (source !== undefined) out.pattern = source
      }
      applyStringChecks(out, def)
      return out
    }
    case 'number': {
      const out: JsonSchema = { type: 'number' }
      applyNumberChecks(out, def)
      return out
    }
    case 'boolean':
      return { type: 'boolean' }
    case 'enum':
      return { type: 'string', enum: Object.values(def.entries ?? {}) }
    case 'literal': {
      const values = def.values ?? []
      return values.length === 1 ? { const: values[0] } : { enum: [...values] }
    }
    case 'array':
      return { type: 'array', items: toJsonSchema(def.element) }
    case 'optional':
      return toJsonSchema(def.innerType)
    case 'nullable':
      return { anyOf: [toJsonSchema(def.innerType), { type: 'null' }] }
    default:
      return {}
  }
}

/** The same projection with the dialect declared, for a top-level document. */
export function toRootJsonSchema(schema: unknown): JsonSchema {
  return { $schema: JSON_SCHEMA_DIALECT, ...toJsonSchema(schema) }
}
