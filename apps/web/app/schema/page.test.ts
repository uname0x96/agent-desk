import { createElement } from 'react'
import { beforeAll, describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  AGENT_TYPES,
  buildX402Config,
  sampleOutputs,
  samples,
  X402_HEADERS,
  X402_SCHEME,
} from '@agent-desk/schemas'
import SchemaPage from './page.tsx'

/**
 * FR-15: a Creator must be able to build a conforming Agent from this page
 * alone, signed out. Every element the story names is asserted here so the
 * page cannot quietly lose one.
 */

const FACILITATOR_URL = 'https://facilitator.agentdesk.test'

let markup: string
let body: string

beforeAll(() => {
  process.env.FACILITATOR_URL = FACILITATOR_URL
  markup = renderToStaticMarkup(createElement(SchemaPage))
  body = markup
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
})

describe('the public schema page', () => {
  it('renders the input and output schema of all five Types', () => {
    for (const type of AGENT_TYPES) {
      expect(body).toContain(`${type} — input schema`)
      expect(body).toContain(`${type} — output schema`)
    }
    // z.toJSONSchema output, not a hand-written restatement.
    expect(body).toContain('https://json-schema.org/draft/2020-12/schema')
    expect(body).toContain('volatility_24h_pct')
    expect(body).toContain('cost_table')
  })

  it('renders the shared samples for every Type', () => {
    for (const type of AGENT_TYPES) {
      expect(body).toContain(`${type} — sample input`)
      expect(body).toContain(`${type} — sample output`)
    }
    expect(body).toContain(`"${samples.data.symbol}"`)
    expect(body).toContain(`"${sampleOutputs.data.price}"`)
    expect(body).toContain(`"${sampleOutputs.research.signal}"`)
    expect(body).toContain(`"${sampleOutputs.execution.status}"`)
  })

  it('states the x402 wire contract: headers, both timeouts and the single retry', () => {
    expect(body).toContain(X402_HEADERS.required)
    expect(body).toContain(X402_HEADERS.signature)
    expect(body).toContain(X402_HEADERS.response)
    expect(body).toContain('POST / (unpaid), 15 s timeout')
    expect(body).toContain('POST / (paid), 15 s timeout')
    expect(body).toContain('One retry, 2 paid attempts at most')
  })

  it('renders the active binding from buildX402Config', () => {
    const x402 = buildX402Config({ facilitatorUrl: FACILITATOR_URL })
    expect(body).toContain(X402_SCHEME)
    expect(body).toContain(x402.network)
    expect(body).toContain('eip155:97')
    expect(body).toContain(x402.asset)
    expect(body).toContain(x402.facilitatorUrl)
    // The EIP-712 domain that every payment signature is signed over.
    expect(body).toContain(x402.extra.name)
    expect(body).toContain(x402.extra.version)
  })

  it('names the cross-field rules a JSON Schema cannot express', () => {
    expect(body).toContain('size_usdt must be exactly "0" when decision is REJECT.')
    expect(body).toContain('order_id, filled_price and filled_qty are all required when status is FILLED.')
    expect(body).toContain('reason is required when status is REJECTED.')
  })

  it('says unknown response fields are ignored rather than rejected', () => {
    expect(body).toContain('Unknown fields in a response are ignored rather than rejected.')
  })
})
