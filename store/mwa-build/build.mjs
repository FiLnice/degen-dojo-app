// Builds ../mwa.js (IIFE) from mwa-entry.mjs.
//
//   cd scripts/mwa-build && npm install && node build.mjs
//
// Applies ONE surgical patch to @solana-mobile/wallet-standard-mobile at bundle time (node_modules
// is never modified): its Local-Network-Access gate. When navigator.permissions reports the
// "loopback-network" permission as "prompt", the library shows "Allow connections to your wallet",
// fires fetch('http://localhost') to make Chrome show its native prompt, then waits ONLY for the
// permission's onchange event. On the Seeker's Chrome that native prompt never appears, onchange
// never fires, and the connect hangs until the 30s timeout without ever launching Seed Vault.
// The patch arms a short grace period once the user has tapped "Continue to Allow": if the
// permission still hasn't changed, it continues to the library's own "Ready to connect!" step,
// whose button tap launches the wallet exactly like the granted path does. Granted / denied /
// cancelled behave exactly as before.
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const GRACE_MS = 5000;

const TARGET = /const modal = new LoopbackPermissionModal\(\);\s*if \(await new Promise\(\(resolve, reject\) => \{\s*modal\.addEventListener\("close", \(event\) => \{\s*if \(event\) reject\((new SolanaMobileWalletAdapterError\(SolanaMobileWalletAdapterErrorCode\.ERROR_ASSOCIATION_CANCELLED, "Wallet connection cancelled by user", \{ event \}\))\);\s*\}\);\s*lnaPermission\.onchange = \(\) => \{\s*lnaPermission\.onchange = null;\s*resolve\(lnaPermission\.state\);\s*\};\s*modal\.init\(\);\s*modal\.open\(\);\s*\}\) === "granted"\) \{/;

const REPLACEMENT = (cancelErr) => `const modal = new LoopbackPermissionModal();
			const __ddLnaState = await new Promise((resolve, reject) => {
				let __ddTimer;
				modal.addEventListener("close", (event) => {
					if (event) { clearTimeout(__ddTimer); reject(${cancelErr}); return; }
					__ddTimer = setTimeout(() => {
						lnaPermission.onchange = null;
						console.info("[DD] Local Network Access prompt did not resolve; continuing to wallet launch");
						resolve("dd-lna-timeout");
					}, ${GRACE_MS});
				});
				lnaPermission.onchange = () => {
					clearTimeout(__ddTimer);
					lnaPermission.onchange = null;
					resolve(lnaPermission.state);
				};
				modal.init();
				modal.open();
			});
			if (__ddLnaState === "granted" || __ddLnaState === "dd-lna-timeout") {`;

// The library gives the whole pre-association phase 30s. On Seeker that phase now includes reading
// "Allow connections", the grace period above and tapping "Connect Wallet", so allow 60s. The timer
// only applies until the wallet associates; approving inside Seed Vault is not time-limited.
const TIMEOUT_TARGET = /const WALLET_ASSOCIATION_TIMEOUT = 3e4;/;
const TIMEOUT_REPLACEMENT = 'const WALLET_ASSOCIATION_TIMEOUT = 6e4;';

let patched = 0;
const lnaGracePatch = {
  name: 'dd-lna-grace-period',
  setup(b) {
    b.onLoad({ filter: /wallet-standard-mobile[\\/]lib[\\/](esm|cjs)[\\/]index\.browser\.js$/ }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      const m = src.match(TARGET);
      if (!m) throw new Error(`LNA patch target not found in ${args.path} — the library changed; re-check checkLocalNetworkAccessPermission before shipping`);
      if (!TIMEOUT_TARGET.test(src)) throw new Error(`Association-timeout patch target not found in ${args.path} — the library changed`);
      patched++;
      return { contents: src.replace(TARGET, REPLACEMENT(m[1])).replace(TIMEOUT_TARGET, TIMEOUT_REPLACEMENT), loader: 'js' };
    });
  },
};

await build({
  entryPoints: [path.join(here, 'mwa-entry.mjs')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome100'],
  minify: true,
  legalComments: 'none',
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: path.join(here, '..', 'mwa.js'),
  plugins: [lnaGracePatch],
  logLevel: 'info',
});

if (patched < 1) throw new Error('LNA patch was not applied — refusing to ship an unpatched mwa.js');
console.log(`LNA grace-period + 60s association-timeout patches applied (${patched} file). Output: ../mwa.js`);
