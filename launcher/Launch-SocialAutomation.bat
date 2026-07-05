@echo off
REM Worst-case fallback launcher: use this .bat directly if you can't run
REM SocialAutomation.exe at all (see launcher/build.ps1 and launcher/README.md
REM for the primary build path).
REM
REM Double-click this file, or run it from a terminal. It runs the same
REM friendly bootstrap (launcher\bootstrap.mjs) as SocialAutomation.exe does,
REM just with a visible console instead of a progress window -- prints plain
REM status lines (not a raw pnpm/npm install wall) and leaves the window open
REM as the running server; close it (or Ctrl+C) to stop the app.
REM
REM Prefers the runtime bundled with this distributable
REM (runtime\node-win-x64\node.exe); falls back to PATH `node` for from-source
REM checkouts that haven't staged a bundled runtime (see
REM launcher\fetch-node-runtime.ps1).

setlocal
cd /d "%~dp0.."
title SocialAutomation server

set "BUNDLED_NODE=%CD%\runtime\node-win-x64\node.exe"
if exist "%BUNDLED_NODE%" (
    set "NODE_BIN=%BUNDLED_NODE%"
) else (
    node --version >nul 2>&1
    if errorlevel 1 (
        echo.
        echo SocialAutomation couldn't find a Node.js runtime to run with.
        echo This copy is missing its bundled runtime ^(runtime\node-win-x64\node.exe^) --
        echo please re-download SocialAutomation from the release page.
        echo.
        echo ^(Developers running from source: install Node.js 22+ from
        echo https://nodejs.org/, or run launcher\fetch-node-runtime.ps1 to stage
        echo a bundled runtime.^)
        echo.
        pause
        exit /b 1
    )
    set "NODE_BIN=node"
)

"%NODE_BIN%" launcher\bootstrap.mjs
pause
