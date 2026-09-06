import { createServer, type IncomingMessage, type Server } from 'node:http'
import { generateKeyPairSync, verify } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createBinanceExchange, DEMO_BASE_URL, TESTNET_BASE_URL } from './binance-exchange.ts'
import { exchangeOptionsFor, parseExecutorEnv } from './env.ts'

/**
 * The half of Spot Demo Mode that a mocked port cannot show: that the client
 * really sends where `EXCHANGE_BASE_URL` says, with the key pair that base URL
 * selected, signed by the Ed25519 private key of AD-11.
 *
 * `env.test.ts` proves `EXCHANGE_BASE_URL=https://demo-api.binance.com` selects
 * the demo host and `EXCHANGE_DEMO_*`; this proves `createBinanceExchange` then
 * uses exactly that, against a local HTTP server standing in for the exchange.
 * Between them the switch is covered end to end with no exchange credentials
 * and no network.
 */

const { privateKey, publicKey } = generateKeyPairSync('ed25519')
const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()

interface Captured {
  path: string
  headers: IncomingMessage['headers']
}

const servers: Server[] = []

async function startFakeExchange(body: unknown): Promise<{ url: string; seen: Captured[] }> {
  const seen: Captured[] = []
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', headers: req.headers })
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}`, seen }
}

afterEach(async () => {
  while (servers.length > 0) {
    const server = servers.pop()
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})

const ACCOUNT = { accountType: 'SPOT', balances: [{ asset: 'USDT', free: '250.00000000' }] }

describe('the client the env builds', () => {
  it('sends to EXCHANGE_BASE_URL with the selected api key, signed by the Ed25519 key', async () => {
    const exchangeHost = await startFakeExchange(ACCOUNT)
    const env = parseExecutorEnv({
      PLATFORM_INTERNAL_URL: 'http://web:3000',
      EXCHANGE_BASE_URL: exchangeHost.url,
      EXCHANGE_API_KEY: 'the-selected-api-key',
      EXCHANGE_PRIVATE_KEY: PEM,
    })
    expect(env.ok).toBe(true)
    if (!env.ok) return

    const exchange = createBinanceExchange(exchangeOptionsFor(env.value))
    expect(await exchange.getBalance()).toEqual({ balanceUsdt: '250' })

    const request = exchangeHost.seen[0]
    expect(request).toBeDefined()
    if (!request) return
    expect(request.headers['x-mbx-apikey']).toBe('the-selected-api-key')

    const [path, query = ''] = request.path.split('?')
    expect(path).toBe('/api/v3/account')

    // The SDK signs the query string it then appends `signature` to, so the
    // exchange verifies exactly this prefix. Doing the same here proves the
    // Ed25519 branch of the signer ran, not the HMAC one.
    const [signed = '', signature = ''] = query.split('&signature=')
    expect(signed).toContain('timestamp=')
    expect(
      verify(null, Buffer.from(signed), publicKey, Buffer.from(decodeURIComponent(signature), 'base64')),
    ).toBe(true)
  })

  it('sends a MARKET order as quoteOrderQty against the same host', async () => {
    const exchangeHost = await startFakeExchange({
      symbol: 'BNBUSDT',
      orderId: 42,
      status: 'FILLED',
      executedQty: '0.00788000',
      cummulativeQuoteQty: '5.99999520',
      transactTime: 1788674230047,
    })
    const env = parseExecutorEnv({
      PLATFORM_INTERNAL_URL: 'http://web:3000',
      EXCHANGE_BASE_URL: exchangeHost.url,
      EXCHANGE_API_KEY: 'k',
      EXCHANGE_PRIVATE_KEY: PEM,
    })
    if (!env.ok) throw new Error(env.issues.join('\n'))

    const exchange = createBinanceExchange(exchangeOptionsFor(env.value))
    const order = await exchange.placeMarketOrder({
      symbol: 'BNBUSDT',
      side: 'BUY',
      quoteQty: '6',
    })

    expect(order.orderId).toBe('42')
    const path = exchangeHost.seen[0]?.path ?? ''
    expect(path.startsWith('/api/v3/order?')).toBe(true)
    expect(path).toContain('symbol=BNBUSDT')
    expect(path).toContain('side=BUY')
    expect(path).toContain('type=MARKET')
    expect(path).toContain('quoteOrderQty=6')
  })

  it('builds the demo client from the demo env and nothing else', () => {
    const demo = parseExecutorEnv({
      PLATFORM_INTERNAL_URL: 'http://web:3000',
      EXCHANGE_BASE_URL: DEMO_BASE_URL,
      EXCHANGE_API_KEY: 'testnet-key',
      EXCHANGE_PRIVATE_KEY: 'testnet-pem',
      EXCHANGE_DEMO_API_KEY: 'demo-key',
      EXCHANGE_DEMO_PRIVATE_KEY: 'demo-pem',
    })
    if (!demo.ok) throw new Error(demo.issues.join('\n'))
    expect(exchangeOptionsFor(demo.value)).toEqual({
      apiKey: 'demo-key',
      privateKey: 'demo-pem',
      baseUrl: DEMO_BASE_URL,
    })

    const testnet = parseExecutorEnv({
      PLATFORM_INTERNAL_URL: 'http://web:3000',
      EXCHANGE_API_KEY: 'testnet-key',
      EXCHANGE_PRIVATE_KEY: 'testnet-pem',
      EXCHANGE_DEMO_API_KEY: 'demo-key',
      EXCHANGE_DEMO_PRIVATE_KEY: 'demo-pem',
    })
    if (!testnet.ok) throw new Error(testnet.issues.join('\n'))
    expect(exchangeOptionsFor(testnet.value)).toEqual({
      apiKey: 'testnet-key',
      privateKey: 'testnet-pem',
      baseUrl: TESTNET_BASE_URL,
    })
  })
})
