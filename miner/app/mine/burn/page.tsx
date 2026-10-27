"use client";

// /mine/burn is kept only as a redirect: Burn to Mine is a mode of /mine now (/mine?burn=1). The query (ref, wallet)
// is carried over; a static export can't redirect server-side, so this tiny page does it on load.
import { useEffect } from "react";

export default function BurnRedirect() {
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    q.set("burn", "1");
    window.location.replace("/mine?" + q.toString());
  }, []);
  return (
    <main className="flex min-h-screen items-center justify-center px-5 text-sm text-slate-400">
      <a href="/mine?burn=1" className="text-amber-300 underline">
        Burn to Mine has moved to the miner — continue ›
      </a>
    </main>
  );
}
