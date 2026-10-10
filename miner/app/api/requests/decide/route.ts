import { NextRequest, NextResponse } from "next/server";
import { setStatus } from "@/lib/requests";

const ADMIN_KEY = process.env.ADMIN_KEY || "";

export async function POST(req: NextRequest) {
  try {
    const { id, key, action } = (await req.json()) as {
      id?: string;
      key?: string;
      action?: string;
    };
    if (!ADMIN_KEY || key !== ADMIN_KEY)
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!id || (action !== "approve" && action !== "reject"))
      return NextResponse.json({ error: "bad request" }, { status: 400 });
    const r = await setStatus(id, action === "approve" ? "approved" : "rejected");
    if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true, status: r.status });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Server error." }, { status: 500 });
  }
}
