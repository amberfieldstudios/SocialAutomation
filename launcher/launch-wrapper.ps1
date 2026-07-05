# Fallback launcher body used only when Program.cs can't be compiled with
# csc.exe and build.ps1 falls back to ps2exe (see build.ps1). Mirrors
# Program.cs's behavior: prefer the bundled Node runtime (falling back to
# PATH node >= 22 for dev checkouts), run launcher\bootstrap.mjs (friendly
# progress lines, no raw pnpm wall, self-picks a free port), wait for its
# ready status, then open the browser.
#
# Not used in the primary (csc.exe) build path -- kept so the ps2exe
# fallback in build.ps1 has something to compile, and so this behavior is
# reviewable/reproducible without a C# toolchain.

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot

function Show-Error($msg) {
    Add-Type -AssemblyName System.Windows.Forms
    [System.Windows.Forms.MessageBox]::Show($msg, 'SocialAutomation', 'OK', 'Error') | Out-Null
}

if (-not (Test-Path (Join-Path $repoRoot 'package.json'))) {
    Show-Error "Could not find package.json next to this launcher (looked in: $repoRoot)."
    exit 1
}

$bundledNode = Join-Path $repoRoot 'runtime\node-win-x64\node.exe'
if (Test-Path $bundledNode) {
    $nodeExe = $bundledNode
} else {
    try {
        $nodeVersion = (& node --version) 2>$null
    } catch {
        Show-Error "SocialAutomation couldn't find a Node.js runtime to run with. This copy is missing its bundled runtime (runtime\node-win-x64\node.exe) -- please re-download SocialAutomation. (Developers: install Node.js 22+ from https://nodejs.org/ or run launcher\fetch-node-runtime.ps1.)"
        exit 1
    }
    if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 22) {
        Show-Error "SocialAutomation requires Node.js 22 or later, but found $nodeVersion on PATH, and no bundled runtime is present."
        exit 1
    }
    $nodeExe = 'node'
}

$bootstrapScript = Join-Path $repoRoot 'launcher\bootstrap.mjs'
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $nodeExe
$psi.Arguments = "`"$bootstrapScript`""
$psi.WorkingDirectory = $repoRoot
$psi.UseShellExecute = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError = $true
$proc = [System.Diagnostics.Process]::Start($psi)

$ready = $false
$url = $null
$deadline = (Get-Date).AddSeconds(180)
while ((Get-Date) -lt $deadline -and -not $proc.HasExited) {
    $line = $proc.StandardOutput.ReadLine()
    if ($null -eq $line) { break }
    Write-Host $line
    if ($line -match '^##STATUS##(.*)$') {
        $status = $Matches[1] | ConvertFrom-Json
        if ($status.stage -eq 'ready') { $ready = $true; $url = $status.url; break }
        if ($status.stage -eq 'error') { Show-Error $status.message; exit 1 }
    }
}

if ($ready) {
    Start-Process $url
    Write-Host "SocialAutomation is running at $url -- close this window to stop it."
    $proc.WaitForExit()
} else {
    Show-Error "SocialAutomation did not report ready within 3 minutes. Check this window's output for details."
}
