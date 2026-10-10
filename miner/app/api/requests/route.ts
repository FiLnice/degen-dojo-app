import { NextRequest, NextResponse } from "next/server";
import {
  saveRequest,
  listRequests,
  getRequest,
  sigUsed,
  type Degen,
  type MinerRequest,
} from "@/lib/requests";

const OPERATOR = process.env.NEXT_PUBLIC_OPERATOR_WALLET || "";
const FEE_ORE = parseFloat(process.env.NEXT_PUBLIC_SETUP_FEE_ORE || "5") || 5;
const ORE_MINT = "oreoU2P8bN6jkk3jbaiVxYnG1dCXcYxwhwyK9jSybcp";
const ORE_DECIMALS = 11;
const ADMIN_KEY = process.env.ADMIN_KEY || "";
const HELIUS = process.env.HELIUS_RPC || "";

type TokenBal = { mint?: string; owner?: string; uiTokenAmount?: { amount?: string } };
type JsonTx = { meta?: { err?: unknown; preTokenBalances?: TokenBal[]; postTokenBalances?: TokenBal[] } };

// ORE (base units) the operator wallet received in this transaction (0 if none/invalid).
async function operatorReceived(sig: string): Promise<bigint> {
  if (!HELIUS || !OPERATOR) return 0n;
  const res = await fetch(HELIUS, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "getTransaction",
      params: [sig, { maxSupportedTransactionVersion: 0, encoding: "jsonParsed" }],
    }),
  });
  const j = (await res.json()) as { result?: JsonTx };
  const tx = j.result;
  if (!tx || tx.meta?.err) return 0n;
  const oreOf = (list?: TokenBal[]) =>
    (list || [])
      .filter((b) => b.mint === ORE_MINT && b.owner === OPERATOR)
      .reduce((n, b) => n + BigInt(b.uiTokenAmount?.amount || "0"), 0n);
  const diff = oreOf(tx.meta?.postTokenBalances) - oreOf(tx.meta?.preTokenBalances);
  return diff > 0n ? diff : 0n;
}

export async function POST(req: NextRequest) {
  try {
    const b = (await req.json()) as Partial<{
      name: string;
      tipWallet: string;
      rpc: string;
      contact: string;
      website: string;
      degens: Degen[];
      paymentSig: string;
      payer: string;
    }>;

    if (!OPERATOR)
      return NextResponse.json({ error: "Signups aren’t open yet." }, { status: 503 });
    if (!b.name || !b.tipWallet || !b.rpc || !b.contact || !b.paymentSig || !b.payer)
      return NextResponse.json({ error: "Please fill every field." }, { status: 400 });
    if (!Array.isArray(b.degens) || b.degens.length !== 25)
      return NextResponse.json({ error: "Need exactly 25 images." }, { status: 400 });

    if (await sigUsed(b.paymentSig))
      return NextResponse.json({ error: "That payment was already used." }, { status: 409 });

    const received = await operatorReceived(b.paymentSig);
    if (received < BigInt(Math.floor(FEE_ORE * 10 ** ORE_DECIMALS * 0.999)))
      return NextResponse.json(
        { error: `Couldn’t verify a ${FEE_ORE} ORE payment for that transaction.` },
        { status: 402 },
      );

    const id = crypto.randomUUID().slice(0, 8);
    const request: MinerRequest = {
      id,
      name: String(b.name).slice(0, 80),
      tipWallet: b.tipWallet,
      rpc: b.rpc,
      contact: String(b.contact).slice(0, 200),
      website: String(b.website || "").slice(0, 200),
      degens: b.degens,
      paymentSig: b.paymentSig,
      payer: b.payer,
      feeOre: FEE_ORE,
      status: "pending",
      createdAt: Date.now(),
    };
    await saveRequest(request);
    return NextResponse.json({ id, status: "pending" });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Server error." }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const admin = searchParams.get("admin");
  const id = searchParams.get("id");
  try {
    if (admin != null) {
      if (!ADMIN_KEY || admin !== ADMIN_KEY)
        return NextResponse.json({ error: "unauthorized" }, { status: 401 });
      return NextResponse.json({ requests: await listRequests() });
    }
    if (id) {
      const r = await getRequest(id);
      if (!r) return NextResponse.json({ error: "not found" }, { status: 404 });
      // Only reveal the deploy config once approved.
      return NextResponse.json(r.status === "approved" ? { status: r.status, request: r } : { status: r.status });
    }
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : "Server error." }, { status: 500 });
  }
}
