import { Suspense } from "react"
import type { Metadata } from "next"
import { SignInForm } from "./sign-in-form.tsx"

export const metadata: Metadata = {
  title: "Sign in · AgentDesk",
  description: "Sign in to AgentDesk.",
}

/** The seeded accounts of Story 2.10 are the only way in until Story 3.1. */
export default function SignInPage() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-6 py-20">
      <div className="flex flex-col gap-2">
        <h1 className="text-4xl font-bold tracking-tight">Sign in</h1>
        <p className="text-muted-foreground">
          Your Workflows, Runs, and payments belong to the Account you sign in as.
        </p>
      </div>
      {/* `useSearchParams` needs a boundary for the prerendered shell. */}
      <Suspense fallback={null}>
        <SignInForm />
      </Suspense>
    </div>
  )
}
