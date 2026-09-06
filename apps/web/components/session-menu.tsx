"use client"

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { apiFetch } from "../lib/api.ts"
import { meQueryOptions } from "../lib/session-query.ts"
import { PlatformStatus } from "./platform-status.tsx"
import { Button } from "./ui/button.tsx"

/**
 * The right-hand end of the header: the platform status badges, the Operator
 * link, and sign in / sign out. Story 2.2 requires that `/operator` "is not
 * linked" for a non-operator, so the entry is rendered from `is_operator` on
 * `GET /api/me` rather than listed in the static nav.
 */
export function SessionMenu() {
  const router = useRouter()
  const queryClient = useQueryClient()
  const { data: me, isPending } = useQuery(meQueryOptions())
  const signedIn = me !== undefined

  const signOut = useMutation({
    mutationFn: async () => {
      // 204, so the body is empty and there is no schema to name.
      await apiFetch("/api/auth/sign-out", z.null(), { method: "POST" })
    },
    onSuccess: async () => {
      queryClient.clear()
      router.replace("/sign-in")
      router.refresh()
    },
  })

  return (
    <div className="ml-auto flex items-center gap-3">
      <PlatformStatus signedIn={signedIn} />
      {signedIn ? (
        <>
          {me.is_operator ? (
            <Link
              href="/operator"
              className="text-base font-medium text-muted-foreground hover:text-foreground"
            >
              Operator
            </Link>
          ) : null}
          <span className="hidden text-sm text-muted-foreground sm:inline">{me.email}</span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => signOut.mutate()}
            disabled={signOut.isPending}
          >
            Sign out
          </Button>
        </>
      ) : isPending ? null : (
        <Link
          href="/sign-in"
          className="text-base font-medium text-muted-foreground hover:text-foreground"
        >
          Sign in
        </Link>
      )}
    </div>
  )
}
