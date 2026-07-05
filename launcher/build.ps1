# Builds SocialAutomation.exe from launcher/Program.cs using the in-box
# .NET Framework C# compiler (csc.exe) that ships with every Windows install
# -- no SDK/toolchain download required.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File launcher\build.ps1
#
# Output: <repo root>\SocialAutomation.exe
#
# Falls back to ps2exe (from PSGallery) if csc.exe isn't present, and prints
# instructions for a manual Launch-SocialAutomation.bat if neither works.

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$source = Join-Path $PSScriptRoot 'Program.cs'
$outExe = Join-Path $repoRoot 'SocialAutomation.exe'
$csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'

if (-not (Test-Path $source)) {
    throw "Launcher source not found: $source"
}

if (Test-Path $csc) {
    Write-Host "Building $outExe with csc.exe ..."
    & $csc `
        /nologo `
        /target:winexe `
        /platform:anycpu `
        /out:"$outExe" `
        /reference:System.dll `
        /reference:System.Windows.Forms.dll `
        /reference:System.Net.Http.dll `
        "$source"
    if ($LASTEXITCODE -ne 0) {
        throw "csc.exe failed with exit code $LASTEXITCODE"
    }
    Write-Host "Built $outExe"
    exit 0
}

Write-Warning "csc.exe not found at $csc -- falling back to ps2exe."

if (-not (Get-Module -ListAvailable -Name ps2exe)) {
    Write-Host "Installing ps2exe from PSGallery (current user scope) ..."
    Install-Module -Name ps2exe -Scope CurrentUser -Force -ErrorAction Stop
}

$ps1Wrapper = Join-Path $PSScriptRoot 'launch-wrapper.ps1'
if (-not (Test-Path $ps1Wrapper)) {
    throw "Expected a PowerShell wrapper at $ps1Wrapper for the ps2exe fallback -- see launcher/Launch-SocialAutomation.bat for the manual alternative."
}

Import-Module ps2exe -ErrorAction Stop
Invoke-ps2exe -inputFile $ps1Wrapper -outputFile $outExe -noConsole:$false
Write-Host "Built $outExe via ps2exe"
