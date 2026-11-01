import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { OreIcon } from "@/components/OreIcon";
import { StoreNav } from "@/components/StoreNav";
import { SETUP_FEE_ORE } from "@/lib/config";

export const metadata = {
  title: "Whitelabel ORE mining for NFT collections",
  description: "Put your NFT collection's art on an ORE mining grid. Your holders mine $ORE on your own branded page.",
};

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="flex gap-3 rounded-xl border border-slate-800 bg-slate-900/40 p-3 text-left sm:block sm:space-y-2 sm:p-4">
      <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-amber-600 text-sm font-bold text-white">
        {n}
      </div>
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold text-slate-100">{title}</h2>
        <p className="text-sm text-slate-400">{body}</p>
      </div>
    </div>
  );
}

export default function WhitelabelPage() {
  return (
    <>
    <StoreNav />
    <main className="flex min-h-[calc(100dvh-70px)] items-center px-5 py-4">
      <div className="mx-auto w-full max-w-3xl space-y-5 text-center">
        <div className="inline-flex items-center gap-2 rounded-full border border-amber-600/30 bg-amber-600/10 px-3 py-1 text-xs text-amber-300">
          <OreIcon className="size-3.5" /> Whitelabel ORE mining
        </div>
        <h1 className="text-3xl font-bold leading-tight tracking-tight text-slate-50 sm:text-5xl">
          Get your NFT collection on the{" "}
          <span className="bg-gradient-to-r from-amber-300 to-amber-500 bg-clip-text text-transparent">ORE mining grid</span>
        </h1>
        <p className="mx-auto max-w-xl text-slate-400">
          Your holders mine real <span className="text-amber-300">$ORE</span> on your art, on a page with no Degen Dojo menu.
        </p>

        <div className="grid gap-3 sm:grid-cols-3">
          <Step n={1} title="Paste your collection" body="Your address or hashlist puts your art on the live grid." />
          <Step n={2} title={`Pay ${SETUP_FEE_ORE} ORE`} body="One time, no monthly fees. We review every request." />
          <Step n={3} title="Go live" body="Get your own link, plus one line of code for your website." />
        </div>

        <div className="flex items-center justify-center gap-3">
          <Link
            href="/create"
            className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-500"
          >
            Create your miner <ArrowRight className="size-4" />
          </Link>
          <Link
            href="/mine"
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-6 py-3 text-sm font-medium text-slate-200 transition-colors hover:bg-slate-800"
          >
            See it live
          </Link>
        </div>

        <p className="mx-auto max-w-2xl text-[11px] leading-relaxed text-slate-500">
          We host it. Miners pay the same 1% fee as our own miner, it goes to Degen Dojo and there&apos;s no revenue share. On a
          website, Connect opens your miner in a new tab. Miners sign in their own wallet and can withdraw any time. Mining stakes
          real SOL and it can be lost. Not financial advice.
        </p>
      </div>
    </main>
    </>
  );
}
