import { describe, expect, it } from 'vitest'
import { parseAlphaEnv } from './env.ts'
import { DEFAULT_MODEL } from './model.ts'

describe('parseAlphaEnv', () => {
  it('requires ANTHROPIC_API_KEY, so a missing key refuses the boot', () => {
    expect(parseAlphaEnv({})).toEqual({ ok: false, issues: ['ANTHROPIC_API_KEY: required'] })
    expect(parseAlphaEnv({ ANTHROPIC_API_KEY: '   ' })).toEqual({
      ok: false,
      issues: ['ANTHROPIC_API_KEY: required'],
    })
  })

  it('defaults the model to claude-sonnet-5', () => {
    expect(parseAlphaEnv({ ANTHROPIC_API_KEY: 'sk-ant-test' })).toEqual({
      ok: true,
      value: { ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_MODEL: DEFAULT_MODEL },
    })
    expect(DEFAULT_MODEL).toBe('claude-sonnet-5')
  })

  it('takes ANTHROPIC_MODEL when it is set', () => {
    expect(parseAlphaEnv({ ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_MODEL: 'claude-opus-5' })).toEqual(
      { ok: true, value: { ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_MODEL: 'claude-opus-5' } },
    )
  })
})
