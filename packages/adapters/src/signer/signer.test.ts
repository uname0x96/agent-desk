import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { privateKeyToAccount } from 'viem/accounts'
import {
  KEY_ENVELOPE_VERSION,
  createSigner,
  decryptPrivateKey,
  encryptPrivateKey,
  importKey,
  parseMasterKey,
} from './index.ts'

/**
 * AD-5: the key round-trips under the right `MASTER_KEY` and fails to open
 * under any other. GCM is what makes the second half true — a wrong key must
 * refuse, not hand back plausible-looking bytes that would sign a valid
 * transaction from an address nobody expects.
 */

const MASTER = randomBytes(32).toString('hex')
const OTHER_MASTER = randomBytes(32).toString('hex')
const RPC = ['http://127.0.0.1:8545']

const signerWith = (masterKey: string) =>
  createSigner({ masterKey, chainId: 97, rpcUrls: RPC })

describe('parseMasterKey', () => {
  it('accepts 64 hex characters, which is what .env carries', () => {
    expect(parseMasterKey(MASTER)).toHaveLength(32)
  })

  it('accepts base64 that decodes to 32 bytes', () => {
    const base64 = randomBytes(32).toString('base64')
    expect(parseMasterKey(base64)).toHaveLength(32)
  })

  it('refuses anything that is not 32 bytes', () => {
    expect(() => parseMasterKey('too-short')).toThrow('32 bytes')
    expect(() => parseMasterKey(randomBytes(16).toString('hex'))).toThrow('32 bytes')
  })
})

describe('key envelopes', () => {
  const key = randomBytes(32)
  const privateKey = `0x${randomBytes(32).toString('hex')}`

  it('round-trips a private key', () => {
    const envelope = encryptPrivateKey(privateKey, key)
    expect(envelope.startsWith(`${KEY_ENVELOPE_VERSION}.`)).toBe(true)
    expect(envelope).not.toContain(privateKey.slice(2))
    expect(decryptPrivateKey(envelope, key)).toBe(privateKey)
  })

  it('produces a different envelope every time, so two wallets never look alike', () => {
    const first = encryptPrivateKey(privateKey, key)
    const second = encryptPrivateKey(privateKey, key)
    expect(first).not.toBe(second)
    expect(decryptPrivateKey(first, key)).toBe(decryptPrivateKey(second, key))
  })

  it('fails to decrypt under a different MASTER_KEY', () => {
    const envelope = encryptPrivateKey(privateKey, key)
    expect(() => decryptPrivateKey(envelope, randomBytes(32))).toThrow('wrong MASTER_KEY')
  })

  it('fails on a tampered ciphertext', () => {
    const envelope = encryptPrivateKey(privateKey, key)
    const parts = envelope.split('.')
    const ciphertext = Buffer.from(parts[2]!, 'base64')
    ciphertext[0] = ciphertext[0]! ^ 0xff
    parts[2] = ciphertext.toString('base64')
    expect(() => decryptPrivateKey(parts.join('.'), key)).toThrow('wrong MASTER_KEY')
  })

  it('fails on a tampered authentication tag', () => {
    const envelope = encryptPrivateKey(privateKey, key)
    const parts = envelope.split('.')
    const tag = Buffer.from(parts[3]!, 'base64')
    tag[0] = tag[0]! ^ 0xff
    parts[3] = tag.toString('base64')
    expect(() => decryptPrivateKey(parts.join('.'), key)).toThrow('wrong MASTER_KEY')
  })

  it('refuses an envelope of another version or shape', () => {
    expect(() => decryptPrivateKey('gcm9.a.b.c', key)).toThrow('key envelope')
    expect(() => decryptPrivateKey('not-an-envelope', key)).toThrow('key envelope')
  })
})

describe('createSigner', () => {
  it('generates a key that round-trips to the address it reported', async () => {
    const signer = signerWith(MASTER)
    const generated = await signer.generateKey()

    expect(generated.address).toMatch(/^0x[0-9a-f]{40}$/)
    const privateKey = await signer.decryptKey(generated.encryptedKey)
    expect(privateKeyToAccount(privateKey).address.toLowerCase()).toBe(generated.address)
    expect(signer.addressOf(generated.encryptedKey)).toBe(generated.address)
  })

  it('generates a different key each time', async () => {
    const signer = signerWith(MASTER)
    const first = await signer.generateKey()
    const second = await signer.generateKey()
    expect(first.address).not.toBe(second.address)
  })

  it('cannot open a key sealed under another MASTER_KEY', async () => {
    const generated = await signerWith(MASTER).generateKey()
    await expect(signerWith(OTHER_MASTER).decryptKey(generated.encryptedKey)).rejects.toThrow(
      'wrong MASTER_KEY',
    )
  })

  it('refuses to build without an RPC URL or on an unknown chain', () => {
    expect(() => createSigner({ masterKey: MASTER, chainId: 97, rpcUrls: [] })).toThrow('RPC_URLS')
    expect(() => createSigner({ masterKey: MASTER, chainId: 1, rpcUrls: RPC })).toThrow('chain id 1')
  })
})

describe('importKey', () => {
  it('seals an existing key and reports its address', () => {
    const key = parseMasterKey(MASTER)
    const privateKey = `0x${randomBytes(32).toString('hex')}`
    const imported = importKey(privateKey, key)

    expect(imported.address).toBe(privateKeyToAccount(privateKey as `0x${string}`).address.toLowerCase())
    expect(decryptPrivateKey(imported.encryptedKey, key)).toBe(privateKey)
  })

  it('refuses anything that is not a 32-byte hex private key', () => {
    const key = parseMasterKey(MASTER)
    expect(() => importKey('0xdeadbeef', key)).toThrow('private key')
    expect(() => importKey(randomBytes(32).toString('hex'), key)).toThrow('private key')
  })
})
