import { describe, expect, it } from 'vitest'
import { toBaseUnits, workflowResponse } from '@agent-desk/schemas'
import {
  orderCapToBaseUnits,
  orderCapToDecimal,
  parsePageSize,
  toWorkflowResponse,
  toWorkflowsPage,
  workflowsResponse,
  type WorkflowRow,
} from './workflows-view.ts'

/** The read model behind `/api/workflows`, over rows rather than a database. */

const CREATED = new Date('2026-09-06T09:29:56.651Z')

function row(overrides: Partial<WorkflowRow> = {}): WorkflowRow {
  return {
    id: 'wf_01K4RWZ0N3F8H2S6C1E7YQAB4M',
    name: 'BNB momentum desk',
    symbol: 'BNBUSDT',
    orderCapUsdt: '10',
    createdAt: CREATED,
    lastRunStatus: 'completed',
    nodes: [
      {
        nodeIndex: 1,
        nodeType: 'research',
        listingId: 'lst_alpha',
        provider: 'Alpha Research',
        price: toBaseUnits('0.05').toString(),
        status: 'active',
        pausedByCreator: false,
        pausedByStake: false,
      },
      {
        nodeIndex: 0,
        nodeType: 'data',
        listingId: 'lst_ticker',
        provider: 'Binance Ticker',
        price: toBaseUnits('0.01').toString(),
        status: 'active',
        pausedByCreator: false,
        pausedByStake: false,
      },
    ],
    ...overrides,
  }
}

describe('toWorkflowResponse', () => {
  it('answers a body that parses as workflowResponse, in node_index order', () => {
    const body = toWorkflowResponse(row())
    expect(workflowResponse.parse(body)).toEqual(body)
    expect(body.nodes.map((node) => node.node_index)).toEqual([0, 1])
    expect(body.nodes.map((node) => node.type)).toEqual(['data', 'research'])
    expect(body.last_run_status).toBe('completed')
    expect(body.created_at).toBe(CREATED.toISOString())
  })

  it('converts the Order Cap from the column decimal to base units (AD-13)', () => {
    expect(toWorkflowResponse(row()).order_cap_usdt).toBe(toBaseUnits('10').toString())
    expect(toWorkflowResponse(row({ orderCapUsdt: null })).order_cap_usdt).toBeNull()
  })

  it('says so rather than crashing when a Node names a Listing that is gone', () => {
    const orphan = row({
      nodes: [
        {
          nodeIndex: 0,
          nodeType: 'data',
          listingId: 'lst_gone',
          provider: null,
          price: null,
          status: null,
          pausedByCreator: false,
          pausedByStake: false,
        },
      ],
    })
    const body = toWorkflowResponse(orphan)
    expect(workflowResponse.parse(body)).toEqual(body)
    expect(body.nodes[0]).toMatchObject({ provider: 'unknown Provider', price: '0', status: 'failed' })
  })

  it('carries a Workflow that has never run as a null last Run status', () => {
    expect(toWorkflowResponse(row({ lastRunStatus: null })).last_run_status).toBeNull()
  })
})

describe('toWorkflowsPage', () => {
  it('answers the shared list envelope and parses as workflowsResponse', () => {
    const page = toWorkflowsPage([row()], 50)
    expect(workflowsResponse.parse(page)).toEqual(page)
    expect(page.next).toBeNull()
  })

  it('keyset-paginates over the id: the extra row only says a next page exists', () => {
    const first = row({ id: 'wf_01K4RWZ0N3F8H2S6C1E7YQAB4M' })
    const second = row({ id: 'wf_01K4RWZ0N3F8H2S6C1E7YQAB4A' })
    const page = toWorkflowsPage([first, second], 1)
    expect(page.items).toHaveLength(1)
    expect(page.next).toBe(first.id)
  })
})

describe('the Order Cap conversions', () => {
  it('round-trips a decimal through base units', () => {
    for (const cap of ['10', '5', '1000.5', '0.000001']) {
      expect(orderCapToDecimal(orderCapToBaseUnits(cap))).toBe(cap)
    }
  })

  it('answers null for a value that is not an amount', () => {
    expect(orderCapToBaseUnits('ten')).toBeNull()
    expect(orderCapToBaseUnits('')).toBeNull()
    expect(orderCapToDecimal(null)).toBeNull()
  })
})

describe('parsePageSize', () => {
  it('defaults, and clamps to the maximum', () => {
    expect(parsePageSize(null)).toBe(50)
    expect(parsePageSize('0')).toBe(50)
    expect(parsePageSize('nonsense')).toBe(50)
    expect(parsePageSize('7')).toBe(7)
    expect(parsePageSize('1000')).toBe(100)
  })
})
