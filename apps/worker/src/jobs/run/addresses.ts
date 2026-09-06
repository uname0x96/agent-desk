import { isAddressEqual } from 'viem'

/**
 * AD-13 fixes address comparison to viem's `isAddressEqual`, which throws on a
 * malformed address. A malformed address in a 402 is a price mismatch, not a
 * crash, so the guard comes first and a value that is not an address simply
 * fails to equal anything.
 *
 * This lives beside the engine rather than in `run-execute.ts` because it is
 * engine logic, and because importing it must not drag in the worker's env.
 */
const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function safeAddressEquals(left: string, right: string): boolean {
  if (!HEX_ADDRESS.test(left) || !HEX_ADDRESS.test(right)) return false
  return isAddressEqual(left as `0x${string}`, right as `0x${string}`)
}
