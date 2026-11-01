"use client";

import { useMemo, type ReactNode } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { PhantomWalletAdapter } from "@solana/wallet-adapter-phantom";
import { SolflareWalletAdapter } from "@solana/wallet-adapter-solflare";
import "@solana/wallet-adapter-react-ui/styles.css";
import { isEmbedded } from "@/lib/wallet-bridge";

// ORE reads + sends go through the /api/rpc proxy (see useOreGame / useOreSubmit).
// This endpoint just satisfies the wallet adapter's ConnectionProvider.
const ENDPOINT = "https://api.mainnet-beta.solana.com";

// In the store the shared wallet session is the only connection: reconnecting here too could hold a different account.
const reconnectHere = async () => !isEmbedded();

export function WalletContextProvider({ children }: { children: ReactNode }) {
  const wallets = useMemo(() => [new PhantomWalletAdapter(), new SolflareWalletAdapter()], []);
  return (
    <ConnectionProvider endpoint={ENDPOINT}>
      <WalletProvider wallets={wallets} autoConnect={reconnectHere}>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
