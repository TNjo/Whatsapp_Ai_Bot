import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // This app lives in a subfolder of the repo; don't let a parent lockfile become the root.
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  // Embedded Postgres (WASM) must be loaded by Node, not bundled.
  serverExternalPackages: ["@electric-sql/pglite"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
};

export default nextConfig;
