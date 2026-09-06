import { decodeReceipt, type ContractAddresses, type ReceiptSource } from '@agent-desk/adapters/chain'
import type { Hex } from '@agent-desk/core/ports'
import type { ListingReceiptSource } from '@agent-desk/core/listing'

/**
 * Reads the `Registered` and `Listed` events back out of a transaction a
 * previous run of the job already confirmed.
 *
 * AD-8 keeps the hash on the `chain_tx` row and, on a redelivery, `chainWrite`
 * re-checks that row rather than re-sending — which means it hands back no
 * receipt for a transaction it did not send in this run. This is the way back to
 * the events without a second write, and it decodes them with `decodeReceipt`,
 * the same function `chainWrite` uses, so there is no second parser.
 */
export function createListingReceiptSource(
  receipts: ReceiptSource,
  addresses: ContractAddresses,
): ListingReceiptSource {
  const decode = async (txHash: Hex) => {
    const raw = await receipts.get(txHash)
    if (!raw || raw.status !== 'success') return null
    return decodeReceipt(raw, addresses)
  }

  return {
    async registeredAgentId(txHash) {
      return (await decode(txHash))?.registered?.agentId ?? null
    },
    async listedRegistryListingId(txHash) {
      return (await decode(txHash))?.listed?.registryListingId ?? null
    },
  }
}
