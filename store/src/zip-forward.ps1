# Creates a Netlify-safe zip with FORWARD-SLASH entry paths.
#
# Why this exists: Windows PowerShell 5.1 uses .NET Framework, whose
# [ZipFile]::CreateFromDirectory writes entry names with BACKSLASHES
# (e.g. "degen\foo.html"). Netlify does not treat "\" as a folder separator,
# so it stores each subfolder file as a single root file literally named
# "degen\foo.html" — and every /degen/... /trait/... URL 404s.
# This helper writes each entry with an explicit forward-slash relative path.
param(
  [Parameter(Mandatory = $true)][string]$Src,
  [Parameter(Mandatory = $true)][string]$Zip
)
Add-Type -AssemblyName System.IO.Compression.FileSystem | Out-Null
Add-Type -AssemblyName System.IO.Compression | Out-Null
$srcFull = (Resolve-Path $Src).Path -replace '[\\/]+$', ''
$fs = [System.IO.File]::Open($Zip, [System.IO.FileMode]::Create)
try {
  $arch = New-Object System.IO.Compression.ZipArchive($fs, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    Get-ChildItem -LiteralPath $Src -Recurse -File | ForEach-Object {
      $rel = $_.FullName.Substring($srcFull.Length + 1).Replace([char]92, '/')
      $entry = $arch.CreateEntry($rel, [System.IO.Compression.CompressionLevel]::Optimal)
      $es = $entry.Open()
      try {
        $in = [System.IO.File]::OpenRead($_.FullName)
        try { $in.CopyTo($es) } finally { $in.Dispose() }
      } finally { $es.Dispose() }
    }
  } finally { $arch.Dispose() }
} finally { $fs.Dispose() }
Write-Output ("Zipped with forward-slash paths -> " + $Zip)
