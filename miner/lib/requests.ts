import { getStore } from "@netlify/blobs";

export type Degen = { name: string; image: string };
export type ReqStatus = "pending" | "approved" | "rejected";

export type MinerRequest = {
  id: string;
  name: string;
  tipWallet: string;
  rpc: string; // the collection's own Helius RPC
  contact: string; // email / twitter / discord to reach them
  website: string;
  degens: Degen[]; // 25 images
  paymentSig: string;
  payer: string; // wallet that paid the fee
  feeOre: number;
  status: ReqStatus;
  createdAt: number;
};

// Netlify Blobs store (auto-configured on Netlify; throws in plain local dev).
function store() {
  return getStore({ name: "miner-requests", consistency: "strong" });
}

export async function saveRequest(r: MinerRequest) {
  const s = store();
  await s.setJSON(`req:${r.id}`, r);
  await s.set(`sig:${r.paymentSig}`, r.id); // replay guard
}

export async function getRequest(id: string): Promise<MinerRequest | null> {
  return (await store().get(`req:${id}`, { type: "json" })) as MinerRequest | null;
}

export async function sigUsed(sig: string): Promise<boolean> {
  return !!(await store().get(`sig:${sig}`));
}

export async function setStatus(id: string, status: ReqStatus): Promise<MinerRequest | null> {
  const r = await getRequest(id);
  if (!r) return null;
  r.status = status;
  await store().setJSON(`req:${id}`, r);
  return r;
}

export async function listRequests(): Promise<MinerRequest[]> {
  const s = store();
  const { blobs } = await s.list({ prefix: "req:" });
  const out: MinerRequest[] = [];
  for (const b of blobs) {
    const r = (await s.get(b.key, { type: "json" })) as MinerRequest | null;
    if (r) out.push(r);
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}
