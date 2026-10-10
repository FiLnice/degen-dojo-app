import type { NextConfig } from "next";

// EXPORT_MINE=1 switches this into a static export (`out/`) so the store can fold in
// /mine as plain files. Static export can't contain the dynamic POST /api/* route
// handlers, so export-mine.mjs moves app/api aside for the duration of that build.
const EXPORT = process.env.EXPORT_MINE === "1";

const nextConfig: NextConfig = {
  ...(EXPORT ? { output: "export" as const } : {}),
  // Pin the workspace root to this project (a stray lockfile exists one level up).
  turbopack: {
    root: process.cwd(), // __dirname is undefined when Next compiles this config as ESM
  },
  images: {
    // Static export has no image optimizer — serve the artwork as-is.
    unoptimized: EXPORT,
    // Allow remote NFT artwork from arbitrary gateways (IPFS/Arweave/etc.).
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
