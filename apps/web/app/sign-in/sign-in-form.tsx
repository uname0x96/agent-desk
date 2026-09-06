"use client"

import { useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { useMutation, useQueryClient } from "@tanstack/react-query"
import { meResponse } from "@agent-desk/schemas"
import { Button } from "../../components/ui/button.tsx"
import { Input } from "../../components/ui/input.tsx"
import { Label } from "../../components/ui/label.tsx"
import { apiFetch, errorMessage } from "../../lib/api.ts"
import { meQueryKey } from "../../lib/session-query.ts"

/**
 * Story 2.1: sign-in only. Sign-up arrives with Story 3.1.
 *
 * A wrong pair answers 401 with one message for both failures, and this form
 * shows exactly that message: it must not tell the visitor which field was
 * wrong either.
 */
export function SignInForm() {
  const router = useRouter()
  const params = useSearchParams()
  const queryClient = useQueryClient()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  // Only a same-site path is followed, so `?next=` cannot become an open
  // redirect; the server builds it the same way in `signInPath`.
  const raw = params.get("next") ?? "/"
  const next = raw.startsWith("/") && !raw.startsWith("//") ? raw : "/"

  const signIn = useMutation({
    mutationFn: () =>
      apiFetch("/api/auth/sign-in", meResponse, {
        method: "POST",
        body: { email, password },
      }),
    onSuccess: (me) => {
      queryClient.setQueryData(meQueryKey, me)
      router.replace(next)
      router.refresh()
    },
  })

  return (
    <form
      className="flex w-full max-w-sm flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault()
        signIn.mutate()
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
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      {signIn.error ? (
        <p role="alert" className="text-sm font-medium text-destructive">
          {errorMessage(signIn.error)}
        </p>
      ) : null}

      <Button type="submit" size="lg" disabled={signIn.isPending}>
        {signIn.isPending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}
