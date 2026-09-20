# AITeam Windows PowerShell Installer
$ErrorActionPreference = "Stop"

$rootDir = (Resolve-Path $PSScriptRoot).Path
$binDir = Join-Path $env:USERPROFILE ".local\bin"

if (-not (Test-Path $binDir)) {
    New-Item -ItemType Directory -Path $binDir -Force | Out-Null
}

$watchCmdContent = @"
@echo off
setlocal
set "PORT=%AITEAM_WATCH_PORT%"
if "%PORT%"=="" set "PORT=4317"
set "REPO=%~1"
if "%REPO%"=="" set "REPO=%CD%"
node "$rootDir\src\watch-server.mjs" --repo "%REPO%" --port "%PORT%"
"@
Set-Content -Path (Join-Path $binDir "aiteam-watch.cmd") -Value $watchCmdContent -Encoding ASCII

$watchPs1Content = @"
`$ErrorActionPreference = "Stop"
`$repo = if (`$args.Count -gt 0 -and `$args[0]) { `$args[0] } else { (Get-Location).Path }
`$port = if (`$env:AITEAM_WATCH_PORT) { `$env:AITEAM_WATCH_PORT } else { "4317" }
node "$rootDir\src\watch-server.mjs" --repo `$repo --port `$port
"@
Set-Content -Path (Join-Path $binDir "aiteam-watch.ps1") -Value $watchPs1Content -Encoding UTF8

Write-Host "Installed AITeam dashboard launcher: $binDir\aiteam-watch.cmd"
Write-Host ""
Write-Host "To link the AITeam skill into any repository, run bash bin/aiteam-install or copy skill/ into .agents/skills/aiteam"
