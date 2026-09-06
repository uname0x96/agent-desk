/** AD-13: ids are ULIDs with a type prefix. */

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const TIME_LEN = 10
const RANDOM_LEN = 16

export const ID_PREFIXES = {
  account: 'acc',
  wallet: 'wal',
  workflow: 'wf',
  listing: 'lst',
  run: 'run',
  call: 'call',
  settlement: 'stl',
} as const

export type IdKind = keyof typeof ID_PREFIXES

function encodeTime(now: number): string {
  let out = ''
  let value = now
  for (let index = TIME_LEN - 1; index >= 0; index -= 1) {
    out = ENCODING[value % 32] + out
    value = Math.floor(value / 32)
  }
  return out
}

function encodeRandom(): string {
  const bytes = new Uint8Array(RANDOM_LEN)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += ENCODING[byte % 32]
  return out
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now) + encodeRandom()
}

export function newId(kind: IdKind, now?: number): string {
  return `${ID_PREFIXES[kind]}_${ulid(now)}`
}

export function isId(kind: IdKind, value: string): boolean {
  const prefix = `${ID_PREFIXES[kind]}_`
  return value.startsWith(prefix) && value.length === prefix.length + TIME_LEN + RANDOM_LEN
}
