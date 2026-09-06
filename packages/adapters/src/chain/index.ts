/**
 * AD-8: the chain adapter. Everything viem-shaped lives here — clients, the
 * encoded calls, the reads, and `chainWrite` — behind the ports declared in
 * `@agent-desk/core/ports` and `@agent-desk/core/signing`.
 *
 * `packages/adapters` never imports `@agent-desk/db` (AD-1), so the `chain_tx`
 * table and the listings cache reach this module as the `ChainTxStore` and
 * `ListingCacheStore` ports, wired by the host.
 */
export {
  RECEIPT_TIMEOUT_MS,
  RPC_RETRY_COUNT,
  addressesFor,
  assertDeployed,
  chainFor,
  createPublicChainClient,
  type ChainClientConfig,
  type ContractAddresses,
} from './clients.ts'
export { identityRegistryAbi, registryAbi, tusdAbi } from './abi.ts'
export { createContractCalls } from './calls.ts'
export { createChainReader, type ChainReaderDeps } from './reader.ts'
export {
  DEFAULT_STALE_SEND_MS,
  createChainWriter,
  createReceiptSource,
  decodeReceipt,
  type ChainWriterDeps,
  type RawLog,
  type RawReceipt,
  type ReceiptSource,
} from './writer.ts'
