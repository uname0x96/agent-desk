# Telegram Notifier

The `notify` seed agent (FR-32, FR-44). It takes a paid request carrying a Run
summary, cost table, tx hashes and order, and posts one formatted message to a
Telegram chat.

- Type `notify`, price `0.005` tUSD, port `4106`, compose service
  `agent-telegram-notifier`.
- Built on `createAgent()` (AD-7), so `POST /`, `GET /health` and `GET /schema`,
  the 402, input and output validation, the 10 s handler budget and the
  single-flight replay cache all come from the kit.
- Talks to the Bot API through grammY, by long polling only, never a webhook
  (AD-12).

## Blocking action item: create the bot

Nobody has created the bot yet and `TELEGRAM_BOT_TOKEN` is empty in `.env`, so
the notifier cannot boot and no live message has ever been sent. One person on
the team needs to do this once.

1. Open Telegram (any client, on the account that will own the bot) and start a
   chat with **@BotFather** — the account with the blue verified check at
   <https://t.me/BotFather>.
2. Send `/newbot`.
3. BotFather asks for a **display name**. Send `AgentDesk`.
4. BotFather asks for a **username**. It must be globally unique and end in
   `bot`; try `agentdesk_demo_bot`, and add a suffix if it is taken. Write the
   username down — the Builders need it to find the bot.
5. BotFather replies with a line like

   ```
   Use this token to access the HTTP API:
   7000000001:AAH0Xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```

   That whole `<bot_id>:<secret>` string is the token. Treat it as a password:
   anyone holding it controls the bot.
6. Put it in the repo's `.env`, and in the team password manager next to the
   other secrets:

   ```
   TELEGRAM_BOT_TOKEN=7000000001:AAH0Xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   AGENT_TELEGRAM_POLL=true
   ```

   `.env` is git-ignored. Never paste the token into a commit, an issue, or a
   chat message; if it leaks, send `/revoke` to BotFather and repeat step 6.
7. Bring the service up: `docker compose up -d agent-telegram-notifier`. The
   logs should show `telegram bot token accepted` with the bot's username,
   followed by `telegram long polling started`. If the token is wrong the
   process exits 1 at boot instead of failing at the first paid request.

### Getting a chat id

A bot cannot message someone who has never started a chat with it, so every
recipient does this once:

1. Open `https://t.me/<the bot username>` and press **Start** (or send
   `/start` in the existing chat).
2. The bot answers with the chat id in a tap-to-copy block.
3. Paste it into AgentDesk under **Settings → Telegram chat id**.

The same reply is where `PLATFORM_CHAT_ID` (the worker's listing verification
Call) and `SEED_TELEGRAM_CHAT_ID` (`pnpm seed`) come from: start the bot from
the account that should receive those, and copy the id it answers with.

### Two pollers, one token

Telegram allows one `getUpdates` consumer per token. Running `pnpm dev` here
while the compose service is up makes the Bot API answer 409 to both. Stop one
of them.

## Environment

| Variable | Notes |
| --- | --- |
| `TELEGRAM_BOT_TOKEN` | From BotFather. Required; the process exits 1 without it. This is the only place in the repo that reads it. |
| `AGENT_TELEGRAM_POLL` | `true` turns long polling on. Set in compose; off by default. |
| `EXPLORER_URL` | Base for the tx links in the message. Defaults to `https://testnet.bscscan.com`. |
| `AGENT_PORT`, `AGENT_PRICE`, `AGENT_PAYTO`, `FACILITATOR_URL`, `INTERNAL_TOKEN`, `CHAIN_ID` | The shared agent variables, validated by `@agent-desk/agent-kit`. |

## The message

One `sendMessage` per paid request, in Telegram HTML with link previews off:

```
<b>AgentDesk Run</b> <code>run_01JAGENTDESK000000000001</code>

LONG BNBUSDT, reduced to 60 USDT, filled at 612.55

<b>Cost</b>
• data · Binance Ticker · 0.01 tUSD · <a href=".../tx/0xa1b2…beef">0xa1b2c3d4…deadbeef</a>
• risk · Guardrail Risk · 0.02 tUSD

<b>Transactions</b>
• <a href=".../tx/0xa1b2…beef">0xa1b2c3d4…deadbeef</a>

<b>Order</b> FILLED
order_id 123456789
filled_price 612.55
filled_qty 0.0979
```

A cost table entry shows its tx hash only when the settlement hash is known
(AD-14). A `REJECTED` order shows the reason instead of the three fields. The
sections are omitted when their input is empty, which is what the listing
verification Call sends.

## Failure behaviour

| Situation | Answer |
| --- | --- |
| `recipient.channel` is not `telegram` | 400 `validation_failed`, from the Type schema, before the handler runs. Never settled. |
| Bot API error, or a chat id the bot cannot message | 500 `internal_error` naming the Bot API code and description. Never settled. |
| Bot API slower than 8 s, or the 10 s handler budget expires | 500. Never settled. |
| The same `PAYMENT-SIGNATURE` arrives twice | One Telegram message, the cached output both times (AD-7). |

The x402 middleware settles only a response below 400, so a message that did
not arrive is never paid for.

## Tests

`corepack pnpm vitest run apps/agents/telegram-notifier` runs everything
against a local stand-in for `api.telegram.org` (`src/mock-bot-api.ts`) used as
grammY's `apiRoot`, so the real grammY client, its request bodies and its error
mapping are all exercised. **The live path against api.telegram.org is
unproven** — there is no bot and no token yet.

## Seed

`pnpm seed` lists this agent under the Platform Account. The descriptor it
needs is exported, so the price and port are written down once:

```ts
import { seedListing } from '@agent-desk/agent-telegram-notifier/seed'
// { name: 'Telegram Notifier', type: 'notify', price: '0.005', port: 4106,
//   endpointEnv: 'TELEGRAM_NOTIFIER_URL',
//   defaultEndpoint: 'http://agent-telegram-notifier:4106' }
```
