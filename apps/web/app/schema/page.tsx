import type { Metadata } from "next"
import { z } from "zod"
import {
  AGENT_TYPES,
  buildX402Config,
  samples,
  sampleOutputs,
  typeSchemas,
  TUSD_DECIMALS,
  X402_HEADERS,
  X402_MAX_PAID_ATTEMPTS,
  X402_MAX_TIMEOUT_SECONDS,
  X402_PAID_TIMEOUT_MS,
  X402_SCHEME,
  X402_UNPAID_TIMEOUT_MS,
  X402_VERSION,
  type AgentType,
} from "@agent-desk/schemas"
import { CopyButton } from "../../components/copy-button.tsx"
import { JsonBlock } from "../../components/json-block.tsx"
import { Separator } from "../../components/ui/separator.tsx"

export const metadata: Metadata = {
  title: "Type contracts · AgentDesk",
  description:
    "The five AgentDesk Type contracts, their samples, and the x402 payment binding. Everything needed to build a conforming Agent.",
}

// FACILITATOR_URL is supplied at runtime by compose, so this page is rendered
// per request rather than baked at build time.
export const dynamic = "force-dynamic"

const TYPE_SUMMARY: Record<AgentType, string> = {
  data: "Reads the market and returns the current price with 24 h change and volatility.",
  research: "Turns a market snapshot into a LONG / SHORT / HOLD signal with a confidence and a reason.",
  risk: "Sizes the position, or rejects it. APPROVE, REDUCE or REJECT.",
  execution: "Places the order on the exchange and reports the fill.",
  notify: "Delivers the run summary and its cost table to a Telegram chat.",
}

/** PRD addendum section 1: the rules a shape check alone cannot express. */
const CROSS_FIELD_RULES: Partial<Record<AgentType, readonly string[]>> = {
  risk: [
    'size_usdt must be exactly "0" when decision is REJECT.',
    "size_usdt must not exceed proposed_size_usdt from the request.",
    "size_usdt must not exceed balance_usdt from the request.",
  ],
  execution: [
    "order_id, filled_price and filled_qty are all required when status is FILLED.",
    "reason is required when status is REJECTED.",
  ],
}

export default function SchemaPage() {
  const facilitatorUrl = process.env.FACILITATOR_URL ?? "http://facilitator:4020"
  const x402 = buildX402Config({ facilitatorUrl })

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-12 px-6 py-12">
      <Intro />
      <PaymentBinding x402={x402} />
      <WireContract />
      <TypeIndex />
      {AGENT_TYPES.map((type) => (
        <TypeSection key={type} type={type} />
      ))}
      <Footnote />
    </div>
  )
}

// ------------------------------------------------------------------- intro

function Intro() {
  return (
    <header className="flex flex-col gap-4">
      <h1 className="text-4xl font-bold tracking-tight">Type contracts</h1>
      <p className="max-w-3xl text-lg text-muted-foreground">
        AgentDesk Agents are ordinary HTTP services that charge per call. There are five Types. An
        Agent declares one Type, accepts that Type&rsquo;s input on <Code>POST /</Code>, answers{" "}
        <Code>402</Code> until the call is paid for, and then returns that Type&rsquo;s output. This
        page is the whole contract: the schemas, the samples, and the payment binding this
        deployment is bound to.
      </p>
      <p className="max-w-3xl text-lg text-muted-foreground">
        All amounts in a Type payload are decimal USDT strings. All timestamps are ISO 8601 UTC.
        Unknown fields in a response are ignored rather than rejected.
      </p>
    </header>
  )
}

// -------------------------------------------------------- payment binding

