# Run from anywhere:  powershell -ExecutionPolicy Bypass -File scripts\sync-github.ps1   (then review + commit in the repo)
# Mirror the CURRENT store + miner into the public repo copy (Downloads\degen-dojo-dapp) — same layout as before:
#   store/src        page/client sources the store build reads     store/functions  Netlify function sources
#   store/dist       the built store (scripts/store-deploy, minus node_modules)
#   store/mwa-build  Mobile Wallet Adapter bundle sources          miner/           degen-dojo-ore (tracked + new, not ignored)
#   docs/            SECURITY-ROADMAP.md, PAYOUTS-SETUP.md
$repo = "C:\Users\sazei\Downloads\degen-dojo-dapp"
$scr  = "C:\Users\sazei\Documents\DEGEN DOJO\BULKITOR\bulkitor\scripts"
$ore  = "C:\Users\sazei\Documents\DEGEN DOJO\degen-dojo-ore"

$t = Get-Content -Raw "$scr\build-store-deploy.mjs"
$names = [regex]::Matches($t, 'scripts/([A-Za-z0-9._-]+\.(?:json|mjs|html|css|js))') | ForEach-Object { $_.Groups[1].Value }
# the store HOME page is built from store-template.html by build-store.mjs (not by build-store-deploy.mjs), so it must be
# listed by hand — leaving it out let the repo copy drift behind the deployed page (security review 2026-10-23, M12)
$names += @("store-repair.html", "store-burn.html", "build-store-deploy.mjs", "build-store.mjs", "store-template.html", "html-safe.mjs", "csp.mjs", "build-leak-guard.mjs", "zip-forward.ps1", "sync-github.ps1")
$skip = @("store.html", "mwa.js")                       # generated outputs, not sources
$src = 0; $fn = 0; $missing = @()
foreach ($n in ($names | Sort-Object -Unique)) {
  if ($skip -contains $n) { continue }
  $p = Join-Path $scr $n
  if (-not (Test-Path $p)) { $missing += $n; continue }
  if ($n -match '^store-fn-' -or $n -match '^store-.*-core\.mjs$' -or $n -eq 'store-notify.mjs') { Copy-Item $p "$repo\store\functions\$n" -Force; $fn++ }
  else { Copy-Item $p "$repo\store\src\$n" -Force; $src++ }
}
"store/src: $src files · store/functions: $fn files · not found (skipped): $($missing -join ', ')"

# built store
robocopy "$scr\store-deploy" "$repo\store\dist" /MIR /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
"store/dist mirrored (robocopy exit $LASTEXITCODE; < 8 = ok)"

# MWA bundle sources
foreach ($n in "build.mjs", "mwa-entry.mjs", "package.json", "package-lock.json") { if (Test-Path "$scr\mwa-build\$n") { Copy-Item "$scr\mwa-build\$n" "$repo\store\mwa-build\$n" -Force } }

# miner: every file git tracks in degen-dojo-ore + new files that aren't ignored
$files = @(git -C $ore ls-files) + @(git -C $ore ls-files --others --exclude-standard)
$m = 0
foreach ($f in ($files | Sort-Object -Unique)) {
  if (-not $f) { continue }
  $from = Join-Path $ore $f; if (-not (Test-Path $from -PathType Leaf)) { continue }
  $to = Join-Path "$repo\miner" $f; New-Item -ItemType Directory -Force (Split-Path $to) | Out-Null
  Copy-Item $from $to -Force; $m++
}
"miner: $m files"

foreach ($n in "SECURITY-ROADMAP.md", "PAYOUTS-SETUP.md") { if (Test-Path "$scr\$n") { Copy-Item "$scr\$n" "$repo\docs\$n" -Force } }
"docs updated"
