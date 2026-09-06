/**
 * Keccak-256, the hash EIP-55 address checksums are computed over.
 *
 * `apps/web` does not depend on viem — viem is a dependency of
 * `@agent-desk/adapters`, which pnpm does not expose to this package, and this
 * story may not add dependencies. So the one hash the UI needs lives here.
 * If viem is ever added to apps/web, delete this file and back
 * `checksumAddress` in lib/format.ts with viem's `getAddress`; nothing else
 * imports it.
 *
 * This is the original Keccak padding (0x01), not SHA3-256's (0x06).
 */

const ROUND_CONSTANTS: readonly bigint[] = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
]

/** Rotation offsets, indexed by lane x + 5y. */
const ROTATIONS: readonly bigint[] = [
  0n, 1n, 62n, 28n, 27n,
  36n, 44n, 6n, 55n, 20n,
  3n, 10n, 43n, 25n, 39n,
  41n, 45n, 15n, 21n, 8n,
  18n, 2n, 61n, 56n, 14n,
]

const MASK64 = (1n << 64n) - 1n
/** Keccak-256 absorbs 1088 bits at a time. */
const RATE_BYTES = 136

function rotl(lane: bigint, bits: bigint): bigint {
  return ((lane << bits) | (lane >> (64n - bits))) & MASK64
}

function permute(state: bigint[]): void {
  const c = new Array<bigint>(5)
  const d = new Array<bigint>(5)
  const b = new Array<bigint>(25)

  for (const roundConstant of ROUND_CONSTANTS) {
    // theta
    for (let x = 0; x < 5; x += 1) {
      c[x] = state[x]! ^ state[x + 5]! ^ state[x + 10]! ^ state[x + 15]! ^ state[x + 20]!
    }
    for (let x = 0; x < 5; x += 1) {
      d[x] = c[(x + 4) % 5]! ^ rotl(c[(x + 1) % 5]!, 1n)
    }
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) state[x + 5 * y] = state[x + 5 * y]! ^ d[x]!
    }

    // rho and pi
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(state[x + 5 * y]!, ROTATIONS[x + 5 * y]!)
      }
    }

    // chi
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 5; x += 1) {
        state[x + 5 * y] = b[x + 5 * y]! ^ (~b[((x + 1) % 5) + 5 * y]! & b[((x + 2) % 5) + 5 * y]! & MASK64)
      }
    }

    // iota
    state[0] = state[0]! ^ roundConstant
  }
}

/** Returns the 32-byte digest of `input`. */
export function keccak256(input: Uint8Array): Uint8Array {
  const state = new Array<bigint>(25).fill(0n)

  const padded = new Uint8Array(Math.floor(input.length / RATE_BYTES + 1) * RATE_BYTES)
  padded.set(input)
  padded[input.length] = 0x01
  padded[padded.length - 1] = padded[padded.length - 1]! | 0x80

  for (let offset = 0; offset < padded.length; offset += RATE_BYTES) {
    for (let lane = 0; lane < RATE_BYTES / 8; lane += 1) {
      let value = 0n
      for (let byte = 7; byte >= 0; byte -= 1) {
        value = (value << 8n) | BigInt(padded[offset + lane * 8 + byte]!)
      }
      state[lane] = state[lane]! ^ value
    }
    permute(state)
  }

  const digest = new Uint8Array(32)
  for (let lane = 0; lane < 4; lane += 1) {
    let value = state[lane]!
    for (let byte = 0; byte < 8; byte += 1) {
      digest[lane * 8 + byte] = Number(value & 0xffn)
      value >>= 8n
    }
  }
  return digest
}

const HEX = '0123456789abcdef'

export function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 0x0f]!
  return out
}

/** Hex digest of the UTF-8 encoding of `text`, without a `0x` prefix. */
export function keccak256Hex(text: string): string {
  return toHex(keccak256(new TextEncoder().encode(text)))
}
