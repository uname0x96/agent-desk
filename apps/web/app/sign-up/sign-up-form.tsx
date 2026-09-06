"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { meResponse } from "@agent-desk/schemas"
import { Button } from "../../components/ui/button.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { ApiError, apiFetch, errorMessage } from "../../lib/api.ts"
import { meQueryKey } from "../../lib/session-query.ts"

/** `signUpRequest` in `packages/schemas`; the browser enforces the same floor. */
const MIN_PASSWORD_LENGTH = 8

/**
 * Story 3.1: `POST /api/auth/sign-up` creates the Account, publishes
 * `wallet.create`, and sets the session cookie, all in one request. This form
 * then goes straight to `/settings`, where the wallet is still being
 * provisioned and the page says so.
 *
 * The `meResponse` the route answers with seeds the shared `['me']` query, so
 * the header is signed in before `/settings` has asked anything.
 */
export function SignUpForm() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  const signUp = useMutation({
    mutationFn: () =>
      apiFetch("/api/auth/sign-up", meResponse, {
        method: "POST",
        body: { email, password },
      }),
    onSuccess: (me) => {
      queryClient.setQueryData(meQueryKey, me)
      router.replace("/settings")
      router.refresh()
    },
  })

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        signUp.mutate()
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          required
          minLength={MIN_PASSWORD_LENGTH}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        <p className="text-sm text-muted-foreground">
          At least {MIN_PASSWORD_LENGTH} characters.
        </p>
      </div>

      {signUp.error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {signUpMessage(signUp.error)}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={signUp.isPending}>
        {signUp.isPending ? "Creating your account…" : "Create account"}
      </Button>

      <p className="text-sm text-muted-foreground">
        Already have an account?{" "}
        <Link href="/sign-in" className="underline underline-offset-4">
          Sign in
        </Link>
        .
      </p>
    </form>
  )
}

/**
 * A taken address is the one failure worth naming precisely — the visitor can
 * act on it, and unlike sign-in there is nothing to give away by saying so.
 */
function signUpMessage(error: unknown): string {
  if (error instanceof ApiError && error.code === "conflict") return "email already registered"
  return errorMessage(error)
}
