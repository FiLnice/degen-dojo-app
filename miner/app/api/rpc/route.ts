import { NextRequest, NextResponse } from "next/server";

// Server-side Solana RPC proxy. The browser talks to /api/rpc; this forwards to
// the Dojo's Helius endpoint using the server-only HELIUS_RPC env var, so the
// key is never exposed to the client and visitors need no RPC of their own.
//
// PRIVATE: gated to local dev only. In production it returns 403, so while the
// site isn't public this proxy can only be used from your own machine. Before a
// public launch, remove the dev gate and add rate-limiting + a method allowlist.
const HELIUS = process.env.HELIUS_RPC || "";

export async function POST(req: NextRequest) {
  // Private by default: always on in local dev; in production ONLY when the deploy
  // sets ALLOW_RPC_PROXY=1. So a public deploy can't leak the Helius quota unless
  // you opt in — keep the deploy behind a private link either way.
  const allowed = process.env.NODE_ENV !== "production" || process.env.ALLOW_RPC_PROXY === "1";
  if (!allowed) {
    return NextResponse.json({ error: "rpc proxy disabled" }, { status: 403 });
  }
  if (!HELIUS) {
    return NextResponse.json({ error: "server missing HELIUS_RPC" }, { status: 500 });
  }
  try {
    const body = await req.text();
    const upstream = await fetch(HELIUS, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: { "Content-Type": "application/json" },
    });
  } catch (e) {
    return NextResponse.json(
      { error: `rpc proxy failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }
}