function PaymentBinding({ x402 }: { x402: ReturnType<typeof buildX402Config> }) {
  const rows: readonly [string, string, string][] = [
    ["x402 version", String(X402_VERSION), "The protocol version every 402 and signature carries."],
    ["Scheme", X402_SCHEME, "The only scheme AgentDesk accepts."],
    ["Network", x402.network, "CAIP-2. Compared as an exact string, never normalised."],
    ["Asset (tUSD)", x402.asset, "The ERC-3009 test token every payment moves."],
    ["Asset decimals", String(x402.decimals), `Amounts on the wire are integer base units (10^${TUSD_DECIMALS}).`],
    ["EIP-712 domain name", x402.extra.name, "Sent as `extra.name` in the 402 and signed over."],
    ["EIP-712 domain version", x402.extra.version, "Sent as `extra.version` in the 402 and signed over."],
    ["Facilitator URL", x402.facilitatorUrl, "Verifies and settles every payment."],
    [
      "maxTimeoutSeconds",
      String(x402.maxTimeoutSeconds),
      `A 402 asking for more than ${X402_MAX_TIMEOUT_SECONDS} is refused as a price mismatch.`,
    ],
  ]

  return (
    <section className="flex flex-col gap-4" aria-labelledby="binding">
      <h2 id="binding" className="text-2xl font-semibold">
        Active payment binding
      </h2>
      <p className="text-muted-foreground">
        These are the live values of this deployment. Every 402 an Agent returns must match them
        exactly; the engine compares them against the Run&rsquo;s Price Lock and pays nothing on a
        difference.
      </p>
      <div className="overflow-x-auto rounded-xl ring-1 ring-border">
        <table className="w-full text-left text-base">
          <thead className="bg-muted/60">
            <tr>
              <th className="px-4 py-3 font-semibold">Field</th>
              <th className="px-4 py-3 font-semibold">Value</th>
              <th className="px-4 py-3 font-semibold">Meaning</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([field, value, meaning]) => (
              <tr key={field} className="border-t border-border">
                <td className="px-4 py-3 font-medium whitespace-nowrap">{field}</td>
                <td className="hash px-4 py-3 font-semibold">{value}</td>
                <td className="px-4 py-3 text-sm text-muted-foreground">{meaning}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <JsonBlock title="The same binding as JSON" value={x402} />
    </section>
  )
}

// ---------------------------------------------------------- wire contract

const UNPAID_EXAMPLE = `HTTP/1.1 402 Payment Required
${X402_HEADERS.required}: <base64url of the payment requirements>
content-type: application/json

{
  "x402Version": ${X402_VERSION},
  "accepts": [
    {
      "scheme": "${X402_SCHEME}",
      "network": "eip155:97",
      "payTo": "0x<your payout wallet>",
      "asset": "0x<tUSD address above>",
      "amount": "10000",
      "maxTimeoutSeconds": ${X402_MAX_TIMEOUT_SECONDS},
      "extra": { "name": "tUSD", "version": "1" }
    }
  ]
}`

const PAID_EXAMPLE = `POST / HTTP/1.1
content-type: application/json
${X402_HEADERS.signature}: <base64url of the signed ERC-3009 authorization>

{ "symbol": "BNBUSDT" }

HTTP/1.1 200 OK
${X402_HEADERS.response}: <base64url of { success, transaction, network, payer }>
content-type: application/json

{ "symbol": "BNBUSDT", "price": "612.40", "change_24h_pct": -1.8, "volatility_24h_pct": 3.2, "ts": "2026-09-05T02:00:00Z" }`

function WireContract() {
  const steps: readonly [string, string][] = [
    [
      `POST / (unpaid), ${X402_UNPAID_TIMEOUT_MS / 1000} s timeout`,
      `The caller sends the Type input with no payment header. The Agent answers 402 with the ${X402_HEADERS.required} header and the requirements body below.`,
    ],
    [
      "The caller checks the 402 against the Price Lock",
      "Scheme, network (exact string), asset, payTo and amount must all match what was locked when the Run started. maxTimeoutSeconds above " +
        `${X402_MAX_TIMEOUT_SECONDS} is refused. On any difference nothing is paid and the Call is marked price_mismatch.`,
    ],
    [
      `POST / (paid), ${X402_PAID_TIMEOUT_MS / 1000} s timeout`,
      `The same body is resent with the ${X402_HEADERS.signature} header carrying a signed ERC-3009 authorization. The Agent verifies it through the Facilitator before running any work.`,
    ],
    [
      `One retry, ${X402_MAX_PAID_ATTEMPTS} paid attempts at most`,
      "On a timeout the caller resends the identical header. An Agent must therefore be idempotent per signature: the same signature runs the handler once and returns the same answer.",
    ],
    [
      "200 with the settlement receipt",
      `The Agent settles through the Facilitator and answers 200 with the ${X402_HEADERS.response} header. Its transaction hash becomes the Call's payment tx hash.`,
    ],
    [
      "Anything other than 200 is unpaid work",
      "The payment is only settled on a response below 400. An invalid output must be a 5xx, never a 200.",
    ],
  ]

  return (
    <section className="flex flex-col gap-4" aria-labelledby="wire">
      <h2 id="wire" className="text-2xl font-semibold">
        The x402 handshake
      </h2>
      <ol className="flex flex-col gap-4">
        {steps.map(([title, body], index) => (
          <li key={title} className="flex gap-4">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted font-semibold">
              {index + 1}
            </span>
            <div className="flex flex-col gap-1">
              <p className="text-base font-semibold">{title}</p>
              <p className="text-muted-foreground">{body}</p>
            </div>
          </li>
        ))}
      </ol>

      <h3 className="mt-4 text-lg font-semibold">Headers</h3>
      <ul className="flex flex-col gap-2 text-base">
        <li>
          <Code>{X402_HEADERS.required}</Code> — set by the Agent on the 402.
        </li>
        <li>
          <Code>{X402_HEADERS.signature}</Code> — set by the caller on the paid request.
        </li>
        <li>
          <Code>{X402_HEADERS.response}</Code> — set by the Agent on the 200, carrying the
          settlement transaction hash.
        </li>
      </ul>

      <div className="grid gap-4 lg:grid-cols-2">
        <PlainBlock title="Unpaid request → 402" text={UNPAID_EXAMPLE} />
        <PlainBlock title="Paid request → 200" text={PAID_EXAMPLE} />
      </div>

      <h3 className="mt-4 text-lg font-semibold">The two routes an Agent must also expose</h3>
      <ul className="flex flex-col gap-2 text-base text-muted-foreground">
        <li>
          <Code>GET /health</Code> — 200 while the Agent is able to serve.
        </li>
        <li>
          <Code>GET /schema</Code> — the Agent&rsquo;s own copy of its Type schemas, samples and
          payment binding, in the same shape as this page.
        </li>
      </ul>
    </section>
  )
}

// -------------------------------------------------------------- the types

function TypeIndex() {
  return (
    <section className="flex flex-col gap-4" aria-labelledby="types">
      <h2 id="types" className="text-2xl font-semibold">
        The five Types
      </h2>
      <ul className="flex flex-wrap gap-3">
        {AGENT_TYPES.map((type) => (
          <li key={type}>
            <a
              href={`#type-${type}`}
              className="inline-flex rounded-full bg-muted px-4 py-1.5 text-base font-semibold hover:bg-accent"
            >
              {type}
            </a>
          </li>
        ))}
      </ul>
    </section>
  )
}

function TypeSection({ type }: { type: AgentType }) {
  // z.toJSONSchema is the canonical projection of the Zod 4 Type schemas;
  // `io: "input"` describes the JSON body as it goes over the wire.
  const input = z.toJSONSchema(typeSchemas[type].input, { io: "input" })
  const output = z.toJSONSchema(typeSchemas[type].output, { io: "input" })
  const rules = CROSS_FIELD_RULES[type]

  return (
    <section id={`type-${type}`} className="flex scroll-mt-24 flex-col gap-4">
      <Separator />
      <div className="flex flex-col gap-1">
        <h2 className="text-2xl font-semibold">{type}</h2>
        <p className="text-lg text-muted-foreground">{TYPE_SUMMARY[type]}</p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <JsonBlock title={`${type} — input schema (what your Agent receives)`} value={input} />
        <JsonBlock title={`${type} — output schema (what your Agent must return)`} value={output} />
        <JsonBlock title={`${type} — sample input`} value={samples[type]} />
        <JsonBlock title={`${type} — sample output`} value={sampleOutputs[type]} />
      </div>

      {rules ? (
        <div className="flex flex-col gap-2 rounded-lg bg-status-warn/10 px-4 py-3 ring-1 ring-status-warn/40 ring-inset">
          <p className="text-sm font-semibold tracking-wide uppercase">
            Rules a shape check cannot express
          </p>
          <ul className="list-disc pl-5 text-base">
            {rules.map((rule) => (
              <li key={rule}>{rule}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}

// ----------------------------------------------------------------- footer

function Footnote() {
  return (
    <section className="flex flex-col gap-3 border-t border-border pt-8">
      <h2 className="text-2xl font-semibold">Before you list</h2>
      <p className="max-w-3xl text-muted-foreground">
        The sample input above is exactly what AgentDesk sends on the verification Call when a
        listing is created. Your Agent must answer that call with a valid output of its Type, over
        the paid handshake, within {X402_PAID_TIMEOUT_MS / 1000} seconds — that is the whole
        verification. The sample input for <Code>notify</Code> is sent with the platform chat id and{" "}
        <Code>run_id: null</Code> substituted in.
      </p>
    </section>
  )
}

// ---------------------------------------------------------------- helpers

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="hash rounded bg-muted px-1.5 py-0.5 text-[0.92em] font-semibold">
      {children}
    </code>
  )
}

function PlainBlock({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-4">
        <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
          {title}
        </span>
        <CopyButton value={text} />
      </div>
      <pre className="max-h-96 overflow-auto rounded-lg bg-muted p-4 font-mono text-[13px] leading-6 whitespace-pre">
        {text}
      </pre>
    </div>
  )
}
