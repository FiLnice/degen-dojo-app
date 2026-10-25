import { NextResponse } from "next/server";

// Retired (security review 2026-10-23, I2). The branded-miner signup lives on the store: POST /api/miner-requests
// (store-fn-miner-requests.mjs) — it checks the payer's signature, the payment's age and the "ddminer:<hash>" memo that
// binds the payment to the exact request, and its admin list needs the key in an Authorization header, never the URL.
// This old route did none of that (no payer binding, admin key in ?admin=), so it now only points there.
const GONE = { error: "This endpoint moved — use /api/miner-requests on store.degendojo.xyz." };

export async function POST() {
  return NextResponse.json(GONE, { status: 410 });
}

export async function GET() {
  return NextResponse.json(GONE, { status: 410 });
}
