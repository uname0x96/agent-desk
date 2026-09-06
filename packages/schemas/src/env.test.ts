import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { csv, defineEnv } from './env.ts'

/**
 * The empty-value rule is the whole point of these tests. `FOO=` in a `.env`
 * file means "not set" to the person who wrote it, and every process that
 * treats it as a present empty string refuses to boot over a line the operator
 * believes is blank.
 */
describe('defineEnv', () => {
  const schema = z.object({
    REQUIRED: z.string().min(1),
    URL_OR_ABSENT: z.string().url().optional(),
  })

  it('reads a fully populated environment', () => {
    expect(defineEnv(schema, { REQUIRED: 'x', URL_OR_ABSENT: 'https://a.test' })).toEqual({
      REQUIRED: 'x',
      URL_OR_ABSENT: 'https://a.test',
    })
  })

  it('treats an empty optional value as absent rather than as an invalid URL', () => {
    expect(defineEnv(schema, { REQUIRED: 'x', URL_OR_ABSENT: '' })).toEqual({ REQUIRED: 'x' })
  })

  it('treats a whitespace-only value as absent too', () => {
    expect(defineEnv(schema, { REQUIRED: 'x', URL_OR_ABSENT: '   ' })).toEqual({ REQUIRED: 'x' })
  })

  it('still fails on a required key that is empty, naming it', () => {
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit')
    }) as never)

    expect(() => defineEnv(schema, { REQUIRED: '' })).toThrow('exit')
    expect(write.mock.calls[0]?.[0]).toContain('REQUIRED')
    expect(exit).toHaveBeenCalledWith(1)

    write.mockRestore()
    exit.mockRestore()
  })
})

describe('csv', () => {
  it('splits, trims, and drops the empties', () => {
    expect(csv(' a , b ,, c ')).toEqual(['a', 'b', 'c'])
    expect(csv('')).toEqual([])
  })
})
