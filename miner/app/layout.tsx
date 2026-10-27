import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "sonner";
import { WalletContextProvider } from "@/providers/WalletContextProvider";
import { COLLECTION_NAME } from "@/lib/config";

const geistSans = Geist({ variable: "--font-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: `${COLLECTION_NAME} × ORE — Grid Mining`,
  description: `Mine $ORE with ${COLLECTION_NAME}.`,
  // the store's own icon (the store has no /favicon.ico — without this the browser asks for one and gets a 404)
  icons: { icon: "/icon-192.png" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <WalletContextProvider>{children}</WalletContextProvider>
        <Toaster theme="dark" position="bottom-right" richColors />
      </body>
    </html>
  );
}
