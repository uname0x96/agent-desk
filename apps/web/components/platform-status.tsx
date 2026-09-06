"use client"

import { useQuery } from "@tanstack/react-query"
import { Badge } from "./ui/badge.tsx"
import { publicSettingsQueryOptions } from "../lib/session-query.ts"

/**
 * AD-10 and AD-12: the current mode and the Emergency Stop badge, from
 * `GET /api/settings/public`, polled every 2 s. This is what makes the Operator
 * page steer a live demo — every open page picks the change up within two
 * seconds without a reload.
 *
 * Nothing is rendered for a signed-out visitor: the route needs a session, and
 * the platform's mode is not public.
 */
export function PlatformStatus({ signedIn }: { signedIn: boolean }) {
  const { data } = useQuery(publicSettingsQueryOptions(signedIn))
  if (!data) return null

  return (
    <div className="flex items-center gap-2" data-testid="platform-status">
      <Badge variant={data.mode === "demo" ? "secondary" : "outline"}>{data.mode} mode</Badge>
      {data.emergency_stop ? (
        <Badge variant="destructive" role="status">
          Emergency Stop
        </Badge>
      ) : null}
    </div>
  )
}
