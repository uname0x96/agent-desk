import type { Metadata } from "next"
import { SignUpForm } from "./sign-up-form.tsx"

export const metadata: Metadata = {
  title: "Sign up · AgentDesk",
  description: "Create an AgentDesk Account and get a funded System Wallet.",
}

/**
 * Story 3.1. An email and a password are the whole form: the wallet is the
 * platform's job, not the visitor's, and this page says so before they type.
 */
export default function SignUpPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-20">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Create an account</h1>
        <p className="text-muted-foreground">
          No wallet, no seed phrase, no faucet. AgentDesk creates a System Wallet for you, funds it
          with test BNB for gas and tUSD to pay Agents, and holds the key encrypted.
        </p>
      </div>
      <SignUpForm />
    </div>
  )
}
