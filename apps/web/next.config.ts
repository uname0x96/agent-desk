import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  transpilePackages: [
    '@agent-desk/schemas',
    '@agent-desk/core',
    '@agent-desk/db',
    '@agent-desk/adapters',
  ],
  outputFileTracingRoot: new URL('../../', import.meta.url).pathname,
  typedRoutes: false,
}

export default nextConfig
