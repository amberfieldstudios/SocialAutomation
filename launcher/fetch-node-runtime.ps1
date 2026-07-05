# Downloads a pinned, official Node.js Windows x64 runtime and stages it at
# <repo root>\runtime\node-win-x64\ so the packaged distributable does not
# require Node to be preinstalled on the user's machine.
#
# This is a BUILD-TIME step (run once per release, or whenever NODE_VERSION
# below changes) -- it is not run by end users. The launcher exe
# (launcher/Program.cs) looks for node.exe at this path first, before
# falling back to PATH (dev convenience only).
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File launcher\fetch-node-runtime.ps1
#
# Idempotent: skips the download if runtime\node-win-x64\node.exe already
# exists and reports the right version (use -Force to re-fetch).

param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

# Keep in sync with package.json's "engines.node" (>=22.0.0). Pin to a
# specific LTS build so every release ships an identical, known-good runtime.
$NodeVersion = '22.14.0'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimeDir = Join-Path $repoRoot 'runtime\node-win-x64'
$nodeExe = Join-Path $runtimeDir 'node.exe'

if ((Test-Path $nodeExe) -and -not $Force) {
    $existing = & $nodeExe --version
    if ($existing -eq "v$NodeVersion") {
        Write-Host "Bundled Node runtime already present at $nodeExe ($existing) -- skipping download."
        exit 0
    }
    Write-Host "Bundled runtime is $existing, expected v$NodeVersion -- re-fetching."
}

$distName = "node-v$NodeVersion-win-x64"
$zipUrl = "https://nodejs.org/dist/v$NodeVersion/$distName.zip"
$shasumUrl = "https://nodejs.org/dist/v$NodeVersion/SHASUMS256.txt"

$tempDir = Join-Path ([System.IO.Path]::GetTempPath()) ("social-automation-node-" + [System.Guid]::NewGuid())
New-Item -ItemType Directory -Path $tempDir -Force | Out-Null
$zipPath = Join-Path $tempDir "$distName.zip"

try {
    Write-Host "Downloading Node.js v$NodeVersion (win-x64) from $zipUrl ..."
    Invoke-WebRequest -Uri $zipUrl -OutFile $zipPath -UseBasicParsing

    Write-Host "Verifying checksum against $shasumUrl ..."
    $shasums = (Invoke-WebRequest -Uri $shasumUrl -UseBasicParsing).Content
    $expectedLine = ($shasums -split "`n") | Where-Object { $_ -match [regex]::Escape("$distName.zip") } | Select-Object -First 1
    if (-not $expectedLine) {
        throw "Could not find a checksum entry for $distName.zip in SHASUMS256.txt -- refusing to trust an unverified download."
    }
    $expectedHash = ($expectedLine -split '\s+')[0].Trim().ToLower()
    $actualHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
    if ($expectedHash -ne $actualHash) {
        throw "Checksum mismatch for $distName.zip (expected $expectedHash, got $actualHash) -- aborting."
    }
    Write-Host "Checksum OK."

    Write-Host "Extracting to $runtimeDir ..."
    if (Test-Path $runtimeDir) {
        Remove-Item -Recurse -Force $runtimeDir
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $runtimeDir) -Force | Out-Null
    Expand-Archive -Path $zipPath -DestinationPath $tempDir -Force
    Move-Item -Path (Join-Path $tempDir $distName) -Destination $runtimeDir

    # Trim to what the app actually needs at runtime: node.exe itself. Keep
    # npm/npx too (harmless, small, useful for a developer poking at the
    # shipped folder) but drop docs/license-adjacent bulk if present.
    Get-ChildItem $runtimeDir -Filter '*.md' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue

    $version = & $nodeExe --version
    Write-Host "Bundled Node runtime ready: $nodeExe ($version)"
}
finally {
    Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue
}
