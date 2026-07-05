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

    Step "Installing dependencies inside the staged folder (junction-free layout)"
    # pnpm's default (isolated) layout is a farm of junctions into
    # node_modules\.pnpm with ABSOLUTE targets from this machine. Junctions do
    # not survive zip -> download -> extract (v1.0.0 shipped exactly that way:
    # the .pnpm store made it into the zip, every junction was silently
    # dropped, and users got "missing the server runtime" on launch).
    # node-linker=hoisted installs a flat, npm-style node_modules of REAL
    # files instead, which is what a zip can actually carry.
    Set-Content -Path (Join-Path $OutDir '.npmrc') -Value "node-linker=hoisted" -Encoding ascii
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

    Step "Materializing remaining links (workspace packages) into real files"
    # Even with node-linker=hoisted, pnpm links workspace packages
    # (node_modules\@social\* -> packages\*, plugins, etc.) as junctions.
    # Replace every link under the staged folder with a real copy of its
    # target so the tree is 100% plain files. Loop because a copied target
    # can itself contain links.
    for ($pass = 1; $pass -le 10; $pass++) {
        $links = @(Get-ChildItem $OutDir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.LinkType })
        if ($links.Count -eq 0) { break }
        Write-Host "  pass ${pass}: materializing $($links.Count) link(s)"
        foreach ($link in $links) {
            if (-not (Test-Path -LiteralPath $link.FullName)) { continue }
            $item = Get-Item -LiteralPath $link.FullName -Force
            if (-not $item.LinkType) { continue }
            $target = @($item.Target)[0]
            if (-not $target -or -not (Test-Path -LiteralPath $target)) {
                throw "Link $($item.FullName) has a missing target ($target) -- cannot materialize"
            }
            if ($item.PSIsContainer) {
                # Deletes only the junction itself, never the target's contents.
                [System.IO.Directory]::Delete($item.FullName)
                robocopy $target $item.FullName /E /NFL /NDL /NJH /NJS /XD 'node_modules' | Out-Null
                if ($LASTEXITCODE -ge 8) { throw "robocopy failed materializing $($item.FullName) (exit $LASTEXITCODE)" }
                $global:LASTEXITCODE = 0
            }
            else {
                Remove-Item -LiteralPath $item.FullName -Force
                Copy-Item -LiteralPath $target $item.FullName -Force
            }
        }
    }
    $leftover = @(Get-ChildItem $OutDir -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.LinkType })
    if ($leftover.Count -gt 0) {
        throw "Staged folder still contains $($leftover.Count) symlink(s)/junction(s) after materializing (e.g. $($leftover[0].FullName)) -- this layout would NOT survive zipping. Refusing to ship it."
    }
    Write-Host "  staged folder contains no symlinks/junctions -- zip-safe."

    Step "Sanity-checking the staged runtime layout"
    # The exact files bootstrap.mjs requires at launch (keep in sync with
    # launcher\bootstrap.mjs). A hoisted install puts vite-node at the root.
    $required = @(
        'runtime\node-win-x64\node.exe',
        'packages\ui\dist\index.html',
        'node_modules\vite-node\vite-node.mjs',
        'launcher\bootstrap.mjs',
        'SocialAutomation.exe'
    )
    foreach ($rel in $required) {
        if (-not (Test-Path (Join-Path $OutDir $rel))) { throw "Staged folder is missing required file: $rel" }
    }

    Step "Creating the release zip"
    $version = (Get-Content (Join-Path $repoRoot 'package.json') -Raw | ConvertFrom-Json).version
    $zipPath = Join-Path (Split-Path -Parent $OutDir) "SocialAutomation-$version-win-x64.zip"
    if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
    # tar.exe (bsdtar, in-box since Windows 10) handles long paths; -a picks
    # zip format from the extension. Zip from the staged folder's parent so
    # the archive has a single SocialAutomation\ root folder, matching what
    # users extract.
    Push-Location (Split-Path -Parent $OutDir)
    try {
        & tar.exe -a -cf $zipPath (Split-Path -Leaf $OutDir)
        if ($LASTEXITCODE -ne 0) { throw "tar.exe failed creating $zipPath (exit $LASTEXITCODE)" }
    }
    finally {
        Pop-Location
    }

    Step "Done"
    $sizeBytes = (Get-ChildItem $OutDir -Recurse -File | Measure-Object -Property Length -Sum).Sum
    $sizeMb = [math]::Round($sizeBytes / 1MB, 1)
    $zipMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
    Write-Host "Distributable staged at: $OutDir ($sizeMb MB)"
    Write-Host "Release zip created at:  $zipPath ($zipMb MB)"
    Write-Host "Run scripts\verify-release.mjs to verify the ZIP round-trips before shipping it."
}
finally {
    Pop-Location
}
