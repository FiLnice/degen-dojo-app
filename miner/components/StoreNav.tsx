"use client";

// The store's top bar, rendered by React (so Next hydration never strips it — an
// HTML-injected bar flashes then vanishes). Only shows when embedded in the store;
// standalone mine.degendojo.xyz renders nothing here.
import { useState } from "react";
import { useWallet } from "@/lib/wallet-bridge";

// ≤640px: collapse the pills behind a ☰ hamburger dropdown (matches the store home + sub-pages).
const NAV_CSS = `.dn-ham{display:none}.dn-connect{display:none}
@media(max-width:640px){
  .dn-bar{gap:10px!important;padding:10px 14px!important;}
  .dn-extra{display:none!important;}
  .dn-ham{display:flex!important;align-items:center;justify-content:center;width:44px;height:44px;border-radius:10px;cursor:pointer;background:rgba(201,151,58,.12);border:1px solid rgba(201,151,58,.45);color:#e8b84b;font-size:22px;line-height:1;margin-left:auto;flex:0 0 auto;}
  .dn-links{position:absolute!important;top:calc(100% - 2px);right:10px;min-width:214px;flex-direction:column!important;align-items:stretch;gap:5px!important;background:rgba(12,10,18,.98);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(201,151,58,.4);border-radius:12px;padding:9px;box-shadow:0 16px 36px rgba(0,0,0,.6);display:none!important;z-index:80;}
  .dn-links.dn-open{display:flex!important;}
  .dn-links a{text-align:left;font-size:13px!important;padding:11px 13px!important;}
  .dn-connect{display:flex!important;}
}`;

const PILLS: [string, string][] = [
  ["/", "⌂ Store"],
  ["/market", "🛒 Market"],
  ["/launch", "🚀 Launch"],
  ["/list", "🏷 List"],
  ["/play", "▶ Play"],
  ["/mine", "⛏ Mine"],
  ["/pot", "🏆 Pot"],
  ["/become-a-preacher", "📣 Preacher"],
];

const CINZEL = "'Cinzel', serif";

export function StoreNav() {
  const { embedded, publicKey, connected, select, disconnect } = useWallet();
  const [open, setOpen] = useState(false);
  if (!embedded) return null;

  const pk = publicKey ? publicKey.toBase58() : "";
  const short = pk ? `${pk.slice(0, 4)}…${pk.slice(-4)}` : "";
  // Connected → the store-wide Profile / Disconnect menu (dojo-profile.js), same as every other page.
  // Falls back to a plain disconnect if that script didn't load.
  const openProfile = (anchor: HTMLElement) => {
    const P = (window as unknown as { DojoProfile?: { menu: (a: HTMLElement, pk: string, dc: () => void) => void } }).DojoProfile;
    if (P && pk) P.menu(anchor, pk, () => { disconnect(); });
    else disconnect();
  };

  return (
    <div
      className="dn-bar"
      style={{
        position: "sticky",
        top: 0,
        zIndex: 72,
        background: "rgba(10,10,15,.94)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid rgba(201,151,58,.18)",
        display: "flex",
        alignItems: "center",
        gap: 16,
        padding: "11px 20px",
        flexWrap: "wrap",
        fontFamily: CINZEL,
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: NAV_CSS }} />
      <a href="/" style={{ display: "flex", alignItems: "center", gap: 11, textDecoration: "none", color: "#efe6d2" }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src="/dd-mark.jpg"
          alt="Degen Dojo"
          style={{ width: 40, height: 40, borderRadius: 9, objectFit: "cover", display: "block", boxShadow: "0 0 0 1px rgba(201,151,58,.35)" }}
          onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = "none"; }}
        />
        <div style={{ textAlign: "left" }}>
          <b style={{ fontFamily: CINZEL, fontSize: 15, letterSpacing: ".16em", display: "block", color: "#efe6d2" }}>DEGEN DOJO</b>
          <small style={{ fontFamily: CINZEL, fontSize: 9, letterSpacing: ".26em", color: "#a99a7e" }}>MINE</small>
        </div>
      </a>

      <nav
        className={"dn-links" + (open ? " dn-open" : "")}
        onClick={() => setOpen(false)}
        style={{ display: "flex", gap: 8, flexWrap: "wrap" }}
      >
        <a
          href="#"
          className="dn-connect"
          onClick={(e) => { e.preventDefault(); if (connected) openProfile(e.currentTarget); else select?.(); }}
          style={{ fontFamily: CINZEL, fontSize: 11, fontWeight: 700, letterSpacing: ".08em", borderRadius: 8, padding: "9px 14px", textDecoration: "none", whiteSpace: "nowrap", color: "#e8b84b", border: "1px solid rgba(201,151,58,.5)", background: "rgba(201,151,58,.12)" }}
        >
          {connected ? `◎ ${short}` : "🔑 Connect"}
        </a>
        {PILLS.map(([href, label]) => {
          const on = href === "/mine";
          return (
            <a
              key={href}
              href={href}
              style={{
                fontFamily: CINZEL,
                fontSize: 11,
                fontWeight: 700,
                letterSpacing: ".08em",
                borderRadius: 8,
                padding: "9px 14px",
                textDecoration: "none",
                whiteSpace: "nowrap",
                ...(on
                  ? { color: "#e8b84b", border: "1px solid rgba(201,151,58,.6)", background: "rgba(201,151,58,.14)" }
                  : { color: "#efe6d2", border: "1px solid rgba(201,151,58,.32)" }),
              }}
            >
              {label}
            </a>
          );
        })}
      </nav>

      <span className="dn-extra" style={{ marginLeft: "auto", display: "flex", alignItems: "center" }}>
        <button
          onClick={(e) => (connected ? openProfile(e.currentTarget) : select?.())}
          style={{
            fontFamily: CINZEL,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: ".05em",
            whiteSpace: "nowrap",
            cursor: "pointer",
            borderRadius: 8,
            padding: "9px 16px",
            ...(connected
              ? { color: "#e8b84b", background: "rgba(201,151,58,.12)", border: "1px solid rgba(201,151,58,.5)" }
              : { color: "#0a0814", background: "linear-gradient(135deg,#c8962a,#8b6018)", border: "none" }),
          }}
        >
          {connected ? `◎ ${short}` : "Connect wallet"}
        </button>
      </span>

      <button
        className="dn-ham"
        type="button"
        aria-label="Menu"
        onClick={() => setOpen((o) => !o)}
      >
        ☰
      </button>
    </div>
  );
}
