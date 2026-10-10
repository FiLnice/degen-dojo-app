import type { ReactNode } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles, Lock, Zap, Coins, Check } from "lucide-react";
import { OreIcon } from "@/components/OreIcon";
import { StoreNav } from "@/components/StoreNav";
import { SETUP_FEE_ORE } from "@/lib/config";

export const metadata = {
  title: "Whitelabel ORE mining for NFT collections",
  description: "Put your NFT collection's art on an ORE mining grid. Your holders mine $ORE while viewing your art; you earn the tips.",
};

function Feature({ icon, title, body }: { icon: ReactNode; title: string; body: string }) {
  return (
    <div className="space-y-2 rounded-xl border border-slate-800 bg-slate-900/40 p-5">
      <div className="inline-flex size-9 items-center justify-center rounded-lg bg-amber-600/15 text-amber-300">
        {icon}
      </div>
      <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
      <p className="text-sm leading-relaxed text-slate-400">{body}</p>
    </div>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <div className="flex gap-4">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-600 text-sm font-bold text-white">
        {n}
      </div>
      <div className="space-y-0.5">
        <h3 className="text-sm font-semibold text-slate-100">{title}</h3>
        <p className="text-sm text-slate-400">{body}</p>
      </div>
    </div>
  );
}

function Faq({ q, a }: { q: string; a: string }) {
  return (
    <div className="space-y-1 border-t border-slate-800 py-4">
      <h3 className="text-sm font-medium text-slate-200">{q}</h3>
      <p className="text-sm leading-relaxed text-slate-400">{a}</p>
    </div>
  );
}

export default function WhitelabelPage() {
  return (
    <>
    <StoreNav />
    <main className="min-h-screen px-5 py-14">
      <div className="mx-auto max-w-3xl space-y-20">
        {/* Hero */}
        <section className="space-y-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-amber-600/30 bg-amber-600/10 px-3 py-1 text-xs text-amber-300">
            <OreIcon className="size-3.5" /> Whitelabel ORE mining
          </div>
          <h1 className="text-4xl font-bold leading-tight tracking-tight text-slate-50 sm:text-5xl">
            Turn your NFT collection into a{" "}
            <span className="bg-gradient-to-r from-amber-300 to-amber-500 bg-clip-text text-transparent">
              mining game
            </span>
          </h1>
          <p className="mx-auto max-w-xl text-lg text-slate-400">
            Put your art on a live ORE mining grid. Your holders mine real <span className="text-amber-300">$ORE</span> while
            they view your collection — and every optional tip goes straight to your wallet.
          </p>
          <div className="flex flex-col items-center justify-center gap-3 pt-2 sm:flex-row">
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
          <p className="text-xs text-slate-600">One-time {SETUP_FEE_ORE} ORE setup · no recurring fees · hosted by you</p>
        </section>

        {/* Value props */}
        <section className="grid gap-4 sm:grid-cols-2">
          <Feature
            icon={<Sparkles className="size-5" />}
            title="Your brand, front and centre"
            body="Your 25 NFTs on the grid, your collection name, your own link. It looks like it was built for you — because it was."
          />
          <Feature
            icon={<Coins className="size-5" />}
            title="You earn the tips"
            body="Miners can add an optional tip each round. It goes directly to the wallet you set — a new, passive revenue stream for your treasury."
          />
          <Feature
            icon={<Lock className="size-5" />}
            title="Provably yours"
            body="You host your own deploy, so your tip wallet lives in your config — we literally can't change it. Every tip is a visible on-chain transfer."
          />
          <Feature
            icon={<Zap className="size-5" />}
            title="Live in minutes"
            body="No code, no servers. Paste your NFTs, deploy in one click, and drop a “Mine ORE” button on your existing site."
          />
        </section>

        {/* How it works */}
        <section className="space-y-6">
          <h2 className="text-center text-2xl font-semibold text-slate-100">How it works</h2>
          <div className="space-y-5">
            <Step n={1} title="Pick your 25 NFTs" body="Paste a hashlist of 25 mint addresses — we pull the artwork automatically and preview your grid." />
            <Step n={2} title={`Pay the ${SETUP_FEE_ORE} ORE setup fee`} body="A one-time fee, verified on-chain. We review your details and approve your request." />
            <Step n={3} title="Deploy + link it" body="One click deploys your own miner. Add a link from your site and your holders can mine right away." />
          </div>
          <div className="text-center">
            <Link
              href="/create"
              className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-500"
            >
              Get started <ArrowRight className="size-4" />
            </Link>
          </div>
        </section>

        {/* FAQ */}
        <section className="space-y-1">
          <h2 className="mb-4 text-center text-2xl font-semibold text-slate-100">Questions</h2>
          <Faq
            q="What exactly do my holders mine?"
            a="Real $ORE, via the on-chain ORE protocol. It's a 5×5 grid game: each round the protocol picks a winning tile and mints ORE. It stakes real SOL — 24 of 25 tiles lose each round — so your community owns that risk. This is not financial advice."
          />
          <Faq
            q="How do I know you won't redirect my tips?"
            a="You host your own deploy. The tip wallet is baked into your configuration, on your infrastructure — we're not in the loop and can't change it. On top of that, every tip is a plain SOL transfer your miners sign, with the destination visible in their wallet."
          />
          <Faq
            q="Do I need to run any servers or write code?"
            a="No. You paste your NFTs, pay the fee, and deploy with one click. The only thing you bring is a free RPC key (from helius.dev) so the data connection is yours."
          />
          <Faq q="What does it cost?" a={`A one-time ${SETUP_FEE_ORE} ORE setup fee. No monthly fees, no revenue share — the tips are entirely yours.`} />
        </section>

        {/* Final CTA */}
        <section className="space-y-4 rounded-2xl border border-amber-800/40 bg-amber-950/10 p-8 text-center">
          <h2 className="text-2xl font-semibold text-slate-50">Ready to give your holders something to do?</h2>
          <p className="mx-auto max-w-md text-sm text-slate-400">
            Set it up in a few minutes and turn your art into an engagement engine.
          </p>
          <Link
            href="/create"
            className="inline-flex items-center gap-2 rounded-lg bg-amber-600 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-amber-500"
          >
            <Check className="size-4" /> Create your miner
          </Link>
        </section>

        <footer className="pb-4 text-center text-[11px] text-slate-600">
          Powered by the ORE protocol. Grid mining stakes real SOL — participants can lose their stake. Not
          financial advice.
        </footer>
      </div>
    </main>
    </>
  );
}
