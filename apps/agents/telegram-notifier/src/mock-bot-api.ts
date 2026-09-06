import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

/**
 * A local stand-in for `api.telegram.org`, used as grammY's `apiRoot`.
 *
 * `TELEGRAM_BOT_TOKEN` is empty on this laptop and no bot exists yet, so every
 * test drives the real grammY client against this server instead. That keeps
 * grammY's own request building, response parsing and error mapping in the
 * test rather than stubbing them away: the assertions below are on the exact
 * JSON a real Bot API server would receive.
 */

export interface BotApiCall {
  method: string
  payload: Record<string, unknown>
}

export type BotApiReply =
  | { ok: true; result: unknown }
  | { ok: false; error_code: number; description: string }

export type BotApiHandler = (
  payload: Record<string, unknown>,
) => BotApiReply | Promise<BotApiReply>

function parsePayload(body: string): Record<string, unknown> {
  if (body === '') return {}
  try {
    return JSON.parse(body) as Record<string, unknown>
  } catch {
    return {}
  }
}

export const DEFAULT_MESSAGE_ID = 4521

export const DEFAULT_BOT_INFO = {
  id: 7_000_000_001,
  is_bot: true,
  first_name: 'AgentDesk',
  username: 'agentdesk_demo_bot',
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
}

export interface MockBotApi {
  /** Pass this as grammY's `client.apiRoot`. */
  apiRoot: string
  calls: BotApiCall[]
  /** Every call to one method, oldest first. */
  callsTo(method: string): BotApiCall[]
  /** Replace the reply for one method. */
  on(method: string, handler: BotApiHandler): void
  close(): Promise<void>
}

export async function startMockBotApi(): Promise<MockBotApi> {
  const calls: BotApiCall[] = []
  const handlers = new Map<string, BotApiHandler>()

  const defaults: Record<string, BotApiHandler> = {
    getMe: () => ({ ok: true, result: DEFAULT_BOT_INFO }),
    deleteWebhook: () => ({ ok: true, result: true }),
    // A polling loop that answers instantly would spin; 20 ms is enough to
    // keep the loop cool without making the tests wait.
    getUpdates: async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
      return { ok: true, result: [] }
    },
    sendMessage: (payload) => ({
      ok: true,
      result: {
        message_id: DEFAULT_MESSAGE_ID,
        date: Math.floor(Date.now() / 1000),
        chat: { id: Number(payload.chat_id) || 0, type: 'private' },
        text: payload.text,
      },
    }),
  }

  const server: Server = createServer((req, res) => {
    const method = (req.url ?? '').split('/').pop() ?? ''
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      const payload = parsePayload(body)
      calls.push({ method, payload })
      const handler = handlers.get(method) ?? defaults[method]
      if (handler === undefined) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({ ok: false, error_code: 404, description: `Not Found: ${method}` }),
        )
        return
      }
      void Promise.resolve(handler(payload)).then(
        (reply) => {
          res.writeHead(reply.ok ? 200 : reply.error_code, {
            'content-type': 'application/json',
          })
          res.end(JSON.stringify(reply))
        },
        () => {
          // A handler that never settles is how the deadline test hangs a
          // request; a handler that rejects is a bug in the test.
          res.destroy()
        },
      )
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  let closed = false

  return {
    apiRoot: `http://127.0.0.1:${port}`,
    calls,
    callsTo: (method) => calls.filter((call) => call.method === method),
    on: (method, handler) => handlers.set(method, handler),
    // Idempotent: a test that closes the server to make the host unreachable
    // is closed again by its own teardown.
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (closed) {
          resolve()
          return
        }
        closed = true
        server.closeAllConnections()
        server.close((error) => (error ? reject(error) : resolve()))
      }),
  }
}
