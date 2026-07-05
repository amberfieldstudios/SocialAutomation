# One-command build of the SocialAutomation self-contained Windows
# distributable: installs deps, builds the UI, stages a bundled Node
# runtime, compiles the launcher exe, then copies everything a user needs
# into dist\SocialAutomation\ -- a folder that can be zipped and shipped as
# a release artifact, and that runs on a machine with NO Node.js preinstalled.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\build-distributable.ps1
#   powershell -ExecutionPolicy Bypass -File scripts\build-distributable.ps1 -SkipInstall
#
# This is the single command t8's release-verification script wraps: it
# should run this, then assert against the resulting dist\SocialAutomation\
# folder (self-contained, no LLM model bundled, user data outside the app
# dir -- see launcher/README.md "Verifying the distributable").
#
# NOTE ON SANDBOXED/CI ENVIRONMENTS: this script downloads a real Node.js
# runtime (via launcher\fetch-node-runtime.ps1) and runs a real pnpm
# install/build, both of which need network access and take a few minutes
# on first run. If either is unavailable, this script fails loudly rather
# than producing a silently-broken artifact.

param(
    [switch]$SkipInstall,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutDir) { $OutDir = Join-Path $repoRoot 'dist\SocialAutomation' }

function Step($msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

Push-Location $repoRoot
try {
    if (-not $SkipInstall) {
        Step "Installing dependencies (pnpm install)"
        & npx --yes pnpm@9.7.0 install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed with exit code $LASTEXITCODE" }
    }
    else {
        Write-Host "Skipping pnpm install (-SkipInstall)."
    }

    Step "Building the dashboard UI (packages/ui/dist)"
    & npx --yes pnpm@9.7.0 --filter=@social/ui run build
    if ($LASTEXITCODE -ne 0) { throw "UI build failed with exit code $LASTEXITCODE" }

    Step "Staging bundled Node.js runtime"
    & (Join-Path $repoRoot 'launcher\fetch-node-runtime.ps1')

    Step "Compiling launcher exe"
    & (Join-Path $repoRoot 'launcher\build.ps1')

    Step "Staging distributable at $OutDir"
    if (Test-Path $OutDir) {
        Remove-Item -Recurse -Force $OutDir
    }
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

    # Copy SOURCE only (never node_modules) with robocopy, then run a fresh
    # `pnpm install` inside the staged folder below. node_modules is a farm
    # of pnpm junctions/symlinks into a content-addressed store -- copying
    # those file-by-file (even with robocopy /SL) follows/duplicates content
    # across every package that depends on a shared module and inflates a
    # <1 GB node_modules into double digits of GB. Reinstalling fresh in
    # place is what actually reproduces pnpm's link farm correctly.
    $includeDirs = @('packages', 'plugins', 'scripts', 'launcher', 'runtime')
    foreach ($dir in $includeDirs) {
        $src = Join-Path $repoRoot $dir
        if (-not (Test-Path $src)) { continue }
        $dst = Join-Path $OutDir $dir
        robocopy $src $dst /E /SL /NFL /NDL /NJH /NJS /XD 'node_modules' | Out-Null
        # robocopy's exit codes 0-7 are all "success" (8+ is a real failure);
        # its process exit code otherwise leaks as this script's own, which
        # calling automation can misread as failure -- normalize it.
        if ($LASTEXITCODE -ge 8) { throw "robocopy failed copying $dir (exit $LASTEXITCODE)" }
        $global:LASTEXITCODE = 0
    }
    Copy-Item (Join-Path $repoRoot 'package.json') $OutDir
    Copy-Item (Join-Path $repoRoot 'pnpm-workspace.yaml') $OutDir
    Copy-Item (Join-Path $repoRoot 'pnpm-lock.yaml') $OutDir -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $repoRoot 'tsconfig.base.json') $OutDir -ErrorAction SilentlyContinue
    Copy-Item (Join-Path $repoRoot 'SocialAutomation.exe') $OutDir
    Copy-Item (Join-Path $repoRoot 'README.md') $OutDir -ErrorAction SilentlyContinue

    Step "Installing dependencies inside the staged folder (fresh node_modules link farm)"
    Push-Location $OutDir
    try {
        # NOT --prod: this workspace is TS-native (every @social/* package's
        # `main` points at src/index.ts, run via vite-node -- see
        # scripts/start.mjs's header comment), so devDependencies like
        # vite-node/typescript are needed at RUNTIME, not just for building.
        & npx --yes pnpm@9.7.0 install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "pnpm install in staged folder failed with exit code $LASTEXITCODE" }
    }
    finally {
        Pop-Location
    }

    Step "Done"
    $sizeBytes = (Get-ChildItem $OutDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
    $sizeMb = [math]::Round($sizeBytes / 1MB, 1)
    Write-Host "Distributable staged at: $OutDir ($sizeMb MB)"
    Write-Host "Zip this folder to produce the release artifact, e.g.:"
    Write-Host "  Compress-Archive -Path '$OutDir' -DestinationPath '$repoRoot\dist\SocialAutomation-win-x64.zip' -Force"
}
finally {
    Pop-Location
}
