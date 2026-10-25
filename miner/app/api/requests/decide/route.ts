import { NextResponse } from "next/server";

// Retired (security review 2026-10-23, I2): it took the admin key in the request body. Requests are approved or
// rejected on the store's /miner-admin page (POST /api/miner-requests {action:"decide"}, key in an Authorization header).
export async function POST() {
  return NextResponse.json({ error: "This endpoint moved — use /miner-admin on store.degendojo.xyz." }, { status: 410 });
}
