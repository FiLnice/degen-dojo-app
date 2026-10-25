// Retired (security review 2026-10-23, I2): this page read the admin key from the URL (?key=) and called the old
// /api/requests routes. Branded-miner requests are reviewed on the store's /miner-admin page, which keeps the key out
// of the URL and sends it only in an Authorization header.
export default function AdminPage() {
  return (
    <main className="grid min-h-screen place-items-center px-5 text-center text-sm text-slate-400">
      <p>
        Branded-miner requests are managed at{" "}
        <a className="text-slate-200 underline" href="https://store.degendojo.xyz/miner-admin">
          store.degendojo.xyz/miner-admin
        </a>
        .
      </p>
    </main>
  );
}
