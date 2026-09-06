import { createDecipheriv, createCipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  createPublicClient,
  createWalletClient,
  fallback,
  http,
  nonceManager,
  type Chain,
  type PublicClient,
  type TypedDataDomain,
  type WalletClient,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { bscTestnet } from 'viem/chains'
import type {
  Address,
  GeneratedKey,
  Hex,
  SendRawTxRequest,
  SignTypedDataRequest,
  Signer,
} from '@agent-desk/core/ports'

/**
 * AD-5: the `Signer` port, the only code in the system that holds a private key
 * in cleartext, and only for the length of one operation.
 *
 * Keys are sealed with AES-256-GCM under `MASTER_KEY`. GCM is authenticated, so
 * a ciphertext sealed under a different master key fails to open rather than
 * yielding a wrong key that would sign a valid transaction from an address
 * nobody expects — which is exactly the failure a unit test must be able to
 * prove, and does.
 *
 * `MASTER_KEY` is a construction parameter, never read from `process.env` here,
 * so it appears only in the env schema of the process that builds a signer:
 * `apps/worker` and `scripts/` (AD-1). `apps/web` importing this module fails
 * lint.
 */

/** Ciphertext envelope, versioned so a future scheme can be told apart. */
export const KEY_ENVELOPE_VERSION = 'gcm1'
/** Bound into the GCM tag so a sealed key cannot be replayed as another secret. */
const AAD = Buffer.from('agent-desk:wallet-key:v1')
const IV_BYTES = 12
const TAG_BYTES = 16

export interface SignerConfig {
  /**
   * 32 bytes. Accepted as 64 hex characters (what `.env` carries) or as base64
   * that decodes to exactly 32 bytes; anything else is refused at construction
   * rather than at the first signature.
   */
  masterKey: string
  chainId: number
  /** Tried in order through viem `fallback()` with three retries (conventions). */
  rpcUrls: readonly string[]
}

/** Conventions: chain reads and sends go through `fallback()` with three retries. */
export const RPC_RETRY_COUNT = 3

export function parseMasterKey(masterKey: string): Buffer {
  const trimmed = masterKey.trim()
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) return Buffer.from(trimmed, 'hex')
  const decoded = Buffer.from(trimmed, 'base64')
  if (decoded.length === 32) return decoded
  throw new Error(
    'MASTER_KEY must be 32 bytes: 64 hex characters, or base64 that decodes to 32 bytes',
  )
}

// ------------------------------------------------------------- encryption

/** Seals a private key. The envelope is what `wallets.encrypted_key` stores. */
export function encryptPrivateKey(privateKey: string, masterKey: Buffer): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv, { authTagLength: TAG_BYTES })
  cipher.setAAD(AAD)
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [
    KEY_ENVELOPE_VERSION,
    iv.toString('base64'),
    ciphertext.toString('base64'),
    tag.toString('base64'),
  ].join('.')
}

/** Opens a sealed key. Throws when the master key, the tag, or the format is wrong. */
export function decryptPrivateKey(envelope: string, masterKey: Buffer): Hex {
  const parts = envelope.split('.')
  if (parts.length !== 4 || parts[0] !== KEY_ENVELOPE_VERSION) {
    throw new Error(`not a ${KEY_ENVELOPE_VERSION} key envelope`)
  }
  const [, ivPart, ciphertextPart, tagPart] = parts as [string, string, string, string]
  const iv = Buffer.from(ivPart, 'base64')
  const tag = Buffer.from(tagPart, 'base64')
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
    throw new Error('key envelope has a malformed iv or authentication tag')
  }
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv, { authTagLength: TAG_BYTES })
  decipher.setAAD(AAD)
  decipher.setAuthTag(tag)
  let plaintext: string
  try {
    plaintext = Buffer.concat([
      decipher.update(Buffer.from(ciphertextPart, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // GCM refuses to return anything it cannot authenticate. This is the wrong
    // MASTER_KEY, a truncated envelope, or a tampered ciphertext; the caller
    // cannot tell them apart and must not be encouraged to try.
    throw new Error('failed to decrypt the wallet key: wrong MASTER_KEY or corrupt envelope')
  }
  if (!/^0x[0-9a-fA-F]{64}$/.test(plaintext)) {
    throw new Error('decrypted value is not a 32-byte private key')
  }
  return plaintext as Hex
}

/**
 * Seals an existing key and reports the address it belongs to. Used once, by
 * `importPlatformWallet()` in `scripts/`; the `Signer` port has no import
 * method because nothing else in the system may bring its own key.
 */
export function importKey(privateKey: string, masterKey: Buffer): GeneratedKey {
  const trimmed = privateKey.trim()
  if (!/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    throw new Error('expected a 0x-prefixed 32-byte hex private key')
  }
  const account = privateKeyToAccount(trimmed as Hex)
  return {
    address: account.address.toLowerCase(),
    encryptedKey: encryptPrivateKey(trimmed, masterKey),
  }
}

// ------------------------------------------------------------------ signer

export interface ViemSigner extends Signer {
  /** Exposed so `chainWrite` can await receipts on the same transport. */
  readonly publicClient: PublicClient
  readonly chain: Chain
  /** The address a sealed key belongs to, without returning the key. */
  addressOf(encryptedKey: string): Address
}

const CHAINS: Record<number, Chain> = { [bscTestnet.id]: bscTestnet }

export function chainFor(chainId: number): Chain {
  const chain = CHAINS[chainId]
  if (!chain) throw new Error(`no viem chain registered for chain id ${chainId}`)
  return chain
}

export function createSigner(config: SignerConfig): ViemSigner {
  const masterKey = parseMasterKey(config.masterKey)
  if (config.rpcUrls.length === 0) throw new Error('RPC_URLS is empty')
  const chain = chainFor(config.chainId)
  const transport = fallback(config.rpcUrls.map((url) => http(url, { retryCount: RPC_RETRY_COUNT })))
  const publicClient = createPublicClient({ chain, transport })

  /**
   * `nonceManager` keeps two sends from one wallet off the same nonce. The
   * per-wallet mutex in `core/signing` serialises the *decision* to send, but it
   * is released once the node has the raw transaction, so the second send can
   * reach `eth_getTransactionCount` before the first is in a block.
   */
  const accountFor = (encryptedKey: string) =>
    privateKeyToAccount(decryptPrivateKey(encryptedKey, masterKey), { nonceManager })

  return {
    publicClient,
    chain,

    addressOf(encryptedKey) {
      return accountFor(encryptedKey).address.toLowerCase()
    },

    async generateKey(): Promise<GeneratedKey> {
      const privateKey = generatePrivateKey()
      const account = privateKeyToAccount(privateKey)
      return {
        address: account.address.toLowerCase(),
        encryptedKey: encryptPrivateKey(privateKey, masterKey),
      }
    },

    async decryptKey(encryptedKey: string): Promise<Hex> {
      return decryptPrivateKey(encryptedKey, masterKey)
    },

    async signTypedData(request: SignTypedDataRequest): Promise<Hex> {
      const account = accountFor(request.encryptedKey)
      // viem's typed-data generics cannot be expressed from the port's loose
      // Record shape, so the argument object is cast once, here.
      return account.signTypedData({
        domain: request.domain as TypedDataDomain,
        types: request.types,
        primaryType: request.primaryType,
        message: request.message,
      } as never)
    },

    async sendRawTx(request: SendRawTxRequest): Promise<Hex> {
      const account = accountFor(request.encryptedKey)
      const walletClient: WalletClient = createWalletClient({ account, chain, transport })
      return walletClient.sendTransaction({
        account,
        chain,
        to: request.to as Hex,
        data: request.data,
        ...(request.value === undefined ? {} : { value: request.value }),
        ...(request.gas === undefined ? {} : { gas: request.gas }),
      })
    },
  }
}

/**
 * Constant-time comparison for the one place a caller may want to check that
 * two envelopes seal the same key without opening either: the Platform Wallet
 * import, which must stay idempotent without logging anything sensitive.
 */
export function sameEnvelope(left: string, right: string): boolean {
  const a = Buffer.from(left)
  const b = Buffer.from(right)
  return a.length === b.length && timingSafeEqual(a, b)
}
